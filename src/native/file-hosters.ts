import { load } from 'cheerio/slim';
import { ProviderError } from './errors.js';
import { domText } from './dom-text.js';
import { objectValue } from './metadata.js';
import { normalizeDeclaredLanguage, resolveHlsMetadata } from './hls.js';
import { browserHttp, playerHeaders, playerPage } from './hoster-http.js';
import { readPlayerLiteral, readPlayerStringExpression, unpackPlayerScripts } from './player-data.js';
import { httpUrl } from './voe.js';
import { resolveUrl } from './url.js';
import type { HttpClient, NativeStream, NativeSubtitle, TextResponse } from './types.js';

export type FileHoster = 'supervideo' | 'vidoza' | 'mixdrop' | 'streamtape' | 'lulustream' | 'filemoon';
const HOSTS: Record<FileHoster, string[]> = {
  supervideo: ['supervideo.cc'], vidoza: ['vidoza.net'],
  mixdrop: ['mixdrop.ps', 'mixdrop.co', 'mixdrop.to', 'mixdrop.si', 'mixdrop.bz', 'mixdrop.ag', 'mixdrop.ch', 'miixdrop.top', 'mxdrop.to', 'mdy48tn97.com'],
  streamtape: ['streamtape.com', 'streamtape.net', 'streamtape.xyz', 'watchadsontape.com', 'shavetape.cash'],
  lulustream: ['luluvdo.com', 'luluvdoo.com', 'lulustream.com'],
  filemoon: ['filemoon.to', 'filemoon.sx', 'filemoon.in'],
};
const MAX_SOURCES = 64;

export function fileHoster(value: string): FileHoster | undefined {
  try {
    const url = resolveUrl(httpUrl(value));
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return (Object.keys(HOSTS) as FileHoster[]).find(name => HOSTS[name].includes(host));
  } catch { return undefined; }
}

function fileCode(url: string, provider: FileHoster): string {
  const path = resolveUrl(url).pathname;
  const pattern = provider === 'vidoza' ? /^\/(?:w\/)?(?:embed-)?([A-Za-z0-9]{8,64})\.html\/?$/
    : provider === 'supervideo' ? /^\/(?:e\/)?([A-Za-z0-9]{8,64})\/?$/
    : provider === 'lulustream' || provider === 'filemoon' ? /^\/(?:(?:e|d|v)\/|embed-)([A-Za-z0-9]{8,64})(?:\.html|\/.*)?$/
    : /^\/(?:e|f|v)\/([A-Za-z0-9]{8,64})(?:\/.*)?$/;
  const code = pattern.exec(path)?.[1];
  if (!code) throw new ProviderError('invalid_response');
  return code;
}

function language(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 100) return undefined;
  const normalized = normalizeDeclaredLanguage(value);
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized) ? normalized : undefined;
}

export function declaredQuality(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  const match = /^(\d{3,4})p?$/i.exec(text);
  if (match && Number(match[1]) >= 144 && Number(match[1]) <= 4320) return `${match[1]}p`;
  if (/^(?:4k|uhd)$/i.test(text)) return '2160p';
  if (/^8k$/i.test(text)) return '4320p';
  return undefined;
}

function arrayData(script: string, names: string[]): unknown[][] {
  const results: unknown[][] = [];
  const pattern = new RegExp(`(?:\\b(?:${names.join('|')})|["'](?:${names.join('|')})["'])\\s*[:=]\\s*(?=\\[)`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(script))) {
    const parsed = readPlayerLiteral(script, match.index + match[0].length);
    if (!Array.isArray(parsed.value)) throw new ProviderError('invalid_response');
    results.push(parsed.value); pattern.lastIndex = parsed.end;
    if (results.length > MAX_SOURCES) throw new ProviderError('response_incomplete');
  }
  return results;
}

interface Source { url: string; quality?: string; hls: boolean }
interface PlayerData { sources: Source[]; subtitles: NativeSubtitle[]; failure?: ProviderError }

