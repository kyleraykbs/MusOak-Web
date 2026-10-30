"""Editing a playlist: make one, fill it, reorder it, prune it, rename it.

The order a person gives a playlist is the order it must play in, and all of it
has to still be true after a reload - it is the server's order, not the page's.
The long-list test is the other side of the same coin: a playlist that is too
big to fit on the page must still be readable and playable to its end.

The provider-only half - an album whose release is longer than what the library
holds, and the "not synced yet" line that says so - has no way to be made here
(providers are off and nothing in the API creates a provider release), so it
lives in the API's own test, `TestAnUnopenedAlbumSaysItIsNotWhole`.
"""

from __future__ import annotations

import base64
import os
import struct
import subprocess
import time
import uuid

import pytest

from conftest import sign_in_ui
from journeys import PASSWORD, drag_row, press, queue_titles, titles
from test_library import Account, wait_sounding

pytestmark = [pytest.mark.slow]

DIALOG = "//*[contains(@class,'dialog')]"


def _tone(backend, title, artist, album, seconds, frequency):
    path = os.path.join(backend.media_dir, f"{uuid.uuid4().hex[:8]}-{frequency}.ogg")
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"sine=frequency={frequency}:duration={seconds}",
            "-c:a", "libopus",
            "-metadata", f"title={title}",
            "-metadata", f"artist={artist}",
            "-metadata", f"album={album}",
            path,
        ],
        check=True,
    )
    return path


def _upload(backend, token, path, title, artists, album):
    with open(path, "rb") as handle:
        data = base64.b64encode(handle.read()).decode()
    status, payload = backend.post(
        "/api/v1/uploads",
        {"filename": os.path.basename(path), "title": title, "artists": artists, "album": album, "data": data},
        token=token,
    )
    assert status in (200, 201), f"upload {title!r} -> {status} {payload}"
    return payload.get("upload") or {}


def _search_and_row(ui, title):
    ui.click_tab("Search")
    ui.type("input[placeholder='Search tracks']", title)
    ui.wait(lambda: title in (ui.texts(".row .title") or []), f"the search never found {title!r}", timeout=20)


def _open_row_menu(ui, title, timeout=20.0):
    """Open the ⋮ on the row named `title`, waiting for the row to be drawn.

    A reorder redraws the list from the server's order, so a row can be absent
    for a moment; the wait is the difference between testing the menu and
    testing the redraw.
    """
    find = (
        "const row = [...document.querySelectorAll('.row')]"
        ".find((el) => (el.querySelector('.title')?.textContent || '').trim() === arguments[0]);"
        "return Boolean(row?.querySelector(\"button[title='More actions'], button[title='More']\"));"
    )
    ui.wait(lambda: ui.js(find, title) or None, f"the row for {title!r} never drew its menu button", timeout)
    clicked = ui.js(
        "const row = [...document.querySelectorAll('.row')]"
        ".find((el) => (el.querySelector('.title')?.textContent || '').trim() === arguments[0]);"
        "const button = row?.querySelector(\"button[title='More actions'], button[title='More']\");"
        "if (button) button.click();"
        "return Boolean(button);",
        title,
    )
    assert clicked, f"the menu button for {title!r} was not there"
    ui.wait(lambda: ui.has(".menu-item") or None, "the row menu never opened", timeout=10)


def _menu(ui, label):
    clicked = ui.js(
        "const item = [...document.querySelectorAll('.menu-item')]"
        ".find((el) => (el.textContent || '').trim().startsWith(arguments[0]));"
        "if (item) item.click();"
        "return Boolean(item);",
        label,
    )
    assert clicked, f"the {label!r} menu item was not there"
    return ui


def _playlist_rows(ui):
    return ui.js("return [...document.querySelectorAll('.content .page .list .row .title')].map((el) => el.textContent.trim());")


