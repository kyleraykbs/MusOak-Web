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
  loadingState, artworkImage, skeletonRows,
} from "../dom.js";
import { banner, currentClient, navigate, refreshCurrent, registerView, requireLogin, serverAnswered, openFavoriteDialog, favoriteRating, inBrowser } from "../app.js";
import { isSignedIn, state } from "../state.js";
import { currentRoom } from "../rooms-state.js";
import * as offline from "../offline.js";
import { player } from "../player.js";
import { artistLine, artistLineNode, goToArtistItem, playOne, playTracks, providerErrorLines, queueButton, queueNextTracks, queueLastTracks, reportError, shuffleItems } from "./queue.js";
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

/** A cover tile: stable dimensions plus lazy, asynchronous image decode. */
export function artworkTile(client, path, size = "") {
  const className = `art ${size}`.trim();
  if (!path) return h("div", { class: className, "aria-hidden": "true" }, icon("note", size === "big" ? 44 : 18));
  return artworkImage(client ? client.artworkUrl(path) : path, { className, eager: size === "big" });
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
      onclick: () => queueNextTracks(list),
    })
  );
  if (withShuffleQueue) {
    buttons.push(
      h("button", {
        class: "btn",
        text: "Shuffle Queue",
        disabled: empty,
        title: "Add these tracks to the play queue in a random order",
        onclick: () => queueNextTracks(shuffleItems(list)),
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
    items.push({ label: "Queue", onClick: () => queueNextTracks([track]) });
    items.push({ label: "Queue last", onClick: () => queueLastTracks([track]) });
    items.push({ label: "Radio", onClick: () => startRadio(track) });
  }
  items.push({ label: "Add to playlist…", onClick: () => addToPlaylistDialog([track]) });
  items.push({ label: "Download song file", onClick: () => downloadSongFile(track) });
  items.push({ label: "Share…", onClick: () => shareTrack(track) });
  const rating = favoriteRating(track.id);
  items.push({
    label: rating == null ? "Rate favourite…" : `Rating ${Number(rating).toFixed(1)}/5.0…`,
    onClick: () => openFavoriteDialog(track.id),
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
    // Whether the server has the file is asked of the status the bar's own
    // poll reads, not of the listing the variant just came in: a listing is a
    // snapshot, and "Asking the server for the file…" over a file that landed
    // a moment ago is the page claiming to have asked when it did not.
    const status = await client.mediaStatus(variant.id).catch(() => null);
    if ((status?.state || variant.media?.state) !== "ready") {
      toast("Asking the server for the file…");
      await client.startDownload(variant.id);
    }
    const artists = artistLine(track);
    const name = fileName(`${artists ? `${artists} - ` : ""}${track.title || "song"}`);
    const link = h("a", { class: "visually-hidden", href: client.mediaUrl(variant.id), download: name });
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

/** One track in a list: number, artwork, title, artist, time, a ⋮ menu and an
 *  optional trailing control (the favourites list's rating). */
export function trackRow({ track, position, client, onActivate, menu = [], trailing = null }) {
  return h(
    "div",
    {
      class: "row clickable",
      onclick: (event) => {
        if (event.target.closest?.("button")) return;
        onActivate?.();
      },
    },
    h("span", { class: "time playlist-track-number", text: String(position + 1) }),
    artworkTile(client, track.artworkUrl),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", text: track.title || "" }),
      artistLineNode(artistLine(track), (track.artistIds || [])[0])
    ),
    h("span", { class: "time", text: track.durationMs ? fmtDuration(track.durationMs) : "" }),
    queueButton(track, { class: "btn flat round" }),
    iconButton("dots", {
      title: "More actions",
      onclick: (event) => popover(event.currentTarget, menu),
    }),
    // A row's own extra, after the controls it shares with every other row:
    // the favourites list puts its rating here, so the grow before it is what
    // pushes the time, the buttons and the rating into one right-hand column.
    trailing
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
  const picker = h("select", { class: "input", disabled: true }, h("option", { text: "Loading playlists…" }));
  const name = h("input", { class: "input", placeholder: "…or a new playlist name", disabled: true });
  const status = h("span", { class: "subtitle", role: "status", text: "Loading playlists…" });
  const body = h("div", { class: "field" }, h("label", { text: `${list.length} track(s)` }), picker, name, status);
  let submit = null;
  const ref = dialog({ title: "Add to playlist", body, actions: [{ label: "Cancel" }, { label: "Add", class: "suggested", onClick: () => submit?.() }], onOpen: () => name.focus() });
  let playlists;
  try {
    playlists = await client.playlists();
  } catch (error) {
    ref.close();
    reportError(error);
    return;
  }
  mount(picker, playlists.length
    ? playlists.map((playlist) => h("option", { value: playlist.id, text: playlist.name }))
    : h("option", { value: "", text: "(no playlists yet)" }));
  picker.disabled = false;
  name.disabled = false;
  status.textContent = "";
  submit = async () => {
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
  };
}

// --- the playlist page -----------------------------------------------------

let sheet = null; // the piece of the page this view owns
let activeId = ""; // and the playlist it drew
let activeName = "Playlist";
let loadGeneration = 0;

function renderPlaylist(container, params = {}) {
  // A sheet of its own inside the container, so a fetch that finishes after the
  // user has moved on lands in a detached node instead of another view's page.
  sheet = h("div", { class: "view-sheet" });
  mount(container, sheet);
  activeId = String(params?.id || "");
  return loadPlaylist();
}

async function loadPlaylist() {
  const target = sheet;
  const mine = ++loadGeneration;
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

  if (!target.firstChild || !target.querySelector(".playlist-refresh-loading")) mount(target, h("div", { class: "loading-panel playlist-refresh-loading" }, skeletonRows(5), h("span", { class: "loading-caption", text: "Loading playlist…" })));

  // The same rule the play buttons follow: a page that already knows it has no
  // server goes straight to the copy kept here, rather than spending the wait
  // on a request whose only possible answer is "no". A page that still believes
  // the server is there asks it first, as it always did.
  if (!player.online() && (await drawKept(target))) return;

  let detail;
  try {
    detail = await client.playlist(activeId);
  } catch (error) {
    // The server cannot say what this playlist holds, but this browser can: a
    // playlist kept here plays with no server at all, so its page is drawn from
    // the index and the cache instead of being left as a failure. Without this
    // the one page a kept playlist has was the one page that would not open. A
    // server that *answered* is not one that cannot answer - a refusal is the
    // server's own word on it, and that word is what the page shows.
    if (!serverAnswered(error) && (await drawKept(target))) return;
    reportError(error);
    mount(target, emptyState("note", "Could not load this playlist", error?.message || ""));
    return;
  }
  if (mine !== loadGeneration || !target.isConnected) return;

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
              // Clicking a song queues the list up to it, not the whole list:
              // what is below the click is not what was asked for, and a queue
              // of everything makes every later choice a place in a long list
              // rather than the song that was picked. "Play all" is the button
              // for all of it.
              onActivate: () => playOne(tracks, position, { playlistId: activeId }),
              menu: trackMenu(track, [{ label: "Remove from playlist", onClick: () => removeEntry(position) }], {
                playlistId: activeId,
              }),
            })
          )
        )
      : emptyState("note", "Empty playlist", "Add tracks from search.")
  );
}

