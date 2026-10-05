// Search: what the library holds and what every provider knows, in one list.
//
// The shell (../app.js) is browser-guarded, so importing it is safe in Node:
// unit tests import this module for the pure helpers below without a window.

import {
  h, clear, mount, dialog, popover, prompt, debounce, fmtDuration, toast,
  icon, iconOr, iconButton,
} from "../dom.js";
import {
  registerView, banner, requireLogin, currentClient, navigate,
} from "../app.js";
import { player } from "../player.js";
import { platformFilter, platformsFor, knownPlatforms } from "../platforms.js";
import { artistLink } from "./queue.js";
import { trackMenu } from "./playlist.js";
import { state, saveLocal } from "../state.js";

const SEARCH_LIMIT = 25;
// Typing searches without being asked, but every keystroke is a provider round
// trip, so wait for a pause first. One letter is not worth a round trip while
// typing, but it is a fine thing to ask for on purpose ("U2").
const TYPING_PAUSE_MS = 500;
const MIN_QUERY = 2;

// --- pure helpers ----------------------------------------------------------

/**
 * Matching user uploads sit above provider results, whatever order the server
 * sent the groups in: what the household uploaded itself is the most likely
 * thing being looked for. Stable: the two groups keep their relative order.
 */
export function pinUserUploads(groups = []) {
  const uploads = [];
  const providers = [];
  for (const group of groups || []) {
    (group?.userUpload ? uploads : providers).push(group);
  }
  return [...uploads, ...providers];
}

/** "Artist, Artist" for a track or album payload. */
export function artistLine(item) {
  return (item?.artists || []).filter(Boolean).join(", ");
}

/** The providers of one search group, deduplicated and sorted. */
export function groupProviders(group) {
  const names = (group?.variants || []).map((variant) => variant?.provider).filter(Boolean);
  return [...new Set(names)].sort();
}

/**
 * The sections the results are shown in, in order: user uploads first, then
 * provider tracks, then albums, artists and playlists. Empty ones are left out.
 */
export function searchSections({ groups = [], albums = [], artists = [], playlists = [] } = {}) {
  const pinned = pinUserUploads(groups);
  const uploads = pinned.filter((group) => group?.userUpload);
  const tracks = pinned.filter((group) => !group?.userUpload);
  const sections = [];
  if (uploads.length) sections.push({ key: "uploads", title: "Your uploads", kind: "track", items: uploads });
  if (tracks.length) sections.push({ key: "tracks", title: "Tracks", kind: "track", items: tracks });
  if (albums.length) sections.push({ key: "albums", title: "Albums", kind: "album", items: albums });
  if (artists.length) sections.push({ key: "artists", title: "Artists", kind: "artist", items: artists });
  if (playlists.length) sections.push({ key: "playlists", title: "Playlists", kind: "playlist", items: playlists });
  return sections;
}

/** The tabs the search offers, in the order they are shown. */
export const SEARCH_KINDS = [
  { key: "tracks", label: "Tracks", what: "tracks" },
  { key: "albums", label: "Albums", what: "albums" },
  { key: "artists", label: "Artists", what: "artists" },
  { key: "playlists", label: "Playlists", what: "playlists" },
];

/**
 * The one tab's worth of results. Tracks is the tab that also carries what the
 * household uploaded, since an upload is a track like any other.
 */
export function sectionsFor(kind, payload = {}) {
  const wanted = kind === "tracks" ? ["uploads", "tracks"] : [kind];
  return searchSections(payload).filter((section) => wanted.includes(section.key));
}

/**
 * Provider problems as quiet lines. A provider that failed says so without
 * taking the results that did arrive down with it.
 */
export function providerErrorLines(problems = []) {
  return (problems || []).map(
    (problem) => `${problem?.provider || "a provider"}: ${problem?.error || "failed"}`
  );
}

// --- module state ----------------------------------------------------------

let input = null;
let problemsEl = null;
let resultsEl = null;
let tabsEl = null;
let filterEl = null;
let lastQuery = "";
let generation = 0;

// --- small builders --------------------------------------------------------

