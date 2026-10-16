// Playlists kept in the browser, the way the GTK client keeps them on disk.
//
// A kept playlist is playable with no backend at all: every song's bytes are in
// Cache Storage before the playlist is called downloaded, and the index in
// IndexedDB remembers what belongs to which playlist. Which playlists you keep
// is about this browser, not about the account.
//
// The sw.js service worker answers media requests from that cache, so playback
// keeps working offline. Everything else stays on the network.

import { h, clear, dialog, toast, fmtBytes, iconOr } from "./dom.js";
import { Client } from "./client.js";
import { state, session } from "./state.js";

/** The cache the media bytes live in, served back by sw.js. */
export const CACHE_NAME = "musoak-offline-v1";

const DB_NAME = "musoak-offline";
const DB_VERSION = 1;
const STORE = "playlists";

/** How long the server is given to have one song on disk before this page stops
 *  waiting for it. The player waits the same length for the file it is about to
 *  play; a fetch that has not finished by then is stuck rather than slow, and
 *  waiting for it is a "Keep playlist" that spins for the session while every
 *  playlist behind the first one waits for ever. */
const READY_TIMEOUT_MS = 60000;

/** How often the server is asked whether the file has landed. */
const READY_POLL_MS = 500;

/** How long one song's bytes are given to arrive once the server has them.
 *  READY_TIMEOUT_MS covers the wait for the server, not the transfer: a
 *  connection that is accepted and then goes quiet would otherwise hold this
 *  song's slot in the download queue for the rest of the session, and every
 *  song behind it waits for a transfer that is never coming. Generous, because
 *  a song over a slow line is slow, not stuck. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const MUTED_COLOUR = "var(--red)";

// --- pure logic (used by the module and by its tests) ----------------------

function defaultBase() {
  return typeof location !== "undefined" && location.origin ? location.origin : "http://localhost";
}

/**
 * The cache entry a media URL belongs to. The variant alone is not enough: the
 * same song on two backends is two downloads, so the backend (the `ps` the
 * router routes by) is part of the key. Everything else in the query is noise
 * the browser may add.
 */
export function mediaCacheKey(mediaUrl, base = defaultBase()) {
  const parsed = new URL(mediaUrl, base);
  // The backend is named in the query (that is how a kept song is fetched with
  // no headers), so it has to be part of the key: the same variant id on two
  // backends is two different files.
  const server = parsed.searchParams.get("ms") || "";
  return `${parsed.origin}${parsed.pathname}?ms=${encodeURIComponent(server)}`;
}

/**
 * The variant a media URL names. The media path is `/api/v1/media/<variant>`;
 * nothing else in the URL is the song - not the backend in the query, and not
 * the position a stream was asked to start at.
 */
export function mediaVariantId(mediaUrl, base = defaultBase()) {
  try {
    const found = /^\/api\/v1\/media\/([^/]+)$/.exec(new URL(mediaUrl, base).pathname);
    return found ? decodeURIComponent(found[1]) : "";
  } catch {
    return "";
  }
}

/**
 * A media URL as this page asks for it again: the path and its query, which is
 * what the element and the worker both work with, since the origin is the
 * page's own either way.
 */
