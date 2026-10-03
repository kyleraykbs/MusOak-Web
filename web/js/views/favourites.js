// The tracks this account favourited.
//
// The rows are the same ones the playlist page draws, and the star is the
// shell's: this view only lists what the account starred, and offers to take
// the star back.

import { h, mount } from "../dom.js";
import { currentClient, on, registerView, requireLogin } from "../app.js";
import { isSignedIn, state } from "../state.js";
import { playTracks, reportError } from "./queue.js";
import { emptyState, playButtons, trackCountLine, trackMenu, trackRow } from "./playlist.js";

registerView({
  id: "favourites",
  title: "Favourites",
  icon: "\u2605",
  order: 30,
  render: renderFavourites,
  refresh: loadFavourites,
});

// A star moved anywhere in the app changes this list: the set the shell keeps
// says which rows belong, so a repaint is enough — and a fresh fetch picks up
// what was starred somewhere else.
on("favorites-changed", () => {
  if (onScreen()) {
    paint();
    loadFavourites();
  }
});
on("user-changed", () => {
  if (onScreen()) loadFavourites();
});

let sheet = null; // the piece of the page this view owns
let tracks = [];

function onScreen() {
  return Boolean(sheet?.isConnected);
}

function renderFavourites(container) {
  // A sheet of its own inside the container: when another view takes the
  // container over this one is detached, and an answer arriving late lands in
  // nothing rather than on top of somebody else's page.
  sheet = h("div", { style: { display: "contents" } });
  mount(container, sheet);
  return loadFavourites();
}

async function loadFavourites() {
  if (!sheet || !sheet.isConnected) return;

  if (!isSignedIn()) {
    tracks = [];
    paint();
    return;
  }

  const client = currentClient();
  try {
    tracks = await client.favorites();
  } catch (error) {
    reportError(error);
    tracks = [];
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
        "star",
        "No favourites",
        "Sign in to this server to see your favourites.",
        h("button", { class: "btn suggested", text: "Sign in", onclick: () => requireLogin() })
      )
    );
    return;
  }

  // What the account starred, in the order the server listed it: a star taken
  // back in a row menu drops out of the list at once. Playing from here is not
  // playing a playlist, so no playlist is recorded for a restore.
  const list = tracks.filter((track) => state.favorites.has(track.id));
  const client = currentClient();
  mount(
    sheet,
    h(
      "div",
      { class: "row", style: { flexWrap: "wrap" } },
      h("div", { class: "grow" }, h("div", { class: "subtitle", text: trackCountLine(list) })),
      ...playButtons(list, { withShuffleQueue: false })
    ),
    list.length
      ? h(
          "div",
          { class: "list" },
          list.map((track, position) =>
            trackRow({
              track,
              position,
              client,
              onActivate: () => playTracks(list, position),
              menu: trackMenu(track),
            })
          )
        )
      : emptyState("star", "No favourites", "Star tracks and they collect here.")
  );
}
