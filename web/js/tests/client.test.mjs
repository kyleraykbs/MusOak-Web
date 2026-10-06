// The client's contract with the router: which backend a call names, what a
// failure looks like, and which source wins. Pure logic, no DOM.
import test from "node:test";
import assert from "node:assert/strict";

import { Client, ServerError, randomId } from "../client.js";

const BACKEND = "https://music.example.com";

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

test("every call names its backend in a header", async () => {
  const calls = stubFetch(() => jsonResponse({ tracks: [] }));
  const client = new Client({ server: BACKEND, token: "t0ken" });

  await client.favorites();

  assert.equal(calls[0].url, "/api/v1/me/favorites");
  assert.equal(calls[0].init.headers["X-Musoak-Server"], BACKEND);
  assert.equal(calls[0].init.headers.Authorization, "Bearer t0ken");
});

test("a backend URL keeps its routing when it is handed to an element", () => {
  const client = new Client({ server: BACKEND });

  const media = client.mediaUrl("variant-1");
  assert.match(media, /^\/api\/v1\/media\/variant-1\?ms=/);
  assert.equal(new URLSearchParams(media.split("?")[1]).get("ms"), BACKEND);

  const art = client.artworkUrl("/api/v1/artwork/abc");
  assert.equal(new URLSearchParams(art.split("?")[1]).get("ms"), BACKEND);

  // Somewhere else entirely: leave it alone.
  assert.equal(client.artworkUrl("https://cdn.example.com/a.jpg"), "https://cdn.example.com/a.jpg");
  assert.equal(client.artworkUrl(""), "");
});

test("a failing call becomes a ServerError with the server's words", async () => {
  stubFetch(() => jsonResponse({ error: "wrong password" }, 403));
  const client = new Client({ server: BACKEND });

  await assert.rejects(() => client.joinRoom("r1", "nope"), (error) => {
    assert.ok(error instanceof ServerError);
    assert.equal(error.status, 403);
    assert.equal(error.message, "wrong password");
    assert.equal(error.unauthorized, false);
    return true;
  });
});

test("a 401 is recognisable, so the shell can ask for a sign-in", async () => {
  stubFetch(() => jsonResponse("nope", 401));
  const client = new Client({ server: BACKEND });

  await assert.rejects(() => client.me(), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.unauthorized, true);
    return true;
  });
});

test("a backend that cannot be reached is not a crash", async () => {
  globalThis.fetch = async () => {
    throw new Error("connection refused");
  };
  const client = new Client({ server: BACKEND });

  await assert.rejects(() => client.providers(), (error) => {
    assert.equal(error.status, 0);
    assert.match(error.message, /cannot reach .*music\.example\.com/);
    return true;
  });
});

test("the account's provider order decides the source", async () => {
  const client = new Client({ server: BACKEND });
  client.ranking = async () => ({ effective: ["ytmusic", "spotify"] });

  const picked = await client.pickVariant([
    { id: "s1", provider: "spotify" },
    { id: "y1", provider: "ytmusic" },
  ]);
  assert.equal(picked.id, "y1");

  // An explicit preference outranks any order.
  const preferred = await client.pickVariant(
    [{ id: "s1", provider: "spotify" }, { id: "y1", provider: "ytmusic" }],
    "s1"
  );
  assert.equal(preferred.id, "s1");
});

test("with no order at all the first variant is played", async () => {
  const client = new Client({ server: BACKEND });
  client.ranking = async () => ({});

  const picked = await client.pickVariant([{ id: "only", provider: "local" }]);
  assert.equal(picked.id, "only");
  assert.equal(await client.pickVariant([]), null);
});

