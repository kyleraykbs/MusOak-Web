// A platform playlist, as the platform lists it.
//
// Clicking a playlist in search opens this: the songs, in the provider's own
// order, read live and written nowhere. Nothing here is in the library yet, so
// the rows show what is on offer rather than pretend to be playable - there is
// no plus and no play, because there is no track to give either - and bringing
// them in is the button at the top. An import somebody asks for, not something
// a click does behind their back.

import { h, mount, clear, toast, fmtDuration, icon } from "../dom.js";
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
  mount(container, emptyState("note", "Loading the playlist..."));
  try {
    const answer = await client.providerPlaylist(params.id);
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
      { class: "card row", style: { padding: "14px 16px" } },
      h("button", {
        class: "btn flat small",
        title: "Back",
        onclick: () => navigate(from?.view || "search", from?.params || {}),
      }, icon("prev", 16), "Back"),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "title", style: { fontSize: "20px", color: "var(--fg0)" }, text: name }),
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
  const list = h("div", { class: "list" });
  for (const row of playlistTrackRows(client, tracks)) list.appendChild(row);
  sheet.appendChild(list);
}

/** The songs as rows: what the platform lists, in its order, with nothing to
 *  press. There is no library track behind them yet, so there is nothing to
 *  play, queue or favourite - that is what the import is for.
 *
 * Exported because it is the page's whole content and the one part of it a
 * test can look at: the rest is a header and a button. */
export function playlistTrackRows(client, tracks) {
  return (tracks || []).map((track, position) =>
    h(
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
    )
  );
}

/** Bring the playlist in: the one act on this page that writes anything. It
 *  answers with what came in, and the caller decides where to go from there. */
export async function importIntoLibrary(client, playlist) {
  const result = await client.syncPlaylist(playlist.id, playlist.provider || "");
  return { id: String(result?.playlist?.id || ""), added: Number(result?.added) || 0 };
}

/** Import, then open the playlist where it now lives: the library page, with
 *  the songs playable. */
async function runImport(client, playlist, button) {
  button.disabled = true;
  button.textContent = "Importing...";
  try {
    const { id, added } = await importIntoLibrary(client, playlist);
    toast(`Imported ${playlist.title || "the playlist"}: ${added} new track(s)`);
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
  icon: "\u2261",
  order: 72,
  hidden: true,
  render,
});