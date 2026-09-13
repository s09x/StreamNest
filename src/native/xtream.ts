import { load } from 'cheerio/slim';
import { XMLValidator } from 'fast-xml-parser';
import { ProviderError } from './errors.js';
import { isChallenge } from './http.js';
import { readCompleteJsonProperty } from './json-prefix.js';
import { jsonResponse, normalizeTitle, objectValue, responseText, yearValue } from './metadata.js';
import { parseHost, parseRequest } from './request.js';
import type { ContentRequest, HttpClient, Identity, MetadataProvider, NativeStream, NativeSubtitle, RequestOptions, SettingsField, TextResponse } from './types.js';

type Row = Record<string, unknown>;
interface Credentials { host: string; username: string; password: string }
interface PublicIds { tmdbId?: string; imdbId?: string }
interface CatalogRow extends PublicIds {
  id: string;
  name: string;
  matchingTitle: string;
  year?: number;
  extension?: string;
  directSource?: string;
  legacy?: boolean;
}
interface Episode { row: Row; id: string; season: number; episode: number }
interface SeriesData { info: Row; episodes?: Episode[] }
interface LegacyChannel { title: string; playlists: string[]; streams: string[] }

const CONCURRENCY = 3;

function credentials(settings: unknown): Credentials {
  const values = objectValue(settings);
  if (!values) throw new ProviderError('configuration_required');
  const host = parseHost(values.host);
  for (const key of ['username', 'password']) {
    const value = values[key];
    if (typeof value !== 'string' || !value.length || value.length > 1024 || /[\r\n\0]/.test(value)) {
      throw new ProviderError('configuration_required');
    }
  }
  return { host, username: values.username as string, password: values.password as string };
}

function integer(value: unknown, minimum = 0): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= minimum ? result : undefined;
}

function providerId(value: unknown, allowZero = false): string | undefined {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  return (allowZero ? /^(?:0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(text) ? text : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 2000 ? value.trim() : undefined;
}

function publicIds(row: Row): PublicIds {
  const tmdb = new Set<string>();
  const imdb = new Set<string>();
  for (const key of ['tmdb', 'tmdb_id', 'imdb', 'imdb_id']) {
    const value = row[key];
    if (typeof value === 'number' && !Number.isSafeInteger(value)) continue;
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    const raw = String(value).trim();
    if (/^tt\d+$/.test(raw)) imdb.add(raw);
    else if (/^[1-9]\d*$/.test(raw) && (key === 'tmdb' || key === 'tmdb_id')) tmdb.add(raw);
  }
  if (tmdb.size > 1 || imdb.size > 1) throw new ProviderError('invalid_response');
  return { tmdbId: [...tmdb][0], imdbId: [...imdb][0] };
}

function extension(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9]{1,8}$/.test(value) ? value.toLowerCase() : undefined;
}

function matchingName(name: string): { title: string; year?: number } {
  // Only recognizable, delimited provider decorations are removed. Title words
  // and sequel numbers remain part of the identity comparison.
  let title = name.replace(/^\s*\[(?:DE|GER|DEUTSCH|EN|ENG|MULTI)\]\s*/i, '')
    .replace(/^\s*(?:DE|GER|DEUTSCH|EN|ENG|MULTI)\s*\|\s*/i, '').trim();
  for (let decoration = 0; decoration < 8; decoration++) {
    const stripped = title.replace(/\s*\[(?:4K|UHD|FHD|HD|SD|\d{3,4}p|HEVC|H\.?26[45]|MULTI|DE|GER|EN|ENG)\]\s*$/i, '')
      .replace(/\s+(?:\|\s*|-\s*)(?:4K|UHD|FHD|HD|SD|\d{3,4}p)\s*$/i, '').trim();
    if (stripped === title) break;
    title = stripped;
  }
  const match = /\s*[([]((?:18|19|20|21)\d{2})[)\]]\s*$/.exec(title);
  const year = match ? Number(match[1]) : undefined;
  if (match) title = title.slice(0, match.index).trim();
  return { title: normalizeTitle(title), year };
}

async function mapLimited<T, R>(items: T[], action: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { output[index] = await action(items[index]!); }
      catch (error) { failed = true; failure = error; }
    }
  }));
  if (failed) throw failure instanceof ProviderError ? failure : new ProviderError('request_failed');
  return output;
}

