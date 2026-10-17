// The playback engine and the now-playing bar.
//
// One audio element, one queue: a track is resolved to a source on the backend,
// and the rendition's file is downloaded before any of it is heard. Nothing is
// played until the backend holds the complete file - a rendition it does not hold
// is refused rather than sent to the audio element - so every source this element
// receives is one it can seek within and serve again from disk.
// the songs after it are fetched ahead, and when the page's own copy of the
// track that is playing arrives the element is moved onto it, at the same
// position, so the rest of the song plays out of memory.
// Everything else in the app talks to the `player` singleton and listens on
// player.on(...).
//
// The file is importable without a DOM: the shell guards its own boot, and
// nothing here touches the document until mountPlayer() is called.
import {
  banner, currentClient, emit, navigate, on, requireLogin, toggleFavorite,
} from "./app.js";
import { ServerError } from "./client.js";
import { h, mount, dialog, icon, iconButton, fmtBytes, artworkImage } from "./dom.js";
import { lyricsPanel } from "./views/lyrics.js";
import { session, state, updateSession, preloadAhead } from "./state.js";
import { openSourcePicker, pickSource, sourceLabel, findSourceDialog } from "./views/sources.js";
import { withDownloadSlot } from "./offline.js";

/**
 * How many copies this page keeps in memory at most, played ones included.
 *
 * The look-ahead window is the device setting (`preloadAhead`: how many songs
 * after the one playing are fetched), so this is only the bound on what stays
 * behind it: a song just played is kept, so stepping back costs nothing, and the
 * oldest are let go first. A count alone bounds nothing a phone notices - whole
 * songs are megabytes each - so the bytes below are the budget that matters.
 */
export const OFFLINE_KEEP = 50;
/**
 * How much memory the copies may take together.
 *
 * Fifty whole songs is hundreds of megabytes and the tab is killed for holding
 * them, which is a session that ends with no error and nothing the listener did.
 * A phone can afford this much and no more, and the oldest copies outside the
 * window are let go to stay inside it.
 */
export const OFFLINE_MAX_BYTES = 256 * 1024 * 1024;
/** How many resolved tracks and media statuses this page remembers at once.
 *  Far more than any window needs, so it only bounds a session left open for
 *  hours; an entry that is dropped is resolved again when it is next asked
 *  for, which is a shortcut lost, not a promise broken. */
const CACHE_ENTRIES = 256;
/** How many songs this page fetches at once: one, always. The preload count is
 *  how many are *wanted*, not how many run together - "no multi-download". */
const OFFLINE_FETCHES = 1;
/** How long a song that did not arrive is left before it is tried again. */
const OFFLINE_RETRY_MS = 60000;
/** How often the bar asks the backend whether a download is done. */
const POLL_MS = 400;

/** How long this client waits for the backend to finish a file before saying it
 *  did not arrive. The server retries its own downloads and reports failure;
 *  this is the backstop for one that is stuck rather than failed, which would
 *  otherwise leave this member loading for ever and the room waiting on them. */
const READY_TIMEOUT_MS = 60000;
/** How long a seek counts as still in progress after the last drag. */
const SEEK_SETTLE_MS = 400;
/** How long the volume waits before this machine remembers it. */
const REMEMBER_MS = 500;
/** How often the queue is written to the account at most. */
const SAVE_PLAYBACK_MS = 5000;
/** How long a seek waits before it is worth saving. */
const SAVE_SETTLE_MS = 400;
/** How much one press of a volume key moves the level: the 5% the terminal
 *  player's own k/j move (`internal/cli/player.go`), which is also five steps
 *  of the bar's slider. */
const VOLUME_STEP = 0.05;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise that answers when a wait has run out, and a way to call it off.
 *
 *  A race against a bare timer leaves the timer behind: it holds the page (or a
 *  test process) open for the rest of its span after the thing being waited for
 *  has long since arrived. */
function deadline(ms) {
  let timer = 0;
  const promise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** A response read into a Blob, one piece at a time, with its own count.
 *
 *  Read rather than asked for whole, because this transfer is the wait a
 *  listener is in and its row says how far along it is; the length the server
 *  states is the denominator, and a response that states none is counted as
 *  unknown rather than as done. */
async function readMedia(response, onProgress) {
  const total = Number(response.headers?.get?.("content-length")) || 0;
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const blob = await response.blob();
    onProgress(blob.size, total || blob.size);
    return blob;
  }
  const reader = body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      onProgress(received, total);
    }
  }
  return new Blob(chunks, { type: response.headers?.get?.("content-type") || "" });
}

// How long a failed fetch waits before the one retry: long enough for a blip,
// short enough that nobody reaches for the skip button.
const FETCH_RETRY_PAUSE_MS = 700;
// How long a start waits for the element to learn a file's length before the
// play it was holding is let go. Nothing this page holds takes that long -
// metadata follows the src almost at once - so the bound is only so a broken
// element cannot leave the start behind to fire on whatever loads next.
const METADATA_TIMEOUT_MS = 10000;
const clamp01 = (value) => Math.min(1, Math.max(0, value));

// The bar is repainted from the audio element's own events, several times a
// second: writing only what changed keeps that quiet work.

/** Set a node's text, if it is not already saying that. */
function setText(node, value) {
  const next = value === null || value === undefined ? "" : String(value);
  if (node.textContent !== next) node.textContent = next;
}

/** Put an icon in a button, if it is not already showing that one. */
function setIcon(button, name, size = 16) {
  if (button.dataset.icon === name) return;
  button.dataset.icon = name;
  mount(button, icon(name, size));
}

/** Name a button, for the eye and for a reader. */
function setLabel(button, label) {
  if (button.dataset.label === label) return;
  button.dataset.label = label;
  button.title = label;
  button.setAttribute("aria-label", label);
}

/** What a file's download state is called, for the bar. */
export function mediaStateLabel(state) {
  switch (String(state || "").toLowerCase()) {
    case "ready":
      return "ready";
    case "downloading":
      return "downloading…";
    case "failed":
      return "download failed";
    default:
      // "none" and anything unexpected: nothing worth saying.
      return "";
  }
}

/**
 * What the bar's text line says the download is doing: the stage under way and
 * that stage's own numbers, from one `GET /media/{id}/status` answer. The
 * state's own vocabulary — "downloading…" and friends — is what a status too
 * bare to carry a stage falls back to, so those strings do not churn. The
 * numbers are the stage's: bytes while it is fetched, and a share of the work
 * while the fetched source is written, where there is no byte count to give.
 */
export function mediaProgressLabel(status) {
  const stage = String(status?.stage || "").toLowerCase();
  const progress = Number(status?.progress);
  const counted = Number.isFinite(progress) && progress >= 0;
  switch (stage) {
    case "download": {
      const total = Number(status?.totalBytes);
      // A length nobody knows yet: the state's own name, and a sweeping bar.
      if (!(total > 0)) return mediaStateLabel("downloading");
      const whole = fmtBytes(total);
      const done = fmtBytes(status?.bytes);
      // The unit is the whole's, said once: "3.1 of 8.4 MB", not "3.1 MB of
      // 8.4 MB" - and said twice only when the two figures land on different
      // units, where dropping one would read as a lie.
      const unit = whole.slice(whole.lastIndexOf(" ") + 1);
      const shown = done.endsWith(` ${unit}`) ? done.slice(0, -(unit.length + 1)) : done;
      return `downloading ${shown} of ${whole}`;
    }
    case "convert":
      return counted ? `converting ${Math.round(progress * 100)}%` : "converting…";
    case "store":
      return "storing the file";
    default:
      return mediaStateLabel(status?.state);
  }
}

/**
 * Which source names a song whose copy this page holds.
 *
 * A local copy is played from memory, but the bar still says where the song
 * came from (the pill, and the source picker behind it).  `known` is what the
 * page resolved for the track — the same resolution that fetched the copy —
 * and `variantId` the rendition the copy holds.  The exact rendition is the
 * honest answer; failing that the song's own default; failing that any source
 * of it, because naming the platform beats naming nothing.  `null` only when
 * this page knows nothing about the track at all.
 */
export function memorySource(known, variantId) {
  const sources = Array.isArray(known?.sources) ? known.sources : [];
  return sources.find((source) => source.variantId === variantId)
    || known?.source
    || sources[0]
    || null;
}

/** The current track and the next `count` ones: what stays downloaded. */
export function prefetchWindow(queue, index, count = 0) {
  const list = queue || [];
  const ahead = Math.max(0, Math.floor(Number(count) || 0));
  const start = Math.max(0, Math.floor(Number(index) || 0));
  return list.slice(start, start + ahead + 1);
}

/**
 * The index that plays after this one, or -1 when the queue is over.
 *
 * Without shuffle that is simply the next one. With shuffle it is a random
 * *other* track: a queue with nothing else left still ends, rather than
 * repeating itself for ever.
 */
export function nextIndex(queue, index, shuffle = false) {
  const count = queue?.length || 0;
  if (count === 0) return -1;
  if (!shuffle) return index + 1 < count ? index + 1 : -1;
  const playing = index >= 0 && index < count;
  const span = playing ? count - 1 : count;
  if (span <= 0) return -1;
  const pick = Math.floor(Math.random() * span);
  return playing && pick >= index ? pick + 1 : pick;
}

/** The whole queue shuffled, with the song that is playing left where it is.
 *
 * It used to shuffle only what came after the current song, which made the
 * button a lie from the queue's own page: the list somebody is looking at stays
 * in the order it was in, and only the part they cannot see moves. What is
 * behind the playhead is not a reason to leave it in order - it is a queue, and
 * the whole of it is what the button says it shuffles.
 */
export function shuffleWhole(queue, index, random = Math.random) {
  const list = [...(queue || [])];
  const playing = Math.max(0, Math.floor(Number(index) || 0));
  const rest = list.filter((_, position) => position !== playing);
  if (rest.length < 2) return list;
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  // Put back in one pass, so the playing song keeps its place in the list and
  // the queue keeps playing it.
  let next = 0;
  return list.map((entry, position) => (position === playing ? entry : rest[next++]));
}

/** A track's artists as one line: the API sends a list. */
export function artistLine(track) {
  if (!track) return "";
  const artists = track.artists;
  if (Array.isArray(artists)) return artists.filter(Boolean).join(", ");
  return String(artists || track.artist || "");
}

/** A track's album, as one name. */
export function albumLine(track) {
  if (!track) return "";
  const albums = track.albums;
  if (Array.isArray(albums) && albums.length) return String(albums[0] || "");
  return String(track.album || "");
}

/**
 * What is playing and where, as the server keeps it.
 *
 * The server stores this document without looking inside it: what "the queue
 * you were on" means is ours to say. The shape is the GTK client's, so either
 * client can pick up after the other.
 */
export function playbackDocument({
  queue = [], track = null, positionMs = 0, paused = true, playlistId = "", savedAt = Date.now(),
} = {}) {
  return {
    queue: (queue || []).map((entry) => ({
      trackId: String(entry?.id || ""),
      title: String(entry?.title || ""),
      artist: artistLine(entry),
      artworkUrl: String(entry?.artworkUrl || ""),
      durationMs: Math.round(Number(entry?.durationMs) || 0),
      album: albumLine(entry),
    })),
    currentTrackId: track ? String(track.id || "") : "",
    positionMs: Math.max(0, Math.round(Number(positionMs) || 0)),
    paused: Boolean(paused),
    playlistId: String(playlistId || ""),
    savedAt: Math.max(0, Math.round(Number(savedAt) || 0)),
  };
}

/** Objects with their keys in one order, so two equal documents compare equal. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((out, key) => {
        out[key] = stable(value[key]);
        return out;
      }, {});
  }
  return value;
}

/**
 * The part of a document that means anything.
 *
 * The timestamp differs on every call, so comparing it would make every run
 * look like a change worth writing.
 */
export function documentKey(document) {
  const { savedAt, ...rest } = document || {};
  return JSON.stringify(stable(rest));
}

/** The queue a saved document describes, and where it had got to. */
export function queueFromDocument(document = {}) {
  const tracks = (document.queue || [])
    .map((entry) => {
      const artist = String(entry?.artist || "");
      const album = String(entry?.album || "");
      return {
        id: String(entry?.trackId || ""),
        title: String(entry?.title || ""),
        artists: artist ? [artist] : [],
        albums: album ? [album] : [],
        album,
        durationMs: Math.round(Number(entry?.durationMs) || 0),
        artworkUrl: String(entry?.artworkUrl || ""),
      };
    })
    .filter((track) => track.id);
  const wanted = String(document.currentTrackId || "");
  const found = tracks.findIndex((track) => track.id === wanted);
  return {
    tracks,
    index: found >= 0 ? found : 0,
    positionMs: Math.max(0, Math.round(Number(document.positionMs) || 0)),
    paused: Boolean(document.paused),
    playlistId: String(document.playlistId || ""),
    currentTrackId: wanted,
  };
}

/** The document inside what the endpoint answers: {"state": ...}, or nothing. */
export function playbackStateFrom(payload) {
  const state = payload?.state;
  if (state && typeof state === "object" && !Array.isArray(state)) return state;
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
}

