import { ProviderError, type FailureCode } from './errors.js';
import { normalizeDeclaredLanguage, resolveHlsMetadata } from './hls.js';
import { jsonResponse, objectValue } from './metadata.js';
import { parseRequest } from './request.js';
import { resolveUrl } from './url.js';
import { httpUrl, isVoeUrl, resolveVoe } from './voe.js';
import { isVixeoUrl, resolveVixeo } from './vixeo.js';
import { isDoodUrl, resolveDood } from './dood.js';
import { isVeevUrl, resolveVeev } from './veev.js';
import { isByseUrl, resolveByseVariants } from './byse.js';
import { isFirestreamUrl, resolveFirestream } from './firestream.js';
import { isFlyfileUrl, resolveFlyfile } from './flyfile.js';
import { isPlaymateUrl, resolvePlaymate } from './playmate.js';
import { fileHoster, resolveFileHoster, declaredQuality, type FileHoster } from './file-hosters.js';
import { browserHttp, browserStream, playerPage } from './hoster-http.js';
import type { ContentRequest, HttpClient, NativeStream } from './types.js';

const ORIGIN = 'https://huhu.to';
const MAX_RESPONSE_LENGTH = 1024 * 1024;
const MAX_SOURCE_ROWS = 256;
type Hoster = FileHoster | 'voe' | 'vixeo' | 'dood' | 'veev' | 'byse' | 'firestream' | 'flyfile' | 'playmate' | 'unsupported';
const HOSTER_NAMES: Record<Hoster, string> = { voe: 'VOE', vixeo: 'Vixeo', dood: 'DoodStream', veev: 'Veev', byse: 'Byse',
  supervideo: 'Supervideo', vidoza: 'Vidoza', mixdrop: 'Mixdrop', streamtape: 'Streamtape', lulustream: 'LuluStream',
  filemoon: 'Filemoon', firestream: 'FireStream', flyfile: 'FlyFile', playmate: 'Playmate', unsupported: 'Unknown hoster' };
interface Mirror { url: string; provider: Hoster; languages: string[]; tags: string[]; sources: number[] }
export interface HuhuSourceReport {
  source: number; host?: string; hoster?: string; label?: string; tag?: string; languages?: string[];
  status: 'pending' | 'resolved' | 'unavailable' | 'blocked' | 'unsupported' | 'failed';
  error?: FailureCode; streamCount?: number; qualities?: string[]; duplicateOf?: number;
}
export interface HuhuResult { streams: NativeStream[]; sources: HuhuSourceReport[]; failure?: FailureCode }

function hoster(url: string): Hoster {
  return isVoeUrl(url) ? 'voe' : isVixeoUrl(url) ? 'vixeo' : isDoodUrl(url) ? 'dood' : isVeevUrl(url) ? 'veev'
    : fileHoster(url) ?? (isByseUrl(url) ? 'byse' : isFirestreamUrl(url) ? 'firestream' : isFlyfileUrl(url) ? 'flyfile'
      : isPlaymateUrl(url) ? 'playmate' : 'unsupported');
}

function failureStatus(error: FailureCode): HuhuSourceReport['status'] {
  return error === 'source_unavailable' ? 'unavailable' : error === 'source_blocked' ? 'blocked'
    : error === 'unsupported_hoster' || error === 'unsupported_runtime' ? 'unsupported' : 'failed';
}

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

function sourceMirrors(data: unknown): { mirrors: Mirror[]; reports: HuhuSourceReport[]; failure?: ProviderError } {
  if (!Array.isArray(data)) throw new ProviderError('invalid_response');
  if (data.length > MAX_SOURCE_ROWS) throw new ProviderError('response_incomplete');
  const mirrors = new Map<string, Mirror>();
  const reports: HuhuSourceReport[] = [];
  let failure: ProviderError | undefined;
  for (const value of data) {
    const report: HuhuSourceReport = { source: reports.length + 1, status: 'pending' };
    reports.push(report);
    try {
      const row = objectValue(value);
      if (!row || typeof row.type !== 'string') throw new ProviderError('invalid_response');
      report.label = textValue(row.name); report.tag = textValue(row.tag);
      if (row.type !== 'url') throw new ProviderError('unsupported_hoster');
      if (typeof row.url !== 'string') throw new ProviderError('invalid_response');
      const url = httpUrl(row.url);
      const provider = hoster(url);
      const address = resolveUrl(url);
      report.host = address.hostname; report.hoster = HOSTER_NAMES[provider];
      if (address.hash) throw new ProviderError('invalid_response');
      // VOE's watch and embed paths identify the same file. Keep query values
      // and case-sensitive file codes intact, including on the Vixeo aliases.
      const path = provider === 'voe' ? address.pathname.replace(/^\/e\//, '/')
        : provider === 'dood' ? address.pathname.replace(/^\/d\//, '/e/') : address.pathname;
      const key = `${address.origin}${path.replace(/\/$/, '')}${address.search}`;
      const mirror: Mirror = mirrors.get(key) ?? { url, provider, languages: [], tags: [], sources: [] };
      const languages: string[] = [];
      if (Array.isArray(row.languages)) {
        if (row.languages.length > 32) throw new ProviderError('response_incomplete');
        for (const value of row.languages) {
          const language = typeof value === 'string' && value.length <= 100 ? normalizeDeclaredLanguage(value) : '';
          if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language)) {
            if (!languages.includes(language)) languages.push(language);
            if (!mirror.languages.includes(language)) mirror.languages.push(language);
          }
        }
      }
      report.languages = languages;
      const tag = textValue(row.tag);
      if (tag && !mirror.tags.includes(tag)) mirror.tags.push(tag);
      if (mirror.sources.length) report.duplicateOf = mirror.sources[0]! + 1;
      mirror.sources.push(reports.length - 1);
      mirrors.set(key, mirror);
    } catch (error) {
      const cause = error instanceof ProviderError ? error : new ProviderError('invalid_response');
      failure ??= cause; report.status = failureStatus(cause.code); report.error = cause.code;
    }
  }
  return { mirrors: [...mirrors.values()], reports, failure };
}