function artwork(path, round = false) {
  const client = currentClient();
  const source = path ? (client?.artworkUrl ? client.artworkUrl(path) : path) : "";
  const shape = `art small${round ? " round" : ""}`;
  if (!source) {
    return h("div", {
      class: shape,
      style: { display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg4)" },
    }, icon("note"));
  }
  return h("img", { class: shape, src: source, alt: "", loading: "lazy" });
}

function emptyState(mark, title, subtitle) {
  return h(
    "div",
    { class: "empty" },
    mark,
    h("span", { class: "title", text: title }),
    subtitle ? h("span", { text: subtitle }) : null
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

// --- playback and menus ----------------------------------------------------

function playTracks(tracks, start = 0) {
  player.play(tracks, start);
}

/** A result opens what it is: an artist into their page, an album into theirs,
 *  and a provider playlist into an import, since its tracks are not in the
 *  library until they have been synced. */
function openCollection(kind, item) {
  if (kind === "artist" || kind === "album") navigate(kind, { id: item.id, from: { view: "search", params: {} } });
  else syncPlaylist(item);
}

function collectionMenu(kind, item) {
  if (kind === "playlist") {
    return [{ label: item.synced ? "Sync again" : "Sync into library", onClick: () => syncPlaylist(item) }];
  }
  return [
    { label: "Sync into library", onClick: () => syncIntoLibrary(kind, item) },
  ];
}

/** A provider playlist is brought in by syncing it, which is also what makes
 *  its tracks playable. */
async function syncPlaylist(item) {
  const client = currentClient();
  if (!client) return;
  try {
    const result = await client.syncPlaylist(item.id, item.provider || "");
    const added = Number(result?.added) || 0;
    toast(`Synced ${item.title || "the playlist"}: ${added} track(s)`);
  } catch (error) {
    handle(error);
  }
}

async function syncIntoLibrary(kind, item) {
  const client = currentClient();
  if (!client) return;
  try {
    const result = kind === "artist"
      ? await client.syncArtist(item.id, { syncAlbums: true })
      : await client.syncAlbum(item.id);
    const added = Number(result?.added) || 0;
    toast(`Synced ${item.title || item.name || "it"}: ${added} track(s)`);
  } catch (error) {
    handle(error);
  }
}

/** One playlist row per playlist, in a dialog, so a row's ⋮ can add to one. */
async function addToPlaylist(tracks) {
  const client = currentClient();
  if (!client) return;
  let playlists = [];
  try {
    playlists = await client.playlists();
  } catch (error) {
    handle(error);
    return;
  }

  const body = playlists.length
    ? h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: "4px" } },
        playlists.map((playlist) =>
          h("button", {
            class: "menu-item",
            text: playlist.name || "Untitled",
            onclick: async () => {
              ref.close();
              await addTracks(client, playlist.id, tracks);
            },
          })
        )
      )
    : h("p", { text: "No playlists yet. Create one first." });

  const ref = dialog({
    title: tracks.length === 1 ? "Add to playlist" : `Add ${tracks.length} tracks`,
    body,
    actions: [
      { label: "New playlist...", onClick: () => void createPlaylistThenAdd(client, tracks) },
      { label: "Cancel" },
    ],
  });
}

async function addTracks(client, playlistId, tracks) {
  try {
    await client.addToPlaylist(playlistId, tracks.map((track) => track.id));
    const what = tracks.length === 1 ? `\u201c${tracks[0].title}\u201d` : `${tracks.length} tracks`;
    toast(`Added ${what} to the playlist`);
  } catch (error) {
    handle(error);
  }
}

async function createPlaylistThenAdd(client, tracks) {
  const name = await prompt("New playlist", "Give it a name.", "", { confirm: "Create" });
  if (!name) return;
  try {
    const playlist = await client.createPlaylist(name);
    if (playlist?.id) await client.addToPlaylist(playlist.id, tracks.map((track) => track.id));
    toast("Playlist created");
  } catch (error) {
    handle(error);
  }
}

// --- rows ------------------------------------------------------------------

