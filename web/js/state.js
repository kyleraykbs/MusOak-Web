// What the app knows about itself, kept across reloads.
//
// One rule: nothing a backend owns lives here. Sessions are per backend, and
// switching backend swaps the session rather than clearing it, so a user can
// hold several at once.

const KEY = "musoak-web";
const listeners = new Map();

export const state = {
  /** GET /ui/config: what this deployment offers. */
  config: { defaultServer: "", loginPopup: false, servers: [], allowCustomServer: true },
  /** Backends this browser knows: the configured ones plus what users added. */
  servers: [],
  /** Backends the user removed from the picker; they stay gone across reloads. */
  hiddenServers: [],
  /** What the user calls each backend, by URL: a deployment's own list is not ours to edit. */
  serverNames: {},
  /** Bumped when someone's icon changes. Icons are served from a stable path
   *  with a long cache, so a new picture needs a new URL to be seen. */
  iconVersions: {},
  /** Which kind of thing the search is looking for: tracks, albums, artists or
   *  provider playlists. */
  searchKind: "tracks",
  /** The backend in use. */
  server: "",
  /** Whether the backend answered the last time anything asked it. */
  online: true,
  /** Per backend: {token, memberId, memberName, volume, muted, loginSkipped}. */
  sessions: {},
  /** The signed-in account, or null for a guest. */
  user: null,
  favorites: new Set(),
  unread: 0,
  /** Who we are listening along to, if anyone. */
  following: null,
  /** The room we are in, so a reload can put us back in it: {roomId, name,
   *  password}. The password is kept because rejoining a closed room without it
   *  would fail; it is no more exposed than the session token beside it. */
  room: null,
  /** Which the Rooms tab was left on: "list" for the rooms list, "room" for the
   *  room being followed, null to decide when it is first opened. */
  roomsShowing: null,
  view: "",
  viewParams: {},
};

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, detail = null) {
  for (const handler of listeners.get(event) || []) {
    try {
      handler(detail);
    } catch (error) {
      console.error(`event ${event} failed`, error);
    }
  }
}

