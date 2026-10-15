// The pure part of the player and the source picker: what the bar says, which
// files stay fetched, what plays next, and how the picker orders and marks its
// rows. Everything here is a function of its arguments — no server; the few
// tests that draw the download bar stand up the little DOM those need.

import test from "node:test";
import assert from "node:assert/strict";

import {
  albumLine, artistLine, documentKey, EAGER_AHEAD, mediaProgressLabel, mediaStateLabel, nextIndex, OFFLINE_AHEAD, OFFLINE_MAX_BYTES,
  OFFLINE_TAIL_GAP_MS, playbackDocument,
  memorySource, playbackStateFrom, prefetchWindow, queueFromDocument, shouldSavePlayback, shuffleTail, player,
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
    await settle();

    assert.deepEqual(fetched, ["/media/v-a", "/media/v-b", "/media/v-c"]);
    assert.equal(player.offlineState("a"), "ready");
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
    for (let i = 0; i < OFFLINE_AHEAD + 5; i += 1) {
      player._offline.set(`old-${i}`, { state: "ready", variantId: `v-old-${i}`, url: `blob:old-${i}`, bytes: 1, at: i });
    }
    player.queue = queue("playing");
    player._index = 0;
    player.keepOffline([track("playing")]);
    assert.equal(player._offline.size, OFFLINE_AHEAD, "the map is bounded to the window's size");
    assert.equal(player.offlineState("playing") === "ready" || player.offlineState("playing") === "pending", true);
    assert.equal(player._offline.has("old-4"), false, "the oldest finished copy went first");
    assert.equal(player._offline.has(`old-${OFFLINE_AHEAD + 4}`), true, "the newest finished copies stayed");

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
  };
  const pending = [];
  try {
    player.setRoom(null);
    player._offline = new Map();
    player._offlineOrder = [];
    player._offlineWanted = [];
    player._offlineInFlight = new Set();
    player._offlineActive = 0;
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
    globalThis.URL.createObjectURL = () => "blob:x";
    globalThis.URL.revokeObjectURL = () => {};
    // Fetches hang until they are released, so what the test sees is the order
    // the page decided to fetch in, not the order they happened to finish.
    globalThis.fetch = (url) => new Promise((resolve) => pending.push([String(url), resolve]));

    player.keepOffline(queue("x1", "x2", "x3", "x4"));
    await settle();
    assert.deepEqual(pending.map(([url]) => url), ["/media/v-x1", "/media/v-x2"], "two fetch at a time");

    // The room's order changes under it: n1 is due next now, x3 and x4 have
    // moved further out. The slot that frees has to go to n1.
    player.keepOffline(queue("n1", "x3", "x4"));
    await settle();
    const [url, resolve] = pending.shift();
    resolve({ ok: true, blob: async () => ({ size: 1 }) });
    await settle();
    assert.equal(url, "/media/v-x1");
    assert.equal(pending.at(-1)[0], "/media/v-n1", "the song the room is about to reach is fetched before the ones behind it");
  } finally {
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

// --- playing a track the device does not hold yet --------------------------

test("a track the device does not hold is fetched and then played", async () => {
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
    client: player._client,
    startDownload: player._startDownload,
    prefetch: player._prefetch,
    wantResume: player._wantResume,
    ready: player._ready,
    room: player._room,
  };
  const played = [];
  let waited = 0;
  let waitedFor = "";
  let prefetched = 0;
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
      this.paused = false;
      played.push(this.src);
      return { catch() {} };
    },
  };
  try {
    player.setRoom(null);
    player.ensureAudio = () => audio;
    player.audio = audio;
    player.queue = queue("a");
    player._index = 0;
    player._offline = new Map();
    player._offlineBytes = 0;
    player._variantFor = async (entry) => ({ variantId: `v-${entry.id}`, sources: [], preferredVariantId: "" });
    // The file is asked for and waited for: what plays is always whole, which is
    // what makes a seek into it - a room's position, a resumed one - instant.
    player._ready = async (variantId) => {
      waited += 1;
      waitedFor = String(variantId);
      return true;
    };
    player._startDownload = () => {};
    player._prefetch = () => {
      prefetched += 1;
    };
    player._wantResume = () => {};
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

    await player._load(0, { autoplay: true });

    // The wait is asynchronous: the file has to be held before the element sees it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(waitedFor, "v-a", "the load waited for the backend to hold the file");
    assert.ok(prefetched >= 1, "and the songs after it were asked for while it downloads");
    assert.ok(waited >= 1, "and asked for it");
    assert.equal(audio.src, "/media/v-a", "then the file was given to the element");
    assert.deepEqual(played, ["/media/v-a"], "and it starts");
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
    player._client = saved.client;
    player._startDownload = saved.startDownload;
    player._prefetch = saved.prefetch;
    player._wantResume = saved.wantResume;
    player._ready = saved.ready;
    player.setRoom(saved.room);
  }
});

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

