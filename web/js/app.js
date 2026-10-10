// The application shell: one backend at a time, one view at a time, and the
// pieces that belong to every view (server picker, login, bell, player).
//
// Views never touch this file's internals: they register themselves and build
// into the container they are handed.

import {
  h, clear, mount, render, dialog, popover, confirm, prompt, toast, fmtAgo, icon, iconOr, iconButton,
} from "./dom.js";
import {
  state, on, emit, loadLocal, saveLocal, sessionFor, session, updateSession,
  isSignedIn, setServer, rememberServer, knownServers, serverLabel, serverId, forgetServer, forgetRoom, renameServer as setServerName, iconVersion, userIdOf,
} from "./state.js";
import { Client, randomId } from "./client.js";
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

export function navigate(id, params = {}) {
  const view = views.get(id);
  if (!view) {
    banner(`no such view: ${id}`, "error");
    return;
  }
  state.view = id;
  state.viewParams = params;
  saveLocal();
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
  try {
    const response = await fetch("/ui/config");
    state.config = await response.json();
  } catch {
    state.config = { defaultServer: "", loginPopup: false, servers: [], allowCustomServer: true };
  }

  for (const entry of state.config.servers || []) rememberServer(entry);
  const wanted = state.server || state.config.defaultServer || "";
  if (wanted) setServer(wanted);

  await loadViews();
  buildLayout();
  booted = true;
  buildClient();

  // A reload should land where the user left off, or on the first view.
  if (!state.view || !views.has(state.view)) {
    const first = [...views.values()].filter((view) => !view.hidden).sort((a, b) => (a.order ?? 50) - (b.order ?? 50))[0];
    if (first) state.view = first.id;
  }
  renderContent();
  renderNav();

  if (wanted) {
    await refreshMe();
    startNotifications();
    await restorePlayback();
    await restoreRoom();
    maybeLoginPopup();
  }

  // The server's state, from the client's own calls and a slow poll between
  // them: a light that only changes when something asked is a light that lies.
  window.addEventListener("musoak:reachable", (event) => {
    const ok = Boolean(event?.detail?.ok);
    if (ok === Boolean(state.online)) return;
    state.online = ok;
    renderCorner();
    emit("online-changed", ok);
  });
  window.addEventListener("online", () => markReachable(true));
  window.addEventListener("offline", () => markReachable(false));
  window.addEventListener("focus", () => checkServer());
  startReachability();
  checkServer();
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
  if (!(await askToRejoin(saved))) {
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

/** Resolves true when the listener says yes, and false when they say no or
 *  dismiss the box. */
function askToRejoin(room) {
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
      title: "Rejoin your room?",
      body: `You were listening in “${room.name || "a room"}”. Join it again?`,
      actions: [
        { label: "Not now", onClick: () => done(false) },
        { label: "Join", class: "suggested", onClick: () => done(true) },
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
    if (await askToJoinRoom(from, names.get(String(note.roomId)))) {
      navigate("rooms", { roomId: note.roomId });
    }
  }
}

/** Resolves true when they take the invitation, and false when they dismiss it
 *  or press Escape. */
function askToJoinRoom(from, room) {
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
      title: "Room invite",
      body: room
        ? `${from} invited you to room \u201c${room}\u201d.`
        : `${from} invited you to a room.`,
      actions: [
        { label: "Dismiss", onClick: () => done(false) },
        { label: "Join", class: "suggested", onClick: () => done(true) },
      ],
    });
  });
}

async function loadViews() {
  const results = await Promise.allSettled(VIEW_MODULES.map((path) => import(path)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const reason = result.reason;
      console.warn(`view ${VIEW_MODULES[index]} failed to load: ${reason?.message || reason}`);
    }
  });
}