export function mediaPath(mediaUrl, base = defaultBase()) {
  const value = String(mediaUrl || "");
  if (!value) return "";
  try {
    const parsed = new URL(value, base);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

/** What a set of downloaded songs adds up to; a missing size counts as zero. */
export function totalBytes(entries) {
  let total = 0;
  for (const entry of entries || []) {
    const value = typeof entry === "number" ? entry : Number(entry?.bytes);
    if (Number.isFinite(value) && value > 0) total += value;
  }
  return total;
}

/**
 * Which songs a kept playlist still needs fetched: the ones its index record
 * does not already hold — a new song, or one now kept from another source.
 */
export function plannedFetches(record, tracks) {
  const have = new Map();
  for (const entry of record?.trackIds || []) have.set(entry.trackId, entry.variantId);
  const plan = [];
  for (const track of tracks || []) {
    const trackId = track.trackId ?? track.id;
    const variantId = track.variantId ?? "";
    if (!trackId || !variantId) continue;
    if (have.get(trackId) === variantId) continue;
    plan.push({ trackId, variantId });
  }
  return plan;
}

/**
 * The songs of a kept list as tracks the player can queue.
 *
 * Each one carries the URL its own copy is at, so a kept playlist is heard
 * whole with no server: the song after this one plays from here too, and
 * nothing has to be resolved to reach it. The title is what the list was kept
 * with - the index is all this page has to name a song by when the server
 * cannot be asked.
 */
export function keptTracks(entries) {
  return (entries || []).map((entry) => ({
    id: String(entry.trackId || ""),
    title: entry.title || "",
    variantId: String(entry.variantId || ""),
    localUrl: String(entry.url || ""),
  }));
}

/**
 * What to say about a kept playlist the browser has let go of.
 *
 * Cache Storage is the browser's room to manage, and it evicts without asking:
 * a playlist can be kept and still have nothing left to play. Saying which
 * songs are gone is the difference between a Play that does nothing and a Play
 * that told somebody why.
 */
export function keptGoneMessage(name, missing, total) {
  const who = name ? `\u201c${name}\u201d` : "That playlist";
  const gone = (missing || []).length;
  const count = Math.max(gone, Number(total) || 0);
  if (!gone) return `${who} has nothing kept on this machine.`;
  if (count <= gone) {
    return `${who} is kept here, but its songs are no longer in this browser\u2019s cache. Keep it again once the server is back.`;
  }
  return `${gone} of ${count} songs in ${who} are no longer in this browser\u2019s cache.`;
}

/** How many songs are fetched at once, unless the account page says otherwise.
 *
 * Every copy that lands in the cache goes through one queue - a playlist being
 * kept, the window the queue warms ahead, a sync after a load - and asking for
 * sixty songs is not asking for sixty downloads. The browser would open sixty
 * connections, the server would run sixty provider fetches at once, and the one
 * song the room is about to need would be last in line behind all of them. Five
 * at a time keeps the wire busy and the queue moving.
 */
export const DEFAULT_DOWNLOAD_LIMIT = 5;

function downloadLimit() {
  if (state.downloadLimit === "all") return Number.POSITIVE_INFINITY;
  const wanted = Number(state.downloadLimit);
  if (!Number.isFinite(wanted) || wanted <= 0) return DEFAULT_DOWNLOAD_LIMIT;
  return Math.min(20, Math.floor(wanted));
}

/** A queue of work with a ceiling on how much of it runs at once: first asked,
 *  first fetched, and a failure takes its own slot back rather than the queue's.
 *  Exported because the ceiling is the thing worth testing, and testing it
 *  through a browser cache is not worth anything. */
export function createDownloadQueue({ limit = downloadLimit } = {}) {
  let running = 0;
  const waiting = [];

  const pump = () => {
    while (running < Math.max(1, Number(limit()) || 1) && waiting.length) {
      const next = waiting.shift();
      running += 1;
      let work;
      try {
        // Invoke immediately: callers use the start of a transfer as their
        // scheduling observation, while the promise still owns rejection and
        // slot release for asynchronous work.
        work = next.task();
      } catch (error) {
        work = Promise.reject(error);
      }
      Promise.resolve(work)
        .then(next.resolve, next.reject)
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  };

  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      pump();
    });
}

/** The queue every cached copy goes through. */
const downloads = createDownloadQueue();

/** Run one server-backed media transfer under this device's concurrency limit. */
export function withDownloadSlot(task) {
  return downloads(task);
}

/**
 * The order a playlist's songs should be fetched in.
 *
 * A playlist being kept is usually the queue being played, and the order it
 * will be heard in is the queue's - after a shuffle that is no longer the order
 * the playlist is stored in. The songs the player is about to reach come first,
 * highest undownloaded first, and everything else keeps the list's own order.
 */
export function queueOrder(tracks, queue = [], index = 0) {
  const list = Array.isArray(tracks) ? [...tracks] : [];
  const rank = new Map();
  let next = 0;
  for (const track of Array.isArray(queue) ? queue.slice(Math.max(0, Math.floor(Number(index) || 0))) : []) {
    const id = String(track?.id ?? track?.trackId ?? "");
    if (id && !rank.has(id)) {
      rank.set(id, next);
      next += 1;
    }
  }
  if (!rank.size) return list;
  return list.sort((left, right) => {
    const a = rank.has(String(left.id)) ? rank.get(String(left.id)) : next;
    const b = rank.has(String(right.id)) ? rank.get(String(right.id)) : next;
    return a - b;
  });
}

/** A playlist's songs, ordered by the queue this page is playing. */
async function inQueueOrder(tracks) {
  let queue = [];
  let index = 0;
  try {
    const { player } = await import("./player.js");
    queue = player.queue || [];
    index = Math.max(0, Number(player._index) || 0);
  } catch {
    /* no player to order by: the list keeps its own order */
  }
  return queueOrder(tracks, queue, index);
}

// --- the index of kept playlists -------------------------------------------

/** id -> {id, name, trackIds, bytes, savedAt}, so reads are synchronous. */
let mirror = new Map();
let loading = null;
const listeners = new Set();
const jobs = new Map();
// The keep-in-step runs under way, by playlist: what is there so a second ask
// can call the first off rather than wait behind it.
const syncing = new Map();
const pending = new Map();

function hasIndexedDb() {
  return typeof indexedDB !== "undefined";
}

// One connection for the life of the page. A connection per read and write
// leaked them - the browser keeps every one it hands out - and a later schema
// upgrade would be blocked by whichever of them was still open.
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => {
      const db = request.result;
      // A version change elsewhere waits for this connection to close, so it
      // closes itself; and a connection the browser takes away (storage
      // cleared, the tab's quota reaped) is forgotten rather than reused.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;   // this ask failed; the next one may not
      reject(request.error);
    };
  });
  return dbPromise;
}