/** Extract only public player data; executable player and advertising code is ignored. */
export function extractFilePlayer(html: string, pageUrl: string, provider: FileHoster): PlayerData {
  if (html.length > 1024 * 1024) throw new ProviderError('response_incomplete');
  const $ = load(html);
  const headers = playerHeaders(pageUrl);
  const sources = new Map<string, Source>();
  const subtitles = new Map<string, NativeSubtitle>();
  let failure: ProviderError | undefined;
  function addSource(raw: unknown, quality?: unknown, type?: unknown): void {
    if (typeof raw !== 'string' || !raw.trim()) throw new ProviderError('invalid_response');
    const url = httpUrl(raw, pageUrl);
    const hls = /\.m3u8(?:$|[?#])/i.test(url) || (typeof type === 'string' && /(?:mpegurl|^hls$)/i.test(type));
    const previous = sources.get(url);
    sources.set(url, { url, quality: declaredQuality(quality) ?? previous?.quality, hls: hls || previous?.hls === true });
    if (sources.size > MAX_SOURCES) throw new ProviderError('response_incomplete');
  }
  $('video source[src],video[src]').each((_, element) => {
    const node = $(element);
    addSource(node.attr('src'), node.attr('res') ?? node.attr('label'), node.attr('type'));
  });
  for (const element of $('script:not([src])').toArray()) {
    let scripts: string[];
    try { scripts = unpackPlayerScripts(domText([element])); }
    catch (error) { failure ??= error instanceof ProviderError ? error : new ProviderError('invalid_response'); continue; }
    for (const script of scripts) {
      try {
        if (provider === 'streamtape') {
          const assignments = /document\.getElementById\(\s*(['"])(?:no)?(?:robot|bot)link\1\s*\)\.innerHTML\s*=\s*([^\r\n]+)/g;
          let match: RegExpExecArray | null;
          while ((match = assignments.exec(script))) {
            const value = readPlayerStringExpression(match[2]!);
            const target = resolveUrl(httpUrl(value, pageUrl));
            if (fileHoster(target.href) !== 'streamtape' || target.pathname !== '/get_video') throw new ProviderError('invalid_response');
            const id = target.searchParams.get('id');
            if (id !== fileCode(pageUrl, provider) || !target.searchParams.get('token')) throw new ProviderError('invalid_response');
            const url = target.href + (target.search ? '&' : '?') + 'stream=1';
            addSource(url, undefined, 'video/mp4');
          }
        }
        if (provider === 'mixdrop') {
          const assignments = /\b(?:MDCore\s*\.\s*)?wurl\s*=\s*(?=['"])/g;
          let match: RegExpExecArray | null;
          while ((match = assignments.exec(script))) addSource(readPlayerLiteral(script, match.index + match[0].length).value, undefined, 'video/mp4');
        }
        for (const values of arrayData(script, ['sources', 'sourcesCode'])) {
          for (const value of values) {
            if (typeof value === 'string') { addSource(value); continue; }
            const row = objectValue(value);
            if (!row) throw new ProviderError('invalid_response');
            addSource(row.file ?? row.src, row.res ?? row.height ?? row.label, row.type);
          }
        }
        for (const values of arrayData(script, ['tracks'])) {
          for (const value of values) {
            const row = objectValue(value);
            if (!row || !['captions', 'subtitles'].includes(String(row.kind ?? ''))) continue;
            const raw = row.file ?? row.src;
            const lang = language(row.srclang ?? row.language ?? row.label);
            if (typeof raw !== 'string' || !raw.trim() || !lang) continue;
            const url = httpUrl(raw, pageUrl);
            const name = typeof row.label === 'string' && row.label.length <= 500 ? row.label : undefined;
            subtitles.set(`${url}\n${lang}\n${name ?? ''}`, { url, language: lang, name, headers: { ...headers } });
            if (subtitles.size > 64) throw new ProviderError('response_incomplete');
          }
        }
      } catch (error) { failure ??= error instanceof ProviderError ? error : new ProviderError('invalid_response'); }
    }
  }
  return { sources: [...sources.values()], subtitles: [...subtitles.values()], ...(failure ? { failure } : {}) };
}

export async function resolveFileHoster(http: HttpClient, embedUrl: string, sourcePage: string, title: string, initial?: TextResponse): Promise<NativeStream[]> {
  const provider = fileHoster(embedUrl);
  if (!provider) throw new ProviderError('unsupported_hoster');
  const expected = fileCode(embedUrl, provider);
  const client = browserHttp(http);
  let current = httpUrl(embedUrl);
  let referer = httpUrl(sourcePage);
  const visited = new Set<string>();
  for (let step = 0; step < 3; step++) {
    if (visited.has(current)) throw new ProviderError('invalid_response');
    visited.add(current);
    const response = step === 0 && initial ? initial : await client.request(current, { headers: { Referer: referer } });
    if (fileHoster(response.url) !== provider || fileCode(response.url, provider) !== expected) throw new ProviderError('invalid_response');
    const html = playerPage(response);
    const $ = load(html);
    const frames = new Set<string>();
    $('iframe[src]').each((_, frame) => {
      try {
        const url = httpUrl($(frame).attr('src')!, response.url);
        if (fileHoster(url) === provider && fileCode(url, provider) === expected && url !== response.url) frames.add(url);
      } catch { /* Advertising and unrelated frames are not playback sources. */ }
    });
    if (frames.size > 1) throw new ProviderError('ambiguous_match');
    const next = frames.values().next().value;
    // Download/watch pages can contain preview data as well as their actual
    // player frame. Follow that explicitly published same-file embed first.
    if (next && /^\/(?:d|f)\//.test(resolveUrl(response.url).pathname)) {
      referer = response.url; current = next; continue;
    }
    const data = extractFilePlayer(html, response.url, provider);
    if (data.sources.length) {
      const streams: NativeStream[] = [];
      let failure: ProviderError | undefined;
      for (const source of data.sources) {
        try {
          const headers = playerHeaders(response.url);
          const technical = source.hls ? await resolveHlsMetadata(client, source.url, headers) : undefined;
          streams.push({ url: source.url, title: [title, ...(technical?.details ?? [])].join(' | '), headers,
            quality: technical?.quality ?? (source.hls ? undefined : source.quality), language: technical?.language,
            ...(data.subtitles.length ? { subtitles: data.subtitles } : {}) });
        } catch (error) { failure ??= error instanceof ProviderError ? error : new ProviderError('request_failed'); }
      }
      if (!streams.length && failure) throw failure;
      return streams;
    }
    if (next) { referer = response.url; current = next; continue; }
    const text = domText($('body').toArray());
    if (/file (?:not found|was deleted)|video (?:not found|unavailable)|file does(?:n't| not) exist/i.test(text)) throw new ProviderError('source_unavailable');
    if (/(?:class=['"][^'"]*(?:cf-turnstile|g-recaptcha))|turnstile\.render\(/i.test(html)) throw new ProviderError('source_blocked');
    if (data.failure) throw data.failure;
    throw new ProviderError('unsupported_hoster');
  }
  throw new ProviderError('invalid_response');
}
