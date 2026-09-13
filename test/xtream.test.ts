import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../src/native/errors.js';
import { parseRequest } from '../src/native/request.js';
import { createXtreamProvider, xtreamSettings } from '../src/native/xtream.js';
import type { HttpClient, Identity, MetadataProvider, RequestOptions, TextResponse } from '../src/native/types.js';

const settings = { host: 'https://provider.example.invalid:8443', username: 'synthetic user', password: 'synthetic&/password' };
const identity: Identity = { type: 'movie', title: 'Inception', aliases: ['Inception'], year: 2010, tmdbId: '27205', imdbId: 'tt1375666' };
const showIdentity: Identity = { type: 'tv', title: 'Dark', aliases: ['Dark'], year: 2017, tmdbId: '70523', imdbId: 'tt5753856' };
const movie = (id: number, tmdb: unknown = '27205', name = 'Inception (2010)') => ({ stream_id: id, tmdb, name, container_extension: 'mkv' });
const series = (id: number, tmdb: unknown = '70523', name = 'Dark (2017)') => ({ series_id: id, tmdb, name });
const category = (id: number) => ({ category_id: String(id), category_name: `Category ${id}` });
const episode = (id = 101, season: unknown = 1, number: unknown = 1) => ({ id, season, episode_num: number, title: 'Synthetic episode', container_extension: 'mkv', info: {} });

class Raw {
  constructor(readonly text: string, readonly status = 200, readonly headers: Record<string, string> = {}) {}
}
type Handler = (form: URLSearchParams, url: URL) => unknown | Promise<unknown>;

function mockHttp(handler: Handler): HttpClient & { calls: Array<{ url: string; form: URLSearchParams; options?: RequestOptions }> } {
  const calls: Array<{ url: string; form: URLSearchParams; options?: RequestOptions }> = [];
  const client: HttpClient & { calls: typeof calls } = {
    calls,
    async request(input, options) {
      const url = new URL(input);
      const legacy = url.pathname.endsWith('/enigma2.php');
      assert.equal(options?.method, legacy ? 'GET' : 'POST');
      if (legacy) assert.equal(options?.body, undefined, 'legacy GET must not carry a form body');
      else assert.equal(url.search, '', 'player API credentials belong in the POST body');
      const form = legacy ? url.searchParams : new URLSearchParams(options?.body);
      assert.equal(form.get('username'), settings.username);
      assert.equal(form.get('password'), settings.password);
      calls.push({ url: input, form, options });
      const value = await handler(form, url);
      const raw = value instanceof Raw ? value : new Raw(JSON.stringify(value));
      return { status: raw.status, url: input, text: raw.text, header: name => raw.headers[name.toLowerCase()] ?? null } satisfies TextResponse;
    },
    async json(url, options) { return JSON.parse((await client.request(url, options)).text); },
    session() { return client; },
    cookies() { return {}; },
  };
  return client;
}

interface Fixture {
  categories?: unknown;
  rows?: Record<string, unknown>;
  auth?: unknown;
  vodInfo?: (id: string) => unknown;
  seriesInfo?: (id: string) => unknown;
  legacy?: (id: string) => unknown;
  seasonsXml?: (id: string) => unknown;
  episodesXml?: (id: string, season: string) => unknown;
  onCategory?: (id: string) => Promise<void>;
}

