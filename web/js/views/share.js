// Sharing: a song with a friend, and a friend into a room.
//
// `shareTrack` is the one entry every song's ⋮ menu uses. The friend page opens
// it the other way round — the friend is already chosen, so you pick the song.
// Both ways end at the same place: `client.share(userId, {trackId|roomId})`.
//
// The pure helpers at the top are what the unit tests import this module for.

import { h, mount, dialog, toast, debounce, icon } from "../dom.js";
import { currentClient, banner, requireLogin } from "../app.js";
import { iconVersion, userIdOf } from "../state.js";

/** How far the follower may run from the friend before it seeks back. */
export const DRIFT_TOLERANCE_MS = 1500;
/** How often the friend's playback document is polled while following. */
export const FOLLOW_POLL_MS = 2000;
/** Typing searches without being asked, so wait for a pause first. */
const TYPING_PAUSE_MS = 400;
/** One letter is not worth a search; two is. */
const MIN_QUERY = 2;
const SEARCH_LIMIT = 25;

// --- pure helpers ----------------------------------------------------------

/** The name a person is shown under: their own, then their username. */
export function displayName(user) {
  const name = String(user?.displayName || "").trim();
  if (name) return name;
  const username = String(user?.username || user?.name || "").trim();
  return username || "Someone";
}

/**
 * A room's id, whichever shape it arrived in: the room state calls it `roomId`,
 * and the API's rooms call it `id`. They name the same room, and a caller that
 * only knows it has a room should not have to know which one it holds.
 */
export function roomIdOf(room) {
  return String(room?.roomId || room?.id || "").trim();
}

/** The API's `online` flag: they played something within the last five minutes. */
export function isOnline(user) {
  return Boolean(user?.online);
}

/**
 * The friends a search keeps: matched on the name they are shown under or on
 * their username, case and surrounding space ignored. An empty query keeps
 * everybody, which is the list before anyone types.
 */
export function filterFriends(friends, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  const list = Array.isArray(friends) ? friends : [];
  if (!needle) return list;
  return list.filter((friend) => {
    const name = displayName(friend).toLowerCase();
    const username = String(friend?.username || friend?.name || "").toLowerCase();
    return name.includes(needle) || username.includes(needle);
  });
}

/**
 * How a relationship reads beside a name. `none` has no label — it has a
 * button — so it answers with the empty string.
 */
const RELATIONSHIP_LABELS = {
  friend: "Already friends",
  "pending-out": "Request sent",
  "pending-in": "Wants to be your friend",
  ignored: "Ignored",
};

export function relationshipLabel(relationship) {
  return RELATIONSHIP_LABELS[String(relationship || "")] || "";
}

/**
 * One entry of a saved playback document as a playable track.
 *
 * The document is the client's own to shape, so both the queue entry's
 * `trackId` and a plain track's `id` are read: the friend may be running this
 * client or the GTK one, and the player takes API tracks either way.
 */
export function queueTrack(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.trackId || "");
  if (!id) return null;
  const artists = Array.isArray(raw.artists)
    ? raw.artists.map((name) => String(name))
    : raw.artist
      ? [String(raw.artist)]
      : [];
  const albums = Array.isArray(raw.albums) ? raw.albums.map((name) => String(name)) : [];
  return {
    id,
    title: String(raw.title || ""),
    artists,
    album: String(raw.album || albums[0] || ""),
    durationMs: Number(raw.durationMs) || 0,
    artworkUrl: String(raw.artworkUrl || ""),
  };
}

/**
 * What a person is listening to right now, out of their saved playback
 * document: the song playing now, by name, when the queue still names it.
 */
export function listeningLine(user) {
  const document = user?.listening;
  if (!document || typeof document !== "object") return "";
  const wanted = String(document.currentTrackId || "");
  if (!wanted) return "";
  const entries = Array.isArray(document.queue) ? document.queue : [];
  const entry = entries.find((raw) => raw && String(raw.trackId || raw.id || "") === wanted);
  if (!entry) return "\u266a Listening now";
  const track = queueTrack(entry);
  if (!track) return "\u266a Listening now";
  const artist = track.artists.join(", ") || track.album;
  return `\u266a ${track.title || wanted}${artist ? ` — ${artist}` : ""}`;
}

