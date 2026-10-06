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
  const calls = { joins: [], commands: [], started: [], ended: [], leaves: [], sockets: [], snapshots: 0 };
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
    roomStarted(roomId, trackId, positionMs, durationMs) {
      calls.started.push({ roomId, trackId, positionMs, durationMs });
      return Promise.resolve(client.roomData);
    },
    roomEnded(roomId, trackId) {
      calls.ended.push({ roomId, trackId });
      return Promise.resolve(client.roomData);
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
    this.resolvedVariant = "v-default";
    this._listeners = new Map();
  }

  on() {
    return () => {};
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
    this.ended = false;
    // The fetch lands a moment later, as a real one does.
    Promise.resolve().then(() => {
      this.loading = false;
      this.paused = !autoplay;
    });
    return Promise.resolve();
  }

  setRoom(room) {
    this.room = room;
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
  assert.equal(client.calls.started.length, 0, "a follower never starts the room");

  // The host begins it a moment in: the follower's file is already here, and
  // the room is close enough that resuming is all that is wanted.
  client.roomData = roomWith(track, { started: true, positionMs: 500, atMs: Date.now() });
  client.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.paused === false), "the held file plays once the host has started");
  assert.equal(player.plays.length, 1, "and it is the file already loaded, not a second one");
  assert.equal(player.seeks.length, 0, "half a second out is close enough");
});

test("a song queued again is played again, not left at its end", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: KYLE });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  const socket = client.calls.sockets[0];

  // This client still holds the copy it just finished.
  player.queue = [{ id: track.trackId, title: track.title }];
  player.index = 0;
  player.variant = "v-default";
  player.position = player.duration;
  player.ended = true;
  player.paused = true;

  client.roomData = roomWith(track);
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 1), "the song is loaded again from its start");
  assert.equal(player.plays[0].autoplay, true, "the host begins it");
  assert.equal(player.plays[0].positionMs, 0, "from the beginning, not from the end");

  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => client.calls.started.length === 1), "and the room is started from it");
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
  assert.equal(client.calls.started.length, 0, "joining a running song does not restart the room");
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

test("the host starts the room from its own player", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: KYLE });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  const socket = client.calls.sockets[0];

  client.roomData = roomWith(track);
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => player.plays.length === 1), "the host loads its own rendition");
  assert.equal(player.plays[0].autoplay, true, "the host's player begins the song");

  // The load lands, and the host says where its file is — which starts the room.
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.ok(await waitFor(() => client.calls.started.length >= 1), "the host starts the room");
  const started = client.calls.started[0];
  assert.equal(started.trackId, track.trackId);
  assert.ok(started.durationMs > 0, "the room is told the host's file length");

  // Once per song, not once per tick.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(client.calls.started.length, 1, "the start is reported once");
});

test("the host's file running out moves the room on; a follower's does not", async (t) => {
  t.after(closeRoom);
  const track = item("a1", "first", KYLE);

  const hostPlayer = new FakePlayer();
  const hostClient = fakeClient({ memberId: KYLE });
  t.after(followWithPlayer(hostPlayer));
  t.after(closeRoom);
  await enterRoom({ client: hostClient, roomId: "room-1", rejoin: true });
  hostClient.roomData = roomWith(track, { started: true });
  hostClient.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: hostClient.roomData.current } });
  await waitFor(() => hostPlayer.plays.length === 1);
  hostPlayer.ended = true;
  hostPlayer.position = hostPlayer.duration;
  hostClient.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: hostClient.roomData.current } });
  assert.ok(await waitFor(() => hostClient.calls.ended.length === 1), "the host's end advances the room");
  assert.equal(hostClient.calls.ended[0].trackId, track.trackId);
  closeRoom();

  const followPlayer = new FakePlayer();
  const followClient = fakeClient({ memberId: SAM });
  t.after(followWithPlayer(followPlayer));
  await enterRoom({ client: followClient, roomId: "room-1", rejoin: true });
  followClient.roomData = roomWith(track, { started: true });
  followClient.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: followClient.roomData.current } });
  await waitFor(() => followPlayer.plays.length === 1);
  followPlayer.ended = true;
  followPlayer.position = followPlayer.duration;
  followClient.calls.sockets[0].onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: followClient.roomData.current } });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(followClient.calls.ended.length, 0, "a follower's file ending moves nothing");
});

test("an ended element that never played the song does not move the room", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: KYLE });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  const socket = client.calls.sockets[0];

  client.roomData = roomWith(track, { started: true });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  await waitFor(() => player.plays.length === 1);

  // The copy that was here before fires its end just after the new one began:
  // the element says ended, and it is nineteen milliseconds in.
  player.ended = true;
  player.position = 19;
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(client.calls.ended.length, 0, "a file that never played is not the song ending");
  assert.ok(player.seeks.length === 0 && player.plays.length === 1, "and nothing is reloaded over it");
});

test("an end report the room never heard is said again", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: KYLE });
  let attempts = 0;
  client.roomEnded = () => {
    attempts += 1;
    // The first one is lost - a dropped socket, a proxy that blinked - and the
    // room is left sitting on a song that is over until it arrives.
    if (attempts === 1) return Promise.reject(new Error("connection lost"));
    return Promise.resolve(client.roomData);
  };
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const track = item("a1", "first", KYLE);
  const socket = client.calls.sockets[0];

  client.roomData = roomWith(track, { started: true });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  await waitFor(() => player.plays.length === 1);

  player.ended = true;
  player.position = player.duration;
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });
  assert.equal(await waitFor(() => attempts === 1), true, "the end is reported");
  assert.ok(await waitFor(() => attempts === 2, 6000), "and said again when it was not heard");
});

test("the host applies the end response even if the socket event is missing", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ memberId: KYLE });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });
  const oldTrack = item("a1", "finished", KYLE);
  const nextTrack = item("b1", "next", SAM);
  const socket = client.calls.sockets[0];
  client.roomData = roomWith(oldTrack, { started: true });
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 1, data: { current: client.roomData.current } });
  await waitFor(() => player.plays.length === 1);

  // The server's REST answer already contains the advance. Deliberately do not
  // deliver a playback event: the host must not keep showing the old song until
  // a reconnect or somebody presses the play button and happens to fetch state.
  client.roomData = roomWith(nextTrack, { started: false });
  player.ended = true;
  player.position = player.duration;
  socket.onEvent({ type: "playback", roomId: "room-1", seq: 2, data: { current: client.roomData.current } });

  assert.ok(await waitFor(() => currentRoom()?.current?.item?.id === nextTrack.id), "the REST end answer updates the visible song");
});

test("the end clock refetches a room when its advance event was missed", async (t) => {
  t.after(closeRoom);
  const track = item("a1", "finished", KYLE);
  const player = new FakePlayer();
  const client = fakeClient({ room: roomWith(track, { started: true, positionMs: 30000, atMs: Date.now() }), memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1", rejoin: true });

  // The server has moved off the song, but this socket misses that last
  // playback event. The UI's clock reaches the displayed length; the follower
  // refetches the room rather than showing the old song until somebody presses
  // play and happens to fetch a command response.
  client.roomData = { ...HOST_ROOM, current: null, queues: {}, masterQueue: [] };
  assert.ok(await waitFor(() => currentRoom()?.current === null, 2500), "the clock-end resync learns the room is idle");
  assert.ok(client.calls.snapshots > 1, "the page refetched after the end");
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
