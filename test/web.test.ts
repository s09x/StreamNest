import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVoePayload, extractVoeConfig, resolveVoe } from '../src/native/voe.js';
import { createMetadataProvider } from '../src/native/metadata.js';
import { createWebProviders } from '../src/native/web.js';
import { ProviderError } from '../src/native/errors.js';
import { createHttpClient } from '../src/native/http.js';
import { resolveVidara } from '../src/native/vidara.js';
import { decodeVixeoSource, resolveVixeo } from '../src/native/vixeo.js';
import { resolvePlaymate } from '../src/native/playmate.js';
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

test('Filmo excludes VOE before acquiring a session when the host auto-follows redirects', async () => {
  const fixture = fixtureHttp(({ url, options }) => {
    if (url === 'http://filmo.to/') {
      assert.equal(options.redirect, 'manual');
      assert.equal(Object.keys(options.headers ?? {}).length, 0);
      return response('https://filmo.to/', page('Filmo', 'Public home page'));
    }
    if (url.includes('/search/suggest')) return json(url, { movies: [{ title: 'Inception', url: 'https://filmo.to/movies/inception' }] });
    assert.equal(url, 'https://filmo.to/movies/inception');
    return response(url, filmoDetail('unused-voe-payload'));
  });
  const guarded: HttpClient = { ...fixture.http, session() { assert.fail('No session may be acquired'); } };
  await assert.rejects(createWebProviders(guarded, metadata()).filmo(movieRequest), failure('unsupported_runtime'));
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls.some(call => call.url.startsWith('https://filmo.to/n')), false);
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

test('Filmpalast ignores both Vidara aliases without requests and retains working alternatives', async () => {
  const links = ['https://odysseusa.cc/e/ExampleFile12', 'https://vidaraa.cc/e/ExampleFile12', 'https://voe.sx/example12345'];
  const source = 'https://media.example.invalid/working.m3u8';
  const fixture = fixtureHttp(({ url }) => {
    if (url.includes('/search/title/')) return response(url, page('Filmpalast', '<a href="https://filmpalast.to/stream/inception">Inception</a>'));
    if (url === 'https://filmpalast.to/stream/inception') return response(url, filmpalastDetail('Inception', 2010, links));
    return response(url, player({ source, captions: [] }));
  });
  const streams = await createWebProviders(fixture.http, metadata()).filmpalast(movieRequest);
  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.url, source);
  assert.equal(fixture.calls.some(call => /odysseusa\.cc|vidaraa\.cc/.test(call.url)), false);
  assert.equal(fixture.calls.length, 3);
});

test('Vidara rejects wrong origins, mismatched file identity, malformed API data and credentialed media URLs', async () => {
  const embed = 'https://odysseusa.cc/e/ExampleFile12';
  const detail = 'https://filmpalast.to/stream/example';
  const cases: Array<{ reply: unknown; finalUrl?: string; raw?: boolean; code?: string }> = [
    { reply: { filecode: 'Different123', streaming_url: 'https://media.example.invalid/master.m3u8', subtitles: [] } },
    { reply: { filecode: 'ExampleFile12', streaming_url: 'https://media.example.invalid/master.m3u8' }, finalUrl: 'https://other.example.invalid/api/stream' },
    { reply: { filecode: 'ExampleFile12', streaming_url: 'https://synthetic:secret@media.example.invalid/master.m3u8' } },
    { reply: { filecode: 'ExampleFile12', streaming_url: 'javascript:alert(1)' } },
    { reply: { filecode: 'ExampleFile12', streaming_url: 'https://media.example.invalid/master.m3u8', subtitles: {} } },
    { reply: '{"filecode":', raw: true, code: 'response_incomplete' },
  ];
  for (const entry of cases) {
    const fixture = fixtureHttp(({ url }) => response(entry.finalUrl ?? url, entry.raw ? String(entry.reply) : JSON.stringify(entry.reply)));
    await assert.rejects(resolveVidara(fixture.http, embed, detail), failure(entry.code ?? 'invalid_response'));
    assert.equal(fixture.calls.length, 1, 'Do not follow an unvalidated media URL');
  }
  const unused = fixtureHttp(() => assert.fail('An unsupported origin must not be requested'));
  await assert.rejects(resolveVidara(unused.http, 'https://other.example.invalid/e/ExampleFile12', detail), failure('invalid_response'));
});

