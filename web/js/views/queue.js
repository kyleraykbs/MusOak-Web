// The play queue: what is playing, what comes next, and — in a room — what
// that room will play.
//
// This is the lowest of the three collection views, so the pieces the other two
// share (the index math of a reorder, a track's artist line, how a failed call
// is reported, how a list is handed to the player) live here; playlist.js and
// favourites.js import them. The one exception runs the other way: a queue row's
// own menu is the playlist view's, imported where it is opened, so the two
// cannot drift apart.
//
// Which queue is shown is decided by room state rather than by the player:
// while a room session is live (rooms-state holds a current room, which is the
// same moment the shell tells the player about it with setRoom) the room's own
// queue and its fair master order are what plays, and the local queue is not
// running. The room's state is read from rooms-state, never from a socket of
// our own.

import { fmtDuration, h, icon, iconButton, iconOr, mount, popover, scheduleFrame, tapOnly, toast, artworkImage } from "../dom.js";
import { banner, currentClient, inBrowser, navigate, on, registerView, requireLogin } from "../app.js";
import { player } from "../player.js";
import {
  clear as clearRoom,
  currentRoom,
  enqueue,
  myQueue,
  nameOf,
  remove as removeRoomItem,
  reorder as reorderRoom,
  subscribe,
} from "../rooms-state.js";

registerView({
  id: "queue",
  title: "Queue",
  icon: "note",
  order: 40,
  // The page and the playbar's drawer show the same list, from the same place.
  render: (container) => renderQueue(container),
  refresh: paint,
});

// The playbar's shuffle button cannot shuffle a room's queue itself - the local
// queue is not what plays there - so it asks, and the shuffle happens here,
// beside the helper that does it.
if (inBrowser) {
  window.addEventListener("musoak:shuffle-my-queue", () => {
    const room = currentRoom();
    if (!room) return;
    const ids = myQueue(room).map((item) => item.id);
    if (ids.length < 2) return;
    run(() => reorderRoom(shuffleItems(ids)));
  });
}

// --- the pure parts --------------------------------------------------------

/** "Artist, Artist two" — what a row shows under a title. */
export function artistLine(item) {
  const artists = item?.artists;
  if (Array.isArray(artists)) return artists.filter(Boolean).join(", ");
  return String(artists || "");
}

/**
 * The line under a room queue row's title: the artist when the row knows one,
 * then who put it there. Both of the room's lists build their subtitle here so
 * they cannot drift apart.
 */
export function roomRowSubtitle(item, room, playingNow = false) {
  const by = playingNow
    ? `playing now · queued by ${nameOf(room, item.addedBy)}`
    : `queued by ${nameOf(room, item.addedBy)}`;
  const artists = artistLine(item);
  return artists ? `${artists} · ${by}` : by;
}

/**
 * The list with one item moved: moveItem([a, b, c], 0, 2) is [b, c, a].
 *
 * A destination past either end lands at that end, and the result is a new
 * list: the one handed in is never touched, because the caller may be an array
 * the player owns. Moving a single step up or down is the same call with
 * `from - 1` or `from + 1`.
 */
export function moveItem(list, from, to) {
  const items = Array.from(list || []);
  if (items.length < 2) return items;
  const start = clampIndex(from, items.length);
  const end = clampIndex(to, items.length);
  if (start === end) return items;
  const [moved] = items.splice(start, 1);
  items.splice(end, 0, moved);
  return items;
}

function clampIndex(index, length) {
  const value = Number(index);
  const whole = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.min(Math.max(whole, 0), length - 1);
}

/** A shuffled copy, from a random source the caller can pin down in a test. */
export function shuffleItems(list, random = Math.random) {
  const items = Array.from(list || []);
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}

/**
 * Everything the queue list shows, as data: the player's own queue, or — in a
 * room — the caller's own room queue or the room's fair master order. Pure, so
 * the rows are testable without a DOM; the view only adds buttons to them.
 */
