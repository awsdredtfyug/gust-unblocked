# Scramjet audit — iPad + Chromebook reliability (2026-09-28)

Focused pass over the browsing proxy after reports that games/apps "sometimes
don't work" on iPads and Chromebooks. Covers `public/js/scramjet-init.js`,
`public/sw.js`, the serve-time bundle patches in `index.js`, and the three
launch paths (`public/js/load.js`, `public/search.html`, `public/cheats.html`).

Versions audited: `@mercuryworkshop/scramjet` 2.0.67-alpha.2,
`@mercuryworkshop/scramjet-controller` 0.0.14, `@mercuryworkshop/libcurl-transport`
2.0.5, `@mercuryworkshop/epoxy-transport` 3.0.1.

Verification: `pnpm lint`, `pnpm check`, and `pnpm test` all pass (44 tests,
one added). Nothing was deployed.

## Fixed in this pass

### 1. Proxy startup could hang forever, and a failed transport had no fallback

`createtransport()` picked one transport and used it unconditionally. That is
fine when it works, but `libcurl-transport`'s `init()` only resolves on the
module's `onload` event and ignores libcurl's `abort` event, so on a device
where WebAssembly is blocked, out of memory, or fails to compile, the promise
never settles. The user got a spinner that never resolved and no error.
Chromebooks default to libcurl (`DESKTOP_UA_CHECK` only special-cases Apple),
so this was a Chromebook-shaped failure.

`public/js/scramjet-init.js` now tries the preferred transport with a 15s
timeout, closes it on failure, and falls back to the other transport before
surfacing an error. Console warns which one failed and which one is being
tried, which makes future field reports diagnosable.

### 2. A dead transport survived every retry (the usual iPad "it stopped working")

iPad Safari suspends background tabs and silently kills WebSockets, and the
Wisp connection is a WebSocket. On return, the cached `Controller`/transport
was permanently dead: `getController()` had cached its promise forever,
`load.js` had cached the controller in a local variable, and "Try again"
reused both. The SW's `$controller$swrevive` path only covers the service
worker dying, not the transport.

Added `window.aetherisProxy.reset()`, which closes the active transport and
clears the cached controller, and made the explicit retry paths rebuild it:

- `load.js` "Try again" calls `reset()` before rebooting.
- `search.html` resets when a proxied navigation fails.
- `cheats.html` resets when opening a cheat frame fails.
- All three stop caching the controller locally; `getController()` owns the
  cache and hands back a fresh instance after a reset.

No automatic reset-on-resume heuristic was added on purpose: a pre-emptive
reset could kill a game that is actually still running. Retry paths are the
safe place for it.

### 3. iPadOS 14.1–15.3 died at proxy boot on two missing Safari 15.4 APIs

scramjet 2.0.67-alpha.2 assumes two APIs Safari only shipped in 15.4:

- `Object.hasOwn` — called by the bundled HTML parser for every parsed
  document (`onattribend`), so every proxied page with any attribute throws.
- `BroadcastChannel` — the controller constructs one unconditionally in its
  constructor, and the client walks `BroadcastChannel.prototype` while
  installing event hooks. A `ReferenceError` here fails controller creation.

The rest of the bundles (class fields, optional chaining) is fine back to
Safari 14.1, so `index.js` now prepends a feature-detected shim to
`/scramjet/scramjet.js` and a new `/controller/controller.api.js` route
serving the controller bundle with the same prefix. On newer browsers both
checks are no-ops; on old iPads the proxy boots instead of throwing.

Trade-off: on those old iPads the `BroadcastChannel` stub drops messages
instead of delivering them, so cross-tab cookie sync and sites that rely on
same-origin `BroadcastChannel` won't work there. That is still strictly better
than the entire proxy failing to start, and the alternative (a real
MessagePort-backed polyfill) is not something the serve-time patch should grow
into. iPads older than 14.1 cannot run the controller's class-field syntax at
all; that floor is unchanged.

### 4. One failed `importScripts` disabled the proxy until the next deploy

`sw.js` imported `/controller/controller.sw.js` once at startup. If that
import failed during a service-worker cold start (flaky school Wi-Fi is
exactly when it happens), `scramjetloaded` stayed `false` for the life of
that worker, and proxied URLs were answered by `fetch(event.request)` — i.e.
our own origin's 404 page — because `/~/sj/` has no real route. The import is
now retried on the first request that needs it, and when it still fails a
proxied **navigation** is sent to `/recover` while proxied subresources get a
clean `503` instead of a fake 404 document.

