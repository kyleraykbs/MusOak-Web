// The room's client-side state machine: what a user would see change when the
// server says so. No DOM here — the reducers are pure.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createRoomState,
  applyEvent,
  mergeSnapshot,
  positionMs,
  moveItem,
  nameOf,
  mayDrive,
  myQueue,
  offsetFrom,
  enterRoom,
  closeRoom,
  leaveRoom,
  currentRoom,
  enqueue,
  remove,
  reorder,
  clear as clearQueue,
  pause,
  seek,
  vote,
  roomPlayMode,
  driftDecision,
  followWithPlayer,
  transportNotice,
} from "../rooms-state.js";
import { state } from "../state.js";

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
    skip: { skipThreshold: 2, minVotersForSkip: 2, voterFractionForSkip: 0.5, readyTimeoutSeconds: 30 },
  });
  return state;
}

test("queue_updated keeps every member's own queue and the fair master order", () => {
  const state = twoMemberRoom();
  const next = applyEvent(state, {
    type: "queue_updated",
    roomId: "room-1",
    data: {
      queues: {
        [KYLE]: [item("a1", "first", KYLE), item("a2", "second", KYLE)],
        [SAM]: [item("b1", "sam one", SAM), item("b2", "sam two", SAM)],
      },
      masterQueue: [
        item("a1", "first", KYLE),
        item("b1", "sam one", SAM),
        item("a2", "second", KYLE),
        item("b2", "sam two", SAM),
      ],
      queue: [item("b1", "sam one", SAM), item("a2", "second", KYLE), item("b2", "sam two", SAM)],
    },
  });

  // One queue per member, each in its owner's order.
  assert.deepEqual(
    next.queues[KYLE].map((entry) => entry.id),
    ["a1", "a2"]
  );
  assert.deepEqual(
    next.queues[SAM].map((entry) => entry.id),
    ["b1", "b2"]
  );
  assert.deepEqual(
    next.masterQueue.map((entry) => entry.id),
    ["a1", "b1", "a2", "b2"]
  );
  // The round robin is the room's: kyle, sam, kyle, sam.
  assert.deepEqual(
    next.masterQueue.map((entry) => entry.addedBy),
    [KYLE, SAM, KYLE, SAM]
  );
  assert.deepEqual(next.queue.map((entry) => entry.id), ["b1", "a2", "b2"]);
  assert.deepEqual(myQueue(next), next.queues[KYLE]);
});

