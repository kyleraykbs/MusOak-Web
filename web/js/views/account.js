// The account tab: who the server says you are, and the few things of it that
// are yours to change.
//
// Everything here is a small form over the /me endpoints. The display name is
// a plain field that saves on demand, the icon uploads the moment it is picked,
// and the two buttons that change who the account *is* ask for the password
// first. The provider order is the same per-account preference the playbar
// consults when it picks which source of a song plays.

import {
  h, clear, mount, dialog, toast, pickFile, fileToBase64, icon,
} from "../dom.js";
import { isSignedIn, bumpIcon, iconVersion, userIdOf } from "../state.js";
import { rejoinRoom } from "../rooms-state.js";
import { registerView, banner, requireLogin, refreshMe, currentClient } from "../app.js";
import { enabledPlatforms } from "../platforms.js";

// An icon travels in the request body, so it stays modest.
export const MAX_ICON_BYTES = 8 << 20;

// The image types the icon endpoint takes, by MIME type or file extension.
const ICON_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

/** The image type a file looks like, or "" when it is not one we take. */
export function iconContentType(hint) {
  const value = String(hint || "").toLowerCase().trim();
  if (!value) return "";
  if (Object.values(ICON_TYPES).includes(value)) return value;
  if (value.includes("/")) return "";
  const dot = value.lastIndexOf(".");
  return ICON_TYPES[dot >= 0 ? value.slice(dot + 1) : value] || "";
}

/** Whether a typed field differs from the value the server holds. */
export function isDirty(saved, current) {
  return String(current ?? "").trim() !== String(saved ?? "").trim();
}

/** A copy of `list` with the item at `from` moved to `to`, clamped in range. */
export function moveItem(list, from, to) {
  const items = [...(list || [])];
  if (!items.length) return items;
  const last = items.length - 1;
  const source = Math.min(Math.max(Math.trunc(Number(from) || 0), 0), last);
  const target = Math.min(Math.max(Math.trunc(Number(to) || 0), 0), last);
  if (source === target) return items;
  const [moved] = items.splice(source, 1);
  items.splice(target, 0, moved);
  return items;
}

/** What is wrong with a password change, or "" when it is ready to send. */
export function passwordProblem(current, next, confirm) {
  if (!String(current) || !String(next)) return "Both the current and the new password are needed.";
  if (String(next) !== String(confirm)) return "The two new passwords do not match.";
  return "";
}

/** What is wrong with a username change, or "" when it is ready to send. */
export function usernameProblem(password, username) {
  if (!String(password) || !String(username).trim()) return "A password and a new username are needed.";
  return "";
}

// --- the view ---------------------------------------------------------------

let root = null; // the container the shell handed us
let account = {}; // the last /me we saw: what Save and Discard compare against
let ranking = { order: [], own: false, list: null };
// The platforms a search can ask, which is what the checkboxes here set.
let searchable = [];
/** The two positions that are not platforms: your own copy, and the best of
 *  everybody else's. They sit in the same order and are ranked the same way. */
const SLOTS = new Set(["self", "uploaded"]);

/** What a slot is called where a person reads it. */
function slotLabel(name) {
  if (name === "self") return "Your uploads";
  if (name === "uploaded") return "Other people's uploads";
  return name;
}
let nameInput = null;
let saveButton = null;
let discardButton = null;

export function render(container) {
  root = container;
  clear(container);
  if (!isSignedIn()) {
    guestCard(container);
    return;
  }
  container.appendChild(h("div", { class: "empty" }, h("span", { class: "title", text: "Loading your account…" })));
  load();
}

export function refresh() {
  if (!root) return;
  if (!isSignedIn()) {
    clear(root);
    guestCard(root);
    return;
  }
  load();
}

