// Playlists: every list on the active server, with a way to make one.
//
// The shell (../app.js) is browser-guarded, so importing it is safe in Node:
// unit tests import this module for the pure helpers below without a window.

import {
  h, clear, mount, popover, prompt, confirm, pickFile, fileToBase64, dialog,
  toast, status, fmtDuration, icon, iconOr, iconButton,
} from "../dom.js";
import {
  registerView, navigate, banner, requireLogin, currentClient,
} from "../app.js";
import { isSignedIn } from "../state.js";
import * as offline from "../offline.js";
import { player } from "../player.js";
import {
  AUDIO_ACCEPT, audioContentType, guessMetadata, isAudioFile, pickFolder, pickFiles,
  uploadSizeError,
} from "./upload.js";

// A cover travels in the request body, so it stays modest.
const MAX_COVER_BYTES = 8 << 20;
const IMAGE_TYPES = /^image\//;

// --- pure helpers ----------------------------------------------------------

/** The total of the track durations, for a playlist the server did not sum. */
export function sumDurations(tracks = []) {
  let total = 0;
  for (const track of tracks || []) total += Number(track?.durationMs) || 0;
  return total;
}

/** The server's duration when it has one, otherwise the tracks' own total. */
export function playlistDurationMs(playlist) {
  const served = Number(playlist?.durationMs) || 0;
  return served || sumDurations(playlist?.tracks);
}

/** The server's track count when it has one, otherwise the loaded tracks. */
export function trackCount(playlist) {
  const served = Number(playlist?.trackCount) || 0;
  return served || (playlist?.tracks || []).length;
}

/** "12 tracks · 48:21" — the count always, the time when it is known. */
export function playlistSubtitle(playlist) {
  const count = trackCount(playlist);
  const parts = [`${count} track${count === 1 ? "" : "s"}`];
  const duration = playlistDurationMs(playlist);
  if (duration) parts.push(fmtDuration(duration));
  return parts.join(" \u00b7 ");
}

/**
 * What the playlist of an import is called: the folder the songs came from, or
 * a plain name for a loose selection. A folder pick gives every file a path
 * that begins with the folder's own name, and that name is the one to keep —
 * the folder is the album, whatever the files inside are called.
 */
export function importPlaylistName(files = []) {
  for (const file of files || []) {
    const path = String(file?.webkitRelativePath || "");
    const cut = path.indexOf("/");
    if (cut > 0) return path.slice(0, cut);
  }
  return "Imported songs";
}

// --- module state ----------------------------------------------------------

/** What the list says when nobody is signed in — the same line the playlist
 *  page uses, since neither has anything to show a guest. */
const SIGN_IN_HINT = "Sign in to this server to see your playlists.";

let current = null; // the container this view drew into
let listEl = null; // where the rows go
let signedInSheet = false; // whether the sheet on screen belongs to an account

// --- small builders --------------------------------------------------------

function artwork(path) {
  const client = currentClient();
  const source = path ? (client?.artworkUrl ? client.artworkUrl(path) : path) : "";
  if (!source) {
    return h("div", {
      class: "art small",
      style: { display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg4)" },
    }, icon("list"));
  }
  return h("img", { class: "art small", src: source, alt: "", loading: "lazy" });
}

function emptyState(mark, title, subtitle, ...extra) {
  return h(
    "div",
    { class: "empty" },
    mark,
    h("span", { class: "title", text: title }),
    subtitle ? h("span", { text: subtitle }) : null,
    ...extra
  );
}

/** What a guest sees instead of a list they cannot load. */
function guestState() {
  return emptyState(
    iconOr("list", 38),
    "No playlists",
    SIGN_IN_HINT,
    h("button", { class: "btn suggested", text: "Sign in", onclick: () => requireLogin() })
  );
}

function menuButton(open) {
  return iconButton("dots", {
    title: "More",
    onclick: (event) => {
      event.stopPropagation();
      open(event.currentTarget);
    },
  });
}

