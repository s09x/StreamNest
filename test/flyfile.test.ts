import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, type FetchImplementation } from '../src/native/http.js';
import { isFlyfileUrl, resolveFlyfile } from '../src/native/flyfile.js';
import { ProviderError } from '../src/native/errors.js';

const embed = 'https://flyfile.app/v/syntheticFile123';
const source = 'https://filmpalast.to/stream/synthetic-movie';
const api = 'https://api.flyfile.app/api';
const master = 'https://streaming-de-3.flyfile.app/hls/synthetic-token/master.m3u8';
const hls = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"\nvideo.m3u8\n';
const metadata = () => ({ id: 'internal-id-456', token: 'syntheticFile123', name: 'Synthetic.Movie.1080p.mkv',
  mimeType: 'video/x-matroska', size: 4000000000, status: 'READY', videoAsset: {
    qualities: [{ quality: '720p', resolution: '1280x720', status: 'READY' }],
    audioTracks: [{ lang: 'ger', default: false }], subtitles: [
      { lang: 'ger', label: 'GER', url: `${api}/public/subtitles/123?idx=0` },
      { lang: 'eng', label: 'ENG', url: `${api}/public/subtitles/123?idx=1` },
    ],
  }, videoSettings: { defaultAudioLanguage: 'en', defaultSubtitlesLanguage: 'en' } });

function fixture(data: unknown = metadata(), assign: unknown = { url: 'https://streaming-de-3.flyfile.app', token: 'synthetic-token' }) {
  const calls: string[] = [];
  const fetcher: FetchImplementation = async (url, options) => {
    calls.push(url);
    assert.equal(options?.headers?.Cookie, undefined);
    assert.equal(options?.headers?.['x-flyfile-host'], 'flyfile.app');
    const body = url === `${api}/public/file/syntheticFile123` ? data
      : url === `${api}/streaming/assign/syntheticFile123` ? assign : url === master ? hls : undefined;
    if (body === undefined) throw new Error('Unexpected fixture request');
    return { status: 200, url, headers: { get: () => null }, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
  };
  return { http: createHttpClient(fetcher), calls };
}

test('FlyFile uses public token identity, actual adaptive quality and published sidecars without cookies', async () => {
  const { http, calls } = fixture();
  const result = await resolveFlyfile(http, embed, source);
  assert.equal(result.url, master);
  assert.equal(result.quality, '720p', 'the filename is not the adaptive stream resolution');
  assert.doesNotMatch(result.title, /1080p/, 'upload quality must not become a false title-based badge');
  assert.equal(result.language, 'de', 'default language is not an audio-track declaration');
  assert.deepEqual(result.subtitles?.map(item => item.language), ['de', 'en']);
  assert.equal(result.subtitles?.[0]?.headers?.Referer, embed);
  assert.equal(result.size, undefined, 'the original 4 GB file size is not the adaptive stream size');
  assert.deepEqual(calls, [`${api}/public/file/syntheticFile123`, `${api}/streaming/assign/syntheticFile123`, master]);
});

test('FlyFile refuses mismatched identities, malformed assignments and invalid subtitle metadata', async () => {
  const wrong = metadata(); wrong.token = 'differentFile123';
  const first = fixture(wrong);
  await assert.rejects(resolveFlyfile(first.http, embed, source), ProviderError);
  assert.equal(first.calls.length, 1);
  for (const assign of [null, { url: 'https://outside.example.invalid', token: 'synthetic-token' },
    { url: 'https://streaming-de-3.flyfile.app', token: '../another' },
    { url: 'https://streaming-de-3.flyfile.app?unexpected=1', token: 'synthetic-token' }]) {
    await assert.rejects(resolveFlyfile(fixture(metadata(), assign).http, embed, source), ProviderError);
  }
  const invalid = metadata(); invalid.videoAsset.subtitles[0]!.url = 'javascript:fixture';
  await assert.rejects(resolveFlyfile(fixture(invalid).http, embed, source), ProviderError);
});

test('FlyFile supports the published raw fallback without reading media bytes', async () => {
  const data = metadata(); data.videoAsset.qualities = []; data.videoAsset.audioTracks = [];
  const { http, calls } = fixture(data);
  const result = await resolveFlyfile(http, embed, source);
  assert.equal(result.url, 'https://streaming-de-3.flyfile.app/raw/synthetic-token');
  assert.equal(result.language, undefined);
  assert.equal(result.quality, undefined);
  assert.equal(calls.length, 2);
});

test('FlyFile recognizes only its verified player routes and bounds redirect identities', async () => {
  assert.equal(isFlyfileUrl(embed), true);
  assert.equal(isFlyfileUrl('https://flyfile.app/e/syntheticFile123'), true);
  for (const value of ['https://outside.example.invalid/v/syntheticFile123', `${embed}?extra=1`, 'https://flyfile.app/login']) {
    assert.equal(isFlyfileUrl(value), false);
  }
  for (const contentRedirect of [embed, 'https://outside.example.invalid/v/syntheticFile123']) {
    const { http, calls } = fixture({ contentRedirect });
    await assert.rejects(resolveFlyfile(http, embed, source), ProviderError);
    assert.equal(calls.length, 1);
  }
});