export function queueProjection({ room = null, showMaster = false, playerQueue = [], currentIndex = -1 } = {}) {
  if (room) {
    const master = Boolean(showMaster);
    const items = master ? room.masterQueue || [] : myQueue(room);
    // The queue is what is coming, not what is on: the playing item has its own
    // card above, and leaving it in the list makes the numbers lie about what
    // is next - and it is the one row nobody may move.
    const playing = String(room.current?.item?.id || "");
    const order = items.map((item) => String(item.id || ""));
    // Where each item sits, so a row's place is a lookup and not a scan of the
    // whole queue for every row.
    const places = new Map(order.map((id, at) => [id, at]));
    const upcoming = items.filter((item) => String(item.id || "") !== playing);
    return {
      mode: "room",
      showMaster: master,
      label: master ? "Room queue" : "Queue",
      count: upcoming.length,
      // A room reorders by naming its whole queue, so the actions need every
      // item in order, the hidden one included.
      order,
      // The master order is the room's; only your own queue is yours to shape.
      editable: !master,
      empty: master ? "Nothing in the room's order yet." : "Queue a playlist or song through those tabs",
      emptyHint: "",
      rows: upcoming.map((item, position) => ({
        key: String(item.id || `item-${position}`),
        // `index` is the item's real place in the queue, which is what the
        // reorder needs; `number` is the place the row shows.
        index: places.get(String(item.id || "")),
        number: position + 1,
        title: item.title,
        subtitle: roomRowSubtitle(item, room),
        time: 0,
        artwork: String(item.artworkUrl || ""),
        playing: false,
        itemId: item.id,
        // The track the row is about, beside the queue item it is: the item id
        // is not the track id, and anything that looks a song up - the copy this
        // device holds, an artist's page - means the track.
        trackId: String(item.trackId || ""),
        track: roomQueueTrack(item),
        // The row says who put it there, which the list shows as a colour.
        mine: String(item.addedBy || "") === String(room.me || ""),
      })),
    };
  }

  const tracks = Array.from(playerQueue || []);
  return {
    mode: "player",
    showMaster: false,
    label: "Queue",
    count: tracks.length,
    editable: true,
    empty: "Nothing queued",
    emptyHint: "Play something to fill this.",
    rows: tracks.map((track, index) => ({
      key: String(track?.id || `track-${index}`),
      index,
      number: index + 1,
      title: String(track?.title || ""),
      subtitle: artistLine(track),
      artistId: String((track?.artistIds || [])[0] || ""),
      time: Number(track?.durationMs || 0),
      artwork: String(track?.artworkUrl || ""),
      playing: index === currentIndex,
      itemId: "",
      // The row's own track, which is what its menu acts on.
      track,
    })),
  };
}

/**
 * A room queue item as the track a menu acts on: the menu knows the canonical
 * track's id, title and artists, not the queue row's own id.
 */
export function roomQueueTrack(item) {
  return {
    id: String(item?.trackId || ""),
    title: item?.title || "",
    artistIds: Array.isArray(item?.artistIds) ? item.artistIds : [],
    artworkUrl: item?.artworkUrl || "",
  };
}

/** Every view reports a failed call the same way: ask for a login, or say so. */
export function reportError(error) {
  if (error?.status === 401) {
    requireLogin();
    return;
  }
  banner(error?.message || String(error), "error");
}

/** Provider problems as quiet lines. A provider that failed says so without
 *  taking the results that did arrive down with it. */
export function providerErrorLines(problems = []) {
  return (problems || []).map(
    (problem) => `${problem?.provider || "a provider"}: ${problem?.error || "failed"}`
  );
}

// --- what a list of tracks does --------------------------------------------

/** How far a pointer may move before a press on a row counts as a drag. */
const DRAG_SLOP = 6;

/** Play a list from one of its entries. In a room the player queues it there.
 *
 * `playlistId` says which playlist the tracks came from, so a restored session
 * can reopen the one that was playing; anywhere else passes nothing, which
 * clears it. Only starting playback touches it — queuing does not.
 */
