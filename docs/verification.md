# Verification

Checks below concern the native repository and generated providers. They do not
claim that a physical Nuvio application has been operated or that every title and
provider/server combination works.

## Automated checks

The final 0.1.7 `npm run check` on Node.js 24.19.0 passed **219 tests** with zero
failures. The existing opt-in public network test remained skipped; the separate
einschalten live checks below ran explicitly against the generated provider.
The manifest, all six provider bundles and runtime notices were rebuilt.

Initial Node.js 25.6.1 runs encountered native allocation failures on this
memory-constrained Windows host, including in existing QuickJS test files and
the build process. The complete successful LTS run used process-local V8 bounds
of 384 MiB old space and 8 MiB semi-space. The test command now limits file-level
parallelism to two; all test cases and their internal concurrency assertions
remain enabled. The temporary environment overrides were restored afterward.

The 0.1.6 local `npm run check` on Node.js 25.6.1 passed 184 tests with zero
failures, including 22 MegaKino and 13 HDFilme unit and built-provider cases.
One public network test remained skipped by its existing opt-in gate.
The separate MegaKino and HDFilme live checks below were run explicitly.

The 0.1.4 local `npm run check` on Node.js 25.6.1 passed 149 tests with zero
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
- einschalten's direct TMDB lookup, source-confirmed IMDb mapping, complete bounded
  search fallback, and DoodStream's same-file redirect and fresh URL construction.
- The complete DoodStream User-Agent on hoster requests and exported playback
  headers; bounded `RELOAD` recovery, malformed player data and challenge handling.
- Real loopback TLS/HTTP/2 requests, HTTP/1.1 negotiation fallback, redirect header
  isolation, POST conversion, timeouts, compression and decoded response limits.
- Bounded MP4 checks that verify the file header and exact requested byte ranges,
  including rejection of ignored Range requests, incorrect offsets and HTML.

The public live test in `test/web.test.ts` is opt-in and excluded from ordinary CI.
It was run separately during 0.1.0 development. Fixtures and CI contain no real accounts
or live signed media URLs.

All three final 0.1.1 JavaScript files also compiled successfully with the actual
Hermes 0.11.0 compiler. The web bundles produced only a nonfatal warning about a
guarded `window.Buffer` branch in `bn.js`; the executed QuickJS tests do not supply
Node's Buffer. Compiler acceptance is not a physical-device playback test.

## einschalten integration

The source was inspected on 2026-09-13. Its public frontend requests movie
details at `https://einschalten.in/api/movies/<TMDB ID>` and playback information
at the corresponding `/watch` path. The latter returns a DoodStream embed URL
and the upload release name. The inspected `vide0.net` links redirect to
`playmogo.com` while retaining the public file ID.

The initial HTTP/1.1 inspection received a Cloudflare challenge. A controlled
comparison identified both transport and User-Agent as relevant:

| Hoster connection | User-Agent | Observed result |
| --- | --- | --- |
| HTTP/1.1 | `Mozilla/5.0` | HTTP 403 challenge |
| HTTP/1.1 | Complete inspected native default | HTTP 403 challenge |
| HTTP/2 | `Mozilla/5.0` | HTTP 403 challenge |
| HTTP/2 | Complete inspected native default | HTTP 200 player and successful media resolution |

The complete value is
`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`.
The provider sends it for the embed and `pass_md5` requests and includes it,
with the final embed Referer, in the exported stream. It parses the published
`pass_md5` and `makePlay` data without executing source scripts or transferring
browser cookies. An explicit `RELOAD` result allows one fresh attempt. A second
reload, changed file identity, malformed prefix or active challenge remains an
error rather than an iframe or fabricated media result.

Before packaging, all three sampled movies passed two direct resolution and
range-check runs in separate processes. The final 0.1.7 generated provider then
completed these checks on Node.js 24.19.0:

| Movie and input | Runtime | Lookup requests / total time including media checks | Result |
| --- | --- | --- | --- |
| Inception, TMDB `27205` | Modeled Mobile URLs, followed redirects, 1 MiB response limit | 4 / 2.5 seconds | One MP4; valid `ftyp` header and both requested ranges returned HTTP 206 |
| Doctor Strange in the Multiverse of Madness, TMDB `453395` | Original Enhanced 0.4.14 JavaScript bindings in QuickJS | 4 / 3.0 seconds | One MP4; both ranges passed, no runtime errors |
| Matrix, IMDb `tt0133093` | Original Enhanced 0.4.14 JavaScript bindings in QuickJS | 6 / 3.9 seconds | Verified IMDb-to-TMDB mapping, one MP4, both ranges passed, no runtime errors |

The first range was bytes 0–1023; the second was bytes 1048576–1049599.
Each reported total file length stayed consistent between its ranges. The
generated provider only discovers the URL; these explicit diagnostic checks
read at most two KiB per stream. They do not decode the whole movie, establish
its audio-track inventory, or operate a physical iPhone. Language `de` comes
from the source's release label. Transcoded quality/codecs and the player's
empty subtitle placeholder are not presented as verified media metadata.

