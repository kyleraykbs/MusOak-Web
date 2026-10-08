// One playlist: its cover, its tracks, and everything you can do with them.
//
// The row, the ⋮ menu, the Play/Shuffle/Queue buttons and the "add to playlist"
// dialog are shared with favourites.js; the index math and the player live one
// file down, in queue.js.

import {
  confirm,
  dialog,
  fileToBase64,
  fmtDuration,
  h,
  icon,
  iconButton,
  iconOr,
  mount,
  pickFile,
  popover,
  prompt,
  toast,
} from "../dom.js";
import { banner, currentClient, navigate, refreshCurrent, registerView, requireLogin, toggleFavorite, inBrowser } from "../app.js";
import { isSignedIn, state } from "../state.js";
import { currentRoom } from "../rooms-state.js";
import { artistLine, artistLineNode, enqueueTracks, providerErrorLines, queueNextTracks, goToArtistItem, playTracks, reportError, shuffleItems } from "./queue.js";
import { shareTrack } from "./share.js";

registerView({
  id: "playlist",
  title: "Playlist",
  hidden: true,
  render: renderPlaylist,
  refresh: loadPlaylist,
});

// An upload travels in the request body, so it stays modest.
const MAX_COVER_BYTES = 8 << 20;

// What the server accepts, by media type and — when the browser does not know
// one — by the name the file came with.
const COVER_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const COVER_BY_SUFFIX = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

/** Whether the shell is following a room: there, the room decides what plays. */
function inRoom() {
  return Boolean(currentRoom());
}

// --- the pure parts --------------------------------------------------------

/** How long a list of tracks runs, in milliseconds. */
export function totalDurationMs(tracks = []) {
  return (tracks || []).reduce((sum, track) => sum + Math.max(0, Number(track?.durationMs) || 0), 0);
}

/** "12 tracks · 47:05" — what a playlist says under its name. */
export function trackCountLine(tracks = []) {
  const list = Array.from(tracks || []);
  return `${list.length} track${list.length === 1 ? "" : "s"} · ${fmtDuration(totalDurationMs(list))}`;
}

// --- pieces the list views share -------------------------------------------

/** The icon, a line and a line of explanation a view shows instead of a list. */
export function emptyState(name, title, body, ...extra) {
  return h(
    "div",
    { class: "empty" },
    h("span", { class: "icon" }, iconOr(name, 38)),
    h("span", { class: "title", text: title }),
    body ? h("span", { text: body }) : null,
    ...extra
  );
}

/** A cover tile: the artwork when the server has one, a note otherwise. */
export function artworkTile(client, path, size = "") {
  const className = `art ${size}`.trim();
  if (path) {
    return h("img", { class: className, alt: "", src: client ? client.artworkUrl(path) : path });
  }
  return h("div", {
    class: className,
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--bg4)",
    },
  }, icon("note", size === "big" ? 44 : 18));
}

/**
 * The buttons a list of tracks gets. In a room they queue into the room
 * instead, because there the room decides what plays.
 *
 * `playlistId` is the playlist the tracks came from when the buttons belong to
 * a playlist page, so playing from here records what to reopen next time.
 */
export function playButtons(tracks, { withShuffleQueue = true, playlistId = "" } = {}) {
  const list = Array.from(tracks || []);
  const empty = !list.length;
  const buttons = [];

  if (inRoom()) {
    buttons.push(
      h("button", {
        class: "btn suggested",
        text: "Queue",
        disabled: empty,
        title: "Add these tracks to the room queue",
        onclick: () => playTracks(list, 0),
      }),
      h("button", {
        class: "btn",
        text: "Shuffle Queue",
        disabled: empty,
        title: "Add these tracks to the room queue in a random order",
        onclick: () => playTracks(shuffleItems(list), 0),
      })
    );
    return buttons;
  }

  buttons.push(
    h("button", {
      class: "btn suggested",
      text: "Play",
      disabled: empty,
      title: "Play these tracks",
      onclick: () => playTracks(list, 0, { playlistId }),
    }),
    h("button", {
      class: "btn",
      text: "Shuffle",
      disabled: empty,
      title: "Play these tracks in a random order",
      onclick: () => playTracks(shuffleItems(list), 0, { playlistId }),
    }),
    h("button", {
      class: "btn",
      text: "Queue",
      disabled: empty,
      title: "Add these tracks to the play queue",
      onclick: () => enqueueTracks(list),
    })
  );
  if (withShuffleQueue) {
    buttons.push(
      h("button", {
        class: "btn",
        text: "Shuffle Queue",
        disabled: empty,
        title: "Add these tracks to the play queue in a random order",
        onclick: () => enqueueTracks(shuffleItems(list)),
      })
    );
  }
  return buttons;
}