/** Online first, then by name — the order a people list reads in. */
export function compareFriends(left, right) {
  const online = Number(isOnline(right)) - Number(isOnline(left));
  if (online) return online;
  const byName = displayName(left).localeCompare(displayName(right), undefined, {
    sensitivity: "base",
  });
  if (byName) return byName;
  return String(left?.username || "").localeCompare(String(right?.username || ""), undefined, {
    sensitivity: "base",
  });
}

export function sortFriends(users = []) {
  return [...(users || [])].sort(compareFriends);
}

/**
 * What the follower should do, given where it is and where the friend is.
 *
 * Pause and resume win over position: they change what is heard, and a paused
 * friend is not "behind" — they are stopped. A friend who is not moving is the
 * one case with nothing to do, whatever the two positions say.
 */
export function driftDecision({
  localMs = 0,
  remoteMs = 0,
  localPaused = false,
  remotePaused = false,
  toleranceMs = DRIFT_TOLERANCE_MS,
} = {}) {
  const position = Number(remoteMs) || 0;
  if (remotePaused !== localPaused) {
    return { action: remotePaused ? "pause" : "resume", positionMs: position };
  }
  if (remotePaused) return { action: "none", positionMs: position };
  if (Math.abs(position - (Number(localMs) || 0)) > toleranceMs) {
    return { action: "seek", positionMs: position };
  }
  return { action: "none", positionMs: position };
}

// --- small builders --------------------------------------------------------

function column(gap = 10) {
  return { display: "flex", flexDirection: "column", gap: `${gap}px` };
}

/** A person's icon, or the initial of their name when they have none. */
export function avatarFor(client, user, className = "art round small") {
  // The server's own count of icon changes, not this browser's: somebody else's
  // new picture has to reach a page that never saw them upload it. The local
  // bump is the fallback for a payload that does not carry one.
  const version = Number(user?.iconVersion) || iconVersion(userIdOf(user));
  const source = user?.iconUrl
    ? client?.artworkUrl
      ? client.artworkUrl(user.iconUrl, version)
      : user.iconUrl
    : "";
  if (source) return h("img", { class: className, src: source, alt: "", loading: "lazy" });
  const initial = displayName(user).trim().charAt(0).toUpperCase() || "?";
  return h("div", {
    class: className,
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--fg3)",
      fontWeight: "600",
    },
    text: initial,
  });
}

function subtitleLine(text) {
  return text ? h("div", { class: "subtitle", text }) : null;
}

function personRow(client, user, onPick) {
  return h(
    "div",
    { class: "row clickable", onclick: onPick },
    avatarFor(client, user),
    h(
      "div",
      { style: { flex: 1, minWidth: 0 } },
      h("div", { class: "title", text: displayName(user) }),
      subtitleLine(user?.username ? `@${user.username}` : "")
    ),
    isOnline(user) ? h("span", { class: "status-dot online", title: "Online" }) : null
  );
}

function songRow(client, track, onPick) {
  const artists = (track?.artists || []).join(", ");
  return h(
    "div",
    { class: "row clickable", onclick: onPick },
    h(
      "div",
      {
        class: "art small",
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--fg4)",
        },
      },
      icon("note", 16)
    ),
    h(
      "div",
      { style: { flex: 1, minWidth: 0 } },
      h("div", { class: "title", text: track?.title || "" }),
      subtitleLine(artists)
    )
  );
}

function roomRow(room, onPick) {
  const count = Number(room?.memberCount) || 0;
  const members = `${count} member${count === 1 ? "" : "s"}`;
  return h(
    "div",
    { class: "row clickable", onclick: onPick },
    h(
      "div",
      { style: { flex: 1, minWidth: 0 } },
      h("div", { class: "title", text: room?.name || "Room" }),
      subtitleLine(room?.hasPassword ? `${members} \u00b7 locked` : members)
    )
  );
}

