// The API client, mirroring musoak-gui's client.py method for method.
//
// Every call goes to this origin: the Go server is a router, and the backend
// this client talks to is named in a header (and in `ps` on URLs handed to
// elements that cannot set headers). That is what lets one page hold sessions
// on several backends at once.

export class ServerError extends Error {
  constructor(status, message) {
    super(message || `server returned ${status}`);
    this.name = "ServerError";
    this.status = status;
    this.message = message || "";
  }

  get unauthorized() {
    return this.status === 401;
  }

  get notFound() {
    return this.status === 404;
  }
}

const REQUEST_TIMEOUT = 30000;

function routed(server, path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}ms=${encodeURIComponent(server)}`;
}

/** The `providers` query parameter for a list of platforms, or nothing at all
 *  when no list was given: absent means "every enabled platform", and a filter
 *  that has narrowed itself down to nothing has to say so with a real value. */
function platformParam(providers) {
  if (!Array.isArray(providers)) return "";
  return `&providers=${encodeURIComponent(providers.join(","))}`;
}

/** A member id for a guest, which is how a browser is known to a room.
 *
 *  `crypto.randomUUID` only exists in a secure context, and this app is reached
 *  over plain http at a LAN address, where there is none - calling it there
 *  threw during boot and left the shell without its views. `getRandomValues`
 *  carries no such restriction, so the same shape is built from it. */
export function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class Client {
  /** One backend, one session. */
  constructor({ server, token = "", memberId = "", memberName = "" } = {}) {
    this.server = (server || "").replace(/\/+$/, "");
    this.token = token;
    this.memberId = memberId;
    this.memberName = memberName;
  }

  // --- plumbing ----------------------------------------------------------

  async request(method, path, body) {
    const headers = { Accept: "application/json", "X-Musoak-Server": this.server };
    if (body !== undefined && body !== null) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.memberId) headers["X-Member-Id"] = this.memberId;
    if (this.memberName) headers["X-Member-Name"] = this.memberName;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    let response;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      this.reportReachable(false);
      throw new ServerError(0, `cannot reach ${this.server || "the server"}: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
    this.reportReachable(true);

    const payload = await response.text();
    if (!response.ok) {
      let message = payload.trim();
      try {
        message = String(JSON.parse(payload).error || message);
      } catch {
        /* not JSON: the text is the message */
      }
      throw new ServerError(response.status, message);
    }
    if (!payload) return null;
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }

  get(path) {
    return this.request("GET", path);
  }

  /**
   * Say whether the backend answered, on the window.
   *
   * The client keeps no opinion about the interface, and no dependency on it:
   * whoever is listening can draw a status light. Nothing happens outside a
   * browser, which is where the tests run.
   */
  reportReachable(ok) {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    try {
      window.dispatchEvent(new CustomEvent("musoak:reachable", { detail: { server: this.server, ok } }));
    } catch {
      /* a shim with a window but no events: nothing to tell */
    }
  }
  post(path, body = {}) {
    return this.request("POST", path, body);
  }
  patch(path, body) {
    return this.request("PATCH", path, body);
  }
  put(path, body) {
    return this.request("PUT", path, body);
  }
  del(path) {
    return this.request("DELETE", path);
  }

  // --- server ------------------------------------------------------------

  async health() {
    try {
      await this.get("/healthz");
      return true;
    } catch {
      return false;
    }
  }

  me() {
    return this.get("/api/v1/me").then((value) => value || {});
  }

  login(username, password) {
    return this.post("/api/v1/auth/login", { username, password }).then((payload) => {
      this.token = String(payload?.token || "");
      return this.token;
    });
  }

  register(username, password) {
    return this.post("/api/v1/auth/register", { username, password }).then((payload) => {
      this.token = String(payload?.token || "");
      return this.token;
    });
  }

  logout() {
    return this.post("/api/v1/auth/logout").catch(() => null);
  }

  providers() {
    return this.get("/api/v1/providers").then((payload) => payload?.providers || []);
  }

  /**
   * Search tracks across the platforms.
   *
   * `providers` narrows the search to those platforms; omitting it searches
   * every enabled one, which is what the server does when nothing is asked.
   */
  search(query, limit = 25, providers = null) {
    return this.get(`/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}${platformParam(providers)}`).then((payload) => ({
      groups: payload?.groups || [],
      providerErrors: payload?.providerErrors || [],
    }));
  }

  searchAlbums(query, limit = 25, providers = null) {
    return this.get(`/api/v1/albums/search?q=${encodeURIComponent(query)}&limit=${limit}${platformParam(providers)}`).then((payload) => ({
      albums: payload?.albums || [],
      providerErrors: payload?.providerErrors || [],
    }));
  }

  searchArtists(query, limit = 25, providers = null) {
    return this.get(`/api/v1/artists/search?q=${encodeURIComponent(query)}&limit=${limit}${platformParam(providers)}`).then((payload) => ({
      artists: payload?.artists || [],
      providerErrors: payload?.providerErrors || [],
    }));
  }

  /**
   * Make one provider's track a source of a song that has none.
   *
   * The pick is deliberate - somebody chose it from a search - so it is
   * attached to that song as it is rather than matched against the library.
   */
  associateSource(trackId, candidate) {
    const body = {
      provider: candidate.provider,
      providerTrackId: candidate.providerTrackId,
      title: candidate.title || "",
      artists: candidate.artists || [],
      album: candidate.album || "",
      durationMs: candidate.durationMs || 0,
      artworkUrl: candidate.artworkUrl || "",
    };
    return this.post(`/api/v1/tracks/${encodeURIComponent(trackId)}/sources`, body).then((value) => value || {});
  }

  /** The platforms this account wants a search to ask by default. */
  setSearchPlatforms(platforms) {
    return this.patch("/api/v1/me", { searchPlatforms: Array.from(platforms || []) }).then((value) => value || {});
  }

  /** The songs one account uploaded. Uploads are visible to everybody. */
  userUploads(userId) {
    return this.get(`/api/v1/users/${encodeURIComponent(userId)}/uploads`).then((payload) => ({
      uploads: payload?.uploads || [],
    }));
  }

  album(id) {
    return this.get(`/api/v1/albums/${id}`).then((value) => value || {});
  }

  artist(id) {
    return this.get(`/api/v1/artists/${id}`).then((value) => value || {});
  }

  syncAlbum(id, providers = [], resolve = false) {
    const body = {};
    if (providers.length) body.providers = providers;
    if (resolve) body.resolve = true;
    return this.post(`/api/v1/albums/${id}/sync`, body);
  }

  syncArtist(id, { providers = [], syncAlbums = false, resolve = false } = {}) {
    const body = {};
    if (providers.length) body.providers = providers;
    if (syncAlbums) body.syncAlbums = true;
    if (resolve) body.resolve = true;
    return this.post(`/api/v1/artists/${id}/sync`, body);
  }

  track(id) {
    return this.get(`/api/v1/tracks/${id}`).then((value) => value || {});
  }

  variants(trackId) {
    return this.get(`/api/v1/tracks/${trackId}/variants`).then((payload) => payload?.variants || []);
  }

  resolve(trackId) {
    return this.post(`/api/v1/tracks/${trackId}/resolve`).then((payload) => payload?.variants || []);
  }

  importPath(path) {
    return this.post("/api/v1/library/import", { path }).then((value) => value || {});
  }

  radio(seedTrackId, { providers = [], length = 25, save = false } = {}) {
    // `save` travels either way: the server saves a station unless it is told
    // not to, so leaving the flag out is not the same as asking for false.
    const body = { seedTrackId, length, save: Boolean(save) };
    if (providers.length) body.providers = providers;
    return this.post("/api/v1/radio", body).then((value) => value || {});
  }

  // --- favourites and ranking --------------------------------------------

  favorites() {
    return this.get("/api/v1/me/favorites").then((payload) => payload?.tracks || []);
  }

  addFavorite(trackId) {
    return this.post("/api/v1/me/favorites", { trackId });
  }

  removeFavorite(trackId) {
    return this.del(`/api/v1/me/favorites/${trackId}`);
  }

  ranking() {
    return this.get("/api/v1/me/providers/ranking").then((value) => value || {});
  }

  setRanking(providers) {
    return this.put("/api/v1/me/providers/ranking", { ranking: providers }).then((value) => value || {});
  }

  /** The order that decides which rendition is played. */
  async providerOrder() {
    try {
      const payload = await this.ranking();
      const effective = payload.effective || payload.order || payload.default || [];
      if (Array.isArray(effective) && effective.length) return effective;
      return payload.ranking || [];
    } catch {
      return [];
    }
  }

  /** Which variant this client would play, given the account's order. */
  async pickVariant(variants, preferredVariantId = "") {
    if (!variants?.length) return null;
    if (preferredVariantId) {
      const preferred = variants.find((variant) => variant.id === preferredVariantId);
      if (preferred) return preferred;
    }
    const order = await this.providerOrder();
    if (!order.length) return variants[0];
    const rank = new Map(order.map((name, index) => [name, index]));
    // A variant's place is its slot when it has one - the account's own upload
    // and the household's favourite are positions in that same order - and its
    // provider's name otherwise.
    const place = (variant) => rank.get(variant.slot || variant.provider) ?? order.length;
    return [...variants].sort((left, right) => place(left) - place(right))[0];
  }

  // --- playlists ---------------------------------------------------------

  playlists() {
    return this.get("/api/v1/me/playlists").then((payload) => payload?.playlists || []);
  }

  playlist(id) {
    // The shared route: it answers for your own playlists and for anybody's
    // that its owner made public.
    return this.get(`/api/v1/playlists/${id}`).then((payload) => ({
      playlist: payload || {},
      tracks: (payload?.items || []).map((item) => item.track || {}),
    }));
  }

  /** Make one of your playlists public or private. */
  setPlaylistPublic(id, isPublic) {
    return this.patch(`/api/v1/me/playlists/${id}`, { public: isPublic }).then((value) => value || {});
  }

  createPlaylist(name) {
    return this.post("/api/v1/me/playlists", { name }).then((value) => value || {});
  }

  /**
   * Bring a provider's playlist over as one of this account's own. `id` and
   * `url` are alternatives: a link is what somebody has when they want to copy
   * a playlist from a platform, and for Spotify it is the only way in without
   * credentials.
   *
   * One track is a provider search, so this answers with a job: watch it with
   * `importStatus` for how far it has got.
   */
  importPlaylist({ provider, id = "", url = "", name = "" } = {}) {
    return this.post("/api/v1/me/playlists/import", { provider, id, url, name }).then((value) => value || {});
  }

  /** How far an import has got: `{state, done, total, playable, playlist}`. */
  importStatus(jobId) {
    return this.get(`/api/v1/me/playlist-imports/${encodeURIComponent(jobId)}`).then((value) => value || {});
  }

  /**
   * Ask the server to write a playlist out as one zip.
   *
   * It answers with an archive: `archiveFileUrl` is the file a download link
   * takes, and `archiveStatus` says how many songs have been written into it so
   * far. The songs are counted before the answer, so the total is known up
   * front.
   */
  startPlaylistArchive(playlistId) {
    return this.post(`/api/v1/me/playlists/${encodeURIComponent(playlistId)}/archives`).then((value) => value || {});
  }

  /** How much of a playlist zip has been written: `{state, done, total}`. */
  archiveStatus(archiveId) {
    return this.get(`/api/v1/me/playlist-archives/${encodeURIComponent(archiveId)}`).then((value) => value || {});
  }

  /** A URL a download link can use for an archive: same origin, routed. */
  archiveFileUrl(archiveId) {
    return routed(this.server, `/api/v1/me/playlist-archives/${encodeURIComponent(archiveId)}/file`);
  }

  renamePlaylist(id, name) {
    return this.patch(`/api/v1/me/playlists/${id}`, { name }).then((value) => value || {});
  }

  deletePlaylist(id) {
    return this.del(`/api/v1/me/playlists/${id}`);
  }

  uploadPlaylistArtwork(id, base64, contentType) {
    return this.put(`/api/v1/me/playlists/${id}/artwork`, { data: base64, contentType }).then((value) => value || {});
  }

  addToPlaylist(id, trackIds) {
    return this.post(`/api/v1/me/playlists/${id}/items`, { trackIds }).then((payload) => ({
      playlist: payload || {},
      tracks: (payload?.items || []).map((item) => item.track || {}),
    }));
  }

  removeFromPlaylist(id, position) {
    return this.del(`/api/v1/me/playlists/${id}/items/${position}`).then((payload) => ({
      playlist: payload || {},
      tracks: (payload?.items || []).map((item) => item.track || {}),
    }));
  }

  /** What was playing last on this account, as the document itself. */
  playbackState() {
    return this.get("/api/v1/me/playback").then((payload) => payload?.state || payload || {});
  }

  savePlaybackState(doc) {
    return this.put("/api/v1/me/playback", { state: doc });
  }

  // --- uploads -----------------------------------------------------------

  createUpload({
    filename,
    contentType,
    data,
    title,
    artists = [],
    album = "",
    durationMs = 0,
    artwork = "",
    artworkContentType = "",
    associateTrackId = "",
  }) {
    return this.post("/api/v1/uploads", {
      filename,
      contentType,
      data,
      title,
      artists,
      album,
      durationMs,
      artworkData: artwork,
      artworkContentType,
      associateTrackId,
    }).then((payload) => payload?.upload || {});
  }

  uploads() {
    return this.get("/api/v1/uploads").then((payload) => payload?.uploads || []);
  }

  allUploads() {
    return this.get("/api/v1/uploads/all").then((payload) => payload?.uploads || []);
  }

  /** The upload this user already has on a song, which a new one replaces. */
  uploadAssociation(trackId) {
    return this.get(`/api/v1/uploads/association?trackId=${encodeURIComponent(trackId)}`).then(
      (payload) => payload?.upload || null
    );
  }

  patchUpload(id, associateTrackId) {
    return this.patch(`/api/v1/uploads/${id}`, { associateTrackId }).then((payload) => payload?.upload || {});
  }

  deleteUpload(id) {
    return this.del(`/api/v1/uploads/${id}`);
  }

  // --- lyrics ------------------------------------------------------------

  /** A song's words as this rendition has them, or null when there are none. */
  lyrics(trackId, variantId = "") {
    const query = variantId ? `?variantId=${encodeURIComponent(variantId)}` : "";
    return this.get(`/api/v1/tracks/${trackId}/lyrics${query}`).then((payload) => payload?.lyrics || null);
  }

  // --- listening ---------------------------------------------------------

  /** Record a listen: what was played, and how much of it was heard. */
  recordPlay({ trackId, variantId = "", playedMs = 0, source = "web" }) {
    return this.post("/api/v1/me/plays", { trackId, variantId, playedMs, source });
  }

  history(limit = 50) {
    return this.get(`/api/v1/me/history?limit=${encodeURIComponent(limit)}`).then((payload) => payload?.plays || []);
  }

  topTracks(limit = 50) {
    return this.get(`/api/v1/me/stats/top?limit=${encodeURIComponent(limit)}`).then((payload) => payload?.tracks || []);
  }

  // --- library hygiene ---------------------------------------------------

  /** Uploads whose bytes are already stored, grouped by content hash. */
  duplicates() {
    return this.get("/api/v1/uploads/duplicates").then((payload) => payload?.groups || []);
  }

  /** Associate many uploads with one song at once. */
  associateUploads(uploadIds, associateTrackId) {
    return this.post("/api/v1/uploads/associate", { uploadIds, associateTrackId });
  }

  // --- sources -----------------------------------------------------------

  sources(trackId) {
    return this.get(`/api/v1/tracks/${trackId}/sources`).then((payload) => ({
      sources: payload?.sources || [],
      preferredVariantId: String(payload?.preferredVariantId || ""),
    }));
  }

  voteVariant(variantId, value) {
    return this.post(`/api/v1/variants/${variantId}/vote`, { value: Number(value) });
  }

  preferVariant(trackId, variantId) {
    return this.put(`/api/v1/me/tracks/${trackId}/preference`, { variantId });
  }

  // --- account -----------------------------------------------------------

  updateProfile(displayName) {
    return this.patch("/api/v1/me", { displayName }).then((payload) => payload?.user || {});
  }

  uploadIcon(base64, contentType) {
    return this.post("/api/v1/me/icon", { data: base64, contentType }).then((payload) => payload?.user || {});
  }

  changePassword(currentPassword, newPassword) {
    return this.post("/api/v1/me/password", { currentPassword, newPassword });
  }

  changeUsername(password, username) {
    return this.post("/api/v1/me/username", { password, username }).then((payload) => payload?.user || {});
  }

  // --- people ------------------------------------------------------------

  /**
   * People by name. An empty query asks for the whole server: a small one
   * answers with everybody and a large one with nothing, and `directory` says
   * which, so that "nobody here" can be told from "too many to list".
   */
  searchUsers(query) {
    return this.get(`/api/v1/users?q=${encodeURIComponent(query)}`).then((payload) => ({
      users: payload?.users || [],
      directory: Boolean(payload?.directory),
    }));
  }

  user(id) {
    return this.get(`/api/v1/users/${id}`).then((value) => value || {});
  }

  userPlayback(id) {
    return this.get(`/api/v1/users/${id}/playback`).then((value) => value || {});
  }

  friends() {
    return this.get("/api/v1/me/friends").then((value) => value || {});
  }

  addFriend(username) {
    return this.post("/api/v1/me/friends", { username }).then((payload) => payload?.user || {});
  }

  acceptFriend(userId) {
    return this.post(`/api/v1/me/friends/${userId}/accept`);
  }

  removeFriend(userId) {
    return this.del(`/api/v1/me/friends/${userId}`);
  }

  ignoreUser(userId) {
    return this.post(`/api/v1/me/friends/${userId}/ignore`);
  }

  unignoreUser(userId) {
    return this.del(`/api/v1/me/friends/${userId}/ignore`);
  }

  shares() {
    return this.get("/api/v1/me/shares").then((payload) => payload?.shares || []);
  }

  share(userId, { trackId = "", roomId = "" } = {}) {
    const body = { userId };
    if (trackId) body.trackId = trackId;
    if (roomId) body.roomId = roomId;
    return this.post("/api/v1/me/shares", body).then((payload) => payload?.share || {});
  }

  notifications() {
    return this.get("/api/v1/me/notifications").then((payload) => payload || {});
  }

  markNotificationsRead() {
    return this.post("/api/v1/me/notifications/read");
  }

  // --- media -------------------------------------------------------------

  startDownload(variantId, wait = true) {
    return this.post(`/api/v1/media/${variantId}/download${wait ? "?wait=1" : ""}`).then((value) => value || {});
  }

  mediaStatus(variantId) {
    return this.get(`/api/v1/media/${variantId}/status`).then((value) => value || {});
  }

  /** A URL an audio element or an <img> can use: same origin, routed by query. */
  mediaUrl(variantId) {
    return routed(this.server, `/api/v1/media/${encodeURIComponent(variantId)}`);
  }

  /**
   * The URL for a cover. `version` is for pictures that change in place: a
   * user's icon is served from a stable path with a long cache, so a new
   * upload needs a different URL before any browser will fetch it again.
   */
  artworkUrl(path, version = "") {
    if (!path) return "";
    if (/^https?:/i.test(path)) return path;
    const url = routed(this.server, path);
    if (!version) return url;
    return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;
  }

  searchPlaylists(query, limit = 25, providers = null) {
    return this.get(`/api/v1/playlists/search?q=${encodeURIComponent(query)}&limit=${limit}${platformParam(providers)}`).then((payload) => ({
      playlists: payload?.playlists || [],
      providerErrors: payload?.providerErrors || [],
    }));
  }

  syncPlaylist(playlistId, provider = "") {
    const body = provider ? { provider } : {};
    return this.post(`/api/v1/playlists/${playlistId}/sync`, body).then((payload) => ({
      playlist: payload?.playlist || {},
      tracks: payload?.tracks || [],
    }));
  }

  // --- rooms -------------------------------------------------------------

  rooms() {
    return this.get("/api/v1/rooms").then((payload) => payload?.rooms || []);
  }

  room(id) {
    return this.get(`/api/v1/rooms/${id}`).then((payload) => payload?.room || payload || {});
  }

  createRoom(name, controls = "everyone", password = "") {
    return this.post("/api/v1/rooms", { name, controls, password }).then((value) => value || {});
  }

  joinRoom(roomId, password = "") {
    return this.post(`/api/v1/rooms/${roomId}/join`, { password }).then((value) => value || {});
  }

  leaveRoom(roomId) {
    return this.post(`/api/v1/rooms/${roomId}/leave`).then((payload) => payload?.room || payload || {});
  }

  /** Put tracks on the caller's own queue; the room's fair order recomputes.
   *  A list goes in one request: adding a playlist is one edit, not one per
   *  song, and the room hears about it once. */
  roomEnqueue(roomId, trackIds) {
    const body = Array.isArray(trackIds) ? { trackIds } : { trackId: trackIds };
    return this.post(`/api/v1/rooms/${roomId}/queue`, body).then(this.roomSnapshot);
  }

  /** Remove one entry (the caller's own, or any member's when the host asks). */
  roomRemove(roomId, itemId) {
    return this.del(`/api/v1/rooms/${roomId}/queue/${encodeURIComponent(itemId)}`).then(this.roomSnapshot);
  }

  roomReorder(roomId, itemIds) {
    return this.post(`/api/v1/rooms/${roomId}/queue/reorder`, { itemIds }).then(this.roomSnapshot);
  }

  roomClearQueue(roomId, memberId = "") {
    const query = memberId ? `?memberId=${encodeURIComponent(memberId)}` : "";
    return this.del(`/api/v1/rooms/${roomId}/queue${query}`).then(this.roomSnapshot);
  }

  roomPause(roomId) {
    return this.post(`/api/v1/rooms/${roomId}/pause`).then(this.roomSnapshot);
  }

  roomResume(roomId) {
    return this.post(`/api/v1/rooms/${roomId}/resume`).then(this.roomSnapshot);
  }

  roomSkip(roomId) {
    return this.post(`/api/v1/rooms/${roomId}/skip`).then(this.roomSnapshot);
  }

  /** The host's copy of a song has run out: the room moves on from their end.
   *  The track and the position are named so an end that lands late, or one
   *  from a file that stopped short, cannot cut the song playing now. */
  roomEnded(roomId, trackId = "", positionMs = 0) {
    return this.post(`/api/v1/rooms/${roomId}/ended`, { trackId, positionMs }).then(this.roomSnapshot);
  }

  roomSeek(roomId, positionMs) {
    return this.post(`/api/v1/rooms/${roomId}/seek`, { positionMs }).then(this.roomSnapshot);
  }

  /** A score from 1 (bad) to 5 (great), changeable while the track plays. */
  roomVote(roomId, score) {
    return this.post(`/api/v1/rooms/${roomId}/vote`, { score }).then(this.roomSnapshot);
  }

  /** "I can play this" — durationMs is what this client will really play. */
  roomReady(roomId, trackId, variantId, durationMs = 0) {
    const body = { trackId, variantId };
    if (durationMs) body.durationMs = durationMs;
    return this.post(`/api/v1/rooms/${roomId}/ready`, body).then(this.roomSnapshot);
  }

  /** Sit the room's current track out, or come back into it. */
  roomOut(roomId, out) {
    return this.post(`/api/v1/rooms/${roomId}/out`, { out }).then(this.roomSnapshot);
  }

  /** The room's own state, whether the endpoint wrapped it or not. */
  roomSnapshot(payload) {
    return payload?.room || payload || {};
  }

  /**
   * The room channel. Browsers cannot put headers on a WebSocket, so the
   * backend is named in the query and the session cookie carries the token.
   * Returns {send, close, ready}.
   */
  roomSocket({ roomId, onEvent, onOpen, onClose } = {}) {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const query = new URLSearchParams({ ps: this.server });
    if (roomId) query.set("roomId", roomId);
    if (this.memberId) query.set("memberId", this.memberId);
    if (this.memberName) query.set("memberName", this.memberName);
    const socket = new WebSocket(`${scheme}//${location.host}/api/v1/ws?${query}`);
    let heartbeat = 0;
    const api = {
      socket,
      ready: false,
      send(type, payload = {}) {
        if (socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify({ type, ...payload }));
        return true;
      },
      close() {
        clearInterval(heartbeat);
        socket.close();
      },
    };
    socket.addEventListener("open", () => {
      api.ready = true;
      heartbeat = setInterval(() => api.send("ping"), 25000);
      onOpen?.(api);
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      onEvent?.(message, api);
    });
    socket.addEventListener("close", () => {
      clearInterval(heartbeat);
      api.ready = false;
      onClose?.(api);
    });
    socket.addEventListener("error", () => {
      onClose?.(api);
    });
    return api;
  }
}

/** A client for a backend, from a remembered session. */
export function clientFor(server, session = {}) {
  return new Client({
    server: server.url || server,
    token: session.token || "",
    memberId: session.memberId || "",
    memberName: session.memberName || "",
  });
}
