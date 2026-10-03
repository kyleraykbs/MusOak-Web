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

// --- the index of kept playlists -------------------------------------------

/** id -> {id, name, trackIds, bytes, savedAt}, so reads are synchronous. */
let mirror = new Map();
let loading = null;
let swRegistered = false;
const listeners = new Set();
const jobs = new Map();
const syncing = new Set();
const pending = new Map();

function hasIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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

/** Wait until the server has this variant on disk, polling while it downloads. */
async function ensureReady(client, variantId, signal) {
  let status = await client.mediaStatus(variantId);
  if (status.state === "ready") return status;
  if (status.state === "failed") throw new Error("the server could not fetch this song");
  await client.startDownload(variantId, false);
  for (;;) {
    await delay(500, signal);
    status = await client.mediaStatus(variantId);
    if (status.state === "ready") return status;
    if (status.state === "failed") throw new Error("the server could not fetch this song");
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

  const work = (async () => {
    const cache = await openCache();
    if (cache) {
      const existing = await cache.match(key);
      if (existing) return responseBytes(existing);
    }
    await ensureReady(client, variantId, signal);
    // The media bytes have no JSON client method: mediaUrl() is the same-origin
    // routed URL, and the session cookie authenticates it.
    const response = await fetch(key, { signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(`the server returned ${response.status} for this song`);
    const blob = await response.blob();
    if (cache) {
      await cache.put(key, new Response(blob, {
        headers: {
          "Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
          "Content-Length": String(blob.size),
          "Accept-Ranges": "bytes",
        },
      }));
    }
    return blob.size;
  })().finally(() => pending.delete(key));

  pending.set(key, work);
  return work;
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

/** The worker that serves kept songs with no server: registered on first use. */
function ensureServiceWorker() {
  if (swRegistered) return;
  swRegistered = true;
  if (typeof navigator === "undefined" || !navigator.serviceWorker || typeof window === "undefined") return;
  try {
    navigator.serviceWorker
      .register(new URL("../sw.js", import.meta.url).href, { type: "module" })
      .catch(() => {
        swRegistered = false;
      });
  } catch {
    swRegistered = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    syncKept().catch(() => {});
  });
  // Registered whether or not anything is kept: the worker also makes sure the
  // app's own files are fetched rather than reused from a cache that predates
  // the server's caching policy, which is what left people running yesterday's
  // modules with nothing they could do about it.
  ensureServiceWorker();
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
  ensureServiceWorker();
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
    const list_ = tracks && tracks.length ? tracks : ((await client.playlist(playlistId)).tracks || []);
    const total = list_.length;
    const entries = [];
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
        entries.push({ trackId: track.id, variantId });
        bytes += size;
      } catch (error) {
        if (stopped()) return null;
        if (error?.status === 401) {
          view.finish();
          view.close();
          await report(error);
          return null;
        }
        failed += 1;
      }
    }

    if (stopped()) return null;

    if (failed) {
      const message = `${failed} of ${total} songs could not be downloaded. Nothing is kept yet.`;
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

/** Bring one kept playlist up to date, fetching only what is missing. */
async function syncOne(playlistId, name, { quiet = true } = {}) {
  if (syncing.has(playlistId)) return false;
  const client = activeClient();
  const record = mirror.get(String(playlistId));
  if (!client || !record) return false;
  syncing.add(playlistId);
  try {
    const detail = await client.playlist(playlistId);
    const tracks = detail.tracks || [];
    const oldByTrack = new Map((record.trackIds || []).map((entry) => [entry.trackId, entry.variantId]));
    const cache = await openCache();
    const entries = [];
    let bytes = 0;

    for (const track of tracks) {
      let variantId = "";
      try {
        variantId = await resolveVariant(client, track.id);
      } catch {
        variantId = oldByTrack.get(track.id) || "";
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
          size = await fetchVariantToCache(client, variantId, null);
          present = true;
        } catch {
          present = false;
        }
      }

      if (present) {
        entries.push({ trackId: track.id, variantId });
        bytes += size;
      } else if (oldByTrack.has(track.id)) {
        entries.push({ trackId: track.id, variantId: oldByTrack.get(track.id) });
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
    if (!quiet) await report(error);
    return false;
  } finally {
    syncing.delete(playlistId);
  }
}

/** Quietly re-download anything missing from every kept playlist. */
export async function syncKept() {
  ensureServiceWorker();
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
      ensureServiceWorker();
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
  download,
  remove,
  syncKept,
  button,
};
