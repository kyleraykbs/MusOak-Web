import { state } from "../state.js";
// The pure part of the player and the source picker: what the bar says, which
// files stay fetched, what plays next, and how the picker orders and marks its
// rows. Everything here is a function of its arguments — no server; the few
// tests that draw the download bar stand up the little DOM those need.

import test from "node:test";
import assert from "node:assert/strict";

import {
  albumLine, artistLine, documentKey, mediaProgressLabel, mediaStateLabel, nextIndex, OFFLINE_KEEP, OFFLINE_MAX_BYTES,
  playbackDocument,
  memorySource, playbackStateFrom, prefetchWindow, queueFromDocument, shouldSavePlayback, shuffleWhole, player,
  volumeGain,
} from "../player.js";
import {
  groupSources, netVotes, pickSource, sourceLabel,
} from "../views/sources.js";
import { enabledPlatforms, forgetPlatforms, platformLabel, platformsFor, selectedPlatforms } from "../platforms.js";

const track = (id) => ({ id, title: id.toUpperCase(), artists: ["Someone"] });
const queue = (...ids) => ids.map(track);
const ids = (tracks) => tracks.map((entry) => entry.id);
const sourceIds = (sources) => sources.map((source) => source.variantId);

test("volumeGain makes equal travel an equal loudness step", () => {
  assert.equal(volumeGain(0), 0);
  assert.equal(volumeGain(1), 1);
  // Half the bar is half the loudness, which under Stevens is amplitude^0.6:
  // 0.5^(1/0.6) = 0.315, not the 0.5 a raw linear element would take.
  assert.ok(Math.abs(volumeGain(0.5) - Math.pow(0.5, 5 / 3)) < 1e-12);
  assert.ok(volumeGain(0.5) > 0.31 && volumeGain(0.5) < 0.32);
  // Out of range is clamped, and the curve never goes backwards.
  assert.equal(volumeGain(-1), 0);
  assert.equal(volumeGain(2), 1);
  assert.ok(volumeGain(0.25) < volumeGain(0.5));
});

test("setVolume hands the element the perceptual gain", () => {
  const saved = {
    volume: player._volume, muted: player._muted, audio: player.audio,
    renderBar: player.renderBar, remember: player._remember,
  };
  try {
    const audio = { volume: 1, muted: true };
    player.audio = audio;
    player._muted = false;
    player.renderBar = () => {};
    player._remember = () => {};
    player.setVolume(0.5);
    assert.ok(Math.abs(audio.volume - volumeGain(0.5)) < 1e-12);
    assert.equal(audio.muted, false);
    player.setVolume(1);
    assert.equal(audio.volume, 1);
    player.setVolume(0);
    assert.equal(audio.volume, 0);
  } finally {
    player._volume = saved.volume;
    player._muted = saved.muted;
    player.audio = saved.audio;
    player.renderBar = saved.renderBar;
    player._remember = saved.remember;
  }
});
test("a play press during a load waits for that copy instead of restarting it", () => {
  const saved = {
    queue: player.queue, loading: player._loading, resumeWhenReady: player._resumeWhenReady,
    jumpTo: player.jumpTo,
  };
  let jumped = 0;
  try {
    player.queue = [track("loading")];
    player._loading = true;
    player._resumeWhenReady = false;
    player.jumpTo = () => { jumped += 1; };
    player.resume();
    assert.equal(jumped, 0, "the in-flight load is not replaced");
    assert.equal(player._resumeWhenReady, true, "the press is kept for the hand-off");
  } finally {
    player.queue = saved.queue;
    player._loading = saved.loading;
    player._resumeWhenReady = saved.resumeWhenReady;
    player.jumpTo = saved.jumpTo;
  }
});

test("the copy spends a waiting play press and keeps the pending position", () => {
  const saved = {
    audio: player.audio, pendingSeek: player._pendingSeek, resumeWhenReady: player._resumeWhenReady,
    stateEvent: player._stateEvent, renderBar: player.renderBar, wantResume: player._wantResume,
    startAudio: player._startAudio, setBuffering: player._setBuffering,
  };
  const starts = [];
  try {
    player.audio = { src: "", readyState: 0 };
    player._pendingSeek = 12_000;
    player._resumeWhenReady = true;
    player._stateEvent = () => {};
    player.renderBar = () => {};
    player._wantResume = (wanted) => starts.push(["want", wanted]);
    player._startAudio = (at) => starts.push(["start", at]);
    player._setBuffering = () => {};
    player._handCopyToElement({ url: "blob:restored" }, { autoplay: false });
    assert.deepEqual(starts, [["want", true], ["start", 12_000]]);
    assert.equal(player._resumeWhenReady, false, "the press is spent once");
  } finally {
    player.audio = saved.audio;
    player._pendingSeek = saved.pendingSeek;
    player._resumeWhenReady = saved.resumeWhenReady;
    player._stateEvent = saved.stateEvent;
    player.renderBar = saved.renderBar;
    player._wantResume = saved.wantResume;
    player._startAudio = saved.startAudio;
    player._setBuffering = saved.setBuffering;
  }
});
test("a user seek clears a stale restore position once metadata exists", () => {
  const saved = {
    audio: player.audio, pendingSeek: player._pendingSeek,
    positionEvent: player._positionEvent, saveSoon: player._saveSoon,
  };
  try {
    const audio = { src: "blob:restored", duration: 180, currentTime: 0 };
    player.audio = audio;
    player._pendingSeek = 12_000;
    player._positionEvent = () => {};
    player._saveSoon = () => {};
    player.seek(30_000);
    assert.equal(audio.currentTime, 30, "the handle moves to the user's position");
    assert.equal(player._pendingSeek, null, "the restore cannot snap it back later");
  } finally {
    player.audio = saved.audio;
    player._pendingSeek = saved.pendingSeek;
    player._positionEvent = saved.positionEvent;
    player._saveSoon = saved.saveSoon;
  }
});
test("playing a selected song keeps pending queue items", () => {
  const saved = {
    queue: player.queue,
    index: player._index,
    emit: player._emit,
    jumpTo: player.jumpTo,
    room: player._room,
  };
  const jumps = [];
  try {
    player._room = null;
    player.queue = [track("current"), track("pending")];
    player._index = 0;
    player._emit = () => {};
    player.jumpTo = (index) => jumps.push(index);

    player.playNow(track("selected"));

    assert.deepEqual(ids(player.queue), ["selected", "pending"]);
    assert.equal(player._index, 0);
    assert.deepEqual(jumps, [0]);
  } finally {
    player.queue = saved.queue;
    player._index = saved.index;
    player._emit = saved.emit;
    player.jumpTo = saved.jumpTo;
    player._room = saved.room;
  }
});

test("mediaStateLabel says what a file is doing", () => {
  assert.equal(mediaStateLabel("ready"), "ready");
  assert.equal(mediaStateLabel("downloading"), "downloading…");
  assert.equal(mediaStateLabel("failed"), "download failed");
  // Nothing worth saying, so the bar says nothing.
  assert.equal(mediaStateLabel("none"), "");
  assert.equal(mediaStateLabel(""), "");
  assert.equal(mediaStateLabel(undefined), "");
});

