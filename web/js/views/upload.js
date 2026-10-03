// One cohesive dialog per song on its way in: what it is called, who it is by,
// its cover, and which catalog song, if any, it is another source of.
//
// The walk over the chosen files lives here too: one dialog, one upload, each,
// in the order the files were chosen. Manage owns the panel and the list.

import { banner, currentClient, requireLogin } from "../app.js";
import { h, mount, dialog, toast, confirm, pickFile, fileToBase64, icon, iconButton } from "../dom.js";
import { artworkTile } from "./playlist.js";

/** What the server accepts as audio, by file extension. */
export const AUDIO_TYPES = {
  ".aac": "audio/aac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".mp4": "audio/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".wma": "audio/x-ms-wma",
};

/** What the server accepts as cover art, by file extension. */
export const IMAGE_TYPES = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** The extensions a file picker should offer, for the song files themselves. */
export const AUDIO_ACCEPT = Object.keys(AUDIO_TYPES).join(",");
const IMAGE_ACCEPT = Object.keys(IMAGE_TYPES).join(",");

/** The decoded cap the server takes for one song. */
export const MAX_UPLOAD_BYTES = 64 << 20;
/** An art image rides in the request body too, so it stays modest. */
export const MAX_ARTWORK_BYTES = 8 << 20;

const ASSOCIATION_NOTE =
  "An association says this file is another source of that song; the title and artists above stay yours.";
const EDIT_NOTE =
  "The title and artists are kept as uploaded; the association decides which song this is a source of.";

let uid = 0;

/**
 * Listen to a candidate, one at a time.
 *
 * The pick is a judgement about whether two recordings are the same, and names
 * are exactly what providers disagree about: hearing it settles what reading it
 * cannot. One element, so a second press stops the first rather than layering
 * two songs on top of each other.
 */
let preview = null;

function playPreview(variantId) {
  const url = currentClient()?.mediaUrl(variantId) || "";
  if (!url) return;
  if (preview) {
    preview.pause();
    preview = null;
  }
  const audio = new Audio(url);
  preview = audio;
  audio.addEventListener("ended", () => {
    if (preview === audio) preview = null;
  });
  audio.play().catch(() => {
    preview = null;
    toast("That one could not be played.");
  });
}

// --- the names a file suggests ----------------------------------------------

/**
 * The rows of a track search: each candidate with a listen button, because the
 * same song from two sources rarely looks different. onPick gets the raw track.
 */
function trackResultRows(groups, onPick) {
  return (groups || []).map((group) => {
    const track = group?.track || {};
    const line = artistLine(track.artists);
    // The candidate's own rendition, so the button has something to play.
    const playable = (group?.variants || []).find((variant) => variant?.downloadable);
    return h(
      "div",
      { class: "row clickable", onclick: () => onPick(track) },
      artworkTile(currentClient(), track.artworkUrl, "small"),
      h(
        "div",
        { class: "grow" },
        h("div", { class: "title", text: String(track.title || "Untitled") }),
        line ? h("div", { class: "subtitle", text: line }) : null
      ),
      // A listen, so the choice can be made by ear rather than by name.
      playable
        ? iconButton("play", {
            title: "Listen to this one",
            class: "btn flat small",
            onclick: (event) => {
              event.stopPropagation();
              playPreview(playable.variantId);
            },
          })
        : null
    );
  });
}

