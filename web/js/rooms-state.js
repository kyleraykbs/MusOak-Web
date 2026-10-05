// Following a room: the client half of Listen Together.
//
// The server owns the room — the queue, the timeline, who plays what — and
// announces every change on `/api/v1/ws`. This module keeps our end: it holds
// the room as last described, applies the events that arrive, sends the
// commands, and re-joins on its own when the socket drops.
//
// Anything that only computes is pure: `applyEvent` and `mergeSnapshot` return
// a new state and never touch the one they were given, which is what lets the
// reducers be tested without a browser.

import { state, rememberRoom, forgetRoom } from "./state.js";
import { toast } from "./dom.js";

/** Who may drive a room. */
export const CONTROLS_HOST = "host";
export const CONTROLS_EVERYONE = "everyone";

/** Who holds the song: the server's clock, or the host's player. */
export const MODE_SERVER = "server";
export const MODE_HOST = "host";
/** The event names the server publishes. */
export const EVENTS = {
  memberJoined: "member_joined",
  memberLeft: "member_left",
  hostChanged: "host_changed",
  modeChanged: "mode_changed",
  queueUpdated: "queue_updated",
  trackPrepared: "track_prepared",
  trackStarted: "track_started",
  trackSkipped: "track_skipped",
  paused: "paused",
  resumed: "resumed",
  seeked: "seeked",
  voteUpdated: "vote_updated",
  readyState: "ready_state",
  roomClosed: "room_closed",
  pong: "pong",
};

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
 *  assumes a symmetric trip, so a pong that took the long way round - a busy
 *  socket, a stalled frame - is the one most likely to be wrong. */
const CLOCK_SAMPLES = 5;
const CLOCK_BURST = 3;

/** How far the local position may run from the room's before it is seeked. */
export const DRIFT_TOLERANCE_MS = 1500;

/** How far the room's position may sit from the host's own file before it
 *  counts as somebody having seeked rather than the host's playback drifting.
 *  The host is the room's clock, so only a jump of this size is theirs to
 *  follow - and their own seeks have already moved them. */
const HOST_SEEK_JUMP_MS = 3000;

/** How often the local player is checked against the room's timeline. */
export const FOLLOW_TICK_MS = 500;

const DEFAULT_SKIP = {
  skipThreshold: 2,
  minVotersForSkip: 2,
  voterFractionForSkip: 0.5,
  readyTimeoutSeconds: 30,
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
    // The server sends the track's cover path with every queued item; dropping
    // it here is what left every room queue row a blank square.
    artworkUrl: str(source.artworkUrl),
    // And the artists, which the row's menu opens a page with.
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
    // The Listening panel shows each member's picture, which the server sends
    // with the member.
    iconUrl: str(source.iconUrl),
    // True while this member is sitting the room's track out: not waited for,
    // and their file is not what the room's length is measured by.
    out: Boolean(source.out),
  };
}

/** One member's readiness report. */
function normalizeReady(raw) {
  const source = raw || {};
  return {
    memberId: str(source.memberId),
    trackId: str(source.trackId),
    variantId: str(source.variantId),
    durationMs: num(source.durationMs),
    atMs: num(source.atMs),
  };
}

/**
 * The track the room is on, and how far along it is. `atMs` is the server
 * instant the position was measured at — the position only means something
 * against the clock it was read from.
 */
export function normalizeCurrent(raw, atMs = 0) {
  if (!raw) return null;
  const item = raw.item && (raw.item.id || raw.item.trackId) ? normalizeItem(raw.item) : null;
  return {
    item,
    startedAtMs: num(raw.startedAtMs),
    timelineMs: num(raw.timelineMs),
    positionMs: num(raw.positionMs),
    atMs: num(atMs) || num(raw.startedAtMs),
    paused: Boolean(raw.paused),
    variants: { ...(raw.variants || {}) },
    ready: list(raw.ready).map(normalizeReady),
    awaiting: list(raw.awaiting).map(str),
    catchingUp: list(raw.catchingUp).map(str),
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
    readyTimeoutSeconds: num(raw.readyTimeoutSeconds, DEFAULT_SKIP.readyTimeoutSeconds),
  };
}

/** The play order after the current track, as the server reports it. */
function pendingFrom(masterQueue, current) {
  const currentId = current && current.item ? current.item.id : "";
  return masterQueue.filter((item) => item.id !== currentId);
}

/**
 * The room's play order, from the member queues and the join order.
 *
 * The server used to send this with every queue change, along with the pending
 * list: two more copies of a queue that a room holding three hundred songs
 * makes a third of a megabyte on the wire, on every enqueue, every advance and
 * every member arriving. It is a function of what the client already has - one
 * item from each member per pass, in join order - so the client works it out.
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
 * The queues after one event: the member it names, or all of them when a server
 * still sends the lot. A member who left has their queue dropped rather than
 * replaced.
 */
function queuesFrom(state, data) {
  const memberId = str(data.memberId);
  if (!memberId) {
    return data.queues === undefined ? state.queues : normalizeQueues(data.queues);
  }
  const queues = { ...state.queues };
  if (data.gone) delete queues[memberId];
  else queues[memberId] = list(data.memberQueue).map(normalizeItem);
  return queues;
}

/**
 * A room's state, empty but well-formed. The connection fields (`me`,
 * `connected`, `error`) belong to the client, not the server.
 */
