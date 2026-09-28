var MIGRATION_VERSION = 2;

async function migrateifneeded() {
  var needed = true;
  try {
    var meta = await caches.open("__sw_meta__");
    var resp = await meta.match("/migration-version");
    if (resp) {
      var v = parseInt(await resp.text(), 10);
      if (v >= MIGRATION_VERSION) needed = false;
    }
  } catch (e) {}

  if (!needed) return;

  console.log("[SW] running one-time DB migration v" + MIGRATION_VERSION);

  await new Promise(function (resolve) {
    var req = indexedDB.deleteDatabase("scramjet-config");
    req.onsuccess = function () {
      console.log("[SW] scramjet-config deleted");
      resolve();
    };
    req.onerror = function () {
      console.warn("[SW] scramjet-config delete error");
      resolve();
    };
    req.onblocked = function () {
      console.warn("[SW] scramjet-config blocked — will retry next install");
      resolve();
    };
    setTimeout(resolve, 3000);
  });

  try {
    var meta2 = await caches.open("__sw_meta__");
    await meta2.put(
      "/migration-version",
      new Response(String(MIGRATION_VERSION)),
    );
  } catch (e) {}
}

var scramjetloaded = false;
var spoofdesktopua = false;

// derive every same-origin check from the SW's own origin so self-hosters on
// other domains get the same bypass/rewrite behavior as aetheris.win
var SITE_ORIGIN = self.location.origin;
var SITE_HOST = self.location.hostname;

// spoofdesktopua lives in SW memory, which the browser can recycle at any
// time — persist it in the __sw_meta__ cache so a restarted SW restores the
// user's setting instead of silently dropping it.
(function restorespoofstate() {
  caches
    .open("__sw_meta__")
    .then(function (c) {
      return c.match("/spoof-desktop-ua");
    })
    .then(function (r) {
      return r ? r.text() : null;
    })
    .then(function (v) {
      if (v !== null) spoofdesktopua = v === "1";
    })
    .catch(function () {});
})();

function persistspoofstate(enabled) {
  caches
    .open("__sw_meta__")
    .then(function (c) {
      return c.put("/spoof-desktop-ua", new Response(enabled ? "1" : "0"));
    })
    .catch(function () {});
}

// Desktop-UA spoofing. On a Chromium browser the claimed Chrome version
// follows the real one, so the spoofed navigator.userAgent matches the
// Sec-CH-UA request headers the browser actually generates. Safari (iPad)
// has no Chrome version to borrow, so it claims a recent stable one — keep
// CHROME_FALLBACK_MAJOR roughly current or version-gated sites start
// treating the spoof as an unsupported browser.
var CHROME_FALLBACK_MAJOR = "154";
var spoofchromemajor = (function () {
  var match = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent);
  return match ? match[1] : CHROME_FALLBACK_MAJOR;
})();
var spooffullversion = spoofchromemajor + ".0.0.0";
var spoofbrandsjson = JSON.stringify([
  { brand: "Chromium", version: spoofchromemajor },
  { brand: "Google Chrome", version: spoofchromemajor },
  { brand: "Not=A?Brand", version: "99" },
]);
// Request-header values matching the shim below, applied in buildrouteevent.
var spoofuach =
  '"Chromium";v="' +
  spoofchromemajor +
  '", "Google Chrome";v="' +
  spoofchromemajor +
  '", "Not=A?Brand";v="99"';
var spoofuachfull =
  '"Chromium";v="' +
  spooffullversion +
  '", "Google Chrome";v="' +
  spooffullversion +
  '", "Not=A?Brand";v="99.0.0.0"';

var desktopua =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" +
  spooffullversion +
  " Safari/537.36";

