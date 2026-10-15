// The page's transport keys.
//
// A browser is the same kind of player as the terminal one, so the same keys
// have to mean the same things - and they must not mean them where the keyboard
// is somebody else's: a field being typed into, a dialog, a menu, or the
// browser's own combination.
import test from "node:test";
import assert from "node:assert/strict";

// The shell reads `document` off wherever it runs. Node has none, and this is
// none of it: what is being tested is what a keypress means.
globalThis.document = {
  body: {},
  createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} }),
  createElementNS: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  createTextNode: () => ({}),
};

class FakeInput {
  constructor(type) {
    this.type = type;
  }
  getAttribute(name) {
    return name === "type" ? this.type : null;
  }
}
globalThis.HTMLInputElement = FakeInput;

const { transportBlocked, transportCommand } = await import("../app.js");

/** A keypress, as the shell's own listener sees one. */
function press(key, { target = null, ...modifiers } = {}) {
  return { key, target, repeat: false, defaultPrevented: false, ...modifiers };
}

test("the transport keys are the terminal player's, plus mute", () => {
  const first = (event) => transportCommand(event);
  assert.equal(first(press(" ")), "toggle-play");
  assert.equal(first(press("l")), "next-track");
  assert.equal(first(press("ArrowRight")), "next-track");
  assert.equal(first(press("h")), "previous-track");
  assert.equal(first(press("ArrowLeft")), "previous-track");
  assert.equal(first(press("k")), "volume-up");
  assert.equal(first(press("ArrowUp")), "volume-up");
  assert.equal(first(press("j")), "volume-down");
  assert.equal(first(press("ArrowDown")), "volume-down");
  assert.equal(first(press("m")), "toggle-mute");
  // A shifted letter is the same key: nobody presses shift before h to skip.
  assert.equal(first(press("L")), "next-track");
  // Everything else is the page's, or another view's, and is left alone.
  assert.equal(first(press("q")), "", "the terminal's quit key is not the page's");
  assert.equal(first(press("Enter")), "");
  assert.equal(first(press("Escape")), "");
  assert.equal(first(press("x")), "");
  assert.equal(first(press(undefined)), "");
});

test("a field keeps every key, and a control does not", () => {
  // Typing: space is a space, and l is an l.
  const text = press(" ", { target: new FakeInput("text") });
  assert.equal(transportCommand(text), "");
  assert.equal(transportCommand(press("l", { target: new FakeInput("search") })), "");
  assert.equal(transportCommand(press("ArrowLeft", { target: new FakeInput("search") })), "");

  // A control is not a field being typed into: clicking the seek used to make
  // space do nothing at all, and the same rule is what the keys run under.
  assert.equal(transportCommand(press(" ", { target: new FakeInput("range") })), "toggle-play");
  assert.equal(transportCommand(press("l", { target: new FakeInput("checkbox") })), "next-track");
});

test("a combination with a modifier belongs to the browser", () => {
  // ctrl+L is the address bar and cmd+ArrowLeft is the browser's history:
  // taking those is how a page becomes a keyboard trap.
  assert.equal(transportCommand(press("l", { ctrlKey: true })), "");
  assert.equal(transportCommand(press("ArrowLeft", { metaKey: true })), "");
  assert.equal(transportCommand(press("ArrowDown", { altKey: true })), "");
  assert.equal(transportCommand(press(" ", { shiftKey: true })), "toggle-play", "shift alone is still a key");
});

test("nothing transports behind a dialog or an open menu", () => {
  const withSelector = (selector, hit) => ({
    querySelector: (asked) => (asked === selector && hit ? {} : null),
  });
  assert.equal(transportBlocked(withSelector(".dialog-backdrop, .popover", true)), true);
  assert.equal(transportBlocked(withSelector(".dialog-backdrop, .popover", false)), false);
  // Nothing to ask: a page with no DOM is not blocked, it has no keyboard.
  assert.equal(transportBlocked(null), false);
});