import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHdfilmeProvider } from '../src/native/hdfilme.js';
import { ProviderError } from '../src/native/errors.js';
import { createNativeRuntime, type FixtureRoute } from './helpers/native-runtime.js';
import type { ContentRequest, HttpClient, Identity, MetadataProvider, RequestOptions, TextResponse } from '../src/native/types.js';

const request: ContentRequest = { type: 'movie', id: 'tt1375666', imdbId: 'tt1375666' };
const identity: Identity = { type: 'movie', title: 'Inception', aliases: ['Inception'], year: 2010, imdbId: 'tt1375666', tmdbId: '27205' };
const pageUrl = 'https://meinecloud.click/movie/tt1375666';
const voe = 'https://voe.sx/e/abcdefgh1234';
const media = 'https://media.example.invalid/master.m3u8?fixture=one%2Btwo';
const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="de",NAME="Deutsch",URI="de.m3u8"\n'
  + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en",NAME="English",URI="en.m3u8"\n'
  + '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"\n720.m3u8\n';

function html(title: string, body: string): string { return `<html><head><title>${title}</title></head><body>${body}</body></html>`; }
function player(links: string[], id = identity.imdbId, extra = ''): string {
  return html(`Movie ${id}`, `<div class="_player"><ul class="_source_list">${links.map(link =>
    `<li data-link="${link.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">Server</li>`).join('')}</ul>
    <iframe id="_player" src=""></iframe></div>${extra}`);
}
function encoded(url: string): string { return Buffer.from(url).toString('base64'); }
function encodeVoe(value: unknown): string {
  const inner = Buffer.from(JSON.stringify(value)).toString('base64');
  const shifted = [...inner].reverse().map(letter => String.fromCharCode(letter.charCodeAt(0) + 3)).join('');
  return Buffer.from(shifted, 'latin1').toString('base64').replace(/[A-Za-z]/g, letter => {
    const start = letter <= 'Z' ? 65 : 97;
    return String.fromCharCode(start + (letter.charCodeAt(0) - start + 13) % 26);
  });
}
function voePage(url = media): string {
  return html('Watch Inception.2160p.mkv - VOE', `<script type="application/json">${JSON.stringify([encodeVoe({
    source: url, default_audio_language: 'sq',
    captions: [{ file: '/captions/de.ass?fixture=1', language: 'de', label: 'Deutsch vollständig' }],
  })])}</script>`);
}
function response(url: string, text: string, status = 200): TextResponse { return { url, text, status, header: () => null }; }
function metadata(value: Identity | null = identity): MetadataProvider { return { async resolve() { return value; } }; }
function failure(code: string) { return (error: unknown) => error instanceof ProviderError && error.code === code; }
function fixture(handler: (url: string, options: RequestOptions) => TextResponse | Promise<TextResponse>) {
  const calls: Array<{ url: string; options: RequestOptions }> = [];
  const http: HttpClient = {
    async request(url, options = {}) { calls.push({ url, options }); return handler(url, options); },
    async json() { assert.fail('This provider does not use an undocumented JSON endpoint.'); },
    session() { assert.fail('The public player does not require a cookie session.'); },
    cookies() { return {}; },
  };
  return { http, calls };
}

test('HDFilme uses the embedded IMDb player, decodes one Base64 layer, and checks the actual HLS metadata', async () => {
  const source = fixture((url, options) => {
    if (url === pageUrl) {
      assert.equal(options.headers?.Referer, 'https://hdfilme.cafe/');
      return response(url, player([encoded('//voe.sx/e/abcdefgh1234'), voe.replace('/e/', '/'),
        encoded('//dr0pstream.com/e/unsupported12')], undefined,
      `<script>throw new Error('must not execute')</script><a href="https://voe.sx/e/unrelated123">Advertisement</a>`));
    }
    if (url === voe) { assert.equal(options.headers?.Referer, pageUrl); return response(url, voePage()); }
    assert.equal(url, media);
    assert.equal(options.headers?.Referer, voe);
    return response(url, master);
  });
  const streams = await createHdfilmeProvider(source.http, metadata())(request);
  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.url, media);
  assert.equal(streams[0]?.quality, '720p');
  assert.equal(streams[0]?.language, 'de / en');
  assert.match(streams[0]!.title, /1280x720 • AVC • AAC • VOE$/);
  assert.equal(streams[0]?.subtitles?.[0]?.url, 'https://voe.sx/captions/de.ass?fixture=1');
  assert.deepEqual(source.calls.map(call => call.url), [pageUrl, voe, media]);
});

