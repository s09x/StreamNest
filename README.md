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

## Providers

| Provider | Content | Configuration |
| --- | --- | --- |
| StreamNest \| Filmpalast | Movies and series episodes | None |
| StreamNest \| Filmo | Movies on runtimes with manual redirect support | None |
| StreamNest \| Xtream VOD | Movies and series from your account | Host, username, password in native provider settings |

Filmpalast and Filmo currently resolve their supported VOE mirrors. An unsupported
or blocked mirror is not presented as a playable stream. Other working mirrors
remain usable when one mirror fails. Live TV and MediathekViewWeb are outside the
scope of this repository.

Filmo requires a fetch bridge that honors manual redirects, verified in the
inspected Android Mobile and Desktop clients. It checks that capability before
creating a source session. The inspected iOS, Android TV and Smart TV bridges do
not support that controlled redirect path. Those clients receive an explicit
unsupported-runtime error for Filmo. Filmpalast does not require this Filmo flow.

The [source comparison](docs/source-selection.md) records the findings for all
requested sources, including PrimeWire, Moflix, KinoGer, Movie2k, SerienStream and
HDFilme, plus the additional sources considered.

## Xtream setup

Open the settings for **StreamNest | Xtream VOD** in a Nuvio client that exposes
native provider settings. Enter your full server URL (including the port when
needed), username, and password. These values are read from Nuvio's
`SCRAPER_SETTINGS`; they are never added to the public JavaScript files.

Nuvio controls the settings UI, local storage, and any device synchronization.
The currently inspected Android TV/Smart TV versions do **not** provide a verified
phone-to-TV transfer of arbitrary native provider settings. Adding the repository
from a phone does not itself transfer Xtream credentials. This client limitation
is not solved or hidden by this plugin. See [native compatibility](docs/native-compatibility.md).

The provider queries categories directly from your server. It uses complete JSON
responses and, where supported, smaller Enigma2 XML lists for oversized series
categories or episode details. It does not store a private catalog in GitHub or
depend on a separately hosted StreamNest service. Servers without a usable compact
response, or clients with lower response limits, can still report an explicit
incomplete-response error.

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
Xtream `onSettings` export.

Commit the manifest, generated providers, and `THIRD_PARTY_NOTICES.md` together
with source changes. Increment the package version for provider updates so Nuvio
can identify a new version. CI verifies that the committed artifacts match the
build. Runtime dependency notices are generated from the bundled packages.

Live checks are explicit opt-in operations. `scripts/check-native.mjs` runs an
actual built provider with a configurable native response limit. Xtream settings
enter that checker only through private standard input; do not place real
credentials in command arguments, source files, fixtures, or committed files.

See [verification](docs/verification.md) for executed checks and their limits.