async function readAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function writeRecord(record) {
  if (!hasIndexedDb()) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function dropRecord(id) {
  if (!hasIndexedDb()) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Load the index once, so isKept()/storageBytes() can answer at once. */
export function ensureLoaded() {
  if (!loading) {
    loading = (hasIndexedDb() ? readAll() : Promise.resolve([]))
      .then((records) => {
        mirror = new Map((records || []).map((record) => [record.id, record]));
        return mirror;
      })
      .catch(() => mirror);
  }
  return loading;
}

async function saveRecord(record) {
  mirror.set(record.id, record);
  await writeRecord(record);
}

function notifyChanged() {
  for (const ref of [...listeners]) {
    const node = ref.deref();
    if (node) node.__offlineRefresh?.();
    else listeners.delete(ref);
  }
}

function watch(node) {
  if (typeof WeakRef === "function") listeners.add(new WeakRef(node));
}

// --- the media cache -------------------------------------------------------

function openCache() {
  if (typeof caches === "undefined") return Promise.resolve(null);
  return caches.open(CACHE_NAME);
}

async function responseBytes(response) {
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length >= 0) return length;
  const blob = await response.clone().blob();
  return blob.size;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      const error = new Error("cancelled");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener?.("abort", abort, { once: true });
  });
}

/** Wait until the server has this variant on disk, polling while it downloads.
 *  The wait has a deadline: a download the server never finishes would
 *  otherwise leave this loop spinning for the rest of the session. */
async function ensureReady(client, variantId, signal) {
  let status = await client.mediaStatus(variantId);
  if (status.state === "ready") return status;
  if (status.state === "failed") throw new Error("the server could not fetch this song");
  await client.startDownload(variantId, false);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    await delay(READY_POLL_MS, signal);
    status = await client.mediaStatus(variantId);
    if (status.state === "ready") return status;
    if (status.state === "failed") throw new Error("the server could not fetch this song");
    if (Date.now() >= deadline) throw new Error("the server did not finish fetching this song");
  }
}

/** One song's bytes, with a deadline beside the caller's own signal.
 *
 *  The deadline is this page's, not the caller's: a transfer that stalls is a
 *  failed download that frees its slot, while the run being cancelled still
 *  stands it down at once. */
async function fetchSongBytes(url, signal, ms) {
  const controller = new AbortController();
  const stop = () => controller.abort(signal?.reason);
  if (signal?.aborted) stop();
  else signal?.addEventListener?.("abort", stop, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("the transfer stalled")), ms);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(`the server returned ${response.status} for this song`);
    return await response.blob();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", stop);
  }
}

/**
 * Put one variant's bytes in the cache, once. Returns its size. A song already
 * cached is never fetched again, so two playlists sharing a song share the
 * entry.
 */
