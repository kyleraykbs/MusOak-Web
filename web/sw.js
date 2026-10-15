// The service worker behind "kept" playlists and a page that opens on a bad
// line.
//
// Two things it answers. A GET for a song the offline module has already put in
// Cache Storage - so a kept playlist plays with no server at all. And the app's
// own shell - the page, its modules, its styles, its fonts - which it keeps in
// Cache Storage and hands back as they last arrived. The page itself is asked of
// the network first, so a reload is where an edit lands, and the copy in hand is
// the fallback when the network does not answer. Everything else is served from
// that copy and revalidated behind the page: the server sends `no-cache`, which
// means "revalidate", so an unchanged module comes back Not Modified and its
// body never crosses the wire. It used to send every one of those straight to
// the network with the browser's cache ignored, which is the long refresh on a
// poor connection: forty-odd module requests over again, with nothing allowed to
// answer them but the wire.
//
// The song cache it never writes to: only js/offline.js decides what is kept,
// which is what keeps a song from being cached twice under two names.

import { CACHE_NAME, mediaCacheKey } from "./js/offline.js";

// The app is served under a prefix on the deployment this was written for
// (`/musoak/`), so the paths that matter are relative to the worker's own scope
// rather than to the origin. Matching the scoped path is what makes this file
// work at the root and under a sub-path - and it is why nothing matched before:
// every rule here was anchored to `/`, so under a prefix no request was ever
// recognised as the shell's.
const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, "");

/** The path as this worker sees it: what follows the scope, leading slash and
 *  all. Empty when the request is outside the scope, which the browser does not
 *  send here anyway. */
function scoped(pathname) {
  if (!pathname.startsWith(SCOPE_PATH + "/")) return "";
  return pathname.slice(SCOPE_PATH.length);
}

const MEDIA_PATH = /^\/api\/v1\/media\/[^/]+$/;
// SHELL_CACHE holds the app itself as it last arrived. Nothing else writes to
// it, and it answers every shell request but a navigation, which asks the
// network first.
const SHELL_CACHE = "musoak-shell";
// SHELL_TIMEOUT_MS is how long a person waits for a page before the copy from
// the last load is served instead. Half a second longer than a slow-but-working
// response, short enough that a dead link is not a dead page. It applies only
// when there is a copy to fall back to: a first load has nothing else to show,
// so the network is given as long as it takes.
const SHELL_TIMEOUT_MS = 2500;
// Everything that makes up the app itself: the page, its modules, its styles,
// its fonts and its icons. The API is left alone.
const SHELL_PATH = /^\/(?:$|index\.html$|theme\.css$|icon\.png$|icon-64\.png$|apple-touch-icon\.png$|sw\.js$|js\/|fonts\/)/;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = scoped(url.pathname);
  if (!path) return;

  if (MEDIA_PATH.test(path)) {
    event.respondWith(keptSong(request));
    return;
  }

  // The frontend is edited while it is being served, so what is kept has to be
  // allowed to change under it: the page asks the network first, and every other
  // file is handed over from the copy it had and refreshed behind the page. An
  // edit lands on the next load, and the wire does not carry the same modules
  // again on the way.
  // A navigation is the page, whichever route it names: the app owns its
  // routes, so a reload on `/musoak/rooms` is the same page as `/musoak/`.
  // Asking the request itself is what makes that work under a prefix - a rule
  // matching the path would have to know every route there is.
  if (request.mode === "navigate" || SHELL_PATH.test(path)) {
    event.respondWith(shell(request));
  }
});

/** The app's own files: the copy in hand, kept fresh behind the page.
 *
 * A page that cannot reach the server used to be a page that did not open. Now
 * it is the app as it was, which is the difference between a slow start and no
 * start on a connection that is having a bad minute. The page itself is the one
 * thing asked of the network first - a reload is where an edit is meant to land
 * - and it is asked with a deadline only when the last load left a copy to fall
 * back to: a first load has nothing else to show, so nothing may time it out.
 */
async function shell(request) {
  const cache = await openShellCache();
  const cached = cache ? await cache.match(request).catch(() => null) : null;

  if (!cached || request.mode === "navigate") {
    // The page, or anything there is no copy of: the wire is the answer. The
    // deadline belongs to the copy that exists, never to the request that has
    // to land.
    const send = () => fetch(request).then((response) => keep(request, cache, response));
    try {
      return cached ? await within(send(), SHELL_TIMEOUT_MS) : await send();
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
  }

  // A module, a stylesheet, a font, an icon: hand over the copy from the last
  // load and ask for a fresh one behind the page. What has not changed answers
  // Not Modified and is not carried again; what has lands on the next load.
  void refresh(request, cache);
  return cached;
}

/** The shell cache, or null where Cache Storage is not to be had. */
async function openShellCache() {
  try {
    return await caches.open(SHELL_CACHE);
  } catch {
    return null;
  }
}

/** Keep what the network answered on the way past, so the next load that cannot
 *  reach the server has something to show. */
function keep(request, cache, response) {
  if (cache && response && response.ok) cache.put(request, response.clone()).catch(() => {});
  return response;
}

/** Ask for a fresh copy of what was just served, for the next load: what comes
 *  back replaces the copy, and what does not leaves it as it was. */
function refresh(request, cache) {
  return fetch(request)
    .then((response) => keep(request, cache, response))
    .catch(() => {});
}

/** A promise that gives up after ms, so a stalled request cannot hold a page. */
function within(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("service worker: the network did not answer in time")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** From the cache when the song was kept; otherwise straight to the network. */
async function keptSong(request) {
  let cached = null;
  try {
    const cache = await caches.open(CACHE_NAME);
    cached = await cache.match(mediaCacheKey(request.url, self.location.origin));
  } catch {
    cached = null;
  }
  if (!cached) {
    // Not kept, or the cache is unreachable: pass the request through as it
    // came, Range header and all, so streaming is never broken.
    return fetch(request);
  }
  return fromCache(request, cached);
}

/** A full (or Range) answer out of the cached bytes. */
async function fromCache(request, cached) {
  const range = request.headers.get("range");
  if (!range) return cached;

  const blob = await cached.clone().blob();
  const size = blob.size;
  const parsed = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!parsed || (parsed[1] === "" && parsed[2] === "")) return cached;

  let start;
  let end;
  if (parsed[1] === "") {
    // A suffix range: the last N bytes.
    start = Math.max(0, size - Number(parsed[2]));
    end = size - 1;
  } else {
    start = Number(parsed[1]);
    end = parsed[2] === "" ? size - 1 : Math.min(Number(parsed[2]), size - 1);
  }

  if (!Number.isFinite(start) || start >= size || start > end) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  }

  const slice = blob.slice(start, end + 1);
  return new Response(slice, {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": cached.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(slice.size),
      "Accept-Ranges": "bytes",
    },
  });
}