var desktopuashim =
  "<script>" +
  "(function(){" +
  "  if (window.__aetherisDesktopUASpoofInstalled) return;" +
  "  window.__aetherisDesktopUASpoofInstalled = true;" +
  "  var pcua = " +
  JSON.stringify(desktopua) +
  ";" +
  "  function def(obj, key, value) {" +
  "    try { Object.defineProperty(obj, key, { get: function(){ return value; }, configurable: true }); } catch(e) {}" +
  "  }" +
  '  def(Navigator.prototype, "userAgent", pcua);' +
  '  def(Navigator.prototype, "platform", "Win32");' +
  '  def(Navigator.prototype, "maxTouchPoints", 0);' +
  '  def(Navigator.prototype, "vendor", "Google Inc.");' +
  "  try {" +
  '    Object.defineProperty(Navigator.prototype, "userAgentData", {' +
  "      get: function(){" +
  "        return {" +
  "          brands: " +
  spoofbrandsjson +
  "," +
  "          mobile: false," +
  '          platform: "Windows",' +
  "          getHighEntropyValues: function(hints) {" +
  "            var values = {" +
  "              brands: this.brands," +
  "              mobile: false," +
  '              platform: "Windows",' +
  '              architecture: "x86",' +
  '              bitness: "64",' +
  '              model: "",' +
  '              platformVersion: "10.0.0",' +
  "              uaFullVersion: " +
  JSON.stringify(spooffullversion) +
  "," +
  "              fullVersionList: this.brands" +
  "            };" +
  "            var out = {};" +
  "            (hints || []).forEach(function(k){ if (k in values) out[k] = values[k]; });" +
  "            return Promise.resolve(out);" +
  "          }" +
  "        };" +
  "      }," +
  "      configurable: true" +
  "    });" +
  "  } catch(e) {}" +
  "})();" +
  "<\/script>";

// scramjet v2 restructured the service worker from a self-contained proxy
// engine (v1's ScramjetServiceWorker — proxy.route()/proxy.fetch() did all the
// rewriting right here) into a thin relay: controller.sw.js only knows how to
// forward a fetch to whichever browser tab's Controller registered the
// matching /~/sj/<id>/ prefix (see the "$controller$init" postMessage in
// scramjet-init.js) and get the already-rewritten Response back over a
// MessageChannel. There's no more loadConfig()/configready gate — a request
// either matches a live tab's prefix (shouldRoute) or it doesn't.
// Import at startup is the happy path, but a transient network failure during
// a service-worker cold start must not disable the proxy until the next
// deploy: re-attempt the import from the fetch handler whenever a request
// actually needs the controller. importScripts is idempotent inside one
// worker, so repeat calls after a success are a no-op (scramjetloaded gate).
function ensurecontrollerloaded() {
  if (scramjetloaded) return true;
  try {
    importScripts("/controller/controller.sw.js");
    scramjetloaded = true;
  } catch (err) {
    console.error("[SW] Scramjet controller failed to load:", err);
    scramjetloaded = false;
  }
  return scramjetloaded;
}
ensurecontrollerloaded();

// Builds the object we hand to $scramjetController.route(). It duck-types the
// fields route()/shouldRoute() actually read off a FetchEvent, for two reasons.
//
// 1. Request body. route() forwards `event.request.body` — the live
//    ReadableStream — to the controller. Request body streams are a
//    Chromium-only feature; in other engines (Firefox, where the Discord 400
//    was reproduced) `Request.prototype.body` is not exposed on requests at
//    all, so that read yields undefined and the POST reaches the origin with
//    an empty body. Discord's API answers a bodyless JSON POST with
//    400 Bad Request. Reading the body with .arrayBuffer() instead works
//    everywhere, and an ArrayBuffer is already one of the RPC's documented
//    body types — route()'s own transfer-list check accepts it unchanged.
//    Buffering also sidesteps the live-stream-transfer semantics that made
//    bodies arrive empty in Chromium too.
//
// 2. Desktop-UA spoofing. v1 let us mutate request headers in-SW via
//    proxy.addEventListener("request", ...) before the request went out. v2's
//    route() builds its headers straight off event.request on the controller
//    side, so the headers have to be right before route() ever sees them.
//    This can't be `new Request(event.request, { headers })`: a Request's
//    .headers always has guard "request", and the Fetch spec's header-fill
//    algorithm silently drops forbidden names (User-Agent, every Sec-CH-UA-*)
//    when filling a "request"-guarded Headers object — regardless of what
//    guard the source headers had. A bare `new Headers()` is unguarded and has
//    no such filtering, so we copy into one of those instead.
function hasrequestbody(req) {
  return req.method !== "GET" && req.method !== "HEAD";
}