function fetchVariantToCache(client, variantId, signal) {
  const key = mediaCacheKey(client.mediaUrl(variantId));
  const running = pending.get(key);
  if (running) return running;

  // Queued, not fired: see createDownloadQueue. The dedupe above still holds -
  // the same song asked for twice is one entry, and the queue sees one task.
  const work = downloads(async () => {
    const cache = await openCache();
    if (cache) {
      const existing = await cache.match(key);
      if (existing) return responseBytes(existing);
    }
    await ensureReady(client, variantId, signal);
    // The media bytes have no JSON client method: mediaUrl() is the same-origin
    // routed URL, and the session cookie authenticates it.
    const blob = await fetchSongBytes(key, signal, DOWNLOAD_TIMEOUT_MS);
    if (cache) {
      await cache.put(key, new Response(blob, {
        headers: {
          "Content-Type": blob.type || "application/octet-stream",
          "Content-Length": String(blob.size),
          "Accept-Ranges": "bytes",
        },
      }));
    }
    return blob.size;
  }).finally(() => pending.delete(key));

  pending.set(key, work);
  return work;
}

/** What went wrong, in words a person can act on. */
function reasonFor(error) {
  if (!error) return "it failed for no stated reason";
  if (error.status) return `the server said ${error.status}${error.message ? ` (${error.message})` : ""}`;
  return String(error.message || error);
}

/** Which variant of a song this client would play, from the account's picks. */
async function resolveVariant(client, trackId) {
  let preferred = "";
  let candidates = [];
  try {
    const found = await client.sources(trackId);
    preferred = found.preferredVariantId;
    candidates = (found.sources || [])
      .filter((source) => source.downloadable)
      .map((source) => ({ id: source.variantId, provider: source.provider, default: source.default }));
  } catch {
    /* fall through to a resolve */
  }
  if (!candidates.length) {
    const variants = await client.resolve(trackId).catch(() => []);
    candidates = (variants || [])
      .filter((variant) => variant.downloadable)
      .map((variant) => ({ id: variant.id, provider: variant.provider, default: false }));
  }
  if (!candidates.length) throw new Error("no downloadable source for this song");
  const chosen = (await client.pickVariant(candidates, preferred)) || candidates[0];
  return chosen.id;
}

// --- talking to the shell --------------------------------------------------

function activeClient() {
  if (!state.server) return null;
  const stored = session();
  return new Client({
    server: state.server,
    token: stored.token || "",
    memberId: stored.memberId || "",
    memberName: stored.memberName || "web",
  });
}

async function announce(message, kind = "") {
  try {
    const { banner } = await import("./app.js");
    banner(message, kind);
  } catch {
    toast(message);
  }
}

async function report(error) {
  if (error?.status === 401) {
    try {
      const { requireLogin } = await import("./app.js");
      requireLogin();
    } catch {
      /* no shell to ask */
    }
    return;
  }
  await announce(error?.message || String(error), "error");
}

/** The worker that serves kept songs with no server is registered by the shell,
 *  in app.js, on every load. It used to be registered from here as well - this
 *  module is the one that knows what the worker is for - but that made the
 *  registration a side effect of a *feature* module loading: with the views
 *  imported behind the first paint, a load that never opened Playlists never
 *  registered a worker at all, and the offline shell quietly did not exist. */
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    syncKept().catch(() => {});
  });
}

// --- what is kept ----------------------------------------------------------

/** Is this playlist kept here? Answers from the loaded index, at once. */
export function isKept(playlistId) {
  return mirror.has(String(playlistId));
}

/** How much room a kept playlist takes up here. */
export function storageBytes(playlistId) {
  return Number(mirror.get(String(playlistId))?.bytes) || 0;
}

/** Every kept playlist, newest first. */
export function list() {
  return [...mirror.values()].sort((left, right) => (right.savedAt || 0) - (left.savedAt || 0));
}

// --- playing what is kept --------------------------------------------------

/** One kept variant's URL, or "" when the cache no longer holds it.
 *
 *  The key is built when a client can still name the backend, and looked for
 *  when it cannot: this page may have been opened with no server at all, and
 *  the cache's own keys are the answer then - they are the strings the download
 *  wrote, which is the key the worker matches a play against. */
