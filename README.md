# StreamNest

StreamNest is a **native Nuvio plugin repository** for German movies and series.
Nuvio downloads the manifest and bundled JavaScript providers from this repository
and executes them in its own plugin runtime.

## Installation

In Nuvio, open **Settings → Plugins → Add Repository** and add:

```text
https://github.com/s09x/StreamNest
```

If the client asks for a manifest URL, use:

```text
https://raw.githubusercontent.com/s09x/StreamNest/main/manifest.json
```

The compiled files in `providers/` are included in the repository. Node.js and the
development tools are not needed to use the providers in Nuvio.

Version 0.1.3 corrects another Nuvio Mobile URL-bridge incompatibility: absent
query and fragment values were exposed as `?` and `#`, causing valid Filmpalast
and Filmo links to be rejected. It also reduces Xtream catalog requests when the
server can return a complete list. After updating, refresh the repository and
check that the installed providers show **0.1.3**.

## Providers

| Provider | Content | Configuration |
| --- | --- | --- |
| Filmpalast | Movies and series episodes | None |
| Filmo | Movies through VOE and Byse | None |
| Xtream VOD | Movies and series from your account | Host, username, password in native provider settings |

Filmpalast supports the six hoster families observed in the inspected movie and
episode pages: **VOE, VIDARA, Vixeo, FireStream, FlyFile and Playmate**. Mirrors are
resolved with at most three concurrent workers. A failing mirror does not suppress
working alternatives, and their display order remains stable.

Filmo recognizes **VOE and Byse**, including separate language and quality rows.
Its VOE handoff requires a fetch bridge that honors manual redirects so Filmo's
session cookie can be removed before crossing origins. Byse uses a same-origin
HTML handoff; it can be used independently of that VOE requirement. Duplicate
Byse destinations within one lookup share the same resolution work.

Byse performs its published server attestation and automatic proof-of-work and
authenticates the returned playback data before using it. This requires a secure
randomness API in the native client. Proof computation is bounded; an actual
interactive challenge or an exhausted computation budget remains an explicit
failure. See [native compatibility](docs/native-compatibility.md) for client
capabilities and [hoster verification](docs/hosters.md) for observed results.

Some upstream files can still be deleted or blocked. For example, the inspected
Doctor Strange 2 VOE file was missing while VIDARA and FlyFile worked; the sampled
Playmate CDN returned a service-level restriction. Such failures do not produce
invented playable URLs. Live TV and MediathekViewWeb are outside this repository's
movie/series scope.

The [source comparison](docs/source-selection.md) records the findings for all
requested sources, including PrimeWire, Moflix, KinoGer, Movie2k, SerienStream and
HDFilme, plus the additional sources considered.

## Xtream setup

Open the settings for **Xtream VOD** in a Nuvio client that exposes
native provider settings. Enter your full server URL (including the port when
needed), username, and password. These values are read from Nuvio's
`SCRAPER_SETTINGS`; they are never added to the public JavaScript files.

The settings export returns the three input fields synchronously. Provider bundles
are compiled to ES2016 and have classes lowered for Hermes dynamic loading, while
remaining executable in the tested QuickJS runtime. Refresh the repository after
an update so Nuvio downloads the corrected JavaScript files.

The reported gear-button failure was traced to the inspected Nuvio Enhanced client:
its settings loader evaluates code that calls native host functions before
registering those functions. It fails before loading Xtream. The user confirmed
that downgrading Nuvio Enhanced restored the menu. Updating this provider cannot
repair that client startup error; see [the source diagnosis](docs/native-compatibility.md#nuvio-enhanced-settings-regression).

Nuvio controls the settings UI, local storage, and any device synchronization.
The currently inspected Android TV/Smart TV versions do **not** provide a verified
phone-to-TV transfer of arbitrary native provider settings. Adding the repository
from a phone does not itself transfer Xtream credentials. This client limitation
is not solved or hidden by this plugin. See [native compatibility](docs/native-compatibility.md).

The provider first requests the complete movie or series catalog directly from
your server. A complete supported response avoids downloading every category
separately: a single exact match can require just authentication, catalog and
details. Bulk responses above 8,388,608 characters are not parsed. Unsupported,
empty, malformed, oversized or truncated bulk responses fall back to complete
category requests; supported Enigma2 XML lists remain available for oversized
series responses. Large catalogs on clients with small response limits can
therefore still be slow. No private catalog is stored in GitHub or in a separate
StreamNest service, and no persistent cache is assumed in an isolated runtime.

## Native presentation

Streams use Nuvio's existing selection and player. Available technical metadata
is included in fields Nuvio retains for its badge rules and stream description.
Only supplied metadata is reported; a default language is not treated as a complete
audio-track inventory, and HEVC does not imply HDR.

Embedded audio and subtitles stay in the original media. Source-published external
subtitles are returned through the native `subtitles` field with their language,
name, and required headers. Actual badge visibility, audio selection and subtitle
rendering depend on the Nuvio client and its settings. Known client-side field
limitations are documented in the compatibility notes.

## Development

Use Node.js 24 or later:

```sh
npm ci
npm run check
```

The check runs TypeScript validation, rebuilds `manifest.json` and `providers/`,
and executes unit and QuickJS integration tests. Build output isolates dependency
variables from Nuvio's globals and exposes `module.exports.getStreams` plus the
Xtream `onSettings` export. Syntax checks reject native async syntax and unlowered
classes in generated artifacts; an actual Hermes compiler was also used during
the compatibility investigation.

Commit the manifest, generated providers, and `THIRD_PARTY_NOTICES.md` together
with source changes. Increment the package version for provider updates so Nuvio
can identify a new version. CI verifies that the committed artifacts match the
build. Runtime dependency notices are generated from the bundled packages.

Live checks are explicit opt-in operations. `scripts/check-native.mjs` runs an
actual built provider with a configurable native response limit. Xtream settings
enter that checker only through private standard input; do not place real
credentials in command arguments, source files, fixtures, or committed files.
Use `--url-runtime nuvio-mobile --redirects follow` to exercise the modeled Mobile
relative-URL behavior and automatically followed redirects. This mode does not
emulate the entire iOS networking stack or the app's UI.

`scripts/check-enhanced.mjs` additionally loads the original JavaScript bindings
from a local Nuvio Enhanced checkout and executes them with the built provider in
QuickJS. It adapts native calls to Node and serializes HTTP requests like the
inspected bridge. Use `--client-root` to select the checkout. It cannot validate
the installed app, its UI, or the iPhone's network connection.

See [verification](docs/verification.md) for executed checks and their limits.