export function playTracks(tracks, index = 0, { playlistId = "" } = {}) {
  player.setContext({ playlistId: playlistId || "" });
  player.play(Array.from(tracks || []), index);
}

/** What clicking a song in a list does: that song, and nothing else.
 *
 * A list of songs is a menu of them, not a set to adopt: wanting the rest is
 * what the queue and shuffle buttons are for, and a click that quietly takes
 * the whole playlist makes every later choice a position in a list nobody asked
 * to be in. */
export function playOne(tracks, position = 0, { playlistId = "" } = {}) {
  const list = Array.from(tracks || []);
  const track = list[Math.max(0, Math.min(position, list.length - 1))];
  if (!track) return;
  playTracks([track], 0, { playlistId });
}

/** Add a list to the end of what is already queued. */
export function enqueueTracks(tracks) {
  player.enqueue(Array.from(tracks || []));
}

/** Put a list at the front of the queue, right after what is playing now. */
export function queueNextTracks(tracks) {
  player.playNext(Array.from(tracks || []));
}

/**
 * Put one song on the end of the queue that will play it: the room's own queue
 * while a room session is live, and this device's queue otherwise.
 *
 * In a room the room decides what plays, so a song that only reached the local
 * queue would never be heard; `enqueue` is the same path the room's own queue
 * is added through, and the player's own queue is not the one running there.
 */
export function queueTrack(track) {
  if (!track?.id) return;
  const name = `\u201c${track.title || "the song"}\u201d`;
  if (currentRoom()) {
    run(() => enqueue(track));
    toast(`Queued ${name} in the room`);
    return;
  }
  enqueueTracks([track]);
  toast(`Queued ${name}`);
}

/**
 * The "+" a song's row carries, wherever a song is listed: search results, a
 * playlist, an album, a room's queue and the queue page alike.
 *
 * One control, one reading: the same plus, the same "Queue" tooltip, and the
 * same place, just before the row's own menu. A press queues and does nothing
 * else, so it is stopped before the row's click - it neither plays the song nor
 * opens the menu it sits beside. `class` follows the row's menu, which is the
 * one thing the lists do not already agree on.
 */
export function queueButton(track, { class: className = "btn flat small" } = {}) {
  return iconButton("plus", {
    title: "Queue",
    class: className,
    onclick: (event) => {
      event.stopPropagation();
      event.preventDefault();
      queueTrack(track);
    },
  });
}

// --- the view --------------------------------------------------------------

// Every place a queue is drawn: the Queue page, and the playbar's drawer. Each
// gets a sheet of its own inside the container it was handed, so a repaint can
// never land in a container another view has taken over.
const sheets = [];
let subscribed = false;

/**
 * Draw the queue into `container` — the Queue page, or the playbar's drawer —
 * and keep it live. The player and room subscriptions are installed here, so
 * anything that shows a queue gets its updates without wiring of its own.
 *
 * `compact` is for a narrow home: the same rows and controls, with the heading
 * left to whoever asked for it.
 */
export function renderQueue(container, { compact = false } = {}) {
  if (!container) return;
  const sheet = h("div", {});
  mount(container, sheet);
  sheets.push({ sheet, compact });
  if (!subscribed) {
    subscribed = true;
    // Every one of these is a repaint of every row of every sheet, and they
    // arrive in bursts: a song arriving is a copy starting, a copy landing, the
    // queue changing and the track changing, and four rebuilds of a long
    // queue's rows is three more than the one frame can show. `scheduleFrame`
    // is the same coalescing the room page has always used.
    player.on("queue-changed", repaint);
    player.on("track-changed", repaint);
    player.on("offline-changed", repaint);
    // A download's own count moves many times per song, and rebuilding every row
    // of every sheet for each of those is work no one sees: the marks already in
    // the page are filled where they stand instead. A mark that arrives, or a
    // song's state that changes, is the `offline-changed` repaint above.
    player.on("download-progress", fillMarks);
    // Whether the server is there decides what the line above the list says.
    on("online-changed", repaint);
    subscribe(repaint);
  }
  paint();
  // The drawer is opened onto a queue that can be any length, and the row worth
  // finding is the one that is playing: it is put in the middle of the panel, so
  // what has just played and what is coming are both in view. Only a fresh draw
  // of the drawer does this - a repaint (a copy landing, a download reporting)
  // must not drag the list back under somebody's thumb.
  if (compact) centrePlayingRow(sheet);
}

