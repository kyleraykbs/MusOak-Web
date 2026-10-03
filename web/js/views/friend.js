// The friend page: who they are, what you can do together, and their four
// lists — public playlists, favourites, recently played, and everything they
// shared with you.
//
// The page also owns "listen along": replay their queue here, then keep the
// follower in step. The playback document is polled every couple of seconds
// for the bigger moves (their track changed, they paused, they rebuilt the
// queue) and the player's own position ticks drive the tight sync, so the two
// stay within a second or two of each other without re-seeking every poll.

import {
  h, mount, popover, confirm, toast, fmtDuration, fmtAgo, icon, iconButton,
} from "../dom.js";
import {
  navigate, currentClient, banner, requireLogin, toggleFavorite, setFollowing,
} from "../app.js";
import { state } from "../state.js";
import { player } from "../player.js";
import {
  avatarFor, displayName, driftDecision, inviteToRoom, isOnline, listeningLine,
  queueTrack, shareTrack, DRIFT_TOLERANCE_MS, FOLLOW_POLL_MS,
} from "./share.js";
import { artistLine, artistLineNode } from "./queue.js";
import { trackMenu } from "./playlist.js";
import { uploadTrack } from "./manage.js";

const EMPTY_PLAYLIST = "No public playlists";
const EMPTY_FAVOURITES = "No favourite songs";
const EMPTY_RECENT = "Nothing played recently";
const EMPTY_SHARED = "Nothing shared yet";
const EMPTY_UPLOADS = "Nothing uploaded yet";
/** How close to the end of a track counts as "their track has ended". */
const END_MARGIN_MS = 250;

// --- small builders --------------------------------------------------------

function fail(error) {
  if (error?.status === 401) requireLogin();
  else banner(error?.message || String(error), "error");
}

/** The empty state takes the name of a drawn icon, not a typed glyph. */
function emptyState(name, title, subtitle) {
  return h(
    "div",
    { class: "empty" },
    h("span", { class: "icon" }, icon(name, 38)),
    h("span", { class: "title", text: title }),
    subtitle ? h("span", { text: subtitle }) : null
  );
}

function menuButton(open) {
  return iconButton("dots", {
    class: "btn flat small",
    title: "More",
    onclick: (event) => {
      event.stopPropagation();
      open(event.currentTarget);
    },
  });
}

function cover(client, path, round = false) {
  const source = path ? (client?.artworkUrl ? client.artworkUrl(path) : path) : "";
  const shape = round ? "art round small" : "art small";
  if (source) return h("img", { class: shape, src: source, alt: "", loading: "lazy" });
  return h(
    "div",
    {
      class: shape,
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--fg4)",
      },
    },
    icon("note", 16)
  );
}

function play(tracks, start = 0) {
  if (tracks?.length) player?.play?.(tracks, start);
}

function starButton(trackId) {
  const button = iconButton("star", {
    class: "btn flat small",
    title: "Favourite",
    onclick: async (event) => {
      event.stopPropagation();
      await toggleFavorite(trackId);
      paint();
    },
  });
  // A starred song is drawn in the accent colour; an unstarred one is dim.
  const paint = () => {
    const favourite = Boolean(state.favorites?.has(trackId));
    button.title = favourite ? "Unfavourite" : "Favourite";
    button.setAttribute("aria-pressed", favourite ? "true" : "false");
    button.style.color = favourite ? "var(--orange)" : "var(--fg4)";
  };
  paint();
  return button;
}

function trackRow(client, track, { note = "" } = {}) {
  const artists = artistLine(track);
  return h(
    "div",
    { class: "row clickable", title: "Play this song", onclick: () => play([track]) },
    cover(client, track?.artworkUrl),
    h(
      "div",
      { style: { flex: 1, minWidth: 0 } },
      h("div", { class: "title", text: track?.title || "" }),
      artists ? artistLineNode(artists, (track?.artistIds || [])[0]) : null,
      note ? h("div", { class: "subtitle", text: note }) : null
    ),
    track?.durationMs ? h("span", { class: "time", text: fmtDuration(track.durationMs) }) : null,
    starButton(track.id),
    menuButton((anchor) => popover(anchor, trackMenu(track)))
  );
}

/**
 * A friend's playlist is shown, not opened: the backend serves a playlist's
 * tracks to its owner alone, so a row here carries what the page knows —
 * cover, name, size — and says why it does not go anywhere.
 */