### 5. `cheats.html` proxy frames had no autoplay/fullscreen delegation

The cheat overlay created its iframe without an `allow` attribute or
`allowFullscreen`, so iPad audio and fullscreen inside those proxied pages
were denied by permissions policy. Both are set now (matching `load.js` and
`search.html`).

## Verified, not bugs

- **libcurl does not need cross-origin isolation.** The bundled libcurl.js
  0.7.4 build has no `SharedArrayBuffer` references (single-threaded build,
  WASM embedded as a data URI), so the missing `Cross-Origin-Opener-Policy` /
  `Cross-Origin-Embedder-Policy` headers are not what breaks Chromebooks.
- **Safari's missing `Request.prototype.body` is already handled.** `sw.js`
  buffers request bodies with `clone().arrayBuffer()` before calling
  `route()`, which also fixes empty POST bodies on Chromium.
- **`Frame#go()` is fire-and-forget.** It sets `iframe.src` and returns
  nothing, so the parent page cannot observe a navigation failure. That is
  why the retry-path resets in fix 2 matter and why an "auto-detect failed
  navigation" approach was not attempted.

## Follow-up improvements (same day)

1. **Transport UI copy now matches the real defaults.** The libcurl card
   describes the actual default (Windows/Linux/ChromeOS/Firefox) and notes
   the automatic epoxy fallback; the epoxy card says it is required on Apple
   devices and used as the fallback elsewhere. The duplicated Apple check in
   `settings.js` and `scramjet-init.js` is commented as a pair that must stay
   in sync.
2. **Desktop-UA spoof refreshed and made consistent.** The claimed Chrome
   version now follows the browser's real major version on Chromium (so it
   matches the machine-generated client hints), with a 154 fallback for
   Safari/iPad instead of the old fixed 120. When spoofing, `buildrouteevent`
   also overrides `Sec-CH-UA`, `Sec-CH-UA-Full-Version-List`,
   `Sec-CH-UA-Platform-Version`, `Sec-CH-UA-Arch` and `Sec-CH-UA-Bitness` so
   server-side version checks can no longer contradict the spoofed UA. A
   regression test evaluates the real `sw.js` in a VM and asserts the
   Chromium-UA path, the Safari fallback, and the injected shim all agree.
   (The `maxTouchPoints: 0` / Win32 consequences on touch-only iPads are
   unchanged — that is inherent to pretending to be a Windows desktop.)
