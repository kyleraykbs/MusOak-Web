// The application shell: one backend at a time, one view at a time, and the
// pieces that belong to every view (server picker, login, bell, player).
//
// Views never touch this file's internals: they register themselves and build
// into the container they are handed.

import {
  h, clear, mount, render, dialog, popover, confirm, prompt, toast, fmtAgo, icon, iconOr, iconButton, artworkImage,
} from "./dom.js";
import {
  state, on, emit, loadLocal, saveLocal, sessionFor, session, updateSession,
  isSignedIn, setServer, rememberServer, knownServers, serverLabel, serverId, forgetServer, forgetRoom, renameServer as setServerName, iconVersion, userIdOf,
} from "./state.js";
import { Client, isTimeout, randomId } from "./client.js";
import { enterRoom, rejoinRoom, roomsTabTarget } from "./rooms-state.js";

const views = new Map();
let client = null;
let playerModule = null;
let booted = false;
let layout = null;
let notifyTimer = 0;
let reachabilityTimer = 0;
/** Friend requests waiting on an answer, for the Friends tab's badge. */
let friendRequestCount = 0;

const VIEW_MODULES = [
  "./views/search.js",
  "./views/catalog.js",
  "./views/playlists.js",
  "./views/playlist.js",
  "./views/provider-playlist.js",
  "./views/favourites.js",
  "./views/history.js",
  "./views/queue.js",
  "./views/import.js",
  "./views/manage.js",
  "./views/friends.js",
  "./views/rooms.js",
  "./views/account.js",
];

// --- what views use --------------------------------------------------------

/** A view: {id, title, icon?, order, hidden?, render(container, params), refresh?} */
export function registerView(view) {
  views.set(view.id, view);
  if (booted) renderNav();
}

export function currentClient() {
  return client;
}

export function currentUser() {
  return state.user;
}

function routeState() {
  return { view: state.view, params: state.viewParams || {} };
}

function syncBrowserRoute({ replace = false } = {}) {
  if (typeof history === "undefined") return;
  const method = replace ? "replaceState" : "pushState";
  history[method](routeState(), "", location.href);
}

function applyBrowserRoute(route) {
  const id = route?.view;
  if (!views.has(id)) return false;
  state.view = id;
  state.viewParams = route.params && typeof route.params === "object" ? route.params : {};
  saveLocal();
  renderContent();
  renderNav();
  return true;
}

export function navigate(id, params = {}) {
  const view = views.get(id);
  if (!view) {
    banner(`no such view: ${id}`, "error");
    return;
  }
  state.view = id;
  state.viewParams = params;
  saveLocal();
  syncBrowserRoute();
  renderContent();
  renderNav();
}

export function refreshCurrent() {
  views.get(state.view)?.refresh?.();
}

/**
 * Whether the view on screen is one that shows other people.
 *
 * Those are the ones worth re-reading on the notification tick: a face or a
 * name changing somewhere else should reach the page you are looking at, and
 * this is the only clock the app has. A view that does not say so is left
 * alone - re-running a search every thirty seconds would be a provider round
 * trip nobody asked for.
 */
function currentViewIsLive() {
  return Boolean(views.get(state.view)?.live);
}

/** How long a banner stays before it takes itself away.
 *
 * The GTK client does the same (ten seconds there): a message that never leaves
 * is one people learn to ignore. The dismiss button is still there for anyone
 * who wants it gone sooner.
 */
const BANNER_MS = 5000;
let bannerTimer = 0;

/** A line across the top of the app, for things worth saying and moving on. */
export function banner(message, kind = "") {
  if (!layout) return;
  const slot = layout.bannerSlot;
  const dismiss = () => {
    if (bannerTimer) {
      clearTimeout(bannerTimer);
      bannerTimer = 0;
    }
    clear(slot);
  };

  if (bannerTimer) {
    clearTimeout(bannerTimer);
    bannerTimer = 0;
  }
  clear(slot);
  if (!message) return;
  slot.appendChild(
    h(
      "div",
      { class: `banner ${kind}`.trim() },
      h("span", { text: message, class: "grow" }),
      h("button", { class: "btn flat small", text: "Dismiss", onclick: dismiss })
    )
  );
  bannerTimer = setTimeout(dismiss, BANNER_MS);
}

export function setUnread(count) {
  state.unread = Number(count) || 0;
  if (layout) renderBell();
}

/** The name of whoever we are listening along to, or null. */
export function setFollowing(name) {
  state.following = name || null;
  emit("following-changed", state.following);
}

export function requireLogin() {
  if (isSignedIn()) return true;
  openLogin();
  return false;
}

export { on, emit, toast };

// --- boot ------------------------------------------------------------------

export async function boot() {
  loadLocal();
  // The deployment's config, from the last run when there is one. Waiting on
  // this round trip before painting is a page that sits empty for as long as
  // the network takes to say something it already said last time - so when the
  // copy in hand will do, the fetch happens behind the page instead of in front
  // of it. A first visit has nothing stored and still waits, which is right:
  // there is nothing to paint without it.
  const known = Array.isArray(state.config?.servers) && state.config.servers.length > 0;
  if (known) void loadConfig();
  else await loadConfig();

  const wanted = state.server || state.config.defaultServer || "";
  if (wanted) setServer(wanted);

  // The shell draws before any view has arrived. The corner, the page and the
  // tab strip are the app; waiting for thirteen module graphs to land before the
  // first pixel is most of what a cold boot spends its time on. The view this
  // load lands on comes in first, so the empty page is short-lived, and
  // registerView redraws the tabs as the rest arrive behind it.
  buildLayout();
  booted = true;
  buildClient();
  renderNav();
  renderContent();
  window.addEventListener("popstate", (event) => {
    if (applyBrowserRoute(event.state)) return;
    syncBrowserRoute({ replace: true });
  });

  // Resolves once the landing view is in hand; the rest keep loading behind the
  // paint.
  await loadViews();

  // A reload should land where the user left off, or on the first view.
  if (!state.view || !views.has(state.view)) {
    const first = [...views.values()].filter((view) => !view.hidden).sort((a, b) => (a.order ?? 50) - (b.order ?? 50))[0];
    if (first) state.view = first.id;
    renderNav();
  }
  renderContent();
  syncBrowserRoute({ replace: true });

  if (wanted) {
    await refreshMe();
    startNotifications();
    await restorePlayback();
    await restoreRoom();
    maybeLoginPopup();
  }

  // The server's state, from the client's own calls and a slow poll between
  // them: a light that only changes when something asked is a light that lies.
  window.addEventListener("musoak:reachable", (event) => markReachable(event?.detail?.ok));
  window.addEventListener("online", () => markReachable(true));
  window.addEventListener("offline", () => markReachable(false));
  window.addEventListener("focus", () => checkServer());
  startReachability();
  checkServer();
  // Last, and never waited on: a worker that cannot register is a slower load,
  // not a broken one.
  startServiceWorker();
  watchVisibility();
}

