// The Manage tab: your own songs, uploaded and tied to the catalog.
//
// The panel at the top takes the files; each one gets its own dialog from
// upload.js, one after another, and the line under the button says where the
// walk is. Below it, your uploads, what each is a source of, and a menu to
// edit that, play it, or remove it.

import { currentClient, registerView, requireLogin, banner, toast } from "../app.js";
import { h, mount, popover, confirm, icon, iconButton } from "../dom.js";
import { artistLine, openEditUploadDialog, openTrackPicker, openUploadDialog, trackMatch } from "./upload.js";
import { trackMenu } from "./playlist.js";
import { playTracks } from "./queue.js";

/** The last render: what a refresh and a finished walk write into. */
let panel = null;
/** The walk in progress, so two panels cannot upload over each other. */
let walk = null;

function report(error) {
  if (error?.status === 401) requireLogin();
  else banner(String(error?.message || error), "error");
}

function emptyState(name, title, caption = "") {
  return h(
    "div",
    { class: "empty" },
    h("span", { class: "icon" }, icon(name, 38)),
    h("span", { class: "title", text: title }),
    caption ? h("span", { text: caption }) : null
  );
}

function client() {
  return currentClient();
}

// --- selection and bulk association (pure) ----------------------------------

/**
 * The selection after one checkbox toggles: a new Set, so a render's own value
 * is never mutated in place. A blank id is ignored.
 */
export function toggleSelection(selected, id, on) {
  const next = new Set(selected || []);
  const key = String(id || "");
  if (!key) return next;
  if (on) next.add(key);
  else next.delete(key);
  return next;
}

/** Whether every shown upload is selected, which is what "select all" reads. */
export function allSelected(selected, uploads) {
  if (!uploads || !uploads.length) return false;
  return uploads.every((upload) => selected.has(String(upload.id || "")));
}

/**
 * What a bulk association did, in one line: how many uploads were associated,
 * and which of the caller's other uploads were released from the song as a
 * result.
 */
export function associationSummary(payload) {
  const associated = (payload?.uploads || []).length;
  if (!associated) return "Nothing associated.";
  const message = `Associated ${associated} upload${associated === 1 ? "" : "s"}.`;
  const released = (payload?.released || []).map((upload) => `\u201c${String(upload?.title || "Untitled")}\u201d`);
  if (!released.length) return message;
  return `${message} Released ${released.join(", ")}.`;
}

// --- the uploads list -------------------------------------------------------

/** The song an upload is a source of, or "No Association". */
async function associationInfo(active, upload, cache) {
  const id = String(upload?.associateTrackId || "");
  if (!id) return { id: "", label: "No Association", match: null };
  if (!cache.has(id)) {
    cache.set(
      id,
      (async () => {
        try {
          const track = await active.track(id);
          return { id, label: String(track.title || "") || "Associated song", match: trackMatch(track) };
        } catch (error) {
          if (error?.status === 401) throw error;
          return { id, label: "Associated song", match: { id, title: "", artists: [] } };
        }
      })()
    );
  }
  return cache.get(id);
}

