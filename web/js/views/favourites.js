// The tracks this account favourited.
//
// The rows are the same ones the playlist page draws, and the star is the
// shell's: this view only lists what the account starred, and offers to take
// the star back.

import { h, icon, mount, skeletonRows, loadingState } from "../dom.js";
import {
  currentClient, favoriteRating, on, openFavoriteDialog, ratingStage, registerView, requireLogin,
} from "../app.js";
import { isSignedIn, state } from "../state.js";
import { playOne, reportError } from "./queue.js";
import { emptyState, playButtons, trackCountLine, trackMenu, trackRow } from "./playlist.js";

registerView({
  id: "favourites",
  title: "Favourites",
  icon: "star",
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
/** Why the last read of them failed, so an empty page is not read as an empty
 *  account: the server's own sentence, or "". */
let loadFailed = "";
let loadGeneration = 0;

function onScreen() {
  return Boolean(sheet?.isConnected);
}

function renderFavourites(container) {
  // A sheet of its own inside the container: when another view takes the
  // container over this one is detached, and an answer arriving late lands in
  // nothing rather than on top of somebody else's page.
  sheet = h("div", { class: "view-sheet" });
  mount(container, sheet);
  return loadFavourites();
}

async function loadFavourites() {
  if (!sheet || !sheet.isConnected) return;
  const mine = ++loadGeneration;

  if (!isSignedIn()) {
    tracks = [];
    paint();
    return;
  }

  const client = currentClient();
  if (!tracks.length) mount(sheet, skeletonRows(4));
  try {
    const next = await client.favorites();
    if (mine !== loadGeneration || !sheet?.isConnected) return;
    tracks = next;
    loadFailed = "";
  } catch (error) {
    if (mine !== loadGeneration || !sheet?.isConnected) return;
    reportError(error);
    tracks = [];
    loadFailed = error?.message || String(error);
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
        "star",
        "No favourites",
        "Sign in to this server to see your favourites.",
        h("button", { class: "btn suggested", text: "Sign in", onclick: () => requireLogin() })
      )
    );
    return;
  }

  // The account's scores are the order of this page: highest first, with the
  // server's order preserved for equal scores. The filter below works against
  // this stable list, so moving its threshold never shuffles equal ratings.
  const list = tracks
    .filter((track) => favoriteRating(track.id) != null)
    .map((track, index) => ({ track, index, rating: Number(favoriteRating(track.id)) || 0 }))
    .sort((left, right) => right.rating - left.rating || left.index - right.index)
    .map(({ track }) => track);
  const client = currentClient();
  if (!list.length) {
    mount(
      sheet,
      loadFailed
        ? emptyState(
            "star",
            "Your favourites could not be loaded",
            loadFailed,
            h("button", { class: "btn suggested", text: "Try again", onclick: () => loadFavourites() })
          )
        : emptyState("star", "No favourites", "Star tracks and they collect here.")
    );
    return;
  }

  let filterRating = 0;
  const filterLabel = h("div", { class: "favourites-filter-label", text: "All ratings" });
  const actions = h("div", { class: "favourites-actions" });
  const results = h("div");
  const filter = ratingStage(filterRating, (rating) => {
    filterRating = rating;
    filterLabel.textContent = rating > 0 ? `At least ${rating.toFixed(1)} stars` : "All ratings";
    renderResults();
  }, { min: "0", ariaLabel: "Filter favourites by minimum rating" });
  const filterBox = h("div", { class: "favourites-filter" }, filter.stage, filterLabel);

  function renderResults() {
    const visible = list.filter((track) => Number(favoriteRating(track.id)) >= filterRating);
    mount(
      actions,
      h("div", { class: "grow" }, h("div", { class: "subtitle", text: trackCountLine(visible) })),
      ...playButtons(visible, { withShuffleQueue: false })
    );
    mount(
      results,
      visible.length
        ? h("div", { class: "list" }, visible.map((track, position) => {
            const editRating = h("button", {
              class: "btn flat small favourites-rating-edit",
              title: "Edit rating",
              "aria-label": "Edit rating",
              onclick: (event) => {
                event.stopPropagation();
                openFavoriteDialog(track.id);
              },
            }, icon("star", 16));
            return trackRow({
              track,
              position,
              client,
              onActivate: () => playOne(visible, position),
              menu: trackMenu(track),
              trailing: h("span", { class: "favourites-row-actions" },
                editRating,
                h("span", {
                  class: "subtitle favourites-rating",
                  text: `${Number(favoriteRating(track.id)).toFixed(1)}/5.0`,
                })
              ),
            });
          }))
        : emptyState("star", "No matching favourites", `Nothing is rated ${filterRating.toFixed(1)} or higher.`)
    );
  }

  renderResults();
  mount(sheet, filterBox, actions, results);
}