/** Put the service worker in place.
 *
 * It is what makes a reload instant: the app's own files come from the copy the
 * last load kept, and the network is asked behind them. Which songs it keeps is
 * the offline module's business, not this one's.
 *
 * The path comes from this module's own URL, not from the page: the app is
 * served under a prefix on the real deployment (`/musoak/`), and a bare
 * "sw.js" would resolve against whatever route the page happens to be on. The
 * scope is the directory the app lives in, which is the whole of what the
 * worker should see - and it is only ever registered once.
 */
function startServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const scope = new URL("../", import.meta.url);
    // `type: "module"` is not optional: sw.js imports the cache names and the
    // media key out of offline.js, and a classic worker cannot have an import
    // at its top. Registering it as one fails with a syntax error, and the
    // failure is invisible - the page simply has no worker, every load is a
    // full one, and the offline shell never exists. That mistake hid here for
    // a while: the only other registration lived in offline.js, so the worker
    // appeared only on the loads that happened to import that feature module.
    navigator.serviceWorker.register(new URL("sw.js", scope), { scope, type: "module" }).then(
      (registration) => {
        // Tell the worker what this page is made of: every script and style it
        // loaded, from the browser's own record of the load. Without that the
        // cache only fills with what a later load happens to ask for, and a
        // phone whose network flips mid-load has nothing to fall back to.
        const ready = registration.active || navigator.serviceWorker.controller;
        if (!ready) return;
        const files = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => /\.(?:js|css)$/.test(new URL(name).pathname));
        ready.postMessage({ type: "shell", urls: [location.href.split("#")[0], ...new Set(files)] });
      },
      () => {
        /* no worker: every load is a full one, exactly as it was before */
      }
    );
  } catch {
    /* a browser without modules, or without a worker: nothing to do */
  }
}

/** How long the deployment is given to say what it offers.
 *
 *  The page cannot be laid out without this answer on a first visit, and the
 *  page itself has already arrived from this same origin - so an answer that
 *  takes longer than this is a request that is hanging, not a slow one. Without
 *  a deadline a proxy that accepts the request and never answers left the first
 *  visit on a blank page for as long as the browser was willing to wait. */
const CONFIG_TIMEOUT_MS = 5000;

/** Ask the deployment what it offers, and take its answer. */
async function loadConfig() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
  try {
    const response = await fetch("/ui/config", { signal: controller.signal });
    if (!response.ok) throw new Error(`the config request answered ${response.status}`);
    state.config = await response.json();
    for (const entry of state.config.servers || []) rememberServer(entry);
    saveLocal();
  } catch {
    if (state.config?.servers?.length) return; // the stored answer stands
    state.config = { defaultServer: "", loginPopup: false, servers: [], allowCustomServer: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask before putting the listener back in the room they were in.
 *
 * Rejoining is an explicit action, and the browser may refuse audio playback
 * without a user gesture. This click is the gesture that lets it play. */
async function restoreRoom() {
  const saved = state.room;
  if (!saved || !saved.roomId || !client) return;
  // A room that is over is not one to ask about: the saved state outlives the
  // room, and "join it again?" for a room that has ended is a question with no
  // good answer - saying yes would only open a new one under the old name.
  if (!(await roomStillUp(saved.roomId))) {
    forgetRoom();
    return;
  }
  if (!(await askJoin("Rejoin your room?", `You were listening in “${saved.name || "a room"}”. Join it again?`))) {
    forgetRoom();
    return;
  }
  try {
    await enterRoom({ client, roomId: saved.roomId, password: saved.password || "" });
    // The click that said yes is also the way in, the way joining from the
    // Rooms list is: the page follows the room it just put you in.
    navigate("room");
  } catch (error) {
    forgetRoom();
    banner(error && error.message ? error.message : "could not rejoin the room you were in", "error");
  }
}

/**
 * Whether the room a reload remembered is still up. Only a "not found" is proof
 * it is gone; anything else - a server that is down, a network that is not there
 * yet - leaves the question worth asking.
 */
async function roomStillUp(roomId) {
  try {
    await client.room(roomId);
    return true;
  } catch (error) {
    return !(error && (error.status === 404 || error.status === 403));
  }
}

/** Ask a yes/no question and resolve with the answer.
 *
 *  Escape and the declining action are both "no", and the promise settles once,
 *  whichever arrives first. Rejoining the room a reload remembers and taking an
 *  invitation from the bell are the same question with different words, so the
 *  shape lives once. */
function askJoin(title, body, { confirm = "Join", cancel = "Not now" } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === "Escape") done(false);
    };
    document.addEventListener("keydown", onKey);
    dialog({
      title,
      body,
      actions: [
        { label: cancel, onClick: () => done(false) },
        { label: confirm, class: "suggested", onClick: () => done(true) },
      ],
    });
  });
}

/** Rooms whose invitation has been announced this session. Keyed by room, not
 *  by notification: two invites to one room are one thing to answer, and a poll
 *  every thirty seconds must not say it again. */
const announcedRooms = new Set();

/**
 * A room invite nobody has seen is worth interrupting for: somebody is waiting
 * on an answer, which a badge on the bell does not convey. Dismissing leaves it
 * in the bell; taking it goes to the room.
 */
async function announceInvites(payload) {
  const invites = (payload?.notifications || []).filter(
    (note) =>
      note.kind === "room-invite" &&
      !note.read &&
      note.roomId &&
      !announcedRooms.has(String(note.roomId))
  );
  if (!invites.length) return;

  // A notification names the room only by id, so the name comes from the rooms
  // list. Not having it is not worth failing an invitation over.
  const names = new Map();
  try {
    const rooms = await client.rooms();
    for (const room of Array.isArray(rooms) ? rooms : rooms?.rooms || []) {
      names.set(String(room.id), room.name);
    }
  } catch {
    /* the invitation still stands without a name */
  }

  for (const note of invites) {
    announcedRooms.add(String(note.roomId));
    const from = note.from?.displayName || note.from?.username || "Someone";
    const room = names.get(String(note.roomId));
    const body = room
      ? `${from} invited you to room \u201c${room}\u201d.`
      : `${from} invited you to a room.`;
    if (await askJoin("Room invite", body, { cancel: "Dismiss" })) {
      navigate("rooms", { roomId: note.roomId });
    }
  }
}

async function loadViews() {
  // The view this load lands on, and only that one, is waited for: a paint with
  // something in it beats a paint with the whole registry in it. The rest of the
  // tabs are asked for behind that paint, and registerView redraws the nav as
  // each of them arrives.
  const landing = landingView();
  await importView(landing);
  const rest = VIEW_MODULES.filter((path) => path !== landing);
  void Promise.allSettled(rest.map((path) => importView(path)));
}

/** The module for the view a reload lands on: its own module when it has one,
 *  the module that registers it when it lives with another, and the first there
 *  is when the view it was left on is gone. Everything else arrives behind it. */
function landingView() {
  const own = `./views/${state.view}.js`;
  if (VIEW_MODULES.includes(own)) return own;
  // A view whose module does not carry its name: the room is registered by the
  // Rooms module, and an artist or an album page by the catalog. A reload on
  // one of those has to ask for that module first, or it lands on nothing.
  const owner = { room: "./views/rooms.js", artist: "./views/catalog.js", album: "./views/catalog.js" };
  return owner[state.view] || VIEW_MODULES[0];
}