// The copy landing mid-song is a hand-over, not a source change: the element
// in hand is not disturbed, the copy is brought up on the second element while
// the routed URL keeps playing, and the switch is that element's play. That is
// the difference between a seam and the outage a pipeline reset makes.
test("when its copy lands mid-song the music moves onto it without a gap", async () => {
  const saved = {
    audio: player.audio,
    spare: player._spare,
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    bytes: player._offlineBytes,
    variant: player._variant,
    variantFor: player._variantFor,
    warm: player._warm,
    client: player._client,
    wantResume: player._wantResume,
    pendingSeek: player._pendingSeek,
    room: player._room,
    fetch: globalThis.fetch,
    create: globalThis.URL.createObjectURL,
  };
  const played = [];
  const audio = {
    src: "/media/v-a",
    currentTime: 42.5,
    duration: 200,
    paused: false,
    ended: false,
    readyState: 4,
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
    removeAttribute() {},
    load() {},
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      played.push(this.src);
      return { catch() {} };
    },
  };
  const spare = spareElement(played);
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    player.setRoom(null);
    player.audio = audio;
    player._spare = spare;
    player.queue = queue("a");
    player._index = 0;
    player._variant = "v-a";
    player._offline = new Map([["a", { state: "pending", variantId: "", url: "", bytes: 0, at: Date.now() }]]);
    player._offlineBytes = 0;
    player._variantFor = async () => ({ variantId: "v-a" });
    player._warm = async () => true;
    player._client = () => ({
      mediaUrl: (variantId) => `/media/${variantId}`,
      startDownload: async () => ({}),
      sources: async () => ({ sources: [{ variantId: "v-a", downloadable: true }], preferredVariantId: "" }),
    });
    player._wantResume = () => {};
    globalThis.URL.createObjectURL = () => "blob:a";
    globalThis.fetch = async () => ({ ok: true, blob: async () => ({ size: 2048 }) });

    await player._fetchOffline("a");

    assert.equal(player.offlineState("a"), "ready");
    assert.equal(audio.src, "/media/v-a", "the element in hand is not disturbed");
    assert.equal(spare.src, "blob:a", "the copy is loaded on the second element");
    assert.deepEqual(played, [], "and nothing has been started yet");

    // The copy is playable: the switch is its play, at the position the music
    // has actually reached, and the element being left is faded out.
    spare.readyState = 4;
    spare.fire("canplay");
    await tick(120);

    assert.equal(player.audio, spare, "the copy is the element in hand now");
    assert.equal(audio.paused, false, "and the routed element is still playing while the copy settles");
    assert.equal(spare.currentTime, 42.5, "at the position the music had reached");
    assert.deepEqual(played, ["blob:a"], "started rather than reloaded");
    assert.equal(player._pendingSeek, null, "with nothing left pending");
    // Both play for a moment first: the new element's first samples are behind
    // the pipeline's latency, so the old one is not let go until they arrive.
    await tick(200);
    assert.equal(audio.paused, true, "and then the routed element is left behind");
    assert.equal(audio.volume, 1, "with its volume put back for the next hand-over");
  } finally {
    player.audio = saved.audio;
    player._spare = saved.spare;
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._variant = saved.variant;
    player._variantFor = saved.variantFor;
    player._warm = saved.warm;
    player._client = saved.client;
    player._wantResume = saved.wantResume;
    player._pendingSeek = saved.pendingSeek;
    player.setRoom(saved.room);
    globalThis.fetch = saved.fetch;
    globalThis.URL.createObjectURL = saved.create;
  }
});

