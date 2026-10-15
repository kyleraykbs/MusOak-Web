// scheduleFrame's contract: at most one run per burst, the frame path when
// frames exist, and the timer fallback when they never come - the case that
// used to freeze a room page at the numbers from its first paint.
import test from "node:test";
import assert from "node:assert/strict";

// The module reads `document` and `requestAnimationFrame` off wherever it
// runs, so both are provided here: Node has neither. The nodes are also enough
// of a DOM for a popover: it needs somewhere to append to, a box to measure and
// a way to be removed.
const created = [];

function fakeNode(tag) {
  const node = {
    tag,
    children: [],
    style: {},
    dataset: {},
    className: "",
    textContent: "",
    isConnected: true,
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    insertBefore(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
      return child;
    },
    remove() {
      this.isConnected = false;
    },
    get firstChild() {
      return this.children[0] || null;
    },
    get childElementCount() {
      return this.children.length;
    },
    getBoundingClientRect: () => ({ top: 100, bottom: 130, left: 40, width: 160, height: 300 }),
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    select() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  };
  created.push(node);
  return node;
}

// dom.js tells a child node from a string with `instanceof Node`; Node has no
// global here, and the fake nodes are plain objects.
globalThis.Node = Object;

const matches = (selector) => created.filter((node) => node.isConnected && node.className.includes(selector.slice(1)));

globalThis.document = {
  createElement: fakeNode,
  createTextNode(value) {
    return { text: value };
  },
  body: fakeNode("body"),
  documentElement: fakeNode("html"),
  querySelector: (selector) => matches(selector)[0] || null,
  querySelectorAll: matches,
  addEventListener() {},
  removeEventListener() {},
  visibilityState: "visible",
};

globalThis.window = {
  innerWidth: 1200,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  visualViewport: null,
};

let frames = [];
globalThis.requestAnimationFrame = (callback) => {
  frames.push(callback);
  return frames.length;
};

const { scheduleFrame, popover } = await import("../dom.js");

/** Lets a frame callback resolve first, as a real compositor would. */
async function flushFrames() {
  const pending = frames.splice(0);
  await Promise.resolve();
  for (const callback of pending) callback();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(ms = 300) {
  await new Promise((resolve) => setTimeout(resolve, ms + 20));
}

test("a visible page paints on the frame, not after the fallback delay", async () => {
  const runs = [];
  const paint = scheduleFrame(() => runs.push("paint"));

  paint();
  await flushFrames();
  assert.deepEqual(runs, ["paint"]);

  paint();
  paint();
  await flushFrames();
  assert.equal(runs.length, 2, "a burst coalesces into the next frame");
});

test("a page whose frames never come still paints", async () => {
  frames = [];
  const runs = [];
  const paint = scheduleFrame(() => runs.push("paint"));

  paint();
  await settle();
  assert.deepEqual(runs, ["paint"], "the fallback ran without any frame");
});

test("the fallback yields to a frame that finally arrives", async () => {
  const runs = [];
  const paint = scheduleFrame(() => runs.push("paint"));

  paint();
  await flushFrames();
  await settle();
  assert.equal(runs.length, 1, "the frame won; the overdue timer stood down");

  paint();
  await settle();
  assert.equal(runs.length, 2, "and the next burst still paints once");
});

// The listeners are attached a turn after the menu opens, so that the press
// which opened it does not immediately close it. A second press on the same
// button removes the open menu directly - it never calls close() - and the
// listeners used to be attached anyway, to a menu that was already gone and
// with no way left to take them off.
test("a menu removed by a second press leaves no listeners behind", async () => {
  const attached = [];
  const documentAdd = globalThis.document.addEventListener;
  const windowAdd = globalThis.window.addEventListener;
  globalThis.document.addEventListener = (type) => attached.push(`document:${type}`);
  globalThis.window.addEventListener = (type) => attached.push(`window:${type}`);
  try {
    const anchor = fakeNode("button");
    popover(anchor, [{ label: "One", onClick() {} }]);
    popover(anchor, [{ label: "One", onClick() {} }]);
    await settle(20);
    assert.deepEqual(attached, [], "nothing is still listening for a menu that is gone");
  } finally {
    globalThis.document.addEventListener = documentAdd;
    globalThis.window.addEventListener = windowAdd;
  }
});

// A list that scrolls under the finger still fires a click when the finger
// lifts: on a queue, that is a scroll starting the song under the thumb. The
// guard lets a still press through and drops anything that moved.
test("a click that was a scroll does not get through", async () => {
  const { tapOnly } = await import("../dom.js");
  const fired = [];
  const handlers = tapOnly((event) => fired.push(event.clientX));

  handlers.pointerdown({ clientX: 40, clientY: 100 });
  handlers.click({ clientX: 52, clientY: 104 });
  assert.deepEqual(fired, [], "twelve pixels is a scroll");

  handlers.pointerdown({ clientX: 40, clientY: 100 });
  handlers.click({ clientX: 44, clientY: 103 });
  assert.deepEqual(fired, [44], "a few pixels of tremor is a tap");
});
