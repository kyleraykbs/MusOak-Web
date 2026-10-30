"""The offline journey: keep a playlist, take the server away, and listen.

This is the point of the "kept" playlist, and the only path where the page's
own Cache Storage and the service worker are the whole backend. Each test brings
its own frontend, because the shared one cannot be stopped mid-run - and a test
that cannot turn the wire off is not testing offline play.

The media files themselves are the service worker's to serve (`sw.js` answers
`/api/v1/media/...` from Cache Storage), so what is asserted is the element's own
`src`, its clock and its length, never a label.
"""

from __future__ import annotations

import os
import uuid

import pytest

import harness
from conftest import sign_in_ui
from test_caching import (
    KEEP,
    KEPT,
    MEDIA_CACHE,
    _media_cache,
    _own_frontend,
    _playlist_row,
    _reload,
    _shell_cache,
)
from test_library import Account, wait_sounding
from journeys import PASSWORD

pytestmark = [pytest.mark.slow]


def _playlist(backend, token, name, track_ids):
    status, playlist = backend.post("/api/v1/me/playlists", {"name": name}, token=token)
    assert status in (200, 201) and (playlist or {}).get("id"), f"playlist create: {status} {playlist}"
    status, payload = backend.post(
        f"/api/v1/me/playlists/{playlist['id']}/items", {"trackIds": list(track_ids)}, token=token
    )
    assert status == 200, f"playlist add: {status} {payload}"
    return playlist


def _kept_front(binaries, backend, run_dir, headless, request, account, name, track_ids, prefix):
    """A person, a playlist, a frontend of its own - kept on this machine.

    Returns the frontend, the browser, the playlist's name and its songs. The
    keep happens, and the playlist is played once while the server is still
    there: that first play is what teaches the page which file each song is, and
    the worker only keeps the shell once a load has gone through it.
    """
    playlist = _playlist(backend, account.token, name, track_ids)
    front = _own_frontend(binaries, backend, run_dir, request, f"frontend-{prefix}")
    ui = harness.open_ui(front.url, os.path.join(run_dir, "artifacts"), name=prefix, headless=headless)
    sign_in_ui(ui, account)
    ui.wait_quiet()
    ui.wait_js("!!navigator.serviceWorker.controller", "the service worker never took the page")
    _reload(ui)
    assert "/" in _shell_cache(ui), "the worker never kept the page itself"

    ui.click_tab("Playlists")
    ui.wait_css(KEEP, "the playlist row drew no keep control")
    ui.click(KEEP)
    ui.wait(lambda: ui.has(KEPT), "the row never said the playlist was kept on this machine", timeout=60)
    held = _media_cache(ui)
    assert held, "the row says the playlist is kept but the page's media cache is empty"
    return front, ui, playlist, held


def test_a_kept_playlist_plays_to_its_end_with_the_server_gone(
    binaries, backend, media_factory, run_dir, headless, request
):
    """Every song of a kept playlist, with nothing to serve it but the page."""
    delta = uuid.uuid4().hex[:6]
    account = Account(backend, prefix="offline")
    lengths = [6, 7, 8]
    tracks = [
        media_factory.import_track(
            account.token, title=f"Kept {index} {delta}", seconds=seconds, frequency=300 + 30 * index
        )
        for index, seconds in enumerate(lengths)
    ]
    songs = [track["track"]["title"] for track in tracks]
    name = f"Kept List {delta}"
    front, ui, playlist, held = _kept_front(
        binaries, backend, run_dir, headless, request, account, name, [t["trackId"] for t in tracks], "offline-kept"
    )
    try:
        assert len(held) >= len(tracks), f"kept {len(held)} songs of {len(tracks)}"

        # One play while the server is up, so the page learns each file.
        ui.click_xpath(_playlist_row(name), f"the row for {name!r}")
        ui.click_text("Play")
        ui.wait_player(
            lambda state: state if state and state["src"] and state["currentTime"] > 0.2 else None,
            "the kept playlist never played while the server was up",
            timeout=30,
        )
        ui.click("[title='Pause']")
        ui.wait_player(lambda state: state and state["paused"], "the song never paused", timeout=10)

        front.stop()

        # And now the whole playlist, from the page alone.
        ui.click_text("Play")
        heard = []
        for title, seconds in zip(songs, lengths):
            wait_sounding(ui, title, seconds, timeout=30)
            heard.append(title)
            if title != songs[-1]:
                ui.click(".player-bar button[title='Next']")
        assert heard == songs, f"the kept playlist played {heard}, want {songs}"
        ui.assert_no_errors("a kept playlist playing with the server gone")
    finally:
        front.stop()
        ui.driver.quit()


