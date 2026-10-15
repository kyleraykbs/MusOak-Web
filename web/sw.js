// The service worker behind "kept" playlists and a page that opens on a bad
// line.
//
// Two things it answers. A GET for a song the offline module has already put in
// Cache Storage - so a kept playlist plays with no server at all. And the app's
// own shell - the page, its modules, its styles, its fonts - which it fetches
// from the network first, for as long as a person will wait for a page, and
// then serves from the last load that worked. It used to send every one of
// those straight to the network with the browser's cache ignored, which is the
// long refresh on a poor connection: forty-odd module requests over again, with
// nothing allowed to answer them but the wire.
//
// The song cache it never writes to: only js/offline.js decides what is kept,
// which is what keeps a song from being cached twice under two names.

import { CACHE_NAME, mediaCacheKey } from "./js/offline.js";

const MEDIA_PATH = /^\/api\/v1\/media\/[^/]+$/;
// SHELL_CACHE holds the app itself as it last arrived. Nothing else writes to
// it, and it is only ever read when the network does not answer in time.
const SHELL_CACHE = "musoak-shell";
// SHELL_TIMEOUT_MS is how long a person waits for a page before the copy from
// the last load is served instead. Half a second longer than a slow-but-working
// response, short enough that a dead link is not a dead page.
const SHELL_TIMEOUT_MS = 2500;
// Everything that makes up the app itself: the page, its modules, its styles and
// its fonts. The API is left alone.
const SHELL_PATH = /^\/(?:$|index\.html$|theme\.css$|icon\.png$|sw\.js$|js\/|fonts\/)/;

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

  if (MEDIA_PATH.test(url.pathname)) {
    event.respondWith(keptSong(request));
    return;
  }

  // The frontend is edited while it is being served, and a browser will reuse a
  // copy it cached back when the server had no say about caching at all. Asking
  // for it with `cache: "reload"` ignores that copy, so an edit appears on the
  // next reload with nothing for anybody to clear - and what arrives is kept,
  // so the next load that cannot reach the network has something to show.
  if (SHELL_PATH.test(url.pathname)) {
    event.respondWith(shell(request));
  }
});

/** The app's own files: the network first, then the last load that worked.
 *
 * A page that cannot reach the server used to be a page that did not open. Now
 * it is the app as it was, which is the difference between a slow start and no
 * start on a connection that is having a bad minute. Freshness is kept where it
 * is wanted: whatever the network answers with replaces the copy, so an edit
 * shows up on the load after next, exactly as it did before.
 */
async function shell(request) {
  let cache = null;
  try {
    cache = await caches.open(SHELL_CACHE);
  } catch {
    /* no Cache Storage: straight to the network, as it always was */
  }

  try {
    const response = await within(fetch(request, { cache: "reload" }), SHELL_TIMEOUT_MS);
    if (response && response.ok && cache) {
      // A copy at a time, not on every request: the page and its modules are
      // the same few hundred kilobytes over and over.
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = cache ? await cache.match(request).catch(() => null) : null;
    if (cached) return cached;
    throw error;
  }
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
