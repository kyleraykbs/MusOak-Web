// The shell's state: which backends the picker offers, and what it does with a
// deployment that configured none. A null list here used to kill the click that
// opens the picker.
import test from "node:test";
import assert from "node:assert/strict";

// The shell keeps its state in localStorage; Node has none, so this file brings
// its own before the module reads it.
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

import { state, knownServers, rememberServer, forgetServer, serverLabel, serverId, sessionFor } from "../state.js";

const reset = () => {
  state.config = { defaultServer: "", loginPopup: false, servers: [], allowCustomServer: true };
  state.servers = [];
  state.server = "";
  state.sessions = {};
};

test("a deployment with no servers configured offers none, and does not throw", () => {
  reset();
  state.config.servers = null; // what a Go nil slice marshals to
  assert.deepEqual(knownServers(), []);
});

test("the configured servers come first, then the ones this browser added", () => {
  reset();
  state.config.servers = [
    { name: "Living room", url: "https://music.example.com" },
    { name: "Laptop", url: "https://laptop.example.com/" },
  ];
  rememberServer({ url: "http://10.0.0.5:8099", name: "Bench" });

  const list = knownServers();
  assert.deepEqual(list.map((entry) => entry.name), ["Living room", "Laptop", "Bench"]);
  assert.deepEqual(list.map((entry) => entry.url), [
    "https://music.example.com",
    "https://laptop.example.com", // the trailing slash never survives
    "http://10.0.0.5:8099",
  ]);
});

test("the same backend listed and remembered appears once", () => {
  reset();
  state.config.servers = [{ name: "Living room", url: "https://music.example.com" }];
  rememberServer({ url: "https://music.example.com/" });
  assert.equal(knownServers().length, 1);
});

test("a server without a name falls back to its host, and a session is per backend", () => {
  reset();
  state.config.servers = null;
  rememberServer({ url: "https://music.example.com" });
  assert.equal(knownServers()[0].name, "music.example.com");
  assert.equal(serverLabel("https://music.example.com"), "music.example.com");
  assert.equal(serverLabel("not a url"), "not a url");

  state.sessions[serverId("https://music.example.com")] = { token: "abc" };
  assert.equal(sessionFor("https://music.example.com").token, "abc");
  assert.equal(sessionFor("https://elsewhere.example.com").token, "");
});

test("removing a server takes it out of the list, forgets its sign-in, and sticks", () => {
  reset();
  state.config.servers = [{ name: "Configured", url: "https://music.example.com" }];
  rememberServer({ url: "http://10.0.0.5:8099", name: "Bench" });
  state.sessions[serverId("https://music.example.com")] = { token: "abc" };
  state.sessions[serverId("http://10.0.0.5:8099")] = { token: "def" };
  state.server = "https://music.example.com";

  forgetServer("https://music.example.com");

  assert.deepEqual(knownServers().map((entry) => entry.url), ["http://10.0.0.5:8099"]);
  assert.equal(sessionFor("https://music.example.com").token, "");
  assert.equal(state.server, "");
  // Configured servers come back from the deployment on every load, so the
  // removal has to be remembered rather than derived.
  assert.deepEqual(state.hiddenServers, ["https://music.example.com"]);

  state.config.servers = [{ name: "Configured", url: "https://music.example.com" }];
  assert.deepEqual(knownServers().map((entry) => entry.url), ["http://10.0.0.5:8099"]);

  // Adding it back is how you undo it.
  rememberServer({ url: "https://music.example.com" });
  assert.deepEqual(knownServers().map((entry) => entry.url).sort(), [
    "http://10.0.0.5:8099",
    "https://music.example.com",
  ]);
  assert.deepEqual(state.hiddenServers, []);
});

test("removing a server that is not the current one leaves the session alone", () => {
  reset();
  rememberServer({ url: "https://music.example.com", name: "Home" });
  rememberServer({ url: "https://other.example.com", name: "Other" });
  state.sessions[serverId("https://other.example.com")] = { token: "keep" };
  state.server = "https://music.example.com";

  forgetServer("https://other.example.com");

  assert.equal(state.server, "https://music.example.com");
  assert.deepEqual(knownServers().map((entry) => entry.name), ["Home"]);
  assert.equal(sessionFor("https://other.example.com").token, "");
});

test("the removed list survives a reload", () => {
  reset();
  state.hiddenServers = [];
  rememberServer({ url: "https://music.example.com" });
  forgetServer("https://music.example.com");
  const stored = globalThis.localStorage.getItem("musoak-web");
  assert.match(stored, /hiddenServers/);
  assert.match(stored, /music\.example\.com/);
});
