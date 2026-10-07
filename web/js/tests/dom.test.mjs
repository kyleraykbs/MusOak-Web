// scheduleFrame's contract: at most one run per burst, the frame path when
// frames exist, and the timer fallback when they never come - the case that
// used to freeze a room page at the numbers from its first paint.
import test from "node:test";
import assert from "node:assert/strict";

// The module reads `document` and `requestAnimationFrame` off wherever it
// runs, so both are provided here: Node has neither.
globalThis.document = {
  createElement(tag) {
    return {
      tag,
      children: [],
      style: {},
      dataset: {},
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      removeChild(child) {
        this.children = this.children.filter((entry) => entry !== child);
        return child;
      },
      get firstChild() {
        return this.children[0] || null;
      },
      set textContent(value) {
        this.text = value;
      },
      addEventListener() {},
      setAttribute() {},
    };
  },
  createTextNode(value) {
    return { text: value };
  },
};

let frames = [];
globalThis.requestAnimationFrame = (callback) => {
  frames.push(callback);
  return frames.length;
};

const { scheduleFrame } = await import("../dom.js");

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
