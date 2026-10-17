"""Every tab opens, and the bar is drawn rather than spelled.

Two real defects this file exists to hold shut:

* a view whose state was assigned to a name the window already owns. `History`
  kept its most-played list in a bare `top`, which is the window's own
  read-only accessor, so the tab died on "setting getter-only property top" and
  drew nothing;
* an icon that is not in the registry falls back to the *text* of its name, so
  the transport showed the words "shuffle" and "prev" laid over each other. A
  missing icon is a silent failure - `icon()` returns null and `iconButton`
  prints the name instead - so it is asserted here, once, for the buttons a
  person presses.
"""

from __future__ import annotations

from urllib.parse import quote

import pytest

from conftest import sign_in_ui

pytestmark = [pytest.mark.slow]

#: The tabs every signed-in account has, by the label a person reads.
TABS = ["Search", "Playlists", "Favourites", "History", "Queue", "Manage", "Friends", "Rooms", "Account"]

#: The bar's controls, by their tooltip. Each must draw an SVG rather than print
#: its own name, which is what `icon()` falling back to text looks like.
TRANSPORT = [
    "button[title='Previous']",
    "button[title='Next']",
    "button[title^='Shuffle']",
    "button[title='Song actions']",
]

#: The star and the room chip only exist once there is something to star or a
#: room to open, so they are asserted where they are, not required to be here.
OPTIONAL_TRANSPORT = ["button[title='Favourite']", "button[title='Lyrics']"]


def test_every_tab_opens_and_draws_something(ui, signed_in):
    sign_in_ui(ui, signed_in)
    ui.wait_quiet()
    for tab in TABS:
        ui.click_tab(tab)
        # The page is the tab's: the heading says which one, and the surface
        # under it holds something. A view that threw while rendering leaves the
        # surface empty - and puts the reason in the console, which
        # `assert_no_errors` reports as the failure it is.
        ui.wait(
            lambda: (ui.js("return document.querySelector('.topbar h1')?.textContent || '';") or "").strip() == tab,
            f"the {tab} tab never became the page",
        )
        ui.wait_js(
            "(document.querySelector('.view-surface')?.childElementCount || 0) > 0"
            " || !!document.querySelector('.view-sheet')",
            f"the {tab} tab drew nothing",
        )
        ui.assert_no_errors(f"the {tab} tab")


#: Two songs of the e2e build's fake provider: the drawer test restores a queue
#: that is long enough to scroll, with the song being played well down it.
DRAWER_A = "E2E Stream Three"
DRAWER_B = "E2E Stream Four"
#: Rows before the playing one, so the drawer cannot reach it by opening at the
#: top, and rows after it, so it can be centred rather than pinned to the end.
DRAWER_BEFORE = 15
DRAWER_AFTER = 8


def song_entry(backend, token, title):
    """One search hit as a saved-playback queue entry (the shape the GTK client writes)."""
    status, answer = backend.get(f"/api/v1/search?q={quote(title)}&limit=5", token=token)
    assert status == 200, f"the search for {title!r} answered {status}: {answer!r}"
    for group in (answer or {}).get("groups") or []:
        track = group.get("track") or {}
        if track.get("title") == title and track.get("id"):
            artists = track.get("artists") or []
            return {
                "trackId": track["id"],
                "title": track["title"],
                "artist": artists[0] if artists else "",
                "album": track.get("album") or "",
                "durationMs": track.get("durationMs") or 0,
                "artworkUrl": track.get("artworkUrl") or "",
            }
    raise AssertionError(f"the search never named {title!r}: {answer!r}")


def test_the_queue_drawer_opens_on_the_song_that_is_playing(ui, backend, signed_in):
    """A queue longer than the panel opens centred on the row that is playing.

    The queue is restored the way a person's is - the account's saved playback
    document - with the song on it sixteen rows down, so a drawer that opened at
    the top could not have it in view. Two songs, not one, because the row that
    is playing is the entry the document names, and copies of one song all name
    the same song.
    """
    a = song_entry(backend, signed_in.token, DRAWER_A)
    b = song_entry(backend, signed_in.token, DRAWER_B)
    queue = [a] * DRAWER_BEFORE + [b] + [a] * DRAWER_AFTER
    status, answer = backend.request(
        "PUT",
        "/api/v1/me/playback",
        {"state": {"queue": queue, "currentTrackId": b["trackId"], "positionMs": 0, "paused": True}},
        token=signed_in.token,
    )
    assert status in (200, 204), f"saving the queue answered {status}: {answer!r}"

    sign_in_ui(ui, signed_in)
    ui.reload()
    # The boot picks the queue up on its own; the bar naming the saved song is
    # that having happened.
    ui.wait(
        lambda: (ui.now_playing() or "") == DRAWER_B or None,
        "the page never picked the saved queue up",
        timeout=30.0,
    )

    ui.click(".queue-fab")
    ui.wait_css(
        ".drawer:not([hidden]) .row[data-playing='true']",
        "the open drawer never showed the song that is playing",
    )
    reading = ui.js(
        "const body = document.querySelector('.drawer-body');"
        "const row = document.querySelector('.drawer-body .row[data-playing=\"true\"]');"
        "const box = body.getBoundingClientRect();"
        "const line = row.getBoundingClientRect();"
        "return { scrollTop: Math.round(body.scrollTop),"
        "  off: Math.round((line.top + line.height / 2) - (box.top + box.height / 2)),"
        "  rows: body.querySelectorAll('.list .row').length,"
        "  at: [...body.querySelectorAll('.list .row')].findIndex((r) => r.dataset.playing === 'true') + 1,"
        "  height: Math.round(box.height) };"
    )
    assert reading["rows"] == len(queue), f"the drawer drew {reading['rows']} of the queue's rows: {reading!r}"
    assert reading["at"] == DRAWER_BEFORE + 1, f"the drawer is not marking the saved song's row: {reading!r}"
    assert reading["scrollTop"] > 0, f"the drawer opened at the top of the queue: {reading!r}"
    assert abs(reading["off"]) <= 60, f"the playing row is not in the middle of the panel: {reading!r}"
    ui.assert_no_errors("the queue drawer")


def test_the_transport_buttons_are_drawn_icons(ui, signed_in):
    sign_in_ui(ui, signed_in)
    ui.wait_quiet()
    for selector in TRANSPORT:
        ui.wait_css(selector, f"{selector} never appeared")
        assert ui.js(
            "const b = document.querySelector(arguments[0]);"
            "return b ? !!b.querySelector('svg') : false;",
            selector,
        ), f"{selector} shows text rather than a drawn icon"
    for selector in OPTIONAL_TRANSPORT:
        drawn = ui.js(
            "const b = document.querySelector(arguments[0]);"
            "if (!b || b.offsetParent === null) return true;"      # not on screen: nothing to draw
            "return !!b.querySelector('svg');",
            selector,
        )
        assert drawn, f"{selector} is showing text rather than a drawn icon"
    ui.assert_no_errors("the transport")