function trackRow(group) {
  const track = group?.track || {};
  const providers = groupProviders(group);
  const artist = artistLine(track);
  const rest = providers.join(", ");
  return h(
    "div",
    { class: "row clickable", onclick: () => playTracks([track]) },
    artwork(track.artworkUrl),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", text: track.title || "Untitled" }),
      // The artist is a way into their page; the provider names are not.
      artist || rest
        ? h(
            "div",
            { class: "subtitle" },
            artist ? artistLink(artist, (track.artistIds || [])[0]) || h("span", { text: artist }) : null,
            rest ? h("span", { text: `${artist ? " \u00b7 " : ""}${rest}` }) : null
          )
        : null
    ),
    track.durationMs ? h("div", { class: "time", text: fmtDuration(track.durationMs) }) : null,
    menuButton((anchor) => popover(anchor, trackMenu(track)))
  );
}

function collectionSubtitle(kind, item) {
  if (kind === "artist") return (item.providers || []).join(", ");
  if (kind === "playlist") return [item.owner, item.provider].filter(Boolean).join(" \u00b7 ");
  return [artistLine(item), (item.providers || []).join(", "), item.year].filter(Boolean).join(" \u00b7 ");
}

function collectionRow(kind, item) {
  const subtitle = collectionSubtitle(kind, item);
  return h(
    "div",
    { class: "row clickable", onclick: () => openCollection(kind, item) },
    artwork(item.artworkUrl),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", text: item.title || item.name || "Untitled" }),
      subtitle ? h("div", { class: "subtitle", text: subtitle }) : null
    ),
    item.trackCount ? h("div", { class: "time", text: `${item.trackCount} track(s)` }) : null,
    menuButton((anchor) => popover(anchor, collectionMenu(kind, item)))
  );
}

function sectionNode(section) {
  return h(
    "div",
    { class: "section", style: { display: "flex", flexDirection: "column", gap: "8px" } },
    h("div", { class: "section-title", text: section.title }),
    h(
      "div",
      { class: "list" },
      section.items.map((item) =>
        section.kind === "track" ? trackRow(item) : collectionRow(section.kind, item)
      )
    )
  );
}

// --- searching -------------------------------------------------------------

function showIdle() {
  generation += 1;
  if (!resultsEl) return;
  if (problemsEl) clear(problemsEl);
  mount(
    resultsEl,
    emptyState(iconOr("search", 38), "Search the library", "Type at least two letters, or press Enter.")
  );
}

function placeholderFor(kind) {
  const entry = SEARCH_KINDS.find((candidate) => candidate.key === kind) || SEARCH_KINDS[0];
  return `Search ${entry.what}`;
}

/** The tabs, with the one being searched marked. */
function kindTabNodes() {
  const current = state.searchKind || "tracks";
  return SEARCH_KINDS.map((entry) =>
    h("button", {
      class: `tab${entry.key === current ? " active" : ""}`,
      text: entry.label,
      title: `Search ${entry.what}`,
      onclick: () => chooseKind(entry.key),
    })
  );
}

/** Switching tab searches that kind again: the tabs are the only thing that
 *  decides what a query is looking for. */
function chooseKind(kind) {
  if (!SEARCH_KINDS.some((entry) => entry.key === kind) || kind === state.searchKind) return;
  state.searchKind = kind;
  saveLocal();
  if (tabsEl) mount(tabsEl, kindTabNodes());
  if (input) {
    input.placeholder = placeholderFor(kind);
    input.focus();
  }
  if (lastQuery) search(lastQuery, true);
  else showIdle();
}

function searchingPlaceholder(query, kind) {
  return emptyState(iconOr("search", 38), `Searching ${placeholderFor(kind).slice(7)}...`, `Looking for \u201c${query}\u201d.`);
}

/** How each tab asks for its own kind of thing, and nothing else: four round
 *  trips per keystroke would be three too many. */
const SEARCH_LOADERS = {
  tracks: (client, query, platforms) => client.search(query, SEARCH_LIMIT, platforms),
  albums: (client, query, platforms) => client.searchAlbums(query, SEARCH_LIMIT, platforms),
  artists: (client, query, platforms) => client.searchArtists(query, SEARCH_LIMIT, platforms),
  playlists: (client, query, platforms) => client.searchPlaylists(query, SEARCH_LIMIT, platforms),
};

