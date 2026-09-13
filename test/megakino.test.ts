import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ProviderError } from '../src/native/errors.js';
import { createMegakinoProvider } from '../src/native/megakino.js';
import type { ContentRequest, HttpClient, Identity, NativeStream, RequestOptions } from '../src/native/types.js';
import { createNativeRuntime, type FixtureRoute } from './helpers/native-runtime.js';

const origin = 'https://7megakino.lol';
const searchUrl = `${origin}/index.php?do=search`;
const detail = `${origin}/1001-fixture-film.html`;
const voe = 'https://voe.sx/e/fixture12345';
const firestream = 'https://firestream.site/e/Fixture123';
const media = 'https://media.example.invalid/movie.m3u8?fixture=one%2Btwo';
const identity: Identity = { type: 'movie', title: 'Inception', aliases: ['Inception'], year: 2010, imdbId: 'tt1375666', tmdbId: '27205' };
const request: ContentRequest = { type: 'movie', id: 'tt1375666', imdbId: 'tt1375666' };
const seriesIdentity: Identity = { type: 'tv', title: 'Fallout', aliases: ['Fallout'], year: 2024, imdbId: 'tt12637874', tmdbId: '106379' };
const seriesRequest: ContentRequest = { type: 'tv', id: 'tt12637874', imdbId: 'tt12637874', season: 2, episode: 1 };
const hls = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="ger",URI="de.m3u8"\n'
  + '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",URI="en.m3u8"\n'
  + '#EXT-X-STREAM-INF:RESOLUTION=1280x720,CODECS="avc1.640020,mp4a.40.2",AUDIO="audio"\nvideo.m3u8\n';

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function html(body: string, head = ''): string {
  return `<html><head><title>MegaKino fixture</title>${head}</head><body>${body}</body></html>`;
}
function route(url: string, body: string, options: Partial<FixtureRoute> = {}): FixtureRoute { return { url, body, ...options }; }
function searchPage(query: string, rows = [[identity.title, detail]], total = rows.length, start = 1): string {
  const summary = total ? `<div class="message-info message-info--yellow">Filme ${total} gefunden (Abfrageergebnisse ${start} - ${start + rows.length - 1}) :</div>` : '';
  const empty = total ? '' : '<div class="message-info"><div class="message-info__content">Die Website-Suche ergab leider keine Ergebnisse. Versuchen Sie, Ihre Anfrage zu ändern oder zu kürzen.</div></div>';
  return html(`<div id="dle-content"><div class="search-page"><form id="fullsearch"><input name="story" value="${escape(query)}"></form>${summary}</div>`
    + rows.map(([title, url]) => `<a class="poster grid-item" href="${escape(url!)}"><h4 class="poster__title">${escape(title!)}</h4></a>`).join('') + `</div>${empty}`);
}
function searchRoute(query = identity.title, rows = [[identity.title, detail]], total = rows.length, start = 1): FixtureRoute {
  return route(searchUrl, searchPage(query, rows, total, start), { method: 'POST', form: {
    do: 'search', subaction: 'search', story: query, titleonly: '3', full_search: '1', showposts: '0',
    search_start: start === 1 ? '0' : String(Math.ceil(start / 10)), result_from: String(start),
  } });
}
function episodeRow(episode: number, links = [voe], group = 1): string {
  return `<li id="serie-${group}_${episode}"><a href="#">Episoden ${episode}</a><ul>${links.map((url, index) =>
    `<li><a href="#" id="hoster${index}-${group}_${episode}" data-link="${escape(url)}">Vega</a></li>`).join('')}</ul></li>`;
}
function detailPage(options: { title?: string; year?: number; genres?: string; canonical?: string; links?: string[]; episodes?: string; imdb?: string; depth?: number } = {}): string {
  const title = options.title ?? identity.title; const year = options.year ?? identity.year;
  const deep = (text: string) => '<i>'.repeat(options.depth ?? 0) + text + '</i>'.repeat(options.depth ?? 0);
  const player = options.episodes === undefined
    ? `<div class="pmovie__player"><div class="tabs-block__select">${(options.links ?? [voe]).map(url => `<span data-link="${escape(url)}">Vega</span>`).join('')}</div></div>`
    : `<div id="dle-player-wrap"><div class="pmovie__player"><ul class="ep-menu">${options.episodes}</ul></div></div>`;
  return html(`<div id="dle-content"><article class="page pmovie"><header class="page__subcol-main"><h2>${deep(escape(title))}</h2>`
    + `<div class="pmovie__year">United States, ${year}, 120 min</div><div class="pmovie__genres">${deep(options.genres ?? 'Kinofilme / Action')}</div></header>`
    + `<div class="pplayer-holder">${player}${options.imdb ? `<script>(function(){var imdb = '${options.imdb}'.replace('tt',''); fetch('https://meinecloud.click/serials.php?task=check'); document.getElementById('mc-serial-iframe');})();</script>` : ''}</div>`
    + '<script>throw new Error("Source scripts must not execute")</script></article></div>',
  `<link rel="canonical" href="${escape(options.canonical ?? detail)}">`);
}
function encodedVoe(config: unknown): string {
  const inner = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  const shifted = [...inner].reverse().map(letter => String.fromCharCode(letter.charCodeAt(0) + 3)).join('');
  return Buffer.from(shifted, 'latin1').toString('base64').replace(/[A-Za-z]/g, letter => {
    const first = letter <= 'Z' ? 65 : 97;
    return String.fromCharCode(first + (letter.charCodeAt(0) - first + 13) % 26);
  });
}
function voeRoutes(url = voe, source = media): FixtureRoute[] {
  return [route(url, html(`<script type="application/json">${JSON.stringify([encodedVoe({ source,
    title: 'Synthetic.Upload.1080p.HEVC.mp4', default_audio_language: 'sq',
    captions: [{ file: '//subs.example.invalid/de.vtt?fixture=a%2Bb', language: 'de', label: 'German (FORCED)' }],
  })])}</script>`)), route(source, hls)];
}
function firestreamRoutes(): FixtureRoute[] {
  return [route(firestream, html(`<script id="video-data" type="application/json">${JSON.stringify({ video: {
    slug: 'Fixture123', encodingStatus: 'completed', transferStatus: 'completed', signedVideoUrl: media, subtitles: [],
  } })}</script>`)), route(media, hls)];
}
function fixture(routes: FixtureRoute[], resolved: Identity | null = identity) {
  const calls: Array<{ url: string; options: RequestOptions }> = [];
  const http: HttpClient = {
    async request(url, options = {}) {
      calls.push({ url, options });
      const form = new URLSearchParams(options.body);
      const found = routes.find(item => item.url === url && (item.method ?? 'GET') === (options.method ?? 'GET')
        && Object.entries(item.form ?? {}).every(([key, value]) => form.get(key) === value));
      assert.ok(found, `Missing synthetic route: ${url}`);
      return { status: found.status ?? 200, url: found.finalUrl ?? url, text: found.body,
        header: name => found.headers?.[name.toLowerCase()] ?? null };
    },
    async json(url, options) { return JSON.parse((await this.request(url, options)).text); },
    session() { return http; }, cookies() { return {}; },
  };
  return { calls, provider: createMegakinoProvider(http, { async resolve() { return resolved; } }) };
}
function failure(code: string) { return (error: unknown) => error instanceof ProviderError && error.code === code; }

