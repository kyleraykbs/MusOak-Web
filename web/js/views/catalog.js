// Artist and album pages: what clicking a search result opens into.
//
// The server answers /artists/{id} with the artist and the albums it knows, and
// /albums/{id} with the tracks once they are in the library. The two pages are
// the same shape, so they share a header and reuse the playlist view's rows.
//
// Both are detail views reached from a result, so neither appears in the nav.

import { h, mount, clear, iconButton, popover, toast, artworkImage, skeletonRows } from "../dom.js";
import { currentClient, navigate, registerView } from "../app.js";
import { playOne, playTracks, queueNextTracks, shuffleItems } from "./queue.js";
import { emptyState, playButtons, trackCountLine, trackMenu, trackRow } from "./playlist.js";
import { shareAlbum, shareArtist } from "./share.js";

registerView({ id: "artist", title: "Artist", hidden: true, render: renderArtist });
registerView({ id: "album", title: "Album", hidden: true, render: renderAlbum });

/** How many songs one request fills in the artist's songs panel. */
const SONGS_PAGE = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function panelSearch(placeholder, onInput) {
  return h("input", {
    type: "search", class: "panel-search", placeholder, "aria-label": placeholder,
    oninput: (event) => onInput(event.currentTarget.value.trim()),
  });
}

// --- pieces both pages use --------------------------------------------------