/**
 * Put the playing song in the middle of the drawer, once.
 *
 * `scrollIntoView` and not arithmetic: the list's scroll container is whichever
 * ancestor actually scrolls (the drawer body here, the view surface on the Queue
 * page), and the browser is the one that knows which.
 */
function centrePlayingRow(sheet) {
  const row = sheet.querySelector?.(".row[data-playing='true']");
  row?.scrollIntoView?.({ block: "center", inline: "nearest" });
}

const repaint = scheduleFrame(() => paint());

/** Fill the download marks already on screen, in place.
 *
 *  Each is one custom property on one node: no rows are rebuilt, no artwork is
 *  re-asked for, and a queue of fifty songs costs the same as a queue of one. */
function fillMarks() {
  for (const entry of sheets) {
    if (hiddenSheet(entry.sheet)) continue;
    for (const mark of entry.sheet.querySelectorAll?.(".held.pending .dl") || []) {
      setMark(mark, markState(mark.closest?.(".held")?.dataset.track || ""));
    }
  }
}

/** Redraw every sheet still in the page. One that a later render replaced is
 *  dropped, which is what keeps a repaint out of a view that is not this one.
 *
 *  A sheet inside something `hidden` - the playbar's drawer, while it is shut -
 *  is skipped rather than dropped: nothing it holds can be seen, and opening the
 *  drawer renders it again from scratch. A long queue was rebuilt in full for
 *  every event of every song, shut or not. */
function paint() {
  for (let index = sheets.length - 1; index >= 0; index -= 1) {
    if (!sheets[index].sheet.isConnected) sheets.splice(index, 1);
  }
  if (!sheets.length) return;

  const room = currentRoom();
  const projection = queueProjection({
    room,
    showMaster: false,
    playerQueue: player.queue || [],
    currentIndex: player.index() ?? -1,
  });
  for (const entry of sheets) {
    if (hiddenSheet(entry.sheet)) continue;
    draw(entry, projection, room);
  }
}

/** Whether a sheet is somewhere nothing is drawn: the drawer holds the queue
 *  while it is shut, and by the time it is opened it has been rendered again. */
function hiddenSheet(sheet) {
  return Boolean(sheet.closest?.("[hidden]"));
}

/** In a room the Queue page shows two queues, yours and the room's own order.
 *  Each is a panel of its own; the tabs above them show or hide one at a time. */
const shown = { mine: true, room: true };

/** The drawer is a column, not a page, so it holds one list at a time. Off is
 *  your own songs, which is where it opens. */
let drawerWholeRoom = false;

