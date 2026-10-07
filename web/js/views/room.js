// The room you are in: who is here, what is playing, and the queue.
//
// This view reads the room from rooms-state.js, which applies the socket events
// and keeps the shared player within two seconds of the host's queue position.

import { h, mount, clear, popover, toast, fmtDuration, icon, iconButton, scheduleFrame } from "../dom.js";
import { registerView, navigate, banner, currentClient, requireLogin } from "../app.js";
import { state, saveLocal } from "../state.js";
import { player } from "../player.js";
import { artworkTile, trackMenu } from "./playlist.js";
import { avatarFor, inviteFriendsToRoom } from "./share.js";
import { listDrag, dragHandle, roomQueueTrack, titleClass } from "./queue.js";
import {
  currentRoom,
  closedRoomReason,
  subscribe,
  leaveRoom,
  refreshRoom,
  myQueue,
  nameOf,
  mayDrive,
  isHost,
  positionMs,
  durationMs,
  remove,
  reorder,
  clear as clearRoomQueue,
  pause,
  resume,
  skip,
  vote,
  moveItem,
  followWithPlayer,
} from "../rooms-state.js";

const VOTE_LABELS = {
  1: "1 · bad",
  2: "2 · semi-bad",
  3: "3 · neutral",
  4: "4 · semi-good",
  5: "5 · great",
};

/** How often the clock on the page is refreshed while a room is on screen. */
const TICK_MS = 1000;

let host = null;
let ticker = 0;
let unsubscribe = null;
let hookedPlayer = false;
let positionLabel = null;

// Loaded with the app, this view attaches the shared player to the room. The
// host plays the mixed queue as its normal queue; every other member follows
// the host's current song and position wherever they navigate.
followWithPlayer(player);

// --- the view --------------------------------------------------------------

function render(container) {
  host = container;
  if (unsubscribe) unsubscribe();
  unsubscribe = subscribe(() => scheduleRedraw());
  watchPlayer();
  // Paint what we hold, then ask for the room as it stands: arriving from the
  // Rooms list, what we hold can be a snapshot from before somebody queued
  // anything, and nothing would tell us so until the next event.
  paint();
  refreshRoom().catch(() => {});
}

function refresh() {
  if (currentRoom()) refreshRoom().catch(report);
  paint();
}

const scheduleRedraw = scheduleFrame(() => {
  if (host && state.view === "room") paint();
});

function paint() {
  if (!host) return;
  stopTicker();
  positionLabel = null;
  const room = currentRoom();
  clear(host);

  if (!room) {
    const reason = closedRoomReason();
    mount(
      host,
      h(
        "div",
        { class: "empty" },
        h("span", { class: "icon" }, icon("room", 38)),
        h("span", { class: "title", text: "Not in a room" }),
        h("span", { text: reason || "Join one from Rooms, and this page follows it." }),
        h("button", { class: "btn suggested", text: "Go to Rooms", onclick: () => navigate("rooms") })
      )
    );
    return;
  }

  if (room.error) mount(host, h("div", { class: "banner error" }, h("span", { class: "grow", text: room.error })));
  mount(host, header(room), nowPlaying(room), members(room), queues(room));
  startTicker();
}

// --- pieces ----------------------------------------------------------------

function header(room) {
  const policy = room.controls === "everyone" ? "everyone can control playback" : "the host controls playback";
  const pieces = [
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", style: { fontSize: "20px", color: "var(--fg0)" }, text: room.name || "Room" }),
      h("div", { class: "subtitle", text: `${room.memberCount} listening · ${policy}` })
    ),
    h("button", {
      class: "btn",
      text: "Invite",
      title: `Invite friends to “${room.name}”`,
      onclick: () => inviteFriendsToRoom(room),
    }),
  ];
  pieces.push(h("button", { class: "btn destructive", text: "Leave", title: `Leave “${room.name}”`, onclick: () => leave() }));
  return h("div", { class: "card row", style: { padding: "14px 16px" } }, h("button", {
    class: "btn flat small",
    title: "Back to the rooms list",
    onclick: () => {
      state.roomsShowing = "list";
      saveLocal();
      navigate("rooms");
    },
  }, icon("prev", 16), "Rooms"), ...pieces);
}

/** The room's control policy is the host's to set: say so, and say the way out.
 *  Exported because the playbar's transport asks the room too, and needs the
 *  same words when the room says no. */
export function hostOnly(action) {
  toast(`Room set to “Host Control”, leave the room to ${action} the song.`);
}

