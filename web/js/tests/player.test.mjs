// The pure part of the player and the source picker: what the bar says, which
// files stay fetched, what plays next, and how the picker orders and marks its
// rows. Everything here is a function of its arguments — no DOM, no server.

import test from "node:test";
import assert from "node:assert/strict";

import {
  albumLine, artistLine, documentKey, mediaStateLabel, nextIndex, playbackDocument,
  playbackStateFrom, prefetchWindow, queueFromDocument, shouldSavePlayback, shuffleTail,
} from "../player.js";
import {
  groupSources, netVotes, pickSource, sourceLabel,
} from "../views/sources.js";
import { enabledPlatforms, platformLabel, selectedPlatforms } from "../platforms.js";

const track = (id) => ({ id, title: id.toUpperCase(), artists: ["Someone"] });
const queue = (...ids) => ids.map(track);
const ids = (tracks) => tracks.map((entry) => entry.id);
const sourceIds = (sources) => sources.map((source) => source.variantId);

test("mediaStateLabel says what a file is doing", () => {
  assert.equal(mediaStateLabel("ready"), "ready");
  assert.equal(mediaStateLabel("downloading"), "downloading…");
  assert.equal(mediaStateLabel("failed"), "download failed");
  // Nothing worth saying, so the bar says nothing.
  assert.equal(mediaStateLabel("none"), "");
  assert.equal(mediaStateLabel(""), "");
  assert.equal(mediaStateLabel(undefined), "");
});

test("prefetchWindow is the current track and the three after it", () => {
  const list = queue("a", "b", "c", "d", "e", "f");
  assert.deepEqual(ids(prefetchWindow(list, 0)), ["a", "b", "c", "d"]);
  assert.deepEqual(ids(prefetchWindow(list, 2)), ["c", "d", "e", "f"]);
  // The end of the queue: there is nothing more to fetch.
  assert.deepEqual(ids(prefetchWindow(list, 4)), ["e", "f"]);
  assert.deepEqual(ids(prefetchWindow(list, 5)), ["f"]);
  assert.deepEqual(prefetchWindow([], 0), []);
  // Nothing playing yet: what the queue would start with.
  assert.deepEqual(ids(prefetchWindow(list, -1)), ["a", "b", "c", "d"]);
  // How far ahead is a parameter, not a fixed three.
  assert.deepEqual(ids(prefetchWindow(list, 0, 1)), ["a", "b"]);
});

test("nextIndex walks the queue and stops at its end", () => {
  const list = queue("a", "b", "c");
  assert.equal(nextIndex(list, 0), 1);
  assert.equal(nextIndex(list, 1), 2);
  // The last track is the last track: a queue does not start over by itself.
  assert.equal(nextIndex(list, 2), -1);
  assert.equal(nextIndex([], -1), -1);
});

test("nextIndex with shuffle picks another track, and still ends", () => {
  const list = queue("a", "b", "c");
  const original = Math.random;
  try {
    Math.random = () => 0;
    assert.equal(nextIndex(list, 1, true), 0);
    assert.equal(nextIndex(list, 0, true), 1);
    Math.random = () => 0.999;
    assert.equal(nextIndex(list, 1, true), 2);
    // A queue with nothing else in it still ends instead of repeating itself.
    assert.equal(nextIndex(queue("only"), 0, true), -1);
    assert.equal(nextIndex([], 0, true), -1);
  } finally {
    Math.random = original;
  }
});