function fixture(options: Fixture = {}) {
  return mockHttp(async (form, url) => {
    const action = form.get('action');
    if (url.pathname.endsWith('/enigma2.php')) {
      const type = form.get('type');
      if (type === 'get_series') return options.legacy?.(form.get('cat_id')!) ?? new Raw('<items></items>');
      if (type === 'get_seasons') return options.seasonsXml?.(form.get('series_id')!) ?? new Raw('<items></items>');
      if (type === 'get_series_streams') return options.episodesXml?.(form.get('series_id')!, form.get('season')!) ?? new Raw('<items></items>');
      throw new Error('Unexpected legacy action');
    }
    assert.equal(url.pathname, '/player_api.php');
    if (!action) return options.auth === undefined ? { user_info: { auth: 1, status: 'Active' } } : options.auth;
    if (action.endsWith('_categories')) return options.categories === undefined ? [category(1)] : options.categories;
    if (action === 'get_vod_streams' || action === 'get_series') {
      assert.ok(form.has('category_id'), 'never issue an unbounded full-catalog call');
      await options.onCategory?.(form.get('category_id')!);
      const key = form.get('category_id')!;
      return options.rows && Object.prototype.hasOwnProperty.call(options.rows, key)
        ? options.rows[key] : (action === 'get_series' ? [series(10)] : [movie(1)]);
    }
    if (action === 'get_vod_info') {
      const id = form.get('vod_id')!;
      return options.vodInfo?.(id) ?? { info: { tmdb_id: 27205 }, movie_data: movie(Number(id)) };
    }
    if (action === 'get_series_info') return options.seriesInfo?.(form.get('series_id')!) ?? {
      info: { tmdb: '70523', name: 'Dark', releaseDate: '2017-12-01' }, episodes: { 1: [episode()] },
    };
    throw new Error('Unexpected synthetic API action');
  });
}

function meta(value: Identity | null = identity): MetadataProvider {
  return { async resolve() { return value; } };
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof ProviderError && error.code === code;
}

function legacyXml(entries: Array<{ id: number; title: string; host?: string; action?: string }>): string {
  return '<?xml version="1.0" encoding="UTF-8"?><items>' + entries.map(entry =>
    `<channel><title><![CDATA[${Buffer.from(entry.title).toString('base64')}]]></title><description></description><playlist_url><![CDATA[${entry.host ?? settings.host}/enigma2.php?username=ignored&password=ignored&type=${entry.action ?? 'get_seasons'}&series_id=${entry.id}]]></playlist_url></channel>`).join('') + '</items>';
}

const seriesInfoIdentity = { name: 'Dark', releaseDate: '2017-12-01', tmdb: '70523' };
function cutSeriesInfo(info: unknown = seriesInfoIdentity): Raw {
  return new Raw(`{"info":${JSON.stringify(info)},"episodes":{"1":[{"id":\n...[truncated]`);
}
function xmlItems(entries: Array<{ title: string; kind: 'playlist_url' | 'stream_url'; url: string }>): string {
  return '<items>' + entries.map(entry => `<channel><title><![CDATA[${Buffer.from(entry.title).toString('base64')}]]></title><${entry.kind}><![CDATA[${entry.url}]]></${entry.kind}></channel>`).join('') + '</items>';
}
function seasonsXml(seasons: number[], id = '10'): string {
  return xmlItems(seasons.map(season => ({ title: ` Season ${season}`, kind: 'playlist_url',
    url: `${settings.host}/enigma2.php?username=returned-user&password=returned-password&type=get_series_streams&series_id=${id}&season=${season}` })));
}
function episodesXml(numbers: number[]): string {
  return xmlItems(numbers.map(number => ({ title: ` Episode ${String(number).padStart(2, '0')}`, kind: 'stream_url',
    url: `${settings.host}/series/returned-user/returned-password/${100 + number}.mkv` })));
}

test('native Xtream settings and missing credentials require no network', async () => {
  const fields = xtreamSettings();
  assert.deepEqual(fields.filter(field => field.key).map(field => field.key), ['host', 'username', 'password']);
  assert.equal(fields.find(field => field.key === 'password')?.isPassword, true);
  assert.equal(fields.find(field => field.key === 'username')?.isPassword, true);
  const http = fixture();
  for (const invalid of [null, {}, { ...settings, host: 'file:///private' }, { ...settings, password: '' }]) {
    await assert.rejects(createXtreamProvider(http, meta(), invalid).getStreams(parseRequest('27205', 'movie')), errorCode('configuration_required'));
  }
  assert.equal(http.calls.length, 0);
});