function report(error) {
  if (error?.status === 401) requireLogin();
  else banner(error?.message || String(error), "error");
}

// --- sharing ---------------------------------------------------------------

/**
 * Share a song, or — with the friend already chosen — pick one to send them.
 *
 * `shareTrack(track)` from a song's menu; `shareTrack(null, {friend})` from the
 * friend page.
 */
export async function shareTrack(track, { friend = null } = {}) {
  const client = currentClient();
  if (!client) return;
  if (track?.id) await chooseTarget(client, track);
  else if (friend) chooseSong(client, friend);
}

/** A friend picked: send the song, then say so. */
async function sendTrack(client, friend, track) {
  try {
    await client.share(friend.id, { trackId: track.id });
    toast(`Shared \u201c${track.title || "a song"}\u201d with ${displayName(friend)}.`);
  } catch (error) {
    report(error);
  }
}

async function loadFriends(client) {
  const payload = await client.friends();
  return Array.isArray(payload?.friends) ? payload.friends : [];
}

/** A song picked: who gets it, and the room option beside them. */
async function chooseTarget(client, track) {
  let friends = [];
  try {
    friends = await loadFriends(client);
  } catch (error) {
    report(error);
    return;
  }
  let close = null;
  const body = h(
    "div",
    { style: column(10) },
    h("p", { text: `Share \u201c${track.title || "this song"}\u201d with\u2026` })
  );
  body.appendChild(
    friends.length
      ? h(
          "div",
          { class: "list" },
          friends.map((friend) =>
            personRow(client, friend, () => {
              close?.();
              sendTrack(client, friend, track);
            })
          )
        )
      : h("p", { class: "subtitle", text: "You have no friends yet." })
  );
  body.appendChild(h("div", { class: "section-title", text: "A room" }));
  body.appendChild(
    h("p", { class: "subtitle", text: "A room is shared by inviting a friend into it." })
  );
  body.appendChild(
    h("button", {
      class: "btn",
      text: "Invite a friend to a room\u2026",
      onclick: () => {
        close?.();
        inviteSomeoneToRoom();
      },
    })
  );
  close = dialog({ title: "Share", body, actions: [{ label: "Close" }] }).close;
}

/** A friend already chosen: search the library and send them something. */
function chooseSong(client, friend) {
  let close = null;
  const input = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search your library\u2026",
  });
  const status = h("p", { class: "subtitle", text: "Search for a song to send." });
  const results = h("div", { class: "list", style: { display: "none" } });
  const body = h(
    "div",
    { style: column(12) },
    h("p", { text: `Share a song with ${displayName(friend)}.` }),
    input,
    status,
    results
  );
  close = dialog({ title: "Share a song", body, actions: [{ label: "Close" }] }).close;

  const search = debounce(async () => {
    const query = input.value.trim();
    mount(results);
    results.style.display = query ? "" : "none";
    if (query.length < MIN_QUERY) {
      status.textContent = "Search for a song to send.";
      return;
    }
    status.textContent = `Searching for \u201c${query}\u201d\u2026`;
    let groups = [];
    try {
      ({ groups } = await client.search(query, SEARCH_LIMIT));
    } catch (error) {
      status.textContent = error?.message || "The search failed.";
      return;
    }
    const tracks = (groups || []).map((group) => group?.track).filter((track) => track?.id);
    if (!tracks.length) {
      status.textContent = "Nothing matched that.";
      return;
    }
    status.textContent = `${tracks.length} song${tracks.length === 1 ? "" : "s"} to share.`;
    mount(
      results,
      tracks.map((track) =>
        songRow(client, track, () => {
          close?.();
          sendTrack(client, friend, track);
        })
      )
    );
  }, TYPING_PAUSE_MS);

  input.addEventListener("input", search);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") search();
  });
  input.focus();
}

