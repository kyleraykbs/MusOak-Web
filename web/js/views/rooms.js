// Rooms: the ones on this server, and the way into one.
//
// Listen Together is one room at a time — this page opens it, and the page in
// room.js follows it. Both send their commands through rooms-state.js; neither
// talks to the socket itself.

import { h, mount, clear, dialog, toast, status, icon } from "../dom.js";
import { registerView, navigate, banner, requireLogin, currentClient } from "../app.js";
import { roomsTabTarget } from "../rooms-state.js";
import { state, saveLocal } from "../state.js";
import { player } from "../player.js";
import {
  enterRoom,
  leaveRoom,
  currentRoom,
  subscribe,
  enqueueMany,
  setBlockedNotice,
  setStatusNotice,
} from "../rooms-state.js";

// The room page registers itself; this module is what the shell loads. Its
// host-only notice is shared, since the playbar says the same thing.
import { hostOnly } from "./room.js";

// The bar's transport asks the room directly, so the room module is given the
// words to use when the room refuses. Registering here is enough: this module
// is loaded with the shell.
setBlockedNotice(hostOnly);
// And the same box for "the room is getting the track ready", which can take a
// while after a skip.
setStatusNotice(status);

/**
 * Open the room being followed, and remember that this is where the tab was
 * left: pressing Rooms again should come back here, not to the list.
 */
function showRoom() {
  state.roomsShowing = "room";
  saveLocal();
  navigate("room");
}

let host = null;
let listed = [];
let loading = false;
let unsubscribe = null;

function render(container, params = {}) {
  host = container;
  if (!unsubscribe) unsubscribe = subscribe(() => scheduleRedraw());
  paint();
  const wanted = params.roomId ? String(params.roomId) : "";
  if (wanted) {
    queueMicrotask(() => {
      // Arriving from an invitation or the player's room chip: already being in
      // the room means just showing it — no second join, no second password.
      const mine = currentRoom();
      if (mine && mine.roomId === wanted) navigate("room");
      else openRoom(wanted);
    });
  }
  loadRooms();
}

function refresh() {
  loadRooms();
}

function scheduleRedraw() {
  if (!host || state.view !== "rooms") return;
  queueMicrotask(() => {
    if (host && state.view === "rooms") paint();
  });
}

// --- the list --------------------------------------------------------------

function paint() {
  if (!host) return;
  clear(host);
  const room = currentRoom();
  mount(
    host,
    room ? followingCard(room) : null,
    openPanel(),
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "row", style: { border: "0", padding: "0 0 8px" } },
        h("span", { class: "section-title grow", text: "Rooms on this server" }),
        h("button", { class: "btn small", text: "Refresh", title: "Refresh", onclick: () => refresh() })
      ),
      roomList()
    )
  );
}

function openPanel() {
  const name = h("input", { class: "input", placeholder: "New room name" });
  const controls = h(
    "select",
    { class: "input", title: "Who may pause, skip and seek" },
    h("option", { value: "host", text: "Host controls" }),
    h("option", { value: "everyone", text: "Everyone controls" })
  );
  const password = h("input", {
    class: "input",
    type: "password",
    placeholder: "Password (optional)",
    autocomplete: "new-password",
    title: "Leave empty for a room anyone may join",
  });
  const create = () => createRoom(name, controls, password);

  name.addEventListener("keydown", (event) => {
    if (event.key === "Enter") create();
  });
  password.addEventListener("keydown", (event) => {
    if (event.key === "Enter") create();
  });

  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "form-row" },
      field("room-name", "Room", name),
      field("room-controls", "Controls", controls, { flex: "0 0 180px" }),
      field("room-password", "Password", password),
      h("button", { class: "btn suggested", text: "Create", onclick: create })
    )
  );
}

/** A labelled form field: the label points at the input. */
function field(id, label, input, style = null) {
  input.id = id;
  return h("div", { class: "field", style }, h("label", { for: id, text: label }), input);
}

function followingCard(room) {
  return h(
    "div",
    { class: "card row" },
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", text: room.name || "Room" }),
      h("div", { class: "subtitle", text: `following · ${room.memberCount} listening` })
    ),
    h("button", { class: "btn", text: "Open", onclick: () => showRoom() }),
    h("button", { class: "btn destructive", text: "Leave", onclick: () => leave(room.roomId) })
  );
}