test('authentication checks the actual auth flag and active status before catalogs', async () => {
  for (const user_info of [{ auth: 0, status: 'Active' }, { auth: '1', status: 'Expired' }, { auth: false, status: 'Active' }]) {
    const http = fixture({ auth: { user_info } });
    await assert.rejects(createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie')), errorCode('authentication_failed'));
    assert.equal(http.calls.length, 1);
  }
  await assert.rejects(createXtreamProvider(fixture({ auth: {} }), meta(), settings).getStreams(parseRequest('27205', 'movie')), errorCode('invalid_response'));
});

test('all categories are completed at concurrency three, duplicate memberships deduplicate and variants survive', async () => {
  let active = 0; let maximum = 0;
  const http = fixture({
    categories: [1, 2, 3, 4, 5].map(category),
    rows: { 1: [movie(1)], 2: [], 3: [movie(2)], 4: [movie(1)], 5: [movie(5, '603', 'The Matrix')] },
    async onCategory() { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setImmediate(resolve)); active--; },
  });
  const metadata: MetadataProvider = { async resolve() { throw new Error('Exact IDs must not need external metadata'); } };
  const provider = createXtreamProvider(http, metadata, settings);
  const streams = await provider.getStreams(parseRequest('27205', 'movie'));
  assert.equal(maximum, 3);
  assert.equal(streams.length, 2);
  assert.ok(streams[0]!.url.endsWith('/1.mkv'));
  assert.ok(streams[1]!.url.endsWith('/2.mkv'));
  assert.ok(streams[0]!.url.includes('/synthetic%20user/synthetic%26%2Fpassword/'));
  assert.equal(http.calls.filter(call => call.form.get('action') === 'get_vod_streams').length, 5);
  await provider.getStreams(parseRequest('27205', 'movie'));
  assert.equal(http.calls.filter(call => call.form.get('action') === 'get_vod_streams').length, 10, 'no false persistent/global catalog cache');
});