/** Bring one friend into a room: pick the room. */
export async function inviteToRoom(user) {
  const client = currentClient();
  if (!client || !user?.id) return;
  let rooms = [];
  try {
    rooms = await client.rooms();
  } catch (error) {
    report(error);
    return;
  }
  let close = null;
  const body = h("div", { style: column(10) }, h("p", { text: `Invite ${displayName(user)} to a room.` }));
  body.appendChild(
    rooms.length
      ? h(
          "div",
          { class: "list" },
          rooms.map((room) =>
            roomRow(room, () => {
              close?.();
              sendRoomInvite(client, user, room);
            })
          )
        )
      : h("p", { class: "subtitle", text: "There are no rooms to invite them to." })
  );
  close = dialog({ title: "Invite to a room", body, actions: [{ label: "Cancel" }] }).close;
}

/** A room picked first: who to bring into it. */
async function inviteSomeoneToRoom() {
  const client = currentClient();
  if (!client) return;
  let rooms = [];
  try {
    rooms = await client.rooms();
  } catch (error) {
    report(error);
    return;
  }
  let close = null;
  const body = h("div", { style: column(10) }, h("p", { text: "Which room?" }));
  body.appendChild(
    rooms.length
      ? h(
          "div",
          { class: "list" },
          rooms.map((room) =>
            roomRow(room, () => {
              close?.();
              inviteFriendsToRoom(room);
            })
          )
        )
      : h("p", { class: "subtitle", text: "There are no rooms yet." })
  );
  close = dialog({ title: "Invite to a room", body, actions: [{ label: "Cancel" }] }).close;
}

/**
 * Bring friends into a room: pick as many as you like. A pick sends that person
 * an invite and marks their row sent, and the dialog stays open - inviting one
 * person is rarely the whole job.
 */
export async function inviteFriendsToRoom(room) {
  const client = currentClient();
  if (!client || !roomIdOf(room)) return;
  let friends = [];
  try {
    friends = await loadFriends(client);
  } catch (error) {
    report(error);
    return;
  }

  const invited = new Set();
  const rows = new Map();
  const list = h("div", { class: "list" });
  const search = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search friends",
    "aria-label": "Search friends",
  });

  // Only the list is redrawn, so typing never costs the search box its focus.
  const paint = () => {
    rows.clear();
    const shown = filterFriends(friends, search.value);
    mount(
      list,
      shown.length
        ? shown.map((friend) => {
            const row = personRow(client, friend, () => send(friend));
            rows.set(friend.id, row);
            if (invited.has(friend.id)) row.appendChild(sentMark());
            return row;
          })
        : [
            h("p", {
              class: "subtitle",
              text: friends.length ? "Nobody by that name." : "You have no friends yet.",
            }),
          ]
    );
  };

  const send = async (friend) => {
    if (invited.has(friend.id)) return;
    if (!(await sendRoomInvite(client, friend, room))) return;
    invited.add(friend.id);
    rows.get(friend.id)?.appendChild(sentMark());
  };

  search.addEventListener("input", paint);
  paint();

  dialog({
    title: "Invite to a room",
    closeButton: true,
    body: h(
      "div",
      { style: column(10) },
      h("p", { text: `Invite friends to ${room?.name || "the room"}.` }),
      search,
      list
    ),
    actions: [{ label: "Done" }],
  });
}

/** The mark a friend's row carries once their invite has gone. */
function sentMark() {
  return h("span", { class: "sent-mark", title: "Invite sent" }, icon("check", 14));
}

async function sendRoomInvite(client, friend, room) {
  const roomId = roomIdOf(room);
  if (!roomId) return false;
  try {
    await client.share(friend.id, { roomId });
  } catch (error) {
    report(error);
    return false;
  }
  toast(`Invited ${displayName(friend)} to ${room?.name || "the room"}.`);
  return true;
}
