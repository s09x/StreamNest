import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, randomBytes, verify, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { createByseFingerprint } from '../src/native/byse-fingerprint.js';
import { ProviderError } from '../src/native/errors.js';
import type { HttpClient, RequestOptions, TextResponse } from '../src/native/types.js';
import { createNativeRuntime } from './helpers/native-runtime.js';

const origin = 'https://fingerprint.example.invalid';
const headers = { 'User-Agent': 'StreamNest synthetic actual HTTP UA', Referer: origin + '/e/Synthetic1', Origin: origin };
const accepted = { token: 'synthetic-fingerprint-token', viewer_id: 'synthetic-viewer', device_id: 'synthetic-device', confidence: 0.35 };

function replaceGlobal(t: TestContext, name: string, value: unknown): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else Reflect.deleteProperty(globalThis, name);
  });
}

interface Options {
  nonce?: string;
  challenge?: unknown;
  result?: unknown;
  challengeUrl?: string;
  attestUrl?: string;
  challengeStatus?: number;
  attestStatus?: number;
}

function fixture(options: Options = {}) {
  const nonce = options.nonce ?? '  synthetic nonce ä 🚀\n';
  const calls: Array<{ url: string; options?: RequestOptions }> = [];
  const attestations: Record<string, unknown>[] = [];
  const response = (url: string, data: unknown, status = 200): TextResponse => ({
    url, status, text: JSON.stringify(data), header: () => null,
  });
  const http: HttpClient = {
    async request(url, request) {
      calls.push({ url, options: request });
      assert.equal(request?.method, 'POST');
      assert.equal(request?.redirect, 'manual');
      if (url.endsWith('/challenge')) {
        assert.equal(request?.body, undefined);
        return response(options.challengeUrl ?? url,
          options.challenge === undefined ? { challenge_id: 'synthetic-challenge', nonce } : options.challenge, options.challengeStatus ?? 200);
      }
      assert.equal(url, origin + '/api/videos/access/attest');
      const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
      attestations.push(body);
      return response(options.attestUrl ?? url, options.result ?? accepted, options.attestStatus ?? 200);
    },
    async json() { throw new Error('The validated response path must be used'); },
    session() { throw new Error('Fingerprint must use the caller-provided origin session'); },
    cookies() { return {}; },
  };
  return { http, calls, attestations, nonce };
}