test('MegaKino excludes coming-soon and wrong-year articles, then returns actual HLS metadata and subtitles', async () => {
  const upcoming = `${origin}/1002-upcoming.html`; const remake = `${origin}/1003-remake.html`;
  const f = fixture([
    searchRoute('Inception', [['Inception', upcoming], ['Inception', remake], ['Inception', detail], ['Inception sequel', `${origin}/1004-sequel.html`]]),
    route(upcoming, detailPage({ genres: 'Demnächst im kino / Action', canonical: upcoming, links: ['https://www.youtube.com/embed/fixture'] })),
    route(remake, detailPage({ year: 2012, canonical: remake })), route(detail, detailPage()), ...voeRoutes(),
  ]);
  const [stream] = await f.provider.getStreams(request);
  assert.equal(stream?.url, media);
  assert.equal(stream.quality, '720p');
  assert.equal(stream.language, 'de / en');
  assert.match(stream.title, /Inception.*1280x720.*AVC.*AAC.*VOE/);
  assert.doesNotMatch(stream.title, /1080p|HEVC/);
  assert.equal(stream.subtitles?.[0]?.url, 'https://subs.example.invalid/de.vtt?fixture=a%2Bb');
  assert.equal(stream.subtitles?.[0]?.name, 'German (FORCED)');
  assert.equal(f.calls.find(call => call.url === voe)?.options.headers?.Referer, detail);
  assert.equal(f.calls.find(call => call.url === media)?.options.headers?.Origin, 'https://voe.sx');
  assert.equal(f.calls.filter(call => call.url.includes('youtube') || call.url.includes('sequel')).length, 0);
});

