# Native Nuvio compatibility

StreamNest installs as a native repository: root `manifest.json`, `scrapers`, and
the referenced JavaScript files. Every stream lookup runs on the Nuvio device.
Public TMDB and Cinemeta endpoints supply title, year, and identity metadata to
the JavaScript providers. GitHub supplies the manifest and provider bundles.

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

## Native contract

The bundled providers export:

```js
module.exports.getStreams(id, mediaType, season, episode)
```

Nuvio normally supplies a typed TMDB identity with `movie` or `tv`. StreamNest also
validates IMDb and compatible prefixed IDs and rejects conflicting episode
coordinates. Xtream exports `onSettings()` and declares `hasSettings: true`.
The settings keys are `host`, `username`, and `password`.

The providers read Nuvio's `fetch`, URL APIs, and `SCRAPER_SETTINGS`. Parser and
decoder dependencies are bundled. They do not use Node filesystem/network APIs,
`Buffer`, a separate backend, or a supposedly persistent JavaScript catalog cache.

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

StreamNest parses text explicitly. Categories are read with bounded concurrency,
and incomplete required categories are never silently converted to empty results.
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
