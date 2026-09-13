import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { httpUrl } from '../src/native/voe.js';
import { resolveUrl } from '../src/native/url.js';
import { ProviderError } from '../src/native/errors.js';
import { mobileUrlBindings } from './helpers/nuvio-mobile-url.mjs';

for (const mobile of [false, true]) {
  test(`source references resolve consistently with ${mobile ? 'Nuvio Mobile' : 'standard'} URL bindings`, () => {
    const nativeURL = globalThis.URL;
    const context = createContext({ URL: nativeURL, URLSearchParams });
    new Script(mobileUrlBindings).runInContext(context);
    if (mobile) globalThis.URL = context.URL;
    try {
      const references = [
        ['//filmpalast.to/stream/example', 'https://filmpalast.to'],
        ['stream/example', 'https://filmpalast.to'],
        ['/stream/example', 'https://filmpalast.to/search/title/example'],
        ['../subs/de.vtt?fixture=a%2Bb&part=one&part=two', 'https://cdn.example.invalid/video/index.m3u8'],
        ['//subs.example.invalid/de.vtt', 'https://hoster.example.invalid/e/example'],
        ['?fixture=a%2Fb%3D', 'https://cdn.example.invalid/video.m3u8?old=1'],
        ['#captions', 'https://cdn.example.invalid/sub.vtt?fixture=1'],
        ['./file', 'https://example.invalid:8443/base/'],
        ['https://cdn.example.invalid/signed.m3u8?fixture=a%2Bb%3D', 'https://source.example.invalid/'],
      ];
      for (const [reference, base] of references) {
        const expected = new nativeURL(reference!, base);
        const actual = resolveUrl(reference!, base);
        assert.equal(httpUrl(reference!, base), expected.href);
        assert.equal(actual.href, expected.href);
        assert.equal(actual.search, expected.search);
        assert.equal(actual.hash, expected.hash);
      }
      for (const suffix of ['', '?', '#', '?#', '?signed=a%2Bb%3D', '#real-fragment']) {
        const input = `https://cdn.example.invalid/stream.m3u8${suffix}`;
        const actual = resolveUrl(input);
        const expected = new nativeURL(input);
        assert.equal(actual.href, expected.href, 'URL normalization must not rewrite the supplied address');
        assert.equal(actual.search, expected.search);
        assert.equal(actual.hash, expected.hash);
      }
      for (const reference of ['//user:password@example.invalid/file', '//user%40example.invalid/file',
        'https://user:password@example.invalid/file', 'javascript:alert(1)', 'file:///private', '/bad\nheader', '\\\\example.invalid/file']) {
        assert.throws(() => httpUrl(reference, 'https://source.example.invalid/'),
          (error: unknown) => error instanceof ProviderError && error.code === 'invalid_response');
      }
    } finally { globalThis.URL = nativeURL; }
  });
}