The capped Inception run had zero truncated responses; its largest source
response was 50,931 bytes. A final HTTP/1.1 control run with the same generated
provider still stopped at the hoster with `source_blocked`, after two successful
API requests and one HTTP 403. That negative control establishes the verified
transport boundary rather than a general failure of the source.

The initial HTTP/2-only diagnostic also exposed a modeling gap: Cinemeta's
metadata endpoint did not advertise HTTP/2, although its ordinary HTTP/1.1
request succeeded. The diagnostic now negotiates protocols before sending an
application request. It retains HTTP/1.1 for such endpoints while negotiating
HTTP/2 with DoodStream. The final Matrix trace records that distinction, and a
local TLS test covers it. A challenge is never used as a reason to change
protocol or invoke a browser solver.

Reproduce the explicit checks with:

```sh
node scripts/check-native.mjs --provider einschalten --id 27205 --type movie --redirects follow --url-runtime nuvio-mobile --transport http2 --verify-media mp4
node scripts/check-enhanced.mjs --provider einschalten --id 453395 --type movie --client-ref 0.4.14 --transport http2 --verify-media mp4
node scripts/check-enhanced.mjs --provider einschalten --id tt0133093 --type movie --client-ref 0.4.14 --transport http2 --verify-media mp4
```

There are 35 dedicated new tests: nine for DoodStream, sixteen for einschalten,
and ten for the diagnostic transport/media checks. Built-provider cases use a
256 KiB QuickJS stack, 512 nested elements, standard and modeled Mobile URLs,
and an unavailable `String.prototype.matchAll`. IMDb fallback search is bounded
to four normalized aliases, four pages per alias and eight candidate details;
the exact detail IMDb ID must confirm a candidate before playback.

Native header propagation was also inspected at Enhanced 0.4.14: plugin headers
become `StreamProxyHeaders.request`, then the iOS bridge passes the sanitized
values to MPV's `http-header-fields`. This is source evidence for that boundary;
physical-device playback, audio selection and long-running playback remain
manual acceptance checks.

