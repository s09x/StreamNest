import test from 'node:test';
import assert from 'node:assert/strict';
import { DOOD_USER_AGENT, extractDoodConfig, isDoodUrl, resolveDood } from '../src/native/dood.js';
import { ProviderError } from '../src/native/errors.js';
import { createHttpClient } from '../src/native/http.js';
import type { RequestOptions } from '../src/native/types.js';
import { doodEmbed, doodFinal, doodPage, doodPass, doodPrefix, doodScript, doodToken } from './helpers/dood-fixture.js';

const sourcePage = 'https://einschalten.in/movies/27205';
type Reply = { text: string; status?: number; url?: string; headers?: Record<string, string> };
function fixture(handler: (url: string, options: RequestOptions) => Reply | Promise<Reply>) {
  const calls: Array<{ url: string; options: RequestOptions }> = [];
  const http = createHttpClient(async (url, options = {}) => {
    calls.push({ url, options });
    const reply = await handler(url, options);
    return { status: reply.status ?? 200, url: reply.url ?? url, text: async () => reply.text,
      headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null } };
  });
  return { calls, http };
}
function failure(code: string) { return (error: unknown) => error instanceof ProviderError && error.code === code; }

test('Dood recognizes the observed hoster aliases and rejects unrelated or credential-bearing URLs', () => {
  for (const host of ['vide0.net', 'playmogo.com', 'doodstream.com']) assert.equal(isDoodUrl(`https://${host}/e/abcdefgh1234`), true);
  for (const url of ['https://vide0.net.attacker.invalid/e/abcdefgh1234', 'https://user:secret@vide0.net/e/abcdefgh1234',
    'https://vide0.net:444/e/abcdefgh1234', 'https://vide0.net/e/abcdefgh1234#other', 'https://vide0.net/e/abcdefgh123',
    'https://vide0.net/e/ABCDEFGH1234', 'https://vide0.net/d/abcdefgh1234', 'javascript:alert(1)']) assert.equal(isDoodUrl(url), false, url);
});

test('Dood reads only the public player assignment and preserves case-sensitive tokens without executing scripts', () => {
  const token = 'SyntheticCaseSensitive123';
  const path = `/pass_md5/fixture/${token}`;
  assert.deepEqual(extractDoodConfig(doodPage(doodScript(token, path))), { path, token });
  assert.deepEqual(extractDoodConfig(doodPage(doodScript() + '</script><script>' + doodScript())), { path: doodPass, token: doodToken });
});

test('Dood rejects conflicting players and incomplete or changed URL construction', () => {
  const second = doodScript('differenttoken1234', '/pass_md5/second/differenttoken1234');
  assert.throws(() => extractDoodConfig(doodPage(doodScript() + '</script><script>' + second)), failure('ambiguous_match'));
  for (const script of [doodScript().replace('?token=' + doodToken, '?token=differenttoken1234'),
    doodScript().replace('/pass_md5/', '/unrelated/'), doodScript().replace('10 > o', '11 > o'),
    doodScript().replace('Date.now()', 'Date.now() + 123'), doodScript() + doodScript(),
    doodScript().replace('function makePlay()', 'function differentName()')]) {
    assert.throws(() => extractDoodConfig(doodPage(script)), failure('invalid_response'));
  }
  assert.throws(() => extractDoodConfig('x'.repeat(1024 * 1024 + 1)), failure('response_incomplete'));
  assert.throws(() => extractDoodConfig('<html><body>No player</body></html>'), failure('invalid_response'));
  assert.throws(() => extractDoodConfig('<html><body><div class="cf-turnstile"></div></body></html>'), failure('source_blocked'));
});