test("a queue event carries only the member whose queue moved", () => {
  const state = twoMemberRoom();
  // The server names the member whose queue changed and sends only theirs. The
  // master mix is a function of the queues and the join order, which the client
  // already has: sending it made every edit cost the whole room.
  const next = applyEvent(state, {
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
  const state = twoMemberRoom();
  const left = applyEvent(state, { type: "member_left", roomId: "room-1", data: { memberId: SAM, memberCount: 1 } });
  const after = applyEvent(left, { type: "queue_updated", roomId: "room-1", data: { memberId: SAM, gone: true } });
  assert.equal(after.queues[SAM], undefined, "their queue is dropped, not replaced");
  assert.deepEqual(
    after.masterQueue.map((entry) => entry.id),
    ["a1", "a2"],
    "the mix is only the members who are here"
  );
});

test("a queue_updated without a pending list derives it from the master queue", () => {
  const playing = applyEvent(twoMemberRoom(), {
    type: "queue_updated",
    roomId: "room-1",
    data: { queues: {}, masterQueue: [item("a1", "first", KYLE), item("b1", "sam one", SAM)] },
  });
  const started = applyEvent(playing, {
    type: "track_started",
    roomId: "room-1",
    data: { item: item("a1", "first", KYLE), startedAt: 1000, timelineMs: 20000 },
  });
  const next = applyEvent(started, {
    type: "queue_updated",
    roomId: "room-1",
    data: { queues: {}, masterQueue: [item("a1", "first", KYLE), item("b1", "sam one", SAM)] },
  });
  assert.deepEqual(next.queue.map((entry) => entry.id), ["b1"]);
});

test("members joining and leaving keep the count honest", () => {
  const two = twoMemberRoom();
  const three = applyEvent(two, {
    type: "member_joined",
    roomId: "room-1",
    data: { member: { id: "member-jo", name: "jo" }, memberCount: 3 },
  });
  assert.equal(three.memberCount, 3);
  assert.equal(nameOf(three, "member-jo"), "jo");
  assert.equal(nameOf(three, "member-kyle"), "kyle");
  assert.equal(nameOf(three, "member-unknown"), "member-u");

  // Joining twice is one member, not two.
  const again = applyEvent(three, {
    type: "member_joined",
    roomId: "room-1",
    data: { member: { id: "member-jo", name: "jo" }, memberCount: 3 },
  });
  assert.equal(again.members.length, 3);

  const left = applyEvent(again, { type: "member_left", roomId: "room-1", data: { memberId: "member-jo", memberCount: 2 } });
  assert.equal(left.memberCount, 2);
  assert.deepEqual(
    left.members.map((member) => member.id),
    [KYLE, SAM]
  );
});

test("track_skipped stops the room's current track without forgetting it", () => {
  const started = applyEvent(twoMemberRoom(), {
    type: "track_started",
    roomId: "room-1",
    data: { item: item("a1", "first", KYLE), startedAt: 5000, timelineMs: 30000 },
  });
  assert.equal(started.current.item.title, "first");
  assert.ok(positionMs(started, 5000) === 0);

  const skipped = applyEvent(started, {
    type: "track_skipped",
    roomId: "room-1",
    data: { item: item("a1", "first", KYLE), reason: "voted", positionMs: 4000 },
  });
  assert.equal(skipped.current.startedAtMs, 0, "the room is no longer playing it");
  assert.equal(skipped.current.item.title, "first");
  assert.equal(skipped.current.positionMs, 4000);
  assert.equal(positionMs(skipped, 1e9), 0, "nothing is running, so nothing advances");

  // A skip for some other track is not ours to act on.
  const other = applyEvent(started, {
    type: "track_skipped",
    roomId: "room-1",
    data: { item: item("zz", "elsewhere", SAM), positionMs: 1 },
  });
  assert.equal(other, started);
});

test("ready_state counts who is ready, out of how many", () => {
  const state = twoMemberRoom();
  const ready = applyEvent(state, {
    type: "ready_state",
    roomId: "room-1",
    data: { ready: 1, members: 2, item: item("a1", "first", KYLE) },
  });
  assert.equal(ready.readyCount, 1);
  assert.equal(ready.memberCount, 2);

  const all = applyEvent(ready, { type: "ready_state", roomId: "room-1", data: { ready: 2, members: 2 } });
  assert.equal(all.readyCount, 2);
});

test("ready_state carries who is sitting the track out", () => {
  const state = twoMemberRoom();
  assert.equal(state.members.length, 2, "the fixture has two members");
  const [first, second] = state.members;

  const out = applyEvent(state, {
    type: "ready_state",
    roomId: "room-1",
    data: { ready: 1, members: 2, out: [second.id] },
  });
  assert.equal(out.members.find((member) => member.id === second.id).out, true);
  assert.equal(out.members.find((member) => member.id === first.id).out, false);

  // Coming back in clears it, and the panel stops saying so.
  const back = applyEvent(out, {
    type: "ready_state",
    roomId: "room-1",
    data: { ready: 2, members: 2, out: [] },
  });
  assert.equal(back.members.every((member) => !member.out), true);
});

test("the room position follows the server clock, freezes when paused and stops at the end", () => {
  const started = applyEvent(twoMemberRoom(), {
    type: "track_started",
    roomId: "room-1",
    data: { item: item("a1", "first", KYLE), startedAt: 10000, timelineMs: 30000 },
  });
  assert.equal(positionMs(started, 12000), 2000);
  assert.equal(positionMs(started, 3000), 0, "before the start is still the start");

  const offset = applyEvent(started, { type: "pong", clientSentAt: 100, serverReceivedAt: 4000 });
  // Within a few milliseconds of the offset for *now*: the code reads the clock
  // itself and this reads it again, so asking for an exact match is asking for
  // the two calls to land in the same millisecond.
  assert.ok(
    Math.abs(offset.serverOffsetMs - offsetFrom(100, Date.now(), 4000)) <= 5,
    `offset ${offset.serverOffsetMs} is not the offset for now`
  );

  const paused = applyEvent(started, { type: "paused", roomId: "room-1", data: { positionMs: 7000 } });
  assert.equal(positionMs(paused, 99000), 7000);

  const resumed = applyEvent(paused, { type: "resumed", roomId: "room-1", data: { startedAt: 20000, positionMs: 7000 } });
  assert.equal(positionMs(resumed, 21000), 8000);
  assert.equal(positionMs(resumed, 99000), 30000, "a track does not outlive its timeline");

  assert.equal(positionMs(createRoomState(), 1), 0);
});

test("events only move the room they belong to, and the reducer never mutates", () => {
  const state = twoMemberRoom();
  const before = structuredClone(state);
  const foreign = applyEvent(state, { type: "queue_updated", roomId: "other", data: { queues: { x: [] } } });
  assert.equal(foreign, state, "another room's event is ignored");

  const next = applyEvent(state, { type: "member_left", roomId: "room-1", data: { memberId: SAM, memberCount: 1 } });
  assert.notEqual(next, state);
  assert.deepEqual(state, before, "the state we applied to is untouched");
  assert.equal(next.members.length, 1);
});

test("the master mix can be reordered by moving one of your items", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(moveItem(["a", "b", "c"], "a"), ["b", "c", "a"], "no target goes to the end");
  assert.deepEqual(moveItem(["a", "b"], "z", "a"), ["a", "b"], "an unknown item changes nothing");
});

test("who may drive a room follows its controls", () => {
  const host = twoMemberRoom();
  assert.equal(mayDrive(host, KYLE), true);
  assert.equal(mayDrive(host, SAM), false);
  const everyone = mergeSnapshot(host, { id: "room-1", controls: "everyone", host: KYLE });
  assert.equal(mayDrive(everyone, SAM), true);
});

test("the room's mode says whether to prepare, play, pause or stop", () => {
  const base = createRoomState({ roomId: "room-1" });
  assert.equal(roomPlayMode(base), "stop", "nothing prepared is nothing to do");
  const prepared = applyEvent(base, {
    type: "track_prepared",
    roomId: "room-1",
    data: { item: item("a1", "first", KYLE) },
  });
  assert.equal(roomPlayMode(prepared), "prepare");
  const started = applyEvent(prepared, {
    type: "track_started",
    roomId: "room-1",
    data: { item: item("a1", "first", KYLE), startedAt: 1000, timelineMs: 30000 },
  });
  assert.equal(roomPlayMode(started), "play");
  const paused = applyEvent(started, { type: "paused", roomId: "room-1", data: { positionMs: 1000 } });
  assert.equal(roomPlayMode(paused), "pause");
  const skipped = applyEvent(started, {
    type: "track_skipped",
    roomId: "room-1",
    data: { item: item("a1", "first", KYLE) },
  });
  assert.equal(roomPlayMode(skipped), "prepare", "a track with no start instant is only held, never played");
});

test("drift is only worth a seek past the tolerance", () => {
  assert.equal(driftDecision(5000, 5000), "hold");
  assert.equal(driftDecision(6400, 5000), "hold", "400ms ahead stays");
  assert.equal(driftDecision(6600, 5000), "back", "1.6s ahead is seeked back");
  assert.equal(driftDecision(3400, 5000), "forward", "1.6s behind is seeked forward");
  assert.equal(driftDecision(5000, 3250), "back");
});

// --- following a room ------------------------------------------------------
//
// The socket and the REST calls, seen from the outside: a fake client stands in
// for the browser, so what is checked is what a room member would notice —
// which command goes out, and whether the membership survives.

const HOST = {
  id: "room-1",
  name: "kitchen",
  host: KYLE,
  controls: "host",
  members: [{ id: KYLE, name: "kyle" }],
  memberCount: 1,
  queues: { [KYLE]: [item("a1", "first", KYLE)] },
  masterQueue: [item("a1", "first", KYLE)],
  queue: [],
  current: null,
  skip: { skipThreshold: 2, minVotersForSkip: 2, voterFractionForSkip: 0.5, readyTimeoutSeconds: 30 },
};

/** The same room seen by a member who is not leading it: sam follows kyle. The
 *  room runs on kyle's copy, so what sam's own clock does is sam's business. */
const FOLLOWER = {
  ...HOST,
  members: [
    { id: KYLE, name: "kyle" },
    { id: SAM, name: "sam" },
  ],
  memberCount: 2,
};

function fakeClient({ room = HOST, joinError = null, sources = null, memberId = KYLE } = {}) {
  const calls = { joins: [], commands: [], leaves: [], ready: [], sockets: [] };
  const client = {
    memberId,
    calls,
    joinError,
    roomData: room,
    joinRoom(roomId, password) {
      calls.joins.push({ roomId, password });
      if (client.joinError) return Promise.reject(client.joinError);
      return Promise.resolve({ room: client.roomData, memberId });
    },
    room() {
      return Promise.resolve(client.roomData);
    },
    sources(trackId) {
      calls.sources = calls.sources || [];
      calls.sources.push(trackId);
      const answer = typeof sources === "function" ? sources(trackId) : sources;
      return Promise.resolve(answer || { sources: [], preferredVariantId: "" });
    },
    roomEnqueue(roomId, trackId) {
      calls.commands.push({ name: "roomEnqueue", args: [roomId, trackId] });
      return Promise.resolve(client.roomData);
    },
    roomRemove(roomId, itemId) {
      calls.commands.push({ name: "roomRemove", args: [roomId, itemId] });
      return Promise.resolve(client.roomData);
    },
    roomReorder(roomId, itemIds) {
      calls.commands.push({ name: "roomReorder", args: [roomId, itemIds] });
      return Promise.resolve(client.roomData);
    },
    roomClearQueue(roomId) {
      calls.commands.push({ name: "roomClearQueue", args: [roomId] });
      return Promise.resolve(client.roomData);
    },
    roomPause(roomId) {
      calls.commands.push({ name: "roomPause", args: [roomId] });
      return Promise.resolve(client.roomData);
    },
    roomResume(roomId) {
      calls.commands.push({ name: "roomResume", args: [roomId] });
      return Promise.resolve(client.roomData);
    },
    roomSkip(roomId) {
      calls.commands.push({ name: "roomSkip", args: [roomId] });
      return Promise.resolve(client.roomData);
    },
    roomEnded(roomId, trackId, positionMs) {
      calls.commands.push({ name: "roomEnded", args: [roomId, trackId, positionMs] });
      return Promise.resolve(client.roomData);
    },
    roomSeek(roomId, positionMs) {
      calls.commands.push({ name: "roomSeek", args: [roomId, positionMs] });
      // The room answers with its new position, which is what a follower then
      // keeps its own file on: without this the fake would hand back the old
      // position and the follow loop would rightly pull the member back.
      if (client.roomData && client.roomData.current) {
        client.roomData = {
          ...client.roomData,
          current: { ...client.roomData.current, startedAtMs: Date.now() - positionMs, positionMs: 0 },
        };
      }
      return Promise.resolve(client.roomData);
    },
    roomVote(roomId, score) {
      calls.commands.push({ name: "roomVote", args: [roomId, score] });
      return Promise.resolve(client.roomData);
    },
    roomOut(roomId, out) {
      calls.commands.push({ name: "roomOut", args: [roomId, out] });
      return Promise.resolve(client.roomData);
    },
    roomReady(roomId, trackId, variantId, durationMs) {
      calls.ready.push({ roomId, trackId, variantId, durationMs });
      return Promise.resolve(client.roomData);
    },
    leaveRoom(roomId) {
      calls.leaves.push({ roomId });
      return Promise.resolve(client.roomData);
    },
    roomSocket({ roomId, onEvent, onOpen, onClose }) {
      const socket = {
        roomId,
        sends: [],
        closed: false,
        onEvent,
        onOpen,
        onClose,
        send(type, payload) {
          this.sends.push({ type, ...payload });
          return true;
        },
        close() {
          this.closed = true;
          onClose?.();
        },
      };
      calls.sockets.push(socket);
      return socket;
    },
  };
  return client;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("a wrong password is the server's error, and leaves you outside the room", async (t) => {
  t.after(closeRoom);
  const client = fakeClient({ joinError: new Error("wrong password") });
  await assert.rejects(enterRoom({ client, roomId: "room-1", password: "nope" }), /wrong password/);
  assert.equal(currentRoom(), null);
  assert.equal(client.calls.sockets.length, 0, "no socket for a room we are not in");
});

test("a room you cannot join does not cost you the room you are in", async (t) => {
  t.after(closeRoom);
  const client = fakeClient();
  let left = 0;
  await enterRoom({ client, roomId: "room-1", onLeave: () => (left += 1) });

  client.joinError = new Error("wrong password");
  await assert.rejects(enterRoom({ client, roomId: "room-2", password: "nope" }), /wrong password/);

  assert.equal(left, 0, "the room we were following is untouched");
  assert.equal(currentRoom().roomId, "room-1");
  assert.equal(client.calls.sockets[0].closed, false);
});

test("the queue commands go to the room through the client's own wrappers", async (t) => {
  t.after(closeRoom);
  const client = fakeClient();
  await enterRoom({ client, roomId: "room-1", password: "sesame" });
  assert.deepEqual(client.calls.joins, [{ roomId: "room-1", password: "sesame" }]);
  assert.equal(client.calls.sockets.length, 1, "joining opens the room channel");

  await enqueue({ id: "track-9" });
  assert.deepEqual(client.calls.commands.at(-1), { name: "roomEnqueue", args: ["room-1", "track-9"] });

  await remove("a1");
  assert.deepEqual(client.calls.commands.at(-1), { name: "roomRemove", args: ["room-1", "a1"] });

  await reorder(["b1", "a1"]);
  assert.deepEqual(client.calls.commands.at(-1), { name: "roomReorder", args: ["room-1", ["b1", "a1"]] });

  await pause();
  assert.deepEqual(client.calls.commands.at(-1), { name: "roomPause", args: ["room-1"] });

  await seek(4200);
  assert.deepEqual(client.calls.commands.at(-1), { name: "roomSeek", args: ["room-1", 4200] });

  await vote(4);
  assert.deepEqual(client.calls.commands.at(-1), { name: "roomVote", args: ["room-1", 4] });

  await clearQueue();
  assert.deepEqual(client.calls.commands.at(-1), { name: "roomClearQueue", args: ["room-1"] });
});

test("a dropped socket is rejoined with the same password", async (t) => {
  t.after(closeRoom);
  const client = fakeClient();
  await enterRoom({ client, roomId: "room-1", password: "sesame" });
  const first = client.calls.sockets[0];
  first.onOpen();
  assert.equal(currentRoom().connected, true);

  first.onClose();
  assert.equal(currentRoom().connected, false, "the page says we are reconnecting");
  assert.ok(await waitFor(() => client.calls.sockets.length === 2), "a second socket is opened");
  assert.deepEqual(client.calls.joins.at(-1), { roomId: "room-1", password: "sesame" });
});

test("events from the room channel reach the state the views read", async (t) => {
  t.after(closeRoom);
  const client = fakeClient();
  await enterRoom({ client, roomId: "room-1" });
  client.calls.sockets[0].onEvent({
    type: "member_joined",
    roomId: "room-1",
    data: { member: { id: "member-jo", name: "jo" }, memberCount: 2 },
  });
  assert.equal(currentRoom().memberCount, 2);
  assert.equal(nameOf(currentRoom(), "member-jo"), "jo");

  client.calls.sockets[0].onEvent({ type: "queue_updated", roomId: "other-room", data: { queues: {} } });
  assert.equal(currentRoom().memberCount, 2, "another room's events change nothing here");
});

test("leaving ends the membership here and on the server", async (t) => {
  t.after(closeRoom);
  const client = fakeClient();
  let left = 0;
  await enterRoom({ client, roomId: "room-1", onLeave: () => (left += 1) });
  const socket = client.calls.sockets[0];

  await leaveRoom({ client, roomId: "room-1" });

  assert.equal(left, 1, "the player is told to stop routing through the room");
  assert.equal(socket.closed, true);
  assert.deepEqual(client.calls.leaves, [{ roomId: "room-1" }]);
  assert.equal(currentRoom(), null);
});

// --- keeping the player on the room's clock --------------------------------
//
// The player a browser would run is stood in for by one a test can hold still:
// it records what it was asked to play, and puts its own position, duration and
// readiness where the engine reads them.

class FakePlayer {
  constructor() {
    this.queue = [];
    this.index = -1;
    this.variant = "";
    this.room = null;
    this.ready = "none";
    this.loading = false;
    this.error = "";
    this.position = 0;
    this.duration = 0;
    // What the browser read from the file. Null means "the same as duration",
    // which is a file that is ready to play; a test can hold it at 0 to model a
    // file whose metadata has not arrived yet.
    this.measured = null;
    this.paused = true;
    this.ended = false;
    this.plays = [];
    this.seeks = [];
    this.resumes = 0;
    this.warmed = [];
    // What `variantFor` answers: the variant the room's follower will play.
    this.resolvedVariant = "v-default";
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event)?.delete(handler);
  }

  current() {
    return this.index >= 0 && this.index < this.queue.length ? this.queue[this.index] : null;
  }

  variantId() {
    return this.variant;
  }

  /** The room asks for its upcoming tracks to be fetched ahead of time. The
   *  callback is how a room is told the file is really here. */
  warm(track, { onReady } = {}) {
    this.warmed.push(track);
    if (onReady) this.warmReady = onReady;
  }

  /** The variant this player would play a track from. The real one resolves it
   *  from the client and the room now asks for that answer rather than making
   *  the same choice again, so a test says what it would have chosen. */
  variantFor() {
    return Promise.resolve({ variantId: this.resolvedVariant });
  }

  readyState() {
    return this.ready;
  }

  positionMs() {
    return this.position;
  }

  durationMs() {
    // The real player falls back to the queue entry's duration when the file's
    // own is not known; here that is `duration`.
    const measured = this.measuredDurationMs();
    return measured > 0 ? measured : this.duration;
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

  /** An ended file reads as paused, as a real element's does. */
  hasEnded() {
    return this.ended;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.resumes += 1;
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
    this.loading = true;
    this.ready = "downloading";
    // The fetch finishes a moment later, as a real one would.
    Promise.resolve().then(() => {
      this.loading = false;
      this.ready = "ready";
      this.duration = 30000;
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

const ONE_VARIANT = () => ({ sources: [{ variantId: "v-default", default: true }], preferredVariantId: "" });

/** The room document the backend returns once a track is prepared. */
function roomPrepared(track) {
  return { ...HOST, current: { item: track, startedAtMs: 0, timelineMs: 0, positionMs: 0, paused: false } };
}

/** The room document the backend returns once a track is running. */
function roomStarted(track, startedAt, timelineMs) {
  return { ...HOST, current: { item: track, startedAtMs: startedAt, timelineMs, positionMs: 0, paused: false } };
}

test("a member reports the length of its own file, never the song's canonical one", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  // The queue entry says 7:11 - the song's canonical length - and the browser
  // has not read this member's file yet.
  player.duration = 431000;
  player.measured = 0;
  const client = fakeClient({ sources: ONE_VARIANT });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });
  assert.ok(await waitFor(() => player.plays.length === 1), "the room's rendition is fetched");

  // Nothing is reported while the file is unmeasured. The room starts on this
  // report and its clock runs from that instant, so a report sent before the
  // file is playable buys a start the member cannot keep up with: they hear the
  // song from wherever the room has got to, sit on the play button while the
  // rest arrives, and jump forward when it lands.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(client.calls.ready.length, 0, "an unmeasured file is not reported ready");

  // The browser reads the file: its own length is what the room is told, never
  // the 7:11 the queue entry borrowed.
  player.measured = 253705;
  assert.ok(await waitFor(() => client.calls.ready.length === 1), "the measured length is reported");
  assert.equal(client.calls.ready[0].durationMs, 253705, "the file's own length");

  // Once per copy: a second tick reports nothing new.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(client.calls.ready.length, 1, "and it is reported once");
});

test("the room plays the variant the player would, so a warm is not wasted", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  // The player's own answer, which is what the room now plays. Warming asks the
  // same question, so a warm and the play that follows fetch one file between
  // them; choosing separately meant the room downloaded the track twice and
  // waited on the second download.
  player.resolvedVariant = "v-other";
  const client = fakeClient({ sources: ONE_VARIANT });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });

  assert.ok(await waitFor(() => player.plays.length === 1), "the room's rendition is fetched");
  assert.equal(player.plays[0].variantId, "v-other", "the variant the player resolved, not a second guess");
});

