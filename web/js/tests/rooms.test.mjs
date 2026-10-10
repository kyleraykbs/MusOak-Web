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
  followWithPlayer,
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

test("a queue event carries one member's queue, and the mix is derived", () => {
  const next = applyEvent(twoMemberRoom(), {
    type: "queue_updated",
    roomId: "room-1",
    data: { memberId: SAM, memberQueue: [item("b1", "sam one", SAM), item("b2", "sam two", SAM)] },
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
  // One item from each member per pass, in join order: kyle, sam, kyle, sam.
  assert.deepEqual(
    next.masterQueue.map((entry) => entry.id),
    ["a1", "b1", "a2", "b2"]
  );
  assert.deepEqual(
    next.masterQueue.map((entry) => entry.addedBy),
    [KYLE, SAM, KYLE, SAM]
  );
});

test("a member leaving takes their queue out of the mix", () => {
  const left = applyEvent(twoMemberRoom(), {
    type: "member_left",
    roomId: "room-1",
    data: { memberId: SAM, memberCount: 1 },
  });
  assert.equal(left.queues[SAM], undefined, "their queue is dropped");
  assert.deepEqual(
    left.masterQueue.map((entry) => entry.id),
    ["a1", "a2"]
  );
  assert.equal(left.memberCount, 1);
});

test("the playback event replaces the song, and drops the one it left", () => {
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

  // The same song, moved: a pause says nothing about the queues.
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

  // The room moved on: the played song leaves its owner's queue and the mix,
  // exactly as the server dropped it.
  const advanced = applyEvent(paused, {
    type: "playback",
    roomId: "room-1",
    seq: 3,
    data: { current: { item: item("b1", "sam one", SAM), positionMs: 0, atMs: 3000, started: false, paused: true, durationMs: 30000 } },
  });
  assert.equal(advanced.current.item.id, "b1");
  assert.equal(advanced.current.started, false, "the next song waits for the host");
  assert.deepEqual(
    advanced.queues[KYLE].map((entry) => entry.id),
    ["a2"]
  );
  // The order is spliced, not rebuilt: b1 was next in the room's round robin
  // and stays next, even though a fresh derive would put kyle's a2 first.
  assert.deepEqual(
    advanced.masterQueue.map((entry) => entry.id),
    ["b1", "a2"]
  );
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
  assert.equal(positionMs(held, 999999), 0, "a song the host has not begun waits at zero");
});

test("the host is the one whose player is the clock", () => {
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

// --- the follower ----------------------------------------------------------
//
// The rule: a different song is loaded, the same song within two seconds is
// left alone, the same song further out is seeked. The host adds the two words
// the room cannot know otherwise.

const HOST_ROOM = {
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

function fakeClient({ room = HOST_ROOM, memberId = KYLE } = {}) {
  const calls = { joins: [], commands: [], syncs: [], leaves: [], sockets: [], snapshots: 0 };
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
    roomSync(roomId, state) {
      calls.syncs.push({ roomId, state });
      return Promise.resolve();
    },
    roomPause(roomId) {
      calls.commands.push({ name: "roomPause", args: [roomId] });
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

  playVariant(track, variantId, { positionMs = 0, autoplay = true } = {}) {
    this.plays.push({ track, variantId, positionMs, autoplay });
    this.queue = [track];
    this.index = 0;
    this.variant = variantId;
    this.position = positionMs;
    this.loading = this.deferLoad;
    // The fetch lands a moment later, as a real one does.
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
  setRoomQueue(tracks, currentItemId = "", { positionMs = 0, autoplay = true } = {}) {
    const old = this.current();
    const list = Array.isArray(tracks) ? tracks : [];
    if (!list.length) {
      this.queue = [];
      this.index = -1;
      this.paused = true;
      this.ended = false;
      this.emit("track-changed");
      return;
    }
    let index = currentItemId ? list.findIndex((entry) => entry.roomItemId === currentItemId) : 0;
    if (index < 0) index = 0;
    const target = list[index];
    const same = old?.roomItemId && old.roomItemId === target.roomItemId;
    this.queue = list;
    this.index = index;
    if (!same) {
      this.position = positionMs;
      this.paused = !autoplay;
      this.ended = false;
      this.duration = target.durationMs || this.duration;
      this.variant = "v-default";
    }
    this.emit("track-changed");
  }

  durationMs() {
    return this.measuredDurationMs();
  }

  isPlaying() {
    return !this.paused && !this.ended;
  }

  next() {
    if (!this.room?.hostPlayback || this.index + 1 >= this.queue.length) return;
    this.index += 1;
    this.position = 0;
    this.paused = false;
    this.ended = false;
    this.emit("track-changed");
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
    ...HOST_ROOM,
    current: { item: track, positionMs: at, atMs, started, paused, durationMs: 30000 },
    masterQueue: [track],
    queues: { [KYLE]: [track] },
  };
}

test("a follower loads the room's song and holds until the host starts it", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });

  const track = item("a1", "first", KYLE);
  client.roomData = roomWith(track);
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });

  assert.ok(await waitFor(() => player.plays.length === 1), "the room's song is loaded");
  assert.equal(player.plays[0].autoplay, false, "a follower holds the song for the host");
  assert.equal(player.plays[0].positionMs, 0);
  assert.equal(client.calls.syncs.length, 0, "a follower never reports host state");

  // The host begins it a moment in: the follower's file is already here, and
  // the room is close enough that resuming is all that is wanted.
  client.roomData = roomWith(track, { started: true, positionMs: 500, atMs: Date.now() });
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.paused === false), "the held file plays once the host has started");
  assert.equal(player.plays.length, 1, "and it is the file already loaded, not a second one");
  assert.equal(player.seeks.length, 0, "half a second out is close enough");
});