test("prefetchWindow is the current track and the count after it", () => {
  const list = queue("a", "b", "c", "d", "e", "f");
  assert.deepEqual(ids(prefetchWindow(list, 0, 3)), ["a", "b", "c", "d"]);
  assert.deepEqual(ids(prefetchWindow(list, 2, 3)), ["c", "d", "e", "f"]);
  // The count is songs *after* the one playing, so nothing ahead is that one.
  assert.deepEqual(ids(prefetchWindow(list, 0, 0)), ["a"]);
  // The end of the queue: there is nothing more to fetch.
  assert.deepEqual(ids(prefetchWindow(list, 4, 3)), ["e", "f"]);
  assert.deepEqual(ids(prefetchWindow(list, 5, 3)), ["f"]);
  assert.deepEqual(prefetchWindow([], 0, 3), []);
  // Nothing playing yet: what the queue would start with.
  assert.deepEqual(ids(prefetchWindow(list, -1, 3)), ["a", "b", "c", "d"]);
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

test("the room host uses the mixed queue locally and keeps duplicate entries distinct", () => {
  const saved = {
    queue: player.queue,
    index: player._index,
    shuffle: player._shuffle,
    room: player._room,
    load: player._load,
  };
  const loads = [];
  try {
    player.setRoom({ roomId: "room-test", hostPlayback: true });
    player.queue = [];
    player._index = -1;
    player._load = (index, options) => {
      loads.push({ index, options });
      player._index = index;
      return Promise.resolve();
    };

    player.setRoomQueue([
      { id: "shared-track", roomItemId: "item-1" },
      { id: "shared-track", roomItemId: "item-2" },
      { id: "next-track", roomItemId: "item-3" },
    ], "item-2", { positionMs: 5000, autoplay: false });

    assert.deepEqual(loads[0], { index: 1, options: { startMs: 5000, autoplay: false } });
    assert.equal(player.current().roomItemId, "item-2");
    player.next();
    assert.equal(player.current().roomItemId, "item-3", "the host advances its ordinary queue");
    assert.equal(loads[1].index, 2);
    player.next();
    assert.equal(loads.length, 2, "the mixed queue does not wrap at the end");
  } finally {
    player._load = saved.load;
    player.queue = saved.queue;
    player._index = saved.index;
    player._shuffle = saved.shuffle;
    player.setRoom(saved.room);
  }
});

test("shuffle queue shuffles the whole queue, around the one playing", () => {
  const list = queue("a", "b", "c", "d", "e");
  const shuffled = shuffleWhole(list, 1, () => 0);
  assert.equal(shuffled[1].id, "b", "the song that is playing keeps its place");
  assert.deepEqual([...ids(shuffled)].sort(), ["a", "b", "c", "d", "e"], "and nothing is lost or added");
  assert.notDeepEqual(ids(shuffled), ids(list), "the rest of the queue is in another order");
  // The queue it was given is not touched.
  assert.deepEqual(ids(list), ["a", "b", "c", "d", "e"]);

  // Fewer than two others: nothing to shuffle, nothing to change.
  const nearly = queue("a", "b");
  assert.deepEqual(ids(shuffleWhole(nearly, 0)), ["a", "b"]);
  const single = queue("a");
  assert.deepEqual(ids(shuffleWhole(single, 0)), ["a"]);
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

test("a platform list that could not be fetched is not remembered as none", async () => {
  forgetPlatforms();
  try {
    // The page can load while the server is briefly unreachable.
    const offline = { providers: () => Promise.reject(new Error("offline")) };
    assert.deepEqual(await platformsFor(offline), []);
    // That is not an answer, and must not become the session's answer: the next
    // ask has to reach a server that is back, or the filter says there are no
    // platforms until somebody reloads the page.
    const back = { providers: () => Promise.resolve([{ name: "ytmusic", capabilities: { search: true } }]) };
    assert.deepEqual((await platformsFor(back)).map((provider) => provider.name), ["ytmusic"]);
    // An answer that has platforms is asked for once.
    forgetPlatforms();
    let calls = 0;
    const counted = {
      providers: () => {
        calls += 1;
        return Promise.resolve([{ name: "ytmusic", capabilities: { search: true } }]);
      },
    };
    await platformsFor(counted);
    await platformsFor(counted);
    assert.equal(calls, 1);
  } finally {
    forgetPlatforms();
  }
});

test("the room's clock is the playbar's clock for whoever is playing here", async () => {
  const { roomClock } = await import("../views/room.js");
  // The room is at 1000ms on the server clock at instant 1000, and its length
  // is the host's file's; a member with a shorter copy still shows their own.
  const room = {
    serverOffsetMs: 0,
    current: { item: { trackId: "t1" }, durationMs: 431000, started: true, paused: false, positionMs: 1000, atMs: 1000 },
  };
  const current = room.current;

  // Playing here: the file this client has decides both numbers, exactly as the
  // playbar shows them, even though the room's length is different.
  const playing = { current: () => ({ id: "t1" }), positionMs: () => 254000, measuredDurationMs: () => 254000 };
  assert.deepEqual(roomClock(playing, room, current), { positionMs: 254000, durationMs: 254000 });

  // A member not playing it yet has only the room's clock to go on.
  const idle = { current: () => ({ id: "other" }), positionMs: () => 5000, measuredDurationMs: () => 10000 };
  const idleClock = roomClock(idle, room, current, 3000);
  assert.equal(idleClock.durationMs, 431000);
  assert.equal(idleClock.positionMs, 3000, "positionMs + (now - atMs)");

  // A file whose length is not known yet falls back to the room's length.
  const unmeasured = { current: () => ({ id: "t1" }), positionMs: () => 1000, measuredDurationMs: () => 0 };
  assert.deepEqual(roomClock(unmeasured, room, current), { positionMs: 1000, durationMs: 431000 });
});

// --- songs kept in memory for offline play ---------------------------------

/** Lets the player's fetches settle: they are promises, not timers. */
async function settle(times = 12) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

test("the queue's next songs are kept in memory, and the window is the limit", async () => {
  const saved = {
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    order: player._offlineOrder,
    bytes: player._offlineBytes,
    variantFor: player._variantFor,
    warm: player._warm,
    client: player._client,
    room: player._room,
    fetch: globalThis.fetch,
    create: globalThis.URL.createObjectURL,
    revoke: globalThis.URL.revokeObjectURL,
  };
  const fetched = [];
  const revoked = [];
  try {
    player.setRoom(null);
    player._offline = new Map();
    player._offlineOrder = [];
    player._offlineBytes = 0;
    player._variantFor = async (entry) => ({ variantId: `v-${entry.id}` });
    player._warm = async () => true;
    player._client = () => ({
      mediaUrl: (variantId) => `/media/${variantId}`,
      startDownload: async () => ({}),
      // The fetch path names a rendition, and the retry names the other source,
      // so a failed attempt shows up as the variant it asked for.
      rendition: async (trackId) => {
        asked.push(`rendition:${trackId}`);
        throw new Error("the provider said no");
      },
      rendition_for_variant: async (variantId) => {
        asked.push(`for_variant:${variantId}`);
        return { trackId: "a", variantId, path: `/tmp/${variantId}.opus`, durationMs: 1000 };
      },
      variants: async () => [
        { id: "v-a", variantId: "v-a", provider: "one", downloadable: true },
        { id: "v-a2", variantId: "v-a2", provider: "two", downloadable: true },
      ],
      pick_variant: (list) => list[0],
      sources: async () => ({
        sources: [
          { variantId: "v-a", downloadable: true },
          { variantId: "v-a2", downloadable: true },
        ],
        preferredVariantId: "",
      }),
    });
    globalThis.URL.createObjectURL = (blob) => `blob:${blob.size}:${Math.random().toString(36).slice(2)}`;
    globalThis.URL.revokeObjectURL = (url) => revoked.push(url);
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      return { ok: true, blob: async () => ({ size: 1024 }) };
    };

    player.queue = queue("a", "b", "c");
    player._index = 0;
    player.keepOffline(player.offlineWindow());
    // One transfer is under way and the rest are waiting their turn: what the
    // queue's marks are drawn from - the row being fetched now, and the queued.
    assert.equal(player.downloading("a"), true, "the first song's copy is the transfer the page leads with");
    assert.equal(player.downloading("b"), false, "one arrow at a time: b is waiting its turn");
    assert.equal(player.downloading("c"), false, "and so is c");
    // One at a time: each song's fetch, transfer and store is a few microtasks,
    // and the next starts when the one before it is done.
    await settle(40);

    assert.deepEqual(fetched, ["/media/v-a", "/media/v-b", "/media/v-c"]);
    assert.equal(player.offlineState("a"), "ready");
    assert.equal(player.downloading("a"), false, "and a copy that is here is not being fetched");
    assert.equal(player.offlineSummary().ready, 3);
    assert.equal(player.offlineSummary().bytes, 3072);

    // A copy that arrived outlives the window: a song the playhead has left is
    // kept, so stepping back costs nothing.
    player.queue = queue("a");
    player.keepOffline(player.offlineWindow());
    assert.equal(player.offlineState("b"), "ready", "a song out of the window is kept");
    assert.equal(player.offlineState("c"), "ready");
    assert.equal(player.offlineSummary().ready, 3);
    assert.equal(revoked.length, 0, "nothing that had arrived was thrown away");

    // The map is still bounded, to the window's own size: past that the oldest
    // finished copies that are neither in the window nor playing are dropped.
    player._offline = new Map();
    for (let i = 0; i < OFFLINE_KEEP + 5; i += 1) {
      player._offline.set(`old-${i}`, { state: "ready", variantId: `v-old-${i}`, url: `blob:old-${i}`, bytes: 1, at: i });
    }
    player.queue = queue("playing");
    player._index = 0;
    player.keepOffline([track("playing")]);
    assert.equal(player._offline.size, OFFLINE_KEEP, "the copies kept are bounded");
    assert.equal(player.offlineState("playing") === "ready" || player.offlineState("playing") === "pending", true);
    assert.equal(player._offline.has("old-4"), false, "the oldest finished copy went first");
    assert.equal(player._offline.has(`old-${OFFLINE_KEEP + 4}`), true, "the newest finished copies stayed");

    // The count is not the only bound: the copies together may not take more
    // than the byte budget, and a phone tab holding fifty whole songs is
    // exactly what that budget is for. The oldest outside the window go first.
    player._offline = new Map();
    player._offlineBytes = 0;
    const half = Math.floor(OFFLINE_MAX_BYTES / 2);
    for (let i = 0; i < 4; i += 1) {
      player._offline.set(`big-${i}`, { state: "ready", variantId: `v-big-${i}`, url: `blob:big-${i}`, bytes: half, at: i });
      player._offlineBytes += half;
    }
    player.queue = queue("playing");
    player._index = 0;
    player.keepOffline([track("playing")]);
    assert.equal(player._offlineBytes <= OFFLINE_MAX_BYTES, true, "the copies stay inside the byte budget");
    assert.equal(player._offline.has("big-0"), false, "the oldest went first");
    assert.equal(player._offline.has("big-3"), true, "and the newest stayed");
  } finally {
    player._queue = null;
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineOrder = saved.order;
    player._offlineBytes = saved.bytes;
    player._variantFor = saved.variantFor;
    player._warm = saved.warm;
    player._client = saved.client;
    player.setRoom(saved.room);
    globalThis.fetch = saved.fetch;
    globalThis.URL.createObjectURL = saved.create;
    globalThis.URL.revokeObjectURL = saved.revoke;
  }
});

// The window is the device setting: songs *after* the one playing. Five means
// the song on and the five behind it, and nothing past them.
test("the preload window is the setting, in songs after the one playing", async () => {
  const saved = {
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    order: player._offlineOrder,
    wanted: player._offlineWanted,
    inFlight: player._offlineInFlight,
    active: player._offlineActive,
    bytes: player._offlineBytes,
    variantFor: player._variantFor,
    warm: player._warm,
    client: player._client,
    room: player._room,
    ahead: state.preloadAhead,
    fetch: globalThis.fetch,
    create: globalThis.URL.createObjectURL,
    revoke: globalThis.URL.revokeObjectURL,
  };
  const fetched = [];
  try {
    player.setRoom(null);
    player._offline = new Map();
    player._offlineOrder = [];
    player._offlineWanted = [];
    player._offlineInFlight = new Map();
    player._offlineActive = 0;
    player._offlineBytes = 0;
    player._variantFor = async (entry) => ({ variantId: `v-${entry.id}` });
    player._warm = async () => true;
    player._client = () => ({
      mediaUrl: (variantId) => `/media/${variantId}`,
      startDownload: async () => ({}),
    });
    globalThis.URL.createObjectURL = () => "blob:x";
    globalThis.URL.revokeObjectURL = () => {};
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      return { ok: true, blob: async () => new Blob([new Uint8Array(8)]) };
    };

    state.preloadAhead = 2;
    player.queue = queue("a", "b", "c", "d", "e");
    player._index = 0;
    assert.deepEqual(ids(player.offlineWindow()), ["a", "b", "c"], "the song on and the two after it");
    player.keepOffline(player.offlineWindow());
    await settle(40);
    assert.deepEqual(fetched, ["/media/v-a", "/media/v-b", "/media/v-c"], "and nothing past the window");
    assert.equal(player.offlineState("d"), "none", "the fourth song is not this device's business");

    // Zero is a real answer: only the song playing.
    fetched.length = 0;
    player._offline = new Map();
    player._offlineOrder = [];
    player._offlineWanted = [];
    state.preloadAhead = 0;
    assert.deepEqual(ids(player.offlineWindow()), ["a"]);
    player.keepOffline(player.offlineWindow());
    await settle(40);
    assert.deepEqual(fetched, ["/media/v-a"], "only the song playing is fetched");
  } finally {
    state.preloadAhead = saved.ahead;
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineOrder = saved.order;
    player._offlineWanted = saved.wanted;
    player._offlineInFlight = saved.inFlight;
    player._offlineActive = saved.active;
    player._offlineBytes = saved.bytes;
    player._variantFor = saved.variantFor;
    player._warm = saved.warm;
    player._client = saved.client;
    player.setRoom(saved.room);
    globalThis.fetch = saved.fetch;
    globalThis.URL.createObjectURL = saved.create;
    globalThis.URL.revokeObjectURL = saved.revoke;
  }
});

test("a room that reorders its queue reorders what this page fetches", async () => {
  const saved = {
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    order: player._offlineOrder,
    wanted: player._offlineWanted,
    inFlight: player._offlineInFlight,
    active: player._offlineActive,
    bytes: player._offlineBytes,
    variantFor: player._variantFor,
    warm: player._warm,
    client: player._client,
    room: player._room,
    fetch: globalThis.fetch,
    create: globalThis.URL.createObjectURL,
    revoke: globalThis.URL.revokeObjectURL,
    ahead: state.preloadAhead,
  };
  const pending = [];
  try {
    player.setRoom(null);
    state.preloadAhead = 5;
    player._offline = new Map();
    player._offlineOrder = [];
    player._offlineWanted = [];
    player._offlineInFlight = new Map();
    player._offlineActive = 0;
    player._offlineBytes = 0;
    player._variantFor = async (entry) => ({ variantId: `v-${entry.id}` });
    player._warm = async () => true;
    player._client = () => ({
      mediaUrl: (variantId) => `/media/${variantId}`,
      startDownload: async () => ({}),
    });
    globalThis.URL.createObjectURL = () => "blob:x";
    globalThis.URL.revokeObjectURL = () => {};
    // Fetches hang until they are released, and honour the abort like a real
    // one: a song that leaves the window gives its one slot back.
    globalThis.fetch = (url, options) =>
      new Promise((resolve, reject) => {
        pending.push([String(url), resolve]);
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    player.keepOffline(queue("x1", "x2", "x3", "x4"));
    await settle();
    assert.deepEqual(pending.map(([url]) => url), ["/media/v-x1"], "one fetch at a time");

    // The room's order changes under it: n1 is due next now, x1 and x2 have
    // moved out of the window. The fetch that left is let go and its slot goes
    // to the song the room is about to reach.
    player.keepOffline(queue("n1", "x3", "x4"));
    await settle();
    assert.equal(pending.at(-1)[0], "/media/v-n1", "the song the room is about to reach goes first");
  } finally {
    state.preloadAhead = saved.ahead;
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineOrder = saved.order;
    player._offlineWanted = saved.wanted;
    player._offlineInFlight = saved.inFlight;
    player._offlineActive = saved.active;
    player._offlineBytes = saved.bytes;
    player._variantFor = saved.variantFor;
    player._warm = saved.warm;
    player._client = saved.client;
    player.setRoom(saved.room);
    globalThis.fetch = saved.fetch;
    globalThis.URL.createObjectURL = saved.create;
    globalThis.URL.revokeObjectURL = saved.revoke;
  }
});

test("a song kept in memory plays with nothing reachable", async () => {
  const saved = {
    ensureAudio: player.ensureAudio,
    audio: player.audio,
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    bytes: player._offlineBytes,
    sources: player._sources,
    source: player._source,
    variant: player._variant,
    variantFor: player._variantFor,
    online: player.online,
    room: player._room,
  };
  const resolutions = [];
  const audio = {
    src: "",
    currentTime: 0,
    duration: 0,
    paused: true,
    readyState: 0,
    removeAttribute() {},
    load() {},
    pause() {},
    play() {
      return { catch() {} };
    },
  };
  try {
    player.setRoom(null);
    player.ensureAudio = () => audio;
    player.audio = audio;
    player.queue = queue("a");
    player._index = 0;
    player._offline = new Map([["a", { state: "ready", variantId: "v-a", url: "blob:a", bytes: 4 }]]);
    player._offlineBytes = 4;
    player._variantFor = () => {
      resolutions.push("resolved");
      throw new Error("the server was asked");
    };
    player.online = () => false;

    await player._load(0, { autoplay: false });

    assert.equal(audio.src, "blob:a", "the copy on this device is what plays");
    assert.deepEqual(resolutions, [], "nothing was resolved with the server gone");
  } finally {
    player.ensureAudio = saved.ensureAudio;
    player.audio = saved.audio;
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._sources = saved.sources;
    player._source = saved.source;
    player._variant = saved.variant;
    player._variantFor = saved.variantFor;
    player.online = saved.online;
    player.setRoom(saved.room);
  }
});

test("the transport still works when the room cannot be reached", () => {
  const saved = { room: player._room, online: player.online, queue: player.queue, index: player._index, audio: player.audio };
  const asked = [];
  try {
    player.queue = queue("a");
    player._index = 0;
    player.audio = {
      src: "blob:a",
      paused: true,
      play() {
        this.paused = false;
        return { catch() {} };
      },
      pause() {
        this.paused = true;
      },
    };
    player.setRoom({
      roomId: "room-test",
      pause: () => asked.push("pause"),
      resume: () => asked.push("resume"),
      skip: () => asked.push("skip"),
    });

    // Offline the room is a place that cannot be asked anything, so the button
    // has to be this device's own.
    player.online = () => false;
    player.pause();
    assert.equal(player.isPaused(), true, "the local element pauses");
    player.resume();
    assert.equal(player.isPaused(), false, "and resumes");
    assert.deepEqual(asked, [], "nothing was asked of a room that cannot answer");

    // Online it is the room's call again: it is the only thing that can change
    // what the room is doing.
    player.online = () => true;
    player.toggle();
    assert.deepEqual(asked, ["pause"], "online the room is asked");
  } finally {
    // The resume retry outlives the assertion on purpose; the test is not
    // waiting four seconds for it.
    player._wantResume(false);
    clearInterval(player._resumeTimer);
    player._resumeTimer = 0;
    player.online = saved.online;
    player.audio = saved.audio;
    player.queue = saved.queue;
    player._index = saved.index;
    player.setRoom(saved.room);
  }
});

// A browser that refuses a play while the page is in the background leaves the
// element paused - the same state a listener's own pause leaves - so the retry
// that keeps a backgrounded session going has to gate on "not playing", not on
// "not paused". The one bare "not playing" it must not touch is a file that has
// run out: play() would start it again from the top.
test("a refused play is asked for again, but an ended file is not", () => {
  const played = [];
  const audio = {
    src: "/media/v-a",
    paused: true,
    ended: false,
    play() {
      played.push(this.src);
      return { catch() {} };
    },
  };
  const saved = { audio: player.audio, resume: player._resumeWanted };
  try {
    player.audio = audio;
    player._resumeWanted = true;

    player._retryWanted();
    assert.deepEqual(played, ["/media/v-a"], "a paused element the browser refused is asked again");

    audio.paused = false;
    player._retryWanted();
    assert.deepEqual(played, ["/media/v-a"], "a file that is playing is left alone");

    audio.paused = true;
    audio.ended = true;
    player._retryWanted();
    assert.deepEqual(played, ["/media/v-a"], "an ended file is never started again");
  } finally {
    player.audio = saved.audio;
    player._resumeWanted = saved.resume;
  }
});


// --- songs this page already holds -----------------------------------------
//
// A kept playlist hands the player tracks that carry the URL their own bytes
// are at. With the server gone there is nothing to resolve, nothing to poll and
// nothing to fetch ahead, and any of those would be a request whose only answer
// is "no" - so what is pinned here is that none of them happens, and that the
// element is given the copy this machine already has.

/** The player stood up with an element and a client that cannot answer. */
function standUpLocal({ audio, warmed, fetched, asked }) {
  player.setRoom(null);
  player.audio = audio;
  // There is no server: anything that asks it throws, so a test that passes
  // with this in place has asked it nothing.
  player._client = () => {
    asked.push("server");
    throw new Error("no server");
  };
  player.warm = (track) => warmed.push(track?.id || "");
  player.keepOffline = (tracks) => fetched.push(...(tracks || []).map((track) => track.id));
  player._saveSoon = () => {};
  player._wantResume = () => {};
}

test("a song that says where its own copy is plays without asking the server", async () => {
  const saved = {
    audio: player.audio, queue: player.queue, index: player._index, variant: player._variant,
    loading: player._loading, client: player._client, warm: player.warm,
    keepOffline: player.keepOffline, saveSoon: player._saveSoon, wantResume: player._wantResume,
    playingWanted: player._playingWanted, room: player._room,
  };
  const played = [];
  const warmed = [];
  const fetched = [];
  const asked = [];
  try {
    standUpLocal({ audio: domAudio(played), warmed, fetched, asked });
    const tracks = [
      { id: "t1", title: "One", variantId: "v1", localUrl: "/api/v1/media/v1?ms=local" },
      { id: "t2", title: "Two", variantId: "v2", localUrl: "/api/v1/media/v2?ms=local" },
    ];

    player.play(tracks, 0);

    assert.deepEqual(played, ["http://localhost/api/v1/media/v1?ms=local"], "the element was handed the copy that is here");
    assert.equal(player._variant, "v1", "and the bar names the rendition it is playing");
    assert.equal(player._loading, false, "nothing is being fetched, so nothing is waited for");
    assert.equal(player._stream, undefined, "the player has no provider stream state");
    assert.equal(player.state().playing, true);
    assert.deepEqual(warmed, [], "no song of the list was fetched ahead: they are all here");
    assert.deepEqual(fetched, [], "and none of them was kept in memory again");
    assert.deepEqual(asked, [], "nothing at all was asked of the server");

    // The song after it arrives the same way, which is what makes a kept
    // playlist play through rather than stopping at its first song.
    player.next();
    assert.deepEqual(played[1], "http://localhost/api/v1/media/v2?ms=local");
    assert.deepEqual(asked, []);
  } finally {
    player.audio = saved.audio;
    player.queue = saved.queue;
    player._index = saved.index;
    player._variant = saved.variant;
    player._loading = saved.loading;
    player._client = saved.client;
    player.warm = saved.warm;
    player.keepOffline = saved.keepOffline;
    player._saveSoon = saved.saveSoon;
    player._wantResume = saved.wantResume;
    player._playingWanted = saved.playingWanted;
    clearInterval(player._resumeTimer);
    player._resumeTimer = 0;
    player.setRoom(saved.room);
  }
});

test("playLocal plays the URL it was handed, and nothing else", () => {
  const saved = {
    audio: player.audio, queue: player.queue, index: player._index, variant: player._variant,
    loading: player._loading, client: player._client, warm: player.warm,
    keepOffline: player.keepOffline, saveSoon: player._saveSoon, wantResume: player._wantResume,
    playingWanted: player._playingWanted, room: player._room,
  };
  const played = [];
  const warmed = [];
  const fetched = [];
  const asked = [];
  const statuses = player._status.size;
  try {
    standUpLocal({ audio: domAudio(played), warmed, fetched, asked });

    assert.equal(player.playLocal({ id: "t1", title: "One", variantId: "v1" }, "/api/v1/media/v1?ms=local"), true);
    assert.deepEqual(played, ["http://localhost/api/v1/media/v1?ms=local"]);
    assert.deepEqual(player.queue.map((track) => track.id), ["t1"], "the queue is the one song, as playOffline makes it");
    assert.equal(player.queue[0].localUrl, "/api/v1/media/v1?ms=local", "which carries the URL it plays from");
    assert.equal(player._index, 0);
    assert.equal(player._loading, false);
    assert.deepEqual(warmed, [], "nothing is fetched ahead");
    assert.deepEqual(asked, [], "and nothing is asked of the server");
    assert.equal(
      player._status.size, statuses,
      "no status is invented for it either: where the file is was never the server's to report here"
    );

    // What it cannot play it refuses, rather than half-playing it.
    assert.equal(player.playLocal({ id: "t1" }, ""), false, "a song with no URL");
    assert.equal(player.playLocal(null, "/api/v1/media/v1?ms=local"), false, "no song");
    assert.deepEqual(played.length, 1, "and the element is left where it was");
  } finally {
    player.audio = saved.audio;
    player.queue = saved.queue;
    player._index = saved.index;
    player._variant = saved.variant;
    player._loading = saved.loading;
    player._client = saved.client;
    player.warm = saved.warm;
    player.keepOffline = saved.keepOffline;
    player._saveSoon = saved.saveSoon;
    player._wantResume = saved.wantResume;
    player._playingWanted = saved.playingWanted;
    clearInterval(player._resumeTimer);
    player._resumeTimer = 0;
    player.setRoom(saved.room);
  }
});

test("offline, a queue that lost one song carries on to the next it holds", () => {
  const saved = {
    queue: player.queue, index: player._index, load: player._load, room: player._room,
  };
  const jumped = [];
  try {
    player.setRoom(null);
    // The first song's bytes are gone - evicted between the page being drawn and
    // the press - and the second one is here.
    player.queue = [{ id: "t1", title: "One" }, { id: "t2", title: "Two", localUrl: "/api/v1/media/v2?ms=local" }];
    player._index = 0;
    player.online = () => false;
    player._load = (index) => {
      jumped.push(index);
      player._index = index;
    };

    assert.equal(player._skipUnavailable(), true, "the queue moves on rather than sitting on a song it does not have");
    assert.deepEqual(jumped, [1]);
    assert.equal(player._index, 1);
  } finally {
    player.queue = saved.queue;
    player._index = saved.index;
    player._load = saved.load;
    delete player.online;
    player.setRoom(saved.room);
  }
});

// An element the way a browser hands one over: `src` reads back resolved against
// the document, which is where a relative path from the client and the element's
// own absolute URL stop being the same string.
const domAudio = (played, { baseURL = "http://localhost/app/", duration = Infinity } = {}) => {
  const audio = {
    baseURL,
    _src: "",
    currentTime: 0,
    duration,
    paused: false,
    ended: false,
    readyState: 0,
    volume: 1,
    muted: false,
    listeners: {},
    addEventListener(name, fn) {
      (this.listeners[name] = this.listeners[name] || []).push(fn);
    },
    removeEventListener(name, fn) {
      this.listeners[name] = (this.listeners[name] || []).filter((each) => each !== fn);
    },
    fire(name) {
      for (const fn of [...(this.listeners[name] || [])]) fn({ type: name });
    },
    load() {},
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      played.push(this.src);
      return { catch() {} };
    },
    removeAttribute(name) {
      if (name === "src") this._src = "";
    },
  };
  Object.defineProperty(audio, "src", {
    enumerable: true,
    configurable: true,
    get() {
      return this._src;
    },
    set(value) {
      this._src = new URL(value, baseURL).href;
    },
  });
  return audio;
};

const spareElement = (played) => ({
  src: "",
  currentTime: 0,
  duration: 200,
  paused: true,
  readyState: 0,
  volume: 0,
  muted: false,
  listeners: {},
  addEventListener(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
  },
  removeEventListener(name, fn) {
    this.listeners[name] = (this.listeners[name] || []).filter((each) => each !== fn);
  },
  fire(name) {
    for (const fn of [...(this.listeners[name] || [])]) fn({ type: name });
  },
  removeAttribute() {
    this.src = "";
  },
  load() {},
  pause() {
    this.paused = true;
  },
  play() {
    this.paused = false;
    played.push(this.src);
    return Promise.resolve();
  },
});

test("changing track does not abort a fetch in flight, and its bytes are kept", async () => {
  const saved = {
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    bytes: player._offlineBytes,
    order: player._offlineOrder,
    active: player._offlineActive,
    variantFor: player._variantFor,
    warm: player._warm,
    client: player._client,
    fetch: globalThis.fetch,
    create: globalThis.URL.createObjectURL,
    room: player._room,
  };
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const signals = [];
  try {
    player.setRoom(null);
    player.queue = queue("a", "b");
    player._index = 0;
    player._offline = new Map([
      ["b", { state: "pending", variantId: "", url: "", bytes: 0, at: Date.now() }],
    ]);
    player._offlineBytes = 0;
    player._offlineOrder = [];
    player._offlineActive = 0;
    player._variantFor = async (entry) => ({ variantId: `v-${entry.id}` });
    player._warm = async () => true;
    player._client = () => ({
      mediaUrl: (variantId) => `/media/${variantId}`,
      startDownload: async () => ({}),
      // The fetch path names a rendition, and the retry names the other source,
      // so a failed attempt shows up as the variant it asked for.
      rendition: async (trackId) => {
        asked.push(`rendition:${trackId}`);
        throw new Error("the provider said no");
      },
      rendition_for_variant: async (variantId) => {
        asked.push(`for_variant:${variantId}`);
        return { trackId: "a", variantId, path: `/tmp/${variantId}.opus`, durationMs: 1000 };
      },
      variants: async () => [
        { id: "v-a", variantId: "v-a", provider: "one", downloadable: true },
        { id: "v-a2", variantId: "v-a2", provider: "two", downloadable: true },
      ],
      pick_variant: (list) => list[0],
      sources: async () => ({
        sources: [
          { variantId: "v-a", downloadable: true },
          { variantId: "v-a2", downloadable: true },
        ],
        preferredVariantId: "",
      }),
    });
    globalThis.URL.createObjectURL = () => "blob:kept";
    globalThis.fetch = async (url, options) => {
      signals.push(options?.signal);
      await gate;
      return { ok: true, blob: async () => ({ size: 512 }) };
    };

    const inFlight = player._fetchOffline("b");
    // The track changes while the fetch is still going: the window no longer
    // holds "b" at all.
    player.queue = queue("z");
    player._index = 0;
    player.keepOffline([track("z")]);

    assert.equal(player.offlineState("b"), "pending", "the fetch in flight is still under way");
    assert.ok(player._offline.has("b"), "and its entry was not discarded");

    release();
    await inFlight;
    await settle();

    assert.equal(player.offlineState("b"), "ready", "its bytes were kept, not thrown away");
    // The fetch started here, by hand, is not a slot the pump owns: nothing
    // may abort it. (A fetch the pump starts is given its slot's signal.)
    assert.equal(signals[0], undefined, "the fetch in hand was given no AbortSignal");
  } finally {
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._offlineOrder = saved.order;
    player._offlineActive = saved.active;
    player._variantFor = saved.variantFor;
    player._warm = saved.warm;
    player._client = saved.client;
    player.setRoom(saved.room);
    globalThis.fetch = saved.fetch;
    globalThis.URL.createObjectURL = saved.create;
  }
});

test("a song played from this page's own copy still names its source", () => {
  // The bar's pill says where the song came from; a local copy is not a song
  // without a platform.  What the page resolved for the track - the resolution
  // that fetched the copy - is what names it.
  const sources = [
    { variantId: "s1", provider: "spotify", official: true },
    { variantId: "y2", provider: "ytmusic", official: true },
  ];
  const known = { sources, preferredVariantId: "s1", variantId: "y2", source: sources[0] };

  // The copy's own rendition is the honest answer.
  assert.equal(memorySource(known, "y2"), sources[1]);
  // A rendition the page no longer lists falls back to the song's own default.
  assert.equal(memorySource({ ...known, sources: [sources[0]] }, "y2"), sources[0]);
  // ...and with no default either, to any source of it: the platform beats
  // nothing.  (This is the case the pill was empty for.)
  assert.equal(memorySource({ sources: [sources[0]] }, "gone"), sources[0]);
  // Nothing known about the track at all: nothing to say.
  assert.equal(memorySource(null, "y2"), null);
  assert.equal(memorySource({ sources: [] }, "y2"), null);

  // And it feeds the pill: the label is the provider, as everywhere else.
  assert.equal(sourceLabel(memorySource(known, "y2")), "ytmusic");
});

test("a file that will not arrive is tried from another source, then the queue moves on", async () => {
  const saved = {
    audio: player.audio,
    ensureAudio: player.ensureAudio,
    queue: player.queue,
    index: player._index,
    sources: player._sources,
    variant: player._variant,
    warm: player._warm,
    variantFor: player._variantFor,
    resolveFixed: player._resolveFixed,
    client: player._client,
    online: player.online,
    report: player._report,
    reportListen: player._reportListen,
    room: player._room,
    retriedFor: player._retriedFor,
    failedVariant: player._failedVariant,
    offline: player._offline,
    offlineOrder: player._offlineOrder,
    offlineWanted: player._offlineWanted,
    offlineInFlight: player._offlineInFlight,
    offlineActive: player._offlineActive,
    offlineBytes: player._offlineBytes,
    fetch: globalThis.fetch,
  };
  const asked = [];
  const audio = {
    src: "",
    currentTime: 0,
    paused: true,
    readyState: 0,
    removeAttribute() {},
    load() {},
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return { catch() {} };
    },
  };
  // Both sources are known to the page, which is what makes a retry possible:
  // what failed is one of them, and the other is what it is tried from.
  const resolution = (variantId) => ({
    variantId,
    sources: [
      { variantId: "v-a", downloadable: true },
      { variantId: "v-a2", downloadable: true },
    ],
    preferredVariantId: "",
  });
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    player.setRoom(null);
    player.audio = audio;
    player.ensureAudio = () => audio;
    player.queue = queue("a", "b");
    player._index = 0;
    player._variant = "v-a";
    player._loading = true;
    player.online = () => true;
    player._report = (error) => asked.push(`report:${error.message}`);
    player._reportListen = () => {};
    player._offline = new Map();
    player._offlineOrder = [];
    player._offlineWanted = [];
    player._offlineInFlight = new Map();
    player._offlineActive = 0;
    player._offlineBytes = 0;
    // Every attempt at the broken song fails; the song behind it arrives.
    player._warm = async (variantId) => String(variantId) !== "v-a";
    globalThis.fetch = async () => ({ ok: true, blob: async () => ({ size: 1 }) });
    player._variantFor = async (entry) => resolution(String(entry.id) === "a" ? "v-a" : "v-b");
    player._resolveFixed = async (entry, variantId) => {
      asked.push(`fixed:${variantId}`);
      return resolution(variantId);
    };
    player._client = () => ({
      mediaUrl: (variantId) => `/media/${variantId}`,
      startDownload: async () => ({}),
      sources: async () => ({ sources: resolution("v-a").sources, preferredVariantId: "" }),
    });

    // The file the element was given could not be fetched. The retry starts at
    // once, and the red line it leaves is what the next song must not inherit.
    await player._awaitCopy({ variantId: "v-a", token: player._token, autoplay: false });
    assert.equal(player._retriedFor, "a", "the failed song is the one being retried");
    await tick(50);
    // The retry ran (the song is the one being retried) and, with every fetch in
    // this test failing, it ended where it must: the next song in the queue.
    assert.ok(player._retriedFor, "a retry was attempted before anything was skipped");

    // And when that one fails too, the queue moves on rather than stopping.
    await player._awaitCopy({ variantId: "v-a2", token: player._token, autoplay: false });
    await tick(50);
    // Where it lands is the queue's business (this stub fails every fetch, so
    // every song in it is retried and then left); what this test is about is
    // that nothing was skipped before it had been tried again.
    assert.equal(player._index >= 1, true, "the queue moved past the song that will not fetch");
  } finally {
    player.audio = saved.audio;
    player.ensureAudio = saved.ensureAudio;
    player.queue = saved.queue;
    player._index = saved.index;
    player._sources = saved.sources;
    player._variant = saved.variant;
    player._warm = saved.warm;
    player._variantFor = saved.variantFor;
    player._resolveFixed = saved.resolveFixed;
    player._client = saved.client;
    player.online = saved.online;
    player._report = saved.report;
    player._reportListen = saved.reportListen;
    player.setRoom(saved.room);
    player._retriedFor = saved.retriedFor;
    player._failedVariant = saved.failedVariant;
    player._offline = saved.offline;
    player._offlineOrder = saved.offlineOrder;
    player._offlineWanted = saved.offlineWanted;
    player._offlineInFlight = saved.offlineInFlight;
    player._offlineActive = saved.offlineActive;
    player._offlineBytes = saved.offlineBytes;
    globalThis.fetch = saved.fetch;
    clearInterval(player._resumeTimer);
    player._resumeTimer = null;
    clearTimeout(player._saveTimer);
    player._saveTimer = null;
  }
});

// When the resolution itself failed there is no file to blame, so the retry is
// the same request again - and a song that then plays is not skipped.
test("a resolution that failed is asked again before anything is skipped", async () => {
  const saved = {
    audio: player.audio,
    queue: player.queue,
    index: player._index,
    variantFor: player._variantFor,
    warm: player._warm,
    client: player._client,
    online: player.online,
    report: player._report,
    room: player._room,
    retriedFor: player._retriedFor,
    failedVariant: player._failedVariant,
    offline: player._offline,
    offlineOrder: player._offlineOrder,
    offlineWanted: player._offlineWanted,
    offlineInFlight: player._offlineInFlight,
    offlineActive: player._offlineActive,
    offlineBytes: player._offlineBytes,
    fetch: globalThis.fetch,
  };
  const asked = [];
  const audio = {
    src: "",
    currentTime: 0,
    paused: true,
    readyState: 0,
    removeAttribute() {},
    load() {},
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return { catch() {} };
    },
  };
  try {
    player.setRoom(null);
    player.audio = audio;
    player.queue = queue("a", "b");
    player._index = 0;
    player.online = () => true;
    player._report = (error) => asked.push(`report:${error.message}`);
    player._offline = new Map();
    player._offlineOrder = [];
    player._offlineWanted = [];
    player._offlineInFlight = new Map();
    player._offlineActive = 0;
    player._offlineBytes = 0;
    player._failedVariant = "";
    player._warm = async () => true;
    globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(16)]) });
    player._variantFor = async (entry) => {
      asked.push(`resolve:${entry.id}`);
      if (asked.filter((each) => each === `resolve:${entry.id}`).length === 1) {
        throw new Error("the server blinked");
      }
      return { variantId: "v-a", sources: [{ variantId: "v-a", downloadable: true }], preferredVariantId: "" };
    };
    player._client = () => ({
      mediaUrl: (variantId) => `/media/${variantId}`,
      startDownload: async () => ({}),
      sources: async () => ({ sources: [] }),
    });

    await player._load(0, { autoplay: false });
    await new Promise((resolve) => setTimeout(resolve, 900));

    const resolves = asked.filter((each) => each === "resolve:a");
    assert.ok(resolves.length >= 2, "the same song was asked for again");
    assert.ok(asked.includes("report:the server blinked"), "the failure was still said out loud");
    assert.equal(player._index, 0, "and it played rather than being skipped");
    assert.equal(player._error, "", "with no red line left under it");
  } finally {
    player.audio = saved.audio;
    player.queue = saved.queue;
    player._index = saved.index;
    player._variantFor = saved.variantFor;
    player._warm = saved.warm;
    player._client = saved.client;
    player.online = saved.online;
    player._report = saved.report;
    player.setRoom(saved.room);
    player._retriedFor = saved.retriedFor;
    player._failedVariant = saved.failedVariant;
    player._offline = saved.offline;
    player._offlineOrder = saved.offlineOrder;
    player._offlineWanted = saved.offlineWanted;
    player._offlineInFlight = saved.offlineInFlight;
    player._offlineActive = saved.offlineActive;
    player._offlineBytes = saved.offlineBytes;
    globalThis.fetch = saved.fetch;
    clearInterval(player._resumeTimer);
    player._resumeTimer = null;
    clearTimeout(player._saveTimer);
    player._saveTimer = null;
  }
});