test('HDFilme keeps case-distinct file IDs and different hoster origins separate', async () => {
  const links = ['https://voe.sx/e/ExampleFile1', 'https://voe.sx/e/examplefile1', 'https://www.voe.sx/e/ExampleFile1'];
  const source = fixture(url => {
    if (url === pageUrl) return response(url, player(links));
    const index = links.indexOf(url);
    return response(url, index < 0 ? master : voePage(`https://media.example.invalid/${index}.m3u8`));
  });
  const streams = await createHdfilmeProvider(source.http, metadata())(request);
  assert.deepEqual(streams.map(stream => stream.url), links.map((_, index) => `https://media.example.invalid/${index}.m3u8`));
});

test('HDFilme avoids requests for series, missing metadata, and TMDB items without a verified IMDb mapping', async () => {
  const source = fixture(() => assert.fail('No source request is expected.'));
  const unused: MetadataProvider = { async resolve() { assert.fail('Series must be rejected before metadata lookup.'); } };
  assert.deepEqual(await createHdfilmeProvider(source.http, unused)({ type: 'tv', id: '106379', season: 1, episode: 1 }), []);
  assert.deepEqual(await createHdfilmeProvider(source.http, metadata(null))(request), []);
  assert.deepEqual(await createHdfilmeProvider(source.http, metadata({ ...identity, imdbId: undefined }))({
    type: 'movie', id: '27205', tmdbId: '27205',
  }), []);
  assert.deepEqual(source.calls, []);
});

test('HDFilme rejects conflicting public identities before following a player link', async () => {
  const source = fixture(() => assert.fail('An inconsistent identity must not reach the source.'));
  for (const value of [{ ...identity, type: 'tv' as const }, { ...identity, imdbId: 'tt0133093' }, { ...identity, title: '' }]) {
    await assert.rejects(createHdfilmeProvider(source.http, metadata(value))(request), failure('invalid_response'));
  }
  await assert.rejects(createHdfilmeProvider(source.http, metadata())({ type: 'movie', id: '603', tmdbId: '603' }), failure('invalid_response'));
});

test('HDFilme distinguishes absent movies and unsupported mirrors from malformed source responses', async () => {
  for (const result of [response(pageUrl, html('404 | Not Found', 'Not Found'), 404), response(pageUrl, player([])),
    response(pageUrl, player([encoded('//mxdrop.to/e/unsupported12')]))]) {
    const source = fixture(() => result);
    assert.deepEqual(await createHdfilmeProvider(source.http, metadata())(request), []);
    assert.equal(source.calls.length, 1);
  }
  for (const body of ['error', 'Fatal error: unexpected source failure', player([voe], 'tt0133093'),
    html('Movie tt1375666', '<a href="https://voe.sx/e/abcdefgh1234">Unrelated link</a>')]) {
    await assert.rejects(createHdfilmeProvider(fixture(() => response(pageUrl, body)).http, metadata())(request), failure('invalid_response'));
  }
});

test('HDFilme rejects changed player destinations and incomplete or challenged pages', async () => {
  for (const target of ['https://meinecloud.click/movie/tt0133093', 'https://other.example.invalid/movie/tt1375666']) {
    await assert.rejects(createHdfilmeProvider(fixture(() => response(target, player([voe]))).http, metadata())(request), failure('invalid_response'));
  }
  await assert.rejects(createHdfilmeProvider(fixture(() => response(pageUrl, player([voe]).replace('</html>', ''))).http, metadata())(request), failure('response_incomplete'));
  await assert.rejects(createHdfilmeProvider(fixture(() => response(pageUrl, html('Just a moment...', 'Challenge'), 403)).http, metadata())(request), failure('source_blocked'));
});

test('HDFilme rejects malformed encodings and unsafe URLs without executing or following them', async () => {
  for (const value of ['A', 'A===', '!!!!', encoded('javascript:alert(1)'), encoded('https://account:secret@voe.sx/e/abcdefgh1234'),
    encoded('//voe.sx/e/abcdefgh1234\n'), 'A'.repeat(16_001)]) {
    const source = fixture(url => { assert.equal(url, pageUrl); return response(url, player([value])); });
    await assert.rejects(createHdfilmeProvider(source.http, metadata())(request), failure('invalid_response'));
    assert.equal(source.calls.length, 1);
  }
  const excessive = fixture(() => response(pageUrl, player(Array.from({ length: 33 }, () => voe))));
  await assert.rejects(createHdfilmeProvider(excessive.http, metadata())(request), failure('response_incomplete'));
});

test('HDFilme isolates malformed rows and failing hosters while retaining successful streams', async () => {
  const broken = 'https://voe.sx/e/blocked12345';
  const source = fixture(url => {
    if (url === pageUrl) return response(url, player(['!!!', broken, voe]));
    if (url === broken) return response(url, html('Just a moment...', 'Challenge'), 403);
    if (url === voe) return response(url, voePage());
    assert.equal(url, media);
    return response(url, master);
  });
  const streams = await createHdfilmeProvider(source.http, metadata())(request);
  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.url, media);
});

