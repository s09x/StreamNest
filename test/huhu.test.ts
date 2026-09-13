import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getHuhuStreams, inspectHuhuStreams } from '../src/native/huhu.js';
import { ProviderError } from '../src/native/errors.js';
import type { ContentRequest, HttpClient, NativeStream, RequestOptions, TextResponse } from '../src/native/types.js';
import { createNativeRuntime, type FixtureRoute } from './helpers/native-runtime.js';
import { veevApiUrl, veevInfo, veevPage, veevPageUrl } from './helpers/veev-fixture.js';

const origin = 'https://huhu.to';
const itemUrl = `${origin}/mediaurl-item.json`;
const sourceUrl = `${origin}/mediaurl-source.json`;
const movie: ContentRequest = { type: 'movie', id: '901', tmdbId: '901' };
const movieItem = { type: 'movie', ids: { tmdb_id: '901', imdb_id: 'tt0000901' }, name: 'Fixture Film', releaseDate: '2020-01-01' };
const series: ContentRequest = { type: 'tv', id: '902', tmdbId: '902', season: 0, episode: 1 };
const seriesItem = { type: 'series', ids: { tmdb_id: '902', imdb_id: 'tt0000902' }, name: 'Fixture Series', releaseDate: '2020-01-01',
  episodes: [{ type: 'episode', ids: { tmdb_episode_id: '903' }, name: 'Fixture Special', season: 0, episode: 1 },
    { type: 'episode', ids: { tmdb_episode_id: '904' }, name: 'Fixture Episode', season: 1, episode: 1 }] };
const voe = 'https://voe.sx/e/FixtureFile01';
const vixeo = 'https://vidsonic.net/e/FixtureFile02';
const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="ger",URI="de.m3u8"\n'
  + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",URI="en.m3u8"\n'
  + '#EXT-X-STREAM-INF:RESOLUTION=1280x720,CODECS="avc1.640020,mp4a.40.2",AUDIO="audio"\nvideo.m3u8\n';
