"""Favourites, ratings and the listening history: what a person records.

These are the screens that survive a reload and outlive a session, so each one
is asserted *after* a reload as well as before it - a rating that is only in the
page's memory looks identical to one the server kept, until the tab is closed.

The star and the rating are one control here (a song is a favourite because it
has a rating), which is why "unfavourite" is the dialog's own Remove.
"""

from __future__ import annotations

import uuid

import pytest

from conftest import sign_in_ui
from journeys import open_favourites, person, press, press_bar, titles
from test_account_edges import _tagged_tone, _upload
from test_library import Account, wait_sounding

pytestmark = [pytest.mark.slow]

RATING_DIALOG = "//*[contains(@class,'dialog')]"


def _set_rating(ui, value):
    """Put the dialog's own slider at a rating, as a hand would."""
    ui.js(
        "const input = document.querySelector('.dialog-backdrop input.rating-range');"
        "if (!input) return null;"
        f"input.value = '{value}';"
        "input.dispatchEvent(new Event('input', { bubbles: true }));"
        "return input.value;"
    )


def _click_in_row(ui, title, selector):
    """Click a control inside the row named `title`, by the app's own click.

    A row is a click target of its own, so WebDriver's actionability check
    ("is something else on top of this?") answers about the row rather than the
    button inside it. The button is the thing a person presses, so it is the
    thing that is clicked.
    """
    clicked = ui.js(
        "const row = [...document.querySelectorAll('.content .row')]"
        ".find((el) => (el.querySelector('.title')?.textContent || '').trim() === arguments[0]);"
        "const button = row?.querySelector(arguments[1]);"
        "let error = '';"
        "try { if (button) button.click(); } catch (thrown) { error = String(thrown && (thrown.stack || thrown.message) || thrown); }"
        "window.__clickError = error;"
        "return Boolean(button);",
        title,
        selector,
    )
    assert clicked, f"{selector!r} was not there in the row for {title!r}"
    return ui


def _open_rating(ui, title):
    """A row's own rating control, from the favourites list."""
    _click_in_row(ui, title, ".favourites-rating-edit")
    # The slider is transparent (the stars are the picture), so it is waited for
    # by being *there* rather than by Selenium's idea of visible.
    ui.wait(
        lambda: ui.has(".dialog-backdrop input.rating-range") or None,
        f"the rating star for {title!r} never opened its dialog",
        timeout=15,
    )


def _click_menu_item(ui, label):
    clicked = ui.js(
        "const item = [...document.querySelectorAll('.menu-item')]"
        ".find((el) => (el.textContent || '').includes(arguments[0]));"
        "if (item) item.click();"
        "return Boolean(item);",
        label,
    )
    assert clicked, f"the {label!r} menu item never appeared"
    return ui


def _rating_text(ui, title):
    return ui.js(
        "const row = [...document.querySelectorAll('.content .row')]"
        f".find((el) => (el.querySelector('.title')?.textContent || '').trim() === {title!r});"
        "return row ? (row.querySelector('.favourites-rating')?.textContent || '').trim() : null;"
    )


def test_a_song_is_favourited_from_its_row_menu_and_removed_again(ui, backend, media_factory):
    """A plain search result: Rate from its own menu, find it in Favourites,
    then take the rating back and see it leave.

    "Favourite" here is the rating itself, so the menu action, the list and the
    dialog's Remove are one round trip. It must not need the song to be on the
    list first, and the removal must reach the account, not just this page.
    """
    delta = uuid.uuid4().hex[:6]
    account = Account(backend, prefix="rowmenu")
    title = f"Rowmenu Song {delta}"
    artist = f"Rowmenu Artist {delta}"
    album = f"Rowmenu Album {delta}"
    _upload(
        backend,
        account.token,
        _tagged_tone(backend, title, artist, album, 6, 360),
        title,
        [artist],
        album,
    )
    sign_in_ui(ui, account)

    ui.click_tab("Search")
    ui.type("input[placeholder='Search tracks']", title)
    ui.wait(lambda: title in (titles(ui) or []), f"the search never found {title!r}", timeout=20)
    _click_in_row(ui, title, "button[title='More actions'], button[title='More']")
    _click_menu_item(ui, "Rate")
    ui.wait(lambda: ui.has(".dialog-backdrop input.rating-range") or None, "the rating dialog never opened", timeout=15)
    _set_rating(ui, "4.5")
    # A new favourite's dialog says Rate; an existing one's says Save.
    ui.click_xpath(
        f"{RATING_DIALOG}//button[normalize-space(.)='Rate' or normalize-space(.)='Save']",
        "the rating dialog's commit button",
    )

    ui.click_tab("Favourites")
    ui.wait(lambda: title in (titles(ui) or []), f"{title!r} never appeared in Favourites", timeout=20)
    assert _rating_text(ui, title) == "4.5/5.0", f"the new favourite says {_rating_text(ui, title)!r}"

    _open_rating(ui, title)
    ui.click_xpath(f"{RATING_DIALOG}//button[normalize-space(.)='Remove rating']", "the dialog's Remove")
    ui.wait(lambda: title not in (titles(ui) or []), f"{title!r} stayed in Favourites", timeout=15)

    ui.reload()
    ui.wait_shell()
    open_favourites(ui, 0)
    assert title not in (titles(ui) or []), "the removal did not survive the reload"
    ui.assert_no_errors("favouriting from a row menu and removing it")


