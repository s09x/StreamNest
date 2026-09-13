# Source selection

The comparison below records direct HTTP observations made on 2026-09-13.
Cloudflare, DDoS-Guard, and hoster behavior can differ by IP address and change
over time. A successful catalog page is not evidence that its final media route
works inside Nuvio. No browser challenge solver is included in the providers.

| Source | Search and matching | Observed playback or blocking boundary | Decision |
| --- | --- | --- | --- |
| [Filmpalast](https://filmpalast.to/) | HTML title search at `/search/title/<title>`. Sampled movie/episode details supplied title, year and explicit `SxxExx`, without a public IMDb ID. | Six observed hoster families are handled: VOE, VIDARA, Vixeo, FireStream, FlyFile and Playmate. Doctor Strange 2 has working alternatives to its missing VOE file. | Included for movies and exact series episodes; see the [hoster verification](hosters.md) for successful and blocked paths. |
| [Filmo](https://filmo.to/) | JSON `/search/suggest?q=<title>` returns movie titles and detail URLs; year is verified on the detail page. | Fresh cookie/CSRF minting leads either to VOE's controlled redirect or Byse's same-origin HTML handoff. Byse uses its ordinary attestation/proof and encrypted playback response. | Included for movies through both observed hosters, subject to each native runtime requirement. Series support was not established. |
| [Moflix](https://moflix-stream.xyz/) | HTML bootstrap data included IMDb/TMDB IDs, original title, year and episode coordinates. Title searches worked; the sampled IMDb search was empty. | HTML returned 200 behind Cloudflare/JSD while `/api/v1/search` returned a Cloudflare 403. One VidHide mirror returned an HLS response; GUpload showed maintenance and Vidara required additional POST/decoding work. | Not included: catalog access and multiple hoster paths do not yet form a verified native provider. |
| [KinoGer](https://kinoger.com/) | DLE title search and inline player arrays; sampled details lacked public identity IDs. | Pages returned 200 behind Cloudflare/JSD. A Fallout fsst/incvideo mirror exposed an MP4 with range support; the sampled Inception Dood path required Turnstile. | Not included: title matching plus additional, inconsistent hoster paths need their own native implementation and acceptance checks. |
| [Movie2k](https://movie2k.cx/) | `/search?q=<title>` and IMDb IDs on sampled details, with series parameters. An IMDb query returned no search results. | Catalog pages returned 200. VOE JavaScript redirects and the encoded public player data were observed. | A possible later adapter, but no complete native Movie2k search-to-stream implementation was verified for this release. |
| [PrimeWire](https://primewire.mov/) | `/api/v1/s` accepted media type, IMDb ID and episode coordinates. Sample queries returned 23 Inception, 30 Fallout and 9 Dark source rows. | Both inspected link-resolution routes returned Cloudflare 403 challenges; `/filter` returned 401. Source rows declared English, while actual audio and a German fallback were not verified. | Not included: the direct catalog API works, but usable German media resolution was not established. |
| [SerienStream](https://serienstream.to/) | `/api/search/suggest?term=<title>` worked; an IMDb term returned no suggestions. Details exposed IMDb and explicit episodes. | Catalog pages returned 200 behind DDoS-Guard. The episode `/r` handoff encountered Turnstile and an optional ALTCHA path; the final route remained unresolved. | Not included: the playback handoff has not been verified in the native runtime. |
| [HDFilme](https://hdfilme.to/) | Root, category and detail pages returned 200. Advertised IMDb search returned a PHP fatal type error twice despite HTTP 200. | The sampled `/dl/2022` route reported a VPN requirement and referred to an external destination; no valid final media chain was established. | Not included: neither the advertised identity search nor a playable native route passed the checks. |
| [AniWorld](https://aniworld.to/) | Anime catalog pages exposed episode coordinates, language choices and IMDb information. | DDoS-Guard-fronted pages and redirect routes were observed, without a complete accepted media chain. | Not included: narrower anime scope and an unverified handoff. |
| Xtream VOD | Native user settings and direct account API. Public IDs are preferred; only unique exact-title/year candidates can supplement them after detail verification. | Form POST reads JSON metadata. Complete Enigma2 XML provides a smaller series route on the tested server when native response limits truncate JSON. | Included for account movies and series. Credentials and account addresses are never published. |

MediathekViewWeb was excluded at the user's explicit request. Live television is
outside the requested movie/series scope.

The release provides the verified paths above. It does not claim universal hoster
coverage, an undocumented JSON API for every source, or permanent immunity to
challenge and parser changes. See [native compatibility](native-compatibility.md)
and [verification](verification.md) for the client boundaries and executed tests.