test('HDFilme keeps all-mirror failures explicit, including an unusable media playlist', async () => {
  for (const blockedAt of ['hoster', 'media']) {
    const source = fixture(url => {
      if (url === pageUrl) return response(url, player([voe]));
      if (url === voe && blockedAt === 'media') return response(url, voePage());
      return response(url, html('Attention Required!', 'Blocked'), 403);
    });
    await assert.rejects(createHdfilmeProvider(source.http, metadata())(request), failure('source_blocked'));
  }
  const invalid = fixture(url => response(url, url === pageUrl ? player([voe]) : url === voe ? voePage() : html('Unavailable', 'No media')));
  await assert.rejects(createHdfilmeProvider(invalid.http, metadata())(request), failure('invalid_response'));
});

test('HDFilme preserves mirror order with at most three concurrent resolutions and deduplicates media URLs', async () => {
  let active = 0, maximum = 0;
  const links = Array.from({ length: 5 }, (_, index) => `https://voe.sx/e/fixturefile${index}`);
  const source = fixture(async url => {
    if (url === pageUrl) return response(url, player(links));
    const index = links.indexOf(url);
    if (index >= 0) {
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, (5 - index) * 5));
      active--;
      return response(url, voePage(`https://media.example.invalid/${index === 4 ? 0 : index}.m3u8`));
    }
    return response(url, master);
  });
  const streams = await createHdfilmeProvider(source.http, metadata())(request);
  assert.equal(maximum, 3);
  assert.deepEqual(streams.map(stream => stream.url), Array.from({ length: 4 }, (_, index) => `https://media.example.invalid/${index}.m3u8`));
});

test('HDFilme does not infer a resolution or audio inventory from an upload filename or source language', async () => {
  const source = fixture(url => response(url, url === pageUrl ? player([voe]) : url === voe ? voePage()
    : '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nsegment.ts\n#EXT-X-ENDLIST\n'));
  const [stream] = await createHdfilmeProvider(source.http, metadata())(request);
  assert.equal(stream?.quality, undefined);
  assert.equal(stream?.language, undefined);
  assert.equal(source.calls.some(call => call.url.endsWith('segment.ts')), false);
});

for (const provideAtob of [false, true]) test(`built HDFilme movie flow executes in QuickJS with Mobile URLs and a 256 KiB stack (native atob: ${provideAtob})`, async () => {
  const finalVoe = 'https://alias.example.invalid/e/abcdefgh1234';
  const nested = '<div>'.repeat(512) + 'Unrelated nested page content' + '</div>'.repeat(512);
  const routes: FixtureRoute[] = [
    { url: 'https://v3-cinemeta.strem.io/meta/movie/tt1375666.json', body: JSON.stringify({ meta: {
      id: 'tt1375666', imdb_id: 'tt1375666', moviedb_id: 27205, type: 'movie', name: 'Inception', releaseInfo: '2010',
    } }) },
    { url: 'https://www.themoviedb.org/movie/27205?language=de-DE', body: html('Inception',
      '<link rel="canonical" href="https://www.themoviedb.org/movie/27205-fixture"><div class="title"><h2><a>Inception</a><span class="tag release_date">(2010)</span></h2></div>') },
    { url: pageUrl, body: player([encoded('//voe.sx/e/abcdefgh1234')], undefined,
      `<script>globalThis.untrustedScriptExecuted = true;</script>${nested}`) },
    { url: voe, body: `<script>window.location.href='${finalVoe}';</script>` },
    { url: finalVoe, body: voePage() },
    { url: media, body: master },
  ];
  const bundle = await readFile(new URL('../providers/hdfilme.js', import.meta.url), 'utf8');
  const runtime = await createNativeRuntime(bundle, { routes, mobileUrl: true, provideAtob, maxStackSize: 256 * 1024 });
  try {
    const result = await runtime.run(`module.exports.getStreams('tt1375666', 'movie', null, null)`);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const streams = result.value as Array<Record<string, unknown>>;
    assert.equal(streams.length, 1);
    assert.equal(streams[0]?.url, media);
    assert.equal(streams[0]?.quality, '720p');
    assert.equal(streams[0]?.language, 'de / en');
    assert.equal(runtime.value('__requests.length'), 6);
    assert.equal(runtime.value('typeof untrustedScriptExecuted'), 'undefined');
    assert.equal(runtime.value(`__requests.some(request => /Cookie|Authorization/.test(Object.keys(request.headers).join(' ')))`), false);
    assert.deepEqual(await runtime.run(`module.exports.getStreams('tt12637874', 'series', 1, 1)`), { ok: true, value: [] });
    assert.equal(runtime.value('__requests.length'), 6);
  } finally { runtime.dispose(); }
});