/** The extension of a file name, lower case, or "" when it has none. */
function extensionOf(name) {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function baseName(name) {
  const value = String(name || "");
  const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return cut >= 0 ? value.slice(cut + 1) : value;
}

/** "A title reduced to its letters and digits, so brackets do not count." */
export function normalizedTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The title and artists a file name suggests: "Artist - Title.ext". */
export function guessMetadata(filename) {
  const base = baseName(filename);
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  for (const separator of [" - ", " \u2013 ", " \u2014 "]) {
    const at = stem.indexOf(separator);
    if (at < 0) continue;
    const artist = stem.slice(0, at).trim();
    const title = stem.slice(at + separator.length).trim();
    if (artist && title) return { title, artists: [artist] };
  }
  return { title: stem, artists: [] };
}

export function audioContentType(filename) {
  return AUDIO_TYPES[extensionOf(filename)] || "application/octet-stream";
}

/** Whether a chosen file is audio: its own type says so, or its extension is
 *  one the server accepts. A folder pick often leaves the type empty, so the
 *  extension is the one that has to carry it. */
export function isAudioFile(file) {
  if (String(file?.type || "").startsWith("audio/")) return true;
  return Boolean(AUDIO_TYPES[extensionOf(file?.name)]);
}

/** The image type a file looks like, or null when it is not an image. */
export function imageContentType(filename) {
  return IMAGE_TYPES[extensionOf(filename)] || null;
}

export function artistLine(artists) {
  return (artists || []).map((name) => String(name)).filter(Boolean).join(", ");
}

export function artistList(value) {
  return String(value || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

/** A track of any shape as one of this dialog's tracks. */
export function trackMatch(track) {
  return {
    id: String(track?.id || ""),
    title: String(track?.title || ""),
    artists: (track?.artists || []).map((name) => String(name)),
  };
}

/**
 * The group that is this song after normalizing its title, or null.
 *
 * Strict on purpose: an upload is only tied to a catalog song when the titles
 * really are the same one. A near miss should end up as its own song.
 */
export function matchTrack(title, groups = []) {
  const wanted = normalizedTitle(title);
  if (!wanted) return null;
  for (const group of groups || []) {
    const raw = group?.track || group || {};
    if (normalizedTitle(raw.title) === wanted) return trackMatch(raw);
  }
  return null;
}

/** How the first option of the association dropdown reads. */
export function describeMatch(match, { prefix = "Matched" } = {}) {
  if (!String(match?.id || "")) return "No match found";
  const rest = [String(match.title || ""), artistLine(match.artists)].filter(Boolean).join(" \u2014 ");
  return prefix ? `${prefix}: ${rest}` : rest;
}

/**
 * The three answers to "which catalog song is this?": the automatic match, No
 * Association, and the door to a search of your own.
 */
export function associationOptions(match, { prefix = "Matched" } = {}) {
  return [
    { index: 0, kind: "match", label: describeMatch(match, { prefix }) },
    { index: 1, kind: "none", label: "No Association" },
    { index: 2, kind: "search", label: "Search\u2026" },
  ];
}

/** Why this file cannot be uploaded, or "" when it can. */
export function uploadSizeError(bytes, name = "") {
  if ((Number(bytes) || 0) <= MAX_UPLOAD_BYTES) return "";
  return name ? `${name} is larger than 64 MB.` : "that file is larger than 64 MB.";
}

/** Why this image cannot be cover art, or "" when it can. */
export function artworkSizeError(bytes) {
  if ((Number(bytes) || 0) <= MAX_ARTWORK_BYTES) return "";
  return "that image is larger than 8 MB.";
}

// --- picking files ----------------------------------------------------------

/** Pick several files at once: one song each. Resolves with [] when cancelled. */
export function pickFiles(accept = "") {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple: true, style: { display: "none" } });
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files);
    });
    input.click();
  });
}

/**
 * Pick a whole folder: every file below it, one song each. `webkitdirectory`
 * is what turns the picker into a folder chooser; a phone has no folder to
 * give, which is why loose files are offered next to it. Resolves with [] when
 * cancelled.
 */
export function pickFolder() {
  return new Promise((resolve) => {
    const input = h("input", {
      type: "file",
      multiple: true,
      webkitdirectory: true,
      directory: true,
      style: { display: "none" },
    });
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.remove();
      resolve(files);
    });
    input.click();
  });
}

/** dom.js's dialog has no close hook, so watch for the node leaving the page. */
function whenClosed(node, callback) {
  const observer = new MutationObserver(() => {
    if (!node.isConnected) {
      observer.disconnect();
      callback();
    }
  });
  observer.observe(document.body, { childList: true });
  return () => observer.disconnect();
}

// --- the dialog -------------------------------------------------------------

/**
 * One song, in an editable dialog. `mode` decides what confirming means:
 * "create" uploads the file, "edit" re-points an existing upload at another
 * song. Resolves through onFinish with "uploaded", "skipped", "saved",
 * "cancelled" or "stopped" (the dialog was closed).
 */
