// The service worker behind "kept" playlists.
//
// It answers one thing and nothing else: a GET for a song the offline module
// has already put in Cache Storage. So a kept playlist plays with no server at
// all, while every other request goes straight to the network untouched.
//
// It never writes to the cache. Only js/offline.js decides what is kept, which
// is what keeps a song from being cached twice under two names.

import { CACHE_NAME, mediaCacheKey } from "./js/offline.js";

const MEDIA_PATH = /^\/api\/v1\/media\/[^/]+$/;
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
  // next reload with nothing for anybody to clear.
  if (SHELL_PATH.test(url.pathname)) {
    event.respondWith(fetch(request, { cache: "reload" }));
  }
});

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