/** One view module. A module that will not load is a tab that will not open, so
 *  its failure is said out loud and the others carry on without it. */
async function importView(path) {
  try {
    await import(path);
  } catch (error) {
    console.warn(`view ${path} failed to load: ${error?.message || error}`);
  }
}

function buildLayout() {
  layout = {
    sidebar: h("aside", { class: "sidebar", "aria-label": "Application sidebar" }),
    main: h("main", { class: "main" }),
    player: h("footer", { class: "player", "aria-label": "Player" }),
    content: h("div", { class: "content", id: "app-content", role: "region", "aria-busy": "false" }),
    bannerSlot: h("div", { class: "banner-slot", role: "status", "aria-live": "polite" }),
    title: h("h1", { text: "MusOak", tabindex: "-1" }),
    bell: iconButton("bell", { title: "Notifications", onclick: openNotifications }),
    brand: h("div", { class: "brand" }),
    nav: h("nav", { class: "nav", "aria-label": "Primary navigation" }),
    corner: h("div", { class: "corner" }),
    skip: h("a", { class: "skip-link", href: "#app-content", text: "Skip to content" }),
  };
  // The brand, the server and the sign-in live together so a phone can put them
  // on one line across the top while the tabs move down beside the player. The
  // tabs travel inside a wrapper that carries the arrows saying they can.
  layout.top = h("div", { class: "sidebar-top" }, layout.brand, layout.corner);
  // How far along the tabs are, drawn rather than native: a scrollbar you can
  // grab would fight the drag, and one that lights up under the mouse says
  // "drag me" about the wrong thing.
  layout.navIndicator = h("span", { class: "nav-indicator", "aria-hidden": "true" });
  layout.navLeft = h(
    "button",
    { class: "nav-edge left", title: "Scroll the tabs left", "aria-label": "Scroll the tabs left", onclick: () => scrollNav(-1) },
    icon("chevron-left", 18)
  );
  layout.navRight = h(
    "button",
    { class: "nav-edge right", title: "Scroll the tabs right", "aria-label": "Scroll the tabs right", onclick: () => scrollNav(1) },
    icon("chevron-right", 18)
  );
  layout.navWrap = h("div", { class: "nav-wrap" }, layout.nav, layout.navIndicator, layout.navLeft, layout.navRight);

  const topbar = h("div", { class: "topbar" }, layout.title, layout.bell);
  mount(layout.main, topbar, layout.bannerSlot, layout.content);
  mount(layout.sidebar, layout.skip, layout.top, layout.navWrap);
  // The queue's own button floats above the bottom panels, clear of the bar:
  // the bar keeps the song's actions, and the queue is always one tap away.
  layout.fab = h(
    "button",
    {
      class: "btn round queue-fab",
      title: "Queue",
      "aria-label": "Queue",
      onclick: () => toggleQueueDrawer(),
    },
    icon("queue", 20)
  );
  // The queue belongs beside the page, not on a page of its own: the floating
  // queue button slides this out from the right.
  layout.queueBody = h("div", { class: "drawer-body" });
  layout.drawer = h(
    "aside",
    { class: "drawer", hidden: true, "aria-label": "Queue", "aria-hidden": "true" },
    h(
      "div",
      { class: "drawer-head" },
      h("span", { class: "drawer-title", text: "Queue" }),
      iconButton("cross", { title: "Close the queue", onclick: () => toggleQueueDrawer(false) })
    ),
    layout.queueBody
  );
  mount(document.getElementById("app"), layout.sidebar, layout.main, layout.player, layout.drawer, layout.fab);

  wireNavScrolling();
  wireQueueDrawer();
  watchViewport();
  watchQueueFab();
  mountPlayer();
  renderBrand();
  renderCorner();
}

/** Open or close the queue drawer, and fill it with the queue. */
export async function toggleQueueDrawer(open = null) {
  if (!layout?.drawer) return;
  const wanted = open === null ? layout.drawer.hidden : Boolean(open);
  layout.drawer.hidden = !wanted;
  layout.drawer.setAttribute("aria-hidden", wanted ? "false" : "true");
  layout.drawer.classList.toggle("open", wanted);
  // The button follows the drawer out of the way and becomes the way back: an
  // arrow pointing the way it would slide to close.
  if (layout.fab) {
    layout.fab.classList.toggle("open", wanted);
    mount(layout.fab, icon(wanted ? "chevron-right" : "queue", 20));
    layout.fab.title = wanted ? "Close the queue" : "Queue";
    layout.fab.setAttribute("aria-label", layout.fab.title);
  }
  // On a desktop the page makes room for the drawer instead of hiding under it;
  // a phone has no room to give and keeps the overlay.
  document.getElementById("app")?.classList.toggle("queue-open", wanted);
  if (wanted) await fillQueueDrawer();
}

/** The drawer shows the queue view's own list, so there is one implementation. */
async function fillQueueDrawer() {
  const body = layout?.queueBody;
  if (!body) return;
  try {
    const module = await import("./views/queue.js");
    if (typeof module.renderQueue === "function") {
      module.renderQueue(body, { compact: true });
      return;
    }
  } catch (error) {
    console.warn("queue drawer: could not load the queue view", error);
  }
  mount(body, h("div", { class: "empty" }, h("span", { class: "title", text: "The queue is unavailable" })));
}

/**
 * The shell is pinned to what the phone actually shows.
 *
 * Fixed positioning is relative to the *layout* viewport, which on a phone is
 * the screen with the browser chrome hidden - taller than the part you can see -
 * so the bottom of the shell, where the tab strip and the player live, can fall
 * behind the chrome. visualViewport is the part you can see, and it reports when
 * that changes as the chrome slides away or comes back.
 */
function fitShellToViewport() {
  const app = document.getElementById("app");
  if (!app || typeof window === "undefined") return;
  const view = window.visualViewport;
  const height = view ? view.height : window.innerHeight;
  app.style.height = `${Math.round(height)}px`;
}

function watchViewport() {
  if (typeof window === "undefined") return;
  fitShellToViewport();
  window.addEventListener("resize", fitShellToViewport);
  window.visualViewport?.addEventListener("resize", fitShellToViewport);
  window.visualViewport?.addEventListener("scroll", fitShellToViewport);
}

/**
 * The floating queue button sits just above whichever panel is topmost down
 * there: the player on a desktop, the tab strip on a phone. Those heights move
 * with the song's text, so the offset is measured rather than guessed.
 */
function placeQueueFab() {
  if (!layout?.fab || typeof window === "undefined") return;
  const phone = window.matchMedia("(max-width: 700px), (max-aspect-ratio: 2/3)").matches;
  const anchor = document.querySelector(phone ? ".nav-wrap" : ".player");
  const rect = anchor?.getBoundingClientRect();
  // The queue button floats above whichever panel is topmost down there, and the
  // room's bubble floats beside it: both take this offset, so they cannot drift
  // apart. The stylesheet cannot know how tall the bar and the tab strip are,
  // and a fixed offset there landed the bubble on the bar.
  document.documentElement.style.setProperty(
    "--queue-fab-bottom",
    rect ? `${Math.round(window.innerHeight - rect.top) + 10}px` : "100px"
  );
}