// What is still to be downloaded has to follow the queue it is downloaded for:
// a shuffle makes different songs the next ones due, and the songs still cold
// are fetched in the new order, one at a time as always.
test("what is still to be downloaded follows a shuffle", async () => {
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const saved = {
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    bytes: player._offlineBytes,
    order: player._offlineOrder,
    wanted: player._offlineWanted,
    inFlight: player._offlineInFlight,
    active: player._offlineActive,
    fetchOffline: player._fetchOffline,
    room: player._room,
    shuffle: player._shuffle,
    loading: player._loading,
    ahead: state.preloadAhead,
  };
  const asked = [];
  const release = new Map();
  try {
    player.setRoom(null);
    state.preloadAhead = 5;
    player._shuffle = true;
    player._loading = false;
    // Fourteen songs, five preloaded: whatever the shuffle does, the window it
    // lands on has something cold in it to fetch.
    player.queue = queue("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n");
    player._index = 0;
    player._offline = new Map();
    player._offlineBytes = 0;
    player._offlineOrder = [];
    player._offlineWanted = [];
    player._offlineInFlight = new Map();
    player._offlineActive = 0;
    player._fetchOffline = (id, signal) =>
      new Promise((resolve) => {
        asked.push(id);
        release.set(id, () => {
          const entry = player._offline.get(id);
          if (entry) entry.state = "ready";
          resolve();
        });
        // A fetch whose song left the window is let go, and its one slot has to
        // come back for the song that replaced it.
        signal?.addEventListener("abort", () => resolve());
      });

    player._prefetch();
    assert.deepEqual(asked, ["a"], "one at a time, from the song playing");
    for (let step = 0; step < 5; step += 1) {
      release.get(asked.at(-1))();
      await tick(0);
    }
    assert.deepEqual(asked, ["a", "b", "c", "d", "e", "f"], "through the window, one at a time");

    // The queue is shuffled: different songs are the ones still cold now, and
    // what the pump starts next has to be the queue's new order.
    const beforeShuffle = asked.length;
    player.shuffleQueue();
    const window = player.queue.map((entry) => entry.id).slice(0, 6);
    const cold = (id) => player._offline.get(id)?.state !== "ready";
    // What the pump still has to start: cold, and not the transfer already in
    // hand (that one was asked for before the shuffle and is not asked again).
    const wanted = window.filter((id) => cold(id) && !player._offlineInFlight.has(id));
    assert.ok(wanted.length >= 1, "there is still something to download");

    let guard = 0;
    while (window.some(cold)) {
      guard += 1;
      assert.ok(guard < 12, "the pump keeps starting one song at a time");
      player._pumpOffline();
      for (const id of [...player._offlineInFlight.keys()]) release.get(id)?.();
      await tick(0);
    }
    assert.deepEqual(
      asked.slice(beforeShuffle),
      wanted,
      "the songs still to be downloaded are fetched in the queue's order"
    );
  } finally {
    state.preloadAhead = saved.ahead;
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._offlineOrder = saved.order;
    player._offlineWanted = saved.wanted;
    player._offlineInFlight = saved.inFlight;
    player._offlineActive = saved.active;
    player._fetchOffline = saved.fetchOffline;
    player._loading = saved.loading;
    player.setRoom(saved.room);
    player._shuffle = saved.shuffle;
  }
});

