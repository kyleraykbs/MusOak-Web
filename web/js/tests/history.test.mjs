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
test("history view module loads after shaping entries in paint", async () => {
  const history = await import("../views/history.js");
  assert.equal(typeof history.playCountLabel, "function");
  assert.equal(typeof history.playedLengthLabel, "function");
});

// The rows are worked out apart from the toolbar, so a keystroke can redraw
// them without rebuilding the field it was typed into.
test("the history search narrows the tab it is on, by title or artist", async () => {
  const { historyRows } = await import("../views/history.js");
  const recent = [
    { track: { id: "a", title: "Blue Monday", artists: ["New Order"] }, playedMs: 60_000 },
    { track: { id: "b", title: "Temptation", artists: ["New Order"] }, playedMs: 5_000 },
    { track: { id: "c", title: "Blue", artists: ["Joni Mitchell"] }, playedMs: 5_000 },
  ];
  const mostPlayed = [{ track: { id: "c", title: "Blue", artists: ["Joni Mitchell"] }, plays: 3 }];
  const titles = (rows) => rows.map((row) => row.track.title);

  assert.deepEqual(titles(historyRows({ mode: "recent", recent, mostPlayed, query: "" })), ["Blue Monday", "Temptation", "Blue"]);
  assert.deepEqual(titles(historyRows({ mode: "recent", recent, mostPlayed, query: "  BLUE " })), ["Blue Monday", "Blue"]);
  assert.deepEqual(titles(historyRows({ mode: "recent", recent, mostPlayed, query: "new order" })), ["Blue Monday", "Temptation"]);
  const top = historyRows({ mode: "top", recent, mostPlayed, query: "" });
  assert.deepEqual(top.map((row) => row.detail), ["3 plays"]);
  assert.equal(historyRows({ mode: "recent", recent, mostPlayed, query: "" })[0].detail, "1:00 played");
});
