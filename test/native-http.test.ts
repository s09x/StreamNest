import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../src/native/http.js';
import type { FetchImplementation } from '../src/native/http.js';
import { parseHost, parseRequest } from '../src/native/request.js';
import { ProviderError } from '../src/native/errors.js';

function response(body: string, status = 200, headers: Record<string, string> = {}) {
  return { status, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }, text: async () => body };
}

test('typed IDs and explicit episode coordinates remain consistent', () => {
  assert.deepEqual(parseRequest('tmdb/27205', 'movie'), { type: 'movie', id: '27205', tmdbId: '27205', imdbId: undefined, season: undefined, episode: undefined });
  assert.equal(parseRequest('tt12637874:0:1', 'series').season, 0);
  assert.throws(() => parseRequest('tt12637874:1:1', 'tv', 2, 1), ProviderError);
  assert.throws(() => parseRequest('106379', 'tv'), ProviderError);
  assert.throws(() => parseRequest('27205', 'movie', 1, 1), ProviderError);
  assert.throws(() => parseRequest('0', 'movie'), ProviderError);
  assert.throws(() => parseRequest('not-an-id', 'movie'), ProviderError);
});

test('host input preserves the supplied protocol and port without accepting embedded credentials', () => {
  assert.equal(parseHost(' http://provider.example.invalid:8080/ '), 'http://provider.example.invalid:8080');
  assert.throws(() => parseHost('http://account:secret@provider.example.invalid'), ProviderError);
  assert.throws(() => parseHost('https://provider.example.invalid/?password=secret'), ProviderError);
  assert.throws(() => parseHost('file:///private'), ProviderError);
});

test('native JSON parsing distinguishes empty catalogs from truncated or invalid responses', async () => {
  assert.deepEqual(await createHttpClient(async () => response('[]')).json('https://example.invalid/catalog'), []);
  for (const body of ['[{"id":1}', '[{"id":1}]\n...[truncated]', '']) {
    await assert.rejects(createHttpClient(async () => response(body)).json('https://example.invalid/catalog'), (error: unknown) => error instanceof ProviderError && error.code === 'response_incomplete');
  }
  await assert.rejects(createHttpClient(async () => response('<html>Server error</html>')).json('https://example.invalid/catalog'), (error: unknown) => error instanceof ProviderError && error.code === 'invalid_response');
});

test('source challenges and credential-bearing underlying errors are never presented as empty results', async () => {
  await assert.rejects(createHttpClient(async () => response('<title>Just a moment...</title>', 403)).json('https://example.invalid'), (error: unknown) => error instanceof ProviderError && error.code === 'source_blocked');
  const client = createHttpClient(async () => { throw new Error('https://example.invalid/?password=synthetic-secret'); });
  await assert.rejects(client.request('https://example.invalid'), (error: unknown) => error instanceof ProviderError && !error.message.includes('synthetic-secret'));
});

test('fresh cookie sessions retain ordinary Filmo-style CSRF cookies without cross-origin leakage', async () => {
  const seen: Array<{ url: string; cookie?: string }> = [];
  const fetcher: FetchImplementation = async (url, options) => {
    seen.push({ url, cookie: options?.headers?.Cookie });
    if (url.endsWith('/start')) return response('', 200, { 'set-cookie': 'XSRF-TOKEN=encoded-value; Path=/; Secure; Expires=Wed, 30 Dec 2037 00:00:00 GMT, filmo-session=session-value; HttpOnly; Path=/; Secure' });
    return response('{}');
  };
  const root = createHttpClient(fetcher);
  const session = root.session();
  await session.request('https://source.example.invalid/start');
  assert.equal(session.cookies('https://source.example.invalid/n')['XSRF-TOKEN'], 'encoded-value');
  await session.request('https://source.example.invalid/n');
  assert.match(seen[1]!.cookie!, /filmo-session=session-value/);
  await session.request('https://other.example.invalid/n');
  assert.equal(seen[2]!.cookie, undefined);
  assert.deepEqual(root.cookies('https://source.example.invalid/n'), {});
  assert.deepEqual(session.cookies('http://source.example.invalid/n'), {});
});