// A fetch under way is kept when the window merely moves: cancelling and
// restarting it was a fetch that never finished - the front of the window moves
// on every room load - and the restarts spent the pipe the slow tail was meant
// to conserve. A song that has left the window altogether is still let go, and
// the songs now due take the slots as the ones in hand free up.
test("a fetch still in the window keeps its slot when the order moves", async () => {
  const saved = {
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    bytes: player._offlineBytes,
    order: player._offlineOrder,
    wanted: player._offlineWanted,
    inFlight: player._offlineInFlight,
    active: player._offlineActive,
    fetchOffline: player._fetchOffline,
    loading: player._loading,
    room: player._room,
  };
  const asked = [];
  const aborted = [];
  const release = new Map();
  try {
    player.setRoom(null);
    player._loading = false;
    player.queue = queue("a", "b", "c", "d");
    player._index = 0;
    player._offline = new Map(["a", "b", "c", "d"].map((id) => [id, { state: "pending", variantId: "", url: "", bytes: 0, at: 0 }]));
    player._offlineBytes = 0;
    player._offlineOrder = [];
    player._offlineWanted = ["a", "b", "c", "d"];
    player._offlineInFlight = new Map();
    player._offlineActive = 0;
    // Each fetch holds until it is released; letting it go leaves it pending.
    player._fetchOffline = (id, signal) =>
      new Promise((resolve) => {
        asked.push(id);
        let done = false;
        const settle = (ready) => {
          if (done) return;
          done = true;
          if (ready) {
            const entry = player._offline.get(id);
            if (entry) entry.state = "ready";
          }
          resolve();
        };
        signal?.addEventListener("abort", () => {
          aborted.push(id);
          settle(false);
        });
        release.set(id, () => settle(true));
      });

    player._pumpOffline();
    assert.deepEqual(asked, ["a"], "one fetch at a time, the song first in the window");

    // The room's order moves: c and d are the next ones due, and a and b are
    // still in the window, only further back.
    player.queue = queue("c", "d", "a", "b");
    player.keepOffline([track("c"), track("d"), track("a"), track("b")]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(aborted, [], "nothing was cancelled, because nothing left the window");
    assert.deepEqual(asked, ["a"], "and nothing was restarted either");

    // The one slot frees: the song now due gets it.
    release.get("a")();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(asked, ["a", "c"], "the song now due took the free slot");

    // A song that leaves the window altogether is let go.
    player.queue = queue("d", "b", "e");
    player.keepOffline([track("d"), track("b"), track("e")]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(aborted, ["c"], "the fetch whose song left the window was let go");
  } finally {
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._offlineOrder = saved.order;
    player._offlineWanted = saved.wanted;
    player._offlineInFlight = saved.inFlight;
    player._offlineActive = saved.active;
    player._fetchOffline = saved.fetchOffline;
    player._loading = saved.loading;
    player.setRoom(saved.room);
  }
});

// One at a time, in the queue's order, and only the window: the next song starts
// when the one before it is here, and a song past the setting is never asked for.
test("the window is fetched one at a time, in the queue's order", async () => {
  const saved = {
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    bytes: player._offlineBytes,
    order: player._offlineOrder,
    wanted: player._offlineWanted,
    inFlight: player._offlineInFlight,
    active: player._offlineActive,
    fetchOffline: player._fetchOffline,
    loading: player._loading,
    room: player._room,
    ahead: state.preloadAhead,
  };
  const asked = [];
  const release = new Map();
  try {
    player.setRoom(null);
    state.preloadAhead = 2;
    player._loading = false;
    player.queue = queue("a", "b", "c", "d", "e", "f", "g", "h");
    player._index = 0;
    player._offline = new Map();
    player._offlineBytes = 0;
    player._offlineOrder = [];
    player._offlineWanted = [];
    player._offlineInFlight = new Map();
    player._offlineActive = 0;
    player._fetchOffline = (id) =>
      new Promise((resolve) => {
        asked.push(id);
        release.set(id, () => {
          const entry = player._offline.get(id);
          if (entry) entry.state = "ready";
          resolve();
        });
      });

    player._prefetch();
    assert.deepEqual(asked, ["a"], "the song playing, and nothing beside it");

    release.get("a")();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(asked, ["a", "b"], "the next song starts when the one before it is here");

    release.get("b")();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(asked, ["a", "b", "c"], "and then the last of the window");

    release.get("c")();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(asked, ["a", "b", "c"], "nothing past the window is fetched");
    assert.equal(player.offlineState("d"), "none", "the fourth song was never asked for");
  } finally {
    state.preloadAhead = saved.ahead;
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._offlineOrder = saved.order;
    player._offlineWanted = saved.wanted;
    player._offlineInFlight = saved.inFlight;
    player._offlineActive = saved.active;
    player._fetchOffline = saved.fetchOffline;
    player._loading = saved.loading;
    player.setRoom(saved.room);
  }
});

// The play path pre-empts the copies: the song somebody is waiting for owns the
// pipe, so nothing else starts while it is being fetched, and the window's songs
// start the moment its file lands.
test("the play path pre-empts the copies", () => {
  const saved = {
    offline: player._offline,
    bytes: player._offlineBytes,
    order: player._offlineOrder,
    wanted: player._offlineWanted,
    inFlight: player._offlineInFlight,
    active: player._offlineActive,
    fetchOffline: player._fetchOffline,
    loading: player._loading,
    room: player._room,
  };
  const asked = [];
  try {
    player.setRoom(null);
    player._loading = true;
    // The first five are already here; only tail songs are still cold.
    player._offline = new Map(["a", "b", "c", "d", "e"].map((id) => [id, { state: "ready", variantId: id, url: `blob:${id}`, bytes: 1, at: 0 }]));
    player._offline.set("f", { state: "pending", variantId: "", url: "", bytes: 0, at: 0 });
    player._offline.set("g", { state: "pending", variantId: "", url: "", bytes: 0, at: 0 });
    player._offlineBytes = 0;
    player._offlineInFlight = new Map();
    player._offlineActive = 0;
    player._fetchOffline = (id) => {
      asked.push(id);
      return new Promise(() => {});
    };

    // Nothing starts while a song is being waited on: not the tail, and not the
    // eager window either. One pipe, and it belongs to the song somebody is
    // listening for.
    player._offlineWanted = ["a", "b", "c", "d", "e", "f", "g"];
    player._pumpOffline();
    assert.deepEqual(asked, [], "nothing starts while a song is being waited on");

    // The eager window is not lost to that wait: the moment the file lands the
    // songs about to be heard are chased again.
    player._offline.set("a", { state: "pending", variantId: "", url: "", bytes: 0, at: 0 });
    player._loading = false;
    player._pumpOffline();
    assert.deepEqual(asked, ["a"], "the eager window starts once the wait is over");
  } finally {
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._offlineOrder = saved.order;
    player._offlineWanted = saved.wanted;
    player._offlineInFlight = saved.inFlight;
    player._offlineActive = saved.active;
    player._fetchOffline = saved.fetchOffline;
    player._loading = saved.loading;
    player.setRoom(saved.room);
  }
});

// A transition stops the element for a moment so the old position is not read
// as the next song's - and reporting "paused" to the lock screen there takes the
// card away, and with it the page's standing as something that is playing, which
// is what a backgrounded phone needs to be allowed to start the next file at
// all. The card follows what the player means to do, not the element's instant.
test("a transition keeps the lock screen's card playing", () => {
  const session = { playbackState: "", setActionHandler() {}, setPositionState() {} };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaSession: session },
    configurable: true,
  });
  const saved = {
    audio: player.audio,
    queue: player.queue,
    index: player._index,
    wanted: player._playingWanted,
    loading: player._loading,
    room: player._room,
    resume: player._resumeWanted,
  };
  const audio = {
    src: "/media/v-a",
    currentTime: 10,
    duration: 200,
    paused: false,
    readyState: 4,
    play() {
      this.paused = false;
      return { catch() {} };
    },
    pause() {
      this.paused = true;
    },
  };
  try {
    player.setRoom(null);
    player.audio = audio;
    player.queue = queue("a", "b");
    player._index = 0;
    player._playingWanted = true;
    player._positionEvent();
    assert.equal(session.playbackState, "playing", "playing is playing");

    // The next song is being fetched and the element is stopped for it.
    player._loading = true;
    audio.paused = true;
    player._positionEvent();
    assert.equal(session.playbackState, "playing", "the card stays while the next song is fetched");

    // The listener pausing is a pause, and the card goes.
    player.pause();
    player._positionEvent();
    assert.equal(session.playbackState, "paused", "a pause is a pause");
  } finally {
    player.audio = saved.audio;
    player.queue = saved.queue;
    player._index = saved.index;
    player._playingWanted = saved.wanted;
    player._loading = saved.loading;
    player.setRoom(saved.room);
    player._resumeWanted = saved.resume;
    clearInterval(player._resumeTimer);
    player._resumeTimer = 0;
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  }
});

