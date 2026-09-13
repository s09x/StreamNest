import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { createCipheriv, createPublicKey, verify } from 'node:crypto';
import { createNativeRuntime, type FixtureRoute, type GuestResult } from './helpers/native-runtime.js';

interface ManifestEntry { id: string; filename: string; supportedTypes: string[]; hasSettings: boolean; version: string }
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8')) as { version: string; scrapers: ManifestEntry[] };

async function bundle(name: string): Promise<string> {
  return readFile(new URL(`providers/${name}.js`, root), 'utf8');
}
function fulfilled<T>(result: GuestResult): T {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  return (result as { ok: true; value: T }).value;
}
function route(url: string, body: unknown, extra: Partial<FixtureRoute> = {}): FixtureRoute {
  return { url, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra };
}
function html(title: string, body: string, head = ''): string {
  return `<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
}
function tmdbPage(type: string, id: string, title: string, year: number) {
  return html('TMDB fixture', `<div class="title"><h2><a>${title}</a><span class="tag release_date">(${year})</span></h2></div>`,
    `<link rel="canonical" href="https://www.themoviedb.org/${type}/${id}-fixture">`);
}
function encodeVoe(value: unknown): string {
  const inner = Buffer.from(JSON.stringify(value)).toString('base64');
  const shifted = [...inner].reverse().map(character => String.fromCharCode(character.charCodeAt(0) + 3)).join('');
  const encoded = Buffer.from(shifted, 'latin1').toString('base64').replace(/(.{4})/g, '$1!!');
  return encoded.replace(/[A-Za-z]/g, letter => {
    const first = letter <= 'Z' ? 65 : 97;
    return String.fromCharCode(first + (letter.charCodeAt(0) - first + 13) % 26);
  });
}
function voePage(mediaName: string): string {
  return html(`Watch ${mediaName}.1080p.HEVC.mkv - VOE | fixture`,
    `<script type="application/json">${JSON.stringify([encodeVoe({
      source: `https://media.example.invalid/${mediaName}.m3u8?fixture=one%2Btwo`,
      captions: [{ file: '/subs/de.ass?fixture=1', language: 'de', label: 'Deutsch vollständig' }],
      audio_languages: [{ countryCode: 'de' }, { countryCode: 'en' }], default_audio_language: 'sq',
    })])}</script>`);
}
function movieMetadata(): FixtureRoute[] {
  return [
    route('https://v3-cinemeta.strem.io/meta/movie/tt1375666.json', { meta: {
      id: 'tt1375666', imdb_id: 'tt1375666', moviedb_id: 27205, type: 'movie', name: 'Inception', releaseInfo: '2010',
    } }),
    route('https://www.themoviedb.org/movie/27205?language=de-DE', tmdbPage('movie', '27205', 'Inception', 2010)),
  ];
}
const initialVoe = 'https://voe.sx/abcdefgh1234';
const finalVoe = 'https://alias.example.invalid/e/abcdefgh1234';
function voeRoutes(mediaName: string): FixtureRoute[] {
  return [
    route(initialVoe, `<script>window.location.href='${finalVoe}';</script>`),
    route(finalVoe, voePage(mediaName)),
  ];
}

test('generated providers parse as ES2016 for Nuvio Hermes dynamic loading', async () => {
  for (const entry of manifest.scrapers) {
    const code = await readFile(new URL(entry.filename, root), 'utf8');
    let program: unknown;
    assert.doesNotThrow(() => { program = parse(code, { ecmaVersion: 2016, sourceType: 'script' }); },
      `${entry.filename} must not require native async functions or newer dynamic syntax`);
    function checkSyntax(node: unknown): void {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(checkSyntax); return; }
      const value = node as Record<string, unknown>;
      assert.notEqual(value.type, 'ClassDeclaration', 'Hermes requires lowered class declarations');
      assert.notEqual(value.type, 'ClassExpression', 'Hermes requires lowered class expressions');
      Object.values(value).forEach(checkSyntax);
    }
    checkSyntax(program);
  }
});

test('manifest bundles execute as native CJS exports without Node globals or external require', async () => {
  assert.equal(manifest.scrapers.length, 6);
  const ids = new Set(manifest.scrapers.map(item => item.id));
  assert.equal(ids.size, 6);
  for (const entry of manifest.scrapers) {
    assert.equal(entry.version, manifest.version);
    assert.match(entry.filename, /^providers\/(?:filmpalast|filmo|einschalten|hdfilme|megakino|xtream)\.js$/);
    assert.deepEqual(entry.supportedTypes, ['streamnest-filmo', 'streamnest-einschalten', 'streamnest-hdfilme'].includes(entry.id) ? ['movie'] : ['movie', 'tv']);
    const code = await readFile(new URL(entry.filename, root), 'utf8');
    assert.ok(Buffer.byteLength(code) < 1024 * 1024);
    const runtime = await createNativeRuntime(code);
    try {
      assert.equal(runtime.value('globalThis.fetch === __originalHostFetch'), true, 'bundled parser functions must not overwrite the Nuvio fetch bridge');
      assert.deepEqual(runtime.value(`({getStreams:typeof module.exports.getStreams,settings:typeof module.exports.onSettings,
        require:typeof require,Buffer:typeof Buffer,process:typeof process,fetchPreserved:fetch === __savedHostFetch})`), {
        getStreams: 'function', settings: entry.hasSettings ? 'function' : 'undefined',
        require: 'undefined', Buffer: 'undefined', process: 'undefined', fetchPreserved: true,
      });
      const invalid = await runtime.run(`module.exports.getStreams('not-an-id','movie')`);
      assert.equal(invalid.ok, false);
      if (!invalid.ok) {
        assert.equal(invalid.error.code, 'invalid_request');
        assert.equal(invalid.error.message, 'StreamNest: invalid movie or episode request.');
      }
      assert.deepEqual(runtime.value('__requests'), []);
    } finally { runtime.dispose(); }
  }
});

for (const mobileUrl of [false, true]) test(`Xtream native settings export declares host and sensitive account fields without returning stored values (mobile URL: ${mobileUrl})`, async () => {
  const runtime = await createNativeRuntime(await bundle('xtream'), {
    mobileUrl,
    settings: { host: 'https://iptv.example.invalid:8080', username: 'synthetic-account', password: 'synthetic-password' },
  });
  try {
    assert.equal(runtime.value('Array.isArray(module.exports.onSettings())'), true,
      'the settings blueprint is available synchronously without starting stream work');
    const fields = fulfilled<Array<Record<string, unknown>>>(await runtime.run('module.exports.onSettings()'));
    assert.equal(fields.find(field => field.key === 'host')?.type, 'text');
    assert.equal(fields.find(field => field.key === 'username')?.isPassword, true);
    assert.equal(fields.find(field => field.key === 'password')?.isPassword, true);
    assert.ok(!JSON.stringify(fields).includes('synthetic-account'));
    assert.ok(!JSON.stringify(fields).includes('synthetic-password'));
    assert.deepEqual(runtime.value('__requests'), []);
  } finally { runtime.dispose(); }
});

test('bundle preserves a host-provided standard atob implementation', async () => {
  const runtime = await createNativeRuntime(await bundle('filmpalast'), { provideAtob: true });
  try {
    assert.equal(runtime.value('atob === __originalAtob'), true);
    assert.equal(runtime.value(`atob('SGVsbG8=')`), 'Hello');
    assert.equal(runtime.value('typeof Buffer'), 'undefined');
  } finally { runtime.dispose(); }
});

test('actual Filmpalast bundle resolves a movie through guest promises, DOM parsing, and data-only VOE decoding', async () => {
  const runtime = await createNativeRuntime(await bundle('filmpalast'), { routes: [
    ...movieMetadata(),
    route('https://filmpalast.to/search/title/Inception', html('Filmpalast search', '<a href="/stream/inception">Inception</a>')),
    route('https://filmpalast.to/stream/inception', html('Film Inception Stream', `<article class="detail pDetails">
      <h2 class="bgDark">Inception</h2><span id="release_text">Inception.German.DL.1080p.HEVC</span>
      <p>Veröffentlicht: 2010</p><a class="button rb iconPlay" href="${initialVoe}">Play</a></article>`)),
    ...voeRoutes('movie'),
  ] });
  try {
    const streams = fulfilled<Array<Record<string, unknown>>>(await runtime.run(`module.exports.getStreams('tt1375666','movie')`));
    assert.equal(streams.length, 1);
    assert.equal(streams[0]?.url, 'https://media.example.invalid/movie.m3u8?fixture=one%2Btwo');
    assert.equal(streams[0]?.language, 'de / en');
    assert.match(String(streams[0]?.title), /HEVC/);
    const subtitles = streams[0]?.subtitles as Array<Record<string, unknown>>;
    assert.equal(subtitles[0]?.url, 'https://alias.example.invalid/subs/de.ass?fixture=1');
    assert.equal(subtitles[0]?.name, 'Deutsch vollständig');
    assert.equal(runtime.value('__requests.length'), 6);
    assert.equal(runtime.value(`__requests.some(request => request.url.startsWith('https://media.example.invalid/'))`), false);
  } finally { runtime.dispose(); }
});

test('Filmpalast resolves Doctor Strange protocol-relative links with the Nuvio Mobile URL bindings', async () => {
  const title = 'Doctor Strange in the Multiverse of Madness';
  const detail = 'https://filmpalast.to/stream/doctor-strange-in-the-multiverse-of-madness';
  const media = 'https://fixture.flyfile.app/hls/fixture-token/master.m3u8';
  const runtime = await createNativeRuntime(await bundle('filmpalast'), { mobileUrl: true, routes: [
    route('https://www.themoviedb.org/movie/453395?language=de-DE', tmdbPage('movie', '453395', title, 2022)),
    route(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(title)}.json`, { metas: [
      { id: 'tt9419884', name: title, type: 'movie', releaseInfo: '2022' },
    ] }),
    route('https://v3-cinemeta.strem.io/meta/movie/tt9419884.json', { meta: {
      id: 'tt9419884', name: title, type: 'movie', moviedb_id: 453395, releaseInfo: '2022',
    } }),
    route(`https://filmpalast.to/search/title/${encodeURIComponent(title)}`, html('Filmpalast search',
      `<a href="${detail.replace('https:', '')}">${title}</a>`)),
    route(detail, html(`Film ${title} Stream`, `<article class="detail pDetails"><h2 class="bgDark">${title}</h2>
      <p>Veröffentlicht: 2022</p><a class="iconPlay" href="//odysseusa.cc/e/fixture12345">Ignored</a>
      <a class="iconPlay" href="//vidaraa.cc/e/fixture12345">Ignored</a>
      <a class="iconPlay" href="//flyfile.app/v/fixture12345">Play</a></article>`,
      `<link rel="canonical" href="${detail.replace('https:', '')}">`)),
    route('https://api.flyfile.app/api/public/file/fixture12345', { token: 'fixture12345', id: 'fixture-id', name: title,
      videoAsset: { qualities: [{ status: 'READY' }], subtitles: [{ url: '//subs.example.invalid/de.vtt?fixture=a%2Bb', lang: 'de' }] } }),
    route('https://api.flyfile.app/api/streaming/assign/fixture12345', { url: 'https://fixture.flyfile.app', token: 'fixture-token' }),
    route(media, '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\nvideo.m3u8\n'),
  ] });
  try {
    assert.equal(runtime.value(`new URL('//filmpalast.to/stream/example','https://filmpalast.to').href`),
      'https://filmpalast.to//filmpalast.to/stream/example', 'fixture must retain the real client defect');
    assert.equal(runtime.value(`new URL('https://filmpalast.to/stream/example').search`), '?');
    assert.equal(runtime.value(`new URL('https://filmpalast.to/stream/example').hash`), '#');
    const streams = fulfilled<Array<Record<string, unknown>>>(await runtime.run(`module.exports.getStreams('453395','movie',null,null)`));
    assert.equal(streams.length, 1);
    assert.equal(streams[0]?.url, media);
    assert.equal(streams[0]?.quality, '720p');
    assert.equal((streams[0]?.subtitles as Array<Record<string, unknown>>)[0]?.url, 'https://subs.example.invalid/de.vtt?fixture=a%2Bb');
    assert.equal(runtime.value('__requests.length'), 8);
    assert.equal(runtime.value(`__requests.some(request => /odysseusa\\.cc|vidaraa\\.cc/.test(request.url))`), false);
    assert.equal(runtime.value(`new URL('https://filmpalast.to/stream/example').hash`), '#',
      'the provider must adapt URL instances without overwriting the host constructor');
  } finally { runtime.dispose(); }
});