async function buildrouteevent(event) {
  var req = event.request;
  var spoof = spoofdesktopua;
  var withbody = hasrequestbody(req);

  // Nothing to rewrite — hand route() the real FetchEvent untouched.
  if (!spoof && !withbody) return event;

  try {
    var headers;
    if (spoof) {
      headers = new Headers();
      for (var pair of req.headers) headers.set(pair[0], pair[1]);
      headers.set("User-Agent", desktopua);
      headers.set("Sec-CH-UA-Mobile", "?0");
      headers.set("Sec-CH-UA-Platform", '"Windows"');
      // Client hints would otherwise leak the real engine/version and
      // contradict the spoofed UA. A bare Headers() is unguarded, so these
      // Sec- names are not filtered out here (see the note above).
      headers.set("Sec-CH-UA", spoofuach);
      headers.set("Sec-CH-UA-Full-Version-List", spoofuachfull);
      headers.set("Sec-CH-UA-Platform-Version", '"10.0.0"');
      headers.set("Sec-CH-UA-Arch", '"x86"');
      headers.set("Sec-CH-UA-Bitness", '"64"');
    } else {
      headers = req.headers;
    }

    // clone() so the original request stays unconsumed for the error paths.
    // Must happen before the first await, while the body is still undisturbed.
    var bodypromise = withbody ? req.clone().arrayBuffer() : null;
    var body = bodypromise ? await bodypromise : null;

    return {
      request: {
        url: req.url,
        referrer: req.referrer,
        destination: req.destination,
        mode: req.mode,
        method: req.method,
        body: body,
        cache: req.cache,
        headers: headers,
      },
      clientId: event.clientId,
      resultingClientId: event.resultingClientId,
    };
  } catch (e) {
    console.error("[SW] failed to build route event, using original:", e);
    return event;
  }
}

var recoveryhtml =
  "<!DOCTYPE html>" +
  '<html lang="en">' +
  "<head>" +
  '<meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<title>Fixing connection…</title>" +
  "<style>" +
  "*{box-sizing:border-box;margin:0;padding:0}" +
  "body{min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "  background:#0e0010;font-family:system-ui,sans-serif;color:#e2d6f5}" +
  ".card{text-align:center;padding:2.5rem 2rem;max-width:360px}" +
  ".spinner{width:48px;height:48px;border:3px solid rgba(180,120,255,.2);" +
  "  border-top-color:#b478ff;border-radius:50%;animation:spin .8s linear infinite;" +
  "  margin:0 auto 1.5rem}" +
  "@keyframes spin{to{transform:rotate(360deg)}}" +
  "h1{font-size:1.1rem;font-weight:600;margin-bottom:.5rem;color:#f0eaff}" +
  "p{font-size:.875rem;color:#a090c0;line-height:1.5}" +
  "</style>" +
  "</head>" +
  "<body>" +
  '<div class="card">' +
  '  <div class="spinner"></div>' +
  "  <h1>fixing stuff...</h1>" +
  "  <p>clearing your cache, won't take long.</p>" +
  "</div>" +
  '<script src="/js/cache-reset.js?v=20260924.1"><\/script>' +
  "<script>" +
  'AetherisCache.reset().then(function(){ window.location.replace("/"); })' +
  '.catch(function(e){ document.querySelector("h1").textContent="Reset incomplete"; document.querySelector("p").textContent=e.message; });' +
  "<\/script>" +
  "</body>" +
  "</html>";

