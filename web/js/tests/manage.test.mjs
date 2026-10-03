// The Manage tab's pure logic: what a file name says the song is, what the
// association dropdown offers, and which files are too big to send.
//
// No DOM here: only the helpers above the dialog in upload.js are exercised.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ARTWORK_BYTES,
  MAX_UPLOAD_BYTES,
  artistLine,
  artistList,
  artworkSizeError,
  associationOptions,
  audioContentType,
  describeMatch,
  guessMetadata,
  imageContentType,
  matchTrack,
  uploadSizeError,
} from "../views/upload.js";
import { allSelected, associationSummary, toggleSelection } from "../views/manage.js";

test("a file name gives the dialog its prefill", () => {
  assert.deepEqual(guessMetadata("Bicep - Glue.opus"), { title: "Glue", artists: ["Bicep"] });
  assert.deepEqual(guessMetadata("Bicep \u2013 Glue.flac"), { title: "Glue", artists: ["Bicep"] });
  assert.deepEqual(guessMetadata("Bicep \u2014 Glue.mp3"), { title: "Glue", artists: ["Bicep"] });
  assert.deepEqual(guessMetadata("/music/A - B.M.C.ogg"), { title: "B.M.C", artists: ["A"] });
  // Nothing to split on: the name is all there is.
  assert.deepEqual(guessMetadata("Glue.opus"), { title: "Glue", artists: [] });
  // A separator with no artist (or no title) is not a separator.
  assert.deepEqual(guessMetadata(" - Glue.opus"), { title: "- Glue", artists: [] });
  assert.deepEqual(guessMetadata("Bicep - .opus"), { title: "Bicep -", artists: [] });
});

test("the association dropdown offers the match, none, then a search", () => {
  const match = { id: "t1", title: "Glue", artists: ["Bicep"] };
  const options = associationOptions(match);
  assert.deepEqual(
    options.map((option) => option.label),
    ["Matched: Glue \u2014 Bicep", "No Association", "Search\u2026"]
  );
  assert.deepEqual(
    options.map((option) => option.index),
    [0, 1, 2]
  );

  // No match: the first option says so rather than disappearing, so the three
  // answers keep their places.
  assert.equal(associationOptions(null)[0].label, "No match found");
  assert.equal(associationOptions({ id: "", title: "Glue", artists: [] })[0].label, "No match found");
  // The edit dialog reads the first option as what the upload is tied to today.
  assert.equal(associationOptions(match, { prefix: "Currently" })[0].label, "Currently: Glue \u2014 Bicep");
  // A song picked by hand is labelled plainly.
  assert.equal(describeMatch(match, { prefix: "" }), "Glue \u2014 Bicep");
});

test("the automatic match only ties a really identical title", () => {
  const groups = [
    { track: { id: "x", title: "Glue (Extended Mix)", artists: ["Bicep"] } },
    { track: { id: "t1", title: "GLUE", artists: ["Bicep"] } },
  ];
  assert.equal(matchTrack("Glue", groups)?.id, "t1");
  assert.equal(matchTrack("G l u e", groups)?.id, "t1");
  assert.equal(matchTrack("Glue", [{ track: { id: "x", title: "Glue (Extended Mix)" } }]), null);
  assert.equal(matchTrack("", groups), null);
  assert.equal(matchTrack("Glue", []), null);
});

test("a song too large to send is named and refused", () => {
  assert.equal(uploadSizeError(0, "a.opus"), "");
  assert.equal(uploadSizeError(MAX_UPLOAD_BYTES, "a.opus"), "");
  const refusal = uploadSizeError(MAX_UPLOAD_BYTES + 1, "a.opus");
  assert.match(refusal, /a\.opus/);
  assert.match(refusal, /64 MB/);
  assert.match(uploadSizeError(MAX_UPLOAD_BYTES + 1), /64 MB/);

  assert.equal(artworkSizeError(MAX_ARTWORK_BYTES), "");
  assert.match(artworkSizeError(MAX_ARTWORK_BYTES + 1), /8 MB/);
});

test("what a file is by its extension", () => {
  assert.equal(audioContentType("song.opus"), "audio/ogg");
  assert.equal(audioContentType("song.FLAC"), "audio/flac");
  assert.equal(audioContentType("song"), "application/octet-stream");
  assert.equal(imageContentType("cover.JPG"), "image/jpeg");
  assert.equal(imageContentType("cover.zip"), null);
});

test("artists read the way the dialog shows and sends them", () => {
  assert.equal(artistLine(["Bicep", "Hammer"]), "Bicep, Hammer");
  assert.equal(artistLine([]), "");
  assert.deepEqual(artistList("Bicep,  Hammer ,"), ["Bicep", "Hammer"]);
  assert.deepEqual(artistList(""), []);
});

test("the selection toggles into a new set, never in place", () => {
  const start = new Set(["a"]);
  const added = toggleSelection(start, "b", true);
  assert.deepEqual([...start], ["a"]);
  assert.deepEqual([...added].sort(), ["a", "b"]);
  assert.deepEqual([...toggleSelection(added, "a", false)], ["b"]);
  // A blank id changes nothing.
  assert.deepEqual([...toggleSelection(added, "", true)], ["a", "b"]);
  // Ids are keyed as strings, the way the list reads them.
  assert.deepEqual([...toggleSelection(new Set(), 7, true)], ["7"]);
});

test("select all reads only the uploads it was shown", () => {
  const shown = [{ id: "1" }, { id: "2" }];
  assert.equal(allSelected(new Set(["1", "2"]), shown), true);
  assert.equal(allSelected(new Set(["1", "2", "3"]), shown), true);
  assert.equal(allSelected(new Set(["1"]), shown), false);
  assert.equal(allSelected(new Set(), shown), false);
  assert.equal(allSelected(new Set(), []), false);
});

test("a bulk association says how many and who was released", () => {
  assert.equal(associationSummary({ uploads: [{ id: "1" }], released: [] }), "Associated 1 upload.");
  assert.equal(associationSummary({ uploads: [{}, {}], released: [] }), "Associated 2 uploads.");
  assert.equal(
    associationSummary({ uploads: [{}, {}], released: [{ title: "Blue Horizon" }, { title: "Green Fields" }] }),
    "Associated 2 uploads. Released \u201cBlue Horizon\u201d, \u201cGreen Fields\u201d."
  );
  assert.equal(associationSummary({ uploads: [], released: [{ title: "x" }] }), "Nothing associated.");
  assert.equal(associationSummary(null), "Nothing associated.");
});
