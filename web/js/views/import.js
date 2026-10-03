// Importing a playlist from another of your backends.
//
// The GTK client's Import dialog, as a page: choose a server, choose one or
// more of its playlists (its own, or one found on a provider through the
// search), name the copy, then watch it match song by song. The matching itself
// lives in ../importer.js.

import { h, clear, mount, dialog, toast, fmtDuration } from "../dom.js";
import { registerView, currentClient, banner, requireLogin } from "../app.js";
import { state, knownServers, sessionFor, serverLabel, rememberServer } from "../state.js";
import { clientFor } from "../client.js";
import { copyPlaylist } from "../importer.js";

// What the page is showing right now. Rebuilt from this on every change, so a
// re-render never loses a selection or a typed name.
const ui = {
  source: "",
  personal: [],
  provider: [],
  picked: new Map(),
  query: "",
  name: "",
  status: "",
  searching: false,
  busy: false,
  summary: "",
  progressText: "",
  progressPct: 0,
};

let root = null;
let progressBar = null;
let progressText = null;

function playlistName(playlist) {
  return String(playlist?.name ?? playlist?.title ?? "").trim() || "untitled playlist";
}

function playlistDetail(kind, playlist) {
  const count = Number(playlist?.trackCount ?? 0);
  const length = Number(playlist?.durationMs ?? 0);
  const parts = [`${count} track(s)`];
  if (length > 0) parts.push(fmtDuration(length));
  if (kind === "provider" && playlist?.owner) parts.push(playlist.owner);
  return parts.join(" · ");
}

function keyOf(kind, playlist) {
  return `${kind}:${playlist?.id ?? ""}`;
}

function sourceClient() {
  return clientFor({ url: ui.source }, sessionFor(ui.source));
}

function fail(error, fallback) {
  if (error?.status === 401) {
    requireLogin();
    return "Sign in to this server to see its playlists.";
  }
  banner(error?.message || String(error), "error");
  return fallback || error?.message || String(error);
}

// --- loading ---------------------------------------------------------------

async function loadSource(url) {
  ui.source = url;
  ui.personal = [];
  ui.provider = [];
  ui.picked.clear();
  ui.query = "";
  ui.name = "";
  ui.status = "Reading that server…";
  ui.summary = "";
  rebuild();

  try {
    const playlists = await sourceClient().playlists();
    ui.personal = Array.isArray(playlists) ? playlists : [];
    ui.status = `${ui.personal.length} playlist(s) on ${serverLabel(url)}`;
  } catch (error) {
    ui.status = fail(error, "could not read that server");
  }
  rebuild();
}

async function searchProviders() {
  const query = ui.query.trim();
  if (!query || !ui.source) return;
  ui.searching = true;
  rebuild();
  try {
    const result = await sourceClient().searchPlaylists(query, 25);
    ui.provider = Array.isArray(result?.playlists) ? result.playlists : [];
    ui.status = `${ui.provider.length} provider playlist(s) for “${query}”`;
  } catch (error) {
    ui.status = fail(error, "provider search failed");
  }
  ui.searching = false;
  rebuild();
}

// --- running the copy ------------------------------------------------------

function setProgress(position, total, text) {
  ui.progressPct = total > 0 ? Math.round((position / total) * 100) : 0;
  ui.progressText = text;
  if (progressText) progressText.textContent = text;
  if (progressBar) progressBar.style.width = `${ui.progressPct}%`;
}

async function run() {
  if (ui.busy) return;
  const entries = [...ui.picked.values()];
  if (!entries.length) return;

  const target = currentClient();
  if (!target) {
    banner("choose a server to copy into first", "error");
    return;
  }
  if (!requireLogin()) return;

  const from = sourceClient();
  const single = entries.length === 1;
  const renamed = ui.name.trim();

  ui.busy = true;
  ui.summary = "";
  ui.progressPct = 0;
  ui.progressText = "";
  rebuild();

  let copied = 0;
  let skipped = 0;
  const names = [];
  try {
    for (const entry of entries) {
      const source = entry.playlist;
      const playlist =
        single && renamed ? { ...source, name: renamed, title: renamed } : source;
      const label = playlistName(source);
      setProgress(0, 1, `Copying ${label}…`);
      const result = await copyPlaylist({
        from,
        to: target,
        providerPlaylist: playlist,
        onProgress: (step) =>
          setProgress(step.position, step.total, `Matching song ${step.position}/${step.total} on ${label}…`),
      });
      copied += result.matched;
      skipped += result.skipped;
      names.push(result.name);
    }
    ui.summary = `Copied ${copied}, skipped ${skipped}.`;
    ui.progressPct = 100;
    ui.progressText = ui.summary;
    toast(names.length === 1 ? `Imported ${names[0]}` : `Imported ${names.length} playlists`);
  } catch (error) {
    ui.summary = fail(error, "the copy stopped");
    ui.progressText = ui.summary;
  } finally {
    ui.busy = false;
    rebuild();
  }
}

// --- the page --------------------------------------------------------------

function toggle(kind, playlist) {
  const key = keyOf(kind, playlist);
  if (ui.picked.has(key)) ui.picked.delete(key);
  else ui.picked.set(key, { kind, playlist });
  rebuild();
}

