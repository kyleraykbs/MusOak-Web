// What a share dialog offers: the app's own link, then every matched platform.

import test from "node:test";
import assert from "node:assert/strict";

import { shareOptions } from "../views/share.js";

const BASE = "https://musoak.test/";
const TRACK = "6f1b0f1e-9d43-4f6a-8d6a-3f2c0f0b1a2c";
const ALBUM = "0b8c3b1a-2d4e-4f60-9a1b-2c3d4e5f6a7b";
const ARTIST = "9a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d";

test("musoak comes first, and is the default choice", () => {
  const options = shareOptions("track", { id: TRACK, title: "Song" }, [], BASE);
  assert.deepEqual(options, [{ provider: "", label: "Musoak", url: `${BASE}?track=${TRACK}` }]);
});

test("the matched platforms follow musoak, one entry each", () => {
  const variants = [
    { provider: "spotify", providerAlbumId: "al1" },
    { provider: "ytmusic", providerAlbumId: "MPREb_1" },
    { provider: "spotify", providerAlbumId: "al2" },
    { provider: "local", providerAlbumId: "" },
  ];
  const options = shareOptions("album", { id: ALBUM, title: "Album" }, variants, BASE);
  assert.deepEqual(options.map((option) => option.label), ["Musoak", "Spotify", "YouTube Music"]);
  assert.equal(options[0].url, `${BASE}?album=${ALBUM}`);
  assert.equal(options[1].url, "https://open.spotify.com/album/al1");
  assert.equal(options[2].url, "https://music.youtube.com/browse/MPREb_1");
});

test("an artist's links are artist pages", () => {
  const options = shareOptions("artist", { id: ARTIST, name: "They" }, [
    { provider: "spotify", providerArtistId: "ar1" },
  ], BASE);
  assert.equal(options[1].url, "https://open.spotify.com/artist/ar1");
});

test("an item with no id has nothing to copy", () => {
  assert.deepEqual(shareOptions("track", {}, [], BASE), []);
});
