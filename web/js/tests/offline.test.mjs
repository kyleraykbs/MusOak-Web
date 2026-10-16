// The offline module's pure logic: what a media URL is called in the cache,
// what a set of kept songs adds up to, and which are still missing. No DOM.
import test from "node:test";
import assert from "node:assert/strict";

import {
  keptEntries, keptGoneMessage, keptTracks, mediaCacheKey, mediaPath, mediaVariantId, playlistEntries,
  queueOrder, totalBytes, plannedFetches,
} from "../offline.js";

const HERE = "https://music.example.com";
const ELSEWHERE = "https://other.example.com";
const ROUTER = "http://localhost:8080";
const HOST = "http://localhost"; // what a path is resolved against with no browser

/** The URL the client hands an audio element for one variant on one backend. */
function media(server, variant, extra = "") {
  return `/api/v1/media/${variant}?ms=${encodeURIComponent(server)}${extra}`;
}

test("the same song on two backends is two cache entries", () => {
  assert.notEqual(mediaCacheKey(media(HERE, "v1"), ROUTER), mediaCacheKey(media(ELSEWHERE, "v1"), ROUTER));
});

test("the same song on the same backend is one entry, whatever else the URL carries", () => {
  const first = mediaCacheKey(media(HERE, "v1"), ROUTER);
  assert.equal(mediaCacheKey(media(HERE, "v1"), ROUTER), first);
  assert.equal(mediaCacheKey(media(HERE, "v1", "&token=abc&t=99"), ROUTER), first);
});

test("two songs on one backend are two entries", () => {
  assert.notEqual(mediaCacheKey(media(HERE, "v1"), ROUTER), mediaCacheKey(media(HERE, "v2"), ROUTER));
});

test("the key survives the percent-encoding the router needs", () => {
  const key = mediaCacheKey(`/api/v1/media/v1?ms=${encodeURIComponent("https://music.example.com/sub")}`, ROUTER);
  assert.equal(key, `${ROUTER}/api/v1/media/v1?ms=${encodeURIComponent("https://music.example.com/sub")}`);
});

test("a kept set adds up across its songs", () => {
  assert.equal(totalBytes([{ bytes: 100 }, { bytes: 250 }]), 350);
  assert.equal(totalBytes([100, 250]), 350);
});

test("a song whose size is unknown adds nothing", () => {
  assert.equal(totalBytes([{ bytes: 100 }, {}, { bytes: null }, { bytes: -5 }]), 100);
});

test("nothing kept adds up to nothing", () => {
  assert.equal(totalBytes([]), 0);
  assert.equal(totalBytes(undefined), 0);
});

test("only songs the index is missing get fetched", () => {
  const record = { trackIds: [{ trackId: "a", variantId: "v1" }] };
  const plan = plannedFetches(record, [
    { trackId: "a", variantId: "v1" },
    { trackId: "b", variantId: "v2" },
  ]);
  assert.deepEqual(plan, [{ trackId: "b", variantId: "v2" }]);
});

test("a song now kept from another source is fetched again", () => {
  const record = { trackIds: [{ trackId: "a", variantId: "v1" }] };
  assert.deepEqual(plannedFetches(record, [{ trackId: "a", variantId: "v9" }]), [
    { trackId: "a", variantId: "v9" },
  ]);
});

test("with no index at all, everything is fetched", () => {
  assert.deepEqual(plannedFetches(null, [{ trackId: "a", variantId: "v1" }]), [
    { trackId: "a", variantId: "v1" },
  ]);
  assert.deepEqual(plannedFetches(undefined, [{ id: "b", variantId: "v2" }]), [
    { trackId: "b", variantId: "v2" },
  ]);
});

test("a song with no rendition yet is not planned", () => {
  assert.deepEqual(plannedFetches(null, [{ trackId: "a", variantId: "" }, { id: "b" }]), []);
});

// A playlist being kept is usually the queue being played, and the order it will
// be heard in is the queue's - after a shuffle that is not the order the
// playlist is stored in. The songs due next come first, highest undownloaded
// first, and everything else keeps the list's own order.
test("a kept playlist is fetched in the queue's order", () => {
  const list = ["a", "b", "c", "d"].map((id) => ({ id }));
  const shuffled = ["c", "d", "a", "b"].map((id) => ({ id }));

  assert.deepEqual(
    queueOrder(list, shuffled, 0).map((each) => each.id),
    ["c", "d", "a", "b"],
    "the queue's order wins over the list's"
  );
  assert.deepEqual(
    queueOrder(list, shuffled, 2).map((each) => each.id),
    ["a", "b", "c", "d"],
    "and the songs already played are not ahead of the ones due"
  );
  assert.deepEqual(
    queueOrder([{ id: "x" }, { id: "b" }, { id: "y" }], [{ id: "b" }], 0).map((each) => each.id),
    ["b", "x", "y"],
    "a song the queue does not hold keeps its place in the list, at the end"
  );
  assert.deepEqual(
    queueOrder(list, [], 0).map((each) => each.id),
    ["a", "b", "c", "d"],
    "with no queue playing, nothing is reordered"
  );
});

// --- playing what is kept --------------------------------------------------