function playlistRow(client, playlist) {
  const count = Number(playlist?.trackCount) || 0;
  return h(
    "div",
    { class: "row clickable", title: "Open this playlist", onclick: () => navigate("playlist", { id: playlist?.id }) },
    cover(client, playlist?.artworkUrl),
    h(
      "div",
      { style: { flex: 1, minWidth: 0 } },
      h("div", { class: "title", text: playlist?.name || "Untitled" }),
      h("div", { class: "subtitle", text: `${count} track${count === 1 ? "" : "s"}` })
    ),
    playlist?.durationMs
      ? h("span", { class: "time", text: fmtDuration(playlist.durationMs) })
      : null
  );
}

function shareRow(client, share) {
  const when = share?.createdAt ? fmtAgo(share.createdAt) : "";
  if (share?.track?.id) return trackRow(client, share.track, { note: when });
  if (share?.roomId) {
    return h(
      "div",
      {
        class: "row clickable",
        title: "Open the rooms",
        onclick: () => navigate("rooms", { roomId: share.roomId }),
      },
      cover(client, "", true),
      h(
        "div",
        { style: { flex: 1, minWidth: 0 } },
        h("div", { class: "title", text: "Room invite" }),
        h("div", {
          class: "subtitle",
          text: [String(share.roomId), when].filter(Boolean).join(" \u00b7 "),
        })
      )
    );
  }
  return h(
    "div",
    { class: "row" },
    cover(client, "", true),
    h(
      "div",
      { style: { flex: 1, minWidth: 0 } },
      h("div", { class: "title", text: "Shared a song" }),
      h("div", {
        class: "subtitle",
        text: [String(share?.trackId || ""), when].filter(Boolean).join(" \u00b7 "),
      })
    )
  );
}

function section(title, rows, emptyText) {
  return h(
    "section",
    { style: { display: "flex", flexDirection: "column", gap: "8px" } },
    h("h2", { class: "section-title", text: title }),
    h(
      "div",
      { class: "list" },
      rows && rows.length
        ? rows
        : h("div", { class: "row" }, h("div", { class: "subtitle", text: emptyText }))
    )
  );
}

// --- the banner and its utilities -----------------------------------------

function listsGrid(client, detail, uploads = []) {
  const playlists = (detail?.publicPlaylists || []).filter((playlist) => playlist?.id);
  const favorites = (detail?.favorites || []).filter((track) => track?.id);
  const recent = (detail?.recent || []).filter((track) => track?.id);
  const shared = (detail?.shared || []).filter((entry) => entry && typeof entry === "object");
  // An upload is a song of their own: what they put into the library, whether
  // or not it ever got matched to something a provider knows.
  const own = uploads.map(uploadTrack).filter((track) => track.id || track.title);
  return h(
    "div",
    { class: "grid-2" },
    section(
      "Uploaded songs",
      own.map((track) => trackRow(client, track)),
      EMPTY_UPLOADS
    ),
    section(
      "Public playlists",
      playlists.map((playlist) => playlistRow(client, playlist)),
      EMPTY_PLAYLIST
    ),
    section(
      "Favourite songs",
      favorites.map((track) => trackRow(client, track)),
      EMPTY_FAVOURITES
    ),
    section(
      "Recently played",
      recent.map((track) => trackRow(client, track)),
      EMPTY_RECENT
    ),
    section(
      "Shared with you",
      shared.map((entry) => shareRow(client, entry)),
      EMPTY_SHARED
    )
  );
}

function actionsRow(client, userId, user, reload) {
  const following = Boolean(follow && follow.userId === userId);
  const ignored = String(user?.relationship || "") === "ignored";
  return h(
    "div",
    { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
    h("button", {
      class: "btn suggested",
      text: following ? "Listening along" : "Listen along",
      title: "Follow what they are playing",
      disabled: following,
      onclick: async () => {
        await startListeningAlong(user);
        reload?.();
      },
    }),
    h("button", {
      class: "btn",
      text: "Invite to a room",
      title: "Bring them into a room",
      onclick: () => inviteToRoom(user),
    }),
    h("button", {
      class: "btn",
      text: ignored ? "Unignore" : "Ignore",
      title: ignored ? "Let their shares back in" : "Their shares stop reaching you",
      onclick: () => toggleIgnore(client, userId, user, reload),
    }),
    h("button", {
      class: "btn",
      text: "Share\u2026",
      title: "Send them a song from your library",
      onclick: () => shareTrack(null, { friend: user }),
    }),
    h("button", {
      class: "btn destructive",
      text: "Unfriend",
      title: "Remove them from your friends",
      onclick: () => unfriend(client, userId, user),
    })
  );
}

function bannerBox(client, userId, user, reload) {
  const parts = [isOnline(user) ? "Online" : "Offline"];
  const listening = listeningLine(user);
  if (listening) parts.push(listening);
  return h(
    "div",
    { class: "card", style: { display: "flex", flexDirection: "column", gap: "12px" } },
    h(
      "div",
      null,
      h(
        "button",
        { class: "btn flat small", onclick: () => navigate("friends", {}) },
        icon("prev", 16),
        "Back to friends"
      )
    ),
    h(
      "div",
      { style: { display: "flex", gap: "18px", alignItems: "center" } },
      avatarFor(client, user, "art big round"),
      h(
        "div",
        { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "6px" } },
        h("div", {
          style: { fontSize: "24px", fontWeight: "700", color: "var(--fg0)" },
          text: displayName(user),
        }),
        user?.username ? h("div", { class: "subtitle", text: `@${user.username}` }) : null,
        h("div", { class: "subtitle", text: parts.join(" \u00b7 ") }),
        actionsRow(client, userId, user, reload)
      )
    )
  );
}

