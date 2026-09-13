# Verification

Checks below concern the native repository and generated providers. They do not
claim that a physical Nuvio application has been operated or that every title and
provider/server combination works.

## Automated checks

The Huhu integration's local `npm run check` on Node.js 25.6.1 passed 167 tests with zero
failures. One public network test is opt-in and remains excluded from CI; the
separate built-provider live checks below were run explicitly. The earlier 0.1.4
check passed 149 tests, and 0.1.1 on Node.js 24.21.0 passed 136 tests. The runtime dependency audit reports one low-severity
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
- Source identity, bounded concurrent mirrors, deterministic order, isolation
  of failed hosters, and deliberate VIDARA exclusion without hoster requests.
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
- Iterative DOM text extraction, including decoded Unicode, comments, CDATA,
  script/style text and deeply nested markup in a 256 KiB QuickJS stack.
- Huhu's direct TMDB/IMDb identity lookup, exact episodes and specials, empty-name
  placeholders, echoed nonexistent episodes, API failures and response bounds.
- Huhu VOE/Vixeo resolution, HLS versus upload quality, declared languages,
  subtitle headers, duplicate mirrors, deterministic concurrency and isolated
  failures, including built-provider execution in a 256 KiB QuickJS stack.

The public live test in `test/web.test.ts` is opt-in and excluded from ordinary CI.
It was run separately during 0.1.0 development. Fixtures and CI contain no real accounts
or live signed media URLs.

All three final 0.1.1 JavaScript files also compiled successfully with the actual
Hermes 0.11.0 compiler. The web bundles produced only a nonfatal warning about a
guarded `window.Buffer` branch in `bn.js`; the executed QuickJS tests do not supply
Node's Buffer. Compiler acceptance is not a physical-device playback test.

## 0.1.4 Filmo stack overflow and VIDARA exclusion

The user isolated an app termination to Filmo and supplied an iOS crash report:
Nuvio Enhanced 0.4.14 build 118, iOS 18.6.2, `EXC_BAD_ACCESS` / `SIGBUS`, with
`KERN_PROTECTION_FAILURE` at the stack boundary. The triggered thread begins at
`___chkstk_darwin` and repeatedly alternates `JS_CallInternal` and
`js_array_every`. QuickJS uses that C entry point for `map` as well as `every`.

The inspected Filmo Doctor Strange page had 22 DOM levels. Reading its entire
`main` text through Cheerio caused 20 nested `map` calls in domutils' recursive
`textContent` implementation. Filmo now traverses text nodes iteratively, with
explicit traversal frames and no recursive DOM-text calls. Its title, year,
language and quality extraction preserve the existing textContent behavior.

Both built Filmo integration cases were extended with 512 nested elements and
the native library's 256 KiB stack limit. Before the fix both failed with
`stack overflow`; after the fix both completed the stream workflow. Separate
tests cover 10,000 nested HTML elements and text semantics. These checks reproduce
and fix the vulnerable traversal; an actual iPhone retest is still required.

The native checker can now read client files at a local Git reference, including
0.4.14's generated polyfill code. Its native fetch adapter blocks until HTTP
finishes and returns a string, matching that version's synchronous bridge. The
earlier promise-returning adapter was incompatible with the 0.4.14 wrapper and
was corrected before interpreting its live results.

The final 0.1.4 providers were run with `--client-ref 0.4.14`, the 256 KiB stack
and automatically followed HTTP redirects. For Doctor Strange 2, Filmo completed
the Byse flow and returned one 720p English/German stream in 26.6 seconds without
a runtime error. Filmpalast returned one FlyFile 720p stream with two external
subtitles in 7.0 seconds; its nine requests contained no VIDARA host. These are
QuickJS tests with Node HTTP adapters, not physical iOS playback measurements.

VIDARA was separately removed from Filmpalast selection at the user's request.
Tests verify that both known domains receive zero requests and that other
hosters remain available. Mirror concurrency and identity tests now use Vixeo;
they retain their original behavioral assertions.

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

