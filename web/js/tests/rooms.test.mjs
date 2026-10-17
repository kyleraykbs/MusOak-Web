// The room's client-side state machine: what a user would see change when the
// server says so, and what the player does about it. No DOM here — the
// reducers are pure, and the player is stood in for.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createRoomState,
  applyEvent,
  mergeSnapshot,
  positionMs,
  durationMs,
  moveItem,
  nameOf,
  mayDrive,
  isHost,
  myQueue,
  offsetFrom,
  driftDecision,
  currentRoom,
  enterRoom,
  closeRoom,
  leaveRoom,
  pause,
  skip,
  followWithPlayer,
  setStatusNotice,
  setUnplayableNotice,
  retryItem,
} from "../rooms-state.js";

const KYLE = "member-kyle";
const SAM = "member-sam";

function item(id, title, addedBy) {
  return { id, trackId: `track-${id}`, title, addedBy, addedAtMs: 1 };
}

/** A room where kyle has queued two songs and sam one. */
function twoMemberRoom() {
  let state = createRoomState({ me: KYLE });
  state = mergeSnapshot(state, {
    id: "room-1",
    name: "kitchen",
    host: KYLE,
    controls: "host",
    members: [
      { id: KYLE, name: "kyle", joinedAtMs: 1 },
      { id: SAM, name: "sam", joinedAtMs: 2 },
    ],
    memberCount: 2,
    queues: {
      [KYLE]: [item("a1", "first", KYLE), item("a2", "second", KYLE)],
      [SAM]: [item("b1", "sam one", SAM)],
    },
    masterQueue: [item("a1", "first", KYLE), item("b1", "sam one", SAM), item("a2", "second", KYLE)],
    skip: { skipThreshold: 2, minVotersForSkip: 2, voterFractionForSkip: 0.5 },
  });
  return state;
}

test("a queue event carries one member's queue, and the order the server sent", () => {
  const next = applyEvent(twoMemberRoom(), {
    type: "queue_updated",
    roomId: "room-1",
    data: {
      memberId: SAM,
      memberQueue: [item("b1", "sam one", SAM), item("b2", "sam two", SAM)],
      // The room's fairness is the server's alone - least-heard first, then
      // longest-waiting, then join order - so its answer cannot be worked out
      // here. It is taken as it comes, item for item.
      master: [item("b2", "sam two", SAM), item("b1", "sam one", SAM), item("a2", "second", KYLE)],
    },
  });
  assert.deepEqual(
    next.queues[SAM].map((entry) => entry.id),
    ["b1", "b2"]
  );
  assert.deepEqual(
    next.queues[KYLE].map((entry) => entry.id),
    ["a1", "a2"],
    "the other member's queue is untouched"
  );
  assert.deepEqual(
    next.masterQueue.map((entry) => entry.id),
    ["b2", "b1", "a2"],
    "the order is exactly the server's, not one this client worked out"
  );
  assert.deepEqual(
    next.masterQueue.map((entry) => entry.addedBy),
    [SAM, SAM, KYLE]
  );

  // A payload from before the field keeps the order it had rather than
  // inventing one: an order this client guessed is one the room is not walking,
  // and following it plays a song the room never chose.
  const kept = applyEvent(next, {
    type: "queue_updated",
    roomId: "room-1",
    seq: 6,
    data: { memberId: KYLE, memberQueue: [item("a1", "first", KYLE)] },
  });
  assert.deepEqual(
    kept.masterQueue.map((entry) => entry.id),
    ["b2", "b1", "a2"],
    "an order the event does not carry is left where it was"
  );
});

test("a member leaving takes their queue out of the mix", () => {
  const left = applyEvent(twoMemberRoom(), {
    type: "member_left",
    roomId: "room-1",
    data: { memberId: SAM, memberCount: 1 },
  });
  assert.equal(left.queues[SAM], undefined, "their queue is dropped");
  assert.equal(left.memberCount, 1);
  // The order this changes is published by the server as a queue event of its
  // own, and that is the one to keep: deriving a replacement is the divergence
  // that had members playing songs the room had never chosen.
  assert.deepEqual(
    left.masterQueue.map((entry) => entry.id),
    ["a1", "b1", "a2"],
    "the order waits for the server's own answer"
  );
});