function draw({ sheet, compact }, projection, room) {
  if (room) {
    const whole = queueProjection({ room, showMaster: true, playerQueue: [], currentIndex: -1 });
    const clear = h("button", {
      class: "btn",
      text: "Clear queue",
      title: "Drop everything from your queue",
      disabled: !projection.count,
      onclick: () => run(clearRoom),
    });
    if (compact) {
      // One list, switched by one toggle. Two panels here widened the drawer to
      // 760px while the floating button and the page's own inset still expected
      // the 420px drawer, so both of them ended up under it.
      mount(
        sheet,
        h(
          "div",
          { class: "queue-drawer-controls" },
          h("button", {
            class: `tab queue-tab${drawerWholeRoom ? " active" : ""}`.trim(),
            title: "Show the room's play order — the fair mix everyone plays (read only)",
            "aria-pressed": drawerWholeRoom ? "true" : "false",
            onclick: () => {
              drawerWholeRoom = !drawerWholeRoom;
              paint();
            },
          }),
          clear
        ),
        offlineLine(),
        panel(
          true,
          sheet,
          drawerWholeRoom ? whole : projection,
          drawerWholeRoom ? "Whole Room" : "My songs",
          drawerWholeRoom ? "room" : "mine",
          false
        )
      );
      return;
    }
    mount(
      sheet,
      h(
        "div",
        { class: "queue-page-tabs" },
        tab(compact, "mine", "My songs", "The songs you queued", () => toggle("mine", sheet)),
        tab(compact, "room", "Whole Room", "The room's play order — the fair mix everyone plays (read only)", () => toggle("room", sheet)),
        clear
      ),
      offlineLine(),
      h(
        "div",
        { class: "queue-panels" },
        panel(compact, sheet, projection, "My songs", "mine", !shown.mine),
        panel(compact, sheet, whole, "Whole Room", "room", !shown.room)
      )
    );
    return;
  }
  mount(
    sheet,
    h(
      "div",
      { class: "row queue-heading-row" },
      h(
        "div",
        { class: "grow" },
        h("div", {
          class: compact ? "subtitle" : "title queue-heading-title",
          text: `${projection.label} · ${projection.count}`,
        })
      ),
      ...controls(projection)
    ),
    offlineLine(),
    projection.rows.length
      ? h("div", { class: "list" }, projection.rows.map((row) => queueRow(projection, row)))
      : h(
          "div",
          { class: "empty" },
          h("span", { class: "icon" }, iconOr("note", 38)),
          h("span", { class: "title", text: projection.empty }),
          projection.emptyHint ? h("span", { text: projection.emptyHint }) : null
        )
  );
}

/** One tab: it shows or hides the panel it names. */
function tab(compact, key, label, title, onclick) {
  return h("button", {
    class: `tab queue-tab${shown[key] ? " active" : ""}`.trim(),
    text: label,
    title,
    "aria-pressed": shown[key] ? "true" : "false",
    onclick,
  });
}

function toggle(key, sheet) {
  shown[key] = !shown[key];
  // Never leave the drawer with nothing in it.
  if (!shown.mine && !shown.room) shown[key === "mine" ? "room" : "mine"] = true;
  paint();
}

/** What the queue says about offline play, or null when there is nothing worth
 *  saying: nothing held, and the server answering. */
function offlineLine() {
  const summary = player.offlineSummary?.();
  if (!summary) return null;
  const held = summary.ready + summary.pending;
  if (!held) {
    if (summary.online) return null;
    return h("div", {
      class: "offline-line offline",
      text: "Offline — nothing in this queue is on this device yet.",
    });
  }
  const parts = [`${summary.ready} ready`];
  if (summary.pending) parts.push(`${summary.pending} downloading`);
  return h("div", {
    class: `offline-line${summary.online ? "" : " offline"}`,
    text: summary.online
      ? `In memory, on device: ${parts.join(" · ")}`
      : `Offline — playing from this device (${parts.join(", ")})`,
  });
}

/** A panel: its heading, then its rows. Visibility is passed in rather than read
 *  from the tabs' state, because the drawer shows one panel and has no tabs. */
function panel(compact, sheet, projection, heading, key, hidden) {
  return h(
    "div",
    { class: "queue-panel", "data-panel": key, hidden },
    h("div", {
      class: compact ? "subtitle" : "title queue-panel-title",
      text: `${heading} · ${projection.count}`,
    }),
    projection.rows.length
      ? h("div", { class: "list" }, projection.rows.map((row) => queueRow(projection, row)))
      : h(
          "div",
          { class: "empty" },
          h("span", { class: "icon" }, iconOr(projection.showMaster ? "queue" : "note", 30)),
          h("span", { class: "title", text: projection.empty })
        )
  );
}

function controls(projection) {
  const buttons = [];
  buttons.push(
    h("button", {
      class: "btn",
      text: "Shuffle",
      title: "Shuffle what is left of the queue, keeping the current track playing",
      disabled: !projection.count,
      onclick: () => player.shuffleQueue(),
    })
  );
  buttons.push(
    h("button", {
      class: "btn",
      text: "Clear",
      title: "Empty the queue",
      disabled: !projection.count,
      onclick: () => player.clear(),
    })
  );
  return buttons;
}