/** Whether this session may save: a guest has no account, a follower has a friend's queue. */
export function shouldSavePlayback({ token = "", following = null, queue = [] } = {}) {
  if (!token) return false;
  if (following) return false;
  return (queue?.length || 0) > 0;
}

class Player {
  constructor() {
    /** The one audio element, once the bar is on screen. */
    this.audio = null;
    /** Plain track objects, in play order. */
    this.queue = [];

    this._index = -1;
    this._volume = 1;
    this._muted = false;
    this._shuffle = false;

    this._listeners = new Map();
    this._room = null;
    this._following = null;

    // what we know about the current track's sources
    this._sources = { sources: [], preferredVariantId: "" };
    this._source = null;
    this._variant = "";

    // what we know about the tracks around it
    this._variants = new Map();   // track id -> {variantId, source, sources, preferredVariantId}
    this._resolving = new Map();  // track id -> promise of the above
    this._started = new Set();    // variant ids we asked the backend to fetch
    this._status = new Map();     // variant id -> media status
    this._warming = new Map();    // variant id -> the one warm running for it

    // Songs held in this page for offline play, by track id: {state, variantId,
    // url, bytes, at}. "pending" until the bytes are here, then "ready", or
    // "failed" with the error and the time it failed at so it can be tried
    // again later. The copy is also what plays: the element is handed a song's
    // own entry and nothing else (see `_awaitCopy`).
    this._offline = new Map();
    this._offlineOrder = [];      // track ids waiting for a fetch slot
    this._offlineWanted = [];     // the window's order now: what a free slot is for
    // Fetches under way, by track id: never re-queued, never cancelled, and the
    // thing a load that wants the same song waits on.
    this._offlineInFlight = new Map();
    this._offlineActive = 0;      // fetches in flight
    this._offlineBytes = 0;

    this._token = 0;              // which track the async work is still for
    this._loading = false;
    this._loadFor = "";           // the "track|variant" the load under way is for
    this._buffering = false;      // the file is here, the sound is not yet
    this._error = "";
    this._blocked = false;
    // null is "nothing to seek"; a number is where to put the file, and zero
    // counts. A fresh load always asks for a position — a file this element
    // already held can be sitting at its end, and playing it from there ends it
    // again at once.
    this._pendingSeek = null;
    // Whether this player means to be playing, which is not the same as whether
    // the element happens to be playing: a transition stops the element for a
    // moment so the old position is not read as the new song's, and the lock
    // screen must not be told the listener paused there.
    this._playingWanted = false;
    // Which song has already had its one retry, and which rendition failed, so
    // a failure cannot loop on the same source for ever.
    this._retriedFor = "";
    this._failedVariant = "";

    this._bar = null;
    this._seeking = false;
    this._seekingByHand = false;
    this._seekTimer = 0;
    this._rememberTimer = 0;
    this._wired = false;

    // where this queue came from, and what the account was last told
    this._contextPlaylistId = "";
    this._lastSaved = "";
    this._lastSaveAt = 0;
    this._saveTimer = 0;
    this._saving = null;
    this._restoring = false;
  }

  // --- what views call ---------------------------------------------------

  /** Replace the queue and start at `startIndex`. */
  play(tracks, startIndex = 0) {
    const list = (Array.isArray(tracks) ? tracks : [tracks]).filter(Boolean);
    if (this._room) {
      // A room decides what plays: asking for a track queues it there.
      if (list.length) this._room.onAdd?.(list);
      return;
    }
    if (!list.length) {
      this.clear();
      return;
    }
    this.queue = list;
    const start = Math.min(Math.max(0, Math.floor(Number(startIndex) || 0)), this.queue.length - 1);
    this._emit("queue-changed", this.queue);
    this.jumpTo(start);
  }

  /** Add tracks to the end of the queue, or right after the current one. */
  enqueue(tracks, { next = false } = {}) {
    const list = (Array.isArray(tracks) ? tracks : [tracks]).filter(Boolean);
    if (!list.length) return;
    if (this._room) {
      this._room.onAdd?.(list);
      return;
    }
    if (!this.queue.length) {
      this.play(list);
      return;
    }
    if (next) this.queue.splice(this._index + 1, 0, ...list);
    else this.queue.push(...list);
    this._emit("queue-changed", this.queue);
    this._prefetch();
  }

  playNext(tracks) {
    this.enqueue(tracks, { next: true });
  }

  current() {
    return this._index >= 0 && this._index < this.queue.length ? this.queue[this._index] : null;
  }

  index() {
    return this._index;
  }

  removeAt(index) {
    if (!(index >= 0 && index < this.queue.length)) return;
    this.queue.splice(index, 1);
    if (index < this._index) {
      this._index -= 1;
      this._emit("queue-changed", this.queue);
      this._prefetch();
      return;
    }
    if (index > this._index) {
      this._emit("queue-changed", this.queue);
      this._prefetch();
      return;
    }
    // The track that was playing is gone: what follows it, or nothing.
    this._index = Math.min(this._index, this.queue.length - 1);
    this._emit("queue-changed", this.queue);
    if (this._index < 0) {
      this._stopAudio();
      this._variant = "";
      this._source = null;
      this._loading = false;
      this._token += 1;
      this._emit("track-changed", null);
      this._stateEvent();
      return;
    }
    this.jumpTo(this._index);
    this._prefetch();
  }

  move(from, to) {
    if (!(from >= 0 && from < this.queue.length)) return;
    const target = Math.min(Math.max(0, Math.floor(Number(to) || 0)), this.queue.length - 1);
    if (from === target) return;
    const [track] = this.queue.splice(from, 1);
    this.queue.splice(target, 0, track);
    if (this._index === from) this._index = target;
    else if (from < this._index && target >= this._index) this._index -= 1;
    else if (from > this._index && target <= this._index) this._index += 1;
    this._emit("queue-changed", this.queue);
    this._prefetch();
  }

  clear() {
    this._token += 1;
    this.queue = [];
    this._index = -1;
    this._variant = "";
    this._source = null;
    this._sources = { sources: [], preferredVariantId: "" };
    this._loading = false;
    this._error = "";
    this._pendingSeek = null;
    this._stopAudio();
    this._releaseAllOffline();
    this._emit("queue-changed", this.queue);
    this._emit("track-changed", null);
    this._stateEvent();
  }

  jumpTo(index, options = {}) {
    const target = Math.floor(Number(index));
    if (!Number.isFinite(target) || target < 0 || target >= this.queue.length) return;
    this._load(target, options);
  }


  /** Play a particular rendition of a room track at the room's position.
   *  Each member picks its own source; the room assigns none. */
  playVariant(track, variantId, { positionMs = 0, autoplay = true } = {}) {
    if (!track?.id || !variantId) return Promise.resolve();
    let index = this.queue.findIndex((entry) => entry?.id === track.id);
    if (index < 0) {
      this.queue = [track];
      index = 0;
      this._emit("queue-changed", this.queue);
    }
    return this._load(index, { startMs: positionMs, autoplay, variantId: String(variantId) });
  }

  /** The variant the current track is playing from, once it is known. */
  variantId() {
    return this._variant;
  }

  /**
   * Play a song out of this page's memory, with the server out of the picture.
   *
   * This is how a queue carries on with nothing reachable: the copy is already
   * here, so there is nothing to resolve and nothing to wait for.
   */
  playOffline(track) {
    const trackId = String(track?.id || "");
    const entry = this._offline.get(trackId);
    if (!entry || entry.state !== "ready" || !entry.url) return false;
    this.queue = [{ ...track, id: trackId }];
    this._index = 0;
    this._shuffle = false;
    this._emit("queue-changed", this.queue);
    this._load(0, { autoplay: true });
    return true;
  }

  /**
   * Play a song from a URL this page already holds, with the server out of the
   * picture: the one a kept playlist was downloaded under, which the service
   * worker answers out of Cache Storage.
   *
   * Nothing is resolved, nothing is polled, nothing is downloaded and nothing is
   * fetched ahead: the bytes are here, so the wait that all of that exists for
   * has nothing left to wait for. The queue is this one song, as `playOffline`
   * makes it; a whole kept playlist is a `play()` of the tracks that
   * `offline.keptTracks` built, each of which carries the URL its own copy is
   * at, so the songs after the first are here too.
   */
  playLocal(track, url) {
    const trackId = String(track?.id || "");
    const source = String(url || track?.localUrl || "");
    if (!trackId || !source) return false;
    this.queue = [{ ...track, id: trackId, localUrl: source }];
    this._index = 0;
    this._shuffle = false;
    this._emit("queue-changed", this.queue);
    this._load(0, { autoplay: true });
    return true;
  }

  /** Where the current track's file is: "none", "pending", "ready" or "failed".
   *
   *  The same answer the queue's mark on that song's row is drawn from, since
   *  there is one download per song and this is it. */
  readyState() {
    return this.offlineState(this.current()?.id || "");
  }

  /** The host advances its ordinary mixed queue locally; followers ask the
   *  room to skip, or move through the order they last knew when it cannot be
   *  reached. */
  next() {
    if (this._room?.hostPlayback) {
      const target = this._index + 1;
      if (target >= 0 && target < this.queue.length) this.jumpTo(target);
      return;
    }
    if (this._room) {
      if (this.online()) return this._roomCommand("skip", "skip");
      this._room.offlineSkip?.();
      return;
    }
    const target = nextIndex(this.queue, this._index, this._shuffle);
    if (target >= 0) this.jumpTo(target);
  }

  /** In a room the queue behind the current song is not history, so previous
   *  means restart this song. */
  previous() {
    if (this._room) return this._roomCommand("seek", "seek", 0);
    if (this._index > 0) this.jumpTo(this._index - 1);
    else this.seek(0);
  }

  pause() {
    this._playingWanted = false;
    this._wantResume(false);
    this.audio?.pause();
  }

  resume() {
    if (!this.queue.length) return;
    if (!this.audio || !this.audio.src) {
      this.jumpTo(Math.max(this._index, 0));
      return;
    }
    this._playingWanted = true;
    this._wantResume(true);
    const playing = this.audio.play();
    if (playing?.catch) playing.catch(() => { /* the browser refused; the button stays honest */ });
  }

  toggle() {
    // In a room the room owns the transport - unless it cannot be reached, when
    // this device is all there is and the button has to keep working.
    if (this._room && this.online()) return this._roomCommand(this.isPaused() ? "resume" : "pause", "pause");
    if (this.isPaused()) this.resume();
    else this.pause();
  }

  /** A transport button while a room owns playback.
   *
   *  The room is the only thing that can change what it is doing - a local
   *  pause is put back by the follower a moment later, which is why this button
   *  used to look dead. So it asks the room instead, or, when the room's policy
   *  keeps that control for its host, says so rather than going silent. */
  _roomCommand(name, action, arg) {
    const room = this._room;
    if (!room) return;
    if (room.mayDrive && !room.mayDrive()) {
      room.onBlocked?.(action);
      return;
    }
    room[name]?.(arg);
  }

  /** Go to a position in the current track. Remembers it if the file is still loading.
   *
   *  Every source the element is given is a whole file, and a file is seeked
   *  within: `currentTime` is the whole of it. Before the file is here there is
   *  nothing to seek, so the position is held on `_pendingSeek` and applied when
   *  the file lands (see `_awaitCopy`). */
  seek(ms) {
    const target = Math.max(0, Math.round(Number(ms) || 0));
    const audio = this.audio;
    if (!audio || !audio.src) {
      this._pendingSeek = target;
      return;
    }
    if (!audio.duration) {
      this._pendingSeek = target;
      return;
    }
    try {
      audio.currentTime = Math.min(target / 1000, audio.duration);
    } catch {
      this._pendingSeek = target;
    }
    this._positionEvent();
    this._saveSoon();
  }

  positionMs() {
    const audio = this.audio;
    if (!audio || !Number.isFinite(audio.currentTime)) return 0;
    return Math.round(audio.currentTime * 1000);
  }