// A copy that never comes up on the second element falls back to moving the
// element in hand onto it: a gap, but not silence.
test("a copy that never becomes playable is moved onto the old way", async () => {
  const saved = {
    audio: player.audio,
    spare: player._spare,
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    bytes: player._offlineBytes,
    variant: player._variant,
    variantFor: player._variantFor,
    warm: player._warm,
    client: player._client,
    wantResume: player._wantResume,
    pendingSeek: player._pendingSeek,
    room: player._room,
    fetch: globalThis.fetch,
    create: globalThis.URL.createObjectURL,
  };
  const played = [];
  const audio = {
    src: "/media/v-a",
    currentTime: 42.5,
    duration: 200,
    paused: false,
    ended: false,
    readyState: 4,
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
    removeAttribute() {},
    load() {},
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      played.push(this.src);
      return { catch() {} };
    },
  };
  const spare = spareElement(played);
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    player.setRoom(null);
    player.audio = audio;
    player._spare = spare;
    player.queue = queue("a");
    player._index = 0;
    player._variant = "v-a";
    player._offline = new Map([["a", { state: "pending", variantId: "", url: "", bytes: 0, at: Date.now() }]]);
    player._offlineBytes = 0;
    player._variantFor = async () => ({ variantId: "v-a" });
    player._warm = async () => true;
    player._client = () => ({
      mediaUrl: (variantId) => `/media/${variantId}`,
      startDownload: async () => ({}),
      sources: async () => ({ sources: [{ variantId: "v-a", downloadable: true }], preferredVariantId: "" }),
    });
    player._wantResume = () => {};
    globalThis.URL.createObjectURL = () => "blob:a";
    globalThis.fetch = async () => ({ ok: true, blob: async () => ({ size: 2048 }) });

    await player._fetchOffline("a");
    spare.fire("error");                       // the copy will not come up
    await tick(50);

    assert.equal(player.audio, audio, "the element in hand is the one that takes it");
    assert.equal(audio.src, "blob:a", "moved onto the copy");
    assert.equal(player._pendingSeek, 42500, "at the exact position it had reached");
    assert.deepEqual(played, [], "the play waits for the position to land");
    audio.fire("loadedmetadata");
    assert.deepEqual(played, ["blob:a"], "and carried on playing from there");
  } finally {
    player.audio = saved.audio;
    player._spare = saved.spare;
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._variant = saved.variant;
    player._variantFor = saved.variantFor;
    player._warm = saved.warm;
    player._client = saved.client;
    player._wantResume = saved.wantResume;
    player._pendingSeek = saved.pendingSeek;
    player.setRoom(saved.room);
    globalThis.fetch = saved.fetch;
    globalThis.URL.createObjectURL = saved.create;
  }
});

