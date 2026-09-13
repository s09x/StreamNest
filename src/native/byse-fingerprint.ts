import { resolveUrl } from './url.js';
import elliptic from 'elliptic';
import type { ec as EllipticCurveTypes } from 'elliptic';
import { hash as sha256 } from '@stablelib/sha256';
import { ProviderError } from './errors.js';
import { jsonResponse, objectValue } from './metadata.js';
import type { HttpClient, TextResponse } from './types.js';

export type ByseFingerprint = {
  token: string;
  viewer_id: string;
  device_id: string;
  confidence: number;
};

interface SigningKey {
  publicKey: JsonWebKey;
  sign(message: Uint8Array): Promise<Uint8Array>;
  destroy(): void;
}

type Runtime = typeof globalThis & {
  __crypto_get_random_values_hex?: (length: number) => unknown;
};

const ORDER = new Uint8Array([
  255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255,
  188, 230, 250, 173, 167, 23, 158, 132, 243, 185, 202, 194, 252, 99, 37, 81,
]);
const EllipticCurve = elliptic.ec;

function unsupported(): never { throw new ProviderError('unsupported_runtime'); }
function invalid(): never { throw new ProviderError('invalid_response'); }

function base64url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!; const second = bytes[index + 1]; const third = bytes[index + 2];
    output += alphabet[first >>> 2];
    output += alphabet[(first & 3) << 4 | (second ?? 0) >>> 4];
    if (second !== undefined) output += alphabet[(second & 15) << 2 | (third ?? 0) >>> 6];
    if (third !== undefined) output += alphabet[third & 63];
  }
  return output;
}

function utf8(value: string): Uint8Array {
  let escaped: string;
  try { escaped = encodeURIComponent(value); } catch { return invalid(); }
  const bytes: number[] = [];
  for (let index = 0; index < escaped.length; index++) {
    if (escaped[index] === '%') { bytes.push(parseInt(escaped.slice(index + 1, index + 3), 16)); index += 2; }
    else bytes.push(escaped.charCodeAt(index));
  }
  return new Uint8Array(bytes);
}

function publicJwk(value: JsonWebKey): JsonWebKey {
  if (value.kty !== 'EC' || value.crv !== 'P-256' || typeof value.x !== 'string' || typeof value.y !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(value.x) || !/^[A-Za-z0-9_-]{43}$/.test(value.y) || value.d !== undefined) return unsupported();
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y, ext: true, key_ops: ['verify'] };
}

function secureRandom(runtime: Runtime): (bytes: Uint8Array<ArrayBuffer>) => void {
  const nativeCrypto = runtime.crypto;
  const random = nativeCrypto && typeof nativeCrypto.getRandomValues === 'function'
    ? nativeCrypto.getRandomValues.bind(nativeCrypto) : undefined;
  const bridge = typeof runtime.__crypto_get_random_values_hex === 'function'
    ? runtime.__crypto_get_random_values_hex : undefined;
  if (!random && !bridge) return unsupported();
  return bytes => {
    if (random) {
      try { random(bytes); return; }
      catch { if (!bridge) return unsupported(); }
    }
    // This exact bridge is registered by Nuvio Mobile's CryptoBridge and backed
    // by SecureRandom (Android) / SecRandomCopyBytes (iOS), not a JS PRNG.
    let encoded: unknown;
    try { encoded = bridge!(bytes.length); } catch { return unsupported(); }
    if (typeof encoded !== 'string' || encoded.length !== bytes.length * 2 || !/^[0-9a-f]+$/i.test(encoded)) return unsupported();
    for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(encoded.slice(index * 2, index * 2 + 2), 16);
  };
}

function validScalar(bytes: Uint8Array): boolean {
  let nonzero = false; let comparison = 0;
  for (let index = 0; index < ORDER.length; index++) {
    const byte = bytes[index]!;
    nonzero ||= byte !== 0;
    if (comparison === 0 && byte !== ORDER[index]) comparison = byte < ORDER[index]! ? -1 : 1;
  }
  return nonzero && comparison < 0;
}

function portableKey(runtime: Runtime): SigningKey {
  const random = secureRandom(runtime);
  const entropy = new Uint8Array(32);
  let accepted = false;
  try {
    for (let attempt = 0; attempt < 16; attempt++) {
      random(entropy);
      if (validScalar(entropy)) { accepted = true; break; }
      entropy.fill(0);
    }
    if (!accepted) return unsupported();
    const curve = new EllipticCurve('p256');
    const material = Array.from(entropy);
    let pair: EllipticCurveTypes.KeyPair | undefined;
    try { pair = curve.keyFromPrivate(material); }
    finally { material.fill(0); entropy.fill(0); }
    const point = pair.getPublic(false, 'array');
    if (point.length !== 65 || point[0] !== 4 || !pair.validate().result) return unsupported();
    const publicKey = publicJwk({ kty: 'EC', crv: 'P-256',
      x: base64url(new Uint8Array(point.slice(1, 33))), y: base64url(new Uint8Array(point.slice(33, 65))) });
    let used = false;
    return {
      publicKey,
      async sign(message) {
        if (used || !pair) return unsupported();
        used = true;
        const digest = sha256(message);
        try {
          // elliptic has a known advisory. This narrow fallback signs one exact
          // SHA-256 digest with one fresh ephemeral key; it never reuses keys or
          // accepts caller-supplied nonces/scalars. This is not a clean-audit claim.
          const signature = curve.sign(Array.from(digest), pair, { canonical: true });
          const output = new Uint8Array(64);
          output.set(signature.r.toArray('be', 32), 0);
          output.set(signature.s.toArray('be', 32), 32);
          return output;
        } finally { digest.fill(0); }
      },
      destroy() {
        // Best effort for JS-held key material; the runtime owns its heap/GC.
        if (pair) {
          const scalar = pair.getPrivate() as unknown as { words?: number[] };
          scalar.words?.fill(0);
          pair = undefined;
        }
      },
    };
  } catch (error) { throw error instanceof ProviderError ? error : new ProviderError('unsupported_runtime'); }
  finally { entropy.fill(0); }
}

