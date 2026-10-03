// Friends: finding people, the requests between you, and the friend page.
//
// Three sub-tabs — Friends, Search, Requests — and one row shape for a person:
// icon, display name over their username, what they are playing, and whether
// they are around. The API decides "around" with its `online` flag (they played
// something within the last five minutes).

import { h, mount, popover, confirm, debounce, toast, icon, iconButton } from "../dom.js";
import { registerView, navigate, currentClient, banner, requireLogin } from "../app.js";
import { state } from "../state.js";
import {
  avatarFor, displayName, isOnline, listeningLine, relationshipLabel, sortFriends,
} from "./share.js";
import { renderFriend } from "./friend.js";

/** Typing should search without being asked, but every keystroke is a round
 *  trip, so wait for a pause first. */
const TYPING_PAUSE_MS = 500;
/** One letter is not worth a round trip while typing, but is a fine thing to
 *  ask for on purpose. */
const MIN_QUERY = 2;

const TABS = [
  { id: "friends", label: "Friends" },
  { id: "search", label: "Search" },
  { id: "requests", label: "Requests" },
];

/** Which tab is open. Decided on the first render, then the reader's to change. */
let activeTab = "";
/** Friend requests waiting, which is what the Requests tab's badge counts. */
let waiting = 0;
let query = "";
/** Bumped per load, so a slow answer cannot land in a later tab's list. */
let generation = 0;
let bodyEl = null;
let searchInput = null;
let searchStatus = null;
let searchResults = null;
/** Re-runs whatever the tab on screen shows. */
let reload = null;

// --- small builders --------------------------------------------------------

function fail(error) {
  if (error?.status === 401) requireLogin();
  else banner(error?.message || String(error), "error");
}

/** The empty state takes the name of a drawn icon, not a typed glyph. */
function emptyState(name, title, subtitle) {
  return h(
    "div",
    { class: "empty" },
    h("span", { class: "icon" }, icon(name, 38)),
    h("span", { class: "title", text: title }),
    subtitle ? h("span", { text: subtitle }) : null
  );
}

function loading(text) {
  return h("div", { class: "empty" }, h("span", { class: "title", text }));
}

/** The answer failed: say what happened where the list was, and banner it. */
function showError(node, title, error) {
  mount(node, emptyState("cross", title, error?.message || String(error)));
  fail(error);
}

function menuButton(open) {
  return iconButton("dots", {
    class: "btn flat small",
    title: "More",
    onclick: (event) => {
      event.stopPropagation();
      open(event.currentTarget);
    },
  });
}

function actionButton(label, className, run) {
  return h("button", {
    class: `btn small${className ? ` ${className}` : ""}`,
    text: label,
    onclick: (event) => {
      event.stopPropagation();
      run();
    },
  });
}

function section(title, rows) {
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: "8px" } },
    h("h2", { class: "section-title", text: title }),
    h("div", { class: "list" }, rows)
  );
}

/** Icon, name over username, their song, and whether they are around. */
function userRow(client, user, { onOpen, trailing = [] } = {}) {
  const listening = listeningLine(user);
  const online = isOnline(user);
  return h(
    "div",
    { class: "row clickable", title: "Open their page", onclick: onOpen },
    avatarFor(client, user),
    h(
      "div",
      { style: { flex: 1, minWidth: 0 } },
      h("div", { class: "title", text: displayName(user) }),
      h("div", { class: "subtitle", text: user?.username ? `@${user.username}` : "" }),
      listening ? h("div", { class: "subtitle", text: listening }) : null
    ),
    h("span", {
      class: `status-dot ${online ? "online" : "offline"}`,
      title: online ? "Online" : "Offline",
    }),
    h("span", { class: "subtitle", text: online ? "Online" : "Offline" }),
    ...trailing
  );
}

function openUser(user) {
  navigate("friends", { userId: String(user?.id || "") });
}

// --- the three tabs --------------------------------------------------------

async function loadFriends() {
  reload = loadFriends;
  const client = currentClient();
  if (!bodyEl) return;
  const mine = ++generation;
  mount(bodyEl, loading("Loading your friends\u2026"));
  if (!client) {
    mount(bodyEl, emptyState("users", "No server", "Choose a backend to see your friends."));
    return;
  }
  let payload;
  try {
    payload = await client.friends();
  } catch (error) {
    if (mine === generation && bodyEl) showError(bodyEl, "Could not load your friends", error);
    return;
  }
  if (mine !== generation || !bodyEl) return;
  const friends = sortFriends(payload?.friends || []);
  if (!friends.length) {
    mount(
      bodyEl,
      emptyState("users", "No friends yet", "Find people under Search and send them a request.")
    );
    return;
  }
  mount(
    bodyEl,
    h(
      "div",
      { class: "list" },
      friends.map((user) =>
        userRow(client, user, {
          onOpen: () => openUser(user),
          trailing: [menuButton((anchor) => friendMenu(client, user, anchor))],
        })
      )
    )
  );
}

