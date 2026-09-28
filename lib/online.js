// Counts distinct browsers instead of raw SSE streams.
//
// Every shell tab opens its own /online EventSource, and a dropped connection
// reconnects with a fresh stream, so the raw connection count over-reports
// people (one user with several tabs can look like several users, and stale
// sockets can linger). Connections that carry a persistent per-browser id
// (localStorage uuid supplied as ?c=) are collapsed into one; connections
// without an id — old cached shells, bots, health checks — count individually.
export function uniqueOnlineCount(clients, clientids) {
  const ids = new Set();
  let anonymous = 0;
  for (const res of clients) {
    const id = clientids.get(res);
    if (id) ids.add(id);
    else anonymous++;
  }
  return ids.size + anonymous;
}