function handle(error) {
  if (error?.status === 401) requireLogin();
  else banner(error?.message || String(error), "error");
}

// --- playback --------------------------------------------------------------

async function play(playlist, shuffle = false) {
  const client = currentClient();
  if (!client) return;
  let tracks = [];
  try {
    tracks = (await client.playlist(playlist.id)).tracks || [];
  } catch (error) {
    handle(error);
    return;
  }
  if (!tracks.length) {
    toast(`${playlist.name || "That playlist"} has no tracks yet.`);
    return;
  }
  if (shuffle) tracks = [...tracks].sort(() => Math.random() - 0.5);
  player.play(tracks, 0);
}

// --- actions ---------------------------------------------------------------

async function create() {
  const name = await prompt("New playlist", "Give it a name.", "", { confirm: "Create" });
  if (!name) return;
  const client = currentClient();
  if (!client) return;
  try {
    await client.createPlaylist(name);
    await load();
    toast("Playlist created");
  } catch (error) {
    handle(error);
  }
}

/** Show a playlist to everybody who can see your page, or to nobody but you. */
async function setVisibility(playlist, isPublic) {
  const client = currentClient();
  if (!client) return;
  try {
    await client.setPlaylistPublic(playlist.id, isPublic);
    await load();
    toast(isPublic ? "Anyone who can see your page can see it now" : "Only you can see it now");
  } catch (error) {
    handle(error);
  }
}

async function rename(playlist) {
  const name = await prompt("Rename playlist", "Name", playlist.name || "", { confirm: "Rename" });
  if (!name || name === playlist.name) return;
  const client = currentClient();
  if (!client) return;
  try {
    await client.renamePlaylist(playlist.id, name);
    await load();
    toast("Playlist renamed");
  } catch (error) {
    handle(error);
  }
}

async function uploadCover(playlist) {
  const file = await pickFile("image/*");
  if (!file) return;
  if (file.size > MAX_COVER_BYTES) {
    banner("That image is too large for a playlist cover (8 MiB).", "error");
    return;
  }
  if (file.type && !IMAGE_TYPES.test(file.type)) {
    banner("Pick an image file for the cover.", "error");
    return;
  }
  const client = currentClient();
  if (!client) return;
  try {
    const data = await fileToBase64(file);
    await client.uploadPlaylistArtwork(playlist.id, data, file.type || "image/png");
    await load();
    toast("Cover updated");
  } catch (error) {
    handle(error);
  }
}

/**
 * Save every song in a playlist as one zip.
 *
 * The server writes the zip into the download as it goes, fetching any song it
 * does not have yet on the way, so a playlist nothing has played takes as long
 * as its downloads do - which is what the count of songs is for. It goes
 * through a link rather than a fetch: a download is the one request a browser
 * waits for as long as it takes, and a fetch would have to hold the whole
 * archive in memory first.
 */
async function downloadZip(playlist) {
  const client = currentClient();
  if (!client || !playlist?.id) return;
  const name = playlist.name || "the playlist";
  status(`Preparing \u201c${name}\u201d\u2026`);
  try {
    const archive = await client.startPlaylistArchive(playlist.id);
    // The download starts now: the songs are written as the browser reads them.
    const link = h("a", { href: client.archiveFileUrl(archive.archiveId), download: "" });
    document.body.appendChild(link);
    link.click();
    link.remove();

    let state = archive;
    let waiting = 0;
    while (state.state !== "done") {
      if (state.state === "failed") throw new Error(state.error || "the download failed");
      // An archive nobody downloaded stays ready: the browser never asked.
      if (state.state === "ready" && ++waiting > 20) throw new Error("the download did not start");
      status(`${state.done} of ${state.total} songs in \u201c${name}\u201d\u2026`);
      await new Promise((resolve) => setTimeout(resolve, 800));
      state = await client.archiveStatus(archive.archiveId);
    }
    status("");
    toast(`${state.done} of ${state.total} songs \u2014 the zip is saving`);
  } catch (error) {
    status("");
    toast(String(error?.message || error));
  }
}

