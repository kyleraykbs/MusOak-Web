// The views' builders actually run.
//
// A name a view forgets to import is not a parse error and not a pure-function
// bug: the module loads, the suite passes, and the view dies the moment somebody
// opens it. Both times that has happened here it was in a builder like these, so
// this calls a few of them against the smallest DOM that will hold them.

import test from "node:test";
import assert from "node:assert/strict";

/** Enough of an element for `h` and the icon helpers. */
class ShimNode {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.listeners = [];
    this.added = [];
    this.classList = {
      add: (name) => this.added.push(name),
      remove: () => {},
      contains: () => false,
    };
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  setAttributeNS(_ns, name, value) { this.attributes[name] = value; }
  appendChild(child) { this.children.push(child); return child; }
  remove() { this.removed = true; }
  addEventListener(name, handler) { this.listeners.push([name, handler]); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  set innerHTML(value) { this._html = value; }
  get innerHTML() { return this._html || ""; }
}

globalThis.Node = ShimNode;
globalThis.document = {
  body: new ShimNode("body"),
  createElement: (tag) => new ShimNode(tag),
  createElementNS: (_ns, tag) => new ShimNode(tag),
  createTextNode: (text) => {
    const node = new ShimNode("#text");
    node.textContent = String(text);
    return node;
  },
};

test("the room's order reads from the song that is on", async () => {
  const queue = await import("../views/queue.js");
  const ids = (list) => list.map((item) => item.id);
  const items = [{ id: "k1" }, { id: "s1" }, { id: "k2" }, { id: "s2" }, { id: "k3" }];

  // The playing item stays in the order, in its place: the rows spell out the
  // alternation the room is following, not the played prefix plus a gap where
  // the playing song went.
  const on = queue.orderFromPlaying(items, "s1");
  assert.equal(on.at, 1);
  assert.deepEqual(ids(on.items), ["s1", "k2", "s2", "k3"]);

  // The playing song is the first of the order: nothing to skip.
  assert.deepEqual(ids(queue.orderFromPlaying(items, "k1").items), ["k1", "s1", "k2", "s2", "k3"]);

  // Not in this list (the room's song is not one of these): the list is what it is.
  assert.equal(queue.orderFromPlaying(items, "elsewhere").at, -1);
  assert.deepEqual(ids(queue.orderFromPlaying(items, "elsewhere").items), ["k1", "s1", "k2", "s2", "k3"]);
  assert.equal(queue.orderFromPlaying(items, "").at, -1);
  assert.deepEqual(queue.orderFromPlaying(null, "k1").items, []);
});

test("the held mark says what this device has, wherever it is drawn", async () => {
  const queue = await import("../views/queue.js");
  const { player } = await import("../player.js");
  const saved = player.offlineState;
  try {
    player.offlineState = (id) =>
      id === "held-1" ? "ready" : id === "pending-1" ? "pending" : "none";

    const kept = queue.heldBadge("held-1");
    assert.equal(kept.className, "held ready", "a copy that is here");
    assert.equal(kept.attributes.title, "In memory, on device");
    assert.equal(kept.attributes["aria-label"], "in memory, on device");

    const coming = queue.heldBadge("pending-1");
    assert.equal(coming.className, "held pending", "a copy on its way");
    assert.equal(coming.attributes.title, "Downloading to this device");

    assert.equal(queue.heldBadge("nothing-1"), null, "nothing worth saying for a song with no copy");
  } finally {
    player.offlineState = saved;
  }
});

test("the queue's grip builds, and a drag can be wired to it", async () => {
  const queue = await import("../views/queue.js");
  const handle = queue.dragHandle("Drag to reorder");
  assert.equal(handle.tagName, "BUTTON");
  assert.match(handle.className, /drag-handle/);
  assert.ok(handle.children.length, "the grip carries an icon");

  const row = document.createElement("div");
  row.dataset.key = "row-1";
  queue.listDrag({ row, handle, entry: { key: "row-1" }, entries: [], onDrop() {} });
  assert.ok(row.added.includes("sortable"), "the row is marked draggable");
  assert.ok(row.added.includes("handled"), "the row knows its gesture lives on the grip");
  // The gesture starts on the grip, not on the row.
  assert.ok(handle.listeners.some(([name]) => name === "pointerdown"));
  assert.equal(row.listeners.filter(([name]) => name === "pointerdown").length, 0);
});

test("a list without a grip still drags by its row", async () => {
  const queue = await import("../views/queue.js");
  const row = document.createElement("div");
  row.dataset.key = "row-1";
  queue.listDrag({ row, entry: { key: "row-1" }, entries: [], onDrop() {} });
  assert.ok(row.listeners.some(([name]) => name === "pointerdown"));
  assert.ok(!row.added.includes("handled"));
});

test("the platform filter builds its button and its panel", async () => {
  const { platformFilter } = await import("../platforms.js");
  const filter = platformFilter({
    providers: [{ name: "ytmusic" }, { name: "youtube" }],
    preferred: ["ytmusic"],
  });
  assert.equal(filter.node.tagName, "BUTTON");
  assert.deepEqual(filter.selected(), ["ytmusic"]);
  // One ticked platform is named rather than counted.
  assert.equal(filter.node.children[0].textContent, "ytmusic");
});

test("every queue row carries the track its menu acts on", async () => {
  const { queueProjection, roomQueueTrack } = await import("../views/queue.js");

  const mine = queueProjection({
    playerQueue: [{ id: "t1", title: "Song", artists: ["Someone"], durationMs: 1000 }],
    currentIndex: 0,
  }).rows;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].track.id, "t1");

