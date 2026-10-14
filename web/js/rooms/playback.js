// The room's clock, and the decisions a member's player takes from it.
//
// The server owns the room: it anchors the current song at a position and a
// server time, and republishes that anchor as a heartbeat about once a second.
// Between beats the member's own player is the only clock there is, and that is
// the whole design: the client runs free, and a beat is a *check*, not a
// schedule. Everything here is pure, so what the player will do about a beat is
// decided by arithmetic that can be tested without a player, a socket or a room.
//
// Three rules make the smoothness:
//
//   * a beat is followed with a tolerance (TOLERANCE_MS): a member whose
//     position is within it is left alone to keep playing. Correcting a hand's
//     width of drift is a seek nobody can hear and everybody can: it stops the
//     file for a moment, which is exactly the stutter being fixed here;
//   * a correction is rate-limited (COOLDOWN_MS) and never happens in the first
//     moments of a run (GRACE_MS), so one bad beat cannot become a seek storm;
//   * the transition is the client's (see `decide` → "advance"): when this
//     member's file is finished, they move to the next song of the room's order
//     at once instead of waiting for a beat that may be a second away. The
//     beat that follows agrees - the order is the same one the server walks -
//     and, while the server still lags, the item is remembered in
//     `advancedPast` so the beat cannot drag the member back onto the song they
//     have already finished.

/** How far a member's playhead may run from the room's position before it is
 *  corrected. A beat inside this is left alone. */
export const TOLERANCE_MS = 2000;

/** The least time between two corrections: the first one has to be given the
 *  chance to land before the next beat calls for another. */
export const COOLDOWN_MS = 5000;

/** Where the room is at a given server time.
 *
 *  The anchor is the server's: `positionMs` is the position at `atMs`, and a
 *  running song has moved on by however much server time has passed since. A
 *  paused or unstarted song is exactly where it was anchored. */
export function roomPosition(current, serverNowMs) {
  if (!current || !current.started) return 0;
  const anchor = Number(current.positionMs) || 0;
  if (current.paused) return anchor;
  const elapsed = Number(serverNowMs) - Number(current.atMs);
  return Math.max(0, anchor + (elapsed > 0 ? elapsed : 0));
}

/** How long the room's current song runs, as the room knows it. Zero means the
 *  server never learned a length, and nothing may be measured against it. */
export function roomLength(current) {
  return current ? Math.max(0, Number(current.durationMs) || 0) : 0;
}

/** When the room's current song finishes, on the server's clock. Null while
 *  there is nothing to finish. */
export function finishesAt(current) {
  if (!current || !current.item || !current.started) return null;
  const length = roomLength(current);
  if (!length) return null;
  if (current.paused) return null;
  const anchor = Number(current.positionMs) || 0;
  return Number(current.atMs) + Math.max(0, length - anchor);
}

/** What to do about a member's position: `"hold"` while it is inside the
 *  tolerance or while a correction just landed, `"back"` or `"forward"` for the
 *  seek that closes a real gap. */
export function driftAction(localMs, roomMs, options = {}) {
  const tolerance = Number.isFinite(options.toleranceMs) ? options.toleranceMs : TOLERANCE_MS;
  const cooldown = Number.isFinite(options.cooldownMs) ? options.cooldownMs : COOLDOWN_MS;
  const sinceCorrect = Number.isFinite(options.sinceCorrectMs) ? options.sinceCorrectMs : Infinity;
  if (sinceCorrect < cooldown) return "hold";
  const drift = (Number(localMs) || 0) - (Number(roomMs) || 0);
  if (drift > tolerance) return "back";
  if (drift < -tolerance) return "forward";
  return "hold";
}

/** The song the room plays after `playedItemId`: the room's own order without
 *  the song that is on, which is the rule the server advances by. Null when the
 *  room has nothing else to play. */
export function nextItem(state, playedItemId) {
  const order = Array.isArray(state && state.masterQueue) ? state.masterQueue : [];
  const played = String(playedItemId || "");
  const next = order.find((entry) => entry && entry.id && String(entry.id) !== played);
  return next || null;
}

/**
 * What this member's player should do, given the room and what the player is
 * doing. Pure: the caller gathers the readings and runs the answer.
 *
 * Returns `{ action, ... }`, one of:
 *
 *   `idle`    — the room has nothing on; let go of whatever the page holds
 *   `wait`    — the room's song is assigned but not started; hold this member
 *               at the room's position without playing
 *   `load`    — put this member on `itemId`, at `positionMs`, autoplaying when
 *               `autoplay` (the caller passes the room's own state: a song the
 *               room has not started is loaded and held, not played)
 *   `wait`    — the room's song is assigned but not started; hold this member
 *               at the room's position without playing
 *   `advance` — this member has finished `itemId` and the room has not said so
 *               yet: move to `nextItemId` at once, from the start
 *   `pause` / `resume` — the room's pause is this member's pause. `input.playing`
 *               is whether *this member's* player is playing, not whether the
 *               room is: the two are different questions and mixing them is
 *               what stopped a room pause from reaching the local player.
 *   `seek`    — a real gap: put this member at `positionMs`
 *   `hold`    — nothing to do; keep playing
 */
export function decide(input) {
  const current = input.current || null;
  const item = current && current.item ? current.item : null;
  const itemId = item ? String(item.id) : "";
  const playing = Boolean(input.playing);
  const loaded = Boolean(input.loaded);
  const advancedPast = input.advancedPast instanceof Set ? input.advancedPast : new Set();

  if (!item || !itemId) return { action: "idle" };

  // A song this member already moved past: the server's own advance is on its
  // way (the tick lags by up to a second), and following the stale anchor would
  // pull them back onto a song they have finished. Leave it alone.
  if (advancedPast.has(itemId)) return { action: "hold" };

  // The file for this item is on its way: nothing to decide until it lands.
  if (loaded && input.loading) return { action: "hold", status: "Loading the track…" };

  // Not this member's item yet, or not loaded: put them on it, at wherever the
  // room is. A song the room has not started is loaded and held, not played.
  if (String(input.itemId || "") !== itemId || !loaded) {
    return {
      action: "load",
      itemId,
      positionMs: roomPosition(current, input.serverNowMs),
      autoplay: Boolean(input.autoplay),
    };
  }

  if (!current.started) {
    return { action: "wait", positionMs: roomPosition(current, input.serverNowMs) };
  }

  if (current.paused) {
    if (playing) return { action: "pause" };
    return { action: "hold" };
  }

  // The transition, and it is this client's: the room's clock says the song is
  // over, or the file on this device has run out. Either way the next song of
  // the room's order starts here, now, rather than after the next beat.
  const roomMs = roomPosition(current, input.serverNowMs);
  const length = roomLength(current);
  const startedAt = Number(input.loadedAtMs);
  const aged = Number.isFinite(startedAt) ? Number(input.nowMs) - startedAt : 0;
  const roomOver = length > 0 && roomMs >= length;
  const fileOver = input.ended || (Number(input.measuredMs) > 0 && aged > Number(input.measuredMs));
  if (roomOver || fileOver) {
    const next = nextItem(input.state, itemId);
    if (!next) return { action: "pause" };
    return { action: "advance", itemId: String(next.id), fromItemId: itemId, autoplay: true };
  }

  if (!playing) {
    return { action: "resume", blocked: Boolean(input.blocked) };
  }

  const drift = driftAction(input.localPositionMs, roomMs, {
    sinceStartMs: input.sinceStartMs,
    sinceCorrectMs: input.sinceCorrectMs,
  });
  if (drift === "hold") return { action: "hold" };
  return { action: "seek", positionMs: roomMs, direction: drift };
}