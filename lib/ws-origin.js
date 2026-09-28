// Shared WebSocket Origin check for the app's raw upgrade handlers (wisp,
// lc-relay). WebSockets are not subject to CORS, so without this check any
// website could open these endpoints from a visitor's browser and use the
// server as a relay. Compare the Origin host to the Host header (works for any
// deployment, including forks and localhost); non-browser clients that send no
// Origin are allowed through.

export function websocketOriginAllowed(req) {
  const origin = req?.headers?.origin;
  if (typeof origin !== "string" || !origin) return true;

  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }

  return !req.headers.host || originHost === req.headers.host;
}
