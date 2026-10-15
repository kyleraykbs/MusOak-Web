// The room playback core: the arithmetic that decides what a member's player
// does about the room's heartbeat. Pure on purpose - a decision that can only
// be tested with a socket and a player is a decision nobody tests.

import test from "node:test";
import assert from "node:assert/strict";

import {
  TOLERANCE_MS,
  COOLDOWN_MS,
  GRACE_MS,
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

test("a run still settling is not corrected, however far off it reads", () => {
  const room = 0;
  const far = 50000;
  assert.equal(driftAction(far, room, { sinceStartMs: GRACE_MS - 1 }), "hold", "the load is not drift");
  assert.equal(driftAction(-far, room, { sinceStartMs: GRACE_MS - 1 }), "hold");
  assert.equal(driftAction(far, room, { sinceStartMs: GRACE_MS }), "back", "once settled, a real gap is corrected");
  assert.equal(driftAction(far, room), "back", "a run of unknown age is not held back");
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

test("a file that runs out well before the room's clock waits instead of moving on", () => {
  // A trimmed copy is shorter than the length the room was told: this device
  // reaches the end of its file while the room still has a minute of song. Moving
  // on here is the transition heard early, and the room's own switch then drags
  // the member back - the reset. The room's clock decides; the member waits it
  // out, quietly.
  const answer = decide({ ...base, localPositionMs: 140000, measuredMs: 140000, ended: false, loadedAtMs: NOW - 140500 });
  assert.equal(answer.action, "pause", "the room is still on this song");
  assert.equal(answer.waiting, true, "and this member is only waiting for it to finish");

  // Ending on the room's own end is the case the transition is for.
  const roomEnds = decide({
    ...base,
    current: running({ id: "a", positionMs: 0, atMs: NOW - 199500, durationMs: 200000 }),
    localPositionMs: 199500,
    measuredMs: 199500,
    ended: false,
    loadedAtMs: NOW - 200000,
  });
  assert.equal(roomEnds.action, "advance", "the room's own end is the transition");
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

// The seek that follows a load is the one the grace exists to stop: a file that
// was handed to the player a moment ago reads wherever it is starting from, not
// where the room is, and correcting that is the "Syncing to the room" heard
// just after a song begins.
test("a run that has just loaded is held rather than seeked", () => {
  const current = running({ id: "a", positionMs: 0, atMs: NOW });
  const far = -TOLERANCE_MS * 4;

  const settling = decide({ ...base, current, localPositionMs: far, sinceStartMs: GRACE_MS - 1 });
  assert.equal(settling.action, "hold", "the first moments of a run are not drift");

  const settled = decide({ ...base, current, localPositionMs: far, sinceStartMs: GRACE_MS + 1 });
  assert.equal(settled.action, "seek", "once it has settled, the same gap is corrected");
});

test("the grace is measured from the load when the tick does not say", () => {
  const current = running({ id: "a", positionMs: 0, atMs: NOW });
  const far = -TOLERANCE_MS * 4;
  // The tick carries the moment it handed the file over and no age beside it.
  const fresh = decide({ ...base, current, localPositionMs: far, sinceStartMs: undefined, loadedAtMs: NOW - 500 });
  assert.equal(fresh.action, "hold", "half a second into a run is still the run settling");
  const old = decide({ ...base, current, localPositionMs: far, sinceStartMs: undefined, loadedAtMs: NOW - 10000 });
  assert.equal(old.action, "seek", "ten seconds in is a real gap");
});
// A member who has moved on to the next song still belongs to the room: the
// beat can be naming the song they finished, and a pause or a play in that
// window is the room's, not the stale item's. Swallowing those with the
// "already moved past" rule is a pause button that does nothing for a second
// after every song change.
test("the room's pause reaches a member who has moved past the beat's song", () => {
  const past = new Set(["a"]);
  const current = running({ id: "a", paused: true, started: true });

  const paused = decide({ ...base, current, advancedPast: past });
  assert.equal(paused.action, "pause", "a paused room pauses them despite the stale item");

  const playingAgain = decide({ ...base, current: running({ id: "a", paused: false }), advancedPast: past, playing: false });
  assert.equal(playingAgain.action, "resume", "and its play starts them again");

  const quietAndPlaying = decide({ ...base, current, advancedPast: past, playing: false });
  assert.equal(quietAndPlaying.action, "hold", "nothing to do when the room is paused and so are they");
});