test('actual Filmpalast bundle maps numeric TMDB identity and preserves exact series episode coordinates', async () => {
  const runtime = await createNativeRuntime(await bundle('filmpalast'), { routes: [
    route('https://www.themoviedb.org/tv/106379?language=de-DE', tmdbPage('tv', '106379', 'Fallout', 2024)),
    route('https://v3-cinemeta.strem.io/catalog/series/top/search=Fallout.json', { metas: [
      { id: 'tt12637874', name: 'Fallout', type: 'series', releaseInfo: '2024-' },
    ] }),
    route('https://v3-cinemeta.strem.io/meta/series/tt12637874.json', { meta: {
      id: 'tt12637874', imdb_id: 'tt12637874', name: 'Fallout', type: 'series', moviedb_id: 106379, releaseInfo: '2024-',
    } }),
    route('https://filmpalast.to/search/title/Fallout%20S02E01', html('Filmpalast search',
      '<a href="/stream/adjacent">Fallout S02E02</a><a href="/stream/fallout-s02e01">Fallout S02E01</a>')),
    route('https://filmpalast.to/stream/fallout-s02e01', html('Serie Fallout S02E01 Stream', `<article class="detail pDetails">
      <h2 class="bgDark">Fallout S02E01</h2><p>Veröffentlicht: 2024</p><a class="iconPlay" href="${initialVoe}">Play</a></article>`)),
    ...voeRoutes('episode'),
  ] });
  try {
    const streams = fulfilled<Array<Record<string, unknown>>>(await runtime.run(`module.exports.getStreams('106379','series',2,1)`));
    assert.equal(streams.length, 1);
    assert.equal(streams[0]?.url, 'https://media.example.invalid/episode.m3u8?fixture=one%2Btwo');
    assert.equal(runtime.value(`__requests.some(request => request.url.includes('adjacent'))`), false);
  } finally { runtime.dispose(); }
});