function nowPlaying(room) {
  const current = room.current;
  const section = sectionBlock("Playing now");
  if (!current || !current.item) {
    section.appendChild(
      h("div", {
        class: "subtitle",
        style: { padding: "0 4px 8px" },
        text: "Nothing playing yet — queue something from search.",
      })
    );
    return section;
  }
  if (!current.started) {
    section.appendChild(
      h(
        "div",
        { class: "subtitle", style: { padding: "0 4px 8px" } },
        h("div", { class: "title", text: current.item.title }),
        h("div", {
          text: isHost(room)
            ? "Starting from the host's player."
            : "Waiting for the host's player.",
        })
      )
    );
    return section;
  }

  const line = h("div", { class: "subtitle" });
  positionLabel = line;
  const title = h("div", { class: "title", text: current.item.title });
  const text = h("div", { class: "grow" }, title, line);
  updateClock();

  const drives = mayDrive(room, room.me);
  // A room on host controls leaves these to the host. They stay clickable and
  // say why, rather than going dead: a disabled button cannot explain itself.
  const playPause = h(
    "button",
    {
      class: "btn",
      title: current.paused ? "Resume" : "Pause",
      "aria-disabled": drives ? null : "true",
      onclick: () => (drives ? act(() => (current.paused ? resume() : pause())) : hostOnly("pause")),
    },
    icon(current.paused ? "play" : "pause")
  );
  const next = h(
    "button",
    {
      class: "btn",
      title: "Skip to the next track",
      "aria-disabled": drives ? null : "true",
      onclick: () => (drives ? act(() => skip()) : hostOnly("skip")),
    },
    icon("next")
  );

  section.appendChild(
    h(
      "div",
      { class: "row", style: { border: "0", padding: "6px 0" } },
      text,
      h("div", { style: { display: "flex", gap: "6px" } }, playPause, next)
    )
  );
  section.appendChild(votes(room, current));
  return section;
}


function votes(room, current) {
  const mine = Number(current.votes[room.me] || 0);
  const buttons = [1, 2, 3, 4, 5].map((score) =>
    h("button", {
      class: `btn small ${mine === score ? "suggested" : ""}`.trim(),
      text: String(score),
      title: VOTE_LABELS[score],
      onclick: () => act(() => vote(score)),
    })
  );

  const cast = Object.keys(current.votes || {}).length;
  let summary = `mean ${Number(current.meanScore || 0).toFixed(2)} from ${cast} vote(s)`;
  if (cast && room.skip) {
    summary += ` · skips below ${room.skip.skipThreshold} with ${room.skip.minVotersForSkip}+ voters over ${Math.round(
      room.skip.voterFractionForSkip * 100
    )}%`;
  }
  return h(
    "div",
    { style: { padding: "0 4px 6px" } },
    h("div", { class: "row", style: { border: "0", padding: "6px 0" } }, buttons),
    h("div", { class: "subtitle", text: summary })
  );
}

function queues(room) {
  const mine = myQueue(room);
  const whole = room.masterQueue || [];
  const section = sectionBlock("Queue", "room-queue");
  // A phone shows the room's order alone, so say where your own songs went.
  section.appendChild(
    h("div", { class: "room-queue-hint", text: "Use popout queue to organize your songs" })
  );
  section.appendChild(
    h(
      "div",
      { class: "row", style: { border: "0", padding: "0 0 6px" } },
      h("span", { class: "grow" }),
      h("button", {
        class: "btn small",
        text: "Clear queue",
        title: "Drop everything from your queue",
        disabled: !mine.length,
        onclick: () => act(() => clearRoomQueue()),
      })
    )
  );
  // Both lists, side by side, the way the Queue page shows them: your songs and
  // the room's own play order. There is no toggle to forget, since neither list
  // can be hidden.
  section.appendChild(
    h(
      "div",
      { class: "queue-panels" },
      queuePanel(room, "My songs", mine, true),
      queuePanel(room, "Whole Room", whole, false)
    )
  );
  return section;
}

/** One column of the room's queue: a heading, then its rows. Your own rows drag
 *  into order; the room's own play order is read only. */
function queuePanel(room, heading, items, mine) {
  // The queue is what is coming: the playing item has the card above it.
  const playing = String(room.current?.item?.id || "");
  const upcoming = items.filter((item) => String(item.id || "") !== playing);
  const list = h("div", { class: "list" });
  const draggable = mine && upcoming.length > 1;
  const rows = upcoming.map((item, position) => queueRow(room, item, position, mine, draggable));
  rows.forEach((element) => list.appendChild(element));
  if (draggable) {
    const entries = upcoming.map((item) => ({ key: String(item.id || ""), item }));
    rows.forEach((element, position) => {
      listDrag({
        row: element,
        handle: element.querySelector(".drag-handle"),
        entry: entries[position],
        entries,
        onDrop: (from, to) => {
          const ids = myQueue(room).map((entry) => entry.id);
          act(() => reorder(moveItem(ids, from.item.id, to.item.id)));
        },
      });
    });
  }
  return h(
    "div",
    { class: "queue-panel", "data-panel": mine ? "mine" : "room" },
    h("div", { class: "title", style: { fontSize: "15px", fontWeight: "600" }, text: `${heading} · ${upcoming.length}` }),
    upcoming.length
      ? list
      : h(
          "div",
          { class: "empty" },
          h("span", { class: "icon" }, icon(mine ? "note" : "queue", 30)),
          h("span", { class: "title", text: mine ? "Queue a playlist or song through those tabs" : "Nothing in the room's order yet." })
        )
  );
}

