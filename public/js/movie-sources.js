// TMDB calls go through the server-side /api/tmdb passthrough — the API key
// lives in index.js (hardcoded default, TMDB_API_KEY env overrides) and never
// ships to the browser.
var TMDB_IMG = "https://image.tmdb.org/t/p/w342";
var TMDB_API = "/api/tmdb";

var MOVIES_SOURCES = [
  {
    // Keep this source behind the relay too. Its media CDN currently
    // challenges the VPS, but falling back to a direct embed would expose
    // the viewer and violate the movie player's proxy-only boundary.
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
    // VidSrc.to as the fallback. Default source. Kept proxied per user
    // preference.
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
    name: "SmashyStream",
    url: function (t, id, s, e) {
      var upstream =
        "https://embed.smashystream.com/playere.php?tmdb=" +
        id +
        (t === "tv" ? "&season=" + s + "&episode=" + e : "");
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    // Verified 2026-09-08: full chain works through the relay from the VPS
    // (vidsrc.to → vsembed.ru → cloudorchestranova.com → per-host
    // generate.php token → comityofcognomen.site playlists/segments, all
    // 200). Fallback source (2Embed is the default).
    name: "VidSrc.to (vidsrc.to)",
    url: function (t, id, s, e) {
      var upstream =
        "https://vidsrc.to/embed/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e);
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    // VidLink: documented TMDB embed (vidlink.pro). Movie /movie/{id},
    // TV /tv/{id}/{s}/{e}. HLS + subtitle support, widely used 2026.
    name: "VidLink (vidlink.pro)",
    url: function (t, id, s, e) {
      var upstream =
        t === "movie"
          ? "https://vidlink.pro/movie/" + id
          : "https://vidlink.pro/tv/" + id + "/" + s + "/" + e;
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    // Embed.su: https://embed.su/embed/movie/{id},
    // https://embed.su/embed/tv/{id}/{s}/{e}. Ranked "very reliable"
    // across EZstream/community lists.
    name: "Embed.su",
    url: function (t, id, s, e) {
      var upstream =
        "https://embed.su/embed/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e);
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    // VidEasy: https://player.videasy.net/movie/{id},
    // https://player.videasy.net/tv/{id}/{s}/{e}. Modern HLS player
    // used by several TMDB front-ends.
    name: "VidEasy (videasy.net)",
    url: function (t, id, s, e) {
      var upstream =
        "https://player.videasy.net/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e);
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    // AutoEmbed: https://player.autoembed.cc/embed/movie/{id},
    // https://player.autoembed.cc/embed/tv/{id}/{s}/{e}.
    name: "AutoEmbed",
    url: function (t, id, s, e) {
      var upstream =
        "https://player.autoembed.cc/embed/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e);
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  {
    // VidSrc.cc v2: https://vidsrc.cc/v2/embed/movie/{id},
    // https://vidsrc.cc/v2/embed/tv/{id}/{s}/{e}. Separate infra from
    // vidsrc.to / vidsrcme.ru, useful when one family blocks the VPS.
    name: "VidSrc.cc v2",
    url: function (t, id, s, e) {
      var upstream =
        "https://vidsrc.cc/v2/embed/" +
        (t === "movie" ? "movie/" + id : "tv/" + id + "/" + s + "/" + e);
      return "/movie-proxy?url=" + encodeURIComponent(upstream);
    },
  },
  // NOTE (2026-09-29): "HLS (hls.lol)" and "Aether (lul)" entries lived
  // here. Both removed from the dropdown: hls.lol serves an
  // "atlantic.st disable VPN" slate to datacenter egress (screenshot
  // verified), and the lul/tnmr.org chain 403s follow-on requests from
  // the VPS more often than not (two clean playback trials, zero
  // frames). The /hls-resolve route + hls-player page stay in place and
  // tested; re-adding is one entry each if egress reputation ever
  // changes.
];
