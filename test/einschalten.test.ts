import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEinschaltenProvider } from '../src/native/einschalten.js';
import { DOOD_USER_AGENT } from '../src/native/dood.js';
import { ProviderError } from '../src/native/errors.js';
import { createHttpClient } from '../src/native/http.js';
import { parseRequest } from '../src/native/request.js';
import { createNativeRuntime, type FixtureRoute } from './helpers/native-runtime.js';
import { doodEmbed, doodFinal, doodPage, doodPass, doodPrefix, doodToken } from './helpers/dood-fixture.js';
import type { Identity, MetadataProvider, RequestOptions } from '../src/native/types.js';

const origin = 'https://einschalten.in';
const detailUrl = origin + '/api/movies/27205';
const watchUrl = detailUrl + '/watch';
const identity: Identity = { type: 'movie', title: 'Inception', aliases: ['Inception'], year: 2010, imdbId: 'tt1375666', tmdbId: '27205' };
const movie = { id: 27205, title: 'Inception', releaseDate: '2010-07-15', imdbId: 'tt1375666' };
const watch = { streamUrl: doodEmbed, releaseName: 'Inception.2010.German.DL.2160p.HEVC' };
type Reply = { body: unknown; status?: number; url?: string; headers?: Record<string, string> };
function fixture(handler: (url: string, options: RequestOptions) => Reply | Promise<Reply>) {
  const calls: Array<{ url: string; options: RequestOptions }> = [];
  const http = createHttpClient(async (url, options = {}) => {
    calls.push({ url, options });
    const reply = await handler(url, options);
    return { status: reply.status ?? 200, url: reply.url ?? url,
      text: async () => typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body),
      headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null } };
  });
  return { calls, http };
}
function metadata(value: Identity | null = identity): MetadataProvider { return { async resolve() { return value; } }; }
const noMetadata: MetadataProvider = { async resolve() { assert.fail('TMDB requests must not require external metadata.'); } };
function failure(code: string) { return (error: unknown) => error instanceof ProviderError && error.code === code; }
function happy(url: string): Reply {
  if (url === detailUrl) return { body: movie };
  if (url === watchUrl) return { body: watch };
  if (url === doodEmbed) return { body: doodPage(), url: doodFinal };
  if (url === 'https://playmogo.com' + doodPass) return { body: doodPrefix };
  assert.fail('Unexpected fixture request: ' + url);
}

test('einschalten resolves TMDB directly and preserves the hoster headers without inventing stream metadata', async () => {
  const source = fixture(happy);
  const streams = await createEinschaltenProvider(source.http, noMetadata)(parseRequest('tmdb/27205', 'movie'));
  assert.equal(streams.length, 1);
  assert.match(streams[0]!.url, /^https:\/\/media\.example\.invalid\/files\/synthetic\/[A-Za-z0-9]{10}\?token=/);
  assert.equal(new URL(streams[0]!.url).searchParams.get('token'), doodToken);
  assert.equal(streams[0]!.title, 'Inception • DoodStream');
  assert.equal(streams[0]!.language, 'de');
  assert.equal(streams[0]!.quality, undefined);
  assert.equal(streams[0]!.subtitles, undefined);
  assert.deepEqual(streams[0]!.headers, { 'User-Agent': DOOD_USER_AGENT, Referer: doodFinal });
  assert.deepEqual(source.calls.map(call => call.url), [detailUrl, watchUrl, doodEmbed, 'https://playmogo.com' + doodPass]);
  assert.equal(source.calls[2]!.options.headers?.Referer, origin + '/movies/27205');
  assert.ok(source.calls.slice(2).every(call => call.options.headers?.['User-Agent'] === DOOD_USER_AGENT));
});

test('einschalten verifies the source IMDb ID after resolving the TMDB mapping', async () => {
  const source = fixture(happy);
  assert.equal((await createEinschaltenProvider(source.http, metadata())(parseRequest('tt1375666', 'movie'))).length, 1);
  for (const imdbId of ['tt0000001', undefined, '']) {
    const wrong = fixture(url => { assert.equal(url, detailUrl); return { body: { ...movie, imdbId } }; });
    assert.deepEqual(await createEinschaltenProvider(wrong.http, metadata())(parseRequest('tt1375666', 'movie')), []);
    assert.equal(wrong.calls.length, 1);
  }
});

