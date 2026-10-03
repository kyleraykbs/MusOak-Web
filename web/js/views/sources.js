// The source picker: which file a song comes from.
//
// The playbar's pill opens this: every source the song has, the official ones
// on top, then the ones people uploaded, each beside its votes. Picking one
// saves it to your account, which is what decides what plays from then on, and
// the last entry hands the song to the Manage tab to upload a file of your own.

import { banner, currentClient, navigate, requireLogin } from "../app.js";
import { state } from "../state.js";
import { clear, h, icon, dialog, toast } from "../dom.js";
import { platformFilter, enabledPlatforms } from "../platforms.js";

/**
 * The way out of a song with no source.
 *
 * Some songs arrive as metadata that matched nothing anywhere: they sit in a
 * playlist with nothing to play. This searches the platforms - through the same
 * filter the search page has - and attaches whichever result is picked to that
 * song, so it becomes playable where it stands rather than having to be found
 * again by name.
 */
export function findSourceDialog(track, { onDone } = {}) {
  const client = currentClient();
  if (!client || !track?.id) return;

  const results = h("div", { class: "find-source-results" });
  const input = h("input", {
    class: "input",
    type: "search",
    placeholder: "Search the platforms\u2026",
    onkeydown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        run();
      }
    },
  });
  let filter = platformFilter({ providers: [] });
  const filterRow = h("div", { class: "search-filter" }, filter.node);
  const note = h("div", { class: "subtitle", text: "" });

  /** One result: a rendition a provider offers, ready to be attached. */
  const candidateRow = (group, variant) => {
    const title = variant.title || group.track?.title || "";
    const artists = (variant.artists || group.track?.artists || []).join(", ");
    return h(
      "button",
      {
        class: "menu-item find-source-row",
        onclick: () => attach(variant, title, artists),
      },
      h("span", { class: "find-source-provider", text: variant.provider || "" }),
      h("span", { style: { flex: 1, minWidth: 0 } },
        h("span", { text: title }),
        artists ? h("span", { class: "subtitle", text: ` \u00b7 ${artists}` }) : null
      ),
      h("span", { class: "subtitle", text: fmtDuration(variant.durationMs || 0) })
    );
  };

  const attach = async (variant, title, artists) => {
    note.textContent = `Attaching ${title}\u2026`;
    try {
      await client.associateSource(track.id, {
        provider: variant.provider,
        providerTrackId: variant.providerTrackId,
        title: variant.title || title,
        artists: variant.artists || [],
        album: variant.album || "",
        durationMs: variant.durationMs || 0,
      });
      toast(`${title} is now a source of this song.`);
      close();
      onDone?.();
    } catch (error) {
      note.textContent = error?.message || String(error);
    }
  };

  const run = async () => {
    const query = input.value.trim();
    if (!query) return;
    note.textContent = "Searching\u2026";
    clear(results);
    try {
      const answer = await client.search(query, 25, filter.selected());
      const rows = [];
      for (const group of answer.groups || []) {
        if (group?.userUpload) continue; // an upload is already a source
        for (const variant of group.variants || []) {
          // Only what can actually be played is worth offering.
          if (variant?.downloadable) rows.push(candidateRow(group, variant));
        }
      }
      clear(results);
      if (!rows.length) {
        note.textContent = "Nothing playable matched. Try the other platforms, or a different spelling.";
        return;
      }
      note.textContent = "";
      for (const row of rows) results.appendChild(row);
    } catch (error) {
      note.textContent = error?.message || String(error);
    }
  };

  const { close } = dialog({
    title: "Find a source",
    body: h(
      "div",
      { class: "find-source" },
      h("p", {
        text: `\u201c${track.title || "This song"}\u201d has no source that can be played. Search the platforms and pick the one it is.`,
      }),
      filterRow,
      h("div", { style: { display: "flex", gap: "8px" } }, input, h("button", { class: "btn", text: "Search", onclick: run })),
      note,
      results
    ),
    actions: [{ label: "Close", onClick: () => close() }],
    onOpen: () => input.focus(),
  });

  // The filter cannot offer platforms until the server has said which it has.
  client
    .providers()
    .then((answer) => {
      const list = enabledPlatforms(answer);
      if (!list.length) return;
      filter = platformFilter({ providers: list, preferred: state.user?.searchPlatforms });
      filterRow.replaceChildren(filter.node);
    })
    .catch(() => {});
}