test('MegaKino searches both verified localized aliases and fetches their shared detail only once', async () => {
  const localized = { ...identity, title: 'Die 5. Welle', aliases: ['Die 5. Welle', 'The 5th Wave', 'THE 5TH WAVE'] };
  const f = fixture([searchRoute(localized.title, [[localized.title, detail]]), searchRoute('The 5th Wave', []),
    route(detail, detailPage({ title: localized.title })), ...voeRoutes()], localized);
  assert.equal((await f.provider.getStreams(request)).length, 1);
  assert.equal(f.calls.filter(call => call.url === searchUrl).length, 2);
  assert.equal(f.calls.filter(call => call.url === detail).length, 1);
});

test('MegaKino finds numbered German titles when DLE exact-word search would return no results', async () => {
  const localized = { ...identity, title: 'Die 5. Welle', aliases: ['The 5th Wave'] };
  const normal = searchRoute(localized.title, [[localized.title, detail]]);
  const exactWords = { ...normal, form: { ...normal.form, all_word_seach: '1' }, body: searchPage(localized.title, []) };
  const f = fixture([exactWords, normal, searchRoute('The 5th Wave', []),
    route(detail, detailPage({ title: localized.title })), ...voeRoutes()], localized);
  assert.equal((await f.provider.getStreams(request)).length, 1);
});

test('MegaKino retries a rejected short-word alias as a complete phrase without losing the verified localized match', async () => {
  const original = '너 말고 다른 연애';
  const localized = { ...identity, aliases: [original] };
  const rejected = searchPage(original, []).replace('Die Website-Suche ergab leider keine Ergebnisse.',
    'Suche ist ausgesetzt! Die Suchzeichenfolge ist leer oder enthält weniger als 4 Zeichen.');
  const fallback = searchRoute(original, []);
  const f = fixture([searchRoute(), { ...fallback, form: { ...fallback.form, all_word_seach: '1' } },
    { ...fallback, body: rejected }, route(detail, detailPage()), ...voeRoutes()], localized);
  assert.equal((await f.provider.getStreams(request)).length, 1);
  assert.equal(f.calls.filter(call => call.url === searchUrl).length, 3);
});

test('MegaKino does not report an empty successful lookup when every source query is rejected', async () => {
  const title = 'It';
  const rejected = searchPage(title, []).replace('Die Website-Suche ergab leider keine Ergebnisse.',
    'Suche ist ausgesetzt! Die Suchzeichenfolge ist leer oder enthält weniger als 4 Zeichen.');
  const f = fixture([{ ...searchRoute(title, []), body: rejected }], { ...identity, title, aliases: [title] });
  await assert.rejects(f.provider.getStreams(request), failure('request_failed'));
  assert.equal(f.calls.length, 2);
});

test('MegaKino follows reported search pagination before resolving a match on page two', async () => {
  const other = Array.from({ length: 10 }, (_, index) => [`Other film ${index}`, `${origin}/${2000 + index}-other.html`]);
  const f = fixture([searchRoute('Inception', other, 11), searchRoute('Inception', [['Inception', detail]], 11, 11),
    route(detail, detailPage()), ...voeRoutes()]);
  assert.equal((await f.provider.getStreams(request)).length, 1);
  assert.deepEqual(f.calls.filter(call => call.url === searchUrl).map(call => new URLSearchParams(call.options.body).get('result_from')), ['1', '11']);
});

test('MegaKino requires complete, stable search pages and keeps excessive candidate sets explicit', async () => {
  const others = Array.from({ length: 10 }, (_, index) => [`Other ${index}`, `${origin}/${2000 + index}-other.html`]);
  for (const broken of [searchPage('Inception', [['Inception', detail]], 12, 11), searchPage('Inception', others, 11),
    searchPage('Inception', [others[0]!], 11, 11), searchPage('Inception', [], 11, 11)]) {
    const second = searchRoute('Inception', [['Inception', detail]], 11, 11);
    const f = fixture([searchRoute('Inception', others, 11), { ...second, body: broken }]);
    await assert.rejects(f.provider.getStreams(request), failure('response_incomplete'));
    assert.equal(f.calls.length, 2);
  }
  const broad = fixture([searchRoute('Inception', others, 101)]);
  await assert.rejects(broad.provider.getStreams(request), failure('response_incomplete'));
  const many = fixture([searchRoute('Inception', Array.from({ length: 9 }, (_, i) => ['Inception', `${origin}/${3000 + i}-match.html`]))]);
  await assert.rejects(many.provider.getStreams(request), failure('ambiguous_match'));
  assert.equal(many.calls.length, 1);
});