  /** The length of this local audio source, or 0 before metadata arrives.
   *  It can differ from the host's room duration. */
  measuredDurationMs() {
    const audio = this.audio;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) return Math.round(audio.duration * 1000);
    return 0;
  }

  /** The length this page was told, or zero where nobody has said: the status
   *  the backend reports the rendition with, and failing that the track's own. */
  _knownDurationMs() {
    const reported = Math.round(Number(this._status.get(this._variant)?.durationMs) || 0);
    if (reported > 0) return reported;
    return Math.round(Number(this.current()?.durationMs) || 0);
  }

  /**
   * How long the song is, from whatever this page knows.
   *
   * A whole file's own length is exact and arrives with its metadata, so it is
   * what the timeline and the seek arithmetic run on. Before the file is here
   * there is no measured length, and the length this page was told is what the
   * bar draws meanwhile - a bar with no length at all could not show where a
   * seek would land.
   */
  durationMs() {
    const measured = this.measuredDurationMs();
    if (measured > 0) return measured;
    return this._knownDurationMs();
  }

  setVolume(value) {
    this._volume = clamp01(Number(value) || 0);
    this._applyVolume();
  }

  volume() {
    return this._volume;
  }

  setMuted(muted) {
    this._muted = Boolean(muted);
    this._applyVolume();
  }

  /** Put the level on the element, and say so everywhere.
   *
   *  A volume and a mute are the same change as far as the page is concerned:
   *  one element to tell, one bar to repaint, one thing to remember. Both used
   *  to repeat those four steps. */
  _applyVolume() {
    if (this.audio) {
      this.audio.volume = this._volume;
      this.audio.muted = this._muted;
    }
    this._emit("volume-changed", this._volume);
    this.renderBar();
    this._remember();
  }

  muted() {
    return this._muted;
  }

  isPaused() {
    return !this.audio || this.audio.paused;
  }

  /** Whether the browser is holding playback until this page is touched. */
  isBlocked() {
    return Boolean(this._blocked);
  }

  /** Whether the file has run out.
   *
   *  An ended file reads as paused - the element stops itself - but it is not
   *  one that is waiting to be resumed: play() would start it again from the
   *  beginning. A room that is about to move on must not do that. */
  hasEnded() {
    return Boolean(this.audio && this.audio.ended);
  }

  isPlaying() {
    return Boolean(this.audio) && !this.audio.paused && !this.audio.ended;
  }

  /** Everything the bar shows, for anyone who would rather poll. */
  state() {
    return {
      track: this.current(),
      index: this._index,
      count: this.queue.length,
      playing: this.isPlaying(),
      paused: this.isPaused(),
      blocked: this.isBlocked(),
      loading: this._loading,
      buffering: this._buffering,
      error: this._error,
      positionMs: this.positionMs(),
      durationMs: this.durationMs(),
      volume: this._volume,
      muted: this._muted,
      shuffle: this._shuffle,
    };
  }

  /** Shuffle what is left of the queue, keeping the current track playing. */
  shuffleQueue() {
    if (this.queue.length < 2) return false;
    this.queue = shuffleWhole(this.queue, this._index);
    this._emit("queue-changed", this.queue);
    this._prefetch();
    return true;
  }

  /** Turn shuffle on (shuffling what is left) or off. */
  toggleShuffle() {
    this._shuffle = !this._shuffle;
    if (this._shuffle) this.shuffleQueue();
    this._stateEvent();
    return this._shuffle;
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event)?.delete(handler);
  }

  /** In a room, adding queues a track there. The host instead receives the
   *  mixed room queue as its ordinary player queue. */
  setRoom(room) {
    const next = room && room.roomId
      ? {
          roomId: room.roomId,
          name: room.name || "",
          onAdd: room.onAdd,
          mayDrive: room.mayDrive,
          onBlocked: room.onBlocked,
          pause: room.pause,
          resume: room.resume,
          skip: room.skip,
          seek: room.seek,
          hostPlayback: Boolean(room.hostPlayback),
          mayShuffle: room.mayShuffle,
          offlineSkip: room.offlineSkip,
        }
      : null;
    const changed = this._room?.roomId !== next?.roomId ||
      this._room?.hostPlayback !== next?.hostPlayback;
    this._room = next;
    if (changed) this.renderBar();
  }

  /** Replace the host's local queue projection without reloading the song in
   *  flight. Item ids distinguish two queued copies of one canonical track. */
  setRoomQueue(tracks, currentItemId = "", { positionMs = 0, autoplay = true } = {}) {
    if (!this._room?.hostPlayback) return;
    const list = (Array.isArray(tracks) ? tracks : []).filter(Boolean);
    if (!list.length) {
      if (this.queue.length) this.clear();
      return;
    }
    let index = currentItemId ? list.findIndex((entry) => entry?.roomItemId === currentItemId) : 0;
    if (index < 0) index = 0;
    const old = this.current();
    const target = list[index];
    const same = old?.roomItemId && old.roomItemId === target?.roomItemId;
    this.queue = list;
    this._index = index;
    this._shuffle = false;
    this._emit("queue-changed", this.queue);
    if (same) {
      this._prefetch();
      return;
    }
    this._load(index, { startMs: positionMs, autoplay });
  }

  clearRoom() {
    this._room = null;
    this.renderBar();
  }

  /** Whether a room owns playback right now: playing a track would queue it there. */
  inRoom() {
    return Boolean(this._room);
  }

  roomId() {
    return this._room?.roomId || "";
  }

  /** Listen along: the stop button appears between the volume and the queue. */
  setFollowingMode({ name, onStop } = {}) {
    this._following = { name: name || "", onStop };
    this.renderBar();
  }

  clearFollowingMode() {
    this._following = null;
    this.renderBar();
  }

  // --- what was playing, kept for the next run ---------------------------

  /** Where this queue came from, so a restart lands back on that playlist. */
  setContext({ playlistId = "" } = {}) {
    this._contextPlaylistId = String(playlistId || "");
  }

  context() {
    return { playlistId: this._contextPlaylistId };
  }

  /** The document as the account would keep it. */
  document() {
    return playbackDocument({
      queue: this.queue,
      track: this.current(),
      positionMs: this.positionMs(),
      paused: this.isPaused(),
      playlistId: this._contextPlaylistId,
    });
  }

  /**
   * Record where we are, unless it is exactly what is already stored.
   *
   * Throttled: this is called from the timeline's own ticks, and only a moved
   * position, a new track or a pause is worth writing.
   */
  savePlayback(client = null) {
    return this._save(false, client);
  }

  /** Save on the way out, when there is no later to do it in. */
  savePlaybackNow(client = null) {
    return this._save(true, client);
  }

  _save(force = false, client = null) {
    if (this._restoring) return false;   // what is being restored is already saved
    const target = client || this._clientIfAny();
    const allowed = shouldSavePlayback({
      token: target?.token || "",
      following: state.following || this._following,
      queue: this.queue,
    });
    if (!allowed) return false;
    const now = Date.now();
    if (!force && now - this._lastSaveAt < SAVE_PLAYBACK_MS) return false;
    const document = this.document();
    const key = documentKey(document);
    if (key === this._lastSaved) return false;
    this._lastSaved = key;
    this._lastSaveAt = now;
    this._write(target, document, key);
    return true;
  }

  /**
   * Send one document, after whatever is still on its way.
   *
   * Two saves must not overtake each other: the server keeps the last one it
   * receives, and an older queue arriving late would be the one a restart
   * picked up.
   */
  _write(target, document, key) {
    this._saving = (this._saving || Promise.resolve())
      .catch(() => {})
      .then(() => target.savePlaybackState(document))
      .catch(() => {
        // A state that did not reach the server is not worth interrupting
        // anyone for: the next change writes it again.
        if (this._lastSaved === key) this._lastSaved = "";
      });
  }

  /** A seek is worth saving once it has settled, not while the handle moves. */
  _saveSoon() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(true), SAVE_SETTLE_MS);
  }

  /**
   * Pick up where the last run left off.
   *
   * The queue comes back in order, at the position it had, and paused: a page
   * does not start playing by itself, exactly as the GTK client leaves a
   * restored session. Resolves with what was restored, or null when there was
   * nothing to pick up; the shell can say so on "playback-restored".
   */
  async restorePlayback(client = null) {
    const target = client || this._clientIfAny();
    if (!target || !target.token) return null;   // a guest has no account to pick up from
    let saved = null;
    try {
      saved = playbackStateFrom(await target.playbackState());
    } catch {
      return null;
    }
    const restored = queueFromDocument(saved);
    if (!restored.tracks.length) return null;

    this._restoring = true;
    try {
      this._contextPlaylistId = restored.playlistId || "";
      // What the server just gave us must not be written straight back.
      this._lastSaved = documentKey(saved);
      this._lastSaveAt = Date.now();
      this.queue = restored.tracks;
      this._index = restored.index;
      this._emit("queue-changed", this.queue);
      await this._load(restored.index, { startMs: restored.positionMs, autoplay: false });
    } finally {
      this._restoring = false;
    }

    const result = {
      restored: true,
      index: restored.index,
      positionMs: restored.positionMs,
      paused: true,
      playlistId: restored.playlistId,
    };
    this._emit("playback-restored", result);
    return result;
  }

  // --- the bar -----------------------------------------------------------

  mount(container) {
    if (!container) return;
    if (!this._bar) this._buildBar();
    if (this._bar.root.parentNode !== container) mount(container, this._bar.root);
    this.ensureAudio();
    this._wire();
    this._restore();
    this.renderBar();
  }

  renderBar() {
    const bar = this._bar;
    if (!bar) return;
    const track = this.current();
    const client = this._clientIfAny();

    // --- the track -------------------------------------------------------
    // Three lines, and each says one thing: the title, then who it is by (with
    // the source beside the name), then - only when there is something to say -
    // what is happening to it. The wait used to be appended to the artist's own
    // line, which read as part of the artist.
    if (track) {
      setText(bar.title, track.title || "unknown track");
      setText(bar.subtitle, artistLine(track) || String(track.album || ""));
      // The bar mirrors the queue's mark on this song's row: the same fraction
      // of the same one download, drawn where the song being waited on is named.
      // Nothing countable sweeps rather than pretending; a copy that is here has
      // nothing left to say.
      const trackId = String(track.id || "");
      const pending = trackId ? this.offlineState(trackId) === "pending" : false;
      const share = pending ? this.offlineProgress(trackId) : null;
      bar.load.style.display = pending ? "" : "none";
      bar.load.classList.toggle("sweep", pending && share === null);
      bar.loadFill.style.width = pending && share !== null ? `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%` : "";
      // The error is the one thing here said in words.
      setText(bar.status, this._error);
      bar.status.style.display = this._error ? "" : "none";
      bar.status.style.color = this._error ? "var(--red)" : "";

      const art = track.artworkUrl && client ? client.artworkUrl(track.artworkUrl) : "";
      const currentArt = bar.cover.getAttribute("src") || "";
      if (currentArt !== art) {
        if (art) bar.cover.src = art;
        else bar.cover.removeAttribute("src");
      }
      this._syncMediaMetadata(track);
    } else {
      setText(bar.title, "Nothing playing");
      setText(bar.subtitle, "");
      bar.load.style.display = "none";
      setText(bar.status, this._error);
      bar.status.style.display = this._error ? "" : "none";
      bar.status.style.color = this._error ? "var(--red)" : "";
      if (bar.cover.getAttribute("src")) bar.cover.removeAttribute("src");
      this._syncMediaMetadata(null);
    }

    // --- the source in use ----------------------------------------------
    bar.pill.disabled = !track;
    // With nothing playing there is no source to choose: an empty pill beside
    // an empty title is a button that does nothing, so it goes away.
    bar.pill.style.display = track ? "" : "none";
    setText(bar.pill, track ? sourceLabel(this._source || pickSource(this._sources.sources, this._sources.preferredVariantId)) : "");

    // --- lyrics ----------------------------------------------------------
    bar.words.style.display = track ? "" : "none";

    // --- the star --------------------------------------------------------
    bar.star.style.display = track ? "" : "none";
    if (track) {
      const starred = Boolean(state.favorites?.has(track.id));
      setIcon(bar.star, "star");
      // An icon-only button says what it is to a reader as well as to a
      // pointer: the star had a tooltip and no name, unlike the rest of the bar.
      setLabel(bar.star, starred ? "Unfavourite" : "Favourite");
      bar.star.setAttribute("aria-pressed", starred ? "true" : "false");
      // The only state the star has no second icon for: a favourite is filled
      // in the app's own accent colour, an ordinary one stays quiet.
      bar.star.style.color = starred ? "var(--orange)" : "";
    }

    // --- transport -------------------------------------------------------
    // A load in flight is not a song playing: until the file for this track is
    // here the element still holds the last one, and reading the transport off
    // it would show a pause button and a running position over a song nobody
    // can hear. The bar says "loading" and offers play, which is what a press
    // there would do once the file lands.
    const loading = this._loading && !this._error;
    const paused = this.isPaused() || loading;
    const playing = !loading && this.isPlaying() && !paused;
    setIcon(bar.play, paused ? "play" : "pause");
    setLabel(bar.play, loading ? "Loading" : paused ? "Play" : "Pause");
    // Which state the button is showing, for the theme to colour: no colour
    // is chosen here.
    bar.play.dataset.state = playing ? "playing" : "paused";
    // Waiting on the sound is its own state: the button still offers pause, and
    // the theme holds it back a little so the wait is visible.
    bar.play.dataset.busy = loading || this._buffering ? "true" : "false";
    // The bar itself carries it too: the played part of the seek takes the
    // same colour as the transport.
    bar.root.dataset.state = playing ? "playing" : "paused";
    // A room owns the transport while we are in one, and the local queue holds
    // nothing then - so the skip is always available there, whatever this
    // player happens to have loaded. There is no room equivalent of "previous",
    // so that one stays off.
    const inRoom = Boolean(this._room);
    bar.previous.disabled = inRoom || this._index <= 0;
    bar.next.disabled = inRoom ? false : !(this._index >= 0 && this._index < this.queue.length - 1);
    // In a room the shuffle asks the queue view to shuffle the caller's own
    // room queue, so whether it may comes from there: one song cannot be
    // shuffled, and a disabled button that says so beats a click that does
    // nothing and tells nobody.
    const mayShuffle = inRoom
      ? Boolean(this._room.mayShuffle?.())
      : this.queue.length - (this._index + 1) >= 2;
    bar.shuffle.disabled = !mayShuffle;
    bar.shuffle.title = inRoom
      ? (mayShuffle ? "Shuffle your own queue" : "Queue another song to shuffle yours")
      : "Shuffle what is left of the queue";
    bar.shuffle.setAttribute("aria-pressed", inRoom ? "false" : this._shuffle ? "true" : "false");

    // --- position --------------------------------------------------------
    const duration = this.durationMs();
    const position = this.positionMs();
    bar.position.disabled = duration <= 0;
    if (!this._seeking && duration > 0) {
      bar.position.value = String(Math.min(1000, (position / duration) * 1000));
      // Chromium has no ::-moz-range-progress, so the played part is painted by
      // a gradient on the element itself, exactly as the volume's fill is. The
      // Firefox pseudo-element still wins there, where it exists.
      bar.position.style.setProperty("--fill", `${Math.round(clamp01(position / duration) * 100)}%`);
    }

    // --- volume ----------------------------------------------------------
    if (Math.abs(Number(bar.volume.value) - this._volume) > 0.001) bar.volume.value = String(this._volume);
    // How far the filled part of the track reaches, for the theme to paint:
    // the colour is the theme's, this is only where it stops.
    bar.volume.style.setProperty("--fill", `${Math.round(clamp01(this._volume) * 100)}%`);
    setIcon(bar.mute, this._muted ? "mute" : "speaker");
    setLabel(bar.mute, this._muted ? "Unmute" : "Mute");
    bar.mute.setAttribute("aria-pressed", this._muted ? "true" : "false");

    // --- the room, and who we are following -----------------------------
    bar.room.style.display = this._room ? "" : "none";
    if (this._room && bar.room.dataset.room !== this._room.roomId) {
      bar.room.dataset.room = this._room.roomId;
      mount(bar.room, icon("room", 14), h("span", { text: this._room.name || "room" }));
    }
    if (this._room) bar.room.title = "Open the room";
    bar.listen.style.display = this._following ? "" : "none";
    if (this._following) {
      setLabel(bar.listen, `Listening along with ${this._following.name || "a friend"} — click to stop`);
    }
  }

  // --- the audio element -------------------------------------------------

  ensureAudio() {
    if (this.audio) return this.audio;
    const audio = new Audio();
    audio.preload = "auto";
    // Assigned before it is wired: the handlers ask whether the element they
    // came from is still the one in hand.
    this.audio = audio;
    // In the document, and named, rather than detached and anonymous: this
    // element is the answer to "what is playing", and an element nobody can
    // find is an element nobody can look at - not the devtools, and not the
    // browser suite that measures a song starting. Hidden, because the bar is
    // how a person drives it.
    audio.dataset.e2e = "audio";
    audio.style.display = "none";
    if (typeof document !== "undefined" && document.body?.appendChild) {
      document.body.appendChild(audio);
    }
    // A media session is what keeps a phone playing with the screen off: it
    // tells the browser this page is a player, which is also what stops a
    // backgrounded tab being frozen and its audio cut off a few songs in.
    this._installMediaSession();
    audio.addEventListener("playing", () => {
      if (audio !== this.audio) return;
      this._blocked = false;
      this._blockedError = "";
      this._wantResume(false);
    });
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        this._retryWanted();
      });
      // A page that has not been touched cannot start audio. Rather than make
      // somebody find the play button, the first touch anywhere tries again.
      const wake = () => this._retryWanted();
      document.addEventListener("pointerdown", wake, true);
      document.addEventListener("keydown", wake, true);
      // A window that is merely behind another is still "visible", so nothing
      // above fires when somebody comes back to it: focus is the only signal,
      // and it is also the gesture the browser wants.
      if (typeof window !== "undefined") window.addEventListener("focus", wake);
    }
    this._wireAudio(audio);
    return audio;
  }

  // --- playing a track ---------------------------------------------------

  async _load(index, { startMs = 0, autoplay = true, variantId = "" } = {}) {
    const audio = this.ensureAudio();
    const track = index >= 0 && index < this.queue.length ? this.queue[index] : null;
    const target = track && variantId ? `${track.id}|${variantId}` : "";
    // A room asks for a song again from every tick of its own state, and it
    // asks while the last request is still fetching: that second load must not
    // stop the element and clear its src, or the file that is on its way is
    // thrown away as fast as it arrives and never reaches canplay. The same
    // rendition, at the same place in the queue, already under way is the same
    // load, and the position is taken again because the room's clock has moved
    // under it.
    if (target && this._loading && this._index === index && target === this._loadFor) {
      this._pendingSeek = Math.max(0, Math.round(Number(startMs) || 0));
      return;
    }
    // The same rendition already on the element is not loaded again either:
    // what a repeated ask means there is where the song should be, not a fresh
    // fetch and a restart from the top.
    if (target && !this._loading && this._index === index && this._variant === variantId && audio.src) {
      this.seek(Math.max(0, Math.round(Number(startMs) || 0)));
      if (autoplay) this.resume();
      return;
    }
    const token = ++this._token;
    // Whatever was playing has just stopped being played: that is the moment a
    // listen is over and worth reporting. A track skipped straight away is the
    // server's to ignore, not the client's to judge. Switching to another file
    // of the same song is not a new listen, so the one that follows is named.
    this._reportListen(track?.id || "");
    this._index = track ? index : -1;
    this._error = "";
    this._loading = Boolean(track);
    this._loadFor = target;
    this._variant = "";
    this._source = null;
    this._sources = { sources: [], preferredVariantId: "" };
    this._pendingSeek = Math.max(0, Math.round(Number(startMs) || 0));

    if (!track) {
      this._stopAudio();
      this._emit("track-changed", null);
      this._stateEvent();
      return;
    }

    // Nothing asks the element to play while the file is on its way, and the bar
    // says paused until it is there. A play that arrives in this window used to
    // start whatever the element still held (see below); a retry that wanted one
    // is stopped here for the same reason, and the wait hands autoplay to the
    // play itself, so the click survives without being held as a live request.
    this._playingWanted = false;
    this._wantResume(false);
    this.renderBar();
    if (audio.src) {
      // The old track is unloaded, not merely paused and rewound: while the next
      // file is fetched, a play that comes from anywhere else - the retry of a
      // refused play, a wake-up after a phone woke up - would start the song
      // that was playing before, under a bar naming another one. An element
      // with no source has nothing to start.
      audio.pause();
      audio.removeAttribute("src");
      try {
        audio.load();
      } catch {
        /* nothing to unload yet */
      }
    }
    this._emit("track-changed", track);
    // The bar says "downloading" from the moment the track is chosen.
    this._stateEvent();

    // A song this page holds is played from memory. Offline there is nothing to
    // resolve and nothing to ask the backend about, and online the bytes are
    // already here, so either way the copy is what plays.
    const kept = this._offline.get(String(track.id || ""));
    const fromMemory = Boolean(kept && kept.state === "ready" && kept.url && (!variantId || kept.variantId === variantId));
    // A song can also say where its own bytes are: a kept playlist is handed to
    // the player as tracks that carry the URL the download wrote, which sw.js
    // answers out of Cache Storage. That is the case this branch exists for -
    // the server is gone, so there is nothing to resolve and nothing to fetch,
    // and asking it anything would be a request whose only possible answer is
    // "no". A room that named a rendition keeps that rendition: a copy is only
    // this song's when it is the file that was asked for.
    const asked = String(variantId || "");
    const carries = String(track.localUrl || "");
    const local = carries && (!asked || String(track.variantId || "") === asked) ? carries : "";
    const localUrl = fromMemory ? kept.url : local;

    let resolved;
    try {
      if (localUrl) {
        // The bytes are local, but the song still came from somewhere and the
        // bar names it: a copy this page holds is *not* a song without a
        // platform.  The resolution that fetched the copy is what this page
        // knows about the track (see `_variantFor`), so the source comes from
        // there rather than being dropped.
        const known = this._variants.get(String(track.id || ""));
        const playedAs = fromMemory ? kept.variantId : String(track.variantId || "");
        resolved = {
          sources: Array.isArray(known?.sources) ? known.sources : [],
          preferredVariantId: known?.preferredVariantId || "",
          variantId: playedAs,
          source: memorySource(known, playedAs),
        };
      } else {
        resolved = variantId
          ? await this._resolveFixed(track, variantId)
          : await this._variantFor(track);
      }
    } catch (error) {
      if (token !== this._token) return;
      this._loading = false;
      this._error = error?.message || "could not fetch that track";
      this._stateEvent();
      // Offline, a song that cannot be resolved is a song this page does not
      // have: the queue carries on with one it does.
      if (!this.online()) {
        this._skipUnavailable();
        return;
      }
      this._report(error);
      // Online, the song gets one more attempt - on another source of it when
      // it has one, because what failed is usually one provider's file and not
      // the song - and then the queue carries on past it. Stopping here is
      // silence and a red line under a track nobody can hear.
      this._failedVariant = String(this._variant || variantId || "");
      this._recoverFromFailure();
      return;
    }
    if (token !== this._token) return;   // the track changed while we looked

    this._sources = { sources: resolved.sources, preferredVariantId: resolved.preferredVariantId };
    this._source = resolved.source || pickSource(resolved.sources, resolved.preferredVariantId);
    this._variant = resolved.variantId;
    this.renderBar();

    if (localUrl) {
      // The copy is already here: nothing to fetch and nothing to wait for.
      audio.src = localUrl;
    } else {
      // The song is downloaded first and played from that: the server holds
      // only files, and a rendition it does not hold is refused rather than
      // streamed, so there is nothing to play until the download lands. Primary:
      // this is the song the bar is naming and a person is waiting for, so the
      // backend gives it the whole pipe - the prefetch's downloads for other
      // songs are cancelled for it, and it starts as fast as the provider can
      // go. The songs after this one are asked for below, which is why they are
      // not primary: they are for later.
      // The songs after this one are asked for now, while this one downloads:
      // the page holds them by the time they are reached, and outside a room
      // it keeps its own copies of the window ahead as it always did. This is
      // the line the early return below used to skip.
      this._prefetch();
      // The wait for the file is the whole of the play now: the element is
      // handed nothing until the queue's own download of it is in memory, and
      // then it is handed that copy at the position this load asked for.
      this._awaitCopy({
        variantId: resolved.variantId,
        token,
        autoplay: Boolean(autoplay),
      });
      return;
    }
    this._loading = false;
    if (!autoplay) {
      // The file is here and the bar shows where it is; the moment is someone
      // else's to choose. The old song was stopped to fetch this one, so this
      // is a stopped player, and the lock screen should say so.
      this._playingWanted = false;
      this._stateEvent();
      this.renderBar();
      return;
    }
    this._stateEvent();
    this._prefetch();
    this.renderBar();
    this._wantResume(true);
    // A track that starts part-way in (a room's song, a restored session) has
    // to wait for the seek the same way a copy taking over does, or the first
    // moment heard is the file's beginning.
    this._startAudio(this._pendingSeek);
    // The button becomes a pause button the moment play() is called, and the
    // sound can still be a moment behind it.
    this._setBuffering(audio.readyState < 3);
  }

  /**
   * A song that would not fetch or would not play: one more attempt, then the
   * queue moves on.
   *
   * The attempt is made on another source of the same song when it has one -
   * what usually fails is one provider's file, not the song - and after that
   * the next song in the queue is played. Stopping here is silence and a red
   * line under a track nobody can hear; a skipped song is named in the banner
   * and left behind.
   */
  _recoverFromFailure() {
    const track = this.current();
    const id = String(track?.id || "");
    if (!id) return false;
    if (this._retriedFor !== id) {
      this._retriedFor = id;
      this._retryOnAnotherSource(track, id);
      return true;
    }
    return this._skipFailed();
  }

  /**
   * The one retry: the same song, from a source other than the one that failed.
   *
   * The song's sources are asked for here rather than read off the screen - a
   * load clears them, and a failure is exactly when the list is worth having -
   * so a song found by a search has its other platforms tried before it is
   * given up on. Nothing else to play means the queue moves on instead.
   */
  async _retryOnAnotherSource(track, id) {
    const failed = String(this._failedVariant || "");
    if (!failed) {
      // The resolution itself failed, so no file can be blamed and no other
      // source is meaningfully "other": ask again, a moment later, as before.
      await sleep(FETCH_RETRY_PAUSE_MS);
      if (String(this.current()?.id || "") !== id) return;
      this._load(this._index, { startMs: this.positionMs(), autoplay: true });
      return;
    }
    let sources = Array.isArray(this._sources.sources) ? this._sources.sources : [];
    if (!sources.length) {
      try {
        const payload = await this._client().sources(id);
        sources = Array.isArray(payload?.sources) ? payload.sources : [];
      } catch {
        sources = [];
      }
    }
    // The song may have been left behind while the list was being fetched.
    if (String(this.current()?.id || "") !== id) return;
    const next = sources.find(
      (source) =>
        source.downloadable !== false &&
        String(source.variantId || "") &&
        String(source.variantId) !== failed
    );
    if (!next) {
      this._skipFailed();
      return;
    }
    this._load(this._index, {
      startMs: this.positionMs(),
      autoplay: true,
      variantId: String(next.variantId),
    });
  }

  /** The next song in the queue, after one that will not play. */
  _skipFailed() {
    for (let index = this._index + 1; index < this.queue.length; index += 1) {
      this._error = "";
      this.jumpTo(index, { autoplay: true });
      return true;
    }
    return false;
  }

  /**
   * Offline, a song this page does not hold is one it cannot play. Rather than
   * stopping the queue on it, the next song it does hold is played: sitting in
   * silence on one missing file is no way to spend a road.
   */
  _skipUnavailable() {
    for (let index = this._index + 1; index < this.queue.length; index += 1) {
      const entry = this._offline.get(String(this.queue[index]?.id || ""));
      // A song whose list came out of the cache it was downloaded into is here
      // just as much as one held in memory: a kept playlist carries on from the
      // next song it holds rather than stopping on one the browser let go.
      const held = (entry?.state === "ready" && entry.url) || this.queue[index]?.localUrl;
      if (held) {
        this._error = "";
        this.jumpTo(index, { autoplay: true });
        return true;
      }
    }
    this._error = "";
    this._stateEvent();
    return false;
  }

  /** A variant a room assigned: the sources are only there to name it. */
  _resolveFixed(track, variantId) {
    // The room named the rendition, so there is nothing to choose and nothing
    // to wait for: the sources are there to name it in the bar, and asking for
    // them first is a provider search between a listener and the song the room
    // is already playing. They are fetched behind the file and the bar catches
    // up when they land.
    const id = String(track.id || "");
    const known = this._variants.get(id);
    const name = (sources) => {
      const found = (Array.isArray(sources) ? sources : []).find(
        (source) => source.variantId === variantId
      );
      return found || memorySource(known, variantId) || null;
    };
    this._client()
      .sources(track.id)
      .then(({ sources, preferredVariantId }) => {
        this._variants.set(id, { sources, preferredVariantId, variantId, source: name(sources) });
        this._boundCache(this._variants);
        // Only while this is still the song being played: a late answer must
        // not repaint the bar for whatever came after it.
        if (String(this.current()?.id || "") !== id) return;
        this._sources = { sources, preferredVariantId };
        this._source = name(sources);
        this.renderBar();
      })
      .catch(() => {
        /* the pill keeps what this page already knew about the track */
      });
    return {
      sources: Array.isArray(known?.sources) ? known.sources : [],
      preferredVariantId: known?.preferredVariantId || "",
      variantId,
      source: name(known?.sources),
    };
  }

  /** Where the track's file comes from, and every source it could come from. */
  _variantFor(track) {
    const cached = this._variants.get(track.id);
    if (cached) return Promise.resolve(cached);
    let pending = this._resolving.get(track.id);
    if (!pending) {
      pending = this._resolve(track);
      this._resolving.set(track.id, pending);
      pending.then(
        (resolved) => {
          if (resolved) {
            this._variants.set(track.id, resolved);
            this._boundCache(this._variants);
          }
        },
        () => {}
      ).finally(() => {
        if (this._resolving.get(track.id) === pending) this._resolving.delete(track.id);
      });
    }
    return pending;
  }

  /** Keep a resolved track or a media status from being remembered for ever.
   *
   *  Both maps are only ever cleared when the server changes, so a session that
   *  plays through a long queue grows one entry per track it has touched. The
   *  oldest goes first, and an entry that is dropped costs a resolution when it
   *  is next asked for - a shortcut lost, which is nothing beside the memory it
   *  held on to.
   */
  _boundCache(store, limit = CACHE_ENTRIES) {
    while (store.size > limit) store.delete(store.keys().next().value);
  }

  async _resolve(track) {
    const client = this._client();
    const { sources, preferredVariantId } = await client.sources(track.id);
    const preferred = pickSource(sources, preferredVariantId);
    const pool = sources
      .map((source) => ({ ...source, id: source.variantId }))
      .filter((source) => source.downloadable);
    let chosen = await client.pickVariant(pool, preferredVariantId);
    if (!chosen) {
      // Nothing known about this song can be downloaded: ask the providers.
      const variants = (await client.resolve(track.id)).filter((variant) => variant.downloadable !== false);
      chosen = await client.pickVariant(variants);
      if (!chosen) throw new ServerError(409, "no source of this song can be played");
      return { sources, preferredVariantId, variantId: chosen.id, source: preferred };
    }
    return {
      sources,
      preferredVariantId,
      variantId: chosen.variantId,
      source: sources.find((source) => source.variantId === chosen.variantId) || preferred,
    };
  }

  /**
   * The song's own download, waited on, then handed to the element.
   *
   * There is one download per song, and this is the one a listener waits for:
   * the entry in the queue's own pipeline, at play priority, for the rendition
   * this load chose. Playback begins when those bytes are in memory and the
   * element is given the copy itself - so a song is never fetched twice, with
   * the element streaming one file while the page downloads another, and the
   * row that shows a download is the row that is playing. The position the load
   * asked for is left pending on the element and applied with the metadata; a
   * whole file is seeked within, so that is a seek and not a `?start=` the
   * server ignores.
   *
   * A download that fails is a song that cannot be played: the load takes the
   * road it would for a file that will not play - one more attempt from another
   * source of the song, then the queue carries on.
   */
  async _awaitCopy(attempt) {
    const trackId = String(this.current()?.id || "");
    if (!trackId) return;
    // The entry first, so the queue's row for this song says "downloading" from
    // the moment the song is chosen, and the backend is told right after that
    // somebody is waiting on this rendition rather than fetching it ahead.
    const entry = this._claimOffline(trackId, attempt.variantId);
    this._startDownload(attempt.variantId, null, true);
    if (entry.state === "ready") {
      this._loading = false;
      this._handCopyToElement(entry, attempt);
      return;
    }
    const running = this._startOffline(trackId);
    // A download that stops moving is a song nobody can play: the wait is
    // bounded, and what it was waiting for is said below.
    const timeout = deadline(READY_TIMEOUT_MS);
    try {
      await Promise.race([running || Promise.resolve(null), timeout.promise]);
    } finally {
      timeout.cancel();
    }
    if (attempt.token !== this._token) return;
    const settled = this._offline.get(trackId);
    this._loading = false;
    // The song that was being waited on is here: the songs behind it start now.
    // They were held for the whole of that wait, which is what keeps one pipe
    // for the song somebody is listening for.
    this._prefetch();
    if (!settled || settled.state !== "ready" || !settled.url) {
      this._error = settled?.error || "that file did not arrive";
      this._stateEvent();
      if (!this.online()) {
        this._skipUnavailable();
        return;
      }
      // The file could not be fetched: one more attempt from another source of
      // the same song, then the queue carries on.
      this._failedVariant = String(attempt.variantId || "");
      this._recoverFromFailure();
      return;
    }
    this._handCopyToElement(settled, attempt);
  }

  /** The copy is here: the element is given it, and started where the load asked. */
  _handCopyToElement(entry, attempt) {
    const audio = this.audio;
    if (!audio) return;
    // The element may already hold this very copy: a restore that ran twice, a
    // load asking for the song that is already on. Assigning the same source
    // again starts the element over from zero and takes the position this load
    // asked for with it, so what is there is kept and the position is applied to
    // it instead.
    if (audio.src !== entry.url) {
      this._stateEvent();
      this.renderBar();
      audio.src = entry.url;
    } else if (this._pendingSeek !== null) {
      const at = this._pendingSeek;
      this._pendingSeek = null;
      this.seek(at);
    }
    if (!attempt.autoplay) {
      // The bar shows a stopped player for a song nobody has started yet; the
      // position stays pending and lands with the metadata.
      this._stateEvent();
      return;
    }
    this._wantResume(true);
    // The position the song was asked to start at, applied before any sound -
    // the file is whole here, and a seek into it is free.
    this._startAudio(this._pendingSeek);
    this._setBuffering(audio.readyState < 3);
  }

  /**
   * This load's entry in the queue's own download pipeline, claimed.
   *
   * A copy that is here, or on its way, of the rendition this load is for is
   * the load's own download and is used as it stands. Anything else - nothing,
   * another rendition of the same song, a failure past its retry - is replaced
   * by this load's own entry, and whatever was fetching the old one is let go:
   * two renditions of one song racing into one map is how the wrong file comes
   * back from what looked like a cache hit.
   */
  _claimOffline(trackId, variantId = "") {
    const id = String(trackId || "");
    const wanted = String(variantId || "");
    const known = this._offline.get(id);
    const sameFile = Boolean(known) && (!wanted || !known.variantId || known.variantId === wanted);
    if (sameFile && (known.state === "ready" || known.state === "pending")) {
      if (wanted && !known.variantId) known.variantId = wanted;
      return known;
    }
    this._abortOffline(id);
    if (known?.url && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(known.url);
    if (known) this._offlineBytes -= Number(known.bytes) || 0;
    const entry = { state: "pending", variantId: wanted, url: "", bytes: 0, at: Date.now() };
    this._offline.set(id, entry);
    return entry;
  }

  /** Ask the backend for a file, once - twice if this is the song being waited
   *  on, since a fetch that is already running ahead of time has to be told that
   *  it is now the one holding up a person. */
  _startDownload(variantId, client = null, primary = false) {
    if (!variantId) return;
    if (this._started.has(variantId) && !primary) return;
    if (this._status.get(variantId)?.state === "ready") return;
    this._started.add(variantId);
    this._boundCache(this._started);
    Promise.resolve()
      .then(() => (client || this._client()).startDownload(variantId, false, primary))
      .then((status) => {
        if (!status || typeof status !== "object") return;
        // The answer to "start downloading" is never that the file is ready:
        // it must not undo what a status check already found out.
        if (this._status.get(variantId)?.state === "ready") return;
        this._status.set(variantId, status);
        this._boundCache(this._status);
      })
      .catch((error) => {
        this._started.delete(variantId);
        // A fetch that failed ahead of time is not worth interrupting anyone
        // for: the track will say so when it is reached.
        if (variantId === this._variant) this._report(error);
      });
  }

  /** Keep the preload window's songs fetched, in queue order.
   *
   *  No separate warm-ahead on top of it: a copy fetches the file the player
   *  would play as part of making the copy, so asking the backend for the same
   *  songs beside it was the same download twice over - and several at once,
   *  which is what "no multi-download" is about. */
  _prefetch() {
    // In a room the order offline play follows is the room's, and rooms-state
    // keeps it: this queue holds one song there, and would evict the room's.
    //
    // The song on the element is in the window with the rest: its copy is what
    // plays, so the row that says it is downloading is the row that is playing,
    // and the count of what this device holds is a count of the queue.
    if (!this._room) {
      this.keepOffline(this.offlineWindow().filter((track) => !track?.localUrl));
    }
  }

  // --- songs kept in memory for offline play -------------------------------

  /** Whether the server still looks reachable to this page. */
  online() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
    return state.online !== false;
  }

  /** The songs ahead of the playhead, in order: what this device preloads.
   *
   *  The count is the device setting - songs *after* the one playing - and the
   *  window always starts with the song on, which is the one the play path needs
   *  first. */
  offlineWindow() {
    return prefetchWindow(this.queue, this._index, preloadAhead()).filter((track) => track?.id);
  }

  /** What this page holds for one track: none, pending, ready or failed. */
  offlineState(trackId) {
    return this._offline.get(String(trackId || ""))?.state || "none";
  }

  /** Whether that song's copy is the transfer the page is leading with.
   *
   *  One mark at a time, which is Kyle's rule: the song nearest the playhead that
   *  is being fetched is the one whose arrow fills. The window behind it is chased
   *  two at a time, so a second transfer runs quietly beside it - it is a copy for
   *  later, and an arrow filling for it says nothing about the song anybody is
   *  waiting on. A row that is pending but not this one is grey. */
  downloading(trackId) {
    const id = String(trackId || "");
    if (!this._offlineInFlight.has(id)) return false;
    const leading = (this._offlineWanted || []).find((each) => this._offlineInFlight.has(each));
    return !leading || leading === id;
  }

  /**
   * How far that copy is, as the queue's own mark draws it: a fraction 0-1, or
   * null when nothing countable is known yet (the mark sweeps instead).
   *
   * The song being played is a copy like any other - that is the whole point of
   * it - so this answers for the track a listener is waiting on as well as for
   * the ones behind it, and the queue's rows are the one place a download of
   * this page is shown. Two counts can be under way for one song: the backend's
   * own stage (the provider's bytes, then the conversion, then the store) and
   * this page's transfer of the file it produced. The transfer is the one the
   * listener is being held up by, so it is the one that wins where it counts.
   */
  offlineProgress(trackId) {
    const entry = this._offline.get(String(trackId || ""));
    if (!entry) return null;
    if (entry.state === "ready") return 1;
    if (entry.state !== "pending") return null;
    const total = Number(entry.transferTotal) || 0;
    if (total > 0) return clamp01(Number(entry.transfer) / total);
    const stage = Number(entry.stageProgress);
    return Number.isFinite(stage) && stage >= 0 ? clamp01(stage) : null;
  }

  /** What the window adds up to, for the queue's own indicator. */
  offlineSummary() {
    let ready = 0;
    let pending = 0;
    let held = 0;
    for (const entry of this._offline.values()) {
      if (entry.state === "ready") ready += 1;
      else if (entry.state === "pending") pending += 1;
      held += 1;
    }
    return { ready, pending, held, bytes: this._offlineBytes, online: this.online() };
  }

  /**
   * Keep this list's songs in memory, dropping anything that left it.
   *
   * Public because a room's order is not this player's queue: a follower holds
   * one song at a time, and the order it would go through offline is the room's.
   */
  keepOffline(tracks = []) {
    // The window, or this call's list if it is shorter: a room hands over its
    // whole remaining order, and only the songs in the preload window are wanted.
    const wanted = (Array.isArray(tracks) ? tracks : [])
      .filter((track) => track?.id)
      .slice(0, preloadAhead() + 1);
    // The window is a priority, not a list that only grows. The songs the room
    // is about to reach are the ones that have to be here, so the order the
    // fetches take is re-derived from this call every time: a song that was
    // queued when it was nearer and has since moved further out gives its turn
    // to the ones now in front of it, and one that has left the window gives it
    // up altogether instead of being fetched ahead of a song that is due next.
    // A fetch already under way is never disturbed - it keeps its slot until the
    // bytes are here - and is not queued a second time either.
    this._offlineWanted = wanted.map((track) => String(track.id));
    const ids = new Set(this._offlineWanted);
    for (const track of wanted) this._queueOffline(track);
    for (const queued of [...this._offlineOrder]) {
      if (!ids.has(queued)) this._releaseOffline(queued);
    }
    // A fetch under way is given up only when its song has left the window
    // altogether. Letting go of one that merely fell down the order was a fetch
    // that never finished: the front of the window moves on every room load, so
    // the same song was cancelled and restarted over and over, and the pipe it
    // was meant to conserve was spent on the restarts instead of the songs.
    // One that is still in the window keeps its slot, and the songs now due
    // take the slots as they free up.
    for (const trackId of [...this._offlineInFlight.keys()]) {
      if (!ids.has(trackId)) this._abortOffline(trackId);
    }
    this._trimOffline(ids);
    this._pumpOffline();
  }

  /**
   * Bound the copies in memory without throwing away a finished download.
   *
   * A copy that has arrived outlives the look-ahead window: a song just played
   * stays here, so stepping back costs nothing. The map is still bounded, by
   * the window's size and by the memory the copies take together, dropping the
   * oldest finished copies that are neither in the window nor the track now
   * playing. The count alone was not a bound on anything a phone notices -
   * fifty whole songs is hundreds of megabytes, and the tab is killed for
   * holding them - so the bytes are the budget that matters. A fetch in flight
   * is never dropped: changing track must not cancel a download under way.
   */
  _trimOffline(inWindow = new Set()) {
    const playing = String(this.current()?.id || "");
    const spare = [...this._offline.entries()]
      .filter(([id, entry]) => entry.state !== "pending" && !inWindow.has(id) && id !== playing)
      .sort((left, right) => Number(left[1].at || 0) - Number(right[1].at || 0));
    let over = this._offline.size - OFFLINE_KEEP;
    for (const [id] of spare) {
      if (over <= 0 && this._offlineBytes <= OFFLINE_MAX_BYTES) break;
      this._releaseOffline(id);
      over -= 1;
    }
  }

  _queueOffline(track) {
    const trackId = String(track.id || "");
    if (!trackId) return;
    const known = this._offline.get(trackId);
    if (known) {
      if (known.state !== "failed") return;
      if (Date.now() - Number(known.at || 0) < OFFLINE_RETRY_MS) return;
    }
    this._offline.set(trackId, { state: "pending", variantId: "", url: "", bytes: 0, at: Date.now() });
    this._offlineOrder.push(trackId);
    this._emit("offline-changed", this.offlineSummary());
  }

  /** Start the next song the window wants, one at a time.
   *
   *  The song somebody is waiting to hear owns the pipe: nothing else is fetched
   *  while its file is on the way, and the copies behind it start the moment it
   *  lands. Past that the order is the queue's own - the next song each time,
   *  never two - so what the queue's rows call "downloading" is one transfer.
   */
  _pumpOffline() {
    if (this._loading) return;
    const wanted = this._offlineWanted || [];
    // The order is the wanted list, re-derived here rather than only when it
    // changes: a fetch that has just been let go is picked up again in its
    // place instead of staying out of the queue because it was in flight when
    // the order was last written down.
    const pending = wanted.filter((id) => {
      const entry = this._offline.get(id);
      return Boolean(entry) && entry.state === "pending" && !this._offlineInFlight.has(id);
    });
    this._offlineOrder = pending;
    if (!pending.length || this._offlineActive >= OFFLINE_FETCHES) return;
    this._startOffline(pending[0]);
  }

  /** Start one song's fetch and hold a slot for it.
   *
   *  Answers with the fetch itself, so a load that wants the same song waits on
   *  the one transfer rather than starting a second: what a load is waiting for
   *  is the download every other row of the queue shows, not a copy of it. The
   *  fetch is held with the entry it belongs to, because a fetch whose entry has
   *  since been replaced is a transfer for a song that is no longer there. */
  _startOffline(trackId) {
    const id = String(trackId || "");
    const entry = this._offline.get(id);
    if (!entry || entry.state !== "pending") return null;
    const inHand = this._offlineInFlight.get(id);
    if (inHand) return inHand.entry === entry ? inHand.promise : null;
    const controller = new AbortController();
    const held = { entry, controller, promise: null };
    this._offlineInFlight.set(id, held);
    this._offlineActive += 1;
    // A row that was waiting its turn is the one filling now, and it is said out
    // loud at the moment it starts: waiting for the first status report to say so
    // is a row that looks asleep while its transfer is under way.
    this._emit("download-progress", id);
    held.promise = this._fetchOffline(id, controller.signal).finally(() => {
      // Only what is still this song's is forgotten: a fetch that was replaced
      // must not take the entry that replaced it out of the maps.
      if (this._offlineInFlight.get(id) === held) this._offlineInFlight.delete(id);
      this._offlineActive -= 1;
      this._pumpOffline();
    });
    return held.promise;
  }

  /** Let go of a fetch whose song has left the window, or whose entry has been
   *  replaced. The maps forget it at once - the transfer is still unwinding, but
   *  it is not this song's download any more - so a replacement can take its
   *  place without waiting for a fetch nobody wants. */
  _abortOffline(trackId) {
    const id = String(trackId || "");
    const inHand = this._offlineInFlight.get(id);
    if (!inHand) return;
    this._offlineInFlight.delete(id);
    inHand.controller.abort();
  }

  /**
   * Fetch one song's bytes into memory.
   *
   * The file is the one this player would really play, so what lands here is
   * what `_load` hands the element, and it is asked for the same way any
   * download is: the backend has to hold it first, which is what `_warm` is.
   * The transfer is read in pieces rather than asked for as one blob, because
   * the queue's row says how far it has got - the download of the song somebody
   * is waiting for is that row, and a transfer nothing can count is a row that
   * sweeps.
   */
  async _fetchOffline(trackId, signal = null) {
    const claimed = this._offline.get(trackId);
    try {
      const pinned = String(claimed?.variantId || "");
      const variantId = pinned || (await this._variantFor({ id: trackId }))?.variantId || "";
      if (!variantId) throw new Error("no source");
      if (claimed) claimed.variantId = variantId;
      if (!(await this._warm(variantId, signal))) throw new Error("that file did not arrive");
      const response = await fetch(this._client().mediaUrl(variantId), signal ? { signal } : undefined);
      if (!response.ok) throw new Error(`media ${response.status}`);
      const blob = await readMedia(response, (received, total) => {
        this._noteTransfer(trackId, received, total);
      });
      // Anything that replaced this entry while the bytes were on their way -
      // another rendition for the same song, a failure past its retry - owns
      // the song now, and these bytes are not its.
      const entry = this._offline.get(trackId);
      if (entry !== claimed || !entry) return null;
      entry.variantId = variantId;
      entry.url = URL.createObjectURL(blob);
      entry.bytes = blob.size;
      entry.state = "ready";
      entry.at = Date.now();
      this._offlineBytes += blob.size;
      this._emit("offline-changed", this.offlineSummary());
      return entry;
    } catch (error) {
      // Let go on purpose is not a failure: the song is still wanted and still
      // pending, and the next pump picks it up in its new place. Anything else
      // is a song that did not arrive, said in the words the load will show.
      if (!signal?.aborted) {
        const entry = this._offline.get(trackId);
        if (entry === claimed && entry && entry.state === "pending") {
          entry.state = "failed";
          entry.error = error?.message || "that file did not arrive";
          entry.at = Date.now();
          this._emit("offline-changed", this.offlineSummary());
        }
      }
      return null;
    }
  }

  /** One transfer's own count, for the queue's mark on that song's row. */
  _noteTransfer(trackId, received, total) {
    const entry = this._offline.get(String(trackId || ""));
    if (!entry || entry.state !== "pending") return;
    entry.transfer = Number(received) || 0;
    entry.transferTotal = Number(total) || 0;
    // A finished stage is not the count for a transfer that states no length:
    // the mark sweeps rather than sitting at the fraction of the thing before it.
    if (!entry.transferTotal) entry.stageProgress = -1;
    this._emit("download-progress", String(trackId));
  }

  /**
   * Give the element the handlers that make it the player's element.
   *
   * Each handler first asks whether the element it came from is still the one
   * in hand, so the events of an element that has just been left behind cannot
   * move the queue on or consume a position.
   */
  _wireAudio(audio) {
    audio.volume = this._volume;
    audio.muted = this._muted;
    audio.addEventListener("timeupdate", () => {
      if (audio !== this.audio) return;

      // Sound that is moving is sound the browser is not holding back, however
      // it got started: the flag behind the "click the page once" hint has no
      // business outliving the playback it was about.
      this._blocked = false;
      this._blockedError = "";
      this._positionEvent();
      this.savePlayback();          // at most every SAVE_PLAYBACK_MS, and only on a change
    });
    audio.addEventListener("durationchange", () => {
      if (audio !== this.audio) return;
      this._positionEvent();
    });
    audio.addEventListener("loadedmetadata", () => {
      if (audio !== this.audio) return;

      const pending = this._pendingSeek;
      this._pendingSeek = null;
      if (pending !== null) {
        try {
          audio.currentTime = Math.min(pending / 1000, audio.duration || pending / 1000);
        } catch {
          /* the file is not seekable yet: it starts at the beginning */
        }
      }
      this._positionEvent();
    });
    audio.addEventListener("play", () => {
      if (audio !== this.audio) return;

      this._stateEvent();
      this.savePlaybackNow();
    });
    audio.addEventListener("pause", () => {
      if (audio !== this.audio) return;

      this._stateEvent();
      this.savePlaybackNow();
    });
    audio.addEventListener("playing", () => {
      if (audio !== this.audio) return;
      this._setBuffering(false);
    });
    audio.addEventListener("waiting", () => {
      if (audio !== this.audio) return;
      this._setBuffering(true);
    });
    audio.addEventListener("stalled", () => {
      if (audio !== this.audio) return;
      this._setBuffering(true);
    });
    audio.addEventListener("canplay", () => {
      if (audio !== this.audio) return;
      this._setBuffering(false);
    });
    audio.addEventListener("pause", () => {
      if (audio !== this.audio) return;
      this._setBuffering(false);
    });
    audio.addEventListener("ended", () => {
      if (audio !== this.audio) return;

      this._setBuffering(false);
      // The room host is a normal queue player: its own queue advances on the
      // element's end. Followers never advance locally; the host's next sync
      // tells them which song is on.
      if (!this._room || this._room.hostPlayback) this.next();
    });
    audio.addEventListener("error", () => {
      if (audio !== this.audio) return;

      if (!this._variant) return;
      // A load still in flight means this is the error of a file the element
      // has already been moved off: it is not this song's failure to act on.
      const settled = !this._loading;
      this._loading = false;
      this._buffering = false;
      // Offline, a file that will not play is a file this page does not have:
      // the next song it does have is more use than an error message.
      if (!this.online() && this._skipUnavailable()) return;
      this._error = "could not play that file";
      this._stateEvent();
      if (!settled) return;
      this._failedVariant = String(this._variant || "");
      this._recoverFromFailure();
    });
  }

  /**
   * Start the element, waiting for a pending position to be applied first.
   *
   * `src` starts the element at zero and the seek lands at `loadedmetadata`,
   * so playing immediately is audible as the song's first moment followed by a
   * jump to where it should be - the "it jumps back a second and starts again"
   * a copy taking over mid-song caused. With a position to land on, the play
   * waits for it.
   */
  _startAudio(atMs) {
    const audio = this.audio;
    if (!audio) return;
    if (!(atMs > 0)) {
      this._play();
      return;
    }
    // A file this page holds is read the moment it is assigned, so its length can
    // be known before this listener is attached - and an event that has already
    // fired never fires again. The position is applied here (the element's own
    // handler may not have run for it yet), then the play: waiting for an event
    // that has been and gone is a start that only the retry ever makes.
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      this._pendingSeek = null;
      this.seek(atMs);
      this._play();
      return;
    }
    const once = () => {
      clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", once);
      // The element's own handler has applied the pending seek by now.
      this._play();
    };
    // A file whose length never arrives must not leave this listener on the
    // element: it would sit there and start whatever is loaded next.
    const timer = setTimeout(() => audio.removeEventListener("loadedmetadata", once), METADATA_TIMEOUT_MS);
    audio.addEventListener("loadedmetadata", once);
  }

  /** Ask the element to play, and say so when the browser refuses. */
  _play() {
    const audio = this.audio;
    if (!audio) return;
    this._playingWanted = true;
    const started = audio.play();
    if (started?.catch) {
      started.catch((error) => {
        this._blocked = true;
        this._stateEvent();
        this._blockedError = error?.message || "";
      });
    }
  }

  /** Forget one song's copy, freeing the memory it held. */
  _releaseOffline(trackId) {
    const id = String(trackId || "");
    const entry = this._offline.get(id);
    if (!entry) return;
    if (entry.url && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(entry.url);
    this._offlineBytes -= Number(entry.bytes) || 0;
    this._offline.delete(id);
    this._offlineOrder = this._offlineOrder.filter((queued) => queued !== id);
    this._emit("offline-changed", this.offlineSummary());
  }

  _releaseAllOffline() {
    for (const trackId of [...this._offline.keys()]) this._releaseOffline(trackId);
  }

  /**
   * The variant this player would play a track from, resolved and cached.
   *
   * Public for the same reason `warm` is: a room's queue is not the player's
   * own, and whoever fetches the room's next track has to fetch the file the
   * player will really play. Choosing separately meant the warm fetched one
   * rendition and the play needed another, so the room paid to download the
   * track twice and waited on the second one.
   */
  variantFor(track) {
    return this._variantFor(track);
  }

  /**
   * Get a track's file ready before it is reached, without saying so.
   *
   * The backend does the downloading, so "fetched" means the status says so;
   * asking now is what makes the advance into the next track cost nothing.
   *
   * Public because a room's queue is not the player's own: the follower knows
   * what the room will play next, and nothing else would fetch it.
   */
  warm(track) {
    if (!track || !track.id) return;
    this._variantFor(track)
      .then((resolved) => {
        if (!resolved) return;
        // Nothing waits on the answer: a song that could not be fetched ahead
        // of time says so when it is reached, and a room's next song is
        // downloaded by the ask itself.
        return this._warm(resolved.variantId);
      })
      .catch(() => {
        /* a track that cannot be fetched will say so when it is reached */
      });
  }

  /**
   * Get a file ready before it is needed, without saying so.
   *
   * The backend does the downloading, so "fetched" means the status says so;
   * asking now is what makes the advance into the next track cost nothing.
   *
   * One warm runs per rendition however many times it is asked for: a room's
   * tick asks for the songs ahead of it every five hundred milliseconds, and
   * with a poll as long as this one each ask would start its own - dozens of
   * status requests a second for the same few files, all waiting on the same
   * download. Callers share the one attempt, and it is forgotten the moment it
   * settles, so a failure or a slot given up can be asked for again.
   */
  _warm(variantId, signal = null) {
    if (!variantId) return Promise.resolve(false);
    if (this._status.get(variantId)?.state === "ready") return Promise.resolve(true);
    const shared = this._warming.get(variantId);
    if (shared) return shared;
    const attempt = this._warmOnce(variantId, signal);
    this._warming.set(variantId, attempt);
    const forget = () => {
      if (this._warming.get(variantId) === attempt) this._warming.delete(variantId);
    };
    attempt.then(forget, forget);
    return attempt;
  }

  async _warmOnce(variantId, signal) {
    try {
      const client = this._client();
      await withDownloadSlot(async () => {
        this._startDownload(variantId, client);
        return true;
      });
      // Nothing waits on this: it gives up rather than polling a stuck
      // download for the rest of the session - or when the slot it was waiting
      // in was given to a song that is due sooner.
      for (let attempt = 0; attempt < 150; attempt += 1) {
        if (signal?.aborted) return false;
        const status = await client.mediaStatus(variantId);
        if (this._status.get(variantId)?.state !== "ready") {
          this._status.set(variantId, status);
          this._boundCache(this._status);
        }
        // A song's queue row is where its download is shown, and this loop is
        // where the backend's own count for it is heard.
        this._setProgress(variantId, status);
        if (status.state === "ready") return true;
        if (status.state === "failed") {
          // The fetch failed - a provider hiccup, or a play that took the pipe
          // for a song somebody was waiting on. Forget the ask, or this variant
          // is never requested again and the room's next songs are never
          // fetched ahead of time: which is a room joined mid-song that sits
          // there without downloading a thing.
          this._started.delete(variantId);
          return false;
        }
        await sleep(POLL_MS);
      }
      // Nothing came of it in the time this was willing to wait: the ask is
      // forgotten so the next warm can make it again. The server deduplicates
      // the request anyway, so asking twice costs nothing.
      this._started.delete(variantId);
    } catch {
      /* the track will say so when it is reached */
    }
    return false;
  }

  /**
   * What the download is doing, from the last status this page got for the
   * rendition being loaded.
   *
   * The bar no longer says it - the queue's own row is where a download is
   * shown - but the room's status line does, and it names the same download:
   * giving it a second vocabulary there meant the room said "Loading the
   * track…" while the page said "downloading 3.1 of 8.4 MB". */
  downloadLabel() {
    return mediaProgressLabel(this._status.get(this._variant));
  }

  /** Take the download's own progress from a status, for the queue's mark on a
   *  song's row. The server sends the fraction of the stage under way, or -1
   *  when the stage has nothing to count. A new stage (the fetch handing over to
   *  the conversion, the conversion to the store) starts its own count, which
   *  may well begin lower than the one before it; within a stage the mark only
   *  ever fills forwards, since a poll that lands behind the last is not the
   *  download going backwards. A -1 is not a fraction at all: the mark goes back
   *  to sweeping, the honest answer to "how far along is a thing nobody
   *  counts". */
  _setProgress(variantId, status) {
    const variant = String(variantId || "");
    if (!variant) return;
    const stage = String(status?.stage || "").toLowerCase();
    const value = Number(status?.progress);
    // Only a download has a fraction to give. Every other state - "none", the
    // answer for a rendition nothing is known about yet, and "ready"/"failed"
    // alike - carries Go's zero progress, which is not a count at all: reading
    // it as one is what would pin a mark at 0% before the first real report.
    const downloading = String(status?.state || "").toLowerCase() === "downloading";
    const progress = downloading && Number.isFinite(value) ? value : -1;
    for (const [trackId, entry] of this._offline) {
      if (entry.state !== "pending" || String(entry.variantId || "") !== variant) continue;
      if (stage !== entry.stage) {
        entry.stage = stage;
        entry.stageProgress = progress;
      } else if (progress < 0) {
        entry.stageProgress = -1;
      } else if (progress >= Number(entry.stageProgress ?? -1)) {
        entry.stageProgress = progress;
      }
      this._emit("download-progress", trackId);
    }
  }

  _stopAudio() {
    this._playingWanted = false;
    if (!this.audio) return;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }

  // --- the client --------------------------------------------------------

  /** The shell's client: one backend at a time, rebuilt when the session changes. */
  _client() {
    const client = currentClient();
    if (!client || !state.server) throw new ServerError(0, "no server selected");
    return client;
  }

  _clientIfAny() {
    return currentClient();
  }

  _report(error) {
    if (error?.status === 401) {
      requireLogin();
      return;
    }
    banner(error?.message || String(error), "error");
    // A song with nothing to play is a dead end, and finding a source is the
    // way out of it: the search that attaches one opens right here, and when it
    // has attached one the track is tried again.
    if (error?.status === 409) {
      findSourceDialog(this.current(), { onDone: () => this.retryCurrent() });
    }
  }

  // --- volume on this machine --------------------------------------------

  _restore() {
    const saved = session();
    const volume = Number(saved.volume);
    this._volume = Number.isFinite(volume) ? clamp01(volume) : 1;
    this._muted = Boolean(saved.muted);
    if (this.audio) {
      this.audio.volume = this._volume;
      this.audio.muted = this._muted;
    }
    this._emit("volume-changed", this._volume);
    this.renderBar();
  }

  _remember() {
    clearTimeout(this._rememberTimer);
    this._rememberTimer = setTimeout(() => {
      const saved = session();
      const sameVolume = Math.abs((Number(saved.volume) || 0) - this._volume) < 0.001;
      if (sameVolume && Boolean(saved.muted) === this._muted) return;
      updateSession({ volume: this._volume, muted: this._muted });
    }, REMEMBER_MS);
  }

  // --- events ------------------------------------------------------------

  _emit(event, payload) {
    for (const handler of [...(this._listeners.get(event) || [])]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`player event ${event} failed`, error);
      }
    }
    // The shell's own listeners (the queue view, the room views) hear about
    // the queue through the app's events as well.
    if (event === "queue-changed" || event === "track-changed") emit(event, payload);
    // Where we are is worth keeping, but the timeline ticks four times a
    // second: the queue is saved as it changes, and the throttled save picks
    // up the position.
    if (event === "queue-changed") this.savePlayback();
    if (event === "track-changed") this.savePlaybackNow();
  }

  _positionEvent() {
    this._emit("position", { positionMs: this.positionMs(), durationMs: this.durationMs() });
    this._syncMediaSession();
    this.renderBar();
  }

  /** Tell the lock screen where we are, within what the API allows. */
  _syncMediaSession() {
    const session = typeof navigator === "undefined" ? null : navigator.mediaSession;
    if (!session) return;
    // The intent, not the element: a transition stops the element for a moment,
    // and reporting "paused" there takes the lock screen's card away - and with
    // it the page's standing as something that is playing, which is what a
    // backgrounded phone needs to be allowed to start the next file at all.
    session.playbackState = this._playingWanted ? "playing" : "paused";
    if (typeof session.setPositionState !== "function") return;
    // The length the app knows, not only the one the element measured: before
    // the file is here there is no measured length, and a lock screen with no
    // position on it is a lock screen that cannot be scrubbed.
    const duration = this.durationMs();
    const position = this.positionMs();
    if (duration <= 0 || position < 0 || position > duration) return;
    try {
      session.setPositionState({ duration: duration / 1000, position: position / 1000, playbackRate: 1 });
    } catch {
      /* the numbers moved between the check and the call: not worth reporting */
    }
  }

  /** The lock screen's name for what is playing. */
  _syncMediaMetadata(track) {
    const session = typeof navigator === "undefined" ? null : navigator.mediaSession;
    if (!session || typeof MediaMetadata === "undefined") return;
    const metadataKey = track ? [track.id, track.title, artistLine(track), track.album, track.artworkUrl].join("\u0000") : "";
    if (this._mediaMetadataFor === metadataKey) return;
    this._mediaMetadataFor = metadataKey;
    if (!track) {
      session.metadata = null;
      return;
    }
    const client = this._clientIfAny();
    const art = track.artworkUrl && client ? client.artworkUrl(track.artworkUrl) : "";
    session.metadata = new MediaMetadata({
      title: track.title || "unknown track",
      artist: artistLine(track) || String(track.album || ""),
      album: String(track.album || ""),
      // The lock screen fetches this itself, so it has to be a whole URL.
      artwork: art ? [{ src: new URL(art, location.href).href, sizes: "512x512" }] : [],
    });
  }

  _installMediaSession() {
    const session = typeof navigator === "undefined" ? null : navigator.mediaSession;
    if (!session || session.__musoak) return;
    session.__musoak = true;
    const handle = (name, run) => {
      try {
        session.setActionHandler(name, run);
      } catch {
        /* that action is not supported here; the others still are */
      }
    };
    handle("play", () => this.toggle());
    handle("pause", () => this.toggle());
    handle("stop", () => this.pause());
    handle("nexttrack", () => this.next());
    handle("previoustrack", () => this.previous());
    handle("seekbackward", () => this.seek(this.positionMs() - 10_000));
    handle("seekforward", () => this.seek(this.positionMs() + 10_000));
    handle("seekto", (details) => {
      if (details && Number.isFinite(details.seekTime)) this.seek(details.seekTime * 1000);
    });
  }

  /** A play the browser refused - the usual way a phone stops between songs.
   *
   *  Nothing is wrong with the queue: the page was in the background when the
   *  next file was handed over, so the browser would not start it. Asking again
   *  when it is visible, and every few seconds until it takes, is what keeps a
   *  backgrounded session running instead of quietly ending.
   */
  _retryWanted() {
    // "Not playing" is the state to recover from, not "paused": a browser that
    // refuses a backgrounded play() leaves the element paused, which is exactly
    // what a working pause looks like - so a gate on isPaused() never fires and
    // the session ends quietly. An ended file is the one bare "not playing"
    // that must be left alone: play() would start it again from the top.
    if (!this._resumeWanted || this.isPlaying() || this.hasEnded()) return;
    const playing = this.audio?.play();
    if (playing?.catch) playing.catch(() => { /* still not allowed: it waits */ });
  }

  _wantResume(wanted) {
    this._resumeWanted = wanted;
    if (!wanted) return;
    if (!this._resumeTimer) {
      this._resumeTimer = setInterval(() => {
        if (!this._resumeWanted) {
          clearInterval(this._resumeTimer);
          this._resumeTimer = 0;
          return;
        }
        this._retryWanted();
      }, 4000);
    }
  }

  /** Whether the bar is showing play while no sound is coming out.
   *
   *  The file is here and the button has already become a pause button, but the
   *  browser has not started playing it yet. Saying so is the difference
   *  between a track that is loading and a player that looks broken. */
  _setBuffering(buffering) {
    const next = Boolean(buffering) && this.isPlaying();
    if (next === this._buffering) return;
    this._buffering = next;
    this._stateEvent();
  }

  _stateEvent() {
    this._emit("state-changed", this.state());
    this.renderBar();
  }

  // --- the bar's buttons -------------------------------------------------

  async _openSources(anchor) {
    const track = this.current();
    if (!track || anchor.disabled) return;
    openSourcePicker(anchor, track, () => this._refreshSources(track), {
      // The length of the room's song is the shortest file in it, so which copy
      // this member is on is the thing worth showing beside the preference.
      playingVariantId: this._variant,
    });
  }

  /** Report the listen that just ended, if there was one.
   *
   *  Sent when the track changes, which is when a listen ends. A pause is not
   *  the end of one: pausing and carrying on is the same listen.
   */
  _reportListen(nextTrackId = "") {
    const entry = this.current();
    const heard = this.positionMs();
    if (!entry?.id || heard <= 0) return;
    // The same song from another file is still the same listen.
    if (nextTrackId && String(nextTrackId) === String(entry.id)) return;
    const client = this._clientIfAny();
    if (!client) return;
    const play = {
      trackId: entry.id,
      variantId: this._variant,
      playedMs: heard,
      source: this._room ? "room" : "web",
    };
    Promise.resolve(client.recordPlay(play)).catch(() => {
      /* a lost listen is not worth interrupting anyone over */
    });
  }

  /** The words, in a panel that follows the playhead.
   *
   *  Only one position listener at a time: opening the panel again replaces the
   *  last one, and closing it stops the updates.
   */
  _openLyrics() {
    const track = this.current();
    const client = this._clientIfAny();
    if (!track || !client) return;
    const panel = lyricsPanel(client, {
      trackId: track.id,
      variantId: this._variant,
      positionMs: this.positionMs(),
      onSeek: (ms) => this.seek(ms),
    });
    const stop = () => {
      this._lyricsOff?.();
      this._lyricsOff = null;
    };
    dialog({
      title: track.title || "Lyrics",
      body: panel.node,
      actions: [{ label: "Close", onClick: stop }],
    });
    stop();
    this._lyricsOff = this.on?.("position", () => panel.setPosition(this.positionMs())) || null;
  }

  /** The preference changed: say so on the pill, and honour it next time. */
  async _refreshSources(track) {
    if (this.current()?.id !== track.id) return;
    try {
      const { sources, preferredVariantId } = await this._client().sources(track.id);
      const chosen = pickSource(sources, preferredVariantId);
      this._sources = { sources, preferredVariantId };
      this._source = chosen;
      this._variants.delete(track.id);
      this.renderBar();
      // A song that failed for want of a source has one now: try it again.
      if (this.retryCurrent()) return;
      // A song playing from one file, just told to play from another: switch to
      // it from where the song has got to, so the change is audible now rather
      // than at the next track. In a room the rendition is the room's to assign,
      // but a member playing their own copy of the track is the whole point of
      // picking a source, so it switches there too - and the position it seeks
      // to is the one drift correction keeps on the room's clock.
      const wanted = String(chosen?.variantId || "");
      if (!wanted || wanted === this._variant) return;
      // A rendition that cannot be downloaded is a preference, not a switch:
      // playing it would only mean silence.
      if (!chosen?.downloadable) return;
      this._load(this._index, { variantId: wanted, startMs: this.positionMs() });
    } catch (error) {
      this._report(error);
    }
  }

  /**
   * Play the current track again, for when something just gave it a source.
   *
   * Only a track that actually failed is retried: one that is playing or
   * loading is left alone, so picking a different source mid-song does not
   * restart it. The resolved sources are dropped first - they are what said
   * there was nothing to play, and they are still what the player holds.
   */
  retryCurrent() {
    if (this._index < 0 || this._index >= this.queue.length) return false;
    if (!this._error) return false;
    const track = this.queue[this._index];
    if (track?.id) this._variants.delete(track.id);
    this._load(this._index);
    return true;
  }

  async _star() {
    const track = this.current();
    if (!track) return;
    await toggleFavorite(track.id);
    this.renderBar();
  }

  _openRoom() {
    if (!this._room) return;
    navigate("rooms", { roomId: this._room.roomId });
  }

  _openQueue() {
    // The shell owns the queue drawer, and the bar does not know which page is
    // showing: it asks, and nothing happens if nobody is listening.
    if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
    window.dispatchEvent(new CustomEvent("musoak:open-queue"));
  }

  /** The menu for whatever is playing: play, queue, add to a playlist, share,
   *  favourite. Those actions and their module live away from the bar, so the
   *  bar asks for the menu rather than building it. */
  _openTrackMenu(anchor) {
    if (typeof window === "undefined" || typeof CustomEvent === "undefined") return;
    window.dispatchEvent(new CustomEvent("musoak:track-menu", { detail: { anchor, track: this.current() } }));
  }

  _stopFollowing() {
    const following = this._following;
    this.clearFollowingMode();
    following?.onStop?.();
  }

  _seekTo(value) {
    const duration = this.durationMs();
    if (duration <= 0) return;
    this._seeking = true;
    clearTimeout(this._seekTimer);
    this._seekTimer = setTimeout(() => {
      this._seeking = false;
      this.renderBar();
    }, SEEK_SETTLE_MS);
    const target = (Number(value) / 1000) * duration;
    // A room owns the position too: moving the local file is put back by the
    // follower, so the seek is asked of the room - or refused, if the room keeps
    // that control for its host.
    if (this._room) return this._roomCommand("seek", "seek", target);
    this.seek(target);
  }

  // --- building the bar --------------------------------------------------

  _wire() {
    if (this._wired) return;
    this._wired = true;
    on("toggle-play", () => this.toggle());
    // The page's transport keys, which the shell answers for the whole page
    // (see app.js): the terminal player's h/j/k/l and the arrows, plus mute.
    // The bar's own buttons do the same things, so there is one way to play a
    // song whichever one is used.
    on("next-track", () => this.next());
    on("previous-track", () => this.previous());
    on("volume-up", () => this.setVolume(this._volume + VOLUME_STEP));
    on("volume-down", () => this.setVolume(this._volume - VOLUME_STEP));
    on("toggle-mute", () => this.setMuted(!this._muted));
    on("favorites-changed", () => this.renderBar());
    on("session-changed", () => {
      this._restore();
      this.renderBar();
    });
    on("server-changed", () => {
      this.savePlaybackNow();     // this server's queue belongs to this server
      this.clear();
      this._lastSaved = "";       // the next server keeps its own document
      this._lastSaveAt = 0;
      this._variants.clear();
      this._resolving.clear();
      this._started.clear();
      this._status.clear();
      this._restore();
    });
    // Leaving must not be the thing that fails: the write is sent and forgotten.
    if (typeof window !== "undefined" && window.addEventListener) {
      const leaving = () => this.savePlaybackNow();
      window.addEventListener("pagehide", leaving);
      window.addEventListener("beforeunload", leaving);
    }
  }

  _buildBar() {
    const cover = artworkImage("about:blank", { className: "art", eager: true });
    const title = h("div", { class: "title", text: "Nothing playing" });
    // The artist line hugs its text, so the pill lands directly after the
    // artist name - which, the name being short, usually puts it under the song
    // title rather than out beside the transport.
    const subtitle = h("div", { class: "subtitle" });
    const pill = h("button", {
      class: "source-pill player-source-pill",
      disabled: true,
      onclick: (event) => this._openSources(event.currentTarget),
    });
    // The pill sits directly beside the artist, at the end of that name.
    const line = h("div", { class: "player-track-line" }, subtitle, pill);
    // The song's own download, on a line under the artist: the same filled
    // fraction the queue's mark on its row draws, as a bar. It is the wait for
    // the file, mirrored - not a second download, and not a number.
    const loadFill = h("div", { class: "bar" });
    const load = h("div", { class: "track-wait", style: { display: "none" } }, loadFill);
    // What will not play, in words, on that same line its bar would have used.
    const status = h("span", { class: "track-error", role: "status", "aria-live": "polite", style: { display: "none" } });
    const text = h("div", { class: "track-text" }, title, line, load, status);

    const star = h("button", {
      class: "btn flat round", title: "Favourite",
      style: { display: "none" }, onclick: () => this._star(),
    });
    const words = h("button", {
      class: "btn flat round", title: "Lyrics",
      style: { display: "none" }, text: "Aa", onclick: () => this._openLyrics(),
    });
    const shuffle = iconButton("shuffle", {
      title: "Shuffle what is left of the queue",
      onclick: () => {
        // In a room the local queue is not what plays, so the button asks the
        // room to shuffle the caller's own queue instead. Editing the queue is
        // a state change, so the enablement is read again before asking.
        if (this._room) window.dispatchEvent(new CustomEvent("musoak:shuffle-my-queue"));
        else this.shuffleQueue();
      },
    });
    const previous = iconButton("prev", { title: "Previous", onclick: () => this.previous() });
    const play = iconButton("play", { title: "Play", class: "btn round play", onclick: () => this.toggle() });
    const next = iconButton("next", { title: "Next", onclick: () => this.next() });
    const controls = h("div", { class: "controls" }, previous, play, next);

    const position = h("input", {
      type: "range", min: "0", max: "1000", step: "1", value: "0",
      title: "Seek", disabled: true,
      // Only a hand moves the room. A range input fires `input` for whatever
      // value it is handed while it is being manipulated, and this bar is redrawn
      // from the position several times a second - so a stray one (a value
      // restored mid-drag, a keyboard nudge, a device speaking for the page)
      // asks the room to jump. The room takes a seek at its word and everybody
      // hears it, which is how a song ends seconds after it started.
      onpointerdown: () => { this._seekingByHand = true; },
      onpointerup: () => { this._seekingByHand = false; },
      onpointercancel: () => { this._seekingByHand = false; },
      onkeydown: () => { this._seekingByHand = true; },
      onkeyup: () => { this._seekingByHand = false; },
      onblur: () => { this._seekingByHand = false; },
      oninput: (event) => {
        if (!this._seekingByHand) return;
        this._seekTo(event.currentTarget.value);
      },
    });
    const timeline = h("div", { class: "timeline" }, position);

    const volume = h("input", {
      type: "range", class: "volume", min: "0", max: "1", step: "0.01", value: String(this._volume),
      title: "Volume",
      oninput: (event) => this.setVolume(event.currentTarget.value),
    });
    const mute = h("button", { class: "btn flat round", title: "Mute", onclick: () => this.setMuted(!this._muted) });
    const sound = h("div", { class: "controls" }, volume, mute);

    const room = h("button", {
      class: "btn flat small", title: "Open the room",
      style: { display: "none" }, onclick: () => this._openRoom(),
    });
    const listen = iconButton("cross", {
      title: "Listening along — click to stop",
      onclick: () => this._stopFollowing(),
    });
    listen.style.display = "none";
    const queue = iconButton("dots", {
      title: "Song actions",
      onclick: (event) => this._openTrackMenu(event.currentTarget),
    });

    // The favourite sits next to the queue it belongs with, rather than beside
    // the song's text.
    const root = h("div", { class: "player-bar" },
      cover, text, shuffle, controls, timeline, sound, room, listen, star, queue);

    // The bar's own download line follows the page's transfers, so it hears the
    // same reports the queue's marks do. Once: a bar can be rebuilt (a page that
    // had none, a test), and a second listener is two renders per report.
    if (!this._barTold) {
      this._barTold = true;
      this.on("download-progress", () => this.renderBar());
    }
    this._bar = {
      words,
      root, cover, title, subtitle, load, loadFill, status, pill, star, shuffle,
      previous, play, next, position, volume, mute, room, listen, queue,
    };
  }
}

/** The one player. */
export const player = new Player();

/** Builds the bar into the shell's footer. */
export function mountPlayer(container) {
  player.mount(container);
}