def test_a_playlist_round_trip_survives_a_reload(ui, backend):
    """Make it, fill it, drag it, prune it, rename it, reload it.

    Each step is the control a person uses. After the reload the name, the
    order and the absence of the removed song are read again from the page -
    which is the server's answer, since the page was thrown away.
    """
    delta = uuid.uuid4().hex[:6]
    album = f"Edit Album {delta}"
    artist = f"Edit Artist {delta}"
    songs = [f"Edit Song {index} {delta}" for index in range(3)]
    account = Account(backend, prefix="edits")
    for index, title in enumerate(songs):
        _upload(
            backend,
            account.token,
            _tone(backend, title, artist, album, 5 + index, 300 + 40 * index),
            title,
            [artist],
            album,
        )

    name = f"Edits {delta}"
    sign_in_ui(ui, account)
    # The first song's own menu creates the playlist by name.
    _search_and_row(ui, songs[0])
    _open_row_menu(ui, songs[0])
    _menu(ui, "Add to playlist")
    ui.wait(lambda: ui.has(f"{DIALOG}//input[@placeholder='…or a new playlist name']") or None, "the add dialog never opened")
    ui.type(f"{DIALOG}//input[@placeholder='…or a new playlist name']", name)
    ui.click_xpath(f"{DIALOG}//button[normalize-space(.)='Add']", "the add dialog's Add")
    ui.wait_quiet(quiet_for=0.2, timeout=10)

    status, listing = backend.get("/api/v1/me/playlists", token=account.token)
    made = next((entry for entry in (listing.get("playlists") or []) if entry.get("name") == name), None)
    assert made, f"the playlist dialog made nothing: {listing}"

    # The other two go into it through the picker.
    for title in songs[1:]:
        _search_and_row(ui, title)
        _open_row_menu(ui, title)
        _menu(ui, "Add to playlist")
        ui.wait(lambda: ui.has(f"{DIALOG}//select") or None, "the add dialog never opened")
        ui.js(
            "const picker = document.querySelector('.dialog-backdrop select');"
            "if (!picker) return null;"
            "picker.value = arguments[0];"
            "return picker.value;",
            made["id"],
        )
        ui.click_xpath(f"{DIALOG}//button[normalize-space(.)='Add']", "the add dialog's Add")
        ui.wait_quiet(quiet_for=0.2, timeout=10)

    ui.click_tab("Playlists")
    ui.click_xpath(
        f"//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)={name!r}]]",
        f"the row for {name!r}",
    )
    ui.wait(lambda: _playlist_rows(ui) == songs, f"the playlist drew {_playlist_rows(ui)}, want {songs}", timeout=20)

    # Put the last row first, with the list's own grip.
    drag_row(ui, songs[-1], songs[0])
    ui.wait(
        lambda: (_playlist_rows(ui) or [""])[0] == songs[-1],
        f"the dropped row is not first: {_playlist_rows(ui)}",
        timeout=10,
    )
    expected = [songs[-1], songs[0], songs[1]]

    # Prune the middle one through its own menu.
    doomed = songs[0]
    _open_row_menu(ui, doomed)
    _menu(ui, "Remove from playlist")
    ui.wait(lambda: doomed not in _playlist_rows(ui), f"{doomed!r} is still in the playlist", timeout=15)
    expected.remove(doomed)

    # Rename it, with the page's own control.
    renamed = f"{name} renamed"
    ui.click_xpath("//button[normalize-space(.)='Rename']", "the playlist's Rename")
    ui.wait(lambda: ui.has(f"{DIALOG}//input") or None, "the rename prompt never opened")
    # The prompt opens with the current name selected, so typing would replace
    # it: the whole new name is put in, as a person editing the field would.
    ui.js(
        "const input = document.querySelector('.dialog-backdrop input');"
        "if (!input) return null;"
        "input.value = arguments[0];"
        "input.dispatchEvent(new Event('input', { bubbles: true }));"
        "return input.value;",
        renamed,
    )
    ui.click_xpath(f"{DIALOG}//button[normalize-space(.)='Rename']", "the prompt's Rename")
    ui.wait_quiet(quiet_for=0.2, timeout=10)

    ui.reload()
    ui.wait_shell()
    ui.click_tab("Playlists")
    ui.wait(lambda: renamed in (titles(ui) or []), f"the renamed playlist is not in the list: {titles(ui)}", timeout=20)
    ui.click_xpath(
        f"//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)={renamed!r}]]",
        f"the row for {renamed!r}",
    )
    ui.wait(
        lambda: _playlist_rows(ui) == expected,
        f"after the reload the playlist is {_playlist_rows(ui)}, want {expected}",
        timeout=20,
    )
    ui.assert_no_errors("editing a playlist and reloading")


def _tiny_wav(path, frequency):
    frames = bytearray()
    for t in range(4000):  # half a second at 8 kHz
        frames += struct.pack("<h", int(600 * ((t * frequency) % 16000 / 16000.0 * 2 - 1)))
    header = b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVEfmt "
    header += struct.pack("<IHHIIHH", 16, 1, 1, 8000, 16000, 2, 16)
    header += b"data" + struct.pack("<I", len(frames))
    with open(path, "wb") as handle:
        handle.write(header + bytes(frames))
    return path


