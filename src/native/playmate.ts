import { resolveUrl } from './url.js';
import { ProviderError } from './errors.js';
import { jsonResponse, objectValue } from './metadata.js';
import { resolveHlsMetadata } from './hls.js';
import { httpUrl } from './voe.js';
import { parsePlayerApiSubtitles } from './vidara.js';
import type { HttpClient, NativeStream } from './types.js';

export function isPlaymateUrl(value: string): boolean {
  try {
    const url = resolveUrl(value);
    return url.origin === 'https://playmate.to' && /^\/(?:watch|embed)\/[A-Za-z0-9]{8,32}\/?$/.test(url.pathname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Implements the public /api/s mapping declared by player-core.min.js. */
export async function resolvePlaymate(http: HttpClient, link: string, sourcePage: string, titleHint?: string): Promise<NativeStream> {
  if (!isPlaymateUrl(link)) throw new ProviderError('invalid_response');
  httpUrl(sourcePage);
  const filecode = resolveUrl(link).pathname.split('/').filter(Boolean).pop()!;
  const embedUrl = `https://playmate.to/embed/${filecode}`;
  const endpoint = 'https://playmate.to/api/s';
  const headers = { 'User-Agent': 'Mozilla/5.0', Referer: embedUrl, Origin: 'https://playmate.to' };
  const response = await http.request(endpoint, { method: 'POST', headers: {
    ...headers, 'Content-Type': 'application/json', Accept: 'application/json',
  }, body: JSON.stringify({ c: filecode, d: 'web' }) });
  if (response.url !== endpoint) throw new ProviderError('invalid_response');
  const data = objectValue(jsonResponse(response));
  if (!data || data.cx !== filecode || typeof data.sx !== 'string' || !data.sx.trim()) throw new ProviderError('invalid_response');
  const url = httpUrl(data.sx);
  if (resolveUrl(url).protocol !== 'https:') throw new ProviderError('invalid_response');
  if (data.kx !== undefined && !Array.isArray(data.kx)) throw new ProviderError('invalid_response');
  const rows = (data.kx as unknown[] | undefined ?? []).map(value => {
    const row = objectValue(value);
    if (!row) throw new ProviderError('invalid_response');
    return { type: row.sk, language: row.sl, file_path: row.sf };
  });
  const tracks = parsePlayerApiSubtitles(rows, embedUrl, headers);
  // A JSON success alone does not make a blocked or missing media URL playable.
  const technical = await resolveHlsMetadata(http, url, headers);
  const title = titleHint?.trim() || (typeof data.tx === 'string' && data.tx.trim() && data.tx.length <= 1000
    && !/https?:\/\//i.test(data.tx) ? data.tx.trim() : 'Playmate');
  return { url, title: [title, ...technical.details].join(' | '), headers,
    ...(technical.quality ? { quality: technical.quality } : {}),
    ...(technical.language ? { language: technical.language } : {}), ...(tracks.length ? { subtitles: tracks } : {}) };
}
