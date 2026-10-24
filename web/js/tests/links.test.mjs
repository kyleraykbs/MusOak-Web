// The addresses a share menu offers: this app's own pages, and the page each
// matched platform keeps for the same song, album or artist.

import test from "node:test";
import assert from "node:assert/strict";

import { itemLink, linkedItem, platformLink, platformLinks } from "../links.js";

const TRACK = "6f1b0f1e-9d43-4f6a-8d6a-3f2c0f0b1a2c";
const ALBUM = "0b8c3b1a-2d4e-4f60-9a1b-2c3d4e5f6a7b";
const ARTIST = "9a7b6c5d-4e3f-4a2b-8c1d-0e9f8a7b6c5d";
const BASE = "https://musoak.test/";

test("each kind of item has its page parameter", () => {
  assert.equal(itemLink("track", TRACK, BASE), `${BASE}?track=${TRACK}`);
  assert.equal(itemLink("album", ALBUM, BASE), `${BASE}?album=${ALBUM}`);
  assert.equal(itemLink("artist", ARTIST, BASE), `${BASE}?artist=${ARTIST}`);
  // A page already carrying a query keeps the rest of it, and the item replaces
  // whatever the old link named.
  assert.equal(itemLink("album", ALBUM, `${BASE}?server=other&album=old`), `${BASE}?server=other&album=${ALBUM}`);
  // A song shared from its album's page names the song, not the album.
  assert.equal(itemLink("track", TRACK, `${BASE}?album=${ALBUM}`), `${BASE}?track=${TRACK}`);
  assert.equal(itemLink("playlist", ALBUM, BASE), "", "playlists are not a share kind");
  assert.equal(itemLink("track", "", BASE), "");
  assert.equal(itemLink("track", TRACK, "not an address"), "");
});

test("a link names its item back, and nothing else", () => {
  assert.deepEqual(linkedItem(`${BASE}?track=${TRACK}`), { kind: "track", id: TRACK });
  assert.deepEqual(linkedItem(`${BASE}?album=${ALBUM}`), { kind: "album", id: ALBUM });
  assert.deepEqual(linkedItem(`${BASE}?artist=${ARTIST}`), { kind: "artist", id: ARTIST });
  assert.deepEqual(linkedItem(`https://musoak.test/?album=${ALBUM}&track=${TRACK}`), { kind: "track", id: TRACK });
  assert.equal(linkedItem("https://musoak.test/"), null);
  assert.equal(linkedItem(`https://musoak.test/?track=not-a-song`), null);
  assert.equal(linkedItem("not an address"), null);
});

test("a platform link is that platform's own page", () => {
  assert.equal(platformLink("spotify", "track", "abc"), "https://open.spotify.com/track/abc");
  assert.equal(platformLink("spotify", "album", "abc"), "https://open.spotify.com/album/abc");
  assert.equal(platformLink("spotify", "artist", "abc"), "https://open.spotify.com/artist/abc");

  assert.equal(platformLink("ytmusic", "track", "v1"), "https://music.youtube.com/watch?v=v1");
  assert.equal(platformLink("ytmusic", "album", "MPREb_1"), "https://music.youtube.com/browse/MPREb_1");
  assert.equal(platformLink("ytmusic", "artist", "UC1"), "https://music.youtube.com/channel/UC1");

  assert.equal(platformLink("youtube", "track", "v1"), "https://www.youtube.com/watch?v=v1");
  // Plain YouTube has videos, not albums or artist pages.
  assert.equal(platformLink("youtube", "album", "x"), "");

  // A local file lives nowhere else.
  assert.equal(platformLink("local", "track", "x"), "");
  assert.equal(platformLink("upload", "track", "x"), "");
  assert.equal(platformLink("e2e-slow", "track", "x"), "");
  assert.equal(platformLink("spotify", "track", ""), "");
});

test("the platforms an item was matched with keep their order and lose duplicates", () => {
  const variants = [
    { provider: "spotify", providerTrackId: "sp1" },
    { provider: "ytmusic", providerTrackId: "yt1" },
    { provider: "local", providerTrackId: "x" },
    { provider: "spotify", providerTrackId: "sp2" }, // one choice per platform
    { provider: "youtube", providerTrackId: "v1" },
  ];
  assert.deepEqual(platformLinks("track", variants), [
    { provider: "spotify", label: "Spotify", url: "https://open.spotify.com/track/sp1" },
    { provider: "ytmusic", label: "YouTube Music", url: "https://music.youtube.com/watch?v=yt1" },
    { provider: "youtube", label: "YouTube", url: "https://www.youtube.com/watch?v=v1" },
  ]);

  const album = [
    { provider: "ytmusic", providerAlbumId: "MPREb_1" },
    { provider: "spotify", providerAlbumId: "al1" },
  ];
  assert.deepEqual(platformLinks("album", album).map((link) => link.url), [
    "https://music.youtube.com/browse/MPREb_1",
    "https://open.spotify.com/album/al1",
  ]);

  const artist = [{ provider: "spotify", providerArtistId: "ar1" }];
  assert.deepEqual(platformLinks("artist", artist).map((link) => link.url), ["https://open.spotify.com/artist/ar1"]);

  assert.deepEqual(platformLinks("track", undefined), []);
});