function parseCatalog(value: unknown, request: ContentRequest): CatalogRow[] {
  if (!Array.isArray(value)) throw new ProviderError('invalid_response');
  const output: CatalogRow[] = [];
  for (const item of value) {
    const row = objectValue(item);
    if (!row) throw new ProviderError('invalid_response');
    // These are VOD/series APIs; do not turn an explicitly different stream type
    // into a film. Genre/category words such as documentary are not exclusions.
    const kind = typeof row.stream_type === 'string' ? row.stream_type.toLowerCase() : '';
    if (kind && !['movie', 'vod', 'series', 'tv'].includes(kind)) continue;
    if (request.type === 'movie' && ['series', 'tv'].includes(kind)) continue;
    if (request.type === 'tv' && ['movie', 'vod'].includes(kind)) continue;
    const id = providerId(request.type === 'movie' ? row.stream_id : row.series_id);
    const name = text(row.name);
    if (!id || !name) throw new ProviderError('invalid_response');
    const parsedName = matchingName(name);
    const declaredYear = yearValue(row.year) ?? yearValue(row.releaseDate) ?? yearValue(row.release_date) ?? yearValue(row.releasedate);
    const year = declaredYear !== undefined && parsedName.year !== undefined && declaredYear !== parsedName.year
      ? undefined : declaredYear ?? parsedName.year;
    output.push({ id, name, matchingTitle: parsedName.title, year,
      extension: extension(row.container_extension), directSource: text(row.direct_source), ...publicIds(row) });
  }
  return output;
}

function uniqueRows(categories: CatalogRow[][]): CatalogRow[] {
  const rows = new Map<string, CatalogRow>();
  for (const category of categories) for (const row of category) {
    const previous = rows.get(row.id);
    if (previous) {
      if (previous.matchingTitle !== row.matchingTitle
        || (previous.year !== undefined && row.year !== undefined && previous.year !== row.year)
        || (previous.tmdbId && row.tmdbId && previous.tmdbId !== row.tmdbId)
        || (previous.imdbId && row.imdbId && previous.imdbId !== row.imdbId)
        || (previous.extension && row.extension && previous.extension !== row.extension)) {
        throw new ProviderError('invalid_response');
      }
      rows.set(row.id, { ...previous, year: previous.year ?? row.year, tmdbId: previous.tmdbId ?? row.tmdbId,
        imdbId: previous.imdbId ?? row.imdbId, extension: previous.extension ?? row.extension,
        directSource: previous.directSource ?? row.directSource, legacy: previous.legacy && row.legacy });
    } else rows.set(row.id, row);
  }
  return [...rows.values()].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
}

function agrees(ids: PublicIds, expected: PublicIds): boolean {
  return !(ids.tmdbId && expected.tmdbId && ids.tmdbId !== expected.tmdbId)
    && !(ids.imdbId && expected.imdbId && ids.imdbId !== expected.imdbId);
}

function exactMatches(rows: CatalogRow[], expected: PublicIds): CatalogRow[] {
  return rows.filter(row => agrees(row, expected)
    && ((expected.tmdbId && row.tmdbId === expected.tmdbId) || (expected.imdbId && row.imdbId === expected.imdbId)));
}

function identityIds(identity: Identity, request: ContentRequest): PublicIds {
  if (identity.type !== request.type) throw new ProviderError('invalid_response');
  const result = publicIds({ tmdb: identity.tmdbId, imdb: identity.imdbId });
  if (!agrees(result, request)) throw new ProviderError('ambiguous_match');
  return { tmdbId: request.tmdbId ?? result.tmdbId, imdbId: request.imdbId ?? result.imdbId };
}

function titleMatches(rows: CatalogRow[], identity: Identity, supplemental = false): CatalogRow[] {
  if (identity.year === undefined) return [];
  const titles = new Set([identity.title, ...identity.aliases].map(normalizeTitle));
  const matches = rows.filter(row => !row.tmdbId && !row.imdbId && row.year === identity.year && titles.has(row.matchingTitle));
  if (matches.length > 1) {
    if (supplemental) return [];
    throw new ProviderError('ambiguous_match');
  }
  return matches;
}

