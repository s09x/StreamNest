import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../src/native/http.js';
import { ProviderError } from '../src/native/errors.js';
import { declaredQuality, extractFilePlayer, fileHoster, resolveFileHoster } from '../src/native/file-hosters.js';
import { PLAYER_USER_AGENT, playerPage } from '../src/native/hoster-http.js';
import type { RequestOptions, TextResponse } from '../src/native/types.js';

const media = 'https://media.example.invalid/master.m3u8?token=one%2Btwo';
const master = '#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"\nhigh.m3u8\n';
function page(script: string, tail = '</body></html>') { return `<html><head><title>Player fixture</title></head><body><script>${script}</script>${tail}`; }
function packed(script: string) { return `eval(function(p,a,c,k,e,d){return p;}(${JSON.stringify(script)},36,0,''.split('|'),0,{}))`; }
function httpFixture(routes: Record<string, { body: string; status?: number; finalUrl?: string }>) {
  const calls: Array<{ url: string; options: RequestOptions }> = [];
  const http = createHttpClient(async (url, options = {}) => {
    calls.push({ url, options });
    const reply = routes[url];
    if (!reply) throw new Error('Unexpected synthetic request');
    return { status: reply.status ?? 200, url: reply.finalUrl ?? url, headers: { get: () => null }, text: async () => reply.body };
  });
  return { http, calls };
}

test('file hoster registry recognizes every observed family and published redirect aliases', () => {
  for (const [host, provider] of [['supervideo.cc', 'supervideo'], ['vidoza.net', 'vidoza'], ['mixdrop.ps', 'mixdrop'],
    ['miixdrop.top', 'mixdrop'], ['streamtape.com', 'streamtape'], ['luluvdo.com', 'lulustream'], ['filemoon.to', 'filemoon']]) {
    assert.equal(fileHoster(`https://${host}/e/Fixture12345`), provider);
  }
  assert.equal(fileHoster('https://supervideo.cc.attacker.invalid/e/Fixture12345'), undefined);
  assert.equal(fileHoster('https://secret@supervideo.cc/e/Fixture12345'), undefined);
});

test('source qualities preserve explicit numeric tiers without turning generic HD into invented pixels', () => {
  assert.deepEqual(['1080p', '800p', '720', '2160', '4K', 'HD', 'SD', '1080p CAM'].map(declaredQuality),
    ['1080p', '800p', '720p', '2160p', '2160p', undefined, undefined, undefined]);
});

test('Vidoza exposes all declared sources with their exact signed URLs and quality metadata', async () => {
  const url = 'https://vidoza.net/embed-Fixture12345.html';
  const low = 'https://media.example.invalid/low.mp4?fixture=one%2Btwo';
  const high = 'https://media.example.invalid/high.mp4?fixture=one%20two';
  const fixture = httpFixture({ [url]: { body: page(`var config={sourcesCode:[{src:'${low}',type:'video/mp4',label:'SD',res:'480'}, {src:'${high}',type:'video/mp4',res:'1080'}]};`) } });
  const streams = await resolveFileHoster(fixture.http, url, 'https://huhu.to/', 'Fixture movie');
  assert.deepEqual(streams.map(stream => [stream.url, stream.quality]), [[low, '480p'], [high, '1080p']]);
  assert.equal(fixture.calls.length, 1, 'Discovery does not download the MP4 files');
  assert.equal(streams[0]!.headers?.['User-Agent'], PLAYER_USER_AGENT);
  assert.equal(streams[0]!.headers?.Referer, url);
});

test('Supervideo supports complete scripts with optional HTML end tags and measures HLS quality', async () => {
  const url = 'https://supervideo.cc/Fixture12345';
  const script = `jwplayer('vplayer').setup({sources:[{file:'${media}',label:'720p'}],tracks:[{file:'/de.vtt',kind:'captions',label:'German (FORCED)'}]});`;
  const fixture = httpFixture({ [url]: { body: page(packed(script), '') }, [media]: { body: master } });
  const streams = await resolveFileHoster(fixture.http, url, 'https://huhu.to/', 'Fixture movie');
  assert.equal(streams[0]!.quality, '1080p');
  assert.equal(streams[0]!.subtitles?.[0]?.language, 'de');
  assert.equal(streams[0]!.subtitles?.[0]?.name, 'German (FORCED)');
  assert.equal(streams[0]!.subtitles?.[0]?.url, 'https://supervideo.cc/de.vtt');
});

