// Following a room: the client half of Listen Together.
//
// The server owns the room — the queue, which song is on, where it is — and
// announces every change on `/api/v1/ws`. This module keeps our end: it holds
// the room as last described, applies the events that arrive, sends the
// commands, and re-joins on its own when the socket drops.
//
// The host plays the mixed queue in its ordinary player and reports the
// current entry, position and pause state once per second and on player
// changes. Every other client loads a different room song and seeks only when
// drift exceeds two seconds. Members choose their own playable version.
//
// Anything that only computes is pure: `applyEvent` and `mergeSnapshot` return
// a new state and never touch the one they were given, which is what lets the
// reducers be tested without a browser.

import { state, rememberRoom, forgetRoom } from "./state.js";
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
export const DRIFT_TOLERANCE_MS = 2000;

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

/** How many of the room's upcoming songs to have on disk. A song the server has
 *  never fetched is a search and a download before it can play, which is longer
 *  than the song it is queued behind, so the window is not one. */
const PREFETCH_AHEAD = 3;

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
 * `positionMs + (serverNow - atMs)`. Until the host's player has begun the
 * song (`started` false) the room holds it at `positionMs`, which is zero.
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
 * The room's play order, from the member queues and the join order.
 *
 * The server sends each member's queue and nothing derived from it; the order
 * is one item from each member per pass, in join order, which every client can
 * work out for itself. The current song keeps its place in its owner's queue
 * until the room moves off it, so the order is the same on both sides: the
 * server drops the played item when it advances, and the client drops it when
 * the `playback` event says the song changed.
 */
export function deriveMaster(queues, members) {
  const order = list(members)
    .map((member) => str(member.id))
    .filter(Boolean);
  const items = (id) => list(queues && queues[id]);
  let total = 0;
  for (const id of order) total += items(id).length;
  const master = [];
  for (let pass = 0; master.length < total; pass += 1) {
    for (const id of order) {
      const queue = items(id);
      if (pass < queue.length) master.push(queue[pass]);
    }
  }
  return master;
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

/**
 * One event, applied to the room as we knew it. Returns the same object when
 * the event says nothing new (an unknown type, or another room's event).
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
      return { ...state, ...stamp, queues, masterQueue: deriveMaster(queues, state.members) };
    }

    case EVENTS.memberJoined: {
      const member = data.member ? normalizeMember(data.member) : null;
      if (!member || !member.id) return state;
      const members = upsertMember(state.members, member);
      const queues = state.queues[member.id] ? state.queues : { ...state.queues, [member.id]: [] };
      return {
        ...state,
        ...stamp,
        members,
        queues,
        memberCount: data.memberCount === undefined ? members.length : num(data.memberCount, members.length),
        host: str(data.host) || state.host,
        masterQueue: deriveMaster(queues, members),
      };
    }

    case EVENTS.memberLeft: {
      const memberId = str(data.memberId);
      if (!memberId) return state;
      const members = state.members.filter((member) => member.id !== memberId);
      const queues = { ...state.queues };
      delete queues[memberId];
      return {
        ...state,
        ...stamp,
        members,
        queues,
        memberCount: data.memberCount === undefined ? members.length : num(data.memberCount, members.length),
        masterQueue: deriveMaster(queues, members),
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
      const changed = !previous || !current || previous.item.id !== current.item.id;
      if (!changed) {
        // The same song, moved: a start, a pause, a resume, a seek or a vote.
        return { ...state, ...stamp, current };
      }
      // The room moved off that song, so the played item leaves its owner's
      // queue and the play order — the same drop the server just did. The order
      // is spliced, not rebuilt: rebuilding it would restart the round-robin
      // and make the next song a different one from the room's.
      const queues = previous ? dropItem(state.queues, previous.item) : state.queues;
      const masterQueue = previous
        ? state.masterQueue.filter((entry) => entry.id !== previous.item.id)
        : state.masterQueue;
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

/** Whether this member is the room's host: whose player is the room's clock. */
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
  const current = state.current;
  if (!current || !current.started) return current ? num(current.positionMs) : 0;
  if (current.paused) return num(current.positionMs);
  const serverNow = num(nowMs) + num(state.serverOffsetMs);
  return Math.max(0, num(current.positionMs) + (serverNow - num(current.atMs)));
}

