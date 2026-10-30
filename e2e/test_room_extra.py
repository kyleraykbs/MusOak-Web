"""Room states a household actually hits: duplicates, a host leaving, a member
whose copy is gone, and a page reloaded in the middle of a listen.

The room's clock is the server's, so each of these is really a question about
whether the *page* keeps following it while something about a member changes.
"""

from __future__ import annotations

import os
import time

import pytest

from journeys import press
from rooms_helpers import (
    api_room,
    current_item,
    in_room_mode,
    item_ids,
    open_scene,
    queue_favourites,
    wait_for,
    wait_playing,

)

pytestmark = [pytest.mark.slow, pytest.mark.browsers]


def _collect_items(backend, room_id, token, seconds=12.0):
    """Every queue entry the room holds over a window, by id.

    The room plays as it goes, so its size is not a number to wait for: an item
    can be heard and gone before the next poll. What a test can say is which
    entries the room ever held.
    """
    seen = {}
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        room = api_room(backend, room_id, token) or {}
        for item in ([current_item(room)] if current_item(room) else []) + list(room.get("masterQueue") or []):
            if item.get("id"):
                seen[item["id"]] = item
        time.sleep(0.2)
    return list(seen.values())


def _sounding_title(ui):
    state = ui.player()
    if not state or state.get("paused") or state.get("ended"):
        return ""
    if (state.get("currentTime") or 0) <= 0.05:
        return ""
    return ui.now_playing()


def test_the_same_song_queued_twice_plays_twice_in_the_room(host, guest, backend, media_factory):
    """Two entries of one song are two turns in the room's order.

    A room keyed by the song rather than by the entry would collapse them: one
    play, one item missing, and the queue shorter than what the members put in.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=1, guest_tracks=1, seconds=8)
    token = scene.host_member.token
    queue_favourites(host, scene.name)
    wait_playing(host, backend, scene.room_id, token, "the room never started")

    # The guest queues their one song twice.
    queue_favourites(guest, scene.name)
    queue_favourites(guest, scene.name)
    items = _collect_items(backend, scene.room_id, token, seconds=14.0)
    guest_track = scene.guest_member.tracks[0]["trackId"]
    guest_items = [item for item in items if item.get("trackId") == guest_track]
    assert len(guest_items) == 2, f"the room holds {len(guest_items)} entries of the guest's song: {items}"
    assert len({item.get("id") for item in guest_items}) == 2, "both entries share one id"

    for page in (host, guest):
        page.assert_no_errors("a room with the same song queued twice")


def test_the_room_carries_on_when_its_host_leaves(host, guest, backend, media_factory):
    """The host walks out; the room is either still playing for the guest or over.

    Both are defensible; a frozen page is not. What is asserted is that the
    remaining member's page says which it is, and that nothing threw while the
    room changed hands (or ended).
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=1, guest_tracks=1, seconds=8)
    queue_favourites(host, scene.name)
    wait_playing(host, backend, scene.room_id, scene.host_member.token, "the room never started")

    host.click_xpath("//button[contains(@title, 'Leave')]", "the room's Leave")

    # The room is either gone from the server or still there: both are read
    # from the server, and the guest's page has to agree with neither hanging.
    def settled():
        room = api_room(backend, scene.room_id, scene.guest_member.token)
        return room or "gone"

    outcome = wait_for(settled, "the room never settled after the host left", timeout=20)
    if outcome == "gone":
        guest.wait(
            lambda: guest.has(".empty") or "room" in (guest.text("body") or "").lower() or None,
            "the guest's page says nothing about the room ending",
            timeout=15,
        )
    else:
        # Somebody is still in it: the guest must hear it, not sit paused.
        guest.wait(
            lambda: _sounding_title(guest) or None,
            "the room outlived its host and the guest stopped hearing it",
            timeout=25,
        )
    for page in (host, guest):
        page.assert_no_errors("the host leaving a room")


def test_a_member_whose_copy_vanished_does_not_stop_the_room(host, guest, backend, media_factory):
    """One member's file is gone from the server: the room still moves on.

    The room's clock is the server's, not a member's file. A member who cannot
    play their turn must not hold the room; the others keep hearing it and the
    order advances.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=1, guest_tracks=1, seconds=6)
    token = scene.host_member.token
    queue_favourites(host, scene.name)
    wait_playing(host, backend, scene.room_id, token, "the room never started")

    # The guest's song is queued, and then its file is taken off the server.
    queue_favourites(guest, scene.name)
    room = api_room(backend, scene.room_id, token) or {}
    guest_variant = scene.guest_member.tracks[0]["variantId"]
    path = os.path.join(backend.media_dir, f"{guest_variant}.opus")
    if os.path.exists(path):
        os.remove(path)

    # The room reaches the guest's song and comes out the other side: the queue
    # empties, or the order moves past that entry.
    start_ids = item_ids(room)

    def moved_on():
        current = current_item(api_room(backend, scene.room_id, token) or {})
        return current.get("id") not in start_ids or not current

    wait_for(moved_on, "the room never moved past a member's missing file", timeout=30)
    for page in (host, guest):
        page.assert_no_errors("a member whose song file is gone")

# The fourth journey this file was written for - a member reloading inside the
# room, and landing back at its position - hangs rather than failing: the run
# stopped after three tests with no deadline raised, so it is not one of the
# waits. It is in agents/TODO.md with that observation; a hanging test in the
# suite is worse than no test, so it is not here until it is understood.