async function remove(playlist) {
  const yes = await confirm(
    "Delete playlist?",
    `\u201c${playlist.name || "This playlist"}\u201d and its entries are removed.`,
    { confirm: "Delete", destructive: true }
  );
  if (!yes) return;
  const client = currentClient();
  if (!client) return;
  try {
    await client.deletePlaylist(playlist.id);
    await load();
    toast("Playlist deleted");
  } catch (error) {
    handle(error);
  }
}

function playlistMenu(playlist) {
  return [
    { label: "Play", onClick: () => play(playlist, false) },
    { label: "Shuffle", onClick: () => play(playlist, true) },
    { label: "Download as zip", onClick: () => downloadZip(playlist) },
    { separator: true },
    { label: "Rename", onClick: () => rename(playlist) },
    { label: "Upload cover", onClick: () => uploadCover(playlist) },
    {
      label: playlist.public === false ? "Make public" : "Make private",
      onClick: () => setVisibility(playlist, playlist.public === false),
    },
    { separator: true },
    { label: "Delete", onClick: () => remove(playlist) },
  ];
}

// --- rows and loading ------------------------------------------------------

function playlistRow(playlist) {
  // The download/cloud control does its own thing: its clicks must not also
  // open the playlist the way a click anywhere else in the row does.
  const keep = offline.button(playlist);
  keep.addEventListener("click", (event) => event.stopPropagation());
  return h(
    "div",
    {
      class: "row clickable",
      onclick: () => navigate("playlist", { id: playlist.id }),
    },
    artwork(playlist.artworkUrl),
    h(
      "div",
      { class: "grow" },
      h(
        "div",
        { style: { display: "flex", alignItems: "center", gap: "8px", minWidth: 0 } },
        h("div", { class: "title", text: playlist.name || "Untitled" }),
        playlist.public === false ? h("span", { class: "tag", text: "private" }) : null
      ),
      h("div", { class: "subtitle", text: playlistSubtitle(playlist) })
    ),
    keep,
    menuButton((anchor) => popover(anchor, playlistMenu(playlist)))
  );
}

function show(playlists) {
  if (!listEl) return;
  if (!playlists.length) {
    mount(
      listEl,
      emptyState(
        iconOr("list", 38),
        "No playlists",
        "Create one, then add tracks from anywhere with a track's menu."
      )
    );
    return;
  }
  mount(listEl, h("div", { class: "list" }, playlists.map(playlistRow)));
}

async function load() {
  if (!current) return;
  // A guest has nothing to load, and nothing they could do with what they
  // cannot see: the view is the sign-in prompt.
  if (!isSignedIn()) {
    if (signedInSheet) sheet();
    return;
  }
  if (!signedInSheet) sheet();
  const client = currentClient();
  if (!client || !listEl) return;
  clear(listEl);
  listEl.appendChild(h("div", { class: "empty" }, h("span", { class: "title", text: "Loading playlists..." })));
  try {
    show(await client.playlists());
  } catch (error) {
    if (listEl) clear(listEl);
    handle(error);
  }
}

// --- importing from a platform ---------------------------------------------

/** The platforms a playlist can be brought over from, in the order offered. */
const PLATFORMS = [
  { id: "ytmusic", label: "YouTube Music" },
  { id: "spotify", label: "Spotify" },
];

/**
 * Bring a playlist over from another platform.
 *
 * The server does the work: it reads the playlist, matches every track into the
 * library, finds each one somewhere it can actually be played, and makes the
 * result a playlist of this account's own. Spotify needs no credentials for any
 * of that - a public playlist is read from its embed page - so a link is enough
 * there, while YouTube Music can be searched as well.
 */