function watchQueueFab() {
  if (typeof window === "undefined" || !layout?.fab) return;
  placeQueueFab();
  window.addEventListener("resize", placeQueueFab);
  if (typeof ResizeObserver !== "undefined") {
    // The bar grows and shrinks with the song's title and the phone's rows, and
    // the tab strip moves with them.
    const observer = new ResizeObserver(placeQueueFab);
    for (const selector of [".player", ".nav-wrap"]) {
      const anchor = document.querySelector(selector);
      if (anchor) observer.observe(anchor);
    }
  }
  // Crossing into the phone layout moves which panel is the topmost one.
  window.matchMedia("(max-width: 700px), (max-aspect-ratio: 2/3)").addEventListener?.("change", placeQueueFab);
}

function wireQueueDrawer() {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && layout?.drawer && !layout.drawer.hidden) toggleQueueDrawer(false);
    const target = event.target;
    const typing = target && (target.matches?.("input, textarea, select") || target.isContentEditable);
    if (event.key === "q" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey && !transportBlocked()) {
      event.preventDefault();
      toggleQueueDrawer();
    }
    if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey && !transportBlocked()) {
      event.preventDefault();
      navigate("search");
      requestAnimationFrame(() => document.querySelector("input[type='search']")?.focus());
    }
  });
}
/** An open drawer follows the queue; a closed one has nothing to follow. */
function followPlayerQueue() {
  for (const event of ["queue-changed", "track-changed"]) {
    playerModule?.player?.on?.(event, () => {
      if (layout?.drawer && !layout.drawer.hidden) fillQueueDrawer();
    });
  }
}

/** Scroll the tab strip by about a screenful, the way the arrows do. */
function scrollNav(direction) {
  if (!layout) return;
  const nav = layout.nav;
  nav.scrollBy({ left: direction * Math.max(nav.clientWidth * 0.7, 120), behavior: "smooth" });
}

/**
 * Make the tab strip draggable, and keep the edge arrows honest.
 *
 * A finger already scrolls an overflow strip; a mouse does not, so the drag is
 * there for one and left to the browser for the other. What the arrows say is
 * read from where the strip actually is, so they cannot lie about it.
 */
function wireNavScrolling() {
  const nav = layout.nav;
  let dragging = null;
  let swallowClick = false;

  nav.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "touch") return; // the browser's own scrolling is better
    dragging = { x: event.clientX, left: nav.scrollLeft, moved: false, pointerId: event.pointerId };
  });
  nav.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const moved = event.clientX - dragging.x;
    if (Math.abs(moved) > 3) {
      if (!dragging.moved) {
        // Capture only once this is a drag: capturing on the press itself sends
        // the click to the strip instead of the tab under it, and no tab would
        // ever be pressed again.
        dragging.moved = true;
        nav.setPointerCapture?.(dragging.pointerId);
      }
      nav.scrollLeft = dragging.left - moved;
    }
  });
  const release = () => {
    if (!dragging) return;
    swallowClick = dragging.moved;
    dragging = null;
  };
  nav.addEventListener("pointerup", release);
  nav.addEventListener("pointercancel", release);
  // A drag that ended on a tab must not also press it.
  nav.addEventListener("click", (event) => {
    if (!swallowClick) return;
    swallowClick = false;
    event.stopPropagation();
    event.preventDefault();
  }, true);

  nav.addEventListener("scroll", updateNavEdges, { passive: true });
  // The strip scrolls sideways, but a mouse wheel only goes up and down, and
  // the page itself cannot scroll to take the gesture instead. Over the strip, a
  // vertical wheel scrolls it across.
  nav.addEventListener(
    "wheel",
    (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return; // a sideways wheel already
      if (nav.scrollWidth <= nav.clientWidth) return; // nothing to scroll
      nav.scrollLeft += event.deltaY;
      event.preventDefault();
    },
    { passive: false }
  );
  window.addEventListener("resize", updateNavEdges);
  updateNavEdges();
}

/** Which way the tab strip has somewhere to go, and how far along it is. */
function updateNavEdges() {
  if (!layout?.navWrap) return;
  const nav = layout.nav;
  const room = nav.scrollWidth - nav.clientWidth;
  const wrap = layout.navWrap;
  wrap.dataset.scrollable = room > 4 ? "true" : "false";
  wrap.dataset.moreLeft = nav.scrollLeft > 4 ? "true" : "false";
  wrap.dataset.moreRight = nav.scrollLeft < room - 4 ? "true" : "false";

  // The indicator is the strip's scrollbar drawn by hand: it shows where the
  // tabs are, and cannot be grabbed, so it never fights the drag.
  const indicator = layout.navIndicator;
  if (!indicator) return;
  const fraction = nav.scrollWidth > 0 ? nav.clientWidth / nav.scrollWidth : 1;
  indicator.style.width = `${(Math.max(fraction, 0.12) * 100).toFixed(2)}%`;
  const travel = room > 0 ? (nav.scrollLeft / nav.scrollWidth) * 100 : 0;
  indicator.style.left = `${travel.toFixed(2)}%`;
}

async function mountPlayer() {
  try {
    const module = await import("./player.js");
    playerModule = module;
    module.mountPlayer?.(layout.player);
    followPlayerQueue();
  } catch (error) {
    console.warn("player unavailable", error);
    mount(layout.player, h("div", { class: "row" }, h("span", { class: "subtitle", text: "player unavailable" })));
  }
}

/**
 * Pick up where the last session left off, the way the GTK client does: the
 * queue, the track and the position come back from the account, and if that
 * queue came from a playlist, so does the page showing it.
 */
export async function restorePlayback() {
  if (!client || !isSignedIn()) return null;
  const restore = playerModule?.player?.restorePlayback;
  if (typeof restore !== "function") return null;
  try {
    const restored = await restore.call(playerModule.player, client);
    if (!restored?.restored) return null;
    banner("Picked up where you left off.");
    if (restored.playlistId && views.has("playlist")) navigate("playlist", { id: restored.playlistId });
    refreshCurrent();
    return restored;
  } catch (error) {
    console.warn("could not pick up the last session", error);
    return null;
  }
}

function renderBrand() {
  // The same icon the desktop client shows, then the name: one element for the
  // word, because as siblings the brand's flex gap sat between its halves and
  // read as a space. The picture is the 64px file, which is what a 26px corner
  // asks for: the 1080px one is a third of a megabyte behind a favicon.
  const image = artworkImage("icon-64.png", { className: "brand-icon", alt: "", eager: true });
  mount(
    layout.brand,
    image,
    h(
      "span",
      { class: "wordmark" },
      h("span", { class: "accent", text: "Mus" }),
      h("span", { class: "oak", text: "Oak" })
    )
  );
}

/** The top-left corner: the server picker, and the sign-in button beside it
 *  when this deployment points at a default server and asks people to sign in. */
