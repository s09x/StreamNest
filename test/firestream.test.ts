import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../src/native/errors.js';
import { isFirestreamUrl, resolveFirestream } from '../src/native/firestream.js';
import type { HttpClient, RequestOptions, TextResponse } from '../src/native/types.js';

const entry = 'https://firestream.to/e/Example1';
const pageUrl = 'https://firestream.site/e/Example1';
const sourcePage = 'https://filmpalast.to/stream/synthetic-film';
const endpoint = 'https://firestream.site/api/videos/Example1/resolve';
const media = 'https://media.example.invalid/encoded/video.m3u8?fixture=one%2Btwo';
const manifest = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Deutsch",LANGUAGE="de",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x800,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"\nvideo.m3u8\n';

function page(video: Record<string, unknown> = {}, blob = 'synthetic-opaque-blob'): string {
  return `<script>throw new Error('Never execute website scripts')</script><script id="video-data" type="application/json">${JSON.stringify({ video: {
    title: 'Synthetic source title', encodingStatus: 'completed', transferStatus: 'completed',
    fileSize: 5_000_000_000, mimeType: 'video/x-matroska', ...video,
  } })}</script><script id="token-blob" type="text/plain">${blob}</script>`;
}

interface Fixture {
  html?: string;
  finalPageUrl?: string;
  resolved?: unknown;
  resolveStatus?: number;
  resolveUrl?: string;
  manifest?: string;
  failHd?: boolean;
}
function mock(options: Fixture = {}) {
  const calls: Array<{ url: string; options?: RequestOptions }> = [];
  let sessions = 0;
  const response = (url: string, text: string, status = 200): TextResponse => ({ url, text, status, header: () => null });
  const http: HttpClient = {
    async request(url, request) {
      calls.push({ url, options: request });
      if (url === entry) return response(options.finalPageUrl ?? pageUrl, options.html ?? page());
      if (url === endpoint) return response(options.resolveUrl ?? endpoint, JSON.stringify(options.resolved ?? {
        signedVideoUrl: media, signedVideoSdUrl: null,
      }), options.resolveStatus ?? 200);
      if (url === media && options.failHd) return response(url, 'Not available', 503);
      if (url.startsWith('https://media.example.invalid/')) return response(url, options.manifest ?? manifest);
      throw new Error('Unexpected URL in synthetic resolver fixture');
    },
    async json(url, request) { return JSON.parse((await http.request(url, request)).text); },
    session() { sessions++; return http; },
    cookies() { return {}; },
  };
  return { http, calls, sessions: () => sessions };
}

function code(expected: string) {
  return (error: unknown) => error instanceof ProviderError && error.code === expected;
}

test('FireStream accepts its real embed/view domains and rejects unrelated or malformed URLs', () => {
  assert.equal(isFirestreamUrl(entry), true);
  assert.equal(isFirestreamUrl('https://firestream.site/v/Q-tWeVae'), true);
  for (const invalid of ['https://firestream.to.evil.example/e/Example1', 'https://firestream.to/e/x',
    'https://user:pass@firestream.to/e/Example1', 'file:///e/Example1', 'https://firestream.to:8443/e/Example1']) {
    assert.equal(isFirestreamUrl(invalid), false);
  }
});

