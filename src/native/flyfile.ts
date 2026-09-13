import { resolveUrl } from './url.js';
import { ProviderError } from './errors.js';
import { resolveHlsMetadata } from './hls.js';
import { jsonResponse, objectValue } from './metadata.js';
import { httpUrl } from './voe.js';
import type { HttpClient, NativeStream, NativeSubtitle } from './types.js';

const ORIGIN = 'https://flyfile.app';
const API = 'https://api.flyfile.app/api';

export function isFlyfileUrl(input: string): boolean {
  try {
    const url = resolveUrl(input);
    return url.origin === ORIGIN && /^\/(?:v|e|embed)\/[A-Za-z0-9_-]{6,128}\/?$/.test(url.pathname)
      && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

function text(value: unknown, maximum = 500): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= maximum && !/[\r\n\0]/.test(value)
    ? value.trim() : undefined;
}

function language(value: unknown): string | undefined {
  const code = text(value, 50)?.toLowerCase();
  if (!code) return undefined;
  return ({ ger: 'de', deu: 'de', german: 'de', deutsch: 'de', eng: 'en', english: 'en',
    fra: 'fr', fre: 'fr', french: 'fr', spa: 'es', ita: 'it' } as Record<string, string>)[code] ?? code;
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw new ProviderError('invalid_response'); }
  }
  if (!Array.isArray(parsed)) throw new ProviderError('invalid_response');
  if (parsed.length > 64) throw new ProviderError('response_incomplete');
  return parsed;
}

function sidecars(value: unknown, embed: string, headers: Record<string, string>): NativeSubtitle[] {
  const result: NativeSubtitle[] = [];
  const seen = new Set<string>();
  for (const entry of list(value)) {
    const row = objectValue(entry);
    const rawUrl = text(row?.url, 16000);
    if (!row || !rawUrl) throw new ProviderError('invalid_response');
    const url = httpUrl(rawUrl, embed);
    if (resolveUrl(url).protocol !== 'https:') throw new ProviderError('invalid_response');
    const code = language(row.lang) ?? 'und';
    const key = `${url}\n${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = text(row.label);
    result.push({ url, language: code, ...(name ? { name } : {}), headers: { ...headers } });
  }
  return result;
}

/** Uses the same public metadata and assignment endpoints as FlyFile's player. */
export async function resolveFlyfile(http: HttpClient, embedUrl: string, sourcePage: string, titleHint?: string): Promise<NativeStream> {
  httpUrl(sourcePage);
  let embed = embedUrl;
  const seen = new Set<string>();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isFlyfileUrl(embed) || seen.has(embed)) throw new ProviderError('invalid_response');
    seen.add(embed);
    const filecode = resolveUrl(embed).pathname.split('/').filter(Boolean).pop()!;
    const headers = { 'User-Agent': 'Mozilla/5.0', Referer: embed, Origin: ORIGIN, 'x-flyfile-host': 'flyfile.app' };
    const endpoint = `${API}/public/file/${filecode}`;
    const metadataResponse = await http.request(endpoint, { headers });
    if (metadataResponse.url !== endpoint) throw new ProviderError('invalid_response');
    const data = objectValue(jsonResponse(metadataResponse));
    if (!data) throw new ProviderError('invalid_response');
    if (data.contentRedirect) {
      if (typeof data.contentRedirect !== 'string') throw new ProviderError('invalid_response');
      embed = httpUrl(data.contentRedirect, embed);
      continue;
    }
    // The API's id is an internal identifier; token is the public link's identity.
    if (data.token !== filecode || !text(data.id) || !text(data.name)) throw new ProviderError('invalid_response');
    const asset = objectValue(data.videoAsset);
    const qualities = list(asset?.qualities);
    let hasHls = false;
    for (const value of qualities) {
      const row = objectValue(value);
      if (!row) throw new ProviderError('invalid_response');
      if (row.status === 'READY') hasHls = true;
    }
    if (!hasHls && (typeof data.mimeType !== 'string' || !data.mimeType.startsWith('video/'))) {
      throw new ProviderError('invalid_response');
    }
    const assignmentUrl = `${API}/streaming/assign/${filecode}`;
    const assignmentResponse = await http.request(assignmentUrl, { headers });
    if (assignmentResponse.url !== assignmentUrl) throw new ProviderError('invalid_response');
    const assignment = objectValue(jsonResponse(assignmentResponse));
    const base = text(assignment?.url, 16000);
    const token = text(assignment?.token, 1024);
    if (!base || !token || !/^[A-Za-z0-9._~-]+$/.test(token)) throw new ProviderError('invalid_response');
    const target = resolveUrl(httpUrl(base));
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.flyfile.app') || target.search || target.hash) {
      throw new ProviderError('invalid_response');
    }
    const url = `${target.href.replace(/\/+$/, '')}/${hasHls ? `hls/${encodeURIComponent(token)}/master.m3u8` : `raw/${encodeURIComponent(token)}`}`;
    const technical = hasHls ? await resolveHlsMetadata(http, url, headers) : { details: [] };
    const declaredAudio = new Set<string>();
    for (const value of list(asset?.audioTracks)) {
      const row = objectValue(value);
      if (!row) throw new ProviderError('invalid_response');
      const code = language(row.lang);
      if (code) declaredAudio.add(code);
    }
    const subtitles = sidecars(asset?.subtitles, embed, headers);
    // Nuvio badge rules also inspect title text. An original upload's filename
    // can advertise 1080p even when the delivered adaptive stream is only 720p.
    const title = text(titleHint) ?? (hasHls ? 'FlyFile' : text(data.name) ?? 'FlyFile');
    const audio = technical.language ?? (declaredAudio.size ? [...declaredAudio].join(' / ') : undefined);
    return { url, title: [title, ...technical.details].join(' | '), headers,
      ...(technical.quality ? { quality: technical.quality } : {}),
      ...(audio ? { language: audio } : {}),
      ...(subtitles.length ? { subtitles } : {}) };
  }
  throw new ProviderError('invalid_response');
}
