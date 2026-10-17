// The room you are in: who is here, what is playing, and the queue.
//
// This view reads the room from rooms-state.js, which applies the socket events
// and keeps the shared player within two seconds of the room's position.

import { h, mount, clear, popover, toast, fmtDuration, icon, iconButton, scheduleFrame, panelHeading } from "../dom.js";
import { registerView, navigate, banner, currentClient, on, requireLogin } from "../app.js";
import { state, saveLocal } from "../state.js";
import { player } from "../player.js";
import { artworkTile, trackMenu } from "./playlist.js";
import { avatarFor, inviteFriendsToRoom } from "./share.js";
import { listDrag, dragHandle, roomQueueTrack, titleClass, heldBadge, orderFromPlaying, roomRowSubtitle, artistLine } from "./queue.js";
import {
  currentRoom,
  closedRoomReason,
  subscribe,
  leaveRoom,
  refreshRoom,
  myQueue,
  nameOf,
  mayDrive,
  positionMs,
  durationMs,
  remove,
  reorder,
  clear as clearRoomQueue,
  pause,
  resume,
  skip,
  vote,
  autoVoteCurrent,
  moveItem,
  followWithPlayer,
} from "../rooms-state.js";

const VOTE_LABELS = {
  1: "1 · bad",
  2: "2 · below average",
  3: "3 · neutral",
  4: "4 · good",
  5: "5 · great",
};

/** How often the clock on the page is refreshed while a room is on screen. */
const TICK_MS = 1000;

let host = null;
let ticker = 0;
let unsubscribe = null;
let unhookOnline = null;
let hookedPlayer = false;
let autoSkipLowRatings = false;
let votedItemId = "";
let votedRoomId = "";
// The line under the song saying where the room is in it. Module state because
// the redraw that writes it and the ticker that reads it are not the same call;
// undeclared, the assignment threw "assignment to undeclared variable" and the
// whole room view drew "This view could not be shown".
let positionLabel = null;

// Loaded with the app, this view attaches the shared player to the room. Every
// member follows the room's current song and position the same way wherever
// they navigate; the server is the clock.
followWithPlayer(player);

// --- the view --------------------------------------------------------------

