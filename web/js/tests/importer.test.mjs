import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeTitle,
  matchScore,
  matchTracks,
  copyPlaylist,
} from "../importer.js";

const track = (id, title, artists, durationMs) => ({ id, title, artists, durationMs });

// --- titles ----------------------------------------------------------------

test("packaging around a title is ignored", () => {
  const plain = normalizeTitle("Blue Horizon");
  assert.equal(normalizeTitle("Blue Horizon (Official Video)"), plain);
  assert.equal(normalizeTitle("Blue Horizon (Official Music Video)"), plain);
  assert.equal(normalizeTitle("Blue Horizon - Remastered"), plain);
  assert.equal(normalizeTitle("Blue Horizon (Remastered 2011)"), plain);
  assert.equal(normalizeTitle("Blue Horizon - 2011 Remaster"), plain);
  assert.equal(normalizeTitle("Blue Horizon (Lyrics)"), plain);
  assert.equal(normalizeTitle("Blue Horizon [Official Audio]"), plain);
});

test("a guest credit does not change the song", () => {
  assert.equal(normalizeTitle("Blue Horizon feat. Guest"), normalizeTitle("Blue Horizon"));
  assert.equal(normalizeTitle("Blue Horizon (feat. Guest)"), normalizeTitle("Blue Horizon"));
  assert.equal(normalizeTitle("Blue Horizon ft. Guest"), normalizeTitle("Blue Horizon"));
});

test("a live take or a remix keeps its own title", () => {
  const plain = normalizeTitle("Blue Horizon");
  assert.notEqual(normalizeTitle("Blue Horizon (Live)"), plain);
  assert.notEqual(normalizeTitle("Blue Horizon (Live at Wembley)"), plain);
  assert.notEqual(normalizeTitle("Blue Horizon (Remix)"), plain);
  assert.notEqual(normalizeTitle("Blue Horizon - Remix"), plain);
});

// --- matching --------------------------------------------------------------

test("the same song under different packaging matches", () => {
  const a = track("a", "Blue Horizon", ["The Waves"], 200_000);
  assert.ok(matchScore(a, track("b", "Blue Horizon (Official Video)", ["The Waves"], 200_000)) > 0);
  assert.ok(matchScore(a, track("b", "Blue Horizon - Remastered", ["The Waves"], 200_000)) > 0);
  assert.ok(matchScore(a, track("b", "Blue Horizon feat. Guest", ["The Waves"], 200_000)) > 0);
});

test("a live take is not the studio track", () => {
  const studio = track("studio", "Blue Horizon", ["The Waves"], 200_000);
  const live = track("live", "Blue Horizon (Live at Wembley)", ["The Waves"], 260_000);
  assert.equal(matchScore(studio, live), 0);
  assert.deepEqual(matchTracks([studio], [live]), [""]);
});

test("a remix is not the original", () => {
  const original = track("original", "Blue Horizon", ["The Waves"], 200_000);
  const remix = track("remix", "Blue Horizon (Remix)", ["The Waves"], 240_000);
  assert.equal(matchScore(original, remix), 0);
  assert.deepEqual(matchTracks([original], [remix]), [""]);
});

test("with both takes present, each matches its own", () => {
  const original = track("original", "Blue Horizon", ["The Waves"], 200_000);
  const remix = track("remix", "Blue Horizon (Remix)", ["The Waves"], 240_000);
  const candidates = [remix, original]; // order must not decide it
  assert.deepEqual(matchTracks([original, remix], candidates), ["original", "remix"]);
});

test("the same title by an unrelated artist does not match", () => {
  const mine = track("mine", "Blue Horizon", ["The Waves"], 200_000);
  const theirs = track("theirs", "Blue Horizon", ["Some Other Band"], 200_000);
  assert.equal(matchScore(mine, theirs), 0);
  assert.deepEqual(matchTracks([mine], [theirs]), [""]);
});

test("an artist in common is enough when the credit lists differ", () => {
  const mine = track("mine", "Blue Horizon", ["The Waves", "Guest Singer"], 200_000);
  const theirs = track("theirs", "Blue Horizon", ["Guest Singer", "Someone Else"], 200_000);
  assert.ok(matchScore(mine, theirs) > 0);
});

test("length breaks a tie between two versions of the same title", () => {
  const wanted = track("wanted", "Blue Horizon", ["The Waves"], 201_000);
  const close = track("close", "Blue Horizon", ["The Waves"], 202_500);
  const far = track("far", "Blue Horizon", ["The Waves"], 260_000);
  assert.deepEqual(matchTracks([wanted], [far, close]), ["close"]);

  const alsoClose = track("alsoClose", "Blue Horizon", ["The Waves"], 208_000);
  assert.deepEqual(matchTracks([wanted], [alsoClose, close]), ["close"]);
});

