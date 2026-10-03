// Pure helpers behind the Search and Playlists views: no DOM, no fetch.

import test from "node:test";
import assert from "node:assert/strict";

import {
  pinUserUploads, artistLine, groupProviders, searchSections, sectionsFor, SEARCH_KINDS, providerErrorLines,
} from "../views/search.js";
import { sumDurations, playlistDurationMs, trackCount, playlistSubtitle, importPlaylistName } from "../views/playlists.js";
import { isAudioFile } from "../views/upload.js";

const upload = (title) => ({
  userUpload: true,
  track: { title },
  variants: [{ provider: "user" }],
});

const group = (title, ...providers) => ({
  track: { title },
  variants: providers.map((provider) => ({ provider })),
});

test("a search tab shows only its own kind", () => {
  const payload = {
    groups: [group("Song", "jamendo"), upload("Mine")],
    albums: [{ id: "al", title: "Album" }],
    artists: [{ id: "ar", name: "Artist" }],
    playlists: [{ id: "pl", title: "List" }],
  };
  // Tracks is the tab that also carries what the household uploaded.
  assert.deepEqual(sectionsFor("tracks", payload).map((section) => section.key), ["uploads", "tracks"]);
  assert.deepEqual(sectionsFor("albums", payload).map((section) => section.key), ["albums"]);
  assert.deepEqual(sectionsFor("artists", payload).map((section) => section.key), ["artists"]);
  assert.deepEqual(sectionsFor("playlists", payload).map((section) => section.key), ["playlists"]);

  // A tab with nothing behind it says nothing rather than borrowing another's.
  assert.deepEqual(sectionsFor("albums", { groups: [group("Song", "jamendo")] }), []);
  assert.deepEqual(sectionsFor("playlists", {}), []);
  assert.deepEqual(SEARCH_KINDS.map((entry) => entry.key), ["tracks", "albums", "artists", "playlists"]);
});

test("user uploads are pinned above provider results", () => {
  const groups = [group("a", "jamendo"), upload("mine"), group("b", "spotify"), upload("mine2")];
  const pinned = pinUserUploads(groups);
  assert.deepEqual(pinned.map((entry) => entry.track.title), ["mine", "mine2", "a", "b"]);
  assert.deepEqual(
    groups.map((entry) => entry.track.title),
    ["a", "mine", "b", "mine2"],
    "the response is not reordered in place"
  );
  assert.deepEqual(pinUserUploads([]), []);
  assert.deepEqual(pinUserUploads(undefined), []);
});

test("the result sections put uploads first and leave empty ones out", () => {
  const sections = searchSections({
    groups: [group("Song", "jamendo"), upload("My Song")],
    albums: [{ id: "al", title: "Album", artists: ["Artist"], providers: ["spotify"] }],
    artists: [{ id: "ar", name: "Artist", providers: ["jamendo"] }],
  });
  assert.deepEqual(sections.map((section) => section.key), ["uploads", "tracks", "albums", "artists"]);
  assert.deepEqual(sections[0].items.map((entry) => entry.track.title), ["My Song"]);
  assert.equal(sections[1].items[0].track.title, "Song");
  assert.equal(sections[2].kind, "album");
  assert.equal(sections[3].kind, "artist");

  assert.deepEqual(searchSections({ albums: [{ id: "al", title: "Album" }] }).map((s) => s.key), ["albums"]);
  assert.deepEqual(searchSections({}), []);
});

test("a group's providers are listed once, sorted", () => {
  assert.deepEqual(groupProviders(group("x", "spotify", "jamendo", "spotify")), ["jamendo", "spotify"]);
  assert.deepEqual(groupProviders({}), []);
});

test("artist lines join what the server sent", () => {
  assert.equal(artistLine({ artists: ["A", "B"] }), "A, B");
  assert.equal(artistLine({}), "");
});

test("provider problems read as a quiet line", () => {
  assert.deepEqual(
    providerErrorLines([{ provider: "jamendo", error: "timeout" }, {}]),
    ["jamendo: timeout", "a provider: failed"]
  );
  assert.deepEqual(providerErrorLines(), []);
});

test("a playlist's duration is the tracks' total when the server did not sum it", () => {
  assert.equal(sumDurations([{ durationMs: 1000 }, { durationMs: 2500 }, {}]), 3500);
  assert.equal(sumDurations(), 0);
  assert.equal(playlistDurationMs({ durationMs: 9000, tracks: [{ durationMs: 1 }] }), 9000);
  assert.equal(
    playlistDurationMs({ durationMs: 0, tracks: [{ durationMs: 60000 }, { durationMs: 30000 }] }),
    90000
  );
});

test("a playlist row says its track count, and its time when it is known", () => {
  assert.equal(playlistSubtitle({ trackCount: 1, durationMs: 65000 }), "1 track \u00b7 1:05");
  assert.equal(playlistSubtitle({ trackCount: 12, durationMs: 0 }), "12 tracks");
  assert.equal(playlistSubtitle({ tracks: [{ durationMs: 1000 }] }), "1 track \u00b7 0:01");
  assert.equal(trackCount({ trackCount: 3, tracks: [{}, {}] }), 3);
  assert.equal(trackCount({ tracks: [{}, {}] }), 2);
});

test("only the files whose name or type says audio are imported", () => {
  // A folder pick usually leaves the type empty, so the name has to carry it.
  for (const name of ["song.mp3", "Song.M4A", "x.aac", "x.ogg", "x.opus", "x.flac", "x.wav", "x.webm"]) {
    assert.equal(isAudioFile({ name, type: "" }), true, name);
  }
  // Some pickers know the type even when the name does not say it.
  assert.equal(isAudioFile({ name: "a recording", type: "audio/mpeg" }), true);
  assert.equal(isAudioFile({ name: "cover.jpg", type: "image/jpeg" }), false);
  assert.equal(isAudioFile({ name: "notes.txt", type: "text/plain" }), false);
  assert.equal(isAudioFile({ name: "no extension", type: "" }), false);
  assert.equal(isAudioFile({}), false);
});

test("an import is named for its folder, and loose files fall back", () => {
  // A folder pick carries the folder's own name at the front of every path.
  assert.equal(importPlaylistName([{ webkitRelativePath: "Holiday/01.mp3", name: "01.mp3" }]), "Holiday");
  assert.equal(importPlaylistName([{ webkitRelativePath: "Holiday/disc1/02.mp3" }]), "Holiday");
  // Files chosen one by one have no folder between them to take a name from.
  assert.equal(importPlaylistName([{ name: "a.mp3" }, { name: "b.mp3" }]), "Imported songs");
  assert.equal(importPlaylistName([]), "Imported songs");
  assert.equal(importPlaylistName(), "Imported songs");
});
