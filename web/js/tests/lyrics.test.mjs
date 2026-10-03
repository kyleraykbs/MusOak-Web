// The one piece of the lyrics view that can be reasoned about without a DOM:
// which line is in force at a given moment. Everything else there is layout.

import test from "node:test";
import assert from "node:assert/strict";

import { activeLine } from "../views/lyrics.js";

const lines = [
  { atMs: 1_000, text: "one" },
  { atMs: 5_000, text: "two" },
  { atMs: 9_000, text: "three" },
];

test("before the first line nothing is active", () => {
  assert.equal(activeLine(lines, 0), -1);
  assert.equal(activeLine(lines, 999), -1);
});

test("a line becomes active on its own moment and holds until the next", () => {
  assert.equal(activeLine(lines, 1_000), 0);
  assert.equal(activeLine(lines, 4_999), 0);
  assert.equal(activeLine(lines, 5_000), 1);
  assert.equal(activeLine(lines, 8_999), 1);
});

test("past the last line the last one stays in force", () => {
  assert.equal(activeLine(lines, 9_000), 2);
  assert.equal(activeLine(lines, 60_000), 2);
});

test("an empty or missing list has no active line", () => {
  assert.equal(activeLine([], 5_000), -1);
  assert.equal(activeLine(undefined, 5_000), -1);
  assert.equal(activeLine(null, 5_000), -1);
});

test("a position that is not a finite number is not a moment", () => {
  assert.equal(activeLine(lines, Number.NaN), -1);
  assert.equal(activeLine(lines, Infinity), -1);
});

test("a line at zero is active from the start", () => {
  assert.equal(activeLine([{ atMs: 0, text: "intro" }], 0), 0);
  assert.equal(activeLine([{ atMs: 0, text: "intro" }], 1), 0);
  // A clock before zero has not reached the first line yet.
  assert.equal(activeLine([{ atMs: 0, text: "intro" }], -5), -1);
});
