import { resolveUrl } from './url.js';
import { load } from 'cheerio/slim';
import { ProviderError } from './errors.js';
import { objectValue, responseText } from './metadata.js';
import { normalizeDeclaredLanguage, resolveHlsMetadata } from './hls.js';
import { httpUrl } from './voe.js';
import type { HttpClient, NativeStream, NativeSubtitle } from './types.js';

const ORIGINS = new Set(['https://vidsonic.net', 'https://vixeo.io']);

export function isVixeoUrl(value: string): boolean {
  try {
    const url = resolveUrl(value);
    return ORIGINS.has(url.origin) && /^\/e\/[A-Za-z0-9]{8,32}\/?$/.test(url.pathname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function decodeBase64Json(value: string): unknown {
  if (!value || value.length > 256 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new ProviderError('invalid_response');
  try {
    const bytes = atob(value);
    let escaped = '';
    for (let index = 0; index < bytes.length; index++) escaped += `%${bytes.charCodeAt(index).toString(16).padStart(2, '0')}`;
    return JSON.parse(decodeURIComponent(escaped));
  } catch { throw new ProviderError('invalid_response'); }
}

export function decodeVixeoSource(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 * 1024) throw new ProviderError('invalid_response');
  const hex = value.replace(/\|/g, '');
  if (!hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new ProviderError('invalid_response');
  let reversed = '';
  for (let index = hex.length - 2; index >= 0; index -= 2) reversed += `%${hex.slice(index, index + 2)}`;
  try { return httpUrl(decodeURIComponent(reversed)); }
  catch { throw new ProviderError('invalid_response'); }
}

function captionTracks(value: unknown, embedUrl: string, headers: Record<string, string>): NativeSubtitle[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProviderError('invalid_response');
  if (value.length > 64) throw new ProviderError('response_incomplete');
  const tracks: NativeSubtitle[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const row = objectValue(entry);
    if (!row || typeof row.path !== 'string' || !row.path.trim() || typeof row.lang !== 'string' || !row.lang.trim()) {
      throw new ProviderError('invalid_response');
    }
    const url = httpUrl(row.path, embedUrl);
    const language = normalizeDeclaredLanguage(row.lang);
    const key = `${url}\n${language}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tracks.push({ url, language, name: typeof row.label === 'string' && row.label.trim() ? row.label.trim() : row.lang.trim(), headers: { ...headers } });
  }
  return tracks;
}

/** Support both observed Vixeo player layouts using their data, never their SDK code. */
export async function resolveVixeo(http: HttpClient, embedUrl: string, sourcePage: string, titleHint?: string): Promise<NativeStream> {
  if (!isVixeoUrl(embedUrl)) throw new ProviderError('invalid_response');
  const requestedId = resolveUrl(embedUrl).pathname.split('/').filter(Boolean).pop()!;
  const response = await http.request(embedUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: httpUrl(sourcePage) } });
  if (!isVixeoUrl(response.url) || resolveUrl(response.url).pathname.split('/').filter(Boolean).pop() !== requestedId) {
    throw new ProviderError('invalid_response');
  }
  const $ = load(responseText(response));
  let encoded: unknown;
  let isMp4: boolean;
  let subtitles: unknown;
  let suppliedTitle: unknown;
  const configAttribute = $('#streamsonic-player-root').attr('data-config');
  if (configAttribute) {
    const config = objectValue(decodeBase64Json(configAttribute));
    if (!config || config.videoId !== requestedId || typeof config.isMp4 !== 'boolean') throw new ProviderError('invalid_response');
    encoded = config.source; isMp4 = config.isMp4; subtitles = config.subtitles; suppliedTitle = config.title;
  } else {
    const swarmAttribute = $('#vsConfig').attr('data-vs');
    const swarm = swarmAttribute ? objectValue(decodeBase64Json(swarmAttribute)) : null;
    if (!swarm || swarm.v !== requestedId) throw new ProviderError('invalid_response');
    const loaders = $('script:not([src])').toArray().map(element => $(element).text())
      .filter(text => /\b_videoUrl\s*=\s*_decode\(\s*_0x1\s*\)/.test(text));
    if (loaders.length !== 1) throw new ProviderError('invalid_response');
    const loader = loaders[0]!;
    encoded = /\b(?:const|let|var)\s+_0x1\s*=\s*(['"])([0-9a-f|]+)\1/i.exec(loader)?.[2];
    const format = /\b(?:const|let|var)\s+isMp4\s*=\s*(true|false)\b/.exec(loader);
    if (!format) throw new ProviderError('invalid_response');
    isMp4 = format[1] === 'true';
    try { subtitles = JSON.parse($('#video-player').attr('data-subtitles') ?? '[]'); }
    catch { throw new ProviderError('invalid_response'); }
    suppliedTitle = $('title').first().text().trim();
  }
  const url = decodeVixeoSource(encoded);
  const headers = { 'User-Agent': 'Mozilla/5.0', Referer: response.url, Origin: resolveUrl(response.url).origin };
  const tracks = captionTracks(subtitles, response.url, headers);
  const technical = isMp4 ? { details: [] as string[], quality: undefined, language: undefined }
    : await resolveHlsMetadata(http, url, headers);
  const title = titleHint?.trim() || (typeof suppliedTitle === 'string' && suppliedTitle.trim() && suppliedTitle.length <= 1000
    && !/https?:\/\//i.test(suppliedTitle) ? suppliedTitle.trim() : 'Vixeo');
  return { url, title: [title, ...technical.details].join(' | '), headers,
    ...(technical.quality ? { quality: technical.quality } : {}),
    ...(technical.language ? { language: technical.language } : {}), ...(tracks.length ? { subtitles: tracks } : {}) };
}