function renderCorner() {
  const online = Boolean(state.online);
  const status = h("span", {
    class: `server-dot ${online ? "online" : "offline"}`.trim(),
    title: online ? `${serverLabel()} is answering` : `${serverLabel()} is not answering`,
    "aria-label": online ? "connected" : "not connected",
  });
  const serverButton = h("button", {
    class: "btn flat",
    title: "Choose the backend this page routes to",
    onclick: (event) => openServerPicker(event.currentTarget),
  }, status, h("span", { class: "label", text: serverLabel() }));

  // A server that is not answering gets a way to ask it again, right here.
  const retryButton = online
    ? null
    : iconButton("retry", {
        title: `Try ${serverLabel()} again`,
        class: "btn flat round retry",
        onclick: () => retryServer(),
      });

  mount(layout.corner, h("div", { class: "corner-row" }, serverButton, retryButton), accountCard());
}

/** Who you are on this server: the account's own icon and name. Anyone we
 *  cannot put a name to - no token, or a token this server will not name -
 *  gets the one button that fixes that, and nothing else. */
function accountCard() {
  const user = isSignedIn() ? state.user : null;
  if (!user) {
    return h("button", {
      class: "btn account-card signin",
      text: "Sign in",
      title: "Sign in to this server",
      onclick: () => openLogin(),
    });
  }
  const name = user.displayName || user.username;
  const iconUrl = user.iconUrl && client ? client.artworkUrl(user.iconUrl, iconVersion(userIdOf(user))) : "";
  // Their own face, at a size worth looking at: the card is about one person,
  // not a list of them, and a row's 32px tile reads as a thumbnail of somebody
  // you barely know.
  const artwork = iconUrl
    ? artworkImage(iconUrl, { className: "art round account-icon" })
    : h("span", { class: "art round account-icon placeholder" }, icon("users", 24));
  return h(
    "button",
    { class: "account-card", title: "Your account", onclick: () => navigate("account") },
    artwork,
    h(
      "span",
      { class: "who" },
      h("span", { class: "name", text: name }),
      user.username && user.displayName ? h("span", { class: "handle", text: `@${user.username}` }) : null
    )
  );
}

/**
 * Whether a failed call means the server is down, or merely answered "no".
 *
 * A refusal is an answer. A server that asks for a login is up and working, and
 * calling it "not answering" sends people looking for a network problem that
 * does not exist - which is exactly what a deployment with requireLogin on
 * looked like. Only a call that never got a response counts as down, and the
 * client reports those with no status at all.
 */
export function serverAnswered(error) {
  return Number(error?.status) > 0;
}

/** The browser's own view of the network, said the same way a failed request
 *  is: the views redraw, and checkServer corrects it if the server disagrees. */
function markReachable(ok) {
  if (Boolean(state.online) === Boolean(ok)) return;
  state.online = Boolean(ok);
  renderCorner();
  emit("online-changed", state.online);
}

/** Ask the backend whether it is there, and draw the answer. */
async function checkServer({ force = false } = {}) {
  if (!client || !state.server) return;
  const before = Boolean(state.online);
  try {
    await client.get("/api/v1/clock");
    state.online = true;
  } catch (error) {
    // A request this page gave up on says nothing either way: the server may be
    // working on something slow, and the light should not flicker for it.
    if (!isTimeout(error)) state.online = serverAnswered(error);
  }
  if (force || state.online !== before) {
    renderCorner();
    emit("online-changed", state.online);
  }
}

/** The retry button: try the server again, and bring the view back with it. */
async function retryServer() {
  await checkServer({ force: true });
  if (!state.online) {
    toast(`${serverLabel()} is still not answering`);
    return;
  }
  await syncSessionCookies();
  await refreshMe();
  refreshCurrent();
  startNotifications();
  checkServer();
}

function startReachability(intervalMs = 20000) {
  clearInterval(reachabilityTimer);
  reachabilityTimer = setInterval(() => checkServer(), intervalMs);
}

/**
 * A hidden tab has nothing to redraw, so the two polls that keep it current -
 * the bell every thirty seconds and the server light every twenty - stop while
 * it is hidden and start again when it is looked at. A page nobody is watching
 * is a page that has no business asking the server anything.
 */
function watchVisibility() {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearInterval(notifyTimer);
      clearInterval(reachabilityTimer);
      return;
    }
    startNotifications();
    startReachability();
  });
}

// Views name their sidebar icon; a few were asked for as glyphs, which some
// fonts show as a box. Both spellings reach the same drawn icon.
const GLYPH_ALIASES = {
  "\u2315": "search", "\u2630": "list", "\u2605": "star", "\u266b": "note", "\u266a": "note",
  "\u21a5": "upload", "\u263a": "people", "\u2302": "home", "\u2699": "gear", "\u2691": "bell",
  "\u25b2": "up", "\u25bc": "down",
};

function nameForIcon(glyph) {
  return GLYPH_ALIASES[glyph] || glyph;
}

let navSignature = "";

/** How many people are waiting on an answer, for the Friends tab. Zero hides
 *  the badge. The bell's poll keeps it current, so the count arrives whether or
 *  not the Friends page has ever been opened. */
export function setFriendRequestCount(count) {
  const next = Math.max(0, Math.trunc(Number(count) || 0));
  if (next === friendRequestCount) return;
  friendRequestCount = next;
  renderNav();
}

/** The number a tab carries. Only Friends has one. */
function navBadge(view) {
  return view.id === "friends" ? friendRequestCount : 0;
}

function renderNav() {
  if (!layout) return;
  const items = [...views.values()].filter((view) => !view.hidden).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  // The count is part of the signature: a tab that gains or loses a badge is a
  // different strip, and a strip is only rebuilt when it is.
  const signature = items.map((view) => `${view.id}:${navBadge(view)}`).join("\u0000");
  // The strip scrolls sideways on a phone, and rebuilding it throws that scroll
  // away: a click on a tab would snap the bar back to its start. When only the
  // highlight moved, move the highlight.
  if (signature === navSignature && layout.nav.childElementCount === items.length) {
    for (const [index, view] of items.entries()) {
      layout.nav.children[index].classList.toggle("active", navCovers(view));
    }
    updateNavEdges();
    return;
  }
  const scroll = layout.nav.scrollLeft;
  mount(
    layout.nav,
    items.map((view) =>
      h("button", {
        class: `nav-item ${navCovers(view) ? "active" : ""}`.trim(),
        onclick: () => navigate(navTarget(view)),
      },
        h("span", { class: "icon" }, iconOr(nameForIcon(view.icon), 16)),
        h("span", { text: view.title }),
        navBadge(view)
          ? h("span", { class: "badge", text: navBadge(view) > 99 ? "99+" : String(navBadge(view)) })
          : null
      )
    )
  );
  layout.nav.scrollLeft = scroll;
  navSignature = signature;
  // The strip is new, so whether it has more to show is new too.
  updateNavEdges();
}

/** Whether a tab is the one on screen: its own view, or one it stands for -
 *  the Rooms tab covers the room being followed, which has no tab of its own. */
function navCovers(view) {
  return state.view === view.id || (view.also || []).includes(state.view);
}

/** Where a tab goes: its own view, or wherever it says it should go today. */
function navTarget(view) {
  return typeof view.to === "function" ? view.to() : view.id;
}