function confirmUnindexedDetail(records: Row[], identity: Identity, expected: PublicIds): void {
  const ids = records.map(publicIds);
  if (ids.some(found => !agrees(found, expected))) throw new ProviderError('invalid_response');
  if (ids.some(found => found.tmdbId || found.imdbId)) {
    if (!ids.some(found => (found.tmdbId && found.tmdbId === expected.tmdbId)
      || (found.imdbId && found.imdbId === expected.imdbId))) throw new ProviderError('invalid_response');
    return;
  }
  if (identity.year === undefined) throw new ProviderError('invalid_response');
  const names = new Set([identity.title, ...identity.aliases].map(normalizeTitle));
  let confirmed = false;
  for (const record of records) {
    const name = text(record.name ?? record.title);
    if (!name) continue;
    const parsed = matchingName(name);
    const declared = yearValue(record.year) ?? yearValue(record.releaseDate) ?? yearValue(record.release_date) ?? yearValue(record.releasedate);
    if (declared !== undefined && parsed.year !== undefined && declared !== parsed.year) throw new ProviderError('ambiguous_match');
    const year = declared ?? parsed.year;
    if (year === undefined) continue;
    if (year !== identity.year || !names.has(parsed.title)) throw new ProviderError('ambiguous_match');
    confirmed = true;
  }
  if (!confirmed) throw new ProviderError('invalid_response');
}

function localIdentity(rows: CatalogRow[], request: ContentRequest): Identity | null {
  if (!rows.length || rows.some(row => row.year === undefined || !row.matchingTitle)) return null;
  const names = new Set(rows.map(row => row.matchingTitle));
  const years = new Set(rows.map(row => row.year));
  const tmdb = new Set(rows.map(row => row.tmdbId).filter((id): id is string => !!id));
  const imdb = new Set(rows.map(row => row.imdbId).filter((id): id is string => !!id));
  if (names.size !== 1 || years.size !== 1 || tmdb.size > 1 || imdb.size > 1) return null;
  return { type: request.type, title: rows[0]!.matchingTitle, aliases: [rows[0]!.matchingTitle], year: rows[0]!.year,
    tmdbId: request.tmdbId ?? [...tmdb][0], imdbId: request.imdbId ?? [...imdb][0] };
}

function confirmsSeriesIdentity(info: Row, identity: Identity, ids: PublicIds): boolean {
  const found = publicIds(info);
  if (!agrees(found, ids) || !((found.tmdbId && found.tmdbId === ids.tmdbId)
    || (found.imdbId && found.imdbId === ids.imdbId))) return false;
  if (info.type !== undefined && info.type !== 'series' && info.type !== 'tv') throw new ProviderError('invalid_response');
  const name = text(info.name);
  if (!name || identity.year === undefined) throw new ProviderError('invalid_response');
  const parsed = matchingName(name);
  const year = yearValue(info.releaseDate) ?? yearValue(info.release_date) ?? yearValue(info.year) ?? parsed.year;
  const names = new Set([identity.title, ...identity.aliases].map(normalizeTitle));
  if (!names.has(parsed.title) || year !== identity.year) throw new ProviderError('ambiguous_match');
  return true;
}

function decodeTitle(encoded: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const input = encoded.replace(/\s/g, '');
  if (!input || input.length > 16384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input)
    || input.length % 4 === 1 || (input.includes('=') && input.length % 4 !== 0)) throw new ProviderError('invalid_response');
  let bits = 0; let count = 0; let escaped = '';
  for (const letter of input.replace(/=+$/, '')) {
    bits = (bits << 6) | alphabet.indexOf(letter); count += 6;
    if (count >= 8) {
      count -= 8;
      escaped += '%' + ((bits >> count) & 255).toString(16).padStart(2, '0');
      bits &= (1 << count) - 1;
    }
  }
  if (bits !== 0) throw new ProviderError('invalid_response');
  try {
    const value = text(decodeURIComponent(escaped));
    if (!value) throw new Error();
    return value;
  } catch { throw new ProviderError('invalid_response'); }
}