test("the playback event replaces the song, and the order loses it", () => {
  const room = twoMemberRoom();
  const playing = applyEvent(room, {
    type: "playback",
    roomId: "room-1",
    seq: 1,
    data: { current: { item: item("a1", "first", KYLE), positionMs: 0, atMs: 1000, started: true, paused: false, durationMs: 30000 } },
  });
  assert.equal(playing.current.item.id, "a1");
  assert.equal(playing.seq, 1);
  assert.deepEqual(
    playing.queues[KYLE].map((entry) => entry.id),
    ["a1", "a2"],
    "the playing song keeps its place in its owner's queue while it plays"
  );
  // The order the server keeps is what is yet to come: a song leaves it as it
  // becomes the one playing, so a client whose order still named the song on
  // would hand that song back to itself on the next advance.
  assert.deepEqual(
    playing.masterQueue.map((entry) => entry.id),
    ["b1", "a2"],
    "the song on is not part of the order"
  );

  // The same song, moved: a pause says nothing about the queues or the order.
  const paused = applyEvent(playing, {
    type: "playback",
    roomId: "room-1",
    seq: 2,
    data: { current: { item: item("a1", "first", KYLE), positionMs: 4000, atMs: 2000, started: true, paused: true, durationMs: 30000 } },
  });
  assert.equal(paused.current.paused, true);
  assert.deepEqual(
    paused.queues[KYLE].map((entry) => entry.id),
    ["a1", "a2"]
  );
  assert.deepEqual(paused.masterQueue.map((entry) => entry.id), ["b1", "a2"]);

  // The room moved on: the played song leaves its owner's queue, and the song
  // it moved onto leaves the order — the same two the server did, and in the
  // same order the server did them in.
  const advanced = applyEvent(paused, {
    type: "playback",
    roomId: "room-1",
    seq: 3,
    data: { current: { item: item("b1", "sam one", SAM), positionMs: 0, atMs: 3000, started: false, paused: true, durationMs: 30000 } },
  });
  assert.equal(advanced.current.item.id, "b1");
  assert.equal(advanced.current.started, false, "the next song waits for the room");
  assert.deepEqual(
    advanced.queues[KYLE].map((entry) => entry.id),
    ["a2"]
  );
  assert.deepEqual(
    advanced.masterQueue.map((entry) => entry.id),
    ["a2"],
    "b1 began, so it is the song on and not part of what is yet to come"
  );
});

test("the beat that says the same song at the same point is not a new room", () => {
  const room = twoMemberRoom();
  const song = { item: item("a1", "first", KYLE), positionMs: 0, atMs: 1000, started: true, paused: false, durationMs: 30000 };
  const playing = applyEvent(room, { type: "playback", roomId: "room-1", seq: 1, data: { current: song } });

  // The heartbeat: the same anchor a second on, which is the same point of the
  // same song. It has to leave the state alone - a room that answered with a
  // fresh object on every beat is a room whose views rebuild their DOM every
  // second they are open, losing the scroll and the drag with it.
  const beat = applyEvent(playing, {
    type: "playback",
    roomId: "room-1",
    seq: 2,
    data: { current: { ...song, positionMs: 1000, atMs: 2000 } },
  });
  assert.equal(beat, playing, "nothing observable changed, so nothing is rebuilt");

  // A room with nothing on has nothing to say either.
  const idle = createRoomState({ me: KYLE });
  assert.equal(applyEvent(idle, { type: "playback", data: { current: null } }), idle);

  // A beat with something to say is still a change: a pause, and a vote.
  const paused = applyEvent(playing, {
    type: "playback",
    roomId: "room-1",
    seq: 3,
    data: { current: { ...song, paused: true } },
  });
  assert.notEqual(paused, playing);
  assert.equal(paused.current.paused, true);
  const voted = applyEvent(playing, {
    type: "playback",
    roomId: "room-1",
    seq: 4,
    data: { current: { ...song, votes: { [SAM]: 5 }, meanScore: 5 } },
  });
  assert.notEqual(voted, playing, "a vote is a tally that changed");
});

test("the room's position ages from its anchor, and stops when paused", () => {
  let state = createRoomState({ me: KYLE, serverOffsetMs: 0 });
  state = mergeSnapshot(state, {
    id: "room-1",
    current: { item: item("a1", "first", KYLE), positionMs: 1000, atMs: 5000, started: true, paused: false, durationMs: 30000 },
  });
  // Server clock is this machine's clock here, so nowMs is a server instant.
  assert.equal(positionMs(state, 8000), 4000);
  assert.equal(durationMs(state), 30000);

  const paused = applyEvent(state, {
    type: "playback",
    roomId: "room-1",
    data: { current: { item: item("a1", "first", KYLE), positionMs: 4000, atMs: 8000, started: true, paused: true, durationMs: 30000 } },
  });
  assert.equal(positionMs(paused, 20000), 4000, "a paused room does not move");

  const held = mergeSnapshot(state, {
    id: "room-1",
    current: { item: item("a1", "first", KYLE), positionMs: 0, atMs: 0, started: false, paused: false, durationMs: 30000 },
  });
  assert.equal(positionMs(held, 999999), 0, "a song the room has not begun waits at zero");
});

test("the host decides who may drive, and nothing about the clock", () => {
  const room = twoMemberRoom();
  assert.equal(isHost(room), true, "kyle hosts it");
  assert.equal(mayDrive(room, KYLE), true);
  assert.equal(mayDrive(room, SAM), false, "host controls: only the host may drive");
  const open = mergeSnapshot(room, { id: "room-1", controls: "everyone", host: KYLE });
  assert.equal(mayDrive(open, SAM), true, "everyone controls: any member may");
  assert.equal(isHost({ ...open, me: SAM }), false);
});

