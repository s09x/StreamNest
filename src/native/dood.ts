import { load } from 'cheerio/slim';
import { domText } from './dom-text.js';
import { ProviderError } from './errors.js';
import { responseText } from './metadata.js';
import { resolveUrl } from './url.js';
import { httpUrl } from './voe.js';
import type { HttpClient, NativeStream } from './types.js';

// Matches the inspected native fetch bridge's complete default. The abbreviated
// Mozilla/5.0 value was challenged even over HTTP/2 in the live comparison.
export const DOOD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const MAX_PAGE_LENGTH = 1024 * 1024;
const RANDOM_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
interface DoodConfig { path: string; token: string }

function fileId(value: string): string | undefined {
  try {
    const url = resolveUrl(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.hash
      || !/^(?:www\.)?(?:vide0\.net|playmogo\.com|doodstream\.com|dood\.(?:to|yt|li))$/.test(url.hostname)) return undefined;
    return /^\/(?:e|d)\/([a-z0-9]{12})\/?$/.exec(url.pathname)?.[1]
      ?? /^\/w\/([A-Za-z0-9]{10})\/?$/.exec(url.pathname)?.[1];
  } catch { return undefined; }
}

export function isDoodUrl(value: string): boolean { return fileId(value) !== undefined; }

/** Read the published pass_md5/makePlay protocol without executing hoster scripts. */
export function extractDoodConfig(html: string): DoodConfig {
  if (html.length > MAX_PAGE_LENGTH) throw new ProviderError('response_incomplete');
  const $ = load(html);
  const configurations = new Map<string, DoodConfig>();
  for (const script of $('script:not([src])').toArray()) {
    const text = domText([script]);
    if (!/\bdsplayer\s*\.\s*src\s*\(\s*\{\s*type\s*:\s*(['"])video\/mp4\1\s*,\s*src\s*:\s*data\s*\+\s*makePlay\s*\(\s*\)/.test(text)) continue;
    const generators = /function\s+makePlay\s*\(\s*\)\s*\{([\s\S]{1,2000}?)\}/g;
    const paths = /\$\s*\.\s*get\s*\(\s*(['"])(\/pass_md5\/[A-Za-z0-9_-]{1,256}\/[A-Za-z0-9_-]{8,128})\1\s*,\s*function\s*\(\s*data\s*\)/g;
    const generator = generators.exec(text)?.[1];
    const path = paths.exec(text)?.[2];
    if (!generator || !path || generators.exec(text) || paths.exec(text)) throw new ProviderError('invalid_response');
    const token = /\breturn\s+[\w$]+\s*\+\s*(['"])\?token=([A-Za-z0-9_-]{8,128})&expiry=\1\s*\+\s*Date\.now\s*\(\s*\)\s*;?\s*$/.exec(generator)?.[2];
    if (!token || !path.endsWith('/' + token) || !generator.includes(RANDOM_ALPHABET)
      || !/\bMath\.random\s*\(\s*\)/.test(generator) || !/(?:\b10\s*>\s*[\w$]+|[\w$]+\s*<\s*10\b)/.test(generator)) {
      throw new ProviderError('invalid_response');
    }
    configurations.set(path, { path, token });
  }
  if (configurations.size > 1) throw new ProviderError('ambiguous_match');
  const config = configurations.values().next().value;
  if (!config) {
    if (/\b(?:cf-turnstile|g-recaptcha)\b|turnstile\.render\s*\(/i.test(html)) throw new ProviderError('source_blocked');
    throw new ProviderError('invalid_response');
  }
  return config;
}

export async function resolveDood(http: HttpClient, embedUrl: string, sourcePage: string, title: string,
  options: { includeUploadTitle?: boolean } = {}): Promise<NativeStream> {
  const expectedId = fileId(embedUrl);
  if (!expectedId) throw new ProviderError('invalid_response');
  // The public download route embeds the same file through /e/. Historical
  // /w/ links keep their own identity and must be checked as published.
  const source = resolveUrl(httpUrl(embedUrl));
  const requested = source.pathname.startsWith('/d/') ? source.origin + source.pathname.replace(/^\/d\//, '/e/') + source.search : source.href;
  const referer = httpUrl(sourcePage);
  // RELOAD asks the ordinary player to obtain fresh data. Retry that instruction once.
  for (let attempt = 0; attempt < 2; attempt++) {
    const opened = await http.request(requested, { headers: { 'User-Agent': DOOD_USER_AGENT, Referer: referer } });
    const html = responseText(opened);
    if (fileId(opened.url) !== expectedId) throw new ProviderError('invalid_response');
    const config = extractDoodConfig(html);
    const endpoint = httpUrl(config.path, opened.url);
    const headers = { 'User-Agent': DOOD_USER_AGENT, Referer: opened.url };
    const response = await http.request(endpoint, { headers });
    const prefix = responseText(response).trim();
    if (httpUrl(response.url) !== endpoint) throw new ProviderError('invalid_response');
    if (prefix === 'RELOAD') continue;
    if (prefix.length > 8000 || /\s/.test(prefix) || !/^https?:\/\//i.test(prefix)) throw new ProviderError('invalid_response');
    const media = resolveUrl(httpUrl(prefix));
    if (media.search || media.hash || isDoodUrl(prefix)) throw new ProviderError('invalid_response');
    // This suffix is the player's ordinary URL construction, not an authentication key.
    let suffix = '';
    for (let index = 0; index < 10; index++) suffix += RANDOM_ALPHABET.charAt(Math.floor(Math.random() * RANDOM_ALPHABET.length));
    const url = httpUrl(`${prefix}${suffix}?token=${config.token}&expiry=${Date.now()}`);
    let label = title;
    if (options.includeUploadTitle) {
      const upload = domText(load(html)('title').toArray()).replace(/\s*[-|]\s*DoodStream\s*$/i, '').trim();
      if (upload && upload !== title && upload.length <= 1000 && !/[\r\n\0]|https?:\/\//i.test(upload)) label += ` | Upload: ${upload}`;
    }
    return { url, title: `${label} • DoodStream`, headers };
  }
  throw new ProviderError('request_failed');
}