function source(url = voe, languages?: unknown, tag?: string) {
  return { type: 'url', url, name: 'Server C1', ...(languages === undefined ? {} : { languages }), ...(tag ? { tag } : {}) };
}
function response(url: string, value: unknown, status = 200): TextResponse {
  return { url, status, text: typeof value === 'string' ? value : JSON.stringify(value), header: () => null };
}
function failure(code: string) { return (error: unknown) => error instanceof ProviderError && error.code === code; }
function encodeVoe(value: unknown): string {
  const inner = Buffer.from(JSON.stringify(value)).toString('base64');
  const shifted = [...inner].reverse().map(letter => String.fromCharCode(letter.charCodeAt(0) + 3)).join('');
  return Buffer.from(shifted, 'latin1').toString('base64').replace(/[A-Za-z]/g, letter => {
    const start = letter <= 'Z' ? 65 : 97;
    return String.fromCharCode(start + (letter.charCodeAt(0) - start + 13) % 26);
  });
}
function player(url: string): string {
  const address = new URL(url);
  const id = address.pathname.split('/').filter(Boolean).pop()!;
  const media = `https://media.example.invalid/${address.hostname}/${id}.m3u8?fixture=one%2Btwo`;
  if (address.hostname === 'voe.sx') return `<html><head><title>Watch Fixture.1080p.mkv - VOE | fixture</title></head><body>
    <script type="application/json">${JSON.stringify([encodeVoe({ source: media,
      captions: [{ file: '//captions.example.invalid/de.vtt?fixture=one%2Btwo', language: 'ger', label: 'German (FORCED)' }],
    })])}</script></body></html>`;
  const config = { videoId: id, isMp4: false, source: Buffer.from(media).reverse().toString('hex'),
    subtitles: [{ path: '/captions/en.vtt', lang: 'eng', label: 'English' }] };
  return `<html><body><div id="streamsonic-player-root" data-config="${Buffer.from(JSON.stringify(config)).toString('base64')}"></div></body></html>`;
}
type Call = { url: string; options: RequestOptions };
function setup(options: { item?: unknown; sources?: unknown; handle?: (call: Call) => TextResponse | undefined | Promise<TextResponse | undefined> } = {}) {
  const calls: Call[] = [];
  const http: HttpClient = {
    async request(url, request = {}) {
      const call = { url, options: request }; calls.push(call);
      const overridden = await options.handle?.(call);
      if (overridden) return overridden;
      if (url === itemUrl) return response(url, Object.hasOwn(options, 'item') ? options.item : movieItem);
      if (url === sourceUrl) return response(url, Object.hasOwn(options, 'sources') ? options.sources : [source(voe, ['de'], 'HD')]);
      if (/^https:\/\/(?:voe\.sx|vidsonic\.net|vixeo\.io)\//.test(url)) return response(url, player(url));
      if (url.startsWith('https://media.example.invalid/')) return response(url, master);
      assert.fail(`Unexpected fixture request: ${url}`);
    },
    async json(url, request) { return JSON.parse((await this.request(url, request)).text); },
    session() { assert.fail('Huhu does not require a source cookie session'); }, cookies() { return {}; },
  };
  return { http, calls };
}

test('Huhu resolves a TMDB movie through both hosters with real HLS quality, languages and subtitle headers', async () => {
  const fixture = setup({ sources: [source(voe, ['de'], 'HD'), source(vixeo, ['de'])] });
  const streams = await getHuhuStreams(fixture.http, movie);
  assert.deepEqual(streams.map(stream => [stream.name?.split('Huhu / ')[1], stream.quality, stream.language]), [
    ['VOE', '720p', 'de / en'], ['Vixeo', '720p', 'de / en'],
  ]);
  assert.ok(streams.every(stream => stream.name === stream.title), 'Nuvio must not replace the metadata title with a generic provider name');
  assert.match(streams[0]!.title, /HD.*1280x720.*VOE/);
  assert.equal(streams[0]!.subtitles?.[0]?.url, 'https://captions.example.invalid/de.vtt?fixture=one%2Btwo');
  assert.equal(streams[0]!.subtitles?.[0]?.language, 'de');
  assert.equal(streams[0]!.subtitles?.[0]?.name, 'German (FORCED)');
  assert.equal(streams[0]!.subtitles?.[0]?.headers?.Referer, voe);
  assert.equal(streams[1]!.subtitles?.[0]?.headers?.Referer, vixeo);
  for (const call of fixture.calls.filter(call => call.url.startsWith(origin))) {
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers?.['Content-Type'], 'application/json; charset=utf-8');
    assert.deepEqual(JSON.parse(call.options.body!), { language: 'de', region: 'DE', type: 'movie', ids: { tmdb_id: '901' }, name: '' });
  }
  assert.equal(fixture.calls.length, 6, 'ID lookup needs two source calls and two requests per hoster');
});

test('Huhu maps an IMDb request using the validated item response without title search or another metadata service', async () => {
  const fixture = setup();
  await getHuhuStreams(fixture.http, { type: 'movie', id: 'tt0000901', imdbId: 'tt0000901' });
  assert.deepEqual(JSON.parse(fixture.calls[0]!.options.body!).ids, { imdb_id: 'tt0000901' });
  assert.deepEqual(JSON.parse(fixture.calls[1]!.options.body!).ids, { tmdb_id: '901' });
  assert.ok(fixture.calls.every(call => !/cinemeta|themoviedb/.test(call.url)));
});

test('Huhu validates specials and sends exact episode coordinates to the source endpoint', async () => {
  const fixture = setup({ item: seriesItem, sources: [source(vixeo, ['de'])] });
  const streams = await getHuhuStreams(fixture.http, series);
  assert.match(streams[0]!.title, /Fixture Series S00E01/);
  assert.deepEqual(JSON.parse(fixture.calls[0]!.options.body!), { language: 'de', region: 'DE', type: 'series', ids: { tmdb_id: '902' }, name: '' });
  assert.deepEqual(JSON.parse(fixture.calls[1]!.options.body!), { language: 'de', region: 'DE', type: 'series', ids: { tmdb_id: '902' }, name: '',
    episode: { ids: {}, season: 0, episode: 1 } });
});