test('Dood follows the same-file redirect with the complete user agent and returns matching playback headers', async () => {
  const fixtureData = fixture((url, options) => {
    assert.equal(options.headers?.['User-Agent'], 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    assert.equal(options.headers?.Cookie, undefined);
    if (url === doodEmbed) return { status: 301, text: '', headers: { location: doodFinal, 'set-cookie': 'unused=synthetic; Path=/' } };
    if (url === doodFinal) { assert.equal(options.headers?.Referer, sourcePage); return { text: doodPage() }; }
    assert.equal(url, 'https://playmogo.com' + doodPass);
    assert.equal(options.headers?.Referer, doodFinal);
    return { text: doodPrefix };
  });
  const before = Date.now();
  const stream = await resolveDood(fixtureData.http, doodEmbed, sourcePage, 'Synthetic Movie');
  const url = new URL(stream.url);
  assert.equal(url.origin, 'https://media.example.invalid');
  assert.match(url.pathname, /^\/files\/synthetic\/[A-Za-z0-9]{10}$/);
  assert.equal(url.searchParams.get('token'), doodToken);
  assert.ok(Number(url.searchParams.get('expiry')) >= before && Number(url.searchParams.get('expiry')) <= Date.now());
  assert.deepEqual(stream.headers, { 'User-Agent': DOOD_USER_AGENT, Referer: doodFinal });
  assert.equal(stream.title, 'Synthetic Movie • DoodStream');
  assert.equal(stream.quality, undefined);
  assert.equal(stream.language, undefined);
  assert.equal(stream.subtitles, undefined, 'the empty player placeholder is not a Spanish subtitle');
  assert.equal(fixtureData.calls.length, 3);
  assert.ok(!fixtureData.calls.some(call => call.url.startsWith(doodPrefix)), 'stream discovery does not fetch video data');
});

test('Dood also works when the native fetch bridge follows redirects automatically', async () => {
  const source = fixture(url => url === doodEmbed ? { text: doodPage(), url: doodFinal } : { text: doodPrefix });
  const stream = await resolveDood(source.http, doodEmbed, sourcePage, 'Synthetic Movie');
  assert.equal(stream.headers?.Referer, doodFinal);
  assert.deepEqual(source.calls.map(call => call.url), [doodEmbed, 'https://playmogo.com' + doodPass]);
});

test('Dood rejects redirected file identities and unknown hosts before requesting a pass', async () => {
  for (const final of ['https://playmogo.com/e/ijklmnop5678', 'https://other.example.invalid/e/abcdefgh1234']) {
    const source = fixture(() => ({ text: doodPage(), url: final }));
    await assert.rejects(() => resolveDood(source.http, doodEmbed, sourcePage, 'Synthetic'), failure('invalid_response'));
    assert.equal(source.calls.length, 1);
  }
  const source = fixture(() => { assert.fail('Invalid input must not be fetched.'); });
  await assert.rejects(() => resolveDood(source.http, 'https://unknown.example.invalid/e/abcdefgh1234', sourcePage, 'Synthetic'), failure('invalid_response'));
});

test('Dood refreshes an expired pass once and does not reuse cached player tokens across lookups', async () => {
  let loads = 0;
  let passes = 0;
  const source = fixture(url => {
    if (url === doodEmbed) {
      loads++;
      const token = `syntheticfresh${loads}`;
      return { text: doodPage(doodScript(token, `/pass_md5/fresh/${token}`)), url: doodFinal };
    }
    passes++;
    assert.equal(url, `https://playmogo.com/pass_md5/fresh/syntheticfresh${loads}`);
    return { text: passes === 1 ? 'RELOAD' : doodPrefix };
  });
  const first = await resolveDood(source.http, doodEmbed, sourcePage, 'Synthetic');
  const next = await resolveDood(source.http, doodEmbed, sourcePage, 'Synthetic');
  assert.equal(new URL(first.url).searchParams.get('token'), 'syntheticfresh2');
  assert.equal(new URL(next.url).searchParams.get('token'), 'syntheticfresh3');
  assert.equal(loads, 3);
  assert.equal(passes, 3);
});

test('Dood limits repeated reload requests and surfaces blocked or deleted files', async () => {
  const reload = fixture(url => url === doodEmbed ? { text: doodPage(), url: doodFinal } : { text: 'RELOAD' });
  await assert.rejects(() => resolveDood(reload.http, doodEmbed, sourcePage, 'Synthetic'), failure('request_failed'));
  assert.equal(reload.calls.length, 4);
  for (const status of [403, 404, 429, 500]) {
    const source = fixture(() => ({ status, text: 'Upstream failure with a synthetic private value' }));
    await assert.rejects(() => resolveDood(source.http, doodEmbed, sourcePage, 'Synthetic'), failure('request_failed'));
    assert.equal(source.calls.length, 1);
  }
  const blocked = fixture(() => ({ status: 403, text: '<html><head><title>Just a moment...</title></head></html>', headers: { 'cf-mitigated': 'challenge' } }));
  await assert.rejects(() => resolveDood(blocked.http, doodEmbed, sourcePage, 'Synthetic'), failure('source_blocked'));
});

test('Dood rejects malformed, credential-bearing, and redirected media-prefix responses', async () => {
  for (const text of ['<html><body>Error</body></html>', '//media.example.invalid/file/',
    'https://user:synthetic-secret@media.example.invalid/file/', 'https://media.example.invalid/file/?token=other',
    'https://media.example.invalid/file/#fragment', 'https://media.example.invalid/file/\nother', doodFinal]) {
    const source = fixture(url => url === doodEmbed ? { text: doodPage(), url: doodFinal } : { text });
    await assert.rejects(() => resolveDood(source.http, doodEmbed, sourcePage, 'Synthetic'), failure('invalid_response'));
    assert.equal(source.calls.length, 2);
  }
  const redirected = fixture(url => url === doodEmbed ? { text: doodPage(), url: doodFinal }
    : { text: doodPrefix, url: 'https://other.example.invalid/pass' });
  await assert.rejects(() => resolveDood(redirected.http, doodEmbed, sourcePage, 'Synthetic'), failure('invalid_response'));
});
