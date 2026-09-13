import { load } from 'cheerio/slim';
import { ProviderError } from './errors.js';
import { jsonResponse, normalizeTitle, objectValue, responseText, yearValue } from './metadata.js';
import { httpUrl, isVoeUrl, resolveVoe } from './voe.js';
import type { ContentRequest, HttpClient, Identity, MetadataProvider, NativeStream, WebProviders } from './types.js';

const MAX_TITLES = 4;
const MAX_DETAILS = 8;
const MAX_MIRRORS = 8;
interface PageMatch { url: string; title: string; year: number; release?: string; mirrors: Mirror[] }
interface Mirror { key: string; url?: string; quality?: string; language?: string }

function sourceUrl(value: string, origin: string, pathPrefix: string): string {
  const result = new URL(httpUrl(value, origin));
  if (result.origin !== origin || !result.pathname.startsWith(pathPrefix) || result.hash) throw new ProviderError('invalid_response');
  return result.href;
}

function titles(identity: Identity): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const title of [identity.title, ...identity.aliases]) {
    const normalized = normalizeTitle(title);
    if (normalized && !seen.has(normalized) && title.length <= 500) {
      seen.add(normalized); result.push(title);
    }
  }
  if (result.length > MAX_TITLES) throw new ProviderError('ambiguous_match');
  return result;
}

function expectedIdentity(identity: Identity, request: ContentRequest): void {
  if (identity.type !== request.type || !titles(identity).length || identity.year === undefined) throw new ProviderError('invalid_response');
  if (request.type === 'tv' && (!Number.isSafeInteger(request.season) || request.season! < 0
    || !Number.isSafeInteger(request.episode) || request.episode! < 0)) throw new ProviderError('invalid_request');
}

function episodeLabel(title: string): { title: string; season: number; episode: number } | null {
  const match = /^(.*?)\s+S(\d{1,4})E(\d{1,4})\s*$/i.exec(title.trim());
  return match ? { title: match[1]!.trim(), season: Number(match[2]), episode: Number(match[3]) } : null;
}

function titleMatches(title: string, identity: Identity, request: ContentRequest): boolean {
  const episode = episodeLabel(title);
  if (request.type === 'tv' && (!episode || episode.season !== request.season || episode.episode !== request.episode)) return false;
  if (request.type === 'movie' && episode) return false;
  const normalized = normalizeTitle(episode?.title ?? title);
  return titles(identity).some(alias => normalizeTitle(alias) === normalized);
}

function sourceLanguage(text: string): string | undefined {
  const languages = new Set<string>();
  if (/\b(?:German|Deutsch|GER|DEU)\b/i.test(text)) languages.add('de');
  if (/\b(?:English|Englisch|ENG)\b/i.test(text)) languages.add('en');
  if (/\b(?:French|Französisch|FRA)\b/i.test(text)) languages.add('fr');
  return languages.size ? [...languages].join(' / ') : undefined;
}

function quality(text: string): string | undefined {
  return /\b(2160p|1080p|720p|576p|480p)\b/i.exec(text)?.[1]?.toLowerCase();
}