function renderBell() {
  if (!layout) return;
  const unread = state.unread;
  layout.bell.classList.toggle("has-unread", unread > 0);
  layout.bell.title = unread ? `${unread} unread` : "Notifications";
  mount(
    layout.bell,
    icon("bell", 17),
    unread ? h("span", { class: "badge", text: unread > 99 ? "99+" : String(unread) }) : null
  );
}

function renderContent() {
  if (!layout) return;
  const view = views.get(state.view);
  layout.title.textContent = view ? view.title : "MusOak";
  // Keep one page shell mounted: views own their loading state, so navigation
  // changes content without blanking the whole layout or shifting the drawer.
  // The outer page shell survives navigation; each view gets a fresh child so
  // a slow response from the previous view becomes disconnected and cannot
  // paint over the destination.
  const shell = layout.viewContainer || (layout.viewContainer = h("div", { class: "page" }));
  const container = h("div", { class: "view-surface" });
  if (!shell.isConnected) layout.content.appendChild(shell);
  layout.content.setAttribute("aria-busy", "true");
  mount(shell, container);

  if (!state.server) {
    mount(container, h("div", { class: "empty" },
      h("span", { class: "icon" }, icon("home", 38)),
      h("span", { class: "title", text: "No server yet" }),
      h("span", { text: "Choose a backend to browse. This page is only a frontend: your music lives on your own server." }),
      h("button", { class: "btn suggested", text: "Choose a server", onclick: (event) => openServerPicker(event.currentTarget) })
    ));
    layout.content.setAttribute("aria-busy", "false");
    return;
  }
  if (!view) {
    mount(container, h("div", { class: "empty" }, h("span", { class: "title", text: "Nothing here yet" })));
    layout.content.setAttribute("aria-busy", "false");
    return;
  }

  clear(container);
  const rendered = (() => {
    try {
      return view.render?.(container, state.viewParams);
    } catch (error) {
      reportViewFailure(container, view, error);
      return null;
    }
  })();
  if (view && container.isConnected) layout.title.focus?.({ preventScroll: true });
  // A view that fetches before it draws can fail later than this call: that
  // failure must reach only the current surface.
  Promise.resolve(rendered).finally(() => {
    if (container.isConnected && container === layout.viewContainer?.firstElementChild) layout.content.setAttribute("aria-busy", "false");
  }).catch((error) => {
    if (container.isConnected && container === layout.viewContainer?.firstElementChild) reportViewFailure(container, view, error);
  });
}

function reportViewFailure(container, view, error) {
  console.error(`view ${view.id} failed`, error);
  if (!container.isConnected) return;
  mount(container, h("div", { class: "empty" },
    h("span", { class: "title", text: "This view could not be shown" }),
    h("span", { text: String(error?.message || error) })
  ));
}

// --- the client ------------------------------------------------------------

function buildClient() {
  const current = session();
  client = new Client({
    server: state.server,
    token: current.token,
    memberId: current.memberId || ensureMemberId(),
    memberName: current.memberName || "web",
  });
  syncSessionCookies();
  return client;
}

function ensureMemberId() {
  const existing = session().memberId;
  if (existing) return existing;
  const id = randomId();
  updateSession({ memberId: id, memberName: "web" });
  return id;
}

/** Media elements cannot set a routing header or a bearer token: a cookie
 *  carries both for them. */
async function syncSessionCookies() {
  try {
    await fetch("/ui/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: state.server, token: session().token || "" }),
    });
  } catch {
    /* the router is down: every call will say so on its own */
  }
}

export function rebindClient() {
  buildClient();
  emit("client-changed", client);
}

export async function refreshMe() {
  if (!isSignedIn()) {
    state.user = null;
    state.favorites = new Map();
    emit("user-changed", null);
    renderCorner();
    return;
  }
  try {
    state.user = await client.me();
    await refreshFavorites();
  } catch (error) {
    if (error.status === 401) {
      updateSession({ token: "" });
      state.user = null;
      buildClient();
    } else {
      banner(`could not load your account: ${error.message}`, "error");
    }
  }
  emit("user-changed", state.user);
  renderCorner();
}

async function refreshFavorites() {
  try {
    const tracks = await client.favorites();
    state.favorites = new Map(
      tracks.map((track) => [String(track.id), normalizeRating(track.rating)])
    );
    emit("favorites-changed", state.favorites);
  } catch {
    /* a guest has none */
  }
}

function normalizeRating(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(5, Math.max(0.1, Math.round(number * 10) / 10)) : 5;
}

export function favoriteRating(trackId) {
  return state.favorites instanceof Map ? state.favorites.get(String(trackId)) : null;
}

/** Open the rating dialog for a track. Existing favourites can be removed here. */
export function openFavoriteDialog(trackId) {
  if (!requireLogin()) return;
  const id = String(trackId || "");
  if (!id) return;
  const existing = favoriteRating(id);
  const slider = h("input", { class: "input", type: "range", min: "0.1", max: "5", step: "0.1", value: String(existing || 5) });
  const value = h("strong", { text: `${Number(slider.value).toFixed(1)}/5.0` });
  slider.addEventListener("input", () => { value.textContent = `${Number(slider.value).toFixed(1)}/5.0`; });
  const status = h("div", { class: "subtitle", text: "" });
  const actions = [{ label: "Cancel" }];
  if (existing != null) actions.push({ label: "Remove rating", class: "destructive", onClick: () => saveFavoriteRating(id, null) });
  actions.push({ label: existing == null ? "Rate" : "Save", class: "suggested", onClick: () => saveFavoriteRating(id, Number(slider.value), status) });
  dialog({
    title: existing == null ? "Rate favourite" : "Change rating",
    body: h("div", { class: "field" }, h("label", { text: "Your rating" }), slider, value, status),
    actions,
  });
}

async function saveFavoriteRating(trackId, rating, status) {
  const before = favoriteRating(trackId);
  if (rating == null) state.favorites.delete(String(trackId));
  else state.favorites.set(String(trackId), normalizeRating(rating));
  emit("favorites-changed", state.favorites);
  try {
    if (rating == null) await client.removeFavorite(trackId);
    else await client.addFavorite(trackId, rating);
  } catch (error) {
    if (before == null) state.favorites.delete(String(trackId));
    else state.favorites.set(String(trackId), before);
    emit("favorites-changed", state.favorites);
    if (status) status.textContent = error?.message || String(error);
    else banner(`could not change that favourite: ${error.message}`, "error");
    return false;
  }
  return true;
}

/** Compatibility action used by stars and menus: opening is the action now. */
export function toggleFavorite(trackId) {
  openFavoriteDialog(trackId);
}

// --- the server picker -----------------------------------------------------