test("a song the target does not have is left blank, aligned by index", () => {
  const known = track("known", "Blue Horizon", ["The Waves"], 200_000);
  const missing = track("missing", "A Song Nobody Has", ["The Waves"], 180_000);
  const candidates = [track("hit", "Blue Horizon", ["The Waves"], 200_000)];
  assert.deepEqual(matchTracks([known, missing], candidates), ["hit", ""]);
});

// --- copying ---------------------------------------------------------------

function sourceClient(tracks, name = "Roadtrip") {
  return {
    synced: [],
    async syncPlaylist(id) {
      this.synced.push(id);
      return { playlist: { id, name }, tracks };
    },
    async playlist() {
      throw new Error("a provider playlist is synced, not read");
    },
  };
}

function targetClient(catalog) {
  return {
    searches: [],
    created: [],
    added: [],
    async search(query) {
      this.searches.push(query);
      // A broad search: every candidate comes back, so matching is what has to
      // tell the songs apart.
      const groups = catalog.map((candidate) => ({ track: candidate }));
      return { groups, providerErrors: [] };
    },
    async createPlaylist(name) {
      this.created.push(name);
      return { id: "new-playlist", name, trackCount: 0 };
    },
    async addToPlaylist(id, trackIds) {
      this.added.push({ id, trackIds });
      return { playlist: { id }, tracks: [] };
    },
  };
}

test("a copy syncs the source, matches song by song and reports what it left behind", async () => {
  const studio = track("s-studio", "Blue Horizon", ["The Waves"], 200_000);
  const remix = track("s-remix", "Blue Horizon (Remix)", ["The Waves"], 240_000);
  const absent = track("s-absent", "A Song Nobody Has", ["The Waves"], 180_000);
  const from = sourceClient([studio, remix, absent]);

  const catalog = [
    track("t-studio", "Blue Horizon (Official Video)", ["The Waves"], 200_500),
    track("t-remix", "Blue Horizon (Remix)", ["The Waves"], 240_500),
  ];
  const to = targetClient(catalog);

  const progress = [];
  const result = await copyPlaylist({
    from,
    to,
    providerPlaylist: { id: "p1", name: "Roadtrip" },
    onProgress: (step) => progress.push(step),
  });

  assert.deepEqual(from.synced, ["p1"]);
  assert.equal(to.searches[0], "Blue Horizon");
  assert.deepEqual(to.created, ["Roadtrip"]);
  assert.deepEqual(to.added, [{ id: "new-playlist", trackIds: ["t-studio", "t-remix"] }]);
  assert.equal(result.matched, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.total, 3);
  assert.equal(result.playlistId, "new-playlist");

  assert.equal(progress.length, 3);
  assert.deepEqual(progress.map((step) => step.position), [1, 2, 3]);
  assert.deepEqual(progress.map((step) => step.matched), [1, 2, 2]);
  assert.deepEqual(progress.map((step) => step.skipped), [0, 0, 1]);
});

test("a title search that finds nothing falls back to the artist", async () => {
  const one = track("s1", "Alpha Tone", ["The Test Suite"], 200_000);
  const from = sourceClient([one]);
  const to = targetClient([]);
  const asked = [];
  to.search = async (query) => {
    asked.push(query);
    // A backend strict about multi-word phrases: only the artist query works.
    if (query === "The Test Suite") {
      return { groups: [{ track: { id: "t1", title: "Alpha Tone", artists: ["The Test Suite"], durationMs: 200_000 } }] };
    }
    return { groups: [] };
  };

  const result = await copyPlaylist({ from, to, providerPlaylist: { id: "p1", name: "Mix" } });
  assert.deepEqual(asked, ["Alpha Tone", "The Test Suite"]);
  assert.equal(result.matched, 1);
  assert.deepEqual(to.added, [{ id: "new-playlist", trackIds: ["t1"] }]);
});

test("a copy keeps the source name when the caller offers none", async () => {
  const from = sourceClient([], "Sunday Morning");
  const to = targetClient([]);
  const result = await copyPlaylist({ from, to, providerPlaylist: { id: "p1" } });
  assert.deepEqual(to.created, ["Sunday Morning"]);
  assert.equal(result.name, "Sunday Morning");
  assert.equal(result.matched, 0);
  assert.equal(result.skipped, 0);
});

test("a failing search leaves that song behind instead of stopping the copy", async () => {
  const one = track("s1", "Blue Horizon", ["The Waves"], 200_000);
  const two = track("s2", "Second Song", ["The Waves"], 200_000);
  const from = sourceClient([one, two]);
  const to = targetClient([track("t1", "Blue Horizon", ["The Waves"], 200_000)]);
  to.search = async (query) => {
    if (query.includes("Second")) throw new Error("search is down");
    return { groups: [{ track: { id: "t1", title: "Blue Horizon", artists: ["The Waves"], durationMs: 200_000 } }] };
  };

  const result = await copyPlaylist({ from, to, providerPlaylist: { id: "p1", name: "Mix" } });
  assert.equal(result.matched, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(to.added, [{ id: "new-playlist", trackIds: ["t1"] }]);
});
