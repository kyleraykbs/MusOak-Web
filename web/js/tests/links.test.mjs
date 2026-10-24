// The address of a song: what the share dialog copies, and what the page reads
// back when that address is opened.

import test from "node:test";
import assert from "node:assert/strict";

import { linkedTrackId, trackLink } from "../links.js";

const ID = "6f1b0f1e-9d43-4f6a-8d6a-3f2c0f0b1a2c";

test("a track link is the page's own address with the song on it", () => {
  assert.equal(trackLink(ID, `https://musoak.test/`), `https://musoak.test/?track=${ID}`);
  // A page already carrying a query keeps the rest of it, and the song replaces
  // whatever the old link named.
  assert.equal(
    trackLink(ID, "https://musoak.test/?server=other&track=old"),
    `https://musoak.test/?server=other&track=${ID}`
  );
  assert.equal(trackLink("", "https://musoak.test/"), "");
  assert.equal(trackLink(ID, "not an address"), "");
});

test("a link names its song back, and nothing else", () => {
  assert.equal(linkedTrackId(`https://musoak.test/?track=${ID}`), ID);
  assert.equal(linkedTrackId(`https://musoak.test/?track=${ID.toUpperCase()}`), ID.toUpperCase());
  assert.equal(linkedTrackId("https://musoak.test/"), "");
  assert.equal(linkedTrackId("https://musoak.test/?track=not-a-song"), "");
  assert.equal(linkedTrackId("not an address"), "");
});