test("the small helpers read the room as the views do", () => {
  const room = twoMemberRoom();
  assert.equal(nameOf(room, SAM), "sam");
  assert.equal(nameOf(room, "member-zzzzzzzz"), "member-z");
  assert.deepEqual(
    myQueue(room).map((entry) => entry.id),
    ["a1", "a2"]
  );
  assert.deepEqual(moveItem(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.equal(driftDecision(0, 1000), "hold");
  assert.equal(driftDecision(0, 5000), "forward");
  assert.equal(driftDecision(9000, 5000), "back");
  assert.equal(driftDecision(2000, 0), "hold", "exactly the tolerance is close enough");
  assert.equal(driftDecision(2001, 0), "back", "a hair past it is corrected");
  assert.equal(offsetFrom(100, 300, 200), 0, "a symmetric trip is no offset");
});

test("the clock offset ignores the heartbeat's untimed pong", () => {
  let state = createRoomState({ me: KYLE });
  // A socket heartbeat pong: no clientSentAt, so no measurement is possible.
  state = applyEvent(state, { type: "pong", clientSentAt: 0, serverReceivedAt: 1791244159849, clientReceivedAt: 1791244160000 });
  assert.equal(state.clockSamples.length, 0, "an untimed pong is not a sample");
  assert.equal(state.serverOffsetMs, 0, "and it does not move the offset");

  // A real sample: the loopback trip took under a millisecond, and answering
  // half a second off the server's clock is what the offset should say.
  state = applyEvent(state, {
    type: "pong",
    clientSentAt: 1000,
    clientReceivedAt: 1002,
    serverReceivedAt: 2000,
  });
  assert.equal(state.clockSamples.length, 1);
  assert.equal(state.serverOffsetMs, 999, "serverReceived - (sent + received)/2");
});

// --- following the room ----------------------------------------------------
//
// The rule, the same for every member: a different song is loaded, the same
// song within two seconds is left alone, the same song further out is seeked,
// and when the local file runs out before the room's next tick the member
// advances to the next song of the room's order on its own.

const BASE_ROOM = {
  id: "room-1",
  name: "kitchen",
  host: KYLE,
  controls: "everyone",
  members: [
    { id: KYLE, name: "kyle", joinedAtMs: 1 },
    { id: SAM, name: "sam", joinedAtMs: 2 },
  ],
  memberCount: 2,
};

function fakeClient({ room = BASE_ROOM, memberId = KYLE } = {}) {
  const calls = { joins: [], commands: [], leaves: [], sockets: [], snapshots: 0 };
  const client = {
    memberId,
    calls,
    roomData: room,
    joinRoom(roomId, password) {
      calls.joins.push({ roomId, password });
      return Promise.resolve({ room: client.roomData, memberId: client.memberId });
    },
    room() {
      calls.snapshots += 1;
      return Promise.resolve(client.roomData);
    },
    roomSocket({ roomId, onEvent, onOpen }) {
      const socket = {
        roomId,
        send() {},
        close() {},
        onEvent: (message) => onEvent?.(message),
        open: () => onOpen?.(),
      };
      calls.sockets.push(socket);
      return socket;
    },
    roomPause(roomId) {
      calls.commands.push({ name: "roomPause", args: [roomId] });
      return Promise.resolve(client.roomData);
    },
    roomSkip(roomId) {
      calls.commands.push({ name: "roomSkip", args: [roomId] });
      // The command answers with the room as it now stands, the snapshot the
      // real endpoint sends: the order the skip produced comes back with it.
      return Promise.resolve(client.roomData);
    },
    leaveRoom(roomId) {
      calls.leaves.push(roomId);
      return Promise.resolve({});
    },
  };
  return client;
}

class FakePlayer {
  constructor() {
    this.queue = [];
    this.index = -1;
    this.variant = "";
    this.room = null;
    this.loading = false;
    this.error = "";
    this.position = 0;
    this.duration = 30000;
    this.measured = null;
    this.paused = true;
    this.ended = false;
    this.plays = [];
    this.seeks = [];
    this.warmed = [];
    this.deferLoad = false;
    this.resolvedVariant = "v-default";
    // The offline surface: what this page holds, and whether the server looks
    // reachable. A test turns `offline` on to be a member with nothing to say.
    this.offline = false;
    this.held = new Set();
    this.kept = [];
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event)?.delete(handler);
  }

  emit(event) {
    for (const handler of this._listeners.get(event) || []) handler();
  }

  current() {
    return this.index >= 0 && this.index < this.queue.length ? this.queue[this.index] : null;
  }

  variantId() {
    return this.variant;
  }

  variantFor() {
    return Promise.resolve({ variantId: this.resolvedVariant });
  }

  warm(track) {
    this.warmed.push(track);
  }

  positionMs() {
    return this.position;
  }

  measuredDurationMs() {
    return this.measured === null ? this.duration : this.measured;
  }

  state() {
    return { loading: this.loading, error: this.error, paused: this.paused, playing: !this.paused };
  }

  isPaused() {
    return this.paused;
  }

  hasEnded() {
    return this.ended;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  seek(ms) {
    this.seeks.push(ms);
    this.position = ms;
  }

  playRoomTrack(track, { positionMs = 0, autoplay = true } = {}) {
    this.plays.push({ track, positionMs, autoplay });
    this.queue = [track];
    this.index = 0;
    this.position = positionMs;
    this.loading = this.deferLoad;
    if (!this.deferLoad) {
      Promise.resolve().then(() => {
        this.loading = false;
        this.paused = !autoplay;
      });
    }
    return Promise.resolve();
  }

  setRoom(room) {
    this.room = room;
  }

  online() {
    return !this.offline;
  }

  offlineState(trackId) {
    return this.held.has(String(trackId)) ? "ready" : "none";
  }

  offlineSummary() {
    return { ready: this.held.size, pending: 0, held: this.held.size, bytes: 0, online: this.online() };
  }

  keepOffline(tracks) {
    this.kept = (Array.isArray(tracks) ? tracks : []).map((entry) => String(entry?.id || ""));
  }

  playOffline(track) {
    if (!this.held.has(String(track.id))) return false;
    this.queue = [{ id: String(track.id), title: track.title, roomItemId: String(track.roomItemId || "") }];
    this.index = 0;
    this.ended = false;
    this.paused = false;
    this.plays.push({ track: this.queue[0], variantId: "offline", positionMs: 0, autoplay: true });
    return true;
  }

  durationMs() {
    return this.measuredDurationMs();
  }

  isPlaying() {
    return !this.paused && !this.ended;
  }

  clearRoom() {
    this.room = null;
  }

  inRoom() {
    return Boolean(this.room);
  }

  roomId() {
    return this.room ? this.room.roomId : "";
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

/** The room document with one song up, started or not. */
function roomWith(track, { started = false, paused = false, positionMs: at = 0, atMs = Date.now() } = {}) {
  return {
    ...BASE_ROOM,
    current: { item: track, positionMs: at, atMs, started, paused, durationMs: 30000 },
    masterQueue: [track],
    queues: { [KYLE]: [track] },
  };
}

test("a queue change carries the room's order, and the room's wins", () => {
  const kyle = { id: KYLE, name: "Kyle" };
  const sage = { id: SAM, name: "Sage" };
  const k1 = item("k1", "first", KYLE);
  const k2 = item("k2", "second", KYLE);
  const s1 = { ...item("s1", "hers", SAM), artists: ["Sage"] };
  const state = {
    ...createRoomState({ roomId: "room-1", me: KYLE }),
    members: [kyle, sage],
    queues: { [KYLE]: [k1, k2], [SAM]: [s1] },
  };

  // The server's order: sage's song first, then Kyle's two - which is not what
  // a client working it out from the member queues in join order would say.
  const kept = applyEvent(state, {
    type: "queue_updated",
    roomId: "room-1",
    seq: 5,
    data: { memberId: KYLE, memberQueue: [k1, k2], master: [s1, k1, k2] },
  });
  assert.deepEqual(
    kept.masterQueue.map((entry) => entry.id),
    ["s1", "k1", "k2"],
    "the room's order is taken as it comes, not worked out again here"
  );
  assert.deepEqual(
    kept.masterQueue[0].artists,
    ["Sage"],
    "the artist names ride along with the order they came in"
  );

  // A server that sends none: the order the client already has is kept, since
  // one it worked out here is an order the room is not walking.
  const keptStale = applyEvent(kept, {
    type: "queue_updated",
    roomId: "room-1",
    seq: 6,
    data: { memberId: KYLE, memberQueue: [k1, k2] },
  });
  assert.deepEqual(
    keptStale.masterQueue.map((entry) => entry.id),
    ["s1", "k1", "k2"],
    "an order the event does not carry is left where it was"
  );
});

test("the “click the page once” hint does not outlive the playback it was about", async (t) => {
  t.after(closeRoom);
  const hint = "Your browser is holding playback: click the page once to start the sound.";
  const notices = [];
  const off = setStatusNotice((message) => notices.push(message));
  t.after(off);

  const player = new FakePlayer();
  player.isBlocked = () => player.blocked;
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });

  const track = item("a1", "first", KYLE);
  client.roomData = roomWith(track, { started: true, positionMs: 500, atMs: Date.now() });
  const socket = client.calls.sockets[0];
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 1), "the room's song is loaded");

  // The browser refuses to start the sound, so the page says so: paused, and
  // holding. That is the one state this hint is for.
  player.paused = true;
  player.blocked = true;
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => notices.includes(hint)), `the hint is said while playback is held: ${JSON.stringify(notices)}`);

  // The click lands and the sound goes, and the file then plays out locally
  // while the room is still naming it: the client advances by itself, so this
  // tick takes the self-advance path and never reaches the line that clears the
  // hint. A page that is playing must not wear a hint saying the browser is
  // holding it.
  player.paused = false;
  player.blocked = false;
  player.ended = true;
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 3, data: { current: client.roomData.current } });
  assert.ok(
    await waitFor(() => notices.at(-1) === ""),
    `the hint is cleared once the song is playing, got ${JSON.stringify(notices.at(-1))}`
  );
});