test('actual Filmo bundle carries guest cookie and CSRF context through the normal mint redirect', async () => {
  const chip = '<div data-provider-chip data-movie-link-id="12" data-p="synthetic-payload" aria-label="VOE"><span class="provider-chip__name">VOE</span><span class="provider-chip__metadata">BluRay 720p</span></div>';
  const runtime = await createNativeRuntime(await bundle('filmo'), { routes: [
    route('http://filmo.to/', '', { status: 301, headers: { location: 'https://filmo.to/' } }),
    ...movieMetadata(),
    route('https://filmo.to/search/suggest?q=Inception', { movies: [{ title: 'Inception', url: 'https://filmo.to/movies/inception' }] }),
    route('https://filmo.to/movies/inception', html('Filmo Inception', `<main><h1>Inception</h1><p>Erscheinungsdatum: 2010</p><div class="provider-row">Deutsch ${chip}</div></main>`,
      '<meta name="csrf-token" content="synthetic-csrf">'), {
      headers: { 'set-cookie': 'XSRF-TOKEN=runtime%2Ffixture; Path=/; Secure, filmo-session=synthetic-session; Path=/; Secure' },
    }),
    route('https://filmo.to/n', { x: 'synthetic-jump' }, { method: 'POST' }),
    route('https://filmo.to/n/synthetic-jump', '', { status: 302, headers: { location: initialVoe } }),
    ...voeRoutes('filmo'),
  ] });
  try {
    const streams = fulfilled<Array<Record<string, unknown>>>(await runtime.run(`module.exports.getStreams('tt1375666','movie')`));
    assert.equal(streams.length, 1);
    const mint = runtime.value(`__requests.find(request => request.url === 'https://filmo.to/n')`) as { body: string; headers: Record<string, string> };
    assert.deepEqual(JSON.parse(mint.body), { p: 'synthetic-payload' });
    assert.equal(mint.headers['X-CSRF-TOKEN'], 'synthetic-csrf');
    assert.equal(mint.headers['X-XSRF-TOKEN'], 'runtime/fixture');
    assert.match(mint.headers.Cookie!, /filmo-session=synthetic-session/);
    assert.equal(streams[0]?.url, 'https://media.example.invalid/filmo.m3u8?fixture=one%2Btwo');
  } finally { runtime.dispose(); }
});

