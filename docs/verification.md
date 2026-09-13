# Verification

Checks below concern the native repository and generated providers. They do not
claim that a physical Nuvio application has been operated or that every title and
provider/server combination works.

## Automated checks

The 0.1.3 local `npm run check` on Node.js 25.6.1 passed 146 tests with zero
failures. One public network test is opt-in and remains excluded from CI; the
separate built-provider live checks below were run explicitly. The earlier 0.1.1
check on Node.js 24.21.0 passed 136 tests. The runtime dependency audit reports one low-severity
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
- Mobile-style relative URL resolution, including the actual Doctor Strange 2
  protocol-relative search link, canonical link, hoster URL and subtitle URL.
- Relative paths, origin-root bases, protocol-relative hosts, signed queries and
  credential rejection under standard and modeled Mobile URL bindings.
- Ktor's absent query/fragment mapping, with both web providers failing before
  the 0.1.3 adapter correction and passing afterward.
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
- Complete bulk movie/series lookup in three requests, variant preservation,
  category fallback for unsupported/truncated/oversized/empty responses, and
  immediate termination for bulk authentication or rate-limit failures.
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

## 0.1.3 native URL and Xtream latency corrections

After the user identified Nuvio Enhanced and still reported no streams following
a downgrade, its Ktor URL bridge was checked against Ktor 3.4.1's implementation.
The bridge produces `?` and `#` for missing query/fragment values. Reproducing
those exact values caused both 0.1.2 providers to return zero results after their
search responses, with `invalid_response`; no film detail page was requested.
The original model had incorrectly used browser-style empty strings.

Both built-provider regression tests then passed after every provider URL call
was routed through the corrected adapter. Tests also check that actual query
values, fragments and hrefs are preserved and that the host constructor retains
its original behavior. A 0.1.3 Filmpalast live run with the corrected native model
returned two 720p streams in 17.0 seconds. Filmo progressed past the formerly
failing search boundary but a run with automatically followed redirects stopped
at its automatic-proof stage and returned `source_blocked`; no device success is
claimed from that run. With manual redirect responses exposed, the final built
provider returned two VOE streams in 35.2 seconds even though Byse did not resolve.
That transport capability is not supplied by the unpatched inspected iOS client.

For Xtream, a complete supported bulk response avoids category fan-out. A synthetic
fixture with 58 categories and one exact movie requires three requests instead of
the previous 61-request algorithm. The same three-request contract is tested for
an exact series episode. A separate built-provider QuickJS benchmark containing
10,000 synthetic movies (997,776 bytes of catalog JSON) returned the correct stream
in three requests and 740 ms including runtime startup. Fixture timing is not a
measurement of the user's account or network. Bulk fallback may remain slow on
large catalogs or constrained clients; no real credentials were used here.

## Earlier 0.1.2 iOS investigation on 2026-09-13

The original Filmpalast bundle failed after the search response when executed
with Mobile 0.4.18's relative-URL behavior. A new built-provider QuickJS regression
failed before the fix and passed after it. The small, dependency-free URL resolver
package is bundled so relative resolution does not depend on that native behavior.

The final providers were checked with a 1 MiB response cap, automatic redirects,
secure randomness and the modeled Mobile URL binding:

```sh
node scripts/check-native.mjs --provider filmpalast --id 453395 --type movie --redirects follow --url-runtime nuvio-mobile
node scripts/check-native.mjs --provider filmo --id 453395 --type movie --redirects follow --url-runtime nuvio-mobile
```

| Doctor Strange in the Multiverse of Madness, TMDB 453395 | Observed 0.1.2 result |
| --- | --- |
| Filmpalast | Two streams, VIDARA and FlyFile, both 720p and each with two external subtitles; 11 requests, 8.7 seconds; maximum response 314,800 bytes |
| Filmo | One Byse stream, 720p with English/German audio; 22 requests, 10.2 seconds; maximum response 700,871 bytes |

Neither final run truncated a response. Initial 0.1.1 live requests failed at the
hoster/network stage, but subsequent 0.1.1 diagnostics also returned both providers'
streams with standard URL APIs. Therefore a persistent independent Filmo failure
has not been established. Its full Byse fixture now runs under both URL bindings,
including protocol-relative source links.

All three final 0.1.2 bundles were also **executed**, not only compiled, through
`new Function` in the official Hermes 0.11.0 CLI. All loaded successfully. Xtream
returned the three input keys without network access, as did the original 0.1.1
bundle in the same check. At that stage, the physical iOS dialog failure remained
unresolved; the later Enhanced investigation below identified its failing client path.
No real Xtream account was queried in this investigation. No video segments were
downloaded, and no physical-device playback test was performed.

The user's working Showbox example was also inspected. That linked script has no
`onSettings` export; the available React Native screen implements a dedicated
Showbox token field. The evidence and its version limits are recorded in
[native compatibility](native-compatibility.md#client-side-settings-limitation).

## Nuvio Enhanced follow-up

The inspected Enhanced revision is `111eaa807a39ee550dc1f91630535d39c8fc4ef9`.
Evaluating its original `JsBindings.staticPolyfillCode` in a fresh QuickJS context
without host registration reproduced `__get_scraper_id is not defined`, before
any provider code ran. With the missing native functions supplied, the original
bindings and built Xtream provider returned all three input keys without network
requests. The user subsequently confirmed that the menu opens after downgrading
Enhanced. The prior provider-only tests did not prove that this client startup worked.

The new checker reads the client bindings directly from a checkout:

```sh
node scripts/check-enhanced.mjs --client-root ../NuvioMobile-Enhanced --provider xtream --mode settings
node scripts/check-enhanced.mjs --client-root ../NuvioMobile-Enhanced --provider filmpalast --id 453395
node scripts/check-enhanced.mjs --client-root ../NuvioMobile-Enhanced --provider filmo --id 453395
node scripts/check-enhanced.mjs --client-root ../NuvioMobile-Enhanced --provider filmo --id 453395 --redirects manual
```

Unlike the earlier Node/V8 live checker, this executes the provider, original
client polyfills and result serialization in QuickJS. Native HTTP and a limited
set of used crypto/URL host functions are adapted to Node. HTTP requests are
serialized to reflect Enhanced's blocking fetch bridge. This still does not
execute Kotlin, Ktor/Darwin or the physical iPhone. Its initial absolute-URL
adapter also omitted the Ktor bare-delimiter defect; the 0.1.3 results above use
the corrected adapter. The following early results are retained as investigation
history, not evidence that 0.1.2 worked through the native URL bridge:

- Filmpalast returned two 720p streams through the original client bindings.
- Filmo with automatic redirects first stopped after the Byse captcha response
  with `source_blocked`; another run completed a difficulty-16 automatic proof
  and returned one 720p English/German stream in 19.8 seconds. This demonstrates
  variability, not reliable success on the user's device.
- Filmo with manual redirect responses exposed returned three streams in 21.9
  seconds, including VOE and Byse. The inspected iOS client ignores its
  `followRedirects` argument; a separate local client patch now selects a Ktor
  client with redirects disabled for that case. Its native behavior remains to
  be verified on iOS.

The client patch includes native iOS settings tests, but they have not run here.
The Gradle wrapper could not start because Java is unavailable, and this Windows
host cannot build or run the iOS target. No new app binary was created or deployed.
The user confirmed that neither web provider returned results after the downgrade.
That led to the Ktor URL investigation and provider correction described above.

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
