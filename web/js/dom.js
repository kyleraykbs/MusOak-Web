// The DOM helpers every view builds with.
//
// Two rules hold everywhere in this app: text from the server is set as a text
// node (never innerHTML), and colours come from theme.css, never from code.

/**
 * h("div", {class: "row", onclick: fn}, "text", childNode)
 * Props: class, text, style (object), dataset, onclick…, everything else is an
 * attribute. `null`/`false`/`undefined` children are skipped.
 */
export function h(tag, props = null, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = String(value);
      else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
      else if (key === "dataset") Object.assign(node.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2), value);
      } else if (key === "value" || key === "checked" || key === "disabled") {
        node[key] = value;
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === "") continue;
    if (Array.isArray(child)) append(node, child);
    else if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/** A text node, for the rare case h() is not the right shape. */
export function text(value) {
  return document.createTextNode(value === null || value === undefined ? "" : String(value));
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(parent, ...children) {
  clear(parent);
  append(parent, children);
  return parent;
}

/**
 * A function that runs `fn` at most once per frame.
 *
 * Repainting a view is expensive and the events that ask for it arrive in
 * bursts - a phone returning to a tab is handed everything it missed at once.
 * A frame coalesces those into one repaint, and none are painted while the tab
 * is hidden, so coming back costs exactly one.
 *
 * requestAnimationFrame is also the one path that stops when a tab is frozen
 * or throttled, and a page whose frames never come would otherwise freeze at
 * the numbers from the moment it last painted - a room that queued three songs
 * would keep showing empty panels until some click happened to repaint it.
 * The timer fallback renders when no frame has, so correctness never depends
 * on the compositor being awake; the frame path stays first so a visible page
 * still coalesces a burst into one.
 */
const FRAME_FALLBACK_MS = 250;

export function scheduleFrame(fn) {
  let queued = false;
  const run = () => {
    queued = false;
    fn();
  };
  return () => {
    if (queued) return;
    queued = true;
    let timer = setTimeout(() => {
      timer = 0;
      if (!queued) return;
      run();
    }, FRAME_FALLBACK_MS);
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        if (!timer) return;
        clearTimeout(timer);
        timer = 0;
        run();
      });
    }
  };
}

/** Replace everything in `parent` with what `build()` returns. */
export function render(parent, build) {
  clear(parent);
  const built = build();
  append(parent, [built]);
  return built;
}

/**
 * A modal. Actions are [{label, class?, onClick}]; onClick returning `false`
 * keeps the dialog open (an action that failed and wants to say so).
 * Escape and a backdrop click close it. Returns {close, node}.
 */
export function dialog({ title, body, actions = [], onOpen, closeButton = false }) {
  const backdrop = h("div", { class: "dialog-backdrop" });
  const close = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  const panel = h(
    "div",
    { class: "dialog", role: "dialog", "aria-modal": "true" },
    closeButton
      ? iconButton("cross", {
          title: "Close",
          class: "btn flat round dialog-close",
          onclick: () => close(),
        })
      : null,
    title ? h("h2", { text: title }) : null,
    body ? (typeof body === "string" ? h("p", { text: body }) : body) : null,
    h(
      "div",
      { class: "actions" },
      actions.map((action) =>
        h("button", {
          class: `btn ${action.class || ""}`.trim(),
          text: action.label,
          onclick: async (event) => {
            const keep = action.onClick ? await action.onClick(event) : undefined;
            if (keep !== false && action.keepOpen !== true) close();
          },
        })
      )
    )
  );
  backdrop.appendChild(panel);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
  onOpen?.(panel, close);
  return { close, node: panel };
}

/**
 * A popover anchored to an element. Items are {label, icon?, onClick, disabled?,
 * checked?, trailing?} or {separator: true} or {header: "…"}. `trailing` is a
 * second, smaller button on the row: {icon, title, onClick}. Closes on outside
 * click, Escape, or after an item is chosen.
 */
/** Which button has a menu open, so pressing it again closes rather than
 *  reopening one. */
let menuAnchor = null;