test('actual Filmo bundle excludes a VOE-only session when the host auto-follows redirects', async () => {
  const chip = '<div data-provider-chip data-movie-link-id="12" data-p="unused-payload"><span class="provider-chip__name">VOE</span></div>';
  const runtime = await createNativeRuntime(await bundle('filmo'), { routes: [
    route('http://filmo.to/', html('Filmo', 'Public home'), { finalUrl: 'https://filmo.to/' }),
    ...movieMetadata(),
    route('https://filmo.to/search/suggest?q=Inception', { movies: [{ title: 'Inception', url: 'https://filmo.to/movies/inception' }] }),
    route('https://filmo.to/movies/inception', html('Filmo Inception', `<main><h1>Inception</h1><p>Erscheinungsdatum: 2010</p>${chip}</main>`)),
  ] });
  try {
    const result = await runtime.run(`module.exports.getStreams('tt1375666','movie')`);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, 'unsupported_runtime');
    assert.equal(runtime.value('__requests.length'), 5);
    assert.equal(runtime.value(`__requests.some(request => Object.keys(request.headers).some(key => /cookie|csrf/i.test(key)))`), false);
    assert.equal(runtime.value(`__requests.some(request => request.url.startsWith('https://filmo.to/n'))`), false);
  } finally { runtime.dispose(); }
});

