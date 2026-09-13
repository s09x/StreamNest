import { ProviderError } from './errors.js';
import { httpUrl } from './voe.js';
import { resolveUrl } from './url.js';
import { isChallenge } from './http.js';
import type { HttpClient, NativeStream, TextResponse } from './types.js';

export const PLAYER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

export function hosterResponse(response: TextResponse): void {
  if (response.status === 404 || response.status === 410) throw new ProviderError('source_unavailable');
  if (response.status === 401 || response.status === 403 || response.header('cf-mitigated') === 'challenge') throw new ProviderError('source_blocked');
}

/** Some XFileSharing pages omit optional HTML end tags but end with a complete script. */
export function playerPage(response: TextResponse): string {
  hosterResponse(response);
  if (response.status < 200 || response.status >= 300) throw new ProviderError('request_failed');
  const text = response.text;
  if (isChallenge(text)) throw new ProviderError('source_blocked');
  if (!text.trim() || text.length >= 1024 * 1024 || /\.\.\.\[truncated\]\s*$/.test(text)) throw new ProviderError('response_incomplete');
  if (/<html\b/i.test(text) && !/<\/(?:html|body|script)>\s*$/i.test(text)) throw new ProviderError('response_incomplete');
  return text;
}

/** Use the same native browser identifier for discovery and exported resources. */
export function browserHttp(http: HttpClient): HttpClient {
  return {
    async request(url, options = {}) {
      const headers = { ...options.headers, 'User-Agent': PLAYER_USER_AGENT };
      const response = await http.request(url, { ...options, headers });
      hosterResponse(response);
      return response;
    },
    async json(url, options) { return JSON.parse((await this.request(url, options)).text); },
    session() { return browserHttp(http.session()); },
    cookies(url) { return http.cookies(url); },
  };
}

export function playerHeaders(url: string): Record<string, string> {
  const target = httpUrl(url);
  return { 'User-Agent': PLAYER_USER_AGENT, Referer: target, Origin: resolveUrl(target).origin };
}

export function browserStream(stream: NativeStream): NativeStream {
  return { ...stream, headers: { ...stream.headers, 'User-Agent': PLAYER_USER_AGENT },
    ...(stream.subtitles ? { subtitles: stream.subtitles.map(subtitle => ({ ...subtitle,
      headers: { ...subtitle.headers, 'User-Agent': PLAYER_USER_AGENT } })) } : {}) };
}
