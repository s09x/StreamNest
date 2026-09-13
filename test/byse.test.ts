import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { byseProofHash, decodeBysePlayback, isByseUrl, resolveByse, resolveByseVariants, solveByseProof } from '../src/native/byse.js';
import { ProviderError } from '../src/native/errors.js';
import { createHttpClient } from '../src/native/http.js';
import type { HttpClient, RequestOptions, TextResponse } from '../src/native/types.js';
import { createNativeRuntime } from './helpers/native-runtime.js';

function errorCode(code: string) {
  return (error: unknown) => error instanceof ProviderError && error.code === code
    && !error.message.includes('synthetic-secret');
}

function envelope(data: unknown, version?: string, keyLength = 32) {
  const key = Buffer.from(Array.from({ length: keyLength }, (_, index) => index + 1));
  const iv = Buffer.from(Array.from({ length: 12 }, (_, index) => index + 41));
  const cipher = createCipheriv(`aes-${keyLength * 8}-gcm`, key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final(), cipher.getAuthTag()]);
  let parts = [key.subarray(0, keyLength / 2).toString('base64url'), key.subarray(keyLength / 2).toString('base64url')];
  if (version !== undefined) {
    parts = Array.from({ length: 30 }, (_, index) => Buffer.alloc(16, index + 80).toString('base64url'));
    const number = Number(version);
    parts[number - 1] = key.subarray(0, keyLength / 2).toString('base64url');
    parts[30 - number] = key.subarray(keyLength / 2).toString('base64url');
  }
  return { version, key_parts: parts, iv: iv.toString('base64url'), payload: ciphertext.toString('base64url') };
}

test('recognizes Byse watch/embed URLs without accepting arbitrary lookalike hosts or credentials', () => {
  assert.equal(isByseUrl('https://bysezejataos.com/d/fmrwk7t9u074'), true);
  assert.equal(isByseUrl('https://bysezejataos.com/e/abcdefghijkl/title'), true);
  assert.equal(isByseUrl('https://filemoon.to/d/abcdefghijkl'), true);
  for (const url of ['https://evilbyse.com/d/abcdefghijkl', 'https://bysebuho.com.evil.invalid/e/abcdefghijkl',
    'https://byse-unverified.org/d/abcdefghijkl', 'https://user:synthetic-secret@bysezejataos.com/d/abcdefghijkl', 'file:///d/abcdefghijkl',
    'https://bysebuho.com/login', 'https://bysebuho.com/d/short']) assert.equal(isByseUrl(url), false);
});

test('matches independent protocol proof vectors, including the source Latin-1 byte conversion', () => {
  // Recorded with the independent protocol reproduction used for a successful
  // server-verified difficulty-16 proof; no live challenge or tokens are retained.
  assert.deepEqual([...byseProofHash('test:0')], [744680823, 2636175254, 3389231444, 4274117603, 238808918, 1804181830, 3538118053, 2924124411]);
  assert.deepEqual([...byseProofHash('nøñçé:12')], [2352152455, 1654927825, 1504963056, 2611576591, 3927409052, 1297475374, 3259699045, 3451500224]);
});

test('computes a genuine bounded proof and distinguishes an exhausted budget', async () => {
  assert.equal(await solveByseProof('synthetic-nonce', 8, { maxAttempts: 173, timeoutMs: 2000 }), '172');
  assert.equal(await solveByseProof('synthetic-nonce', 8, { maxAttempts: 172, timeoutMs: 2000 }), null);
  assert.equal(await solveByseProof('synthetic-nonce', 0), '0');
  assert.equal(await solveByseProof('synthetic-nonce', 16, { timeoutMs: 0 }), null);
  assert.equal(await solveByseProof('synthetic-nonce', 16, { maxAttempts: 0 }), null);
  await assert.rejects(solveByseProof('', 1), errorCode('invalid_response'));
  await assert.rejects(solveByseProof('synthetic', 257), errorCode('invalid_response'));
  await assert.rejects(solveByseProof('synthetic', 1, { timeoutMs: 20001 }), errorCode('invalid_response'));
  await assert.rejects(solveByseProof('synthetic', 1, { maxAttempts: 1_048_577 }), errorCode('invalid_response'));
});

test('proof computation can yield in a native runtime without a timer function', async () => {
  const saved = globalThis.setTimeout;
  try {
    (globalThis as unknown as { setTimeout: unknown }).setTimeout = undefined;
    assert.equal(await solveByseProof('synthetic-nonce', 256, { maxAttempts: 257 }), null);
  } finally { globalThis.setTimeout = saved; }
});