function artTile(client, artworkUrl, className = "art") {
  if (!artworkUrl) return h("div", { class: className, "aria-hidden": "true" });
  // 168px of header is 336 at twice the density; a 48px tile is 112. The
  // original can be a megabyte of phone photo, and neither is drawn that big.
  const width = className.includes("big") ? 336 : 112;
  return artworkImage(client?.artworkUrl ? client.artworkUrl(artworkUrl, "", width) : artworkUrl, { className, eager: className.includes("big") });
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

function header({ client, artworkUrl, appIcon = false, title, lines = [], actions = [] }) {
  return h(
    "div",
    { class: "card collection-header" },
    h(
      "div",
      { class: "collection-header-row" },
      // The singles container is the artist's singles rather than one release,
      // and it has no cover of its own; it wears the app's mark, exactly as its
      // row on the artist page does. The 1080px brand is the copy that is not
      // blurry at this size, and the page has already loaded.
      appIcon
        ? artworkImage("icon.png", { className: "art big", eager: true })
        : artTile(client, artworkUrl, "art big"),
      h(
        "div",
        { class: "grow collection-header-copy" },
        h("div", { class: "title collection-header-title", text: title }),
        ...lines.filter(Boolean).map((line) => h("div", { class: "subtitle wrap", text: line })),
        actions.length ? h("div", { class: "form-row collection-header-actions" }, actions) : null
      )
    )
  );
}



/** The shape both provider-collection pages have, written once: a server to
 *  ask, an id to ask about, a line while it loads, and a paint that draws
 *  whatever came back. The artist page and the album page differ in what they
 *  ask for and what they draw, which is all they should differ in. */
function collectionPage(container, params, { icon, what, plural, loading }) {
  const client = currentClient();
  const sheet = h("div", { class: "view-sheet" });
  mount(container, sheet);
  if (!client) {
    mount(sheet, emptyState(icon, "No server", `Add a server first: ${plural} live on one.`));
    return null;
  }
  if (!params.id) {
    mount(sheet, emptyState(icon, `No ${what}`, `That link does not name an ${what}.`));
    return null;
  }
  mount(sheet, h("div", { class: "loading-panel search-loading catalog-loading" }, skeletonRows(5), h("span", { class: "loading-caption", text: loading })));
  return { client, sheet };
}

/** What a page says when its one load failed: the same sentence with the page's
 *  own noun. */
function collectionFailed(sheet, icon, what, error) {
  if (sheet.isConnected) {
    mount(sheet, emptyState(icon, `That ${what} could not be loaded`, String(error?.message || error)));
  }
}

// --- the artist page --------------------------------------------------------

async function renderArtist(container, params = {}) {
  // The "loading more" line at the end of the songs list, while it is there.
  let songsMore = null;
  const page = collectionPage(container, params, {
    icon: "people", what: "artist", plural: "artists", loading: "Loading the artist…",
  });
  if (!page) return;
  const { client, sheet } = page;

  let artist = null;
  let catalogue = null;
  let albumsQuery = "";
  let songsQuery = "";
  let songs = [];
  let songsTotal = 0;
  let songsGeneration = 0;
  let songsLoading = false;
  let shellBuilt = false;

  const albumsCount = h("span", { class: "panel-count" });
  const albumsList = h("div", { class: "panel-list" });
  const songsCount = h("span", { class: "panel-count" });
  const songsList = h("div", { class: "panel-list" });
  const status = h("div", { class: "catalogue-status", role: "status" });
  const albumsPanel = h("section", { class: "artist-panel" },
    h("div", { class: "panel-head" }, h("span", { class: "panel-title", text: "Albums" }), albumsCount),
    panelSearch("Search albums", (value) => { albumsQuery = value; renderAlbums(); }),
    albumsList);
  const songsPanel = h("section", { class: "artist-panel" },
    h("div", { class: "panel-head" }, h("span", { class: "panel-title", text: "Songs" }), songsCount),
    panelSearch("Search songs", (value) => { songsQuery = value; void loadSongs({ pages: 1 }); }),
    songsList);

  const buildShell = () => {
    if (shellBuilt || !artist) return;
    shellBuilt = true;
    clear(sheet);
    sheet.appendChild(backRow(params.from));
    sheet.appendChild(header({
      client, artworkUrl: artist.artworkUrl, title: artist.name || "Artist",
      lines: [(artist.providers || []).join(", ")],
      actions: [h("button", { class: "btn", text: "Share…", title: "Share this artist's link", onclick: () => void shareArtist(artist) })],
    }));
    sheet.appendChild(status);
    sheet.appendChild(h("div", { class: "artist-panels" }, albumsPanel, songsPanel));
  };

  const renderStatus = () => {
    const state = catalogue;
    status.classList.toggle("busy", Boolean(state?.running));
    if (state?.running) {
      status.textContent = state.total
        ? `reading the catalogue · ${state.done} of ${state.total} releases · ${state.added} songs so far`
        : "reading the catalogue…";
    } else if (state?.errors?.length) {
      status.textContent = `${state.errors.length} release(s) could not be read; open the artist again to retry.`;
    } else {
      status.textContent = "";
    }
  };

  const renderAlbums = () => {
    const albums = artist?.albums || [];
    const needle = albumsQuery.toLowerCase();
    const shown = needle
      ? albums.filter((album) => `${album.title || ""} ${album.year || ""}`.toLowerCase().includes(needle))
      : albums;
    albumsCount.textContent = needle ? `${shown.length} of ${albums.length}` : String(albums.length);
    clear(albumsList);
    if (!shown.length) {
      albumsList.appendChild(emptyState("note", albums.length ? "No album matches" : "Nothing yet",
        albums.length ? "Try another search." : "The provider's albums appear here as they are read."));
      return;
    }
    albumsList.append(...shown.map((album) => albumRow(client, album, params)));
  };

  const renderSongs = () => {
    songsCount.textContent = songsLoading ? "…" : songsTotal > songs.length ? `${songs.length} of ${songsTotal}` : String(songsTotal || songs.length);
    clear(songsList);
    if (!songs.length) {
      songsList.appendChild(emptyState("note", songsLoading ? "Reading the artist…" : songsQuery ? "No song matches" : "No songs yet",
        songsLoading ? "The provider's songs appear here as they are found." : songsQuery ? "Try another search." : "The catalogue has not found a song yet."));
      return;
    }
    songsList.append(...songs.map((track, position) => trackRow({
      track, position, client, onActivate: () => playOne(songs, position), menu: trackMenu(track),
    })));
    watchSongsEnd();
  };

  // The panel is its own scroll box on a desktop and a plain block on a phone,
  // where the page scrolls instead - so watching the panel's `scroll` event
  // left the list at its first two hundred songs. The end of the list is
  // watched instead, against the viewport, which is whatever is scrolling.
  const watchSongsEnd = () => {
    // No observer (an old browser): the panel's own scroll below is the path.
    if (!follower) return;
    if (songs.length >= songsTotal) {
      if (songsMore) {
        follower.unobserve(songsMore);
        songsMore = null;
      }
      return;
    }
    if (!songsMore) {
      songsMore = h("div", { class: "panel-more", role: "status", "aria-live": "polite" },
        h("span", { class: "loading-spinner", "aria-hidden": "true" }),
        h("span", { text: "Loading more songs…" }));
    }
    songsList.appendChild(songsMore);
    follower.observe(songsMore);
  };

  const loadSongs = async ({ pages = 1 } = {}) => {
    const mine = ++songsGeneration;
    songsLoading = true;
    renderSongs();
    const collected = [];
    let total = 0;
    try {
      for (let page = 0; page < Math.max(1, pages); page += 1) {
        const payload = await client.artistTracks(params.id, { query: songsQuery, limit: SONGS_PAGE, offset: page * SONGS_PAGE });
        if (mine !== songsGeneration) return;
        collected.push(...(payload.tracks || []));
        total = payload.total;
        if (collected.length >= total) break;
      }
    } catch (error) {
      if (mine === songsGeneration) toast(String(error?.message || error));
    } finally {
      if (mine !== songsGeneration) return;
      songsLoading = false;
      songs = collected;
      songsTotal = total;
      renderSongs();
    }
  };

  const loadMoreSongs = async () => {
    if (songsLoading || songs.length >= songsTotal) return;
    const mine = songsGeneration;
    songsLoading = true;
    try {
      const payload = await client.artistTracks(params.id, { query: songsQuery, limit: SONGS_PAGE, offset: songs.length });
      if (mine !== songsGeneration) return;
      songs = songs.concat(payload.tracks || []);
      songsTotal = payload.total;
    } catch (error) {
      if (mine === songsGeneration) toast(String(error?.message || error));
    } finally {
      if (mine !== songsGeneration) return;
      songsLoading = false;
      renderSongs();
    }
  };
  const follower = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMoreSongs();
      }, { rootMargin: "600px" })
    : null;
  // A browser without IntersectionObserver still gets the panel's own scroll.
  songsList.addEventListener("scroll", () => {
    if (songsList.scrollTop + songsList.clientHeight >= songsList.scrollHeight - 240) void loadMoreSongs();
  });

  const refresh = async () => {
    const next = await client.artist(params.id);
    if (!sheet.isConnected) return;
    artist = next;
    catalogue = next.catalogue || catalogue;
    buildShell();
    renderAlbums();
    renderStatus();
  };

  const watchCatalogue = async () => {
    while (sheet.isConnected && catalogue?.running) {
      await sleep(1200);
      if (!sheet.isConnected) return;
      let state;
      try {
        state = await client.artistCatalogue(params.id);
      } catch {
        return;
      }
      const moved = state.done !== catalogue.done || state.running !== catalogue.running;
      catalogue = state;
      if (moved) {
        const pages = Math.max(1, Math.ceil(songs.length / SONGS_PAGE));
        await refresh();
        await loadSongs({ pages });
      } else {
        renderStatus();
      }
    }
  };

  try {
    await refresh();
    await loadSongs();
    void watchCatalogue();
  } catch (error) {
    collectionFailed(sheet, "people", "artist", error);
  }
}