/** A duration as m:ss, for a result row. */
function fmtDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

/** A source's score: what orders the two groups. */
export function netVotes(source) {
  return (Number(source?.upvotes) || 0) - (Number(source?.downvotes) || 0);
}

/** What a source is called: the person who uploaded it, or the provider. */
export function sourceLabel(source) {
  if (!source) return "";
  let name = "";
  if (!source.official) {
    const uploader = source.uploader || {};
    name = uploader.displayName || uploader.username || "";
  }
  if (!name) name = String(source.provider || "source");
  // One song can have two copies from one place - two uploads by one person, or
  // two ytmusic renditions - and the name alone draws the same row twice. Their
  // lengths are what differ, so the length is what names them apart.
  const ms = Number(source.durationMs) || 0;
  return ms > 0 ? `${name} \u00b7 ${fmtDuration(ms)}` : name;
}

/**
 * The sources as the picker shows them: the official ones first, then the
 * uploaded ones, each group by net votes descending. The server's own order
 * decides ties, so a source never jumps around between two loads.
 */
export function groupSources(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const ranked = list
    .map((source, index) => ({ source, index }))
    .sort((left, right) => {
      const official =
        Number(Boolean(right.source.official)) - Number(Boolean(left.source.official));
      if (official) return official;
      const votes = netVotes(right.source) - netVotes(left.source);
      if (votes) return votes;
      return left.index - right.index;
    })
    .map((entry) => entry.source);
  return {
    official: ranked.filter((source) => source.official),
    user: ranked.filter((source) => !source.official),
  };
}

/**
 * The source in use: the one saved to the account, else the default one, else
 * the first source there is.
 */
export function pickSource(sources, preferredVariantId = "") {
  const list = Array.isArray(sources) ? sources : [];
  if (preferredVariantId) {
    const preferred = list.find((source) => source.variantId === preferredVariantId);
    if (preferred) return preferred;
  }
  const flagged = list.find((source) => source.default);
  if (flagged) return flagged;
  return list[0] || null;
}

/**
 * The picker, anchored under the playbar's source pill.
 *
 * `onChange` is told when a source was picked, so the bar can say so at once.
 * Returns {close, node}.
 */
