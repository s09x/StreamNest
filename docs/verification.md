# Verification

Checks below concern the native repository and generated providers. They do not
claim that a physical Nuvio application has been operated or that every title and
provider/server combination works.

## Automated checks

The 0.1.1 local check on Node.js 24.21.0 passed 136 tests. One public network test
is opt-in and remains excluded from CI. The 0.1.1 direct built-provider live checks
are recorded below. The runtime dependency audit reports one low-severity
`elliptic` advisory with no patched release; its narrowly scoped use and remaining
limitation are documented in [hoster verification](hosters.md).

`npm run check` validates TypeScript, rebuilds all provider files and the manifest,
and runs unit and QuickJS tests. The tests cover:

- ID namespaces, exact episodes, specials and conflicting input.
- Fixed errors that do not expose credentials; incomplete responses and challenges.
- Scoped source cookies and bounded observable redirects with credential-header
  isolation; final-URL validation when the native host follows redirects itself.
- Native manifest and exports from the actual generated files.
- ES2016 syntax and lowered classes for Hermes dynamic loading; the existing
  published bundle's compiler failure was reproduced before the build fix.
- Synchronous Xtream input fields for `host`, `username` and `password`.
- QuickJS without Node's `Buffer`, `require` or `process`, including isolation from
  Nuvio's global fetch function.
- German metadata aliases and validated TMDB/IMDb cross-references.
- Filmpalast/Filmo matching and all hoster families in the inspected page census.
- Source identity, bounded concurrent mirrors, deterministic order and isolation
  of failed hosters, including Doctor Strange 2's dead VOE file.
- Filmo's VOE redirect guard and Byse's independent same-origin HTML handoff.
- Genuine single-use P-256 signatures verified independently with Node/OpenSSL,
  native-RNG fallback, proof vectors, authenticated AES-GCM, and a complete built
  Filmo/Byse workflow in QuickJS without native ECDSA or Node globals.
- Original upload labels versus actual HLS dimensions, codecs and languages;
  source-published sidecars and retained forced-subtitle display labels.
- Xtream authentication, category completion, variants and detail identity checks.
- Supplemental 4K variants without catalog IDs, cross-ID detail confirmation and
  preservation of verified streams when supplemental candidates are ambiguous.
- Strict XML fallbacks, complete JSON-prefix identity properties and exact legacy
  season/episode selection.

The public live test in `test/web.test.ts` is opt-in and excluded from ordinary CI.
It was run separately during 0.1.0 development. Fixtures and CI contain no real accounts
or live signed media URLs.

All three final 0.1.1 JavaScript files also compiled successfully with the actual
Hermes 0.11.0 compiler. The web bundles produced only a nonfatal warning about a
guarded `window.Buffer` branch in `bn.js`; the executed QuickJS tests do not supply
Node's Buffer. Compiler acceptance is not a physical-device playback test.

## 0.1.1 built-provider live checks

The exact four-argument entry point was called from `scripts/check-native.mjs`
with a 1 MiB response cap and `--redirects follow`. The host supplied secure random
values but no native P-256 key generation, so Byse's portable signing path ran
inside the built JavaScript. No video segments were requested.

| Doctor Strange in the Multiverse of Madness, TMDB 453395 | Observed result |
| --- | --- |
| Filmpalast | Two working alternatives: VIDARA and FlyFile, both 720p, each with German/English external sidecars; 11 requests, about 6.9 seconds, largest response 314,800 bytes |
| Filmo | Byse HLS with English/German audio, 720p; 22 requests, about 9.9 seconds, largest response 700,871 bytes; no external sidecar list was supplied |

Both checks completed with no truncated responses. A final display-only change
then removed Byse's short `name` field so Nuvio's `name ?? title` mapping retains
the verified title, dimensions, codecs and hoster suffix; a built-runtime regression
checks that mapping. Actual iPhone execution and playback remain manual checks.

## Earlier 0.1.0 live native checks on 2026-09-13

Built JavaScript was executed with the same four-argument entry point and a host
fetch adapter that cuts responses at 1 MiB. Credentials were supplied only through
private standard input to `scripts/check-native.mjs` and were not written to disk.

| Case | Observed result |
| --- | --- |
| Inception, TMDB 27205 | Correct direct Xtream stream; 59 metadata requests; largest response 555,148 bytes |
| Dark S01E01, TMDB 70523 | Correct direct stream after an oversized series category switched to complete XML |
| The Simpsons S01E01, TMDB 456 | Correct direct stream despite a 1,638,861-byte series-detail response; complete season/episode XML used |
| Filmo / Matrix, TMDB 603 | The 0.1.0 built provider passed the redirect probe, fresh cookie/CSRF flow and VOE resolution; returned English- and German-labelled variants in 23 requests, with no truncated responses |
| Filmpalast / Game of Thrones S06E10, TMDB 1399 | The 0.1.0 built provider passed exact episode matching and VOE resolution in 8 requests, with no truncated responses |

The compact series category XML contained all 1,109 IDs in its current JSON
counterpart plus two legacy entries. Its candidates therefore require identity
confirmation rather than blindly trusting every legacy row.

For the tested server, JSON form POST succeeds but legacy series XML form POST
returns a gateway error. The provider uses GET for the observed Enigma2 contract.
Media itself is not fetched while listing streams. Earlier bounded file/segment
checks established real MKV/HLS media responses and German track declarations;
the current native live runner only resolves the actual provider outputs.

The Xtream account checks above preceded the final supplemental-variant fix;
that fix and the complete final bundles passed the fixture and QuickJS suite.
The account was not queried again merely to repeat the same catalog downloads.

## Manual acceptance

After publication, install the public GitHub repository in Nuvio. Check the
relevant [client prerequisites](native-compatibility.md), then verify a film and
an exact episode, badge display with the configured preset, audio/subtitle
selection, forced subtitles, seeking, resume and next-episode behavior.

Device testing is performed by the user. Known client SDK limitations must remain
visible in the compatibility notes rather than being described as successful tests.
