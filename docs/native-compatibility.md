# Native Nuvio compatibility

StreamNest installs as a native repository: root `manifest.json`, `scrapers`, and
the referenced JavaScript files. Every stream lookup runs on the Nuvio device.
Public TMDB and Cinemeta endpoints supply title, year, and identity metadata when
a provider needs that mapping. einschalten can address a numeric TMDB movie
directly. Huhu obtains its identity metadata from its own public MediaURL
interface. GitHub supplies the manifest and provider bundles.

## Build and platform prerequisites

Nuvio has more than one client generation. The user-supplied
[native provider guide](https://github.com/yoruix/nuvio-providers/blob/main/DOCUMENTATION.md)
describes React Native/Hermes clients. Its build requires ES2016-compatible dynamic
code. StreamNest 0.1.0 used an ES2020 target and was not compatible with that
contract: the tested Hermes compiler rejected async-arrow functions and classes.
The build now lowers both, preserves host-global isolation, and exports the
Xtream settings array synchronously. QuickJS execution remains part of CI.

The version-specific source audit below concerns the separately inspected
Compose/QuickJS and TV clients; it does not identify an unknown installed iOS build
merely from the words "latest version". Actual settings, network and player
capabilities still depend on the installed client.

The installed Nuvio build must actually include its native JavaScript plugin
runtime. The inspected store variants and older TV runtimes are not equivalent
to the Full builds:

| Client | Prerequisite for this native repository |
| --- | --- |
| Android Mobile 0.4.18 | Full build with Plugins enabled; the Google Play variant disables native JS providers |
| iOS Mobile 0.4.18 | Full/sideload build with native plugins; the App Store variant disables them |
| Android TV 0.9.2-beta | Full build; the Play Store variant disables native plugins |
| Desktop 0.1.23-alpha | Desktop build containing the native plugin runtime; this is an alpha release |
| Samsung Tizen | Tizen 6.0 or later, the packaged PluginService, and working Worker/WebAssembly support |
| LG webOS | webOS 5 or later with the packaged plugin service; webOS 5 has smaller runtime quotas than webOS 6+ |

Tizen 4.x and 5.x/5.5 may run other Nuvio features, but do not provide the native
plugin execution required here. A successfully added repository does not prove
that the device can execute its providers. The per-provider settings, redirect,
response-size, and subtitle limitations below still apply after these basic
prerequisites are satisfied.

- [Mobile Android Play Store plugin stub: PluginRepository.android.kt](https://github.com/NuvioMedia/NuvioMobile/blob/13cd02040a6e9b8bc3b5a51c4925fb0603597955/composeApp/src/androidPlaystore/kotlin/com/nuvio/app/features/plugins/PluginRepository.android.kt#L11)
- [Mobile iOS App Store plugin stub: PluginRepository.ios.kt](https://github.com/NuvioMedia/NuvioMobile/blob/13cd02040a6e9b8bc3b5a51c4925fb0603597955/composeApp/src/iosAppStore/kotlin/com/nuvio/app/features/plugins/PluginRepository.ios.kt#L11)
- [Android TV Play Store plugin stub: PluginManager.kt](https://github.com/NuvioMedia/NuvioTV/blob/e54a74904b7ee40e5c748e156a70749f89e8decf/app/src/playstore/java/com/nuvio/tv/core/plugin/PluginManager.kt#L12)
- [Smart TV versions and packaged services: README.md](https://github.com/NuvioMedia/NuvioTVSmart/blob/f3f8bcc3674a12366a416f9af5f5dcba8df85c35/README.md#L20)

## einschalten

The einschalten adapter supports movies through its public JSON API and
DoodStream. A TMDB request normally needs four native fetch calls: movie details,
the watch response, the redirected embed page, and its published `pass_md5`
request. IMDb requests first use the existing metadata mapping; a bounded title
search is available when that mapping has no TMDB ID, and the source detail must
confirm the exact IMDb ID before playback.

The native transport must support HTTP/2 for DoodStream. In the controlled
comparison, HTTP/1.1 with a complete User-Agent and HTTP/2 with the abbreviated
`Mozilla/5.0` value both received Cloudflare 403 responses. HTTP/2 with the
inspected native bridge's complete default reached the player and media route.
The provider explicitly supplies that complete value to DoodStream and returns
it, together with the final embed Referer, in the stream's playback headers.

Enhanced 0.4.14's iOS fetch bridge uses Ktor's Darwin/NSURLSession transport. The
inspected Android implementation uses OkHttp. Both engines support HTTP/2;
the HTTP version is negotiated by the native client and cannot be selected by a
JavaScript provider option. The existing native clients therefore remain the
networking boundary. The checker's `--transport http2` option only selects a
Node diagnostic adapter, not a new client capability.

The HTTP/2-capable diagnostic adapter falls back to HTTP/1.1 only when the TLS
endpoint does not offer HTTP/2. The inspected Cinemeta endpoint needs that
fallback for IMDb metadata; the DoodStream requests still negotiate HTTP/2.
A challenge response does not trigger protocol switching or a browser solver.

- [Ktor engine support](https://ktor.io/docs/client-engines.html)
- [Enhanced 0.4.14 iOS HTTP implementation](https://github.com/luqmanfadlli/NuvioMobile-Enhanced/blob/0.4.14/composeApp/src/iosMain/kotlin/com/nuvio/app/features/addons/AddonPlatform.ios.kt)

Movie and hoster lookups use ordinary GET requests; the bounded title fallback
uses JSON POST searches. The provider works with followed redirects and reads
the public player assignment without executing hoster scripts. It needs
no browser session, external resolver service, or cryptographic host extension.
Actual challenges, changed file identities, malformed responses and exhausted
retry bounds remain errors. A client constrained to HTTP/1.1 does not meet this
source's verified transport requirement. Physical-device verification is still
separate from the QuickJS and host-adapted checks documented in
[einschalten verification](verification.md#einschalten-integration).

## HDFilme

The HDFilme adapter is declared for movies and uses the public IMDb-addressed
player embedded by `hdfilme.cafe`. Numeric TMDB requests require the existing
verified TMDB/IMDb metadata mapping. Its anonymous GET requests work with
automatically followed redirects and do not depend on Filmo's cookie handoff
or Byse's crypto protocol.

The built adapter passed a 512 KiB response-limit check with modeled Mobile URL
behavior and an execution through Enhanced 0.4.14's original JavaScript bindings.
QuickJS fixtures also cover a 256 KiB stack, deeply nested page markup, and both
the native `atob` API and the bundled fallback. These checks establish provider
execution and stream discovery; physical-device playback remains untested.
The sampled series hoster requires interaction, so series support is not declared.
See [HDFilme verification](verification.md#hdfilme-cafe-integration).

## MegaKino

MegaKino provides movies and exact series episodes through anonymous form POST
searches and the existing VOE/FireStream resolvers. Automatically followed HTTP
redirects are supported. Its source lookup requires no account settings,
interactive browser, or secure-randomness API. Unsupported hosters are skipped.

Movie and S02E01 fixtures execute the generated bundle with a 256 KiB QuickJS
stack, 512 nested DOM elements, standard and modeled Mobile URLs, and no
`String.prototype.matchAll`. DOM text extraction is iterative. A QuickJS
compiler failure was reproduced when an awaited search appeared directly in a
`for-of` expression after ES2016 lowering; materializing the search result
before iteration fixes the load failure without changing the client runtime.

The original Enhanced 0.4.14 JavaScript bindings also resolved a live movie and
an exact episode. The modeled Mobile movie check used a 1 MiB response limit
without truncation. The Enhanced checker accepts `--season` and `--episode`
for both legacy and current client bindings. These checks establish provider
execution and stream discovery; physical-device playback remains untested.
See [MegaKino verification](verification.md#megakino-integration).

## Native contract

The bundled providers export:

```js
module.exports.getStreams(id, mediaType, season, episode)
```

Nuvio normally supplies a typed TMDB identity with `movie` or `tv`. StreamNest also
validates IMDb and compatible prefixed IDs and rejects conflicting episode
coordinates. Xtream exports `onSettings()` and declares `hasSettings: true`.
The settings keys are `host`, `username`, and `password`.

Huhu declares no settings. It uses JSON POST requests to its own `item` and
`source` endpoints, then routes every source to its hoster resolver. DoodStream
and some other source paths need the native HTTP/2 transport described above;
Filemoon/Byse additionally uses the existing secure-randomness and attestation
implementation. The other hoster parsers require no browser session or script
execution. Source responses are limited to 1,048,576 characters and 256 rows;
an excess is an explicit failure. The former separate 32-mirror ceiling is gone.

Nuvio Enhanced's `PluginRuntimeResult.toStreamItem()` uses `name ?: title` and
does not preserve a second description from `title`. Huhu therefore places the
complete source/hoster labels in both fields. Declared source quality remains
visible even when the checked HLS dimensions differ. Tests execute the built
provider with standard and modeled Mobile URL bindings at a 256 KiB stack limit.

The synchronous `getSourceReport()` export reads the most recent lookup in the
same JavaScript instance. It includes the request identity, source indices,
hoster names, source tags, languages, resolution outcomes and duplicate links.
It makes no requests and contains no media URLs or access tokens. A later invalid
request clears the report; a fresh native runtime has no previous report. Nuvio's
current plugin result model has no separate non-playable source-status row, so
unresolved links are reported by the checker rather than inserted as fake media.
Physical-device playback and UI rendering still require user verification.

The providers read Nuvio's `fetch`, URL APIs, and `SCRAPER_SETTINGS`. Parser and
decoder dependencies are bundled. They do not use Node filesystem/network APIs,
`Buffer`, a separate backend, or a supposedly persistent JavaScript catalog cache.

### Relative URL resolution

Mobile 0.4.18's URL bridge concatenates relative references instead of applying
complete URL resolution. For example, `//filmpalast.to/stream/example` against
`https://filmpalast.to` becomes
`https://filmpalast.to//filmpalast.to/stream/example`. This breaks Filmpalast's real
search links and was reproduced with the built 0.1.1 provider.

Since 0.1.2, StreamNest resolves references with bundled `url-toolkit` 2.2.5 before
passing an absolute address to the native URL bridge. The same boundary handles
source pages, hoster links, subtitles and observed redirects. Origin and credential
checks still apply. The host's URL implementation is not overwritten.

The regression fixture intentionally retains the Mobile relative-resolution bug;
it uses host-backed absolute parsing and does not reproduce every Ktor or
URLSearchParams detail. Earlier tests used standard URL APIs and missed this bug.

The later 0.1.3 investigation found a second native mismatch. Ktor 3.4.1 returns
non-null empty strings for absent `encodedQuery` and `encodedFragment`, but the
bridge prefixes both unconditionally. Thus a URL with neither component gets
`search: '?'` and `hash: '#'`. StreamNest previously treated those properties as
real content and rejected valid source/hoster links. All provider URL parsing now
uses the shared adapter, which normalizes only those bare properties to empty
strings. It preserves `href`, real parameters, fragments and signed values.
The host constructor is unchanged. The fixture and live checker now reproduce
the Ktor empty-component behavior; their earlier Node-based adapters missed it.

- [Ktor encoded query and fragment](https://github.com/ktorio/ktor/blob/3.4.1/ktor-http/common/src/io/ktor/http/Url.kt#L182)
- [Enhanced native URL mapping](https://github.com/luqmanfadlli/NuvioMobile-Enhanced/blob/111eaa807a39ee550dc1f91630535d39c8fc4ef9/composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/network/UrlBridge.kt#L36)

- [Mobile URL bindings](https://github.com/NuvioMedia/NuvioMobile/blob/13cd02040a6e9b8bc3b5a51c4925fb0603597955/composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/js/JsBindings.kt)

## Client-side settings limitation

Inspected source versions include Mobile 0.4.18, Desktop 0.1.23-alpha, Android TV
0.9.2-beta, and Smart TV 1.1.2, with the corresponding current branches checked on
2026-09-13.

- Mobile/Desktop provide the native `hasSettings` / `onSettings` dialog and save
  its values locally. Their runtime passes those values as `SCRAPER_SETTINGS`.
- The inspected Android TV/Smart TV runtime can consume a local settings map, but
  the existing phone/repository synchronization transfers repository URLs rather
  than arbitrary native provider settings. A phone-to-TV credential transfer is
  not established by the repository installation feature.
- System backup, account linking and the inspected profile export/import paths
  did not provide an additional native scraper-settings transfer.
- The inspected Mobile/Desktop dialog reads `isPassword` but does not apply it to
  the input's visual transformation. StreamNest emits the native password flag;
  the client is responsible for honoring it.

These are explicit client limitations, not capabilities implemented by additional
unknown manifest properties. Host/password synchronization across those clients
would require a Nuvio-side feature. No client modification or substitute transport
has been made by this repository.

Both the 0.1.1 and 0.1.2 provider bundles return `host`, `username` and `password`
in isolation. Those earlier tests did not exercise the failing Enhanced client
bootstrap described below. The URL correction does not fix that startup failure.

The user-supplied [Showbox provider](https://raw.githubusercontent.com/yoruix/nuvio-providers/refs/heads/multi-file-providers/providers/showbox.js)
is a different configuration path: the inspected file exports only `getStreams`,
contains no `onSettings`, and its manifest entry does not declare `hasSettings`.
The available [React Native settings screen](https://github.com/NuvioMedia/NuvioMobile/blob/cbc9fc4fa6508446b522ee62808983ab6dcb2c31/src/screens/PluginsScreen.tsx)
detects Showbox by its name, ID or filename and implements its token input directly
in the app. A working Showbox cookie input therefore does not by itself establish
generic provider-settings support. This source comparison does not identify the
exact installed iOS build, and StreamNest does not impersonate Showbox to trigger
that dedicated UI.

### Nuvio Enhanced settings regression

The later user-supplied repository identifies a concrete failing implementation:
[NuvioMobile-Enhanced at 111eaa807a39ee550dc1f91630535d39c8fc4ef9](https://github.com/luqmanfadlli/NuvioMobile-Enhanced/tree/111eaa807a39ee550dc1f91630535d39c8fc4ef9).
Its settings loader evaluates `JsBindings.staticPolyfillCode` before registering
`HostFunctions`. The first lines call `__get_scraper_id()` and
`__get_scraper_settings()`, producing `ReferenceError: '__get_scraper_id' is not
defined`. The exception is converted to `null`, and the gear-button handler only
opens a dialog for a non-null result. The provider has not executed at that point.

This failure was reproduced in QuickJS using the exact client polyfill source.
Registering the host getters, result callback and required URL/crypto/fetch
bridges before the polyfills allows the built Xtream provider to return its fields.
A local client patch and native iOS regression tests were prepared in the separate
Enhanced checkout. They have not been compiled into an IPA or installed on a phone.
The user then confirmed that downgrading Enhanced restored the menu; the exact
old/new release numbers were not supplied.

- [Failing settings initialization](https://github.com/luqmanfadlli/NuvioMobile-Enhanced/blob/111eaa807a39ee550dc1f91630535d39c8fc4ef9/composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/PluginRuntime.kt#L81)
- [Immediate host calls](https://github.com/luqmanfadlli/NuvioMobile-Enhanced/blob/111eaa807a39ee550dc1f91630535d39c8fc4ef9/composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/js/JsBindings.kt#L4)
- [Gear-button result gate](https://github.com/luqmanfadlli/NuvioMobile-Enhanced/blob/111eaa807a39ee550dc1f91630535d39c8fc4ef9/composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/PluginsSettingsScreen.kt#L418)

### Filmo and native stack size

The supplied crash report identifies Enhanced 0.4.14 build 118 on iOS 18.6.2.
Its QuickJS thread exhausted the native stack during recursive array callbacks.
Filmo's full-page Cheerio text extraction recursively mapped each DOM level;
the observed page reached 20 nested maps. Since 0.1.4 Filmo reads those text nodes
iteratively. A 512-level built-provider regression fails before the change and
passes afterward with a 256 KiB interpreter stack. The native library uses this
stack limit by default; the earlier generic test harness used 1 MiB.

The fix does not increase the app's native stack or claim that a caught provider
error can recover a native process crash. Native device acceptance remains
separate from the QuickJS/WASM regression.

Evidence:

- [Mobile settings save](https://github.com/NuvioMedia/NuvioMobile/blob/13cd02040a6e9b8bc3b5a51c4925fb0603597955/composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/PluginSettingsDialog.kt#L191)
- [Mobile plugin synchronization](https://github.com/NuvioMedia/NuvioMobile/blob/13cd02040a6e9b8bc3b5a51c4925fb0603597955/composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/PluginRepository.kt#L505)
- [TV phone-management request](https://github.com/NuvioMedia/NuvioTV/blob/e54a74904b7ee40e5c748e156a70749f89e8decf/app/src/main/java/com/nuvio/tv/core/server/RepositoryConfigServer.kt#L82)
- [TV settings injection](https://github.com/NuvioMedia/NuvioTV/blob/e54a74904b7ee40e5c748e156a70749f89e8decf/app/src/full/java/com/nuvio/tv/core/plugin/PluginManager.kt#L828)
- [Smart local-only settings](https://github.com/NuvioMedia/NuvioTVSmart/blob/f3f8bcc3674a12366a416f9af5f5dcba8df85c35/js/core/profile/pluginSyncService.js#L613)

## Response size and Xtream

The inspected Android, Desktop and modern TV runtimes cap a plugin fetch at about
1 MiB. The limited webOS 5 runtime uses 512 KiB. A successful HTTP status can still
contain a truncated body; some native `json()` wrappers then return `null`.

StreamNest parses text explicitly. Since 0.1.3 it first requests the standard
unfiltered `get_vod_streams` or `get_series` response. A complete nonempty catalog
below 8,388,608 characters avoids category fan-out. All existing identity, variant
and exact-episode checks still run. Unsupported, empty, malformed, oversized or
truncated bulk responses fall back to categories. Authentication failures and
rate limits do not trigger category fan-out. This is a request-count improvement,
not a persistent catalog cache or a guarantee about a server's response time.

Fallback categories are read with bounded concurrency, and incomplete required
categories are never silently converted to empty results.
For supported servers:

1. JSON API requests use form POST.
2. An oversized series category can use the legacy `enigma2.php` GET listing.
3. The XML must be complete and well-formed. Candidates are confirmed against
   current public identity metadata; returned credential URLs are not followed.
4. For a large series-detail response, only an independently complete `info`
   property may be read from the received JSON prefix. It is used for positive
   identity verification, not to claim completeness of the episode list.
5. Complete legacy season and episode lists then determine the exact requested
   coordinates. The final URL is constructed from configured credentials and the
   validated provider file ID/extension.

The test account's largest VOD category was 555,148 bytes (about 542 KiB) and does not
fit a 512-KiB runtime. Legacy VOD XML was larger, so it is deliberately not used as
a false solution. Arbitrarily large responses and providers without the necessary
legacy endpoints remain subject to the client's limits.

## Redirect handling

Manual redirects are a platform capability, not a shared guarantee of the
native `fetch` name:

| Published client | Behavior of `redirect: 'manual'` |
| --- | --- |
| Android Mobile 0.4.18 Full | The JS bridge passes the flag and the Android HTTP implementation disables both HTTP and HTTPS redirect following |
| Desktop 0.1.23-alpha | The JS bridge passes the flag and the desktop HTTP implementation disables redirect following |
| iOS Mobile 0.4.18 Full | The JS bridge passes the flag, but the iOS HTTP implementation does not use it |
| Android TV 0.9.2-beta Full | The JS bridge does not pass the option to its native fetch function |
| Smart TV 1.1.2 | The worker bridge does not pass the option to the packaged HTTP service |

StreamNest can strip sensitive
headers and reject a cross-origin POST before following only when the bridge
exposes the redirect response. For host-followed redirects, it validates the
reported final URL, associates cookies with that URL, and rejects an unexpected
credentialed cross-origin result. This validation cannot undo requests the host
already sent, and depends on the host reporting the actual final URL.

All inspected implementations report the final response URL: Android and Desktop
use the final OkHttp request URL, iOS uses the final Ktor call URL, and Smart's
service recursively replaces its request URL when following a redirect. This
supports validation after a response; it does not turn automatic following into
controlled redirect handling. Smart explicitly removes only `Authorization` on a
cross-origin redirect and preserves the original method/body for 307/308.

The observed Filmo VOE flow needs session cookies on `/n/<token>`: a fresh request
without them returned 404. That mirror requires verified manual-redirect support
before its session starts. Android Mobile and Desktop provide that capability in
the inspected releases. Unsupported hosts omit the VOE session before cookies are
acquired; checking the final origin after sending cookies would be too late.

Filmo's Byse link instead returns a same-origin HTTP 200 HTML page with an explicit
`a.open` destination. StreamNest reads that anchor and starts a clean Byse client,
without forwarding Filmo's cookies, CSRF values or mint token. Failure of the
anonymous HTTP redirect probe does not exclude this HTTPS-only handoff.

Byse's attestation also requires secure randomness. The inspected Mobile bridge
provides `crypto.getRandomValues` backed by Android `SecureRandom` or iOS
`SecRandomCopyBytes`. Its native `subtle.generateKey` supports AES/HMAC, so the
provider includes a portable P-256 implementation rather than assuming native
ECDSA support. The inspected Android TV runtime does not expose an equivalent
secure-random bridge; Byse returns `unsupported_runtime` there unless the client
supplies a genuine CSPRNG. Its automatic proof also has a bounded CPU budget.
These are Byse requirements, not a reason to suppress other working hosters.

- [Mobile JS flag forwarding: JsBindings.kt:85](https://github.com/NuvioMedia/NuvioMobile/blob/13cd02040a6e9b8bc3b5a51c4925fb0603597955/composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/js/JsBindings.kt#L85)
- [Android manual redirects and final URL: AddonPlatform.android.kt:291](https://github.com/NuvioMedia/NuvioMobile/blob/13cd02040a6e9b8bc3b5a51c4925fb0603597955/composeApp/src/androidMain/kotlin/com/nuvio/app/features/addons/AddonPlatform.android.kt#L291)
- [Desktop JS flag forwarding: JsBindings.kt:49](https://github.com/NuvioMedia/NuvioDesktop/blob/af4803399e77480ca7db75284b89a049cc6fe040/composeApp/src/fullCommonMain/kotlin/com/nuvio/app/features/plugins/runtime/js/JsBindings.kt#L49)
- [Desktop manual redirects and final URL: AddonPlatform.desktop.kt:108](https://github.com/NuvioMedia/NuvioDesktop/blob/af4803399e77480ca7db75284b89a049cc6fe040/composeApp/src/desktopMain/kotlin/com/nuvio/app/features/addons/AddonPlatform.desktop.kt#L108)
- [iOS unused flag and final URL: AddonPlatform.ios.kt:164](https://github.com/NuvioMedia/NuvioMobile/blob/13cd02040a6e9b8bc3b5a51c4925fb0603597955/composeApp/src/iosMain/kotlin/com/nuvio/app/features/addons/AddonPlatform.ios.kt#L164)
- [TV option forwarding: PluginRuntime.kt:696](https://github.com/NuvioMedia/NuvioTV/blob/e54a74904b7ee40e5c748e156a70749f89e8decf/app/src/full/java/com/nuvio/tv/core/plugin/PluginRuntime.kt#L696)
- [TV final response URL: PluginRuntime.kt:591](https://github.com/NuvioMedia/NuvioTV/blob/e54a74904b7ee40e5c748e156a70749f89e8decf/app/src/full/java/com/nuvio/tv/core/plugin/PluginRuntime.kt#L591)
- [Smart option forwarding: pluginWorker.js:298](https://github.com/NuvioMedia/NuvioTVSmart/blob/f3f8bcc3674a12366a416f9af5f5dcba8df85c35/js/core/player/pluginWorker.js#L298)
- [Smart redirect policy: plugin-http.cjs:569](https://github.com/NuvioMedia/NuvioTVSmart/blob/f3f8bcc3674a12366a416f9af5f5dcba8df85c35/services/plugin-http.cjs#L569)

## Badges and subtitles

Nuvio's configured badge rules can read retained stream names and descriptions.
The native `size` field is description text; the separate `videoSize` badge input
is not passed through the inspected native JS mapper. Unknown codec/HDR/size fields
are not invented to work around that boundary.

Embedded tracks follow Nuvio's existing player path. External native subtitle
objects use `url`, `language`, optional `name`, and optional `headers`. Current
Desktop 0.1.23-alpha does not pass the initial external subtitle list through its
player-start call; current Smart drops per-subtitle headers. StreamNest emits the
correct native fields, but cannot repair these client-side omissions by adding
arbitrary JSON properties. Installed subtitle providers remain controlled by Nuvio.

- [Native stream mapping](https://github.com/NuvioMedia/NuvioMobile/blob/13cd02040a6e9b8bc3b5a51c4925fb0603597955/composeApp/src/commonMain/kotlin/com/nuvio/app/features/streams/StreamFetchSupport.kt#L85)
- [Desktop player-start boundary](https://github.com/NuvioMedia/NuvioDesktop/blob/af4803399e77480ca7db75284b89a049cc6fe040/composeApp/src/desktopMain/kotlin/com/nuvio/app/features/player/PlayerEngine.desktop.kt#L39)
- [Smart subtitle normalization](https://github.com/NuvioMedia/NuvioTVSmart/blob/f3f8bcc3674a12366a416f9af5f5dcba8df85c35/js/core/player/pluginManager.js#L216)

Actual UI, playback, badge presets, track switching, seeking and subtitle rendering
are manual Nuvio acceptance checks. The automated runtime harness is not a physical
device test.
