import { load } from 'cheerio/slim';
import { ProviderError } from './errors.js';
import { resolveHlsMetadata } from './hls.js';
import { jsonResponse, objectValue, responseText } from './metadata.js';
import { httpUrl } from './voe.js';
import type { HttpClient, NativeStream, NativeSubtitle } from './types.js';

function fileId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !/^(?:www\.)?firestream\.(?:to|site)$/i.test(url.hostname)
      || url.port || url.username || url.password) return undefined;
    return /^\/(?:e|v)\/([A-Za-z0-9_-]{6,64})\/?$/.exec(url.pathname)?.[1];
  } catch { return undefined; }
}

export function isFirestreamUrl(value: string): boolean {
  return fileId(value) !== undefined;
}

function shortText(value: unknown, maximum = 1000): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= maximum && !/[\r\n\0]/.test(value)
    ? value.trim() : undefined;
}

function language(value: string): string {
  const code = value.trim().toLowerCase();
  const names: Record<string, string> = {
    german: 'de', deutsch: 'de', ger: 'de', deu: 'de', english: 'en', eng: 'en',
    french: 'fr', fra: 'fr', spanish: 'es', spa: 'es', italian: 'it', ita: 'it',
  };
  return names[code] ?? code;
}

function mediaUrl(value: unknown, base?: string): string {
  const input = shortText(value, 16_000);
  if (!input) throw new ProviderError('invalid_response');
  const result = httpUrl(input, base);
  if (new URL(result).protocol !== 'https:') throw new ProviderError('invalid_response');
  return result;
}

function sourceSubtitles(value: unknown, page: string, headers: Record<string, string>): NativeSubtitle[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ProviderError('invalid_response');
  if (value.length > 64) throw new ProviderError('response_incomplete');
  const result: NativeSubtitle[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = objectValue(raw);
    // Like the public player, ignore absent URL entries rather than inventing
    // sidecars from language/default flags or embedded-track descriptions.
    if (!item || !shortText(item.url, 16_000)) continue;
    const url = mediaUrl(item.url, page);
    const code = language(shortText(item.language, 50) ?? 'und');
    const key = `${url}\n${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ url, language: code, name: shortText(item.label), headers: { ...headers } });
  }
  return result;
}

/** Resolve the normal public token-blob API; no player scripts or telemetry run. */
export async function resolveFirestream(http: HttpClient, embedUrl: string, sourcePage: string, titleHint?: string): Promise<NativeStream> {
  try {
    const id = fileId(embedUrl);
    if (!id) throw new ProviderError('invalid_response');
    const referrer = httpUrl(sourcePage);
    const session = http.session();
    const page = await session.request(embedUrl, { headers: { Referer: referrer } });
    const html = responseText(page);
    if (fileId(page.url) !== id) throw new ProviderError('invalid_response');
    const location = new URL(page.url);
    if (location.protocol !== 'https:') throw new ProviderError('invalid_response');
    const $ = load(html);
    const dataNodes = $('script#video-data[type="application/json"]');
    if (dataNodes.length !== 1) throw new ProviderError('invalid_response');
    const source = dataNodes.text();
    if (!source || source.length > 262_144) throw new ProviderError('response_incomplete');
    let decoded: unknown;
    try { decoded = JSON.parse(source); }
    catch { throw new ProviderError('invalid_response'); }
    const data = objectValue(decoded);
    const video = objectValue(data?.video);
    if (!video) throw new ProviderError('request_failed');
    if (video.slug !== undefined && video.slug !== id) throw new ProviderError('invalid_response');
    const owner = objectValue(video.user);
    if (video.isVpn === true && owner?.blockVpn) throw new ProviderError('source_blocked');

    // HLS assets are not ready until encoding and any transfer have completed.
    // Do not poll encoding status or fabricate a path to the original upload.
    if (video.encodingStatus !== 'completed'
      || (video.transferStatus && video.transferStatus !== 'completed')) throw new ProviderError('request_failed');
    const headers = { 'User-Agent': 'Mozilla/5.0', Referer: page.url, Origin: location.origin };
    let hd = video.signedVideoUrl;
    let sd = video.signedVideoSdUrl;
    if (!shortText(hd, 16_000)) {
      const blobNodes = $('script#token-blob');
      if (blobNodes.length !== 1) throw new ProviderError('invalid_response');
      const blob = shortText(blobNodes.text().trim(), 16_384);
      if (!blob) throw new ProviderError('invalid_response');
      const endpoint = `${location.origin}/api/videos/${encodeURIComponent(id)}/resolve`;
      const response = await session.request(endpoint, { method: 'POST', headers: {
        ...headers, Accept: 'application/json', 'Content-Type': 'application/json',
      }, body: JSON.stringify({ blob }) });
      if (response.url !== endpoint) throw new ProviderError('invalid_response');
      const resolved = objectValue(jsonResponse(response));
      if (!resolved) throw new ProviderError('invalid_response');
      hd = resolved.signedVideoUrl;
      sd = resolved.signedVideoSdUrl;
    }
    const subtitles = sourceSubtitles(video.subtitles, page.url, headers);
    const rawTitle = shortText(titleHint) ?? shortText(video.title);
    const baseTitle = rawTitle && !/https?:\/\//i.test(rawTitle) ? rawTitle : 'FireStream';
    const candidates = [hd, sd].filter((value): value is string => typeof value === 'string' && !!value.trim());
    if (!candidates.length) throw new ProviderError('request_failed');
    let failure: unknown;
    const seen = new Set<string>();
    for (const candidate of candidates) {
      try {
        const url = mediaUrl(candidate);
        if (seen.has(url)) continue;
        seen.add(url);
        const pathname = new URL(url).pathname;
        const isHls = /\.m3u8$/i.test(pathname);
        if (!isHls && !/\.(?:mp4|mkv|webm|m4v|ogg|mov|avi)$/i.test(pathname)) throw new ProviderError('invalid_response');
        const technical = isHls ? await resolveHlsMetadata(session, url, headers) : { details: [] };
        const title = [baseTitle, 'FireStream', ...technical.details].join(' | ');
        // fileSize/mimeType describe the original upload, not necessarily the
        // transcoded HLS representation. They are intentionally not advertised.
        return { url, title, name: title, headers,
          ...('quality' in technical && technical.quality ? { quality: technical.quality } : {}),
          ...('language' in technical && technical.language ? { language: technical.language } : {}),
          ...(subtitles.length ? { subtitles } : {}) };
      } catch (error) { failure = error; }
    }
    throw failure instanceof ProviderError ? failure : new ProviderError('request_failed');
  } catch (error) { throw error instanceof ProviderError ? error : new ProviderError('request_failed'); }
}