async function keptUrl(cache, client, variantId) {
  if (!cache || !variantId) return "";
  const wanted = client ? mediaCacheKey(client.mediaUrl(variantId)) : "";
  if (wanted && (await cache.match(wanted).catch(() => null))) return mediaPath(wanted);
  const keys = await cache.keys().catch(() => []);
  const found = keys.find((request) => mediaVariantId(request.url) === String(variantId));
  return found ? mediaPath(found.url) : "";
}

/**
 * Which of a kept record's songs this page can still play, and where each one
 * is. Songs the browser has since let go are listed as missing rather than
 * dropped: they are what the page says out loud (see `keptGoneMessage`).
 *
 * The cache is passed in rather than opened here so the rule can be read - and
 * tested - without a browser cache to stand up.
 */
export async function keptEntries(record, { cache = null, client = null } = {}) {
  const entries = [];
  const missing = [];
  for (const entry of record?.trackIds || []) {
    const url = await keptUrl(cache, client, entry.variantId);
    if (url) entries.push({ ...entry, url });
    else missing.push({ trackId: entry.trackId, variantId: entry.variantId, title: entry.title || "" });
  }
  return { id: String(record?.id || ""), name: record?.name || "", entries, missing };
}

/**
 * A kept playlist's songs as they can be played right now: for each one the
 * entry the download wrote and the URL its own copy is at, plus the ones the
 * browser has let go. Answers null for a playlist this browser does not keep,
 * which is how a caller tells "kept, and the cache is empty" from "not kept".
 */
export async function playlistEntries(playlistId) {
  await ensureLoaded();
  const record = mirror.get(String(playlistId));
  if (!record) return null;
  return keptEntries(record, { cache: await openCache(), client: activeClient() });
}

// --- keeping a playlist ----------------------------------------------------

function downloadDialog(name, onCancel) {
  const status = h("div", { class: "subtitle", text: "Finding the songs\u2026" });
  const song = h("div", { class: "subtitle" });
  const bar = h("div", { class: "bar" });
  const progress = h("div", { class: "progress" }, bar);
  const error = h("div", { class: "subtitle", style: { color: MUTED_COLOUR } });
  const state_ = { cancelled: false, finished: false };

  const { close, node } = dialog({
    title: `Downloading ${name}`,
    body: h("div", { class: "field" }, status, song, progress, error),
    actions: [
      {
        label: "Cancel",
        class: "destructive",
        onClick: () => {
          if (!state_.finished) {
            state_.cancelled = true;
            onCancel?.();
          }
        },
      },
    ],
  });
  const action = node.querySelector(".actions .btn");

  // Escape and a backdrop click close the dialog without telling us: notice
  // the node leaving the page and stop the transfer under way with it.
  const observer = new MutationObserver(() => {
    if (node.isConnected) return;
    observer.disconnect();
    if (state_.finished) return;
    state_.cancelled = true;
    onCancel?.();
  });
  observer.observe(document.body, { childList: true });

  return {
    node,
    close,
    state: state_,
    setProgress(position, total, title) {
      status.textContent = `Song ${position}/${total}`;
      song.textContent = title || "";
      bar.style.width = `${Math.round(((position - 1) / Math.max(total, 1)) * 100)}%`;
    },
    setError(message) {
      state_.finished = true;
      error.textContent = message;
      bar.style.width = "100%";
      if (action) action.textContent = "Close";
    },
    finish() {
      state_.finished = true;
    },
  };
}

/**
 * Keep a playlist here: song by song, with progress and a way out. Songs that
 * are already cached are not downloaded twice; nothing is kept unless every
 * song made it.
 */
