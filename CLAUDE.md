# Aetheris Development Notes

## Project overview

Aetheris is a Node/Fastify application served behind Caddy. The production app
runs from `/var/www/aetheris` under PM2, and Caddy uses the repository's
`Caddyfile` as `/etc/caddy/Caddyfile`.

Important files:

- `index.js` — Fastify application, APIs, WebSocket/Wisp handling, and static files.
- `Caddyfile` — public routing and server-side reverse proxies.
- `public/movies.html` — Movies & TV interface and provider selection.
- `public/js/scramjet-init.js` — browsing-proxy bootstrap used by games/apps.
- `deploy.sh` — pulls `main`, installs dependencies, reloads Caddy, and restarts PM2.
- `notes.md` — production server operational notes.

## Working rules

- Do not deploy unless the user explicitly asks to deploy.
- Do not commit or push unless the user explicitly asks for it or asks to deploy.
- Preserve unrelated working-tree changes.
- Use `apply_patch` for manual file edits.
- Run `pnpm lint` and `git diff --check` after code changes.
- Validate Caddy changes before deployment with:

  ```sh
  Get-Content Caddyfile -Raw | ssh craxvps "caddy validate --adapter caddyfile --config /dev/stdin"
  ```

- A deployment is not complete until the affected live routes are tested.
- For movie playback, test with an iPad/Safari user agent and capture failed
  requests from nested frames. A `200` on the first embed document is not proof
  that playback works.

## Movies proxy constraints

- Movies are intended to use server-side Caddy proxying, not Scramjet or the
  browsing proxy.
- Do not add Scramjet/controller/service-worker dependencies to `movies.html`.
- Movie providers commonly return wrapper pages which load another player
  origin, root-relative assets, APIs, HLS manifests, keys, subtitles, and video
  segments from changing CDN hosts.
- Standard Caddy can rewrite response headers but cannot rewrite arbitrary HTML,
  JavaScript, JSON, or HLS response bodies without an additional module.
- `handle_path /proxy/provider/*` strips the prefix before proxying. A proxied
  document containing `/assets/file.js` will make the browser request
  `https://aetheris.win/assets/file.js`, not
  `/proxy/provider/assets/file.js`.
- Never route all root requests according to a shared cookie or broad Referer
  matcher. That can hijack the entire Aetheris site after a movie loads. This
  exact failure previously caused the homepage to render `streamingnow.mov`.
- Do not hard-code rotating media CDN hostnames as the sole solution.
- Do not assume changing `Origin`, `Referer`, CSP, or frame headers fixes an
  upstream that blocks the VPS IP.

## Known production findings

These were observed on 2026-09-03 and must be rechecked because providers change:

- `vidsrc.to` wrapped the actual player at `vsembed.ru`.
- The Vsembed player requested root-relative `/assets/sbx.js` and
  `/vs_src.php?type=movie&id=...`.
- `www.2embed.cc` wrapped a player at `videm.xyz`.
- `multiembed.mov` redirected to `streamingnow.mov`.
- `streamingnow.mov` returned `403` to the production VPS but `200` from a
  residential/local connection. Caddy on that VPS therefore cannot proxy it
  successfully without a different egress path or provider.
- `vidsrcme.ru` currently resolves playback to `cloudorchestranova.com`
  (player) + `zenithofzircon.space` (HLS). Embed pages, `generate.php`, and
  `master/index.m3u8` proxy fine, but every `/content/.../page-N.html` media
  segment returns a Cloudflare "Attention Required" challenge (`403`,
  `server: cloudflare`) to non-browser HTTP clients — even with a real
  browser UA. The player then retry-storms `generate.php` into `429`,
  `master.m3u8` into `401`, and reloads the player document in a loop.
  Header tweaks cannot fix a Cloudflare browser challenge; treat as an
  upstream block (same category as the `streamingnow.mov` VPS `403`).
  Direct-embed fallback was removed 2026-09-08. Every movie provider now
  goes through `/movie-proxy`; challenged providers remain unavailable until
  their CDN accepts the VPS egress or a second server-side egress is added.
  Observed 2026-09-03 from a local connection; recheck, providers change.