export function openServerPicker(anchor) {
  const known = knownServers();
  const items = known.map((entry) => ({
    label: entry.name,
    icon: entry.url === state.server ? "*" : sessionFor(entry.url).token ? "+" : "",
    title: entry.url,
    onClick: () => switchServer(entry.url),
    trailing: [
      { icon: "pencil", title: `Rename ${entry.name}`, onClick: () => editServer(entry) },
      { icon: "cross", title: `Remove ${entry.name} from this list`, onClick: () => removeServer(entry) },
    ],
  }));

  if (state.config.allowCustomServer) {
    items.push({ separator: true });
    items.push({ label: "Add a server…", icon: "plus", onClick: () => addServerDialog() });
  }
  if (known.length && state.server) {
    items.push({ separator: true });
    items.push({
      label: isSignedIn() ? "Sign out of this server" : "Sign in to this server",
      icon: isSignedIn() ? "logout" : "login",
      onClick: () => (isSignedIn() ? signOut() : openLogin()),
    });
  }
  popover(anchor, items);
}

/** Edit a backend in this browser: what it is called, and where it points.
 *  Changing the address moves the entry, carrying its sign-in with it. */
async function editServer(entry) {
  const nameInput = h("input", { class: "input", value: entry.name, placeholder: "What to call it" });
  const urlInput = h("input", { class: "input", value: entry.url, placeholder: "https://music.example.com" });
  const status = h("span", { class: "login-status" });

  dialog({
    title: `Edit ${entry.name}`,
    body: h(
      "div",
      { class: "field" },
      h("label", { text: "Name" }),
      nameInput,
      h("label", { text: "Address" }),
      urlInput,
      status
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Save",
        class: "suggested",
        onClick: () => {
          const name = nameInput.value.trim();
          const url = urlInput.value.trim().replace(/\/+$/, "");
          if (!/^https?:\/\/[^\s/]+/i.test(url)) {
            status.className = "login-status error";
            status.textContent = "an address starts with http:// or https:// and names a host";
            return false;
          }
          applyServerEdit(entry, { name, url });
        },
      },
    ],
    onOpen: () => {
      nameInput.focus();
      nameInput.select?.();
    },
  });
}

/** Put an edited server back: the same entry, possibly at a new address. */
function applyServerEdit(entry, { name, url }) {
  const wasActive = entry.url === state.server;
  if (url === entry.url) {
    setServerName(entry.url, name);
    toast(name ? `${entry.name} is now ${name}` : `${entry.name} goes by its own name again`);
  } else {
    // The entry moves: its sign-in goes with it, and the address it left is
    // forgotten, so a deployment's own list does not bring it back.
    const carried = sessionFor(entry.url);
    rememberServer({ url, name: name || serverLabel(url) });
    state.sessions[serverId(url)] = carried;
    delete state.sessions[serverId(entry.url)];
    setServerName(entry.url, "");
    if (name) setServerName(url, name);
    forgetServer(entry.url);
    toast(`${entry.name} now points at ${url}`);
  }
  renderCorner();
  renderBrand();
  if (wasActive && url !== state.server) switchServer(url);
}

/** Drop a backend from this browser: it leaves the list and its sign-in is
 *  forgotten. The server itself is untouched, which is what the dialog says. */
async function removeServer(entry) {
  const agreed = await confirm(
    `Remove ${entry.name}?`,
    "It leaves this list and this browser forgets its sign-in. The server itself is untouched, and you can add it again by address.",
    { confirm: "Remove", destructive: true }
  );
  if (!agreed) return;
  const wasCurrent = entry.url === state.server;
  forgetServer(entry.url);
  toast(`${entry.name} removed`);
  const next = knownServers()[0];
  if (wasCurrent && next) {
    switchServer(next.url);
    return;
  }
  if (wasCurrent) {
    buildClient();
    state.user = null;
    emit("user-changed", null);
    renderBrand();
    renderCorner();
    renderContent();
    return;
  }
  renderCorner();
}

export function switchServer(url) {
  if (!url || url === state.server) return;
  setServer(url);
  buildClient();
  state.user = null;
  state.favorites = new Map();
  state.online = true;
  emit("user-changed", null);
  renderBrand();
  renderCorner();
  refreshMe().then(() => {
    refreshCurrent();
    startNotifications();
    checkServer({ force: true });
  });
}

function addServerDialog() {
  const nameInput = h("input", { class: "input", placeholder: "What to call it" });
  const input = h("input", { class: "input", placeholder: "https://music.example.com" });
  dialog({
    title: "Add a server",
    body: h(
      "div",
      { class: "field" },
      h("label", { text: "Name" }),
      nameInput,
      h("label", { text: "The address of a MusOak backend" }),
      input
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Add",
        class: "suggested",
        onClick: () => {
          const url = input.value.trim().replace(/\/+$/, "");
          if (!/^https?:\/\//i.test(url)) {
            banner("a server address starts with http:// or https://", "error");
            return false;
          }
          rememberServer({ url, name: nameInput.value.trim() });
          switchServer(url);
        },
      },
    ],
    onOpen: () => nameInput.focus(),
  });
}

// --- signing in ------------------------------------------------------------

function maybeLoginPopup() {
  const asks = state.config.loginPopup && state.config.defaultServer;
  const skipped = session().loginSkipped;
  if (asks && !isSignedIn() && !skipped) openLogin({ arrival: true });
}

export function openLogin({ arrival = false } = {}) {
  const username = h("input", { class: "input", placeholder: "username", autocomplete: "username" });
  const password = h("input", { class: "input", type: "password", placeholder: "password", autocomplete: "current-password" });
  const status = h("span", { class: "subtitle" });
  let registering = false;

  const submit = async (event) => {
    const button = event?.currentTarget;
    status.className = "login-status";
    if (!username.value.trim() || !password.value) {
      status.className = "login-status error";
      status.textContent = "a username and a password, please";
      return false;
    }
    status.textContent = registering ? "Creating your account…" : "Signing in…";
    if (button) {
      button.disabled = true;
      button.dataset.busy = "true";
    }
    try {
      if (registering) await client.register(username.value.trim(), password.value);
      else await client.login(username.value.trim(), password.value);
      updateSession({ token: client.token, loginSkipped: true });
      await syncSessionCookies();
      await refreshMe();
      // A room membership carries the name and picture it was made with, so
      // signing in has to join again for the room to show who this now is.
      await rejoinRoom().catch(() => {});
      const who = state.user?.displayName || state.user?.username || username.value.trim();
      renderCorner();
      startNotifications();
      // Picking up can say its own piece; the confirmation is what should stay.
      await restorePlayback();
      banner(`Signed in to ${serverLabel()} as ${who}`);
      refreshCurrent();
      return true;
    } catch (error) {
      status.className = "login-status error";
      status.textContent = error?.message || (registering ? "could not create that account" : "could not sign in");
      return false;
    } finally {
      if (button) {
        button.disabled = false;
        delete button.dataset.busy;
      }
    }
  };

  const form = h(
    "div",
    { class: "field" },
    arrival ? h("p", { text: `${serverLabel()} asks who you are. Sign in, or carry on as a guest.` }) : null,
    h("label", { text: "Username" }),
    username,
    h("label", { text: "Password" }),
    password,
    status
  );

  const { close } = dialog({
    title: arrival ? `Sign in to ${serverLabel()}` : "Sign in",
    body: form,
    actions: [
      { id: "skip", label: "Skip", onClick: () => { updateSession({ loginSkipped: true }); renderCorner(); } },
      {
        id: "toggle-registration",
        label: "Create an account",
        onClick: (event) => {
          registering = !registering;
          event.currentTarget.textContent = registering ? "I have an account" : "Create an account";
          const submitButton = event.currentTarget.closest(".dialog")?.querySelector("[data-action='submit']");
          if (submitButton) submitButton.textContent = registering ? "Create account" : "Sign in";
          status.textContent = registering ? "a new account on this server" : "";
          return false;
        },
      },
      { id: "submit", label: "Sign in", class: "suggested", onClick: submit },
    ],
    onOpen: () => username.focus(),
  });
  return { close };
}