function legacyChannels(xml: string): LegacyChannel[] {
  if (!/^\uFEFF?\s*(?:<\?xml[^>]*>\s*)?<items(?:\s[^>]*)?>[\s\S]*<\/items>\s*$/i.test(xml)) throw new ProviderError('response_incomplete');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)
    || (xml.match(/<channel(?:\s|>)/g) ?? []).length !== (xml.match(/<\/channel>/g) ?? []).length) throw new ProviderError('invalid_response');
  if (XMLValidator.validate(xml) !== true) throw new ProviderError('invalid_response');
  const $ = load(xml, { xmlMode: true });
  const items = $.root().children('items');
  if (items.length !== 1) throw new ProviderError('invalid_response');
  return items.children('channel').toArray().map(channel => {
    const node = $(channel);
    if (node.children('title').length !== 1) throw new ProviderError('invalid_response');
    return { title: decodeTitle(node.children('title').text()),
      playlists: node.children('playlist_url').toArray().map(element => $(element).text()),
      streams: node.children('stream_url').toArray().map(element => $(element).text()) };
  });
}

function legacyEndpoint(value: string, host: string, type: string): URL {
  const endpoint = new URL(host + '/enigma2.php');
  let url: URL;
  try { url = new URL(value, host + '/'); }
  catch { throw new ProviderError('invalid_response'); }
  if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname || url.username || url.password
    || url.hash || url.searchParams.getAll('type').length !== 1 || url.searchParams.get('type') !== type) throw new ProviderError('invalid_response');
  return url;
}

function legacySeries(xml: string, host: string): CatalogRow[] {
  const result: CatalogRow[] = [];
  for (const channel of legacyChannels(xml)) {
    if (channel.playlists.length !== 1) throw new ProviderError('invalid_response');
    const name = channel.title;
    const url = legacyEndpoint(channel.playlists[0]!, host, 'get_seasons');
    const id = providerId(url.searchParams.get('series_id'));
    if (!id || url.searchParams.getAll('series_id').length !== 1) throw new ProviderError('invalid_response');
    const parsed = matchingName(name);
    result.push({ id, name, matchingTitle: parsed.title, year: parsed.year, legacy: true });
  }
  // An empty legacy response cannot prove completeness of a truncated JSON list.
  if (!result.length) throw new ProviderError('response_incomplete');
  return result;
}

function legacySeasons(xml: string, host: string, seriesId: string): Set<number> {
  const seasons = new Set<number>();
  for (const channel of legacyChannels(xml)) {
    const number = /^Season\s*(\d+)$/i.exec(channel.title);
    const season = number ? integer(number[1]) : undefined;
    if (season === undefined || channel.playlists.length !== 1) throw new ProviderError('invalid_response');
    const url = legacyEndpoint(channel.playlists[0]!, host, 'get_series_streams');
    if (url.searchParams.getAll('series_id').length !== 1 || url.searchParams.get('series_id') !== seriesId
      || url.searchParams.getAll('season').length !== 1 || integer(url.searchParams.get('season')) !== season) throw new ProviderError('invalid_response');
    if (seasons.has(season)) throw new ProviderError('ambiguous_match');
    seasons.add(season);
  }
  return seasons;
}

