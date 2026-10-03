// Artist and album pages: what clicking a search result opens into.
//
// The server answers /artists/{id} with the artist and the albums it knows, and
// /albums/{id} with the tracks once they are in the library. The two pages are
// the same shape, so they share a header and reuse the playlist view's rows.
//
// Both are detail views reached from a result, so neither appears in the nav.

import { h, mount, clear, iconButton, popover, toast } from "../dom.js";
import { currentClient, navigate, registerView } from "../app.js";
import { playTracks } from "./queue.js";
import { emptyState, playButtons, trackCountLine, trackMenu, trackRow } from "./playlist.js";

registerView({ id: "artist", title: "Artist", hidden: true, render: renderArtist });
registerView({ id: "album", title: "Album", hidden: true, render: renderAlbum });

/** Albums this page has already asked the provider about, so opening one twice
 *  in a session does not mean two round trips. */
const syncedThisSession = new Set();

// --- pieces both pages use --------------------------------------------------

function artTile(client, artworkUrl, className = "art") {
  if (!artworkUrl) return h("div", { class: className });
  const src = client?.artworkUrl ? client.artworkUrl(artworkUrl) : artworkUrl;
  return h("img", { class: className, src, alt: "", loading: "lazy" });
}

function artistLine(item) {
  return (item?.artists || []).filter(Boolean).join(", ");
}

/** Where the page was opened from, so Back goes back there with what it needs
 *  to render again: an album knows its artist only by name, so the page it came
 *  from is remembered rather than rebuilt. */
function backRow(from) {
  const target = from && typeof from === "object" ? from : { view: from || "search", params: {} };
  return h("div", {},
    h("button", {
      class: "btn",
      text: "Back",
      title: "Back to the results",
      onclick: () => navigate(target.view, target.params || {}),
    }));
}

function header({ client, artworkUrl, title, lines = [], actions = [] }) {
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "row", style: { alignItems: "flex-start", gap: "16px" } },
      artTile(client, artworkUrl, "art big"),
      h(
        "div",
        { class: "grow", style: { display: "flex", flexDirection: "column", gap: "6px" } },
        h("div", { class: "title", style: { fontSize: "1.15rem" }, text: title }),
        ...lines.filter(Boolean).map((line) => h("div", { class: "subtitle wrap", text: line })),
        actions.length ? h("div", { class: "form-row", style: { marginTop: "8px" } }, actions) : null
      )
    )
  );
}

/**
 * The sync control: a button and the line under it that says what is happening.
 *
 * A sync is one long request - an artist means a provider round trip per album,
 * which took 25 seconds for Radiohead - so the button says what it is doing
 * rather than sitting there looking pressed.
 */
function syncControl({ label, running, title, work, hint }) {
  const status = h("span", { class: "login-status", role: "status" });
  const button = h("button", {
    class: "btn suggested",
    text: label,
    title,
    "aria-live": "off",
    onclick: async (event) => {
      const element = event.currentTarget;
      if (element.dataset.busy === "true") return;
      element.dataset.busy = "true";
      element.textContent = running;
      status.className = "login-status";
      status.textContent = hint || "Talking to the provider. A big artist can take a minute.";
      try {
        await work();
        status.className = "login-status";
        status.textContent = "";
      } catch (error) {
        status.className = "login-status error";
        status.textContent = String(error?.message || error);
      } finally {
        delete element.dataset.busy;
        element.textContent = label;
      }
    },
  });
  return h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } }, button, status);
}

/** A sync that reports how much it added and then lets the page catch up. */
async function syncAndSay(client, { id, name, album = false }, refresh) {
  const result = album ? await client.syncAlbum(id) : await client.syncArtist(id, { syncAlbums: true });
  const added = Number(result?.added) || 0;
  // Syncing twice adds nothing, and "0 track(s)" reads like a failure.
  toast(added ? `Synced ${name || "it"}: ${added} new track(s)` : `${name || "It"} was already in the library`);
  await refresh();
}

// --- the artist page --------------------------------------------------------

async function renderArtist(container, params = {}) {
  const client = currentClient();
  const sheet = h("div", { style: { display: "contents" } });
  mount(container, sheet);

  if (!client) {
    mount(sheet, emptyState("people", "No server", "Add a server first: artists live on one."));
    return;
  }
  if (!params.id) {
    mount(sheet, emptyState("people", "No artist", "That link does not name an artist."));
    return;
  }
  mount(sheet, emptyState("people", "Loading the artist..."));

  let artist;
  const load = async () => {
    artist = await client.artist(params.id);
    paint();
  };
  const paint = () => {
    if (!sheet.isConnected) return;
    const albums = artist.albums || [];
    clear(sheet);
    sheet.appendChild(backRow(params.from));
    sheet.appendChild(
      header({
        client,
        artworkUrl: artist.artworkUrl,
        title: artist.name || "Artist",
        lines: [
          albums.length ? `${albums.length} album${albums.length === 1 ? "" : "s"}` : "Nothing in the library yet",
          (artist.providers || []).join(", "),
        ],
        actions: [
          syncControl({
            label: "Sync into library",
            running: "Syncing...",
            title: "Bring every album this artist has into the library",
            hint: "Asking the provider about every album this artist has. A big artist takes a minute or so.",
            work: () => syncAndSay(client, { id: artist.id, name: artist.name }, load),
          }),
        ],
      })
    );
    sheet.appendChild(h("div", { class: "section-title", text: "Albums" }));
    sheet.appendChild(
      albums.length
        ? h("div", { class: "list" }, albums.map((album) => albumRow(client, album, params, load)))
        : emptyState("note", "No albums yet", "Sync the artist to find out what they released.")
    );
  };

  try {
    await load();
  } catch (error) {
    if (sheet.isConnected) mount(sheet, emptyState("people", "That artist could not be loaded", String(error?.message || error)));
  }
}