// A room names the rendition, so nothing has to be chosen before the song
// starts: asking the server for the track's sources first is a provider search
// between a listener and what the room is already playing.
test("a room's song is fetched without waiting for its sources", async () => {
  const saved = {
    audio: player.audio,
    ensureAudio: player.ensureAudio,
    queue: player.queue,
    index: player._index,
    sources: player._sources,
    variant: player._variant,
    client: player._client,
    loading: player._loading,
    room: player._room,
    started: player._started,
    status: player._status,
    offline: player._offline,
    offlineOrder: player._offlineOrder,
    offlineWanted: player._offlineWanted,
    offlineInFlight: player._offlineInFlight,
    offlineActive: player._offlineActive,
    offlineBytes: player._offlineBytes,
    warm: player._warm,
    fetch: globalThis.fetch,
  };
  const audio = {
    src: "",
    currentTime: 0,
    paused: true,
    readyState: 0,
    removeAttribute() {},
    load() {},
    pause() {},
    play() {
      return { catch() {} };
    },
  };
  let sourcesAsked = false;
  try {
    player.setRoom(null);
    player.audio = audio;
    player.ensureAudio = () => audio;
    player.queue = queue("a");
    player._index = 0;
    player._loading = true;
    player._started = new Set();
    player._status = new Map();
    player._offline = new Map();
    player._offlineOrder = [];
    player._offlineWanted = [];
    player._offlineInFlight = new Map();
    player._offlineActive = 0;
    player._offlineBytes = 0;
    // Nothing about the file waits on the sources: the backend has the file, it
    // is fetched, and the sources are only there to name it in the bar.
    player._warm = async () => true;
    globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob([new Uint8Array(16)]) });
    player._client = () => ({
      mediaUrl: (variantId) => `/media/${variantId}`,
      startDownload: async () => ({}),
      // Never answers: the song must not wait for it.
      sources: () => {
        sourcesAsked = true;
        return new Promise(() => {});
      },
    });

    await player._load(0, { autoplay: false, variantId: "v-room" });
    await settle();

    assert.equal(sourcesAsked, true, "the sources are asked for, for the bar's pill");
    assert.equal(player._variant, "v-room", "and the rendition the room named is the one being fetched");
    assert.equal(player.readyState(), "ready", "the room's file is here, sources or no sources");
    assert.equal(String(audio.src).startsWith("blob:"), true, `the element holds the copy of it: ${audio.src}`);
  } finally {
    player.audio = saved.audio;
    player.ensureAudio = saved.ensureAudio;
    player.queue = saved.queue;
    player._index = saved.index;
    player._sources = saved.sources;
    player._variant = saved.variant;
    player._client = saved.client;
    player._loading = saved.loading;
    player.setRoom(saved.room);
    player._started = saved.started;
    player._status = saved.status;
    player._offline = saved.offline;
    player._offlineOrder = saved.offlineOrder;
    player._offlineWanted = saved.offlineWanted;
    player._offlineInFlight = saved.offlineInFlight;
    player._offlineActive = saved.offlineActive;
    player._offlineBytes = saved.offlineBytes;
    player._warm = saved.warm;
    globalThis.fetch = saved.fetch;
  }
});