var audiounlockshim =
  "<script>" +
  "(function(){" +
  "  if (window.__aetherisAudioUnlockInstalled) return;" +
  "  window.__aetherisAudioUnlockInstalled = true;" +
  "  var issafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);" +
  "  var contexts = new Set();" +
  "  var unlocked = false;" +
  "  function dbg(){" +
  "    if (console && console.log) {" +
  '      var args = ["[audio-dbg]"].concat(Array.prototype.slice.call(arguments));' +
  "      console.log.apply(console, args);" +
  "    }" +
  "  }" +
  "  function silentping(ctx){" +
  "    try {" +
  "      var buf = ctx.createBuffer(1, 1, 22050);" +
  "      var src = ctx.createBufferSource();" +
  "      src.buffer = buf; src.connect(ctx.destination);" +
  '      if (typeof src.start === "function") src.start(0);' +
  '      else if (typeof src.noteOn === "function") src.noteOn(0);' +
  "    } catch(e){}" +
  "  }" +
  "  function tryresume(ctx){" +
  '    if (!ctx || typeof ctx.resume !== "function") return;' +
  '    if (ctx.state === "suspended" || ctx.state === "interrupted") {' +
  "      silentping(ctx);" +
  "      try {" +
  '        ctx.resume().then(function(){ dbg("resume() resolved, new state:", ctx.state); })' +
  '          .catch(function(e){ dbg("resume() rejected:", e && e.message); });' +
  '      } catch(e){ dbg("resume() threw:", e && e.message); }' +
  "    }" +
  "  }" +
  "  function watchcontext(ctx){" +
  "    if (!ctx || ctx.__aetherisWatched) return;" +
  "    ctx.__aetherisWatched = true; contexts.add(ctx);" +
  '    try { ctx.addEventListener("statechange", function(){' +
  '      dbg("watched context statechange ->", ctx.state);' +
  '      if (unlocked && (ctx.state === "suspended" || ctx.state === "interrupted")) tryresume(ctx);' +
  "    }); } catch(e){}" +
  "  }" +
  "  function scanunitycontexts(){" +
  "    try {" +
  '      var canvases = document.querySelectorAll("canvas");' +
  "      for (var i=0;i<canvases.length;i++){" +
  "        var c = canvases[i];" +
  "        var u = c.unityInstance || window.unityInstance || window.myGameInstance || window.gameInstance;" +
  "        var ctx = u && u.Module && u.Module.WEBAudio && u.Module.WEBAudio.audioContext;" +
  '        if (ctx) { dbg("found Unity WEBAudio context, state:", ctx.state); watchcontext(ctx); if (unlocked) tryresume(ctx); }' +
  "      }" +
  "    } catch(e){}" +
  "  }" +
  "  function unlockall(){" +
  '    if (!unlocked) { dbg("first unlock gesture fired (Safari:", issafari, ")"); startpolling(); }' +
  "    unlocked = true; contexts.forEach(tryresume); scanunitycontexts();" +
  "  }" +
  "  var _polltimer = null;" +
  "  function startpolling(){" +
  "    if (_polltimer) return;" +
  "    _polltimer = setInterval(function(){" +
  "      if (document.hidden) return;" +
  "      contexts.forEach(function(ctx){" +
  '        if (ctx.state === "suspended" || ctx.state === "interrupted") { dbg("poll: resuming context, state:", ctx.state); tryresume(ctx); }' +
  "      }); scanunitycontexts();" +
  "    }, 2000);" +
  "  }" +
  '  document.addEventListener("visibilitychange", function(){' +
  '    if (document.visibilityState === "visible" && unlocked) { dbg("visibilitychange -> visible, re-resuming contexts"); unlockall(); }' +
  "  });" +
  "  var native = window.AudioContext || window.webkitAudioContext;" +
  "  if (native) {" +
  '    dbg("patching AudioContext constructor (Safari:", issafari, ")");' +
  "    var wrapped = function(){" +
  "      var ctx = arguments.length ? new native(arguments[0]) : new native();" +
  '      dbg("AudioContext created, initial state:", ctx.state, "sampleRate:", ctx.sampleRate);' +
  "      watchcontext(ctx); tryresume(ctx); return ctx;" +
  "    };" +
  "    wrapped.prototype = native.prototype;" +
  "    try { window.AudioContext = wrapped; } catch(e){}" +
  "    try { window.webkitAudioContext = wrapped; } catch(e){}" +
  '  } else { dbg("no AudioContext available on this page"); }' +
  '  var events = ["touchstart","touchend","mousedown","click","keydown","pointerdown","gesturestart"];' +
  "  events.forEach(function(evt){ document.addEventListener(evt, unlockall, { capture: true, passive: true }); });" +
  '  window.addEventListener("message", function(e){ if (e && e.data && e.data.type === "aetheris-unlock-audio") unlockall(); });' +
  "  function patchchildiframe(el){" +
  '    if (!el || el.tagName !== "IFRAME") return;' +
  "    try {" +
  '      var cur = el.getAttribute("allow") || "";' +
  '      if (cur.indexOf("autoplay") === -1) {' +
  '        el.setAttribute("allow", cur ? cur + "; autoplay" : "autoplay; fullscreen");' +
  '        dbg("patched child iframe allow:", el.src || el.getAttribute("src"));' +
  "      }" +
  "    } catch(e){}" +
  "  }" +
  '  function patchchildiframes(){ try { var iframes = document.querySelectorAll("iframe"); for (var i = 0; i < iframes.length; i++) patchchildiframe(iframes[i]); } catch(e){} }' +
  "  patchchildiframes();" +
  "  try {" +
  "    var mo = new MutationObserver(function(mutations){" +
  "      for (var i = 0; i < mutations.length; i++){" +
  "        var added = mutations[i].addedNodes;" +
  "        for (var j = 0; j < added.length; j++){" +
  "          var n = added[j];" +
  '          if (n && n.tagName === "IFRAME") patchchildiframe(n);' +
  '          else if (n && n.querySelectorAll) { var nested = n.querySelectorAll("iframe"); for (var k = 0; k < nested.length; k++) patchchildiframe(nested[k]); }' +
  "        }" +
  "      }" +
  "    });" +
  "    mo.observe(document.documentElement, { childList: true, subtree: true });" +
  "  } catch(e){}" +
  "  window.__audiodbg = { getcontexts: function(){ return Array.from(contexts); }, forceunlock: unlockall, get unlocked(){ return unlocked; } };" +
  "})();" +
  "<\/script>";