test("a song that has run out here moves the room on rather than stalling", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const first = item("a1", "first", KYLE);
  const second = item("b1", "second", SAM);
  const room = {
    ...BASE_ROOM,
    // The room's clock is well past the end of the file this page holds: its
    // item is longer than the copy that plays it.
    current: { item: first, positionMs: 40000, atMs: Date.now(), started: true, paused: false, durationMs: 30000 },
    queues: { [KYLE]: [first], [SAM]: [second] },
    masterQueue: [first, second],
  };
  const client = fakeClient({ room, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  assert.ok(
    await waitFor(() => player.plays.length === 1 && player.current()?.id === first.trackId),
    "the room's song is loaded"
  );

  // The page reaches the end of its own copy before the room's own boundary.
  // Pausing here and waiting for the room is the stall at the end of a song;
  // the page goes on to the next song of the room's order instead.
  player.measured = 30000;
  player.emit("position");
  assert.ok(await waitFor(() => player.plays.length === 2), "the next song of the room's order is started");
  assert.equal(player.plays[1].track.id, second.trackId, "it is the next song in the room's order");
  assert.equal(player.paused, false, "and this page is not left paused at the end of the old one");
});

test("leaving a room gives the player back", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: KYLE });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  client.roomData = roomWith(track, { started: true });
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 1), "the room's song is loaded");

  let unlinked = false;
  let stopped = false;
  player.inRoom = () => true;
  player.clearRoom = () => {
    unlinked = true;
  };
  player.clear = () => {
    stopped = true;
  };
  await leaveRoom();
  assert.equal(unlinked, true, "the room stops owning the player");
  assert.equal(stopped, true, "and what it put on is let go of, not left playing in the next room");
});

