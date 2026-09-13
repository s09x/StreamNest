import { ProviderError } from './errors.js';
import { resolveUrl } from './url.js';
import type { HttpClient, RequestOptions, TextResponse } from './types.js';

export type FetchImplementation = (url: string, options?: RequestOptions) => Promise<{
  status: number; url?: string; text(): Promise<string>;
  headers: { get?(name: string): string | null; [key: string]: unknown };
}>;
interface Cookie { name: string; value: string; domain: string; path: string; secure: boolean; expires?: number }

function safeUrl(input: string): URL {
  try {
    const authority = /^https?:\/\/([^/?#]*)/i.exec(input)?.[1];
    if (!authority || authority.includes('@')) throw new Error();
    const url = resolveUrl(input);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    return url;
  } catch { throw new ProviderError('invalid_request'); }
}
export function isChallenge(text: string): boolean {
  return /<title[^>]*>\s*(Just a moment|Attention Required)/i.test(text) || /cf-mitigated["'=:\s]+challenge/i.test(text);
}

export function createHttpClient(fetcher: FetchImplementation = globalThis.fetch as unknown as FetchImplementation): HttpClient {
  function makeClient(withCookies: boolean): HttpClient {
    let jar: Cookie[] = [];
    function cookies(input: string): Record<string, string> {
      const url = safeUrl(input); const now = Date.now();
      jar = jar.filter(cookie => cookie.expires === undefined || cookie.expires > now);
      const values: Record<string, string> = {};
      for (const cookie of jar) {
        const pathMatches = url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/');
        if (url.hostname === cookie.domain && pathMatches && (!cookie.secure || url.protocol === 'https:')) values[cookie.name] = cookie.value;
      }
      return values;
    }
    function storeCookies(input: string, header: string | null): void {
      if (!header) return;
      const url = safeUrl(input);
      for (const line of header.split(/\r?\n|,(?=\s*[!#$%&'*+.^_`|~\w-]+=)/)) {
        const parts = line.split(';'); const pair = /^\s*([^=\s]+)=(.*)$/.exec(parts.shift() ?? '');
        if (!pair) continue;
        const cookie: Cookie = { name: pair[1]!, value: pair[2]!, domain: url.hostname, path: '/', secure: false };
        let maxAge: number | undefined;
        for (const part of parts) {
          const index = part.indexOf('='); const key = (index < 0 ? part : part.slice(0, index)).trim().toLowerCase();
          const value = index < 0 ? '' : part.slice(index + 1).trim();
          if (key === 'domain') cookie.domain = value.replace(/^\./, '').toLowerCase();
          if (key === 'path' && value.startsWith('/')) cookie.path = value;
          if (key === 'secure') cookie.secure = true;
          if (key === 'expires' && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value);
          if (key === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
        }
        if (cookie.domain !== url.hostname) continue;
        if (maxAge !== undefined) cookie.expires = Date.now() + maxAge * 1000;
        jar = jar.filter(existing => existing.name !== cookie.name || existing.domain !== cookie.domain || existing.path !== cookie.path);
        jar.push(cookie);
      }
    }
    const client: HttpClient = {
      async request(input, options = {}) {
        let url = safeUrl(input).href; let method = options.method ?? 'GET'; let body = options.body;
        let headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0', ...options.headers };
        for (let redirect = 0; redirect < 6; redirect++) {
          const outgoing: Record<string, string> = { ...headers };
          if (withCookies) { const values = cookies(url); if (Object.keys(values).length) outgoing.Cookie = Object.keys(values).map(name => `${name}=${values[name]}`).join('; '); }
          let response;
          try { response = await fetcher(url, { method, body, headers: outgoing, redirect: 'manual' }); }
          catch { throw new ProviderError('request_failed'); }
          if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new ProviderError('request_failed');
          let receivedUrl: URL;
          try { receivedUrl = safeUrl(response.url || url); }
          catch { throw new ProviderError('invalid_response'); }
          const followedToAnotherOrigin = receivedUrl.origin !== resolveUrl(url).origin;
          // Some Nuvio hosts ignore redirect:manual. Inspect the final origin before
          // accepting cookies or data; this cannot undo headers a host already sent.
          if (followedToAnotherOrigin && ((method === 'POST' && body !== undefined)
            || Object.keys(outgoing).some(key => /authorization|cookie|csrf/i.test(key)))) {
            throw new ProviderError('request_failed');
          }
          const get = (name: string): string | null => {
            if (typeof response.headers?.get === 'function') return response.headers.get(name);
            const value = response.headers?.[name.toLowerCase()] ?? response.headers?.[name];
            return value == null ? null : String(value);
          };
          if (withCookies) storeCookies(receivedUrl.href, get('set-cookie'));
          const location = get('location');
          if (options.redirect !== 'manual' && location && [301, 302, 303, 307, 308].includes(response.status)) {
            let target: URL;
            try { target = safeUrl(resolveUrl(location, receivedUrl.href).href); }
            catch { throw new ProviderError('invalid_response'); }
            if (target.origin !== receivedUrl.origin || followedToAnotherOrigin) {
              if (method === 'POST' && [307, 308].includes(response.status)) throw new ProviderError('request_failed');
              const clean: Record<string, string> = {};
              for (const [key, value] of Object.entries(headers)) if (!/authorization|cookie|csrf|origin/i.test(key)) clean[key] = value;
              headers = clean;
            }
            if (method === 'POST' && [301, 302, 303].includes(response.status)) { method = 'GET'; body = undefined; }
            url = target.href; continue;
          }
          let text: string;
          try { text = await response.text(); } catch { throw new ProviderError('request_failed'); }
          if (get('cf-mitigated') === 'challenge' || isChallenge(text)) throw new ProviderError('source_blocked');
          return { status: response.status, url: receivedUrl.href, text, header: get } satisfies TextResponse;
        }
        throw new ProviderError('request_failed');
      },
      async json(url, options) {
        const response = await client.request(url, options);
        if (response.status < 200 || response.status >= 300) throw new ProviderError('request_failed');
        if (!response.text.trim() || /\.\.\.\[truncated\]\s*$/.test(response.text)) throw new ProviderError('response_incomplete');
        try { return JSON.parse(response.text); }
        catch { throw new ProviderError(response.text.trim().startsWith('{') || response.text.trim().startsWith('[') ? 'response_incomplete' : 'invalid_response'); }
      },
      session: () => makeClient(true), cookies,
    };
    return client;
  }
  return makeClient(false);
}