function roomList() {
  if (loading && !listed.length) return h("div", { class: "subtitle", style: { padding: "8px 4px" }, text: "Loading…" });
  if (!listed.length) {
    return h(
      "div",
      { class: "empty", style: { padding: "20px" } },
      h("span", { class: "icon" }, icon("room", 38)),
      h("span", { class: "title", text: "No rooms yet" }),
      h("span", { text: "Create one above, or wait for someone else to open one." })
    );
  }

  const mine = currentRoom();
  const list = h("div", { class: "list" });
  for (const room of listed) {
    const following = mine && mine.roomId === room.id;
    list.appendChild(
      h(
        "div",
        { class: "row clickable", onclick: () => (following ? showRoom() : openRoom(room.id)) },
        h(
          "div",
          { class: "grow" },
          h("div", { class: "title", text: `${room.name} (${room.memberCount ?? (room.members || []).length})` }),
          h("div", { class: "subtitle", text: (following ? "following · " : "") + describeRoom(room) })
        ),
        room.hasPassword ? h("span", { class: "tag", text: "password" }) : null,
        h("button", {
          class: following ? "btn destructive small" : "btn small",
          text: following ? "Leave" : "Join",
          title: `${following ? "Leave" : "Join"} “${room.name}”`,
          onclick: (event) => {
            event.stopPropagation();
            if (following) leave(room.id);
            else openRoom(room.id);
          },
        })
      )
    );
  }
  return list;
}

/** One line about a room, for the list. */
function describeRoom(room) {
  const parts = [`${room.memberCount ?? (room.members || []).length} listening`];
  const current = room.current;
  if (current && current.item) parts.push(`playing ${current.item.title}`);
  else if ((room.queue || []).length) parts.push(`${room.queue.length} queued`);
  if (room.controls === "everyone") parts.push("everyone controls");
  return parts.join(" · ");
}

// --- data ------------------------------------------------------------------

async function loadRooms() {
  const client = currentClient();
  if (!client) {
    listed = [];
    paint();
    return;
  }
  loading = true;
  try {
    listed = await client.rooms();
  } catch (error) {
    listed = [];
    report(error);
  } finally {
    loading = false;
  }
  if (host && state.view === "rooms") paint();
}

// --- actions ---------------------------------------------------------------

function report(error) {
  if (error && error.status === 401) {
    requireLogin();
    return;
  }
  banner(error && error.message ? error.message : String(error), "error");
}

function createRoom(nameInput, controlsSelect, passwordInput) {
  const client = currentClient();
  const name = nameInput.value.trim();
  if (!client) {
    banner("choose a server first", "error");
    return;
  }
  if (!name) {
    banner("a room needs a name", "error");
    return;
  }
  const controls = controlsSelect.value === "everyone" ? "everyone" : "host";
  const password = passwordInput.value;
  nameInput.value = "";
  passwordInput.value = "";
  Promise.resolve()
    .then(async () => {
      const payload = await client.createRoom(name, controls, password);
      const room = payload?.room || {};
      await join(room.id || "", password, room.name || name);
      loadRooms();
    })
    .catch(report);
}

/** Open a room by id: the notification bell lands here. */
async function openRoom(roomId) {
  const client = currentClient();
  if (!client) return;
  try {
    const room = await client.room(roomId);
    if (room.hasPassword) askPassword(room, {});
    else await join(roomId, "", room.name);
  } catch (error) {
    report(error);
  }
}

/** Ask for the room's password, and say why the last one was wrong. */
function askPassword(room, { password = "", error = "" } = {}) {
  const input = h("input", {
    class: "input",
    type: "password",
    placeholder: "Password",
    "aria-label": "Password",
    value: password,
    autocomplete: "current-password",
  });
  const submit = async () => {
    try {
      await join(room.id, input.value, room.name);
    } catch (failure) {
      askPassword(room, { password: input.value, error: failure.message || "could not join" });
    }
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
  });
  dialog({
    title: `Join “${room.name}”`,
    body: h(
      "div",
      { class: "field" },
      h("p", { text: "This room has a password." }),
      input,
      error ? h("span", { style: { color: "var(--red)" }, text: error }) : null
    ),
    actions: [{ label: "Cancel" }, { label: "Join", class: "suggested", onClick: submit }],
    onOpen: () => input.focus(),
  });
}

/**
 * Join a room and put the player under its orders: while we are in one,
 * playing a song anywhere queues it for the room instead.
 */
async function join(roomId, password, name) {
  const client = currentClient();
  if (!client) throw new Error("choose a server first");
  const room = await enterRoom({
    client,
    roomId,
    password,
    onLeave: () => player.clearRoom(),
  });
  // The player's room - and its transport hooks - are set by the room module
  // itself, so that a reload which restores a room gets them too.
  toast(`joined ${room.name || name}`);
  showRoom();
  return room;
}

async function leave(roomId) {
  const client = currentClient();
  if (!client) return;
  const mine = currentRoom();
  try {
    await leaveRoom({ client, roomId });
  } catch (error) {
    report(error);
  }
  if (mine && mine.roomId === roomId) toast("left the room");
  loadRooms();
}

registerView({
  // People are what this shows, so it re-reads them on the notification tick.
  live: true,
  id: "rooms",
  title: "Rooms",
  icon: "\u2302",
  order: 70,
  render,
  refresh,
  // The tab opens the room being followed unless the list is where it was left,
  // and it stays lit while that room is on screen.
  to: roomsTabTarget,
  also: ["room"],
});
