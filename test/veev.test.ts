import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVeevLzw, decodeVeevValue, extractVeevKey, isVeevUrl, resolveVeev, veevDecodePlan } from '../src/native/veev.js';
import { createHttpClient } from '../src/native/http.js';
import { ProviderError } from '../src/native/errors.js';
import { PLAYER_USER_AGENT } from '../src/native/hoster-http.js';
import { compressVeev, encodeVeev, veevApiUrl, veevCode, veevInfo, veevKey, veevPage, veevPageUrl, veevPlan } from './helpers/veev-fixture.js';
import type { RequestOptions } from '../src/native/types.js';

function setup(info: unknown = veevInfo(), document = veevPage()) {
  const calls: Array<{ url: string; options: RequestOptions }> = [];
  const http = createHttpClient(async (url, options = {}) => {
    calls.push({ url, options });
    let body: string;
    if (url === veevPageUrl) body = document;
    else if (url === veevApiUrl) body = JSON.stringify(info);
    else if (url === 'https://media.example.invalid/master.m3u8') body = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x536\nvideo.m3u8\n';
    else if (url === 'https://veev.to/captions.json') body = JSON.stringify([{ src: '/en.vtt', srcLang: 'eng', label: 'English' }]);
    else throw new Error('Unexpected fixture request');
    return { status: 200, url, text: async () => body, headers: { get: () => null } };
  });
  return { http, calls };
}
const failure = (code: string) => (error: unknown) => error instanceof ProviderError && error.code === code;

test('Veev validates both observed file-code lengths and refuses lookalikes, credentials and fragments', () => {
  for (const id of [veevCode, 'a'.repeat(38)]) assert.equal(isVeevUrl(`https://veev.to/e/${id}`), true);
  for (const url of ['https://veev.to.attacker.invalid/e/Fixture12345', 'https://secret@veev.to/e/Fixture12345',
    'https://veev.to:444/e/Fixture12345', veevPageUrl + '#another', 'https://veev.to/login']) assert.equal(isVeevUrl(url), false);
});

test('Veev data decoding retains Unicode and signed queries through independent compression fixtures', () => {
  const value = 'https://media.example.invalid/über.mp4?token=one%2Btwo&lang=de';
  assert.equal(decodeVeevLzw(compressVeev('TOBEORNOTTOBEORTOBEORNOT')), 'TOBEORNOTTOBEORTOBEORNOT');
  assert.equal(decodeVeevValue(encodeVeev(value, veevPlan[0]!), veevPlan[0]!), value);
  assert.deepEqual(veevDecodePlan(veevKey), veevPlan);
});

test('Veev uses the final bootstrap key, including its opaque suffix, without executing decoys or scripts', () => {
  assert.equal(extractVeevKey(veevPage()), veevKey);
  assert.equal((globalThis as Record<string, unknown>).veevMustNotExecute, undefined);
  assert.throws(() => extractVeevKey('<script>window._vvto={fc:"synthetic-decoy"};</script>'), ProviderError);
  assert.throws(() => extractVeevKey('<script>window._vvto.fc=readSecret();</script>'), ProviderError);
});

test('Veev rejects malformed compression, plans and hex instead of exposing encrypted payloads', () => {
  for (const value of ['', '\u0200', 'a\u0400', ['wrong']]) assert.throws(() => decodeVeevLzw(value), ProviderError);
  for (const value of ['123', '3abc0', '0', '1'.repeat(1025)]) assert.throws(() => veevDecodePlan(value), ProviderError);
  for (const value of ['g', '123', 'ff']) assert.throws(() => decodeVeevValue(compressVeev(value), [0]), ProviderError);
});

test('Veev returns every video variant with its declared height and retained subtitle headers', async () => {
  const fixture = setup();
  const streams = await resolveVeev(fixture.http, veevPageUrl, 'https://huhu.to/', 'Verified movie');
  assert.deepEqual(streams.map(stream => [stream.url, stream.quality]), [
    ['https://media.example.invalid/720.mp4?fixture=one%2Btwo', '720p'],
    ['https://media.example.invalid/1080.mp4?fixture=one%20two', '1080p'],
  ]);
  assert.ok(streams.every(stream => stream.title === 'Verified movie'));
  assert.equal(streams[0]!.subtitles?.[0]?.url, 'https://veev.to/captions/de.vtt?fixture=one%2Btwo');
  assert.equal(streams[0]!.subtitles?.[0]?.language, 'de');
  assert.equal(streams[0]!.subtitles?.[0]?.headers?.Referer, veevPageUrl);
  assert.equal(streams[0]!.headers?.['User-Agent'], PLAYER_USER_AGENT);
  assert.equal(fixture.calls.length, 2, 'No advertising, telemetry or media downloads are needed to parse the offered streams');
  assert.equal(new URL(fixture.calls[1]!.url).searchParams.get('ch'), veevKey);
});

test('Veev inspects HLS dimensions and appends the separately published caption list', async () => {
  const data = { ...veevInfo([{ url: 'https://media.example.invalid/master.m3u8', quality: '1080', type: 'application/x-mpegurl; charset=utf-8' }]) };
  const fixture = setup({ ...data, file: { ...data.file, captions_json: '/captions.json' } });
  const streams = await resolveVeev(fixture.http, veevPageUrl, 'https://huhu.to/', 'Verified movie');
  assert.equal(streams[0]!.quality, '1280x536');
  assert.deepEqual(streams[0]!.subtitles?.map(track => track.language), ['de', 'en']);
  assert.equal(fixture.calls.length, 4);
});

test('Veev distinguishes deleted files, access checks and changed identities with fixed errors', async () => {
  const valid = veevInfo();
  for (const [data, code] of [
    [{ status: 'error', code: 404, message: 'synthetic-private-value' }, 'source_unavailable'],
    [{ status: 'error', recaptcha: true }, 'source_blocked'],
    [{ status: 'error', hashcheck: true }, 'source_blocked'],
    [{ status: 'error', code: 500 }, 'request_failed'],
    [{ ...valid, file: { ...valid.file, file_code: 'Different123' } }, 'invalid_response'],
    [{ ...valid, file: { ...valid.file, disable_adb: 1 } }, 'source_blocked'],
    [{ ...valid, file: { ...valid.file, dv: [] } }, 'source_unavailable'],
  ] as const) {
    await assert.rejects(resolveVeev(setup(data).http, veevPageUrl, 'https://huhu.to/', 'Verified movie'), error => failure(code)(error)
      && !(error as Error).message.includes('synthetic-private-value'));
  }
});

test('Veev retains valid variants when another encoded source is malformed and deduplicates repeated URLs', async () => {
  const valid = veevInfo();
  const fixture = setup({ ...valid, file: { ...valid.file, dv: [{ s: 'wrong' }, ...valid.file.dv, valid.file.dv[0]] } });
  const streams = await resolveVeev(fixture.http, veevPageUrl, 'https://huhu.to/', 'Verified movie');
  assert.deepEqual(streams.map(stream => stream.quality), ['720p', '1080p']);
});

test('Veev rejects a foreign API handoff even when the response echoes a matching file code', async () => {
  const http = createHttpClient(async (url) => ({ status: 200, url: url === veevPageUrl ? url : 'https://other.example.invalid/dl',
    headers: { get: () => null }, text: async () => url === veevPageUrl ? veevPage() : JSON.stringify(veevInfo()) }));
  await assert.rejects(resolveVeev(http, veevPageUrl, 'https://huhu.to/', 'Verified movie'), failure('invalid_response'));
});