function signOut() {
  client?.logout().catch(() => null);
  updateSession({ token: "" });
  state.user = null;
  state.favorites = new Map();
  // Signed out is signed out: the bell's poll has nothing left to ask this
  // account for, and a tab that keeps asking every thirty seconds as a guest is
  // a request nobody is waiting on.
  clearInterval(notifyTimer);
  buildClient();
  emit("user-changed", null);
  renderCorner();
  refreshCurrent();
  toast("signed out");
}

// --- notifications ---------------------------------------------------------

function startNotifications() {
  clearInterval(notifyTimer);
  if (!isSignedIn()) {
    setUnread(0);
    setFriendRequestCount(0);
    return;
  }
  const tick = async () => {
    let payload;
    try {
      payload = await client.notifications();
      setUnread(payload.unread || 0);
      setFriendRequestCount(payload.friendRequests || 0);
    } catch {
      /* offline is not an error worth shouting about */
      return;
    }
    await announceInvites(payload);
    // Somebody may have changed their picture or their name: the views that
    // show people ask again, and the icon versions in the answer are what make
    // a new picture a new URL.
    if (currentViewIsLive()) refreshCurrent();
  };
  tick();
  notifyTimer = setInterval(tick, 30000);
}

async function openNotifications(event) {
  // The anchor has to be taken now: `currentTarget` is only set while the event
  // is being dispatched, and this handler awaits before it draws.
  const anchor = event?.currentTarget || layout?.bell;
  if (!requireLogin()) return;
  let payload = { notifications: [], unread: 0 };
  try {
    payload = await client.notifications();
  } catch (error) {
    banner(`could not load notifications: ${error.message}`, "error");
    return;
  }
  const items = (payload.notifications || []).map((note) => ({
    label: describeNotification(note),
    icon: note.read ? "" : "\u2022",
    onClick: () => {
      if (note.kind === "room-invite" && note.roomId) navigate("rooms", { roomId: note.roomId });
      // A request is answered on the Requests tab, so go there rather than to
      // the person's page: that is where the button is.
      else if (note.kind === "friend-request") navigate("friends", { tab: "requests" });
      else if (note.from?.id) navigate("friends", { userId: note.from.id });
    },
  }));
  if (!items.length) items.push({ label: "nothing yet", disabled: true });
  popover(anchor, items);
  try {
    await client.markNotificationsRead();
    setUnread(0);
  } catch {
    /* leaving it unread is harmless */
  }
}

function describeNotification(note) {
  const from = note.from?.displayName || note.from?.username || "someone";
  const when = note.createdAt ? ` (${fmtAgo(note.createdAt)})` : "";
  switch (note.kind) {
    case "friend-request":
      return `${from} asked to be friends${when}`;
    case "friend-accepted":
      return `${from} accepted your friend request${when}`;
    case "room-invite":
      return `${from} invited you to a room${when}`;
    case "share":
      return `${from} shared a song with you${when}`;
    default:
      return `${from} shared something with you${when}`;
  }
}

// --- keyboard --------------------------------------------------------------

/** A browser runs the shell on import; a test importing a view must not. */
export const inBrowser = typeof document !== "undefined" && typeof window !== "undefined";

/**
 * Whether the keyboard belongs to a field the user is typing into. Space is a
 * space there, and a command everywhere else - including on the controls, where
 * a click has just left the focus: clicking the seek used to make space do
 * nothing at all.
 */
export function isTypingTarget(element) {
  if (!element || typeof element !== "object") return false;
  if (element.isContentEditable) return true;
  if (typeof HTMLTextAreaElement !== "undefined" && element instanceof HTMLTextAreaElement) return true;
  if (typeof HTMLSelectElement !== "undefined" && element instanceof HTMLSelectElement) return true;
  if (typeof HTMLInputElement === "undefined" || !(element instanceof HTMLInputElement)) return false;
  const type = (element.getAttribute("type") || "text").toLowerCase();
  return !NON_TYPING_INPUTS.has(type);
}

/** Input types that never take a space: the ones that are controls, not fields. */
const NON_TYPING_INPUTS = new Set([
  "range", "checkbox", "radio", "button", "submit", "reset",
  "color", "file", "image", "hidden",
]);

/**
 * Which transport command a key means, and "" for a key that is not one.
 *
 * These are the terminal player's keys (`musoak play`): l/→ next, h/←
 * previous, k/↑ volume up, j/↓ volume down, space pause/resume. A page is the
 * same kind of player, so a person who has used the one in the terminal
 * presses these in both. `m` mutes, which is the one a terminal player has no
 * need for.
 *
 * What decides whether a key is a command is who has the keyboard: a field
 * being typed into keeps every one of them, and so does a combination with a
 * modifier - ctrl+L is the browser's address bar, never a skip. Everything
 * else - a button, the seek, the page itself - belongs to the player, which is
 * the rule space already ran under.
 */
export function transportCommand(event) {
  if (!event || isTypingTarget(event.target)) return "";
  if (event.ctrlKey || event.metaKey || event.altKey) return "";
  switch (event.key) {
    case " ":
      return "toggle-play";
    case "ArrowRight":
    case "l":
    case "L":
      return "next-track";
    case "ArrowLeft":
    case "h":
    case "H":
      return "previous-track";
    case "ArrowUp":
    case "k":
    case "K":
      return "volume-up";
    case "ArrowDown":
    case "j":
    case "J":
      return "volume-down";
    case "m":
    case "M":
      return "toggle-mute";
    default:
      return "";
  }
}

/**
 * Whether something modal is on screen and has the keyboard: a dialog, or an
 * open menu. Transport behind one of those is a song changing under a question
 * nobody has answered yet, and Escape is what the keys are for there.
 */
export function transportBlocked(root = typeof document === "undefined" ? null : document) {
  return Boolean(root?.querySelector?.(".dialog-backdrop, .popover"));
}

/** The commands a held key may keep repeating. Volume is a knob, and holding
 *  it is how a knob is turned; a held skip would run through the queue. */
const REPEATING_COMMANDS = new Set(["volume-up", "volume-down"]);

if (inBrowser) {
  document.addEventListener("keydown", (event) => {
    const command = transportCommand(event);
    if (!command || event.defaultPrevented) return;
    if (event.repeat && !REPEATING_COMMANDS.has(command)) return;
    if (transportBlocked()) return;
    // Every one of these is the player's now: an arrow that skips must not
    // also scroll the page, and a space that pauses must not also page down.
    event.preventDefault();
    emit(command);
  });
  boot();
}