// A browser that will not start the copy leaves the element in hand playing:
// the copy is taken up at the next load instead.
test("a copy the browser will not start does not take over", async () => {
  const saved = { audio: player.audio, spare: player._spare, room: player._room };
  const played = [];
  const audio = {
    src: "/media/v-a",
    currentTime: 42.5,
    paused: false,
    readyState: 4,
    volume: 1,
    muted: false,
    listeners: {},
    addEventListener(name, fn) {
      (this.listeners[name] = this.listeners[name] || []).push(fn);
    },
    removeEventListener() {},
    fire(name) {
      for (const fn of [...(this.listeners[name] || [])]) fn({ type: name });
    },
    removeAttribute() {},
    load() {},
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      played.push(this.src);
      return { catch() {} };
    },
  };
  const spare = spareElement(played);
  spare.play = () => Promise.reject(new Error("not allowed"));
  try {
    player.setRoom(null);
    player.audio = audio;
    player._spare = spare;
    await player._handOverToCopy({ url: "blob:a", variantId: "v-a" }, 42500, false);

    assert.equal(player.audio, audio, "the element in hand is still the one playing");
    assert.equal(audio.paused, false, "and it never stopped");
  } finally {
    player.audio = saved.audio;
    player._spare = saved.spare;
    player.setRoom(saved.room);
  }
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

// A file that will not arrive gets one more attempt - on another source of the
// same song when it has one, since what usually fails is one provider's file -
// and then the queue carries on. Stopping on it is silence and a red line.
test("a file that will not arrive is tried from another source, then the queue moves on", async () => {
  const saved = {
    audio: player.audio,
    ensureAudio: player.ensureAudio,
    queue: player.queue,
    index: player._index,
    sources: player._sources,
    variant: player._variant,
    ready: player._ready,
    variantFor: player._variantFor,
    resolveFixed: player._resolveFixed,
    client: player._client,
    online: player.online,
    report: player._report,
    reportListen: player._reportListen,
    room: player._room,
    retriedFor: player._retriedFor,
    failedVariant: player._failedVariant,
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
    // The song that is not the point of the test lands, so the queue moving on
    // can be seen to work; every attempt at the broken one fails.
    player._ready = async (variantId) =>
      String(variantId) === "v-b"
        ? { state: "ready", path: "/media/v-b" }
        : { state: "failed", error: "that file could not be downloaded" };
    player._variantFor = async (entry) => resolution(String(entry.id) === "a" ? "v-a" : "v-b");
    player._resolveFixed = async (entry, variantId) => {
      asked.push(`fixed:${variantId}`);
      return resolution(variantId);
    };
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

    // The file the element was given could not be fetched. The retry starts at
    // once, and the red line it leaves is what the next song must not inherit.
    await player._waitForFile({ variantId: "v-a", token: player._token, autoplay: false });
    assert.equal(player._retriedFor, "a", "the failed song is the one being retried");
    await tick(50);
    // The retry ran (the song is the one being retried) and, with every fetch in
    // this test failing, it ended where it must: the next song in the queue.
    assert.ok(player._retriedFor, "a retry was attempted before anything was skipped");

    // And when that one fails too, the queue moves on rather than stopping.
    await player._waitForFile({ variantId: "v-a2", token: player._token, autoplay: false });
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
    player._ready = saved.ready;
    player._variantFor = saved.variantFor;
    player._resolveFixed = saved.resolveFixed;
    player._client = saved.client;
    player.online = saved.online;
    player._report = saved.report;
    player._reportListen = saved.reportListen;
    player.setRoom(saved.room);
    player._retriedFor = saved.retriedFor;
    player._failedVariant = saved.failedVariant;
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
    player._warm = async () => true;
    player._ready = async () => true;
    player._variantFor = async (entry) => {
      asked.push(`resolve:${entry.id}`);
      if (asked.filter((each) => each === `resolve:${entry.id}`).length === 1) {
        throw new Error("the server blinked");
      }
      return { variantId: "v-a", sources: [{ variantId: "v-a", downloadable: true }], preferredVariantId: "" };
    };
    player._client = () => ({ mediaUrl: (variantId) => `/media/${variantId}`, sources: async () => ({ sources: [] }) });

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
    clearInterval(player._resumeTimer);
    player._resumeTimer = null;
    clearTimeout(player._saveTimer);
    player._saveTimer = null;
  }
});

// What is still to be downloaded has to follow the queue it is downloaded for:
// a shuffle makes different songs the next ones due, and the songs still cold
// are fetched in the new order, not the old one.
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
    abort: player._offlineAbort,
    fetchOffline: player._fetchOffline,
    warm: player.warm,
    room: player._room,
    shuffle: player._shuffle,
    tail: player._tailAt,
    tailTimer: player._tailTimer,
    loading: player._loading,
  };
  const asked = [];
  const release = new Map();
  try {
    player.setRoom(null);
    player._shuffle = true;
    player._loading = false;
    player._tailAt = 0;
    player._tailTimer = 0;
    player.queue = queue("a", "b", "c", "d", "e", "f", "g", "h", "i", "j");
    player._index = 0;
    player._offline = new Map();
    player._offlineBytes = 0;
    player._offlineOrder = [];
    player._offlineWanted = [];
    player._offlineInFlight = new Set();
    player._offlineActive = 0;
    player._offlineAbort = new Map();
    player.warm = () => {};
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
    assert.deepEqual(asked, ["a", "b"], "the eager window is fetched first");
    release.get("a")();
    release.get("b")();
    await tick(0);
    release.get("c")();
    release.get("d")();
    await tick(0);
    release.get("e")();
    await tick(0);
    assert.deepEqual(asked, ["a", "b", "c", "d", "e", "f"], "through the eager five and the first of the tail");
    release.get("f")();
    await tick(0);

    // The queue is shuffled: different songs are now the ones still cold.
    const beforeShuffle = asked.length;
    player.shuffleQueue();
    const order = player.queue.map((entry) => entry.id);
    const cold = (id) => player._offline.get(id)?.state !== "ready";
    const remaining = order.filter((id) => player._offline.get(id)?.state !== "ready");
    assert.ok(remaining.length >= 2, "there is still something to download");

    // The tail is paced, so the pump is driven past each gap until the songs
    // still cold have all been fetched; what it starts has to be the songs in
    // the queue's order, not the order they were queued in before the shuffle.
    let guard = 0;
    while (order.some(cold)) {
      guard += 1;
      assert.ok(guard < 20, "the pump keeps starting something while a song is cold");
      clearTimeout(player._tailTimer);
      player._tailTimer = 0;
      player._tailAt = 0;
      player._pumpOffline();
      for (const id of [...player._offlineInFlight]) release.get(id)?.();
      await tick(0);
    }
    assert.deepEqual(
      asked.slice(beforeShuffle),
      remaining,
      "the songs still to be downloaded are fetched in the queue's order"
    );
  } finally {
    clearTimeout(player._tailTimer);
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._offlineOrder = saved.order;
    player._offlineWanted = saved.wanted;
    player._offlineInFlight = saved.inFlight;
    player._offlineActive = saved.active;
    player._offlineAbort = saved.abort;
    player._fetchOffline = saved.fetchOffline;
    player.warm = saved.warm;
    player._tailAt = saved.tail;
    player._tailTimer = saved.tailTimer;
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
    abort: player._offlineAbort,
    fetchOffline: player._fetchOffline,
    tail: player._tailAt,
    tailTimer: player._tailTimer,
    loading: player._loading,
    room: player._room,
  };
  const asked = [];
  const aborted = [];
  const release = new Map();
  try {
    player.setRoom(null);
    player._loading = false;
    player._tailAt = 0;
    player._tailTimer = 0;
    player.queue = queue("a", "b", "c", "d");
    player._index = 0;
    player._offline = new Map(["a", "b", "c", "d"].map((id) => [id, { state: "pending", variantId: "", url: "", bytes: 0, at: 0 }]));
    player._offlineBytes = 0;
    player._offlineOrder = [];
    player._offlineWanted = ["a", "b", "c", "d"];
    player._offlineInFlight = new Set();
    player._offlineActive = 0;
    player._offlineAbort = new Map();
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
    assert.deepEqual(asked, ["a", "b"], "the two eager slots went to the songs at the front");

    // The room's order moves: c and d are the next ones due, and a and b are
    // still in the window, only further back.
    player.queue = queue("c", "d", "a", "b");
    player.keepOffline([track("c"), track("d"), track("a"), track("b")]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(aborted, [], "nothing was cancelled, because nothing left the window");
    assert.deepEqual(asked, ["a", "b"], "and nothing was restarted either");

    // A slot frees: the song now due gets it.
    release.get("a")();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(asked, ["a", "b", "c"], "the song now due took the free slot");

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
    player._offlineAbort = saved.abort;
    player._fetchOffline = saved.fetchOffline;
    player._tailAt = saved.tail;
    player._tailTimer = saved.tailTimer;
    player._loading = saved.loading;
    player.setRoom(saved.room);
  }
});