async function loadRequests() {
  reload = loadRequests;
  const client = currentClient();
  if (!bodyEl) return;
  const mine = ++generation;
  mount(bodyEl, loading("Loading requests\u2026"));
  if (!client) {
    mount(bodyEl, emptyState("send", "No server", "Choose a backend to see your requests."));
    return;
  }
  let payload;
  try {
    payload = await client.friends();
  } catch (error) {
    if (mine === generation && bodyEl) showError(bodyEl, "Could not load your requests", error);
    return;
  }
  // This list is the count the tab's badge shows, so keep them the same.
  waiting = (payload?.incoming || []).length;
  if (mine !== generation || !bodyEl) return;
  const incoming = payload?.incoming || [];
  const outgoing = payload?.outgoing || [];
  if (!incoming.length && !outgoing.length) {
    mount(bodyEl, emptyState("send", "No requests", "Requests to be your friend land here."));
    return;
  }
  const parts = [];
  if (incoming.length) {
    parts.push(
      section(
        "Incoming requests",
        incoming.map((user) =>
          userRow(client, user, {
            onOpen: () => openUser(user),
            trailing: [
              actionButton("Accept", "suggested", () => acceptRequest(client, user)),
              actionButton("Decline", "", () => declineRequest(client, user)),
            ],
          })
        )
      )
    );
  }
  if (outgoing.length) {
    parts.push(
      section(
        "Sent requests",
        outgoing.map((user) =>
          userRow(client, user, {
            onOpen: () => openUser(user),
            trailing: [h("span", { class: "subtitle", text: "Pending" })],
          })
        )
      )
    );
  }
  mount(bodyEl, parts);
}

function loadSearch() {
  searchInput = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search people by name or username",
    value: query,
  });
  searchStatus = h("div", { class: "subtitle" });
  searchResults = h("div");
  mount(
    bodyEl,
    h(
      "div",
      { style: { display: "flex", gap: "8px", alignItems: "center" } },
      searchInput,
      h("button", {
        class: "btn",
        text: "Search",
        title: "Search again",
        onclick: () => runSearch(true),
      })
    ),
    searchStatus,
    searchResults
  );
  reload = () => runSearch(true);
  searchInput.addEventListener("input", debounce(() => runSearch(false), TYPING_PAUSE_MS));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") runSearch(true);
  });
  runSearch(false);
}

/** What you can do with this person, given how you already relate. */
function searchExtras(client, user) {
  const relationship = String(user?.relationship || "none");
  if (relationship === "none") {
    return [actionButton("Add friend", "suggested", () => sendRequest(client, user))];
  }
  const label = relationshipLabel(relationship);
  return label ? [h("span", { class: "subtitle", text: label })] : [];
}

async function runSearch(force = false) {
  if (!searchInput || !searchResults || !searchStatus) return;
  const client = currentClient();
  const wanted = searchInput.value.trim();
  query = wanted;
  const mine = ++generation;
  if (!wanted) {
    searchStatus.textContent = "";
    mount(searchResults, emptyState("search", "Find people", "Search by display name or username."));
    return;
  }
  if (wanted.length < MIN_QUERY && !force) {
    searchStatus.textContent = "Keep typing\u2026";
    mount(searchResults);
    return;
  }
  if (!client) {
    searchStatus.textContent = "";
    mount(searchResults, emptyState("search", "No server", "Choose a backend to search people."));
    return;
  }
  searchStatus.textContent = `Looking for \u201c${wanted}\u201d\u2026`;
  mount(searchResults);
  let users = [];
  try {
    users = await client.searchUsers(wanted);
  } catch (error) {
    if (mine === generation && searchResults) {
      searchStatus.textContent = "";
      showError(searchResults, "Could not search people", error);
    }
    return;
  }
  if (mine !== generation || !searchResults) return;
  if (!users.length) {
    searchStatus.textContent = "";
    mount(searchResults, emptyState("search", "No one found", "Try another name."));
    return;
  }
  searchStatus.textContent = `${users.length} result${users.length === 1 ? "" : "s"}.`;
  mount(
    searchResults,
    h(
      "div",
      { class: "list" },
      users.map((user) =>
        userRow(client, user, { onOpen: () => openUser(user), trailing: searchExtras(client, user) })
      )
    )
  );
}

// --- what you can do with a person ----------------------------------------

async function sendRequest(client, user) {
  try {
    await client.addFriend(user.username);
    toast(`Friend request sent to ${displayName(user)}.`);
    reload?.();
  } catch (error) {
    fail(error);
  }
}

async function acceptRequest(client, user) {
  try {
    await client.acceptFriend(user.id);
    toast(`You are now friends with ${displayName(user)}.`);
    reload?.();
  } catch (error) {
    fail(error);
  }
}