test('Mixdrop follows its same-file frame and current alias while preserving playback headers', async () => {
  const url = 'https://mixdrop.ps/f/Fixture12345';
  const watch = 'https://miixdrop.top/f/Fixture12345';
  const embed = 'https://miixdrop.top/e/Fixture12345';
  const mp4 = '//media.example.invalid/mixdrop.mp4?fixture=one%2Btwo';
  const fixture = httpFixture({ [url]: { finalUrl: watch, body: '<html><body><iframe src="/e/Fixture12345"></iframe></body></html>' },
    [embed]: { body: page(`MDCore.wurl=${JSON.stringify(mp4)};`) } });
  const streams = await resolveFileHoster(fixture.http, url, 'https://huhu.to/', 'Fixture');
  assert.equal(streams[0]!.url, 'https:' + mp4);
  assert.equal(streams[0]!.headers?.Referer, embed);
  assert.equal(fixture.calls[1]!.options.headers?.Referer, watch);
});

test('Lulu download pages use the actual player frame instead of preview sources', async () => {
  const url = 'https://luluvdo.com/d/Fixture12345';
  const embed = 'https://luluvdo.com/e/Fixture12345';
  const fixture = httpFixture({
    [url]: { body: page(`jwplayer('preview').setup({sources:[{file:'https://media.example.invalid/preview.m3u8'}]});`)
      .replace('</body>', `<iframe src="${embed}"></iframe></body>`) },
    [embed]: { body: page(`jwplayer('vplayer').setup({sources:[{file:'${media}'}]});`, '') }, [media]: { body: master },
  });
  const streams = await resolveFileHoster(fixture.http, url, 'https://huhu.to/', 'Fixture episode');
  assert.equal(streams[0]!.url, media);
  assert.equal(streams[0]!.headers?.Referer, embed);
  assert.ok(!fixture.calls.some(call => call.url.includes('preview.m3u8')));
});

test('Streamtape decodes only the literal link expression and validates the source file identity', async () => {
  const url = 'https://streamtape.com/v/Fixture12345/title.mp4';
  const code = `document.getElementById('norobotlink').innerHTML = '//streamtape.' + ('xcdcom/get_video?id=Fixture12345&token=fixture%2Bvalue').substring(1).substring(2);`;
  const fixture = httpFixture({ [url]: { body: page(code) } });
  const streams = await resolveFileHoster(fixture.http, url, 'https://huhu.to/', 'Fixture episode');
  assert.equal(streams[0]!.url, 'https://streamtape.com/get_video?id=Fixture12345&token=fixture%2Bvalue&stream=1');
  assert.equal(fixture.calls.length, 1);
  const other = extractFilePlayer(page(code.replace('id=Fixture12345', 'id=OtherVideo12')), url, 'streamtape');
  assert.equal(other.sources.length, 0);
  assert.equal(other.failure?.code, 'invalid_response');
});

test('player parsing preserves good alternatives despite malformed scripts and failing HLS variants', async () => {
  const url = 'https://supervideo.cc/e/Fixture12345';
  const bad = 'https://media.example.invalid/deleted.m3u8';
  const fixture = httpFixture({ [url]: { body: page(`jwplayer('vplayer').setup({sources:[{file:'${bad}'},{file:'${media}'}]});`) },
    [bad]: { body: 'Gone', status: 404 }, [media]: { body: master } });
  assert.deepEqual((await resolveFileHoster(fixture.http, url, 'https://huhu.to/', 'Fixture')).map(stream => stream.url), [media]);
  const data = extractFilePlayer(page(`var sources=[{file:'https://media.example.invalid/main.mp4',res:'1080'}];`)
    .replace('</body>', `<script>eval(function(p,a,c,k,e,d){return p;}('0',99,1,'wrong'.split('|'),0,{}));</script></body>`), url, 'supervideo');
  assert.equal(data.sources.length, 1);
  assert.equal(data.sources[0]!.quality, '1080p');
  assert.equal(data.failure?.code, 'invalid_response');
});

test('unavailable, challenged, changed-file and incomplete pages produce distinct failures', async () => {
  const url = 'https://supervideo.cc/e/Fixture12345';
  for (const [reply, expected] of [
    [{ body: 'Missing', status: 404 }, 'source_unavailable'],
    [{ body: '<title>Just a moment</title>', status: 403 }, 'source_blocked'],
    [{ body: page(''), finalUrl: 'https://supervideo.cc/e/OtherVideo12' }, 'invalid_response'],
    [{ body: '<html><body><script>var source="unfinished' }, 'response_incomplete'],
    [{ body: '<html><body>File not found</body></html>' }, 'source_unavailable'],
  ] as const) {
    const fixture = httpFixture({ [url]: reply });
    await assert.rejects(resolveFileHoster(fixture.http, url, 'https://huhu.to/', 'Fixture'), error => error instanceof ProviderError && error.code === expected);
  }
  const response: TextResponse = { url, status: 200, header: () => null, text: page('') + '...[truncated]' };
  assert.throws(() => playerPage(response), ProviderError);
});