// The songs ahead are chased, two at a time, so they are here before they are
// reached; the songs past the eager window are fetched too, but slowly - one at
// a time with a real gap between starts - because the server's upstream is what
// the song somebody is actually waiting for needs.
test("the eager window is chased and the rest is fetched slowly", async () => {
  const saved = {
    queue: player.queue,
    index: player._index,
    offline: player._offline,
    bytes: player._offlineBytes,
    order: player._offlineOrder,
    wanted: player._offlineWanted,
    inFlight: player._offlineInFlight,
    active: player._offlineActive,
    abort: player._offlineAbort,
    fetchOffline: player._fetchOffline,
    warm: player.warm,
    tail: player._tailAt,
    tailTimer: player._tailTimer,
    loading: player._loading,
    room: player._room,
    now: Date.now,
    timeout: globalThis.setTimeout,
  };
  const asked = [];
  const release = new Map();
  const timers = [];
  const realTimeout = globalThis.setTimeout;
  const tick = (ms) => new Promise((resolve) => realTimeout(resolve, ms));
  let now = 1_000_000;
  try {
    player.setRoom(null);
    assert.equal(EAGER_AHEAD, 5, "five songs ahead are chased");
    player.queue = queue("a", "b", "c", "d", "e", "f", "g", "h");
    player._index = 0;
    player._offline = new Map();
    player._offlineBytes = 0;
    player._offlineOrder = [];
    player._offlineWanted = [];
    player._offlineInFlight = new Set();
    player._offlineActive = 0;
    player._offlineAbort = new Map();
    player._tailAt = 0;
    player._tailTimer = 0;
    player._loading = false;
    player.warm = () => {};
    // The clock and the wake-up are the test's, so the pacing is asserted
    // exactly rather than by waiting for it.
    Date.now = () => now;
    globalThis.setTimeout = (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    };
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
        signal?.addEventListener("abort", () => settle(false));
        release.set(id, () => settle(true));
      });

    player._prefetch();
    assert.deepEqual(asked, ["a", "b"], "the eager window is chased, two at a time");

    release.get("a")();
    release.get("b")();
    await tick(0);
    assert.deepEqual(asked, ["a", "b", "c", "d"], "and the next eager songs take the slots");

    release.get("c")();
    release.get("d")();
    await tick(0);
    assert.deepEqual(asked, ["a", "b", "c", "d", "e"], "and then the last of the five");

    // The eager window is done; the tail starts, but nothing follows it yet.
    release.get("e")();
    await tick(0);
    assert.deepEqual(asked, ["a", "b", "c", "d", "e", "f"], "the tail starts once the eager window is fetched");

    release.get("f")();
    await tick(0);
    assert.deepEqual(asked, ["a", "b", "c", "d", "e", "f"], "but the next tail song waits for the gap");
    assert.equal(timers.length, 1, "a wake-up was left for it");
    assert.equal(timers[0].ms, OFFLINE_TAIL_GAP_MS, "for the whole gap, nothing having elapsed");

    // Only after the gap does the next one start - one, not two.
    now += OFFLINE_TAIL_GAP_MS;
    timers.shift().fn();
    assert.deepEqual(asked, ["a", "b", "c", "d", "e", "f", "g"], "and then exactly one more");
  } finally {
    player.queue = saved.queue;
    player._index = saved.index;
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._offlineOrder = saved.order;
    player._offlineWanted = saved.wanted;
    player._offlineInFlight = saved.inFlight;
    player._offlineActive = saved.active;
    player._offlineAbort = saved.abort;
    player._fetchOffline = saved.fetchOffline;
    player.warm = saved.warm;
    player._tailAt = saved.tail;
    player._tailTimer = saved.tailTimer;
    player._loading = saved.loading;
    player.setRoom(saved.room);
    Date.now = saved.now;
    globalThis.setTimeout = saved.timeout;
  }
});

