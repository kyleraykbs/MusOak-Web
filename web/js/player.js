// The playback engine and the now-playing bar.
//
// One audio element, one queue: a track is resolved to a source on the backend
// and downloaded there before the element is pointed at it, so an advance has
// nothing to wait for. Everything else in the app talks to the `player`
// singleton and listens on player.on(...).
//
// The file is importable without a DOM: the shell guards its own boot, and
// nothing here touches the document until mountPlayer() is called.

import {
  banner, currentClient, emit, navigate, on, requireLogin, toggleFavorite,
} from "./app.js";
import { ServerError } from "./client.js";
import { h, mount, dialog, fmtDuration, icon, iconButton } from "./dom.js";
import { lyricsPanel } from "./views/lyrics.js";
import { session, state, updateSession } from "./state.js";
import { openSourcePicker, pickSource, sourceLabel, findSourceDialog } from "./views/sources.js";

/** How many tracks after the current one stay downloaded. */
export const PREFETCH = 3;
/** How often the bar asks the backend whether a download is done. */
const POLL_MS = 400;
/** How long a seek counts as still in progress after the last drag. */
const SEEK_SETTLE_MS = 400;
/** How long the volume waits before this machine remembers it. */
const REMEMBER_MS = 500;
/** How often the queue is written to the account at most. */
const SAVE_PLAYBACK_MS = 5000;
/** How long a seek waits before it is worth saving. */
const SAVE_SETTLE_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

