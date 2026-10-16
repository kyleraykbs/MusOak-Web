// A platform playlist, as the platform lists it.
//
// Clicking a playlist in search opens this: the songs, in the provider's own
// order, read live and written nowhere. Nothing here is in the library yet, so
// the rows show what is on offer rather than pretend to be playable - there is
// no plus and no play, because there is no track to give either - and bringing
// them in is the button at the top. An import somebody asks for, not something
// a click does behind their back.

import { h, mount, clear, toast, fmtDuration, icon, loadingState } from "../dom.js";
import { registerView, navigate, currentClient } from "../app.js";
import { artworkTile, emptyState } from "./playlist.js";
import { artistLine } from "./queue.js";

async function render(container, params = {}) {
  const client = currentClient();
  clear(container);
  if (!client) {
    mount(container, emptyState("note", "No server", "Add a server first: playlists live on one."));
    return;
  }
  if (!params.id) {
    mount(container, emptyState("note", "No playlist", "That link does not name a playlist."));
    return;
  }
  mount(container, loadingState("Loading playlist…"));
  try {
    const answer = await client.providerPlaylist(params.id, params.provider || "");
    if (!container.isConnected) return;
    paint(container, params, client, answer);
  } catch (error) {
    if (!container.isConnected) return;
    mount(
      container,
      h(
        "div",
        { class: "empty" },
        h("span", { class: "icon" }, icon("note", 38)),
        h("span", { class: "title", text: "Could not load this playlist" }),
        h("span", { text: String(error?.message || error) })
      )
    );
  }
}

function paint(container, params, client, answer) {
  const playlist = answer?.playlist || {};
  const tracks = answer?.tracks || [];
  const name = playlist.title || "Playlist";
  const from = params.from && typeof params.from === "object" ? params.from : { view: "search", params: {} };
  const sheet = h("div", { style: { display: "contents" } });

  clear(container);
  mount(container, sheet);

  const importButton = h("button", {
    class: "btn suggested",
    text: "Import into library",
    title: `Bring “${name}” into your library`,
  });
  importButton.onclick = () => runImport(client, playlist, importButton);

  sheet.appendChild(
    h(
      "div",
      { class: "card provider-playlist-header" },
      h("button", {
        class: "btn flat small",
        title: "Back",
        onclick: () => navigate(from?.view || "search", from?.params || {}),
      }, icon("prev", 16), "Back"),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "provider-playlist-title", text: name }),
        h("div", {
          class: "subtitle",
          text: [playlist.owner, playlist.provider, `${tracks.length} track(s)`].filter(Boolean).join(" \u00b7 "),
        })
      ),
      importButton
    )
  );

  sheet.appendChild(h("div", { class: "section-title", text: `Songs · ${tracks.length}` }));
  if (!tracks.length) {
    sheet.appendChild(emptyState("note", "Nothing listed", "The provider did not list any tracks for this playlist."));
    return;
  }
  // A playlist can be thousands of songs long, and it arrives in one answer:
  // what is drawn is a hundred at a time, with a button for the next hundred,
  // so the page stays a length somebody can scroll.
  const list = h("div", { class: "list" });
  const more = h("button", { class: "btn provider-playlist-more", text: "", title: "Draw the next songs" });
  let shown = 0;
  const draw = () => {
    for (const row of playlistRowChunk(client, tracks, shown)) list.appendChild(row);
    shown += PAGE_ROWS;
    const left = tracks.length - shown;
    if (left > 0) {
      more.textContent = `Load ${left > PAGE_ROWS ? PAGE_ROWS : left} more`;
      more.style.display = "";
    } else {
      more.style.display = "none";
    }
  };
  more.onclick = () => draw();
  draw();

  // The provider's own ceiling, said plainly. Spotify's public page lists the
  // first hundred tracks and no more - an account's API answers with all of
  // them - and a count larger than the list is how that reads from here.
  const counted = Number(playlist.trackCount) || 0;
  if (counted > tracks.length) {
    sheet.appendChild(
      h("div", {
        class: "subtitle provider-playlist-limit",
        text: `The provider listed ${tracks.length} of ${counted} songs. Importing brings in what it lists.`,
      })
    );
  }
  sheet.appendChild(list);
  sheet.appendChild(h("div", { class: "provider-playlist-more-row" }, more));
}

/** The songs as rows: what the platform lists, in its order, with nothing to
 *  press. There is no library track behind them yet, so there is nothing to
 *  play, queue or favourite - that is what the import is for.
 *
 * Exported because it is the page's whole content and the one part of it a
 * test can look at: the rest is a header and a button. */
export function playlistTrackRows(client, tracks, offset = 0) {
  return (tracks || []).map((track, index) => {
    const position = offset + index;
    return h(
      "div",
      { class: "row" },
      h("span", { class: "time", text: String(position + 1) }),
      artworkTile(client, track.artworkUrl),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "title", text: track.title || "" }),
        h("div", { class: "subtitle", text: artistLine(track) })
      ),
      track.durationMs ? h("span", { class: "time", text: fmtDuration(track.durationMs) }) : null
    );
  });
}

/** How many songs are drawn at once. See draw() for why a page shows a part of
 *  a playlist rather than all of it. */
export const PAGE_ROWS = 100;

/** The chunk of songs from `from` on, numbered from where the list starts: the
 *  rows a page draws at a time. */
export function playlistRowChunk(client, tracks, from, size = PAGE_ROWS) {
  return playlistTrackRows(client, (tracks || []).slice(from, from + size), from);
}

/** Bring the playlist in: the one act on this page that writes anything. It
 *  answers with what came in, and the caller decides where to go from there.
 *
 * Two ways in, because a playlist can arrive two ways. One the library has a
 * row for is synced, which fills that row's tracklist and answers at once. One
 * the library has never seen - a pasted link or a platform id - is imported as
 * a job: nothing here waits on a provider reading a hundred tracks, and the
 * playlist shows up in Playlists when it is done. */
export async function importIntoLibrary(client, playlist) {
  if (playlist.id) {
    const result = await client.syncPlaylist(playlist.id, playlist.provider || "");
    return { id: String(result?.playlist?.id || ""), added: Number(result?.added) || 0, queued: false };
  }
  await client.importPlaylist({
    provider: playlist.provider || "",
    id: String(playlist.providerPlaylistId || ""),
    name: playlist.title || "",
  });
  return { id: "", added: 0, queued: true };
}

/** Import, then open the playlist where it now lives: the library page, with
 *  the songs playable. */
async function runImport(client, playlist, button) {
  button.disabled = true;
  button.textContent = "Importing...";
  try {
    const { id, added, queued } = await importIntoLibrary(client, playlist);
    toast(
      queued
        ? `Importing ${playlist.title || "the playlist"} — it will appear in Playlists`
        : `Imported ${playlist.title || "the playlist"}: ${added} new track(s)`
    );
    if (id) navigate("playlist", { id, from: { view: "providerPlaylist", params: { id: playlist.id } } });
  } catch (error) {
    button.disabled = false;
    button.textContent = "Import into library";
    toast(String(error?.message || error));
  }
}

registerView({
  id: "providerPlaylist",
  title: "Playlist",
  icon: "list",
  order: 72,
  hidden: true,
  render,
});