async function toggleIgnore(client, userId, user, reload) {
  const ignored = String(user?.relationship || "") === "ignored";
  try {
    if (ignored) {
      await client.unignoreUser(userId);
      toast(`Unignored ${displayName(user)}. Their shares reach you again.`);
    } else {
      await client.ignoreUser(userId);
      toast(`Ignored ${displayName(user)}. Their shares stop reaching you.`);
    }
    await reload?.();
  } catch (error) {
    fail(error);
  }
}

async function unfriend(client, userId, user) {
  const confirmed = await confirm(
    "Unfriend?",
    `${displayName(user)} is removed from your friends.`,
    { confirm: "Unfriend", destructive: true }
  );
  if (!confirmed) return;
  try {
    await client.removeFriend(userId);
    toast(`Unfriended ${displayName(user)}.`);
    navigate("friends", {});
  } catch (error) {
    fail(error);
  }
}

// --- the page --------------------------------------------------------------

/** Render the page into `container`; the returned function re-fetches it. */
export function renderFriend(container, userId) {
  const load = async () => {
    const client = currentClient();
    if (!client) return;
    mount(container, emptyState("users", "Loading profile\u2026"));
    let detail;
    try {
      detail = await client.user(userId);
    } catch (error) {
      mount(container, emptyState("cross", "Could not load this profile", error?.message || ""));
      fail(error);
      return;
    }
    const user = detail?.user || {};
    // Their uploads are public, so they are fetched alongside the profile
    // rather than waiting on it.
    const uploads = await client.userUploads(userId).then((answer) => answer.uploads).catch(() => []);
    mount(container, bannerBox(client, userId, user, load), listsGrid(client, detail, uploads));
  };
  load();
  return load;
}

// --- listening along -------------------------------------------------------

/** The page (and the playbar's stop button) share this one follower. */
let follow = null;

/** Times arrive either as milliseconds or as seconds; both land in ms. */
function stamp(value, now = Date.now()) {
  const number = Number(value) || 0;
  if (!number) return now;
  return number < 1e12 ? number * 1000 : number;
}

/**
 * Where the friend should be by now: their saved position plus the time since
 * they saved it, capped at the length of the track. A paused friend does not
 * move, and a track that has run out stays at its end rather than looping.
 */
function expectedRemoteMs(snapshot, now, durationMs) {
  const base = Number(snapshot.positionMs) || 0;
  if (snapshot.paused) return base;
  const position = base + Math.max(0, now - snapshot.savedAt);
  return durationMs > 0 ? Math.min(position, durationMs) : position;
}

function currentDuration() {
  const fromPlayer = Number(player?.durationMs?.()) || 0;
  if (fromPlayer) return fromPlayer;
  return Number(player?.current?.()?.durationMs) || 0;
}

function subscribe(event, handler) {
  const off = player?.on?.(event, handler);
  if (typeof off === "function") return off;
  return () => player?.off?.(event, handler);
}

/**
 * Whether a room owns playback. Asking first matters: `play()` while in a room
 * would send the friend's whole queue to the room instead of playing it here.
 */
function inRoom() {
  if (typeof player?.inRoom === "function") return player.inRoom();
  return Boolean(player?.roomId?.());
}