def test_a_long_playlist_draws_at_once_and_scrolls_to_its_end(ui, backend):
    """A hundred songs: the page draws promptly and reaches the last row.

    The list is appended in chunks so a long one paints instead of blocking,
    and the page keeps the songs in the server's order. What is asserted is a
    person's experience of it: rows on screen quickly, the end reachable, and
    the count honest.
    """
    count = 120
    delta = uuid.uuid4().hex[:6]
    account = Account(backend, prefix="long")
    track_ids = []
    for index in range(count):
        path = _tiny_wav(os.path.join(backend.media_dir, f"long-{delta}-{index}.wav"), 200 + index)
        uploaded = _upload(
            backend, account.token, path, f"Long Song {index:03d} {delta}", [f"Long Artist {delta}"], f"Long Album {delta}",
        )
        track_ids.append(uploaded.get("trackId"))
    status, playlist = backend.post("/api/v1/me/playlists", {"name": f"Long {delta}"}, token=account.token)
    assert status in (200, 201) and playlist.get("id")
    status, payload = backend.post(
        f"/api/v1/me/playlists/{playlist['id']}/items", {"trackIds": track_ids}, token=account.token
    )
    assert status == 200, f"adding {count} tracks answered {status}: {payload}"

    sign_in_ui(ui, account)
    ui.click_tab("Playlists")
    ui.click_xpath(
        f"//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)={'Long ' + delta!r}]]",
        "the long playlist's row",
    )
    started = time.monotonic()
    ui.wait(lambda: len(_playlist_rows(ui)) > 0, "the long playlist never drew a row", timeout=20)
    drawn_ms = (time.monotonic() - started) * 1000
    assert drawn_ms < 4000, f"the first rows took {drawn_ms:.0f} ms"

    ui.wait(lambda: len(_playlist_rows(ui)) == count, f"the playlist settled at {len(_playlist_rows(ui))} rows", timeout=20)

    # The end of the list: the page scrolls there, and the last row is the last song.
    ui.js(
        "const list = document.querySelector('.content .page .list');"
        "if (list) list.scrollTop = list.scrollHeight;"
        "window.scrollTo(0, document.body.scrollHeight);"
        "return true;"
    )
    last = f"Long Song {count - 1:03d} {delta}"
    ui.wait(lambda: ui.has(f".content .page .list .row .title") and last in _playlist_rows(ui), "the last row is missing")
    ui.assert_no_errors("opening a hundred-song playlist")


def test_an_album_plays_and_queues_from_its_row(ui, backend):
    """An artist page's album row queueing the whole album, then playing it.

    Queue album must add every song of the album and *not* start playing;
    Play album must start. Both ask the album endpoint first, which is what
    makes an unopened album whole before it plays.
    """
    delta = uuid.uuid4().hex[:6]
    artist = f"Row Artist {delta}"
    album = f"Row Album {delta}"
    songs = [f"Row Song {index} {delta}" for index in range(2)]
    account = Account(backend, prefix="album-row")
    first = None
    for index, title in enumerate(songs):
        uploaded = _upload(
            backend, account.token, _tone(backend, title, artist, album, 6 + index, 250 + 30 * index),
            title, [artist], album,
        )
        first = first or uploaded.get("trackId")

    sign_in_ui(ui, account)
    status, detail = backend.get(f"/api/v1/tracks/{first}", token=account.token)
    artist_id = (detail.get("artistIds") or [""])[0]
    assert artist_id, f"the uploaded track names no artist: {detail}"
    ui.goto(f"/?artist={artist_id}")
    ui.wait_text(".collection-header-title", artist, "the artist's page never opened", timeout=25)

    _open_row_menu(ui, album)
    _menu(ui, "Queue album")
    ui.wait_quiet(quiet_for=0.3, timeout=15)
    ui.click_tab("Queue")
    # A queue filled while nothing is playing starts at its first song - that is
    # the app's own rule - so the album is the song on plus the queue behind it.
    def album_is_the_queue():
        on_bar = ui.now_playing()
        drawn = queue_titles(ui)
        return True if on_bar in songs and sorted({on_bar, *drawn}) == sorted(songs) else None

    ui.wait(album_is_the_queue, "Queue album did not put the whole album on the queue", timeout=20)

    # Play album, from the same menu, starts the first song.
    ui.goto(f"/?artist={artist_id}")
    ui.wait_text(".collection-header-title", artist, "the artist's page never came back", timeout=25)
    _open_row_menu(ui, album)
    _menu(ui, "Play album")
    wait_sounding(ui, songs[0], 6)
    ui.assert_no_errors("queueing and playing an album from its row")