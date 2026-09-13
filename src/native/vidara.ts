import { ProviderError } from './errors.js';
import { jsonResponse, objectValue } from './metadata.js';
import { normalizeDeclaredLanguage, resolveHlsMetadata } from './hls.js';
import { httpUrl } from './voe.js';
import type { HttpClient, NativeStream, NativeSubtitle } from './types.js';

const ORIGINS = new Set(['https://odysseusa.cc', 'https://vidaraa.cc']);

export function isVidaraUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ORIGINS.has(url.origin) && /^\/e\/[A-Za-z0-9]{8,32}\/?$/.test(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

function mediaUrl(value: unknown, base?: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ProviderError('invalid_response');
  const url = httpUrl(value.trim(), base);
  if (new URL(url).protocol !== 'https:') throw new ProviderError('invalid_response');
  return url;
}

function shortText(value: unknown, limit = 500): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= limit && !/[\r\n\0]/.test(value)
    ? value.trim() : undefined;
}

export function parsePlayerApiSubtitles(value: unknown, embedUrl: string, headers: Record<string, string>): NativeSubtitle[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProviderError('invalid_response');
  if (value.length > 64) throw new ProviderError('response_incomplete');
  const result: NativeSubtitle[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = objectValue(raw);
    if (!item) throw new ProviderError('invalid_response');
    // The public player renders type 0 as captions; other types are not sidecars.
    if (item.type !== 0) continue;
    const url = mediaUrl(item.file_path, embedUrl);
    const label = shortText(item.language);
    const key = `${url}\n${label ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ url, language: label ? normalizeDeclaredLanguage(label) : 'und', ...(label ? { name: label } : {}), headers: { ...headers } });
  }
  return result;
}

/** The observed player reads /api/stream JSON directly; telemetry crypto is unrelated. */
export async function resolveVidara(http: HttpClient, embedUrl: string, sourcePage: string, titleHint?: string): Promise<NativeStream> {
  if (!isVidaraUrl(embedUrl)) throw new ProviderError('invalid_response');
  const embed = new URL(embedUrl);
  const filecode = embed.pathname.split('/').filter(Boolean).pop()!;
  const endpoint = `${embed.origin}/api/stream`;
  const headers = { 'User-Agent': 'Mozilla/5.0', Referer: embed.href, Origin: embed.origin };
  // No cookie jar is used: these are public file identifiers, not account tokens.
  httpUrl(sourcePage);
  const response = await http.request(endpoint, { method: 'POST', headers: {
    ...headers, Accept: 'application/json', 'Content-Type': 'application/json',
  }, body: JSON.stringify({ filecode, device: 'web' }) });
  if (response.url !== endpoint) throw new ProviderError('invalid_response');
  const data = objectValue(jsonResponse(response));
  if (!data || data.filecode !== filecode) throw new ProviderError('invalid_response');
  const url = mediaUrl(data.streaming_url);
  const sourceSubtitles = parsePlayerApiSubtitles(data.subtitles, embed.href, headers);
  // Inspect only the manifest. Preserve its full adaptive variant/audio graph;
  // never fetch segments, initialization maps, or keys while finding streams.
  const technical = await resolveHlsMetadata(http, url, headers);
  const sourceTitle = shortText(data.title);
  const title = shortText(titleHint) ?? (sourceTitle && !/https?:\/\//i.test(sourceTitle) ? sourceTitle : 'Vidara');
  return { url, title: [title, ...technical.details].join(' | '), headers,
    ...(technical.quality ? { quality: technical.quality } : {}),
    ...(technical.language ? { language: technical.language } : {}),
    ...(sourceSubtitles.length ? { subtitles: sourceSubtitles } : {}) };
}