function legacyEpisodes(xml: string, host: string, parent: CatalogRow, season: number): Episode[] {
  const root = new URL(host + '/');
  const prefix = root.pathname + 'series/';
  const numbers = new Set<number>();
  const result: Episode[] = [];
  for (const channel of legacyChannels(xml)) {
    const number = /^Episode\s*(\d+)$/i.exec(channel.title);
    const episode = number ? integer(number[1]) : undefined;
    if (episode === undefined || channel.streams.length !== 1) throw new ProviderError('invalid_response');
    let url: URL;
    try { url = new URL(channel.streams[0]!, host + '/'); }
    catch { throw new ProviderError('invalid_response'); }
    if (url.origin !== root.origin || url.username || url.password || url.hash || url.search
      || !url.pathname.startsWith(prefix)) throw new ProviderError('invalid_response');
    const parts = url.pathname.slice(prefix.length).split('/');
    const file = /^([1-9]\d*)\.([a-zA-Z0-9]{1,8})$/.exec(parts[2] ?? '');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !file) throw new ProviderError('invalid_response');
    if (numbers.has(episode)) throw new ProviderError('ambiguous_match');
    numbers.add(episode);
    const id = file[1]!;
    // Returned credentials are not copied. Only the file ID and extension are
    // used to construct the normal URL with this installation's own account.
    result.push({ id, season, episode, row: { id, season, episode_num: episode,
      title: `${parent.name} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
      container_extension: file[2]!, info: {} } });
  }
  return result;
}

function episodes(value: unknown): Episode[] {
  const detail = objectValue(value);
  if (!detail) throw new ProviderError('invalid_response');
  const grouped = objectValue(detail.episodes);
  if (!grouped) {
    if (Array.isArray(detail.episodes) && detail.episodes.length === 0) return [];
    throw new ProviderError('invalid_response');
  }
  const output: Episode[] = [];
  for (const [group, values] of Object.entries(grouped)) {
    const groupSeason = integer(group);
    if (groupSeason === undefined || !Array.isArray(values)) throw new ProviderError('invalid_response');
    for (const value of values) {
      const row = objectValue(value);
      if (!row) throw new ProviderError('invalid_response');
      // An absent row season can use the explicit enclosing season key. An
      // explicitly null/invalid/conflicting season never becomes season zero.
      const season: number | undefined = Object.prototype.hasOwnProperty.call(row, 'season') ? integer(row.season) : groupSeason;
      const episode = integer(row.episode_num);
      const id = providerId(row.id);
      if (season === undefined || season !== groupSeason || episode === undefined || !id) throw new ProviderError('invalid_response');
      output.push({ row, id, season, episode });
    }
  }
  return output;
}

function metadataObject(value: unknown): Row {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return {};
  const result = objectValue(value);
  if (!result) throw new ProviderError('invalid_response');
  return result;
}

function sourceUrl(value: unknown, host: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    if (/[^\S ]|[\r\n\0]/.test(value)) return undefined;
    const url = new URL(value, host + '/');
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

function subtitles(info: Row, host: string): NativeSubtitle[] {
  if (info.subtitles === undefined || info.subtitles === null || info.subtitles === '') return [];
  if (!Array.isArray(info.subtitles)) throw new ProviderError('invalid_response');
  const seen = new Set<string>();
  const result: NativeSubtitle[] = [];
  for (const value of info.subtitles) {
    const item = objectValue(value);
    if (!item) throw new ProviderError('invalid_response');
    // Embedded track descriptors have no URL and stay with the original media.
    if (item.url === undefined && item.file === undefined) continue;
    const url = sourceUrl(item.url ?? item.file, host);
    const language = text(item.language ?? item.lang);
    if (!url || !language) throw new ProviderError('invalid_response');
    const key = `${url}\n${language}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const headers = item.headers === undefined ? undefined : objectValue(item.headers);
    if (headers === null) throw new ProviderError('invalid_response');
    const safeHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value)) throw new ProviderError('invalid_response');
      safeHeaders[name] = value;
    }
    result.push({ url, language, name: text(item.name ?? item.label),
      headers: Object.keys(safeHeaders).length ? safeHeaders : undefined });
  }
  return result;
}

function technical(info: Row): { parts: string[]; quality?: string; size?: string } {
  const video = objectValue(info.video);
  const audio = objectValue(info.audio);
  const parts: string[] = [];
  let quality: string | undefined;
  const width = integer(video?.width, 1);
  const height = integer(video?.height, 1);
  if (height !== undefined && height <= 16384 && width !== undefined && width <= 32768) {
    quality = [360, 480, 720, 1080, 1440, 2160, 4320].includes(height) ? `${height}p` : `${width}x${height}`;
    parts.push(`${width}x${height}`);
  }
  const videoCodec = text(video?.codec_name);
  const codecs: Record<string, string> = { h264: 'H.264', avc: 'AVC', h265: 'HEVC', hevc: 'HEVC', av1: 'AV1', vp9: 'VP9', aac: 'AAC', ac3: 'AC3', eac3: 'EAC3', dts: 'DTS', flac: 'FLAC' };
  if (videoCodec && /^[\w.+-]{1,40}$/.test(videoCodec)) parts.push(codecs[videoCodec.toLowerCase()] ?? videoCodec);
  const audioCodec = text(audio?.codec_name);
  const channels = integer(audio?.channels, 1);
  const layout = text(audio?.channel_layout);
  if (audioCodec && /^[\w.+-]{1,40}$/.test(audioCodec)) {
    const reported = [codecs[audioCodec.toLowerCase()] ?? audioCodec, layout && /^[\w. ()+-]{1,40}$/.test(layout) ? layout : channels && channels <= 32 ? `${channels} channels` : ''].filter(Boolean);
    parts.push(reported.join(' '));
  }
  // One Xtream audio object is not the file's complete language/track inventory.
  // In particular, audio.tags.language must not produce an English-only label.
  const hdr = text(info.hdr);
  if (hdr && /^(?:HDR10\+?|Dolby Vision|HLG)$/i.test(hdr)) parts.push(hdr);
  let bytes: number | undefined;
  for (const field of ['size_bytes', 'file_size', 'filesize', 'size']) {
    bytes = integer(info[field], 1);
    if (bytes !== undefined) break;
  }
  const size = bytes === undefined ? undefined : bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  return { parts, quality, size };
}

