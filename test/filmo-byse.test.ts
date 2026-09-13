import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../src/native/http.js';
import { createWebProviders } from '../src/native/web.js';
import { ProviderError } from '../src/native/errors.js';

const detail = 'https://filmo.to/movies/inception';
const target = 'https://bysezejataos.com/d/synthetic123';
function page(byse = true): string {
  const chip = (name: string, id: string) => `<div data-provider-chip data-movie-link-id="${id}" data-p="synthetic-${name}"><span class="provider-chip__name">${name}</span></div>`;
  return `<html><head><meta name="csrf-token" content="synthetic-csrf"></head><body><main><h1>Inception</h1><p>Erscheinungsdatum: 2010</p>${chip('VOE', '1')}${byse ? chip('Byse', '2') : ''}</main></body></html>`;
}
const metadata = { async resolve() { return { type: 'movie' as const, title: 'Inception', aliases: ['Inception'], year: 2010, tmdbId: '27205' }; } };

test('Filmo follows the same-origin Byse handoff on auto-follow hosts without leaking source cookies', async () => {
  for (const unavailableProbe of [false, true]) {
    const seen: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
    const http = createHttpClient(async (url, options) => {
      const headers = options?.headers ?? {};
      seen.push({ url, headers, body: options?.body });
      const result = (body: unknown, responseHeaders: Record<string, string> = {}, finalUrl = url) => ({
        status: 200, url: finalUrl, headers: { get: (key: string) => responseHeaders[key.toLowerCase()] ?? null },
        text: async () => typeof body === 'string' ? body : JSON.stringify(body),
      });
      if (url === 'http://filmo.to/') {
        if (unavailableProbe) throw new Error('Synthetic HTTP transport unavailable');
        return result('<html></html>', {}, 'https://filmo.to/');
      }
      if (url.includes('/search/suggest')) return result({ movies: [{ title: 'Inception', url: detail }] });
      if (url === detail) return result(page(), { 'set-cookie': 'filmo-session=synthetic-session; Path=/; Secure, XSRF-TOKEN=synthetic-xsrf; Path=/; Secure' });
      if (url === 'https://filmo.to/n') {
        assert.deepEqual(JSON.parse(options?.body ?? ''), { p: 'synthetic-Byse' });
        assert.match(headers.Cookie!, /synthetic-session/);
        return result({ x: 'synthetic-jump' });
      }
      if (url === 'https://filmo.to/n/synthetic-jump') {
        assert.match(headers.Cookie!, /synthetic-session/);
        return result(`<html><body><a class="open" href="${target}" target="_blank" rel="noopener noreferrer">Open video</a></body></html>`);
      }
      if (url.startsWith('https://bysezejataos.com/')) {
        assert.equal(headers.Cookie, undefined);
        assert.equal(headers['X-CSRF-TOKEN'], undefined);
        assert.doesNotMatch(JSON.stringify(headers), /synthetic-jump|synthetic-session|synthetic-xsrf/);
        // The hoster rejects this synthetic private file before playback. The
        // purpose here is to verify the safe source-to-hoster handoff boundary.
        if (url.endsWith('/details')) return result({ code: 'synthetic123', title: 'Inception', owner_private: true });
        if (url.endsWith('/settings')) return result({ code: 'synthetic123', premium_only: false });
      }
      throw new Error('Unexpected fixture request');
    });
    await assert.rejects(createWebProviders(http, metadata).filmo({ type: 'movie', id: '27205' }),
      (error: unknown) => error instanceof ProviderError && error.code === 'source_blocked');
    assert.equal(seen.filter(call => call.url === 'https://filmo.to/n').length, 1);
    assert.ok(seen.some(call => call.url.endsWith('/synthetic123/details')));
    assert.equal(seen.some(call => call.url.includes('voe.sx')), false);
  }
});
