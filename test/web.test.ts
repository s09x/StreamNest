import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVoePayload, extractVoeConfig, resolveVoe } from '../src/native/voe.js';
import { createMetadataProvider } from '../src/native/metadata.js';
import { createWebProviders } from '../src/native/web.js';
import { ProviderError } from '../src/native/errors.js';
import { createHttpClient } from '../src/native/http.js';
import type { ContentRequest, HttpClient, Identity, MetadataProvider, RequestOptions, TextResponse } from '../src/native/types.js';

function encodeVoe(value: unknown): string {
  const inner = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  const shifted = [...inner].reverse().map((letter) => String.fromCharCode(letter.charCodeAt(0) + 3)).join('');
  const base64 = Buffer.from(shifted, 'latin1').toString('base64');
  const noise = ['@$', '^^', '~@', '%?', '*~', '!!', '#&'];
  const decorated = [...base64].map((letter, index) => letter + (index % 4 === 3 ? noise[index % noise.length] : '')).join('');
  return decorated.replace(/[a-zA-Z]/g, (letter) => {
    const start = letter <= 'Z' ? 65 : 97;
    return String.fromCharCode(start + (letter.charCodeAt(0) - start + 13) % 26);
  });
}

test('VOE public envelope decodes Unicode captions and preserves original resource query values', () => {
  const expected = {
    source: 'https://media.example.invalid/master.m3u8?synthetic=one%2Btwo',
    captions: [{ file: '/captions/de.ass?fixture=1', language: 'de', label: 'Deutsch – vollständig' }],
    default_audio_language: 'sq',
    audio_languages: [{ countryCode: 'de', language: 'German' }],
  };
  assert.deepEqual(decodeVoePayload(encodeVoe(expected)), expected);
});

test('VOE extraction treats scripts strictly as data and ignores unrelated JSON objects', () => {
  const expected = { source: 'https://media.example.invalid/master.m3u8', captions: [] };
  const html = `<script>throw new Error('must never execute')</script><script type="application/json">{"unrelated":true}</script><script type="application/json">${JSON.stringify([encodeVoe(expected)])}</script>`;
  assert.deepEqual(extractVoeConfig(html), expected);
  assert.equal(extractVoeConfig('<script>window.fakePlayer = true</script>'), null);
});

test('VOE malformed, non-object, and excessive envelopes are rejected', () => {
  for (const value of ['!', 'A', 'A===', 'a'.repeat(1_500_001), encodeVoe([])]) {
    assert.throws(() => decodeVoePayload(value));
  }
});