test("a room with nothing on lets go of the song the page was holding", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const first = item("a1", "first", KYLE);
  const room = {
    ...BASE_ROOM,
    current: { item: first, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 },
    queues: { [KYLE]: [first] },
    masterQueue: [first],
  };
  const client = fakeClient({ room, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  assert.ok(await waitFor(() => player.plays.length === 1), "the room's song is loaded");

  // The room has nothing on (a fresh room, or one the server has not started):
  // the song still on the element is not this room's, and it is not left there
  // to look like it is.
  let letGo = false;
  player.clear = () => {
    letGo = true;
  };
  client.roomData = { ...room, current: null };
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: null } });
  assert.ok(await waitFor(() => letGo), "a room that has nothing on is not heard playing something else");
});

test("a member loads the room's song and holds until the room starts it", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });

  const track = item("a1", "first", KYLE);
  client.roomData = roomWith(track);
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });

  assert.ok(await waitFor(() => player.plays.length === 1), "the room's song is loaded");
  assert.equal(player.plays[0].autoplay, false, "a member holds the song until the room starts it");
  assert.equal(player.plays[0].positionMs, 0);

  // The room begins it a moment in: the member's file is already here, and
  // the room is close enough that resuming is all that is wanted.
  client.roomData = roomWith(track, { started: true, positionMs: 500, atMs: Date.now() });
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.paused === false), "the held file plays once the room has started it");
  assert.equal(player.plays.length, 1, "and it is the file already loaded, not a second one");
  assert.equal(player.seeks.length, 0, "half a second out is close enough");
});

test("a member does not restart the same room item while its file loads", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  player.deferLoad = true;
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  client.roomData = roomWith(track, { started: true });
  const socket = client.calls.sockets[0];
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 1));
  assert.equal(player.loading, true);

  player.emit("state-changed");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(player.plays.length, 1, "a load already requested for this room item is not restarted");
});

test("the same track in a new room queue entry reloads from its new position", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const first = item("a1", "same song", KYLE);
  const socket = client.calls.sockets[0];

  client.roomData = roomWith(first, { started: true });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 1));

  const second = { ...first, id: "a2" };
  client.roomData = roomWith(second, { started: true });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 2), "a second queue copy starts a new local playback");
  assert.equal(player.plays[1].track.id, first.trackId);
  assert.ok(player.plays[1].positionMs < 1000, `the new copy starts at the room's start (${player.plays[1].positionMs}ms in)`);
});

test("a follower arriving at a running song starts where the room is", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);

  client.roomData = roomWith(track, { started: true, positionMs: 5000, atMs: Date.now() });
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });

  assert.ok(await waitFor(() => player.plays.length === 1), "the running song is loaded");
  assert.equal(player.plays[0].autoplay, true, "a running song is played, not held");
  assert.ok(player.plays[0].positionMs >= 5000, `loaded at the room's position (${player.plays[0].positionMs})`);
});

test("a follower seeks when it is more than two seconds off, and not before", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  const socket = client.calls.sockets[0];

  client.roomData = roomWith(track, { started: true, positionMs: 0, atMs: Date.now() });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  await waitFor(() => player.plays.length === 1);

  // Within the tolerance: nothing happens.
  player.position = 1200;
  client.roomData = roomWith(track, { started: true, positionMs: 1000, atMs: Date.now() });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(player.seeks.length, 0, "within two seconds is close enough");

  // More than two seconds out: a seek onto the room's position.
  player.position = 0;
  client.roomData = roomWith(track, { started: true, positionMs: 5000, atMs: Date.now() });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 3, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.seeks.length === 1), "a drifted member is seeked back");
  assert.ok(player.seeks[0] >= 5000, `seeked to the room (${player.seeks[0]})`);
});