test('einschalten treats unsupported series, unknown metadata, and missing movie/watch routes as no match', async () => {
  const unused = fixture(() => { assert.fail('No source requests are expected.'); });
  assert.deepEqual(await createEinschaltenProvider(unused.http, noMetadata)(parseRequest('27205', 'tv', 1, 1)), []);
  assert.deepEqual(await createEinschaltenProvider(unused.http, metadata(null))(parseRequest('tt1375666', 'movie')), []);
  for (const missing of [detailUrl, watchUrl]) {
    const source = fixture(url => url === missing ? { status: 404, body: '' } : happy(url));
    assert.deepEqual(await createEinschaltenProvider(source.http, noMetadata)(parseRequest('27205', 'movie')), []);
    assert.ok(!source.calls.some(call => call.url === doodEmbed));
  }
});

test('einschalten rejects conflicting metadata and invalid mapped IDs before source requests', async () => {
  const source = fixture(() => { assert.fail('Invalid identities must not reach the source.'); });
  for (const value of [{ ...identity, type: 'tv' as const }, { ...identity, imdbId: 'tt0000001' },
    { ...identity, tmdbId: '27205/other' }, { ...identity, tmdbId: '9007199254740992' }]) {
    await assert.rejects(() => createEinschaltenProvider(source.http, metadata(value))(parseRequest('tt1375666', 'movie')), failure('invalid_response'));
  }
  await assert.rejects(() => createEinschaltenProvider(source.http, noMetadata)(parseRequest('9007199254740992', 'movie')), failure('invalid_request'));
});

test('einschalten rejects malformed detail responses and changed source identity', async () => {
  for (const body of [null, [], { ...movie, id: 603 }, { ...movie, id: 0 }, { ...movie, title: '' },
    { ...movie, title: 'bad\nlabel' }, { ...movie, releaseDate: 'invalid' }, { ...movie, imdbId: 'wrong' }]) {
    const source = fixture(() => ({ body }));
    await assert.rejects(() => createEinschaltenProvider(source.http, noMetadata)(parseRequest('27205', 'movie')), failure('invalid_response'));
    assert.equal(source.calls.length, 1);
  }
});

test('einschalten does not turn incomplete, redirected, blocked, or failed API responses into empty matches', async () => {
  const cases: Array<[Reply, string]> = [
    [{ body: '{"id":27205' }, 'response_incomplete'],
    [{ body: 'x'.repeat(1024 * 1024 + 1) }, 'response_incomplete'],
    [{ body: movie, url: 'https://unrelated.example.invalid/api/movies/27205' }, 'invalid_response'],
    [{ body: 'rate limited', status: 429 }, 'request_failed'],
    [{ body: '<html><title>Just a moment...</title></html>', status: 403, headers: { 'cf-mitigated': 'challenge' } }, 'source_blocked'],
  ];
  for (const [reply, code] of cases) {
    const source = fixture(() => reply);
    await assert.rejects(() => createEinschaltenProvider(source.http, noMetadata)(parseRequest('27205', 'movie')), failure(code));
  }
});

test('einschalten validates the advertised hoster and rejects malformed watch responses', async () => {
  for (const body of [null, [], {}, { ...watch, streamUrl: 'https://unknown.example.invalid/embed' },
    { ...watch, streamUrl: 'https://synthetic:secret@vide0.net/e/abcdefgh1234' }, { ...watch, releaseName: 42 }]) {
    const source = fixture(url => url === detailUrl ? { body: movie } : { body });
    await assert.rejects(() => createEinschaltenProvider(source.http, noMetadata)(parseRequest('27205', 'movie')), failure('invalid_response'));
    assert.equal(source.calls.length, 2);
  }
});

test('einschalten reports only explicitly named release languages and keeps transcode quality unknown', async () => {
  for (const [releaseName, language] of [['Synthetic.DL.1080p.HEVC', undefined], ['Synthetic.German.DL.1080p', 'de'],
    ['Synthetic.German.English.1080p', 'de / en'], ['Synthetic.ENG', 'en'], [undefined, undefined]]) {
    const source = fixture(url => url === watchUrl ? { body: { ...watch, releaseName } } : happy(url));
    const [stream] = await createEinschaltenProvider(source.http, noMetadata)(parseRequest('27205', 'movie'));
    assert.equal(stream?.language, language);
    assert.equal(stream?.quality, undefined);
    assert.equal(stream?.size, undefined);
    assert.doesNotMatch(stream!.title, /1080p|HEVC/);
  }
});