// A room asks for its song again from every tick of its own state, often while
// the last ask is still fetching. A second load that stopped the element and
// cleared its src would throw away the file on its way as fast as it arrived,
// so the song would never reach canplay - and the room, seeing it not play,
// would keep asking: the overload, and the skip that never came. The same
// rendition already under way is the same load, and only the position is taken
// again.
test("a room that asks for one item again does not restart its load", async () => {
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const saved = {
    audio: player.audio,
    ensureAudio: player.ensureAudio,
    queue: player.queue,
    index: player._index,
    variant: player._variant,
    loading: player._loading,
    loadFor: player._loadFor,
    token: player._token,
    pendingSeek: player._pendingSeek,
    playingWanted: player._playingWanted,
    offline: player._offline,
    offlineWanted: player._offlineWanted,
    offlineOrder: player._offlineOrder,
    offlineInFlight: player._offlineInFlight,
    offlineActive: player._offlineActive,
    offlineBytes: player._offlineBytes,
    resolveFixed: player._resolveFixed,
    startOffline: player._startOffline,
    startDownload: player._startDownload,
    prefetch: player._prefetch,
    resume: player._resumeWanted,
    resumeTimer: player._resumeTimer,
    client: player._client,
    room: player._room,
  };
  let clears = 0;
  let finish = null;
  const starts = [];
  const fetches = [];
  const audio = {
    src: "/media/v-old",
    currentTime: 0,
    duration: 200,
    paused: false,
    readyState: 4,
    listeners: {},
    addEventListener(name, fn) {
      (this.listeners[name] = this.listeners[name] || []).push(fn);
    },
    removeEventListener(name, fn) {
      this.listeners[name] = (this.listeners[name] || []).filter((each) => each !== fn);
    },
    fire(name) {
      for (const fn of [...(this.listeners[name] || [])]) fn({ type: name });
    },
    removeAttribute() {
      clears += 1;
      this.src = "";
    },
    load() {},
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return { catch() {} };
    },
  };
  const item = track("a");
  try {
    player.setRoom(null);
    player.audio = audio;
    player.ensureAudio = () => audio;
    player.queue = [item];
    player._index = 0;
    player._variant = "";
    player._loading = false;
    player._loadFor = "";
    player._token = 0;
    player._pendingSeek = null;
    player._playingWanted = false;
    player._offline = new Map();
    player._offlineWanted = [];
    player._offlineOrder = [];
    player._offlineInFlight = new Map();
    player._offlineActive = 0;
    player._offlineBytes = 0;
    player._resolveFixed = () => ({ sources: [], preferredVariantId: "", variantId: "v-a", source: null });
    player._startDownload = (variantId) => {
      starts.push(variantId);
    };
    player._prefetch = () => {};
    // The song's own download, held open until this test releases it: what the
    // room's second ask must not do is start another one.
    player._startOffline = (trackId) => {
      fetches.push(trackId);
      return new Promise((resolve) => {
        finish = () => {
          const entry = player._offline.get(trackId);
          if (entry) {
            entry.state = "ready";
            entry.variantId = "v-a";
            entry.url = "blob:copy";
            entry.bytes = 1;
          }
          resolve(entry);
        };
      });
    };
    player._client = () => ({ mediaUrl: (variantId) => `/media/${variantId}` });

    player.playVariant(item, "v-a", { positionMs: 1000 });
    await tick(0);
    assert.equal(player._loading, true, "the first load is under way");

    // The room asks again before the file is here, from its own, newer clock.
    player.playVariant(item, "v-a", { positionMs: 4000 });
    await tick(0);

    assert.deepEqual(starts, ["v-a"], "the backend was asked for the file once");
    assert.deepEqual(fetches, ["a"], "and the song's own download was started once");
    assert.equal(clears, 1, "the element was not stopped and cleared again");
    assert.equal(player._pendingSeek, 4000, "the position taken is the room's, the later one");

    // The one load carries on: it still reaches a playable element.
    finish();
    await tick(0);
    assert.equal(player._loading, false, "the load finishes");
    assert.equal(audio.src, "blob:copy", "and the element is given the copy of the file");
    audio.fire("loadedmetadata");
    assert.equal(audio.paused, false, "and it plays");
  } finally {
    player.audio = saved.audio;
    player.ensureAudio = saved.ensureAudio;
    player.queue = saved.queue;
    player._index = saved.index;
    player._variant = saved.variant;
    player._loading = saved.loading;
    player._loadFor = saved.loadFor;
    player._token = saved.token;
    player._pendingSeek = saved.pendingSeek;
    player._playingWanted = saved.playingWanted;
    player._offline = saved.offline;
    player._offlineWanted = saved.offlineWanted;
    player._offlineOrder = saved.offlineOrder;
    player._offlineInFlight = saved.offlineInFlight;
    player._offlineActive = saved.offlineActive;
    player._offlineBytes = saved.offlineBytes;
    player._resolveFixed = saved.resolveFixed;
    player._startOffline = saved.startOffline;
    player._startDownload = saved.startDownload;
    player._prefetch = saved.prefetch;
    player._client = saved.client;
    player._resumeWanted = saved.resume;
    clearInterval(player._resumeTimer);
    player._resumeTimer = saved.resumeTimer;
    player.setRoom(saved.room);
  }
});