/**
 * The artist's name as a way into their page, or null when the track names no
 * artist: a name alone cannot name a page.
 */
export function artistLink(names, id = "") {
  const text = String(names || "");
  const artistId = String(id || "");
  if (!text || !artistId) return null;
  return h("button", {
    class: "link",
    text,
    title: `Go to ${text}`,
    onclick: () => navigate("artist", { id: artistId }),
  });
}

/** The artist line under a title, with the artist's page behind it when the
 *  track names one. */
export function artistLineNode(names, id = "") {
  const text = String(names || "");
  return h("div", { class: "subtitle" }, artistLink(text, id) || h("span", { text }));
}

/** The menu item that opens a track's artist, or null when there is none to
 *  open. Every track menu carries it, so they cannot drift apart. */
export function goToArtistItem(track) {
  const artistId = String((track?.artistIds || [])[0] || "");
  if (!artistId) return null;
  return { label: "Go to artist", onClick: () => navigate("artist", { id: artistId }) };
}

/** The title's class in a room list. Only the room's own order is coloured by
 *  who queued each song: your own list is all yours, and reads normally. */
export function titleClass(roomOrder, own) {
  if (!roomOrder) return "title";
  return own ? "title queued-mine" : "title queued-other";
}

/**
 * What this device holds of a song, as the mark both queues put on a row: the
 * green diamond when the copy is here, and the download arrow while it is on its
 * way - filled with yellow by the one copy being fetched right now, and quiet
 * grey on the rows still waiting their turn.
 *
 * Shared, because the room page's own queue says the same thing as the player's
 * queue, and two lists deciding it separately is how they come to disagree. The
 * song being played is one of these rows too: its copy is what plays, so the
 * mark that is filling is the mark on the row of the song somebody is waiting
 * to hear, and it becomes the diamond when the sound begins.
 */
export function heldBadge(trackId) {
  const id = String(trackId || "");
  const held = player.offlineState?.(id) || "none";
  if (held !== "ready" && held !== "pending") return null;
  const kept = held === "ready";
  return h(
    "span",
    {
      class: `held ${held}`,
      dataset: { track: id },
      title: kept ? "In memory, on device" : "Downloading to this device",
      "aria-label": kept ? "in memory, on device" : "downloading to this device",
    },
    kept ? icon("diamond", 14) : downloadMark(markState(id))
  );
}

/**
 * What a song's mark says: the count its own transfer has, or the sweep when
 * that transfer is the one happening and nobody can count it.
 *
 * A download that is queued behind another is not drawn as one in progress: one
 * yellow arrow is the transfer on the wire, and a list of arrows all moving says
 * nothing about which song is being waited on.
 */
function markState(trackId) {
  if (!player.downloading?.(trackId)) return { active: false, fraction: null };
  return { active: true, fraction: player.offlineProgress?.(trackId) ?? null };
}

/**
 * The download arrow, with the ink that fills it: two of the one glyph, the
 * second clipped to how far the download has got, so the mark fills the way a
 * bar fills without being a second thing to read.
 */
function downloadMark({ active = false, fraction = null } = {}) {
  const mark = h("span", { class: "dl" }, icon("download", 14), h("span", { class: "ink" }, icon("download", 14)));
  setMark(mark, { active, fraction });
  return mark;
}

/**
 * Fill a mark, in place: one style write and at most one class per report.
 *
 * `active` is the transfer happening now. With no count for it the ink sweeps -
 * the honest drawing of a download nobody can measure - and with no transfer the
 * mark is left grey, which is what a song waiting its turn looks like.
 */