/** The current track and the next `count` ones: what stays downloaded. */
export function prefetchWindow(queue, index, count = PREFETCH) {
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

/** The queue with everything after `index` shuffled, the head untouched. */
export function shuffleTail(queue, index, random = Math.random) {
  const list = [...(queue || [])];
  const head = Math.max(0, Math.floor(Number(index) || 0)) + 1;
  const tail = list.slice(head);
  if (tail.length < 2) return list;
  for (let i = tail.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [tail[i], tail[j]] = [tail[j], tail[i]];
  }
  return list.slice(0, head).concat(tail);
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

    this._token = 0;              // which track the async work is still for
    this._loading = false;
    this._progress = 0;
    this._error = "";
    this._pendingSeek = 0;

    this._bar = null;
    this._seeking = false;
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
    this._progress = 0;
    this._error = "";
    this._pendingSeek = 0;
    this._stopAudio();
    this._emit("queue-changed", this.queue);
    this._emit("track-changed", null);
    this._stateEvent();
  }

  jumpTo(index) {
    const target = Math.floor(Number(index));
    if (!Number.isFinite(target) || target < 0 || target >= this.queue.length) return;
    this._load(target);
  }

  /**
   * Play one particular source of a track, starting where it is told to.
   *
   * Listening together assigns each member a variant and a position, so the
   * provider order does not get a say here: this is the file everyone was told
   * to play. The track joins the local queue if it is not in it already.
   */
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

  /** Where the current track's file is: "none", "downloading", "ready", "failed". */
  readyState() {
    if (!this._variant) return "none";
    return this._mediaState() || "none";
  }

  /** Go to the track after this one, if there is one. */
  next() {
    if (this._room) return this._roomCommand("skip", "skip");
    const target = nextIndex(this.queue, this._index, this._shuffle);
    if (target >= 0) this.jumpTo(target);
  }

  /** Restart the current track, or step back to the previous one. */
  previous() {
    if (this._index > 0) this.jumpTo(this._index - 1);
    else this.seek(0);
  }

  pause() {
    this._wantResume(false);
    this.audio?.pause();
  }

  resume() {
    if (!this.queue.length) return;
    if (!this.audio || !this.audio.src) {
      this.jumpTo(Math.max(this._index, 0));
      return;
    }
    this._wantResume(true);
    const playing = this.audio.play();
    if (playing?.catch) playing.catch(() => { /* the browser refused; the button stays honest */ });
  }

  toggle() {
    if (this._room) return this._roomCommand(this.isPaused() ? "resume" : "pause", "pause");
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

  /** Go to a position in the current track. Remembers it if the file is still loading. */
  seek(ms) {
    const target = Math.max(0, Math.round(Number(ms) || 0));
    const audio = this.audio;
    if (!audio || !audio.src || !audio.duration) {
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

  /**
   * The length of the file this client actually has, or 0 before the browser
   * has read its metadata. Anything reporting what this member will play - the
   * room's readiness above all - has to ask this and not durationMs(): the
   * queue entry's duration is the song's canonical one, which is a different
   * number whenever this member holds a different copy.
   */
  measuredDurationMs() {
    const audio = this.audio;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) return Math.round(audio.duration * 1000);
    return 0;
  }

  durationMs() {
    const measured = this.measuredDurationMs();
    if (measured > 0) return measured;
    return Math.round(Number(this.current()?.durationMs) || 0);
  }

  setVolume(value) {
    this._volume = clamp01(Number(value) || 0);
    if (this.audio) this.audio.volume = this._volume;
    this._emit("volume-changed", this._volume);
    this.renderBar();
    this._remember();
  }

  volume() {
    return this._volume;
  }

  setMuted(muted) {
    this._muted = Boolean(muted);
    if (this.audio) this.audio.muted = this._muted;
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
      loading: this._loading,
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
    if (this.queue.length - (this._index + 1) < 2) return false;
    this.queue = shuffleTail(this.queue, this._index);
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

  /** While in a room, the room owns playback: adding queues a track there, and
   *  the transport asks it rather than moving the local player. `mayDrive`
   *  answers for the room's control policy and `onBlocked` is what to say when
   *  it is not ours to drive. */
  setRoom(room) {
    this._room = room && room.roomId
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
        }
      : null;
    this.renderBar();
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
    if (track) {
      setText(bar.title, track.title || "unknown track");
      let subtitle = artistLine(track) || String(track.album || "");
      if (this._loading) {
        const label = mediaStateLabel(this._mediaState()) || "downloading…";
        subtitle = subtitle ? `${subtitle} · ${label}` : label;
      }
      if (this._error) subtitle = this._error;
      setText(bar.subtitle, subtitle);
      bar.subtitle.style.color = this._error ? "var(--red)" : "";

      const art = track.artworkUrl && client ? client.artworkUrl(track.artworkUrl) : "";
      if (art) {
        if (bar.cover.getAttribute("src") !== art) bar.cover.src = art;
      } else {
        bar.cover.removeAttribute("src");
      }
      this._syncMediaMetadata(track);
    } else {
      setText(bar.title, "Nothing playing");
      setText(bar.subtitle, this._error);
      bar.subtitle.style.color = this._error ? "var(--red)" : "";
      bar.cover.removeAttribute("src");
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
      bar.star.title = starred ? "Unfavourite" : "Favourite";
      bar.star.setAttribute("aria-pressed", starred ? "true" : "false");
      // The only state the star has no second icon for: a favourite is filled
      // in the app's own accent colour, an ordinary one stays quiet.
      bar.star.style.color = starred ? "var(--orange)" : "";
    }

    // --- transport -------------------------------------------------------
    const paused = this.isPaused();
    const playing = this.isPlaying() && !paused;
    setIcon(bar.play, paused ? "play" : "pause");
    setLabel(bar.play, paused ? "Play" : "Pause");
    // Which state the button is showing, for the theme to colour: no colour
    // is chosen here.
    bar.play.dataset.state = playing ? "playing" : "paused";
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
    // In a room the local queue is not what plays, so the shuffle is never dead
    // there: it acts on the caller's own room queue (see the listener in the
    // queue view), which is the room's to reorder.
    bar.shuffle.disabled = inRoom ? false : this.queue.length - (this._index + 1) < 2;
    bar.shuffle.title = inRoom ? "Shuffle your own queue" : "Shuffle what is left of the queue";
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

    // --- how the download is going --------------------------------------
    if (this._loading && !this._error) {
      bar.progress.style.display = "";
      bar.progressFill.style.width = `${Math.round(clamp01(this._progress) * 100)}%`;
    } else {
      bar.progress.style.display = "none";
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
    // A media session is what keeps a phone playing with the screen off: it
    // tells the browser this page is a player, which is also what stops a
    // backgrounded tab being frozen and its audio cut off a few songs in.
    this._installMediaSession();
    audio.addEventListener("playing", () => this._wantResume(false));
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => this._retryWanted());
    }
    audio.volume = this._volume;
    audio.muted = this._muted;
    audio.addEventListener("timeupdate", () => {
      this._positionEvent();
      this.savePlayback();          // at most every SAVE_PLAYBACK_MS, and only on a change
    });
    audio.addEventListener("durationchange", () => this._positionEvent());
    audio.addEventListener("loadedmetadata", () => {
      const pending = this._pendingSeek;
      this._pendingSeek = 0;
      if (pending > 0) {
        try {
          audio.currentTime = Math.min(pending / 1000, audio.duration || pending / 1000);
        } catch {
          /* the file is not seekable yet: it starts at the beginning */
        }
      }
      this._positionEvent();
    });
    audio.addEventListener("play", () => {
      this._stateEvent();
      this.savePlaybackNow();
    });
    audio.addEventListener("pause", () => {
      this._stateEvent();
      this.savePlaybackNow();
    });
    audio.addEventListener("playing", () => this._stateEvent());
    audio.addEventListener("waiting", () => this._stateEvent());
    audio.addEventListener("ended", () => this.next());
    audio.addEventListener("error", () => {
      if (!this._variant) return;
      this._loading = false;
      this._error = "could not play that file";
      this._stateEvent();
    });
    this.audio = audio;
    return audio;
  }

  // --- playing a track ---------------------------------------------------

  async _load(index, { startMs = 0, autoplay = true, variantId = "" } = {}) {
    const audio = this.ensureAudio();
    const token = ++this._token;
    // Whatever was playing has just stopped being played: that is the moment a
    // listen is over and worth reporting. A track skipped straight away is the
    // server's to ignore, not the client's to judge. Switching to another file
    // of the same song is not a new listen, so the one that follows is named.
    this._reportListen(index >= 0 && index < this.queue.length ? this.queue[index]?.id : "");
    const track = index >= 0 && index < this.queue.length ? this.queue[index] : null;
    this._index = track ? index : -1;
    this._error = "";
    this._loading = Boolean(track);
    this._progress = 0;
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

    if (audio.src) {
      // The old track is over: it must not be read as the new track's position
      // while the new file is fetched.
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch {
        /* nothing to rewind yet */
      }
    }
    this._emit("track-changed", track);
    // The bar says "downloading" from the moment the track is chosen.
    this._stateEvent();

    let resolved;
    try {
      resolved = variantId
        ? await this._resolveFixed(track, variantId)
        : await this._variantFor(track);
    } catch (error) {
      if (token !== this._token) return;
      this._loading = false;
      this._error = error?.message || "could not fetch that track";
      this._stateEvent();
      this._report(error);
      return;
    }
    if (token !== this._token) return;   // the track changed while we looked

    this._sources = { sources: resolved.sources, preferredVariantId: resolved.preferredVariantId };
    this._source = resolved.source || pickSource(resolved.sources, resolved.preferredVariantId);
    this._variant = resolved.variantId;
    this.renderBar();

    const status = await this._ready(resolved.variantId, token);
    if (token !== this._token || status === null) return;
    if (status.state === "failed") {
      this._loading = false;
      this._error = status.error || "that file could not be downloaded";
      this._stateEvent();
      return;
    }

    audio.src = this._client().mediaUrl(resolved.variantId);
    this._loading = false;
    if (!autoplay) {
      // The file is here and the bar shows where it is; the moment is someone
      // else's to choose.
      this._stateEvent();
      this.renderBar();
      return;
    }
    this._stateEvent();
    this._prefetch();
    this.renderBar();
    this._wantResume(true);
    const started = audio.play();
    if (started?.catch) started.catch(() => { /* nothing to say: the button still says pause */ });
  }

  /** A variant a room assigned: the sources are only there to name it. */
  async _resolveFixed(track, variantId) {
    try {
      const { sources, preferredVariantId } = await this._client().sources(track.id);
      return {
        sources,
        preferredVariantId,
        variantId,
        source: sources.find((source) => source.variantId === variantId) || null,
      };
    } catch {
      return { sources: [], preferredVariantId: "", variantId, source: null };
    }
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
          if (resolved) this._variants.set(track.id, resolved);
        },
        () => {}
      ).finally(() => {
        if (this._resolving.get(track.id) === pending) this._resolving.delete(track.id);
      });
    }
    return pending;
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

  /** Wait until the backend has the file, showing how far along it is. */
  async _ready(variantId, token) {
    const ready = this._status.get(variantId);
    if (ready?.state === "ready") return ready;
    const client = this._client();
    this._loading = true;
    this._startDownload(variantId, client);
    for (;;) {
      let status;
      try {
        status = await client.mediaStatus(variantId);
      } catch (error) {
        if (token !== this._token) return null;
        this._error = error?.message || "could not fetch that track";
        this._report(error);
        return { state: "failed", error: this._error };
      }
      this._status.set(variantId, status);
      if (token !== this._token) return null;
      if (variantId === this._variant) {
        this._progress = Number(status.progress) || (status.state === "ready" ? 1 : 0);
        this.renderBar();
      }
      if (status.state === "ready" || status.state === "failed") return status;
      await sleep(POLL_MS);
      if (token !== this._token) return null;
    }
  }

  /** Ask the backend for a file, once. */
  _startDownload(variantId, client = null) {
    if (!variantId || this._started.has(variantId)) return;
    if (this._status.get(variantId)?.state === "ready") return;
    this._started.add(variantId);
    Promise.resolve()
      .then(() => (client || this._client()).startDownload(variantId, false))
      .then((status) => {
        if (!status || typeof status !== "object") return;
        // The answer to "start downloading" is never that the file is ready:
        // it must not undo what a status check already found out.
        if (this._status.get(variantId)?.state === "ready") return;
        this._status.set(variantId, status);
      })
      .catch((error) => {
        this._started.delete(variantId);
        // A fetch that failed ahead of time is not worth interrupting anyone
        // for: the track will say so when it is reached.
        if (variantId === this._variant) this._report(error);
      });
  }

  /** Keep the current track and the next few fetched. */
  _prefetch() {
    for (const track of prefetchWindow(this.queue, this._index, PREFETCH)) {
      this.warm(track);
    }
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
        if (resolved) this._warm(resolved.variantId);
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
   */
  async _warm(variantId) {
    if (!variantId || this._status.get(variantId)?.state === "ready") return;
    try {
      const client = this._client();
      this._startDownload(variantId, client);
      // Nothing waits on this: it gives up rather than polling a stuck
      // download for the rest of the session.
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const status = await client.mediaStatus(variantId);
        if (this._status.get(variantId)?.state !== "ready") this._status.set(variantId, status);
        if (status.state === "ready" || status.state === "failed") return;
        await sleep(POLL_MS);
      }
    } catch {
      /* the track will say so when it is reached */
    }
  }

  _mediaState() {
    const status = this._status.get(this._variant);
    if (status?.state) return status.state;
    return this._loading ? "downloading" : "";
  }

  _stopAudio() {
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
    session.playbackState = this.isPaused() ? "paused" : "playing";
    if (typeof session.setPositionState !== "function") return;
    const duration = this.measuredDurationMs();
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
    if (this._mediaMetadataFor === (track?.id || "")) return;
    this._mediaMetadataFor = track?.id || "";
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
    if (!this._resumeWanted || this.isPaused()) return;
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
    const cover = h("img", { class: "art", alt: "", style: { width: "56px", height: "56px" } });
    const title = h("div", { class: "title", text: "Nothing playing" });
    // The artist line hugs its text, so the pill lands directly after the
    // artist name - which, the name being short, usually puts it under the song
    // title rather than out beside the transport.
    const subtitle = h("div", { class: "subtitle", style: { flex: "0 1 auto", minWidth: "0" } });
    const pill = h("button", {
      class: "source-pill",
      title: "Choose where this song comes from",
      disabled: true,
      style: { flex: "0 1 auto", maxWidth: "150px" },
      onclick: (event) => this._openSources(event.currentTarget),
    });
    const progressFill = h("div", { class: "bar" });
    const progress = h("div", { class: "progress", style: { display: "none", marginTop: "4px" } }, progressFill);
    // The pill sits directly beside the artist, at the end of that name.
    const line = h("div", { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: "0" } },
      subtitle, pill);
    const text = h("div", { class: "track-text" }, title, line, progress);

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
        // room to shuffle the caller's own queue instead.
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
      oninput: (event) => this._seekTo(event.currentTarget.value),
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

    this._bar = {
      words,
      root, cover, title, subtitle, pill, progress, progressFill, star, shuffle,
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