test('Huhu ignores echoed missing episodes and successful empty-name placeholders without querying sources', async () => {
  const missing = setup({ item: { ...seriesItem, episode: { season: 99, episode: 1, ids: {} } } });
  assert.deepEqual(await getHuhuStreams(missing.http, { ...series, season: 99 }), []);
  assert.equal(missing.calls.length, 1);
  const placeholder = setup({ item: { type: 'movie', ids: { tmdb_id: '901' }, name: '', nameTranslations: {} } });
  assert.deepEqual(await getHuhuStreams(placeholder.http, movie), []);
  assert.equal(placeholder.calls.length, 1);
});

test('Huhu rejects mismatched identity, malformed item responses and ambiguous episode coordinates', async () => {
  for (const item of [null, [], {}, { ...movieItem, type: 'series' }, { ...movieItem, ids: { tmdb_id: '999' } },
    { ...movieItem, name: ' ' }, { ...movieItem, name: 'https://example.invalid/private' }]) {
    const fixture = setup({ item });
    await assert.rejects(getHuhuStreams(fixture.http, movie), failure('invalid_response'));
    assert.equal(fixture.calls.length, 1);
  }
  const imdb = setup({ item: { ...movieItem, ids: { ...movieItem.ids, imdb_id: 'tt0000999' } } });
  await assert.rejects(getHuhuStreams(imdb.http, { ...movie, id: 'tt0000901', imdbId: 'tt0000901' }), failure('invalid_response'));
  const duplicate = setup({ item: { ...seriesItem, episodes: [...seriesItem.episodes, seriesItem.episodes[0]] } });
  await assert.rejects(getHuhuStreams(duplicate.http, series), failure('ambiguous_match'));
  const malformed = setup({ item: { ...seriesItem, episodes: [{ type: 'episode', season: '0', episode: 1 }] } });
  await assert.rejects(getHuhuStreams(malformed.http, series), failure('invalid_response'));
  const absent = setup({ item: { ...seriesItem, episodes: undefined } });
  await assert.rejects(getHuhuStreams(absent.http, series), failure('invalid_response'));
});

test('Huhu rejects conflicting public IDs and invalid episodes before network access', async () => {
  for (const request of [{ ...movie, tmdbId: '999' }, { ...movie, imdbId: 'not-an-id' }, { ...movie, episode: 1 },
    { ...series, season: -1 }, { ...series, id: '902:1:1' }, { ...series, episode: undefined }]) {
    const fixture = setup();
    await assert.rejects(getHuhuStreams(fixture.http, request), failure('invalid_request'));
    assert.equal(fixture.calls.length, 0);
  }
});

test('Huhu treats HTTP-200 API errors, redirects, truncation and response limits as failures with fixed messages', async () => {
  for (const [value, code] of [[{ error: 'synthetic-private-value' }, 'request_failed'], ['{"ids":', 'response_incomplete'],
    ['x'.repeat(1024 * 1024 + 1), 'response_incomplete']] as const) {
    const fixture = setup({ item: value });
    await assert.rejects(getHuhuStreams(fixture.http, movie), error => failure(code)(error) && !(error as Error).message.includes('synthetic-private-value'));
  }
  const redirected = setup({ handle: ({ url }) => url === itemUrl ? response('https://other.example.invalid/item', movieItem) : undefined });
  await assert.rejects(getHuhuStreams(redirected.http, movie), failure('invalid_response'));
  for (const [status, body, code] of [[429, '{}', 'request_failed'], [403, '<title>Just a moment</title>', 'source_blocked']] as const) {
    const fixture = setup({ handle: ({ url }) => url === itemUrl ? response(url, body, status) : undefined });
    await assert.rejects(getHuhuStreams(fixture.http, movie), failure(code));
  }
});

test('Huhu distinguishes empty lists, explicitly unsupported sources and malformed or excessive responses', async () => {
  const empty = setup({ sources: [] });
  assert.deepEqual(await getHuhuStreams(empty.http, movie), []);
  assert.equal(empty.calls.length, 2);
  for (const [sources, code] of [[{}, 'invalid_response'], [null, 'invalid_response'], ['[{', 'response_incomplete'],
    [[source('https://unsupported.example.invalid/watch/fixture')], 'unsupported_hoster'],
    [[{ type: 'torrent', url: 'magnet:synthetic' }], 'unsupported_hoster'],
    [[{ type: 'url' }], 'invalid_response'], [[source('https://synthetic:secret@voe.sx/e/FixtureFile01')], 'invalid_response'],
    [Array.from({ length: 257 }, () => source(voe)), 'response_incomplete']] as const) {
    const fixture = setup({ sources });
    await assert.rejects(getHuhuStreams(fixture.http, movie), failure(code));
    assert.equal(fixture.calls.length, 2);
  }
});