- `www.2embed.cc` → `videm.xyz` (`Server VNE`): the embed page, `api.php`
  (`race`/`play`/`sources`, all `200 application/json`) and `_stream`
  playlists proxy fine through the relay, but every media segment (ByteDance
  ImageX CDN, `p16-ttam-va.ibyteimg.com`) returns
  `{"code":1004,"error":"domain forbidden"}` (`403`) to the production VPS
  regardless of Referer/Origin/UA (verified 2026-09-08 via full curl replay
  of the signed chain from the VPS; no cookies involved anywhere). Same
  upstream-block category as `streamingnow.mov`/`vidsrcme.ru`. 2Embed stays
  proxied per user preference. Titles whose 2Embed servers all funnel to a
  blocked host still fail (verified 2026-09-28: UNABOMBER tmdb=1492640 has no
  swish server — vidsrc.buzz/Videm-direct both hit `relay3.videm.xyz` 429s,
  Vcr is dead, and VidSrc.to's new `filamentoffable.space` CDN 403/429/401s);
  for those, switch the source dropdown or retry later. Because the swish
  path was verified playing real video through the relay, 2Embed replaced
  VidSrc.to as the default on 2026-09-28; VidSrc.to remains as fallback.
  If a 2Embed server recovers VPS access, no code change is needed.
  Recheck, providers change.
- **2026-09-29 — provider sweep, all candidates rejected.** Probed from the
  VPS egress + Playwright playback through the live relay (Backrooms
  tmdb=1083381): `vidsrc.xyz`/`embed.su` DNS-dead; `vidlink.pro` Cloudflare
  403; SuperEmbed redirects to `streamingnow.mov` (CF challenge) and its VIP
  endpoint 404s; VidCore app never calls `/api/sources` (error state, dead
  video); `vidzee` loads but builds no player; `vidsrc.dev` is parked
  (sedoparking); `cinesrc.st` loads but its stream API `a.cineflix.st`
  502s; `vidsrc.sh` wraps the same challenged `cloudorchestranova` chain
  (`sartorialsupernova.space` 403/429/401); `embos.top` resolves no stream;
  `ployan.me` needs opaque per-session tokens (unusable directly);
  123moviesfree's own player JS 404s on their server; `cineby.at` DNS-dead
  and `cineby.ws` 404s all watch paths; `vidking.net` DNS-dead;
  `player.videasy.to` flaps 403 to non-browser clients (curl 200, headless
  Chromium always 403, relay flaky) — front door too unreliable to add.
- **2026-09-29 — hls.lol source REMOVED (VPN slate).** The chain resolves
  and plays 200s end to end, but screenshot verification proved the
  decoded video is an "atlantic.st disable Cloudflare Warp VPN" slate,
  not the title — for all titles, because the VPS egress is flagged as
  datacenter/VPN. Frame counts alone don't prove content; always
  screenshot-verify. Dropdown entry removed (source list back to 4);
  `/hls-resolve` + `hls-player.html` stay tested in case egress
  reputation ever changes.
- **2026-09-29 — lul/aether chain rejected (throttled).** The P-Stream
  `lul.aether.cx` lookup + worker-signed `*.tnmr.org` masters resolve
  (200) and single requests succeed from the VPS, but follow-on
  playlist/segment requests 403 more often than not — two clean
  screenshot-verified playback trials yielded zero frames. Burst
  throttling, possibly with fast signature expiry mixed in. Entry
  removed; route stays for a possible re-test after a long cooldown.
- A prior attempted movie fix was fully reverted. Commits `3cf60bbe` through
  `8cfd2243` document that rollback; do not reintroduce that design.
- **2026-09-28 — 2Embed boot errors fixed; upstream media blocks remain.**
  2Embed now wraps a swish/2vcdn.skin player (server 1) or a vidsrc.buzz
  player (other servers). Five relay/client defects were fixed: (1) the
  JWPlayer base rewrite no longer appends a `#/jwplayer.js` fragment (JW
  derives its webpack base with `src.slice(0, src.lastIndexOf("/jwplayer.js")+1)`;
  the fragment made every chunk request hit the jwplayer.js proxy URL, so
  `provider.hlsjs.js`/`vast.js` 404'd and setup failed with Error 104153);
  the relay now appends a literal `/jwplayer.js` after the percent-encoded
  upstream directory; (2) the relay client re-anchors same-origin URLs that
  provider JS builds from `script.src`/`document.baseURI` onto the upstream
  origin (fixes `/player/jw8/vast.js` being fetched from aetheris.win);
  (3) the relay CSP allows `image.tmdb.org` for poster/backdrop artwork that
  players set via CSS or JS strings the URL hooks cannot see; (4) doctype
  injection removes quirks mode on pages like 2vcdn.skin; (5) the relay now
  refuses the TikTok ad-image "segments" of 2vcdn's decoy hls4 playlist
  (`isDecoyAdImage` in `movie-relay.js`). Without (5) those images fetch and
  buffer successfully through the relay, hls.js plays a black video whose
  clock advances, and the page's hls4 → hls3 fallback never fires; with (5)
  the fallback fires within seconds and the real signed hls3 playlist and
  segments stream through the relay. Still blocked by
  the VPS egress (not code-fixable): `tagivi.com` Cloudflare 403,
  `unfortunatelyejectinflected.com` 403, `relay3.videm.xyz` 429 bursts,
  some signed segment URLs 404. VidSrc.to remains the default fallback.

## Production access

- SSH alias: `craxvps`
- Application directory: `/var/www/aetheris`
- Deployment command on the server: `deploy`
- PM2 application name: `aetheris`

Treat deployment as an external state change: validate locally/remotely first,
deploy only with authorization, then verify the homepage and every changed route.