async function load(target) {
  const active = client();
  if (!active) {
    mount(target.duplicatesBox);
    mount(target.bar);
    mount(target.list, emptyState("upload", "No server yet", "Add a server first: uploads go to the active server."));
    return;
  }
  target.generation += 1;
  const mine = target.generation;
  mount(target.list, h("div", { style: { color: "var(--fg4)", fontSize: "12.5px" }, text: "Loading\u2026" }));
  try {
    const [uploads, duplicates] = await Promise.all([
      active.uploads(),
      // The duplicates endpoint is a nicety: an older server without it still
      // shows the uploads.
      active.duplicates().catch(() => []),
    ]);
    if (mine !== target.generation) return;
    target.uploads = uploads;
    target.duplicates = duplicates || [];
    // A selection that no longer names an upload is dropped with the reload.
    const live = new Set(uploads.map((upload) => String(upload.id || "")));
    target.selected = new Set([...(target.selected || [])].filter((id) => live.has(id)));
    renderDuplicates(active, target);
    if (!uploads.length) {
      mount(target.bar);
      mount(
        target.list,
        emptyState(
          "upload",
          "Nothing uploaded yet",
          "Songs you upload are yours: they top the search results for everyone."
        )
      );
      return;
    }
    const infos = new Map();
    await Promise.all(
      uploads.map(async (upload) => {
        infos.set(String(upload.id || ""), await associationInfo(active, upload, target.cache));
      })
    );
    if (mine !== target.generation) return;
    target.infos = infos;
    renderUploads(active, target);
  } catch (error) {
    if (mine !== target.generation) return;
    mount(target.duplicatesBox);
    mount(target.bar);
    if (error?.status === 401) {
      requireLogin();
      mount(target.list, emptyState("upload", "Sign in to see your uploads"));
      return;
    }
    report(error);
    mount(target.list, emptyState("upload", "Your uploads could not be loaded", String(error?.message || error)));
  }
}

// --- possible duplicates ----------------------------------------------------

/** The "Possible duplicates" panel: same bytes, more than one upload. */
function renderDuplicates(active, target) {
  const groups = target.duplicates || [];
  if (!groups.length) {
    mount(target.duplicatesBox);
    return;
  }
  mount(
    target.duplicatesBox,
    h("div", { class: "section-title", text: "Possible duplicates" }),
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "10px" } },
      groups.map((group) => duplicateGroup(active, group))
    )
  );
}

/** One group of identical uploads, each with a way to open it. */
function duplicateGroup(active, group) {
  const uploads = group.uploads || [];
  return h(
    "div",
    { class: "card" },
    h("div", {
      class: "subtitle",
      text: `${uploads.length} uploads of the same file`,
    }),
    h(
      "div",
      { class: "list" },
      uploads.map((upload) =>
        h(
          "div",
          { class: "row" },
          upload.artworkUrl
            ? h("img", { class: "art", alt: "", src: active.artworkUrl(upload.artworkUrl) })
            : h("div", { class: "art" }),
          h(
            "div",
            { class: "grow" },
            h("div", { class: "title", text: String(upload.title || "Untitled") }),
            h("div", { class: "subtitle", text: artistLine(upload.artists) })
          ),
          h("button", {
            class: "btn flat",
            text: "Open",
            onclick: () => playTracks([uploadTrack(upload)], 0),
          })
        )
      )
    )
  );
}

/**
 * What the search box keeps, out of what the account has uploaded.
 *
 * Filtered here rather than asked for: the list is the account's own and is
 * already in hand, so typing costs nothing and nothing can arrive out of order.
 */