test('Huhu deduplicates VOE watch/embed links, retains declared languages and tags, and does not infer HD from upload titles', async () => {
  const fixture = setup({ sources: [source(voe, ['ger'], 'HD'), source(voe.replace('/e/', '/'), ['eng'], 'SUB'), source(voe, ['ger'], 'HD')],
    handle: ({ url }) => url.startsWith('https://media.example.invalid/') ? response(url, '#EXTM3U\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n') : undefined });
  const streams = await getHuhuStreams(fixture.http, movie);
  assert.equal(streams.length, 1);
  assert.equal(streams[0]!.quality, undefined);
  assert.equal(streams[0]!.language, 'de / en');
  assert.match(streams[0]!.name!, /Source: HD \| Source: SUB/);
  assert.equal(fixture.calls.filter(call => call.url.startsWith('https://voe.sx/')).length, 1);
  const unknown = setup({ sources: [source(voe)], handle: fixtureCall => fixtureCall.url.startsWith('https://media.example.invalid/')
    ? response(fixtureCall.url, '#EXTM3U\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n') : undefined });
  assert.equal((await getHuhuStreams(unknown.http, movie))[0]!.language, undefined, 'The German API locale does not declare a media language');
});

test('Huhu preserves case-distinct Vixeo IDs, separate origins and exact signed VOE query values', async () => {
  const urls = ['https://vixeo.io/e/CaseVideoABC1', 'https://vixeo.io/e/caseVideoABC1', 'https://vidsonic.net/e/CaseVideoABC1',
    `${voe}?fixture=one%2Btwo`, `${voe}?fixture=one%20two`];
  const fixture = setup({ sources: urls.map(url => source(url)) });
  const streams = await getHuhuStreams(fixture.http, movie);
  assert.equal(streams.length, 4, 'Only identical final media URLs are collapsed');
  for (const url of urls) assert.equal(fixture.calls.filter(call => call.url === url).length, 1);
});

test('Huhu bounds concurrent mirrors, preserves source order and isolates malformed rows and failed hosters', async () => {
  let active = 0; let peak = 0;
  const completions: number[] = [];
  const urls = Array.from({ length: 7 }, (_, index) => `https://vidsonic.net/e/FixtureFile${String(index).padStart(2, '0')}`);
  const delays = [35, 2, 20, 2, 10, 1, 1];
  const fixture = setup({ sources: [null, ...urls.map(url => source(url)), source('https://vidaraa.cc/e/ExcludedFile1')], handle: async ({ url }) => {
    const index = urls.indexOf(url);
    if (index < 0) return undefined;
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, delays[index])); completions.push(index);
      if (index === 2) throw new ProviderError('source_blocked');
      return response(url, player(url));
    } finally { active--; }
  } });
  const streams = await getHuhuStreams(fixture.http, movie);
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(completions[0], 1);
  assert.deepEqual(streams.map(stream => /FixtureFile(\d+)/.exec(stream.url)?.[1]), ['00', '01', '03', '04', '05', '06']);
  assert.ok(!fixture.calls.some(call => call.url.includes('vidaraa.cc')));
});

test('Huhu propagates the first source-order failure when every offered mirror fails', async () => {
  const fixture = setup({ sources: [source(voe), source(vixeo)], handle: async ({ url }) => {
    if (url !== voe && url !== vixeo) return undefined;
    await new Promise(resolve => setTimeout(resolve, url === voe ? 15 : 1));
    throw new ProviderError(url === voe ? 'request_failed' : 'source_blocked');
  } });
  await assert.rejects(getHuhuStreams(fixture.http, movie), failure('request_failed'));
});