// Ad spoof shim. Inlined into proxied documents once the source has been
// fetched, with the external tag as the fallback until then (and if the fetch
// ever fails). The inline form matters for sites like YouTube that enumerate
// script elements: scramjet's patched URL getters call unrewriteUrl() on every
// local <script src> they see, which logs an "unexpected url" error each time.
// Inline executes synchronously before game scripts, same as before.
var ADSPOOF_SRC = "/js/ad-spoof.js?v=20260928.3";
var adspoofshim = '<script src="' + ADSPOOF_SRC + '"><\/script>';
var adspoofinline = null;
(function warmadspoof() {
  fetch(ADSPOOF_SRC)
    .then(function (response) {
      return response.ok ? response.text() : "";
    })
    .then(function (text) {
      if (!text) return;
      adspoofinline =
        "<script>" + text.replace(/<\/script/gi, "<\\/script") + "<\/script>";
    })
    .catch(function () {
      /* the external fallback tag still works */
    });
})();

// Panic key — reads the same origin localStorage the settings page writes
// (proxied pages are same-origin under /~/sj/, so this works inside games
// too). One keypress navigates the whole tab away to the "safe" URL.
var panicshim =
  "<script>" +
  "(function(){" +
  "  if (window.__aetherisPanicInstalled) return;" +
  "  window.__aetherisPanicInstalled = true;" +
  "  function panic(e) {" +
  "    try {" +
  '      var k = localStorage.getItem("panickey");' +
  "      if (!k || e.key !== k) return;" +
  "      var t = e.target;" +
  '      if (e.key.length === 1 && t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;' +
  '      var u = localStorage.getItem("panicurl") || "https://classroom.google.com/";' +
  '      try { var parsed = new URL(u, location.href); if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) u = "https://classroom.google.com/"; } catch (_) { u = "https://classroom.google.com/"; }' +
  "      var w = window.top || window;" +
  "      try { w.location.replace(u); } catch (_) { window.location.replace(u); }" +
  "    } catch (_) {}" +
  "  }" +
  '  document.addEventListener("keydown", panic, true);' +
  "})();" +
  "<\/script>";

// scramjet v2 doesn't patch navigator.cookieEnabled — proxied pages see the
// real browser's value unmodified. Some sites (e.g. Bloxity/legionsdk.com)
// gate signin on `navigator.cookieEnabled === false` and show "your browser
// is blocking cookies" when it does, even though scramjet's own document.cookie
// is fully virtualized (backed by its own cookie jar + IndexedDB persistence)
// and works regardless of that flag. Always true in the proxied world, so
// force it — unconditional, not gated behind any toggle.
var cookieenabledshim =
  "<script>" +
  "(function(){" +
  "  if (window.__aetherisCookieEnabledShimInstalled) return;" +
  "  window.__aetherisCookieEnabledShimInstalled = true;" +
  "  try {" +
  '    Object.defineProperty(Navigator.prototype, "cookieEnabled", { get: function(){ return true; }, configurable: true });' +
  "  } catch(e){}" +
  "})();" +
  "<\/script>";

// Cap on how much HTML to buffer while looking for the <head>/<html> tag.
// Documents are expected to have one near the top; anything larger than this
// is treated as "no usable tag" and the shims go at the front, matching the
// previous non-streaming fallback.
var SHIM_SCAN_LIMIT = 256 * 1024;