/** A stable short name for a backend, for cache keys and the picker. */
export function serverId(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`.replace(/[^a-zA-Z0-9._:-]/g, "_");
  } catch {
    return String(url || "");
  }
}

export function sessionFor(url = state.server) {
  return state.sessions[serverId(url)] || { token: "", memberId: "", memberName: "", volume: 1, muted: false };
}

export function session() {
  return sessionFor(state.server);
}

export function updateSession(patch) {
  const id = serverId(state.server);
  state.sessions[id] = { ...sessionFor(), ...patch };
  saveLocal();
  emit("session-changed", state.sessions[id]);
  return state.sessions[id];
}

export function isSignedIn() {
  return Boolean(session().token);
}

export function serverLabel(url = state.server) {
  const named = state.serverNames?.[url];
  if (named) return named;
  const found = state.servers.find((entry) => entry.url === url);
  if (found?.name) return found.name;
  try {
    return new URL(url).host;
  } catch {
    return url || "no server";
  }
}

/** Give a backend a name of the caller's own; an empty name gives it back. */
export function renameServer(url, name) {
  if (!url) return;
  const wanted = String(name ?? "").trim();
  state.serverNames = state.serverNames || {};
  if (wanted) state.serverNames[url] = wanted;
  else delete state.serverNames[url];
  saveLocal();
  emit("servers-changed", url);
}

/** The id of a user, however the payload nests it: /me carries the account at
 *  the top level and the person it belongs to under `user`. */
export function userIdOf(user) {
  return String(user?.user?.id || user?.id || "");
}

/** Say that someone's icon has changed, so the next render asks for it afresh:
 *  the server serves icons from a stable path with a long cache. */
export function bumpIcon(userId) {
  const id = String(userId || "");
  if (!id) return;
  state.iconVersions = state.iconVersions || {};
  state.iconVersions[id] = (Number(state.iconVersions[id]) || 0) + 1;
  saveLocal();
}

/** The version to ask for, or "" for a picture that has not changed here. */
export function iconVersion(userId) {
  return (state.iconVersions || {})[String(userId || "")] || "";
}

export function rememberServer({ url, name = "" }) {
  if (!url) return;
  // Adding a server back is how you undo removing it.
  state.hiddenServers = (state.hiddenServers || []).filter((entry) => entry !== url);
  if (!state.servers.some((entry) => entry.url === url)) {
    state.servers.push({ url, name: name || serverLabel(url) });
  } else if (name) {
    state.servers = state.servers.map((entry) => (entry.url === url ? { ...entry, name } : entry));
  }
  saveLocal();
}

export function setServer(url) {
  if (!url) return;
  state.server = url;
  rememberServer({ url });
  saveLocal();
  emit("server-changed", url);
}

export function loadLocal() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    stored = null;
  }
  if (stored && typeof stored === "object") {
    state.servers = Array.isArray(stored.servers) ? stored.servers : [];
    state.hiddenServers = Array.isArray(stored.hiddenServers) ? stored.hiddenServers : [];
    state.serverNames = stored.serverNames && typeof stored.serverNames === "object" ? stored.serverNames : {};
    state.iconVersions = stored.iconVersions && typeof stored.iconVersions === "object" ? stored.iconVersions : {};
    state.searchKind = typeof stored.searchKind === "string" && stored.searchKind ? stored.searchKind : "tracks";
    state.sessions = stored.sessions && typeof stored.sessions === "object" ? stored.sessions : {};
    state.server = typeof stored.server === "string" ? stored.server : "";
    state.view = typeof stored.view === "string" ? stored.view : "";
    state.room =
      stored.room && typeof stored.room === "object" && typeof stored.room.roomId === "string" && stored.room.roomId
        ? {
            roomId: stored.room.roomId,
            name: typeof stored.room.name === "string" ? stored.room.name : "",
            password: typeof stored.room.password === "string" ? stored.room.password : "",
          }
        : null;
  }
}

/** Remember the room we are in, so a reload can put us back in it. */
export function rememberRoom(room) {
  const roomId = room && typeof room.roomId === "string" ? room.roomId : "";
  state.room = roomId
    ? { roomId, name: typeof room.name === "string" ? room.name : "", password: typeof room.password === "string" ? room.password : "" }
    : null;
  saveLocal();
}

/** Forget it, once we have left or it will not have us. */
export function forgetRoom() {
  if (!state.room) return;
  state.room = null;
  saveLocal();
}

export function saveLocal() {
  const payload = {
    server: state.server,
    servers: state.servers,
    hiddenServers: state.hiddenServers || [],
    serverNames: state.serverNames || {},
    iconVersions: state.iconVersions || {},
    searchKind: state.searchKind || "tracks",
    sessions: state.sessions,
    view: state.view,
    room: state.room,
    roomsShowing: state.roomsShowing,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    /* private mode: the session simply does not outlive the tab */
  }
}

/** Remove a backend from this browser: its list entry, its sign-in, and — so it
 *  stays removed even when the deployment lists it — a note to keep hiding it. */
export function forgetServer(url) {
  if (!url) return;
  state.hiddenServers = [...new Set([...(state.hiddenServers || []), url])];
  delete state.sessions[serverId(url)];
  state.servers = state.servers.filter((entry) => entry.url !== url);
  if (state.server === url) state.server = "";
  saveLocal();
}

/** Undo a removal, so the deployment's own server list is offered again. */
export function unhideServer(url) {
  state.hiddenServers = (state.hiddenServers || []).filter((entry) => entry !== url);
  saveLocal();
}

/** The ordered backend list the picker shows: configured first, then added. */
export function knownServers() {
  const seen = new Set();
  const list = [];
  const hidden = new Set(state.hiddenServers || []);
  const configured = Array.isArray(state.config?.servers) ? state.config.servers : [];
  const remembered = Array.isArray(state.servers) ? state.servers : [];
  for (const entry of [...configured, ...remembered]) {
    const url = (entry?.url || "").replace(/\/+$/, "");
    if (!url || seen.has(url) || hidden.has(url)) continue;
    seen.add(url);
    // A name the user chose outranks the one the deployment lists it under.
    list.push({ url, name: state.serverNames?.[url] || entry.name || serverLabel(url) });
  }
  return list;
}
