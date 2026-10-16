"""End-to-end playback with complete files only.

Provider-backed streaming is intentionally not part of the web contract. Every
scenario below resolves a rendition, waits for its download to become ready, and
only then observes the audio element. The checks retain the user-visible
behaviours that matter: download-first playback, file seeking/restoration,
queue transitions, and joining a room mid-song.
"""

from __future__ import annotations

import json
import os
import time
from urllib.parse import quote

import pytest

from conftest import sign_in_ui
from rooms_helpers import api_room, create_room, in_room_mode, join_room, wait_for
from test_library import Account, assert_clock_moves, row_xpath, wait_sounding

pytestmark = [pytest.mark.slow]

SONG_SECONDS = 30
SONG_MS = SONG_SECONDS * 1000
POSITION_MS = 12_000
ROOM_WARMUP = 3.0
FIRST_SOUND_BUDGET = 45.0
ROOM_FIRST_SOUND_BUDGET = 45.0
POSITION_TOLERANCE_MS = 1500


def search_track(backend, token, title):
    status, payload = backend.get(f"/api/v1/search?q={quote(title)}&limit=5", token=token)
    assert status == 200, f"search for {title!r} answered {status}: {payload!r}"
    for group in (payload or {}).get("groups") or []:
        track = group.get("track") or {}
        if track.get("title") == title:
            variants = group.get("variants") or []
            variant = next((item for item in variants if item.get("downloadable", True)), None)
            assert variant, f"search returned no downloadable rendition for {title!r}: {group!r}"
            return track, variant
    raise AssertionError(f"search never named {title!r}: {payload!r}")


def media_status(backend, token, variant_id):
    status, payload = backend.get(f"/api/v1/media/{variant_id}/status", token=token)
    assert status == 200, f"media status answered {status}: {payload!r}"
    return payload if isinstance(payload, dict) else {}


def wait_for_file(backend, token, variant_id):
    return wait_for(
        lambda: media_status(backend, token, variant_id).get("state") == "ready" or None,
        f"rendition {variant_id!r} never finished downloading",
        timeout=60,
    )


def play_search(ui, title):
    ui.goto("/")
    ui.click_tab("Search")
    ui.type("input[type='search']", title)
    ui.click("button[title='Search again']")
    ui.wait_xpath(row_xpath(title), f"the {title!r} search result")
    ui.click_xpath(row_xpath(title), f"the {title!r} search result")


def wait_file_sounding(ui, title, timeout=FIRST_SOUND_BUDGET):
    state = wait_sounding(ui, title, SONG_SECONDS, timeout=timeout)
    assert "start=" not in (state.get("src") or ""), f"audio was handed a ranged/stream URL: {state!r}"
    return state


def position_ms(ui):
    state = ui.player() or {}
    return float(state.get("currentTime") or 0) * 1000


def assert_position(ui, wanted, where):
    actual = position_ms(ui)
    assert abs(actual - wanted) <= POSITION_TOLERANCE_MS, f"{where}: got {actual:.0f}ms, wanted {wanted}ms"


def test_a_search_song_downloads_before_the_audio_element_plays(ui, backend, signed_in):
    """A not-yet-held rendition is downloaded before ``audio.src`` is assigned."""
    title = "E2E Stream Six"
    _, variant = search_track(backend, signed_in.token, title)
    sign_in_ui(ui, signed_in)
    play_search(ui, title)

    # During the slow fake download the element must remain source-less.
    ui.wait(
        lambda: (ui.player() or {}).get("src") == "" or None,
        "the player was not ready to inspect while the file downloaded",
        timeout=10,
    )
    wait_for_file(backend, signed_in.token, variant["id"])
    state = wait_file_sounding(ui, title)
    assert f"/api/v1/media/{variant['id']}" in state["src"]
    ui.assert_no_errors("download-first playback")


def test_a_downloaded_song_replays_from_one_whole_file(ui, backend, signed_in):
    """A second play uses the held file and never asks for a provider stream."""
    title = "E2E Stream Seven"
    _, variant = search_track(backend, signed_in.token, title)
    sign_in_ui(ui, signed_in)
    play_search(ui, title)
    wait_for_file(backend, signed_in.token, variant["id"])
    wait_file_sounding(ui, title)

    ui.click_tab("Search")
    ui.click_xpath(row_xpath(title), f"the already-downloaded {title!r} result")
    state = wait_file_sounding(ui, title)
    assert "start=" not in state["src"]
    ui.assert_no_errors("replaying a downloaded song")


def test_a_restored_song_seeks_inside_the_downloaded_file(ui, backend, signed_in):
    """Restore and seek use the file's media timeline, not a provider offset."""
    title = "E2E Stream Eight"
    _, variant = search_track(backend, signed_in.token, title)
    sign_in_ui(ui, signed_in)
    play_search(ui, title)
    wait_for_file(backend, signed_in.token, variant["id"])
    wait_file_sounding(ui, title)

    ui.wait_css(".timeline input[type='range']", "the file seek control", timeout=15)
    ui.js(f'''document.querySelector('.timeline input[type="range"]').value = {POSITION_MS / SONG_MS * 1000};''')
    ui.js('document.querySelector(\'.timeline input[type="range"]\').dispatchEvent(new Event("input", {bubbles:true}));')
    wait_for(lambda: position_ms(ui) >= POSITION_MS - POSITION_TOLERANCE_MS, "the file seek never landed", timeout=15)
    assert_position(ui, POSITION_MS, "seek inside downloaded file")

    ui.reload()
    ui.wait(lambda: ui.now_playing() == title or None, f"{title!r} was not restored", timeout=30)
    ui.click(".player-bar button.play")
    state = wait_file_sounding(ui, title)
    assert "start=" not in state["src"]
    assert_position(ui, POSITION_MS, "restored file")
    ui.assert_no_errors("restoring a downloaded song")




def test_a_guest_joining_a_downloaded_song_starts_at_the_room_position(host, guest, backend):
    """A room join seeks the guest's complete file to the room clock."""
    host_account = Account(backend, prefix="playback-host")
    guest_account = Account(backend, prefix="playback-guest")
    title = "E2E Stream Nine"
    _, variant = search_track(backend, host_account.token, title)
    sign_in_ui(host, host_account)
    play_search(host, title)
    wait_for_file(backend, host_account.token, variant["id"])
    wait_file_sounding(host, title)
    name = f"playback-{os.urandom(3).hex()}"
    room_id = create_room(host, name)
    in_room_mode(host, room_id)
    status, payload = backend.post(
        f"/api/v1/rooms/{room_id}/queue",
        {"trackIds": [variant["trackId"]]},
        token=host_account.token,
    )
    assert status == 200, f"queueing the room answered {status}: {payload!r}"
    wait_for(lambda: (api_room(backend, room_id, host_account.token).get("current") or {}).get("started"), "the room never started", timeout=20)
    time.sleep(ROOM_WARMUP)

    join_room(guest, name)
    in_room_mode(guest, room_id)
    room = api_room(backend, room_id, guest_account.token)
    current = room["current"]
    room_ms = current["positionMs"] + (room["serverNowMs"] - current["atMs"])
    wait_file_sounding(guest, title, timeout=ROOM_FIRST_SOUND_BUDGET)
    assert_position(guest, room_ms, "guest joining downloaded room song")
    assert "start=" not in (guest.player().get("src") or "")
    guest.assert_no_errors("guest joining a downloaded room song")