function parseFilmpalast(html: string, url: string, identity: Identity, request: ContentRequest): PageMatch | null {
  const $ = load(html);
  const main = $('article.detail.pDetails').first();
  main.find('script,style,.comments,#comments,.comment,[id^="comment-"]').remove();
  const title = main.find('h2.bgDark').first().text().trim();
  const pageTitle = $('title').first().text().trim();
  const year = yearValue(/Veröffentlicht:\s*(\d{4})/i.exec(main.text())?.[1]);
  if (!main.length || !title || year === undefined || !/^(?:Film|Serie)\s/i.test(pageTitle)) throw new ProviderError('invalid_response');
  if ((request.type === 'tv') !== /^Serie\s/i.test(pageTitle) || !titleMatches(title, identity, request) || year !== identity.year) return null;
  const canonical = $('link[rel="canonical"]').attr('href');
  const canonicalUrl = canonical ? sourceUrl(canonical, 'https://filmpalast.to', '/stream/') : url;
  const release = main.find('#release_text').first().text().trim().slice(0, 1000) || undefined;
  const mirrors: Mirror[] = [];
  const seen = new Set<string>();
  main.find('a.iconPlay[href]').each((_, element) => {
    const raw = $(element).attr('href');
    if (!raw) return;
    const target = httpUrl(raw, canonicalUrl);
    if (!isVoeUrl(target)) return;
    const key = new URL(target).pathname.replace(/^\/e\//, '/').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    mirrors.push({ key, url: target, quality: quality(release ?? ''), language: sourceLanguage(release ?? '') });
  });
  if (mirrors.length > MAX_MIRRORS) throw new ProviderError('response_incomplete');
  return { url: canonicalUrl, title, year, release, mirrors };
}

function filmoMirrors(html: string): Array<Mirror & { payload: string }> {
  const $ = load(html);
  const mirrors: Array<Mirror & { payload: string }> = [];
  const seen = new Set<string>();
  $('[data-provider-chip][data-movie-link-id]').each((_, element) => {
    const chip = $(element);
    const provider = chip.find('.provider-chip__name').first().text().trim() || chip.attr('aria-label')?.trim();
    if (provider?.toUpperCase() !== 'VOE') return;
    const id = chip.attr('data-movie-link-id');
    const payload = chip.attr('data-p');
    if (!id || !/^[\w-]{1,120}$/.test(id) || !payload || payload.length > 16_000) throw new ProviderError('invalid_response');
    const language = sourceLanguage(chip.closest('.provider-row').text());
    const key = `${id}:${language ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    mirrors.push({ key, payload, language, quality: quality(chip.find('.provider-chip__metadata').text()) });
  });
  if (mirrors.length > MAX_MIRRORS) throw new ProviderError('response_incomplete');
  return mirrors;
}

function parseFilmo(html: string, url: string, identity: Identity): PageMatch | null {
  const $ = load(html);
  const title = $('h1').first().text().trim();
  const mainText = $('main').length ? $('main').text() : $('body').text();
  const year = yearValue(/Erscheinungsdatum:\s*(\d{4})/i.exec(mainText)?.[1])
    ?? yearValue($('.ft-meta-label').toArray().map(element => $(element).text().trim()).find(text => /^\d{4}$/.test(text)));
  if (!title || year === undefined) throw new ProviderError('invalid_response');
  if (!titles(identity).some(alias => normalizeTitle(alias) === normalizeTitle(title)) || year !== identity.year) return null;
  const canonical = $('link[rel="canonical"]').attr('href');
  const canonicalUrl = canonical ? sourceUrl(canonical, 'https://filmo.to', '/movies/') : url;
  return { url: canonicalUrl, title, year, mirrors: filmoMirrors(html).map(({ payload: _payload, ...mirror }) => mirror) };
}

async function resolveMirrors(page: PageMatch, resolver: (mirror: Mirror) => Promise<NativeStream>): Promise<NativeStream[]> {
  const streams: NativeStream[] = [];
  let failure: ProviderError | undefined;
  const seen = new Set<string>();
  for (const mirror of page.mirrors) {
    try {
      const stream = await resolver(mirror);
      if (seen.has(stream.url)) continue;
      seen.add(stream.url);
      const label = stream.title && stream.title !== 'VOE' ? stream.title : page.release ?? page.title;
      streams.push({ ...stream, title: `${label} • VOE`, quality: stream.quality ?? mirror.quality,
        language: stream.language ?? mirror.language });
    } catch (error) {
      failure ??= error instanceof ProviderError ? error : new ProviderError('request_failed');
    }
  }
  if (!streams.length && failure) throw failure;
  return streams;
}

export function createWebProviders(http: HttpClient, metadata: MetadataProvider): WebProviders {
  return {
    async filmpalast(request) {
      const identity = await metadata.resolve(request);
      if (!identity) return [];
      expectedIdentity(identity, request);
      const links = new Set<string>();
      for (const title of titles(identity)) {
        const query = request.type === 'tv'
          ? `${title} S${String(request.season).padStart(2, '0')}E${String(request.episode).padStart(2, '0')}` : title;
        const response = await http.request(`https://filmpalast.to/search/title/${encodeURIComponent(query)}`);
        const html = responseText(response);
        const $ = load(html);
        if (!$('title').length || !/filmpalast/i.test(html)) throw new ProviderError('invalid_response');
        $('a[href]').each((_, anchor) => {
          const label = $(anchor).text().trim();
          if (!titleMatches(label, identity, request)) return;
          const href = $(anchor).attr('href');
          if (!href || !/\/stream\//.test(href)) return;
          links.add(sourceUrl(href, 'https://filmpalast.to', '/stream/'));
        });
      }
      if (links.size > MAX_DETAILS) throw new ProviderError('ambiguous_match');
      const matches = new Map<string, PageMatch>();
      for (const url of links) {
        const response = await http.request(url);
        const match = parseFilmpalast(responseText(response), url, identity, request);
        if (match) matches.set(match.url, match);
      }
      if (matches.size > 1) throw new ProviderError('ambiguous_match');
      const page = matches.values().next().value;
      if (!page) return [];
      return resolveMirrors(page, mirror => resolveVoe(http, mirror.url!, page.url));
    },
    async filmo(request) {
      if (request.type !== 'movie') return [];
      // The token jump requires its Filmo session. A host that automatically
      // follows redirects can forward those Cookie headers before JS can strip
      // them, so establish observable manual redirects without cookies first.
      const probeUrl = 'http://filmo.to/';
      const probe = await http.request(probeUrl, { redirect: 'manual' });
      if (![301, 302, 307, 308].includes(probe.status) || probe.url !== probeUrl
        || probe.header('location') !== 'https://filmo.to/') throw new ProviderError('unsupported_runtime');
      const identity = await metadata.resolve(request);
      if (!identity) return [];
      expectedIdentity(identity, request);
      const links = new Set<string>();
      for (const title of titles(identity)) {
        const response = await http.request(`https://filmo.to/search/suggest?q=${encodeURIComponent(title)}`, {
          headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        });
        const data = objectValue(jsonResponse(response));
        if (!data || !Array.isArray(data.movies)) throw new ProviderError('invalid_response');
        for (const value of data.movies) {
          const movie = objectValue(value);
          if (!movie || typeof movie.title !== 'string' || typeof movie.url !== 'string') throw new ProviderError('invalid_response');
          if (titles(identity).some(alias => normalizeTitle(alias) === normalizeTitle(movie.title as string))) {
            links.add(sourceUrl(movie.url, 'https://filmo.to', '/movies/'));
          }
        }
      }
      if (links.size > MAX_DETAILS) throw new ProviderError('ambiguous_match');
      const matches = new Map<string, PageMatch>();
      for (const url of links) {
        const response = await http.request(url);
        const match = parseFilmo(responseText(response), url, identity);
        if (match) matches.set(match.url, match);
      }
      if (matches.size > 1) throw new ProviderError('ambiguous_match');
      const page = matches.values().next().value;
      if (!page) return [];
      return resolveMirrors(page, async mirror => {
        const session = http.session();
        const response = await session.request(page.url);
        const html = responseText(response);
        if (!parseFilmo(html, page.url, identity)) throw new ProviderError('invalid_response');
        const current = filmoMirrors(html).find(item => item.key === mirror.key);
        const csrf = load(html)('meta[name="csrf-token"]').attr('content');
        const xsrf = session.cookies(page.url)['XSRF-TOKEN'];
        if (!current || !csrf || /[\r\n]/.test(csrf)) throw new ProviderError('invalid_response');
        const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-TOKEN': csrf, Origin: 'https://filmo.to', Referer: page.url };
        if (xsrf) {
          try { headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf); }
          catch { throw new ProviderError('invalid_response'); }
          if (/[\r\n]/.test(headers['X-XSRF-TOKEN']!)) throw new ProviderError('invalid_response');
        }
        const minted = objectValue(jsonResponse(await session.request('https://filmo.to/n', {
          method: 'POST', headers, body: JSON.stringify({ p: current.payload }),
        })));
        if (typeof minted?.x !== 'string' || !minted.x || minted.x.length > 8000) throw new ProviderError('invalid_response');
        const opened = await session.request(`https://filmo.to/n/${encodeURIComponent(minted.x)}`, {
          headers: { Referer: page.url },
        });
        responseText(opened);
        return resolveVoe(session, opened.url, page.url, opened);
      });
    },
  };
}