/**
 * Draw this playlist from the copy kept on this machine. Says whether there was
 * one to draw, so the caller can report the failure it had when there was not.
 *
 * What comes back is the page's ordinary shape - the same header, the same
 * rows, the same Play button - filled from the index and the cache rather than
 * from the server, because that is all a kept playlist needs: its songs carry
 * the URL their own bytes are at, and the player plays them without asking
 * anybody. The header's own actions are the ones the server would have to
 * perform, so a kept copy shows none of them.
 */
async function drawKept(target) {
  await offline.ensureLoaded();
  if (!offline.isKept(activeId)) return false;
  const kept = await offline.playlistEntries(activeId);
  if (!kept) return false;
  if (!target.isConnected) return true;

  const tracks = offline.keptTracks(kept.entries);
  activeName = kept.name || "Playlist";
  if (!tracks.length) {
    // Kept, and the browser has since let every song of it go: the page says so
    // rather than drawing a list of nothing with a Play button over it.
    mount(
      target,
      emptyState("cloud", "Nothing to play", offline.keptGoneMessage(kept.name, kept.missing, kept.missing.length))
    );
    return true;
  }
  if (kept.missing.length) {
    // Some songs are gone and the rest are here: the page plays what it has and
    // says what it does not, rather than refusing the whole list.
    banner(offline.keptGoneMessage(kept.name, kept.missing, tracks.length + kept.missing.length));
  }

  mount(
    target,
    header(currentClient(), { id: activeId, name: kept.name, mine: false }, tracks),
    h("div", {
      class: "subtitle",
      text: "Kept on this machine \u2014 this page plays without the server.",
    }),
    h(
      "div",
      { class: "list" },
      tracks.map((track, position) => keptTrackRow(tracks, track, position))
    )
  );
  return true;
}

