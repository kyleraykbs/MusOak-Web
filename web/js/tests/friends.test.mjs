// The friends views' pure logic, without a screen: how a relationship reads,
// how a list of people sorts, what a friend's saved queue entry turns into,
// and what the listen-along follower does when it drifts.
//
// The helpers live in views/share.js, which the friends views and the share
// dialog both import. It is importable here because the shell (../app.js) only
// boots in a browser.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DRIFT_TOLERANCE_MS, displayName, driftDecision, filterFriends, isOnline,
  listeningLine, queueTrack, relationshipLabel, roomIdOf, sortFriends,
} from "../views/share.js";

test("a room is named by whichever shape its id arrived in", () => {
  // The room state, as rooms-state.js normalizes it.
  assert.equal(roomIdOf({ roomId: "abc", name: "Room" }), "abc");
  // An API room, as /api/v1/rooms returns it.
  assert.equal(roomIdOf({ id: "xyz", name: "Room" }), "xyz");
  // A room state that carries both prefers its own field.
  assert.equal(roomIdOf({ roomId: "abc", id: "xyz" }), "abc");
  // Nothing to work with is an empty string, never undefined.
  assert.equal(roomIdOf(null), "");
  assert.equal(roomIdOf({ name: "Room" }), "");
});

test("a search keeps the friends whose name or username it matches", () => {
  const friends = [
    { username: "bob", displayName: "Robert" },
    { username: "kyle", displayName: "" },
    { username: "ana", displayName: "Ana Maria" },
  ];
  assert.deepEqual(filterFriends(friends, "rob").map((f) => f.username), ["bob"]);
  assert.deepEqual(filterFriends(friends, "KYLE").map((f) => f.username), ["kyle"]);
  assert.deepEqual(filterFriends(friends, "mar").map((f) => f.username), ["ana"]);
  // Nothing typed is the whole list; nobody by that name is nobody.
  assert.equal(filterFriends(friends, "").length, 3);
  assert.equal(filterFriends(friends, "   ").length, 3);
  assert.equal(filterFriends(friends, "zed").length, 0);
  assert.equal(filterFriends(undefined, "x").length, 0);
});

test("a relationship reads as the row around it says it", () => {
  assert.equal(relationshipLabel("friend"), "Already friends");
  assert.equal(relationshipLabel("pending-out"), "Request sent");
  assert.equal(relationshipLabel("pending-in"), "Wants to be your friend");
  assert.equal(relationshipLabel("ignored"), "Ignored");
  // "none" has no label: it has a button, so the row renders "Add friend".
  assert.equal(relationshipLabel("none"), "");
  assert.equal(relationshipLabel(""), "");
  assert.equal(relationshipLabel("something-else"), "");
});

test("a person is named by their display name, then their username", () => {
  assert.equal(displayName({ username: "bob", displayName: "Robert" }), "Robert");
  assert.equal(displayName({ username: "bob" }), "bob");
  assert.equal(displayName({ displayName: "  " , username: "bob" }), "bob");
  assert.equal(displayName({}), "Someone");
  assert.equal(displayName(null), "Someone");
});

test("online is the API's flag, not something guessed from the name", () => {
  assert.equal(isOnline({ online: true }), true);
  assert.equal(isOnline({ online: false }), false);
  assert.equal(isOnline({}), false);
  assert.equal(isOnline(null), false);
});

test("friends sort online first, then by name", () => {
  const sorted = sortFriends([
    { username: "zoe", displayName: "Zoe", online: false },
    { username: "bob", displayName: "bob", online: true },
    { username: "ada", displayName: "Ada", online: true },
    { username: "nils", displayName: "Nils", online: false },
  ]);
  assert.deepEqual(
    sorted.map((user) => user.username),
    ["ada", "bob", "nils", "zoe"]
  );
});

test("sorting does not depend on the order the server sent, or mutate it", () => {
  const sent = [
    { username: "c", displayName: "c", online: false },
    { username: "a", displayName: "A", online: true },
    { username: "b", displayName: "B", online: false },
  ];
  const sorted = sortFriends(sent);
  assert.deepEqual(
    sorted.map((user) => user.username),
    ["a", "b", "c"]
  );
  assert.deepEqual(
    sent.map((user) => user.username),
    ["c", "a", "b"],
    "the caller's array keeps its order"
  );
  assert.deepEqual(sortFriends([]), []);
});

test("a friend's saved queue entry becomes a playable track", () => {
  const fromQueue = queueTrack({
    trackId: "abc",
    title: "Song",
    artist: "Band",
    album: "Record",
    durationMs: 1200,
    artworkUrl: "/api/v1/artwork/x",
  });
  assert.deepEqual(fromQueue, {
    id: "abc",
    title: "Song",
    artists: ["Band"],
    album: "Record",
    durationMs: 1200,
    artworkUrl: "/api/v1/artwork/x",
  });
  // The same helper reads a plain API track, artists list and all.
  const fromTrack = queueTrack({ id: "xyz", title: "Other", artists: ["A", "B"] });
  assert.equal(fromTrack.id, "xyz");
  assert.deepEqual(fromTrack.artists, ["A", "B"]);
  assert.equal(queueTrack({ title: "no id" }), null);
  assert.equal(queueTrack(null), null);
});

test("what a friend is playing reads off their playback document", () => {
  assert.equal(
    listeningLine({
      listening: { currentTrackId: "t1", queue: [{ trackId: "t1", title: "Song", artist: "Band" }] },
    }),
    "\u266a Song \u2014 Band"
  );
  // The queue does not name the song any more, but they are still playing.
  assert.equal(listeningLine({ listening: { currentTrackId: "t1", queue: [] } }), "\u266a Listening now");
  assert.equal(listeningLine({ listening: null }), "");
  assert.equal(listeningLine({}), "");
});

test("the follower seeks only once it has drifted past the margin", () => {
  const close = driftDecision({ localMs: 10_000, remoteMs: 11_000 });
  assert.deepEqual(close, { action: "none", positionMs: 11_000 });
  const far = driftDecision({ localMs: 10_000, remoteMs: 14_000 });
  assert.deepEqual(far, { action: "seek", positionMs: 14_000 });
  // Behind is drift too: they seeked backwards inside the same song.
  assert.equal(driftDecision({ localMs: 60_000, remoteMs: 1_000 }).action, "seek");
  // The margin is a margin, not an exact match.
  assert.equal(driftDecision({ localMs: 0, remoteMs: DRIFT_TOLERANCE_MS }).action, "none");
  assert.equal(driftDecision({ localMs: 0, remoteMs: DRIFT_TOLERANCE_MS + 1 }).action, "seek");
});

test("a paused friend stops the follower and a resumed one starts it again", () => {
  assert.deepEqual(driftDecision({ localMs: 5_000, remoteMs: 5_000, remotePaused: true }), {
    action: "pause",
    positionMs: 5_000,
  });
  assert.deepEqual(driftDecision({ localMs: 5_000, remoteMs: 5_000, localPaused: true }), {
    action: "resume",
    positionMs: 5_000,
  });
  // Both stopped: nothing to do, however far apart the two positions are.
  assert.equal(
    driftDecision({ localMs: 1_000, remoteMs: 9_000, localPaused: true, remotePaused: true }).action,
    "none"
  );
});