// Streams an HTML body through a UTF-8 decode/re-encode so the shims can be
// inserted as soon as the insertion point is found. The previous version
// buffered the whole document (text(), replace, re-encode) before the page
// could render anything, which is both a memory spike and a visible delay on
// exactly the weak devices this proxy targets. The pump reads ahead until
// the stream queue is full and pull() resumes it, so memory stays bounded.
// (A pull-only source cannot be used here: a pull that finds nothing to
// enqueue yet — the common case while scanning for <head> — is not followed
// by another pull in every engine.)
function streamwithshims(body, shims) {
  var reader = body.getReader();
  var decoder = new TextDecoder("utf-8");
  var encoder = new TextEncoder();
  var injected = false;
  var pending = "";
  var paused = false;
  var finished = false;

  function process(controller, result) {
    if (result.done) {
      var tail = decoder.decode();
      if (!injected) {
        controller.enqueue(encoder.encode(shims + pending + tail));
      } else if (tail) {
        controller.enqueue(encoder.encode(tail));
      }
      controller.close();
      finished = true;
      return;
    }

    var text = decoder.decode(result.value, { stream: true });

    if (!injected) {
      pending += text;
      var match =
        /<head[^>]*>/i.exec(pending) || /<html[^>]*>/i.exec(pending);
      if (match) {
        var cut = match.index + match[0].length;
        controller.enqueue(
          encoder.encode(pending.slice(0, cut) + shims + pending.slice(cut)),
        );
        pending = "";
        injected = true;
      } else if (pending.length >= SHIM_SCAN_LIMIT) {
        controller.enqueue(encoder.encode(shims + pending));
        pending = "";
        injected = true;
      }
    } else if (text) {
      controller.enqueue(encoder.encode(text));
    }
  }

  function pump(controller) {
    if (finished || paused) return;
    reader.read().then(
      function (result) {
        // The consumer may have cancelled while this read was in flight.
        if (finished || paused) return;
        try {
          process(controller, result);
        } catch (err) {
          finished = true;
          try {
            controller.error(err);
          } catch (_) {
            /* already closed */
          }
          return;
        }
        if (finished || paused) return;
        if (controller.desiredSize <= 0) {
          paused = true;
          return;
        }
        pump(controller);
      },
      function (err) {
        if (finished) return;
        finished = true;
        try {
          controller.error(err);
        } catch (_) {
          /* already closed */
        }
      },
    );
  }

  return new ReadableStream({
    start: function (controller) {
      pump(controller);
    },
    pull: function (controller) {
      if (paused) {
        paused = false;
        pump(controller);
      }
    },
    cancel: function (reason) {
      finished = true;
      return reader.cancel(reason);
    },
  });
}

function injecthtmlshims(response, options) {
  if (!options) options = {};
  try {
    if (!response || !(response instanceof Response)) return response;
    if (response.status !== 200) return response;
    if (response.type === "opaque" || response.type === "opaqueredirect")
      return response;
    var ct = (response.headers.get("content-type") || "").toLowerCase();
    if (ct.indexOf("text/html") === -1) return response;

    var shims =
      cookieenabledshim +
      panicshim +
      (options.desktopua ? desktopuashim : "") +
      audiounlockshim +
      (adspoofinline || adspoofshim);

    var newheaders = new Headers(response.headers);
    newheaders.delete("content-length");
    // Override only the features the proxy needs; keep any policy the remote
    // page declared for camera, microphone, geolocation, and friends.
    var existingpolicy = newheaders.get("Permissions-Policy") || "";
    var kept = [];
    existingpolicy
      .split(",")
      .map(function (part) {
        return part.trim();
      })
      .forEach(function (part) {
        if (!part) return;
        var name = part.split("=")[0].trim().toLowerCase();
        if (name === "autoplay" || name === "fullscreen") return;
        kept.push(part);
      });
    kept.push("autoplay=*", "fullscreen=*");
    newheaders.set("Permissions-Policy", kept.join(", "));

    var body = response.body ? streamwithshims(response.body, shims) : shims;
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: newheaders,
    });
  } catch (err) {
    return response;
  }
}

// controller.sw.js's route() has its own try/catch that swallows EVERY
// controller-side failure and resolves with
//   new Response("Internal Service Worker Error: " + e.message, { status: 500 })
// It never rejects, so the .catch() on route() below is dead code for anything
// that goes wrong inside the controller. That plain-text body is what the page
// receives, so any site that does `await res.json()` on a failed API call
// reports a JSON syntax error at position 0 ("Unexpected token 'I'") and the
// real message — "No frame found for request", a transport error, whatever —
// never surfaces anywhere. Sniff that exact shape and log the real reason.
// (String bodies get Content-Type: text/plain;charset=UTF-8 from the Response
// constructor, so this check is cheap and can't match a real proxied response,
// which always carries the origin's own headers.)
var SW_ERROR_PREFIX = "Internal Service Worker Error";

