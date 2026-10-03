// A song's words, as one rendition has them.
//
// The panel does not own a timer: the caller ticks and hands the position in
// through the returned handle, so the highlight follows playback without this
// view competing for the clock. Clicking a line seeks, because a word sheet you
// cannot jump in is a poster, not a lyric view.

import { h, clear, mount } from "../dom.js";

/**
 * The index of the line in force at `positionMs`: the last line whose time has
 * come. Before the first line there is none, which is -1, so a caller can tell
 * "not started" from "on line 0".
 *
 * Lines are taken in the order given (the server sorts them); a line whose time
 * has not arrived ends the walk.
 */
export function activeLine(lines, positionMs) {
  if (!Array.isArray(lines) || lines.length === 0) return -1;
  const at = Number(positionMs);
  if (!Number.isFinite(at)) return -1;
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const lineMs = Number(lines[i]?.atMs);
    if (!Number.isFinite(lineMs) || lineMs > at) break;
    index = i;
  }
  return index;
}

/**
 * Build a word panel for one rendition.
 *
 * Returns `{ node, setPosition }`. `setPosition(ms)` moves the highlight;
 * `onSeek(atMs)` is called when a timed line is clicked. The node is returned
 * empty and filled when the lookup answers, so a slow source never blocks the
 * rest of the player.
 */
export function lyricsPanel(client, { trackId, variantId = "", positionMs = 0, onSeek } = {}) {
  const root = h("div", { class: "lyrics" });
  let synced = [];
  let rows = [];
  let active = -1;

  const highlight = (next) => {
    if (next === active) return;
    if (rows[active]) rows[active].classList.remove("active");
    active = next;
    const row = rows[active];
    if (row) {
      row.classList.add("active");
      // Keep the singing line on screen without taking the page's scroll.
      row.scrollIntoView?.({ block: "nearest" });
    }
  };

  // Nothing to follow along with: say so rather than showing an empty box.
  const show = (title, hint) => {
    synced = [];
    rows = [];
    active = -1;
    clear(root);
    root.appendChild(
      h(
        "div",
        { class: "empty" },
        h("span", { class: "title", text: title }),
        hint ? h("span", { text: hint }) : null
      )
    );
  };

  const render = (lyrics) => {
    if (!lyrics) {
      show("No lyrics for this one");
      return;
    }
    if (lyrics.source === "lrclib-instrumental") {
      show("Instrumental");
      return;
    }
    synced = Array.isArray(lyrics.synced) ? lyrics.synced : [];
    if (synced.length > 0) {
      rows = synced.map((line) =>
        h("button", {
          class: "lyrics-line",
          type: "button",
          text: line.text,
          onclick: () => onSeek?.(Number(line.atMs) || 0),
        })
      );
      active = -1;
      mount(root, rows);
      highlight(activeLine(synced, positionMs));
      return;
    }
    const plain = String(lyrics.plain || "").trim();
    if (!plain) {
      show("No lyrics for this one");
      return;
    }
    // Words without timings: they can be read, but not followed along with.
    synced = [];
    rows = [];
    active = -1;
    mount(
      root,
      h(
        "div",
        { class: "lyrics-plain" },
        plain.split(/\r?\n/).map((text) => h("div", { text }))
      )
    );
  };

  Promise.resolve()
    .then(() => client?.lyrics(trackId, variantId))
    .then(render)
    .catch(() => render(null));

  return {
    node: root,
    setPosition(ms) {
      if (rows.length === 0) return;
      highlight(activeLine(synced, ms));
    },
  };
}