  const room = queueProjection({
    room: {
      me: "m1",
      members: [{ id: "m1", displayName: "Someone" }],
      masterQueue: [],
      queues: { m1: [{ id: "i1", trackId: "t2", title: "Room Song", artistIds: ["a1"] }] },
    },
  }).rows;
  assert.equal(room.length, 1);
  assert.equal(room[0].track.id, "t2");
  assert.deepEqual(room[0].track.artistIds, ["a1"]);
  assert.equal(roomQueueTrack({ id: "i2", trackId: "t3" }).id, "t3");
});

test("the module a row's menu comes from loads where the menu is opened", async () => {
  // queue.js imports this one at the moment a menu is opened, because the
  // playlist view imports queue.js: a plain import would be a cycle.
  const { trackMenu } = await import("../views/playlist.js");
  assert.equal(typeof trackMenu, "function");
});

test("the Rooms tab goes where it was left", async () => {
  const { state } = await import("../state.js");
  const { roomsTabTarget } = await import("../rooms-state.js");

  // Nothing remembered and no room to show: the list is the only place to go.
  state.roomsShowing = null;
  assert.equal(roomsTabTarget(), "rooms");

  // Backed out to the list: the tab keeps showing the list even though the room
  // is still being followed - which is the whole point of remembering it.
  state.roomsShowing = "list";
  assert.equal(roomsTabTarget(), "rooms");
  state.roomsShowing = null;
});

test("the uploads search keeps what matches the title, the artists or the file name", async () => {
  const { matchingUploads } = await import("../views/manage.js");
  const uploads = [
    { id: "1", title: "Silver", artists: ["Jesu"] },
    { id: "2", title: "Gold", artists: ["Slowdive"], filename: "track-02.flac" },
    { id: "3", title: "Pity", album: "Silver EP" },
  ];
  const ids = (list) => list.map((upload) => upload.id);

  assert.deepEqual(ids(matchingUploads(uploads, "")), ["1", "2", "3"]);
  assert.deepEqual(ids(matchingUploads(uploads, "silver")), ["1", "3"]);
  assert.deepEqual(ids(matchingUploads(uploads, "SLOWDIVE")), ["2"]);
  assert.deepEqual(ids(matchingUploads(uploads, "track-02")), ["2"]);
  assert.deepEqual(ids(matchingUploads(uploads, "nothing here")), []);
});

test("the plus queues a song and does not let the row's own click through", async () => {
  const { queueButton } = await import("../views/queue.js");
  const { player } = await import("../player.js");

  const saved = { queue: player.queue, index: player._index, prefetch: player._prefetch, play: player.play };
  const plays = [];
  try {
    // A queue already playing, so the add is a plain append: the assertion is
    // about the press, not about the queue starting on its first song.
    player.queue = [{ id: "seed", title: "Seed" }];
    player._index = 0;
    player._prefetch = () => {};
    player.play = (...args) => plays.push(args);

    const button = queueButton({ id: "t1", title: "Song", artists: ["Someone"] });
    assert.equal(button.attributes.title, "Queue");
    assert.equal(button.attributes["aria-label"], "Queue");

    let stopped = 0;
    let prevented = 0;
    button.listeners.find(([name]) => name === "click")[1]({
      stopPropagation: () => { stopped += 1; },
      preventDefault: () => { prevented += 1; },
    });

    assert.deepEqual(player.queue.map((track) => track.id), ["seed", "t1"], "the song is queued");
    assert.deepEqual(plays, [], "and it is not played");
    // The press is swallowed before it reaches the row, which is what keeps a
    // queue from also being a play or a menu.
    assert.equal(stopped, 1);
    assert.equal(prevented, 1);
  } finally {
    player.queue = saved.queue;
    player._index = saved.index;
    player._prefetch = saved.prefetch;
    player.play = saved.play;
  }
});

