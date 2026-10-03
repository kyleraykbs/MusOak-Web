// Which platforms a search asks.
//
// The list is whatever the server has enabled; which of them a search asks by
// default is the account's own setting, and the search page resets to it every
// time it is opened. YouTube is off unless the account says otherwise: its
// catalogue is enormous and noisy beside a music service, so including it by
// default would bury the results people want.

import { h, icon } from "./dom.js";

/** Platforms that stay out of a search until somebody ticks them. */
const OFF_BY_DEFAULT = new Set(["youtube"]);

/**
 * The platforms a search can actually ask, out of whatever `client.providers()`
 * handed back.
 *
 * That call answers with the list itself; the wrapper shape is accepted too, so
 * a caller that reads it differently still gets a list rather than a silent
 * empty one - which is what the filter showed when this was wrong. A platform
 * that cannot search is left out: Spotify answers metadata-only, so offering it
 * here would only ever produce an error line beside the results.
 */
export function enabledPlatforms(answer) {
  const list = Array.isArray(answer) ? answer : answer?.providers || [];
  return list.filter((provider) => provider?.name && provider?.capabilities?.search);
}

/**
 * The names that are ticked: the account's own choice when it has one, else
 * every platform except the ones that are off by default.
 *
 * `preferred` is what the account says (its `searchPlatforms`); an empty or
 * missing list means the account has never chosen.
 */
export function selectedPlatforms(providers = [], preferred = null) {
  const names = providers.map((provider) => provider.name).filter(Boolean);
  const chosen = Array.isArray(preferred) ? preferred.filter(Boolean) : [];
  if (chosen.length) return names.filter((name) => chosen.includes(name));
  return names.filter((name) => !OFF_BY_DEFAULT.has(name));
}

/**
 * What the filter button says: the platform's own name when a search asks
 * exactly one, a count when it asks several, and what it is doing at the ends
 * of the range.
 */
export function platformLabel(names = [], chosen = []) {
  const on = names.filter((name) => chosen.includes(name));
  if (!names.length) return "Platforms";
  if (on.length === 1) return on[0];
  if (on.length === names.length) return "All platforms";
  if (on.length === 0) return "No platforms";
  return `${on.length} platforms`;
}

/**
 * The platform filter: a button that says which platforms are on, and a panel
 * of checkboxes under it. The panel stays open while boxes are ticked - it is a
 * filter, not a menu - and closes when the click lands outside it.
 *
 * `providers` is the list the server reports, `preferred` the account's own
 * choice, and `onChange` is called with the ticked names whenever they change.
 */
export function platformFilter({ providers = [], preferred = null, onChange } = {}) {
  const names = providers.map((provider) => provider.name).filter(Boolean);
  let chosen = new Set(selectedPlatforms(providers, preferred));
  let panel = null;
  let open = false;

  const label = () => platformLabel(names, [...chosen]);

  const button = h("button", {
    class: "filter-button",
    type: "button",
    "aria-haspopup": "true",
    "aria-expanded": "false",
    title: "Choose which platforms a search asks",
  }, h("span", { text: label() }), icon("chevron-down", 14));

  const close = () => {
    if (!open) return;
    open = false;
    button.setAttribute("aria-expanded", "false");
    panel?.remove();
    panel = null;
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("resize", close);
  };

  function onOutside(event) {
    if (panel?.contains(event.target) || button.contains(event.target)) return;
    close();
  }

  function onKey(event) {
    if (event.key !== "Escape") return;
    // Escape closes this panel and goes no further: inside a dialog, it should
    // not take the dialog down with it.
    event.stopPropagation();
    close();
  }

  const toggle = (name) => {
    if (chosen.has(name)) chosen.delete(name);
    else chosen.add(name);
    for (const box of panel?.querySelectorAll("input[data-platform]") || []) {
      box.checked = chosen.has(box.dataset.platform);
    }
    button.firstChild.textContent = label();
    onChange?.([...chosen]);
  };

  const place = () => {
    if (!panel) return;
    const box = button.getBoundingClientRect();
    const width = Math.max(220, box.width);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.min(box.left, Math.max(8, window.innerWidth - width - 8))}px`;
    panel.style.top = `${box.bottom + 6}px`;
  };

  const openPanel = () => {
    if (open) {
      close();
      return;
    }
    open = true;
    button.setAttribute("aria-expanded", "true");
    panel = h(
      "div",
      { class: "popover platform-panel", role: "group", "aria-label": "Platforms" },
      names.length
        ? names.map((name) =>
            h(
              "label",
              { class: "platform-row" },
              h("input", {
                type: "checkbox",
                "data-platform": name,
                checked: chosen.has(name),
                onchange: () => toggle(name),
              }),
              h("span", { text: name })
            )
          )
        : h("div", { class: "menu-item", style: { color: "var(--gray)", cursor: "default" }, text: "No platforms enabled" })
    );
    document.body.appendChild(panel);
    place();
    setTimeout(() => {
      if (!open) return;
      document.addEventListener("mousedown", onOutside, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
    });
  };

  button.addEventListener("click", openPanel);

  return {
    node: button,
    /** The ticked names, for a search to pass along. */
    selected: () => names.filter((name) => chosen.has(name)),
    /** Re-read the account's choice, for a view that was rebuilt. */
    refresh: () => {
      chosen = new Set(selectedPlatforms(providers, preferred));
      button.firstChild.textContent = label();
    },
  };
}