function importDialog() {
  const client = currentClient();
  if (!client) return;

  let platform = PLATFORMS[0].id;
  let mode = "search";
  let picked = null;
  let busy = false;

  const input = h("input", { class: "input" });
  const results = h("div", { class: "list", style: { maxHeight: "220px", overflow: "auto" } });
  const status = h("div", { class: "login-status", role: "status" });

  const platformName = () => (PLATFORMS.find((entry) => entry.id === platform) || {}).label || platform;

  /** The input and the button say what this mode wants. */
  const restyle = () => {
    const searching = mode === "search";
    input.value = "";
    input.placeholder = searching ? `Search ${platformName()} playlists` : "Paste a playlist link";
    find.style.display = searching ? "" : "none";
    status.className = "login-status";
    status.textContent = searching ? "" : `A public ${platformName()} playlist link works without a key.`;
  };

  const choose = (row, value, apply) =>
    h(
      "button",
      {
        class: "tab",
        text: value.label,
        onclick: (event) => {
          apply(value.id);
          picked = null;
          mount(results);
          for (const button of row.children) button.classList.toggle("active", button === event.currentTarget);
          restyle();
        },
      }
    );

  const platformRow = h("div", { class: "row", style: { border: "0", padding: "0", gap: "6px" } });
  for (const entry of PLATFORMS) platformRow.appendChild(choose(platformRow, entry, (id) => { platform = id; }));
  platformRow.firstChild.classList.add("active");

  const modeRow = h("div", { class: "row", style: { border: "0", padding: "0", gap: "6px" } });
  for (const entry of [{ id: "search", label: "From search" }, { id: "link", label: "From a link" }]) {
    modeRow.appendChild(choose(modeRow, entry, (id) => { mode = id; }));
  }
  modeRow.firstChild.classList.add("active");

  const find = h("button", { class: "btn", text: "Find", onclick: () => void search() });

  async function search() {
    const query = input.value.trim();
    if (!query) return;
    status.className = "login-status";
    status.textContent = `Searching ${platformName()}...`;
    mount(results);
    try {
      const { playlists, providerErrors } = await client.searchPlaylists(query, 20);
      const mine = (playlists || []).filter((entry) => (entry.provider || "") === platform);
      status.className = "login-status";
      status.textContent = mine.length ? "" : providerErrors?.[0]?.error || `No ${platformName()} playlists matched.`;
      mount(
        results,
        ...mine.map((entry) =>
          h(
            "div",
            {
              class: "row clickable",
              onclick: (event) => {
                picked = entry;
                for (const row of results.children) row.classList.toggle("active", row === event.currentTarget);
                status.className = "login-status";
                status.textContent = `Ready to import “${entry.title || "that playlist"}”`;
              },
            },
            h(
              "div",
              { class: "grow" },
              h("div", { class: "title", text: entry.title || "Untitled" }),
              h("div", {
                class: "subtitle",
                text: [entry.owner, entry.trackCount ? `${entry.trackCount} tracks` : ""].filter(Boolean).join(" \u00b7 "),
              })
            )
          )
        )
      );
    } catch (error) {
      status.className = "login-status error";
      status.textContent = String(error?.message || error);
    }
  }

  /** False keeps the box open, so a failure can say why. */
  async function run() {
    if (busy) return false;
    const link = input.value.trim();
    if (!picked && !link) {
      status.className = "login-status error";
      status.textContent = mode === "search" ? "Pick a playlist from the results first." : "Paste a playlist link.";
      return false;
    }
    busy = true;
    status.className = "login-status";
    status.textContent = "Reading the playlist…";
    try {
      const started = await client.importPlaylist({
        provider: platform,
        id: picked ? picked.providerPlaylistId || picked.id || "" : "",
        url: picked ? "" : link,
      });
      const jobId = started.jobId || "";
      if (!jobId) throw new Error("the import did not start");

      // The job does the work; this watches it. Each track is a provider
      // search, so the count is the only thing worth showing.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        const job = await client.importStatus(jobId);
        if (job.state === "running") {
          status.className = "login-status";
          status.textContent = job.total
            ? `Finding each song: ${job.done} of ${job.total}…`
            : "Reading the playlist…";
          continue;
        }
        if (job.state !== "done") throw new Error(job.error || "the import failed");
        const playlist = job.playlist || {};
        toast(`Imported ${job.done || 0} track(s), ${job.playable || 0} ready to play`);
        await load();
        if (playlist.id) navigate("playlist", { id: playlist.id });
        return undefined;
      }
    } catch (error) {
      status.className = "login-status error";
      status.textContent = String(error?.message || error);
      busy = false;
      return false;
    }
  }

  restyle();
  dialog({
    title: "Import a playlist",
    body: h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "10px", minWidth: "min(420px, 80vw)" } },
      platformRow,
      modeRow,
      h("div", { style: { display: "flex", gap: "8px" } }, input, find),
      results,
      status
    ),
    actions: [{ label: "Cancel" }, { label: "Import", class: "suggested", onClick: () => run() }],
  });
}