async function load() {
  const client = currentClient();
  if (!client) {
    if (root) {
      clear(root);
      guestCard(root);
    }
    return;
  }
  try {
    const [me, payload, order, providers] = await Promise.all([
      client.me(), client.ranking(), client.providerOrder(), client.providers().catch(() => []),
    ]);
    account = { ...me };
    // Only the platforms a search can actually ask get a checkbox: Spotify
    // answers metadata-only, so a search asking it would only add an error line.
    searchable = enabledPlatforms(providers).map((provider) => provider.name);
    const own = Array.isArray(payload.ranking) ? payload.ranking : [];
    ranking = { order: order.length ? order : own, own: own.length > 0, list: null };
    if (root) build();
  } catch (error) {
    fail(error);
    if (!root || error?.status === 401) return; // a 401 is answered by the sign-in dialog
    // Whatever went wrong, the view must stop saying it is loading.
    clear(root);
    root.appendChild(h("div", { class: "card" },
      h("div", { class: "empty" },
        h("span", { class: "icon", style: { display: "inline-flex", lineHeight: "0" } }, icon("gear", 38)),
        h("span", { class: "title", text: "Your account could not be loaded" }),
        h("span", { text: String(error?.message || error) }),
        h("button", { class: "btn suggested", text: "Try again", onclick: () => load() }))));
  }
}

function build() {
  if (!root) return;
  clear(root);
  root.appendChild(profileCard());
  root.appendChild(actionsRow());
  root.appendChild(saveFooter());
  root.appendChild(providerCard());
}

// --- the form ---------------------------------------------------------------

function field(id, label, input) {
  input.id = id;
  return h("div", { class: "field" }, h("label", { for: id, text: label }), input);
}

function iconTile() {
  const version = Number(account.iconVersion) || iconVersion(userIdOf(account));
  const url = currentClient()?.artworkUrl(account.iconUrl || "", version) || "";
  const tile = url
    ? h("img", { class: "art big round", src: url, alt: "Your icon" })
    : h("div", {
        class: "art big round",
        role: "img",
        "aria-label": "No icon yet",
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--bg4)",
        },
      }, icon("users", 48));
  return h("button", {
    class: "btn",
    title: "Choose a new icon",
    style: { padding: "0", border: "0", background: "transparent" },
    onclick: chooseIcon,
  }, tile);
}

function profileCard() {
  const card = h("div", { class: "list" });

  card.appendChild(h("div", { class: "row" },
    iconTile(),
    h("div", { class: "grow" },
      h("div", { class: "title", text: "Profile picture" }),
      h("div", { class: "subtitle wrap", text: "A png, jpeg, webp, gif or avif image, up to 8 MB. Animated pngs and gifs keep moving." })),
    h("button", { class: "btn", text: "Upload icon", onclick: chooseIcon })));

  nameInput = h("input", {
    class: "input",
    type: "text",
    value: account.displayName || "",
    placeholder: "Display name",
  });
  card.appendChild(h("div", { class: "row" }, field("account-display-name", "Display name", nameInput)));

  card.appendChild(h("div", { class: "row" },
    h("div", { class: "grow", text: "Username" }),
    h("span", { class: "subtitle", text: account.username || "" })));

  return card;
}

function actionsRow() {
  return h("div", { class: "form-row" },
    h("button", { class: "btn", style: { flex: "1" }, text: "Change password", onclick: openPassword }),
    h("button", { class: "btn", style: { flex: "1" }, text: "Change username", onclick: openUsername }));
}

function saveFooter() {
  discardButton = h("button", { class: "btn", style: { flex: "1" }, text: "Discard", disabled: true, onclick: discardName });
  saveButton = h("button", { class: "btn suggested", style: { flex: "1" }, text: "Save", disabled: true, onclick: saveName });
  nameInput.addEventListener("input", syncNameButtons);
  return h("div", { class: "form-row" }, discardButton, saveButton);
}

function syncNameButtons() {
  const dirty = isDirty(account.displayName || "", nameInput.value);
  saveButton.disabled = !dirty;
  discardButton.disabled = !dirty;
}

async function saveName() {
  const client = currentClient();
  if (!client) return;
  try {
    await client.updateProfile(nameInput.value.trim());
    await refreshMe();
    // A room membership carries the name it was made with, so a change here has
    // to reach the room: the member is joined again under the new name.
    await rejoinRoom().catch(() => {});
    toast("Display name saved.");
    await load();
  } catch (error) {
    fail(error);
  }
}

function discardName() {
  nameInput.value = account.displayName || "";
  syncNameButtons();
}

// --- the icon ---------------------------------------------------------------