export function matchingUploads(uploads, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return uploads;
  return uploads.filter((upload) => {
    const hay = [upload.title, upload.album, upload.filename, ...(upload.artists || [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  });
}

/** Draw the uploads the search box is keeping, out of what load() fetched. */
function renderUploads(active, target) {
  const uploads = target.uploads || [];
  const shown = matchingUploads(uploads, target.filter || "");
  renderSelectionBar(active, target);
  if (!shown.length) {
    mount(
      target.list,
      emptyState(
        "upload",
        "Nothing matches",
        `None of your ${uploads.length} upload(s) match “${String(target.filter).trim()}”.`
      )
    );
    return;
  }
  const selected = target.selected || new Set();
  const header = h(
    "div",
    { class: "row" },
    h("input", {
      type: "checkbox",
      checked: allSelected(selected, shown),
      "aria-label": "Select all uploads",
      onchange: (event) => {
        target.selected = event.currentTarget.checked
          ? new Set(shown.map((upload) => String(upload.id || "")))
          : new Set();
        renderUploads(active, target);
      },
    }),
    h("div", { class: "grow" }, h("div", { class: "subtitle", text: `Select all (${shown.length})` })),
    h("span", { style: { width: "24px" } })
  );
  mount(
    target.list,
    h(
      "div",
      { class: "list" },
      header,
      shown.map((upload) => uploadRow(active, upload, target.infos?.get(String(upload.id || "")), target))
    )
  );
}

function uploadRow(active, upload, info, target) {
  const artists = artistLine(upload.artists);
  const association = info?.label || "No Association";
  const subtitle = [artists, association].filter(Boolean).join(" \u00b7 ");
  const id = String(upload.id || "");
  return h(
    "div",
    { class: "row" },
    h("input", {
      type: "checkbox",
      checked: target.selected?.has(id) || false,
      "aria-label": `Select ${String(upload.title || "upload")}`,
      onchange: (event) => {
        target.selected = toggleSelection(target.selected, id, event.currentTarget.checked);
        renderUploads(active, target);
      },
    }),
    upload.artworkUrl
      ? h("img", { class: "art", alt: "", src: active.artworkUrl(upload.artworkUrl) })
      : h("div", { class: "art" }),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", text: String(upload.title || "Untitled") }),
      h("div", { class: "subtitle", text: subtitle })
    ),
    iconButton("dots", {
      title: "More",
      onclick: (event) => uploadMenu(event.currentTarget, upload, info, target),
    })
  );
}

/** The bar that appears once one or more uploads are selected. */
function renderSelectionBar(active, target) {
  const count = (target.selected || new Set()).size;
  if (!count) {
    mount(target.bar);
    return;
  }
  mount(
    target.bar,
    h(
      "div",
      { class: "row", style: { justifyContent: "space-between" } },
      h("span", { class: "subtitle", text: `${count} selected` }),
      h(
        "div",
        { style: { display: "flex", gap: "8px" } },
        h("button", {
          class: "btn suggested",
          text: "Associate with\u2026",
          onclick: () => associateSelected(active, target),
        }),
        h("button", {
          class: "btn flat",
          text: "Clear",
          onclick: () => {
            target.selected = new Set();
            renderUploads(active, target);
          },
        })
      )
    )
  );
}

/** Pick a song, then associate every selected upload with it at once. */
async function associateSelected(active, target) {
  const ids = [...(target.selected || [])];
  if (!ids.length) return;
  const track = await openTrackPicker({ title: "Associate with a song" });
  if (!track?.id) return;
  try {
    const payload = await active.associateUploads(ids, track.id);
    toast(associationSummary(payload));
    target.selected = new Set();
    load(target);
  } catch (error) {
    report(error);
  }
}

/** A song as the player takes one. */
export function uploadTrack(upload) {
  return {
    id: String(upload.trackId || ""),
    title: String(upload.title || ""),
    artists: upload.artists || [],
    album: String(upload.album || ""),
    durationMs: Number(upload.durationMs) || 0,
    artworkUrl: String(upload.artworkUrl || ""),
  };
}

function uploadMenu(anchor, upload, info, target) {
  const track = uploadTrack(upload);
  popover(anchor, [
    {
      label: "Edit metadata/association",
      onClick: () =>
        openEditUploadDialog({ upload, match: info?.match || null }).then((outcome) => {
          if (outcome === "saved") load(target);
        }),
    },
    { separator: true },
    // A row here is a song like any other, so it carries the same actions the
    // search results do: play, queue, add to a playlist, share, favourite.
    ...trackMenu(track),
    { separator: true },
    { label: "Delete", onClick: () => removeUpload(upload, target) },
  ]);
}

async function removeUpload(upload, target) {
  const active = client();
  if (!active) return;
  const title = String(upload.title || "this song");
  const yes = await confirm("Delete upload", `Remove \u201c${title}\u201d from your uploads?`, {
    confirm: "Delete",
    destructive: true,
  });
  if (!yes) return;
  try {
    await active.deleteUpload(String(upload.id || ""));
    toast(`Deleted \u201c${title}\u201d.`);
    load(target);
  } catch (error) {
    report(error);
  }
}

// --- uploading --------------------------------------------------------------

/** Walk files through their dialogs, then bring the list up to date. */
/**
 * Take drops for whichever view is showing.
 *
 * `current` is asked at the moment of the drop, not when it was registered: the
 * view it belongs to may have been replaced by then. Returning null means the
 * drop is somebody else's, and it is swallowed either way - the browser must
 * never be left to open the file.
 */
function watchDrops(current) {
  dropTarget = current;
  if (dropWatched) return;
  dropWatched = true;
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    const handler = dropTarget?.();
    const files = Array.from(event.dataTransfer?.files || []);
    if (handler && files.length) handler(files);
  });
}