function queueRow(room, item, index, mine, draggable = false) {
  // Only the room's own order is coloured by who queued each song: every row of
  // your own list is yours, and reads normally.
  const own = String(item.addedBy || "") === String(room.me || "");
  const row = h(
    "div",
    { class: "row", "data-key": String(item.id || "") },
    h("span", { class: "time", text: String(index + 1) }),
    artworkTile(currentClient(), item.artworkUrl),
    h(
      "div",
      { class: "grow" },
      h("div", { class: titleClass(!mine, own), text: item.title }),
      h("div", { class: "subtitle", text: `queued by ${nameOf(room, item.addedBy)}` })
    ),
    // The menu sits left of the remove button, the same way round as the
    // player's own queue, so both lists read the same.
    iconButton("dots", {
      title: "Song actions",
      class: "btn flat small",
      onclick: (event) => popover(event.currentTarget, trackMenu(roomQueueTrack(item))),
    }),
    mine
      ? iconButton("cross", {
          title: "Remove from your queue",
          class: "btn flat small",
          onclick: () => act(() => remove(item.id)),
        })
      : null,
    draggable ? dragHandle("Drag to reorder your queue") : null
  );

  return row;
}

function members(room) {
  const section = sectionBlock("Listening");
  const current = room.current;
  const list = h("div", { class: "list" });
  for (const member of room.members) {
    const marks = [];
    if (member.id === room.host) marks.push("host");
    if (member.id === room.me) marks.push("you");
    const score = current ? Number(current.votes[member.id] || 0) : 0;
    if (score) marks.push(`voted ${score}`);

    // "Next" is the first song the room will play from that queue, so the one
    // playing is not it - the queue list skips it the same way.
    const playing = String(current?.item?.id || "");
    const upcoming = (room.queues[member.id] || []).filter((item) => String(item.id || "") !== playing);
    const queued = upcoming.length
      ? ` · next: ${upcoming[0].title}${upcoming.length > 1 ? ` (+${upcoming.length - 1})` : ""}`
      : "";
    list.appendChild(
      h(
        "div",
        { class: "row" },
        // A rounded square, like every other tile in the app - `.art.round` is
        // what makes a circle, and a member's picture is not an exception.
        avatarFor(currentClient(), member, "art member"),
        h(
          "div",
          { class: "grow" },
          h("div", { class: "title", text: nameOf(room, member.id) }),
          h("div", { class: "subtitle", text: `${marks.length ? marks.join(", ") : "listening"}${queued}` })
        )
      )
    );
  }
  section.appendChild(list);
  return section;
}

function sectionBlock(title, extra = "") {
  return h("div", { class: `card ${extra}`.trim() }, h("div", { class: "section-title", text: title }));
}

// --- the moving parts ------------------------------------------------------

function watchPlayer() {
  if (hookedPlayer) return;
  hookedPlayer = true;
  player.on?.("position", () => updateClock());
}

function startTicker() {
  stopTicker();
  ticker = setInterval(updateClock, TICK_MS);
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = 0;
}

/** The clock under the title. The host's reported position is room time;
 *  while the local player is on the same song, show its actual playhead. */
export function roomClock(player, room, current, nowMs = Date.now()) {
  const local = player && typeof player.current === "function" ? player.current() : null;
  const here = Boolean(local && current && current.item && local.id === current.item.trackId);
  const roomLength = Math.max(0, durationMs(room));
  if (!here) return { positionMs: positionMs(room, nowMs), durationMs: roomLength };

  const position = typeof player.positionMs === "function" ? player.positionMs() : 0;
  // The file's own length, not the queue entry's: what this member hears is
  // measured from their own copy.
  const duration = typeof player.measuredDurationMs === "function" ? player.measuredDurationMs() : 0;
  return { positionMs: position, durationMs: duration > 0 ? duration : roomLength };
}

function updateClock() {
  const label = positionLabel;
  if (!label) return;
  if (state.view !== "room") {
    stopTicker();
    return;
  }
  const room = currentRoom();
  if (!room) return;
  const current = room.current;
  if (!current || !current.item) return;

  const clock = roomClock(player, room, current);
  label.textContent = `${fmtDuration(clock.positionMs)} / ${fmtDuration(clock.durationMs)}`;
}

// --- actions ---------------------------------------------------------------

function act(job) {
  Promise.resolve()
    .then(job)
    .catch(report);
}

function report(error) {
  if (error && error.status === 401) {
    requireLogin();
    return;
  }
  banner(error && error.message ? error.message : String(error), "error");
}

async function leave() {
  const room = currentRoom();
  const client = currentClient();
  if (!room || !client) {
    navigate("rooms");
    return;
  }
  const roomId = room.roomId;
  try {
    await leaveRoom({ client, roomId });
  } catch (error) {
    report(error);
  }
  toast("left the room");
  navigate("rooms");
}

registerView({
  id: "room",
  title: "Room",
  icon: "\u2302",
  order: 71,
  hidden: true,
  render,
  refresh,
  // Somebody's picture or name can change while this is open.
  live: true,
});
