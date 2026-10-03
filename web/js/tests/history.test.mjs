// What the history view reads beside a row: how much of a song a listen heard,
// and how often a song has been played.

import test from "node:test";
import assert from "node:assert/strict";

import { playCountLabel, playedLengthLabel } from "../views/history.js";

test("a played length reads as minutes and seconds", () => {
  assert.equal(playedLengthLabel(252_000), "4:12 played");
  assert.equal(playedLengthLabel(5_000), "0:05 played");
  assert.equal(playedLengthLabel(3_670_000), "1:01:10 played");
});

test("a played length that is missing or nonsense is zero", () => {
  assert.equal(playedLengthLabel(0), "0:00 played");
  assert.equal(playedLengthLabel(undefined), "0:00 played");
  assert.equal(playedLengthLabel(-4000), "0:00 played");
});

test("a play count is singular only for one", () => {
  assert.equal(playCountLabel(0), "0 plays");
  assert.equal(playCountLabel(1), "1 play");
  assert.equal(playCountLabel(7), "7 plays");
  assert.equal(playCountLabel(undefined), "0 plays");
});