test('MegaKino distinguishes an explicit empty search from stale, blocked, malformed and truncated pages', async () => {
  const empty = fixture([searchRoute('Inception', [])]);
  assert.deepEqual(await empty.provider.getStreams(request), []);
  for (const [body, status, code] of [
    [searchPage('Other title'), 200, 'invalid_response'], [html('<div id="dle-content"></div>'), 200, 'invalid_response'],
    [searchPage('Inception').replace('</html>', ''), 200, 'response_incomplete'],
    ['<html><title>Just a moment...</title></html>', 403, 'source_blocked'], [html('Unavailable'), 503, 'request_failed'],
  ] as const) {
    const f = fixture([{ ...searchRoute(), body, status }]);
    await assert.rejects(f.provider.getStreams(request), failure(code));
    assert.equal(f.calls.length, 1);
  }
});

test('MegaKino rejects unsafe detail links and cross-origin search responses before fetching details', async () => {
  for (const url of ['https://unrelated.example.invalid/1001-fixture.html', `${origin}/1001-fixture.html#fragment`,
    `${origin}/1001-fixture.html?query=1`, 'https://synthetic:private@7megakino.lol/1001-fixture.html']) {
    const f = fixture([searchRoute('Inception', [['Inception', url]])]);
    await assert.rejects(f.provider.getStreams(request), failure('invalid_response'));
    assert.equal(f.calls.length, 1);
  }
  const redirected = fixture([{ ...searchRoute(), finalUrl: 'https://unrelated.example.invalid/' }]);
  await assert.rejects(redirected.provider.getStreams(request), failure('invalid_response'));
});

test('MegaKino checks detail identity, final URLs and canonical IDs before hoster requests', async () => {
  for (const [body, finalUrl, code] of [
    [detailPage({ canonical: `${origin}/9999-other.html` }), detail, 'invalid_response'],
    [detailPage(), `${origin}/9999-other.html`, 'invalid_response'],
    [detailPage({ canonical: 'https://unrelated.example.invalid/1001-fixture.html' }), detail, 'invalid_response'],
    [detailPage().replace('2010,', 'unknown,'), detail, 'invalid_response'],
  ]) {
    const f = fixture([searchRoute(), route(detail, body!, { finalUrl })]);
    await assert.rejects(f.provider.getStreams(request), failure(code!));
    assert.equal(f.calls.length, 2);
  }
  for (const options of [{ title: 'Different film' }, { year: 2011 }, { genres: 'Serien' },
    { links: [voe, 'https://meinecloud.click/movie/tt0000001'] }]) {
    const f = fixture([searchRoute(), route(detail, detailPage(options))]);
    assert.deepEqual(await f.provider.getStreams(request), []);
    assert.equal(f.calls.length, 2);
  }
});

test('MegaKino rejects multiple current exact matches instead of choosing the first', async () => {
  const other = `${origin}/1002-other.html`;
  const f = fixture([searchRoute('Inception', [['Inception', detail], ['Inception', other]]),
    route(detail, detailPage()), route(other, detailPage({ canonical: other }))]);
  await assert.rejects(f.provider.getStreams(request), failure('ambiguous_match'));
  assert.equal(f.calls.length, 3);
});

test('MegaKino uses the page season and exact episode rather than the reset list prefix or misleading hoster label', async () => {
  const firstSeason = `${origin}/1002-season-one.html`; const adjacent = 'https://voe.sx/e/adjacent1234';
  const f = fixture([searchRoute('Fallout', [['Fallout - Staffel 1', firstSeason], ['Fallout - Staffel 2', detail], ['The Fallout', `${origin}/1003-movie.html`]]),
    route(detail, detailPage({ title: 'Fallout - Staffel 2', year: 2024, genres: 'Serien / Action',
      episodes: episodeRow(2, [adjacent]) + episodeRow(1), imdb: seriesIdentity.imdbId })), ...voeRoutes()], seriesIdentity);
  const streams = await f.provider.getStreams(seriesRequest);
  assert.equal(streams.length, 1);
  assert.match(streams[0]!.title, /Fallout - Staffel 2/);
  assert.equal(f.calls.filter(call => [firstSeason, adjacent].includes(call.url) || call.url.includes('meinecloud')).length, 0);
});