3. **Homepage pre-warm no longer builds a transport on low-memory devices.**
   `index.html` still pre-loads the proxy bundles, but skips the full
   controller (2.1MB libcurl script + WASM compile + Wisp socket) when
   `deviceMemory <= 4`, which covers most school Chromebooks. Devices that
   report more memory (and iPads, which don't expose `deviceMemory`) keep the
   full warm-up.
4. **Frame-aware resume recovery.** `scramjet-init.js` tracks the frames
   created through the current controller and, when the page becomes visible
   again after being hidden for more than a minute with no connected frame,
   drops the cached controller. The next launch builds a live transport
   instead of reusing a Wisp socket the OS already killed. A connected frame
   is never reset, so a game that may still be running cannot be broken by
   this.
5. **HTML shim injection is streamed.** `sw.js` no longer buffers a whole
   proxied document with `response.text()` before it can render: a pump
   decodes/re-encodes chunks and inserts the shims the moment `<head>` /
   `<html>` is seen (or at the 256KB scan cap for fragment-like documents),
   pausing read-ahead when the stream queue is full. Content-Length is still
   stripped and the permissions-policy merge is unchanged. Tests cover the
   first-chunk, split-tag, no-tag, non-HTML, non-200 and Desktop-Mode paths.
   (A pull-only source is not used: a pull that enqueues nothing is not
   guaranteed to be called again — discovered while testing this.)

6. **Blob/data URL requests no longer 404 through the proxy.** When a blob
   URL reached the fetch handler in its percent-encoded form
   (`blob%3Ahttps%3A...`), the controller's blob/data branch tested the raw
   path for a literal `blob:` prefix, missed, and resolved the string against
   our own origin — producing `/blob%3A...` 404s and cascading
   "No frame found for request" errors on Bing and GitHub (blob module
   workers). The serve-time patch decodes the encoded cases before the
   branch. Verified: those 404s are gone and GitHub's console is clean.
7. **Automatic transport failover on TLS rejection.** libcurl's WASM build
   uses its own CA list and rejects some otherwise-valid certificate chains
   (`www.clarity.ms` is a reproducible case: libcurl error 60, epoxy loads
   it fine). `scramjet-init.js` now wraps `transport.request`, and a TLS
   error quietly builds the other transport, swaps it into the controller
   (`controller.setTransport`), and replays the one failed request. Users no
   longer have to flip the transport setting per site; streamed bodies are
   skipped (not replayable).
8. **The injected ad-spoof shim no longer breaks real ad libraries.** Its
   Google Publisher Tag stub executed `googletag.cmd` callbacks immediately
   against fake slot objects, so real GPT later threw
   (`enableSingleRequest is not a function`, ...) on ad-supported sites.
   GPT/AdSense are now passive queue placeholders; the game SDK spoofs
   (CrazyGames, Poki, AdInPlay) are unchanged. Verified: multiplayerpiano.com
   went from six page errors to none, with its live chat still working.
9. **The ad-spoof shim is inlined** after its source is fetched, instead of
   a `<script src="/js/ad-spoof.js">` inside proxied documents. Scramjet's
   patched URL getters log an error for every local script src a page
   enumerates; YouTube produced twelve per load. Verified: zero after the
   change, video still plays.
10. **Closed-frame request noise quieted.** When a page is replaced while its
    background requests are in flight, the controller logs a full stack trace
    per request. The served controller bundle now skips the
    "No frame found for request" case only; other controller errors log
    normally. Redundant `allowfullscreen` attributes were also removed from
    the shell, search, player, and cheat frames (the `allow=` attribute
    already includes fullscreen) to silence Chrome's precedence warning.

## Real-site validation (same day)

Driven with Playwright against a local server (Chrome, Windows UA):

- **Works:** example.com, Wikipedia, DuckDuckGo, Bing, GitHub, Cool Math
  Games, Kahoot, Chess.com (navbar poll aside), Discord login, YouTube
  (video buffers and plays through the proxy), Multiplayer Piano
  (WebSockets and audio), and the Unity WebGL game "Slope" from the truffled
  catalog (renders and runs).
- **POST/query integrity:** verified end-to-end against httpbin — JSON POST
  body arrives with Content-Length, empty POST arrives as `Content-Length: 0`,
  query strings are preserved.
- **Navigation lifecycle:** traversing DuckDuckGo → Bing → GitHub → Cool Math
  Games → Chess.com → Kahoot in one session loads every page with no
  closed-frame request errors after the quieting patch.
- **Known upstream limitations:** WebAuthn/passkeys cannot work through any
  rebasing proxy (RP ID mismatch, logged and ignored by Discord); Cloudflare
  `cdn-cgi/challenge-platform` scripts 404 through the proxy (token-bound,
  page loads unaffected); the y8/Unity analytics host `tbt.mx` is dead
  upstream (500s in the Slope console, no gameplay impact); `clarity.ms`
  TLS is handled by the failover above.

## Recommended, not changed

1. **A true transport liveness probe is still missing.** The resume handler
   above recovers the common case (tab returns after minutes with nothing
   framed), but a dead transport behind a still-connected frame is only
   recovered when the user retries. A probe (e.g. a HEAD request through
   `controller.transport` on resume) could detect that, but it needs
   real-device validation to avoid killing live games.
2. **Blocked-site fingerprinting is still a hard blocker.** School filters
   that block `wss://` to non-allowlisted hosts or block the VPS egress stop
   both transports; the fallback cannot help there. Worth keeping the
   recovery page's guidance as the documented escape hatch.

## Validation notes for the next live pass

- iPad Safari: launch a proxied game, background the tab for a few minutes,
  return, and hit "Try again" — it should now recover without a reload.
- iPadOS 14.x/15.0–15.3 (if a device is available): confirm the controller
  boots and a proxied page loads; expect console warnings about no
  `BroadcastChannel` fallback only if code actually tries to use it.
- Chromebook: force the libcurl path to fail (e.g. block `/libcurl/index.mjs`
  in DevTools) and confirm the fallback to epoxy still launches a game.
- Throttle to Slow 3G and confirm the transport timeout produces a fallback
  or an error instead of an infinite spinner.
- Load a large proxied page and confirm it starts rendering before the whole
  document has arrived, with the panic-key/audio shims still present in the
  document head (streamed injection).
- On the game shell (nothing framed), background the tab for a couple of
  minutes, return, then launch a game; it should build a fresh transport
  instead of failing on the suspended one.