function showDialog({
  client,
  mode,
  file = null,
  upload = null,
  name,
  title,
  artists,
  match = null,
  artworkPath = "",
  onFinish,
}) {
  const editing = mode === "edit";
  const ids = {
    title: `upload-title-${(uid += 1)}`,
    artists: `upload-artists-${(uid += 1)}`,
    association: `upload-association-${(uid += 1)}`,
  };

  // What the automatic match found; a search of the user's own replaces it.
  let pickedTrackId = String(match?.id || "");
  let choice = pickedTrackId ? 0 : 1;
  let finished = false;
  let busy = false;
  let closeDialog = () => {};
  let confirmButton = null;
  let art = { data: "", contentType: "", url: artworkPath ? client.artworkUrl(artworkPath) : "" };

  const notice = h("div", { class: "banner", style: { margin: "0", display: "none" } });

  const say = (message, kind = "") => {
    notice.className = `banner ${kind}`.trim();
    notice.textContent = message;
    notice.style.display = message ? "" : "none";
  };

  // --- cover art ------------------------------------------------------------

  const tile = h(editing ? "div" : "button", {
    class: editing ? "art" : "btn",
    type: editing ? null : "button",
    title: editing ? "" : "Choose cover art",
    style: {
      width: "96px",
      height: "96px",
      flex: "none",
      padding: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
  });
  const paintTile = () => {
    mount(
      tile,
      art.url
        ? h("img", { alt: "", src: art.url, style: { width: "100%", height: "100%", objectFit: "cover" } })
        : h("span", { style: { color: "var(--gray)" } }, icon(editing ? "note" : "plus", 26))
    );
  };
  paintTile();

  const chooseArt = async () => {
    const image = await pickFile(IMAGE_ACCEPT);
    if (!image) return;
    const tooBig = artworkSizeError(image.size);
    if (tooBig) {
      say(tooBig, "error");
      return;
    }
    const contentType = imageContentType(image.name);
    if (!contentType) {
      say("that file is not a png, jpeg, webp, gif or avif image", "error");
      return;
    }
    try {
      const data = await fileToBase64(image);
      art = { data, contentType, url: `data:${contentType};base64,${data}` };
      paintTile();
      say("");
    } catch (error) {
      say(String(error.message || error), "error");
    }
  };
  if (!editing) tile.addEventListener("click", chooseArt);

  // --- the fields -----------------------------------------------------------

  const titleInput = h("input", {
    class: "input",
    id: ids.title,
    type: "text",
    value: String(title || ""),
    disabled: editing,
    placeholder: "Title",
  });
  const artistsInput = h("input", {
    class: "input",
    id: ids.artists,
    type: "text",
    value: artistLine(artists),
    disabled: editing,
    placeholder: "Artists",
  });

  // --- the association ------------------------------------------------------

  const options = associationOptions(match, { prefix: editing ? "Currently" : "Matched" });
  const optionOne = h("option", { value: "0", text: options[0].label });
  const select = h(
    "select",
    { class: "input", id: ids.association },
    optionOne,
    options.slice(1).map((option) => h("option", { value: String(option.index), text: option.label }))
  );
  select.value = String(choice);

  // The search panel: "Search…" is a door, not an answer, so the dropdown keeps
  // its old answer until a song is picked.
  const query = h("input", { class: "input", type: "search", placeholder: "Search for the song this is" });
  const searchStatus = h("div", { style: { color: "var(--fg4)", fontSize: "12.5px" } });
  const results = h("div", { class: "list" });
  const searchPanel = h(
    "div",
    { style: { display: "none", flexDirection: "column", gap: "8px" } },
    query,
    searchStatus,
    results
  );

  let generation = 0;
  const pick = (track) => {
    const picked = trackMatch(track);
    pickedTrackId = picked.id;
    optionOne.textContent = describeMatch(picked, { prefix: "" });
    select.value = "0";
    choice = 0;
    searchPanel.style.display = "none";
  };

  const runSearch = async () => {
    const text = query.value.trim();
    if (!text) return;
    generation += 1;
    const mine = generation;
    searchStatus.textContent = "Searching\u2026";
    mount(results);
    try {
      const { groups } = await client.search(text, 10);
      if (mine !== generation) return;
      mount(results, trackResultRows(groups, pick));
      searchStatus.textContent = groups.length ? "" : `Nothing found for \u201c${text}\u201d.`;
    } catch (error) {
      if (mine !== generation) return;
      searchStatus.textContent = String(error.message || error);
    }
  };
  query.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch();
    }
  });
  select.addEventListener("change", () => {
    if (select.value === "2") {
      select.value = String(choice);
      searchPanel.style.display = "flex";
      query.focus();
      return;
    }
    choice = Number(select.value);
  });

  const selectedTrackId = () => (choice === 0 ? pickedTrackId : "");

  // --- confirming -----------------------------------------------------------

  const finish = (outcome) => {
    if (finished) return;
    finished = true;
    closeDialog();
    onFinish(outcome);
  };

  /** The user's upload already on this song, unless it is the one being edited. */
  const replacementFor = async (trackId) => {
    try {
      const found = await client.uploadAssociation(trackId);
      if (!found) return null;
      if (String(found.id || "") === String(upload?.id || "")) return null;
      return found;
    } catch {
      // The warning is a courtesy; the server enforces the rule either way.
      return null;
    }
  };

  const submit = async () => {
    if (busy) return false;
    // Held from here: the association is checked against the server below, and a
    // second click must not start a second upload while that is in flight.
    busy = true;
    const wanted = selectedTrackId();
    // One association per user per song. The server replaces the one already
    // there, so say which one that is before it happens.
    if (wanted) {
      const clash = await replacementFor(wanted);
      if (clash) {
        busy = false;
        const agreed = await confirm(
          "Replace the association?",
          `You already have \u201c${clash.title}\u201d associated with this song. Associating this one replaces it \u2014 \u201c${clash.title}\u201d goes back to standing on its own.`,
          { confirm: "Replace" }
        );
        if (!agreed) return false;
        busy = true;
      }
    }
    if (editing) {
      if (wanted === String(upload?.associateTrackId || "")) {
        toast("Nothing to change.");
        finish("cancelled");
        return false;
      }
      busy = true;
      if (confirmButton) confirmButton.disabled = true;
      say("Saving\u2026");
      try {
        await client.patchUpload(String(upload?.id || ""), wanted);
        toast(wanted ? "Association saved." : "Association removed.");
        finish("saved");
      } catch (error) {
        busy = false;
        if (confirmButton) confirmButton.disabled = false;
        if (error.status === 401) {
          requireLogin();
          finish("stopped");
        } else {
          say(String(error.message || error), "error");
        }
      }
      return false;
    }

    const value = titleInput.value.trim();
    if (!value) {
      say("Give the song a title first.", "error");
      busy = false;
      return false;
    }
    if (!file) {
      busy = false;
      return false;
    }
    busy = true;
    if (confirmButton) {
      confirmButton.disabled = true;
      confirmButton.textContent = "Uploading\u2026";
    }
    say("Uploading\u2026");
    try {
      const data = await fileToBase64(file);
      const created = await client.createUpload({
        filename: file.name,
        contentType: audioContentType(file.name),
        data,
        title: value,
        artists: artistList(artistsInput.value),
        album: "",
        durationMs: 0,
        artwork: art.data,
        artworkContentType: art.contentType,
        associateTrackId: wanted,
      });
      toast(`Uploaded \u201c${created.title || value}\u201d.`);
      finish("uploaded");
    } catch (error) {
      busy = false;
      if (confirmButton) {
        confirmButton.disabled = false;
        confirmButton.textContent = "Upload";
      }
      if (error.status === 401) {
        requireLogin();
        finish("stopped");
      } else {
        say(String(error.message || error), "error");
      }
    }
    return false;
  };

  // --- the body -------------------------------------------------------------

  const body = h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "12px" } },
    h(
      "div",
      { style: { display: "flex", gap: "12px", alignItems: "center" } },
      tile,
      h(
        "div",
        { style: { flex: "1", display: "flex", flexDirection: "column", gap: "8px" } },
        h("div", { class: "field" }, h("label", { for: ids.title, text: "Title" }), titleInput),
        h("div", { class: "field" }, h("label", { for: ids.artists, text: "Artists" }), artistsInput)
      )
    ),
    h("div", { class: "section-title", text: "Association" }),
    select,
    h("div", { style: { color: "var(--fg4)", fontSize: "12.5px" }, text: editing ? EDIT_NOTE : ASSOCIATION_NOTE }),
    searchPanel,
    notice
  );

  const actions = [
    {
      label: editing ? "Cancel" : "Skip",
      class: "flat",
      onClick: () => {
        finish(editing ? "cancelled" : "skipped");
        return false;
      },
    },
    { label: editing ? "Save" : "Upload", class: "suggested", onClick: submit },
  ];

  const handle = dialog({
    title: editing ? `Edit ${name}` : `Upload ${name}`,
    body,
    actions,
    onOpen: (panel, close) => {
      closeDialog = close;
      confirmButton = panel.querySelector(".actions .suggested");
      if (!editing) titleInput.focus();
    },
  });
  closeDialog = handle.close;
  whenClosed(handle.node, () => finish(editing ? "cancelled" : "stopped"));
}