async function signingKey(runtime: Runtime): Promise<SigningKey> {
  const subtle = runtime.crypto?.subtle;
  if (subtle && typeof subtle.generateKey === 'function' && typeof subtle.exportKey === 'function' && typeof subtle.sign === 'function') {
    try {
      // Public keys remain exportable when the private key is non-extractable.
      const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const publicKey = publicJwk(await subtle.exportKey('jwk', keys.publicKey));
      let privateKey: CryptoKey | undefined = keys.privateKey;
      let used = false;
      return {
        publicKey,
        async sign(message) {
          if (used || !privateKey) return unsupported();
          used = true;
          try {
            const input = new Uint8Array(message);
            const signed = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, input.buffer));
            if (signed.length !== 64) return unsupported();
            return signed;
          } catch { return unsupported(); }
        },
        destroy() { privateKey = undefined; },
      };
    } catch {
      // The verified Mobile shim exposes secure randomness but only AES/HMAC
      // generateKey. Use the portable P-256 implementation in that situation.
    }
  }
  return portableKey(runtime);
}

function opaque(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value || /[\r\n\0]/.test(value)) return invalid();
  return value;
}

function originUrl(value: string): string {
  try {
    const url = resolveUrl(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return invalid();
    return url.origin;
  } catch { return invalid(); }
}

function requestHeaders(values: Record<string, string>, origin: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(key) || typeof value !== 'string' || /[\r\n\0]/.test(value)) return invalid();
    const lower = key.toLowerCase();
    if (seen.has(lower) && seen.get(lower) !== value) return invalid();
    seen.set(lower, value);
    if (!['origin', 'user-agent', 'content-type', 'accept'].includes(lower)) headers[key] = value;
  }
  if (seen.has('origin') && seen.get('origin') !== origin) return invalid();
  // The attested user_agent is exactly the header this helper sends. No OS,
  // browser family, canvas, or screen characteristics are invented.
  headers['User-Agent'] = seen.get('user-agent') ?? 'Mozilla/5.0';
  headers.Origin = origin;
  headers.Accept = 'application/json';
  return headers;
}

function clientAttributes(userAgent: string): Record<string, unknown> {
  const client: Record<string, unknown> = { user_agent: userAgent, extra: {} };
  try {
    const nav = globalThis.navigator;
    if (nav) {
      const languages = Array.isArray(nav.languages) ? nav.languages : typeof nav.language === 'string' ? [nav.language] : [];
      const actual = languages.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 64);
      if (actual.length > 0 && actual.length <= 32) client.languages = [...actual];
      if (Number.isSafeInteger(nav.hardwareConcurrency) && nav.hardwareConcurrency > 0) client.hardware_concurrency = nav.hardwareConcurrency;
    }
  } catch { /* Optional host attributes are omitted when the runtime lacks them. */ }
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof timezone === 'string' && timezone.length > 0 && timezone.length <= 128) client.timezone = timezone;
  } catch { /* No fallback timezone or browser identity is fabricated. */ }
  return client;
}

function checkedJson(response: TextResponse, endpoint: string): Record<string, unknown> {
  if (response.url !== endpoint) return invalid();
  if ([401, 403, 429].includes(response.status)) throw new ProviderError('source_blocked');
  const value = objectValue(jsonResponse(response));
  return value ?? invalid();
}

/** One anonymous origin attestation; no identity or private key is persisted here. */
export async function createByseFingerprint(http: HttpClient, inputOrigin: string, suppliedHeaders: Record<string, string>): Promise<ByseFingerprint> {
  let key: SigningKey | undefined;
  try {
    const origin = originUrl(inputOrigin);
    const headers = requestHeaders(suppliedHeaders, origin);
    key = await signingKey(globalThis as Runtime);
    const challengeEndpoint = origin + '/api/videos/access/challenge';
    const challenge = checkedJson(await http.request(challengeEndpoint, { method: 'POST', headers, redirect: 'manual' }), challengeEndpoint);
    const challengeId = opaque(challenge.challenge_id, 512);
    if (typeof challenge.nonce !== 'string' || !challenge.nonce || challenge.nonce.length > 8192) return invalid();
    const nonce = challenge.nonce;
    const signature = await key.sign(utf8(nonce));
    const publicKey = key.publicKey;
    key.destroy();
    key = undefined;
    const body = {
      viewer_id: '', device_id: '', challenge_id: challengeId, nonce, signature: base64url(signature), public_key: publicKey,
      client: clientAttributes(headers['User-Agent']!), storage: {}, attributes: { entropy: 'low' },
    };
    const endpoint = origin + '/api/videos/access/attest';
    const result = checkedJson(await http.request(endpoint, { method: 'POST', redirect: 'manual',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), endpoint);
    if (typeof result.confidence !== 'number' || !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) return invalid();
    return { token: opaque(result.token, 32768), viewer_id: opaque(result.viewer_id, 1024),
      device_id: opaque(result.device_id, 1024), confidence: result.confidence };
  } catch (error) { throw error instanceof ProviderError ? error : new ProviderError('request_failed'); }
  finally { key?.destroy(); }
}
