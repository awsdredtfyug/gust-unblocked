// TMDB calls go through the server-side /api/tmdb passthrough — the API key
// lives in index.js (hardcoded default, TMDB_API_KEY env overrides) and never
// ships to the browser.
var TMDB_IMG = "https://image.tmdb.org/t/p/w342";
var TMDB_API = "/api/tmdb";

var MOVIES_SOURCES = [
  {
    // NOTE (2026-09-29): front door 200 from the VPS, but no title loads —
    // the media chain answers the VPS with a Cloudflare challenge. Kept
    // proxied (never direct) per user preference; expect failure until the
    // CDN accepts the VPS egress.
    name: "VidSrc (vidsrcme.ru)",
    url: function (t, id, s, e) {
      var upstream =
        "https://vidsrcme.ru/embed/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e);
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    // NOTE (2026-09-28): 2Embed's first server wraps a swish/2vcdn.skin
    // player and the others a vidsrc.buzz player; the swish path plays end
    // to end through the relay (the relay refuses the decoy hls4 ad-image
    // fragments, so the player's own hls4 → hls3 fallback fires and the real
    // signed hls3 segments stream proxied). Individual titles can still fail
    // when every 2Embed server for that title funnels to a host that rejects
    // the VPS egress (tagivi.com and unfortunatelyejectinflected answer 403
    // to the datacenter IP, relay3.videm.xyz rate-limits with 429), so keep
    // VidSrc.to as the fallback. Fallback source (Flixer is the default
    // since 2026-09-29). Kept proxied per user preference.
    name: "2Embed (2embed.cc)",
    url: function (t, id, s, e) {
      // 2Embed's TV endpoint expects its parameters after a
      // literal ampersand. With a normal `?s=...`, it silently
      // ignores the selection and always serves S1 E1.
      var upstream =
        t === "movie"
          ? "https://www.2embed.cc/embed/" + id
          : "https://www.2embed.cc/embedtv/" + id + "&s=" + s + "&e=" + e;
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    // NOTE (2026-09-29): front door 200 from the VPS, but the media chain
    // currently loop-retries (filamentoffable.space CDN 403/429/401s).
    // Fallback source (2Embed is the default).
    name: "VidSrc.to (vidsrc.to)",
    url: function (t, id, s, e) {
      var upstream =
        "https://vidsrc.to/embed/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e);
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    // ADDED 2026-09-29: VidSrc.pm ("Vidflix", vidstack player). Front door
    // 200 from the VPS for both movie and TV patterns. Playback NOT yet
    // verified end to end — live-test before trusting it.
    name: "VidSrc.pm (vidsrc.pm)",
    url: function (t, id, s, e) {
      var upstream =
        "https://vidsrc.pm/embed/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e);
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    // ADDED 2026-09-29: Flixer. Full watch pages (not a minimal embed):
    // movie https://flixer.su/watch/movie/{id},
    // TV https://flixer.su/watch/tv/{id}/{s}/{e} (OTX-verified pattern).
    // HAR-verified chain (tmdb=1032863): watch page + API
    // (plsdontscrapemelove.flixer.su) + HLS master/variants on
    // shrek.dragonballzfans.xyz + TS segments on serve.dragonballzfans.xyz
    // (segments mislabeled text/html — the relay's binary guard covers
    // those) + subtitles on sub.vdrk.site. The player mints its own
    // per-title stream tokens client-side, so no server-side minting is
    // needed — the relay just proxies. Front door + API + media hosts all
    // answer 200/404-alive from the VPS. Default source since 2026-09-29:
    // the relay forwards the WASM-signed auth headers (X-Api-Key,
    // X-Request-*, fingerprints), verified live via INVALID_TIMESTAMP on a
    // stale-signature replay (was: 403 "no sources found").
    name: "Flixer (flixer.su)",
    url: function (t, id, s, e) {
      var upstream =
        "https://flixer.su/watch/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e);
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  // REMOVED 2026-09-29 (VPS-verified dead, kept out of the dropdown):
  // - SmashyStream: 301-redirects to anyembed.xyz, whose front door serves
  //   a Cloudflare browser challenge the relay can never complete
  //   (set-cookie is stripped, so the challenge never clears). The Vite
  //   React shell then boots without data ("useCallback / R.current is
  //   null"). Dead until the front door stops challenging.
  // - VidLink (vidlink.pro): front door 403 "you have been blocked"
  //   (Cloudflare datacenter block).
  // - Embed.su: DNS dead (ENOTFOUND from the VPS resolver).
  // - VidEasy (player.videasy.net): 301 to player.videasy.to, which renders
  //   a grey page (its users.videasy.to/api/script.js 404s).
  // - AutoEmbed: player.autoembed.cc NXDOMAIN, and autoembed.co is only a
  //   wrapper iframing that dead host (plus 2embed/vidsrc.to, already
  //   listed). Adds nothing.
  // - VidSrc.cc v2: front door 403 into a Cloudflare challenge page.
  // NOTE (2026-09-29): "HLS (hls.lol)" and "Aether (lul)" entries lived
  // here. Both removed from the dropdown: hls.lol serves an
  // "atlantic.st disable VPN" slate to datacenter egress (screenshot
  // verified), and the lul/tnmr.org chain 403s follow-on requests from
  // the VPS more often than not (two clean playback trials, zero
  // frames). The /hls-resolve route + hls-player page stay in place and
  // tested; re-adding is one entry each if egress reputation ever
  // changes.
];