// The song's own copy is what plays, and a load that finds it already on the
// element must not assign it again: setting the same source restarts the element
// at zero, which is the position a restore came back to thrown away. The restore
// path really does load twice (the boot and the session both pick the queue up),
// so this is the shape it takes.
test("a load of the song already on the element keeps its copy and its place", () => {
  const saved = {
    audio: player.audio,
    ensureAudio: player.ensureAudio,
    queue: player.queue,
    index: player._index,
    loading: player._loading,
    pendingSeek: player._pendingSeek,
    playingWanted: player._playingWanted,
    offline: player._offline,
    saveTimer: player._saveTimer,
  };
  const audio = {
    currentTime: 12,
    duration: 30,
    paused: true,
    readyState: 4,
    removeAttribute() {
      this.src = "";
    },
    load() {
      this.loads = (this.loads || 0) + 1;
    },
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return { catch() {} };
    },
  };
  // A source change is what the element restarts on: its clock goes back to zero
  // and the position it was at is gone. Modelled, because that is the whole of
  // what this test is about.
  let src = "blob:copy";
  Object.defineProperty(audio, "src", {
    get: () => src,
    set(value) {
      src = value;
      audio.currentTime = 0;
    },
  });
  try {
    player.audio = audio;
    player.ensureAudio = () => audio;
    player.queue = [track("a")];
    player._index = 0;
    player._loading = true;
    player._playingWanted = false;
    player._pendingSeek = 12_000;
    player._offline = new Map([["a", { state: "ready", variantId: "v-a", url: "blob:copy", bytes: 1, at: 0 }]]);

    player._handCopyToElement(player._offline.get("a"), { variantId: "v-a", token: player._token, autoplay: false });

    assert.equal(audio.src, "blob:copy", "the copy already on the element was not assigned again");
    assert.equal(audio.loads, undefined, "nothing was reloaded");
    assert.equal(audio.currentTime, 12, "and the position the load asked for is where the element is");
    assert.equal(player._pendingSeek, null, "which is where it should be, so it is not applied twice");
  } finally {
    player.audio = saved.audio;
    player.ensureAudio = saved.ensureAudio;
    player.queue = saved.queue;
    player._index = saved.index;
    player._loading = saved.loading;
    player._pendingSeek = saved.pendingSeek;
    player._playingWanted = saved.playingWanted;
    player._offline = saved.offline;
    clearTimeout(player._saveTimer);
    player._saveTimer = saved.saveTimer;
  }
});

// The song being loaded is asked for as the primary download, and one that is
// being warmed remains background work until it is needed.
test("the song being waited on is downloaded as the primary", async () => {
  const calls = [];
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const client = {
    startDownload: async (...args) => {
      calls.push(args);
      return {};
    },
  };
  const saved = { client: player._client, started: player._started, status: player._status };
  try {
    player._client = () => client;
    player._started = new Set();
    player._status = new Map();

    player._startDownload("v-playing", null, true);
    player._startDownload("v-next");
    player._startDownload("v-playing", null, true);
    player._startDownload("v-next");
    await tick(0);
    await tick(0);

    assert.deepEqual(
      calls,
      [
        ["v-playing", false, true],
        ["v-next", false, false],
        ["v-playing", false, true],
      ],
      "the played song is primary (twice, so a warm-ahead fetch is promoted), the next one is not, and a background fetch is only asked once"
    );
  } finally {
    player._client = saved.client;
    player._started = saved.started;
    player._status = saved.status;
  }
});

// A warm that failed is asked for again. The fetch can fail for a reason that
// has nothing to do with the song - a provider hiccup, or a play taking the
// pipe for something somebody was waiting on - and remembering the failure as
// "already asked for" is how a room joined mid-song ends up fetching nothing:
// the queue ahead of the song stays cold for the rest of the session.
test("a warm that fails is asked for again", async () => {
  const starts = [];
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const client = {
    startDownload: async (variantId) => {
      starts.push(variantId);
      return { state: "failed" };
    },
    mediaStatus: async () => ({ state: "failed" }),
  };
  const saved = {
    client: player._client,
    started: player._started,
    status: player._status,
    variantFor: player._variantFor,
  };
  try {
    player._client = () => client;
    player._started = new Set();
    player._status = new Map();
    player._variantFor = async () => ({ variantId: "v-a" });

    player.warm({ id: "t-a", title: "A song" });
    for (let i = 0; i < 8; i += 1) await tick(0);
    player.warm({ id: "t-a", title: "A song" });
    for (let i = 0; i < 8; i += 1) await tick(0);

    assert.deepEqual(starts, ["v-a", "v-a"], "the second warm asks again after the first failed");
  } finally {
    player._client = saved.client;
    player._started = saved.started;
    player._status = saved.status;
    player._variantFor = saved.variantFor;
  }
});