test('truncated required movie categories never return an early successful match or use XML', async () => {
  const http = fixture({ categories: [category(1), category(2)], rows: { 1: [movie(1)], 2: new Raw('[{"stream_id":2') } });
  await assert.rejects(createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie')), errorCode('response_incomplete'));
  assert.equal(http.calls.some(call => call.url.includes('enigma2.php')), false);
  assert.equal(http.calls.some(call => call.form.get('action') === 'get_vod_info'), false);
});

test('null and error-shaped category responses are failures, not empty catalogs', async () => {
  for (const value of [null, { error: 'synthetic failure' }]) {
    const http = fixture({ rows: { 1: value } });
    await assert.rejects(createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie')), errorCode('invalid_response'));
  }
  const http = fixture({ categories: [] });
  assert.deepEqual(await createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie')), []);
});

test('IMDb strings in the field named tmdb keep their namespace and use verified cross-ID metadata', async () => {
  const http = fixture({ rows: { 1: [movie(1, 'tt1375666'), movie(2, '1375666', 'Different numeric namespace')] },
    vodInfo: id => ({ info: { tmdb_id: 'tt1375666' }, movie_data: movie(Number(id), 'tt1375666') }) });
  const streams = await createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie'));
  assert.equal(streams.length, 1);
  assert.ok(streams[0]!.url.endsWith('/1.mkv'));
  const direct = await createXtreamProvider(http, meta(null), settings).getStreams(parseRequest('tt1375666', 'movie'));
  assert.equal(direct.length, 1);
});

test('ID-less title matching requires exact normalized alias, year and a unique item', async () => {
  const rows = [movie(1, '', '[DE] Inception (2010) [GER] [1080p]'), movie(2, '0', 'Inception (2020)'), movie(3, '603', 'Inception (2010)')];
  const http = fixture({ rows: { 1: rows }, vodInfo: id => ({ info: {}, movie_data: movie(Number(id), '') }) });
  assert.equal((await createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie'))).length, 1);
  const ambiguous = fixture({ rows: { 1: [movie(1, '', 'Inception (2010)'), movie(2, '', 'Inception (2010)')] } });
  await assert.rejects(createXtreamProvider(ambiguous, meta(), settings).getStreams(parseRequest('27205', 'movie')), errorCode('ambiguous_match'));
  const missingYear = fixture({ rows: { 1: [movie(1, '', 'Inception')] } });
  assert.deepEqual(await createXtreamProvider(missingYear, meta(), settings).getStreams(parseRequest('27205', 'movie')), []);
});

test('a unique detail-confirmed ID-less 4K variant accompanies an indexed 1080p variant without external metadata', async () => {
  const http = fixture({ rows: { 1: [movie(1), movie(2, '', 'Inception (2010) [4K]')] },
    vodInfo: id => ({ movie_data: movie(Number(id), id === '1' ? '27205' : ''),
      info: { tmdb_id: '27205', video: { width: id === '1' ? 1920 : 3840, height: id === '1' ? 1080 : 2160 } } }),
  });
  let metadataCalls = 0;
  const metadata: MetadataProvider = { async resolve() { metadataCalls++; throw new Error('Local indexed identity is sufficient'); } };
  const streams = await createXtreamProvider(http, metadata, settings).getStreams(parseRequest('27205', 'movie'));
  assert.equal(metadataCalls, 0);
  assert.equal(streams.length, 2);
  assert.ok(streams.some(item => item.url.endsWith('/1.mkv') && item.name?.includes('1920x1080')));
  assert.ok(streams.some(item => item.url.endsWith('/2.mkv') && item.name?.includes('3840x2160')));
  assert.equal(http.calls.filter(call => call.form.get('action') === 'get_vod_info').length, 2);
});

test('local cross-ID identity confirms an IMDb-only supplemental detail for a TMDB request', async () => {
  const http = fixture({ rows: { 1: [{ ...movie(1), imdb_id: 'tt1375666' }, movie(2, '', 'Inception (2010) [4K]')] },
    vodInfo: id => ({ movie_data: movie(Number(id), id === '1' ? '27205' : ''),
      info: id === '1' ? { tmdb_id: '27205' } : { imdb_id: 'tt1375666' } }),
  });
  let metadataCalls = 0;
  const metadata: MetadataProvider = { async resolve() { metadataCalls++; throw new Error('Both public IDs are already established locally'); } };
  const streams = await createXtreamProvider(http, metadata, settings).getStreams(parseRequest('27205', 'movie'));
  assert.equal(metadataCalls, 0);
  assert.equal(streams.length, 2);
  assert.ok(streams.some(item => item.url.endsWith('/2.mkv')));
});

test('conflicting or unconfirmed ID-less details do not suppress verified indexed streams', async () => {
  for (const extra of [
    { movie_data: movie(2, ''), info: { tmdb_id: '603' } },
    { movie_data: { stream_id: 2, container_extension: 'mkv' }, info: {} },
  ]) {
    const http = fixture({ rows: { 1: [movie(1), movie(2, '', 'Inception (2010) [4K]')] },
      vodInfo: id => id === '2' ? extra : { movie_data: movie(1), info: { tmdb_id: '27205' } },
    });
    const streams = await createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie'));
    assert.equal(streams.length, 1);
    assert.ok(streams[0]!.url.endsWith('/1.mkv'));
  }
});

test('two ambiguous ID-less variants are omitted while the indexed match remains usable', async () => {
  const http = fixture({ rows: { 1: [movie(1), movie(2, '', 'Inception (2010) [4K]'), movie(3, '', 'Inception (2010) [1080p]')] } });
  const streams = await createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie'));
  assert.equal(streams.length, 1);
  assert.ok(streams[0]!.url.endsWith('/1.mkv'));
  assert.equal(http.calls.filter(call => call.form.get('action') === 'get_vod_info').length, 1);
});

test('detail identity conflicts cannot turn a title fallback into the wrong film', async () => {
  const http = fixture({ rows: { 1: [movie(1, '', 'Inception (2010)')] },
    vodInfo: id => ({ info: { tmdb_id: '603' }, movie_data: movie(Number(id), '') }) });
  await assert.rejects(createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie')), errorCode('invalid_response'));
});

test('series use exact integer/string coordinates and preserve explicit specials', async () => {
  const http = fixture({ seriesInfo: () => ({ info: { tmdb: '70523' }, episodes: {
    0: [episode(100, '0', '1')], 1: [episode(101, 1, '1'), episode(103, 1, 3)],
  } }) });
  const provider = createXtreamProvider(http, meta(showIdentity), settings);
  assert.ok((await provider.getStreams(parseRequest('70523', 'tv', 0, 1)))[0]!.url.endsWith('/100.mkv'));
  assert.ok((await provider.getStreams(parseRequest('70523', 'tv', 1, 3)))[0]!.url.endsWith('/103.mkv'));
  assert.deepEqual(await provider.getStreams(parseRequest('70523', 'tv', 1, 2)), []);
  assert.equal(http.calls.some(call => call.form.get('action') === 'get_vod_streams'), false);
});

test('null, boolean, conflicting and duplicate episode coordinates fail closed', async () => {
  for (const value of [episode(100, null, 1), episode(100, false, 1), episode(100, 0, ''), episode(100, 1, 1)]) {
    const http = fixture({ seriesInfo: () => ({ info: {}, episodes: { 0: [value] } }) });
    await assert.rejects(createXtreamProvider(http, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 0, 1)), errorCode('invalid_response'));
  }
  const http = fixture({ seriesInfo: () => ({ info: {}, episodes: { 1: [episode(1), episode(2)] } }) });
  await assert.rejects(createXtreamProvider(http, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 1, 1)), errorCode('ambiguous_match'));
  await assert.rejects(createXtreamProvider(http, meta(showIdentity), settings).getStreams({ type: 'tv', id: '70523:1:1', season: 0, episode: 1 }), errorCode('invalid_request'));
});

test('technical fields come from metadata, one English audio descriptor is not an English-only label', async () => {
  const http = fixture({ vodInfo: id => ({ movie_data: movie(Number(id)), info: {
    video: { width: 1920, height: 800, codec_name: 'hevc' },
    audio: { codec_name: 'aac', channels: 2, channel_layout: 'stereo', tags: { language: 'eng' } },
    size_bytes: '3221225472',
    subtitles: [
      { file: '/captions/de.vtt', language: 'de', label: 'Deutsch', headers: { Referer: 'https://source.example.invalid/' } },
      { stream_index: 3, codec_name: 'ass', language: 'de' },
    ],
  } }) });
  const result = (await createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie')))[0]!;
  assert.equal(result.quality, '1920x800');
  assert.equal(result.size, '3.00 GiB');
  assert.equal(result.language, undefined);
  assert.ok(!/English|eng\b|HDR/i.test(result.title));
  assert.ok(result.title.includes('1920x800'));
  assert.ok(result.title.includes('HEVC'));
  assert.ok(result.title.includes('AAC stereo'));
  assert.ok(result.name?.includes('1920x800'), 'native clients preferring name retain verified technical information');
  assert.equal(result.subtitles?.length, 1);
  assert.equal(result.subtitles?.[0]?.language, 'de');
  assert.equal(result.subtitles?.[0]?.url, settings.host + '/captions/de.vtt');
});

test('a real direct_source is usable without an invented container extension', async () => {
  const http = fixture({ rows: { 1: [{ stream_id: 1, tmdb: '27205', name: 'Inception' }] },
    vodInfo: () => ({ info: {}, movie_data: { stream_id: 1, direct_source: 'https://media.example.invalid/declared.m3u8?fixture=1' } }) });
  assert.equal((await createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie')))[0]?.url,
    'https://media.example.invalid/declared.m3u8?fixture=1');
  const missing = fixture({ rows: { 1: [{ stream_id: 1, tmdb: '27205', name: 'Inception' }] },
    vodInfo: () => ({ info: {}, movie_data: { stream_id: 1 } }) });
  await assert.rejects(createXtreamProvider(missing, meta(), settings).getStreams(parseRequest('27205', 'movie')), errorCode('invalid_response'));
});

test('incomplete series JSON can use complete XML but confirms each legacy candidate through current detail IDs', async () => {
  const http = fixture({ rows: { 1: new Raw('[{"series_id":') },
    legacy: () => new Raw(legacyXml([{ id: 10, title: 'Dark (2017)' }, { id: 11, title: 'Dark (2017)' }, { id: 12, title: 'Other (2017)' }])),
    seriesInfo: id => ({ info: { name: 'Dark', releaseDate: '2017-12-01', tmdb: id === '10' ? '70523' : '99999' }, episodes: { 1: [episode(Number(id) * 10)] } }),
  });
  const result = await createXtreamProvider(http, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 1, 1));
  assert.equal(result.length, 1);
  assert.ok(result[0]!.url.endsWith('/100.mkv'));
  assert.equal(http.calls.filter(call => call.form.get('action') === 'get_series_info' && call.form.get('series_id') === '10').length, 1);
  assert.equal(http.calls.some(call => call.form.get('series_id') === '12'), false);
  assert.ok(http.calls.every(call => new URL(call.url).origin === new URL(settings.host).origin));
  const legacyCall = http.calls.find(call => new URL(call.url).pathname === '/enigma2.php')!;
  assert.equal(legacyCall.options?.method, 'GET');
  assert.equal(legacyCall.options?.body, undefined);
  assert.ok(legacyCall.url.includes(encodeURIComponent(settings.username)));
  assert.equal(legacyCall.form.get('username'), settings.username, 'returned XML credentials are never reused');
  assert.ok(http.calls.every(call => call.form.get('type') !== 'get_seasons'), 'returned playlist URLs are parsed, never followed');
});

test('a transient XML gateway timeout receives one retry and still requires current series identity confirmation', async () => {
  let attempts = 0;
  const http = fixture({ rows: { 1: new Raw('[{"series_id":') },
    legacy: () => ++attempts === 1 ? new Raw('Gateway timeout', 504)
      : new Raw(legacyXml([{ id: 10, title: 'Dark (2017)' }])),
  });
  const result = await createXtreamProvider(http, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 1, 1));
  assert.equal(result.length, 1);
  assert.equal(attempts, 2);
  assert.equal(http.calls.filter(call => call.form.get('action') === 'get_series_info').length, 1);
});

test('persistent metadata 503 responses stop after two requests for both JSON and XML', async () => {
  const json = fixture({ rows: { 1: new Raw('Service unavailable', 503) } });
  await assert.rejects(createXtreamProvider(json, meta(), settings).getStreams(parseRequest('27205', 'movie')), errorCode('request_failed'));
  assert.equal(json.calls.filter(call => call.form.get('action') === 'get_vod_streams').length, 2);
  let xmlAttempts = 0;
  const xml = fixture({ rows: { 1: new Raw('[') }, legacy: () => { xmlAttempts++; return new Raw('Service unavailable', 503); } });
  await assert.rejects(createXtreamProvider(xml, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 1, 1)), errorCode('request_failed'));
  assert.equal(xmlAttempts, 2);
  assert.equal(xml.calls.some(call => call.form.get('action') === 'get_series_info'), false);
});

test('metadata retries exclude rate limits, bad requests, auth rejection and challenges', async () => {
  for (const status of [400, 401, 403, 429]) {
    const http = fixture({ rows: { 1: new Raw('Rejected', status) } });
    await assert.rejects(createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie')));
    assert.equal(http.calls.filter(call => call.form.get('action') === 'get_vod_streams').length, 1);
  }
  const challenge = fixture({ rows: { 1: new Raw('<title>Just a moment</title>', 503) } });
  await assert.rejects(createXtreamProvider(challenge, meta(), settings).getStreams(parseRequest('27205', 'movie')), errorCode('source_blocked'));
  assert.equal(challenge.calls.filter(call => call.form.get('action') === 'get_vod_streams').length, 1);
});

test('oversized series detail uses complete info plus exact legacy season and episode without an unrelated metadata lookup', async () => {
  const full = JSON.stringify({ info: seriesInfoIdentity, episodes: { 1: [{ ...episode(), info: { plot: 'x'.repeat(1_100_000) } }] } });
  assert.ok(Buffer.byteLength(full) > 1_048_576);
  const http = fixture({ categories: [category(1), category(2)], rows: { 1: [series(10)], 2: new Raw('[') },
    legacy: () => new Raw(legacyXml([{ id: 99, title: 'Unrelated Show (2020)' }])),
    seriesInfo: () => new Raw(full.slice(0, 1_048_576) + '\n...[truncated]'),
    seasonsXml: id => new Raw(seasonsXml([0, 1, 2], id)),
    episodesXml: (id, season) => { assert.equal(id, '10'); assert.equal(season, '0'); return new Raw(episodesXml([1, 3])); },
  });
  let metadataCalls = 0;
  const metadata: MetadataProvider = { async resolve() { metadataCalls++; throw new Error('No giant external lookup needed for an exact local ID/title/year'); } };
  const result = await createXtreamProvider(http, metadata, settings).getStreams(parseRequest('70523', 'tv', 0, 1));
  assert.equal(metadataCalls, 0);
  assert.equal(result.length, 1);
  assert.ok(result[0]!.url.endsWith('/101.mkv'));
  assert.ok(result[0]!.url.includes('/synthetic%20user/synthetic%26%2Fpassword/'));
  assert.ok(!result[0]!.url.includes('returned-user'));
  assert.ok(result[0]!.title.includes('S00E01'));
  assert.equal(http.calls.filter(call => call.form.get('type') === 'get_seasons').length, 1);
  assert.equal(http.calls.filter(call => call.form.get('type') === 'get_series_streams').length, 1);
  assert.equal(http.calls.filter(call => call.form.get('action') === 'get_series_info').length, 1);
});

test('legacy detail overflow does not substitute a missing season or episode', async () => {
  const missingSeason = fixture({ seriesInfo: () => cutSeriesInfo(), seasonsXml: id => new Raw(seasonsXml([2], id)) });
  assert.deepEqual(await createXtreamProvider(missingSeason, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 1, 1)), []);
  assert.equal(missingSeason.calls.some(call => call.form.get('type') === 'get_series_streams'), false);
  const missingEpisode = fixture({ seriesInfo: () => cutSeriesInfo(), seasonsXml: id => new Raw(seasonsXml([1], id)),
    episodesXml: () => new Raw(episodesXml([2, 3])) });
  assert.deepEqual(await createXtreamProvider(missingEpisode, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 1, 1)), []);
});

test('series detail overflow requires a fully parsed matching info object before any legacy episode lookup', async () => {
  const cases: Array<[Raw, string]> = [
    [new Raw('{"info":{"name":"Dark\n...[truncated]'), 'response_incomplete'],
    [cutSeriesInfo({ ...seriesInfoIdentity, tmdb: '99999' }), 'invalid_response'],
    [cutSeriesInfo({ ...seriesInfoIdentity, series_id: '99999' }), 'invalid_response'],
    [cutSeriesInfo({ ...seriesInfoIdentity, releaseDate: '2020-01-01' }), 'ambiguous_match'],
    [cutSeriesInfo({ ...seriesInfoIdentity, name: 'Other Show' }), 'ambiguous_match'],
  ];
  for (const [detail, code] of cases) {
    const http = fixture({ seriesInfo: () => detail, seasonsXml: id => new Raw(seasonsXml([1], id)) });
    await assert.rejects(createXtreamProvider(http, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 1, 1)), errorCode(code));
    assert.equal(http.calls.some(call => call.form.get('type') === 'get_seasons'), false);
  }
});

test('legacy season links validate parent, type, origin, coordinates and duplicate seasons', async () => {
  const valid = seasonsXml([1]);
  const cases: Array<[string, string]> = [
    [valid.replace('series_id=10', 'series_id=99'), 'invalid_response'],
    [valid.replace('type=get_series_streams', 'type=get_vod_streams'), 'invalid_response'],
    [valid.replace(settings.host, 'https://other.example.invalid'), 'invalid_response'],
    [valid.replace('season=1', 'season=2'), 'invalid_response'],
    [seasonsXml([1, 1]), 'ambiguous_match'],
    [valid.replace('</items>', ''), 'response_incomplete'],
  ];
  for (const [xml, code] of cases) {
    const http = fixture({ seriesInfo: () => cutSeriesInfo(), seasonsXml: () => new Raw(xml) });
    await assert.rejects(createXtreamProvider(http, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 1, 1)), errorCode(code));
    assert.equal(http.calls.some(call => call.form.get('type') === 'get_series_streams'), false);
  }
});