test("a correction over two seconds seeks the member onto the room's position", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  const socket = client.calls.sockets[0];

  client.roomData = roomWith(track, { started: true, positionMs: 0, atMs: Date.now() });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  await waitFor(() => player.plays.length === 1);

  // The local playhead is at the start; the room is five seconds in.
  player.position = 0;
  client.roomData = roomWith(track, { started: true, positionMs: 5000, atMs: Date.now() });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.seeks.length === 1), "a drift over two seconds is corrected");
  assert.ok(player.seeks[0] >= 5000, `seeked onto the room's position (${player.seeks[0]})`);
});

test("a drift of two seconds or less is left alone", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  const socket = client.calls.sockets[0];

  client.roomData = roomWith(track, { started: true, positionMs: 0, atMs: Date.now() });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  await waitFor(() => player.plays.length === 1);

  // A second or so out: inside the tolerance, so the local playhead is kept.
  player.position = 1000;
  client.roomData = roomWith(track, { started: true, positionMs: 0, atMs: Date.now() });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(player.seeks.length, 0, "within the tolerance the local playhead is left where it is");
});

test("a change of the room's current song loads that song", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const first = item("a1", "first", KYLE);
  const second = item("b1", "second", SAM);
  const socket = client.calls.sockets[0];

  client.roomData = roomWith(first, { started: true });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 1));
  assert.equal(player.current().id, first.trackId);

  client.roomData = roomWith(second, { started: true });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 2), "the room's new song is loaded");
  assert.equal(player.plays[1].track.id, second.trackId);
});

test("when its file ends, the member advances locally and keeps playing", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const first = item("a1", "first", KYLE);
  const second = item("b1", "second", SAM);
  const room = {
    ...BASE_ROOM,
    current: { item: first, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 },
    queues: { [KYLE]: [first], [SAM]: [second] },
    masterQueue: [first, second],
  };
  const client = fakeClient({ room, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  assert.ok(await waitFor(() => player.plays.length === 1 && player.current()?.id === first.trackId));

  // The local file runs out while the room's clock still has the song: this
  // member's copy is shorter than the room thinks the song is, and moving on
  // here is the premature switch - the room's own change then drags them back.
  // So they wait it out, quietly.
  player.ended = true;
  player.emit("position");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(player.plays.length, 1, "a file that ends early does not move the member on");

  // The room's own clock reaches the end of the song: that is the transition.
  client.calls.sockets[0].onEvent({
    type: "playback", roomId: "room-1", seq: 2,
    data: { current: { item: first, positionMs: 30000, atMs: Date.now(), started: true, paused: false, durationMs: 30000 } },
  });
  assert.ok(await waitFor(() => player.plays.length === 2), "the next song of the room's order is loaded");
  assert.equal(player.plays[1].track.id, second.trackId);
  assert.equal(player.plays[1].positionMs, 0);
  assert.equal(player.plays[1].autoplay, true);
  assert.equal(player.paused, false, "and it keeps playing");

  // The room's own tick lags by up to a second and still names the song we
  // left. It must not drag the member back onto it.
  client.calls.sockets[0].onEvent({
    type: "playback", roomId: "room-1", seq: 3,
    data: { current: { item: first, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 } },
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(player.plays.length, 2, "a stale current does not reload the played song");
  assert.equal(player.current().id, second.trackId, "and the member stays on the next song");
});

test("an idle room stops this client's player", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  const socket = client.calls.sockets[0];

  client.roomData = roomWith(track, { started: true });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  await waitFor(() => player.plays.length === 1 && player.paused === false);

  client.roomData = { ...BASE_ROOM, current: null, masterQueue: [], queues: {} };
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: null } });
  assert.ok(await waitFor(() => player.paused === true), "nothing playing means nothing playing here");
});

// The room's seq counts every event it publishes, including the beats that
// change nothing here (see the reducer test above). A beat the state does not
// take up is still one the socket heard: if it were not counted, the next event
// would look like a gap in the stream and the client would go back for a
// snapshot it does not need.
test("a beat the room spends on nothing is still an event heard", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  client.roomData = roomWith(track, { started: true });
  const socket = client.calls.sockets[0];
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 1));
  const fetches = client.calls.snapshots;

  // Two beats that say nothing, then a queue event: seq 4 follows seq 3 with
  // nothing missing in between, so nothing is fetched to fill a hole.
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 3, data: { current: client.roomData.current } });
  socket.onEvent({ type: "queue_updated", roomId: "room-1", seq: 4, data: { memberId: KYLE, memberQueue: [track] } });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(client.calls.snapshots, fetches, "the stream was whole, so the room was not refetched");
});