async function chooseIcon() {
  const file = await pickFile("image/png,image/jpeg,image/webp,image/gif,image/avif");
  if (!file) return;
  const contentType = iconContentType(file.type) || iconContentType(file.name);
  if (!contentType) {
    banner("That file is not a png, jpeg, webp, gif or avif image.", "error");
    return;
  }
  if (file.size > MAX_ICON_BYTES) {
    banner(`That image is larger than ${MAX_ICON_BYTES >> 20} MB.`, "error");
    return;
  }
  const client = currentClient();
  if (!client) return;
  try {
    const data = await fileToBase64(file);
    await client.uploadIcon(data, contentType);
    // The icon lives at a path that never changes and is served with a long
    // cache, so say it changed and ask who we are again: the tile and the
    // corner show the new picture with no reload.
    bumpIcon(userIdOf(account));
    await refreshMe();
    // Same as the name: the room shows the picture the membership was made
    // with, so it has to be made again to show this one.
    await rejoinRoom().catch(() => {});
    toast("Icon updated.");
    await load();
  } catch (error) {
    fail(error);
  }
}

// --- the two confirmations ---------------------------------------------------

function dialogFields(...entries) {
  return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } }, entries);
}

function openPassword() {
  const current = h("input", { class: "input", type: "password", placeholder: "Current password" });
  const next = h("input", { class: "input", type: "password", placeholder: "New password" });
  const again = h("input", { class: "input", type: "password", placeholder: "Repeat the new password" });
  // Whatever goes wrong is said here, in the dialog: a banner on the page
  // behind a modal is a message nobody reads.
  const status = h("span", { class: "login-status" });
  const say = (message, kind = "error") => {
    status.className = kind ? `login-status ${kind}` : "login-status";
    status.textContent = message;
  };
  dialog({
    title: "Change password",
    body: dialogFields(
      h("p", { style: { margin: "0" }, text: "The current password proves it is you." }),
      field("account-current-password", "Current password", current),
      field("account-new-password", "New password", next),
      field("account-confirm-password", "Repeat the new password", again),
      status
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Change",
        class: "suggested",
        onClick: async (event) => {
          const button = event?.currentTarget;
          say("");
          const problem = passwordProblem(current.value, next.value, again.value);
          if (problem) {
            say(problem);
            return false;
          }
          if (button) button.dataset.busy = "true";
          try {
            await currentClient().changePassword(current.value, next.value);
            toast("Password changed.");
          } catch (error) {
            say(String(error?.message || "the password could not be changed"));
            return false;
          } finally {
            if (button) delete button.dataset.busy;
          }
        },
      },
    ],
    onOpen: (panel) => panel.querySelector("input")?.focus(),
  });
}

function openUsername() {
  const password = h("input", { class: "input", type: "password", placeholder: "Password" });
  const username = h("input", { class: "input", type: "text", placeholder: "New username" });
  const status = h("span", { class: "login-status" });
  const say = (message, kind = "error") => {
    status.className = kind ? `login-status ${kind}` : "login-status";
    status.textContent = message;
  };
  dialog({
    title: "Change username",
    body: dialogFields(
      h("p", { style: { margin: "0" }, text: "Changing your username changes how everyone finds you. The old name stops working right away." }),
      field("account-username-password", "Password", password),
      field("account-new-username", "New username", username),
      status
    ),
    actions: [
      { label: "Cancel" },
      {
        label: "Change",
        class: "suggested",
        onClick: async (event) => {
          const button = event?.currentTarget;
          say("");
          const problem = usernameProblem(password.value, username.value);
          if (problem) {
            say(problem);
            return false;
          }
          if (button) button.dataset.busy = "true";
          try {
            await currentClient().changeUsername(password.value, username.value.trim());
            await refreshMe();
            toast("Username changed.");
            await load();
          } catch (error) {
            say(String(error?.message || "the username could not be changed"));
            return false;
          } finally {
            if (button) delete button.dataset.busy;
          }
        },
      },
    ],
    onOpen: (panel) => panel.querySelector("input")?.focus(),
  });
}

// --- providers ---------------------------------------------------------------

