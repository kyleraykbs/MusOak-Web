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
from test_library import wait_sounding
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


def test_a_member_reloads_and_lands_back_in_the_room(host, guest, backend, media_factory):
    """Reload inside a room, answer the rejoin question, land at the position.

    The reload is the person's own: the page comes up blank of state, asks
    whether to go back to the room it remembers, and the click that says yes is
    also the gesture that lets the room's audio start. What must survive is the
    room, the song and the clock - not just the page's own player.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=3, guest_tracks=1, seconds=30)
    token = scene.host_member.token
    queue_favourites(host, scene.name)
    wait_playing(host, backend, scene.room_id, token, "the room never started")
    guest.wait(lambda: _sounding_title(guest) or None, "the guest never followed the room", timeout=25)

    # Navigation is scheduled rather than run inside `execute_script`: a room
    # page reloading while the room's own dialog is up can leave that command
    # waiting for a load the dialog is holding, and a hanging test proves
    # nothing. This is still a person's `location.reload()`.
    guest.js("setTimeout(() => location.reload(), 0); return true;")
    guest.wait_shell(timeout=25)
    guest.wait(
        lambda: guest.has(".dialog-backdrop") or None,
        "the rejoin question never appeared after the reload",
        timeout=25,
    )
    guest.click_xpath(
        "//*[contains(@class,'dialog')]//button[normalize-space(.)='Join']",
        "the rejoin question's Join",
    )
    in_room_mode(guest, scene.room_id, timeout=25)

    room = api_room(backend, scene.room_id, token)
    current = current_item(room)
    title = current.get("title")
    assert title, f"the room has no song after the reload: {room}"
    wait_sounding(guest, title, 30, timeout=25)

    # Compare the page's clock with the server's reading taken after it settled.
    room = api_room(backend, scene.room_id, token)
    current = current_item(room)
    expected = ((room.get("current") or {}).get("positionMs") or 0) / 1000.0
    got = guest.player().get("currentTime") or 0
    assert abs(got - expected) < 3.0, f"the reloaded page is at {got:.1f}s, the room is at {expected:.1f}s"
    guest.assert_no_errors("reloading inside a room")
    host.assert_no_errors("the room while a member reloads")


def test_a_member_keeps_playing_in_a_room_offline_and_resyncs(host, guest, backend, media_factory):
    """A room member's audio survives `offline`, ignores the room moving on,
    and returns to the host's clock when the network comes back.

    Firefox has no WebDriver "offline mode" hook in this suite. This exercises
    the app's actual offline branch instead: `navigator.onLine` answers false
    and API requests are refused, so `player.online()` takes the local-room
    path; the host stays connected to prove that one absent member neither
    stops the room nor keeps the room's clock from moving.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=3, guest_tracks=1, seconds=30)
    token = scene.host_member.token
    queue_favourites(host, scene.name)
    wait_playing(host, backend, scene.room_id, token, "the room never started")

    guest.wait(
        lambda: _sounding_title(guest) or None,
        "the guest never started following the room",
        timeout=25,
    )

    def set_online(ui, online):
        # A page-level offline: `navigator.onLine` answers through a getter so
        # a reachability check cannot turn the page back online behind the
        # test's back, and API requests are refused while the flag is set.
        answer = ui.js(
            """
            window.__e2eOffline = !arguments[0];
            if (!window.__e2eRealFetch) window.__e2eRealFetch = window.fetch;
            window.fetch = function (...args) {
              if (window.__e2eOffline) return Promise.reject(new TypeError("offline"));
              return window.__e2eRealFetch.apply(this, args);
            };
            Object.defineProperty(navigator, "onLine", {
              configurable: true,
              get() { return !window.__e2eOffline; },
            });
            window.dispatchEvent(new Event(arguments[0] ? "online" : "offline"));
            return navigator.onLine;
            """,
            online,
        )
        assert answer is online, "the page's online flag did not follow the test"

    set_online(guest, False)
    staying = guest.now_playing()
    before = guest.player()["currentTime"]
    guest.wait_player(
        lambda state: state
        if state
        and not state["paused"]
        and state["currentTime"] > before + 0.8
        and _sounding_title(guest)
        else None,
        "the room member's audio stopped when the page went offline",
        timeout=8,
    )

    # The room moves on. The offline member has not heard it, so its own song
    # must keep running rather than jumping, clearing or pausing. Read the
    # server, not the other member's player: the room's clock is the truth,
    # and a host page that is slow to redraw says nothing about this member.
    status, payload = backend.post(
        f"/api/v1/rooms/{scene.room_id}/skip",
        token=scene.host_member.token,
    )
    assert status == 200, f"the room would not skip: {status} {payload!r}"

    def room_moved():
        current = current_item(api_room(backend, scene.room_id, token))
        title = current.get("title")
        return title if title and title != staying else None

    moved = wait_for(room_moved, "the room's order never moved on", timeout=10)
    guest.wait_player(
        lambda state: state
        if state
        and not state["paused"]
        and guest.now_playing() == staying
        and state["currentTime"] > before + 1.2
        else None,
        "the offline member followed a room change it never heard",
        timeout=10,
    )

    # Back on the network: the room's own item wins and this page catches up.
    set_online(guest, True)
    wait_sounding(guest, moved, 30, timeout=25)
    assert guest.now_playing() == moved, f"the reconnected member is on {guest.now_playing()!r}"
    guest.assert_no_errors("a room member going offline and reconnecting")
    host.assert_no_errors("the room host while a member is offline")
    guest.assert_no_errors("a room member going offline and reconnecting")
    host.assert_no_errors("the room host while a member is offline")