test('einschalten completes paginated title fallback and confirms the detail IMDb before playback', async () => {
  const fallback = { ...identity, tmdbId: undefined, aliases: ['Inception', 'INCEPTION'] };
  const source = fixture((url, options) => {
    if (url !== origin + '/api/search') return happy(url);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers?.['Content-Type'], 'application/json');
    const body = JSON.parse(options.body!);
    assert.equal(body.query, 'Inception');
    if (body.pageNumber === 1) return { body: { data: [{ ...movie, id: 10, title: 'Unrelated' }, { ...movie, id: 11, releaseDate: '1990-01-01' }], pagination: { currentPage: 1, hasMore: true } } };
    assert.equal(body.pageNumber, 2);
    return { body: { data: [movie, movie], pagination: { currentPage: 2, hasMore: false } } };
  });
  const streams = await createEinschaltenProvider(source.http, metadata(fallback))(parseRequest('tt1375666', 'movie'));
  assert.equal(streams.length, 1);
  assert.equal(source.calls.filter(call => call.url === detailUrl).length, 1);
  assert.equal(source.calls.length, 6);
});

test('einschalten never accepts a title/year match without a confirming IMDb ID', async () => {
  for (const data of [[], [movie]]) {
    const source = fixture(url => {
      if (url === origin + '/api/search') return { body: { data, pagination: { currentPage: 1, hasMore: false } } };
      assert.equal(url, detailUrl);
      return { body: { ...movie, imdbId: 'tt0000001' } };
    });
    assert.deepEqual(await createEinschaltenProvider(source.http, metadata({ ...identity, tmdbId: undefined }))(parseRequest('tt1375666', 'movie')), []);
    assert.ok(!source.calls.some(call => call.url === watchUrl));
  }
});

test('einschalten rejects incomplete pagination and bounds fallback search work', async () => {
  const fallback = metadata({ ...identity, tmdbId: undefined });
  for (const body of [{ data: [movie] }, { data: [movie], pagination: { currentPage: 2, hasMore: false } },
    { data: [movie], pagination: { currentPage: 1, hasMore: 'false' } }]) {
    const source = fixture(() => ({ body }));
    await assert.rejects(() => createEinschaltenProvider(source.http, fallback)(parseRequest('tt1375666', 'movie')), failure('invalid_response'));
  }
  const endless = fixture((url, options) => {
    assert.equal(url, origin + '/api/search');
    return { body: { data: [movie], pagination: { currentPage: JSON.parse(options.body!).pageNumber, hasMore: true } } };
  });
  await assert.rejects(() => createEinschaltenProvider(endless.http, fallback)(parseRequest('tt1375666', 'movie')), failure('response_incomplete'));
  assert.equal(endless.calls.length, 4);
  const empty = fixture(() => ({ body: { data: [], pagination: { currentPage: 1, hasMore: true } } }));
  await assert.rejects(() => createEinschaltenProvider(empty.http, fallback)(parseRequest('tt1375666', 'movie')), failure('response_incomplete'));
  const oversized = fixture(() => ({ body: { data: Array(101).fill(movie), pagination: { currentPage: 1, hasMore: false } } }));
  await assert.rejects(() => createEinschaltenProvider(oversized.http, fallback)(parseRequest('tt1375666', 'movie')), failure('response_incomplete'));
});

test('einschalten refuses ambiguous IMDb results and excessive title or detail candidates', async () => {
  const fallback = { ...identity, tmdbId: undefined };
  const many = fixture(() => ({ body: { data: Array.from({ length: 9 }, (_, index) => ({ ...movie, id: index + 1 })), pagination: { currentPage: 1, hasMore: false } } }));
  await assert.rejects(() => createEinschaltenProvider(many.http, metadata(fallback))(parseRequest('tt1375666', 'movie')), failure('ambiguous_match'));
  const unused = fixture(() => { assert.fail('Excessive aliases should fail before source requests.'); });
  await assert.rejects(() => createEinschaltenProvider(unused.http, metadata({ ...fallback, aliases: ['One', 'Two', 'Three', 'Four'] }))(parseRequest('tt1375666', 'movie')), failure('ambiguous_match'));
  const ambiguous = fixture(url => {
    if (url === origin + '/api/search') return { body: { data: [movie, { ...movie, id: 603 }], pagination: { currentPage: 1, hasMore: false } } };
    return { body: { ...movie, id: Number(url.split('/').pop()) } };
  });
  await assert.rejects(() => createEinschaltenProvider(ambiguous.http, metadata(fallback))(parseRequest('tt1375666', 'movie')), failure('ambiguous_match'));
  assert.equal(ambiguous.calls.length, 3);
});