/** How long the current song runs for, as the room knows it. */
export function durationMs(state) {
  return state.current ? num(state.current.durationMs) : 0;
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
 */
export function driftDecision(localMs, roomMs, toleranceMs = DRIFT_TOLERANCE_MS) {
  const drift = num(localMs) - num(roomMs);
  if (drift > toleranceMs) return "back";
  if (drift < -toleranceMs) return "forward";
  return "hold";
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
    state: createRoomState({ me: memberId, connected: false }),
  };
  active.state = mergeSnapshot(active.state, joined);
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
  if (mine && event.seq && connection.state.seq && event.seq !== connection.state.seq + 1) {
    // A gap means events were missed and the derived play order may be wrong:
    // the snapshot is the way back.
    scheduleResync(connection);
  }
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

/** A score of 1 (bad) to 5 (great); enough of them skips the track. */
export function vote(score) {
  return command(({ client, roomId }) => client.roomVote(roomId, Math.round(num(score))));
}

/** Report the host's ordinary queue player. Position is sampled from the
 *  player; the server timestamps it and broadcasts it to followers. */
function reportHostState(running, player, itemId, trackId) {
  const connection = active;
  if (!connection) return;
  const ended = Boolean(itemId && player.hasEnded?.());
  const currentItemId = ended ? "" : str(itemId);
  const currentTrackId = currentItemId ? str(trackId) : "";
  const paused = currentItemId ? Boolean(player.isPaused?.()) : true;
  const started = currentItemId ? !paused : false;
  const durationMs = currentItemId
    ? Math.max(0, Math.round(player.measuredDurationMs?.() || player.durationMs?.() || 0))
    : 0;
  const key = `${currentItemId}|${currentTrackId}|${started}|${paused}|${durationMs}`;
  const now = Date.now();
  if (key === running.syncKey && now - running.lastSyncAt < 1000) return;
  running.syncKey = key;
  running.lastSyncAt = now;
  connection.client.roomSync(connection.roomId, {
    itemId: currentItemId,
    trackId: currentTrackId,
    positionMs: currentItemId ? Math.max(0, Math.round(player.positionMs?.() || 0)) : 0,
    durationMs,
    started,
    paused,
  }).catch(() => {
    /* the next one-second sync retries */
  });
}

// --- following the room with the player ------------------------------------
//
// The server broadcasts the host's sampled player state. Followers load a
// different song and seek only when drift exceeds two seconds; the host's
// ordinary queue is the room's mixed order and advances locally.

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
    variantId: "",
    track: null,
    resolving: "",
    failedItemId: "",
    failedAt: 0,
    queueKey: null,
    hostMode: false,
    syncKey: "",
    lastSyncAt: 0,
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
  plugin.variantId = "";
  plugin.track = null;
  plugin.resolving = "";
  plugin.failedItemId = "";
  plugin.failedAt = 0;
  plugin.queueKey = null;
}

