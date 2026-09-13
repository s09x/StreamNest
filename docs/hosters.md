# Hoster coverage and verification

StreamNest uses five of the six hoster families found in the inspected Filmpalast
movie and episode pages, and both hosters found in the inspected Filmo pages.
Huhu supports the VOE and Vixeo/Vidsonic families returned by its MediaURL API.
VIDARA is deliberately excluded from Filmpalast since 0.1.4 at the user's request.
This is a dated source census, not a claim that upstream sites cannot add hosters.

| Source / hoster | Native path | Observed result on 2026-09-13 |
| --- | --- | --- |
| Filmpalast / VOE | Published player data and its normal redirects | Some sampled files resolve; the Doctor Strange 2 file returns 404 in both regular and embed forms. |
| Filmpalast / VIDARA | Intentionally ignored, including `odysseusa.cc` and `vidaraa.cc`; no hoster requests | Earlier adapter checks resolved sample files. Those historical results do not make this an offered mirror in 0.1.4. |
| Filmpalast / Vixeo | Both `vidsonic.net` and `vixeo.io` layouts; identity-bound Base64/hex data | Both layouts produced valid HLS. A media playlist without a resolution declaration does not produce an invented quality label. |
| Filmpalast / FireStream | Read `data-player-url`, follow the declared host, parse `video-data` / `token-blob`, POST the normal resolve request | Inception, GoT S06E10 and Fallout S01E01 produced HLS. Fallout publishes a valid German WebVTT sidecar. |
| Filmpalast / FlyFile | Public file metadata followed by the normal streaming assignment | Doctor Strange 2 produced an adaptive master and German/English sidecars. Its delivered master is 720p even though the upload filename contains 1080p. |
| Filmpalast / Playmate | Published `/api/s` mapping, echoed file identity and HLS validation | The sampled Fallout API works, but its `oibusq.store` CDN zone returns an explicit Cloudflare service restriction. The resolver rejects that media response while preserving other hosters. |
| Filmo / VOE | Fresh source cookies/CSRF, normal mint and controlled token redirect | Movie resolution succeeds on hosts that honor manual redirects. Cookies must be removed before leaving Filmo. |
| Filmo / Byse | Same-origin HTML handoff, normal server attestation, automatic proof, authenticated playback data | The normal Doctor Strange 2 protocol produced a valid HLS master with English/German audio; native runtime requirements and computation limits below still apply. |
| Huhu / VOE | Validated movie/episode identity, direct public hoster link, normal VOE redirects/data and HLS inspection | Inception and Fallout S01E01 produced valid HLS. The Inception upload label says 1080p while the delivered master is 720p; the provider reports the manifest resolution. |
| Huhu / Vixeo | Existing `vidsonic.net` / `vixeo.io` decoder and HLS inspection | Inception and Matrix produced 720p HLS through Vidsonic. |
| Huhu / other hosters | Not offered by this provider; no requests to unsupported hosters during discovery | The sampled list also contained Dood, Vidoza, Supervideo, Mixdrop, Veev, Streamtape and LuluVdo. A direct Supervideo probe returned Cloudflare 403 and the Vidoza sample returned 404. The other families were inventoried without a complete native playback check. |

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
declared dimensions instead of an original upload's filename or byte size. VOE's
existing Filmpalast/Filmo paths report source-declared player-title quality; that
field has not been independently checked against the HLS master in those paths.
Huhu additionally inspects VOE URLs ending in `.m3u8` and uses the actual HLS
resolution. If that playlist contains no resolution, the upload tier is not
reinstated. Huhu preserves source-declared language labels when neither the
manifest nor the player supplies an audio inventory; those labels do not claim
an exhaustive list of embedded tracks.

Known standard heights produce values such as `720p`. Nonstandard dimensions such
as `1920x800` remain explicit dimensions. A default audio-language setting does
not declare an audio-track inventory. Published labels such as `German (FORCED)`
retain their display text and use the normalized language code `de`.

At most three hoster requests are resolved concurrently. Identity matching remains
case-sensitive where the source uses case-sensitive file codes. A blocked, expired
or malformed mirror cannot suppress successful alternatives or become a fake
playable result. See [verification](verification.md) and
[client compatibility](native-compatibility.md) for the boundaries of testing.