test('authenticates Node-produced AES-GCM fixtures with portable AES-128/192/256 and UTF-8 data', () => {
  const data = { sources: [{ url: 'https://cdn.example.invalid/media.m3u8?value=synthetic-secret', height: 1080 }], title: 'Grüße 😀', tracks: [] };
  for (const length of [16, 24, 32]) assert.deepEqual(decodeBysePlayback(envelope(data, undefined, length)), data);
  assert.deepEqual(decodeBysePlayback(envelope(data, '5')), data);
  assert.deepEqual(decodeBysePlayback(envelope(data, '20')), data);
});

test('rejects tampered ciphertext, wrong version key selection and malformed encrypted metadata', () => {
  const data = envelope({ sources: [], tracks: [] }, '5');
  const corrupted = Buffer.from(data.payload, 'base64url');
  corrupted[0] = corrupted[0]! ^ 1;
  for (const value of [
    { ...data, payload: corrupted.toString('base64url') }, { ...data, version: '4' },
    { ...data, iv: Buffer.alloc(8).toString('base64url') }, { ...data, payload: 'bad!!' },
    { ...data, key_parts: [''] }, { ...data, key_parts: [42] }, { ...data, payload: 'a'.repeat(384001) },
    envelope([]), envelope('synthetic-secret'),
  ]) assert.throws(() => decodeBysePlayback(value), errorCode('invalid_response'));
});

test('bundled proof and GCM execute without BigInt, native crypto, Node or text codecs', async () => {
  const prelude = await readFile(new URL('../src/native/polyfills.js', import.meta.url), 'utf8');
  const built = await build({ entryPoints: [fileURLToPath(new URL('../src/native/byse.ts', import.meta.url))],
    bundle: true, platform: 'browser', target: 'es2016', format: 'iife', globalName: 'ByseFixture', write: false,
    banner: { js: prelude + '\nglobalThis.BigInt=undefined;globalThis.crypto=undefined;globalThis.TextEncoder=undefined;globalThis.TextDecoder=undefined;' },
    footer: { js: 'module.exports=ByseFixture;' } });
  const runtime = await createNativeRuntime(built.outputFiles[0]!.text);
  try {
    const plaintext = { sources: [{ url: 'https://cdn.example.invalid/test.m3u8' }], title: 'Deutsch ä 😀', tracks: [] };
    assert.deepEqual(runtime.value(`module.exports.decodeBysePlayback(${JSON.stringify(envelope(plaintext, '5'))})`), plaintext);
    assert.deepEqual(runtime.value(`Array.from(module.exports.byseProofHash('test:0'))`),
      [744680823, 2636175254, 3389231444, 4274117603, 238808918, 1804181830, 3538118053, 2924124411]);
    const proof = await runtime.run(`module.exports.solveByseProof('synthetic-nonce',8,{maxAttempts:173})`);
    assert.deepEqual(proof, { ok: true, value: '172' });
    assert.equal(runtime.value('typeof Buffer'), 'undefined');
    assert.equal(runtime.value('typeof BigInt'), 'undefined');
    assert.deepEqual(runtime.value('__requests'), []);
  } finally { runtime.dispose(); }
});

