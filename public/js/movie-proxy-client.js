(function () {
  if (window.__MOVIE_PROXY_INIT__) return;
  window.__MOVIE_PROXY_INIT__ = true;

  var PROXY_ROUTE = "/movie-proxy";
  var targetUrl = window.__MOVIE_PROXY_TARGET__ || location.href;
  // Never resolve provider URLs against our own origin: a stale cached page
  // can miss __MOVIE_PROXY_ORIGIN__, and resolving its <base href="/"> then
  // sends provider API calls back to us (our /api.php 404s) instead of
  // upstream. Derive the origin from the target URL whenever the declared
  // one is absent or points at ourselves.
  var declaredOrigin = window.__MOVIE_PROXY_ORIGIN__ || "";
  var targetOrigin = (function () {
    if (declaredOrigin && declaredOrigin !== location.origin)
      return declaredOrigin;
    try {
      return new URL(targetUrl).origin;
    } catch (e) {
      return location.origin;
    }
  })();

  // One-shot diagnostic beacon helper, defined before any hook so hook
  // failures themselves can be reported (Safari/WebKit silently rejects
  // some prototype redefinitions that succeed on Chromium — a PC/iPad
  // divergence that is otherwise invisible from server logs).
  function beaconErr(msg) {
    try {
      var img = new Image();
      img.src =
        "/movie-ping?v=20260929.13&origin=" +
        encodeURIComponent(targetOrigin || "none") +
        "&err=" +
        encodeURIComponent(String(msg).slice(0, 300));
    } catch (e) {}
  }

  // SPA providers (flixer.su, vidsrc.pm) route on window.location.pathname,
  // which inside the relay is /movie-proxy — so their router matches
  // nothing and the frame stays black with no errors. Mirror the upstream
  // path/query/hash into the address bar (same-origin, no reload) before
  // app scripts boot. Network resolution is unaffected: every hook below
  // resolves against the upstream target URL, never location.href.
  try {
    var upstreamUrl = new URL(targetUrl);
    var upstreamPath =
      upstreamUrl.pathname + upstreamUrl.search + upstreamUrl.hash;
    if (
      upstreamUrl.protocol.indexOf("http") === 0 &&
      location.pathname.indexOf(PROXY_ROUTE) === 0 &&
      location.pathname + location.search + location.hash !== upstreamPath
    ) {
      history.replaceState(null, "", upstreamPath);
    }
  } catch (e) {
    beaconErr("hook:replaceState:" + ((e && e.message) || e));
  }

  // Providers such as Videm serve their player with `<base href="/">`, so a
  // request for `api.php` means the site root in their own context. Resolving
  // only against the proxied document URL would send it to
  // /embed/.../api.php instead, which answers with an HTML error page rather
  // than JSON — and the player then reports "No content available". Mirror
  // the provider's own resolution by honoring their base tag (anchored on
  // the upstream origin); pages without one keep document-URL resolution.
  // The negative lookup is deliberately NOT cached: this script is injected
  // right after <head>, so the provider's <base> tag may not be parsed yet
  // on the first call. Re-query until one is found, then pin it.
  var upstreamBase = null;
  var baseResolved = false;
  function resolveBase() {
    if (!baseResolved) {
      try {
        var baseEl = document.querySelector("base[href]");
        var baseHref = baseEl && baseEl.getAttribute("href");
        if (baseHref) {
          var resolved = new URL(baseHref, targetOrigin).href;
          // A stale cached page may carry a base pointing at ourselves
          // (older relay versions proxied <base>); never honor those, or
          // every relative provider URL collapses onto Aetheris and 404s.
          if (new URL(resolved).origin !== location.origin) {
            upstreamBase = resolved;
            baseResolved = true;
          }
        }
      } catch (e) {
        upstreamBase = null;
      }
    }
    return upstreamBase || targetUrl;
  }

  // One-shot diagnostic beacon: reports which client version is executing
  // and how it resolves provider URLs, so relay sessions can be diagnosed
  // from `pm2 logs`. Same-origin image ping; any failure stays silent.
  try {
    var pingSample = "";
    try {
      pingSample = new URL("api.php?a=ping", resolveBase()).href;
    } catch (e) {}
    var pingImg = new Image();
    pingImg.src =
      "/movie-ping?v=20260929.13&origin=" +
      encodeURIComponent(targetOrigin || "none") +
      "&sample=" +
      encodeURIComponent(pingSample);
  } catch (e) {}

  // Temporary playback diagnostic: beacon browser-side script errors back
  // so a silently-stuck provider player (page loads, assets 200, but no
  // media requests) can be diagnosed from `pm2 logs` without devtools
  // access on the viewer's device. Same-origin image ping, no loop risk
  // (Image src is not hooked below). Remove once playback is stable.
  try {
    var errBeacon = function (msg) {
      beaconErr(msg);
    };
    window.addEventListener("error", function (e) {
      errBeacon(
        (e.message || "error") +
          " @ " +
          (e.filename || "?") +
          ":" +
          (e.lineno || "?"),
      );
    });
    window.addEventListener("unhandledrejection", function (e) {
      var reason = e.reason;
      errBeacon(
        "rejection: " +
          String((reason && reason.message) || reason || "?").slice(0, 200),
      );
    });
  } catch (e) {}

  function debug(label, url, out) {
    try {
      if (window.__MOVIE_PROXY_DEBUG__)
        console.log("[mp-debug] " + label, url, out ? "-> " + out : "");
    } catch (e) {}
  }

  function decodeEntities(str) {
    if (!str) return str;
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  // Undo double-proxying: provider code sometimes takes an already-rewritten
  // relay URL (e.g. a subtitle file URL from a rewritten JSON list) and
  // embeds it as a parameter of its own API call
  // (/api/subtitle?url=/movie-proxy?url=...). Forwarding that nesting
  // upstream makes the provider fetch our relay URL instead of the media
  // file, which it rejects (observed: 500 on flixer's subtitle endpoint).
  // Replace nested relay URLs with their direct upstream targets before
  // proxying the outer URL. Other parameters are spliced byte-for-byte so
  // signed query strings are never normalized.
  function unnestRelayUrls(raw) {
    var RELAY_MARK = PROXY_ROUTE + "?url=";
    if (
      raw.indexOf(RELAY_MARK) === -1 &&
      raw.indexOf(encodeURIComponent(RELAY_MARK)) === -1
    )
      return raw;
    try {
      var u = new URL(raw, resolveBase());
      var query = u.search ? u.search.slice(1) : "";
      if (!query) return raw;
      var out = [];
      var changed = false;
      query.split("&").forEach(function (pair) {
        var eq = pair.indexOf("=");
        var key = eq === -1 ? pair : pair.slice(0, eq);
        var val = eq === -1 ? "" : pair.slice(eq + 1);
        var decoded = null;
        try {
          decoded = decodeURIComponent(val.replace(/\+/g, " "));
        } catch (e) {}
        if (decoded && decoded.indexOf(RELAY_MARK) !== -1) {
          try {
            var inner = new URL(decoded, resolveBase()).searchParams.get(
              "url",
            );
            if (inner) {
              val = encodeURIComponent(inner);
              changed = true;
            }
          } catch (e) {}
        }
        out.push(eq === -1 ? key : key + "=" + val);
      });
      if (!changed) return raw;
      var rebuilt =
        u.origin +
        u.pathname +
        (out.length ? "?" + out.join("&") : "") +
        u.hash;
      // Triple-nested wrappers collapse one level per pass.
      return unnestRelayUrls(rebuilt);
    } catch (e) {}
    return raw;
  }

  function toProxyUrl(rawUrl, ref) {
    if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
    var trimmed = decodeEntities(rawUrl.trim());
    // Vite's runtime preload helper builds chunk URLs as "/" + path, so an
    // already-rewritten "/movie-proxy?url=..." becomes "//movie-proxy?..."
    // (protocol-relative, host "movie-proxy" — DNS failure). Fold it back
    // to the relay route so preloads hit the same canonical URL the
    // module loader will import (module identity depends on it).
    if (/^\/\/movie-proxy(?=\/|\?|$)/.test(trimmed))
      trimmed = trimmed.slice(1);
    // Provider code may embed an already-proxied URL as a parameter of its
    // own API call (/api/subtitle?url=/movie-proxy?url=...) — unwrap those
    // before anything else, otherwise the already-proxied check below
    // returns the nesting untouched and upstream chokes on it.
    trimmed = unnestRelayUrls(trimmed);
    // Some embed scripts blindly prepend their CDN base to an iframe URL.
    // Recover our absolute relay URL from values such as
    // https://cdn.example/e/https://aetheris.win/movie-proxy?url=...
    var absoluteProxy = location.origin + PROXY_ROUTE;
    var embeddedProxyIndex = trimmed.indexOf(absoluteProxy);
    if (embeddedProxyIndex > 0) {
      var providerPrefix = trimmed.slice(0, embeddedProxyIndex);
      var embeddedProxy = trimmed.slice(embeddedProxyIndex);
      try {
        // Preserve intentional transformations such as
        // https://2vcdn.skin/e/ + /token while removing the accidentally
        // embedded Aetheris relay wrapper around that original token path.
        var embeddedTarget = new URL(embeddedProxy).searchParams.get("url");
        var originalTarget = new URL(embeddedTarget);
        var transformedTarget =
          providerPrefix +
          originalTarget.pathname.replace(/^\/+/, "") +
          originalTarget.search +
          originalTarget.hash;
        return toProxyUrl(transformedTarget, ref);
      } catch (e) {
        return embeddedProxy;
      }
    }
    if (
      trimmed.startsWith("data:") ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("javascript:")
    ) {
      return rawUrl;
    }
    if (
      trimmed.startsWith(PROXY_ROUTE) ||
      trimmed.includes("/movie-proxy?url=") ||
      trimmed.includes(location.host + PROXY_ROUTE)
    ) {
      return rawUrl;
    }
    if (trimmed === "about:blank" || trimmed.charAt(0) === "#") return rawUrl;

    // These are relay-owned control requests injected by this client. All
    // other same-origin-looking paths belong to the upstream document and
    // must be resolved against its base before being sent through the relay.
    try {
      var localCandidate = new URL(trimmed, location.href);
      if (
        localCandidate.origin === location.origin &&
        (localCandidate.pathname === "/movie-ping" ||
          localCandidate.pathname === "/js/movie-proxy-client.js")
      ) {
        return rawUrl;
      }
    } catch (e) {}

    try {
      var absUrl = new URL(trimmed, resolveBase()).href;
      // Provider code often resolves relative URLs against whatever base it
      // holds: `new URL("vast.js", script.src)` on a proxied script, or
      // `new URL("/player/jw8/vast.js", document.baseURI)`. Both collapse
      // the path onto our origin (for example
      // https://aetheris.win/player/jw8/vast.js) instead of the provider's,
      // so the relay ends up fetching its own 404. Re-anchor any non-relay
      // same-origin URL onto the upstream origin; paths that belong to the
      // relay itself were already returned untouched above.
      if (targetOrigin && targetOrigin !== location.origin) {
        var parsedAbs = new URL(absUrl);
        if (parsedAbs.origin === location.origin) {
          absUrl =
            targetOrigin +
            parsedAbs.pathname +
            parsedAbs.search +
            parsedAbs.hash;
        }
      }
      var r = ref || targetUrl;
      var out =
        location.origin +
        PROXY_ROUTE +
        "?url=" +
        encodeURIComponent(absUrl) +
        "&referer=" +
        encodeURIComponent(r);
      debug("proxy", trimmed, out);
      return out;
    } catch (e) {
      return rawUrl;
    }
  }

  // Overwrite fetch
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    init = init || {};
    var isUrl = typeof input === "string" || input instanceof URL;
    var url = isUrl ? String(input) : input && input.url;
    if (url) {
      var proxied = toProxyUrl(url);
      if (isUrl) {
        input = proxied;
      } else if (input && input.url) {
        input = new Request(proxied, input);
      }
    }
    return origFetch.call(this, input, init);
  };

  // Overwrite XMLHttpRequest
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    if (url && typeof url === "string") {
      args[1] = toProxyUrl(url);
    }
    return origOpen.apply(this, args);
  };

  // Overwrite iframe.src & setAttribute
  try {
    var iframeProto = HTMLIFrameElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(iframeProto, "src");
    if (desc && desc.set) {
      Object.defineProperty(iframeProto, "src", {
        get: function () {
          return desc.get.call(this);
        },
        set: function (val) {
          desc.set.call(this, toProxyUrl(val));
        },
        configurable: true,
        enumerable: true,
      });
    }
    var origSetAttr = iframeProto.setAttribute;
    iframeProto.setAttribute = function (name, val) {
      if (String(name).toLowerCase() === "src" && val) {
        val = toProxyUrl(val);
      }
      return origSetAttr.call(this, name, val);
    };
  } catch (e) {
    beaconErr("hook:iframe-src:" + ((e && e.message) || e));
  }

  // Overwrite video/audio src
  try {
    var mediaProto = HTMLMediaElement.prototype;
    var mediaDesc = Object.getOwnPropertyDescriptor(mediaProto, "src");
    if (mediaDesc && mediaDesc.set) {
      Object.defineProperty(mediaProto, "src", {
        get: function () {
          return mediaDesc.get.call(this);
        },
        set: function (val) {
          mediaDesc.set.call(this, toProxyUrl(val));
        },
        configurable: true,
        enumerable: true,
      });
    }
    var mediaSetAttr = Element.prototype.setAttribute;
    mediaProto.setAttribute = function (attrName, val) {
      if (String(attrName).toLowerCase() === "src" && val) {
        val = toProxyUrl(val);
      }
      return mediaSetAttr.call(this, attrName, val);
    };
    // iPad diagnosis + recovery: report play() rejections (Safari autoplay
    // policy) and media element errors (codec/HLS failures show as black
    // video with no JS exception). One beacon each per element to avoid
    // log spam.
    //
    // Safari aborts a pending play() whenever the player reassigns src /
    // calls load() mid-gesture (React re-render after subtitles/quality
    // state lands, or a fresh signed URL after an upstream 503 retry does
    // exactly this). The provider never retries, so the frame sits black
    // with playlists loaded but zero segments fetched. Retry with backoff:
    // if the player settles, one of these wins. Guarded by isConnected +
    // paused so a detached element or an already-playing video never loops.
    function retryPlay(el, attempt) {
      var delays = [1000, 2500, 5000, 10000];
      if (attempt >= delays.length) return;
      setTimeout(function () {
        try {
          if (!el.isConnected || !el.paused) return;
          var pN = origPlay.call(el);
          if (pN && pN.catch) {
            pN.catch(function (retryErr) {
              try {
                beaconErr(
                  "video:play-retry-" +
                    (attempt + 1) +
                    "-failed:" +
                    ((retryErr && retryErr.name) || "?") +
                    ":" +
                    ((retryErr && retryErr.message) || retryErr),
                );
              } catch (e) {}
              if (retryErr && retryErr.name === "AbortError")
                retryPlay(el, attempt + 1);
            });
          }
        } catch (e) {}
      }, delays[attempt]);
    }
    try {
      var origPlay = mediaProto.play;
      if (origPlay) {
        mediaProto.play = function () {
          try {
            var p = origPlay.apply(this, arguments);
            if (p && p.catch) {
              var el = this;
              p.catch(function (playErr) {
                try {
                  if (!el.__mpPlayBeacon) {
                    el.__mpPlayBeacon = true;
                    beaconErr(
                      "video:play-rejected:" +
                        ((playErr && playErr.name) || "?") +
                        ":" +
                        ((playErr && playErr.message) || playErr),
                    );
                  }
                  // Transient aborts (src reassignment settling) recover on
                  // their own; the provider won't retry, so we do, bounded.
                  if (playErr && playErr.name === "AbortError")
                    retryPlay(el, 0);
                } catch (e) {}
              });
            }
            return p;
          } catch (e) {
            return origPlay.apply(this, arguments);
          }
        };
      }
    } catch (e) {
      beaconErr("hook:media-play:" + ((e && e.message) || e));
    }
    try {
      document.addEventListener(
        "error",
        function (ev) {
          try {
            var t = ev.target;
            if (
              t &&
              (t.tagName === "VIDEO" ||
                t.tagName === "AUDIO" ||
                t.tagName === "SOURCE")
            ) {
              if (t.__mpErrBeacon) return;
              t.__mpErrBeacon = true;
              var code =
                t.error && typeof t.error.code !== "undefined"
                  ? t.error.code
                  : "?";
              var srcHost = "?";
              try {
                srcHost = new URL(
                  t.currentSrc || t.src || "",
                  location.href,
                ).host;
              } catch (e) {}
              beaconErr("video:error:" + t.tagName + ":code=" + code + ":host=" + srcHost);
            }
          } catch (e) {}
        },
        true,
      );
    } catch (e) {
      beaconErr("hook:media-error:" + ((e && e.message) || e));
    }
  } catch (e) {
    beaconErr("hook:media-src:" + ((e && e.message) || e));
  }

  // Overwrite subtitle track and source src. Videm assigns track URLs
  // directly (`tr.src = 'api.php?a=sub&ref=...'`); without this the URL
  // resolves natively against the proxy document and 404s on Aetheris
  // instead of reaching the provider.
  // setAttribute variants are covered too: players on the native-HLS path
  // (iOS Safari) may set media URLs via setAttribute instead of the IDL.
  try {
    ["HTMLTrackElement", "HTMLSourceElement"].forEach(function (name) {
      var ctor = window[name];
      if (!ctor || !ctor.prototype) return;
      var desc = Object.getOwnPropertyDescriptor(ctor.prototype, "src");
      if (desc && desc.set) {
        Object.defineProperty(ctor.prototype, "src", {
          get: function () {
            return desc.get.call(this);
          },
          set: function (val) {
            desc.set.call(this, toProxyUrl(val));
          },
          configurable: true,
          enumerable: true,
        });
      }
      var protoSetAttr = Element.prototype.setAttribute;
      ctor.prototype.setAttribute = function (attrName, val) {
        if (String(attrName).toLowerCase() === "src" && val) {
          val = toProxyUrl(val);
        }
        return protoSetAttr.call(this, attrName, val);
      };
    });
  } catch (e) {
    beaconErr("hook:track-source:" + ((e && e.message) || e));
  }

  // Providers dynamically create scripts, images, links, forms, and embeds.
  // Static HTML rewriting cannot see those assignments, so hook their URL
  // properties and setAttribute calls before they can contact upstream.
  function hookUrlElement(constructorName, properties) {
    try {
      var ctor = window[constructorName];
      if (!ctor || !ctor.prototype) return;
      properties.forEach(function (property) {
        var descriptor = Object.getOwnPropertyDescriptor(
          ctor.prototype,
          property,
        );
        if (descriptor && descriptor.set) {
          Object.defineProperty(ctor.prototype, property, {
            get: descriptor.get
              ? function () {
                  return descriptor.get.call(this);
                }
              : undefined,
            set: function (val) {
              descriptor.set.call(this, toProxyUrl(val));
            },
            configurable: true,
            enumerable: descriptor.enumerable,
          });
        }
      });
      var originalSetAttribute = Element.prototype.setAttribute;
      ctor.prototype.setAttribute = function (name, val) {
        if (properties.indexOf(String(name).toLowerCase()) !== -1 && val) {
          val = toProxyUrl(val);
        }
        return originalSetAttribute.call(this, name, val);
      };
    } catch (e) {
      beaconErr("hook:" + constructorName + ":" + ((e && e.message) || e));
    }
  }

  [
    ["HTMLScriptElement", ["src"]],
    ["HTMLImageElement", ["src"]],
    ["HTMLLinkElement", ["href"]],
    ["HTMLAnchorElement", ["href"]],
    ["HTMLAreaElement", ["href"]],
    ["HTMLObjectElement", ["data"]],
    ["HTMLEmbedElement", ["src"]],
    ["HTMLFormElement", ["action"]],
    ["HTMLInputElement", ["src", "formaction"]],
    ["HTMLButtonElement", ["formaction"]],
  ].forEach(function (entry) {
    hookUrlElement(entry[0], entry[1]);
  });

  // Inline module scripts assembled at runtime (flixer injects
  // `<script type=module>` whose imports are absolute upstream URLs built
  // from variables) bypass every network hook: the server never sees the
  // final specifier, native import fetches it directly, and the relay CSP
  // blocks that to preserve the proxy-only boundary ("Loading failed for
  // the module", status 0). Rewrite absolute http(s) URLs in
  // module-specifier positions to relay URLs at assignment time. Only
  // import positions are touched, and same-origin URLs are left alone, so
  // string constants used for comparison or messaging stay intact.
  function rewriteInlineModuleText(text) {
    if (typeof text !== "string" || text.indexOf("import") === -1)
      return text;
    return text.replace(
      /(from\s*["']|import\s*["']|import\(\s*["'])(https?:\/\/[^"'\s]+)(["'])/g,
      function (match, prefix, url, suffix) {
        try {
          if (new URL(url).origin === location.origin) return match;
          return prefix + toProxyUrl(url) + suffix;
        } catch (e) {
          return match;
        }
      },
    );
  }

  function maybeRewriteModuleText(el, value) {
    try {
      if (
        el &&
        el.tagName === "SCRIPT" &&
        String(el.type || "").toLowerCase() === "module" &&
        typeof value === "string"
      ) {
        return rewriteInlineModuleText(value);
      }
    } catch (e) {}
    return value;
  }

  // Re-read both inline-script properties so the type hook below can
  // re-process whichever one the provider assigned first.
  function rewriteScriptBody(el) {
    try {
      if (
        !el ||
        el.tagName !== "SCRIPT" ||
        String(el.type || "").toLowerCase() !== "module"
      )
        return;
      var cur = nodeTextDesc.get.call(el);
      var rew = rewriteInlineModuleText(cur);
      if (rew !== cur) nodeTextDesc.set.call(el, rew);
      if (scriptInnerHtmlDesc) {
        var curHtml = scriptInnerHtmlDesc.get.call(el);
        var rewHtml = rewriteInlineModuleText(curHtml);
        if (rewHtml !== curHtml) scriptInnerHtmlDesc.set.call(el, rewHtml);
      }
    } catch (e) {}
  }

  try {
    var scriptProto = window.HTMLScriptElement
      ? window.HTMLScriptElement.prototype
      : null;
    var nodeTextDesc =
      scriptProto &&
      Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    if (scriptProto && nodeTextDesc && nodeTextDesc.set) {
      Object.defineProperty(scriptProto, "textContent", {
        get: nodeTextDesc.get
          ? function () {
              return nodeTextDesc.get.call(this);
            }
          : undefined,
        set: function (val) {
          nodeTextDesc.set.call(this, maybeRewriteModuleText(this, val));
        },
        configurable: true,
        enumerable: nodeTextDesc.enumerable,
      });
    }
    var scriptTextDesc =
      scriptProto && Object.getOwnPropertyDescriptor(scriptProto, "text");
    if (scriptProto && scriptTextDesc && scriptTextDesc.set) {
      Object.defineProperty(scriptProto, "text", {
        get: scriptTextDesc.get
          ? function () {
              return scriptTextDesc.get.call(this);
            }
          : undefined,
        set: function (val) {
          scriptTextDesc.set.call(this, maybeRewriteModuleText(this, val));
        },
        configurable: true,
        enumerable: scriptTextDesc.enumerable,
      });
    }
    // innerHTML is the third way to fill an inline script (flixer's WASM
    // loader uses `t.innerHTML = ...imports...`). Shadow it on script
    // elements only — other elements' markup is never module source.
    var scriptInnerHtmlDesc =
      scriptProto &&
      Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (scriptProto && scriptInnerHtmlDesc && scriptInnerHtmlDesc.set) {
      Object.defineProperty(scriptProto, "innerHTML", {
        get: scriptInnerHtmlDesc.get
          ? function () {
              return scriptInnerHtmlDesc.get.call(this);
            }
          : undefined,
        set: function (val) {
          scriptInnerHtmlDesc.set.call(this, maybeRewriteModuleText(this, val));
        },
        configurable: true,
        enumerable: scriptInnerHtmlDesc.enumerable,
      });
    }
    // Type may be assigned after the text; re-process once it becomes a
    // module script so ordering never matters.
    var scriptTypeDesc =
      scriptProto && Object.getOwnPropertyDescriptor(scriptProto, "type");
    if (
      scriptProto &&
      scriptTypeDesc &&
      scriptTypeDesc.set &&
      nodeTextDesc &&
      nodeTextDesc.get &&
      nodeTextDesc.set
    ) {
      Object.defineProperty(scriptProto, "type", {
        get: scriptTypeDesc.get
          ? function () {
              return scriptTypeDesc.get.call(this);
            }
          : undefined,
        set: function (val) {
          scriptTypeDesc.set.call(this, val);
          try {
            if (String(val || "").toLowerCase() === "module")
              rewriteScriptBody(this);
          } catch (e) {}
        },
        configurable: true,
        enumerable: scriptTypeDesc.enumerable,
      });
    }
  } catch (e) {
    beaconErr("hook:script-text:" + ((e && e.message) || e));
  }
  // sendBeacon is commonly used with root-relative provider endpoints and is
  // not routed through fetch. Keep it inside the same proxy boundary.
  try {
    var originalSendBeacon = navigator.sendBeacon;
    if (originalSendBeacon) {
      navigator.sendBeacon = function (url, data) {
        return originalSendBeacon.call(this, toProxyUrl(String(url)), data);
      };
    }
  } catch (e) {
    beaconErr("hook:sendBeacon:" + ((e && e.message) || e));
  }

  // Worker/EventSource constructors also perform network requests without
  // using fetch or XHR.
  function hookUrlConstructor(name) {
    try {
      var Original = window[name];
      if (!Original) return;
      var Wrapped = function (url, options) {
        return new Original(toProxyUrl(String(url)), options);
      };
      Wrapped.prototype = Original.prototype;
      window[name] = Wrapped;
    } catch (e) {
      beaconErr("hook:" + name + ":" + ((e && e.message) || e));
    }
  }
  ["Worker", "SharedWorker", "EventSource"].forEach(hookUrlConstructor);

  // Prevent popups
  window.open = function () {
    return null;
  };
})();
