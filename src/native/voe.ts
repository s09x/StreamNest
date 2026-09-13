import { load } from 'cheerio/slim';
import { ProviderError } from './errors.js';
import { objectValue, responseText } from './metadata.js';
import { resolveUrl } from './url.js';
import type { HttpClient, NativeStream, NativeSubtitle, TextResponse } from './types.js';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MAX_ENCODED_LENGTH = 1_500_000;

/** Decode the public VOE data envelope without executing any player JavaScript. */
export function decodeVoePayload(encoded: string): Record<string, unknown> {
  if (!encoded || encoded.length > MAX_ENCODED_LENGTH) throw new Error('Invalid VOE payload');
  const rotated = encoded.replace(/[a-zA-Z]/g, (letter) => {
    const start = letter <= 'Z' ? 65 : 97;
    return String.fromCharCode(start + (letter.charCodeAt(0) - start + 13) % 26);
  });
  const first = decodeBase64(rotated.replace(/@\$|\^\^|~@|%\?|\*~|!!|#&/g, '_').replace(/_/g, ''));
  let inner = '';
  for (let index = first.length - 1; index >= 0; index--) {
    const code = first.charCodeAt(index) - 3;
    if (code < 0 || code > 127) throw new Error('Invalid VOE payload');
    inner += String.fromCharCode(code);
  }
  const bytes = decodeBase64(inner);
  let escaped = '';
  for (let index = 0; index < bytes.length; index++) {
    escaped += `%${bytes.charCodeAt(index).toString(16).padStart(2, '0')}`;
  }
  const value: unknown = JSON.parse(decodeURIComponent(escaped));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid VOE payload');
  return value as Record<string, unknown>;
}

function decodeBase64(encoded: string): string {
  const input = encoded.replace(/\s/g, '');
  if (!input || input.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)
    || input.length % 4 === 1 || (input.includes('=') && input.length % 4 !== 0)) {
    throw new Error('Invalid VOE payload');
  }
  const unpadded = input.replace(/=+$/, '');
  let bits = 0;
  let count = 0;
  let result = '';
  for (const letter of unpadded) {
    bits = (bits << 6) | BASE64.indexOf(letter);
    count += 6;
    if (count >= 8) {
      count -= 8;
      result += String.fromCharCode((bits >> count) & 255);
      bits &= (1 << count) - 1;
    }
  }
  if (bits !== 0) throw new Error('Invalid VOE payload');
  return result;
}

export function extractVoeConfig(html: string): Record<string, unknown> | null {
  const $ = load(html);
  for (const script of $('script[type="application/json"]').toArray()) {
    let parsed: unknown;
    try { parsed = JSON.parse($(script).text()); } catch { continue; }
    if (Array.isArray(parsed) && typeof parsed[0] === 'string') {
      return decodeVoePayload(parsed[0]);
    }
  }
  return null;
}

export function httpUrl(value: string, base?: string): string {
  try {
    const url = resolveUrl(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || value.length > 16_000 || /[\r\n]/.test(value)) throw new Error();
    return url.href;
  } catch { throw new ProviderError('invalid_response'); }
}

export function isVoeUrl(value: string): boolean {
  try {
    const url = resolveUrl(value);
    return /^(?:www\.)?voe\.sx$/i.test(url.hostname) && /^\/(?:e\/)?[a-z\d]{8,32}\/?$/i.test(url.pathname)
      && !url.username && !url.password && ['https:', 'http:'].includes(url.protocol);
  } catch { return false; }
}

function fileId(url: string): string | undefined {
  const path = resolveUrl(url).pathname;
  return /^\/(?:e\/)?([a-z\d]{8,32})\/?$/i.exec(path)?.[1]?.toLowerCase();
}

function declaredRedirect(html: string, currentUrl: string): string | null {
  const $ = load(html);
  const redirects = new Set<string>();
  $('script:not([src])').each((_, script) => {
    const text = $(script).text();
    const pattern = /(?:window\.)?location(?:\.href)?\s*=\s*(['"])(https?:\/\/[^'"\r\n]+)\1|(?:window\.)?location\.(?:replace|assign)\(\s*(['"])(https?:\/\/[^'"\r\n]+)\3\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const target = httpUrl(match[2] ?? match[4]!, currentUrl);
      if (fileId(target) && fileId(target) === fileId(currentUrl)) redirects.add(target);
    }
  });
  if (redirects.size > 1) throw new ProviderError('ambiguous_match');
  return redirects.values().next().value ?? null;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 1000 ? value.trim() : undefined;
}

function languageCode(value: string): string {
  const input = value.trim();
  const mapping: Record<string, string> = { german: 'de', deutsch: 'de', ger: 'de', deu: 'de', english: 'en', eng: 'en',
    french: 'fr', francais: 'fr', fra: 'fr', spanish: 'es', spa: 'es', italian: 'it', ita: 'it' };
  return mapping[input.toLowerCase()] ?? input.toLowerCase();
}

function audioLanguages(config: Record<string, unknown>): string | undefined {
  if (!Array.isArray(config.audio_languages)) return undefined;
  const languages = new Set<string>();
  for (const value of config.audio_languages.slice(0, 32)) {
    const item = objectValue(value);
    const language = typeof value === 'string' ? textValue(value)
      : textValue(item?.languageCode) ?? textValue(item?.language) ?? textValue(item?.countryCode);
    if (language) languages.add(languageCode(language));
  }
  return languages.size ? [...languages].join(' / ') : undefined;
}

function subtitles(config: Record<string, unknown>, playerUrl: string, headers: Record<string, string>): NativeSubtitle[] {
  if (config.captions === undefined || config.captions === null) return [];
  if (!Array.isArray(config.captions)) throw new ProviderError('invalid_response');
  if (config.captions.length > 64) throw new ProviderError('response_incomplete');
  const result: NativeSubtitle[] = [];
  const seen = new Set<string>();
  for (const value of config.captions) {
    const item = objectValue(value);
    if (!item) continue;
    const file = typeof item.file === 'string' ? item.file.trim() : undefined;
    const language = textValue(item.language);
    if (!file || !language || (item.kind !== undefined && !['captions', 'subtitles'].includes(String(item.kind)))) continue;
    const url = httpUrl(file, playerUrl);
    const name = textValue(item.label) ?? textValue(item.name);
    const key = `${url}\n${language}\n${name ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sourceHeaders = objectValue(item.headers);
    const captionHeaders = { ...headers };
    if (sourceHeaders) {
      for (const [header, headerValue] of Object.entries(sourceHeaders)) {
        if (/^[A-Za-z0-9-]+$/.test(header) && typeof headerValue === 'string' && !/[\r\n]/.test(headerValue)
          && !/^(?:host|connection|content-length|range)$/i.test(header)) captionHeaders[header] = headerValue;
      }
    }
    result.push({ url, language: languageCode(language), ...(name ? { name } : {}), headers: captionHeaders });
  }
  return result;
}

/** Return provider URLs only after the ordinary public redirect/data flow succeeds. */
export async function resolveVoe(http: HttpClient, embedUrl: string, sourcePage: string, initial?: TextResponse): Promise<NativeStream> {
  let current = httpUrl(embedUrl);
  if (!fileId(current)) throw new ProviderError('invalid_response');
  const seen = new Set<string>();
  for (let step = 0; step < 4; step++) {
    if (seen.has(current)) throw new ProviderError('invalid_response');
    seen.add(current);
    const response = step === 0 && initial ? initial : await http.request(current, { headers: {
      'User-Agent': 'Mozilla/5.0', Referer: step === 0 ? httpUrl(sourcePage) : current,
    } });
    current = httpUrl(response.url || current);
    const html = responseText(response);
    let config: Record<string, unknown> | null;
    try { config = extractVoeConfig(html); }
    catch { throw new ProviderError('invalid_response'); }
    if (!config) {
      const target = declaredRedirect(html, current);
      if (!target) throw new ProviderError('invalid_response');
      current = target; continue;
    }
    const source = typeof config.source === 'string' ? config.source.trim() : undefined;
    if (!source) throw new ProviderError('invalid_response');
    const url = httpUrl(source, current);
    const $ = load(html);
    const filename = textValue(config.title) ?? $('title').first().text().replace(/^Watch\s+/i, '').replace(/\s+-\s+VOE\b[\s\S]*$/i, '').trim();
    const title = filename && !/https?:\/\//i.test(filename) ? filename : 'VOE';
    const headers = { 'User-Agent': 'Mozilla/5.0', Referer: current, Origin: resolveUrl(current).origin };
    const captionList = subtitles(config, current, headers);
    const quality = /\b(2160p|1080p|720p|576p|480p)\b/i.exec(title)?.[1]?.toLowerCase();
    const language = audioLanguages(config);
    return { url, title, headers, ...(quality ? { quality } : {}), ...(language ? { language } : {}),
      ...(captionList.length ? { subtitles: captionList } : {}) };
  }
  throw new ProviderError('invalid_response');
}
