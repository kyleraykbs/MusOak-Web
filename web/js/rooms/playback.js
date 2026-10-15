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

/** How close to the room's own end a member's file may run out and still count
 *  as the song being over. Anything earlier is a copy shorter than the length
 *  the room was told; see the transition in decide. */
export const FILE_END_SLACK_MS = 2500;

/** The first moments of a run, in which the position is not corrected at all.
 *  A file that has just been handed to the player is still settling - it is
 *  decoding, and its playhead is not yet where it was asked to start - so what
 *  the first beats measure is the load, not a drift. Seeking it back is the
 *  "Syncing to the room" heard a moment after a song begins, which is the
 *  stutter this whole file exists to keep out. */
export const GRACE_MS = 2000;

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
 *  tolerance, while the run is still settling, or while a correction just
 *  landed; `"back"` or `"forward"` for the seek that closes a real gap.
 *
 *  `sinceStartMs` is how long this member's file has been running, and a run
 *  younger than GRACE_MS is left alone whatever it measures - see the constant.
 *  A caller that does not know (or does not say) gives Infinity, which is a run
 *  too old for the grace to apply. */
export function driftAction(localMs, roomMs, options = {}) {
  const tolerance = Number.isFinite(options.toleranceMs) ? options.toleranceMs : TOLERANCE_MS;
  const cooldown = Number.isFinite(options.cooldownMs) ? options.cooldownMs : COOLDOWN_MS;
  const sinceStart = Number.isFinite(options.sinceStartMs) ? options.sinceStartMs : Infinity;
  if (sinceStart < GRACE_MS) return "hold";
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
  // pull them back onto a song they have finished. There is nothing to load -
  // but the room's transport still governs this member's, so a pause here
  // pauses them and a play starts them again. Swallowing those with the load is
  // how a pause pressed just after a song change did nothing at all.
  if (advancedPast.has(itemId)) {
    if (current.paused) return playing ? { action: "pause" } : { action: "hold" };
    if (!playing) return { action: "resume" };
    return { action: "hold" };
  }

  // The file for this item is on its way: nothing to decide until it lands.
  // The words are the bar's own - "downloading 3.1 of 8.4 MB", "converting 45%"
  // - so the room's line and the bar under it are not two accounts of one
  // download; a page too bare to carry a stage keeps the plain sentence.
  if (loaded && input.loading) return { action: "hold", status: input.loadLabel || "Loading the track…" };

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
  // How long this member's file has been running, for the grace the drift rule
  // applies. The caller may say, and the tick does not: the load it remembers
  // is the same moment, so the grace is measured from the load either way.
  const sinceStartMs = Number.isFinite(Number(input.sinceStartMs))
    ? Number(input.sinceStartMs)
    : Number.isFinite(startedAt)
      ? Number(input.nowMs) - startedAt
      : Infinity;
  const roomOver = length > 0 && roomMs >= length;
  const fileOver = input.ended || (Number(input.measuredMs) > 0 && aged > Number(input.measuredMs));
  // The room's clock is what says when the song is over; a member's own file
  // running out is only evidence of it when it runs out *near* the room's end.
  // A copy shorter than the length the room was told - trimmed differently, or
  // a different rendition - ends early, and moving on there is the transition
  // heard before the song was over; the room's own switch then drags the member
  // back onto the song they had already started, which is the reset. So a file
  // that ends first waits for the room, quietly.
  //
  // With no length known there is nothing to measure against, and the local end
  // is all the evidence there is.
  const nearRoomEnd = length <= 0 || length - roomMs <= FILE_END_SLACK_MS;
  if (roomOver || (fileOver && nearRoomEnd)) {
    const next = nextItem(input.state, itemId);
    if (!next) return { action: "pause" };
    return { action: "advance", itemId: String(next.id), fromItemId: itemId, autoplay: true };
  }
  if (fileOver) return { action: "pause", waiting: true };

  if (!playing) {
    return { action: "resume", blocked: Boolean(input.blocked) };
  }

  const drift = driftAction(input.localPositionMs, roomMs, {
    sinceStartMs,
    sinceCorrectMs: input.sinceCorrectMs,
  });
  if (drift === "hold") return { action: "hold" };
  return { action: "seek", positionMs: roomMs, direction: drift };
}