async function declineRequest(client, user) {
  try {
    await client.removeFriend(user.id);
    toast(`Turned down the request from ${displayName(user)}.`);
    reload?.();
  } catch (error) {
    fail(error);
  }
}

async function ignore(client, user) {
  try {
    await client.ignoreUser(user.id);
    toast(`Ignored ${displayName(user)}. Their shares stop reaching you.`);
    reload?.();
  } catch (error) {
    fail(error);
  }
}

async function unignore(client, user) {
  try {
    await client.unignoreUser(user.id);
    toast(`Unignored ${displayName(user)}. Their shares reach you again.`);
    reload?.();
  } catch (error) {
    fail(error);
  }
}

async function unfriend(client, user) {
  const confirmed = await confirm(
    "Unfriend?",
    `${displayName(user)} is removed from your friends.`,
    { confirm: "Unfriend", destructive: true }
  );
  if (!confirmed) return;
  try {
    await client.removeFriend(user.id);
    toast(`Unfriended ${displayName(user)}.`);
    reload?.();
  } catch (error) {
    fail(error);
  }
}

function friendMenu(client, user, anchor) {
  const ignored = String(user?.relationship || "") === "ignored";
  popover(anchor, [
    { label: "Open their page", onClick: () => openUser(user) },
    { separator: true },
    {
      label: ignored ? "Unignore" : "Ignore",
      onClick: () => (ignored ? unignore(client, user) : ignore(client, user)),
    },
    { label: "Unfriend", onClick: () => unfriend(client, user) },
  ]);
}

// --- the view --------------------------------------------------------------

function tabBar(container) {
  return h(
    "div",
    { class: "tabs" },
    TABS.map((tab) =>
      h(
        "button",
        {
          class: `tab${activeTab === tab.id ? " active" : ""}`,
          onclick: () => {
            if (activeTab === tab.id) return;
            activeTab = tab.id;
            render(container, {});
          },
        },
        h("span", { text: tab.label }),
        // The count is what is waiting, which is not what the tab on screen
        // shows: whoever is looking at Search still wants to know.
        tab.id === "requests" && waiting > 0
          ? h("span", { class: "badge", text: waiting > 99 ? "99+" : String(waiting) })
          : null
      )
    )
  );
}

/**
 * How many friend requests are waiting, for the tab's badge. It is asked for
 * whenever the page opens and after one is answered, not on a timer: the count
 * only changes when somebody sends or answers one.
 */
async function loadWaiting() {
  const client = currentClient();
  if (!client) {
    waiting = 0;
    return;
  }
  try {
    const payload = await client.friends();
    waiting = (payload?.incoming || []).length;
  } catch {
    waiting = 0;
  }
}

function showTab() {
  if (activeTab === "friends") loadFriends();
  else if (activeTab === "requests") loadRequests();
  else loadSearch();
}

/**
 * Which tab the page opens on: the friends somebody has, or the way to find
 * them. Somebody with nobody to show wants to search; everybody else wants the
 * list.
 */
async function openingTab() {
  const client = currentClient();
  if (!client) return "search";
  try {
    const payload = await client.friends();
    return (payload?.friends || []).length ? "friends" : "search";
  } catch {
    // A guest, or a server that will not say: searching is the way in.
    return "search";
  }
}

function render(container, params = {}) {
  // A userId means the friend page; the tab rows navigate here with one.
  if (params?.userId) {
    bodyEl = null;
    searchInput = null;
    searchStatus = null;
    searchResults = null;
    reload = renderFriend(container, String(params.userId));
    return;
  }
  // A tab named by whoever sent us here: a notification about a request wants
  // the tab where it is answered, not whichever tab was last open.
  if (params?.tab && TABS.some((tab) => tab.id === params.tab)) activeTab = String(params.tab);
  bodyEl = h("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } });
  if (activeTab) {
    mount(container, tabBar(container), bodyEl);
    showTab();
    countWaiting(container);
    return;
  }
  // Which tab to open on takes a round trip; the bar is drawn once it is known.
  mount(container, loading("Loading\u2026"));
  openingTab().then((tab) => {
    if (activeTab) return; // they picked one while we asked
    activeTab = tab;
    mount(container, tabBar(container), bodyEl);
    showTab();
    countWaiting(container);
  });
}

/** Ask how many requests are waiting, and redraw the bar when the answer lands. */
async function countWaiting(container) {
  await loadWaiting();
  if (state.view !== "friends" || !bodyEl) return;
  mount(container, tabBar(container), bodyEl);
}

registerView({
  // People are what this shows, so it re-reads them on the notification tick.
  live: true,
  id: "friends",
  title: "Friends",
  icon: "\u263a",
  order: 60,
  render,
  refresh: () => reload?.(),
});