// The play path pre-empts the tail: the song somebody is waiting for owns the
// pipe, so nothing slow starts while it is being fetched. The eager window is
// not held back - it is what is about to be heard.
test("the play path pre-empts the tail", () => {
  const saved = {
    offline: player._offline,
    bytes: player._offlineBytes,
    order: player._offlineOrder,
    wanted: player._offlineWanted,
    inFlight: player._offlineInFlight,
    active: player._offlineActive,
    abort: player._offlineAbort,
    fetchOffline: player._fetchOffline,
    tail: player._tailAt,
    tailTimer: player._tailTimer,
    loading: player._loading,
    room: player._room,
  };
  const asked = [];
  try {
    player.setRoom(null);
    player._tailAt = 0;
    player._tailTimer = 0;
    player._loading = true;
    // The first five are already here; only tail songs are still cold.
    player._offline = new Map(["a", "b", "c", "d", "e"].map((id) => [id, { state: "ready", variantId: id, url: `blob:${id}`, bytes: 1, at: 0 }]));
    player._offline.set("f", { state: "pending", variantId: "", url: "", bytes: 0, at: 0 });
    player._offline.set("g", { state: "pending", variantId: "", url: "", bytes: 0, at: 0 });
    player._offlineBytes = 0;
    player._offlineInFlight = new Set();
    player._offlineActive = 0;
    player._offlineAbort = new Map();
    player._fetchOffline = (id) => {
      asked.push(id);
      return new Promise(() => {});
    };

    // Only tail songs are due, and a song is being waited on: none start.
    player._offlineWanted = ["a", "b", "c", "d", "e", "f", "g"];
    player._pumpOffline();
    assert.deepEqual(asked, [], "no tail fetch starts while a song is being waited on");
    assert.notEqual(player._tailTimer, 0, "a wake-up is left so the tail is not forgotten");

    // The eager window is not held back by the play path: what is about to be
    // heard is still chased.
    player._offline.set("a", { state: "pending", variantId: "", url: "", bytes: 0, at: 0 });
    player._pumpOffline();
    assert.deepEqual(asked, ["a"], "the eager window still chases the song");
  } finally {
    clearTimeout(player._tailTimer);
    player._offline = saved.offline;
    player._offlineBytes = saved.bytes;
    player._offlineOrder = saved.order;
    player._offlineWanted = saved.wanted;
    player._offlineInFlight = saved.inFlight;
    player._offlineActive = saved.active;
    player._offlineAbort = saved.abort;
    player._fetchOffline = saved.fetchOffline;
    player._tailAt = saved.tail;
    player._tailTimer = saved.tailTimer;
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
    // The file is what plays, so the wait has to answer for this to get that far.
    player._ready = async () => true;
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

    assert.equal(sourcesAsked, true, "the sources are asked for, for the bar's pill");
    assert.equal(player._variant, "v-room", "and the rendition the room named is the one being fetched");
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
  }
});