async function resolveMirror(http: HttpClient, mirror: Mirror, title: string): Promise<NativeStream[]> {
  const client = browserHttp(http);
  let resolved: NativeStream[];
  switch (mirror.provider) {
    case 'voe': resolved = [browserStream(await resolveVoe(client, mirror.url, `${ORIGIN}/`))]; break;
    case 'vixeo': resolved = [browserStream(await resolveVixeo(client, mirror.url, `${ORIGIN}/`, title))]; break;
    case 'dood': resolved = [await resolveDood(client, mirror.url, `${ORIGIN}/`, title, { includeUploadTitle: true })]; break;
    case 'veev': resolved = await resolveVeev(http, mirror.url, `${ORIGIN}/`, title); break;
    case 'byse': resolved = await resolveByseVariants(http, mirror.url, `${ORIGIN}/`, title); break;
    case 'firestream': resolved = [await resolveFirestream(http, mirror.url, `${ORIGIN}/`, title)]; break;
    case 'flyfile': resolved = [await resolveFlyfile(http, mirror.url, `${ORIGIN}/`, title)]; break;
    case 'playmate': resolved = [await resolvePlaymate(http, mirror.url, `${ORIGIN}/`, title)]; break;
    case 'unsupported': throw new ProviderError('unsupported_hoster');
    case 'filemoon': {
      const page = await client.request(mirror.url, { headers: { Referer: `${ORIGIN}/` } });
      if (/<title[^>]*>\s*Byse Frontend\s*<\/title>/i.test(playerPage(page))) {
        resolved = await resolveByseVariants(http, mirror.url, `${ORIGIN}/`, title);
        break;
      }
      try { resolved = await resolveFileHoster(http, mirror.url, `${ORIGIN}/`, title, page); }
      catch (error) {
        if (!(error instanceof ProviderError) || error.code !== 'unsupported_hoster') throw error;
        // The current API is independent of the SPA's document title/branding.
        resolved = await resolveByseVariants(http, mirror.url, `${ORIGIN}/`, title);
      }
      break;
    }
    default: resolved = await resolveFileHoster(http, mirror.url, `${ORIGIN}/`, title);
  }
  const results: NativeStream[] = [];
  for (let stream of resolved) {
    const details: string[] = [];
    if (mirror.provider === 'voe' && /\.m3u8$/i.test(resolveUrl(stream.url).pathname)) {
      const technical = await resolveHlsMetadata(client, stream.url, stream.headers ?? {});
      details.push(...technical.details);
      stream = { ...stream, quality: technical.quality, language: technical.language ?? stream.language };
    }
    let label = stream.title && stream.title !== 'VOE' ? stream.title : title;
    const suffix = ` • ${HOSTER_NAMES[mirror.provider]}`;
    if (label.endsWith(suffix)) label = label.slice(0, -suffix.length);
    const tags = mirror.tags.map(tag => `Source: ${tag}`);
    if (stream.quality) details.push(`Video: ${stream.quality}`);
    const name = `${[label, ...tags, ...details].join(' | ')} • Huhu / ${HOSTER_NAMES[mirror.provider]}`;
    // Nuvio Enhanced chooses name over title and otherwise discards the title.
    // Keep all source labels and technical metadata in the displayed field.
    results.push({ ...stream, name, title: name,
      quality: stream.quality ?? mirror.tags.map(declaredQuality).find(value => value !== undefined),
      language: stream.language ?? (mirror.languages.length ? mirror.languages.join(' / ') : undefined) });
  }
  return results;
}

export async function inspectHuhuStreams(http: HttpClient, input: ContentRequest): Promise<HuhuResult> {
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
  if (item.name === '' && item.releaseDate === undefined && item.episodes === undefined) return { streams: [], sources: [] };
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
    if (!matches.length) return { streams: [], sources: [] };
    if (matches.length > 1) throw new ProviderError('ambiguous_match');
    label += ` S${String(request.season).padStart(2, '0')}E${String(request.episode).padStart(2, '0')}`;
  }
  const data = await api(http, 'source', { type, ids: { tmdb_id: matchedId }, name: '',
    ...(request.type === 'tv' ? { episode: { ids: {}, season: request.season, episode: request.episode } } : {}) });
  const selected = sourceMirrors(data);
  const results: Array<NativeStream[] | ProviderError> = new Array(selected.mirrors.length);
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
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const mirror = selected.mirrors[index]!;
    for (const source of mirror.sources) {
      const report = selected.reports[source]!;
      if (result instanceof ProviderError) {
        report.status = failureStatus(result.code); report.error = result.code;
      } else {
        report.status = result.length ? 'resolved' : 'unavailable'; report.streamCount = result.length;
        report.qualities = [...new Set(result.map(stream => stream.quality).filter((value): value is string => value !== undefined))];
      }
    }
    if (result instanceof ProviderError) { failure ??= result; continue; }
    for (const stream of result) if (!seen.has(stream.url)) { seen.add(stream.url); streams.push(stream); }
  }
  return { streams, sources: selected.reports, ...(failure ? { failure: failure.code } : {}) };
}

export async function getHuhuStreams(http: HttpClient, input: ContentRequest): Promise<NativeStream[]> {
  const result = await inspectHuhuStreams(http, input);
  if (!result.streams.length && result.failure) throw new ProviderError(result.failure);
  return result.streams;
}
