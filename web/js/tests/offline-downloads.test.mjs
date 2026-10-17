// One download at a time. A queue of sixty songs is sixty downloads asked for in
// a breath; without this they all start, the browser opens sixty connections, and
// the song about to be played waits behind every one of them.

import test from "node:test";
import assert from "node:assert/strict";

import { DOWNLOAD_CONCURRENCY, createDownloadQueue } from "../offline.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a queue of downloads runs no more than the limit at once", async () => {
  const queue = createDownloadQueue({ limit: () => 2 });
  let running = 0;
  let peak = 0;
  const started = [];

  const tasks = Array.from({ length: 6 }, (_, index) =>
    queue(async () => {
      running += 1;
      peak = Math.max(peak, running);
      started.push(index);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return index;
    })
  );

  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5], "every one of them finishes");
  assert.equal(peak, 2, "two at a time, no more");
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5], "and in the order they were asked for");
});

test("a failed download gives its slot back rather than the queue's", async () => {
  const queue = createDownloadQueue({ limit: () => 1 });
  await assert.rejects(queue(async () => {
    throw new Error("the server said no");
  }), /the server said no/);
  assert.equal(await queue(async () => "next"), "next", "the queue still moves");
});

test("the shared queue runs one at a time, whatever the device asks for", async () => {
  assert.equal(DOWNLOAD_CONCURRENCY, 1, "one at a time, always");
  const one = createDownloadQueue();
  let running = 0;
  let peak = 0;
  const tasks = [1, 2, 3].map(() =>
    one(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    })
  );
  await Promise.all(tasks);
  assert.equal(peak, 1, "and the queue is what enforces it");
});
