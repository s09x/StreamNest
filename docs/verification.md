# Verification

Checks below concern the native repository and generated providers. They do not
claim that a physical Nuvio application has been operated or that every title and
provider/server combination works.

## Automated checks

The final local check on Node.js 24.21.0 passed 78 tests. One public network test
is opt-in; it was executed separately and passed. `npm audit --omit=dev` reported
no known runtime dependency vulnerabilities at the time of the release check.

`npm run check` validates TypeScript, rebuilds all provider files and the manifest,
and runs unit and QuickJS tests. The tests cover:

- ID namespaces, exact episodes, specials and conflicting input.
- Fixed errors that do not expose credentials; incomplete responses and challenges.
- Scoped source cookies and bounded observable redirects with credential-header
  isolation; final-URL validation when the native host follows redirects itself.
- Native manifest and exports from the actual generated files.
- QuickJS without Node's `Buffer`, `require` or `process`, including isolation from
  Nuvio's global fetch function.
- German metadata aliases and validated TMDB/IMDb cross-references.
- Filmpalast/Filmo matching, VOE data decoding and native external subtitle fields.
- Filmo's anonymous manual-redirect capability probe, including refusal before
  source-session creation on hosts that follow the probe automatically.
- Xtream authentication, category completion, variants and detail identity checks.
- Supplemental 4K variants without catalog IDs, cross-ID detail confirmation and
  preservation of verified streams when supplemental candidates are ambiguous.
- Strict XML fallbacks, complete JSON-prefix identity properties and exact legacy
  season/episode selection.

The public live test in `test/web.test.ts` is opt-in and excluded from ordinary CI.
It was run separately during development. Fixtures and CI contain no real accounts
or live signed media URLs.

## Live native checks on 2026-09-13

Built JavaScript was executed with the same four-argument entry point and a host
fetch adapter that cuts responses at 1 MiB. Credentials were supplied only through
private standard input to `scripts/check-native.mjs` and were not written to disk.

| Case | Observed result |
| --- | --- |
| Inception, TMDB 27205 | Correct direct Xtream stream; 59 metadata requests; largest response 555,148 bytes |
| Dark S01E01, TMDB 70523 | Correct direct stream after an oversized series category switched to complete XML |
| The Simpsons S01E01, TMDB 456 | Correct direct stream despite a 1,638,861-byte series-detail response; complete season/episode XML used |
| Filmo / Matrix, TMDB 603 | Final built provider passed the redirect probe, fresh cookie/CSRF flow and VOE resolution; returned English- and German-labelled variants in 23 requests, with no truncated responses |
| Filmpalast / Game of Thrones S06E10, TMDB 1399 | Final built provider passed exact episode matching and VOE resolution in 8 requests, with no truncated responses |

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
