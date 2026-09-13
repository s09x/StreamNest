import { ProviderError } from './errors.js';
import { normalizeDeclaredLanguage, resolveHlsMetadata } from './hls.js';
import { jsonResponse, objectValue } from './metadata.js';
import { parseRequest } from './request.js';
import { resolveUrl } from './url.js';
import { httpUrl, isVoeUrl, resolveVoe } from './voe.js';
import { isVixeoUrl, resolveVixeo } from './vixeo.js';
import type { ContentRequest, HttpClient, NativeStream } from './types.js';

const ORIGIN = 'https://huhu.to';
const MAX_RESPONSE_LENGTH = 1024 * 1024;
const MAX_SOURCE_ROWS = 256;
const MAX_MIRRORS = 32;
interface Mirror { url: string; provider: 'voe' | 'vixeo'; languages: string[]; tags: string[] }

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 1000
    && !/[\r\n\0]/.test(value) && !/https?:\/\//i.test(value) ? value.trim() : undefined;
}

function numericId(value: unknown): string | undefined {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1)) return undefined;
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return /^[1-9]\d*$/.test(text) ? text : undefined;
}

async function api(http: HttpClient, operation: 'item' | 'source', body: Record<string, unknown>): Promise<unknown> {
  const url = `${ORIGIN}/mediaurl-${operation}.json`;
  const response = await http.request(url, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ language: 'de', region: 'DE', ...body }),
  });
  if (response.url !== url) throw new ProviderError('invalid_response');
  if (response.text.length > MAX_RESPONSE_LENGTH) throw new ProviderError('response_incomplete');
  const data = jsonResponse(response);
  if (objectValue(data)?.error) throw new ProviderError('request_failed');
  return data;
}

function sourceMirrors(data: unknown): { mirrors: Mirror[]; failure?: ProviderError } {
  if (!Array.isArray(data)) throw new ProviderError('invalid_response');
  if (data.length > MAX_SOURCE_ROWS) throw new ProviderError('response_incomplete');
  const mirrors = new Map<string, Mirror>();
  let failure: ProviderError | undefined;
  for (const value of data) {
    try {
      const row = objectValue(value);
      if (!row || typeof row.type !== 'string') throw new ProviderError('invalid_response');
      if (row.type !== 'url') continue;
      if (typeof row.url !== 'string') throw new ProviderError('invalid_response');
      const url = httpUrl(row.url);
      const provider = isVoeUrl(url) ? 'voe' : isVixeoUrl(url) ? 'vixeo' : null;
      if (!provider) continue;
      const address = resolveUrl(url);
      if (address.hash) throw new ProviderError('invalid_response');
      // VOE's watch and embed paths identify the same file. Keep query values
      // and case-sensitive file codes intact, including on the Vixeo aliases.
      const path = provider === 'voe' ? address.pathname.replace(/^\/e\//, '/') : address.pathname;
      const key = `${address.origin}${path.replace(/\/$/, '')}${address.search}`;
      const mirror = mirrors.get(key) ?? { url, provider, languages: [], tags: [] };
      if (Array.isArray(row.languages)) {
        for (const value of row.languages.slice(0, 32)) {
          const language = typeof value === 'string' && value.length <= 100 ? normalizeDeclaredLanguage(value) : '';
          if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language) && !mirror.languages.includes(language)) mirror.languages.push(language);
        }
      }
      const tag = textValue(row.tag);
      if (tag && !mirror.tags.includes(tag)) mirror.tags.push(tag);
      mirrors.set(key, mirror);
    } catch (error) {
      failure ??= error instanceof ProviderError ? error : new ProviderError('invalid_response');
    }
  }
  if (mirrors.size > MAX_MIRRORS) throw new ProviderError('response_incomplete');
  return { mirrors: [...mirrors.values()], failure };
}

