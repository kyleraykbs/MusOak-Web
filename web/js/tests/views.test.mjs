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
  addEventListener(name, handler) { this.listeners.push([name, handler]); }
  removeEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  set innerHTML(value) { this._html = value; }
  get innerHTML() { return this._html || ""; }
}

globalThis.Node = ShimNode;
globalThis.document = {
  createElement: (tag) => new ShimNode(tag),
  createElementNS: (_ns, tag) => new ShimNode(tag),
  createTextNode: (text) => {
    const node = new ShimNode("#text");
    node.textContent = String(text);
    return node;
  },
};

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