export async function download(playlistId, name, tracks, onProgress) {
  if (!playlistId || jobs.has(playlistId)) return null;
  await ensureLoaded();
  const client = activeClient();
  if (!client) {
    await announce("Choose a server before keeping music offline.", "error");
    return null;
  }

  const job = { abort: new AbortController() };
  jobs.set(playlistId, job);
  const view = downloadDialog(name || "playlist", () => job.abort.abort());
  const stopped = () => view.state.cancelled || !view.node.isConnected;

  try {
    const list_ = await inQueueOrder(
      tracks && tracks.length ? tracks : ((await client.playlist(playlistId)).tracks || [])
    );
    const total = list_.length;
    const entries = [];
    const reasons = [];
    let bytes = 0;
    let failed = 0;

    for (let position = 0; position < total; position += 1) {
      if (stopped()) return null;
      const track = list_[position];
      view.setProgress(position + 1, total, track.title || "");
      onProgress?.(position + 1, total, track.title || "");
      try {
        const variantId = await resolveVariant(client, track.id);
        const size = await fetchVariantToCache(client, variantId, job.abort.signal);
        // The title comes along: with no server to ask, the index is the only
        // thing that can name what is playing, and "unknown track" under a song
        // this machine holds is a page that forgot what it kept.
        entries.push({ trackId: track.id, variantId, title: track.title || "" });
        bytes += size;
      } catch (error) {
        if (stopped()) return null;
        if (error?.status === 401) {
          view.finish();
          view.close();
          await report(error);
          return null;
        }
        // Say *why*, and say it in the log as well as the dialog: a song that
        // cannot be downloaded used to be counted and thrown away, so the one
        // person who could have fixed it - whoever is looking at the page - saw
        // "1 of 1 songs could not be downloaded" and nothing else.
        failed += 1;
        reasons.push(`${track.title || "a song"}: ${reasonFor(error)}`);
        console.warn("offline: could not keep", track.title || track.id, error);
      }
    }

    if (stopped()) return null;

    if (failed) {
      const message = `${failed} of ${total} songs could not be downloaded. Nothing is kept yet. ${reasons.join("; ")}`;
      view.setError(message);
      await announce(message, "error");
      return null;
    }

    const record = {
      id: playlistId,
      name: name || "",
      trackIds: entries,
      bytes,
      savedAt: Date.now(),
    };
    await saveRecord(record);
    notifyChanged();
    view.finish();
    view.close();
    await announce(`Kept ${record.name || "the playlist"} for offline play.`);
    return record;
  } catch (error) {
    view.finish();
    view.close();
    await report(error);
    return null;
  } finally {
    jobs.delete(playlistId);
  }
}

/** Take a playlist off this machine, freeing what nothing else keeps. */
export async function remove(playlistId) {
  await ensureLoaded();
  const record = mirror.get(String(playlistId));
  if (!record) return 0;
  // A keep-in-step still running would fetch the songs straight back, so the
  // ask to remove is also the ask to stop.
  syncing.get(record.id)?.abort();
  const client = activeClient();
  mirror.delete(record.id);
  await dropRecord(record.id);

  const stillKept = new Set();
  for (const other of mirror.values()) {
    for (const entry of other.trackIds || []) stillKept.add(entry.variantId);
  }

  let freed = 0;
  const cache = client ? await openCache() : null;
  if (cache) {
    for (const entry of record.trackIds || []) {
      if (stillKept.has(entry.variantId)) continue;
      const key = mediaCacheKey(client.mediaUrl(entry.variantId));
      const hit = await cache.match(key);
      if (!hit) continue;
      freed += await responseBytes(hit);
      await cache.delete(key);
    }
  }

  notifyChanged();
  return freed;
}

async function removeKept(playlistId) {
  try {
    const freed = await remove(playlistId);
    await announce(`Freed ${fmtBytes(freed)} of offline music.`);
  } catch (error) {
    await report(error);
  }
}

// --- keeping in step -------------------------------------------------------

/** Bring one kept playlist up to date, fetching only what is missing.
 *
 *  A second ask for the same playlist is somebody who has given up waiting on
 *  the first: the run already going is called off rather than left to hold the
 *  new one behind it, which is what left "Sync now" doing nothing at all after
 *  one song had stuck. */