async function resolveMirror(http: HttpClient, mirror: Mirror, title: string): Promise<NativeStream> {
  let stream = mirror.provider === 'voe' ? await resolveVoe(http, mirror.url, `${ORIGIN}/`)
    : await resolveVixeo(http, mirror.url, `${ORIGIN}/`, title);
  const details: string[] = [];
  if (mirror.provider === 'voe' && /\.m3u8$/i.test(resolveUrl(stream.url).pathname)) {
    const technical = await resolveHlsMetadata(http, stream.url, stream.headers ?? {});
    details.push(...technical.details);
    // Huhu's VOE upload labels can advertise 1080p while the delivered master
    // is 720p. An absent manifest resolution must not revive the upload tier.
    stream = { ...stream, quality: technical.quality, language: technical.language ?? stream.language };
  }
  const hoster = mirror.provider === 'voe' ? 'VOE' : 'Vixeo';
  const label = stream.title && stream.title !== 'VOE' ? stream.title : title;
  return { ...stream, name: `Huhu • ${hoster}`, title: `${[label, ...mirror.tags, ...details].join(' | ')} • ${hoster}`,
    language: stream.language ?? (mirror.languages.length ? mirror.languages.join(' / ') : undefined) };
}

export async function getHuhuStreams(http: HttpClient, input: ContentRequest): Promise<NativeStream[]> {
  const request = parseRequest(input.id, input.type, input.season, input.episode);
  if ((input.tmdbId !== undefined && (!numericId(input.tmdbId) || (request.tmdbId && request.tmdbId !== input.tmdbId)))
    || (input.imdbId !== undefined && (!/^tt\d+$/.test(input.imdbId) || (request.imdbId && request.imdbId !== input.imdbId)))) {
    throw new ProviderError('invalid_request');
  }
  const tmdbId = input.tmdbId ?? request.tmdbId;
  const imdbId = input.imdbId ?? request.imdbId;
  const type = request.type === 'tv' ? 'series' : 'movie';
  const ids = { ...(tmdbId ? { tmdb_id: tmdbId } : {}), ...(imdbId ? { imdb_id: imdbId } : {}) };
  const item = objectValue(await api(http, 'item', { type, ids, name: '' }));
  const returnedIds = objectValue(item?.ids);
  if (!item || item.type !== type || !returnedIds
    || (tmdbId && numericId(returnedIds.tmdb_id) !== tmdbId) || (imdbId && returnedIds.imdb_id !== imdbId)) {
    throw new ProviderError('invalid_response');
  }
  // Unknown IDs return a successful placeholder with an empty name and echoed
  // IDs. They are not a catalog match and must not start hoster discovery.
  if (item.name === '' && item.releaseDate === undefined && item.episodes === undefined) return [];
  const title = textValue(item.name);
  const matchedId = numericId(returnedIds.tmdb_id);
  if (!title || !matchedId) throw new ProviderError('invalid_response');
  let label = title;
  if (request.type === 'tv') {
    if (!Array.isArray(item.episodes)) throw new ProviderError('invalid_response');
    const matches = item.episodes.filter(value => {
      const row = objectValue(value);
      if (!row || row.type !== 'episode' || !Number.isSafeInteger(row.season) || (row.season as number) < 0
        || !Number.isSafeInteger(row.episode) || (row.episode as number) < 0) throw new ProviderError('invalid_response');
      return row.season === request.season && row.episode === request.episode;
    });
    // The top-level item.episode merely echoes the caller, even for S99E01.
    if (!matches.length) return [];
    if (matches.length > 1) throw new ProviderError('ambiguous_match');
    label += ` S${String(request.season).padStart(2, '0')}E${String(request.episode).padStart(2, '0')}`;
  }
  const data = await api(http, 'source', { type, ids: { tmdb_id: matchedId }, name: '',
    ...(request.type === 'tv' ? { episode: { ids: {}, season: request.season, episode: request.episode } } : {}) });
  const selected = sourceMirrors(data);
  const results: Array<NativeStream | ProviderError> = new Array(selected.mirrors.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < selected.mirrors.length) {
      const index = next++;
      try { results[index] = await resolveMirror(http, selected.mirrors[index]!, label); }
      catch (error) { results[index] = error instanceof ProviderError ? error : new ProviderError('request_failed'); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, selected.mirrors.length) }, () => worker()));
  const streams: NativeStream[] = [];
  const seen = new Set<string>();
  let failure = selected.failure;
  for (const result of results) {
    if (result instanceof ProviderError) { failure ??= result; continue; }
    if (!seen.has(result.url)) { seen.add(result.url); streams.push(result); }
  }
  if (!streams.length && failure) throw failure;
  return streams;
}
