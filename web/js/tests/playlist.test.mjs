// The pure logic the playlist, favourites and queue views are built on: the
// index math of a reorder, how a list of tracks reads as one line, and what the
// queue view projects out of the player's queue or a room's.
//
// None of it touches the DOM: the views import the shell statically (it boots
// only in a browser) and take the player in behind a browser check, so these
// helpers import cleanly here.

import test from "node:test";
import assert from "node:assert/strict";

import { trackCountLine, totalDurationMs, radioEmptyReason } from "../views/playlist.js";
import { artistLine, moveItem, queueProjection, shuffleItems } from "../views/queue.js";
import { createRoomState } from "../rooms-state.js";

const track = (durationMs, index = 0) => ({
  id: `t${index}`,
  title: `Song ${index}`,
  artists: ["Someone"],
  durationMs,
});

test("moveItem moves one item and leaves the list it was given alone", () => {
  const list = ["a", "b", "c", "d"];
  assert.deepEqual(moveItem(list, 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(moveItem(list, 3, 0), ["d", "a", "b", "c"]);
  assert.deepEqual(moveItem(list, 1, 1), list);
  assert.deepEqual(list, ["a", "b", "c", "d"]);
});

test("moveItem's neighbours are one step up and one step down", () => {
  const list = ["a", "b", "c"];
  assert.deepEqual(moveItem(list, 1, 0), ["b", "a", "c"]); // up
  assert.deepEqual(moveItem(list, 1, 2), ["a", "c", "b"]); // down
});

test("moveItem clamps a destination past either end", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 0, 9), ["b", "c", "a"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, -4), ["c", "a", "b"]);
});

test("moveItem copes with a list too short to move anything in", () => {
  assert.deepEqual(moveItem([], 0, 1), []);
  assert.deepEqual(moveItem(["only"], 0, 3), ["only"]);
  assert.deepEqual(moveItem(undefined, 0, 1), []);
});

test("shuffleItems is a permutation and never mutates its input", () => {
  const list = ["a", "b", "c", "d", "e"];
  const shuffled = shuffleItems(list, () => 0);
  assert.deepEqual([...shuffled].sort(), [...list].sort());
  assert.deepEqual(list, ["a", "b", "c", "d", "e"]);
});

test("shuffleItems is deterministic for a given random source", () => {
  assert.deepEqual(shuffleItems([1, 2, 3, 4], () => 0), [2, 3, 4, 1]);
  assert.deepEqual(shuffleItems([1, 2, 3, 4], () => 0.999999), [1, 2, 3, 4]);
});

test("a track list adds up its durations and reads as one line", () => {
  assert.equal(totalDurationMs([track(60_000, 0), track(90_500, 1), track(0, 2)]), 150_500);
  assert.equal(trackCountLine([track(60_000, 0), track(90_500, 1), track(0, 2)]), "3 tracks · 2:31");
  assert.equal(trackCountLine([track(1_000)]), "1 track · 0:01");
  assert.equal(trackCountLine([]), "0 tracks · 0:00");
});

test("a duration the server did not know counts as nothing, not as NaN", () => {
  const list = [{ durationMs: 30_000 }, { durationMs: null }, {}, { durationMs: -5 }, { durationMs: "120000" }];
  assert.equal(totalDurationMs(list), 150_000);
  assert.equal(totalDurationMs(undefined), 0);
});

test("a track's artist line joins whoever is credited", () => {
  assert.equal(artistLine({ artists: ["A", "B"] }), "A, B");
  assert.equal(artistLine({ artists: [] }), "");
  assert.equal(artistLine({}), "");
  assert.equal(artistLine(undefined), "");
});

test("the player's own queue projects with the playing track marked", () => {
  const queue = [
    { id: "a", title: "First", artists: ["A", "B"], durationMs: 60_000, artworkUrl: "/art/a.jpg" },
    { id: "b", title: "Second", artists: [], durationMs: 90_000 },
  ];
  const projection = queueProjection({ playerQueue: queue, currentIndex: 1 });

  assert.equal(projection.mode, "player");
  assert.equal(projection.label, "Queue");
  assert.equal(projection.count, 2);
  assert.equal(projection.editable, true); // reordering and removing are ours
  assert.equal(projection.empty, "Nothing queued");
  assert.deepEqual(
    projection.rows.map((row) => [row.index, row.title, row.subtitle, row.time, row.playing]),
    [
      [0, "First", "A, B", 60_000, false],
      [1, "Second", "", 90_000, true],
    ]
  );
  assert.equal(projection.rows[0].artwork, "/art/a.jpg");
});