test("a room socket names its backend, since headers are impossible there", () => {
  const sent = [];
  class FakeSocket {
    constructor(url) {
      sent.push(url);
      this.readyState = 1;
    }
    addEventListener() {}
    send() {}
    close() {}
  }
  const original = globalThis.WebSocket;
  globalThis.WebSocket = FakeSocket;
  globalThis.location = { protocol: "http:", host: "web.example.com" };
  try {
    const client = new Client({ server: BACKEND, memberId: "m1", memberName: "web" });
    client.roomSocket({ roomId: "r1" });
    const url = new URL(sent[0]);
    assert.equal(url.pathname, "/api/v1/ws");
    assert.equal(url.searchParams.get("ps"), BACKEND);
    assert.equal(url.searchParams.get("roomId"), "r1");
    assert.equal(url.searchParams.get("memberId"), "m1");
  } finally {
    globalThis.WebSocket = original;
  }
});

test("room commands go to the room's own endpoints", async () => {
  const calls = stubFetch(() => jsonResponse({ id: "r1", members: [] }));
  const client = new Client({ server: BACKEND });

  const room = await client.roomEnqueue("r1", "t1");
  assert.equal(calls[0].url, "/api/v1/rooms/r1/queue");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { trackId: "t1" });
  // A bare snapshot is the room, not a wrapper around it.
  assert.equal(room.id, "r1");

  await client.roomRemove("r1", "item 1");
  assert.equal(calls[1].url, "/api/v1/rooms/r1/queue/item%201");
  assert.equal(calls[1].init.method, "DELETE");

  await client.roomReorder("r1", ["a", "b"]);
  assert.deepEqual(JSON.parse(calls[2].init.body), { itemIds: ["a", "b"] });

  await client.roomVote("r1", 4);
  assert.deepEqual(JSON.parse(calls[3].init.body), { score: 4 });
  assert.equal(calls[3].url, "/api/v1/rooms/r1/vote");

  await client.roomStarted("r1", "t1", 0, 180000);
  assert.deepEqual(JSON.parse(calls[4].init.body), { trackId: "t1", positionMs: 0, durationMs: 180000 });
  assert.equal(calls[4].url, "/api/v1/rooms/r1/started");

  await client.roomEnded("r1", "t1", "i1");
  assert.equal(calls[5].url, "/api/v1/rooms/r1/ended");
  assert.deepEqual(JSON.parse(calls[5].init.body), { trackId: "t1", itemId: "i1" });

  await client.roomSeek("r1", 5000);
  assert.equal(calls[6].url, "/api/v1/rooms/r1/seek");

  await client.roomClearQueue("r1", "m2");
  assert.equal(calls[7].url, "/api/v1/rooms/r1/queue?memberId=m2");
});

test("a joined room is unwrapped from its envelope", async () => {
  stubFetch(() => jsonResponse({ room: { id: "r9" }, memberId: "m1" }));
  const client = new Client({ server: BACKEND });
  const joined = await client.joinRoom("r9", "secret");
  assert.equal(joined.room.id, "r9");
  assert.equal(joined.memberId, "m1");

  stubFetch(() => jsonResponse({ room: { id: "r9" } }));
  assert.equal((await client.room("r9")).id, "r9");
});

test("the saved playback document comes back as the document", async () => {
  const document = { queue: [{ trackId: "t1" }], currentTrackId: "t1", positionMs: 5000, paused: true };
  const calls = stubFetch(() => jsonResponse({ state: document }));
  const client = new Client({ server: BACKEND });

  assert.deepEqual(await client.playbackState(), document);
  await client.savePlaybackState(document);
  assert.equal(calls[1].url, "/api/v1/me/playback");
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(JSON.parse(calls[1].init.body), { state: document });

  // An account that never played anything answers with nothing to pick up.
  stubFetch(() => jsonResponse({}));
  assert.deepEqual(await client.playbackState(), {});
});

test("a member id is made even where the browser has no crypto.randomUUID", (t) => {
  // A page served over plain http at a LAN address is not a secure context, and
  // the browser leaves randomUUID undefined there. Asking for one anyway threw
  // during boot and left the shell with no views at all.
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  t.after(() => delete crypto.randomUUID);

  assert.match(randomId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