async function syncOne(playlistId, name, { quiet = true } = {}) {
  const id = String(playlistId);
  syncing.get(id)?.abort();
  const client = activeClient();
  const record = mirror.get(id);
  if (!client || !record) return false;
  const run = new AbortController();
  syncing.set(id, run);
  const { signal } = run;
  try {
    const detail = await client.playlist(playlistId);
    const tracks = await inQueueOrder(detail.tracks || []);
    const oldByTrack = new Map((record.trackIds || []).map((entry) => [entry.trackId, entry]));
    const cache = await openCache();
    const entries = [];
    let bytes = 0;

    for (const track of tracks) {
      if (signal.aborted) return false;
      let variantId = "";
      try {
        variantId = await resolveVariant(client, track.id);
      } catch {
        variantId = oldByTrack.get(track.id)?.variantId || "";
      }
      if (!variantId) continue;

      const key = mediaCacheKey(client.mediaUrl(variantId));
      let present = false;
      let size = 0;
      const hit = cache ? await cache.match(key) : null;
      if (hit) {
        present = true;
        size = await responseBytes(hit);
      } else {
        try {
          size = await fetchVariantToCache(client, variantId, signal);
          present = true;
        } catch {
          present = false;
        }
      }

      if (present) {
        entries.push({ trackId: track.id, variantId, title: track.title || "" });
        bytes += size;
      } else if (oldByTrack.has(track.id)) {
        // The file this copy was made from is gone from the cache and the
        // server could not fetch it again: the entry stays, with the title it
        // was kept under, so the playlist keeps naming the song it holds.
        const old = oldByTrack.get(track.id);
        entries.push({ trackId: track.id, variantId: old.variantId, title: track.title || old.title || "" });
      }
    }

    const changed =
      bytes !== record.bytes || JSON.stringify(entries) !== JSON.stringify(record.trackIds || []);
    if (changed) {
      await saveRecord({ ...record, name: name || record.name, trackIds: entries, bytes, savedAt: Date.now() });
      notifyChanged();
    }
    if (changed && !quiet) await announce(`Updated ${record.name || "the playlist"} for offline play.`);
    return changed;
  } catch (error) {
    // Called off is not a failure to report: whoever asked is already waiting
    // on the run that replaced this one.
    if (signal.aborted) return false;
    if (!quiet) await report(error);
    return false;
  } finally {
    // Only if this is still the run for this playlist: a called-off one must
    // not drop the entry the run that replaced it put there.
    if (syncing.get(id) === run) syncing.delete(id);
  }
}

/** Quietly re-download anything missing from every kept playlist. */
export async function syncKept() {
  await ensureLoaded();
  for (const record of list()) {
    await syncOne(record.id, record.name);
  }
}

// --- the row control -------------------------------------------------------

function openKeptDialog(playlist) {
  const bytes = storageBytes(playlist.id);
  dialog({
    title: playlist.name || "Offline copy",
    body: h(
      "div",
      { class: "field" },
      h("p", { text: `${fmtBytes(bytes)} of music on this machine.` }),
      h("p", { text: "Its songs play with no server connection." })
    ),
    actions: [
      { label: "Cancel" },
      { label: "Sync now", onClick: () => syncOne(playlist.id, playlist.name, { quiet: false }) },
      { label: "Remove download", class: "destructive", onClick: () => removeKept(playlist.id) },
    ],
  });
}

/**
 * A playlist row's offline state: the size to the left of the cloud, the cloud
 * to the left of the menu — time, size, cloud, menu, as the row puts it.
 */
export function button(playlist) {
  const id = playlist.id;
  const name = playlist.name || "";
  const size = h("span", { class: "time" });
  const control = h("button", {
    class: "btn flat round",
    onclick: () => {
      if (isKept(id)) openKeptDialog({ id, name });
      else download(id, name, null, null);
    },
  });

  const refresh = () => {
    const kept = isKept(id);
    const bytes = kept ? storageBytes(id) : 0;
    size.textContent = kept && bytes ? fmtBytes(bytes) : "";
    const label = kept
      ? "Kept for offline play \u2014 click to remove the download"
      : "Keep this playlist for offline play";
    control.title = label;
    control.setAttribute("aria-label", label);
    clear(control);
    control.appendChild(iconOr(kept ? "cloud" : "download"));
  };
  const node = h("div", { style: { display: "flex", alignItems: "center", gap: "6px" } }, size, control);
  node.__offlineRefresh = refresh;
  watch(node);
  refresh();
  ensureLoaded().then(refresh);
  return node;
}

/** Everything the views call, in one place. */
export const offline = {
  isKept,
  storageBytes,
  list,
  playlistEntries,
  keptTracks,
  keptGoneMessage,
  download,
  remove,
  syncKept,
  button,
};