test('cookie scope, expiry and path boundaries are honored', async () => {
  const client = createHttpClient(async () => response('', 200, { 'set-cookie': 'private=one; Path=/api; Domain=example.invalid\nexpired=two; Path=/; Max-Age=0; Expires=Wed, 30 Dec 2037 00:00:00 GMT\nforeign=three; Domain=invalid; Path=/' })).session();
  await client.request('https://example.invalid/start');
  assert.deepEqual(client.cookies('https://example.invalid/api/items'), { private: 'one' });
  assert.deepEqual(client.cookies('https://example.invalid/apix'), {});
  assert.deepEqual(client.cookies('https://child.example.invalid/api'), {});
});

test('observable redirects are bounded and strip credential headers and POST bodies across origins', async () => {
  const calls: Array<{ url: string; method?: string; body?: string; headers?: Record<string, string> }> = [];
  const fetcher: FetchImplementation = async (url, options) => {
    calls.push({ url, ...options });
    return url.includes('first.example.invalid') ? response('', 302, { location: 'https://second.example.invalid/next' }) : response('{}');
  };
  await createHttpClient(fetcher).request('https://first.example.invalid/n', { method: 'POST', body: 'secret', headers: { Authorization: 'secret', 'X-CSRF-TOKEN': 'secret' } });
  assert.equal(calls[1]!.method, 'GET');
  assert.equal(calls[1]!.body, undefined);
  assert.equal(calls[1]!.headers?.Authorization, undefined);
  assert.equal(calls[1]!.headers?.['X-CSRF-TOKEN'], undefined);
  await assert.rejects(createHttpClient(async () => response('', 307, { location: 'https://second.example.invalid' })).request('https://first.example.invalid', { method: 'POST', body: 'secret' }), ProviderError);
  await assert.rejects(createHttpClient(async () => response('', 302, { location: 'https://example.invalid/loop' })).request('https://example.invalid'), ProviderError);
});

test('host-followed redirects attribute cookies and relative locations to the received URL', async () => {
  const calls: string[] = [];
  const session = createHttpClient(async url => {
    calls.push(url);
    if (calls.length === 1) return { ...response('', 302, { location: 'next', 'set-cookie': 'host-cookie=fixture; Path=/; Secure' }), url: 'https://target.example.invalid/path/redirect' };
    return response('{}');
  }).session();
  const received = await session.request('https://source.example.invalid/start');
  assert.deepEqual(calls, ['https://source.example.invalid/start', 'https://target.example.invalid/path/next']);
  assert.equal(received.url, 'https://target.example.invalid/path/next');
  assert.deepEqual(session.cookies('https://source.example.invalid/'), {});
  assert.deepEqual(session.cookies('https://target.example.invalid/'), { 'host-cookie': 'fixture' });
});

test('unexpected host-followed credentialed redirects fail without accepting destination data or cookies', async () => {
  let readBody = false;
  const session = createHttpClient(async url => url.endsWith('/start')
    ? response('', 200, { 'set-cookie': 'session=fixture; Path=/' })
    : { ...response('', 200, { 'set-cookie': 'foreign=fixture; Path=/' }), url: 'https://other.example.invalid/final',
      text: async () => { readBody = true; return '{}'; } }).session();
  await session.request('https://source.example.invalid/start');
  await assert.rejects(session.request('https://source.example.invalid/next'), ProviderError);
  assert.equal(readBody, false);
  assert.deepEqual(session.cookies('https://source.example.invalid/'), { session: 'fixture' });
  assert.deepEqual(session.cookies('https://other.example.invalid/'), {});
  for (const options of [{ method: 'POST' as const, body: 'synthetic=fixture' }, { headers: { Authorization: 'synthetic-secret' } }]) {
    await assert.rejects(createHttpClient(async () => ({ ...response('{}'), url: 'https://other.example.invalid/final' }))
      .request('https://source.example.invalid/', options), ProviderError);
  }
  await assert.rejects(createHttpClient(async () => ({ ...response('{}'), url: 'file:///fixture' })).request('https://source.example.invalid/'), ProviderError);
});