def test_a_rating_survives_a_reload(ui, backend, media_factory):
    """Rate a starred song 3.5 and reload: the row still says 3.5/5.0.

    The rating is the account's, not the page's, so a reload must not lose it -
    and the row must paint it the same way the dialog wrote it.
    """
    someone = person(backend, media_factory, "rate", lengths=(6,))
    sign_in_ui(ui, someone)
    order = open_favourites(ui, 1)
    title = order[0]

    _open_rating(ui, title)
    _set_rating(ui, "3.5")
    ui.click_xpath(f"{RATING_DIALOG}//button[normalize-space(.)='Save']", "the dialog's Save")
    ui.wait(
        lambda: (_rating_text(ui, title) or "") == "3.5/5.0",
        f"the row never said 3.5/5.0, it said {_rating_text(ui, title)!r}",
        timeout=15,
    )

    ui.reload()
    ui.wait_shell()
    open_favourites(ui, 1)
    assert _rating_text(ui, title) == "3.5/5.0", "the rating did not survive the reload"
    ui.assert_no_errors("rating a song and reloading")


def test_the_rating_filter_hides_what_is_below_it(ui, backend, media_factory):
    """Rate one song high and one low, then ask the list for four stars.

    The filter is the reason ratings exist: it must narrow the list to what
    clears it, and put everything back when it is released.
    """
    someone = person(backend, media_factory, "filter", lengths=(6, 7))
    sign_in_ui(ui, someone)
    order = open_favourites(ui, 2)
    high, low = order[0], order[1]

    for title, value in ((high, "4.5"), (low, "1.0")):
        _open_rating(ui, title)
        _set_rating(ui, value)
        ui.click_xpath(f"{RATING_DIALOG}//button[normalize-space(.)='Save']", "the dialog's Save")
        ui.wait(
            lambda: (_rating_text(ui, title) or "").startswith(value),
            f"the row for {title!r} never showed {value}",
            timeout=15,
        )

    ui.js(
        "const input = document.querySelector('input[aria-label=\"Filter favourites by minimum rating\"]');"
        "if (!input) return null;"
        "input.value = '4';"
        "input.dispatchEvent(new Event('input', { bubbles: true }));"
        "return input.value;"
    )
    ui.wait(
        lambda: titles(ui) == [high],
        f"a four-star filter drew {titles(ui)}, want only {high!r}",
        timeout=15,
    )

    ui.js(
        "const input = document.querySelector('input[aria-label=\"Filter favourites by minimum rating\"]');"
        "if (!input) return null;"
        "input.value = '0';"
        "input.dispatchEvent(new Event('input', { bubbles: true }));"
        "return input.value;"
    )
    ui.wait(lambda: len(titles(ui)) == 2, "releasing the filter did not put both rows back", timeout=15)
    ui.assert_no_errors("filtering favourites by rating")


def test_removing_the_rating_takes_the_song_out_of_favourites(ui, backend, media_factory):
    """The row menu's rating action opens the dialog, and Remove unfavourites.

    A song is a favourite because it has a rating here, so taking the rating
    back is taking the song off this list - and it must stay off after a reload.
    """
    someone = person(backend, media_factory, "unfav", lengths=(6, 7))
    sign_in_ui(ui, someone)
    order = open_favourites(ui, 2)
    doomed = order[0]

    _click_in_row(ui, doomed, "button[title='More actions']")
    probe = ui.js("return {popovers: document.querySelectorAll('.popover').length, items: [...document.querySelectorAll('.menu-item')].map((el) => el.textContent.trim())};")
    assert probe.get("popovers"), f"the row menu never opened: {probe}"
    rating_item = next((item for item in probe["items"] if item.startswith(("Rate", "Rating"))), "")
    assert rating_item, f"the row menu offers no rating action: {probe}"

    _click_menu_item(ui, rating_item[:6])
    ui.wait(lambda: ui.has(".dialog-backdrop input.rating-range") or None, "the rating dialog never opened", timeout=15)
    ui.click_xpath(f"{RATING_DIALOG}//button[normalize-space(.)='Remove rating']", "the dialog's Remove")
    ui.wait(lambda: doomed not in titles(ui), f"{doomed!r} is still in favourites", timeout=15)

    ui.reload()
    ui.wait_shell()
    open_favourites(ui, 1)
    assert doomed not in titles(ui), "the unfavourite did not survive the reload"
    ui.assert_no_errors("unfavouriting from the row menu")


def test_the_history_holds_what_was_just_played(ui, backend, media_factory):
    """Play through two songs and ask the history what it heard.

    The history is written when a track changes, so this asserts the whole
    chain: playback, the listen report, the server's record, and the view that
    draws it - for songs a person actually listened to.
    """
    someone = person(backend, media_factory, "history", lengths=(6, 7, 8))
    sign_in_ui(ui, someone)
    order = open_favourites(ui, 3)
    press(ui, "Play")
    wait_sounding(ui, order[0], someone.seconds(order[0]))
    # The third song starting is the proof that two listens have ended.
    wait_sounding(ui, order[2], someone.seconds(order[2]), timeout=40)

    press_bar(ui, "Pause")
    ui.click_tab("History")
    ui.wait(
        lambda: set(order[:2]) <= set(titles(ui)),
        f"the history drew {titles(ui)}, want {order[:2]}",
        timeout=20,
    )
    # Newest first: the second song is above the first.
    drawn = titles(ui)
    assert drawn.index(order[1]) < drawn.index(order[0]), f"the history is not newest first: {drawn}"
    ui.assert_no_errors("reading the history after playing")