test('legacy episodes validate explicit numbers and numeric files without following returned stream URLs', async () => {
  const valid = episodesXml([1]);
  const cases: Array<[string, string]> = [
    [valid.replace('/series/', '/movie/'), 'invalid_response'],
    [valid.replace(settings.host, 'https://other.example.invalid'), 'invalid_response'],
    [valid.replace('/101.mkv', '/not-an-id.mkv'), 'invalid_response'],
    [episodesXml([1, 1]), 'ambiguous_match'],
    [valid.replace('</items>', ''), 'response_incomplete'],
    [xmlItems([{ title: 'Pilot', kind: 'stream_url', url: settings.host + '/series/x/y/101.mkv' }]), 'invalid_response'],
  ];
  for (const [xml, code] of cases) {
    const http = fixture({ seriesInfo: () => cutSeriesInfo(), seasonsXml: id => new Raw(seasonsXml([1], id)), episodesXml: () => new Raw(xml) });
    await assert.rejects(createXtreamProvider(http, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 1, 1)), errorCode(code));
    assert.ok(http.calls.every(call => ['/player_api.php', '/enigma2.php'].includes(new URL(call.url).pathname)));
  }
});

test('XML fallback rejects truncation, malformed XML, wrong origins and unusable legacy metadata', async () => {
  const complete = legacyXml([{ id: 10, title: 'Dark (2017)' }]);
  const cases: Array<[string, string]> = [
    [complete.replace('</items>', ''), 'response_incomplete'],
    ['<items></items>', 'response_incomplete'],
    [complete.replace('</title>', '</wrong>'), 'invalid_response'],
    [legacyXml([{ id: 10, title: 'Dark (2017)', host: 'https://other.example.invalid' }]), 'invalid_response'],
    [legacyXml([{ id: 10, title: 'Dark (2017)', action: 'get_vod_streams' }]), 'invalid_response'],
  ];
  for (const [xml, expected] of cases) {
    const http = fixture({ rows: { 1: new Raw('[') }, legacy: () => new Raw(xml) });
    await assert.rejects(createXtreamProvider(http, meta(showIdentity), settings).getStreams(parseRequest('70523', 'tv', 1, 1)), errorCode(expected));
  }
  const http = fixture({ rows: { 1: new Raw('[') }, legacy: () => new Raw(complete) });
  await assert.rejects(createXtreamProvider(http, meta(null), settings).getStreams(parseRequest('70523', 'tv', 1, 1)), errorCode('response_incomplete'));
});

test('unknown upstream exceptions and malformed XML do not expose credentials in thrown errors', async () => {
  const http = mockHttp(() => { throw new Error(settings.password + ' https://private.example.invalid/'); });
  await assert.rejects(createXtreamProvider(http, meta(), settings).getStreams(parseRequest('27205', 'movie')), error => {
    assert.ok(error instanceof ProviderError);
    assert.ok(!error.message.includes(settings.password));
    assert.ok(!error.message.includes('private.example.invalid'));
    return true;
  });
});