No live response, signed media URL or account value was written to project or
scratch files. Test servers and workers are stopped by their cleanup paths. The
included loopback TLS certificate/key are explicitly synthetic test fixtures,
trusted only inside isolated workers without changing the user's certificate
store. See [native requirements](native-compatibility.md#einschalten).

## MegaKino integration

Direct checks on 2026-09-13 followed [7megakino.lol](https://7megakino.lol/)
from its search form through detail pages and the published `data-link` player
destinations. The accepted paths use VOE (Vega) and FireStream (Orion).

Search submits `do=search`, `subaction=search` and `story` to
`/index.php?do=search`, with `titleonly=3`. The provider follows the reported
result ranges and checks the echoed query, page positions, totals and duplicate
article IDs. It allows at most four normalized title aliases, ten result pages
per alias, eight candidate details and 32 supported mirrors on a matched page.
Exceeding a bound or observing incomplete/changing pagination remains an error.
These bounds concern the site's published search results, not an exhaustive
scan of its catalog.

The site's exact-word option, `all_word_seach=1`, incorrectly returned no results
for the observed German title `Die 5. Welle`; default title search returned the
correct article. That regression was reproduced in a fixture before removing
the option from ordinary searches. Conversely, the original title
`너 말고 다른 연애` caused default search to reject its short words. That specific
source rejection now permits one whole-phrase retry. An alias still rejected
afterward does not suppress a successfully searched alias; if every query is
rejected, the lookup fails explicitly. Neither case weakens the subsequent
exact title/year/episode checks.

Movie matching excludes the `Demnächst im kino` category: Doctor Strange 2 has
both a current article and a separate trailer-only article with the same title
and year. Series matching uses the `Staffel` number in the page heading and the
series-start year. Both inspected Fallout season pages used `serie-1_<episode>`
internally, so that first number cannot be treated as the season. Episode row
IDs, visible episode numbers and mirror IDs must agree. Published player IMDb
IDs are checked when available; a conflict rejects the page.

The built provider completed these live checks:

| Content and input | Runtime | Requests / time | Observed result |
| --- | --- | --- | --- |
| Die 5. Welle, IMDb `tt2304933` | Modeled Mobile URLs, followed redirects, 1 MiB response limit | 11 / 4.2 seconds | Two streams: VOE 720p HLS and a FireStream media playlist without declared dimensions |
| Die 5. Welle, TMDB `299687` | Original Enhanced 0.4.14 JavaScript bindings in QuickJS | 14 / 18.5 seconds | The same two hoster paths, with no runtime errors |
| Eine andere Liebe als deine S01E01, TMDB `314939` | Original Enhanced 0.4.14 JavaScript bindings in QuickJS | 13 / 9.1 seconds | One VOE 720p HLS stream, with no runtime errors |

The capped movie run had no truncation; its largest response was 177,672 bytes.
The series detail was 179,368 bytes in the Enhanced run. The sampled VOE files
declared audio language `und`, and the FireStream playlist did not declare an
audio inventory. No German audio or external subtitles are invented from the
site's German catalog label. Timings describe these host-adapted checks, not
physical-device performance or an availability guarantee.

Reproduce the opt-in checks with:

```sh
node scripts/check-native.mjs --provider megakino --id tt2304933 --type movie --redirects follow --url-runtime nuvio-mobile
node scripts/check-enhanced.mjs --provider megakino --id 299687 --type movie --client-ref 0.4.14
node scripts/check-enhanced.mjs --provider megakino --id 314939 --type tv --season 1 --episode 1 --client-ref 0.4.14
```

The 22 dedicated tests cover normal/empty/rejected searches, numbered titles,
pagination and bounds, mismatched metadata and canonical IDs, coming-soon
duplicates, exact episodes, unsupported hosts, mirror deduplication, partial and
total hoster failures, actual HLS metadata and external subtitle preservation.
Four cases execute the generated movie/S02E01 workflows under both URL bindings
with a 256 KiB QuickJS stack and deeply nested markup. They also keep the
ES2016-lowered provider's QuickJS load failure covered: awaiting search results
before the `for-of` loop fixes the reproduced `stack underflow` compiler error.

All temporary source responses and diagnostics were inspected in memory. No
source scripts were executed, and no media segments, encryption keys or live
session data were saved. Device playback, seeking and audio/subtitle selection
remain manual acceptance checks.

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

## HDFilme cafe integration

Direct checks on 2026-09-13 followed the player embedded by
[HDFilme's Vaiana detail page](https://hdfilme.cafe/filme1/42055-vaiana-streaming-stream.html)
and the published [MeineCloud player script](https://meinecloud.click/static/js/main.js?v=16).
The detail embeds `https://meinecloud.click/movie/tt27419466`. That player lists
hoster destinations as plain or Base64-encoded `data-link` attributes. The native
adapter uses the same public IMDb-addressed movie route, verifies the returned
URL and page identity, and reads supported VOE rows without executing scripts.

The website's form searches for Inception, `tt1375666`, and Fallout returned a
PHP `TypeError` despite HTTP 200. Its published AJAX quicksearch also returned
`error` for those queries using freshly read page/session values. Neither search
route is a prerequisite for the embedded player's IMDb lookup. A nonexistent
movie ID returned an explicit 404. Inception and The Matrix had movie-player
pages, but their sampled hosters did not include VOE.

The sampled Dropload movie and episode paths returned Turnstile forms.
Supervideo returned a Cloudflare block, Doodstream redirected to a Cloudflare
challenge, and the inspected Mixdrop pages reported unavailable videos.
The published series check returned an explicit player and episode count for
Women in Blue, Fallout, and Dark. Those player pages supplied Dropload links;
a native series playback chain was not established. HDFilme therefore declares
only `movie` support, with VOE as its supported hoster.

The built `providers/hdfilme.js` completed these live checks for Vaiana (2026):

| Entry | Runtime | Requests | Result |
| --- | --- | --- | --- |
| IMDb `tt27419466` | Modeled Mobile URLs, followed redirects, 512 KiB response limit | 6, about 2.9 seconds | One 720p HLS stream |
| TMDB `1108427` | Modeled Mobile URLs, followed redirects, 512 KiB response limit | 9, about 3.9 seconds | Verified IMDb cross-reference and one 720p HLS stream |
| IMDb `tt27419466` | Original Enhanced 0.4.14 JavaScript bindings in QuickJS, followed redirects | 6, about 3.6 seconds | One 720p HLS stream, no runtime errors |
| TMDB `1108427` | Original Enhanced 0.4.14 JavaScript bindings in QuickJS, followed redirects | 9, about 5.2 seconds | Verified IMDb cross-reference and one 720p HLS stream, no runtime errors |

The largest observed response was 163,108 bytes; the capped runs had no
truncation. The media server returned an HTTP 200 HLS master with 1280x720
video. Its audio language was `und` (undetermined), and no external subtitles
were published for that file. German audio was not inferred from the website's
catalog language. These checks establish stream discovery and a valid master
playlist; playback on a physical Nuvio device remains a manual acceptance step.

Fixtures cover mismatched identities, changed player destinations, unsupported
hosters, malformed encodings and URLs, missing movies, incomplete/challenged
pages, HLS failures, case-distinct mirrors, stable ordering, deduplication and
the three-worker concurrency limit. The actual bundle also runs with Mobile URL
bindings, a 256 KiB QuickJS stack, 512 nested page elements, and both the native
Base64 API and the bundle's fallback. The adapter never executes source scripts
or downloads media segments or encryption keys. Source responses and diagnostics
were inspected in memory; no disposable fixture downloads or session data were
retained.

## Manual acceptance

After publication, install the public GitHub repository in Nuvio. Check the
relevant [client prerequisites](native-compatibility.md), then verify a film and
an exact episode, badge display with the configured preset, audio/subtitle
selection, forced subtitles, seeking, resume and next-episode behavior.

Device testing is performed by the user. Known client SDK limitations must remain
visible in the compatibility notes rather than being described as successful tests.