/** One song of a kept copy: the row every list draws, with the menu cut to what
 *  can be done with no server - play it here, or put it in this page's queue. */
function keptTrackRow(tracks, track, position) {
  return trackRow({
    track,
    position,
    client: null,
    onActivate: () => playOne(tracks, position, { playlistId: activeId }),
    menu: [
      { label: "Play", onClick: () => playOne(tracks, position, { playlistId: activeId }) },
      { label: "Queue", onClick: () => queueNextTracks([track]) },
      { label: "Queue last", onClick: () => queueLastTracks([track]) },
    ],
  });
}

function header(client, playlist, tracks) {
  // A server that predates visibilities says nothing about who owns a
  // playlist, and then this is the owner looking at their own.
  const mine = playlist.mine !== false;
  const management = mine
    ? h(
        "div",
        { class: "playlist-header-management" },
        h("button", { class: "btn", text: "Upload cover", title: "Set this playlist's cover", onclick: uploadCover }),
        h("button", { class: "btn", text: "Rename", title: "Rename this playlist", onclick: renamePlaylist }),
        h("button", { class: "btn destructive", text: "Delete", title: "Delete this playlist", onclick: deletePlaylist })
      )
    : null;
  return h(
    "div",
    { class: "card collection-header playlist-header" },
    h(
      "div",
      { class: "collection-header-row" },
      artworkTile(client, playlist.artworkUrl, "big"),
      h(
        "div",
        { class: "grow collection-header-copy" },
        h(
          "div",
          { class: "collection-header-title-row playlist-header-title-row" },
          h("div", { class: "title collection-header-title", text: playlist.name || "Playlist" }),
          playlist.public === false ? h("span", { class: "tag", text: "private" }) : null
        ),
        h("div", { class: "subtitle", text: trackCountLine(tracks) })
      )
    ),
    management,
    mine ? visibilityControl(playlist) : null,
    h(
      "div",
      { class: "playlist-detail-actions" },
      ...playButtons(tracks, { playlistId: activeId })
    )
  );
}

function visibilityControl(playlist) {
  const isPublic = playlist.public !== false;
  return h(
    "div",
    { class: "field playlist-visibility" },
    h("label", { text: "Visibility" }),
    h(
      "select",
      {
        class: "input",
        "aria-label": "Playlist visibility",
        onchange: (event) => setPlaylistVisibility(playlist, event.currentTarget.value === "public", event.currentTarget),
      },
      h("option", { value: "public", text: "Public", selected: isPublic }),
      h("option", { value: "private", text: "Private", selected: !isPublic })
    )
  );
}

/** Set the playlist's visibility and redraw the header with the server's answer. */
async function setPlaylistVisibility(playlist, isPublic, control) {
  const client = currentClient();
  if (!client) return;
  control.disabled = true;
  try {
    await client.setPlaylistPublic(activeId, isPublic);
    toast(isPublic ? "Anyone who can see your page can see it now." : "Only you can see it now.");
    await loadPlaylist();
  } catch (error) {
    control.value = playlist.public === false ? "private" : "public";
    reportError(error);
  } finally {
    control.disabled = false;
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