export function createRoomState(initial = {}) {
  return {
    roomId: "",
    name: "",
    controls: CONTROLS_HOST,
    mode: MODE_SERVER,
    createdAtMs: 0,
    members: [],
    memberCount: 0,
    hasPassword: false,
    queues: {},
    masterQueue: [],
    queue: [],
    current: null,
    preparing: null,
    readyCount: 0,
    skip: { ...DEFAULT_SKIP },
    serverNowMs: 0,
    serverOffsetMs: 0,
    clockSamples: [],
    atMs: 0,
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
  const masterQueue = list(room.masterQueue).map(normalizeItem);
  const current = normalizeCurrent(room.current, num(room.serverNowMs));
  return {
    roomId: str(room.id),
    name: str(room.name),
    host: str(room.host),
    controls: room.controls === CONTROLS_EVERYONE ? CONTROLS_EVERYONE : CONTROLS_HOST,
    mode: room.mode === MODE_HOST ? MODE_HOST : MODE_SERVER,
    createdAtMs: num(room.createdAtMs),
    members,
    memberCount: num(room.memberCount, members.length),
    hasPassword: Boolean(room.hasPassword),
    queues: normalizeQueues(room.queues),
    masterQueue,
    queue: room.queue === undefined ? pendingFrom(masterQueue, current) : list(room.queue).map(normalizeItem),
    current,
    preparing: null,
    next: room.next ? normalizeItem(room.next) : null,
    skip: normalizeSkip(room.skip),
    serverNowMs: num(room.serverNowMs),
    atMs: 0,
  };
}

/** Take the server's word for the room, keeping what belongs to this client. */
export function mergeSnapshot(state, raw) {
  const merged = { ...state, ...normalizeSnapshot(raw) };
  return { ...merged, error: "", roomClosed: false };
}

// --- the reducer -----------------------------------------------------------

/**
 * One event, applied to the room as we knew it. Returns the same object when
 * the event says nothing new (an unknown type, or another room's event).
 */
export function applyEvent(state, event) {
  const type = str(event && event.type);
  const data = event && typeof event.data === "object" && event.data !== null ? event.data : {};
  const roomId = str(event && event.roomId);
  if (roomId && state.roomId && roomId !== state.roomId) return state;
  const atMs = num(event && event.atMs, state.atMs);
  // Every position is only true at one instant: the server's. Events carry it;
  // a missing stamp falls back to the track's start, which is the same thing
  // for a track that has just begun.
  const clock = num(event && event.atMs) || num(state.current && state.current.atMs) || num(state.current && state.current.startedAtMs);

  switch (type) {
    case EVENTS.queueUpdated: {
      const queues = queuesFrom(state, data);
      const masterQueue =
        data.masterQueue === undefined ? deriveMaster(queues, state.members) : list(data.masterQueue).map(normalizeItem);
      const next = data.next === undefined ? state.next : data.next ? normalizeItem(data.next) : null;
      const current = state.current;
      return {
        ...state,
        atMs,
        queues,
        masterQueue,
        next,
        queue: data.queue === undefined ? pendingFrom(masterQueue, current) : list(data.queue).map(normalizeItem),
        preparing: data.preparing ? normalizeItem(data.preparing) : null,
      };
    }

    case EVENTS.memberJoined: {
      const member = data.member ? normalizeMember(data.member) : null;
      const members = member ? upsertMember(state.members, member) : state.members;
      return {
        ...state,
        atMs,
        members,
        host: data.host ? str(data.host) : state.host,
        memberCount: data.memberCount === undefined ? members.length : num(data.memberCount, members.length),
      };
    }

    case EVENTS.hostChanged: {
      const host = str(data.host);
      if (!host || host === state.host) return state;
      // Who leads the room decides who may drive it, so it is not something the
      // view can wait for the next snapshot to find out.
      return { ...state, atMs, host };
    }

    case EVENTS.modeChanged: {
      const mode = str(data.mode);
      if (mode !== MODE_HOST && mode !== MODE_SERVER) return state;
      // Who holds the song decides what this client does with its player, so it
      // is not something to wait a snapshot for either. The song in flight
      // changes hands with it.
      return { ...state, atMs, mode };
    }

    case EVENTS.memberLeft: {
      const memberId = str(data.memberId || (data.member && data.member.id));
      const members = memberId ? state.members.filter((member) => member.id !== memberId) : state.members;
      return {
        ...state,
        atMs,
        members,
        memberCount: data.memberCount === undefined ? members.length : num(data.memberCount, members.length),
      };
    }

    case EVENTS.trackPrepared: {
      const item = data.item ? normalizeItem(data.item) : state.preparing;
      const base = state.current;
      return {
        ...state,
        atMs,
        preparing: item,
        readyCount: 0,
        current: item
          ? {
              ...(base || {}),
              item,
              variants: { ...(data.variants || {}) },
              startedAtMs: 0,
              positionMs: 0,
              atMs: clock,
              paused: false,
            }
          : base,
      };
    }

    case EVENTS.trackStarted: {
      const item = data.item ? normalizeItem(data.item) : state.current && state.current.item;
      if (!item) return state;
      return {
        ...state,
        atMs,
        preparing: null,
        readyCount: 0,
        current: {
          item,
          startedAtMs: num(data.startedAt, num(event && event.atMs)),
          timelineMs: num(data.timelineMs),
          positionMs: 0,
          atMs: num(event && event.atMs) || num(data.startedAt),
          paused: false,
          variants: { ...(data.variants || {}) },
          ready: [],
          awaiting: list(data.awaiting).map(str),
          catchingUp: list(data.catchingUp).map(str),
          votes: {},
          meanScore: 0,
        },
      };
    }

    case EVENTS.trackSkipped: {
      const skipped = data.item ? normalizeItem(data.item) : null;
      const current = state.current;
      if (current && skipped && current.item && current.item.id !== skipped.id) return state;
      return {
        ...state,
        atMs,
        preparing: null,
        readyCount: 0,
        // The room moved on without us: stop, but keep the item on screen.
        current: current
          ? { ...current, startedAtMs: 0, positionMs: num(data.positionMs, current.positionMs) }
          : null,
      };
    }

    case EVENTS.paused:
      if (!state.current) return state;
      return {
        ...state,
        atMs,
        current: { ...state.current, paused: true, positionMs: num(data.positionMs, state.current.positionMs) },
      };

    case EVENTS.resumed:
      if (!state.current) return state;
      return {
        ...state,
        atMs,
        current: {
          ...state.current,
          paused: false,
          startedAtMs: num(data.startedAt, state.current.startedAtMs),
          positionMs: num(data.positionMs, state.current.positionMs),
          // The resumed position is true as of the server's own start instant.
          atMs: num(data.startedAt) || clock,
        },
      };

    case EVENTS.seeked:
      if (!state.current) return state;
      return {
        ...state,
        atMs,
        current: {
          ...state.current,
          startedAtMs: num(data.startedAt, state.current.startedAtMs),
          positionMs: num(data.positionMs, state.current.positionMs),
          atMs: num(data.startedAt) || clock,
        },
      };

    case EVENTS.voteUpdated: {
      if (!state.current) return state;
      return {
        ...state,
        atMs,
        current: {
          ...state.current,
          votes: { ...state.current.votes, [str(data.memberId)]: num(data.score) },
          meanScore: data.mean === undefined ? state.current.meanScore : num(data.mean),
        },
      };
    }

    case EVENTS.readyState: {
      const next = {
        ...state,
        atMs,
        readyCount: num(data.ready, state.readyCount),
        memberCount: data.members === undefined ? state.memberCount : num(data.members, state.memberCount),
      };
      // The room's length is the file the member who queued the song is
      // playing; when they switch sources it moves with them.
      if (next.current && data.timelineMs !== undefined) {
        next.current = { ...next.current, timelineMs: num(data.timelineMs) };
      }
      // Who is sitting this one out travels with the ready state, so the
      // Listening panel does not have to refetch the room to show it.
      if (Array.isArray(data.out)) {
        const out = new Set(data.out.map(str));
        next.members = next.members.map((member) => ({ ...member, out: out.has(member.id) }));
      }
      return next;
    }

    case EVENTS.roomClosed: {
      if (roomId && state.roomId && roomId !== state.roomId) return state;
      return { ...state, atMs, roomClosed: true, current: null, preparing: null };
    }

    case EVENTS.pong: {
      if (!event || event.clientSentAt === undefined || event.serverReceivedAt === undefined) return state;
      const sent = num(event.clientSentAt);
      // When the frame arrived, not when this ran: a reducer that runs late is
      // not a slow network, and counting it as one moves the clock by half of
      // whatever the delay was.
      const received = num(event.clientReceivedAt, Date.now());
      const sample = {
        offset: offsetFrom(sent, received, num(event.serverReceivedAt)),
        rtt: Math.max(0, received - sent),
      };
      // The quickest of the recent samples is the one to believe: the arithmetic
      // assumes the trip out and the trip back took the same time, so a pong
      // that took the long way round - a busy socket, a stalled frame - is the
      // one most likely to be wrong, and a single bad sample moves the room's
      // position for a whole resync interval.
      const recent = [...list(state.clockSamples), sample].slice(-CLOCK_SAMPLES);
      const best = recent.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      return { ...state, clockSamples: recent, serverOffsetMs: best.offset };
    }

    default:
      return state;
  }
}

function upsertMember(members, member) {
  const index = members.findIndex((existing) => existing.id === member.id);
  if (index === -1) return [...members, member];
  const next = members.slice();
  next[index] = { ...members[index], ...member };
  return next;
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

/** One member's own queue: what they queued, in the order they want it. */
export function myQueue(state, memberId = state.me) {
  return state.queues[str(memberId)] || [];
}

/** Who is on deck according to the fair mix, as a set of member ids. */
export function masterOwners(state) {
  return state.masterQueue.map((item) => item.addedBy);
}

/**
 * The room's position at a wall-clock instant. `nowMs` is this machine's clock;
 * the offset moves it onto the server's, which is the clock the timeline is
 * measured in. A position only ages from the instant the server measured it.
 */
export function positionMs(state, nowMs = Date.now()) {
  const current = state.current;
  if (!current || !current.startedAtMs) return 0;
  const timeline = num(current.timelineMs);
  const clamp = (value) => Math.max(0, timeline > 0 ? Math.min(value, timeline) : value);
  const base = num(current.positionMs);
  if (current.paused) return clamp(base);
  const reference = num(current.atMs) || num(current.startedAtMs);
  return clamp(base + (num(nowMs) + num(state.serverOffsetMs) - reference));
}

/** How long the current track runs for, as the room knows it. */
export function durationMs(state) {
  return state.current ? num(state.current.timelineMs) : 0;
}

/** NTP's arithmetic: the server stamped its receive halfway through the trip. */
export function offsetFrom(clientSentAt, clientReceivedAt, serverReceivedAt) {
  return Math.round(num(serverReceivedAt) - (num(clientSentAt) + num(clientReceivedAt)) / 2);
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
 * What the room is telling this member's player to do with the current track:
 * `"stop"` (nothing is playing), `"prepare"` (fetch it, so the room can
 * start), `"play"` (it is running) or `"pause"` (hold where it is).
 *
 * A start instant of zero means the room has not begun the track yet — the
 * snapshot omits the `track_prepared` event's own field, so the item's start is
 * what tells the states apart.
 */
export function roomPlayMode(room) {
  const current = room && room.current;
  if (!current || !current.item) return "stop";
  if (num(current.startedAtMs) > 0) return current.paused ? "pause" : "play";
  return "prepare";
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
 *
 * Somebody who is in a room wants that room when they press the tab - that is
 * what they are looking at - but not once they have backed out to the list,
 * which is why the choice is remembered rather than assumed every time.
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
 *
 * `onLeave` runs when the membership ends — the room view uses it to take the
 * player's routing back down.
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
  if (connection.retryTimer) clearTimeout(connection.retryTimer);
  connection.retryTimer = 0;
  stopClock(connection);
  if (resyncTimer) clearTimeout(resyncTimer);
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
  // A burst, not one: the offset is taken from the quickest sample of the
  // recent ones, so several in a row are worth more than one - and the first
  // estimate after joining is the one a song's start is measured against.
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
  if (connection.clockTimer) clearInterval(connection.clockTimer);
  connection.clockTimer = 0;
}

function onMessage(connection, message) {
  const type = str(message && message.type);
  if (!type) return;
  const event = {
    type,
    roomId: str(message.roomId),
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
  const next = applyEvent(connection.state, event);
  if (next !== connection.state) {
    connection.state = next;
    publish();
  }
  if (mine) notifyTransport(event);
  if (mine && type === EVENTS.readyState) sayReadyWait(event.data);
  if (mine && RESYNC_EVENTS.has(type)) scheduleResync(connection);
}

/** What a member did, said in the past tense for the room's notice. */
const TRANSPORT_VERBS = {
  [EVENTS.paused]: "paused",
  [EVENTS.resumed]: "resumed",
  [EVENTS.seeked]: "seeked",
  [EVENTS.trackSkipped]: "skipped",
};

/** How long the same notice stays quiet after it is shown, so dragging the
 *  seek bar says one thing instead of a hundred. */
const TRANSPORT_NOTICE_MS = 1200;

let lastTransportNotice = { text: "", at: 0 };

/** What a member's hand on the transport is called, or "" when nobody's is on
 *  it: the room's own decisions - a vote, a track running out - name no one. */
export function transportNotice(event) {
  const verb = TRANSPORT_VERBS[str(event && event.type)];
  const name = str(event && event.data && event.data.by && event.data.by.name);
  if (!verb || !name) return "";
  return `${name} ${verb}`;
}

/** Say who touched the transport, once: a dragged seek bar is one notice, not
 *  one per pixel. */
function notifyTransport(event) {
  const text = transportNotice(event);
  if (!text) return;
  const now = Date.now();
  if (text === lastTransportNotice.text && now - lastTransportNotice.at < TRANSPORT_NOTICE_MS) return;
  lastTransportNotice = { text, at: now };
  toast(text);
}

/** Say how the room's wait is going: who has their file, and how much of the
 *  window is left. This is the countdown - a member waiting on somebody else's
 *  download watches a number come down rather than a play button that does
 *  nothing. Said while it changes: the number is the news. */
function sayReadyWait(data) {
  if (!data || typeof data !== "object") return;
  const ready = num(data.ready);
  const members = num(data.members);
  if (members <= 0) return;
  const left = Math.round(num(data.remainingMs) / 1000);
  if (left > 0 && ready < members) toast(`${ready}/${members} ready — starting in ${left}s`);
}

/** Events whose payload is a summary: the snapshot is the fuller truth. */
const RESYNC_EVENTS = new Set([
  EVENTS.trackStarted,
  EVENTS.trackPrepared,
  EVENTS.voteUpdated,
  EVENTS.readyState,
  EVENTS.memberJoined,
  EVENTS.memberLeft,
  EVENTS.modeChanged,
]);

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

/** Refetch the room: what the events only summarised. */
/**
 * Sit the room's current track out, or come back in. The room plays for as long
 * as the shortest file in it, so a member holding a short or broken copy uses
 * this rather than ending the song for everybody.
 */
export async function setOut(out) {
  const connection = active;
  if (!connection) return null;
  const snapshot = await connection.client.roomOut(connection.roomId, Boolean(out));
  setState(mergeSnapshot(connection.state, snapshot));
  return snapshot;
}

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
  if (payload && typeof payload === "object" && (payload.id || payload.room)) {
    setState(mergeSnapshot(connection.state, payload.room || payload));
  }
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
 * A room owns the position, so the seek is asked of the room - but the answer
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

/** Tell the room what you will actually play, and how long it runs. */
export function ready({ trackId = "", variantId = "", durationMs = 0 } = {}) {
  return command(({ client, roomId }) =>
    client.roomReady(roomId, str(trackId), str(variantId), Math.round(num(durationMs))));
}

/** Who holds the song: the server's clock, or the host's player. The host's
 *  checkbox - their choice, live, and the song in flight changes hands with it. */
export function setMode(mode) {
  const target = str(mode);
  if (target !== MODE_SERVER && target !== MODE_HOST) {
    throw new Error('mode must be "server" or "host"');
  }
  return command(({ client, roomId }) => client.roomMode(roomId, target));
}

// --- following the room with the player ------------------------------------
//
// The room is the authority on what plays and where it is; the player only has
// to keep up. The room view hands the one player here, and the engine does
// three things while a room is followed: it plays this member's own rendition
// of the prepared track (and says so, which is what lets the room start rather
// than wait out its readiness timeout), it keeps the local position on the
// room's timeline with small seeks, and it pauses and resumes with the room.
// Everything is derived from the room state; the only call it makes on its own
// is the readiness report.

/** How long a track whose sources could not be read is left alone. */
const RESOLVE_BACKOFF_MS = 5000;

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
    // what the engine has loaded, and what it has already told the room
    itemId: "",
    trackId: "",
    variantId: "",
    // the track behind the item, for the artist and artwork the bar shows
    track: null,
    reportedKey: "",
    startedKey: "",
    endedAskedFor: "",
    preReadyFor: "",
    preReadyAt: 0,
    preReadyDone: "",
    failedItemId: "",
    failedAt: 0,
    resolving: "",
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

/** Forget what the engine knew about the track it was following. */
function forgetTrack() {
  if (!plugin) return;
  plugin.itemId = "";
  plugin.trackId = "";
  plugin.variantId = "";
  plugin.track = null;
  plugin.reportedKey = "";
  plugin.startedKey = "";
  plugin.endedAskedFor = "";
  plugin.preReadyFor = "";
  plugin.preReadyAt = 0;
  plugin.preReadyDone = "";
  plugin.failedItemId = "";
  plugin.failedAt = 0;
  plugin.resolving = "";
}

async function followRoom(running) {
  const player = running.player;
  const room = currentRoom();
  if (!room || room.roomClosed) {
    // No room: the player is its own again.
    if (player.inRoom?.()) player.clearRoom();
    forgetTrack();
    return;
  }
  ensureRoomMode(player, room);

  const current = room.current;
  if (!current || !current.item) {
    // The room is idle: the player still routes through it — playing a song
    // queues it there — but nothing of the room's is on the local file.
    forgetTrack();
    if (!player.isPaused()) player.pause();
    return;
  }

  const item = current.item;
  const trackId = str(item.trackId);
  if (!trackId) return;
  const itemId = str(item.id) || trackId;
  if (running.itemId !== itemId) {
    running.itemId = itemId;
    running.trackId = trackId;
    running.variantId = "";
    running.track = null;
    running.reportedKey = "";
    running.startedKey = "";
    running.failedItemId = "";
    running.failedAt = 0;
    sayStep(`song:${itemId}`, `Room: ${item.title || "next song"}`);
  }

  // The file this member was playing has run out. The room's clock is that file,
  // so the room should have moved on - and a client still showing the song it
  // just finished has a stale picture of it: a start that never arrived, a
  // socket that was down, a frame dropped. Asking turns "it sits on the play
  // button until something else happens" into "it goes". A skip needs none of
  // this, which is why a skip was always instant: its answer carries the room.
  if (player.hasEnded?.() && running.endedAskedFor !== itemId) {
    running.endedAskedFor = itemId;
    sayStep(`ended:${itemId}`, "This file has run out — asking the room where it is");
    scheduleResync(active);
  }

  // The room's next songs are fetched, and this member's readiness for them
  // reported, before anything about the current one is settled. It does not
  // depend on it: what the room plays next is the room's business, and a member
  // whose own song is still resolving - or who is still fetching it - is
  // exactly the member the room would otherwise wait for at the advance.
  warmAhead(player, room, itemId, running);

  if (!running.variantId) {
    if (running.resolving === trackId) return;
    if (running.failedItemId === itemId && Date.now() - running.failedAt < RESOLVE_BACKOFF_MS) return;
    running.resolving = trackId;
    sayStatus("Finding a source…");
    sayStep(`resolve:${itemId}`, `Finding a source for ${item.title || "the song"}…`);
    let variant = "";
    try {
      // The room's item carries a title and nothing else, so the track itself
      // is fetched alongside the variant: without it the bar has no artist and
      // no artwork to show, which is what a listener in a room used to see.
      [variant, running.track] = await Promise.all([
        resolveVariant(room, trackId, player),
        loadTrack(active, trackId),
      ]);
    } finally {
      if (plugin === running) running.resolving = "";
    }
    if (plugin !== running || running.itemId !== itemId) return;
    running.variantId = variant;
    if (!variant) {
      running.failedItemId = itemId;
      running.failedAt = Date.now();
      return;
    }
  }

  const mode = roomPlayMode(room);
  const state = player.state();
  const onTrack = player.current()?.id === trackId;
  const ours = onTrack && str(player.variantId()) === running.variantId;
  const loadingHere = onTrack && Boolean(state && (state.loading || state.buffering));
  const broken = onTrack && Boolean(state && state.error);

  // A track this member cannot fetch is not worth the room's readiness timeout:
  // it would start late and play to nobody. Sitting this one out is what the
  // room's reckoning is for — it stops the room waiting on this member — and
  // coming back in is the next track's business.
  const unfetchable = running.failedItemId === itemId || (onTrack && player.readyState() === "failed");
  if (unfetchable && running.satOutFor !== itemId) {
    running.satOutFor = itemId;
    sayStatus("That track could not be fetched. The room carries on without it.");
    setOut(true).catch(() => {});
  } else if (!unfetchable && running.satOutFor) {
    running.satOutFor = "";
    setOut(false).catch(() => {});
  }

  // A skip can take a while - the source is resolved, the file fetched, the
  // room's gate opened - and a silent bar reads as a broken one. Say what is
  // going on until the track is actually playing.
  sayStatus(
    mode === "prepare"
      ? "Waiting for the room to start…"
      : loadingHere
        ? "Loading the track…"
        : ""
  );

  // What the room is waiting for, and how far along each of them is. The room
  // assigns every member a rendition, so its own state says what to ask about -
  // and a member's file is the only thing between them and hearing this song.
  // "Getting ready" with nothing behind it is what a stuck room looked like.
  await reportLoading(room, running);

  if (!ours) {
    if (!loadingHere && !broken) {
      // Start the room's rendition: the prepared one is fetched but held, the
      // running one starts where the timeline already is. The fetched track
      // carries the artist and artwork the bar shows; the item alone would only
      // give it a title.
      const autoplay = mode === "play";
      sayStep(
        `load:${itemId}:${autoplay ? "play" : "hold"}`,
        autoplay
          ? `Playing ${item.title || "the song"} — the room is at ${shortLength(positionMs(room, Date.now()))}`
          : `Loading ${item.title || "the song"}…`
      );
      player.playVariant(running.track || { id: trackId, title: item.title }, running.variantId, {
        positionMs: autoplay ? positionMs(room, Date.now()) : 0,
        autoplay,
      });
    }
    return;
  }

  reportReady(running, room, item, trackId, player);

  // In host mode the host's player is the clock: the room starts nothing and
  // waits on nobody, so the moment their file is really playing they say so -
  // once per song, with where their file is and how long it says the song is -
  // and the room's clock is that. A party in one room sounds exactly as smooth
  // as the host's own player, and their file running out is the song ending.
  if (
    room.mode === MODE_HOST &&
    isHost(room) &&
    player.current()?.id === trackId &&
    !player.isPaused() &&
    !player.hasEnded?.() &&
    running.startedKey !== itemId
  ) {
    const measured = typeof player.measuredDurationMs === "function" ? player.measuredDurationMs() : 0;
    running.startedKey = itemId;
    sayStep(`started:${itemId}`, `Starting the room on this player (${shortLength(measured || 0)})`);
    startedNow(trackId, player.positionMs(), measured);
  }

  if (mode === "play") {
    sayStep(
      `play:${itemId}`,
      `Playing ${item.title || "the song"} — the room is at ${shortLength(positionMs(room, Date.now()))}`
    );
    followTimeline(player, room);
  } else if (!player.isPaused() && room.mode !== MODE_HOST) {
    // The room has not started this song, so this member's file is held for it.
    // In host mode the host's own player is the start: them playing it is what
    // the room is waiting for, so it is not paused back out from under them.
    player.pause();
  }
}

/**
 * The host's player saying the song is playing: the room's clock is put where
 * their file is, and it runs as long as their file says it is. In host mode this
 * is the whole start of a song - the room starts nothing, their player does,
 * and this is the word for it.
 */
function startedNow(trackId = "", positionMs = 0, durationMs = 0) {
  const live = currentRoom();
  const connection = active;
  if (!live || !connection || !isHost(live) || live.mode !== MODE_HOST) return;
  connection.client
    .roomStarted(
      connection.roomId,
      str(trackId),
      Math.max(0, Math.round(num(positionMs))),
      Math.max(0, Math.round(num(durationMs)))
    )
    .catch(() => {
      /* their player is still playing; they say so again on the next song */
    });
}

/**
 * Get the room's next songs ready, and say so for the one it has prepared.
 *
 * The room can only start the next song the instant this one ends if it already
 * knows every member's file is here, and a member can only say that before the
 * gap if they are told about the song before it. So this runs for every member
 * on every tick, not only for the one who happens to be playing right now.
 */
function warmAhead(player, room, itemId, running) {
  // The player's own queue is empty in a room, so nothing else would fetch what
  // the room plays next. Warm it here, or a skip waits on a download.
  for (const entry of upcomingItems(room, itemId)) {
    player.warm?.({ id: str(entry.trackId), title: entry.title });
  }

  // The room names the song it has prepared behind this one. Fetching it and
  // saying so is what lets the room start it the moment this one ends: it can
  // only learn a member is ready before the gap if the member says so before
  // the gap, and a download that begins at the end is the gap.
  const prepared = room.next;
  const preparedId = str(prepared?.id);
  if (!preparedId) return;
  // A fetch that failed once is the difference between the next song starting
  // on the instant and the room waiting for a download at the gap, so it is
  // tried again while the room still has this song prepared. It stops once the
  // room has been told: from there the file is the room's business, not this
  // member's.
  if (running.preReadyDone === preparedId) return;
  if (running.preReadyFor === preparedId && Date.now() - running.preReadyAt < PRELOAD_RETRY_MS) return;
  running.preReadyFor = preparedId;
  running.preReadyAt = Date.now();
  sayStep(`next:${preparedId}`, `Next: ${prepared.title || "the song after this one"} — fetching it now`);
  player.warm?.(
    { id: str(prepared.trackId), title: prepared.title },
    {
      onReady: (variantId, durationMs) => {
        running.preReadyDone = preparedId;
        reportReadyAhead(prepared, variantId, durationMs);
      },
    }
  );
}

/** How long to wait before trying a failed fetch for the prepared song again. */
const PRELOAD_RETRY_MS = 15000;

/** How many of the room's upcoming items to have ready, as the player keeps its
 *  own queue: the next two songs, so a switchover costs nothing. */
const PREFETCH_AHEAD = 2;

/**
 * Say that this member's copy of the song has run out.
 *
 * Only in host mode, and only the host's word: their player is the clock, so
 * their file reaching its end is the end of the song - and it is the one length
 * the room cannot work out for itself. In server mode the server's own clock
 * says when a song is over, and nobody's file ending moves it.
 */
function endedNow(trackId = "", positionMs = 0) {
  const live = currentRoom();
  const connection = active;
  if (!live || !connection || !isHost(live) || live.mode !== MODE_HOST) return;
  connection.client.roomEnded(connection.roomId, str(trackId), Math.max(0, Math.round(num(positionMs)))).catch(() => {
    /* the room's own timer is the backstop */
  });
}

/** The room's items after the current one, in the room's own play order. */
function upcomingItems(room, currentItemId) {
  const order = list(room && room.masterQueue);
  const at = order.findIndex((entry) => str(entry.id) === str(currentItemId));
  if (at < 0) return [];
  return order.slice(at + 1, at + 1 + PREFETCH_AHEAD);
}

/** Put the player in the room the rest of the app is in. */
function ensureRoomMode(player, room) {
  if (typeof player.roomId === "function" && player.roomId() === room.roomId) return;
  player.setRoom({
    roomId: room.roomId,
    name: room.name,
    onAdd: (tracks) => Promise.resolve().then(() => enqueueMany(tracks)).catch(() => {}),
    // The bar's transport belongs to the room too, so it asks the room the same
    // way the room view does. This is also the path taken when a reload puts
    // us back in a room nobody has visited the page of.
    mayDrive: () => {
      const live = currentRoom();
      return Boolean(live) && mayDrive(live, live.me);
    },
    onBlocked: (action) => blockedNotice?.(action),
    pause: () => pause().catch(() => {}),
    resume: () => resume().catch(() => {}),
    skip: () => skip().catch(() => {}),
    seek: (ms) => seek(ms).catch(() => {}),
    // The host's file reaching its end is the song reaching its end.
    ended: (trackId, positionMs) => endedNow(trackId, positionMs),
  });
}

/** What to say when the room's policy keeps a control for its host. The app
 *  registers the words: this module never touches the page. */
let blockedNotice = null;

export function setBlockedNotice(handler) {
  blockedNotice = typeof handler === "function" ? handler : null;
}

/** What to say while the room is getting a track ready. Same idea, and the app
 *  shows it in the same box; an empty string clears it. */
let statusNotice = null;

export function setStatusNotice(handler) {
  statusNotice = typeof handler === "function" ? handler : null;
}

function sayStatus(message) {
  statusNotice?.(message);
}

/**
 * Every step of a room's song-to-song life, said out loud.
 *
 * The room is a machine with several parts - this member's file, the files of
 * the others, the room's clock, the socket - and when one of them is slow, all
 * a listener sees is a play button that does nothing. So each part says what it
 * is doing as it does it: what the room is waiting for, what this client is
 * fetching, who has still to arrive, when the room starts and where, when the
 * room's clock is put onto this file, and what comes next. Each step is said
 * once per song; a step that repeats is not news.
 */
let stepNotice = null;

export function setStepNotice(handler) {
  stepNotice = typeof handler === "function" ? handler : null;
}

function sayStep(key, text) {
  if (!text) return;
  // A new song opens a fresh stream of steps. Within one song each step is said
  // once: a stream of ticks is not a stream of toasts, and steps that alternate
  // - playing, syncing, playing - would otherwise never stop.
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

/** The steps already said for this song, so a stream of ticks says one thing once. */
const saidSteps = new Set();

/** A room's member by id, for naming who the room is waiting for. */
function memberNameOf(room, memberId) {
  const member = list(room && room.members).find((entry) => str(entry.id) === str(memberId));
  return str(member && member.name) || "a listener";
}

/** A length as m:ss, for saying how long a file runs. */
function shortLength(ms) {
  const total = Math.max(0, Math.round(num(ms) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The track behind a room item. The item carries only a title, and the bar
 *  needs the artist and the artwork too. Failing is not fatal: the bar falls
 *  back to the title alone. */
async function loadTrack(connection, trackId) {
  if (!connection || !connection.client) return null;
  try {
    const track = await connection.client.track(trackId);
    return track && track.id ? track : null;
  } catch {
    return null;
  }
}

/**
 * The variant this member plays, which is the one the player would choose: the
 * account's saved source, else the default, else the provider order — and the
 * room's own assignment when nothing else is known.
 *
 * The player is asked rather than the same choice made a second time here, so
 * that what gets warmed and what gets played are one file.
 */
async function resolveVariant(room, trackId, player) {
  if (!active) return "";
  const assignments = room.current && room.current.variants;
  const assigned = assignments ? str(assignments[room.me]) : "";
  try {
    const resolved = await player.variantFor({ id: trackId });
    return str(resolved && resolved.variantId) || assigned;
  } catch {
    return assigned;
  }
}

/**
 * Follow the room's timeline: hold inside the drift tolerance, seek past it,
 * and stay silent — never restart, never advance — once the file is done.
 *
 * The host is the exception, and is why the room has a host at all: the song
 * runs as long as their copy and the room moves on when theirs ends, so seeking
 * them onto the server's idea of the position would cut the song they are
 * hearing to catch up with a clock they are the reference for. A playlist does
 * not do that, and neither does this.
 */
function followTimeline(player, room) {
  const position = positionMs(room, Date.now());
  const timeline = num(room.current.timelineMs);

  // In host mode the host's player is the clock, so there is nothing here to
  // correct: the song runs as long as their file, their file reaching its end
  // is what moves the room on, and seeking or pausing them would be the room
  // arguing with itself. In server mode they are a member like any other: the
  // server's clock is the one everybody follows, theirs included.
  if (isHost(room) && room.mode === MODE_HOST) {
    // An ended file is not a paused one: the element stops itself when it runs
    // out, and play() would start it over from the beginning - which is what a
    // room that is about to move on would hear. Resuming is for the file that
    // was fetched and held, waiting for the room to start it.
    if (player.isPaused() && !player.hasEnded?.()) player.resume();
    // Except when the room has been moved somewhere else entirely. That is a
    // seek somebody made, not drift, and it is the room's position like any
    // other: the host follows it, and their own seeks moved them already.
    if (Math.abs(player.positionMs() - position) > HOST_SEEK_JUMP_MS) player.seek(position);
    return;
  }

  // The room's timeline is over: stop rather than loop or move on.
  if (timeline > 0 && position >= timeline) {
    if (!player.isPaused()) player.pause();
    return;
  }

  const local = player.positionMs();
  const duration = player.durationMs();
  // A file shorter than the timeline has already run out: it waits, silent,
  // for the room to move on.
  if (duration > 0 && local >= duration - 250) {
    if (!player.isPaused()) player.pause();
    return;
  }

  if (driftDecision(local, position) !== "hold") {
    sayStep(`sync:${str(room.current && room.current.item && room.current.item.id)}`, `Syncing to the room (${shortLength(position)})`);
    player.seek(position);
  }
  if (player.isPaused() && !player.hasEnded?.()) player.resume();
}

/** Whether this member is the room's host: the one whose copy it runs on. */
export function isHost(room) {
  const me = str(room && room.me);
  return Boolean(me) && me === str(room && room.host);
}

/** How often a waiting member's file is looked in on. */
const LOADING_POLL_MS = 500;

/**
 * Ask after the files of the members the room is waiting for, and keep the
 * answers where the room view can show them. A member the room is not waiting
 * for is not asked about: their file is not what this song is waiting on.
 */
async function reportLoading(room, running) {
  const connection = active;
  const current = room && room.current;
  const waiting = (current && current.awaiting) || [];
  const variants = (current && current.variants) || {};
  const wanted = waiting.map((id) => str(variants[id]));

  if (!connection || !waiting.length) {
    if (running.loading && Object.keys(running.loading).length) setLoading(connection, {});
    return;
  }
  if (Date.now() - (running.loadingAt || 0) < LOADING_POLL_MS) return;
  running.loadingAt = Date.now();

  const statuses = await Promise.all(
    wanted.map((variantId) =>
      variantId ? connection.client.mediaStatus(variantId).catch(() => null) : Promise.resolve(null)
    )
  );
  if (connection !== active) return;

  const loading = {};
  waiting.forEach((id, index) => {
    const status = statuses[index];
    if (status) loading[id] = { state: str(status.state), progress: num(status.progress) };
  });
  const parts = waiting.map((id) => {
    const status = loading[id];
    const how = status && status.state === "downloading" ? ` (${Math.round(Math.max(0, Math.min(1, num(status.progress))) * 100)}%)` : "";
    return `${memberNameOf(room, id)}${how}`;
  });
  sayStep(`waiting:${str(current.item.id)}:${parts.join("|")}`, `Waiting on: ${parts.join(", ")}`);
  setLoading(connection, loading);
}

/** Keep the room's picture of what it is waiting for, without redrawing for an
 *  answer that has not changed. */
function setLoading(connection, loading) {
  if (!connection || connection !== active) return;
  const before = connection.state.loading || {};
  if (JSON.stringify(before) === JSON.stringify(loading)) return;
  setState({ ...connection.state, loading });
}

/** Tell the room a file is here for a song it has not started yet, and how long
 *  it runs. The room starts on this report, and the length is the one the
 *  browser measured: a report without one leaves the room on the song's
 *  canonical length until the song is already playing. */
function reportReadyAhead(item, variantId, durationMs = 0) {
  const connection = active;
  const trackId = str(item?.trackId);
  if (!connection || !trackId || !variantId) return;
  connection.client.roomReady(connection.roomId, trackId, variantId, Math.max(0, Math.round(num(durationMs)))).catch(() => {});
}

/** Tell the room the file is here — once for each prepared track.
 *
 *  Only a measured file counts. The room starts on this report and its clock
 *  runs from that instant, so a report sent while the file is still arriving
 *  buys a start the member cannot keep up with: they hear the song from
 *  wherever the room has got to, sit on the play button while the rest
 *  downloads, and jump forward when it lands. Waiting is the lesser cost, and
 *  with one person in the room it costs nothing but the fetch they would have
 *  paid anyway. A file that never arrives is not a wait: the member sits the
 *  track out, and the room moves on without them. */
function reportReady(running, room, item, trackId, player) {
  const itemId = str(item.id) || trackId;
  if (player.current()?.id !== trackId) return;
  // What this member is actually playing, which is not always what the room
  // assigned: picking a source switches to that copy, and the room needs to
  // know the length of the one it will really hear. Reported once per copy.
  const playing = str(player.variantId());
  if (!playing) return;
  if (player.readyState() !== "ready") return;
  // What this member will actually play, never the song's canonical length: the
  // room's timeline is built from these, and a borrowed number builds a room
  // that runs longer than the file anybody is hearing.
  const measured = typeof player.measuredDurationMs === "function" ? player.measuredDurationMs() : 0;
  if (measured <= 0) return;
  const key = itemId + "/" + playing + "/measured";
  if (running.reportedKey === key) return;
  running.reportedKey = key;
  sayStep(`ready:${key}`, `${item.title || "This file"} is ready here (${shortLength(measured)})`);

  const connection = active;
  if (!connection) return;
  connection.client
    .roomReady(connection.roomId, trackId, playing, measured)
    .then((answer) => {
      if (active !== connection || plugin !== running) return;
      if (answer && typeof answer === "object" && (answer.id || answer.room)) {
        setState(mergeSnapshot(connection.state, answer.room || answer));
      }
    })
    .catch((error) => console.error("room ready report failed", error));
}
