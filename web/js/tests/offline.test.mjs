// The offline module's pure logic: what a media URL is called in the cache,
// what a set of kept songs adds up to, and which are still missing. No DOM.
import test from "node:test";
import assert from "node:assert/strict";

import { mediaCacheKey, queueOrder, totalBytes, plannedFetches } from "../offline.js";

const HERE = "https://music.example.com";
const ELSEWHERE = "https://other.example.com";
const ROUTER = "http://localhost:8080";

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