function verifyAttestation(body: Record<string, unknown>, nonce: string): void {
  assert.equal(body.viewer_id, '');
  assert.equal(body.device_id, '');
  assert.equal(body.challenge_id, 'synthetic-challenge');
  assert.equal(body.nonce, nonce, 'the signed challenge is not trimmed or normalized');
  assert.deepEqual(body.storage, {});
  assert.deepEqual(body.attributes, { entropy: 'low' });
  const publicKey = body.public_key as Record<string, unknown>;
  assert.equal(publicKey.kty, 'EC');
  assert.equal(publicKey.crv, 'P-256');
  assert.equal(publicKey.d, undefined, 'no private key material is sent');
  assert.match(publicKey.x as string, /^[A-Za-z0-9_-]{43}$/);
  assert.match(publicKey.y as string, /^[A-Za-z0-9_-]{43}$/);
  const signature = Buffer.from(body.signature as string, 'base64url');
  assert.equal(signature.length, 64, 'IEEE-P1363 r || s, not DER');
  const key = createPublicKey({ key: publicKey, format: 'jwk' });
  assert.equal(verify('sha256', Buffer.from(nonce, 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature), true,
    'Node/OpenSSL independently verifies the client signature');
  assert.equal(verify('sha256', Buffer.from(nonce + 'different', 'utf8'), { key, dsaEncoding: 'ieee-p1363' }, signature), false);
}

test('Byse fingerprint prefers native P-256 WebCrypto and signs the exact UTF-8 nonce once', async t => {
  let keyGenerations = 0; let signatures = 0;
  replaceGlobal(t, 'crypto', {
    subtle: {
      async generateKey(...args: Parameters<typeof webcrypto.subtle.generateKey>) {
        keyGenerations++;
        return webcrypto.subtle.generateKey(...args);
      },
      exportKey: webcrypto.subtle.exportKey.bind(webcrypto.subtle),
      async sign(...args: Parameters<typeof webcrypto.subtle.sign>) { signatures++; return webcrypto.subtle.sign(...args); },
    },
    getRandomValues() { throw new Error('Portable key generation must not run'); },
  });
  const mock = fixture();
  assert.deepEqual(await createByseFingerprint(mock.http, origin, headers), accepted);
  assert.equal(keyGenerations, 1);
  assert.equal(signatures, 1);
  assert.equal(mock.calls.length, 2);
  verifyAttestation(mock.attestations[0]!, mock.nonce);
});

test('portable P-256 fallback signs correctly with secure getRandomValues and a fresh key for every invocation', async t => {
  let randomCalls = 0;
  replaceGlobal(t, 'crypto', { getRandomValues(array: Uint8Array) { randomCalls++; return webcrypto.getRandomValues(array); } });
  t.mock.method(Math, 'random', () => { throw new Error('A weak PRNG must never be used'); });
  const publicKeys = new Set<string>();
  for (let index = 0; index < 6; index++) {
    const mock = fixture({ nonce: `synthetic nonce ${index} – ü` });
    assert.deepEqual(await createByseFingerprint(mock.http, origin, headers), accepted);
    verifyAttestation(mock.attestations[0]!, mock.nonce);
    publicKeys.add(JSON.stringify(mock.attestations[0]!.public_key));
  }
  assert.equal(publicKeys.size, 6);
  assert.ok(randomCalls >= 6);
});

test('Mobile-style AES-only subtle API falls back to secure portable ECDSA', async t => {
  let attempts = 0;
  replaceGlobal(t, 'crypto', {
    subtle: {
      async generateKey() { attempts++; throw new Error('ECDSA is not implemented by this native shim'); },
      async exportKey() { throw new Error('Not reached'); },
      async sign() { throw new Error('Not reached'); },
    },
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  });
  const mock = fixture();
  await createByseFingerprint(mock.http, origin, headers);
  assert.equal(attempts, 1);
  verifyAttestation(mock.attestations[0]!, mock.nonce);
});

test('the verified Nuvio native random hex bridge can supply entropy when global crypto is absent', async t => {
  replaceGlobal(t, 'crypto', undefined);
  const requested: number[] = [];
  replaceGlobal(t, '__crypto_get_random_values_hex', (length: number) => {
    requested.push(length);
    return randomBytes(length).toString('hex');
  });
  t.mock.method(Math, 'random', () => { throw new Error('No Math.random fallback'); });
  const mock = fixture();
  await createByseFingerprint(mock.http, origin, headers);
  assert.ok(requested.length >= 1 && requested.every(length => length === 32));
  verifyAttestation(mock.attestations[0]!, mock.nonce);
});

test('missing, broken or malformed secure entropy fails explicitly before challenge requests', async t => {
  replaceGlobal(t, 'crypto', undefined);
  replaceGlobal(t, '__crypto_get_random_values_hex', undefined);
  const missing = fixture();
  await assert.rejects(createByseFingerprint(missing.http, origin, headers),
    error => error instanceof ProviderError && error.code === 'unsupported_runtime');
  assert.equal(missing.calls.length, 0);
  Object.defineProperty(globalThis, '__crypto_get_random_values_hex', { configurable: true, writable: true, value: () => 'not-random-hex' });
  const malformed = fixture();
  await assert.rejects(createByseFingerprint(malformed.http, origin, headers),
    error => error instanceof ProviderError && error.code === 'unsupported_runtime');
  assert.equal(malformed.calls.length, 0);
});

test('invalid private scalars from a broken RNG are bounded instead of reduced or accepted', async t => {
  let requests = 0;
  replaceGlobal(t, 'crypto', { getRandomValues(array: Uint8Array) { requests++; array.fill(0); return array; } });
  replaceGlobal(t, '__crypto_get_random_values_hex', undefined);
  const mock = fixture();
  await assert.rejects(createByseFingerprint(mock.http, origin, headers),
    error => error instanceof ProviderError && error.code === 'unsupported_runtime');
  assert.equal(requests, 16);
  assert.equal(mock.calls.length, 0);
});

test('attested client attributes are actual available values and the actual outgoing User-Agent', async t => {
  replaceGlobal(t, 'crypto', webcrypto);
  replaceGlobal(t, 'navigator', { languages: ['de-DE', 'en-US'], language: 'de-DE', hardwareConcurrency: 8, userAgent: 'unrelated navigator value' });
  replaceGlobal(t, 'Intl', { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/Berlin' }) }) });
  replaceGlobal(t, 'localStorage', new Proxy({}, { get() { throw new Error('Existing storage must not be inspected'); } }));
  const mock = fixture();
  await createByseFingerprint(mock.http, origin, { 'user-agent': headers['User-Agent'], Referer: headers.Referer, Origin: origin });
  assert.deepEqual(mock.attestations[0]!.client, {
    user_agent: headers['User-Agent'], extra: {}, languages: ['de-DE', 'en-US'], hardware_concurrency: 8, timezone: 'Europe/Berlin',
  });
  assert.equal(mock.calls[0]?.options?.headers?.['User-Agent'], headers['User-Agent']);
});

test('unavailable optional host attributes are omitted rather than fabricated', async t => {
  replaceGlobal(t, 'crypto', webcrypto);
  replaceGlobal(t, 'navigator', undefined);
  replaceGlobal(t, 'Intl', undefined);
  const mock = fixture();
  await createByseFingerprint(mock.http, origin, headers);
  assert.deepEqual(mock.attestations[0]!.client, { user_agent: headers['User-Agent'], extra: {} });
});

test('challenge, origin and attestation response validation fail closed without leaking values', async t => {
  replaceGlobal(t, 'crypto', webcrypto);
  const cases: Options[] = [
    { challenge: { challenge_id: 'synthetic-challenge', nonce: '' } },
    { challenge: { challenge_id: 'synthetic-challenge', nonce: 123 } },
    { challengeUrl: 'https://foreign.example.invalid/api/videos/access/challenge' },
    { attestUrl: 'https://foreign.example.invalid/api/videos/access/attest' },
    { result: { ...accepted, token: 'synthetic-token\r\nprivate-data' } },
    { result: { ...accepted, confidence: '0.35' } },
    { result: { ...accepted, confidence: 2 } },
  ];
  for (const options of cases) {
    const mock = fixture(options);
    await assert.rejects(createByseFingerprint(mock.http, origin, headers), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, 'invalid_response');
      assert.ok(!error.message.includes('synthetic-token'));
      return true;
    });
  }
  const mock = fixture();
  await assert.rejects(createByseFingerprint(mock.http, origin + '/wrong-path', headers),
    error => error instanceof ProviderError && error.code === 'invalid_response');
  await assert.rejects(createByseFingerprint(mock.http, origin, { ...headers, Origin: 'https://other.example.invalid' }),
    error => error instanceof ProviderError && error.code === 'invalid_response');
  assert.equal(mock.calls.length, 0);
});

test('access denial is not retried or converted to a fabricated fingerprint', async t => {
  replaceGlobal(t, 'crypto', webcrypto);
  const mock = fixture({ attestStatus: 403 });
  await assert.rejects(createByseFingerprint(mock.http, origin, headers),
    error => error instanceof ProviderError && error.code === 'source_blocked');
  assert.equal(mock.calls.length, 2);
});

test('the browser-bundled portable signer executes in QuickJS without Node, BigInt or text codecs', async () => {
  const nonce = 'synthetic QuickJS nonce ä 🚀';
  const prelude = await readFile(new URL('../src/native/polyfills.js', import.meta.url), 'utf8');
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/native/byse-fingerprint.ts', import.meta.url))],
    bundle: true, write: false, platform: 'browser', target: 'es2016', format: 'iife', globalName: 'FingerprintFixture',
    banner: { js: prelude + '\nglobalThis.BigInt=undefined;globalThis.TextEncoder=undefined;globalThis.TextDecoder=undefined;' },
    footer: { js: 'module.exports=FingerprintFixture;' },
  });
  const runtime = await createNativeRuntime(bundled.outputFiles[0]!.text, { provideCryptoRandom: true, routes: [
    { url: origin + '/api/videos/access/challenge', method: 'POST', body: JSON.stringify({ challenge_id: 'synthetic-challenge', nonce }) },
    { url: origin + '/api/videos/access/attest', method: 'POST', body: JSON.stringify(accepted) },
  ] });
  try {
    // The deterministic entropy provider exists only in this synthetic VM
    // fixture. Production requires the verified cryptographic host interface.
    runtime.value(`globalThis.__fingerprintHttp={
      async request(url,options){const result=await fetch(url,options);return{url:result.url,status:result.status,text:await result.text(),header:name=>result.headers.get(name)}}
    };`);
    const result = await runtime.run(`module.exports.createByseFingerprint(__fingerprintHttp,${JSON.stringify(origin)},${JSON.stringify(headers)})`);
    assert.deepEqual(result, { ok: true, value: accepted });
    const attestation = JSON.parse(runtime.value('__requests[1].body') as string) as Record<string, unknown>;
    verifyAttestation(attestation, nonce);
    assert.equal(runtime.value('typeof Buffer'), 'undefined');
    assert.equal(runtime.value('typeof require'), 'undefined');
    assert.equal(runtime.value('typeof BigInt'), 'undefined');
  } finally { runtime.dispose(); }
});