// --- the walk ---------------------------------------------------------------

/** One file through its dialog. Resolves with the outcome for that file. */
async function oneFile({ client, file, known }) {
  const tooBig = uploadSizeError(file.size, file.name);
  if (tooBig) {
    banner(tooBig, "error");
    return "skipped";
  }

  let title;
  let artists;
  let match;
  if (known) {
    // A source for a known song: the song is its own match, and its names are
    // the ones to fill in.
    title = known.title;
    artists = known.artists;
    match = known;
    if (!title) ({ title, artists } = guessMetadata(file.name));
  } else {
    ({ title, artists } = guessMetadata(file.name));
    let groups = [];
    try {
      ({ groups } = await client.search([title, ...artists].join(" "), 5));
    } catch (error) {
      if (error.status === 401) {
        requireLogin();
        return "stopped";
      }
      // The automatic match is a nicety, not a requirement.
    }
    match = matchTrack(title, groups);
  }

  return new Promise((resolve) => {
    showDialog({
      client,
      mode: "create",
      file,
      name: file.name,
      title,
      artists,
      match,
      onFinish: resolve,
    });
  });
}

/**
 * Walk files through the upload dialog, one at a time, in the order chosen.
 *
 * With no files it opens the multi-select picker first, which is what "Upload a
 * source…" needs: the association for `associateTrackId` is filled in.
 * onProgress is told about each step: {index, total, name, state}.
 */