test("an empty queue still knows what to say", () => {
  const empty = queueProjection();
  assert.equal(empty.count, 0);
  assert.equal(empty.empty, "Nothing queued");
  assert.equal(empty.emptyHint, "Play something to fill this.");

  const quiet = queueProjection({
    room: createRoomState({ me: "m1", members: [], queues: {}, masterQueue: [], current: null }),
  });
  assert.equal(quiet.count, 0);
  assert.equal(quiet.empty, "Queue a playlist or song through those tabs");

  const master = queueProjection({
    room: createRoomState({ me: "m1", members: [], queues: {}, masterQueue: [], current: null }),
    showMaster: true,
  });
  assert.equal(master.empty, "Nothing in the room's order yet.");
});

const room = () =>
  createRoomState({
    roomId: "r1",
    me: "member-1",
    members: [
      { id: "member-1", name: "Kyle" },
      { id: "member-2", name: "" },
    ],
    queues: {
      "member-1": [{ id: "q1", trackId: "t1", title: "Mine", addedBy: "member-1", artworkUrl: "/api/v1/artwork/cover.png" }],
      "member-2": [{ id: "q2", trackId: "t2", title: "Theirs", addedBy: "member-2" }],
    },
    masterQueue: [
      { id: "q1", trackId: "t1", title: "Mine", addedBy: "member-1" },
      { id: "q2", trackId: "t2", title: "Theirs", addedBy: "member-2" },
    ],
    current: { item: { id: "q2" } },
  });

test("in a room the queue view shows my own queue, and it is mine to shape", () => {
  const projection = queueProjection({ room: room() });

  assert.equal(projection.mode, "room");
  assert.equal(projection.editable, true);
  assert.equal(projection.count, 1);
  assert.deepEqual(
    projection.rows.map((row) => [row.index, row.title, row.subtitle, row.playing, row.itemId]),
    [[0, "Mine", "queued by Kyle", false, "q1"]]
  );
});

test("a room queue row carries the track's artwork, so the rows are not blank squares", () => {
  const projection = queueProjection({ room: room() });
  assert.equal(projection.rows[0].artwork, "/api/v1/artwork/cover.png");
});

test("the master queue is the room's, shown read only, and leaves out what is playing", () => {
  const projection = queueProjection({ room: room(), showMaster: true });

  // The room is on q2, so the list is what comes after it - and the numbering
  // is the list's own, not the queue's.
  assert.equal(projection.count, 1);
  assert.equal(projection.editable, false);
  assert.deepEqual(
    projection.rows.map((row) => [row.itemId, row.title, row.number]),
    [["q1", "Mine", 1]]
  );
  // The whole order is still what a reorder names, the playing item included.
  assert.deepEqual(projection.order, ["q1", "q2"]);
});

test("a queuer with no name is shown by a readable piece of their id", () => {
  const projection = queueProjection({ room: { ...room(), current: null }, showMaster: true });
  assert.equal(projection.rows[1].subtitle, "queued by member-2");

  const anonymous = queueProjection({
    room: createRoomState({
      me: "whoever",
      members: [],
      queues: { whoever: [{ id: "q9", title: "Nameless", addedBy: "" }] },
      masterQueue: [],
      current: null,
    }),
  });
  assert.equal(anonymous.rows[0].subtitle, "queued by someone");
});
test("an empty station names the provider that had trouble", () => {
  // A station comes back empty because a provider failed, and the sentence
  // that says which one is the whole value of the toast.
  assert.equal(
    radioEmptyReason({ tracks: [], providerErrors: [{ provider: "ytmusic", error: "exit status 1" }] }),
    "Nothing came back to build a radio from \u2014 ytmusic: exit status 1"
  );
  assert.equal(
    radioEmptyReason({ providerErrors: [{ provider: "ytmusic", error: "timeout" }, { provider: "spotify", error: "401" }] }),
    "Nothing came back to build a radio from \u2014 ytmusic: timeout; spotify: 401"
  );
  // With nothing to blame the old sentence still stands, and a station that
  // simply had nothing worth offering is not dressed up as a failure.
  assert.equal(radioEmptyReason({ tracks: [] }), "Nothing came back to build a radio from.");
  assert.equal(radioEmptyReason(undefined), "Nothing came back to build a radio from.");
});