function stream(config: Credentials, row: CatalogRow, id: string, kind: 'movie' | 'series', media: Row, info: Row): NativeStream {
  const direct = sourceUrl(text(media.direct_source) ?? text(info.direct_source) ?? row.directSource, config.host);
  const suffix = extension(media.container_extension) ?? extension(info.container_extension) ?? row.extension;
  if (!direct && !suffix) throw new ProviderError('invalid_response');
  const url = direct ?? `${config.host}/${kind}/${encodeURIComponent(config.username)}/${encodeURIComponent(config.password)}/${id}.${suffix}`;
  const details = technical(info);
  const title = [text(media.title) ?? row.name, ...details.parts, details.size].filter(Boolean).join(' | ');
  const published = subtitles(info, config.host);
  return { url, title, name: `StreamNest | Xtream | ${title}`, quality: details.quality, size: details.size,
    headers: { 'User-Agent': 'Mozilla/5.0' }, subtitles: published.length ? published : undefined };
}

export function xtreamSettings(): SettingsField[] {
  return [
    { type: 'header', label: 'Xtream movies and series' },
    { type: 'text', key: 'host', label: 'Server URL', placeholder: 'https://your-provider.example:8080',
      description: 'Your Xtream server address, including its port when required.' },
    { type: 'text', key: 'username', label: 'Username', isPassword: true },
    { type: 'text', key: 'password', label: 'Password', isPassword: true },
    { type: 'info', label: 'Stored in Nuvio on this device',
      description: 'Uses your own account for movies and series. An incomplete category is reported as an error, never as an empty catalog.' },
  ];
}