async function startListeningAlong(user) {
  const client = currentClient();
  if (!client || !user?.id) return;
  const userId = String(user.id);
  if (follow?.userId === userId) return;
  stopFollowing();
  if (inRoom()) {
    toast("Leave the room to listen along.");
    return;
  }

  let document;
  try {
    document = await client.userPlayback(userId);
  } catch (error) {
    fail(error);
    return;
  }
  const items = (Array.isArray(document?.queue) ? document.queue : [])
    .map(queueTrack)
    .filter(Boolean);
  if (!items.length) {
    toast(`${displayName(user)} is not playing anything right now.`);
    return;
  }
  const wanted = String(document?.currentTrackId || "");
  let index = items.findIndex((track) => track.id === wanted);
  if (index < 0) index = 0;

  follow = {
    userId,
    name: displayName(user),
    client,
    queueKey: items.map((track) => track.id).join("|"),
    index,
    trackId: items[index].id,
    positionMs: Number(document?.positionMs) || 0,
    paused: Boolean(document?.paused),
    savedAt: stamp(document?.savedAt),
    unsubscribers: [],
    syncing: false,
    timer: 0,
  };
  player?.play?.(items, index);
  if (player?.current?.()?.id !== follow.trackId) {
    // A room owns what plays: the queue went there instead of here.
    follow = null;
    toast("Leave the room to listen along.");
    return;
  }
  sync();
  follow.unsubscribers.push(subscribe("position", sync), subscribe("track-changed", onTrackChanged));
  follow.timer = setInterval(poll, FOLLOW_POLL_MS);
  player?.setFollowingMode?.({ name: follow.name, onStop: () => stopFollowing(true) });
  setFollowing(follow.name);
  toast(`Listening along with ${follow.name}.`);
}

function stopFollowing(notify = false) {
  if (!follow) return;
  clearInterval(follow.timer);
  for (const off of follow.unsubscribers) {
    try {
      off();
    } catch {
      /* an unsubscriber that failed has nothing left to do */
    }
  }
  const name = follow.name;
  follow = null;
  player?.clearFollowingMode?.();
  setFollowing(null);
  if (notify) toast(`Stopped listening along with ${name}.`);
}

async function poll() {
  const current = follow;
  if (!current) return;
  let document;
  try {
    document = await current.client.userPlayback(current.userId);
  } catch (error) {
    if (follow !== current) return;
    if (error?.status === 401) {
      requireLogin();
      stopFollowing();
      return;
    }
    if (error?.status === 403 || error?.status === 404) {
      banner(`${current.name} is not sharing their playback any more.`, "error");
      stopFollowing();
      return;
    }
    return; // a blip: the loop keeps trying
  }
  if (follow !== current) return;
  applyPlayback(document);
}

function applyPlayback(document) {
  const current = follow;
  if (!current) return;
  const items = (Array.isArray(document?.queue) ? document.queue : [])
    .map(queueTrack)
    .filter(Boolean);
  if (!items.length) return;
  const wanted = String(document?.currentTrackId || "");
  let index = items.findIndex((track) => track.id === wanted);
  if (index < 0) index = 0;

  current.positionMs = Number(document?.positionMs) || 0;
  current.paused = Boolean(document?.paused);
  current.savedAt = stamp(document?.savedAt);
  current.index = index;
  current.trackId = items[index].id;

  const queueKey = items.map((track) => track.id).join("|");
  if (queueKey !== current.queueKey) {
    current.queueKey = queueKey;
    player?.play?.(items, index);
  } else if (player?.current?.()?.id !== current.trackId) {
    // They moved on to another song: skip forward to it.
    player?.jumpTo?.(index);
  }
  sync();
}

/** Put the player back on the friend's track when it has wandered off it. */
function enforceRemote() {
  const current = follow;
  if (!current) return;
  const length = player?.queue?.length || 0;
  if (current.index < 0 || current.index >= length) return;
  player?.jumpTo?.(current.index);
  sync();
}

function onTrackChanged() {
  if (!follow) return;
  if (player?.current?.()?.id === follow.trackId) return;
  enforceRemote();
}

/**
 * The tight loop: on every position tick, work out where the friend is and
 * what that asks of the player — nothing, a seek past the drift margin, or a
 * pause/resume to match them.
 */
function sync() {
  const current = follow;
  if (!current || current.syncing) return;
  const playing = player?.current?.();
  if (!playing) return;
  if (playing.id !== current.trackId) {
    enforceRemote();
    return;
  }
  const duration = currentDuration();
  const expected = expectedRemoteMs(current, Date.now(), duration);
  // Their song has run out and they have not moved on: hold silence rather
  // than loop it, and pick up again when the next one lands.
  const ended = duration > 0 && expected >= duration - END_MARGIN_MS;
  const decision = driftDecision({
    localMs: Number(player.positionMs?.()) || 0,
    remoteMs: expected,
    localPaused: Boolean(player.isPaused?.()),
    remotePaused: current.paused || ended,
    toleranceMs: DRIFT_TOLERANCE_MS,
  });
  current.syncing = true;
  try {
    if (decision.action === "pause") player.pause?.();
    else if (decision.action === "resume") player.resume?.();
    else if (decision.action === "seek") player.seek?.(decision.positionMs);
  } finally {
    current.syncing = false;
  }
}