def test_a_kept_playlist_says_which_song_the_browser_let_go(
    binaries, backend, media_factory, run_dir, headless, request
):
    """One kept song removed from Cache Storage: the page says so and plays the rest.

    A browser may evict a kept song under storage pressure. What must not happen
    is silence: the page names what is gone and the songs it still holds play.
    """
    delta = uuid.uuid4().hex[:6]
    account = Account(backend, prefix="evicted")
    lengths = [6, 7]
    tracks = [
        media_factory.import_track(
            account.token, title=f"Held {index} {delta}", seconds=seconds, frequency=340 + 30 * index
        )
        for index, seconds in enumerate(lengths)
    ]
    songs = [track["track"]["title"] for track in tracks]
    name = f"Evicted {delta}"
    front, ui, playlist, held = _kept_front(
        binaries, backend, run_dir, headless, request, account, name, [t["trackId"] for t in tracks], "offline-evicted"
    )
    try:
        assert len(held) >= len(tracks)
        # Play once while the server is up, then let go of one song's bytes.
        ui.click_xpath(_playlist_row(name), f"the row for {name!r}")
        ui.click_text("Play")
        ui.wait_player(
            lambda state: state if state and state["src"] and state["currentTime"] > 0.2 else None,
            "the kept playlist never played while the server was up",
            timeout=30,
        )
        ui.click("[title='Pause']")
        ui.wait_player(lambda state: state and state["paused"], "the song never paused", timeout=10)
        released = ui.js_async(
            "const cache = await caches.open(arguments[0]);"
            "const keys = await cache.keys();"
            "const key = keys.find((request) => request.url.includes(arguments[1]));"
            "if (!key) return 0;"
            "await cache.delete(key);"
            "return (await cache.keys()).length;",
            MEDIA_CACHE,
            tracks[0]["variantId"],
        )
        assert released is not None

        front.stop()
        # Re-enter through the offline Playlists list: the page currently open
        # still has its online rendering in the DOM, and nothing redraws it
        # merely because the server went away.
        ui.click_tab("Playlists")
        ui.wait(
            lambda: name in (ui.texts(".row .title") or []),
            f"the offline list does not show {name!r}",
            timeout=20,
        )
        ui.click_xpath(_playlist_row(name), f"the row for {name!r}")
        # The page says what it cannot play, and does not sit silent over it.
        def missing_banner():
            text = ui.text(".banner") or ""
            return text if "no longer in this browser" in text else None

        message = ui.wait(missing_banner, "the page never said a kept song had gone", timeout=20)
        assert "1 of 2" in message, f"the banner does not say one of two is gone: {message!r}"
        ui.click_text("Play")
        wait_sounding(ui, songs[1], lengths[1], timeout=30)
        ui.assert_no_errors("a kept playlist with one song evicted")
    finally:
        front.stop()
        ui.driver.quit()


def test_the_shell_and_a_kept_playlist_open_with_the_server_gone(
    binaries, backend, media_factory, run_dir, headless, request
):
    """Reload with nothing listening: the app still opens, and still plays.

    The shell comes out of Cache Storage, the playlist out of IndexedDB and the
    song out of the same cache the worker serves - three separate stores, and a
    person expects all three to hold.
    """
    delta = uuid.uuid4().hex[:6]
    account = Account(backend, prefix="shell-off")
    tracks = [
        media_factory.import_track(account.token, title=f"Shell {index} {delta}", seconds=6 + index, frequency=280 + 20 * index)
        for index in range(2)
    ]
    songs = [track["track"]["title"] for track in tracks]
    name = f"Shell List {delta}"
    front, ui, playlist, held = _kept_front(
        binaries, backend, run_dir, headless, request, account, name, [t["trackId"] for t in tracks], "offline-shell"
    )
    try:
        ui.click_xpath(_playlist_row(name), f"the row for {name!r}")
        ui.click_text("Play")
        ui.wait_player(
            lambda state: state if state and state["src"] and state["currentTime"] > 0.2 else None,
            "the kept playlist never played while the server was up",
            timeout=30,
        )
        ui.click("[title='Pause']")
        front.stop()

        _reload(ui)
        ui.wait_shell()
        ui.click_tab("Playlists")
        ui.wait(
            lambda: name in (ui.texts(".row .title") or []),
            f"the offline page does not list the kept playlist {name!r}",
            timeout=25,
        )
        ui.click_xpath(_playlist_row(name), f"the row for {name!r}")
        ui.click_text("Play")
        wait_sounding(ui, songs[0], 6, timeout=30)
        ui.assert_no_errors("opening a kept playlist with the server gone")
    finally:
        front.stop()
        ui.driver.quit()