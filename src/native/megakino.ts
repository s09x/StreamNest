import { load } from 'cheerio/slim';
import { domText } from './dom-text.js';
import { ProviderError } from './errors.js';
import { isFirestreamUrl, resolveFirestream } from './firestream.js';
import { resolveHlsMetadata } from './hls.js';
import { normalizeTitle, responseText, yearValue } from './metadata.js';
import { resolveMirrors, type Mirror } from './mirrors.js';
import { resolveUrl } from './url.js';
import { httpUrl, isVoeUrl, resolveVoe } from './voe.js';
import type { ContentRequest, HttpClient, Identity, MetadataProvider, NativeStream } from './types.js';

const ORIGIN = 'https://7megakino.lol';
const SEARCH = `${ORIGIN}/index.php?do=search`;
const PAGE_SIZE = 10;
const MAX_SEARCH_PAGES = 10;
const MAX_DETAILS = 8;
const MAX_MIRRORS = 32;
interface PageMatch { url: string; title: string; mirrors: Mirror[] }

function detailUrl(value: string): { url: string; id: string } {
  const url = resolveUrl(httpUrl(value, `${ORIGIN}/`));
  const id = /^\/([1-9]\d*)-[^/]+\.html$/.exec(url.pathname)?.[1];
  if (url.origin !== ORIGIN || !id || url.search || url.hash) throw new ProviderError('invalid_response');
  return { url: url.href, id };
}

function aliases(identity: Identity, request: ContentRequest): string[] {
  if (identity.type !== request.type || yearValue(identity.year) !== identity.year || identity.year === undefined
    || (request.imdbId && identity.imdbId && request.imdbId !== identity.imdbId)
    || (request.tmdbId && identity.tmdbId && request.tmdbId !== identity.tmdbId)) throw new ProviderError('invalid_response');
  const titles = new Map<string, string>();
  for (const title of [identity.title, ...identity.aliases]) {
    const normalized = normalizeTitle(title);
    if (!normalized || title.length > 500) throw new ProviderError('invalid_response');
    if (!titles.has(normalized)) titles.set(normalized, title);
  }
  if (titles.size > 4) throw new ProviderError('ambiguous_match');
  return [...titles.values()];
}

function seasonTitle(value: string): { title: string; season?: number } {
  const match = /^(.*?)\s*[-–—]\s*Staffel\s+(\d{1,4})\s*$/i.exec(value.trim());
  return match ? { title: match[1]!.trim(), season: Number(match[2]) } : { title: value.trim() };
}

function titleMatches(value: string, titles: string[], request: ContentRequest): boolean {
  const parsed = seasonTitle(value);
  if (request.type === 'tv' ? parsed.season !== request.season : parsed.season !== undefined) return false;
  return titles.some(title => normalizeTitle(title) === normalizeTitle(parsed.title));
}