test("a song's row carries the plus beside its menu, wherever the row is drawn", async () => {
  const { trackRow } = await import("../views/playlist.js");
  const row = trackRow({
    track: { id: "t1", title: "Song", artists: ["Someone"] },
    position: 0,
    client: null,
    onActivate: () => {},
    menu: [],
  });
  const labels = row.children.map((child) => child.attributes?.["aria-label"]).filter(Boolean);
  assert.deepEqual(labels, ["Queue", "More actions"], "the plus sits left of the row's menu");
});

test("in a room the plus queues for the room, not for this device", async () => {
  const { queueButton } = await import("../views/queue.js");
  const { player } = await import("../player.js");
  const { enterRoom, closeRoom } = await import("../rooms-state.js");

  const enqueued = [];
  const client = {
    memberId: "me-1",
    joinRoom: () =>
      Promise.resolve({
        room: { id: "room-1", name: "kitchen", host: "me-1", members: [], memberCount: 1, queues: {}, masterQueue: [] },
        memberId: "me-1",
      }),
    roomSocket: () => ({ send() {}, close() {} }),
    roomEnqueue: (roomId, ids) => {
      enqueued.push({ roomId, ids });
      return Promise.resolve({});
    },
  };
  const saved = player.queue;
  try {
    await enterRoom({ client, roomId: "room-1" });
    player.queue = [{ id: "seed" }];

    queueButton({ id: "t1", title: "Song" }).listeners.find(([name]) => name === "click")[1]({
      stopPropagation() {},
      preventDefault() {},
    });

    assert.deepEqual(enqueued, [{ roomId: "room-1", ids: "t1" }], "the room's own queue takes it");
    assert.deepEqual(player.queue.map((track) => track.id), ["seed"], "the local queue is left alone");
  } finally {
    player.queue = saved;
    closeRoom();
  }
});

test("a server that refuses is a server that answered", async () => {
  // The clock probe throws on a 401, and treating that as "not answering" made
  // every logged-out visitor to a requireLogin deployment see a dead server.
  const { serverAnswered } = await import("../app.js");
  assert.equal(serverAnswered({ status: 401 }), true);
  assert.equal(serverAnswered({ status: 500 }), true);
  assert.equal(serverAnswered({ status: 409 }), true);
  // No status at all is the client's own "cannot reach" error.
  assert.equal(serverAnswered({ status: 0 }), false);
  assert.equal(serverAnswered(new Error("network")), false);
  assert.equal(serverAnswered(undefined), false);
});

// Clicking a playlist in search opens the platform's list: the songs as the
// provider has them, read live, with the import as a button. This is the half
// that used to be a sync behind the click - which imported nothing worth having
// and left "playlist not found" when it then tried to open a library page that
// did not exist yet.
test("a platform playlist lists its songs and imports only when asked", async () => {
  const { playlistTrackRows, importIntoLibrary } = await import("../views/provider-playlist.js");

  const tracks = [
    { providerTrackId: "p1", title: "First", artists: ["Someone"], durationMs: 185000 },
    { providerTrackId: "p2", title: "Second", artists: ["Other"], durationMs: 0 },
  ];
  const rows = playlistTrackRows(null, tracks);
  assert.equal(rows.length, 2, "one row per song the provider lists");
  assert.ok(!String(rows[0].className || "").includes("clickable"), "the rows are not rows you can play: nothing is in the library yet");
  const titles = rows.map(
    (row) => row.children.find((child) => child.className === "grow")?.children?.[0]?.textContent
  );
  assert.deepEqual(titles, ["First", "Second"]);

  const calls = [];
  const client = {
    syncPlaylist: async (id, provider) => {
      calls.push([id, provider]);
      return { playlist: { id: "local-1" }, added: 2 };
    },
  };
  assert.deepEqual(calls, [], "listing the songs imports nothing");
  const imported = await importIntoLibrary(client, { id: "row-1", provider: "ytmusic" });
  assert.deepEqual(calls, [["row-1", "ytmusic"]], "the import asks the server once, with the provider");
  assert.deepEqual(imported, { id: "local-1", added: 2, queued: false }, "and answers with where it landed");

  // A playlist the library has never seen - a pasted link, a platform id - is
  // imported as a job instead: nothing here waits on a provider reading a
  // hundred tracks, and the button must still do something.
  const jobs = [];
  const linking = {
    importPlaylist: async (request) => {
      jobs.push(request);
      return { jobId: "job-1" };
    },
  };
  const byLink = await importIntoLibrary(linking, { providerPlaylistId: "PL123", provider: "ytmusic", title: "A list" });
  assert.deepEqual(jobs, [{ provider: "ytmusic", id: "PL123", name: "A list" }], "the link import starts a job");
  assert.equal(byLink.queued, true, "and says so, rather than pretending it is done");
});