async function search(raw, force = false) {
  const query = String(raw || "").trim();
  const client = currentClient();
  if (!client) return;
  if (!query) {
    lastQuery = "";
    showIdle();
    return;
  }
  if (query.length < MIN_QUERY && !force) return;
  if (!resultsEl) return;

  lastQuery = query;
  generation += 1;
  const mine = generation;
  if (problemsEl) clear(problemsEl);
  const kind = state.searchKind || "tracks";
  mount(resultsEl, searchingPlaceholder(query, kind));

  // The filter is what decides which platforms are asked; it cannot say until
  // the server has said which ones it has.
  await platformsFor(client);
  const platforms = filterEl ? filterEl.selected() : null;

  const loader = SEARCH_LOADERS[kind] || SEARCH_LOADERS.tracks;
  const answer = await loader(client, query, platforms).catch((error) => ({ error }));
  if (mine !== generation) return;

  const problems = [...(answer.providerErrors || [])];
  if (answer.error) {
    problems.push({ provider: "", error: answer.error.message || String(answer.error) });
    if (answer.error.status === 401) requireLogin();
  }

  showResults(sectionsFor(kind, answer), problems, query);
}

function showResults(sections, problems, query) {
  if (!resultsEl) return;
  if (problemsEl) {
    clear(problemsEl);
    if (problems.length) {
      problemsEl.appendChild(
        h("div", {
          style: { color: "var(--fg4)", fontSize: "13px" },
          text: `Some providers had trouble \u2014 ${providerErrorLines(problems).join("; ")}`,
        })
      );
    }
  }
  if (!sections.length) {
    const entry = SEARCH_KINDS.find((candidate) => candidate.key === (state.searchKind || "tracks"));
    mount(resultsEl, emptyState(iconOr("search", 38), `No ${entry?.what || "results"}`, `Nothing matched \u201c${query}\u201d.`));
    return;
  }
  mount(resultsEl, sections.map(sectionNode));
}

// --- the view --------------------------------------------------------------

function render(container, params = {}) {
  input = h("input", {
    class: "input",
    type: "search",
    placeholder: placeholderFor(state.searchKind),
    value: params?.q || lastQuery,
    oninput: debounce(() => search(input.value), TYPING_PAUSE_MS),
    onkeydown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        search(input.value, true);
      }
    },
  });
  const button = h("button", {
    class: "btn",
    text: "Search",
    title: "Search again",
    onclick: () => search(input.value, true),
  });
  problemsEl = h("div", {});
  resultsEl = h("div", { style: { display: "flex", flexDirection: "column", gap: "18px" } });
  tabsEl = h("div", { class: "tabs" }, kindTabNodes());
  filterEl = platformFilter({
    providers: knownPlatforms(),
    preferred: state.user?.searchPlatforms,
    onChange: () => refresh(),
  });
  const filterRow = h("div", { class: "search-filter" }, filterEl.node);

  mount(
    container,
    tabsEl,
    filterRow,
    h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } }, input, button),
    problemsEl,
    resultsEl
  );

  // The platform list arrives after the first paint; the filter is rebuilt with
  // it, keeping whatever the browser already remembered.
  const loadPlatforms = (attempt = 0) => {
    platformsFor(currentClient()).then((list) => {
      if (!filterRow.isConnected) return;
      if (!list.length) {
        // Not an answer: the server may simply not have been reachable yet. A
        // filter that says there are no platforms is worse than one that waits
        // a moment and asks again.
        if (attempt < 4) setTimeout(() => loadPlatforms(attempt + 1), 500 * (attempt + 1));
        return;
      }
      // The account's choice is what a search starts from: this is rebuilt
      // rather than remembered, so re-opening the page resets to it.
      filterEl = platformFilter({
        providers: list,
        preferred: state.user?.searchPlatforms,
        onChange: () => refresh(),
      });
      filterRow.replaceChildren(filterEl.node);
    });
  };
  loadPlatforms();

  if (params?.q) search(params.q, true);
  else if (lastQuery) search(lastQuery, true);
  else showIdle();
}

function refresh() {
  if (lastQuery) search(lastQuery, true);
}

const view = {
  id: "search",
  title: "Search",
  icon: "\u2315",
  order: 10,
  render,
  refresh,
};

registerView(view);