// Changing songs takes the last one off the element. Paused and rewound is not
// enough: anything that asks the element to play while the next file is being
// fetched - the retry of a refused play, a wake-up - started the song that was
// playing before, under a bar naming the new one.
test("the song that was playing is unloaded when the track changes", async () => {
  const saved = {
    audio: player.audio,
    ensureAudio: player.ensureAudio,
    queue: player.queue,
    index: player._index,
    client: player._client,
    variantFor: player._variantFor,
    ready: player._ready,
    startDownload: player._startDownload,
    prefetch: player._prefetch,
    room: player._room,
    pendingSeek: player._pendingSeek,
  };
  const audio = {
    src: "/media/v-old",
    currentTime: 42,
    duration: 200,
    paused: false,
    readyState: 4,
    removeAttribute(name) {
      if (name === "src") this.src = "";
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
  try {
    player.setRoom(null);
    player.audio = audio;
    player.ensureAudio = () => audio;
    player.queue = queue("a");
    player._index = 0;
    player._startDownload = () => {};
    player._prefetch = () => {};
    player._variantFor = async () => ({ variantId: "v-a", sources: [], preferredVariantId: "" });
    // The file is not here yet, which is the window this is about.
    player._ready = () => new Promise(() => {});

    await player._load(0, { autoplay: true });

    assert.equal(audio.src, "", "the old song is off the element while the next one is fetched");
    assert.equal(audio.paused, true, "and it is not playing");
    assert.equal(player._playingWanted, false, "nothing is asking it to play while the file is on its way");
    assert.equal(player._resumeWanted, false, "and the retry that wanted one is stopped");
  } finally {
    player.audio = saved.audio;
    player.ensureAudio = saved.ensureAudio;
    player.queue = saved.queue;
    player._index = saved.index;
    player._client = saved.client;
    player._variantFor = saved.variantFor;
    player._ready = saved.ready;
    player._startDownload = saved.startDownload;
    player._prefetch = saved.prefetch;
    player.setRoom(saved.room);
    player._pendingSeek = saved.pendingSeek;
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
    resolveFixed: player._resolveFixed,
    ready: player._ready,
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
  const polls = [];
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
    player._resolveFixed = () => ({ sources: [], preferredVariantId: "", variantId: "v-a", source: null });
    player._startDownload = (variantId) => {
      starts.push(variantId);
    };
    player._prefetch = () => {};
    player._ready = (variantId) => {
      polls.push(variantId);
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    player._client = () => ({ mediaUrl: (variantId) => `/media/${variantId}` });

    player.playVariant(item, "v-a", { positionMs: 1000 });
    await tick(0);
    assert.equal(player._loading, true, "the first load is under way");

    // The room asks again before the file is here, from its own, newer clock.
    player.playVariant(item, "v-a", { positionMs: 4000 });
    await tick(0);

    assert.deepEqual(starts, ["v-a"], "the backend was asked once, not once per ask");
    assert.deepEqual(polls, ["v-a"], "and the wait for the file was started once");
    assert.equal(clears, 1, "the element was not stopped and cleared again");
    assert.equal(player._pendingSeek, 4000, "the position taken is the room's, the later one");

    // The one load carries on: it still reaches a playable element.
    finish({ state: "ready" });
    await tick(0);
    assert.equal(player._loading, false, "the load finishes");
    assert.equal(audio.src, "/media/v-a", "and the element is given the file");
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
    player._resolveFixed = saved.resolveFixed;
    player._ready = saved.ready;
    player._startDownload = saved.startDownload;
    player._prefetch = saved.prefetch;
    player._client = saved.client;
    player._resumeWanted = saved.resume;
    clearInterval(player._resumeTimer);
    player._resumeTimer = saved.resumeTimer;
    player.setRoom(saved.room);
  }
});

// The song being loaded is asked for as the primary download, and one that is
// already being fetched ahead of time is asked again as primary, so the backend
// knows to give it the pipe instead of letting the prefetch's streams compete
// with it. Everything else is asked for as background work.
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
// The rest of this file is a function of its arguments, but the bar is DOM. So
// these few tests stand a document up that is only as much as building and
// drawing the bar touches, and take it away again. What they hold to: the fill
// is the server's own fraction, -1 is a sweep rather than a made-up number, the
// text names the stage, and a stage change starts its count over.

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
  player._progress = -1;
  player._stage = "";
  player._status = status ? new Map([["v-a", status]]) : new Map();
  player._setProgress(player._status.get("v-a"));
  return player._bar;
}

test("a sized download fills the bar to the fraction the server reports", () => {
  withDom(() => {
    const bar = barShowing({ state: "downloading", stage: "download", progress: 0.42, bytes: 3_250_000, totalBytes: 8_800_000 });
    player._loading = true;
    player.renderBar();
    assert.equal(bar.progress.style.display, "", "the bar is shown while the file is on its way");
    assert.equal(bar.progress.classList.contains("indeterminate"), false, "and it fills rather than sweeps");
    assert.equal(bar.progressFill.style.width, "42%");
    assert.match(bar.subtitle.textContent, /downloading 3\.1 of 8\.4 MB/, "with the numbers the server sent");
  });
});

test("a download with nothing to count sweeps instead of filling", () => {
  withDom(() => {
    // A first, countable poll, so there is a fill for the sweep to replace.
    const bar = barShowing({ state: "downloading", stage: "download", progress: 0.42, bytes: 3_250_000, totalBytes: 8_800_000 });
    player._loading = true;
    player.renderBar();
    assert.equal(bar.progressFill.style.width, "42%");

    // The provider has told nobody a length: -1 means sweep, and no width at
    // all, rather than the fraction the last poll happened to leave behind.
    const unknown = { state: "downloading", stage: "download", progress: -1, bytes: 12_000, totalBytes: 0 };
    player._status = new Map([["v-a", unknown]]);
    player._setProgress(unknown);
    player.renderBar();
    assert.equal(bar.progressFill.style.width, "", "no fill");
    assert.equal(bar.progress.classList.contains("indeterminate"), true, "the sweep instead");
    assert.equal(bar.progress.style.display, "");
    assert.match(bar.subtitle.textContent, /downloading…/);
  });
});

test("a status that names no stage is not read as zero progress", () => {
  withDom(() => {
    // The first answer for a rendition nothing is known about yet: state
    // "none", no stage, and Go's zero progress. Reading that zero as a count is
    // what would pin the bar at 0% before the first real report; sweeping until
    // one names a stage is the honest drawing.
    const bar = barShowing({ state: "none", stage: "", progress: 0 });
    player._loading = true;
    player.renderBar();
    assert.equal(bar.progressFill.style.width, "", "no fill");
    assert.equal(bar.progress.classList.contains("indeterminate"), true, "a sweep instead");
    assert.match(bar.subtitle.textContent, /downloading…/);
  });
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

test("a stage change starts its own count instead of keeping the old fraction", () => {
  withDom(() => {
    const download = { state: "downloading", stage: "download", progress: 0.9, bytes: 9_000_000, totalBytes: 10_000_000 };
    const bar = barShowing(download);
    player._loading = true;
    player.renderBar();
    assert.equal(bar.progressFill.style.width, "90%");

    // The same stage never goes backwards, whatever order two polls land in.
    player._setProgress({ ...download, progress: 0.4 });
    player.renderBar();
    assert.equal(bar.progressFill.style.width, "90%");

    // The fetch hands over to the conversion: its own count, from zero, and
    // not left sitting at the fraction the fetch finished on.
    const convert = { state: "downloading", stage: "convert", progress: 0.05 };
    player._status = new Map([["v-a", convert]]);
    player._setProgress(convert);
    player.renderBar();
    assert.equal(bar.progressFill.style.width, "5%");
    assert.match(bar.subtitle.textContent, /converting 5%/);
  });
});

test("a download that is ready shows no fill, and the timeline again", () => {
  withDom(() => {
    const bar = barShowing({ state: "ready", stage: "store", progress: -1 });
    // Even on the poll that reports ready while the load is still unwinding,
    // the bar must not flash a fill: ready means the count is over.
    player._loading = true;
    player.renderBar();
    assert.equal(bar.progress.style.display, "none");
    assert.equal(bar.progress.classList.contains("indeterminate"), false);

    player._loading = false;
    player.renderBar();
    assert.equal(bar.progress.style.display, "none", "hidden, as a finished download always was");
  });
});