test('Vidara preserves the HLS master and reports nonstandard crop dimensions without inventing a quality tier', async () => {
  const source = 'https://media.example.invalid/master.m3u8?fixture=2';
  const fixture = fixtureHttp(({ url }) => url.includes('/api/stream')
    ? json(url, { filecode: 'ExampleFile12', streaming_url: source, title: 'Fixture', subtitles: [], default_audio_language: 'sq' })
    : response(url, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Deutsch",LANGUAGE="de",URI="de.m3u8"\n'
      + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",URI="en.m3u8"\n'
      + '#EXT-X-STREAM-INF:RESOLUTION=1920x800,CODECS="hvc1.2.4.L153.B0,ec-3",AUDIO="a"\nhigh.m3u8\n'
      + '#EXT-X-STREAM-INF:RESOLUTION=1280x534,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a"\nlow.m3u8\n'));
  const result = await resolveVidara(fixture.http, 'https://odysseusa.cc/e/ExampleFile12', 'https://filmpalast.to/stream/example');
  assert.equal(result.url, source);
  assert.equal(result.quality, '1920x800');
  assert.equal(result.language, 'de / en');
  assert.match(result.title, /1920x800.*HEVC.*EAC3/);
  assert.doesNotMatch(result.title, /HDR/);
  assert.equal(fixture.calls.length, 2);
});

test('Vidara accepts the independently verified vidaraa.cc alias without creating a cookie session', async () => {
  const fixture = fixtureHttp(({ url }) => url === 'https://vidaraa.cc/api/stream'
    ? json(url, { filecode: 'ExampleFile12', title: 'original-upload.2160p.HEVC.mkv', streaming_url: 'https://media.example.invalid/master.m3u8', subtitles: null })
    : response(url, '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\n720.m3u8\n'));
  const result = await resolveVidara(fixture.http, 'https://vidaraa.cc/e/ExampleFile12', 'https://filmpalast.to/stream/example', 'Example');
  assert.equal(result.quality, '720p');
  assert.match(result.title, /^Example.*1280x720.*AVC.*AAC/);
  assert.doesNotMatch(result.title, /2160p|HEVC/);
  assert.equal(result.subtitles, undefined);
  assert.equal(fixture.calls.every(call => call.session === 0), true);
});

function vixeoEncoded(url: string): string {
  return Buffer.from(url, 'utf8').reverse().toString('hex').replace(/(.{10})/g, '$1|');
}

test('Vixeo current layout decodes only the base64 JSON config and binds its public video ID', async () => {
  const embed = 'https://vixeo.io/e/ExampleFile12';
  const source = 'https://media.example.invalid/master.m3u8?fixture=one%2Btwo';
  const config = { videoId: 'ExampleFile12', source: vixeoEncoded(source), isMp4: false, title: 'opaque-upload-name',
    subtitles: [{ path: '/subtitles/de.vtt?fixture=1', lang: 'de', isDefault: true }] };
  const fixture = fixtureHttp(({ url }) => url === embed
    ? response(url, page('Vixeo', `<div id="streamsonic-player-root" data-config="${Buffer.from(JSON.stringify(config)).toString('base64')}"></div><script>throw new Error('not executed')</script>`))
    : response(url, '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x800,CODECS="hvc1.2.4.L153.B0,ec-3"\nvideo.m3u8\n'));
  const stream = await resolveVixeo(fixture.http, embed, 'https://filmpalast.to/stream/example', 'Verified title');
  assert.equal(stream.url, source);
  assert.equal(stream.quality, '1920x800');
  assert.match(stream.title, /^Verified title.*1920x800.*HEVC.*EAC3/);
  assert.equal(stream.subtitles?.[0]?.url, 'https://vixeo.io/subtitles/de.vtt?fixture=1');
  assert.equal(stream.subtitles?.[0]?.headers?.Origin, 'https://vixeo.io');
  assert.equal(stream.language, undefined, 'Caption language is not audio language');
  assert.equal(fixture.calls.length, 2);
});