/**
 * Play, shuffle or queue an album from a row that does not carry its tracklist.
 *
 * The whole album is asked for, not the row's count: the album endpoint reads
 * the release's tracklist whole, so a shuffle from an artist page shuffles the
 * record rather than the three songs an unopened album happened to hold.
 */
async function playAlbum(id, { shuffle = false, queue = false } = {}) {
  const client = currentClient();
  if (!client) return;
  let tracks;
  try {
    tracks = (await client.album(id)).tracks || [];
  } catch (error) {
    toast(String(error?.message || error));
    return;
  }
  if (!tracks.length) {
    toast("That album has no tracks to play yet");
    return;
  }
  const list = shuffle ? shuffleItems(tracks) : tracks;
  if (queue) queueNextTracks(list);
  else playTracks(list, 0);
}

function albumRow(client, album, params) {
  const singles = album.kind === "singles";
  // An album nobody has opened holds only the songs that were matched into it,
  // and its own count is not the length of the record: it says so rather than
  // stating a number that is wrong. Opening the album reads the rest.
  const count = album.partial
    ? `not synced yet · ${album.releaseTrackCount || "?"} tracks`
    : album.trackCount ? `${album.trackCount} track(s)` : "";
  const subtitle = singles
    ? ["all single releases", album.trackCount ? `${album.trackCount} track(s)` : ""]
    : [artistLine(album), album.year, count];
  const artwork = singles
    ? artworkImage("icon-64.png", { className: "art", eager: false })
    : artTile(client, album.artworkUrl);
  return h(
    "div",
    { class: `row clickable${singles ? " album-singles" : ""}`, onclick: () => navigate("album", { id: album.id, from: { view: "artist", params: { id: params.id } } }) },
    artwork,
    h(
      "div",
      { class: "grow" },
      h("div", { class: "title", text: album.title || "Untitled" }),
      subtitle.filter(Boolean).length ? h("div", { class: "subtitle", text: subtitle.filter(Boolean).join(" \u00b7 ") }) : null
    ),
    h("span", { class: "time", text: singles ? "" : album.year || "" }),
    iconButton("dots", {
      title: "More actions",
      onclick: (event) => {
        event.stopPropagation();
        popover(event.currentTarget, [
          { label: "Play album", onClick: () => void playAlbum(album.id, { shuffle: false }) },
          { label: "Shuffle album", onClick: () => void playAlbum(album.id, { shuffle: true }) },
          { label: "Queue album", onClick: () => void playAlbum(album.id, { queue: true }) },
          { label: "Share…", onClick: () => shareAlbum(album) },
        ]);
      },
    })
  );
}

