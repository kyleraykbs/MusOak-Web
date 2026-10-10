// The pure part of the player and the source picker: what the bar says, which
// files stay fetched, what plays next, and how the picker orders and marks its
// rows. Everything here is a function of its arguments — no DOM, no server.

import test from "node:test";
import assert from "node:assert/strict";

import {
  albumLine, artistLine, documentKey, mediaStateLabel, nextIndex, playbackDocument,
  playbackStateFrom, prefetchWindow, queueFromDocument, shouldSavePlayback, shuffleTail, player,
} from "../player.js";
import {
  groupSources, netVotes, pickSource, sourceLabel,
} from "../views/sources.js";
import { enabledPlatforms, forgetPlatforms, platformLabel, platformsFor, selectedPlatforms } from "../platforms.js";

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
async function settle(times = 8) {
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
    player._client = () => ({ mediaUrl: (variantId) => `/media/${variantId}` });
    globalThis.URL.createObjectURL = (blob) => `blob:${blob.size}:${Math.random().toString(36).slice(2)}`;
    globalThis.URL.revokeObjectURL = (url) => revoked.push(url);
    globalThis.fetch = async (url) => {
      fetched.push(String(url));
      return { ok: true, blob: async () => ({ size: 1024 }) };
    };

    player.queue = queue("a", "b", "c");
    player._index = 0;
    player.keepOffline(player.offlineWindow());
    await settle();

    assert.deepEqual(fetched, ["/media/v-a", "/media/v-b", "/media/v-c"]);
    assert.equal(player.offlineState("a"), "ready");
    assert.equal(player.offlineSummary().ready, 3);
    assert.equal(player.offlineSummary().bytes, 3072);

    // The window is what it keeps: a song that leaves it is freed.
    const before = player.offlineSummary().ready;
    player.queue = queue("a");
    player.keepOffline(player.offlineWindow());
    assert.equal(player.offlineState("b"), "none", "a song out of the window is released");
    assert.equal(player.offlineState("c"), "none");
    assert.equal(player.offlineSummary().ready, 1);
    assert.ok(before === 3 && revoked.length === 2, `released ${revoked.length} of 2 copies`);
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
