// Pure logic behind the account form. No DOM: these are the rules the form
// uses to decide whether Save and Discard do anything, which way a provider
// moves, and whether a password change is ready to send.

import test from "node:test";
import assert from "node:assert/strict";
import {
  iconContentType, isDirty, moveItem, passwordProblem, usernameProblem,
} from "../views/account.js";

test("a field is dirty only when it really differs from the saved value", () => {
  assert.equal(isDirty("Kyle", "Kyle"), false);
  assert.equal(isDirty("Kyle", "Kyl"), true);
  assert.equal(isDirty("Kyle", "kyle"), true);
  assert.equal(isDirty("Kyle", "Kyle "), false);
  assert.equal(isDirty("", ""), false);
  assert.equal(isDirty(undefined, ""), false);
  assert.equal(isDirty("", "New name"), true);
});

test("moveItem reorders a copy, clamped to the list", () => {
  const original = ["one", "two", "three"];

  assert.deepEqual(moveItem(original, 0, 1), ["two", "one", "three"]);
  assert.deepEqual(moveItem(original, 2, 0), ["three", "one", "two"]);
  assert.deepEqual(moveItem(original, 1, 1), original);
  assert.deepEqual(moveItem(original, 0, -5), original);
  assert.deepEqual(moveItem(original, 9, 0), ["three", "one", "two"]);
  assert.deepEqual(moveItem(original, 0, 9), ["two", "three", "one"]);
  assert.deepEqual(moveItem([], 0, 1), []);

  // The caller's list is untouched: a failed save must not move anything.
  assert.deepEqual(original, ["one", "two", "three"]);
});

test("a password change needs both passwords and a matching confirmation", () => {
  assert.equal(passwordProblem("old", "new", "new"), "");
  assert.equal(passwordProblem("", "new", "new"), "Both the current and the new password are needed.");
  assert.equal(passwordProblem("old", "", ""), "Both the current and the new password are needed.");
  assert.equal(passwordProblem("old", "new", "other"), "The two new passwords do not match.");
  assert.equal(passwordProblem("old", "new", ""), "The two new passwords do not match.");
});

test("a username change needs the password and a non-blank name", () => {
  assert.equal(usernameProblem("hunter2", "kyle"), "");
  assert.equal(usernameProblem("", "kyle"), "A password and a new username are needed.");
  assert.equal(usernameProblem("hunter2", ""), "A password and a new username are needed.");
  assert.equal(usernameProblem("hunter2", "   "), "A password and a new username are needed.");
});

test("an icon upload only accepts the image types the endpoint takes", () => {
  assert.equal(iconContentType("png"), "image/png");
  assert.equal(iconContentType("photo.JPG"), "image/jpeg");
  assert.equal(iconContentType("art.webp"), "image/webp");
  assert.equal(iconContentType("image/gif"), "image/gif");
  assert.equal(iconContentType("song.mp3"), "");
  assert.equal(iconContentType(""), "");
});