export function createXtreamProvider(http: HttpClient, metadata: MetadataProvider, settings: unknown): { getStreams(request: ContentRequest): Promise<NativeStream[]> } {
  return {
    async getStreams(input) {
      try {
        const config = credentials(settings);
        const request = parseRequest(input.id, input.type, input.season, input.episode);
        if ((input.tmdbId !== undefined && !/^[1-9]\d*$/.test(input.tmdbId))
          || (input.imdbId !== undefined && !/^tt\d+$/.test(input.imdbId))) throw new ProviderError('invalid_request');
        if (!agrees(request, input)) throw new ProviderError('invalid_request');
        const expected: PublicIds = { tmdbId: request.tmdbId ?? input.tmdbId, imdbId: request.imdbId ?? input.imdbId };
        const normalized: ContentRequest = { ...request, ...expected };
        const form = (params: Record<string, string> = {}) => {
          const values: Record<string, string> = { username: config.username, password: config.password, ...params };
          return Object.entries(values).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
        };
        const requestMetadata = async (path: string, values: Record<string, string>, accept: string, method: 'GET' | 'POST' = 'POST') => {
          const encoded = form(values);
          const url = config.host + path + (method === 'GET' ? '?' + encoded : '');
          const options: RequestOptions = method === 'POST'
            ? { method, headers: { Accept: accept, 'Content-Type': 'application/x-www-form-urlencoded' }, body: encoded }
            : { method, headers: { Accept: accept } };
          let response = await http.request(url, options);
          if (response.header('cf-mitigated') === 'challenge' || isChallenge(response.text)) throw new ProviderError('source_blocked');
          // These forms only read metadata. Retry one transient gateway/timeout
          // response, without depending on timers absent from native runtimes.
          if ([408, 502, 503, 504].includes(response.status)) response = await http.request(url, options);
          return response;
        };
        const api = async (action?: string, params?: Record<string, string>): Promise<unknown> => {
          try {
            const response = await requestMetadata('/player_api.php', { ...params, ...(action ? { action } : {}) }, 'application/json');
            try { return jsonResponse(response); }
            catch (error) {
              if ([401, 403].includes(response.status) && !(error instanceof ProviderError && error.code === 'source_blocked')) throw new ProviderError('authentication_failed');
              throw error;
            }
          } catch (error) { throw error instanceof ProviderError ? error : new ProviderError('request_failed'); }
        };
        const enigma = async (type: string, params: Record<string, string>) => responseText(await requestMetadata(
          '/enigma2.php', { type, ...params }, 'application/xml,text/xml', 'GET'));
        const auth = objectValue(await api());
        const user = objectValue(auth?.user_info);
        if (!user || !Object.prototype.hasOwnProperty.call(user, 'auth') || typeof user.status !== 'string') throw new ProviderError('invalid_response');
        if (!(user.auth === 1 || user.auth === '1' || user.auth === true) || user.status.trim().toLowerCase() !== 'active') throw new ProviderError('authentication_failed');

        const isMovie = request.type === 'movie';
        const categoriesValue = await api(isMovie ? 'get_vod_categories' : 'get_series_categories');
        if (!Array.isArray(categoriesValue)) throw new ProviderError('invalid_response');
        const categories = new Set<string>();
        for (const value of categoriesValue) {
          const category = objectValue(value);
          const id = providerId(category?.category_id, true);
          if (!category || !id || !text(category.category_name)) throw new ProviderError('invalid_response');
          categories.add(id);
        }
        const perCategory = await mapLimited([...categories], async categoryId => {
          try { return parseCatalog(await api(isMovie ? 'get_vod_streams' : 'get_series', { category_id: categoryId }), request); }
          catch (error) {
            if (isMovie || !(error instanceof ProviderError) || error.code !== 'response_incomplete') throw error;
            // The legacy series endpoint requires GET on the verified provider;
            // its POST behavior differs from the JSON player API contract.
            return legacySeries(await enigma('get_series', { cat_id: categoryId }), config.host);
          }
        });
        const rows = uniqueRows(perCategory);
        let matches = exactMatches(rows, expected);
        let verifiedIds = expected;
        let identity: Identity | null = localIdentity(matches, normalized);
        if (identity) verifiedIds = identityIds(identity, normalized);
        let identityFlight: Promise<Identity | null> | undefined;
        const ensureIdentity = async () => {
          if (!identity) {
            identityFlight ??= metadata.resolve(normalized);
            identity = await identityFlight;
          }
          if (identity) verifiedIds = identityIds(identity, normalized);
          return identity;
        };
        const seriesDetails = new Map<string, SeriesData>();
        const seriesData = async (seriesId: string): Promise<SeriesData> => {
          const existing = seriesDetails.get(seriesId);
          if (existing) return existing;
          const response: TextResponse = await requestMetadata('/player_api.php', { action: 'get_series_info', series_id: seriesId }, 'application/json');
          let result: SeriesData;
          try {
            const value = jsonResponse(response);
            const detail = objectValue(value);
            if (!detail) throw new ProviderError('invalid_response');
            result = { info: metadataObject(detail.info), episodes: episodes(value) };
          } catch (error) {
            if ([401, 403].includes(response.status) && !(error instanceof ProviderError && error.code === 'source_blocked')) throw new ProviderError('authentication_failed');
            if (!(error instanceof ProviderError) || error.code !== 'response_incomplete') throw error;
            const value = readCompleteJsonProperty(response.text, ['info']);
            if (value === undefined) throw new ProviderError('response_incomplete');
            const info = objectValue(value);
            if (!info) throw new ProviderError('invalid_response');
            result = { info };
          }
          if (result.info.series_id !== undefined && providerId(result.info.series_id) !== seriesId) throw new ProviderError('invalid_response');
          seriesDetails.set(seriesId, result);
          return result;
        };
        const needsLegacy = rows.some(row => row.legacy);
        if ((!matches.length || needsLegacy) && rows.length) {
          identity = await ensureIdentity();
          matches = exactMatches(rows, verifiedIds);
        }
        if (needsLegacy) {
          if (!identity || identity.year === undefined) throw new ProviderError('response_incomplete');
          const names = new Set([identity.title, ...identity.aliases].map(normalizeTitle));
          const legacyCandidates = rows.filter(row => row.legacy && row.year === identity!.year && names.has(row.matchingTitle));
          const confirmed = await mapLimited(legacyCandidates, async row => {
            const { info } = await seriesData(row.id);
            const ids = publicIds(info);
            if (!confirmsSeriesIdentity(info, identity!, verifiedIds)) return null;
            return { ...row, ...ids };
          });
          matches.push(...confirmed.filter((row): row is CatalogRow => row !== null));
        }
        const supplemental = new Set<string>();
        const unindexed = rows.filter(row => !row.legacy && !row.tmdbId && !row.imdbId);
        if (unindexed.length) {
          const hasVerifiedMatches = matches.length > 0;
          if (!identity) {
            try { identity = await ensureIdentity(); }
            catch (error) { if (!hasVerifiedMatches) throw error; }
          }
          if (identity) {
            const extra = titleMatches(unindexed, identity, hasVerifiedMatches);
            if (hasVerifiedMatches) for (const row of extra) supplemental.add(row.id);
            matches.push(...extra);
          }
        }
        const resolveMatch = async (row: CatalogRow): Promise<NativeStream | null> => {
          if (isMovie) {
            const detail = objectValue(await api('get_vod_info', { vod_id: row.id }));
            const media = objectValue(detail?.movie_data);
            if (!detail || !media || providerId(media.stream_id) !== row.id) throw new ProviderError('invalid_response');
            const info = metadataObject(detail.info);
            if (!agrees(publicIds(info), row) || !agrees(publicIds(media), row)
              || !agrees(publicIds(info), verifiedIds) || !agrees(publicIds(media), verifiedIds)) throw new ProviderError('invalid_response');
            if (!row.tmdbId && !row.imdbId) {
              if (!identity) throw new ProviderError('invalid_response');
              confirmUnindexedDetail([info, media], identity, verifiedIds);
            }
            return stream(config, row, row.id, 'movie', media, info);
          }
          const detail = await seriesData(row.id);
          const info = detail.info;
          if (!agrees(publicIds(info), row) || !agrees(publicIds(info), verifiedIds)) throw new ProviderError('invalid_response');
          if (!row.tmdbId && !row.imdbId) {
            if (!identity) throw new ProviderError('invalid_response');
            confirmUnindexedDetail([info], identity, verifiedIds);
          }
          let available = detail.episodes;
          if (available === undefined) {
            const verifiedIdentity = await ensureIdentity();
            if (!verifiedIdentity || verifiedIdentity.year === undefined) throw new ProviderError('response_incomplete');
            if (!confirmsSeriesIdentity(info, verifiedIdentity, verifiedIds)) throw new ProviderError('invalid_response');
            const seasons = legacySeasons(await enigma('get_seasons', { series_id: row.id }), config.host, row.id);
            if (!seasons.has(request.season!)) return null;
            available = legacyEpisodes(await enigma('get_series_streams', { series_id: row.id, season: String(request.season) }),
              config.host, row, request.season!);
          }
          const found = available.filter(item => item.season === request.season && item.episode === request.episode);
          if (found.length > 1) throw new ProviderError('ambiguous_match');
          const episode = found[0];
          if (!episode) return null;
          const episodeInfo = metadataObject(episode.row.info);
          return stream(config, row, episode.id, 'series', episode.row, episodeInfo);
        };
        const results = await mapLimited(matches, async row => {
          try { return await resolveMatch(row); }
          catch (error) {
            // Optional unindexed variants must prove their identity. An
            // unconfirmed extra must not suppress already verified ID matches.
            if (supplemental.has(row.id)) return null;
            throw error;
          }
        });
        return results.filter((value): value is NativeStream => value !== null);
      } catch (error) { throw error instanceof ProviderError ? error : new ProviderError('request_failed'); }
    },
  };
}