for (const mobileUrl of [false, true]) test(`actual Filmo bundle completes Byse attestation, proof and authenticated playback without manual redirects or native ECDSA (mobile URL: ${mobileUrl})`, async () => {
  const code = 'abcdefghijkl';
  const watch = `https://bysezejataos.com/d/${code}`;
  const frame = `https://frame.example.invalid/n3i/${code}`;
  const frameApi = `https://frame.example.invalid/api/videos/${code}/embed`;
  const nonce = 'synthetic nonce: Grüße';
  const fingerprint = { token: 'synthetic-fingerprint', viewer_id: 'synthetic-viewer', device_id: 'synthetic-device', confidence: 0.35 };
  const mediaUrl = 'https://cdn.example.invalid/byse/master.m3u8';
  const key = Buffer.alloc(32, 7); const iv = Buffer.alloc(12, 3);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify({
    sources: [{ url: mediaUrl, mime_type: 'application/vnd.apple.mpegurl', height: 1080 }],
    tracks: [{ url: 'https://cdn.example.invalid/de.vtt', language: 'ger', title: 'Deutsch', kind: 'captions' }],
  })), cipher.final(), cipher.getAuthTag()]);
  const encrypted = { version: '0', key_parts: [key.subarray(0, 16).toString('base64url'), key.subarray(16).toString('base64url')],
    iv: iv.toString('base64url'), payload: payload.toString('base64url') };
  const chip = (name: string, id: string) => `<div data-provider-chip data-movie-link-id="${id}" data-p="synthetic-${name}"><span class="provider-chip__name">${name}</span></div>`;
  // The reported iOS crash exhausted the native stack while recursively reading
  // a nested Filmo page. Keep deep markup outside the selected stream fields.
  const nestedMarkup = '<div>'.repeat(512) + 'Nested page content' + '</div>'.repeat(512);
  const runtime = await createNativeRuntime(await bundle('filmo'), { mobileUrl, maxStackSize: 256 * 1024, provideCryptoRandom: true, routes: [
    route('http://filmo.to/', html('Filmo', 'Public home'), { finalUrl: 'https://filmo.to/' }),
    ...movieMetadata(),
    route('https://filmo.to/search/suggest?q=Inception', { movies: [{ title: 'Inception', url: '//filmo.to/movies/inception' }] }),
    route('https://filmo.to/movies/inception', html('Filmo Inception', `<main><h1>Inception</h1><p>Erscheinungsdatum: 2010</p>${chip('VOE', '1')}${chip('Byse', '2')}${nestedMarkup}</main>`,
      '<meta name="csrf-token" content="synthetic-csrf">'), { headers: { 'set-cookie': 'filmo-session=synthetic-session; Path=/; Secure' } }),
    route('https://filmo.to/n', { x: 'synthetic-jump' }, { method: 'POST' }),
    route('https://filmo.to/n/synthetic-jump', html('Video öffnen', `<a class="open" rel="noopener noreferrer" href="${watch}">Open</a>`)),
    route(`https://bysezejataos.com/api/videos/${code}/details`, { code, title: 'Upload 1080p', embed_frame_url: frame }),
    route(`https://bysezejataos.com/api/videos/${code}/settings`, { code, captcha_required: true }),
    route(`${frameApi}/details`, { code, title: 'Upload 1080p', embed_frame_url: `https://frame.example.invalid/next/${code}` }),
    route(`${frameApi}/settings`, { code, captcha_required: true }),
    route('https://frame.example.invalid/api/videos/access/challenge', { challenge_id: 'synthetic-access', nonce }, { method: 'POST' }),
    route('https://frame.example.invalid/api/videos/access/attest', fingerprint, { method: 'POST' }),
    route(`${frameApi}/captcha`, { pow_nonce: 'synthetic-nonce', pow_difficulty: 8, pow_token: 'synthetic-proof', expires_in: 1800 }, { method: 'POST' }),
    route(`${frameApi}/captcha/verify`, { status: 'ok', token: 'synthetic-captcha' }, { method: 'POST' }),
    route(`${frameApi}/playback`, { playback: encrypted }, { method: 'POST' }),
    route(mediaUrl, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="en",URI="en.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="de",URI="de.m3u8"\n#EXT-X-STREAM-INF:RESOLUTION=1716x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="a"\nvideo.m3u8\n'),
  ] });
  try {
    const streams = fulfilled<Array<Record<string, unknown>>>(await runtime.run(`module.exports.getStreams('tt1375666','movie')`));
    assert.equal(streams.length, 1);
    assert.equal(streams[0]?.url, mediaUrl);
    assert.equal(streams[0]?.quality, '720p');
    assert.equal(streams[0]?.language, 'en / de');
    assert.doesNotMatch(String(streams[0]?.title), /1080p/);
    const nativeLabel = String(streams[0]?.name ?? streams[0]?.title);
    assert.match(nativeLabel, /1716x720/);
    assert.match(nativeLabel, /Byse/);
    const requests = runtime.value('__requests') as Array<{ url: string; headers: Record<string, string>; body?: string }>;
    const attest = requests.find(request => request.url.endsWith('/access/attest'))!;
    const body = JSON.parse(attest.body!);
    assert.equal(verify('sha256', Buffer.from(nonce), {
      key: createPublicKey({ key: body.public_key, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
    }, Buffer.from(body.signature, 'base64url')), true);
    assert.equal(body.public_key.d, undefined);
    for (const request of requests.filter(request => request.url.startsWith(frameApi) && request.body)) {
      assert.deepEqual(JSON.parse(request.body!).fingerprint, fingerprint);
      assert.equal(request.headers.Cookie, undefined);
    }
    assert.equal(requests.some(request => request.url.includes('/next/')), false);
    assert.equal(requests.some(request => request.url.includes('voe.sx')), false);
    assert.equal(runtime.value('typeof Buffer'), 'undefined');
    assert.equal(runtime.value('typeof crypto.subtle'), 'undefined');
  } finally { runtime.dispose(); }
});

function xtreamRoutes(): FixtureRoute[] {
  const api = 'https://iptv.example.invalid:8080/player_api.php';
  return [
    route(api, [{ stream_id: 10, name: 'Inception (2010)', tmdb: '27205', container_extension: 'mkv' }], {
      method: 'POST', form: { action: 'get_vod_streams' },
    }),
    route(api, { movie_data: { stream_id: 10, container_extension: 'mkv' }, info: {
      tmdb_id: 27205, video: { width: 1920, height: 1080, codec_name: 'h264' },
      audio: { codec_name: 'aac', channels: 2 }, filesize: 1_073_741_824,
    } }, { method: 'POST', form: { action: 'get_vod_info', vod_id: '10' } }),
    route(api, { user_info: { auth: 1, status: 'Active' } }, { method: 'POST' }),
  ];
}

test('actual Xtream bundle uses only synthetic native settings and cannot retain an account across fresh contexts', async () => {
  const code = await bundle('xtream');
  const first = await createNativeRuntime(code, {
    settings: { host: 'https://iptv.example.invalid:8080', username: 'fixture-one', password: 'fixture-pass-one' }, routes: xtreamRoutes(),
  });
  try {
    const streams = fulfilled<Array<Record<string, unknown>>>(await first.run(`module.exports.getStreams('27205','movie')`));
    assert.equal(streams.length, 1);
    assert.equal(streams[0]?.url, 'https://iptv.example.invalid:8080/movie/fixture-one/fixture-pass-one/10.mkv');
    assert.equal(first.value('__requests.length'), 3);
    assert.equal(first.value(`__requests.some(request => request.method !== 'POST')`), false);
  } finally { first.dispose(); }
  const empty = await createNativeRuntime(code, { routes: xtreamRoutes() });
  try {
    const result = await empty.run(`module.exports.getStreams('27205','movie')`);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'configuration_required');
      assert.ok(!result.error.message.includes('fixture-one'));
      assert.ok(!result.error.message.includes('fixture-pass-one'));
    }
    assert.deepEqual(empty.value('__requests'), []);
  } finally { empty.dispose(); }
  const second = await createNativeRuntime(code, {
    settings: { host: 'https://iptv.example.invalid:8080', username: 'fixture-two', password: 'fixture-pass-two' }, routes: xtreamRoutes(),
  });
  try {
    const streams = fulfilled<Array<Record<string, unknown>>>(await second.run(`module.exports.getStreams('27205','movie')`));
    assert.equal(streams[0]?.url, 'https://iptv.example.invalid:8080/movie/fixture-two/fixture-pass-two/10.mkv');
  } finally { second.dispose(); }
});