test("a track this member cannot fetch is sat out, not waited on", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ sources: ONE_VARIANT });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });
  await waitFor(() => player.plays.length === 1);

  // The file cannot be fetched: the media state says so, which is what a failed
  // download looks like here. The room would otherwise wait out its readiness
  // timeout and then play the track to nobody.
  player.ready = "failed";
  assert.ok(
    await waitFor(() => client.calls.commands.some((call) => call.name === "roomOut" && call.args[1] === true), 9000),
    "the member sits the track out rather than waiting on it"
  );
});

test("the prepared track is played, reported ready once, then follows the room's clock", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ sources: ONE_VARIANT, room: FOLLOWER, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  // The room prepares it; the snapshot the debounced refetch returns agrees.
  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });

  assert.ok(await waitFor(() => player.plays.length === 1), "the room's rendition is fetched");
  assert.deepEqual(player.plays[0], {
    track: { id: "track-a1", title: "first" },
    variantId: "v-default",
    positionMs: 0,
    autoplay: false,
  });

  assert.ok(await waitFor(() => client.calls.ready.length === 1), "readiness is reported");
  assert.deepEqual(client.calls.ready[0], {
    roomId: "room-1",
    trackId: "track-a1",
    variantId: "v-default",
    durationMs: 30000,
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(client.calls.ready.length, 1, "reported once per prepared track");

  // The room starts it: the held file is resumed, not fetched again.
  const startedAt = Date.now() - 500;
  client.roomData = roomStarted(track, startedAt, 30000);
  socket.onEvent({
    type: "track_started",
    roomId: "room-1",
    atMs: Date.now(),
    data: { item: track, startedAt, timelineMs: 30000 },
  });
  assert.ok(await waitFor(() => !player.isPaused()), "the room's play resumes the file");
  assert.equal(player.plays.length, 1, "the prepared file is reused");

  // A local clock that has run ahead is pulled back with one small seek.
  player.position = 8000;
  assert.ok(await waitFor(() => player.seeks.length === 1), "drift past the tolerance is corrected");
  assert.ok(player.seeks[0] < 3000, `the seek lands on the room's position (${player.seeks[0]})`);
});