test("a command folds the room's answer into the state", async (t) => {
  t.after(closeRoom);
  const client = fakeClient({ memberId: KYLE });
  await enterRoom({ client, roomId: "room-1" });
  const track = item("a1", "first", KYLE);
  client.roomData = roomWith(track, { started: true, paused: false });
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.equal(currentRoom().current.paused, false);

  client.roomData = roomWith(track, { started: true, paused: true });
  await pause();
  assert.equal(currentRoom().current.paused, true, "the answer is the room as it stands now");
  assert.equal(client.calls.commands[0].name, "roomPause");
});

test("leaving the room forgets it here and on the server", async (t) => {
  const client = fakeClient({ memberId: KYLE });
  await enterRoom({ client, roomId: "room-1" });
  assert.ok(currentRoom());
  await leaveRoom();
  assert.equal(currentRoom(), null);
  assert.deepEqual(client.calls.leaves, ["room-1"]);
});

// --- offline, in a room -----------------------------------------------------

/** The room's three songs, the follower holding the last two on this device. */
function offlineRoom() {
  const first = item("a1", "first", KYLE);
  const second = item("b1", "second", SAM);
  const third = item("c1", "third", KYLE);
  const room = {
    ...BASE_ROOM,
    current: { item: first, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 },
    queues: { [KYLE]: [first, third], [SAM]: [second] },
    masterQueue: [first, second, third],
  };
  return { first, second, third, room };
}

test("an offline follower plays the room's order out of this device", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const { first, second, third, room } = offlineRoom();
  const client = fakeClient({ room, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });

  // Nothing is reachable any more, and this device holds the next two songs.
  player.offline = true;
  player.held = new Set([second.trackId, third.trackId]);
  // Its copy of the song the room was on has played out.
  player.queue = [{ id: first.trackId, title: first.title, roomItemId: first.id }];
  player.index = 0;
  player.ended = true;

  player.emit("state-changed");
  assert.ok(
    await waitFor(() => player.plays.some((play) => play.variantId === "offline")),
    "the next song this device holds is played"
  );
  assert.equal(player.plays.at(-1).track.id, second.trackId);
  assert.deepEqual(client.calls.commands, [], "nothing was asked of a room that cannot be reached");

  // The room's order is what it follows, and the page kept it for this.
  assert.ok(player.kept.includes(second.trackId), `kept ${player.kept.join(",")}`);
});

test("coming back online puts the follower on the room's own song again", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const { first, second, third, room } = offlineRoom();
  const client = fakeClient({ room, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });

  player.offline = true;
  player.held = new Set([second.trackId]);
  player.queue = [{ id: first.trackId, title: first.title, roomItemId: first.id }];
  player.index = 0;
  player.ended = true;
  player.emit("state-changed");
  await waitFor(() => player.plays.some((play) => play.variantId === "offline"));

  // Back on the network, and the room has moved on without us: the room is the
  // truth, so the song it is on is the song that plays.
  const moved = { ...room, current: { item: third, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 } };
  client.roomData = moved;
  player.offline = false;
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 9, data: { current: moved.current } });

  assert.ok(
    await waitFor(() => player.plays.at(-1)?.track?.id === third.trackId && player.plays.at(-1)?.variantId !== "offline"),
    `the room's song is loaded (${player.plays.at(-1)?.track?.id})`
  );
});

// The room's pause has to reach this member's own player. It is the one action
// where the room and the client disagree in the middle of doing nothing: the
// room says paused, this page's sound is still going, and a button that only
// stops the bot is a button that did not work.
test("the room's pause pauses this member's own player", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  const socket = client.calls.sockets[0];

  client.roomData = roomWith(track, { started: true, paused: false, atMs: Date.now() });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 1 && player.paused === false), "the room's song plays here");

  client.roomData = roomWith(track, { started: true, paused: true, positionMs: 4000, atMs: Date.now() });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.paused === true), "the room's pause reaches this page's player");

  client.roomData = roomWith(track, { started: true, paused: false, positionMs: 4000, atMs: Date.now() });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 3, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.paused === false), "and the room's play starts it again");
});