const code = 'abcdefghijkl';
const watch = `https://bysezejataos.com/d/${code}`;
const frame = `https://frame.example.invalid/n3i/${code}`;
const sourcePage = 'https://filmo.to/movies/synthetic-film';
const attestationNonce = 'synthetic exact nonce: Grüße 😀';
const fingerprint = { token: 'synthetic-fingerprint-token', viewer_id: 'synthetic-viewer', device_id: 'synthetic-device', confidence: 0.35 };
const media = {
  sources: [
    { url: 'https://cdn.example.invalid/1080.mp4?signature=synthetic', mime_type: 'video/mp4', height: 1080, size_bytes: 2147483649 },
    { url: 'https://cdn.example.invalid/master.m3u8?signature=synthetic', mime_type: 'application/vnd.apple.mpegurl', height: 1080, size_bytes: 2147483649 },
  ],
  tracks: [
    { url: '/captions/de.vtt?signature=synthetic', language: 'ger', title: 'Deutsch vollständig', kind: 'captions' },
    { url: '/captions/en.vtt?signature=synthetic', language: 'eng', title: 'English', kind: 'subtitles' },
    { url: '/thumbnails.vtt', kind: 'thumbnails' },
  ],
};
interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
interface FixtureOptions { captcha?: boolean; verification?: string; premium?: boolean; mismatch?: boolean; frameMismatch?: boolean; rotatingEmbedFrame?: boolean; challengeStatus?: number; attestationStatus?: number; playbackStatus?: number; invalidMedia?: unknown; deadHls?: boolean }
function fixture(options: FixtureOptions = {}) {
  const calls: Call[] = [];
  let sessions = 0;
  let frameAliases = 0;
  const http: HttpClient = {
    async request(input: string, request: RequestOptions = {}): Promise<TextResponse> {
      const url = new URL(input);
      const call = { url: input, method: request.method ?? 'GET', headers: request.headers ?? {}, body: request.body };
      calls.push(call);
      if (url.origin === 'https://cdn.example.invalid') {
        const text = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="ger",URI="de.m3u8"\n'
          + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="eng",URI="en.m3u8"\n'
          + '#EXT-X-STREAM-INF:RESOLUTION=1920x800,CODECS="hvc1.1.6.L120.90,mp4a.40.2",AUDIO="a"\nvideo.m3u8\n';
        return { status: options.deadHls ? 404 : 200, url: input, text, header: () => null };
      }
      const embedded = url.origin === 'https://frame.example.invalid';
      const requestedCode = url.pathname.split('/')[3] ?? code;
      const requestedFrame = `https://frame.example.invalid/n3i/${options.frameMismatch ? 'wrongcode1234' : requestedCode}`;
      const tail = url.pathname.replace(`/api/videos/${requestedCode}/`, '').replace(/^embed\//, '');
      let status = 200; let result: unknown;
      if (url.pathname === '/api/videos/access/challenge') {
        assert.equal(embedded, true, 'the terminal iframe origin issues the challenge');
        assert.equal(call.method, 'POST');
        assert.equal(request.body, undefined);
        result = { challenge_id: 'synthetic-access-challenge', nonce: attestationNonce };
      } else if (url.pathname === '/api/videos/access/attest') {
        assert.equal(call.method, 'POST');
        const payload = JSON.parse(request.body!);
        assert.equal(payload.challenge_id, 'synthetic-access-challenge');
        assert.equal(payload.nonce, attestationNonce);
        assert.equal(payload.viewer_id, '');
        assert.equal(payload.device_id, '');
        assert.deepEqual(payload.storage, {});
        assert.equal(payload.client.user_agent, call.headers['User-Agent']);
        const signature = Buffer.from(payload.signature, 'base64url');
        assert.equal(signature.length, 64);
        assert.equal(verify('sha256', Buffer.from(attestationNonce), {
          key: createPublicKey({ key: payload.public_key, format: 'jwk' }), dsaEncoding: 'ieee-p1363',
        }, signature), true, 'the challenge has a genuine ephemeral P-256 signature');
        status = options.attestationStatus ?? 200;
        result = status === 200 ? fingerprint : { error: 'synthetic-secret upstream error' };
      } else if (tail === 'details') result = { code: options.mismatch ? 'othercode123' : requestedCode,
        title: 'Synthetic Movie 2020 German 1080p', owner_private: false,
        embed_frame_url: embedded && options.rotatingEmbedFrame
          ? `https://frame.example.invalid/${String(++frameAliases).padStart(3, 'a')}/${requestedCode}` : requestedFrame };
      else if (tail === 'settings') result = { code: requestedCode, premium_only: options.premium ?? false,
        captcha_required: embedded ? options.captcha ?? false : true };
      else if (tail === 'captcha') {
        assert.deepEqual(JSON.parse(request.body!), { fingerprint });
        assert.equal(call.method, 'POST');
        status = options.challengeStatus ?? 200;
        result = { pow_nonce: 'synthetic-nonce', pow_difficulty: 8, pow_token: 'synthetic-challenge-token', expires_in: 1800 };
      } else if (tail === 'captcha/verify') {
        assert.deepEqual(JSON.parse(request.body!), { pow_token: 'synthetic-challenge-token', solution: '172', fingerprint });
        result = { status: options.verification ?? 'ok', token: 'synthetic-verified-token', expires_in: 1800 };
      } else if (tail === 'playback') {
        assert.equal(call.method, 'POST');
        assert.deepEqual(JSON.parse(request.body!), { fingerprint });
        if (options.captcha) assert.equal(call.headers['X-Captcha-Token'], 'synthetic-verified-token');
        status = options.playbackStatus ?? 200;
        result = status === 200 ? { playback: envelope(options.invalidMedia ?? media, '5') } : { error: 'synthetic-secret upstream error' };
      } else throw new Error('Unexpected test route');
      return { status, url: input, text: JSON.stringify(result), header: () => null };
    },
    async json(url, request) { return JSON.parse((await http.request(url, request)).text); },
    session() { sessions++; return http; }, cookies() { return {}; },
  };
  return { http, calls, sessions: () => sessions };
}

test('Filemoon uses the verified Byse protocol and retains all separately published media variants', async () => {
  const f = fixture();
  const streams = await resolveByseVariants(f.http, `https://filemoon.to/d/${code}`, 'https://huhu.to/', 'Verified title');
  assert.deepEqual(streams.map(stream => stream.url), [media.sources[1]!.url, media.sources[0]!.url]);
  assert.deepEqual(streams.map(stream => stream.quality), ['1920x800', '1080p']);
  assert.ok(streams.every(stream => stream.subtitles?.length === 2));
  assert.equal(f.calls.filter(call => /\/playback$/.test(call.url)).length, 1, 'All variants share the same attestation and playback request');
});

test('all-variant Byse resolution preserves a file alternative when its HLS source has expired', async () => {
  const f = fixture({ deadHls: true });
  const streams = await resolveByseVariants(f.http, watch, sourcePage);
  assert.deepEqual(streams.map(stream => stream.url), [media.sources[0]!.url]);
});

test('follows the declared iframe before interpreting watch captcha settings and preserves source sidecars', async () => {
  const f = fixture();
  const stream = await resolveByse(f.http, watch, sourcePage, 'Verified display title');
  assert.equal(f.sessions(), 2, 'watch and iframe origins each have an isolated cookie session');
  assert.equal(stream.url, media.sources[1]!.url);
  assert.equal(stream.quality, '1920x800');
  assert.equal(stream.size, undefined, 'one file size is not the size of an adaptive media graph');
  assert.equal(stream.language, 'de / en');
  assert.match(stream.title, /^Verified display title/);
  assert.match(stream.title, /HEVC/);
  assert.equal(stream.subtitles?.length, 2);
  assert.deepEqual(stream.subtitles?.map(item => item.language), ['de', 'en']);
  assert.equal(stream.subtitles?.[0]?.url, 'https://frame.example.invalid/captions/de.vtt?signature=synthetic');
  assert.equal(stream.subtitles?.[0]?.name, 'Deutsch vollständig');
  assert.equal(stream.headers?.Referer, frame);
  assert.equal(stream.subtitles?.[0]?.headers?.Referer, frame);
  assert.ok(!f.calls.some(call => /captcha/.test(call.url)));
  assert.equal(f.calls.filter(call => /cdn\.example/.test(call.url)).length, 1, 'only the small master is checked');
  assert.ok(f.calls.filter(call => call.url.startsWith('https://frame.example.invalid')).every(call => call.headers['X-Embed-Parent'] === watch));
  assert.ok(f.calls.every(call => !call.headers['X-Embed-Origin'] && !call.headers['X-Embed-Referer']));
});

test('submits genuine attestation, computed proof and server tokens in the required sequence', async () => {
  const f = fixture({ captcha: true });
  const stream = await resolveByse(f.http, watch, sourcePage);
  assert.equal(stream.url, media.sources[1]!.url);
  assert.equal(f.calls.filter(call => call.url.endsWith('/captcha')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/captcha/verify')).length, 1);
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => new URL(call.url).pathname), [
    '/api/videos/access/challenge', '/api/videos/access/attest',
    `/api/videos/${code}/embed/captcha`, `/api/videos/${code}/embed/captcha/verify`, `/api/videos/${code}/embed/playback`,
  ]);
  assert.ok(!JSON.stringify(stream).includes('synthetic-fingerprint-token'));
  assert.ok(!JSON.stringify(stream).includes('synthetic-verified-token'));
  assert.ok(!JSON.stringify(stream).includes('synthetic-challenge-token'));
});

test('a terminal alias frame ignores newly minted embed URLs and continues to attestation and playback', async () => {
  for (const initial of [watch, `https://bysezejataos.com/e/${code}`]) {
    const f = fixture({ captcha: true, rotatingEmbedFrame: true });
    const stream = await resolveByse(f.http, initial, sourcePage);
    assert.equal(stream.url, media.sources[1]!.url);
    assert.equal(f.calls.filter(call => call.url.endsWith('/details')).length, 2,
      'only the entry page and its declared alias frame load details');
    assert.equal(f.calls.filter(call => call.url.endsWith('/access/attest')).length, 1);
    assert.equal(f.calls.filter(call => call.url.endsWith('/playback')).length, 1);
    assert.equal(stream.headers?.Referer, frame, 'the first declared alias remains the playback context');
  }
});

test('shares an origin attestation within one lookup while keeping file proofs independent', async () => {
  const f = fixture({ captcha: true });
  const secondCode = 'zyxwvutsrqpo';
  await Promise.all([
    resolveByse(f.http, watch, sourcePage),
    resolveByse(f.http, `https://bysezejataos.com/d/${secondCode}`, sourcePage),
  ]);
  assert.equal(f.sessions(), 2);
  assert.equal(f.calls.filter(call => call.url.endsWith('/access/challenge')).length, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/access/attest')).length, 1);
  assert.deepEqual(f.calls.filter(call => call.url.endsWith('/captcha/verify')).map(call => new URL(call.url).pathname).sort(),
    [`/api/videos/${code}/embed/captcha/verify`, `/api/videos/${secondCode}/embed/captcha/verify`].sort());
  const nextLookup = fixture({ captcha: true });
  await resolveByse(nextLookup.http, watch, sourcePage);
  assert.equal(nextLookup.calls.filter(call => call.url.endsWith('/access/attest')).length, 1,
    'a separate lookup creates its own attestation');
});

test('a failed fingerprint flight can recover in the same anonymous lookup session', async () => {
  const options: FixtureOptions = { attestationStatus: 403 };
  const f = fixture(options);
  await assert.rejects(resolveByse(f.http, watch, sourcePage), errorCode('source_blocked'));
  options.attestationStatus = 200;
  const stream = await resolveByse(f.http, watch, sourcePage);
  assert.equal(stream.url, media.sources[1]!.url);
  assert.equal(f.sessions(), 2);
  assert.equal(f.calls.filter(call => call.url.endsWith('/access/attest')).length, 2);
});

test('keeps origin access cookies through proof and playback without leaking them to the CDN', async () => {
  const f = fixture({ captcha: true });
  const http = createHttpClient(async (input, options = {}) => {
    const url = new URL(input);
    const outgoing = options.headers ?? {};
    let cookie: string | null = null;
    if (url.origin === 'https://bysezejataos.com' && url.pathname.endsWith('/details')) {
      cookie = 'watch-state=synthetic-watch; Path=/; Secure';
    } else if (url.origin === 'https://frame.example.invalid') {
      assert.ok(!String(outgoing.Cookie).includes('synthetic-watch'), 'watch cookies stay on the watch origin');
      if (url.pathname.endsWith('/details')) cookie = 'frame-state=synthetic-frame; Path=/; Secure';
      else assert.match(outgoing.Cookie!, /frame-state=synthetic-frame/);
      if (url.pathname.endsWith('/access/attest')) cookie = 'access-state=synthetic-access; Path=/; Secure';
      if (/captcha|playback/.test(url.pathname)) assert.match(outgoing.Cookie!, /access-state=synthetic-access/);
    } else if (url.origin === 'https://cdn.example.invalid') {
      assert.equal(outgoing.Cookie, undefined);
      assert.equal(outgoing['X-Captcha-Token'], undefined);
      assert.ok(!JSON.stringify(outgoing).includes(fingerprint.token));
    }
    const response = await f.http.request(input, options);
    return { status: response.status, url: response.url, text: async () => response.text,
      headers: { get: (name: string) => name.toLowerCase() === 'set-cookie' ? cookie : null } };
  });
  await resolveByse(http, watch, sourcePage);
});

test('failed attestation, image/rejected-proof and premium cases stop without an image solver or media request', async () => {
  for (const options of [{ attestationStatus: 403 }, { captcha: true, verification: 'retry' }, { captcha: true, challengeStatus: 403 }, { premium: true }]) {
    const f = fixture(options);
    await assert.rejects(resolveByse(f.http, watch, sourcePage), errorCode('source_blocked'));
    assert.ok(!f.calls.some(call => /playback|captcha\/image|cdn\.example/.test(call.url)));
  }
});

test('identity conflicts, frame code mismatches and malformed playback never become a usable stream', async () => {
  for (const options of [{ mismatch: true }, { frameMismatch: true }, { invalidMedia: { sources: [], tracks: [] } },
    { invalidMedia: { sources: [{ url: 'javascript:alert(1)' }], tracks: [] } }]) {
    const f = fixture(options);
    await assert.rejects(resolveByse(f.http, watch, sourcePage), errorCode('invalid_response'));
  }
});

test('a playback HTTP error stays explicit even after proof verification succeeded', async () => {
  const f = fixture({ captcha: true, playbackStatus: 405 });
  await assert.rejects(resolveByse(f.http, watch, sourcePage), errorCode('request_failed'));
});

test('does not return a dead HLS URL or inherit technical metadata from the upload name', async () => {
  const f = fixture({ deadHls: true });
  await assert.rejects(resolveByse(f.http, watch, sourcePage), errorCode('request_failed'));
});