function albumRow(client, album, params, refresh) {
  const subtitle = [artistLine(album), album.year, album.trackCount ? `${album.trackCount} track(s)` : ""]
    .filter(Boolean)
    .join(" \u00b7 ");
  return h(
    "div",
    { class: "row clickable", onclick: () => navigate("album", { id: album.id, from: { view: "artist", params: { id: params.id } } }) },
    artTile(client, album.artworkUrl),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", text: album.title || "Untitled" }),
      subtitle ? h("div", { class: "subtitle", text: subtitle }) : null
    ),
    h("span", { class: "time", text: album.year || "" }),
    iconButton("dots", {
      title: "More actions",
      onclick: (event) => {
        event.stopPropagation();
        popover(event.currentTarget, [
          {
            label: "Sync into library",
            onClick: async () => {
              try {
                await syncAndSay(client, { id: album.id, name: album.title, album: true }, refresh);
              } catch (error) {
                toast(String(error?.message || error));
              }
            },
          },
        ]);
      },
    })
  );
}

// --- the album page ---------------------------------------------------------

async function renderAlbum(container, params = {}) {
  const client = currentClient();
  const sheet = h("div", { style: { display: "contents" } });
  mount(container, sheet);

  if (!client) {
    mount(sheet, emptyState("note", "No server", "Add a server first: albums live on one."));
    return;
  }
  if (!params.id) {
    mount(sheet, emptyState("note", "No album", "That link does not name an album."));
    return;
  }
  mount(sheet, emptyState("note", "Loading the album..."));

  let album;
  let syncing = false;
  const load = async () => {
    album = await client.album(params.id);
    paint();
    if (shortOfItsRelease()) void fetchTheRest();
  };

  /**
   * An album built from single matches holds only the tracks that happened to
   * be matched - the release knows the rest, and says how many it has. The page
   * asks for them by itself rather than leaving a partial album looking whole.
   */
  const shortOfItsRelease = () => {
    if (syncing || !(album.providers || []).length) return false;
    if (syncedThisSession.has(album.id)) return false;
    const release = (album.variants || []).reduce(
      (most, variant) => Math.max(most, Number(variant.trackCount) || 0),
      0
    );
    // No count recorded yet means the tracklist has never been read, so this is
    // the ask that records it.
    return release === 0 || (album.tracks || []).length < release;
  };

  const fetchTheRest = async () => {
    syncing = true;
    syncedThisSession.add(album.id);
    paint();
    try {
      await client.syncAlbum(album.id);
    } catch (error) {
      // A provider that will not answer is not worth a banner over an album
      // that already has something to show.
      toast(String(error?.message || error));
    }
    syncing = false;
    if (sheet.isConnected) await load();
  };
  const paint = () => {
    if (!sheet.isConnected) return;
    const tracks = album.tracks || [];
    clear(sheet);
    sheet.appendChild(backRow(params.from));
    sheet.appendChild(
      header({
        client,
        artworkUrl: album.artworkUrl,
        title: album.title || "Album",
        lines: [
          [artistLine(album), album.year].filter(Boolean).join(" \u00b7 "),
          syncing
            ? "getting the rest from the provider..."
            : tracks.length
              ? trackCountLine(tracks)
              : "Not in the library yet",
          (album.providers || []).join(", "),
        ],
        actions: [
          syncControl({
            label: tracks.length ? "Sync again" : "Sync into library",
            running: "Syncing...",
            title: "Bring this album's tracks into the library",
            hint: "Asking the provider about this album.",
            work: () => syncAndSay(client, { id: album.id, name: album.title, album: true }, load),
          }),
        ],
      })
    );
    if (!tracks.length) {
      sheet.appendChild(
        emptyState("note", "Nothing to play yet", "Syncing the album brings its tracks in and makes them playable.")
      );
      return;
    }
    sheet.appendChild(...playButtons(tracks));
    sheet.appendChild(
      h(
        "div",
        { class: "list" },
        tracks.map((track, position) =>
          trackRow({
            track,
            position,
            client,
            onActivate: () => playTracks(tracks, position),
            menu: trackMenu(track),
          })
        )
      )
    );
  };

  try {
    await load();
  } catch (error) {
    if (sheet.isConnected) mount(sheet, emptyState("note", "That album could not be loaded", String(error?.message || error)));
  }
}