async function followRoom(running) {
  const player = running.player;
  const room = currentRoom();
  if (!room || room.roomClosed) {
    if (player.inRoom?.()) player.clearRoom();
    forgetTrack();
    return;
  }
  ensureRoomMode(player, room);
  const host = isHost(room);
  if (running.hostMode !== host) {
    running.hostMode = host;
    running.queueKey = null;
    running.itemId = "";
    running.loadedItemId = "";
    running.variantId = "";
  }
  if (host) {
    followHost(running, room);
    return;
  }

  const current = room.current;
  if (!current?.item) {
    forgetTrack();
    if (!player.isPaused()) player.pause();
    return;
  }
  const item = current.item;
  const trackId = str(item.trackId);
  const itemId = str(item.id) || trackId;
  if (!trackId) return;
  if (running.itemId !== itemId) {
    running.itemId = itemId;
    running.loadedItemId = "";
    running.variantId = "";
    running.track = null;
    running.failedItemId = "";
    running.failedAt = 0;
    sayStep(`song:${itemId}`, `Room: ${item.title || "the next song"}`);
  }
  warmAhead(player, room, itemId);

  if (!running.variantId) {
    if (running.resolving === trackId) return;
    if (running.failedItemId === itemId && Date.now() - running.failedAt < RESOLVE_BACKOFF_MS) return;
    running.resolving = trackId;
    sayStatus("Finding a source…");
    let variant = "";
    let track = null;
    try {
      [variant, track] = await Promise.all([resolveVariant(trackId, player), loadTrack(active, trackId)]);
    } finally {
      if (plugin === running) running.resolving = "";
    }
    if (plugin !== running || running.itemId !== itemId) return;
    running.track = track;
    running.variantId = variant;
    if (!variant) {
      running.failedItemId = itemId;
      running.failedAt = Date.now();
      sayStatus("That song could not be found.");
      return;
    }
  }

  const onTrack = player.current()?.id === trackId;
  const media = player.state();
  const loadingHere = onTrack && Boolean(media && (media.loading || media.buffering));
  const sameTrack = onTrack && str(player.variantId()) === running.variantId;
  if (loadingHere && running.loadedItemId === itemId) {
    sayStatus("Loading the track…");
    return;
  }
  if (!sameTrack || running.loadedItemId !== itemId) {
    const playing = current.started && !current.paused;
    running.loadedItemId = itemId;
    player.playVariant(running.track || { id: trackId, title: item.title }, running.variantId, {
      positionMs: current.started ? positionMs(room, Date.now()) : 0,
      autoplay: playing,
    });
    return;
  }

  sayStatus("");
  if (!current.started || current.paused) {
    if (!player.isPaused()) player.pause();
    return;
  }

  const want = positionMs(room, Date.now());
  const measured = player.measuredDurationMs?.() || 0;
  if (measured > 0 && want >= measured) {
    if (!player.isPaused()) player.pause();
    return;
  }
  if (player.isPaused()) {
    sayStatus(blockedHint(player));
    if (player.hasEnded?.()) player.seek(want);
    player.resume();
    return;
  }
  if (driftDecision(player.positionMs(), want) !== "hold") {
    sayStep(`sync:${itemId}`, `Syncing to the room (${shortLength(want)})`);
    player.seek(want);
  }
}

function followHost(running, room) {
  const player = running.player;
  const master = list(room.masterQueue).filter((item) => item?.id && item?.trackId);
  const currentItemId = str(room.current?.item?.id);
  const currentIndex = master.findIndex((item) => item.id === currentItemId);
  const items = currentIndex < 0
    ? master
    : [master[currentIndex], ...master.slice(0, currentIndex), ...master.slice(currentIndex + 1)];
  const queueKey = items.map((item) => `${item.id}:${item.trackId}`).join("|");
  if (running.queueKey !== queueKey) {
    const localItemId = str(player.current()?.roomItemId);
    const currentItemId = str(room.current?.item?.id);
    const targetId = items.some((item) => item.id === localItemId) ? localItemId : currentItemId;
    const targetPosition = targetId === currentItemId ? positionMs(room, Date.now()) : player.positionMs();
    const autoplay = !room.current?.started || !room.current?.paused;
    player.setRoomQueue(items.map((item) => ({
      ...item,
      id: str(item.trackId),
      roomItemId: str(item.id),
    })), targetId, { positionMs: targetPosition, autoplay });
    running.queueKey = queueKey;
  }

  const track = player.current();
  const itemId = str(track?.roomItemId);
  const trackId = str(track?.id);
  const current = room.current;
  if (itemId && current?.item?.id === itemId) {
    if (current.started && current.paused) {
      if (!player.isPaused()) player.pause();
    } else if (player.isPaused() && !player.state()?.loading && !player.hasEnded?.()) {
      if (player.isBlocked?.()) sayStatus("Your browser is holding playback: click the page once to start the sound.");
      player.resume();
    }
  }
  reportHostState(running, player, itemId, trackId);
}

/** Have the room's next songs on disk before the room reaches them. */
function warmAhead(player, room, itemId) {
  const order = list(room.masterQueue);
  const at = order.findIndex((entry) => str(entry.id) === str(itemId));
  const from = at < 0 ? 0 : at + 1;
  for (const entry of order.slice(from, from + PREFETCH_AHEAD)) {
    player.warm?.({ id: str(entry.trackId), title: entry.title });
  }
}

/** Put the player in the room the rest of the app is in. */
function ensureRoomMode(player, room) {
  player.setRoom({
    roomId: room.roomId,
    name: room.name,
    hostPlayback: isHost(room),
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

export function setBlockedNotice(handler) {
  blockedNotice = typeof handler === "function" ? handler : null;
}

export function setStatusNotice(handler) {
  statusNotice = typeof handler === "function" ? handler : null;
}

export function setStepNotice(handler) {
  stepNotice = typeof handler === "function" ? handler : null;
}

function sayStatus(message) {
  statusNotice?.(message);
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
