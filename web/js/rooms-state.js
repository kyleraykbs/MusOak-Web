// Following a room: the client half of Listen Together.
//
// The server owns the room — the queue, which song is on, where it is — and
// announces every change on `/api/v1/ws`. This module keeps our end: it holds
// the room as last described, applies the events that arrive, sends the
// commands, and re-joins on its own when the socket drops.
//
// The server is the room's clock, and the room's order and its fairness are
// the server's alone: every member follows the order it publishes - load a
// different room song, seek only when drift exceeds two seconds, and move on
// locally when the local file runs out before the room's next tick. Members
// choose their own playable version.
//
// Anything that only computes is pure: `applyEvent` and `mergeSnapshot` hand
// back a state and never touch the one they were given - the one they were
// given being the answer when an event says nothing new, which is what keeps
// the beat that republishes a room from rebuilding a view. That is also what
// lets the reducers be tested without a browser.

import { state, rememberRoom, forgetRoom, preloadAhead } from "./state.js";
import { TOLERANCE_MS, decide, driftAction, roomLength, roomPosition } from "./rooms/playback.js";
import { toast } from "./dom.js";

/** Who may drive a room. */
export const CONTROLS_HOST = "host";
export const CONTROLS_EVERYONE = "everyone";

/** The event names the server publishes. */
export const EVENTS = {
  memberJoined: "member_joined",
  memberLeft: "member_left",
  hostChanged: "host_changed",
  queueUpdated: "queue_updated",
  playback: "playback",
  roomClosed: "room_closed",
  pong: "pong",
};

/** How far this client may run from the room's position before it seeks. */
export const DRIFT_TOLERANCE_MS = TOLERANCE_MS;

/** How often the local player is checked against the room's position. */
export const FOLLOW_TICK_MS = 500;

/** Where the reconnect backoff starts and how far it grows. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15000;

/** How long a connection must last before the backoff is reset. A drop after
 *  this is a fresh outage; a drop before it is the same one continuing. */
const RECONNECT_STABLE_MS = 10000;

/** A burst of events costs one snapshot refetch, not one each. */
const RESYNC_DEBOUNCE_MS = 400;

/** How often the server clock is sampled while a room is followed. */
export const CLOCK_RESYNC_MS = 15000;

/** How many clock samples to keep, and how many pings to send in a burst. The
 *  offset is taken from the quickest of the recent samples: the arithmetic
 *  assumes a symmetric trip, so a pong that took the long way round is the one
 *  most likely to be wrong. */
const CLOCK_SAMPLES = 5;
const CLOCK_BURST = 3;

/** How long a track whose sources could not be read is left alone. */
const RESOLVE_BACKOFF_MS = 5000;
/** How long a song this client cannot play is left alone at its worst. A song
 *  whose source the server cannot find is not found by asking again every five
 *  seconds: the search behind each ask is a provider round trip, and the room's
 *  own status line says the same thing each time. The wait doubles per try, so
 *  the first few are quick (a provider having a bad minute is common) and a song
 *  that is really unplayable settles into one ask every five minutes. */
const RESOLVE_BACKOFF_MAX_MS = 5 * 60 * 1000;

const DEFAULT_SKIP = {
  skipThreshold: 2,
  minVotersForSkip: 2,
  voterFractionForSkip: 0.5,
};

