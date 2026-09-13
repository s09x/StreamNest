import { ProviderError } from './errors.js';
import { isDoodUrl, resolveDood } from './dood.js';
import { jsonResponse, normalizeTitle, objectValue, yearValue } from './metadata.js';
import { httpUrl } from './voe.js';
import type { ContentRequest, HttpClient, Identity, MetadataProvider, NativeStream, RequestOptions } from './types.js';

const ORIGIN = 'https://einschalten.in';
const MAX_TITLES = 4;
const MAX_PAGES = 4;
const MAX_DETAILS = 8;
interface Movie { id: string; title: string; year: number; imdbId?: string }

function numericId(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? text : undefined;
}

function shortText(value: unknown, limit = 500): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= limit && !/[\r\n\0]/.test(value) ? value.trim() : undefined;
}

function movieRecord(value: unknown): Movie {
  const row = objectValue(value);
  const id = numericId(row?.id);
  const title = shortText(row?.title);
  const year = yearValue(row?.releaseDate);
  if (!row || !id || !title || year === undefined) throw new ProviderError('invalid_response');
  let imdbId: string | undefined;
  if (row.imdbId !== undefined && row.imdbId !== null && row.imdbId !== '') {
    if (typeof row.imdbId !== 'string' || !/^tt\d+$/.test(row.imdbId) || row.imdbId.length > 32) throw new ProviderError('invalid_response');
    imdbId = row.imdbId;
  }
  return { id, title, year, imdbId };
}

export function createEinschaltenProvider(http: HttpClient, metadata: MetadataProvider) {
  async function api(path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = ORIGIN + path;
    const response = await http.request(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
    if (httpUrl(response.url) !== url) throw new ProviderError('invalid_response');
    if (response.status === 404) return undefined;
    if (response.text.length > 1024 * 1024) throw new ProviderError('response_incomplete');
    return jsonResponse(response);
  }

  async function detail(id: string): Promise<Movie | null> {
    const value = await api(`/api/movies/${id}`);
    if (value === undefined) return null;
    const movie = movieRecord(value);
    if (movie.id !== id) throw new ProviderError('invalid_response');
    return movie;
  }

  async function search(identity: Identity, imdbId: string): Promise<Movie | null> {
    const aliases = new Map<string, string>();
    for (const value of [identity.title, ...identity.aliases]) {
      const title = shortText(value);
      const normalized = title && normalizeTitle(title);
      if (!normalized) throw new ProviderError('invalid_response');
      if (!aliases.has(normalized)) aliases.set(normalized, title!);
    }
    if (aliases.size > MAX_TITLES) throw new ProviderError('ambiguous_match');
    const candidates = new Set<string>();
    for (const title of aliases.values()) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const root = objectValue(await api('/api/search', { method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Referer: ORIGIN + '/' },
          body: JSON.stringify({ query: title, pageNumber: page }) }));
        const pagination = objectValue(root?.pagination);
        if (!root || !Array.isArray(root.data) || !pagination || typeof pagination.hasMore !== 'boolean'
          || pagination.currentPage !== page) throw new ProviderError('invalid_response');
        if (root.data.length > 100) throw new ProviderError('response_incomplete');
        for (const value of root.data) {
          const row = movieRecord(value);
          if (aliases.has(normalizeTitle(row.title)) && (identity.year === undefined || row.year === identity.year)) candidates.add(row.id);
        }
        if (candidates.size > MAX_DETAILS) throw new ProviderError('ambiguous_match');
        if (!pagination.hasMore) break;
        if (page === MAX_PAGES || root.data.length === 0) throw new ProviderError('response_incomplete');
      }
    }
    const matches: Movie[] = [];
    for (const id of candidates) {
      const movie = await detail(id);
      // A matching title is only a candidate. The detail IMDb ID must confirm it.
      if (movie && movie.imdbId === imdbId) matches.push(movie);
    }
    if (matches.length > 1) throw new ProviderError('ambiguous_match');
    return matches[0] ?? null;
  }

  return async function getStreams(request: ContentRequest): Promise<NativeStream[]> {
    if (request.type !== 'movie') return [];
    let movie: Movie | null;
    if (request.tmdbId) {
      const id = numericId(request.tmdbId);
      if (!id) throw new ProviderError('invalid_request');
      // Movie IDs are TMDB IDs, so numeric requests need no external metadata lookup.
      movie = await detail(id);
    } else {
      if (!request.imdbId || !/^tt\d+$/.test(request.imdbId) || request.imdbId.length > 32) throw new ProviderError('invalid_request');
      const identity = await metadata.resolve(request);
      if (!identity) return [];
      if (identity.type !== 'movie' || identity.imdbId !== request.imdbId) throw new ProviderError('invalid_response');
      if (identity.tmdbId !== undefined) {
        const id = numericId(identity.tmdbId);
        if (!id) throw new ProviderError('invalid_response');
        movie = await detail(id);
      } else movie = await search(identity, request.imdbId);
    }
    if (!movie || (request.imdbId && movie.imdbId !== request.imdbId)) return [];
    const watch = await api(`/api/movies/${movie.id}/watch`);
    if (watch === undefined) return [];
    const data = objectValue(watch);
    const embedUrl = shortText(data?.streamUrl, 16000);
    if (!data || !embedUrl || !isDoodUrl(embedUrl)) throw new ProviderError('invalid_response');
    const release = data.releaseName == null ? undefined : shortText(data.releaseName, 1500);
    if (data.releaseName != null && !release) throw new ProviderError('invalid_response');
    const stream = await resolveDood(http, embedUrl, `${ORIGIN}/movies/${movie.id}`, movie.title);
    const languages: string[] = [];
    if (/\b(?:German|Deutsch|GER|DEU)\b/i.test(release ?? '')) languages.push('de');
    if (/\b(?:English|Englisch|ENG)\b/i.test(release ?? '')) languages.push('en');
    // DoodStream can transcode uploads. Do not infer quality/codecs or a second language from "DL".
    return [{ ...stream, ...(languages.length ? { language: languages.join(' / ') } : {}) }];
  };
}