test("a file shorter than the timeline waits, silent, instead of starting over", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ sources: ONE_VARIANT, room: FOLLOWER, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });
  await waitFor(() => player.plays.length === 1);

  const startedAt = Date.now();
  client.roomData = roomStarted(track, startedAt, 60000);
  socket.onEvent({
    type: "track_started",
    roomId: "room-1",
    atMs: Date.now(),
    data: { item: track, startedAt, timelineMs: 60000 },
  });
  await waitFor(() => !player.isPaused());

  // The short file reaches its own end while the room still has a minute left.
  player.duration = 4000;
  player.position = 4000;
  player.pause();
  await new Promise((resolve) => setTimeout(resolve, 700));

  assert.ok(player.isPaused(), "the member stays silent to the room's end");
  assert.equal(player.plays.length, 1, "the file is not started over");
  assert.equal(player.seeks.length, 0, "and the timeline does not push it back");
});

test("a member who is not playing still fetches the room's next song", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  // This member cannot even work out what it would play, so it never becomes
  // the one playing the room's song - and the room would otherwise wait for it
  // at the advance. What the room plays next does not depend on that.
  player.variantFor = () => new Promise(() => {});
  const client = fakeClient({ sources: ONE_VARIANT, room: FOLLOWER, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const current = item("a1", "first", KYLE);
  const next = item("a2", "second", KYLE);

  client.roomData = {
    ...FOLLOWER,
    current: { item: current, startedAtMs: Date.now() - 1000, timelineMs: 30000, positionMs: 0, paused: false },
    next,
  };
  socket.onEvent({
    type: "track_started",
    roomId: "room-1",
    atMs: Date.now(),
    data: { item: current, startedAt: Date.now() - 1000, timelineMs: 30000 },
  });
  socket.onEvent({
    type: "queue_updated",
    roomId: "room-1",
    atMs: Date.now(),
    data: { masterQueue: [current, next], queue: [next], next },
  });

  assert.ok(
    await waitFor(() => player.warmed.some((track) => track.id === "track-a2")),
    "the next song is fetched even though this member is not playing the current one"
  );
  // And the room is told this member is ready for it, which is what lets the
  // song start the instant this one ends instead of waiting for them.
  assert.equal(typeof player.warmReady, "function", "the fetch came with a report to make");
  player.warmReady("v-default");
  assert.ok(
    await waitFor(() => client.calls.ready.some((report) => report.trackId === "track-a2")),
    "readiness is reported for a song the room has not started"
  );
});

test("the host follows a jump it did not make, and ignores its own drift", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ sources: ONE_VARIANT });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });
  await waitFor(() => player.plays.length === 1);

  // The room is already twenty seconds in: the host arrived late, or somebody
  // seeked. Either way it is the room's position like any other, and a jump
  // this size is not drift.
  const startedAt = Date.now() - 20000;
  client.roomData = roomStarted(track, startedAt, 30000);
  socket.onEvent({
    type: "track_started",
    roomId: "room-1",
    atMs: Date.now(),
    data: { item: track, startedAt, timelineMs: 30000 },
  });
  assert.ok(await waitFor(() => player.seeks.length >= 1), "the host follows the room's position");
  assert.ok(player.seeks.at(-1) > 15000, `seeked to ${player.seeks.at(-1)}, want where the room is`);

  // Their own small drift is not: the song runs as long as their copy, so there
  // is nothing there to correct.
  const seeks = player.seeks.length;
  player.position = 21000;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(player.seeks.length, seeks, "the host's own drift is not corrected");

  // And their file is not stopped a moment short of its own end: that gap is
  // the room's timeline arriving late, and it is the host's silence to hear.
  player.duration = 30000;
  player.position = 29760;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(player.isPaused(), false, "the host plays to the end of their own file");
});

