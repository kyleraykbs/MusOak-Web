// What this account has listened to: the last few plays and the songs played
// most.
//
// Both come from the listening history the server keeps. The rows are built
// here rather than shared with the playlist page, because a listen carries a
// length or a count where a playlist row carries a number and a duration.

import { currentClient, on, registerView, requireLogin } from "../app.js";
import { appendProgressively, fmtDuration, h, mount, loadingState } from "../dom.js";
import { isSignedIn } from "../state.js";
import { artistLine, playOne, playTracks, queueButton, reportError } from "./queue.js";
import { artworkTile, emptyState } from "./playlist.js";

registerView({
  id: "history",
  title: "History",
  icon: "retry",
  order: 35,
  render,
  refresh: load,
});

// Signing in or out changes whose history this is, so repaint when it does.
on("user-changed", () => {
  if (onScreen()) load();
});

// --- the pure parts --------------------------------------------------------

/** "4:12 played" — how much of a song a listen actually heard. */
export function playedLengthLabel(playedMs) {
  return `${fmtDuration(playedMs)} played`;
}

/** "1 play" or "3 plays". */
export function playCountLabel(plays) {
  const count = Math.max(0, Number(plays) || 0);
  return `${count} play${count === 1 ? "" : "s"}`;
}


// --- the view ---------------------------------------------------------------

let sheet = null; // the piece of the page this view owns
let recent = [];
// The songs played most. Named for what it holds rather than `top`: an
// assignment to a bare `top` lands on the window's own accessor.
let mostPlayed = [];
let historyMode = "recent";
let historyQuery = "";
let loadGeneration = 0;

function onScreen() {
  return Boolean(sheet?.isConnected);
}

function render(container) {
  // A sheet of its own, so an answer arriving after another view took the
  // container over lands nowhere rather than on top of that view.
  sheet = h("div", { class: "view-sheet" });
  mount(container, sheet);
  mount(sheet, loadingState("Loading history…"));
  return load();
}

async function load() {
  if (!sheet || !sheet.isConnected) return;
  const mine = ++loadGeneration;

  if (!isSignedIn()) {
    recent = [];
    mostPlayed = [];
    paint();
    return;
  }

  const client = currentClient();
  try {
    const [nextRecent, nextTop] = await Promise.all([client.history(), client.topTracks()]);
    if (mine !== loadGeneration || !sheet?.isConnected) return;
    recent = nextRecent;
    mostPlayed = nextTop;
  } catch (error) {
    if (mine !== loadGeneration || !sheet?.isConnected) return;
    reportError(error);
    recent = [];
    mostPlayed = [];
  }
  if (!sheet || !sheet.isConnected) return;
  paint();
}

function paint() {
  if (!sheet || !sheet.isConnected) return;

  if (!isSignedIn()) {
    mount(
      sheet,
      emptyState(
        "retry",
        "No history",
        "Sign in to this server to see what you have played.",
        h("button", { class: "btn suggested", text: "Sign in", onclick: () => requireLogin() })
      )
    );
    return;
  }

  const search = h("input", {
    class: "input history-search", type: "search", placeholder: "Search history",
    value: historyQuery,
    oninput: (event) => { historyQuery = event.currentTarget.value; paint(); },
  });
  const recentButton = h("button", { class: `tab ${historyMode === "recent" ? "active" : ""}`, text: "Recently played", onclick: () => { historyMode = "recent"; paint(); } });
  const topButton = h("button", { class: `tab ${historyMode === "top" ? "active" : ""}`, text: "Most played", onclick: () => { historyMode = "top"; paint(); } });
  const entries = historyMode === "recent" ? recent : mostPlayed;
  const shaped = entries.map(historyMode === "recent"
    ? (play) => ({ track: play.track, detail: playedLengthLabel(play.playedMs) })
    : (entry) => ({ track: entry.track, detail: playCountLabel(entry.plays) }));
  const filtered = shaped.filter((item) => {
    const text = `${item.track?.title || ""} ${artistLine(item.track || {})}`.toLowerCase();
    return text.includes(historyQuery.trim().toLowerCase());
  });
  mount(
    sheet,
    h("div", { class: "history-toolbar" }, search, h("div", { class: "tabs" }, recentButton, topButton)),
    section(historyMode === "recent" ? "Recently played" : "Most played", filtered)
  );
}

/** One section: its heading and its already-shaped rows, or a line saying none. */
function section(title, entries) {
  const client = currentClient();
  const items = (entries || []).filter((item) => item.track);
  const tracks = items.map((item) => item.track);
  return h(
    "div",
    { class: "section history-section" },
    h("div", { class: "section-title", text: title }),
    items.length
      ? h(
          "div",
          { class: "list" },
          items.map((item, index) => row(item, client, () => playOne(tracks, index)))
        )
      : emptyState("retry", title, "Nothing here yet.")
  );
}

/** One listen: artwork, the song, and how much or how often it played. */
function row(item, client, onActivate) {
  const track = item.track;
  return h(
    "div",
    { class: "row clickable", title: `Play ${track.title || "this song"}`, onclick: onActivate },
    artworkTile(client, track.artworkUrl),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", text: track.title || "" }),
      h("div", { class: "subtitle", text: artistLine(track) })
    ),
    h("span", { class: "time", text: item.detail }),
    queueButton(track)
  );
}