/** The ⋮ menu every track carries, with whatever the view adds to it.
 *
 * `playlistId` is the playlist a row belongs to, so the menu's own Play records
 * it the same way the row click and the page's Play do; a view that is not a
 * playlist passes nothing, which clears it.
 */
/**
 * Build a station out of a song and play it: the song first, then what the
 * providers think belongs beside it.
 *
 * Nothing is saved: the menu's Radio is a station to listen to now, and a saved
 * list would turn up among somebody's playlists unasked.
 */
async function startRadio(track) {
  const client = currentClient();
  if (!client || !track?.id) return;
  toast(`Building a radio from \u201c${track.title || "this song"}\u201d\u2026`);
  try {
    const station = await client.radio(track.id, { save: false });
    const list = [track, ...(station?.tracks || [])];
    if (list.length < 2) {
      toast(radioEmptyReason(station));
      return;
    }
    playTracks(list, 0);
  } catch (error) {
    reportError(error);
  }
}

/** Why a station came back empty, in the words the toast can use. A provider
 *  that failed is the usual reason, and its own sentence says more than
 *  "nothing came back" ever could. */
export function radioEmptyReason(station) {
  const problems = providerErrorLines(station?.providerErrors || []);
  return problems.length
    ? `Nothing came back to build a radio from \u2014 ${problems.join("; ")}`
    : "Nothing came back to build a radio from.";
}

export function trackMenu(track, extra = [], { playlistId = "" } = {}) {
  const items = [];
  if (inRoom()) {
    // In a room the room decides what plays, so there is one way in.
    items.push({ label: "Queue in the room", onClick: () => playTracks([track], 0) });
  } else {
    items.push({ label: "Play", onClick: () => playTracks([track], 0, { playlistId }) });
    items.push({ label: "Queue next", onClick: () => queueNextTracks([track]) });
    items.push({ label: "Queue", onClick: () => enqueueTracks([track]) });
    items.push({ label: "Radio", onClick: () => startRadio(track) });
  }
  items.push({ label: "Add to playlist…", onClick: () => addToPlaylistDialog([track]) });
  items.push({ label: "Download song file", onClick: () => downloadSongFile(track) });
  items.push({ label: "Share…", onClick: () => shareTrack(track) });
  items.push({
    label: state.favorites.has(track.id) ? "Unfavourite" : "Favourite",
    onClick: () => toggleFavorite(track.id),
  });
  // Only when the track names an artist: an artist's page needs an id, and a
  // name alone cannot name one.
  const artist = goToArtistItem(track);
  if (artist) items.push(artist);
  return [...items, ...extra];
}

/**
 * Save a song's file to disk.
 *
 * The browser is handed the media URL itself rather than a fetch: the server
 * answers that path on this origin (the query names which backend it is), so a
 * plain download link saves the .opus without the bytes passing through this
 * page. A song the server has not fetched yet is asked for first, because there
 * is nothing to download until it has the file.
 */
export async function downloadSongFile(track) {
  const client = currentClient();
  if (!client || !track?.id) return;
  try {
    const variants = await client.variants(track.id);
    const variant = (variants || []).find((entry) => entry.downloadable);
    if (!variant) {
      toast("There is no file to download for that song.");
      return;
    }
    if (variant.media?.state !== "ready") {
      toast("Asking the server for the file…");
      await client.startDownload(variant.id);
    }
    const artists = artistLine(track);
    const name = fileName(`${artists ? `${artists} - ` : ""}${track.title || "song"}`);
    const link = h("a", { href: client.mediaUrl(variant.id), download: name, style: { display: "none" } });
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast(`Saving ${name}`);
  } catch (error) {
    reportError(error);
  }
}

/** A name safe to save under: the song's own, minus what a path would object
 *  to, with the extension the media is stored in. */