async function surfacerouteerror(response, request) {
  try {
    if (!response || response.status !== 500) return response;
    var ct = (response.headers.get("content-type") || "").toLowerCase();
    if (ct.indexOf("text/plain") !== 0) return response;

    var text = await response.clone().text();
    if (text.indexOf(SW_ERROR_PREFIX) !== 0) return response;

    // Expected during navigation: the search page replaces its iframe while
    // the old page's background requests are still finishing, and the
    // controller drops them with this exact message. Keep it out of the
    // error stream.
    if (text.indexOf("No frame found for request") !== -1) {
      console.warn(
        "[SW] dropped request from a closed frame:",
        request.method,
        request.url.slice(0, 200),
      );
      return response;
    }

    console.error(
      "[SW] scramjet controller failed to handle a request —",
      text,
      "\n  method:",
      request.method,
      "\n  url:",
      request.url,
      "\n  destination:",
      request.destination || "(empty)",
      "\n  mode:",
      request.mode,
    );
  } catch (e) {
    /* diagnostic only — never let it break the response */
  }

  return response;
}

var fetcherrors = new Map();
function logfetchfail(req, err) {
  var now = Date.now();
  if (now - (fetcherrors.get(req.url) || 0) < 5000) return;
  // cap: one entry per failing url, cleared wholesale once it grows — the SW
  // is recycled eventually, but don't let a pathological page grow it forever
  if (fetcherrors.size > 500) fetcherrors.clear();
  fetcherrors.set(req.url, now);
  console.error(
    "[SW] fetch failed:",
    (err && err.message) || err,
    "\n url:",
    req.url,
  );
}

// scramjet v2's default codec is plain encodeURIComponent, so a proxied
// request's URL *contains the whole remote URL in readable form* — e.g.
// https://aetheris.win/~/sj/<id>/<frameId>/https%3A%2F%2Fexample.com%2Findex.html
// Only "/" ":" "?" "&" "=" "#" get percent-encoded; hostnames, dots and file
// extensions survive verbatim. That makes every substring/extension rule below
// match proxied URLs too, which would silently take them away from scramjet and
// hand them to a plain same-origin fetch (→ our own 404 page). v1's codec
// mangled the URL so these rules were safe there; in v2 every one of them has
// to be gated on this. Anything under the /~/sj/ prefix belongs to scramjet,
// full stop.
function isproxiedurl(url) {
  return url.indexOf("/~/sj/") !== -1;
}

function shouldbypass(url) {
  if (
    url.indexOf("data:") === 0 ||
    url.indexOf("chrome-extension:") === 0 ||
    url.indexOf("blob:") === 0 ||
    url.indexOf("ws:") === 0
  )
    return true;

  // scramjet v2 also serves its own per-frame bootstrap file at
  // /~/sj/<id>/<frameId>/scramjet.wasm.js (a virtual file synthesized by the
  // controller, not a real one on disk — see Controller.methods.request's
  // virtualWasmPath handling), whose name matches ".wasm" too.
  if (isproxiedurl(url)) return false;

  if (url.indexOf(".unityweb") !== -1 || url.indexOf(".wasm") !== -1)
    return true;

  if (
    url.indexOf("/api-proxy/") !== -1 ||
    url.indexOf("/proxy/") !== -1 ||
    url.indexOf("jsdelivr.net") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/assets/") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/scramjet/") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/controller/") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/api/") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/js/") !== -1 ||
    url.indexOf(SITE_ORIGIN + "/css/") !== -1
  )
    return true;

  try {
    var parsed = new URL(url);
    if (parsed.hostname === SITE_HOST && /\.html$/.test(parsed.pathname))
      return true;
  } catch (e) {}

  try {
    if (/\/online(-count)?$/.test(new URL(url).pathname)) return true;
  } catch (e) {}

  return false;
}