function providerCard() {
  const card = h("div", { class: "card" },
    h("div", { class: "row" },
      h("span", { class: "grow section-title", text: "Providers" }),
      ranking.order.length ? h("span", { class: "tag", text: ranking.own ? "your order" : "server default" }) : null),
    h("div", { class: "row" },
      h("span", { class: "grow subtitle wrap", text: "This order decides which source of a song plays. Official sources still come first." })),
    h("div", { class: "row" },
      h("span", { class: "grow subtitle wrap", text: "The boxes are which platforms a search asks. A search starts from them every time you open it." })));

  const list = h("div", { class: "list" });
  ranking.list = list;
  mount(list, rankingRows());
  card.appendChild(list);
  return card;
}

function rankingRows() {
  const order = ranking.order;
  if (!order.length) return [h("div", { class: "row" }, h("span", { class: "subtitle", text: "No providers to rank." }))];
  return order.map((name, index) =>
    h("div", { class: "row" },
      h("span", { class: "time", text: String(index + 1) }),
      h("span", { class: "grow title", text: slotLabel(name) }),
      // The two slots are not platforms - they are where a copy of your own and
      // the household's favourite go - so they are not something to search.
      SLOTS.has(name)
        ? null
        : searchable.includes(name)
          ? h("input", {
              type: "checkbox",
              title: "Ask this platform when searching",
              "aria-label": `Ask ${name} when searching`,
              checked: searchDefault().includes(name),
              onchange: (event) => toggleSearchPlatform(name, event.target.checked),
            })
          : h("input", {
              type: "checkbox",
              disabled: true,
              checked: false,
              title: `${name} answers metadata only, so it cannot be searched`,
              "aria-label": `${name} cannot be searched`,
            }),
      h("button", {
        class: "btn small flat",
        title: "Move up",
        "aria-label": "Move up",
        disabled: index === 0,
        onclick: () => moveRanking(index, index - 1),
      }, icon("up", 14)),
      h("button", {
        class: "btn small flat",
        title: "Move down",
        "aria-label": "Move down",
        disabled: index === order.length - 1,
        onclick: () => moveRanking(index, index + 1),
      }, icon("down", 14))));
}

/**
 * The platforms a search asks by default: what the account chose, else the
 * built-in default of every searchable platform except YouTube.
 */
function searchDefault() {
  const chosen = Array.isArray(account?.searchPlatforms) ? account.searchPlatforms : [];
  if (chosen.length) return searchable.filter((name) => chosen.includes(name));
  return searchable.filter((name) => name !== "youtube");
}

/** Tick or untick a platform for searches, and save the account's choice. */
async function toggleSearchPlatform(name, on) {
  const next = new Set(searchDefault());
  if (on) next.add(name);
  else next.delete(name);
  const list = searchable.filter((entry) => next.has(entry));
  const client = currentClient();
  if (!client) return;
  try {
    await client.setSearchPlatforms(list);
    account = { ...account, searchPlatforms: list };
    // The shell holds the account too, and the search page reads its copy.
    await refreshMe().catch(() => {});
    toast("Search platforms saved.");
  } catch (error) {
    fail(error);
    // Put the box back where the account still says it is.
    if (ranking.list) mount(ranking.list, rankingRows());
  }
}

async function moveRanking(from, to) {
  const next = moveItem(ranking.order, from, to);
  if (next.every((name, index) => name === ranking.order[index])) return;
  const client = currentClient();
  if (!client) return;
  try {
    await client.setRanking(next);
    ranking = { ...ranking, order: next, own: true };
    if (ranking.list) mount(ranking.list, rankingRows());
    toast("Provider order saved.");
  } catch (error) {
    fail(error);
  }
}

// --- the guest ---------------------------------------------------------------

function guestCard(container) {
  container.appendChild(h("div", { class: "card" },
    h("div", { class: "empty" },
      h("span", { class: "icon", style: { display: "inline-flex", lineHeight: "0" } }, icon("gear", 38)),
      h("span", { class: "title", text: "Guest session" }),
      h("span", { text: "You are browsing this server as a guest, so there is no account here to edit. Sign in to change your display name, icon, providers and password." }),
      h("button", { class: "btn suggested", text: "Sign in", onclick: () => requireLogin() }))));
}

// --- failures ----------------------------------------------------------------

function fail(error) {
  if (error?.status === 401) {
    requireLogin();
    return;
  }
  banner(error?.message || String(error), "error");
}

// --- registration ------------------------------------------------------------

registerView({
  id: "account",
  title: "Account",
  icon: "\u2699",
  order: 80,
  render,
  refresh,
});