function setMark(mark, { active = false, fraction = null } = {}) {
  if (!mark) return;
  // `null` is "no count", which is not zero: Number() would read it as one, and
  // an arrow pinned at nothing looks like a download that is not happening.
  const value = fraction === null || fraction === undefined ? NaN : Number(fraction);
  if (!active || !Number.isFinite(value)) {
    if (active) mark.classList.add("unknown");
    else mark.classList.remove("unknown");
    mark.style.removeProperty("--fill");
    return;
  }
  mark.classList.remove("unknown");
  const share = Math.min(1, Math.max(0, value));
  mark.style.setProperty("--fill", `${Math.round(share * 100)}%`);
}

/**
 * The order read from the song that is on: rows start at the playing item, and
 * what has already played is not shown as if it were next.
 *
 * The room's master keeps a played item until the next one begins (that is how
 * the round-robin keeps its phase), so a list that draws the whole queue with
 * the playing item pulled out shows the played prefix as the top of "upcoming" -
 * which reads as the room playing two of somebody's songs before anybody else's
 * turn. `at` is where the playing item sits, or -1 when it is not in the list.
 */
export function orderFromPlaying(items, playingId) {
  const list = Array.isArray(items) ? items : [];
  const id = String(playingId || "");
  const at = id ? list.findIndex((item) => String(item?.id || "") === id) : -1;
  return { items: at > 0 ? list.slice(at) : list, at };
}

function queueRow(projection, row) {
  const buttons = [];
  // What this device holds of the song: the queue says what will still play
  // when the server is out of reach.
  const badge = heldBadge(row.track?.id || row.trackId || row.key);
  if (badge) buttons.push(badge);
  // The menu a song has wherever it is listed. No plus here: these rows are the
  // queue, and a button that queues what is already queued is a button that
  // cannot do anything.
  if (row.track?.id) {
    buttons.push(
      iconButton("dots", {
        title: "Song actions",
        class: "btn flat small",
        onclick: (event) => openRowMenu(event.currentTarget, row.track),
      })
    );
  }
  if (projection.editable) {
    buttons.push(rowButton("cross", 14, "Remove from the queue", false, () => removeRow(projection, row)));
    // The grip is the only part of the row that drags, so the row itself keeps
    // the gesture a phone needs: scrolling the list.
    buttons.push(dragHandle());
  }
  const jumpable = projection.mode === "player";
  const element = h(
    "div",
    {
      class: jumpable ? "row clickable" : "row",
      "data-key": row.key,
      // Which row is the song being played, in the page as well as in the
      // player: the drawer centres this one when it opens, and a test can say
      // which row it looked at without counting icons.
      "data-playing": row.playing ? "true" : null,
      // A tap jumps inside the queue, a scroll is a scroll: the drawer is a
      // list you scroll under your thumb, and without the guard every scroll
      // ends by playing whatever the thumb stopped over.
      ...(jumpable
        ? tapOnly((event) => {
            if (event.target.closest?.("button")) return;
            // Jumping inside the queue is not playing a playlist: a restore
            // must not reopen whichever one the queue was filled from.
            player.setContext({ playlistId: "" });
            player.jumpTo(row.index);
          })
        : {}),
    },
    h(
      "span",
      {
        class: "time",
        style: row.playing ? { width: "24px", color: "var(--orange)" } : { width: "24px" },
      },
      row.playing ? icon("play", 14) : String(row.number)
    ),
    artworkTile(row.artwork),
    h(
      "div",
      { class: "grow" },
      h("div", { class: titleClass(projection.showMaster, row.mine), text: row.title }),
      row.subtitle ? artistLineNode(row.subtitle, row.artistId) : null
    ),
    row.time ? h("span", { class: "time", text: fmtDuration(row.time) }) : null,
    ...buttons
  );
  // A queue you may shape is one you may drag, the way the Room page's rows
  // are: the drop ends up in the same move the arrows used to do.
  if (projection.editable) {
    listDrag({
      row: element,
      handle: element.querySelector(".drag-handle"),
      entry: row,
      entries: projection.rows,
      onDrop: (from, to) => moveRow(projection, from, to.index),
    });
  }
  return element;
}

/** The grip that picks a row up. Big enough for a thumb, and the only part of
 *  the row that takes the drag gesture. */