function render(container) {
  host = container;
  // Both of these are subscriptions, and a view is rendered again every time
  // somebody navigates to it: without letting the last pair go, every visit
  // leaves another redraw behind for each beat of the room.
  if (unsubscribe) unsubscribe();
  unsubscribe = subscribe(() => {
    scheduleRedraw();
    autoVoteCurrentIfNeeded();
  });
  if (unhookOnline) unhookOnline();
  // Offline is said on the card, so the card has to be redrawn when it changes.
  unhookOnline = on("online-changed", () => scheduleRedraw());
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
async function autoVoteCurrentIfNeeded() {
  const room = currentRoom();
  if (!room?.current?.started) return;
  const itemId = String(room?.current?.item?.id || "");
  const roomId = String(room?.roomId || "");
  if (!itemId || (itemId === votedItemId && roomId === votedRoomId)) return;
  // Somebody who has already said what they think of this song is not overruled
  // by their own saved rating arriving a moment later: the automatic vote is a
  // convenience for a member who has not voted, not a replacement for one who
  // has.
  if (room.current.votes?.[room.me] != null) return;
  votedItemId = itemId;
  votedRoomId = roomId;
  try {
    await autoVoteCurrent(room, { autoSkip: autoSkipLowRatings });
  } catch (error) {
    console.warn("saved room rating failed", error);
  }
}

const scheduleRedraw = scheduleFrame(() => {
  if (host && state.view === "room") paint();
});

function paint() {
  if (!host) return;
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

  mount(
    host,
    // The room's own error, in the same mount as everything else: mounted on
    // its own first it was wiped by the mount below it before a frame could
    // draw it, so a room that lost its channel said nothing at all.
    room.error ? h("div", { class: "banner error" }, h("span", { class: "grow", text: room.error })) : null,
    header(room),
    nowPlaying(room),
    h("label", { class: "row room-policy-toggle" },
      h("input", { type: "checkbox", checked: autoSkipLowRatings, onchange: (event) => { autoSkipLowRatings = event.currentTarget.checked; } }),
      h("span", { text: "Auto-skip low ratings" })
    ),
    members(room),
    queues(room)
  );
  ensureTicker();
}

// --- pieces ----------------------------------------------------------------

function header(room) {
  const policy = room.controls === "everyone" ? "everyone can control playback" : "the host controls playback";
  const actions = h("div", { class: "room-card-actions" },
    h("button", { class: "btn", text: "Invite", title: `Invite friends to “${room.name}”`, onclick: () => inviteFriendsToRoom(room) }),
    h("button", { class: "btn destructive", text: "Leave", title: `Leave “${room.name}”`, onclick: () => leave() })
  );
  return h("div", { class: "card room-header" },
    h("div", { class: "room-card-heading" },
      h("button", { class: "btn flat small", title: "Back to the rooms list", onclick: () => {
        state.roomsShowing = "list";
        saveLocal();
        navigate("rooms");
      } }, icon("prev", 16), "Rooms"),
      actions
    ),
    h("div", { class: "room-title", text: room.name || "Room" }),
    h("div", { class: "subtitle", text: `${room.memberCount} listening · ${policy}` })
  );
}

/** The room's control policy is the host's to set: say so, and say the way out.
 *  Exported because the playbar's transport asks the room too, and needs the
 *  same words when the room says no. */
export function hostOnly(action) {
  toast(`Room set to “Host Control”, leave the room to ${action} the song.`);
}

function nowPlaying(room) {
  const current = room.current;
  const drives = mayDrive(room, room.me);
  const actions = h("div", { class: "room-card-actions" });
  if (current?.started) {
    actions.append(
      h("button", { class: "btn", title: current.paused ? "Resume" : "Pause", "aria-label": current.paused ? "Resume" : "Pause", "aria-disabled": drives ? null : "true", onclick: () => (drives ? act(() => (current.paused ? resume() : pause())) : hostOnly("pause")) }, icon(current.paused ? "play" : "pause")),
      h("button", { class: "btn", title: "Skip to the next track", "aria-label": "Skip to the next track", "aria-disabled": drives ? null : "true", onclick: () => (drives ? act(() => skip()) : hostOnly("skip")) }, icon("next"))
    );
  }
  section.appendChild(h("div", { class: "room-card-heading" }, h("div", { class: "section-title", text: "Playing now" }), actions));
  if (!current || !current.item) {
    section.appendChild(
      h("div", {
        class: "subtitle room-status-message",
        // A room with nothing on because nobody queued anything and a room with
        // nothing on because its channel is down look identical, and they want
        // opposite things: one wants a song, the other is already waiting. The
        // state knows which one this is.
        text:
          room.connected === false
            ? room.error || "The room's channel is down — reconnecting…"
            : "Nothing playing yet — queue something from search.",
      })
    );
    return section;
  }
  if (!current.started) {
    const artists = artistLine(current.item);
    section.appendChild(
      h(
        "div",
        { class: "subtitle room-status-message" },
        h("div", { class: "title", text: current.item.title }),
        ...(artists ? [h("div", { text: artists })] : []),
        h("div", { text: "Starting…" })
      )
    );
    return section;
  }

  const line = h("div", { class: "subtitle" });
  positionLabel = line;
  const title = h("div", { class: "title", text: current.item.title });
  const artists = artistLine(current.item);
  const credit = artists ? h("div", { class: "subtitle", text: artists }) : null;
  const offlineNow = player.online && !player.online()
    ? h("div", { class: "subtitle", text: "Offline — playing what is on this device." })
    : null;
  const text = h("div", { class: "grow" }, title, credit, line, offlineNow);
  updateClock();


  section.appendChild(h("div", { class: "room-now-playing-row" }, text));
  section.appendChild(votes(room, current));
  return section;
}


function votes(room, current) {
  const mine = Number(current.votes[room.me] || 0);
  const buttons = [1, 2, 3, 4, 5].map((score) =>
    h("button", {
      // A score is a decimal from 0.1 to 5.0, so the button a member pressed is
      // the one within a tenth of it - an exact match would drop the mark from
      // a rating saved as, say, 4.0 the moment anything rounded it.
      class: `btn small ${Math.abs(mine - score) < 0.05 ? "suggested" : ""}`.trim(),
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
    { class: "room-votes" },
    h("div", { class: "row room-vote-buttons" }, buttons),
    h("div", { class: "subtitle", text: summary })
  );
}

function queues(room) {
  const mine = myQueue(room);
  const whole = room.masterQueue || [];
  const section = sectionBlock("Queue", "room-queue");
  // A phone shows the room's order alone, so say where your own songs went.
  // The queue button is what opens them, and it is the one control that is
  // always on the screen: this used to name a "popout queue" that no part of
  // the app has ever had.
  section.appendChild(
    h("div", { class: "room-queue-hint", text: "Your own songs are in the Queue \u2014 the button at the bottom of the screen." })
  );
  section.appendChild(
    h(
      "div",
      { class: "room-queue-clear room-queue-clear-action" },
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
  //
  // The room's order now holds what comes next — the song on is held by the
  // room itself, not the order — so the playing item is put back on top of the
  // column, once, the way it has always looked.
  const playing = room.current?.item;
  const wholeWithCurrent =
    playing && !whole.some((item) => String(item.id) === String(playing.id))
      ? [playing, ...whole]
      : whole;
  section.appendChild(
    h(
      "div",
      { class: "queue-panels" },
      queuePanel(room, "My songs", mine, true),
      queuePanel(room, "Whole Room", wholeWithCurrent, false)
    )
  );
  return section;
}

/** One column of the room's queue: a heading, then its rows. Your own rows drag
 *  into order; the room's own play order is read only. */
function queuePanel(room, heading, items, mine) {
  // The list reads from the song that is on. Everything before it has played,
  // and drawing that prefix as the top of the queue is what made the room look
  // like it was playing two of one member's songs before another member's turn;
  // the playing row stays in the list, marked, so the order the room is really
  // following - one from each member per pass - is what the rows spell out.
  const playing = String(room.current?.item?.id || "");
  const ordered = orderFromPlaying(items, playing);
  const upcoming = ordered.items;
  const list = h("div", { class: "list" });
  const draggable = mine && upcoming.length > 1;   // the drop moves by id, so a sliced list is fine
  const rows = upcoming.map((item, position) =>
    queueRow(room, item, position, mine, draggable, ordered.at >= 0 && position === 0)
  );
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
    h("div", { class: "title room-queue-title", text: `${heading} · ${upcoming.length}` }),
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

function queueRow(room, item, index, mine, draggable = false, playingNow = false) {
  // Only the room's own order is coloured by who queued each song: every row of
  // your own list is yours, and reads normally.
  const own = String(item.addedBy || "") === String(room.me || "");
  const row = h(
    "div",
    {
      // A queue row is a row: the class carries the list's own layout and the
      // drop target a drag looks for (`.closest('.row')`), and `data-key` is
      // what the drop is matched by. Without either, the room's rows drew as
      // bare boxes that could not be dragged at all.
      class: playingNow ? "row now" : "row",
      "data-key": String(item.id || ""),
    },
    h("span", { class: "time", "aria-label": playingNow ? "Playing now" : `Queue position ${index + 1}` }, playingNow ? icon("play", 12) : String(index + 1)),
    h(
      "div",
      { class: "grow" },
      h("div", { class: titleClass(!mine, own), text: item.title }),
      h("div", {
        class: "subtitle",
        text: roomRowSubtitle(item, room, playingNow),
      })
    ),
    heldBadge(String(item.trackId || "")),
    // The plus queues the song and the menu holds its other actions, the same
    // way round as the player's own queue, so both lists read the same.
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
  return h("section", { class: `card ${extra}`.trim() }, panelHeading(title));
}

// --- the moving parts ------------------------------------------------------

function watchPlayer() {
  if (hookedPlayer) return;
  hookedPlayer = true;
  player.on?.("position", () => updateClock());
  player.on?.("offline-changed", () => scheduleRedraw());
  // Progress is filled in place by the queue view; redraw only when the room's
  // held state changes, avoiding full row rebuilds for every byte report.
  player.on?.("download-progress", () => {
    for (const mark of host?.querySelectorAll?.(".held.pending .dl") || []) {
      const id = mark.closest?.(".held")?.dataset.track || "";
      const fraction = player.offlineProgress?.(id);
      const value = Number(fraction);
      if (Number.isFinite(value)) mark.style.setProperty("--fill", `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`);
    }
  });
}

/** The clock under the title is a reading of the room's position, so it ticks
 *  once a second while this view is the one on screen. It is built on the way
 *  in and left alone by every repaint: building it in `paint` is what had it
 *  torn down and made again on each beat of the room, which reset the second
 *  and so rarely let it fire at all. */
function ensureTicker() {
  if (ticker || state.view !== "room" || !currentRoom()) return;
  ticker = setInterval(updateClock, TICK_MS);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = 0;
}

/** The clock under the title. The room's position is room time;
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
  const room = currentRoom();
  // A view is not told when it is left, so this is where the ticker finds out:
  // the second it wakes on is not one this clock is for any more.
  if (state.view !== "room" || !room) {
    stopTicker();
    return;
  }
  const label = positionLabel;
  if (!label) return;
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
    toast(`left ${room.name || "the room"}`);
  } catch (error) {
    // This page has let the room go either way; what failed is telling the
    // server, and "left the room" over that is the one thing that is not true.
    report(error);
  }
  navigate("rooms");
}

registerView({
  id: "room",
  title: "Room",
  icon: "home",
  order: 71,
  hidden: true,
  render,
  refresh,
  // Somebody's picture or name can change while this is open.
  live: true,
});
