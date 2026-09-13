import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebProviders } from '../src/native/web.js';
import { resolveVixeo } from '../src/native/vixeo.js';
import { parsePlayerApiSubtitles } from '../src/native/vidara.js';
import { ProviderError } from '../src/native/errors.js';
import type { HttpClient, Identity, RequestOptions, TextResponse } from '../src/native/types.js';

const identity: Identity = { type: 'movie', title: 'Fixture Film', aliases: ['Fixture Film'], year: 2020, tmdbId: '123' };
const request = { type: 'movie' as const, id: '123', tmdbId: '123' };
const detail = 'https://filmpalast.to/stream/fixture-film';
const manifest = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,CODECS="avc1.640020,mp4a.40.2"\nvideo.m3u8\n';

function response(url: string, value: unknown): TextResponse {
  return { url, status: 200, text: typeof value === 'string' ? value : JSON.stringify(value), header: () => null };
}

function setup(urls: string[], api: (url: string, options: RequestOptions) => Promise<TextResponse> | TextResponse) {
  const calls: string[] = [];
  const http: HttpClient = {
    async request(url, options = {}) {
      calls.push(url);
      if (url.includes('/search/title/')) return response(url, `<html><head><title>Filmpalast fixture</title></head><body><a href="${detail}">Fixture Film</a></body></html>`);
      if (url === detail) return response(url, `<html><head><title>Film Fixture Film Stream</title></head><body><article class="detail pDetails">
        <h2 class="bgDark">Fixture Film</h2><p>Veröffentlicht: 2020</p>
        ${urls.map(value => `<a class="iconPlay" href="${value}">Play</a>`).join('')}</article></body></html>`);
      if (url.endsWith('/api/stream')) return api(url, options);
      assert.ok(url.startsWith('https://media.example.invalid/'));
      return response(url, manifest);
    },
    async json(url, options) { return JSON.parse((await this.request(url, options)).text); },
    session() { assert.fail('These public Vidara fixtures must not acquire a cookie session'); },
    cookies() { return {}; },
  };
  return { http, calls, provider: createWebProviders(http, { async resolve() { return identity; } }) };
}

function apiResponse(url: string, options: RequestOptions): TextResponse {
  const payload = JSON.parse(options.body!) as { filecode: string };
  return response(url, { filecode: payload.filecode, title: '', subtitles: [],
    streaming_url: `https://media.example.invalid/${new URL(url).hostname}/${payload.filecode}.m3u8` });
}

test('case-distinct public mirror IDs are not collapsed during Filmpalast extraction', async () => {
  const fixture = setup(['https://odysseusa.cc/e/CaseVideoABC1', 'https://odysseusa.cc/e/caseVideoABC1'], apiResponse);
  const streams = await fixture.provider.filmpalast(request);
  assert.deepEqual(streams.map(stream => stream.url), [
    'https://media.example.invalid/odysseusa.cc/CaseVideoABC1.m3u8',
    'https://media.example.invalid/odysseusa.cc/caseVideoABC1.m3u8',
  ]);
  assert.equal(fixture.calls.filter(url => url.endsWith('/api/stream')).length, 2);
});

test('equal public IDs at different origins remain independent offered mirrors', async () => {
  const fixture = setup(['https://odysseusa.cc/e/SameVideoABC1', 'https://vidaraa.cc/e/SameVideoABC1'], apiResponse);
  const streams = await fixture.provider.filmpalast(request);
  assert.deepEqual(streams.map(stream => stream.url), [
    'https://media.example.invalid/odysseusa.cc/SameVideoABC1.m3u8',
    'https://media.example.invalid/vidaraa.cc/SameVideoABC1.m3u8',
  ]);
});

test('mirror resolution has at most three active workers, preserves page order and isolates a failed mirror', async () => {
  const codes = Array.from({ length: 7 }, (_, index) => `VideoCode00${index + 1}`);
  const delays = [35, 5, 20, 2, 10, 1, 1];
  let active = 0; let peak = 0;
  const completions: string[] = [];
  const fixture = setup(codes.map(code => `https://odysseusa.cc/e/${code}`), async (url, options) => {
    const code = (JSON.parse(options.body!) as { filecode: string }).filecode;
    const index = codes.indexOf(code);
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, delays[index]));
      completions.push(code);
      if (index === 2) throw new ProviderError('source_blocked');
      return apiResponse(url, options);
    } finally { active--; }
  });
  const streams = await fixture.provider.filmpalast(request);
  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.equal(completions[0], 'VideoCode002', 'Fixture completions are deliberately out of page order');
  assert.deepEqual(streams.map(stream => new URL(stream.url).pathname.split('/').pop()),
    codes.filter((_, index) => index !== 2).map(code => `${code}.m3u8`));
  assert.equal(fixture.calls.filter(url => url.endsWith('/api/stream')).length, 7);
});

test('all failed mirrors report the first page-order failure rather than a successful empty list', async () => {
  const fixture = setup(['https://odysseusa.cc/e/FirstVideo12', 'https://odysseusa.cc/e/SecondVideo1'], async (_url, options) => {
    const first = JSON.parse(options.body!).filecode === 'FirstVideo12';
    await new Promise(resolve => setTimeout(resolve, first ? 15 : 1));
    throw new ProviderError(first ? 'request_failed' : 'source_blocked');
  });
  await assert.rejects(fixture.provider.filmpalast(request), error => error instanceof ProviderError && error.code === 'request_failed');
});

test('explicit ISO3 HLS and Vixeo subtitle languages normalize to ISO2 without losing display labels', async () => {
  const embed = 'https://vixeo.io/e/ExampleFile12';
  const source = 'https://media.example.invalid/languages.m3u8';
  const config = { videoId: 'ExampleFile12', isMp4: false,
    source: Buffer.from(source).reverse().toString('hex'), default_audio_language: 'ar',
    subtitles: [{ path: '/de.vtt', lang: 'ger', label: 'German (FORCED)' }, { path: '/en.vtt', lang: 'eng', label: 'English' }] };
  const http: HttpClient = {
    async request(url) {
      if (url === embed) return response(url, `<html><head><title>Vixeo fixture</title></head><body><div id="streamsonic-player-root"
        data-config="${Buffer.from(JSON.stringify(config)).toString('base64')}"></div></body></html>`);
      assert.equal(url, source);
      return response(url, '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="eng",URI="en.m3u8"\n'
        + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="ger",URI="de.m3u8"\n'
        + '#EXT-X-STREAM-INF:RESOLUTION=1280x720,AUDIO="a"\nvideo.m3u8\n');
    },
    async json() { assert.fail('No JSON API is used by this player layout'); },
    session() { assert.fail('No session needed'); }, cookies() { return {}; },
  };
  const stream = await resolveVixeo(http, embed, detail, 'Fixture Film');
  assert.equal(stream.language, 'en / de');
  assert.deepEqual(stream.subtitles?.map(subtitle => [subtitle.language, subtitle.name]), [['de', 'German (FORCED)'], ['en', 'English']]);
});

test('source-published German forced caption label remains visible while language becomes de', () => {
  const subtitles = parsePlayerApiSubtitles([{ type: 0, file_path: '/de.ass', language: 'German (FORCED)' }],
    'https://vidaraa.cc/e/ExampleFile12', { Referer: 'https://vidaraa.cc/e/ExampleFile12' });
  assert.equal(subtitles[0]?.language, 'de');
  assert.equal(subtitles[0]?.name, 'German (FORCED)');
});