test('FireStream reproduces the public blob POST and keeps the HLS graph and declared sidecars', async () => {
  const fixture = mock({ html: page({ isMulti: true, isVpn: true, user: { blockVpn: false }, subtitles: [
    { url: 'https://captions.example.invalid/de.vtt?fixture=1', language: 'German', label: 'German', default: true },
    { url: 'https://captions.example.invalid/de.vtt?fixture=1', language: 'de', label: 'German', default: true },
  ] }) });
  const result = await resolveFirestream(fixture.http, entry, sourcePage, 'Synthetic film');
  assert.equal(fixture.sessions(), 1);
  assert.equal(result.url, media);
  assert.equal(result.quality, '1920x800');
  assert.equal(result.language, 'de');
  assert.equal(result.size, undefined, 'the upload size is not the HLS representation size');
  assert.ok(result.name?.includes('Synthetic film'));
  assert.ok(result.name?.includes('AVC'));
  assert.equal(result.subtitles?.length, 1);
  assert.equal(result.subtitles?.[0]?.language, 'de');
  assert.equal(result.subtitles?.[0]?.name, 'German', 'default=true must not invent a forced label');
  const post = fixture.calls.find(call => call.url === endpoint)!;
  assert.equal(post.options?.method, 'POST');
  assert.deepEqual(JSON.parse(post.options?.body ?? '{}'), { blob: 'synthetic-opaque-blob' });
  assert.equal(post.options?.headers?.Referer, pageUrl);
  assert.equal(post.options?.headers?.Origin, 'https://firestream.site');
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls.some(call => /\/challenge|\/view|\.ts(?:\?|$)|audio\.m3u8/.test(call.url)), false);
});

test('FireStream metadata does not invent dimensions or languages for a plain media playlist', async () => {
  const fixture = mock({ html: page({ isMulti: true }), manifest: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n' });
  const result = await resolveFirestream(fixture.http, entry, sourcePage);
  assert.equal(result.quality, undefined);
  assert.equal(result.language, undefined);
  assert.equal(result.size, undefined);
  assert.equal(fixture.calls.some(call => call.url.endsWith('segment.ts')), false);
});

test('FireStream can use an already supplied direct file without fetching its media body', async () => {
  const direct = 'https://media.example.invalid/original.mp4?fixture=1';
  const fixture = mock({ html: page({ signedVideoUrl: direct }) });
  const result = await resolveFirestream(fixture.http, entry, sourcePage);
  assert.equal(result.url, direct);
  assert.equal(fixture.calls.length, 1);
  assert.equal(result.size, undefined);
});

test('FireStream tries the declared SD alternative when the HD playlist fails', async () => {
  const sd = 'https://media.example.invalid/sd/video.m3u8?fixture=2';
  const fixture = mock({ resolved: { signedVideoUrl: media, signedVideoSdUrl: sd }, failHd: true });
  assert.equal((await resolveFirestream(fixture.http, entry, sourcePage)).url, sd);
  assert.equal(fixture.calls.filter(call => call.url === endpoint).length, 1, 'one-time blob is not reused');
});

test('FireStream rejects processing videos, explicit VPN gates and cross-file or foreign redirects', async () => {
  for (const [options, expected] of [
    [{ html: page({ encodingStatus: 'processing' }) }, 'request_failed'],
    [{ html: page({ transferStatus: 'pending' }) }, 'request_failed'],
    [{ html: page({ isVpn: true, user: { blockVpn: true } }) }, 'source_blocked'],
    [{ finalPageUrl: 'https://firestream.site/e/Different1' }, 'invalid_response'],
    [{ finalPageUrl: 'https://other.example.invalid/e/Example1' }, 'invalid_response'],
  ] as Array<[Fixture, string]>) {
    const fixture = mock(options);
    await assert.rejects(resolveFirestream(fixture.http, entry, sourcePage), code(expected));
    assert.equal(fixture.calls.some(call => call.url === endpoint), false);
  }
});

test('FireStream validates complete data and API URLs without logging opaque token content', async () => {
  for (const options of [
    { html: '<script id="video-data" type="application/json">{"video":' },
    { html: page({}, '') },
    { resolveUrl: 'https://other.example.invalid/api/videos/Example1/resolve' },
    { resolved: { signedVideoUrl: 'javascript:alert(1)' } },
    { resolved: { signedVideoUrl: 'https://media.example.invalid/login' } },
  ] as Fixture[]) {
    const fixture = mock(options);
    await assert.rejects(resolveFirestream(fixture.http, entry, sourcePage), error => {
      assert.ok(error instanceof ProviderError);
      assert.ok(!error.message.includes('synthetic-opaque-blob'));
      return true;
    });
  }
});
