// The room playback core: the arithmetic that decides what a member's player
// does about the room's heartbeat. Pure on purpose - a decision that can only
// be tested with a socket and a player is a decision nobody tests.

import test from "node:test";
import assert from "node:assert/strict";

import {
  TOLERANCE_MS,
  COOLDOWN_MS,
  roomPosition,
  roomLength,
  finishesAt,
  driftAction,
  nextItem,
  decide,
} from "../rooms/playback.js";

function item(id, title = id) {
  return { id, trackId: `track-${id}`, title };
}

/** A running room anchored the way the server anchors one. */
function running({ id = "a", positionMs = 0, atMs = 1000, durationMs = 200000, paused = false, started = true } = {}) {
  return { item: item(id), positionMs, atMs, durationMs, paused, started };
}

const NOW = 1000;

test("the room's position ages from its anchor and stops when paused", () => {
  assert.equal(roomPosition(running({ positionMs: 5000, atMs: 1000 }), 3000), 7000);
  assert.equal(roomPosition(running({ positionMs: 5000, atMs: 1000, paused: true }), 3000), 5000);
  assert.equal(roomPosition(running({ started: false, positionMs: 1200 }), 9000), 0);
  assert.equal(roomPosition(null, 9000), 0);
});

test("a song's end is a server time, and only for a song that is running", () => {
  const current = running({ positionMs: 1000, atMs: 1000, durationMs: 60000 });
  assert.equal(finishesAt(current), 1000 + (60000 - 1000));
  assert.equal(finishesAt(running({ durationMs: 0 })), null, "no length, nothing to finish");
  assert.equal(finishesAt(running({ paused: true })), null, "a paused song is not on its way anywhere");
  assert.equal(roomLength(current), 60000);
});

test("inside the tolerance is left alone; outside it is a correction", () => {
  const room = 10000;
  assert.equal(driftAction(room + TOLERANCE_MS, room), "hold", "exactly at the tolerance is inside it");
  assert.equal(driftAction(room - TOLERANCE_MS, room), "hold");
  assert.equal(driftAction(room + TOLERANCE_MS + 1, room), "back", "ahead of the room");
  assert.equal(driftAction(room - TOLERANCE_MS - 1, room), "forward", "behind the room");
});

test("one correction at a time: a fresh seek is left to land", () => {
  const room = 0;
  const far = 50000;
  assert.equal(driftAction(far, room, { sinceCorrectMs: COOLDOWN_MS - 1 }), "hold", "the last seek is still landing");
  assert.equal(driftAction(far, room, { sinceCorrectMs: COOLDOWN_MS }), "back");
  assert.equal(driftAction(far, room), "back", "with nothing to wait for, a real gap is corrected");
});

test("the next song is the room's order without the song that is on", () => {
  const state = { masterQueue: [item("a"), item("b"), item("c")] };
  assert.equal(nextItem(state, "a").id, "b");
  assert.equal(nextItem(state, "b").id, "a");
  assert.equal(nextItem({ masterQueue: [item("a")] }, "a"), null);
  assert.equal(nextItem({}, "a"), null);
});

// --- the decision ----------------------------------------------------------

const base = {
  state: { masterQueue: [item("a"), item("b")] },
  autoplay: true,
  loading: false,
  current: running({ id: "a" }),
  itemId: "a",
  loaded: true,
  playing: true,
  localPositionMs: 5000,
  measuredMs: 200000,
  ended: false,
  serverNowMs: NOW,
  nowMs: NOW,
  loadedAtMs: NOW - 10000,
  sinceStartMs: 10000,
  sinceCorrectMs: 60000,
  advancedPast: new Set(),
};

test("a room with nothing on lets the member go", () => {
  assert.equal(decide({ ...base, current: null }).action, "idle");
});

test("the room's song is loaded at the room's position when it is not the one playing", () => {
  const current = running({ id: "b", positionMs: 3000, atMs: NOW });
  const answer = decide({ ...base, current, itemId: "a" });
  assert.equal(answer.action, "load");
  assert.equal(answer.itemId, "b");
  assert.equal(answer.positionMs, 3000);
  assert.equal(answer.autoplay, true);
});

test("a song the member has already finished is not taken back up", () => {
  const answer = decide({ ...base, advancedPast: new Set(["a"]) });
  assert.equal(answer.action, "hold", "the beat lags; the member is already past this song");
});

test("a song assigned but not started is held, not played", () => {
  const answer = decide({ ...base, current: running({ id: "a", started: false }) });
  assert.equal(answer.action, "wait");
  const arriving = decide({ ...base, autoplay: false, itemId: "", current: running({ id: "b", started: false }) });
  assert.equal(arriving.action, "load");
  assert.equal(arriving.autoplay, false, "the room has not started it, so the member holds it");
});

test("a file that is still loading is left to load", () => {
  const answer = decide({ ...base, loading: true });
  assert.equal(answer.action, "hold");
  assert.equal(answer.status, "Loading the track…");
});

test("the room's pause is the member's pause, and its play the member's play", () => {
  assert.equal(decide({ ...base, current: running({ id: "a", paused: true }) }).action, "pause");
  assert.equal(decide({ ...base, playing: false }).action, "resume");
});

test("the transition is the client's: the room's clock running out moves the member on now", () => {
  const current = running({ id: "a", positionMs: 0, atMs: NOW - 200000, durationMs: 200000 });
  const answer = decide({ ...base, current, localPositionMs: 199000, measuredMs: 200000 });
  assert.equal(answer.action, "advance");
  assert.equal(answer.itemId, "b", "the next song of the room's order");
  assert.equal(answer.fromItemId, "a");
});

test("a file that runs out before the room's clock does moves the member on too", () => {
  // A trimmed copy is shorter than the length the room was told, so this device
  // reaches the end of the file while the room's clock still has seconds on it.
  const answer = decide({ ...base, localPositionMs: 199000, measuredMs: 199000, ended: false, loadedAtMs: NOW - 199500 });
  assert.equal(answer.action, "advance");
});

test("a transition with nothing after it holds instead of guessing", () => {
  const current = running({ id: "a", durationMs: 1000 });
  const answer = decide({ ...base, state: { masterQueue: [item("a")] }, current, localPositionMs: 1000, measuredMs: 1000 });
  assert.equal(answer.action, "pause");
});

test("drift inside the tolerance holds; beyond it, one seek", () => {
  const current = running({ id: "a", positionMs: 0, atMs: NOW });
  const onRoom = decide({ ...base, current, localPositionMs: 0 });
  assert.equal(onRoom.action, "hold");
  const slightlyBehind = decide({ ...base, current, localPositionMs: TOLERANCE_MS - 1 });
  assert.equal(slightlyBehind.action, "hold", "a hand's width of drift is not worth a seek");
  const badlyBehind = decide({ ...base, current, localPositionMs: -TOLERANCE_MS * 4 });
  assert.equal(badlyBehind.action, "seek");
  assert.equal(badlyBehind.positionMs, 0);
  assert.equal(badlyBehind.direction, "forward");
});