function playlistRow(kind, playlist) {
  const key = keyOf(kind, playlist);
  const on = ui.picked.has(key);
  const box = h("input", { type: "checkbox", checked: on, onchange: () => toggle(kind, playlist) });
  return h(
    "label",
    { class: "row clickable" },
    box,
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", text: playlistName(playlist) }),
      h("div", { class: "subtitle", text: playlistDetail(kind, playlist) })
    ),
    kind === "provider" ? h("span", { class: "tag", text: playlist?.provider || "provider" }) : null
  );
}

function sourceOptions() {
  const servers = knownServers().filter((entry) => entry.url !== state.server);
  const select = h(
    "select",
    { class: "input", onchange: (event) => onSourceChosen(event.currentTarget.value) },
    h("option", { value: "", text: servers.length ? "Choose a server…" : "No other servers yet" }),
    servers.map((entry) =>
      h("option", {
        value: entry.url,
        text: entry.name || entry.url,
        selected: entry.url === ui.source ? true : null,
      })
    ),
    state.config.allowCustomServer ? h("option", { value: "__add__", text: "Add a server…" }) : null
  );
  return select;
}

function onSourceChosen(value) {
  if (value === "__add__") {
    addServerDialog();
    return;
  }
  if (value) loadSource(value);
}

function addServerDialog() {
  const input = h("input", { class: "input", placeholder: "https://music.example.com" });
  dialog({
    title: "Add a server",
    body: h(
      "div",
      { class: "field" },
      h("label", { text: "The address of another MusOak backend" }),
      input
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Use it",
        class: "suggested",
        onClick: () => {
          const raw = input.value.trim().replace(/\/+$/, "");
          if (!/^https?:\/\//i.test(raw)) {
            banner("a server address starts with http:// or https://", "error");
            return false;
          }
          rememberServer({ url: raw });
          loadSource(raw);
        },
      },
    ],
    onOpen: () => input.focus(),
  });
}

function playlistsCard() {
  const rows = [
    ...ui.personal.map((playlist) => playlistRow("personal", playlist)),
    ...ui.provider.map((playlist) => playlistRow("provider", playlist)),
  ];

  const search = h("input", {
    class: "input",
    placeholder: "Search this server's providers…",
    value: ui.query,
    oninput: (event) => {
      ui.query = event.currentTarget.value;
    },
    onkeydown: (event) => {
      if (event.key === "Enter") searchProviders();
    },
  });

  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "row" },
      h("span", { class: "grow", text: ui.source ? `Playlists on ${serverLabel(ui.source)}` : "Playlists" }),
      search,
      h("button", {
        class: "btn",
        text: ui.searching ? "Searching…" : "Search",
        disabled: ui.searching || !ui.source,
        onclick: searchProviders,
      })
    ),
    h("div", { class: "subtitle", text: ui.status }),
    rows.length
      ? h("div", { class: "list" }, rows)
      : h(
          "div",
          { class: "empty" },
          h("span", { class: "title", text: "No playlists yet" }),
          h("span", {
            text: ui.source
              ? "Search the providers above for one of this server's playlists."
              : "Add another server first: Import copies playlists between your servers.",
          })
        )
  );
}

function runCard() {
  const count = ui.picked.size;
  const single = count === 1;
  const nameInput = h("input", {
    class: "input",
    placeholder: single ? playlistName([...ui.picked.values()][0].playlist) : "Each keeps its own name",
    value: ui.name,
    disabled: !single || ui.busy,
    title: single ? "The name of the new playlist here" : "With several picked, each playlist keeps its own name",
    oninput: (event) => {
      ui.name = event.currentTarget.value;
    },
  });

  progressBar = h("div", { class: "bar", style: { width: `${ui.progressPct}%` } });
  progressText = h("span", { class: "subtitle", text: ui.progressText });

  return h(
    "div",
    { class: "card" },
    h(
      "div",
      { class: "field" },
      h("label", { text: "New playlist name" }),
      nameInput
    ),
    h(
      "div",
      { class: "row" },
      h("span", { class: "grow", text: count ? `${count} playlist(s) picked` : "Pick one or more playlists above" }),
      h("button", {
        class: "btn suggested",
        text: ui.busy ? "Copying…" : count === 1 ? "Copy playlist" : `Copy ${count || ""}`.trim(),
        disabled: ui.busy || count === 0,
        onclick: run,
      })
    ),
    ui.busy || ui.summary ? h("div", { class: "progress" }, progressBar) : null,
    ui.busy || ui.summary ? progressText : null,
    ui.summary ? h("div", { class: "row" }, h("span", { class: "grow", text: ui.summary })) : null
  );
}

function rebuild() {
  if (!root) return;
  clear(root);
  mount(
    root,
    h(
      "div",
      { class: "card" },
      h("h2", { text: "Import a playlist" }),
      h("p", {
        class: "subtitle",
        text:
          "Copy a playlist from another of your MusOak servers onto this one. Songs are matched by title and artist; anything this server does not have is left behind and counted.",
      }),
      h("div", { class: "field" }, h("label", { text: "Copy from" }), sourceOptions())
    ),
    playlistsCard(),
    runCard()
  );
}

function render(container, params = {}) {
  root = container;
  const wanted = params?.server || ui.source;
  if (wanted) {
    loadSource(wanted);
    return;
  }
  const first = knownServers().find((entry) => entry.url !== state.server);
  if (first) {
    loadSource(first.url);
    return;
  }
  rebuild();
}

function refresh() {
  if (ui.source) loadSource(ui.source);
  else rebuild();
}

registerView({
  id: "import",
  title: "Import",
  icon: "\u2913",
  order: 95,
  hidden: true,
  render,
  refresh,
});
