import { load } from 'cheerio/slim';
import { domText } from './dom-text.js';
import { ProviderError } from './errors.js';
import { resolveHlsMetadata } from './hls.js';
import { responseText } from './metadata.js';
import { resolveMirrors, type Mirror } from './mirrors.js';
import { resolveUrl } from './url.js';
import { httpUrl, isVoeUrl, resolveVoe } from './voe.js';
import type { ContentRequest, HttpClient, MetadataProvider, NativeStream } from './types.js';

const ORIGIN = 'https://hdfilme.cafe';
// HDFilme embeds this public IMDb-addressed movie player on its detail pages.
const PLAYER_ORIGIN = 'https://meinecloud.click';
const MAX_MIRRORS = 32;
const MAX_LINK_LENGTH = 16_000;

function mirrorUrl(raw: string, pageUrl: string): string {
  if (!raw || raw.length > MAX_LINK_LENGTH) throw new ProviderError('invalid_response');
  let value = raw.trim();
  if (!/^(?:https?:)?\/\//i.test(value)) {
    // The published player accepts either a plain URL or one Base64 layer.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1
      || (value.includes('=') && value.length % 4 !== 0)) throw new ProviderError('invalid_response');
    try { value = atob(value); }
    catch { throw new ProviderError('invalid_response'); }
  }
  if (!/^(?:https?:)?\/\//i.test(value) || /[\s\0]/.test(value)) throw new ProviderError('invalid_response');
  return httpUrl(value, pageUrl);
}

function movieMirrors(html: string, pageUrl: string, imdbId: string): Mirror[] {
  const $ = load(html);
  const list = $('._player ._source_list');
  if (domText($('title').toArray()).trim() !== `Movie ${imdbId}`
    || list.length !== 1 || $('iframe#_player').length !== 1) throw new ProviderError('invalid_response');
  const rows = list.children('li[data-link]');
  if (rows.length > MAX_MIRRORS) throw new ProviderError('response_incomplete');
  const mirrors: Mirror[] = [];
  const seen = new Set<string>();
  let malformed = false;
  for (const row of rows.toArray()) {
    let url: string;
    try { url = mirrorUrl($(row).attr('data-link')!, pageUrl); }
    catch { malformed = true; continue; }
    // Other advertised hosters did not yield an accepted native playback path.
    if (!isVoeUrl(url)) continue;
    const address = resolveUrl(url);
    const key = `${address.origin}${address.pathname.replace(/^\/e\//, '/').replace(/\/$/, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mirrors.push({ key, url, provider: 'voe' });
  }
  if (!mirrors.length && malformed) throw new ProviderError('invalid_response');
  return mirrors;
}

export function createHdfilmeProvider(http: HttpClient, metadata: MetadataProvider) {
  return async function getStreams(request: ContentRequest): Promise<NativeStream[]> {
    // The inspected series route only supplied a hoster requiring interaction.
    if (request.type !== 'movie') return [];
    const identity = await metadata.resolve(request);
    if (!identity) return [];
    const requestedImdb = request.imdbId ?? (/^tt\d+$/.test(request.id) ? request.id : undefined);
    if (identity.type !== 'movie' || !identity.title.trim() || identity.title.length > 500
      || (requestedImdb && requestedImdb !== identity.imdbId)
      || (request.tmdbId && request.tmdbId !== identity.tmdbId)) throw new ProviderError('invalid_response');
    // A TMDB-only item without a verified IMDb cross-reference cannot use this player.
    if (!identity.imdbId) return [];
    if (!/^tt\d+$/.test(identity.imdbId) || identity.imdbId.length > 32) throw new ProviderError('invalid_response');
    const pageUrl = `${PLAYER_ORIGIN}/movie/${identity.imdbId}`;
    const response = await http.request(pageUrl, { headers: { Referer: `${ORIGIN}/` } });
    if (httpUrl(response.url) !== pageUrl) throw new ProviderError('invalid_response');
    if (response.status === 404) return [];
    const mirrors = movieMirrors(responseText(response), pageUrl, identity.imdbId);
    return resolveMirrors({ title: identity.title, mirrors }, async mirror => {
      const stream = await resolveVoe(http, mirror.url!, pageUrl);
      const hls = await resolveHlsMetadata(http, stream.url, stream.headers ?? {});
      return { ...stream, quality: hls.quality, language: hls.language ?? stream.language,
        title: [stream.title === 'VOE' ? identity.title : stream.title, ...hls.details].join(' • ') };
    });
  };
}
