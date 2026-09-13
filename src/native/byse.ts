import { AES } from '@stablelib/aes';
import { GCM } from '@stablelib/gcm';
import { createByseFingerprint, type ByseFingerprint } from './byse-fingerprint.js';
import { ProviderError } from './errors.js';
import { resolveHlsMetadata } from './hls.js';
import { resolveUrl } from './url.js';
import type { HttpClient, NativeStream, NativeSubtitle, RequestOptions } from './types.js';

const USER_AGENT = 'Mozilla/5.0';
const MAX_PROOF_MS = 20_000;
const MAX_PROOF_ATTEMPTS = 1_048_576;
const MAX_CIPHER_CHARS = 384_000;
const MAX_SOURCES = 32;
const MAX_TRACKS = 64;
const BYSE_HOSTS = new Set(['bysezejataos.com']);
const multiply32 = Math.imul;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function invalid(): never { throw new ProviderError('invalid_response'); }
function blocked(): never { throw new ProviderError('source_blocked'); }

function flag(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0) return false;
  if (value === true || value === 1) return true;
  return invalid();
}

function urlValue(value: unknown, base?: string): URL {
  if (typeof value !== 'string' || value.length > 16_000 || /[\r\n\0\\]/.test(value)) return invalid();
  const input = value.trim();
  const authority = /^(?:https?:)?\/\/([^/?#]*)/i.exec(input)?.[1];
  if (authority && (authority.includes('@') || /%40/i.test(authority))) return invalid();
  try {
    const url = resolveUrl(input, base);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return invalid();
    return url;
  } catch { return invalid(); }
}

function videoCode(url: URL): string {
  const parts = url.pathname.split('/').filter(Boolean);
  const code = parts[1];
  if (!code || !/^[a-zA-Z0-9]{8,40}$/.test(code)) return invalid();
  return code;
}

function isAliasFrame(url: URL): boolean {
  const prefix = url.pathname.split('/').filter(Boolean)[0] ?? '';
  return /^[a-z0-9]{3,5}$/i.test(prefix) && !['d', 'download', 'dwn', 'e'].includes(prefix);
}

export function isByseUrl(value: string): boolean {
  try {
    const url = urlValue(value);
    const host = url.hostname.toLowerCase();
    return BYSE_HOSTS.has(host)
      && /^\/(?:d|e)\/[a-zA-Z0-9]{8,40}(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

function rotate(value: number, count: number): number { return (value << count | value >>> (32 - count)) >>> 0; }

function quarterRound(state: Uint32Array): void {
  state[0] = state[0]! + state[1]! >>> 0;
  state[3] = rotate(state[3]! ^ state[0]!, 16);
  state[2] = state[2]! + state[3]! >>> 0;
  state[1] = rotate(state[1]! ^ state[2]!, 12);
  state[0] = state[0]! + state[1]! >>> 0;
  state[3] = rotate(state[3]! ^ state[0]!, 8);
  state[2] = state[2]! + state[3]! >>> 0;
  state[1] = rotate(state[1]! ^ state[2]!, 7);
}

function proofHashInto(input: string, memory: number[], result: Uint32Array, initial?: Uint32Array): Uint32Array {
  let a = (initial ? initial[0]! : 1779033703) | 0;
  let b = (initial ? initial[1]! : 3144134277) | 0;
  let c = (initial ? initial[2]! : 1013904242) | 0;
  let d = (initial ? initial[3]! : 2773480762) | 0;
  // Signed intermediates have identical modulo-2^32 semantics and avoid boxing
  // unsigned values in QuickJS. Inline rounds avoid millions of VM calls.
  for (let index = 0; index < input.length; index++) {
    a = a + (input.charCodeAt(index) & 255) | 0; a = a << 7 | a >>> 25;
    a = a + b | 0; d ^= a; d = d << 16 | d >>> 16;
    c = c + d | 0; b ^= c; b = b << 12 | b >>> 20;
    a = a + b | 0; d ^= a; d = d << 8 | d >>> 24;
    c = c + d | 0; b ^= c; b = b << 7 | b >>> 25;
  }
  for (let count = 0; count < 8; count++) {
    a = a + b | 0; d ^= a; d = d << 16 | d >>> 16;
    c = c + d | 0; b ^= c; b = b << 12 | b >>> 20;
    a = a + b | 0; d ^= a; d = d << 8 | d >>> 24;
    c = c + d | 0; b ^= c; b = b << 7 | b >>> 25;
  }
  for (let index = 0; index < 512; index++) {
    a = a + b | 0; d ^= a; d = d << 16 | d >>> 16;
    c = c + d | 0; b ^= c; b = b << 12 | b >>> 20;
    a = a + b | 0; d ^= a; d = d << 8 | d >>> 24;
    c = c + d | 0; b ^= c; b = b << 7 | b >>> 25;
    memory[index] = a ^ c;
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let index = 0; index < 512; index++) {
      const other = memory[index]! & 511;
      let value = memory[index]! + memory[other]! | 0;
      value = value << 13 | value >>> 19;
      value ^= multiply32(memory[(index + 1) & 511]!, -1640531535); // 2654435761 modulo 2^32
      memory[index] = value;
      a ^= value;
      a = a + b | 0; d ^= a; d = d << 16 | d >>> 16;
      c = c + d | 0; b ^= c; b = b << 12 | b >>> 20;
      a = a + b | 0; d ^= a; d = d << 8 | d >>> 24;
      c = c + d | 0; b ^= c; b = b << 7 | b >>> 25;
    }
  }
  for (let block = 0; block < result.length; block++) {
    a = a + b | 0; d ^= a; d = d << 16 | d >>> 16;
    c = c + d | 0; b ^= c; b = b << 12 | b >>> 20;
    a = a + b | 0; d ^= a; d = d << 8 | d >>> 24;
    c = c + d | 0; b ^= c; b = b << 7 | b >>> 25;
    let value = a;
    for (let offset = 0; offset < 64; offset++) {
      const word = memory[block * 64 + offset]!;
      value = value + word | 0;
      value = value << 5 | value >>> 27;
      value ^= multiply32(word, -2048144777); // 2246822519 modulo 2^32
    }
    result[block] = (value ^ c) >>> 0;
  }
  return result;
}

/** Data-only reconstruction of the 512-word proof published in pow-DEJGtdh2.js. */
export function byseProofHash(input: string): Uint32Array {
  if (typeof input !== 'string' || input.length > 2048) return invalid();
  return proofHashInto(input, new Array<number>(512).fill(0), new Uint32Array(8));
}

function leadingZeroBits(words: Uint32Array): number {
  let count = 0;
  for (let index = 0; index < words.length; index++) {
    if (words[index] === 0) count += 32;
    else return count + Math.clz32(words[index]!);
  }
  return count;
}

export async function solveByseProof(
  nonce: string,
  difficulty: number,
  limits: { timeoutMs?: number; maxAttempts?: number } = {},
): Promise<string | null> {
  const timeout = limits.timeoutMs ?? MAX_PROOF_MS;
  const attempts = limits.maxAttempts ?? MAX_PROOF_ATTEMPTS;
  if (typeof nonce !== 'string' || !nonce || nonce.length > 1024 || !Number.isInteger(difficulty)
    || difficulty < 0 || difficulty > 256 || !Number.isFinite(timeout) || timeout < 0 || timeout > MAX_PROOF_MS
    || !Number.isSafeInteger(attempts) || attempts < 0 || attempts > MAX_PROOF_ATTEMPTS) return invalid();
  const deadline = Date.now() + timeout;
  const initial = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  const prefix = nonce + ':';
  for (let index = 0; index < prefix.length; index++) {
    initial[0] = rotate(initial[0]! + (prefix.charCodeAt(index) & 255) >>> 0, 7);
    quarterRound(initial);
  }
  const memory = new Array<number>(512).fill(0);
  // Later output words cannot affect earlier ones. Compute only the words
  // needed to establish the requested leading-zero prefix.
  const result = new Uint32Array(Math.max(1, Math.ceil(difficulty / 32)));
  for (let counter = 0; counter < attempts; counter++) {
    if ((counter & 31) === 0 && Date.now() >= deadline) return null;
    if (leadingZeroBits(proofHashInto(String(counter), memory, result, initial)) >= difficulty) return String(counter);
    if ((counter & 255) === 255) {
      // Hermes exposes timers; native QuickJS may only expose the Promise queue.
      if (typeof globalThis.setTimeout === 'function') await new Promise<void>(resolve => globalThis.setTimeout(resolve, 0));
      else await Promise.resolve();
    }
  }
  return null;
}

function base64Bytes(value: unknown, maximum = MAX_CIPHER_CHARS): Uint8Array {
  if (typeof value !== 'string' || !value || value.length > maximum
    || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value) || value.length % 4 === 1
    || (value.includes('=') && value.length % 4 !== 0)) return invalid();
  const text = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const output = new Uint8Array(Math.floor(text.length * 6 / 8));
  let buffer = 0; let bits = 0; let cursor = 0;
  for (let index = 0; index < text.length; index++) {
    buffer = buffer << 6 | alphabet.indexOf(text[index]!);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[cursor++] = buffer >>> bits & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  return output;
}

function utf8(bytes: Uint8Array): string {
  const hex = '0123456789abcdef';
  let encoded = '';
  for (const byte of bytes) encoded += '%' + hex[byte >>> 4] + hex[byte & 15];
  try { return decodeURIComponent(encoded); } catch { return invalid(); }
}

/** Authenticate the source-provided AES-GCM envelope before parsing its data. */
export function decodeBysePlayback(value: unknown): Record<string, unknown> {
  const envelope = record(value);
  if (!envelope || !Array.isArray(envelope.key_parts) || !envelope.key_parts.length
    || envelope.key_parts.length > 64 || envelope.key_parts.some(part => typeof part !== 'string' || part.length > 1024)) return invalid();
  let selected = envelope.key_parts as string[];
  const version = typeof envelope.version === 'string' ? envelope.version.trim() : String(envelope.version ?? '');
  if (/^(?:[1-9]|1[0-9]|20)$/.test(version)) {
    const first = Number(version); const second = 31 - first;
    if (first <= selected.length && second <= selected.length) {
      const chosen = [selected[first - 1], selected[second - 1]].filter((part): part is string => typeof part === 'string' && !!part);
      if (chosen.length) selected = chosen;
    }
  }
  const pieces = selected.filter(Boolean).map(part => base64Bytes(part, 1024));
  const length = pieces.reduce((total, part) => total + part.length, 0);
  if (![16, 24, 32].includes(length)) return invalid();
  const key = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) { key.set(piece, offset); offset += piece.length; piece.fill(0); }
  const iv = base64Bytes(envelope.iv, 64);
  const ciphertext = base64Bytes(envelope.payload);
  if (iv.length !== 12 || ciphertext.length < 16) { key.fill(0); return invalid(); }
  let cipher: AES | undefined; let gcm: GCM | undefined; let plaintext: Uint8Array | null = null;
  try {
    cipher = new AES(key);
    gcm = new GCM(cipher);
    plaintext = gcm.open(iv, ciphertext);
    if (!plaintext) return invalid();
    const result = record(JSON.parse(utf8(plaintext)));
    if (!result) return invalid();
    return result;
  } catch { return invalid(); }
  finally {
    plaintext?.fill(0); key.fill(0); iv.fill(0); ciphertext.fill(0);
    gcm?.clean(); cipher?.clean();
  }
}

interface View { url: URL; code: string; mode: 'watch' | 'embed'; parent?: string }
interface OriginContext { session: HttpClient; fingerprint?: Promise<ByseFingerprint> }
const contexts = new WeakMap<HttpClient, Map<string, OriginContext>>();

function originContext(http: HttpClient, origin: string): OriginContext {
  let origins = contexts.get(http);
  if (!origins) { origins = new Map(); contexts.set(http, origins); }
  let context = origins.get(origin);
  if (!context) { context = { session: http.session() }; origins.set(origin, context); }
  return context;
}

function fingerprintFor(context: OriginContext, view: View): Promise<ByseFingerprint> {
  if (context.fingerprint) return context.fingerprint;
  // The public client attests the origin, not a video. Share its promise and
  // cookie session only within this lookup; each file keeps its own proof token.
  const flight = createByseFingerprint(context.session, view.url.origin, requestHeaders(view)).catch(error => {
    if (context.fingerprint === flight) delete context.fingerprint;
    throw error;
  });
  context.fingerprint = flight;
  return flight;
}

function requestHeaders(view: View): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Referer: view.url.href, Origin: view.url.origin };
  // Filmo opens the watch page with noreferrer. The watch-to-frame message then
  // supplies only its own URL; no fictitious outer referrer or fingerprint exists.
  if (view.mode === 'embed' && view.parent) headers['X-Embed-Parent'] = view.parent;
  return headers;
}

async function api(http: HttpClient, view: View, operation: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
  const path = `/api/videos/${encodeURIComponent(view.code)}/${view.mode === 'embed' ? 'embed/' : ''}${operation}`;
  const response = await http.request(view.url.origin + path, {
    ...options, headers: { ...requestHeaders(view), ...options.headers },
  });
  if ([401, 403, 429].includes(response.status)) return blocked();
  if (response.status < 200 || response.status >= 300) throw new ProviderError('request_failed');
  if (urlValue(response.url).origin !== view.url.origin) return invalid();
  if (!response.text.trim() || /\.\.\.\[truncated\]\s*$/.test(response.text)) throw new ProviderError('response_incomplete');
  try {
    const result = record(JSON.parse(response.text));
    if (!result) return invalid();
    return result;
  } catch { return invalid(); }
}

async function proofToken(http: HttpClient, view: View, fingerprint: ByseFingerprint): Promise<string> {
  const challenge = await api(http, view, 'captcha', {
    method: 'POST', body: JSON.stringify({ fingerprint }), headers: { 'Content-Type': 'application/json' },
  });
  const nonce = challenge.pow_nonce; const token = challenge.pow_token;
  const difficulty = challenge.pow_difficulty; const expires = challenge.expires_in;
  if (typeof nonce !== 'string' || !nonce || nonce.length > 1024 || typeof token !== 'string' || !token || token.length > 16_000
    || !Number.isInteger(difficulty) || typeof difficulty !== 'number' || difficulty < 0 || difficulty > 24
    || typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 3) return blocked();
  const solution = await solveByseProof(nonce, difficulty, { timeoutMs: Math.min(MAX_PROOF_MS, (expires - 3) * 1000) });
  if (solution === null) return blocked();
  const verified = await api(http, view, 'captcha/verify', {
    method: 'POST', body: JSON.stringify({ pow_token: token, solution, fingerprint }), headers: { 'Content-Type': 'application/json' },
  });
  if (verified.status !== 'ok' || typeof verified.token !== 'string' || !verified.token || verified.token.length > 16_000
    || /[\r\n]/.test(verified.token)) return blocked();
  return verified.token;
}

function subtitleLanguage(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return 'und';
  const normalized = value.trim().toLowerCase().replace(/_/g, '-');
  const aliases: Record<string, string> = { german: 'de', deutsch: 'de', ger: 'de', deu: 'de',
    english: 'en', eng: 'en', french: 'fr', fra: 'fr', fre: 'fr', spanish: 'es', spa: 'es', italian: 'it', ita: 'it' };
  const [first, ...rest] = normalized.split('-');
  return [aliases[first!] ?? first, ...rest].join('-');
}

async function mediaStream(http: HttpClient, data: Record<string, unknown>, view: View, title: string): Promise<NativeStream> {
  if (!Array.isArray(data.sources) || !data.sources.length || data.sources.length > MAX_SOURCES) return invalid();
  const sources = data.sources.map(value => {
    const source = record(value);
    if (!source || typeof source.url !== 'string') return invalid();
    const url = urlValue(source.url, view.url.href);
    return { source, url, hls: /mpegurl|hls/i.test(String(source.mime_type ?? '')) || /\.m3u8$/i.test(url.pathname) };
  });
  // An adaptive master retains its renditions and tracks. Otherwise use the
  // highest explicitly supplied height, without guessing from a download label.
  sources.sort((a, b) => Number(b.hls) - Number(a.hls)
    || (typeof b.source.height === 'number' ? b.source.height : 0) - (typeof a.source.height === 'number' ? a.source.height : 0));
  const chosen = sources[0]!;
  const headers = { 'User-Agent': USER_AGENT, Referer: view.url.href, Origin: view.url.origin };
  const rawTracks = data.tracks ?? [];
  if (!Array.isArray(rawTracks) || rawTracks.length > MAX_TRACKS) return invalid();
  const subtitles: NativeSubtitle[] = [];
  const seen = new Set<string>();
  for (const rawTrack of rawTracks) {
    const track = record(rawTrack);
    if (!track) return invalid();
    if (track.kind !== undefined && track.kind !== 'captions' && track.kind !== 'subtitles') continue;
    if (typeof track.url !== 'string') return invalid();
    const url = urlValue(track.url, view.url.href).href;
    const language = subtitleLanguage(track.language);
    const key = url + '\n' + language;
    if (seen.has(key)) continue;
    seen.add(key);
    subtitles.push({ url, language, name: typeof track.title === 'string' ? track.title : undefined, headers });
  }
  const height = chosen.source.height;
  const standardHeights = [4320, 2160, 1440, 1080, 720, 576, 480, 360, 240, 144];
  let quality = typeof height === 'number' && standardHeights.includes(height) ? `${height}p` : undefined;
  let language: string | undefined;
  if (chosen.hls) {
    const metadata = await resolveHlsMetadata(http, chosen.url.href, headers);
    quality = metadata.quality;
    language = metadata.language;
    if (metadata.details.length) title += ' • ' + metadata.details.join(' • ');
  }
  const size = chosen.source.size_bytes;
  return { url: chosen.url.href, title, quality, language,
    size: !chosen.hls && typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? `${(size / 1024 ** 3).toFixed(2)} GiB` : undefined,
    headers, subtitles };
}

export async function resolveByse(http: HttpClient, embedUrl: string, sourcePage: string, titleHint?: string): Promise<NativeStream> {
  if (!isByseUrl(embedUrl)) return invalid();
  urlValue(sourcePage);
  const initial = urlValue(embedUrl);
  let view: View = { url: initial, code: videoCode(initial), mode: initial.pathname.startsWith('/e/') ? 'embed' : 'watch' };
  const preferredTitle = titleHint?.trim();
  let title = preferredTitle || 'Byse';
  const visited = new Set<string>();
  for (let hop = 0; hop < 4; hop++) {
    if (visited.has(view.url.href)) return invalid();
    visited.add(view.url.href);
    const context = originContext(http, view.url.origin);
    const session = context.session;
    const details = await api(session, view, 'details');
    const settings = await api(session, view, 'settings');
    if (details.code !== view.code || settings.code !== view.code || typeof details.title !== 'string' || !details.title.trim()) return invalid();
    if (flag(details.owner_private) || flag(settings.premium_only)) return blocked();
    title = preferredTitle || details.title.trim();
    // Watch and ordinary /e/ pages can delegate to an alias iframe. The public
    // embed component plays directly on that alias route, even when its details
    // mint another embed_frame_url; recursively following those aliases loops.
    const terminalAlias = view.mode === 'embed' && isAliasFrame(view.url);
    const frame = !terminalAlias && typeof details.embed_frame_url === 'string' && details.embed_frame_url.trim()
      ? urlValue(details.embed_frame_url, view.url.href) : undefined;
    if (frame && frame.href !== view.url.href) {
      if (videoCode(frame) !== view.code) return invalid();
      const parent = view.parent ?? view.url.href;
      view = { url: frame, code: view.code, mode: 'embed', parent };
      continue;
    }
    const requiresProof = flag(settings.captcha_required);
    const fingerprint = await fingerprintFor(context, view);
    const token = requiresProof ? await proofToken(session, view, fingerprint) : undefined;
    const playback = await api(session, view, 'playback', {
      method: 'POST', body: JSON.stringify({ fingerprint }),
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Captcha-Token': token } : {}) },
    });
    return mediaStream(session, decodeBysePlayback(playback.playback), view, title);
  }
  return invalid();
}