test("shuffleTail shuffles what is left and leaves the head alone", () => {
  const list = queue("a", "b", "c", "d", "e");
  const shuffled = shuffleTail(list, 1);
  assert.deepEqual(ids(shuffled.slice(0, 2)), ["a", "b"]);
  assert.deepEqual([...ids(shuffled)].sort(), ["a", "b", "c", "d", "e"]);
  // The queue it was given is not touched.
  assert.deepEqual(ids(list), ["a", "b", "c", "d", "e"]);
  // Fewer than two tracks left: nothing to shuffle, nothing to change.
  assert.deepEqual(ids(shuffleTail(list, 3)), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(ids(shuffleTail(list, 4)), ["a", "b", "c", "d", "e"]);
  // A fixed source of randomness, so the order itself can be checked.
  assert.deepEqual(ids(shuffleTail(queue("a", "b", "c", "d"), 0, () => 0)), ["a", "c", "d", "b"]);
});

test("the picker lists official sources above the uploaded ones", () => {
  const sources = [
    { variantId: "u2", provider: "user", official: false, upvotes: 3, downvotes: 0 },
    { variantId: "o1", provider: "spotify", official: true, upvotes: 1, downvotes: 0 },
    { variantId: "u1", provider: "user", official: false, upvotes: 9, downvotes: 1 },
    { variantId: "o2", provider: "deezer", official: true, upvotes: 5, downvotes: 1 },
  ];
  const { official, user } = groupSources(sources);
  assert.deepEqual(sourceIds(official), ["o2", "o1"]);
  assert.deepEqual(sourceIds(user), ["u1", "u2"]);
  assert.deepEqual(groupSources([]), { official: [], user: [] });
  assert.deepEqual(groupSources(undefined), { official: [], user: [] });
});

test("net votes decide the order inside a group", () => {
  assert.equal(netVotes({ upvotes: 5, downvotes: 2 }), 3);
  assert.equal(netVotes({ upvotes: 1 }), 1);
  assert.equal(netVotes({}), 0);
  const { user } = groupSources([
    { variantId: "down", official: false, upvotes: 0, downvotes: 2 },
    { variantId: "zero", official: false, upvotes: 1, downvotes: 1 },
    { variantId: "up", official: false, upvotes: 4, downvotes: 0 },
  ]);
  assert.deepEqual(sourceIds(user), ["up", "zero", "down"]);
});

test("a source is named after its uploader, or its provider", () => {
  assert.equal(sourceLabel({ provider: "spotify", official: true }), "spotify");
  assert.equal(
    sourceLabel({ provider: "user", official: false, uploader: { username: "amy", displayName: "Amy Waves" } }),
    "Amy Waves"
  );
  assert.equal(sourceLabel({ provider: "user", official: false, uploader: { username: "amy" } }), "amy");
  assert.equal(sourceLabel({ provider: "user", official: false }), "user");
  assert.equal(sourceLabel(null), "");
  // Two uploads of one song by one person must not draw the same row twice:
  // their lengths tell them apart.
  const amy = { provider: "user", official: false, uploader: { displayName: "Amy Waves" } };
  assert.equal(sourceLabel({ ...amy, durationMs: 126051 }), "Amy Waves \u00b7 2:06");
  assert.equal(sourceLabel({ ...amy, durationMs: 138000 }), "Amy Waves \u00b7 2:18");
  // Two renditions from one provider are told apart the same way.
  assert.equal(sourceLabel({ provider: "ytmusic", official: true, durationMs: 254000 }), "ytmusic \u00b7 4:14");
  assert.equal(sourceLabel({ provider: "ytmusic", official: true, durationMs: 431000 }), "ytmusic \u00b7 7:11");
});

test("pickSource marks the saved source, else the default one", () => {
  const sources = [
    { variantId: "a", provider: "spotify", official: true },
    { variantId: "b", provider: "user", official: false, default: true },
  ];
  assert.equal(pickSource(sources, "a").variantId, "a");
  assert.equal(pickSource(sources).variantId, "b");
  // A preference for a source that is gone falls back to the default.
  assert.equal(pickSource(sources, "vanished").variantId, "b");
  // No default flag at all: the first source is the one.
  assert.equal(pickSource([{ variantId: "x" }, { variantId: "y" }]).variantId, "x");
  assert.equal(pickSource([], "a"), null);
});

test("artistLine joins the artists the API sends", () => {
  assert.equal(artistLine({ artists: ["Amy", "Bo"] }), "Amy, Bo");
  assert.equal(artistLine({ artists: [] }), "");
  assert.equal(artistLine({}), "");
  assert.equal(artistLine(null), "");
});

// --- what was playing, kept for the next run ------------------------------

const apiTrack = (id, title, artists, album) => ({
  id, title, artists, albums: [album], durationMs: 12345, artworkUrl: `/art/${id}`,
});

test("the saved document is the shape the GTK client writes", () => {
  const document = playbackDocument({
    queue: [apiTrack("t1", "One", ["Amy", "Bo"], "First"), apiTrack("t2", "Two", [], "Second")],
    track: apiTrack("t2", "Two", [], "Second"),
    positionMs: 4210.7,
    paused: true,
    playlistId: "pl-1",
    savedAt: 1727000000000,
  });
  assert.deepEqual(document, {
    queue: [
      { trackId: "t1", title: "One", artist: "Amy, Bo", artworkUrl: "/art/t1", durationMs: 12345, album: "First" },
      { trackId: "t2", title: "Two", artist: "", artworkUrl: "/art/t2", durationMs: 12345, album: "Second" },
    ],
    currentTrackId: "t2",
    positionMs: 4211,
    paused: true,
    playlistId: "pl-1",
    savedAt: 1727000000000,
  });
  // Nothing playing, nothing saved about it, and no second thoughts about time.
  const empty = playbackDocument();
  assert.deepEqual(empty.queue, []);
  assert.equal(empty.currentTrackId, "");
  assert.equal(empty.positionMs, 0);
  assert.equal(empty.paused, true);
  assert.equal(empty.playlistId, "");
  assert.ok(Math.abs(empty.savedAt - Date.now()) < 5000);
  // A track that came from a plain "album" field still names its album.
  assert.equal(albumLine({ album: "Only" }), "Only");
  assert.equal(albumLine({}), "");
});

test("a document that only moved its timestamp is not a change", () => {
  const first = playbackDocument({ queue: [apiTrack("t1", "One", ["Amy"], "A")], positionMs: 1000, savedAt: 1 });
  const later = { ...first, savedAt: 999999 };
  assert.equal(documentKey(later), documentKey(first));
  // Key order is not a change either: the server may hand the keys back sorted.
  const reordered = { savedAt: 5, currentTrackId: first.currentTrackId, queue: first.queue, paused: first.paused, positionMs: first.positionMs, playlistId: first.playlistId };
  assert.equal(documentKey(reordered), documentKey(first));
  // A moved position, or a new track, is.
  assert.notEqual(documentKey({ ...first, positionMs: 2000 }), documentKey(first));
  assert.notEqual(documentKey({ ...first, currentTrackId: "t2" }), documentKey(first));
  assert.notEqual(documentKey({ ...first, paused: false }), documentKey(first));
  assert.notEqual(documentKey(playbackDocument({ queue: [], savedAt: 1 })), documentKey(first));
});

test("a saved document rebuilds the queue it describes", () => {
  const document = playbackDocument({
    queue: [apiTrack("t1", "One", ["Amy"], "First"), apiTrack("t2", "Two", ["Bo", "Cy"], "Second")],
    track: apiTrack("t2", "Two", ["Bo", "Cy"], "Second"),
    positionMs: 8500,
    paused: true,
    playlistId: "pl-9",
  });
  const rebuilt = queueFromDocument(document);
  assert.deepEqual(rebuilt.tracks, [
    { id: "t1", title: "One", artists: ["Amy"], albums: ["First"], album: "First", durationMs: 12345, artworkUrl: "/art/t1" },
    { id: "t2", title: "Two", artists: ["Bo, Cy"], albums: ["Second"], album: "Second", durationMs: 12345, artworkUrl: "/art/t2" },
  ]);
  assert.equal(rebuilt.index, 1);
  assert.equal(rebuilt.positionMs, 8500);
  assert.equal(rebuilt.paused, true);
  assert.equal(rebuilt.playlistId, "pl-9");
});

test("a queue whose track is gone starts at the beginning", () => {
  const rebuilt = queueFromDocument({
    queue: [{ trackId: "a", title: "A", artist: "Amy", album: "", artworkUrl: "", durationMs: 0 }],
    currentTrackId: "gone",
    positionMs: -10,
  });
  assert.equal(rebuilt.index, 0);
  assert.equal(rebuilt.positionMs, 0);
  assert.equal(rebuilt.paused, false);
  assert.equal(rebuilt.playlistId, "");
  // Nothing to pick up: no tracks at all.
  assert.equal(queueFromDocument({}).tracks.length, 0);
  assert.equal(queueFromDocument({ queue: [{ title: "no id" }] }).tracks.length, 0);
});

test("the stored state comes back wrapped, and is unwrapped", () => {
  const document = playbackDocument({ queue: [apiTrack("t1", "One", ["Amy"], "A")], track: apiTrack("t1", "One", ["Amy"], "A"), positionMs: 10 });
  assert.deepEqual(playbackStateFrom({ state: document, updatedAt: 5 }), document);
  // A bare document is taken as it is, and nothing at all is an empty one.
  assert.deepEqual(playbackStateFrom(document), document);
  assert.deepEqual(playbackStateFrom({ state: "not an object" }), { state: "not an object" });
  assert.deepEqual(playbackStateFrom(null), {});
  assert.deepEqual(playbackStateFrom(undefined), {});
});

test("guests and followers do not save", () => {
  const queue = [apiTrack("t1", "One", ["Amy"], "A")];
  assert.equal(shouldSavePlayback({ token: "abc", following: null, queue }), true);
  // A guest has no account to save to.
  assert.equal(shouldSavePlayback({ token: "", following: null, queue }), false);
  // What is playing is the friend's to save, not ours.
  assert.equal(shouldSavePlayback({ token: "abc", following: "Amy", queue }), false);
  // Nothing playing is nothing to pick up.
  assert.equal(shouldSavePlayback({ token: "abc", following: null, queue: [] }), false);
  assert.equal(shouldSavePlayback(), false);
});

test("youtube is left out of a search until somebody ticks it", () => {
  const providers = [{ name: "ytmusic" }, { name: "youtube" }, { name: "spotify" }];
  assert.deepEqual(selectedPlatforms(providers), ["ytmusic", "spotify"]);
});

test("the platform filter asks for nothing until it knows the platforms", () => {
  assert.deepEqual(selectedPlatforms([]), []);
});

test("the platforms a search can ask are read from the list the client returns", () => {
  const answer = [
    { name: "ytmusic", capabilities: { search: true, download: true } },
    { name: "youtube", capabilities: { search: true, download: true } },
    // Spotify answers metadata-only: offering it in a search filter would only
    // ever add an error line beside the results.
    { name: "spotify", capabilities: { search: false, download: false } },
  ];
  assert.deepEqual(enabledPlatforms(answer).map((provider) => provider.name), ["ytmusic", "youtube"]);
  // A wrapper shape is accepted too, and anything unusable is empty rather
  // than a list of blanks.
  assert.deepEqual(enabledPlatforms({ providers: answer }).map((p) => p.name), ["ytmusic", "youtube"]);
  assert.deepEqual(enabledPlatforms(undefined), []);
  assert.deepEqual(enabledPlatforms([{ capabilities: {} }, { name: "spotify", capabilities: { search: true } }]).map((p) => p.name), ["spotify"]);
});

test("the filter names the platform when a search asks only one", () => {
  const names = ["ytmusic", "youtube"];
  assert.equal(platformLabel(names, ["ytmusic"]), "ytmusic");
  assert.equal(platformLabel(names, ["ytmusic", "youtube"]), "All platforms");
  assert.equal(platformLabel(names, []), "No platforms");
  assert.equal(platformLabel(names, ["ytmusic", "spotify", "youtube"]), "All platforms");
  assert.equal(platformLabel(["a", "b", "c"], ["a", "b"]), "2 platforms");
  assert.equal(platformLabel([], []), "Platforms");
});

test("the account's own choice is what a search starts from", () => {
  const providers = [{ name: "ytmusic" }, { name: "youtube" }, { name: "spotify" }];
  assert.deepEqual(selectedPlatforms(providers, ["youtube"]), ["youtube"]);
  assert.deepEqual(selectedPlatforms(providers, ["ytmusic", "youtube"]), ["ytmusic", "youtube"]);
  // Unset (empty) falls back to the built-in default: everything but YouTube.
  assert.deepEqual(selectedPlatforms(providers, []), ["ytmusic", "spotify"]);
});

test("the room's clock is the playbar's clock for whoever is playing here", async () => {
  const { roomClock } = await import("../views/room.js");
  const room = {
    serverOffsetMs: 0,
    current: { item: { trackId: "t1" }, timelineMs: 431000, startedAtMs: 1000, atMs: 1000, positionMs: 0, paused: false },
  };
  const current = room.current;

  // Playing here: the file this client has decides both numbers, exactly as the
  // playbar shows them, even though the room plays the track for longer.
  const playing = { current: () => ({ id: "t1" }), positionMs: () => 254000, measuredDurationMs: () => 254000 };
  assert.deepEqual(roomClock(playing, room, current), { positionMs: 254000, durationMs: 254000 });

  // A member not playing it yet has only the room's clock to go on.
  const idle = { current: () => ({ id: "other" }), positionMs: () => 5000, measuredDurationMs: () => 10000 };
  const idleClock = roomClock(idle, room, current, 3000);
  assert.equal(idleClock.durationMs, 431000);
  assert.equal(idleClock.positionMs, 2000);

  // A file whose length is not known yet falls back to the room's timeline.
  const unmeasured = { current: () => ({ id: "t1" }), positionMs: () => 1000, measuredDurationMs: () => 0 };
  assert.deepEqual(roomClock(unmeasured, room, current), { positionMs: 1000, durationMs: 431000 });
});