test("a follower does not restart the same room item while its file loads", async (t) => {
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
  assert.equal(player.plays[1].positionMs, 0);
  assert.equal(client.calls.syncs.length, 0, "followers never send host state");
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
  assert.equal(client.calls.syncs.length, 0, "joining a running song does not report host state");
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

test("the host plays the generated mixed queue and syncs its local advance", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const first = item("a1", "host first", KYLE);
  const guestFirst = item("b1", "guest first", SAM);
  const hostSecond = item("a2", "host second", KYLE);
  const guestSecond = item("b2", "guest second", SAM);
  const room = {
    ...HOST_ROOM,
    current: { item: guestFirst, positionMs: 0, atMs: Date.now(), started: false, paused: true, durationMs: 30000 },
    queues: { [KYLE]: [first, hostSecond], [SAM]: [guestFirst] },
    masterQueue: [first, guestFirst, hostSecond],
  };
  const client = fakeClient({ room, memberId: KYLE });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });

  assert.ok(await waitFor(() => client.calls.syncs.some(({ state }) => state.itemId === guestFirst.id)));
  assert.deepEqual(player.queue.map((entry) => entry.roomItemId), ["b1", "a1", "a2"]);
  const firstSync = client.calls.syncs.find(({ state }) => state.itemId === guestFirst.id).state;
  assert.equal(firstSync.trackId, guestFirst.trackId);
  assert.equal(firstSync.started, true);
  assert.equal(firstSync.paused, false);

  client.calls.sockets[0].onEvent({
    type: "queue_updated", roomId: "room-1", seq: 1,
    data: { memberId: SAM, memberQueue: [guestFirst, guestSecond] },
  });
  assert.ok(await waitFor(() => player.queue.length === 4), "the mixed room queue updates the host's queue");
  assert.deepEqual(player.queue.map((entry) => entry.roomItemId), ["b1", "a1", "a2", "b2"]);

  const beforeAdvance = client.calls.syncs.length;
  assert.equal(player.room?.hostPlayback, true);
  assert.equal(player.index, 0);
  player.next();
  assert.equal(player.current().roomItemId, first.id);
	assert.ok(await waitFor(() => client.calls.syncs.slice(beforeAdvance).some(({ state }) => state.itemId === first.id)));
  const advanced = client.calls.syncs.findLast(({ state }) => state.itemId === first.id).state;
  assert.equal(advanced.trackId, first.trackId);
  assert.equal(advanced.positionMs, 0);
});

test("the host reports an empty queue item when its last file ends", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const only = item("a1", "last", KYLE);
  const room = {
    ...HOST_ROOM,
    current: { item: only, positionMs: 0, atMs: Date.now(), started: false, paused: true, durationMs: 30000 },
    queues: { [KYLE]: [only], [SAM]: [] },
    masterQueue: [only],
  };
  const client = fakeClient({ room, memberId: KYLE });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  assert.ok(await waitFor(() => client.calls.syncs.some(({ state }) => state.itemId === only.id)));

  player.ended = true;
  player.emit("position");
  assert.ok(await waitFor(() => client.calls.syncs.some(({ state }) => state.itemId === "")));
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

  client.roomData = { ...HOST_ROOM, current: null, masterQueue: [], queues: {} };
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: null } });
  assert.ok(await waitFor(() => player.paused === true), "nothing playing means nothing playing here");
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
    ...HOST_ROOM,
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