test('actual Xtream bundle validates Enigma2 XML after incomplete series JSON and confirms the public series identity', async () => {
  const host = 'https://iptv.example.invalid:8080';
  const api = `${host}/player_api.php`;
  const title = Buffer.from('Dark (2017)', 'utf8').toString('base64');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><items><channel><title><![CDATA[${title}]]></title>
    <description></description><playlist_url><![CDATA[${host}/enigma2.php?type=get_seasons&series_id=4092]]></playlist_url>
    </channel></items>`;
  const runtime = await createNativeRuntime(await bundle('xtream'), {
    mobileUrl: true,
    settings: { host, username: 'xml-fixture-user', password: 'xml-fixture-password' },
    routes: [
      route(api, [{ category_id: '7', category_name: 'Fixture series' }], { method: 'POST', form: { action: 'get_series_categories' } }),
      route(api, '[{"series_id":', { method: 'POST', form: { action: 'get_series', category_id: '7' } }),
      route(api, 'Unsupported bulk catalog', { status: 404, method: 'POST', form: { action: 'get_series' } }),
      route(`${host}/enigma2.php?username=xml-fixture-user&password=xml-fixture-password&type=get_series&cat_id=7`, xml),
      route(api, {
        info: { name: 'Dark', releaseDate: '2017-12-01', tmdb: '70523', imdb_id: 'tt5753856' },
        episodes: { 1: [{ id: 8091, season: 1, episode_num: 1, title: 'Synthetic first episode', container_extension: 'mkv', info: {} }] },
      }, { method: 'POST', form: { action: 'get_series_info', series_id: '4092' } }),
      route(api, { user_info: { auth: 1, status: 'Active' } }, { method: 'POST' }),
      route('https://www.themoviedb.org/tv/70523?language=de-DE', tmdbPage('tv', '70523', 'Dark', 2017)),
      route('https://v3-cinemeta.strem.io/catalog/series/top/search=Dark.json', { metas: [
        { id: 'tt5753856', name: 'Dark', type: 'series', releaseInfo: '2017-2020' },
      ] }),
      route('https://v3-cinemeta.strem.io/meta/series/tt5753856.json', { meta: {
        id: 'tt5753856', imdb_id: 'tt5753856', name: 'Dark', type: 'series', moviedb_id: 70523, releaseInfo: '2017-2020',
      } }),
    ],
  });
  try {
    const streams = fulfilled<Array<Record<string, unknown>>>(await runtime.run(`module.exports.getStreams('70523','tv',1,1)`));
    assert.equal(streams.length, 1);
    assert.equal(streams[0]?.url, `${host}/series/xml-fixture-user/xml-fixture-password/8091.mkv`);
    const calls = runtime.value('__requests') as Array<{ url: string; method: string; body: string }>;
    const providerCalls = calls.filter(call => call.url.startsWith(host));
    assert.equal(providerCalls.length, 6);
    for (const call of providerCalls) {
      const legacy = call.url.startsWith(`${host}/enigma2.php?`);
      assert.equal(call.method, legacy ? 'GET' : 'POST');
      assert.ok(legacy || call.url === api);
      const form = legacy ? new URL(call.url).searchParams : new URLSearchParams(call.body);
      assert.equal(form.get('username'), 'xml-fixture-user');
      assert.equal(form.get('password'), 'xml-fixture-password');
      if (legacy) assert.equal(form.get('type'), 'get_series');
    }
    assert.equal(providerCalls.filter(call => new URLSearchParams(call.body).get('series_id') === '4092').length, 1);
    assert.equal(calls.filter(call => call.url.startsWith('https://www.themoviedb.org/')).length, 1);
    assert.equal(calls.filter(call => call.url.startsWith('https://v3-cinemeta.strem.io/')).length, 2);
    assert.equal(runtime.value(`typeof Buffer`), 'undefined');
    assert.equal(runtime.value(`typeof require`), 'undefined');
  } finally { runtime.dispose(); }
});