test('MegaKino rejects conflicting episode coordinates and returns empty only for an absent episode', async () => {
  for (const [episodes, code] of [
    [episodeRow(1) + episodeRow(1), 'ambiguous_match'], [episodeRow(1).replace('Episoden 1', 'Episoden 2'), 'invalid_response'],
    [episodeRow(1).replace('hoster0-1_1', 'hoster0-1_2'), 'invalid_response'], [episodeRow(1, [voe], 2), 'invalid_response'],
  ]) {
    const f = fixture([searchRoute('Fallout', [['Fallout - Staffel 2', detail]]),
      route(detail, detailPage({ title: 'Fallout - Staffel 2', year: 2024, genres: 'Serien', episodes }))], seriesIdentity);
    await assert.rejects(f.provider.getStreams(seriesRequest), failure(code!));
    assert.equal(f.calls.length, 2);
  }
  for (const options of [{ episodes: episodeRow(2) }, { episodes: episodeRow(1), imdb: 'tt0000001' },
    { episodes: episodeRow(1), year: 2025 }, { episodes: episodeRow(1), title: 'Fallout - Staffel 1' }]) {
    const f = fixture([searchRoute('Fallout', [['Fallout - Staffel 2', detail]]),
      route(detail, detailPage({ title: 'Fallout - Staffel 2', year: 2024, genres: 'Serien', ...options }))], seriesIdentity);
    assert.deepEqual(await f.provider.getStreams(seriesRequest), []);
  }
});

test('MegaKino ignores trailers, unsupported hosts and malformed links without requesting them', async () => {
  const f = fixture([searchRoute(), route(detail, detailPage({ links: ['https://meinecloud.click/movie/tt1375666',
    'https://vidara.to/e/Fixture123', 'https://odysseusa.cc/e/Fixture123', 'https://vidaraa.cc/e/Fixture123',
    'https://supervideo.cc/embed-fixture12345.html', 'https://dood.to/e/fixture12345', 'https://mixdrop.ag/e/fixture12345',
    'https://streamtape.com/e/Fixture12345', 'https://www.youtube.com/embed/fixture', 'javascript:throw new Error()',
    'https://synthetic:private@voe.sx/e/fixture12345', `${voe}#fragment`,
  ] }))]);
  assert.deepEqual(await f.provider.getStreams(request), []);
  assert.equal(f.calls.length, 2);
});

test('MegaKino deduplicates equivalent VOE links and preserves FireStream after a deleted VOE file', async () => {
  const f = fixture([searchRoute(), route(detail, detailPage({ links: [voe, voe.replace('/e/', '/'), firestream, firestream] })),
    route(voe, html('File not found'), { status: 404 }), ...firestreamRoutes()]);
  const streams = await f.provider.getStreams(request);
  assert.equal(streams.length, 1);
  assert.match(streams[0]!.title, /FireStream/);
  assert.equal(streams[0]!.quality, '720p');
  assert.equal(f.calls.filter(call => call.url === voe).length, 1);
  assert.equal(f.calls.filter(call => call.url === firestream).length, 1);
  assert.equal(f.calls.filter(call => call.url === voe.replace('/e/', '/')).length, 0);
});

test('MegaKino keeps all-mirror failures and invalid HLS responses explicit', async () => {
  for (const [hoster, source, code] of [
    [route(voe, html('File missing'), { status: 404 }), route(media, hls), 'request_failed'],
    [route(voe, '<html><title>Attention Required</title></html>', { status: 403 }), route(media, hls), 'source_blocked'],
    [voeRoutes()[0]!, route(media, html('Not media')), 'invalid_response'],
    [voeRoutes()[0]!, route(media, hls, { status: 403 }), 'request_failed'],
  ] as const) {
    const f = fixture([searchRoute(), route(detail, detailPage()), hoster, source]);
    await assert.rejects(f.provider.getStreams(request), failure(code));
  }
});