let dropWatched = false;
let dropTarget = null;

function start(files, associateTrackId, progress) {
  if (walk) {
    toast("An upload is already in progress.");
    return;
  }
  const write = (message) => {
    progress.textContent = message;
  };
  walk = openUploadDialog({
    files,
    associateTrackId,
    onProgress: (step) => {
      if (step.state === "opening") write(`Song ${step.index + 1} of ${step.total}: ${step.name}`);
    },
  })
    .then((summary) => {
      if (!summary.total) return;
      write(summary.uploaded ? `Uploaded ${summary.uploaded} of ${summary.total}.` : "Nothing uploaded.");
      if (summary.uploaded && panel) load(panel);
    })
    .catch(report)
    .finally(() => {
      walk = null;
    });
}

// --- the view ---------------------------------------------------------------

export function render(container, params = {}) {
  const progress = h("div", { style: { color: "var(--fg4)", fontSize: "12.5px", minHeight: "16px" } });
  // Possible duplicates sit above the uploads: a copy is worth resolving, and
  // the section is empty (and hidden) when there is nothing to say.
  const duplicatesBox = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } });
  const bar = h("div");
  const list = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } });

  const choose = h("button", {
    class: "btn suggested",
    text: "Choose files",
    onclick: () => start([], "", progress),
  });

  const card = h("div", {
    class: "card",
    style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "8px", textAlign: "center" },
  });
  card.addEventListener("dragover", (event) => {
    event.preventDefault();
    card.style.borderColor = "var(--blue)";
  });
  card.addEventListener("dragleave", () => {
    card.style.borderColor = "var(--bg1)";
  });
  // The drop is handled on the page, not on the card: a file dragged over the
  // page lands wherever the pointer is, and a drop nothing handles is one the
  // browser opens itself - which is what "it just opens it in the browser" was.
  // Anywhere on this page while it is showing means the same thing.
  watchDrops(() => {
    if (!card.isConnected) return null;
    return (files) => start(files, "", progress);
  });

  mount(
    card,
    h("span", { style: { color: "var(--bg4)" } }, icon("upload", 30)),
    h("div", { style: { fontSize: "17px", color: "var(--fg2)" }, text: "Drop it or choose files" }),
    h("div", {
      style: { color: "var(--fg4)", fontSize: "12.5px", maxWidth: "460px" },
      text: "Up to 64 MB per song. One dialog per song asks what it is and which song, if any, it is a source of.",
    }),
    choose,
    progress
  );

  const search = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search your uploads…",
    oninput: () => {
      if (!panel) return;
      panel.filter = search.value;
      renderUploads(client(), panel);
    },
  });

  mount(
    container,
    duplicatesBox,
    card,
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "10px" } },
      h("div", { class: "section-title", text: "Your uploads" }),
      search,
      bar,
      list
    )
  );

  panel = {
    list,
    bar,
    duplicatesBox,
    progress,
    cache: new Map(),
    generation: 0,
    uploads: [],
    duplicates: [],
    infos: new Map(),
    selected: new Set(),
    filter: "",
  };
  load(panel);

  // The source picker's "Upload a source…": files for this exact song.
  const associateTrackId = String(params?.associateTrackId || "");
  if (associateTrackId) start([], associateTrackId, progress);
}

export function refresh() {
  if (panel) load(panel);
}

registerView({
  id: "manage",
  title: "Manage",
  icon: "\u21a5",
  order: 50,
  render,
  refresh,
});
