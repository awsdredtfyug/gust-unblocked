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
  // NOTE (2026-09-29): an "HLS (hls.lol)" entry lived here. Removed from
  // the dropdown because the media host serves an "atlantic.st disable
  // VPN" slate to datacenter egress instead of the title (verified by
  // screenshot — frame counts alone don't prove content). The /hls-resolve
  // route + hls-player page stay in place and tested; re-adding is one
  // entry if egress reputation ever changes.
  {
    // P-Stream lul backend (verified 2026-09-29 from the VPS: lookup API
    // + worker-signed master + child + segments all 200 through the
    // relay). Plays through the local hls-player page so every byte stays
    // proxied; appended last so existing source indexes never shift.
    name: "Aether (lul)",
    url: function (t, id, s, e) {
      return (
        "/hls-player.html?via=lul&type=" +
        t +
        "&id=" +
        id +
        (t === "tv" ? "&s=" + s + "&e=" + e : "")
      );
    },
  },
];