test("a file that has run out is not started over while the room moves on", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ sources: ONE_VARIANT });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });
  await waitFor(() => player.plays.length === 1);

  const startedAt = Date.now() - 500;
  client.roomData = roomStarted(track, startedAt, 30000);
  socket.onEvent({
    type: "track_started",
    roomId: "room-1",
    atMs: Date.now(),
    data: { item: track, startedAt, timelineMs: 30000 },
  });
  await waitFor(() => !player.isPaused());

  // The file runs out. The element stops itself, which reads as paused - but it
  // is not waiting to be resumed, and play() on it starts the song again from
  // the beginning. That is what a listener hears as the song replaying just
  // before it jumps.
  player.ended = true;
  player.paused = true;
  const resumes = player.resumes;
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(player.resumes, resumes, "the ended file is left where it stopped");
});

test("a seek moves this member's own file, not only the room's idea of where they are", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ sources: ONE_VARIANT });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });
  await waitFor(() => player.plays.length === 1);

  const startedAt = Date.now() - 500;
  client.roomData = roomStarted(track, startedAt, 30000);
  socket.onEvent({
    type: "track_started",
    roomId: "room-1",
    atMs: Date.now(),
    data: { item: track, startedAt, timelineMs: 30000 },
  });
  await waitFor(() => !player.isPaused());

  await seek(20000);
  assert.deepEqual(
    client.calls.commands.find((command) => command.name === "roomSeek").args,
    ["room-1", 20000],
    "the room is asked to move"
  );
  // The answer is a room position, not a moved file: without this the bar says
  // the seek happened and the audio carries on where it was.
  assert.deepEqual(player.seeks, [20000], "the member's own file moves with the room");
});