function num(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function str(value) {
  return value === null || value === undefined ? "" : String(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

// --- shapes ----------------------------------------------------------------

/** One entry of a room's queue. */
export function normalizeItem(raw) {
  const source = raw || {};
  return {
    id: str(source.id),
    trackId: str(source.trackId),
    title: str(source.title),
    addedBy: str(source.addedBy),
    addedAtMs: num(source.addedAtMs),
    durationMs: num(source.durationMs),
    artworkUrl: str(source.artworkUrl),
    artistIds: list(source.artistIds).map(str),
    artists: list(source.artists).map(str),
  };
}

/** One participant in a room. */
export function normalizeMember(raw) {
  const source = raw || {};
  return {
    id: str(source.id),
    name: str(source.name),
    userId: str(source.userId),
    joinedAtMs: num(source.joinedAtMs),
    iconUrl: str(source.iconUrl),
    iconVersion: num(source.iconVersion),
  };
}

/**
 * The song the room is on, and where it is.
 *
 * `positionMs` is the position at `atMs` on the server clock: while `started`
 * is true and `paused` is false the room is at
 * `positionMs + (serverNow - atMs)`. Until the room has begun the song
 * (`started` false) the room holds it at `positionMs`, which is zero.
 */
export function normalizeCurrent(raw) {
  if (!raw) return null;
  const item = raw.item && (raw.item.id || raw.item.trackId) ? normalizeItem(raw.item) : null;
  if (!item) return null;
  return {
    item,
    positionMs: num(raw.positionMs),
    atMs: num(raw.atMs),
    started: Boolean(raw.started),
    paused: Boolean(raw.paused),
    durationMs: num(raw.durationMs) || num(item.durationMs),
    votes: { ...(raw.votes || {}) },
    meanScore: num(raw.meanScore),
  };
}

/** `{memberId: [item]}` — what each member has queued, in their own order. */
export function normalizeQueues(raw) {
  const queues = {};
  for (const [memberId, items] of Object.entries(raw || {})) {
    queues[str(memberId)] = list(items).map(normalizeItem);
  }
  return queues;
}

function normalizeSkip(raw) {
  if (!raw) return { ...DEFAULT_SKIP };
  return {
    skipThreshold: raw.skipThreshold === undefined ? DEFAULT_SKIP.skipThreshold : num(raw.skipThreshold),
    minVotersForSkip: num(raw.minVotersForSkip, DEFAULT_SKIP.minVotersForSkip),
    voterFractionForSkip: num(raw.voterFractionForSkip, DEFAULT_SKIP.voterFractionForSkip),
  };
}

/**
 * A room's state, empty but well-formed. The connection fields (`me`,
 * `connected`, `error`) belong to the client, not the server.
 */
export function createRoomState(initial = {}) {
  return {
    roomId: "",
    name: "",
    host: "",
    controls: CONTROLS_HOST,
    createdAtMs: 0,
    members: [],
    memberCount: 0,
    hasPassword: false,
    queues: {},
    masterQueue: [],
    current: null,
    skip: { ...DEFAULT_SKIP },
    serverNowMs: 0,
    serverOffsetMs: 0,
    clockSamples: [],
    seq: 0,
    me: "",
    connected: false,
    error: "",
    roomClosed: false,
    ...initial,
  };
}

/** Read a room document — a snapshot, or the `room` of a join answer. */
export function normalizeSnapshot(raw) {
  const room = (raw && raw.room) || raw || {};
  const members = list(room.members).map(normalizeMember);
  return {
    roomId: str(room.id),
    name: str(room.name),
    host: str(room.host),
    controls: room.controls === CONTROLS_EVERYONE ? CONTROLS_EVERYONE : CONTROLS_HOST,
    createdAtMs: num(room.createdAtMs),
    members,
    memberCount: num(room.memberCount, members.length),
    hasPassword: Boolean(room.hasPassword),
    queues: normalizeQueues(room.queues),
    masterQueue: list(room.masterQueue).map(normalizeItem),
    current: normalizeCurrent(room.current),
    skip: normalizeSkip(room.skip),
    serverNowMs: num(room.serverNowMs),
    seq: num(room.seq),
  };
}

/** Take the server's word for the room, keeping what belongs to this client. */
export function mergeSnapshot(state, raw) {
  const snapshot = normalizeSnapshot(raw);
  // A REST answer can race a newer socket event. Never let a response that was
  // in flight first roll the room back after that event has already arrived.
  if (state.roomId && snapshot.roomId === state.roomId && state.seq && snapshot.seq && snapshot.seq < state.seq) {
    return state;
  }
  const merged = { ...state, ...snapshot };
  return { ...merged, error: "", roomClosed: false };
}

// --- the reducer -----------------------------------------------------------

/** A member's queue as the event leaves it, or null when they left. */
function queuesFrom(queues, data) {
  const memberId = str(data.memberId);
  if (!memberId) return data.queues === undefined ? queues : normalizeQueues(data.queues);
  const next = { ...queues };
  if (data.gone) delete next[memberId];
  else next[memberId] = list(data.memberQueue).map(normalizeItem);
  return next;
}

/** Remove one played item from its owner's queue, in place of a fresh copy. */
function dropItem(queues, item) {
  const owner = str(item && item.addedBy);
  const items = queues[owner];
  if (!items) return queues;
  const next = items.filter((entry) => entry.id !== item.id);
  if (next.length === items.length) return queues;
  return { ...queues, [owner]: next };
}

/** The room's place in the song it is on, as one number. A running song is
 *  anchored at a position and a server time that move on together, so the pair
 *  is what stays still; a paused or unstarted song is held at its position and
 *  its `at` says nothing. */
function anchorOf(current) {
  return current.started && !current.paused ? current.positionMs - current.atMs : current.positionMs;
}

/** Whether two readings are the same tally of scores: a beat republishes the
 *  votes it already gave, in a fresh object. */
function sameVotes(left, right) {
  const keys = Object.keys(left || {});
  if (keys.length !== Object.keys(right || {}).length) return false;
  return keys.every((key) => left[key] === right[key]);
}

/** Whether two readings of the room's current song say the same thing.
 *
 *  This is the heartbeat's question: comparing `positionMs` alone would call
 *  every beat a change, because a running song's position is re-reported a
 *  second later as the position it has since reached. The anchor is compared
 *  instead, so a start, a pause, a resume, a seek or a vote is a change and the
 *  beat that merely republishes is not. */
function sameCurrent(previous, current) {
  if (!previous || !current) return previous === current;
  if (previous.item.id !== current.item.id) return false;
  if (previous.item.title !== current.item.title) return false;
  if (previous.item.artworkUrl !== current.item.artworkUrl) return false;
  if (previous.started !== current.started || previous.paused !== current.paused) return false;
  if (previous.durationMs !== current.durationMs) return false;
  if (!sameVotes(previous.votes, current.votes)) return false;
  return anchorOf(previous) === anchorOf(current);
}

/**
 * One event, applied to the room as we knew it. Returns the same object when
 * the event says nothing new: an unknown type, another room's event, or the
 * beat that republishes the position of the song the room is already on.
 */
export function applyEvent(state, event) {
  const type = str(event && event.type);
  const data = event && typeof event.data === "object" && event.data !== null ? event.data : {};
  const roomId = str(event && event.roomId);
  if (roomId && state.roomId && roomId !== state.roomId) return state;
  const seq = num(event && event.seq);
  const stamp = seq ? { seq } : {};

  switch (type) {
    case EVENTS.queueUpdated: {
      const queues = queuesFrom(state.queues, data);
      // The room's order is the server's to know, and it sends it with every
      // queue it touches. It is taken exactly as it came: a client that works
      // one out for itself comes out with a different order - the server's
      // fairness is its own - and then it advances to a song the room never
      // chose while the room's next beat pulls it back to the one it did.
      // A payload without one predates the field: the order we have is kept
      // rather than invented.
      const master = Array.isArray(data.master) ? data.master.map(normalizeItem) : null;
      return { ...state, ...stamp, queues, masterQueue: master || state.masterQueue };
    }

    case EVENTS.memberJoined: {
      const member = data.member ? normalizeMember(data.member) : null;
      if (!member || !member.id) return state;
      const members = upsertMember(state.members, member);
      const queues = state.queues[member.id] ? state.queues : { ...state.queues, [member.id]: [] };
      // The order is not touched here: a member arriving changes it only in the
      // server's reckoning, which follows in the queue event it publishes.
      return {
        ...state,
        ...stamp,
        members,
        queues,
        memberCount: data.memberCount === undefined ? members.length : num(data.memberCount, members.length),
        host: str(data.host) || state.host,
      };
    }

    case EVENTS.memberLeft: {
      const memberId = str(data.memberId);
      if (!memberId) return state;
      const members = state.members.filter((member) => member.id !== memberId);
      const queues = { ...state.queues };
      delete queues[memberId];
      // Same as a join: the server publishes the order the leaving member
      // changes as a queue event of its own, and that is the one to keep.
      return {
        ...state,
        ...stamp,
        members,
        queues,
        memberCount: data.memberCount === undefined ? members.length : num(data.memberCount, members.length),
      };
    }

    case EVENTS.hostChanged: {
      const host = str(data.host);
      if (!host || host === state.host) return state;
      // Who leads decides who may drive and whose player is the clock, so it is
      // not something a view can wait for the next snapshot to find out.
      return { ...state, ...stamp, host };
    }

    case EVENTS.playback: {
      const current = normalizeCurrent(data.current);
      const previous = state.current;
      // The heartbeat is this event: the server republishes the song it is on,
      // and the anchor it carries, about once a second. Between beats the
      // position is derived from the anchor rather than carried by an event, so
      // a beat that says the same song at the same point says nothing a view can
      // show - and returning the state we were given is what keeps a page from
      // rebuilding its whole DOM every second, losing its scroll and its focus
      // with it.
      if (sameCurrent(previous, current)) return state;
      const changed = !previous || !current || previous.item.id !== current.item.id;
      if (!changed) {
        // The same song, moved: a start, a pause, a resume, a seek or a vote.
        return { ...state, ...stamp, current };
      }
      // The room moved off that song, so the played item leaves its owner's
      // queue — the same drop the server just did. The order loses both the
      // song that ended and the one that began: the server takes a song out of
      // the order as it becomes the current one, so the order is what is yet to
      // come and never the song on. It is filtered, never rebuilt: a rebuilt
      // order is a different order, and a member following one plays a song the
      // room never chose.
      const queues = previous ? dropItem(state.queues, previous.item) : state.queues;
      const gone = new Set([str(previous && previous.item.id), str(current && current.item.id)]);
      const masterQueue = state.masterQueue.filter((entry) => !gone.has(str(entry.id)));
      return { ...state, ...stamp, current, queues, masterQueue };
    }

    case EVENTS.pong: {
      // The pong's stamps are the message's own fields, not a payload: the
      // reply carries clientSentAt, serverReceivedAt and serverSentAt beside
      // the type. A pong with no clientSentAt answers the socket's own
      // heartbeat, which is not a clock sample at all - measuring one says the
      // round trip took however long the page has been open.
      const sent = num(event.clientSentAt);
      const received = num(event.clientReceivedAt);
      const serverReceived = num(event.serverReceivedAt);
      if (!sent || !received || !serverReceived) return state;
      const sample = offsetFrom(sent, received, serverReceived);
      const rtt = Math.max(0, received - sent);
      const samples = [...state.clockSamples, { offset: sample, rtt }].slice(-CLOCK_SAMPLES);
      // The quickest trip is the least noisy estimate, and the quickest trip on
      // a loopback is under a millisecond: zero is the best sample there is, not
      // one to skip.
      const best = samples.reduce((winner, entry) => (!winner || entry.rtt < winner.rtt ? entry : winner), null);
      return { ...state, clockSamples: samples, serverOffsetMs: best ? best.offset : sample };
    }

    default:
      return state;
  }
}

/** A member by id, added or replaced. */
function upsertMember(members, member) {
  const index = members.findIndex((existing) => existing.id === member.id);
  if (index === -1) return [...members, member];
  const next = members.slice();
  next[index] = { ...members[index], ...member };
  return next;
}

/** Parse a server pong into the offset it implies. */
export function offsetFrom(clientSentAt, clientReceivedAt, serverReceivedAt) {
  // NTP's arithmetic: the server stamped its receive halfway through the trip.
  return Math.round(num(serverReceivedAt) - (num(clientSentAt) + num(clientReceivedAt)) / 2);
}

// --- what a view asks the state --------------------------------------------

/** A member's display name, falling back to a readable piece of their id. */
export function nameOf(state, memberId) {
  const id = str(memberId);
  const member = state.members.find((entry) => entry.id === id);
  if (member && member.name) return member.name;
  return id ? id.slice(0, 8) : "someone";
}

/** Whether one member may pause, skip or seek here. */
export function mayDrive(state, memberId) {
  return state.controls === CONTROLS_EVERYONE || state.host === str(memberId);
}

/** Whether this member is the room's host: who may pause, skip or seek. */
export function isHost(room) {
  const me = str(room && room.me);
  return Boolean(me) && me === str(room && room.host);
}

/** One member's own queue: what they queued, in the order they want it. */
export function myQueue(state, memberId = state.me) {
  return state.queues[str(memberId)] || [];
}

/** Who is on deck according to the fair mix, as a set of member ids. */
export function masterOwners(state) {
  return state.masterQueue.map((item) => item.addedBy);
}

/** The room's play order with the current song taken out: what comes next. */
export function pendingQueue(state) {
  const currentId = state.current ? state.current.item.id : "";
  return state.masterQueue.filter((item) => item.id !== currentId);
}

/**
 * The room's position at a wall-clock instant. `nowMs` is this machine's clock;
 * the offset moves it onto the server's, which is the clock the position is
 * measured in.
 */
export function positionMs(state, nowMs = Date.now()) {
  if (!state.current) return 0;
  // The arithmetic is the core's, next to the drift rule that measures against
  // it and the transition that uses it: one implementation of where the room
  // is, not two that can disagree.
  return roomPosition(state.current, num(nowMs) + num(state.serverOffsetMs));
}

/** How long the current song runs for, as the room knows it. */
export function durationMs(state) {
  return roomLength(state.current);
}

/** Move one id to just before `beforeId` (or to the end when it is empty). */
export function moveItem(itemIds, movedId, beforeId = "") {
  const ids = list(itemIds).map(str);
  if (!ids.includes(movedId)) return ids;
  const rest = ids.filter((id) => id !== movedId);
  const index = beforeId && rest.includes(beforeId) ? rest.indexOf(beforeId) : rest.length;
  rest.splice(index, 0, movedId);
  return rest;
}

/**
 * What to do about the local position: `"hold"` while it is within the
 * tolerance, otherwise `"back"` or `"forward"` — the seek that closes the gap.
 * The rule itself lives in rooms/playback.js, next to the clock it measures
 * against; this keeps the name the app has always asked it by.
 */
export function driftDecision(localMs, roomMs, toleranceMs = DRIFT_TOLERANCE_MS) {
  return driftAction(localMs, roomMs, { toleranceMs, cooldownMs: 0 });
}

// --- the connection --------------------------------------------------------

let active = null;
let resyncTimer = 0;
let closedReason = "";
const listeners = new Set();

/** The room being followed, or null. */
export function currentRoom() {
  return active ? active.state : null;
}

/**
 * Which view the Rooms tab opens: the room being followed, or the list.
 */
export function roomsTabTarget() {
  if (state.roomsShowing === "list") return "rooms";
  return currentRoom() ? "room" : "rooms";
}

/** Why the last room ended, when the server ended it. */
export function closedRoomReason() {
  return closedReason;
}

/** Watch the followed room; the handler is called with its state on change. */
export function subscribe(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/**
 * Forget that this item could not be resolved, so the next beat works its
 * source out again.
 *
 * What calls it is an association: the song has a source now, and asking for it
 * is a provider round trip the back-off would otherwise refuse. It does nothing
 * unless the room is still on that item - the song it was asked about is the
 * one that has to be re-resolved, not whatever is playing by the time somebody
 * has answered.
 */
export function retryItem(itemId = "") {
  const running = plugin;
  if (!running) return;
  const id = str(itemId) || str(running.itemId);
  if (!id || str(running.itemId) !== id) return;
  if (str(running.failedItemId) === id) {
    running.failedItemId = "";
    running.failedAt = 0;
  }
  running.failedTries?.delete(id);
  // It failed before it was ever put on the player, so the item goes back to
  // unresolved and the next beat resolves it and hands it over.
  running.loadedItemId = "";
  running.variantId = "";
  running.track = null;
}

function publish() {
  const room = currentRoom();
  for (const handler of [...listeners]) {
    try {
      handler(room);
    } catch (error) {
      console.error("room listener failed", error);
    }
  }
}

function setState(next) {
  if (!active) return;
  active.state = next;
  publish();
}

/**
 * Join a room and start following it. Returns its state; throws the server's
 * error (a wrong password is a 403 with its message) when joining fails.
 */
export async function enterRoom({ client, roomId, password = "", onLeave = null, rejoin = false } = {}) {
  if (!client) throw new Error("choose a server first");
  const id = str(roomId);
  if (!id) throw new Error("choose a room first");
  if (!rejoin && active && active.client === client && active.roomId === id) return active.state;

  // Join first, and only then let go of the room we were in: a wrong password
  // must not cost you the room you are already following.
  const payload = await client.joinRoom(id, password);
  if (active) closeRoom();

  const joined = (payload && payload.room) || {};
  const memberId = str(payload && payload.memberId) || str(client.memberId);
  if (memberId && client.memberId !== memberId) client.memberId = memberId;
  closedReason = "";
  active = {
    client,
    roomId: str(joined.id) || id,
    password,
    onLeave,
    socket: null,
    retryTimer: 0,
    clockTimer: 0,
    attempts: 0,
    openedAt: 0,
    closed: false,
    // The last seq the socket was told, which the state does not keep for the
    // beats that change nothing (see onMessage). The room's own seq, from the
    // join answer, is where the stream starts.
    seq: 0,
    state: createRoomState({ me: memberId, connected: false }),
  };
  active.state = mergeSnapshot(active.state, joined);
  active.seq = num(active.state.seq);
  // So a reload can put us back in this room, and the bar can say which one.
  rememberRoom({ roomId: active.roomId, name: str(joined.name), password });
  connect(active);
  publish();
  return active.state;
}

/**
 * Join the room we are already in again, so the server sees who we are now.
 *
 * A membership is made at the join: its name and picture come from the account
 * when the request carried one, and from the browser's own name when it did
 * not. Signing in therefore has to re-join, or the room keeps calling somebody
 * "web" with no picture for as long as they stay in it.
 */
export async function rejoinRoom() {
  if (!active) return null;
  const { client, roomId, password, onLeave } = active;
  return enterRoom({ client, roomId, password, onLeave, rejoin: true });
}

/** Stop following the room and forget it, without asking the server. */
export function closeRoom(reason = "") {
  const connection = active;
  if (!connection) return;
  active = null;
  // A room we are no longer in is not one to rejoin on the next reload.
  forgetRoom();
  connection.closed = true;
  clearTimeout(connection.retryTimer);
  connection.retryTimer = 0;
  stopClock(connection);
  clearTimeout(resyncTimer);
  resyncTimer = 0;
  closedReason = str(reason);
  // The room is over for this page, so the player is given back. Detaching the
  // follower is not enough: it only unlinks the room (and the unmount path must
  // not stop the music while the room is still being followed), so what the
  // room put on would otherwise keep playing as if this page had chosen it -
  // which is how a song from a room already left is heard in the next one.
  if (plugin?.player?.inRoom?.()) plugin.player.clearRoom();
  plugin?.player?.clear?.();
  try {
    connection.socket?.close?.();
  } catch {
    /* the socket is already gone */
  }
  try {
    connection.onLeave?.();
  } catch (error) {
    console.error("room leave handler failed", error);
  }
  publish();
}

/** Leave the room: close the socket, drop the membership here and on the server. */
export async function leaveRoom({ client = null, roomId = "" } = {}) {
  const connection = active;
  const target = str(roomId) || (connection ? connection.roomId : "");
  const api = client || (connection ? connection.client : null);
  const mine = Boolean(connection && connection.roomId === target);
  if (mine) closeRoom();
  if (!api || !target) return;
  await api.leaveRoom(target);
}

export function connect(connection = active) {
  if (!connection || connection.closed) return null;
  connection.socket = connection.client.roomSocket({
    roomId: connection.roomId,
    onOpen: () => {
      if (active !== connection) return;
      connection.openedAt = Date.now();
      setState({ ...connection.state, connected: true, error: "" });
      syncClock(connection);
    },
    onEvent: (message) => {
      if (active === connection) onMessage(connection, message);
    },
    onClose: () => {
      stopClock(connection);
      if (active === connection) scheduleReconnect(connection);
    },
  });
  return connection.socket;
}

/** Ask the server for its clock; the pong that comes back carries the offset. */
function syncClock(connection) {
  for (let i = 0; i < CLOCK_BURST; i += 1) connection.socket?.send?.("ping", { clientSentAt: Date.now() });
  if (connection.clockTimer) return;
  connection.clockTimer = setInterval(() => {
    if (active !== connection || !connection.state.connected) {
      stopClock(connection);
      return;
    }
    connection.socket?.send?.("ping", { clientSentAt: Date.now() });
  }, CLOCK_RESYNC_MS);
}

function stopClock(connection) {
  clearInterval(connection.clockTimer);
  connection.clockTimer = 0;
}

function onMessage(connection, message) {
  const type = str(message && message.type);
  if (!type) return;
  const event = {
    type,
    roomId: str(message.roomId),
    seq: num(message.seq),
    atMs: num(message.atMs),
    data: message.data,
    clientSentAt: message.clientSentAt,
    serverReceivedAt: message.serverReceivedAt,
    // Stamped here, where the frame actually arrived: the reducer may run a
    // tick later, and that delay is not the network's.
    clientReceivedAt: Date.now(),
  };
  const mine = !event.roomId || !connection.state.roomId || event.roomId === connection.state.roomId;
  if (type === EVENTS.roomClosed && mine) {
    closeRoom("the room was closed");
    return;
  }
  // A gap means events were missed and the derived play order may be wrong: the
  // snapshot is the way back. It is measured against the last seq *seen*, not
  // the last one that changed anything - the heartbeat spends a seq every second
  // folding into the state it already had (see applyEvent) - and against the
  // seq a snapshot left the state at, which is where a rejoin starts from.
  const knownSeq = Math.max(num(connection.seq), num(connection.state.seq));
  const missed = Boolean(mine && event.seq && knownSeq && event.seq !== knownSeq + 1);
  if (event.seq) connection.seq = event.seq;
  if (missed) scheduleResync(connection);
  const next = applyEvent(connection.state, event);
  if (next !== connection.state) {
    connection.state = next;
    publish();
  }
}

function scheduleResync(connection) {
  if (resyncTimer) return;
  resyncTimer = setTimeout(() => {
    resyncTimer = 0;
    if (active !== connection) return;
    refreshRoom().catch((error) => {
      if (error && error.status === 401) return;
      setState({ ...connection.state, error: `could not refresh the room: ${error.message}` });
    });
  }, RESYNC_DEBOUNCE_MS);
}

function scheduleReconnect(connection) {
  if (!connection || connection.closed || connection.retryTimer) return;
  // A connection that stayed up is a connection that worked, so the backoff
  // starts again from the bottom. One that dropped straight away does not reset
  // it: a flaky link, or a proxy that hangs up after a second, would otherwise
  // retry every half second for the rest of the session.
  const lasted = Date.now() - num(connection.openedAt);
  if (connection.openedAt && lasted >= RECONNECT_STABLE_MS) connection.attempts = 0;
  connection.attempts += 1;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (connection.attempts - 1), RECONNECT_MAX_MS);
  setState({
    ...connection.state,
    connected: false,
    error: `lost the room connection; retrying in ${Math.max(1, Math.round(delay / 1000))}s`,
  });
  connection.retryTimer = setTimeout(() => {
    connection.retryTimer = 0;
    rejoin(connection);
  }, delay);
}

/** A dropped socket is rejoined: the room is the server's, we only resume it. */
async function rejoin(connection) {
  if (!connection || connection.closed || active !== connection) return;
  try {
    const payload = await connection.client.joinRoom(connection.roomId, connection.password);
    if (active !== connection || connection.closed) return;
    const memberId = str(payload && payload.memberId);
    if (memberId) connection.client.memberId = memberId;
    connection.state = mergeSnapshot(connection.state, (payload && payload.room) || {});
    publish();
  } catch (error) {
    const status = num(error && error.status);
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      closeRoom(`could not rejoin the room: ${error.message}`);
      return;
    }
    scheduleReconnect(connection);
    return;
  }
  connect(connection);
}


function foldRoomAnswer(connection, payload) {
  if (active !== connection || !payload || typeof payload !== "object") return currentRoom();
  const room = payload.room || payload;
  if (!room.id) return currentRoom();
  setState(mergeSnapshot(connection.state, room));
  return currentRoom();
}

/** Refetch the room: what the events only summarised. */
export async function refreshRoom() {
  if (!active) return null;
  const connection = active;
  const snapshot = await connection.client.room(connection.roomId);
  if (active !== connection) return currentRoom();
  setState(mergeSnapshot(connection.state, snapshot));
  return currentRoom();
}

// --- commands --------------------------------------------------------------
//
// Room commands are REST calls — the server answers each with the room as it
// now stands — while the socket carries the events that follow. They go
// through the client's own named wrappers, and the answer is merged straight
// away so the page moves without waiting for its own event.

function requireConnection() {
  if (!active) throw new Error("you are not in a room");
  return active;
}

/** Run one room command and fold its answer — the room — into the state. */
async function command(run) {
  const connection = requireConnection();
  const payload = await run(connection);
  if (active !== connection) return currentRoom();
  foldRoomAnswer(connection, payload);
  return currentRoom();
}

/** Add one track to your own queue; the room starts it when it is idle. */
export function enqueue(track) {
  const trackId = typeof track === "string" ? track : str(track && track.id);
  if (!trackId) throw new Error("a track to queue is required");
  return command(({ client, roomId }) => client.roomEnqueue(roomId, trackId));
}

/** Add a list of tracks to your queue, as one edit. */
export function enqueueMany(tracks) {
  const items = Array.isArray(tracks) ? tracks : [tracks];
  const ids = items.map((track) => (typeof track === "string" ? track : str(track && track.id))).filter(Boolean);
  if (!ids.length) return Promise.resolve(currentRoom());
  return command(({ client, roomId }) => client.roomEnqueue(roomId, ids));
}

/** Drop one item of your queue. */
export function remove(itemId) {
  if (!itemId) throw new Error("an item to remove is required");
  return command(({ client, roomId }) => client.roomRemove(roomId, itemId));
}

/** Your queue, in the order you want it: `itemIds` must be a permutation. */
export function reorder(itemIds) {
  return command(({ client, roomId }) => client.roomReorder(roomId, list(itemIds).map(str)));
}

/** Empty your queue — the server's own answer, 204 or the room. */
export function clear() {
  return command(({ client, roomId }) => client.roomClearQueue(roomId));
}

export function pause() {
  return command(({ client, roomId }) => client.roomPause(roomId));
}

export function resume() {
  return command(({ client, roomId }) => client.roomResume(roomId));
}

export function skip() {
  return command(({ client, roomId }) => client.roomSkip(roomId));
}

/**
 * Move the room's position, and this member's own file with it.
 *
 * A room owns the position, so the seek is asked of the room — but the answer
 * is a room position, not a moved file. Without this the member's own audio
 * stays where it was and only the room's idea of where they are has changed,
 * which reads as a seek that did nothing.
 */
export function seek(positionMs = 0) {
  const target = Math.max(0, Math.round(num(positionMs)));
  return command(({ client, roomId }) => client.roomSeek(roomId, target)).then((answer) => {
    plugin?.player?.seek?.(target);
    return answer;
  });
}

/** A score from 0.1 (bad) to 5 (great). */
export function vote(score, options = {}) {
  const value = Math.min(5, Math.max(0.1, Math.round(num(score) * 10) / 10));
  return command(({ client, roomId }) => client.roomVote(roomId, value, options));
}

/** Cast the current user's saved rating once when a new room item starts. */
export function autoVoteCurrent(room, { autoSkip = false } = {}) {
  const item = room?.current?.item;
  const rating = state.favorites instanceof Map ? state.favorites.get(str(item?.trackId)) : null;
  if (!item || rating == null) return Promise.resolve(null);
  return command(({ client, roomId }) => client.roomVote(roomId, rating, { autoSkip }));
}

// --- following the room with the player ------------------------------------
//
// The server is the room's clock: it publishes the current song and position
// about once a second and advances the queue on its own. Every member follows
// the same way — load a different song, seek only when drift exceeds two
// seconds, and, when the local file runs out before the room's next tick
// arrives, move on to the next song of the room's order locally rather than
// waiting. The "host" only decides who may pause, skip or seek.

let plugin = null;


/**
 * Put a player under the room's orders: while a room is followed it plays what
 * the room plays, and it is released — `player.clearRoom()` — when the room
 * ends. Returns a function that detaches it again.
 */
export function followWithPlayer(playbackPlayer) {
  detachPlugin();
  if (!playbackPlayer) return () => {};
  plugin = {
    player: playbackPlayer,
    timer: 0,
    offs: [],
    unsub: null,
    itemId: "",
    loadedItemId: "",
    resolving: "",
    roomId: "",
    advancedPast: new Set(),
    warmedKey: "",
    loadedAtMs: 0,
    lastCorrectMs: 0,
    status: "",
    syncing: false,
    pending: false,
  };
  for (const event of ["position", "state-changed", "track-changed"]) {
    const off = playbackPlayer.on?.(event, requestSync);
    if (typeof off === "function") plugin.offs.push(off);
  }
  plugin.unsub = subscribe(() => {
    ensureTicker();
    requestSync();
  });
  ensureTicker();
  return detachPlugin;
}

function detachPlugin() {
  const gone = plugin;
  if (!gone) return;
  plugin = null;
  stopTicker(gone);
  for (const off of gone.offs) {
    try {
      off();
    } catch {
      /* the player is already gone */
    }
  }
  try {
    gone.unsub?.();
  } catch {
    /* the state is already gone */
  }
}

/** Keep the follow ticker running exactly while a room is followed. */
function ensureTicker() {
  if (!plugin) return;
  if (active && !plugin.timer) plugin.timer = setInterval(requestSync, FOLLOW_TICK_MS);
  else if (!active) stopTicker(plugin);
}

function stopTicker(target) {
  if (!target) return;
  clearInterval(target.timer);
  target.timer = 0;
}

/** Ask for one follow step; ticks that overlap collapse into one. */
function requestSync() {
  const running = plugin;
  if (!running) return;
  if (running.syncing) {
    // A state change that lands mid-step is not lost: run again right after.
    running.pending = true;
    return;
  }
  running.syncing = true;
  Promise.resolve()
    .then(() => followRoom(running))
    .catch((error) => console.error("room playback failed", error))
    .finally(() => {
      if (plugin !== running) return;
      running.syncing = false;
      if (running.pending) {
        running.pending = false;
        requestSync();
      }
    });
}

/** Say what is happening while it happens, and say it once: a tick that finds
 *  the same thing again has nothing new to report. */
function setStatus(running, message) {
  const text = str(message);
  if (running.status === text) return;
  running.status = text;
  sayStatus(text);
}

/** What to say when the browser will not start the sound: the one hint that
 *  turns "the room is stuck" into "click once". */
function blockedHint(player) {
  return player.isBlocked?.() ? "Your browser is holding playback: click the page once to start the sound." : "";
}

/** Forget what the player knew about the song it was following. */
function forgetTrack() {
  if (!plugin) return;
  plugin.itemId = "";
  plugin.loadedItemId = "";
  plugin.resolving = "";
  plugin.loadedAtMs = 0;
}

/** Whether the room's own order still holds a queue item of this id. */
function holdsItem(order, id) {
  return order.some((entry) => str(entry.id) === str(id));
}

/** Drop bookkeeping for room items that no longer exist. */
function pruneBookkeeping(running, room) {
  const current = room.current && room.current.item ? room.current.item : null;
  const order = current ? [current, ...list(room.masterQueue)] : list(room.masterQueue);
  for (const itemId of running.advancedPast) {
    if (!holdsItem(order, itemId)) running.advancedPast.delete(itemId);
  }
  for (const key of saidSteps) {
    const itemId = key.slice(key.indexOf(":") + 1);
    if (!holdsItem(order, itemId)) saidSteps.delete(key);
  }
}

/** One follow step: read the room and the player, let the core decide (see
 *  rooms/playback.js), and do what it says. Every reading about the player
 *  arrives as data; the decision itself is arithmetic elsewhere, where it can
 *  be tested without a socket, a player or a room. */
async function followRoom(running) {
  const player = running.player;
  const room = currentRoom();
  if (!room || room.roomClosed) {
    if (player.inRoom?.()) player.clearRoom();
    forgetTrack();
    return;
  }
  ensureRoomMode(player, room);
  // A different room is a different order: what this client advanced past in
  // the last one says nothing here.
  if (running.roomId !== room.roomId) {
    running.roomId = room.roomId;
    running.advancedPast.clear();
  }
  // Everything this client remembers is about a song the room still has, and a
  // song that has left makes it stale: left alone, the memory of a session is
  // one entry per song the room has ever played.
  pruneBookkeeping(running, room);

  const current = room.current || null;
  const item = current && current.item ? current.item : null;
  if (!item) {
    // A room with nothing on is not a room whose song this page should keep
    // wearing: what is on the element is whatever was there before - another
    // room's song, or the user's own - and it is let go of rather than left
    // sitting in the bar looking like this room's (and outliving every room
    // after it). Unlinking the room is not enough: that leaves the audio.
    forgetTrack();
    running.advancedPast.clear();
    setStatus(running, "");
    if (player.current?.()) player.clear?.();
    if (!player.isPaused()) player.pause();
    return;
  }

  const trackId = str(item.trackId);
  const itemId = str(item.id) || trackId;
  if (!trackId) return;

  // The room's next songs, on this device and in memory: what makes the next
  // transition instant is having been fetched while this one played.
  warmAhead(running, room, itemId);

  // With nothing reachable there is nothing to resolve and nothing to measure
  // drift against: the order and the copies this page holds are what is left.
  if (!player.online?.()) {
    setStatus(running, "");
    followOfflineRoom(running, room);
    return;
  }

  const onTrack = player.current()?.id === trackId;
  const media = player.state() || {};
  const now = Date.now();
  const answer = decide({
    state: room,
    current,
    itemId: running.itemId,
    loaded: onTrack && running.loadedItemId === itemId,
    loading: onTrack && Boolean(media.loading || media.buffering),
    loadLabel: onTrack ? player.downloadLabel?.() || "" : "",
    playing: !player.isPaused(),
    autoplay: Boolean(current.started) && !current.paused,
    localPositionMs: player.positionMs?.() || 0,
    measuredMs: player.measuredDurationMs?.() || 0,
    ended: Boolean(player.hasEnded?.()),
    blocked: Boolean(player.isBlocked?.()),
    serverNowMs: now + num(room.serverOffsetMs),
    nowMs: now,
    loadedAtMs: running.loadedAtMs,
    sinceCorrectMs: running.lastCorrectMs ? now - running.lastCorrectMs : Infinity,
    advancedPast: running.advancedPast,
  });

  switch (answer.action) {
    case "load":
    case "advance": {
      // The transition is the client's: the item this member finished is marked
      // before anything else, because every tick is racing the room's own
      // advance and the mark is what keeps the two from fighting.
      let target = item;
      let at = answer.positionMs;
      let autoplay = Boolean(answer.autoplay);
      if (answer.action === "advance") {
        running.advancedPast.add(str(answer.fromItemId));
        target = list(room.masterQueue).find((entry) => str(entry.id) === str(answer.itemId)) || null;
        at = 0;
        autoplay = true;
      }
      if (!target) {
        if (!player.isPaused()) player.pause();
        return;
      }
      await loadItem(running, target, { positionMs: at, autoplay });
      return;
    }
    case "wait":
    case "pause":
      setStatus(running, "");
      if (!player.isPaused()) player.pause();
      return;
    case "resume": {
      // The one hint that turns "the room is stuck" into "click once".
      const held = answer.blocked ? blockedHint(player) : "";
      setStatus(running, held);
      if (player.hasEnded?.()) player.seek(answer.positionMs ?? positionMs(room, Date.now()));
      player.resume();
      return;
    }
    case "seek":
      setStatus(running, "");
      running.lastCorrectMs = now;
      sayStep(`sync:${itemId}`, `Syncing to the room (${shortLength(answer.positionMs)})`);
      player.seek(answer.positionMs);
      return;
    case "hold":
    default:
      setStatus(running, answer.status || "");
      return;
  }
}

/** Where this member's copy of an item should start: the room's own position
 *  when the room is on that item, and the position it was handed otherwise.
 *
 *  Taken at the moment the file is handed over, not when the decision was made:
 *  resolving and fetching take time, and a position from before them is one
 *  already behind the room - which the drift rule then corrects with a seek,
 *  which is the "syncing" heard a moment after a song starts. A song the room
 *  has started is joined where the room is; one this member is moving to itself
 *  starts at its beginning, because the room has not started it yet. */
function startFor(itemId, at) {
  const live = currentRoom();
  const onRoom =
    live && live.current && str(live.current.item?.id) === itemId && live.current.started && !live.current.paused;
  return onRoom ? Math.max(0, positionMs(live, Date.now())) : Math.max(0, num(at));
}

/** Put a room item through the player's normal source/download pipeline. */
async function loadItem(running, item, { positionMs: at = 0, autoplay = true } = {}) {
  const player = running.player;
  const trackId = str(item.trackId);
  const itemId = str(item.id) || trackId;
  if (!trackId || !itemId || running.resolving === itemId) return;
  running.itemId = itemId;
  running.resolving = itemId;
  running.loadedItemId = itemId;
  running.loadedAtMs = Date.now();
  sayStep(`song:${itemId}`, `Room: ${item.title || "the next song"}`);
  setStatus(running, "");
  try {
    await player.playRoomTrack({ id: trackId, title: item.title, artists: item.artists, artworkUrl: item.artworkUrl, roomItemId: itemId }, {
      positionMs: startFor(itemId, at), autoplay,
    });
  } finally {
    if (plugin === running) running.resolving = "";
  }
}

/**
 * A song this client cannot play: left alone for longer each time it is tried.
 *
 * The count is per item, so a provider having a bad minute costs a few quick
 * retries and a song that is really unplayable settles into one ask every few
 * minutes instead of the room asking for ever on a five-second beat.
 */
function markUnplayable(running, itemId) {
  running.failedTries ||= new Map();
  running.failedTries.set(itemId, Number(running.failedTries.get(itemId) || 0) + 1);
  running.failedItemId = itemId;
  running.failedAt = Date.now();
}

/**
 * A follower with nothing reachable plays the order it last knew, out of the
 * copies this page kept for it.
 *
 * The room cannot start a song when it cannot be heard from, so the local
 * player carries on by itself - song into song - until the socket comes back,
 * and then the room's own item wins and this client jumps to it. That is what
 * following means with the server gone: the last order, and the songs.
 */
function followOfflineRoom(running, room, { force = false } = {}) {
  const player = running.player;
  const order = list(room.masterQueue).filter((entry) => entry?.id && entry?.trackId);
  // A song the room's order does not contain is not this room's: it is what was
  // playing when this page arrived - another room's, or the user's own - and
  // leaving it there is how a page is heard playing something the room knows
  // nothing about. It is let go of, and the room's order decides from here.
  const playing = str(player.current()?.id);
  if (playing && !order.some((entry) => str(entry.trackId) === playing)) player.clear?.();

  if (!order.length) {
    if (!player.isPaused()) player.pause();
    return;
  }
  // On a song that has not ended: leave it alone. It is the song the room last
  // said, and it is already here - unless somebody asked for the next one.
  if (!force && player.current() && !player.hasEnded?.()) return;

  const localId = str(player.current()?.roomItemId);
  const roomItemId = str(room.current?.item?.id);
  let at = order.findIndex((entry) => entry.id === (localId || roomItemId));
  if (localId && at >= 0) at += 1;      // our copy of that song is over
  if (at < 0) at = 0;

  for (; at < order.length; at += 1) {
    const entry = order[at];
    if (player.offlineState?.(str(entry.trackId)) !== "ready") continue;
    sayStep(`offline:${entry.id}`, `Offline — playing ${entry.title || "the next song"} from this device`);
    player.playOffline?.({ id: str(entry.trackId), title: entry.title, roomItemId: str(entry.id) });
    return;
  }
  // Nothing left that this page holds: hold, quiet, until the room returns.
  if (!player.isPaused()) player.pause();
}

/** Keep upcoming room songs in the shared download pipeline. */
function warmAhead(running, room, itemId) {
  const player = running.player;
  const order = list(room.masterQueue);
  const at = order.findIndex((entry) => str(entry.id) === str(itemId));
  const upcoming = order.slice(at < 0 ? 0 : at).map((entry) => ({
    id: str(entry.trackId),
    title: entry.title,
    artists: entry.artists,
    artworkUrl: entry.artworkUrl,
    roomItemId: str(entry.id),
  }));
  const key = `${player.online?.() ? "online" : "offline"}:${upcoming.map((entry) => entry.roomItemId).join(",")}`;
  if (key === running.warmedKey) return;
  running.warmedKey = key;
  player.keepOffline?.(upcoming);
}

/** Put the player in the room the rest of the app is in. */
function ensureRoomMode(player, room) {
  player.setRoom({
    roomId: room.roomId,
    name: room.name,
    // The server is the room's clock now, so no member's player owns the
    // advance: a skip asks the room, and the local file running out is handled
    // by the following layer above.
    hostPlayback: false,
    onAdd: (tracks) => Promise.resolve().then(() => enqueueMany(tracks)).catch(() => {}),
    mayDrive: () => {
      const live = currentRoom();
      return Boolean(live) && mayDrive(live, live.me);
    },
    // The bar's shuffle asks the queue view to shuffle the caller's own room
    // queue, so it is only for a member holding two or more of their own.
    mayShuffle: () => {
      const live = currentRoom();
      return Boolean(live) && myQueue(live).length >= 2;
    },
    // A skip with nothing reachable moves through the order this page knew.
    offlineSkip: () => {
      const live = currentRoom();
      if (live) followOfflineRoom(plugin, live, { force: true });
    },
    onBlocked: (action) => blockedNotice?.(action),
    pause: () => pause().catch(() => {}),
    resume: () => resume().catch(() => {}),
    skip: () => skip().catch(() => {}),
    seek: (ms) => seek(ms).catch(() => {}),
  });
}

/** The variant this member plays: the one the player itself would choose. */
async function resolveVariant(trackId, player) {
  try {
    const resolved = await player.variantFor({ id: trackId });
    return str(resolved && resolved.variantId);
  } catch {
    return "";
  }
}

/** The track behind a room item: the item carries only a title, and the bar
 *  needs the artist and the artwork too. Failing is not fatal. */
async function loadTrack(connection, trackId) {
  if (!connection || !connection.client) return null;
  try {
    const track = await connection.client.track(trackId);
    return track && track.id ? track : null;
  } catch {
    return null;
  }
}

// --- notices ---------------------------------------------------------------
//
// The page is never touched from here: the app registers the words, and this
// module says what is happening while it happens.

let blockedNotice = null;
let statusNotice = null;
let stepNotice = null;
let unplayableNotice = null;

export function setBlockedNotice(handler) {
  blockedNotice = typeof handler === "function" ? handler : null;
}

export function setStatusNotice(handler) {
  statusNotice = typeof handler === "function" ? handler : null;
}

/**
 * A song this member cannot be put on the player at all: no source was found
 * for it. The app is handed the item and the track, and asks whoever is
 * listening what the song is - the answer attaches a real rendition to it,
 * which is the difference between a room that plays and one that sits on
 * "Finding a source\u2026" until the song is over.
 */
export function setUnplayableNotice(handler) {
  unplayableNotice = typeof handler === "function" ? handler : null;
}

export function setStepNotice(handler) {
  stepNotice = typeof handler === "function" ? handler : null;
}

function sayStatus(message) {
  statusNotice?.(message);
}

function sayUnplayable(problem) {
  unplayableNotice?.(problem);
}

/** Say each step of a song once; a stream of ticks is not a stream of toasts. */
const saidSteps = new Set();

function sayStep(key, text) {
  if (!text) return;
  if (key.startsWith("song:")) saidSteps.clear();
  if (saidSteps.has(key)) return;
  saidSteps.add(key);
  try {
    if (stepNotice) stepNotice(text);
    else toast(text);
  } catch {
    /* a notice that fails is not worth the room */
  }
}

/** A length as m:ss, for saying how far into a song the room is. */
function shortLength(ms) {
  const total = Math.max(0, Math.round(num(ms) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