export function dragHandle(title = "Drag to reorder") {
  return iconButton("grip", { title, class: "btn flat small drag-handle" });
}

/**
 * Drag a row onto another with the pointer, which is the one gesture a phone
 * has: HTML5 drag-and-drop never fires from a touch without a long press. The
 * row is picked up the moment `handle` is held - no timer - and dropped on
 * whichever row it is released over. A press that never moves stays a press, so
 * tapping a queue row still plays or jumps.
 *
 * `handle` is the grip: leaving it out makes the whole row the grip, which is
 * what a list without one wants. With a handle the rest of the row keeps the
 * scroller's gesture - a list you cannot scroll on a phone is worse than one
 * you cannot reorder.
 *
 * `entries` is the list on screen and `onDrop(from, to)` gets the two entries
 * involved; each caller knows how its own list is reordered.
 */
export function listDrag({ row, handle = null, entry, entries, onDrop }) {
  let over = null;
  let moved = false;
  let startX = 0;
  let startY = 0;

  const clearOver = () => {
    if (over) over.classList.remove("drag-over");
    over = null;
  };

  const onMove = (event) => {
    if (!moved) {
      // Held is not yet dragged: a press has to move before it means a move, or
      // every tap would shuffle the list.
      if (Math.abs(event.clientX - startX) + Math.abs(event.clientY - startY) < DRAG_SLOP) return;
      moved = true;
      row.classList.add("dragging");
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest?.(".row");
    if (target === over) return;
    clearOver();
    if (target && target !== row && target.dataset.key) {
      over = target;
      over.classList.add("drag-over");
    }
  };

  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    row.classList.remove("dragging");
    const target = over;
    clearOver();
    if (!moved || !target) return;
    // The press became a drag: swallow the click it would otherwise be.
    row.addEventListener(
      "click",
      (clickEvent) => {
        clickEvent.stopPropagation();
        clickEvent.preventDefault();
      },
      { capture: true, once: true }
    );
    const to = entries.find((candidate) => candidate.key === target.dataset.key);
    if (to) onDrop(entry, to);
  };

  row.classList.add("sortable");
  if (handle) row.classList.add("handled");
  const grip = handle || row;
  grip.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // Without a grip the whole row is one, so its buttons (remove, and the
    // artist's name, which is one too) keep their press: a press that does not
    // move is still their click.
    if (!handle && event.target.closest?.(".btn")) return;
    // The listeners live on the document: a drag leaves the row immediately,
    // and a pointer capture is not always granted (a synthesised one never is).
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
}

/**
 * Open the song's own menu.
 *
 * The menu lives with the playlist view, which is what a row's actions mostly
 * touch; this module is imported by it, so the import here has to be at the
 * moment it is needed rather than at load, or the two would be a cycle.
 */
async function openRowMenu(anchor, track) {
  const { trackMenu } = await import("./playlist.js");
  popover(anchor, trackMenu(track));
}

function rowButton(name, size, title, disabled, onclick) {
  return h("button", { class: "btn flat small", title, "aria-label": title, disabled, onclick }, icon(name, size));
}

function artworkTile(path) {
  const client = currentClient();
  if (path) return artworkImage(client ? client.artworkUrl(path) : path, { className: "art", eager: true });
  return h("div", { class: "art", "aria-hidden": "true" }, icon("note", 18));
}

function moveRow(projection, row, to) {
  if (projection.mode === "room") {
    // A room reorder names the whole order, so the moved list is the message -
    // and the whole order includes the item that is playing, which the list
    // does not show.
    run(() => reorderRoom(moveItem(projection.order, row.index, to)));
    return;
  }
  player.move(row.index, to);
}

function removeRow(projection, row) {
  if (projection.mode === "room") {
    run(() => removeRoomItem(row.itemId));
    return;
  }
  player.removeAt(row.index);
}

/** Room commands answer with a promise; a refusal is worth saying out loud. */
function run(task) {
  try {
    return Promise.resolve(task()).catch(reportError);
  } catch (error) {
    reportError(error);
    return null;
  }
}