test('MegaKino bounds mirror counts and does not infer a quality tier from upload names or source labels', async () => {
  const tooMany = fixture([searchRoute(), route(detail, detailPage({ links: Array.from({ length: 33 }, (_, i) => `https://voe.sx/e/fixture${String(i).padStart(5, '0')}`) }))]);
  await assert.rejects(tooMany.provider.getStreams(request), failure('response_incomplete'));
  assert.equal(tooMany.calls.length, 2);
  const f = fixture([searchRoute(), route(detail, detailPage()), voeRoutes()[0]!,
    route(media, '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n')]);
  const [stream] = await f.provider.getStreams(request);
  assert.equal(stream?.quality, undefined);
  assert.equal(stream?.language, undefined);
  assert.doesNotMatch(stream!.title, /1080p|HEVC/);
  assert.equal(f.calls.some(call => call.url.endsWith('segment.ts')), false);
});

test('MegaKino rejects invalid episodes and inconsistent metadata without querying the source', async () => {
  for (const input of [{ ...seriesRequest, season: undefined }, { ...seriesRequest, episode: -1 }]) {
    const f = fixture([], seriesIdentity);
    await assert.rejects(f.provider.getStreams(input), failure('invalid_request'));
    assert.equal(f.calls.length, 0);
  }
  for (const wrong of [{ ...identity, year: undefined }, { ...identity, imdbId: 'tt0000001' }, { ...identity, type: 'tv' as const }]) {
    const f = fixture([], wrong);
    await assert.rejects(f.provider.getStreams(request), failure('invalid_response'));
    assert.equal(f.calls.length, 0);
  }
  const missing = fixture([], null);
  assert.deepEqual(await missing.provider.getStreams(request), []);
  assert.equal(missing.calls.length, 0);
});

function nativeMetadata(value: Identity): FixtureRoute[] {
  const kind = value.type === 'movie' ? 'movie' : 'series';
  return [route(`https://v3-cinemeta.strem.io/meta/${kind}/${value.imdbId}.json`, JSON.stringify({ meta: {
    id: value.imdbId, imdb_id: value.imdbId, moviedb_id: Number(value.tmdbId), type: kind, name: value.title, releaseInfo: String(value.year),
  } })), route(`https://www.themoviedb.org/${value.type}/${value.tmdbId}?language=de-DE`,
  html(`<div class="title"><h2><a>${value.title}</a><span class="tag release_date">(${value.year})</span></h2></div>`,
    `<link rel="canonical" href="https://www.themoviedb.org/${value.type}/${value.tmdbId}-fixture">`))];
}

for (const mobileUrl of [false, true]) for (const series of [false, true]) {
  test(`built MegaKino resolves ${series ? 'S02E01' : 'a movie'} with a 256 KiB QuickJS stack (Mobile URL: ${mobileUrl})`, async () => {
    const code = await readFile(new URL('../providers/megakino.js', import.meta.url), 'utf8');
    const metadata = series ? seriesIdentity : identity;
    const title = series ? 'Fallout - Staffel 2' : 'Inception';
    const address = voe.replace('https:', '');
    const runtime = await createNativeRuntime(`String.prototype.matchAll = undefined;\n${code}`, { mobileUrl, maxStackSize: 256 * 1024, routes: [
      ...nativeMetadata(metadata), searchRoute(metadata.title, [[title, detail.replace('https:', '')]]),
      route(detail, detailPage({ title, year: metadata.year, genres: series ? 'Serien / Action' : 'Kinofilme', depth: 512,
        links: [address, 'https://www.youtube.com/embed/fixture'], episodes: series ? episodeRow(2, ['https://voe.sx/e/adjacent1234']) + episodeRow(1, [address]) : undefined,
        canonical: detail.replace('https:', ''), imdb: series ? seriesIdentity.imdbId : undefined })), ...voeRoutes(),
    ] });
    try {
      const result = await runtime.run(`module.exports.getStreams('${metadata.imdbId}', '${series ? 'series' : 'movie'}'${series ? ', 2, 1' : ''})`);
      assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
      if (!result.ok) return;
      const streams = result.value as NativeStream[];
      assert.equal(streams.length, 1);
      assert.equal(streams[0]!.url, media);
      assert.equal(streams[0]!.quality, '720p');
      assert.equal(streams[0]!.language, 'de / en');
      assert.equal(streams[0]!.subtitles?.[0]?.url, 'https://subs.example.invalid/de.vtt?fixture=a%2Bb');
      assert.equal(runtime.value('__requests.length'), 6);
      assert.equal(runtime.value(`__requests.some(item => /adjacent|youtube|meinecloud/.test(item.url))`), false);
      assert.equal(runtime.value('fetch === __originalHostFetch'), true);
    } finally { runtime.dispose(); }
  });
}