async function search(http: HttpClient, titles: string[], request: ContentRequest): Promise<string[]> {
  const candidates = new Map<string, string>();
  let completedQuery = false;
  for (const title of titles) {
    let total: number | undefined;
    let wholePhrase = false;
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const from = (page - 1) * PAGE_SIZE + 1;
      const response = await http.request(SEARCH, { method: 'POST', headers: {
        'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN, Referer: `${ORIGIN}/`,
      }, body: new URLSearchParams({ do: 'search', subaction: 'search', story: title, titleonly: '3',
        // DLE's default title search preserves numbered titles such as "Die 5. Welle".
        // Exact title, year and episode matching is performed on the returned articles.
        full_search: '1', showposts: '0', search_start: page === 1 ? '0' : String(page),
        result_from: String(from), ...(wholePhrase ? { all_word_seach: '1' } : {}) }).toString() });
      const $ = load(responseText(response));
      const main = $('#dle-content');
      const query = $('#fullsearch input[name="story"]');
      if (response.url !== SEARCH || main.length !== 1 || query.length !== 1 || query.attr('value') !== title) {
        throw new ProviderError('invalid_response');
      }
      const posters = main.find('a.poster[href]');
      const summary = domText(main.find('.message-info--yellow').toArray()).trim();
      const range = /^Filme\s+(\d+)\s+gefunden\s*\(Abfrageergebnisse\s+(\d+)\s*-\s*(\d+)\)\s*:$/i.exec(summary);
      if (!range) {
        const messages = $('.message-info__content').toArray().map(node => domText([node]).trim());
        if (page === 1 && !summary && !posters.length) {
          if (messages.some(text => /^Die Website-Suche ergab leider keine Ergebnisse\./.test(text))) {
            completedQuery = true; break;
          }
          if (messages.some(text => /^Suche ist ausgesetzt!\s+Die Suchzeichenfolge ist leer oder enthält weniger als 4 Zeichen\./.test(text))) {
            // A multiword original title can contain only short tokens. The
            // source's whole-phrase option permits one bounded retry for it.
            if (!wholePhrase) { wholePhrase = true; page--; continue; }
            break;
          }
        }
        throw new ProviderError('invalid_response');
      }
      const count = Number(range[1]); const start = Number(range[2]); const end = Number(range[3]);
      if (!Number.isSafeInteger(count) || count < 1 || count > PAGE_SIZE * MAX_SEARCH_PAGES
        || (total !== undefined && total !== count) || start !== from || end !== Math.min(from + PAGE_SIZE - 1, count)
        || posters.length !== end - start + 1) throw new ProviderError('response_incomplete');
      total = count;
      for (const poster of posters.toArray()) {
        const heading = $(poster).find('.poster__title');
        const label = domText(heading.toArray()).trim();
        if (heading.length !== 1 || !label || label.length > 500) throw new ProviderError('invalid_response');
        const link = detailUrl($(poster).attr('href')!);
        if (seen.has(link.id)) throw new ProviderError('response_incomplete');
        seen.add(link.id);
        if (titleMatches(label, titles, request)) candidates.set(link.id, link.url);
      }
      if (candidates.size > MAX_DETAILS) throw new ProviderError('ambiguous_match');
      if (end === count) { completedQuery = true; break; }
    }
  }
  if (!completedQuery) throw new ProviderError('request_failed');
  return [...candidates.values()];
}