test("the variant is what a media URL names, whatever else it carries", () => {
  assert.equal(mediaVariantId(`/api/v1/media/v1?ms=${encodeURIComponent(HERE)}`), "v1");
  assert.equal(mediaVariantId("https://page.example.com/api/v1/media/v1?ms=x&start=5000"), "v1");
  assert.equal(mediaVariantId("/api/v1/media/v%2F1?ms=x"), "v/1", "the client percent-encodes the id, and it comes back whole");
  // Something that is not a media path names no song.
  assert.equal(mediaVariantId(`/api/v1/download/v1?ms=${encodeURIComponent(HERE)}`), "");
  assert.equal(mediaVariantId(`/api/v1/media/?ms=${encodeURIComponent(HERE)}`), "");
  assert.equal(mediaVariantId(""), "");
});

test("a media URL asks for the song the same way after a round trip", () => {
  const path = `/api/v1/media/v1?ms=${encodeURIComponent(HERE)}`;
  assert.equal(mediaPath(path), path);
  assert.equal(mediaPath(`${ROUTER}${path}`), path, "the origin is the page's own either way");
  assert.equal(mediaPath(""), "");
});

test("a kept entry becomes the track the player queues", () => {
  const track = { trackId: "t1", variantId: "v1", title: "One", url: "/api/v1/media/v1?ms=x" };
  assert.deepEqual(keptTracks([track]), [
    { id: "t1", title: "One", variantId: "v1", localUrl: "/api/v1/media/v1?ms=x" },
  ]);
  // An entry kept before the title was written down still names the song's own
  // id as a track, rather than breaking the list it is in.
  assert.deepEqual(keptTracks([{ trackId: "t1", variantId: "v1" }]), [
    { id: "t1", title: "", variantId: "v1", localUrl: "" },
  ]);
  assert.deepEqual(keptTracks([]), []);
  assert.deepEqual(keptTracks(undefined), []);
});

test("what a kept playlist says when the browser has let it go", () => {
  assert.match(
    keptGoneMessage("Offline songs", [{ trackId: "t1" }, { trackId: "t2" }], 2),
    /no longer in this browser/,
    "every song gone is said plainly, not counted"
  );
  assert.match(keptGoneMessage("Offline songs", [{ trackId: "t2" }], 3), /1 of 3 songs in/, "a count when some are left");
  assert.match(keptGoneMessage("Offline songs", [], 0), /has nothing kept on this machine/);
  assert.match(keptGoneMessage("", [{ trackId: "t1" }], 1), /^That playlist/, "a playlist nobody named still reads");
});

/** A client that names its backend in the query, as the real one does. */
const keptClient = (server = HERE) => ({
  mediaUrl: (variantId) => `/api/v1/media/${variantId}?ms=${encodeURIComponent(server)}`,
});

/** As much of Cache Storage as these rules touch: what is in it, and nothing
 *  about how it got there. */
const keptCache = (...keys) => ({
  async match(url) {
    return keys.includes(url) ? { url } : null;
  },
  async keys() {
    return keys.map((url) => ({ url }));
  },
});

// `mediaCacheKey` resolves a path against the page's own origin; here that is
// the default a browser-less run falls back to.
const KEY = (variant, server = HERE) => `${HOST}/api/v1/media/${variant}?ms=${encodeURIComponent(server)}`;

const keptRecord = {
  id: "pl-1",
  name: "Offline songs",
  trackIds: [
    { trackId: "t1", variantId: "v1", title: "One" },
    { trackId: "t2", variantId: "v2", title: "Two" },
  ],
};

test("a kept playlist's songs come back with the URL the download wrote", async () => {
  const found = await keptEntries(keptRecord, {
    cache: keptCache(KEY("v1"), KEY("v2")),
    client: keptClient(),
  });
  assert.deepEqual(found.entries, [
    { trackId: "t1", variantId: "v1", title: "One", url: `/api/v1/media/v1?ms=${encodeURIComponent(HERE)}` },
    { trackId: "t2", variantId: "v2", title: "Two", url: `/api/v1/media/v2?ms=${encodeURIComponent(HERE)}` },
  ]);
  assert.deepEqual(found.missing, []);
  assert.equal(found.name, "Offline songs");
});

test("the cache's own keys are the answer when no client can name the backend", async () => {
  // A page opened with no server configured: the URL cannot be built, and the
  // entry the download wrote is found by the song it names.
  const found = await keptEntries(keptRecord, { cache: keptCache(KEY("v1", ELSEWHERE), KEY("v2", ELSEWHERE)) });
  assert.deepEqual(found.entries.map((entry) => entry.url), [
    `/api/v1/media/v1?ms=${encodeURIComponent(ELSEWHERE)}`,
    `/api/v1/media/v2?ms=${encodeURIComponent(ELSEWHERE)}`,
  ]);
});

test("a song the browser has evicted is missing rather than dropped", async () => {
  const found = await keptEntries(keptRecord, {
    cache: keptCache(KEY("v2")),
    client: keptClient(),
  });
  assert.deepEqual(found.entries.map((entry) => entry.trackId), ["t2"]);
  assert.deepEqual(found.missing, [{ trackId: "t1", variantId: "v1", title: "One" }]);
});

test("no cache at all is every song missing, not a failure", async () => {
  const found = await keptEntries(keptRecord, { cache: null, client: keptClient() });
  assert.deepEqual(found.entries, []);
  assert.equal(found.missing.length, 2);
  assert.deepEqual(await keptEntries(null, { cache: null }), { id: "", name: "", entries: [], missing: [] });
});

test("a playlist this browser does not keep is null, not an empty list", async () => {
  // Nothing has been kept in this process, so the index is empty - which is the
  // one answer that must not be confused with "kept, and the cache is empty".
  assert.equal(await playlistEntries("pl-1"), null);
});