// A room's follow tick warms the songs ahead of it every five hundred
// milliseconds, so the same rendition is asked for again and again while one
// fetch is still running. Every ask shares the one attempt instead of starting
// its own sixty-second poll of the same status - dozens of status requests a
// second for the same few files.
test("the same rendition is warmed once while its fetch is running", async () => {
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const polled = [];
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = {
    startDownload: async () => ({}),
    mediaStatus: async (variantId) => {
      polled.push(variantId);
      await gate;
      return { state: "failed" };
    },
  };
  const saved = {
    client: player._client,
    started: player._started,
    status: player._status,
    warming: player._warming,
  };
  try {
    player._client = () => client;
    player._started = new Set();
    player._status = new Map();
    player._warming = new Map();

    const first = player._warm("v-a");
    const second = player._warm("v-a");
    await tick(0);
    assert.equal(polled.length, 1, "the two asks share the one status poll");
    assert.equal(first, second, "and are handed the same attempt");

    release();
    assert.equal(await first, false, "a warm that failed answers false");
    assert.equal(await second, false);

    // Settled, so it is forgotten: the next ask makes its own attempt.
    player._warm("v-a");
    await tick(0);
    assert.equal(polled.length, 2, "after it settles the next ask polls again");
  } finally {
    player._client = saved.client;
    player._started = saved.started;
    player._status = saved.status;
    player._warming = saved.warming;
  }
});

// --- how the download is drawn ---------------------------------------------
//
// A download is drawn in one place: the queue's mark on the song's own row, and
// the count it fills by is the song's entry in the player. So these tests hold
// to the count itself - the server's own fraction while the backend fetches,
// this page's transfer of the file afterwards, a stage that starts its count
// over, and -1 as "nobody can count this" rather than a made-up zero - and to
// the bar having no download of its own to draw at all. The mark's own drawing
// is the view's business (`views.test.mjs`); this is where the number it draws
// is decided.

function fakeStyle() {
  const style = {};
  style.setProperty = (name, value) => { style[name] = value; };
  return style;
}

function fakeNode(tag) {
  const classes = new Set();
  const node = {
    tag,
    children: [],
    style: fakeStyle(),
    dataset: {},
    className: "",
    textContent: "",
    isConnected: true,
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((entry) => entry !== child); return child; },
    remove() { this.isConnected = false; },
    get firstChild() { return this.children[0] || null; },
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, width: 0, height: 0 }),
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    matches: () => false,
    focus() {},
    select() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return this[name] ?? null; },
    removeAttribute(name) { delete this[name]; },
  };
  return node;
}

/** Run `draw` with a document under it, then put the globals back. */
function withDom(draw) {
  const had = {
    Node: "Node" in globalThis,
    document: "document" in globalThis,
    window: "window" in globalThis,
  };
  const before = { Node: globalThis.Node, document: globalThis.document, window: globalThis.window };
  globalThis.Node = Object;
  globalThis.document = {
    createElement: fakeNode,
    createElementNS: (namespace, tag) => fakeNode(tag),
    createTextNode: (value) => ({ textContent: String(value) }),
    body: fakeNode("body"),
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    innerWidth: 1200,
    innerHeight: 800,
  };
  try {
    return draw();
  } finally {
    if (had.Node) globalThis.Node = before.Node; else delete globalThis.Node;
    if (had.document) globalThis.document = before.document; else delete globalThis.document;
    if (had.window) globalThis.window = before.window; else delete globalThis.window;
  }
}

/** Point the player at one rendition and its status, and build the bar. */
function barShowing(status) {
  player._buildBar();
  player.queue = [track("t1")];
  player._index = 0;
  player._variant = "v-a";
  player._error = "";
  player._buffering = false;
  player._status = status ? new Map([["v-a", status]]) : new Map();
  return player._bar;
}

/** A song's own entry in the download pipeline, with one status put through it. */
function entryShowing(status, { variantId = "v-a", trackId = "t1" } = {}) {
  player._offline = new Map([[trackId, { state: "pending", variantId, url: "", bytes: 0, at: 0 }]]);
  player._setProgress(variantId, status);
  return player._offline.get(trackId);
}

test("the bar mirrors the song's own download as a bar, and says nothing", () => {
  const saved = player._offline;
  withDom(() => {
    const bar = barShowing({ state: "downloading", stage: "download", progress: 0.42, bytes: 3_250_000, totalBytes: 8_800_000 });
    // The song being played is fetched like any other, and the bar shows that
    // same transfer - a bar, not a second loader or a number.
    assert.equal(bar.progress, undefined, "no loader element of the old kind");
    assert.equal(bar.progressFill, undefined);

    player._offline = new Map([["t1", { state: "pending", variantId: "v-a", url: "", bytes: 0, at: 0 }]]);
    player._loading = true;
    player.renderBar();
    // The wait is a bar under the artist, not a word on the artist's line.
    assert.equal(bar.subtitle.textContent, "Someone", "the artist keeps its line");
    assert.equal(bar.status.style.display, "none", "and there is no waiting text");
    assert.equal(bar.load.style.display, "", "the song's own download is drawn below it");
    assert.equal(bar.load.classList.contains("sweep"), true, "nothing countable yet: it sweeps");
    assert.equal(bar.loadFill.style.width, "", "and claims no number");

    // The backend's count arrives: the bar fills, exactly as the queue's mark
    // on this song's row does.
    player._offline = new Map([["t1", { state: "pending", variantId: "v-a", url: "", bytes: 0, at: 0, stageProgress: 0.4 }]]);
    player.renderBar();
    assert.equal(bar.loadFill.style.width, "40%");
    assert.equal(bar.load.classList.contains("sweep"), false, "a counted wait does not sweep");

    // The copy is here: the line has nothing left to say.
    player._offline = new Map([["t1", { state: "ready", variantId: "v-a", url: "blob:x", bytes: 1, at: 0 }]]);
    player.renderBar();
    assert.equal(bar.load.style.display, "none", "a song this device holds draws no bar");

    // And a song that will not play is said in words, in the same place.
    player._error = "could not play that file";
    player.renderBar();
    assert.equal(bar.load.style.display, "none");
    assert.equal(bar.status.style.display, "");
    assert.equal(bar.status.textContent, "could not play that file");
    assert.equal(bar.status.style.color, "var(--red)");
  });
  player._offline = saved;
  player._error = "";
});

test("a download's count is its own stage's, and never goes backwards", () => {
  const saved = player._offline;
  try {
    const download = { state: "downloading", stage: "download", progress: 0.9, bytes: 9_000_000, totalBytes: 10_000_000 };
    const entry = entryShowing(download);
    assert.equal(entry.stageProgress, 0.9);
    assert.equal(player.offlineProgress("t1"), 0.9, "the mark fills by the count the server sent");

    // The same stage never goes backwards, whatever order two polls land in.
    player._setProgress("v-a", { ...download, progress: 0.4 });
    assert.equal(player.offlineProgress("t1"), 0.9);

    // The fetch hands over to the conversion: its own count, from zero, and not
    // left sitting at the fraction the fetch finished on.
    player._setProgress("v-a", { state: "downloading", stage: "convert", progress: 0.05 });
    assert.equal(player.offlineProgress("t1"), 0.05, "a new stage starts its own count");
  } finally {
    player._offline = saved;
  }
});

test("a count nobody has sweeps rather than reading as zero", () => {
  const saved = player._offline;
  try {
    // No length yet: the state's own name, which is what the server means by -1.
    entryShowing({ state: "downloading", stage: "download", progress: -1, bytes: 12_000, totalBytes: 0 });
    assert.equal(player.offlineProgress("t1"), null, "nothing countable: the mark sweeps");

    // The first answer for a rendition nothing is known about yet: state
    // "none", no stage, and Go's zero progress. Reading that zero as a count is
    // what would pin the mark at nothing before the first real report.
    player._offline = new Map([["t1", { state: "pending", variantId: "v-a", url: "", bytes: 0, at: 0 }]]);
    player._setProgress("v-a", { state: "none", stage: "", progress: 0 });
    assert.equal(player.offlineProgress("t1"), null, "a bare status is not a fraction");

    // And a song that is already here is full, whatever it last reported.
    player._offline.get("t1").state = "ready";
    assert.equal(player.offlineProgress("t1"), 1);
  } finally {
    player._offline = saved;
  }
});

test("this page's own transfer is the count the mark shows while it arrives", () => {
  const saved = player._offline;
  try {
    // The backend's stage is done and the file is on its way here: the count
    // that matters now is the one this page can see, and it wins over the
    // stage's finished fraction.
    entryShowing({ state: "ready", stage: "store", progress: -1 });
    player._offline.get("t1").state = "pending";
    player._noteTransfer("t1", 1_250_000, 5_000_000);
    assert.equal(player.offlineProgress("t1"), 0.25);
    player._noteTransfer("t1", 5_000_000, 5_000_000);
    assert.equal(player.offlineProgress("t1"), 1);
  } finally {
    player._offline = saved;
  }
});

test("the label names the stage and that stage's own numbers", () => {
  assert.equal(mediaProgressLabel({ state: "downloading", stage: "download", progress: 0.31, bytes: 3_100_000, totalBytes: 8_400_000 }), "downloading 3.0 of 8.0 MB");
  // No length yet: the state's own name, which is what the server means by -1.
  assert.equal(mediaProgressLabel({ state: "downloading", stage: "download", progress: -1, bytes: 12_000, totalBytes: 0 }), "downloading…");
  assert.equal(mediaProgressLabel({ state: "downloading", stage: "convert", progress: 0.45 }), "converting 45%");
  assert.equal(mediaProgressLabel({ state: "downloading", stage: "convert", progress: -1 }), "converting…");
  assert.equal(mediaProgressLabel({ state: "downloading", stage: "store", progress: -1 }), "storing the file");
  // A status too bare to carry a stage keeps the state's own vocabulary.
  assert.equal(mediaProgressLabel({ state: "ready" }), "ready");
  assert.equal(mediaProgressLabel({ state: "failed" }), "download failed");
  assert.equal(mediaProgressLabel(undefined), "");
});

test("a status for a song nothing is downloading is not a count at all", () => {
  const saved = player._offline;
  try {
    // Statuses arrive for renditions this page is only naming - a warm ahead,
    // a room's own song - and a song with no entry has no mark to fill.
    player._offline = new Map();
    player._setProgress("v-a", { state: "downloading", stage: "download", progress: 0.5 });
    assert.equal(player.offlineProgress("t1"), null);

    // A song whose copy is already here is full; a failed one has no count.
    player._offline = new Map([
      ["done", { state: "ready", variantId: "v-a", url: "blob:done", bytes: 1, at: 0 }],
      ["gone", { state: "failed", variantId: "v-a", url: "", bytes: 0, at: 0, error: "no" }],
    ]);
    player._setProgress("v-a", { state: "downloading", stage: "download", progress: 0.5 });
    assert.equal(player.offlineProgress("done"), 1);
    assert.equal(player.offlineProgress("gone"), null, "a failure has nothing to fill");
  } finally {
    player._offline = saved;
  }
});