test('Huhu rejects an invalid HLS mirror while preserving another playable hoster', async () => {
  const fixture = setup({ sources: [source(voe), source(vixeo)], handle: ({ url }) => url.includes('/voe.sx/')
    ? response(url, '<html><body>Expired</body></html>') : undefined });
  const streams = await getHuhuStreams(fixture.http, movie);
  assert.deepEqual(streams.map(stream => stream.name?.split('Huhu / ')[1]), ['Vixeo']);
});

test('Huhu resolves more than the old 32-mirror limit and reports every input row', async () => {
  const sources = Array.from({ length: 40 }, (_, index) => source(`https://voe.sx/e/Fixture${String(index).padStart(5, '0')}`, ['de']));
  const fixture = setup({ sources });
  const result = await inspectHuhuStreams(fixture.http, movie);
  assert.equal(result.streams.length, 40);
  assert.equal(result.sources.length, 40);
  assert.ok(result.sources.every(item => item.status === 'resolved'));
  assert.equal(fixture.calls.length, 82);
});

test('Huhu keeps source 1080p labels visible when delivered HLS dimensions differ', async () => {
  const fixture = setup({ sources: [source(voe, ['de'], '1080p')] });
  const [stream] = await getHuhuStreams(fixture.http, movie);
  assert.equal(stream?.quality, '720p');
  assert.match(stream!.name!, /Source: 1080p/);
  assert.match(stream!.name!, /Video: 720p/);
  assert.equal(stream!.name, stream!.title, 'This is the exact field Nuvio maps to the visible stream name');
});

test('Huhu reports unavailable, unsupported, malformed and duplicate entries without suppressing successful streams', async () => {
  const legacyDood = 'https://dood.yt/w/AbCd123456';
  const fixture = setup({ sources: [source(voe, ['de'], '1080p'), source(legacyDood, ['de'], '1080p'),
    source('https://unsupported.example.invalid/watch/fixture', ['de']), null, source(voe.replace('/e/', '/'), ['en'], 'HD')],
    handle: ({ url }) => url === legacyDood ? response(url, 'File not found', 404) : undefined });
  const result = await inspectHuhuStreams(fixture.http, movie);
  assert.equal(result.streams.length, 1);
  assert.deepEqual(result.sources.map(item => item.status), ['resolved', 'unavailable', 'unsupported', 'failed', 'resolved']);
  assert.equal(result.sources[1]!.tag, '1080p');
  assert.equal(result.sources[1]!.hoster, 'DoodStream');
  assert.equal(result.sources[4]!.duplicateOf, 1);
  assert.equal(fixture.calls.filter(call => call.url.startsWith('https://voe.sx/')).length, 1);
  assert.ok(!JSON.stringify(result.sources).includes('https://'), 'Diagnostics do not expose media URLs or tokens');
});

test('Huhu preserves all Veev video variants and the source quality label', async () => {
  const fixture = setup({ sources: [source(veevPageUrl, ['de'], '1080p')], handle: ({ url }) => {
    if (url === veevPageUrl) return response(url, veevPage());
    if (url === veevApiUrl) return response(url, veevInfo());
    return undefined;
  } });
  const result = await inspectHuhuStreams(fixture.http, movie);
  assert.deepEqual(result.streams.map(stream => stream.quality), ['720p', '1080p']);
  assert.ok(result.streams.every(stream => stream.name?.includes('Source: 1080p')));
  assert.equal(result.sources[0]!.streamCount, 2);
});

