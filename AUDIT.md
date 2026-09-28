# Audit — 2026-09-28

A full read-through of the server (`index.js`, `lc-relay.js`, `movie-relay.js`,
`monitor.js`, `lib/`), the Caddy config, the deploy script, the frontend pages
and scripts, and the test suite. Findings below are split into what was fixed
in this pass and what is recommended but intentionally not changed.

Run `pnpm lint && pnpm check && pnpm test` to reproduce the verification.
Nothing was deployed.

## Fixed in this pass

### User-facing

- **404 page trapped users on nested URLs.** The "Go home?" button used
  `./index.html`, which resolves to `/foo/index.html` (another 404) for any
  unmatched path with more than one segment. `navigation.js` now navigates to
  `/index.html#home`, and Ctrl/Cmd/Shift/middle-click are left to the browser
  so links can open in a new tab. (`public/js/navigation.js`)
- **Update modal could become impossible to dismiss.** `home.html` wrote
  `localStorage` before hiding the overlay; with storage disabled/full the
  write threw and the full-screen modal never hid. It now uses the
  `Aetheris.storage` safe wrapper and the close button receives focus.
  (`public/home.html`)
- **Kahoot cheat card silently did nothing** (placeholder item with no URL or
  copy text). It now shows "No cheats for this game yet". Cheat cards and menu
  items are real buttons / keyboard-activatable, the proxy overlay is a
  labelled dialog with Escape support, proxy navigation failures render an
  error instead of a black screen, and the Blooket bookmarklet is built from
  `location.origin` so forks work. (`public/cheats.html`)
- **Search page printed raw stack traces** into the visible error area; it now
  logs them to the console and shows the message. Back/forward to a URL
  without `?q` clears the stale proxied frame. The URL heuristic no longer
  treats "3.5mm jack fix" as a hostname. Loading/error text is announced to
  screen readers. (`public/search.html`)
- **`?fps` substring false positive**: `search.html?q=fps+games` showed the
  debug FPS overlay. Now an exact flag match. (`public/js/preload.js`)
- **Catalog script failures left libraries stuck on "Loading…" forever.**
  `apps.html` and `maths.html` now surface the retry/error state when their
  data script fails to load. (`public/apps.html`, `public/maths.html`)
- **AI panel fixes** (`public/js/ai.js`): model discovery now sends the auth
  token (it silently fell back to two hardcoded models when
  `AI_REQUIRE_LOGIN=true`); a mid-stream error aborts the response body
  instead of leaving it downloading; image generation has a timeout and abort;
  images from older turns are trimmed before they can trip the 20 MB request
  cap; a cleared chat can no longer be repopulated by a slow `FileReader`.
- **Report modals are accessible** on both the home page and the game player:
  dialog semantics, linked labels, `aria-pressed` type buttons, live status
  region, labelled close button, and focus returned on close.
  (`public/home.html`, `public/load.html`)
- **Chat/minichat**: tab state announced (`role="tab"`/`aria-selected`),
  conversation rows and user-search results are keyboard-operable, icon-only
  buttons have labels, minichat has a `<title>`, and Escape closes the New
  Message dialog from anywhere. (`public/chat.html`, `public/minichat.html`,
  `public/js/chat.js`, `public/js/dm-shared.js`)
- **Bookkeeping bug fixes**: About page pointed at a non-existent "forum"; the
  UGS tile image alt text didn't match its label. (`public/about.html`)
- **Cache-key consistency**: all pages now request `usability.css` with the
  same version (`20260928.1`); three pages were using a stale key.

### Server / reliability

- **Lethal Company relay IP cap was global.** Caddy connects from loopback, so
  every socket counted as `127.0.0.1` and the per-IP room limit of 5 was a
  server-wide cap. The relay now reads the real client from the rightmost
  `X-Forwarded-For` entry (falling back to the socket). It also rejects
  cross-origin WebSocket upgrades, caps the client version string, rejects
  control characters in room codes, and sanitizes log output.
  (`lc-relay.js`)
- **`/api.php` (Videm subtitle compat route) bypassed the movie relay rate
  limit** because the limiter only matched `/movie-proxy`. It is now under the
  same 600/min per-IP cap. (`index.js`)
- **Movie relay**: `mailto:`/`tel:` links are no longer proxied into a 403,
  and the HTML CSP now allows `flagcdn.com` images, which the subtitle picker
  uses. (`movie-relay.js`)
- **Monitor** (`monitor.js`): downtime is no longer double-counted across
  reports and at recovery; Caddy reload results are checked instead of
  assuming success; recovery actions have a 5-minute cooldown; malformed
  `DOMAINS`/interval/port env values fall back instead of causing an uncaught
  rejection or hot loop; tick/report rejections are logged instead of killing
  the process.