test("the host's file reaching its end tells the room to move on", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ sources: ONE_VARIANT });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });
  await waitFor(() => player.plays.length === 1);

  const startedAt = Date.now() - 500;
  client.roomData = roomStarted(track, startedAt, 30000);
  socket.onEvent({
    type: "track_started",
    roomId: "room-1",
    atMs: Date.now(),
    data: { item: track, startedAt, timelineMs: 30000 },
  });
  await waitFor(() => !player.isPaused());

  // The room runs on the host's copy, so their file reaching its end is the
  // song reaching its end: the room is told, rather than left to a length it
  // worked out before the song started.
  assert.equal(typeof player.room?.ended, "function", "the player was given the room's end hook");
  player.room.ended("track-a1", 30000);
  assert.ok(
    await waitFor(() => client.calls.commands.some((command) => command.name === "roomEnded")),
    "the room is told the song is over"
  );
  // The track and where the file had got to travel with it: an end that lands
  // after the room has moved on, or one from a file that stopped short, must
  // not cut the song that is playing by then.
  assert.deepEqual(
    client.calls.commands.find((command) => command.name === "roomEnded").args,
    ["room-1", "track-a1", 30000]
  );
});

test("a member who is not the host does not tell the room the song is over", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ sources: ONE_VARIANT, room: FOLLOWER, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });
  await waitFor(() => player.plays.length === 1);

  const startedAt = Date.now() - 500;
  client.roomData = roomStarted(track, startedAt, 30000);
  socket.onEvent({
    type: "track_started",
    roomId: "room-1",
    atMs: Date.now(),
    data: { item: track, startedAt, timelineMs: 30000 },
  });
  await waitFor(() => !player.isPaused());

  player.room?.ended?.();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    client.calls.commands.some((command) => command.name === "roomEnded"),
    false,
    "somebody the room is not waiting for does not move it on"
  );
});