function fileName(value) {
  const cleaned = String(value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return `${cleaned || "song"}.opus`;
}

/** One track in a list: number, artwork, title, artist, time and a ⋮ menu. */
export function trackRow({ track, position, client, onActivate, menu = [] }) {
  return h(
    "div",
    {
      class: "row clickable",
      onclick: (event) => {
        if (event.target.closest?.("button")) return;
        onActivate?.();
      },
    },
    h("span", { class: "time", style: { width: "24px" }, text: String(position + 1) }),
    artworkTile(client, track.artworkUrl),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", text: track.title || "" }),
      artistLineNode(artistLine(track), (track.artistIds || [])[0])
    ),
    h("span", { class: "time", text: track.durationMs ? fmtDuration(track.durationMs) : "" }),
    iconButton("dots", {
      title: "More actions",
      onclick: (event) => popover(event.currentTarget, menu),
    })
  );
}

/**
 * Add tracks to one of the account's playlists, or to a new one named on the
 * spot. The new name wins over the pick, as it does in the GTK client.
 */
export async function addToPlaylistDialog(tracks) {
  const client = currentClient();
  const list = Array.from(tracks || []);
  if (!client || !list.length) return;

  let playlists;
  try {
    playlists = await client.playlists();
  } catch (error) {
    reportError(error);
    return;
  }

  const picker = h(
    "select",
    { class: "input" },
    playlists.length
      ? playlists.map((playlist) => h("option", { value: playlist.id, text: playlist.name }))
      : h("option", { value: "", text: "(no playlists yet)" })
  );
  const name = h("input", { class: "input", placeholder: "…or a new playlist name" });
  const status = h("span", { class: "subtitle" });

  dialog({
    title: "Add to playlist",
    body: h(
      "div",
      { class: "field" },
      h("label", { text: `${list.length} track(s)` }),
      picker,
      name,
      status
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Add",
        class: "suggested",
        onClick: async () => {
          const wanted = name.value.trim();
          const chosen = playlists.find((playlist) => playlist.id === picker.value);
          if (!wanted && !chosen) {
            status.textContent = "pick a playlist or name a new one";
            return false;
          }
          try {
            const target = wanted ? await client.createPlaylist(wanted) : chosen;
            await client.addToPlaylist(target.id, list.map((track) => track.id));
            toast(`Added ${list.length} track(s) to “${target.name}”`);
            refreshCurrent();
          } catch (error) {
            reportError(error);
            status.textContent = error?.message || String(error);
            return false;
          }
        },
      },
    ],
    onOpen: () => name.focus(),
  });
}

// --- the playlist page -----------------------------------------------------

let sheet = null; // the piece of the page this view owns
let activeId = ""; // and the playlist it drew
let activeName = "";

function renderPlaylist(container, params = {}) {
  // A sheet of its own inside the container, so a fetch that finishes after the
  // user has moved on lands in a detached node instead of another view's page.
  sheet = h("div", { style: { display: "contents" } });
  mount(container, sheet);
  activeId = String(params?.id || "");
  return loadPlaylist();
}

async function loadPlaylist() {
  const target = sheet;
  if (!target || !target.isConnected) return;
  if (!isSignedIn()) {
    // A guest has no playlist to show: the same ask the playlists list makes.
    mount(
      target,
      emptyState(
        "note",
        "No playlist",
        "Sign in to this server to see your playlists.",
        h("button", { class: "btn suggested", text: "Sign in", onclick: () => requireLogin() })
      )
    );
    return;
  }
  const client = currentClient();
  if (!client || !activeId) {
    mount(target, emptyState("note", "No playlist", "Open one from the Playlists tab."));
    return;
  }

  if (!target.firstChild) mount(target, emptyState("note", "Loading playlist…", ""));

  let detail;
  try {
    detail = await client.playlist(activeId);
  } catch (error) {
    reportError(error);
    mount(target, emptyState("note", "Could not load this playlist", error?.message || ""));
    return;
  }
  if (!target.isConnected) return; // the view moved on while we fetched

  const playlist = detail.playlist || {};
  const tracks = detail.tracks || [];
  activeName = playlist.name || "Playlist";

  mount(
    target,
    header(client, playlist, tracks),
    tracks.length
      ? h(
          "div",
          { class: "list" },
          tracks.map((track, position) =>
            trackRow({
              track,
              position,
              client,
              onActivate: () => playTracks(tracks, position, { playlistId: activeId }),
              menu: trackMenu(track, [{ label: "Remove from playlist", onClick: () => removeEntry(position) }], {
                playlistId: activeId,
              }),
            })
          )
        )
      : emptyState("note", "Empty playlist", "Add tracks from search.")
  );
}