export async function openUploadDialog({ files = [], associateTrackId = "", onProgress = null } = {}) {
  const client = currentClient();
  const summary = { total: 0, uploaded: 0, skipped: 0, stopped: false };
  if (!client) {
    banner("Add a server first: uploads go to the active server.", "error");
    return summary;
  }

  let chosen = (files || []).filter(Boolean);
  if (!chosen.length) chosen = await pickFiles(AUDIO_ACCEPT);
  if (!chosen.length) return summary;
  summary.total = chosen.length;

  // In source mode the song is known up front, from the picker that sent us.
  let known = null;
  if (associateTrackId) {
    try {
      known = trackMatch(await client.track(associateTrackId));
    } catch (error) {
      if (error.status === 401) {
        requireLogin();
        return summary;
      }
      known = null;
    }
    if (!known?.id) known = null;
  }

  for (let index = 0; index < chosen.length; index += 1) {
    const file = chosen[index];
    onProgress?.({ index, total: chosen.length, name: file.name, state: "opening" });
    const outcome = await oneFile({ client, file, known });
    if (outcome === "stopped") {
      summary.stopped = true;
      break;
    }
    if (outcome === "uploaded") summary.uploaded += 1;
    else summary.skipped += 1;
    onProgress?.({ index, total: chosen.length, name: file.name, state: outcome });
  }
  return summary;
}

/**
 * The same dialog against an upload that already exists: its name and artists
 * are shown as uploaded (the server keeps those), and the association — the one
 * thing PATCH /uploads/{id} takes — can be changed. Resolves with the outcome.
 */
export async function openEditUploadDialog({ upload, match = null } = {}) {
  const client = currentClient();
  if (!client) return "stopped";
  return new Promise((resolve) => {
    showDialog({
      client,
      mode: "edit",
      upload,
      name: String(upload?.title || "upload"),
      title: String(upload?.title || ""),
      artists: upload?.artists || [],
      match,
      artworkPath: String(upload?.artworkUrl || ""),
      onFinish: resolve,
    });
  });
}

/**
 * Pick a catalog song by hand on its own: the same search the upload dialog
 * offers, without the rest of the dialog. Resolves with the chosen track as
 * trackMatch shapes it, or null when it is closed without one.
 */
export function openTrackPicker({ title = "Associate with a song" } = {}) {
  const client = currentClient();
  if (!client) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    let closeDialog = () => {};
    const finish = (track) => {
      if (settled) return false;
      settled = true;
      closeDialog();
      resolve(track);
      return false;
    };

    const query = h("input", { class: "input", type: "search", placeholder: "Search for the song this is" });
    const status = h("div", { style: { color: "var(--fg4)", fontSize: "12.5px" } });
    const results = h("div", { class: "list" });
    let generation = 0;

    const runSearch = async () => {
      const text = query.value.trim();
      if (!text) return;
      generation += 1;
      const mine = generation;
      status.textContent = "Searching\u2026";
      mount(results);
      try {
        const { groups } = await client.search(text, 10);
        if (mine !== generation) return;
        mount(results, trackResultRows(groups, (track) => finish(trackMatch(track))));
        status.textContent = groups.length ? "" : `Nothing found for \u201c${text}\u201d.`;
      } catch (error) {
        if (mine !== generation) return;
        status.textContent = String(error.message || error);
      }
    };
    query.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch();
      }
    });

    const handle = dialog({
      title,
      body: h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } }, query, status, results),
      actions: [{ label: "Cancel", class: "flat", onClick: () => finish(null) }],
      onOpen: (panel, close) => {
        closeDialog = close;
        query.focus();
      },
    });
    closeDialog = handle.close;
    whenClosed(handle.node, () => finish(null));
  });
}