// A skip is one load of the room's new song and then a hold. The follow tick
// runs several times a second (every beat, and every position the player
// emits), so anything the tick does anew is done per tick: a provider
// resolution and a fetch of the songs ahead, a re-derivation of the offline
// window across the whole order, and - if the load never lands - a fresh
// `_load` that pauses the element and clears its source, which is a song that
// never buffers. A 40-song room made that a page falling over instead of a
// song change.
test("a skip is one load and then a hold, whatever the ticks do", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const counts = { playRoomTrack: 0, seek: 0, keepOffline: 0 };
  for (const name of ["playRoomTrack", "seek", "keepOffline"]) {
    const real = player[name].bind(player);
    player[name] = (...args) => {
      counts[name] += 1;
      return real(...args);
    };
  }

  // The room's order for what comes next, as the server's fairness has it:
  // kyle's second song before sam's first, which no rule of this client's
  // would arrive at by itself.
  const first = item("a1", "first", KYLE);
  const second = item("b1", "second", SAM);
  const third = item("c1", "third", KYLE);
  const room = {
    ...BASE_ROOM,
    current: { item: first, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 },
    queues: { [KYLE]: [first, third], [SAM]: [second] },
    masterQueue: [third, second],
  };
  const client = fakeClient({ room, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const socket = client.calls.sockets[0];
  assert.ok(await waitFor(() => player.plays.length === 1 && player.current()?.id === first.trackId));
  await new Promise((resolve) => setTimeout(resolve, 60));

  // The skip: the room takes the head of its order, publishes the song it is
  // on, and answers the command with the room as it now stands.
  const skipped = {
    ...room,
    current: { item: third, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 },
    queues: { [KYLE]: [third], [SAM]: [second] },
    masterQueue: [second],
  };
  client.roomData = skipped;
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: skipped.current } });
  socket.onEvent({
    type: "queue_updated",
    roomId: "room-1",
    seq: 3,
    data: { memberId: KYLE, memberQueue: [third], master: [second] },
  });
  await skip();
  assert.ok(await waitFor(() => player.current()?.id === third.trackId), "the member is on the song the room skipped to");
  assert.deepEqual(
    currentRoom().masterQueue.map((entry) => entry.id),
    ["b1"],
    "the order is the one the server sent, not one derived here"
  );

  // A second of ticks - position events and the follow ticker both - asks for
  // nothing more: not another load, not another source, not another warm.
  const settled = { ...counts };
  for (let beat = 0; beat < 16; beat += 1) {
    player.emit("position");
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.deepEqual(counts, settled, "a second of ticks asked for nothing more");
  assert.equal(counts.playRoomTrack, 2, "one load for the room's first song, one for the skip");
  assert.ok(counts.keepOffline <= 6, `the songs ahead are kept once per window, not per tick (${counts.keepOffline})`);
});

test("a room load is not repeated on every tick", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  let asked = 0;
  const real = player.playRoomTrack.bind(player);
  player.playRoomTrack = (...args) => {
    asked += 1;
    return real(...args);
  };
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  client.roomData = roomWith(track, { started: true, positionMs: 0, atMs: Date.now() });
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => asked === 1), "the room's song is asked for once");
  for (let beat = 0; beat < 8; beat += 1) {
    player.emit("position");
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  assert.equal(asked, 1, "a room load is left alone");
});


// The same thing through the engine, where it was seen: a song change moves the
// member on, the room's own beat is still naming the song they left, and the
// pause pressed in that window has to reach their player.
test("a pause pressed after a song change reaches this member", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const first = item("a1", "first", KYLE);
  const second = item("b1", "second", SAM);
  const room = {
    ...BASE_ROOM,
    current: { item: first, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 },
    queues: { [KYLE]: [first], [SAM]: [second] },
    masterQueue: [first, second],
  };
  const client = fakeClient({ room, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  assert.ok(await waitFor(() => player.plays.length === 1 && player.current()?.id === first.trackId));

  // The room's clock reaches the end of the song: the member moves to the next
  // one by itself, so the room's own beat still names the song they left.
  const socket = client.calls.sockets[0];
  socket.onEvent({
    type: "playback", roomId: "room-1", seq: 2,
    data: { current: { item: first, positionMs: 30000, atMs: Date.now(), started: true, paused: false, durationMs: 30000 } },
  });
  assert.ok(await waitFor(() => player.plays.length === 2), "the member advanced locally");

  // The room pauses while its own beat still names the song that just played.
  socket.onEvent({
    type: "playback", roomId: "room-1", seq: 3,
    data: { current: { item: first, positionMs: 0, atMs: Date.now(), started: true, paused: true, durationMs: 30000 } },
  });
  assert.ok(await waitFor(() => player.paused === true), "the pause reaches the player despite the stale item");

  // And the room playing again starts this member again.
  socket.onEvent({
    type: "playback", roomId: "room-1", seq: 4,
    data: { current: { item: first, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 } },
  });
  assert.ok(await waitFor(() => player.paused === false), "and its play starts the member again");
});

// A transition is a switch, not a search. The source of the next songs is
// worked out while the current one is playing, so the song change does not sit
// on a provider round trip - and it starts where the room is *then*, not where
// it was when the decision was made, or the drift rule would seek it back and
// be heard as "syncing" a moment after the song started.
test("a room transition uses the shared playback pipeline", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const first = item("a1", "first", KYLE);
  const second = item("b1", "second", SAM);
  const room = {
    ...BASE_ROOM,
    current: { item: first, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 },
    queues: { [KYLE]: [first], [SAM]: [second] },
    masterQueue: [first, second],
  };
  const client = fakeClient({ room, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  assert.ok(await waitFor(() => player.plays.length === 1), "the room's song is playing");
  client.calls.sockets[0].onEvent({
    type: "playback", roomId: "room-1", seq: 2,
    data: { current: { item: second, positionMs: 0, atMs: Date.now(), started: true, paused: false, durationMs: 30000 } },
  });
  assert.ok(await waitFor(() => player.plays.length === 2), "the member moves to the next song");
});
