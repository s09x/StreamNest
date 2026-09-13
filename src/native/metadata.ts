import { load } from 'cheerio/slim';
import { ProviderError } from './errors.js';
import type { ContentRequest, HttpClient, Identity, MediaType, MetadataProvider, TextResponse } from './types.js';

const CINEMETA = 'https://v3-cinemeta.strem.io';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MAX_CACHE = 128;
const MAX_CANDIDATES = 5;

export function normalizeTitle(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[\u2018\u2019\u201c\u201d'"`]/g, '')
    .replace(/[\s\u2010-\u2015:;,.!?()[\]{}\-_/]+/g, ' ').trim();
}

export function responseText(response: TextResponse): string {
  if (response.header('cf-mitigated') === 'challenge'
    || /<title[^>]*>\s*(?:Just a moment|Attention Required)/i.test(response.text)) {
    throw new ProviderError('source_blocked');
  }
  if (response.status < 200 || response.status >= 300) throw new ProviderError('request_failed');
  if (!response.text.trim() || /\.\.\.\[truncated\]\s*$/.test(response.text)) throw new ProviderError('response_incomplete');
  if (/<html\b/i.test(response.text) && !/<\/html\s*>/i.test(response.text)) throw new ProviderError('response_incomplete');
  return response.text;
}

export function jsonResponse(response: TextResponse): unknown {
  const text = responseText(response);
  try { return JSON.parse(text); }
  catch { throw new ProviderError(/^[\[{]/.test(text.trim()) ? 'response_incomplete' : 'invalid_response'); }
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function yearValue(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const match = /^(\d{4})(?:\D|$)/.exec(String(value).trim());
  return match && Number(match[1]) >= 1800 && Number(match[1]) <= 2999 ? Number(match[1]) : undefined;
}

function titleValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 500 ? value.trim() : undefined;
}

function uniqueTitles(titles: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  return titles.filter((title): title is string => {
    if (!title) return false;
    const key = normalizeTitle(title);
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function numericId(value: unknown): string | undefined {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  return /^[1-9]\d*$/.test(text) ? text : undefined;
}

function publicIds(request: ContentRequest): { tmdbId?: string; imdbId?: string } {
  if (request.type !== 'movie' && request.type !== 'tv') throw new ProviderError('invalid_request');
  const raw = request.id.trim().replace(/^tmdb[:/]/, '');
  const fromIdTmdb = numericId(raw);
  const fromIdImdb = /^tt\d+$/.test(raw) ? raw : undefined;
  if (request.tmdbId !== undefined && !numericId(request.tmdbId)) throw new ProviderError('invalid_request');
  if (request.imdbId !== undefined && !/^tt\d+$/.test(request.imdbId)) throw new ProviderError('invalid_request');
  if (fromIdTmdb && request.tmdbId && fromIdTmdb !== request.tmdbId) throw new ProviderError('invalid_request');
  if (fromIdImdb && request.imdbId && fromIdImdb !== request.imdbId) throw new ProviderError('invalid_request');
  return { tmdbId: request.tmdbId ?? fromIdTmdb, imdbId: request.imdbId ?? fromIdImdb };
}

function cloneIdentity(identity: Identity): Identity {
  return { ...identity, aliases: [...identity.aliases] };
}

export function createMetadataProvider(http: HttpClient): MetadataProvider {
  const cache = new Map<string, { identity: Identity; expires: number }>();

  async function tmdbPage(type: MediaType, id: string, locale: string): Promise<Identity> {
    const response = await http.request(`https://www.themoviedb.org/${type}/${id}?language=${locale}`);
    const $ = load(responseText(response));
    const canonical = $('link[rel="canonical"]').attr('href');
    let canonicalUrl: URL;
    try { canonicalUrl = new URL(canonical ?? '', response.url); }
    catch { throw new ProviderError('invalid_response'); }
    if (!canonical || !/^(?:www\.)?themoviedb\.org$/i.test(canonicalUrl.hostname)
      || !(new RegExp(`^/${type}/${id}(?:-|$)`)).test(canonicalUrl.pathname)) {
      throw new ProviderError('invalid_response');
    }
    const heading = $('div.title > h2').first();
    const title = titleValue(heading.find('a').first().text());
    const year = yearValue(heading.find('span.tag.release_date').text().replace(/[()]/g, ''));
    if (!title || year === undefined) throw new ProviderError('invalid_response');
    const aliases = [title];
    $('p').each((_, paragraph) => {
      const label = $(paragraph).find('strong').first().text().trim();
      if (/^(Original Title|Original Name|Originaltitel|Originalname)$/i.test(label)) {
        const original = titleValue($(paragraph).clone().children('strong').remove().end().text());
        if (original) aliases.push(original);
      }
    });
    return { type, title, aliases: uniqueTitles(aliases), year, tmdbId: id };
  }

  async function cinemeta(type: MediaType, imdbId: string): Promise<Identity | null> {
    const kind = type === 'tv' ? 'series' : 'movie';
    const response = await http.request(`${CINEMETA}/meta/${kind}/${imdbId}.json`);
    if (response.status === 404) return null;
    const root = objectValue(jsonResponse(response));
    if (!root || !('meta' in root)) throw new ProviderError('invalid_response');
    if (root.meta === null) return null;
    const meta = objectValue(root.meta);
    const title = titleValue(meta?.name);
    if (!meta || !title || meta.type !== kind || meta.id !== imdbId
      || (meta.imdb_id !== undefined && meta.imdb_id !== imdbId)) throw new ProviderError('invalid_response');
    return { type, title, aliases: [title], year: yearValue(meta.releaseInfo) ?? yearValue(meta.year),
      imdbId, tmdbId: numericId(meta.moviedb_id) };
  }

  async function candidates(page: Identity): Promise<Identity[]> {
    const kind = page.type === 'tv' ? 'series' : 'movie';
    const data = objectValue(await http.json(`${CINEMETA}/catalog/${kind}/top/search=${encodeURIComponent(page.title)}.json`));
    if (!data || !Array.isArray(data.metas)) throw new ProviderError('invalid_response');
    const ids = new Set<string>();
    for (const value of data.metas) {
      const row = objectValue(value);
      if (!row) throw new ProviderError('invalid_response');
      if (typeof row.name !== 'string' || normalizeTitle(row.name) !== normalizeTitle(page.title)) continue;
      if (row.type !== undefined && row.type !== kind) continue;
      const year = yearValue(row.releaseInfo) ?? yearValue(row.year);
      if (year !== undefined && year !== page.year) continue;
      const id = row.imdb_id ?? row.id;
      if (typeof id === 'string' && /^tt\d+$/.test(id)) ids.add(id);
    }
    if (ids.size > MAX_CANDIDATES) throw new ProviderError('ambiguous_match');
    const matches: Identity[] = [];
    for (const id of ids) {
      const identity = await cinemeta(page.type, id);
      if (identity && identity.tmdbId === page.tmdbId) {
        if (identity.year !== undefined && identity.year !== page.year) throw new ProviderError('ambiguous_match');
        matches.push(identity);
      }
    }
    if (matches.length > 1) throw new ProviderError('ambiguous_match');
    return matches;
  }

  return {
    async resolve(request) {
      const ids = publicIds(request);
      if (!ids.imdbId && !ids.tmdbId) return null;
      const key = `${request.type}:${ids.tmdbId ?? ''}:${ids.imdbId ?? ''}`;
      const cached = cache.get(key);
      if (cached && cached.expires > Date.now()) {
        cache.delete(key); cache.set(key, cached); return cloneIdentity(cached.identity);
      }
      cache.delete(key);
      let identity: Identity | null;
      if (ids.imdbId) {
        identity = await cinemeta(request.type, ids.imdbId);
        if (!identity) return null;
        if (ids.tmdbId && identity.tmdbId !== ids.tmdbId) throw new ProviderError('invalid_request');
        if (identity.tmdbId) {
          // German aliases are needed even when Nuvio originally supplied IMDb.
          const german = await tmdbPage(request.type, identity.tmdbId, 'de-DE');
          if (identity.year !== undefined && identity.year !== german.year) throw new ProviderError('ambiguous_match');
          identity = { ...identity, title: german.title, year: german.year,
            aliases: uniqueTitles([...german.aliases, ...identity.aliases]) };
        }
      } else {
        const german = await tmdbPage(request.type, ids.tmdbId!, 'de-DE');
        const matches = await candidates(german);
        let additional: Identity | undefined;
        if (!matches.length) {
          additional = await tmdbPage(request.type, ids.tmdbId!, 'en-US');
          if (additional.year !== german.year) throw new ProviderError('ambiguous_match');
          if (normalizeTitle(additional.title) !== normalizeTitle(german.title)) matches.push(...await candidates(additional));
        }
        const matched = matches[0];
        identity = { ...german, imdbId: matched?.imdbId,
          aliases: uniqueTitles([...german.aliases, ...(additional?.aliases ?? []), ...(matched?.aliases ?? [])]) };
      }
      cache.set(key, { identity: cloneIdentity(identity), expires: Date.now() + CACHE_TTL });
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
      return cloneIdentity(identity);
    },
  };
}