## Huhu integration

Direct checks on 2026-09-13 followed the public
[Huhu client script](https://huhu.to/assets/index-CyRgdH9q.js). The site sends JSON
POST requests with `language: "de"` and `region: "DE"` to
`/mediaurl-item.json` and `/mediaurl-source.json`. Movie requests use
`type: "movie"`; series requests use `type: "series"` and source lookups include
`episode: { ids: {}, season, episode }`.

The item endpoint accepted both TMDB and IMDb identities for Inception and
Fallout. An unknown movie returned HTTP 200 with an empty name and echoed ID.
An item lookup for Fallout S99E01 echoed that nonexistent episode at the top
level while returning the real episode list separately. The provider therefore
validates the returned media type and IDs, requires a populated title, and uses
only actual episode-list entries to authorize a series source lookup.

The source endpoint returned ordinary hoster links, not native playable URLs.
The provider resolves only VOE and Vixeo/Vidsonic, retains source language/tag
metadata and published subtitles, deduplicates equivalent links, and runs no
more than three mirrors concurrently. It rejects oversized or malformed API
responses and isolates individual mirror failures. Other source-listed hosters
remain outside its implemented coverage.

The 18 Huhu tests passed after TypeScript validation and a fresh native build.
They include four complete QuickJS workflows covering TMDB movies and IMDb
specials under standard and modeled Mobile URL APIs, with the 256 KiB native
stack limit and without Node globals. The cases also cover invalid identities,
unlisted/ambiguous episodes, source errors inside HTTP 200, signed query
preservation, unsupported/malformed mirrors, ordering and concurrency, expired
HLS, subtitle headers, and missing resolution/language declarations.

Source/hoster probes found valid HLS for Inception and Fallout S01E01 through
VOE, plus Inception and Matrix through Vixeo/Vidsonic. The VOE Inception upload
label said 1080p while the master declared 1728x720. Fallout's sampled master
declared 1280x536. These dimensions are retained without inventing a standard
resolution tier. Only metadata and playlists were read; media segments, keys
and account credentials were not fetched or saved.

The generated Huhu bundle was also executed through the original Nuvio
Enhanced 0.4.14 JavaScript bindings in QuickJS, with automatically followed HTTP
redirects and the 256 KiB stack limit:

| Request | Result | Requests / elapsed time |
| --- | --- | --- |
| Inception, TMDB 27205 | Three streams: two German 720p alternatives through VOE and Vixeo, plus French 360p VOE | 10 / 7.3 s |
| Matrix, TMDB 603 | One German 720p Vixeo stream | 4 / 4.6 s |
| Fallout S01E01, IMDb tt12637874 | Four VOE streams: German 1280x536, 720p and 1080p, plus French 720x300 | 14 / 13.1 s |

All three runs captured zero client/provider JavaScript errors. The largest
response was 159,959 bytes. These samples supplied no external subtitles;
subtitle preservation was verified with the fixture workflows. Reproduce them
with `node scripts/check-enhanced.mjs --provider huhu --client-ref 0.4.14
--redirects follow --id 27205 --type movie`, substituting the other ID and adding
`--type tv --season 1 --episode 1` for Fallout. The checker adapts native HTTP
calls to Node; it does not operate the installed app or validate device playback,
seeking or audio selection.

## Manual acceptance

After publication, install the public GitHub repository in Nuvio. Check the
relevant [client prerequisites](native-compatibility.md), then verify a film and
an exact episode, badge display with the configured preset, audio/subtitle
selection, forced subtitles, seeking, resume and next-episode behavior.

For Huhu, start with Inception (TMDB 27205), Matrix (TMDB 603), and Fallout
(TMDB 106379) S01E01. Check the offered language and hoster labels, then verify
that moving to another episode requests that episode's sources. Live fixtures
do not establish audio selection or playback behavior in the installed app.

Device testing is performed by the user. Known client SDK limitations must remain
visible in the compatibility notes rather than being described as successful tests.