function parsePage(html: string, url: string, titles: string[], identity: Identity, request: ContentRequest): PageMatch | null {
  const $ = load(html);
  const main = $('#dle-content article.pmovie');
  const header = main.find('header.page__subcol-main');
  const heading = header.children('h1,h2');
  const title = domText(heading.toArray()).trim();
  const yearText = domText(header.find('.pmovie__year').toArray());
  const yearPattern = /(?:^|,)\s*(\d{4})(?=\s*(?:,|$))/g;
  const declaredYears: Array<number | undefined> = [];
  let yearMatch: RegExpExecArray | null;
  while ((yearMatch = yearPattern.exec(yearText))) declaredYears.push(yearValue(yearMatch[1]));
  const genres = domText(header.find('.pmovie__genres').toArray()).split('/').map(value => value.trim());
  if (main.length !== 1 || header.length !== 1 || heading.length !== 1 || !title || title.length > 500
    || declaredYears.length !== 1 || declaredYears[0] === undefined || !genres.some(Boolean)) throw new ProviderError('invalid_response');
  // The site also returns trailer-only "coming soon" articles with the same title/year.
  if (genres.includes('Demnächst im kino')) return null;
  const series = genres.includes('Serien');
  if ((request.type === 'tv') !== series || (!series && !genres.some(genre => /^Kinofilme(?: im kino)?$/.test(genre)))
    || !titleMatches(title, titles, request) || declaredYears[0] !== identity.year) return null;
  const canonical = $('link[rel="canonical"]');
  if (canonical.length > 1) throw new ProviderError('invalid_response');
  const target = detailUrl(canonical.attr('href') ?? url);
  if (target.id !== detailUrl(url).id) throw new ProviderError('invalid_response');

  const player = main.find('.pplayer-holder');
  if (player.length !== 1) throw new ProviderError('invalid_response');
  // These IDs are published in the site's own player handoff. Treat conflicts
  // as a failed match even though the handoff itself is not an offered mirror.
  const imdbIds = new Set<string>();
  player.find('.tabs-block__select [data-link]').each((_, node) => {
    const match = /^https:\/\/meinecloud\.click\/movie\/(tt\d+)\/?$/.exec($(node).attr('data-link') ?? '');
    if (match) imdbIds.add(match[1]!);
  });
  player.find('script:not([src])').each((_, node) => {
    const text = domText([node]);
    if (!text.includes('https://meinecloud.click/serials.php') || !text.includes('mc-serial-iframe')) return;
    const pattern = /\bvar\s+imdb\s*=\s*(['"])(tt\d+)\1\.replace\(/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) imdbIds.add(match[2]!);
  });
  if (imdbIds.size > 1 || (identity.imdbId && [...imdbIds].some(id => id !== identity.imdbId))) return null;

  let links = player.find('.tabs-block__select [data-link]');
  if (series) {
    const rows = player.find('.ep-menu > li');
    if (rows.length > 1000) throw new ProviderError('response_incomplete');
    const episodes = new Set<number>();
    let selected: (typeof rows)[number] | undefined;
    for (const row of rows.toArray()) {
      // This is a list-local prefix, not the season: Fallout's S02 page also
      // publishes serie-1_1. The page heading establishes the requested season.
      const position = /^serie-1_(\d{1,4})$/.exec($(row).attr('id') ?? '');
      const label = /^Episoden?\s+(\d{1,4})$/i.exec(domText($(row).children('a').toArray()).trim());
      if (!position || !label || Number(position[1]) !== Number(label[1])) throw new ProviderError('invalid_response');
      const episode = Number(position[1]);
      if (episodes.has(episode)) throw new ProviderError('ambiguous_match');
      episodes.add(episode);
      if (episode === request.episode) selected = row;
    }
    if (!selected) return { url: target.url, title, mirrors: [] };
    links = $(selected).children('ul').find('a[data-link]');
    for (const link of links.toArray()) {
      const position = /-1_(\d{1,4})$/.exec($(link).attr('id') ?? '');
      if (!position || Number(position[1]) !== request.episode) throw new ProviderError('invalid_response');
    }
  }
  const mirrors = new Map<string, Mirror>();
  for (const link of links.toArray()) {
    let address: URL;
    try { address = resolveUrl(httpUrl($(link).attr('data-link') ?? '', target.url)); }
    catch { continue; }
    if (address.hash) continue;
    const provider = isVoeUrl(address.href) ? 'voe' : isFirestreamUrl(address.href) ? 'firestream' : null;
    if (!provider) continue;
    const path = provider === 'voe' ? address.pathname.replace(/^\/e\//, '/') : address.pathname;
    const key = `${provider}:${address.origin}${path}${address.search}`;
    if (!mirrors.has(key)) mirrors.set(key, { key, url: address.href, provider });
    if (mirrors.size > MAX_MIRRORS) throw new ProviderError('response_incomplete');
  }
  return { url: target.url, title, mirrors: [...mirrors.values()] };
}

export function createMegakinoProvider(http: HttpClient, metadata: MetadataProvider) {
  return {
    async getStreams(request: ContentRequest): Promise<NativeStream[]> {
      if (request.type !== 'movie' && request.type !== 'tv') throw new ProviderError('invalid_request');
      if (request.type === 'tv' && (!Number.isSafeInteger(request.season) || request.season! < 0
        || !Number.isSafeInteger(request.episode) || request.episode! < 0)) throw new ProviderError('invalid_request');
      const identity = await metadata.resolve(request);
      if (!identity) return [];
      const titles = aliases(identity, request);
      const matches = new Map<string, PageMatch>();
      // QuickJS rejects the lowered generator when await is inside the for-of expression.
      const links = await search(http, titles, request);
      for (const url of links) {
        const response = await http.request(url);
        const html = responseText(response);
        if (detailUrl(response.url).id !== detailUrl(url).id) throw new ProviderError('invalid_response');
        const page = parsePage(html, response.url, titles, identity, request);
        if (page) matches.set(detailUrl(page.url).id, page);
      }
      if (matches.size > 1) throw new ProviderError('ambiguous_match');
      const page = matches.values().next().value;
      if (!page) return [];
      return resolveMirrors(page, async mirror => {
        if (mirror.provider === 'firestream') return resolveFirestream(http, mirror.url!, page.url, page.title);
        const stream = await resolveVoe(http, mirror.url!, page.url);
        const path = resolveUrl(stream.url).pathname;
        if (/\.m3u8$/i.test(path)) {
          const technical = await resolveHlsMetadata(http, stream.url, stream.headers ?? {});
          return { ...stream, title: [page.title, ...technical.details].join(' | '), quality: technical.quality,
            language: technical.language ?? stream.language };
        }
        if (!/\.(?:mp4|mkv|webm|m4v|mov|avi)$/i.test(path)) throw new ProviderError('invalid_response');
        return stream;
      });
    },
  };
}