test("past the room's timeline the file is held, and leaving gives the player back", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ sources: ONE_VARIANT, room: FOLLOWER, memberId: SAM });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const track = item("a1", "first", KYLE);

  client.roomData = roomPrepared(track);
  socket.onEvent({ type: "track_prepared", roomId: "room-1", atMs: Date.now(), data: { item: track } });
  await waitFor(() => player.plays.length === 1);
  assert.ok(await waitFor(() => player.inRoom()), "the player routes through the room");

  const startedAt = Date.now();
  client.roomData = roomStarted(track, startedAt, 150);
  socket.onEvent({
    type: "track_started",
    roomId: "room-1",
    atMs: Date.now(),
    data: { item: track, startedAt, timelineMs: 150 },
  });
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.ok(player.isPaused(), "the room's timeline end stops the file");
  assert.equal(player.plays.length, 1, "and never loops");

  await leaveRoom({ client, roomId: "room-1" });
  assert.ok(await waitFor(() => !player.inRoom()), "the player is its own again");
});

test("the room's track reaches the player with its artist and artwork", async (t) => {
  t.after(closeRoom);
  // A room's queue item carries a title and nothing else, so the follower has
  // to look the track up. Without that the bar a listener sees has no artist
  // and no cover, only a title.
  const client = fakeClient({
    room: {
      ...HOST,
      current: { item: item("a1", "first", KYLE), startedAtMs: Date.now() - 1000, paused: false },
    },
  });
  client.sources = async () => ({
    sources: [{ variantId: "v1", downloadable: true }],
    preferredVariantId: "v1",
  });
  client.track = async (id) => ({
    id,
    title: "Feel Right",
    artists: ["meija"],
    artworkUrl: "/api/v1/artwork/abc.png",
  });

  const player = new FakePlayer();
  followWithPlayer(player);
  await enterRoom({ client, roomId: "room-1" });

  assert.ok(await waitFor(() => player.plays.length), "the follower starts the room's track");
  assert.deepEqual(player.plays[0].track.artists, ["meija"]);
  assert.equal(player.plays[0].track.artworkUrl, "/api/v1/artwork/abc.png");
});