export function popover(anchor, items) {
  const reopening = menuAnchor === anchor && document.querySelector(".popover");
  document.querySelectorAll(".popover").forEach((node) => node.remove());
  menuAnchor = null;
  if (reopening) return null;
  const main = (item) =>
    h("button", {
      class: "menu-item",
      role: "menuitem",
      disabled: item.disabled,
      title: item.title || "",
      onclick: async (event) => {
        event.stopPropagation();
        if (item.disabled) return;
        close();
        await item.onClick?.();
      },
    }, h("span", { style: { width: "18px", textAlign: "center" }, text: item.icon || (item.checked ? "*" : "") }), item.label);

  const menu = h(
    "div",
    { class: "popover", role: "menu" },
    items.map((item) => {
      if (item.separator) return h("div", { class: "menu-separator" });
      if (item.header) return h("div", { class: "menu-item", style: { color: "var(--gray)", cursor: "default" }, text: item.header });
      if (!item.trailing) return main(item);
      const trailing = Array.isArray(item.trailing) ? item.trailing : [item.trailing];
      return h(
        "div",
        { class: "menu-row" },
        main(item),
        trailing.filter(Boolean).map((action) =>
          h("button", {
            class: "menu-item trailing",
            title: action.title || "",
            "aria-label": action.title || "Action",
            onclick: async (event) => {
              event.stopPropagation();
              close();
              await action.onClick?.();
            },
          }, icon(action.icon || "cross", 15))
        )
      );
    })
  );
  document.body.appendChild(menu);
  const box = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  // Below the button when it fits, above it when it does not: clamping a menu
  // that is opened from the player bar would drop it on top of the button that
  // opened it. The player bar is at the bottom of the window, so this is the
  // common case there.
  const below = box.bottom + 6;
  const above = box.top - size.height - 6;
  const top = below + size.height + 10 <= window.innerHeight ? below : above;
  const left = Math.max(8, Math.min(box.left, window.innerWidth - size.width - 10));
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${left}px`;
  menuAnchor = anchor;

  const close = () => {
    if (menuAnchor === anchor) menuAnchor = null;
    menu.remove();
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", close, true);
  };
  const onOutside = (event) => {
    // The button's own press must not close the menu: it arrives as a click
    // just after, and popover() reads the open menu to tell a second press from
    // a first. A press lands on the glyph inside the button rather than on the
    // button itself, so its whole subtree counts as the anchor.
    if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  setTimeout(() => {
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
  });
  return { close, node: menu };
}

/** The stack notices are shown in: one column above the player bar, oldest at
 *  the top, so two notices never land on top of each other. It is created when
 *  the first notice arrives and removed when the last one goes. */
let noticeStack = null;

function notices() {
  if (!noticeStack || !noticeStack.isConnected) {
    noticeStack = h("div", { class: "toasts" });
    document.body.appendChild(noticeStack);
  }
  return noticeStack;
}

/** Add a transient notice, above the sticky one when there is one. */
function addNotice(node) {
  const stack = notices();
  if (statusNode && statusNode.parentElement === stack) stack.insertBefore(node, statusNode);
  else stack.appendChild(node);
}

function dropNotice(node) {
  node.remove();
  if (noticeStack && noticeStack.childElementCount === 0) {
    noticeStack.remove();
    noticeStack = null;
  }
}

/** A short toast, for things that went right and need no answer. Several at
 *  once stack rather than cover one another. */
export function toast(message) {
  const node = h("div", { class: "toast", text: message });
  addNotice(node);
  setTimeout(() => dropNotice(node), 2600);
}

/** The app's one place for "this is happening while something takes a while".
 *
 *  The same box as `toast`, but it stays until it is changed, and there is only
 *  ever one of it: a room preparing a track can say so for as long as it takes
 *  without stacking notices. Passing "" clears it. */
let statusNode = null;

export function status(message) {
  const text = String(message || "");
  if (!text) {
    statusNode?.remove();
    statusNode = null;
    if (noticeStack && noticeStack.childElementCount === 0) {
      noticeStack.remove();
      noticeStack = null;
    }
    return;
  }
  if (!statusNode || !statusNode.isConnected) {
    statusNode = h("div", { class: "toast", role: "status" });
  }
  statusNode.textContent = text;
  // Last in the stack: with toasts coming and going above it, the line that
  // says what is happening stays where the eye already is.
  notices().appendChild(statusNode);
}

/** Ask for one line of text. Resolves with the string, or null if cancelled. */
export function prompt(title, label, initial = "", { type = "text", confirm = "Save" } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const input = h("input", { class: "input", type, value: initial });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const { close } = dialog({
      title,
      body: h("div", { class: "field" }, label ? h("label", { text: label }) : null, input),
      actions: [
        { label: "Cancel", onClick: () => finish(null) },
        { label: confirm, class: "suggested", onClick: () => finish(input.value.trim()) },
      ],
      onOpen: (panel) => {
        panel.querySelector("input")?.focus();
        input.select?.();
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            finish(input.value.trim());
            close();
          }
        });
      },
    });
  });
}

/** Ask a yes/no question. Resolves true only on the confirming answer. */
export function confirm(title, message, { confirm: confirmLabel = "Confirm", destructive = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    dialog({
      title,
      body: message,
      actions: [
        { label: "Cancel", onClick: () => finish(false) },
        { label: confirmLabel, class: destructive ? "destructive" : "suggested", onClick: () => finish(true) },
      ],
    });
  });
}

/** Pick one file from disk. Resolves with a File, or null. */
export function pickFile(accept = "") {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, style: { display: "none" } });
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const file = input.files?.[0] || null;
      input.remove();
      resolve(file);
    });
    input.click();
  });
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Icons are drawn, not typed: a glyph the reader's font lacks shows as a box,
// and this app must look the same on every machine. Each is a 24x24 path drawn
// with currentColor.
const ICONS = {
  search: "M10 4a6 6 0 1 0 3.6 10.8l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z",
  list: "M4 6h2v2H4V6Zm4 0h12v2H8V6ZM4 11h2v2H4v-2Zm4 0h12v2H8v-2ZM4 16h2v2H4v-2Zm4 0h12v2H8v-2Z",
  star: "M12 3.6l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9-5.3-2.9-5.3 2.9 1.1-5.9L3.5 9.8l5.9-.8L12 3.6Z",
  note: "M9 4h9v2h-7v9.2A3.4 3.4 0 1 1 9 12.2V4Zm-2 8a2 2 0 1 0 2 2V12a2 2 0 0 0-2 0Z",
  upload: "M12 3l5 5h-3v6h-4V8H7l5-5ZM5 18h14v2H5v-2Z",
  download: "M11 3h2v9h3l-4 5-4-5h3V3ZM5 19h14v2H5v-2Z",
  cloud: "M7.5 6.5A4 4 0 0 1 15 7.6a3.5 3.5 0 0 1-.4 7H8a4 4 0 0 1-.5-8.1ZM12 11v6h-2v-6H8l4-4 4 4h-2v6h-2v-6h-2v6h-2Z",
  people: "M9 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm0 8c3 0 6 1.5 6 3.5V19H3v-2.5C3 14.5 6 13 9 13Zm7-8a2.5 2.5 0 0 1 0 5 2.5 2.5 0 0 1 0-5Zm.6 7c2 .6 3.4 1.8 3.4 3.3V19h-4v-2.6c0-1.1-.5-2-1.4-2.7.7-.5 1.4-.8 2-.7Z",
  home: "M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3l9-8Z",
  gear: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-1-7h2l.4 2.3 1.8.8 2-1.2 1.4 1.4-1.2 2 .8 1.8L20.5 11v2l-2.3.4-.8 1.8 1.2 2-1.4 1.4-2-1.2-1.8.8L13 20.5h-2l-.4-2.3-1.8-.8-2 1.2-1.4-1.4 1.2-2-.8-1.8L3.5 13v-2l2.3-.4.8-1.8-1.2-2 1.4-1.4 2 1.2 1.8-.8L11 3Z",
  bell: "M12 3a5 5 0 0 0-5 5v4l-2 3h14l-2-3V8a5 5 0 0 0-5-5Zm-2 15a2 2 0 1 0 4 0h-4Z",
  play: "M7 4l12 8-12 8V4Z",
  pause: "M6 5h4v14H6V5Zm8 0h4v14h-4V5Z",
  next: "M6 4l9 8-9 8V4Zm11 0h2v16h-2V4Z",
  prev: "M18 4v16l-9-8 9-8ZM5 4h2v16H5V4Z",
  shuffle: "M17 4h4v4h-2V7.4l-4.3 4.3-1.4-1.4L17.6 6H17V4ZM4 6h4l9 9v1.6l1.6-1.6H20v4h-4v-2h.6L7 7.4V6H4Zm0 11h4l2.3-2.3 1.4 1.4L8.5 18.4 9 19H4v-2Z",
  queue: "M4 5h2v2H4V5Zm4 0h12v2H8V5ZM4 11h2v2H4v-2Zm4 0h12v2H8v-2ZM4 17h2v2H4v-2Zm4 0h12v2H8v-2Z",
  plus: "M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4Z",
  minus: "M4 11h16v2H4v-2Z",
  cross: "M6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4 6.4 5Z",
  check: "M9.6 15.2 5.4 11l-1.4 1.4 5.6 5.6L20.4 7.2 19 5.8 9.6 15.2Z",
  dots: "M6 10h3v3H6v-3Zm5 0h3v3h-3v-3Zm5 0h3v3h-3v-3Z",
  up: "M12 6l6 7h-4v5h-4v-5H6l6-7Z",
  down: "M12 18l-6-7h4V6h4v5h4l-6 7Z",
  "chevron-left": "M14.7 5.3 8 12l6.7 6.7 1.4-1.4L10.8 12l5.3-5.3-1.4-1.4Z",
  "chevron-down": "M6.7 9.3 12 14.7l5.3-5.4-1.4-1.4L12 11.9 7.9 7.9 6.7 9.3Z",
  grip: "M10 6.2a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm0 5.8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm0 5.8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm8-11.6a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm0 5.8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm0 5.8a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  "chevron-right": "M9.3 5.3 8 6.7 13.3 12 8 17.3l1.3 1.4L15.7 12 9.3 5.3Z",
  retry: "M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z",
  pencil: "M4 20h4l10-10-4-4L4 16v4Zm2-3.4L14.6 8 16 9.4 7.4 18H6v-1.4ZM16.7 4.3l3 3-1.4 1.4-3-3 1.4-1.4Z",
  users: "M8 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm8 1a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM2 19v-2c0-2 3-3.5 6-3.5s6 1.5 6 3.5v2H2Zm14.5 0v-2c0-1.2-.5-2.2-1.4-3 .6-.2 1.3-.3 1.9-.3 2.5 0 5 1.2 5 3.3v2h-5.5Z",
  folder: "M3 5h6l2 2h10v12H3V5Zm2 4v8h14V9H5Z",
  send: "M3 4l18 8-18 8 3-8-3-8Zm5.2 7L5.6 6.9 16.5 12 5.6 17.1 8.2 13H12v-2H8.2Z",
  heart: "M12 20s-8-4.6-8-9.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 3.5C20 15.4 12 20 12 20Z",
  room: "M4 4h16v12H4V4Zm2 2v8h12V6H6Zm3 11h6v2H9v-2Z",
  speaker: "M5 9h3l4-3v12l-4-3H5V9Zm10.5-.9a5 5 0 0 1 0 7.8l-1.3-1.5a3 3 0 0 0 0-4.8l1.3-1.5Z",
  mute: "M5 9h3l4-3v12l-4-3H5V9Zm10 1.6 1.4-1.4 5 5-1.4 1.4-5-5Zm6.4-1.4-5 5 1.4 1.4 5-5-1.4-1.4Z",
};

/** Names a view may use, in the order they fit the app. */
export const iconNames = Object.keys(ICONS);

/** An icon by name, or null when there is no such icon (callers fall back). */
export function icon(name, size = 16) {
  const path = ICONS[name];
  if (!path) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  svg.style.flex = "none";
  svg.style.verticalAlign = "-3px";
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path);
  svg.appendChild(shape);
  return svg;
}

/** An icon when one exists, otherwise the text a view asked for. */
export function iconOr(glyph, size = 16) {
  return icon(glyph, size) || h("span", { class: "icon", text: glyph || "" });
}

/** A button whose label is an icon. */
export function iconButton(name, { title = "", onclick, class: className = "btn flat round", size = 16 } = {}) {
  return h("button", { class: className, title, "aria-label": title, onclick }, icon(name, size) || h("span", { text: name }));
}

/** "3:07" */
export function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}:${String(minutes % 60).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** "1.4 GB" */
export function fmtBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${units[index]}`;
}

/** "just now", "4m ago", "3d ago" */
export function fmtAgo(when) {
  const then = when instanceof Date ? when : new Date(when);
  const seconds = Math.max(0, (Date.now() - then.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return then.toLocaleDateString();
}

/** The piece of an artwork URL that survives a reload (nothing secret). */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "");
  }
}

export function debounce(fn, delay = 250) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