const bundle = () => readFile(new URL('../providers/huhu.js', import.meta.url), 'utf8');
function route(url: string, value: unknown, method = 'GET'): FixtureRoute {
  return { url, method, body: typeof value === 'string' ? value : JSON.stringify(value) };
}
for (const mobileUrl of [false, true]) for (const isSeries of [false, true]) {
  test(`Huhu built bundle resolves ${isSeries ? 'IMDb specials' : 'TMDB movies'} in QuickJS (mobile URL: ${mobileUrl})`, async () => {
    const sources = [source(voe, ['de'], 'HD'), source(vixeo, ['de'])];
    const routes = [route(itemUrl, isSeries ? seriesItem : movieItem, 'POST'), route(sourceUrl, sources, 'POST')];
    for (const url of [voe, vixeo]) {
      routes.push(route(url, player(url)));
      const address = new URL(url);
      routes.push(route(`https://media.example.invalid/${address.hostname}/${address.pathname.split('/').pop()}.m3u8?fixture=one%2Btwo`, master));
    }
    const runtime = await createNativeRuntime(await bundle(), { routes, mobileUrl, maxStackSize: 256 * 1024 });
    try {
      const result = await runtime.run(isSeries ? `module.exports.getStreams('tt0000902:0:1','series')` : `module.exports.getStreams('tmdb:901','movie')`);
      assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
      if (!result.ok) return;
      const streams = result.value as NativeStream[];
      assert.equal(streams.length, 2);
      assert.deepEqual(streams.map(stream => stream.quality), ['720p', '720p']);
      assert.equal(streams[0]!.subtitles?.[0]?.url, 'https://captions.example.invalid/de.vtt?fixture=one%2Btwo');
      assert.equal(runtime.value('typeof Buffer'), 'undefined');
      const calls = runtime.value('__requests') as Array<{ url: string; body?: string }>;
      const initial = JSON.parse(calls.find(call => call.url === itemUrl)!.body!);
      assert.deepEqual(initial.ids, isSeries ? { imdb_id: 'tt0000902' } : { tmdb_id: '901' });
      const requested = JSON.parse(calls.find(call => call.url === sourceUrl)!.body!);
      assert.deepEqual(requested.ids, { tmdb_id: isSeries ? '902' : '901' });
      assert.deepEqual(requested.episode, isSeries ? { ids: {}, season: 0, episode: 1 } : undefined);
      assert.equal(calls.length, 6);
    } finally { runtime.dispose(); }
  });
}

test('Huhu built bundle rejects API errors and conflicting episodes without exposing upstream messages', async () => {
  const runtime = await createNativeRuntime(await bundle(), { mobileUrl: true,
    routes: [route(itemUrl, { error: 'synthetic-private-value' }, 'POST')] });
  try {
    const invalid = await runtime.run(`module.exports.getStreams('902:0:1','tv',1,1)`);
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, 'invalid_request');
    assert.deepEqual(runtime.value('__requests'), []);
    const result = await runtime.run(`module.exports.getStreams('901','movie')`);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'request_failed');
      assert.equal(result.error.message, 'StreamNest: a source request failed.');
    }
  } finally { runtime.dispose(); }
});

for (const mobileUrl of [false, true]) test(`built Huhu preserves multiple Veev variants, visible labels and complete source reports (Mobile: ${mobileUrl})`, async () => {
  const legacy = 'https://dood.yt/w/AbCd123456';
  const runtime = await createNativeRuntime(await bundle(), { mobileUrl, maxStackSize: 256 * 1024, routes: [
    route(itemUrl, movieItem, 'POST'), route(sourceUrl, [source(veevPageUrl, ['de'], '1080p'), source(legacy, ['de'], '1080p')], 'POST'),
    route(veevPageUrl, veevPage()), route(veevApiUrl, veevInfo()), { ...route(legacy, 'File not found'), status: 404 },
  ] });
  try {
    const result = await runtime.run(`module.exports.getStreams('901','movie')`);
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (!result.ok) return;
    const streams = result.value as NativeStream[];
    assert.deepEqual(streams.map(stream => stream.quality), ['720p', '1080p']);
    assert.ok(streams.every(stream => stream.name?.includes('Source: 1080p') && stream.name === stream.title));
    const requests = runtime.value('__requests.length');
    const report = runtime.value('module.exports.getSourceReport()') as { request: ContentRequest; streamCount: number; sources: Array<{ status: string }> };
    assert.equal(report.request.id, '901');
    assert.equal(report.streamCount, 2);
    assert.deepEqual(report.sources.map(source => source.status), ['resolved', 'unavailable']);
    assert.equal(runtime.value('__requests.length'), requests, 'The report does not perform another lookup');
    assert.ok(!JSON.stringify(report).includes('https://'));
    await runtime.run(`module.exports.getStreams('invalid','movie')`);
    assert.equal(runtime.value('module.exports.getSourceReport()'), null, 'A rejected later request cannot expose stale diagnostics');
  } finally { runtime.dispose(); }
});