type Call = { url: string; options: RequestOptions; session: number };
function fixtureHttp(handler: (call: Call) => TextResponse | Promise<TextResponse>) {
  const calls: Call[] = [];
  let sessionCount = 0;
  const make = (session: number): HttpClient => ({
    async request(url, options = {}) {
      const call = { url, options, session }; calls.push(call);
      return handler(call);
    },
    async json(url, options) {
      const response = await this.request(url, options);
      if (response.status !== 200) throw new ProviderError('request_failed');
      return JSON.parse(response.text);
    },
    session() { return make(++sessionCount); },
    cookies() { return session ? { 'XSRF-TOKEN': 'synthetic%2Fcookie' } : {}; },
  });
  return { http: make(0), calls };
}
function response(url: string, text: string, status = 200, headers: Record<string, string> = {}): TextResponse {
  return { url, text, status, header: name => headers[name.toLowerCase()] ?? null };
}
function json(url: string, value: unknown): TextResponse { return response(url, JSON.stringify(value)); }
function page(title: string, body: string, head = ''): string {
  return `<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
}
function tmdb(type: 'movie' | 'tv', id: string, title: string, year = 2010): string {
  return page('TMDB', `<div class="title"><h2><a>${title}</a><span class="tag release_date">(${year})</span></h2></div>`,
    `<link rel="canonical" href="https://www.themoviedb.org/${type}/${id}-example">`);
}
function cine(id: string, title: string, tmdbId: number, type = 'movie', year = '2010') {
  return { meta: { id, imdb_id: id, name: title, moviedb_id: tmdbId, type, releaseInfo: year } };
}
function player(config: Record<string, unknown>, title = 'Example.1080p.HEVC.mkv'): string {
  return page(`Watch ${title} - VOE | Player`, `<script type="application/json">${JSON.stringify([encodeVoe(config)])}</script>`);
}
const movieRequest: ContentRequest = { type: 'movie', id: 'tt1375666', imdbId: 'tt1375666' };
const movieIdentity: Identity = { type: 'movie', title: 'Inception', aliases: ['Inception'], year: 2010, imdbId: 'tt1375666', tmdbId: '27205' };
function metadata(identity: Identity = movieIdentity): MetadataProvider { return { async resolve() { return identity; } }; }
function failure(code: string) { return (error: unknown) => error instanceof ProviderError && error.code === code; }

test('IMDb-first metadata preserves verified German and English aliases and isolates cache consumers', async () => {
  const fixture = fixtureHttp(({ url }) => {
    if (url.includes('/meta/movie/tt0133093.json')) return json(url, cine('tt0133093', 'The Matrix', 603, 'movie', '1999'));
    if (url === 'https://www.themoviedb.org/movie/603?language=de-DE') return response(url, tmdb('movie', '603', 'Matrix', 1999));
    assert.fail(`Unexpected metadata request: ${url}`);
  });
  const provider = createMetadataProvider(fixture.http);
  const request: ContentRequest = { type: 'movie', id: 'tt0133093', imdbId: 'tt0133093' };
  const first = await provider.resolve(request);
  assert.deepEqual(first?.aliases, ['Matrix', 'The Matrix']);
  first!.aliases.push('user mutation');
  assert.deepEqual((await provider.resolve(request))?.aliases, ['Matrix', 'The Matrix']);
  assert.equal(fixture.calls.length, 2);
});

test('TMDB-only bridge validates numeric cross-reference instead of accepting the first title hit', async () => {
  const fixture = fixtureHttp(({ url }) => {
    if (url.includes('themoviedb.org')) return response(url, tmdb('movie', '27205', 'Inception'));
    if (url.includes('/catalog/')) return json(url, { metas: [
      { id: 'tt9999991', name: 'Inception', releaseInfo: '2010', type: 'movie' },
      { id: 'tt1375666', name: 'Inception', releaseInfo: '2010', type: 'movie' },
    ] });
    if (url.includes('tt9999991')) return json(url, cine('tt9999991', 'Inception', 999));
    return json(url, cine('tt1375666', 'Inception', 27205));
  });
  const result = await createMetadataProvider(fixture.http).resolve({ type: 'movie', id: '27205', tmdbId: '27205' });
  assert.equal(result?.imdbId, 'tt1375666');
  assert.equal(result?.tmdbId, '27205');
  assert.equal(fixture.calls.filter(call => call.url.includes('/meta/')).length, 2);
});

test('numeric metadata bridge rejects conflicting canonical IDs and ambiguous cross-ID mappings', async () => {
  const canonical = fixtureHttp(({ url }) => response(url, tmdb('tv', '27205', 'Inception')));
  await assert.rejects(createMetadataProvider(canonical.http).resolve({ type: 'movie', id: '27205' }), failure('invalid_response'));
  const ambiguous = fixtureHttp(({ url }) => {
    if (url.includes('themoviedb')) return response(url, tmdb('movie', '27205', 'Inception'));
    if (url.includes('/catalog/')) return json(url, { metas: ['tt1111111', 'tt2222222'].map(id => ({ id, name: 'Inception', releaseInfo: '2010' })) });
    const id = /\/meta\/movie\/(tt\d+)\.json/.exec(url)![1]!;
    return json(url, cine(id, 'Inception', 27205));
  });
  await assert.rejects(createMetadataProvider(ambiguous.http).resolve({ type: 'movie', id: '27205' }), failure('ambiguous_match'));
});

test('failed metadata is not cached and private identifiers do not trigger public requests', async () => {
  let blocked = true;
  const fixture = fixtureHttp(({ url }) => {
    if (blocked) return response(url, page('Just a moment', 'Challenge'), 403);
    return json(url, { meta: { id: 'tt1375666', imdb_id: 'tt1375666', name: 'Inception', type: 'movie', releaseInfo: '2010' } });
  });
  const provider = createMetadataProvider(fixture.http);
  assert.equal(await provider.resolve({ type: 'movie', id: 'streamnest:private' }), null);
  assert.equal(fixture.calls.length, 0);
  await assert.rejects(provider.resolve(movieRequest), failure('source_blocked'));
  blocked = false;
  assert.equal((await provider.resolve(movieRequest))?.title, 'Inception');
  assert.equal(fixture.calls.length, 2);
  await assert.rejects(provider.resolve({ ...movieRequest, imdbId: 'tt0000000' }), failure('invalid_request'));
});

test('truncated source HTML is explicit even when a usable-looking title appears before the cut', async () => {
  const fixture = fixtureHttp(({ url }) => response(url, tmdb('movie', '27205', 'Inception').replace('</html>', '')));
  await assert.rejects(createMetadataProvider(fixture.http).resolve({ type: 'movie', id: '27205' }), failure('response_incomplete'));
});

test('metadata uses an authoritative English alias when localized catalog matching has no cross-reference', async () => {
  const fixture = fixtureHttp(({ url }) => {
    if (url.includes('themoviedb')) return response(url, tmdb('movie', '603', url.endsWith('de-DE') ? 'Matrix' : 'The Matrix', 1999));
    if (url.includes('search=Matrix.')) return json(url, { metas: [] });
    if (url.includes('/catalog/')) return json(url, { metas: [{ id: 'tt0133093', name: 'The Matrix', releaseInfo: '1999' }] });
    return json(url, cine('tt0133093', 'The Matrix', 603, 'movie', '1999'));
  });
  const result = await createMetadataProvider(fixture.http).resolve({ type: 'movie', id: '603' });
  assert.deepEqual(result?.aliases, ['Matrix', 'The Matrix']);
  assert.equal(result?.imdbId, 'tt0133093');
});

function filmpalastDetail(title: string, year: number, links: string[], type = 'Film', release = 'Example.German.DL.1080p.WEB.HEVC') {
  return page(`${type} ${title} Stream`, `<article class="detail pDetails"><h2 class="bgDark">${title}</h2>
    <span id="release_text">${release}</span><p>Ver&ouml;ffentlicht: ${year}</p>
    ${links.map(url => `<a class="button rb iconPlay" href="${url}">Play</a>`).join('')}</article>`);
}

test('Filmpalast isolates a blocked mirror, resolves another, and does not infer English from DL', async () => {
  const first = 'https://voe.sx/abcdefgh1234';
  const second = 'https://voe.sx/abcdwxyz5678';
  const fixture = fixtureHttp(({ url }) => {
    if (url.includes('/search/title/')) return response(url, page('Filmpalast', '<a href="/stream/inception">Inception</a>'));
    if (url.includes('/stream/inception')) return response(url, filmpalastDetail('Inception', 2010, [first, second, second]));
    if (url === first) return response(url, page('Just a moment', 'challenge'), 403);
    if (url === second) return response(url, `<script>window.location.href = 'https://alias.example.invalid/e/abcdwxyz5678';</script>`);
    return response(url, player({ source: 'https://media.example.invalid/master.m3u8?synthetic=1', default_audio_language: 'en', audio_languages: [], captions: [] }));
  });
  const streams = await createWebProviders(fixture.http, metadata()).filmpalast(movieRequest);
  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.language, 'de');
  assert.match(streams[0]!.title, /HEVC/);
  assert.equal(streams[0]?.headers?.Origin, 'https://alias.example.invalid');
  assert.equal(fixture.calls.filter(call => call.url === second).length, 1);
});

test('Filmpalast keeps all-mirror failures explicit instead of returning successful empty streams', async () => {
  const fixture = fixtureHttp(({ url }) => {
    if (url.includes('/search/')) return response(url, page('Filmpalast', '<a href="/stream/inception">Inception</a>'));
    if (url.includes('/stream/')) return response(url, filmpalastDetail('Inception', 2010, ['https://voe.sx/abcdefgh1234']));
    return response(url, page('Just a moment', 'challenge'), 403);
  });
  await assert.rejects(createWebProviders(fixture.http, metadata()).filmpalast(movieRequest), failure('source_blocked'));
});

test('Filmpalast episode matching uses exact coordinates and series-start year', async () => {
  const identity: Identity = { type: 'tv', title: 'Fallout', aliases: ['Fallout'], year: 2024 };
  const fixture = fixtureHttp(({ url }) => {
    if (url.includes('/search/')) {
      assert.ok(url.endsWith('Fallout%20S02E01'));
      return response(url, page('Filmpalast', '<a href="/stream/movie">The Fallout</a><a href="/stream/adjacent">Fallout S02E02</a><a href="/stream/correct">Fallout S02E01</a>'));
    }
    if (url.includes('/stream/')) {
      assert.ok(url.endsWith('/correct'));
      return response(url, filmpalastDetail('Fallout S02E01', 2024, ['https://voe.sx/abcdefgh1234'], 'Serie'));
    }
    return response(url, player({ source: 'https://media.example.invalid/episode.m3u8', captions: [] }));
  });
  const streams = await createWebProviders(fixture.http, metadata(identity)).filmpalast({ type: 'tv', id: '106379', season: 2, episode: 1 });
  assert.equal(streams.length, 1);
});

test('Filmpalast refuses ambiguous title/year pages before minting any media URLs', async () => {
  const fixture = fixtureHttp(({ url }) => {
    if (url.includes('/search/')) return response(url, page('Filmpalast', '<a href="/stream/a">Inception</a><a href="/stream/b">Inception</a>'));
    assert.ok(url.includes('/stream/'));
    return response(url, filmpalastDetail('Inception', 2010, ['https://voe.sx/abcdefgh1234']));
  });
  await assert.rejects(createWebProviders(fixture.http, metadata()).filmpalast(movieRequest), failure('ambiguous_match'));
  assert.equal(fixture.calls.length, 3);
});

function filmoDetail(payload: string, year = 2010): string {
  const chip = `<div data-provider-chip data-movie-link-id="123" data-p="${payload}" aria-label="VOE"><span class="provider-chip__name">VOE</span><span class="provider-chip__metadata">BluRay 720p</span></div>`;
  return page('Filmo Inception', `<main><h1>Inception</h1><p>Erscheinungsdatum: ${year}</p><div class="provider-row">Deutsch ${chip}${chip}</div></main>`, '<meta name="csrf-token" content="synthetic-page-csrf">');
}

test('Filmo uses fresh page-session values, stable provider identity, and native source-published subtitles', async () => {
  const fixture = fixtureHttp(({ url, options, session }) => {
    if (url === 'http://filmo.to/') {
      assert.equal(options.redirect, 'manual');
      assert.equal(session, 0);
      return response(url, '', 301, { location: 'https://filmo.to/' });
    }
    if (url.includes('/search/suggest')) return json(url, { movies: [{ title: 'Inception', url: 'https://filmo.to/movies/inception' }] });
    if (url.includes('/movies/inception')) return response(url, filmoDetail(session ? 'fresh-payload' : 'old-payload'));
    if (url === 'https://filmo.to/n') {
      assert.ok(session > 0);
      assert.deepEqual(JSON.parse(options.body!), { p: 'fresh-payload' });
      assert.equal(options.headers?.['X-CSRF-TOKEN'], 'synthetic-page-csrf');
      assert.equal(options.headers?.['X-XSRF-TOKEN'], 'synthetic/cookie');
      assert.equal(options.headers?.Origin, 'https://filmo.to');
      return json(url, { x: 'minted/fixture' });
    }
    assert.equal(url, 'https://filmo.to/n/minted%2Ffixture');
    return response('https://voe.sx/e/abcdefgh1234', player({
      source: 'https://media.example.invalid/master.m3u8?fixture=1',
      audio_languages: [{ countryCode: 'de' }, { countryCode: 'en' }],
      captions: [{ file: '/subs/de.ass?fixture=2', language: 'de', label: 'Deutsch Forced' }],
    }, 'Example.720p.mkv'));
  });
  const streams = await createWebProviders(fixture.http, metadata()).filmo(movieRequest);
  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.language, 'de / en');
  assert.equal(streams[0]?.subtitles?.[0]?.url, 'https://voe.sx/subs/de.ass?fixture=2');
  assert.equal(streams[0]?.subtitles?.[0]?.name, 'Deutsch Forced');
  assert.equal(streams[0]?.subtitles?.[0]?.headers?.Origin, 'https://voe.sx');
  assert.equal(fixture.calls.filter(call => call.url === 'https://filmo.to/n').length, 1);
});

test('Filmo never substitutes a movie for a series and checks release year before minting', async () => {
  const fixture = fixtureHttp(({ url }) => {
    if (url === 'http://filmo.to/') return response(url, '', 301, { location: 'https://filmo.to/' });
    if (url.includes('/search/')) return json(url, { movies: [{ title: 'Inception', url: 'https://filmo.to/movies/inception' }] });
    assert.ok(url.includes('/movies/'));
    return response(url, filmoDetail('unused', 2020));
  });
  const providers = createWebProviders(fixture.http, metadata());
  assert.deepEqual(await providers.filmo({ type: 'tv', id: '106379', season: 1, episode: 1 }), []);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(await providers.filmo(movieRequest), []);
});

test('Filmo rejects host auto-follow before acquiring cookies, resolving metadata, or minting a token', async () => {
  const fixture = fixtureHttp(({ url, options }) => {
    assert.equal(url, 'http://filmo.to/');
    assert.equal(options.redirect, 'manual');
    assert.equal(Object.keys(options.headers ?? {}).length, 0);
    return response('https://filmo.to/', page('Filmo', 'Public home page'));
  });
  const guarded: HttpClient = { ...fixture.http, session() { assert.fail('No session may be acquired'); } };
  const unusedMetadata: MetadataProvider = { async resolve() { assert.fail('No metadata lookup may precede the capability gate'); } };
  await assert.rejects(createWebProviders(guarded, unusedMetadata).filmo(movieRequest), failure('unsupported_runtime'));
  assert.equal(fixture.calls.length, 1);
});

test('VOE rejects inconsistent redirects and preserves no fabricated default-audio inventory', async () => {
  const fixture = fixtureHttp(({ url }) => response(url, player({
    source: 'https://media.example.invalid/master.m3u8', audio_languages: [], default_audio_language: 'de', captions: [],
  })));
  const stream = await resolveVoe(fixture.http, 'https://voe.sx/abcdefgh1234', 'https://filmpalast.to/stream/example');
  assert.equal(stream.language, undefined);
  assert.equal(stream.subtitles, undefined);
  const redirect = fixtureHttp(({ url }) => response(url, `<script>window.location.href='https://alias.example.invalid/e/otherfile123';</script>`));
  await assert.rejects(resolveVoe(redirect.http, 'https://voe.sx/abcdefgh1234', 'https://filmpalast.to/stream/example'), failure('invalid_response'));
});

test('VOE prefers explicit language codes and names over country flags', async () => {
  const fixture = fixtureHttp(({ url }) => response(url, player({
    source: 'https://media.example.invalid/master.m3u8', default_audio_language: 'de', captions: [],
    audio_languages: [
      { countryCode: 'US', languageCode: 'en', language: 'English' },
      { countryCode: 'DE', language: 'English' },
      { countryCode: 'FR', languageCode: '', language: 'French' },
    ],
  })));
  const stream = await resolveVoe(fixture.http, 'https://voe.sx/abcdefgh1234', 'https://filmpalast.to/stream/example');
  assert.equal(stream.language, 'en / fr');
});

test('public source contract check (explicit opt-in; metadata and player HTML only)', {
  skip: process.env.STREAMNEST_PUBLIC_CHECK !== '1', timeout: 120_000,
}, async () => {
  const http = createHttpClient(async (url, options) => {
    const result = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
    return { status: result.status, url: result.url, text: () => result.text(),
      headers: { get: (name: string) => result.headers.get(name) } };
  });
  const provider = createWebProviders(http, createMetadataProvider(http));
  const movie = await provider.filmo({ type: 'movie', id: 'tt0133093', imdbId: 'tt0133093' });
  assert.ok(movie.length > 0, 'Filmo must return a resolved source for this explicit sample');
  const episode = await provider.filmpalast({ type: 'tv', id: '1399', tmdbId: '1399', season: 6, episode: 10 });
  assert.ok(episode.length > 0, 'Filmpalast must return a resolved source for this explicit sample');
  for (const stream of [...movie, ...episode]) {
    assert.ok(/^https?:\/\//.test(stream.url));
    assert.ok(stream.title);
  }
  // Do not request the returned media URLs or print their signature parameters.
});