test('Vixeo legacy layout uses identity-bound hex source data and does not download MP4 files', async () => {
  const embed = 'https://vidsonic.net/e/ExampleFile12';
  const source = 'https://media.example.invalid/movie.mp4?fixture=2';
  const fixture = fixtureHttp(({ url }) => {
    assert.equal(url, embed);
    return response(url, page('Vixeo legacy', `<div id="vsConfig" data-vs="${Buffer.from(JSON.stringify({ v: 'ExampleFile12', m: false, p: false })).toString('base64')}"></div>
      <video id="video-player" data-subtitles='[]'></video><script>
      const _0x1 = "${vixeoEncoded(source)}";
      const _decode = function(s) { throw new Error('Do not execute player code'); };
      let _videoUrl = _decode(_0x1); const isMp4 = true;
      </script>`));
  });
  const stream = await resolveVixeo(fixture.http, embed, 'https://filmpalast.to/stream/example', 'Verified movie');
  assert.equal(stream.url, source);
  assert.equal(stream.title, 'Verified movie');
  assert.equal(stream.quality, undefined);
  assert.equal(fixture.calls.length, 1);
});

test('Vixeo rejects malformed encoding, mismatched IDs and credentialed decoded URLs before media lookup', async () => {
  for (const value of ['odd', 'abz0', '|', vixeoEncoded('https://synthetic:password@media.example.invalid/master.m3u8')]) {
    assert.throws(() => decodeVixeoSource(value), failure('invalid_response'));
  }
  const config = { videoId: 'WrongFile123', source: vixeoEncoded('https://media.example.invalid/master.m3u8'), isMp4: false, subtitles: [] };
  const fixture = fixtureHttp(({ url }) => response(url, page('Vixeo', `<div id="streamsonic-player-root" data-config="${Buffer.from(JSON.stringify(config)).toString('base64')}"></div>`)));
  await assert.rejects(resolveVixeo(fixture.http, 'https://vixeo.io/e/ExampleFile12', 'https://filmpalast.to/stream/example'), failure('invalid_response'));
  assert.equal(fixture.calls.length, 1);
});

test('Playmate normal public API maps its declared abbreviated fields without inventing audio inventory', async () => {
  const source = 'https://media.example.invalid/playmate.m3u8?fixture=1';
  const fixture = fixtureHttp(({ url, options }) => {
    if (url === 'https://playmate.to/api/s') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body!), { c: 'ExampleFile12', d: 'web' });
      assert.equal(options.headers?.Referer, 'https://playmate.to/embed/ExampleFile12');
      return json(url, { cx: 'ExampleFile12', sx: source, tx: '', lx: 'en',
        kx: [{ sk: 0, sf: '/subtitles/de.vtt', sl: 'German' }] });
    }
    assert.equal(url, source);
    return response(url, '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,CODECS="avc1.640020,mp4a.40.2"\nvideo.m3u8\n');
  });
  const stream = await resolvePlaymate(fixture.http, 'https://playmate.to/watch/ExampleFile12', 'https://filmpalast.to/stream/example', 'Verified episode');
  assert.equal(stream.url, source);
  assert.equal(stream.quality, '720p');
  assert.equal(stream.language, undefined);
  assert.equal(stream.subtitles?.[0]?.language, 'de');
  assert.equal(stream.subtitles?.[0]?.url, 'https://playmate.to/subtitles/de.vtt');
});

test('Playmate JSON success is not advertised as playable when the actual HLS endpoint is blocked', async () => {
  const fixture = fixtureHttp(({ url }) => url === 'https://playmate.to/api/s'
    ? json(url, { cx: 'ExampleFile12', sx: 'https://media.example.invalid/blocked.m3u8', kx: [] })
    : response(url, page('Just a moment', 'Challenge'), 403));
  await assert.rejects(resolvePlaymate(fixture.http, 'https://playmate.to/watch/ExampleFile12', 'https://filmpalast.to/stream/example'), failure('source_blocked'));
});

test('Filmpalast attempts the actual FireStream data-player-url instead of a JavaScript href', async () => {
  const fixture = fixtureHttp(({ url }) => {
    if (url.includes('/search/title/')) return response(url, page('Filmpalast', '<a href="/stream/inception">Inception</a>'));
    if (url.includes('/stream/')) return response(url, page('Film Inception Stream', `<article class="detail pDetails"><h2 class="bgDark">Inception</h2><p>Veröffentlicht: 2010</p>
      <a class="iconPlay verystream" href="javascript:void(0)" data-player-url="https://firestream.to/e/Example1">Play</a></article>`));
    assert.equal(url, 'https://firestream.to/e/Example1');
    throw new ProviderError('source_blocked');
  });
  await assert.rejects(createWebProviders(fixture.http, metadata()).filmpalast(movieRequest), failure('source_blocked'));
  assert.equal(fixture.calls.length, 3);
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