function header(client, playlist, tracks) {
  // A server that predates visibilities says nothing about who owns a
  // playlist, and then this is the owner looking at their own.
  const mine = playlist.mine !== false;
  const visibility = mine
    ? h("button", {
        class: "btn",
        text: playlist.public === false ? "Make public" : "Make private",
        title: playlist.public === false
          ? "Anyone who can see your page would be able to see it"
          : "Only you would be able to see it",
        onclick: () => toggleVisibility(playlist),
      })
    : null;
  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "row" },
      h("button", {
        class: "btn round",
        title: "Back to playlists",
        onclick: () => navigate("playlists"),
      }, icon("prev", 18)),
      artworkTile(client, playlist.artworkUrl, "big"),
      h(
        "div",
        { class: "grow" },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 } },
          h("div", { class: "title", style: { fontSize: "22px", fontWeight: "600" }, text: playlist.name || "Playlist" }),
          playlist.public === false ? h("span", { class: "tag", text: "private" }) : null
        ),
        h("div", { class: "subtitle", text: trackCountLine(tracks) })
      )
    ),
    h(
      "div",
      { class: "row", style: { flexWrap: "wrap" } },
      ...playButtons(tracks, { playlistId: activeId }),
      mine ? h("button", { class: "btn", text: "Rename", title: "Rename this playlist", onclick: renamePlaylist }) : null,
      mine ? h("button", { class: "btn", text: "Upload cover", title: "Set this playlist's cover", onclick: uploadCover }) : null,
      visibility,
      mine ? h("button", { class: "btn destructive", text: "Delete", title: "Delete this playlist", onclick: deletePlaylist }) : null
    )
  );
}

/** Show a playlist to everybody who can see your page, or to nobody but you. */
async function toggleVisibility(playlist) {
  const client = currentClient();
  if (!client) return;
  const wanted = playlist.public === false;
  try {
    await client.setPlaylistPublic(activeId, wanted);
    toast(wanted ? "Anyone who can see your page can see it now." : "Only you can see it now.");
    await loadPlaylist();
  } catch (error) {
    reportError(error);
  }
}

async function renamePlaylist() {
  const client = currentClient();
  if (!client) return;
  const name = await prompt("Rename playlist", "Name", activeName, { confirm: "Rename" });
  if (!name) return;
  try {
    await client.renamePlaylist(activeId, name);
    toast("Playlist renamed");
    await loadPlaylist();
  } catch (error) {
    reportError(error);
  }
}

async function uploadCover() {
  const client = currentClient();
  if (!client) return;
  const file = await pickFile("image/*");
  if (!file) return;
  if (file.size > MAX_COVER_BYTES) {
    banner(`that image is larger than ${MAX_COVER_BYTES / (1 << 20)} MB`, "error");
    return;
  }
  const contentType = coverType(file);
  if (!contentType) {
    banner("that file is not a png, jpeg, webp, gif or avif image", "error");
    return;
  }
  try {
    await client.uploadPlaylistArtwork(activeId, await fileToBase64(file), contentType);
    toast("Cover set");
    await loadPlaylist();
  } catch (error) {
    reportError(error);
  }
}

function coverType(file) {
  if (COVER_TYPES.has(file.type)) return file.type;
  const suffix = String(file.name || "").split(".").pop().toLowerCase();
  return COVER_BY_SUFFIX[suffix] || "";
}

async function deletePlaylist() {
  const client = currentClient();
  if (!client) return;
  const agreed = await confirm("Delete playlist?", `“${activeName}” and its entries are removed.`, {
    confirm: "Delete",
    destructive: true,
  });
  if (!agreed) return;
  try {
    await client.deletePlaylist(activeId);
    toast("Playlist deleted");
    navigate("playlists");
  } catch (error) {
    reportError(error);
  }
}

async function removeEntry(position) {
  const client = currentClient();
  if (!client) return;
  try {
    await client.removeFromPlaylist(activeId, position);
    toast("Removed from the playlist");
    await loadPlaylist();
  } catch (error) {
    reportError(error);
  }
}

// The playbar's ⋮ asks for the song's menu rather than building one: the actions
// live here, with the rows that already offer them, so the menu is built in the
// same tick as the click.
if (inBrowser) {
  window.addEventListener("musoak:track-menu", (event) => {
    const { anchor, track } = event.detail || {};
    if (!anchor) return;
    popover(
      anchor,
      track
        ? trackMenu(track)
        : [
            { header: "Nothing playing" },
            { label: "View queue", onClick: () => window.dispatchEvent(new CustomEvent("musoak:open-queue")) },
          ]
    );
  });
}