// --- importing song files from this machine --------------------------------

/**
 * Upload a folder, or a handful of loose files, and make a playlist of them.
 *
 * This is not the Upload view's one-dialog-per-song walk: a folder can be
 * dozens of files and none of them need a decision, so the names come from the
 * files themselves and the walk is one upload after another with a count of
 * where it has got to. A file the server refuses is written down and passed
 * over rather than stopping the rest, and a playlist is only made when at
 * least one song came back — an empty list is not worth a name.
 */
function importFilesDialog() {
  const client = currentClient();
  if (!client) return;

  let busy = false;
  let close = () => {};

  const line = h("div", { class: "login-status", role: "status" });
  const note = h("div", { style: { color: "var(--fg4)", fontSize: "12.5px" } });
  const report = h("div", { class: "list", style: { maxHeight: "200px", overflow: "auto" } });
  const after = h("div", { style: { display: "flex", gap: "8px" } });

  const folderButton = h("button", { class: "btn", text: "Choose a folder", onclick: () => void choose(true) });
  const fileButton = h("button", { class: "btn", text: "Choose files", onclick: () => void choose(false) });

  const say = (message, kind = "") => {
    line.className = `login-status ${kind}`.trim();
    line.textContent = message;
  };

  /** The picker first, then the walk; a folder carries its own name with it. */
  async function choose(isFolder) {
    if (busy) return;
    let chosen = [];
    try {
      chosen = isFolder ? await pickFolder() : await pickFiles(AUDIO_ACCEPT);
    } catch (error) {
      say(String(error?.message || error), "error");
      return;
    }
    if (!chosen.length) return;
    const audio = chosen.filter(isAudioFile);
    const skipped = chosen.length - audio.length;
    note.textContent = skipped ? `Skipped ${skipped} of ${chosen.length} file(s): not audio.` : "";
    if (!audio.length) {
      say("None of the files chosen are audio.", "error");
      return;
    }
    await run(audio, importPlaylistName(chosen), skipped);
  }

  async function run(audio, name, skipped) {
    busy = true;
    folderButton.disabled = true;
    fileButton.disabled = true;
    mount(report);
    mount(after);

    const trackIds = [];
    const failed = [];
    for (let index = 0; index < audio.length; index += 1) {
      const file = audio[index];
      say(`Uploading ${index + 1} of ${audio.length}: ${file.name}\u2026`);
      const tooBig = uploadSizeError(file.size, file.name);
      if (tooBig) {
        failed.push({ name: file.name, message: tooBig });
        continue;
      }
      const { title, artists } = guessMetadata(file.name);
      try {
        const data = await fileToBase64(file);
        const created = await client.createUpload({
          filename: file.name,
          contentType: audioContentType(file.name),
          data,
          title,
          artists,
          album: "",
          durationMs: 0,
          artwork: "",
          artworkContentType: "",
          associateTrackId: "",
        });
        if (created?.trackId) trackIds.push(created.trackId);
        else failed.push({ name: file.name, message: "the server did not return a track" });
      } catch (error) {
        if (error?.status === 401) {
          busy = false;
          requireLogin();
          close();
          return;
        }
        failed.push({ name: file.name, message: String(error?.message || error) });
      }
    }

    busy = false;
    try {
      if (!trackIds.length) throw new Error("none of the songs uploaded, so there is nothing to make a playlist from");
      const playlist = await client.createPlaylist(name);
      if (!playlist?.id) throw new Error("the server did not return the new playlist");
      await client.addToPlaylist(playlist.id, trackIds);
      await load();
      finish(playlist, name, { total: audio.length, imported: trackIds.length, failed, skipped });
    } catch (error) {
      say(String(error?.message || error), "error");
      folderButton.disabled = false;
      fileButton.disabled = false;
    }
  }

  /** The last word: the playlist opens itself when nothing was left behind. */
  function finish(playlist, name, { total, imported, failed, skipped }) {
    say(`Imported ${imported} of ${total} song(s) into \u201c${name}\u201d.`);
    if (!failed.length) {
      close();
      toast(`Imported ${imported} song(s) into \u201c${name}\u201d${skipped ? `, ${skipped} not audio` : ""}`);
      navigate("playlist", { id: playlist.id });
      return;
    }
    mount(
      report,
      failed.map((entry) =>
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "grow" },
            h("div", { class: "title", text: entry.name }),
            h("div", { class: "subtitle", text: entry.message })
          )
        )
      )
    );
    mount(
      after,
      h("button", {
        class: "btn suggested",
        text: "Open playlist",
        onclick: () => {
          close();
          navigate("playlist", { id: playlist.id });
        },
      }),
      h("button", { class: "btn", text: "Close", onclick: () => close() })
    );
    toast(`${failed.length} song(s) could not be imported`);
  }

  const handle = dialog({
    title: "Import song files",
    body: h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "10px", minWidth: "min(420px, 80vw)" } },
      h("div", {
        text: "Choose a folder of songs from this machine, or pick the files themselves. Only audio is imported, and the songs land in a playlist named after the folder.",
      }),
      h("div", { style: { display: "flex", gap: "8px" } }, folderButton, fileButton),
      note,
      line,
      report,
      after
    ),
    actions: [{ label: "Close", class: "flat" }],
  });
  close = handle.close;
}

// --- the view --------------------------------------------------------------

/** The sheet the account in use can see: their playlists, or the sign-in ask. */
function sheet() {
  listEl = h("div", {});
  signedInSheet = isSignedIn();
  if (!signedInSheet) {
    mount(current, guestState());
    return;
  }
  mount(
    current,
    h(
      "div",
      { style: { display: "flex", gap: "8px", alignItems: "center" } },
      h("button", { class: "btn suggested", text: "New playlist", onclick: create }),
      h("button", {
        class: "btn",
        text: "Import from a platform",
        title: "Copy a YouTube Music or Spotify playlist into one of your own",
        onclick: () => importDialog(),
      }),
      h("button", {
        class: "btn",
        text: "Import song files",
        title: "Upload audio from this machine and make a playlist of it",
        onclick: () => importFilesDialog(),
      }),
      h("button", {
        class: "btn",
        text: "Import from other servers",
        title: "Copy playlists from another of your servers",
        onclick: () => navigate("import"),
      })
    ),
    listEl
  );
}

function render(container) {
  current = container;
  sheet();
  load();
}

const view = {
  id: "playlists",
  title: "Playlists",
  icon: "\u2630",
  order: 20,
  render,
  refresh: load,
};

registerView(view);