function buildLayout() {
  layout = {
    sidebar: h("aside", { class: "sidebar" }),
    main: h("section", { class: "main" }),
    player: h("footer", { class: "player" }),
    content: h("div", { class: "content" }),
    bannerSlot: h("div", { class: "banner-slot" }),
    title: h("h1", { text: "MusOak" }),
    bell: iconButton("bell", { title: "Notifications", onclick: openNotifications }),
    brand: h("div", { class: "brand" }),
    nav: h("nav", { class: "nav" }),
    corner: h("div", { class: "corner" }),
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
  mount(layout.sidebar, layout.top, layout.navWrap);
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
  if (typeof window === "undefined") return;
  window.addEventListener("musoak:open-queue", () => toggleQueueDrawer());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && layout?.drawer && !layout.drawer.hidden) toggleQueueDrawer(false);
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
  // read as a space.
  mount(
    layout.brand,
    h("img", { src: "icon.png", alt: "", width: 26, height: 26 }),
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
    ? h("img", { class: "art round account-icon", src: iconUrl, alt: "" })
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
    state.online = serverAnswered(error);
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
  clear(layout.content);

  if (!state.server) {
    layout.content.appendChild(
      h("div", { class: "empty" },
        h("span", { class: "icon", text: "\u25c9" }),
        h("span", { class: "title", text: "No server yet" }),
        h("span", { text: "Choose a backend to browse. This page is only a frontend: your music lives on your own server." }),
        h("button", { class: "btn suggested", text: "Choose a server", onclick: (event) => openServerPicker(event.currentTarget) }))
    );
    return;
  }
  if (!view) {
    layout.content.appendChild(h("div", { class: "empty" }, h("span", { class: "title", text: "Nothing here yet" })));
    return;
  }

  // One container for the life of the app, cleared on every render: a view may
  // finish fetching after the next one has painted, and a container that is
  // replaced would leave that answer nowhere to land.
  const container = layout.viewContainer || (layout.viewContainer = h("div", { class: "page" }));
  if (!container.isConnected) layout.content.appendChild(container);
  clear(container);
  const rendered = (() => {
    try {
      return view.render?.(container, state.viewParams);
    } catch (error) {
      reportViewFailure(container, view, error);
      return null;
    }
  })();
  // A view that fetches before it draws can fail later than this call: that
  // failure has to reach the user too.
  Promise.resolve(rendered).catch((error) => {
    if (container === layout.viewContainer) reportViewFailure(container, view, error);
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
    state.favorites = new Set();
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
    state.favorites = new Set(tracks.map((track) => track.id));
    emit("favorites-changed", state.favorites);
  } catch {
    /* a guest has none */
  }
}

/** Toggle a favourite and say so everywhere. */
export async function toggleFavorite(trackId) {
  if (!requireLogin()) return;
  const had = state.favorites.has(trackId);
  if (had) state.favorites.delete(trackId);
  else state.favorites.add(trackId);
  emit("favorites-changed", state.favorites);
  try {
    if (had) await client.removeFavorite(trackId);
    else await client.addFavorite(trackId);
  } catch (error) {
    if (had) state.favorites.add(trackId);
    else state.favorites.delete(trackId);
    emit("favorites-changed", state.favorites);
    banner(`could not change that favourite: ${error.message}`, "error");
  }
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
    items.push({ label: "Add a server...", icon: "+", onClick: () => addServerDialog() });
  }
  if (known.length && state.server) {
    items.push({ separator: true });
    items.push({
      label: isSignedIn() ? "Sign out of this server" : "Sign in to this server",
      icon: "\u21a9",
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
  state.favorites = new Set();
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
      {
        label: "Skip",
        onClick: () => {
          updateSession({ loginSkipped: true });
          renderCorner();
        },
      },
      {
        label: "Create an account",
        onClick: (event) => {
          registering = !registering;
          event.currentTarget.textContent = registering ? "I have an account" : "Create an account";
          const submitButton = event.currentTarget.closest(".dialog")?.querySelector(".actions .suggested");
          if (submitButton) submitButton.textContent = registering ? "Create account" : "Sign in";
          status.textContent = registering ? "a new account on this server" : "";
          return false;
        },
      },
      { label: "Sign in", class: "suggested", onClick: submit },
    ],
    onOpen: () => username.focus(),
  });
  return { close };
}

function signOut() {
  client?.logout().catch(() => null);
  updateSession({ token: "" });
  state.user = null;
  state.favorites = new Set();
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

if (inBrowser) {
  document.addEventListener("keydown", (event) => {
    if (isTypingTarget(event.target)) return;
    if (event.key === " ") {
      event.preventDefault();
      emit("toggle-play");
    }
  });
  boot();
}
