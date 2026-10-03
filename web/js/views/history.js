// What this account has listened to: the last few plays and the songs played
// most.
//
// Both come from the listening history the server keeps. The rows are built
// here rather than shared with the playlist page, because a listen carries a
// length or a count where a playlist row carries a number and a duration.

import { currentClient, on, registerView, requireLogin } from "../app.js";
import { fmtDuration, h, mount } from "../dom.js";
import { isSignedIn } from "../state.js";
import { artistLine, playTracks, reportError } from "./queue.js";
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
let top = [];

function onScreen() {
  return Boolean(sheet?.isConnected);
}

function render(container) {
  // A sheet of its own, so an answer arriving after another view took the
  // container over lands nowhere rather than on top of that view.
  sheet = h("div", { style: { display: "contents" } });
  mount(container, sheet);
  return load();
}

async function load() {
  if (!sheet || !sheet.isConnected) return;

  if (!isSignedIn()) {
    recent = [];
    top = [];
    paint();
    return;
  }

  const client = currentClient();
  try {
    [recent, top] = await Promise.all([client.history(), client.topTracks()]);
  } catch (error) {
    reportError(error);
    recent = [];
    top = [];
  }
  if (!sheet || !sheet.isConnected) return; // the view was replaced while we fetched
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

  mount(
    sheet,
    section("Recently played", recent, (play) => ({
      track: play.track,
      detail: playedLengthLabel(play.playedMs),
    })),
    section("Most played", top, (entry) => ({
      track: entry.track,
      detail: playCountLabel(entry.plays),
    }))
  );
}

/** One section: its heading and its rows, or a line saying there are none. */
function section(title, entries, shape) {
  const client = currentClient();
  const items = (entries || []).map(shape).filter((item) => item.track);
  const tracks = items.map((item) => item.track);
  return h(
    "div",
    { class: "section" },
    h("div", { class: "subtitle", text: title }),
    items.length
      ? h(
          "div",
          { class: "list" },
          items.map((item, index) => row(item, client, () => playTracks(tracks, index)))
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
    h("span", { class: "time", text: item.detail })
  );
}
