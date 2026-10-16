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