function nativeRoutes(depth = 0): FixtureRoute[] {
  return [
    { url: detailUrl, body: JSON.stringify(movie) },
    { url: watchUrl, body: JSON.stringify(watch) },
    { url: doodEmbed, finalUrl: doodFinal, body: doodPage(undefined, depth) },
    { url: 'https://playmogo.com' + doodPass, body: doodPrefix },
  ];
}

for (const mobileUrl of [false, true]) test(`built einschalten resolves a complete movie workflow with native URL bindings and a small stack (mobile: ${mobileUrl})`, async () => {
  const code = await readFile(new URL('../providers/einschalten.js', import.meta.url), 'utf8');
  const runtime = await createNativeRuntime('String.prototype.matchAll = undefined;\n' + code, { mobileUrl, maxStackSize: 256 * 1024, routes: nativeRoutes(512) });
  try {
    const result = await runtime.run("module.exports.getStreams('tmdb/27205','movie')");
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (!result.ok) return;
    const streams = result.value as Array<Record<string, unknown>>;
    assert.equal(streams.length, 1);
    assert.equal(streams[0]!.title, 'Inception • DoodStream');
    assert.equal(streams[0]!.language, 'de');
    assert.equal(streams[0]!.quality, undefined);
    assert.deepEqual(streams[0]!.headers, { 'User-Agent': DOOD_USER_AGENT, Referer: doodFinal });
    assert.equal(runtime.value('__requests.length'), 4);
    assert.equal(runtime.value("__requests.slice(2).every(request => request.headers['User-Agent'] === " + JSON.stringify(DOOD_USER_AGENT) + ')'), true);
    assert.equal(runtime.value('fetch === __savedHostFetch'), true);
    assert.equal(runtime.value('typeof Buffer'), 'undefined');
    assert.equal(new URL(String(streams[0]!.url)).searchParams.get('token'), doodToken);
  } finally { runtime.dispose(); }
});

test('built einschalten resolves IMDb via real metadata code and makes no requests for a valid series request', async () => {
  const code = await readFile(new URL('../providers/einschalten.js', import.meta.url), 'utf8');
  const runtime = await createNativeRuntime(code, { mobileUrl: true, maxStackSize: 256 * 1024, routes: [
    { url: 'https://v3-cinemeta.strem.io/meta/movie/tt1375666.json', body: JSON.stringify({ meta: { id: 'tt1375666', imdb_id: 'tt1375666', moviedb_id: 27205, type: 'movie', name: 'Inception', releaseInfo: '2010' } }) },
    { url: 'https://www.themoviedb.org/movie/27205?language=de-DE', body: '<html><head><link rel="canonical" href="https://www.themoviedb.org/movie/27205-fixture"></head><body><div class="title"><h2><a>Inception</a><span class="tag release_date">(2010)</span></h2></div></body></html>' },
    ...nativeRoutes(),
  ] });
  try {
    assert.deepEqual(await runtime.run("module.exports.getStreams('27205','tv',1,1)"), { ok: true, value: [] });
    assert.equal(runtime.value('__requests.length'), 0);
    const result = await runtime.run("module.exports.getStreams('tt1375666','movie')");
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (result.ok) assert.equal((result.value as unknown[]).length, 1);
    assert.equal(runtime.value('__requests.length'), 6);
  } finally { runtime.dispose(); }
});

test('built einschalten returns a fixed source error instead of an iframe when the hoster is challenged', async () => {
  const code = await readFile(new URL('../providers/einschalten.js', import.meta.url), 'utf8');
  const runtime = await createNativeRuntime(code, { routes: nativeRoutes().map(route => route.url === doodEmbed
    ? { ...route, status: 403, body: '<html><title>Just a moment...</title></html>', headers: { 'cf-mitigated': 'challenge' } } : route) });
  try {
    const result = await runtime.run("module.exports.getStreams('27205','movie')");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'source_blocked');
    assert.equal(runtime.value('__requests.length'), 3);
  } finally { runtime.dispose(); }
});