self.addEventListener("fetch", function (event) {
  var url = event.request.url;
  var proxied = isproxiedurl(url);

  // Recovery page shim — own origin + exact paths only. A bare substring
  // match would also swallow cross-origin subresources like
  // https://cdn.example/api/recovery/data.json (and /recovery, /precovery…).
  if (!proxied && url.indexOf("/recover") !== -1) {
    var recoverparsed = null;
    try {
      recoverparsed = new URL(url);
    } catch (e) {}
    var recoverpath = recoverparsed ? recoverparsed.pathname : "";
    if (
      recoverparsed &&
      recoverparsed.origin === self.location.origin &&
      (recoverpath === "/recover" ||
        recoverpath === "/recover.html" ||
        recoverpath === "/sw-recover")
    ) {
      event.respondWith(
        new Response(recoveryhtml, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      );
      return;
    }
  }

  if (!proxied && url.indexOf("api.1games.io") !== -1) {
    var rewritten = url.replace(
      "https://api.1games.io/",
      SITE_ORIGIN + "/api-proxy/",
    );
    event.respondWith(
      event.request.text().then(function (body) {
        return fetch(rewritten, {
          method: event.request.method,
          headers: event.request.headers,
          body: event.request.method !== "GET" ? body : undefined,
        });
      }),
    );
    return;
  }

  var parsed = null;
  try {
    parsed = new URL(url);
  } catch (e) {}

  if (
    parsed &&
    parsed.origin === self.location.origin &&
    parsed.pathname.indexOf("/assets/games/") === 0 &&
    /\.html$/i.test(parsed.pathname)
  ) {
    event.respondWith(
      fetch(event.request)
        .then(function (r) {
          return injecthtmlshims(r, { desktopua: spoofdesktopua });
        })
        .catch(function () {
          return fetch(event.request);
        }),
    );
    return;
  }

  // Same gate as the /recover rule above: without !proxied this swallows
  // proxied assets whose URL merely contains the substring.
  if (!proxied && url.indexOf("disable-devtool") !== -1) {
    event.respondWith(
      new Response("", {
        headers: { "Content-Type": "application/javascript" },
      }),
    );
    return;
  }

  if (shouldbypass(url)) return;

  if (!ensurecontrollerloaded()) {
    if (proxied) {
      // /~/sj/ URLs exist only as a scramjet prefix; letting them fall
      // through to the origin would answer with our 404 page and look like a
      // dead site. Send navigations to the recovery flow and fail the rest
      // honestly (the route() failure path below does the same).
      if (event.request.mode === "navigate") {
        event.respondWith(Response.redirect("/recover", 302));
      } else {
        event.respondWith(
          new Response("", { status: 503, statusText: "Proxy unavailable" }),
        );
      }
      return;
    }
    event.respondWith(
      fetch(event.request).catch(function () {
        if (event.request.mode === "navigate")
          return Response.redirect("/recover", 302);
        return new Response("", { status: 503, statusText: "SW unavailable" });
      }),
    );
    return;
  }

  // shouldRoute() only matches URLs under a live tab's /~/sj/<id>/ prefix
  // (registered by that tab's Controller — see scramjet-init.js). Anything
  // else — same-origin site assets, requests from a tab whose Controller
  // hasn't finished registering yet — just falls through to a normal fetch.
  var shouldroute = false;
  try {
    shouldroute = $scramjetController.shouldRoute(event);
  } catch (e) {
    shouldroute = false;
  }

  if (!shouldroute) return;

  event.respondWith(
    buildrouteevent(event)
      .then(function (re) {
        return $scramjetController.route(re);
      })
      .then(function (r) {
        return surfacerouteerror(r, event.request);
      })
      .then(function (r) {
        return injecthtmlshims(r, { desktopua: spoofdesktopua });
      })
      .catch(function (err) {
        logfetchfail(event.request, err);
        if (event.request.mode === "navigate")
          return Response.redirect("/recover", 302);
        // Deliberately NOT `fetch(event.request)` here. This URL is under
        // /~/sj/, which exists only as a scramjet prefix — our own origin has
        // no such route, so fastify answers it with the 404.html page. That
        // turns a proxy failure into "<!DOCTYPE html>..." arriving at whatever
        // called .json(), which is where a lot of the "invalid JSON" noise
        // comes from. Fail honestly instead.
        return new Response("", {
          status: 503,
          statusText: "Proxy unavailable",
        });
      }),
  );
});

self.addEventListener("install", function (event) {
  event.waitUntil(
    migrateifneeded().then(function () {
      return self.skipWaiting();
    }),
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data && event.data.type === "aetheris-set-desktop-ua-spoof") {
    spoofdesktopua = event.data.enabled === true;
    persistspoofstate(spoofdesktopua);
  }
});