test("the room you are in is remembered, and forgotten when you leave", async (t) => {
  t.after(closeRoom);
  const client = fakeClient();
  await enterRoom({ client, roomId: "room-1", password: "sesame" });
  // A reload reads this back and rejoins: without it "pick up where you left
  // off" leaves you outside the room you were listening in.
  assert.deepEqual(state.room, { roomId: "room-1", name: "kitchen", password: "sesame" });

  await leaveRoom({ client, roomId: "room-1" });
  assert.equal(state.room, null, "a room you have left is not one to rejoin");
});

test("the room's next tracks are fetched ahead, so a skip does not wait on one", async (t) => {
  t.after(closeRoom);
  const next = item("a2", "second", KYLE);
  const client = fakeClient({
    room: {
      ...HOST,
      queues: { [KYLE]: [item("a1", "first", KYLE), next] },
      masterQueue: [item("a1", "first", KYLE), next],
      current: { item: item("a1", "first", KYLE), startedAtMs: Date.now() - 1000, paused: false },
    },
  });
  client.sources = async () => ({ sources: [{ variantId: "v1", downloadable: true }], preferredVariantId: "v1" });
  client.track = async (id) => ({ id, title: "x" });

  const player = new FakePlayer();
  followWithPlayer(player);
  await enterRoom({ client, roomId: "room-1" });

  // The player's own queue is empty in a room, so nothing else would fetch this.
  assert.ok(
    await waitFor(() => player.warmed.some((track) => track.id === "track-a2")),
    "the item after the current one is warmed"
  );
});


test("the song prepared behind this one is fetched and reported before it is needed", async (t) => {
  t.after(closeRoom);
  const player = new FakePlayer();
  const client = fakeClient({ sources: ONE_VARIANT });
  t.after(followWithPlayer(player));
  await enterRoom({ client, roomId: "room-1" });
  const socket = client.calls.sockets[0];
  const first = item("a1", "first", KYLE);
  const second = item("a2", "second", KYLE);

  // Playing the first, with the second prepared behind it.
  client.roomData = roomStarted(first, Date.now(), 180_000);
  socket.onEvent({
    type: "track_started",
    roomId: "room-1",
    atMs: Date.now(),
    data: { item: first, startedAt: Date.now(), timelineMs: 180_000 },
  });
  await waitFor(() => player.plays.length === 1);

  socket.onEvent({ type: "queue_updated", roomId: "room-1", atMs: Date.now(), data: { next: second } });

  assert.ok(
    await waitFor(() => player.warmed.some((track) => track.id === "track-a2")),
    "the prepared song is fetched while this one plays"
  );
  assert.equal(typeof player.warmReady, "function", "and the room is told when it arrives");

  // The file is here: say so now, rather than waiting for the room to move on.
  player.warmReady("v-default");
  assert.ok(
    await waitFor(() => client.calls.ready.some((report) => report.trackId === "track-a2")),
    "readiness is reported for a song the room has not started"
  );
  assert.equal(
    client.calls.ready.find((report) => report.trackId === "track-a2").durationMs,
    0,
    "with no length: the measured one follows once the song is really playing"
  );
});

// A member's hand on the transport is announced by name; the room's own
// decisions are silent, since there is nobody to name.
test("a member's transport action is announced, the room's own is silent", () => {
  const by = { id: KYLE, name: "Kyle" };
  assert.equal(transportNotice({ type: "paused", data: { by } }), "Kyle paused");
  assert.equal(transportNotice({ type: "resumed", data: { by } }), "Kyle resumed");
  assert.equal(transportNotice({ type: "seeked", data: { by } }), "Kyle seeked");
  assert.equal(transportNotice({ type: "track_skipped", data: { by } }), "Kyle skipped");
  // The room skipped it on votes, or the track simply ran out: no name to say.
  assert.equal(transportNotice({ type: "track_skipped", data: { reason: "votes" } }), "");
  assert.equal(transportNotice({ type: "track_skipped", data: { reason: "completed" } }), "");
  // Events that are not the transport at all say nothing.
  assert.equal(transportNotice({ type: "queue_updated", data: { by } }), "");
  assert.equal(transportNotice(null), "");
});
