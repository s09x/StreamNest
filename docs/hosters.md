# Hoster coverage and verification

StreamNest uses five of the six hoster families found in the inspected Filmpalast
movie and episode pages, and both hosters found in the inspected Filmo pages.
einschalten additionally uses DoodStream's published MP4 route with HTTP/2.
VIDARA is deliberately excluded from Filmpalast since 0.1.4 at the user's request.
This is a dated source census, not a claim that upstream sites cannot add hosters.

| Source / hoster | Native path | Observed result on 2026-09-13 |
| --- | --- | --- |
| einschalten / DoodStream | Movie/watch API, same-file redirect from `vide0.net` to `playmogo.com`, published `pass_md5` data and `makePlay` URL construction | HTTP/2 with the tested complete User-Agent resolved Inception, Doctor Strange 2 and Matrix; bounded MP4 and seek-range checks returned HTTP 206. See the [transport verification](verification.md#einschalten-integration). |
| Filmpalast / VOE | Published player data and its normal redirects | Some sampled files resolve; the Doctor Strange 2 file returns 404 in both regular and embed forms. |
| Filmpalast / VIDARA | Intentionally ignored, including `odysseusa.cc` and `vidaraa.cc`; no hoster requests | Earlier adapter checks resolved sample files. Those historical results do not make this an offered mirror in 0.1.4. |
| Filmpalast / Vixeo | Both `vidsonic.net` and `vixeo.io` layouts; identity-bound Base64/hex data | Both layouts produced valid HLS. A media playlist without a resolution declaration does not produce an invented quality label. |
| Filmpalast / FireStream | Read `data-player-url`, follow the declared host, parse `video-data` / `token-blob`, POST the normal resolve request | Inception, GoT S06E10 and Fallout S01E01 produced HLS. Fallout publishes a valid German WebVTT sidecar. |
| Filmpalast / FlyFile | Public file metadata followed by the normal streaming assignment | Doctor Strange 2 produced an adaptive master and German/English sidecars. Its delivered master is 720p even though the upload filename contains 1080p. |
| Filmpalast / Playmate | Published `/api/s` mapping, echoed file identity and HLS validation | The sampled Fallout API works, but its `oibusq.store` CDN zone returns an explicit Cloudflare service restriction. The resolver rejects that media response while preserving other hosters. |
| Filmo / VOE | Fresh source cookies/CSRF, normal mint and controlled token redirect | Movie resolution succeeds on hosts that honor manual redirects. Cookies must be removed before leaving Filmo. |
| Filmo / Byse | Same-origin HTML handoff, normal server attestation, automatic proof, authenticated playback data | The normal Doctor Strange 2 protocol produced a valid HLS master with English/German audio; native runtime requirements and computation limits below still apply. |
| HDFilme / VOE | The embedded MeineCloud movie player, public VOE data, and HLS validation | Vaiana (2026) returned a 720p HLS master through the built adapter and original Enhanced 0.4.14 JavaScript bindings. Its audio language was undetermined. |
| MegaKino / VOE (Vega) | Direct page/episode `data-link`, public VOE redirects and data, then HLS validation | Die 5. Welle and Eine andere Liebe als deine S01E01 returned 720p HLS. Their audio language was declared `und`. The sampled older Doctor Strange 2 and Fallout S02E01 files returned 404. |
| MegaKino / FireStream (Orion) | Direct `data-link`, public video data and resolve POST, then HLS validation | Die 5. Welle returned a valid media playlist. It did not declare dimensions or audio groups, so no quality tier or language inventory is invented. |

## einschalten and DoodStream

The movie API returns a DoodStream embed URL and an upload release label. The
resolver accepts the observed `vide0.net`, `playmogo.com` and `doodstream.com`
aliases, verifies the same public file code after redirects, and reads the
player's `pass_md5` endpoint and matching `makePlay` token as data. The endpoint
must remain on the final embed origin. An explicit `RELOAD` response permits
one fresh player lookup; a second reload fails within the request budget.

The returned media prefix is validated before applying the player's ordinary
ten-character suffix and timestamp. Each lookup obtains fresh data. The complete
User-Agent and final embed Referer are retained for playback. Normal discovery
does not fetch the MP4. The opt-in `--verify-media mp4` diagnostic reads at most
two KiB to check the file header and a separate byte range.

HTTP/2 and the complete User-Agent were both necessary in the observed comparison.
The adapter uses the native client's transport; it does not execute Cloudflare
or hoster scripts or depend on a borrowed browser cookie. See
[native requirements](native-compatibility.md#einschalten).

Upload labels can describe a source file before DoodStream transcodes it. The
provider therefore returns the movie title and explicitly named release
languages, with no inferred quality tier, codec or second language from `DL`.
The player's empty Spanish subtitle placeholder is not exposed as a subtitle.

## MegaKino mirrors

MegaKino's adapter resolves the direct VOE and FireStream links published in a
verified movie or episode page. The site's visible names are Vega and Orion;
hoster URLs determine the resolver because older HTML IDs still say
`doodstream` for VOE links. Only links in the requested episode row are used.

The inspected Inception Sirius/MeineCloud player led to Dropload (Turnstile),
Supervideo (Cloudflare block), and an unavailable Mixdrop file. Direct sampled
Streamtape files were missing, and Doodstream redirected to a Cloudflare
challenge. These paths, VIDARA/Polaris and trailers are not offered by this
adapter. A missing supported mirror does not prevent another supported mirror
from resolving. If all offered mirrors fail, the failure remains explicit.

MegaKino reuses the existing three-worker mirror resolver, with stable source
order and duplicate suppression. It checks VOE HLS playlists as well as the
FireStream playlists checked by that resolver. Published external subtitles and
playback headers are retained. Source scripts, video segments and encryption
keys are not fetched for playback discovery.

## HDFilme's embedded movie player

HDFilme `.cafe` embeds the public `meinecloud.click/movie/<IMDb ID>` page. Its
published script decodes a single Base64 layer from `._source_list` mirror rows
and places the destination in the player iframe. StreamNest parses those rows
as data, verifies the returned page's IMDb identity, and resolves supported VOE
mirrors without executing the site's JavaScript. At most three mirrors run
concurrently; malformed or failed alternatives cannot suppress a working one.

Vaiana (2026) produced a valid VOE HLS master with 1280x720 video. Its language
was declared `und`, which remains undetermined. This adapter checks the actual
HLS playlist for dimensions and audio groups. It keeps the adaptive master,
playback headers and any source-published external subtitles.

The sampled Dropload/`dr0pstream.com` routes required Turnstile, Doodstream
redirected to a Cloudflare challenge, Supervideo returned a Cloudflare block,
and the sampled Mixdrop files were unavailable. Those hosters are not requested
by this provider. The inspected series route supplied Dropload episode links;
no accepted native series playback path was established. Missing movies and
movies without supported mirrors return no streams; failures of all offered
VOE mirrors remain explicit errors. No video segments or encryption keys are
downloaded during discovery.

## Byse's normal client protocol

Filmo's Byse mint URL returns HTTP 200 HTML with an explicit `a.open` link. The
link uses `noreferrer`; the provider starts a clean hoster context and never sends
Filmo cookies, CSRF values or its mint token to Byse.

Byse can publish a separate embed frame in its details. StreamNest follows that
declared frame with the matching public video code and the parent context used
by the site's own player. The ordinary access sequence is:

1. Generate a fresh P-256 key for a single challenge signature.
2. Request the source's access challenge and sign its exact nonce with
   ECDSA/SHA-256. Send the public key, signature and actually available client
   attributes to the normal attestation endpoint.
3. Use the returned attestation in the source's automatic proof-of-work flow.
   An actual image challenge is not treated as a successful automatic proof.
4. Submit the verified token and attestation to the playback POST.
5. Authenticate/decrypt the source-provided AES-GCM envelope, then validate its
   HLS playlist and published subtitle data.

No borrowed identity, fabricated browser telemetry, external solver service,
private account key, player-script execution or hosted StreamNest service is used.
Private signing keys are single-use and are not saved. A cryptographically secure
randomness API is required; `Math.random` is not a substitute.

Proof computation is limited to 20 seconds and 1,048,576 attempts. The optimized
solver was substantially faster in V8 than in the QuickJS WASM test harness;
neither is a physical iPhone benchmark. A difficult challenge on a slow runtime
can still exhaust the budget. Duplicate Filmo language rows that point to the
same Byse file share one resolution within a lookup.

The portable P-256 fallback uses `elliptic` 6.6.1, for which npm reports the
low-severity [GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84)
and offers no patched version. This use is limited to a fresh ephemeral key and
one challenge signature; it does not handle Xtream credentials or persistent
account signing keys. Independent Node crypto verification tests check the
signatures. This scope is not a claim that the dependency advisory is fixed.

## Metadata and failure handling

HLS masters are retained with their original adaptive renditions and audio graph.
Only manifests are read during stream discovery; resolvers do not download video
segments or encryption keys. Adapters that inspect the HLS playlist use its
declared dimensions instead of an original upload's filename or byte size. The
shared VOE decoder initially reports source-declared player-title quality;
HDFilme and MegaKino replace that value with the checked HLS dimensions.

Known standard heights produce values such as `720p`. Nonstandard dimensions such
as `1920x800` remain explicit dimensions. A default audio-language setting does
not declare an audio-track inventory. Published labels such as `German (FORCED)`
retain their display text and use the normalized language code `de`.

At most three hoster requests are resolved concurrently. Identity matching remains
case-sensitive where the source uses case-sensitive file codes. A blocked, expired
or malformed mirror cannot suppress successful alternatives or become a fake
playable result. See [verification](verification.md) and
[client compatibility](native-compatibility.md) for the boundaries of testing.