// --- the album page ---------------------------------------------------------

async function renderAlbum(container, params = {}) {
  const page = collectionPage(container, params, {
    icon: "note",
    what: "album",
    plural: "albums",
    loading: "Loading the album…",
  });
  if (!page) return;
  const { client, sheet } = page;

  let album;
  let loadGeneration = 0;
  const load = async () => {
    const mine = ++loadGeneration;
    const next = await client.album(params.id);
    if (mine !== loadGeneration || !sheet.isConnected) return;
    album = next;
    paint();
  };
  const watchCatalogue = async () => {
    while (sheet.isConnected && album?.catalogue?.running) {
      await sleep(1500);
      if (!sheet.isConnected) return;
      try {
        await load();
      } catch {
        return;
      }
    }
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
        appIcon: album.kind === "singles",
        title: album.title || "Album",
        lines: [
          [artistLine(album), album.year].filter(Boolean).join(" \u00b7 "),
          album.catalogue?.running
            ? `reading the singles · ${album.catalogue.done || 0} of ${album.catalogue.total || 0} releases`
            : album.partial && album.releaseTrackCount
              ? `not synced yet · ${tracks.length} of ${album.releaseTrackCount} tracks`
              : tracks.length ? trackCountLine(tracks) : "No tracks found",
          (album.providers || []).join(", "),
        ],
        actions: [h("button", {
          class: "btn",
          text: "Share…",
          title: "Share this album's link",
          onclick: () => void shareAlbum(album),
        })],
      })
    );
    if (!tracks.length) {
      sheet.appendChild(emptyState("note", "No tracks found", "The provider did not return a tracklist for this album."));
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
            onActivate: () => playOne(tracks, position),
            menu: trackMenu(track),
          })
        )
      )
    );
  };

  try {
    await load();
    void watchCatalogue();
  } catch (error) {
    collectionFailed(sheet, "note", "album", error);
  }
}