export function openSourcePicker(anchor, track, onChange = null, { playingVariantId = "" } = {}) {
  if (!anchor || !track?.id) return null;

  const panel = h("div", { class: "popover", role: "menu", style: { visibility: "hidden" } });
  const data = { sources: [], preferredVariantId: "", notice: "" };
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", close);
    window.removeEventListener("scroll", close, true);
    window.visualViewport?.removeEventListener("resize", place);
    window.visualViewport?.removeEventListener("scroll", place);
    panel.remove();
  };
  const onOutside = (event) => {
    if (!panel.contains(event.target) && event.target !== anchor) close();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };

  // The part of the screen you can actually see. The app shell is measured the
  // same way, so the two agree on where the bar has ended up.
  const viewport = () => {
    const view = window.visualViewport;
    return view
      ? { top: view.offsetTop, left: view.offsetLeft, width: view.width, height: view.height }
      : { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  };

  const place = () => {
    panel.style.visibility = "";
    const view = viewport();
    const box = anchor.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    const top = Math.min(box.bottom + 6, view.top + view.height - size.height - 10);
    const left = Math.max(view.left + 8, Math.min(box.left, view.left + view.width - size.width - 10));
    panel.style.top = `${Math.max(view.top + 8, top)}px`;
    panel.style.left = `${left}px`;
  };

  const report = (error) => {
    if (error?.status === 401) requireLogin();
    else banner(error?.message || String(error), "error");
  };

  const load = async () => {
    const client = currentClient();
    if (!client) {
      data.notice = "no server selected";
      render();
      return;
    }
    try {
      const { sources, preferredVariantId } = await client.sources(track.id);
      data.sources = sources;
      data.preferredVariantId = preferredVariantId;
      data.notice = "";
    } catch (error) {
      report(error);
      data.notice = error?.message || "could not load the sources";
    }
    render();
  };

  const pick = async (source) => {
    const variantId = String(source.variantId || "");
    if (!variantId) return;
    // The marker moves at once, so the pick is visible where it was made.
    data.preferredVariantId = variantId;
    render();
    try {
      await currentClient().preferVariant(track.id, variantId);
    } catch (error) {
      report(error);
    }
    // Tell the bar only once the server has it. The bar re-reads the sources
    // when it hears, and a read that beats the write reports the source that
    // was chosen before - which is what "it shows one behind" was.
    onChange?.(variantId);
    await load();
  };

  const vote = async (source, value) => {
    const variantId = String(source.variantId || "");
    if (!variantId) return;
    // Voting the same way again withdraws the vote, as on the playbar.
    const wanted = Number(source.myVote || 0) === value ? 0 : value;
    source.myVote = wanted;
    render();
    try {
      await currentClient().voteVariant(variantId, wanted);
    } catch (error) {
      report(error);
    }
    await load();
  };

  const voteButton = (source, value) => {
    const label = value > 0 ? "Upvote this source" : "Downvote this source";
    return h(
      "button",
      {
        class: "btn flat small",
        title: label,
        "aria-label": label,
        "aria-pressed": Number(source.myVote || 0) === value ? "true" : "false",
        onclick: () => vote(source, value),
      },
      icon(value > 0 ? "up" : "down", 14),
      h("span", { text: String(value > 0 ? Number(source.upvotes) || 0 : Number(source.downvotes) || 0) })
    );
  };

  const row = (source, current) => {
    const inUse = Boolean(current && current.variantId === source.variantId);
    return h(
      "div",
      { class: "menu-item", style: { gap: "6px" } },
      h(
        "button",
        {
          class: "btn flat small",
          style: {
            flex: "1", minWidth: "0", justifyContent: "flex-start", textAlign: "left", overflow: "hidden",
          },
          title: source.title || "",
          onclick: () => pick(source),
        },
        h("span", {
          style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          text: sourceLabel(source),
        }),
        inUse ? h("span", { class: "tag", style: { marginLeft: "8px", flex: "none" }, text: "default" }) : null,
        // What is playing right now, which in a room is the room's rendition
        // and not necessarily this member's preference.
        String(source.variantId) === String(playingVariantId)
          ? h("span", { class: "tag", style: { marginLeft: "8px", flex: "none" }, text: "playing" })
          : null,
        // A source this server cannot fetch is still worth preferring - it is
        // where the song is, if the app ever has it - but it will not play.
        source.downloadable === false
          ? h("span", { class: "subtitle", style: { marginLeft: "8px", flex: "none" }, text: "not playable" })
          : null
      ),
      voteButton(source, 1),
      voteButton(source, -1)
    );
  };

  const render = () => {
    clear(panel);
    const { official, user } = groupSources(data.sources);
    const current = pickSource(data.sources, data.preferredVariantId);

    if (!data.sources.length) {
      panel.appendChild(
        h("div", {
          class: "menu-item",
          style: { color: "var(--gray)", cursor: "default" },
          text: data.notice || "Loading…",
        })
      );
    }
    for (const source of official) panel.appendChild(row(source, current));
    if (official.length && user.length) panel.appendChild(h("div", { class: "menu-separator" }));
    for (const source of user) panel.appendChild(row(source, current));
    if (data.sources.length) panel.appendChild(h("div", { class: "menu-separator" }));

    panel.appendChild(
      h(
        "button",
        {
          class: "menu-item",
          onclick: () => {
            close();
            // The song has a source now: the picker reloads, and the bar is
            // told so it can retry a track that failed for want of one.
            findSourceDialog(track, {
              onDone: () => {
                load();
                onChange?.();
              },
            });
          },
        },
        h("span", { style: { width: "18px", textAlign: "center" } }, icon("search", 14)),
        "Find a source\u2026"
      )
    );
    panel.appendChild(
      h(
        "button",
        {
          class: "menu-item",
          onclick: () => {
            close();
            navigate("manage", { associateTrackId: track.id });
          },
        },
        h("span", { style: { width: "18px", textAlign: "center" } }, icon("upload", 14)),
        "Upload a source\u2026"
      )
    );
    if (!closed) place();
  };

  document.body.appendChild(panel);
  render();
  setTimeout(() => {
    if (closed) return;
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    // A phone's chrome sliding away, or the keyboard, changes the visible area
    // without a window resize: follow it, so the panel stays above the bar.
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
  });
  load();

  return { close, node: panel };
}