- **`deploy.sh` orphan detection could never match** PM2-started processes
  (`node --env-file=... index.js` does not contain the literal `node index.js`)
  and mishandled multi-line `pm2 pid` output. It now matches `index.js` plus
  the directory check, normalizes the managed PID list, and verifies the app
  answers on its loopback port before printing "Done".
- **`scripts/check-source.js` silently skipped catalog JSON validation on
  Windows** (`file.includes("assets/data")` vs backslash paths) and would
  false-fail inline `type="module"` blocks. Both fixed; catalog parsing now
  actually runs in `pnpm check`.
- **Caddyfile**: removed the dead `(movie_proxy)` snippet (never imported), and
  excluded `/api/*` from the wildcard CORS preflight so arbitrary websites can
  no longer drive login/registration requests through visitors' browsers.
  (`Caddyfile` — validate with `caddy validate` before deploying.)

### Tests

`pnpm test` now runs 40 tests (was 36). Added:

- navigation fallback + modified-click behavior (`tests/site.test.js`)
- backup import version/format hardening and structured value round-trips
  (`tests/backup.test.js`)
- lc-relay cross-origin rejection, same-origin room creation, and crafted
  room-code rejection (`tests/api.test.js`)

Local smoke test: server boots, `GET /foo/bar` returns the 404 page,
`/api.php` rejects invalid refs, `/movie-proxy` still blocks private targets
and relays `example.com` with the expected CSP.

### Follow-up (same day): source-blocked cover images

Game cards, app icons and movie posters loaded directly from third-party hosts,
so a school DNS filter on `truffled.lol` / `igroutka.ru` / `velara.my` /
`cdn.jsdelivr.net` left every card on a placeholder. Remote images now go
through a same-origin `/img?url=` relay (`lib/image-proxy.js`) that reuses the
SSRF-hardened fetch in `lib/public-network.js`, validates redirects and
addresses, caps size/type (png/jpeg/webp/gif/avif), keeps a small in-memory
LRU, and serves long-lived browser-cacheable responses. `Aetheris.imageUrl()`
wires every card/poster renderer (`games.js`, `apps.js`, `load.js`,
`movies-ui.js`, `ai.js`) to it. The `truffled.json` catalog was also refreshed
from `https://truffled.lol/js/json/g.json` (604 games), and `petezah.json` was
re-pointed at PeteZah's live catalog
(`https://petezahgames.com/storage/data/collection.json`, 1209 games; the
captcha-gated `/iframe.html` wrappers are resolved to direct game URLs, and
three malformed cover URLs were repaired).

PeteZah's own catalog ships 23 dead game URLs and 82 dead covers (mostly the
`storage/ag/echo/*` collection, which 404s on their server). They are kept for
parity and will start working if PeteZah restores the files.

## Recommended, not changed

Ordered by value; each needs a product decision or live validation before
touching.

1. **Raise the registration password minimum** from 4 characters
   (`index.js`). Existing accounts are unaffected, but it changes what users
   can choose.
2. **`data-transfer.js` export builds the full JSON before checking the
   128 MB limit**, so a very large save can OOM before the guard runs. A
   streaming size estimate while dumping would fix it.
3. **`movie-relay.js` only rewrites quoted `src/href/data-src/data-api`
   attributes**; `srcset`, `action`, `poster` and unquoted attributes fall
   through. The client-side hooks cover most dynamic cases; static HTML with
   `srcset` still resolves against the relay origin.
4. **`/movie-proxy` remains an unauthenticated, CORS-wide forward relay** with
   a small blocklist. It validates destinations and caps text bodies, but a
   determined user can still relay arbitrary public POST traffic through the
   VPS. An upstream allowlist or an auth gate would close this; it would also
   break currently working providers unless done carefully.
5. **`lc-relay` has no per-socket message-rate limit** (frames are capped at
   1 MB and backpressure terminates above 4 MB buffered). A token bucket per
   connection would bound CPU/bandwidth further.
6. **The on-demand TLS `ask` matcher accepts any `*.aetheris.win` /
   `*.crax.lol` subdomain.** Only someone controlling those domains' DNS can
   exploit it, so it is low risk; an exact hostname allowlist is stricter.
7. **`sw.js` restores the desktop-UA spoof flag asynchronously**, so requests
   handled before the restore finishes can miss spoofing. Gating route handling
   on that promise would close the window.
8. **AI model menu keyboard navigation** supports Tab/Escape but not
   arrow keys, and the model list items could use a proper listbox role.
9. **`public/js/theme.js`'s `applyTheme()` does not persist the choice**
   (callers currently persist separately); easy to make self-contained.
10. **Documentation**: `README.md` has no development/test section; the audit
    and verification commands live in `QA.md` and this file.
