"""What a person does to a queue, and what the queue must do back.

Every bug this area has produced was invisible from the outside until somebody
played through the change: a row dropped in the wrong place, a duplicate entry
that reused a finished file, a reorder that refetched, a restore that lost the
queue. So each test *plays through* the thing it changed rather than asserting
that a list was re-rendered.
"""

from __future__ import annotations

import time

import pytest

from conftest import sign_in_ui
from journeys import (
    drag_row,
    open_favourites,
    open_queue,
    person,
    press,
    press_bar,
    queue_titles,
    sounding,
    titles,
)
from test_library import wait_sounding

pytestmark = [pytest.mark.slow]


def _queue_from_favourites(ui, person_):
    """Sign in, open the starred list, press its Play, and open the queue.

    Returns the list *as the page drew it*: the favourites list has its own
    order, which is not the order the songs were imported in, and a test that
    assumes the import order waits for the wrong song.
    """
    sign_in_ui(ui, person_)
    order = open_favourites(ui, len(person_.titles))
    assert len(order) == len(person_.titles), f"the list drew {order}"
    press(ui, "Play")
    open_queue(ui)
    ui.wait(
        lambda: len(queue_titles(ui)) >= len(order) - 1,
        f"the queue never held the starred songs: {queue_titles(ui)}",
        timeout=20,
    )
    return order


def test_a_dropped_row_is_the_row_that_plays(ui, backend, media_factory):
    """Drag the last row of the queue to the top, then press Next.

    The drop is a *move*, and what plays next is the row the person put there.
    A drop that names the wrong index, or a scroll position that moves the list
    under the pointer, lands a song somewhere else - which is what the queue's
    own drop bug was.
    """
    someone = person(backend, media_factory, "drag", lengths=(4, 5, 6, 7))
    order = _queue_from_favourites(ui, someone)
    wait_sounding(ui, order[0], someone.seconds(order[0]))
    # Paused while the queue is shaped: a four-second song would otherwise end
    # in the middle of the assertions and advance the queue underneath them.
    press_bar(ui, "Pause")
    ui.wait_player(lambda s: s if s and s.get("paused") else None, "the pause never landed")

    rows = queue_titles(ui)
    assert len(rows) >= 3, f"the queue drew {rows}, want the songs after the one playing"
    moved_title = rows[-1]
    first_title = rows[0]
    assert moved_title != first_title

    drag_row(ui, moved_title, first_title)

    ui.wait(
        lambda: (queue_titles(ui) or [""])[0] == moved_title,
        f"the dropped row is not first: {queue_titles(ui)}",
        timeout=10,
    )

    # And the queue itself agrees: Next plays the row that was dropped.
    press_bar(ui, "Next")
    state = wait_sounding(ui, moved_title, someone.seconds(moved_title))
    assert state["paused"] is False
    ui.assert_no_errors("dragging a queue row and playing it")


def test_removing_the_playing_song_advances_to_the_next(ui, backend, media_factory):
    """Remove the song on the bar; the next queue entry starts.

    A current row has its own Remove button too. Removing it must advance the
    player, not leave the bar naming a song whose row is gone or clear the whole
    queue under it.
    """
    someone = person(backend, media_factory, "remove", lengths=(6, 7, 8))
    order = _queue_from_favourites(ui, someone)
    wait_sounding(ui, order[0], someone.seconds(order[0]))
    playing_title = ui.now_playing()
    upcoming = queue_titles(ui)
    assert upcoming, "the queue drew no upcoming rows"
    following = upcoming[0]

    ui.click("[data-playing='true'] button[title='Remove from the queue']")

    state = wait_sounding(ui, following, someone.seconds(following), timeout=20)
    assert ui.now_playing() == following, f"after removing {playing_title!r}, the bar says {ui.now_playing()!r}"
    assert state["paused"] is False
    ui.assert_no_errors("removing the song being played")


def test_the_same_song_queued_twice_plays_twice(ui, backend, media_factory):
    """Two entries of one song are two plays, not one.

    A queued entry is keyed by its place in the queue, not by the song: the
    second copy must not be handed the first copy's finished file and run out
    the moment it starts, which is exactly what happened when the two were
    treated as one.
    """
    someone = person(backend, media_factory, "twice", lengths=(4,))
    # Play the list, then queue it again: two entries of one song, the first
    # playing and the second waiting.
    sign_in_ui(ui, someone)
    open_favourites(ui, 1)
    press(ui, "Play")
    press(ui, "Queue")
    open_queue(ui)
    ui.wait(lambda: len(queue_titles(ui)) >= 1, "the queue never held the second copy", timeout=20)
    rows = queue_titles(ui)
    assert rows.count(someone.titles[0]) >= 1, f"the second copy is not in the queue: {rows}"

    wait_sounding(ui, someone.titles[0], someone.seconds(someone.titles[0]))

    # The first copy ends and the second starts: the same title, a clock that
    # went back to the beginning.
    seen_end = False
    restarted = False
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and not restarted:
        state = ui.player()
        if not state:
            continue
        position = state.get("currentTime") or 0
        duration = state.get("duration") or 0
        if duration and position >= duration - 0.7:
            seen_end = True
        elif seen_end and position < 0.7 and not state.get("paused"):
            restarted = True
            break
        time.sleep(0.1)
    assert seen_end, "the first copy never reached its end"
    assert restarted, "the second copy of the song never started: a queued duplicate was dropped"
    ui.assert_no_errors("queueing the same song twice")


def test_shuffling_the_queue_leaves_the_song_playing_alone(ui, backend, media_factory):
    """Shuffle the queue from the bar while a song is playing.

    The song on the bar stays on, keeps its place in time and keeps sounding;
    the rest is a permutation of the same entries - nothing lost, nothing
    duplicated, and no restart of the song in hand.
    """
    someone = person(backend, media_factory, "shuffle", lengths=(7, 8, 9, 10, 11))
    order = _queue_from_favourites(ui, someone)
    before = wait_sounding(ui, order[0], someone.seconds(order[0]))
    playing_title = ui.now_playing()
    order_before = queue_titles(ui)

    # A shuffle may, by chance, leave the order alone; the claim is about what
    # the shuffle must not do, so it is pressed until the order moves.
    for attempt in range(4):
        press_bar(ui, "Shuffle what is left of the queue")
        ui.wait_quiet(quiet_for=0.2, timeout=5)
        if queue_titles(ui) != order_before:
            break
    assert queue_titles(ui) != order_before, f"four shuffles left {order_before} in the same order"

    after = queue_titles(ui)
    assert sorted(after) == sorted(order_before), f"shuffle changed the queue's contents: {order_before} -> {after}"
    assert ui.now_playing() == playing_title, "the song being played was replaced by the shuffle"
    state = sounding(ui)
    assert state is not None, "the song being played stopped for the shuffle"
    assert (state.get("currentTime") or 0) >= (before.get("currentTime") or 0) - 0.5, (
        "the song being played restarted for the shuffle"
    )
    ui.assert_no_errors("shuffling the queue while a song plays")


def test_a_reload_in_the_middle_of_the_queue_comes_back_there(ui, backend, media_factory):
    """Reload with the queue half heard: same song, same position, still paused.

    The journey a person takes every day: close the tab, come back, carry on.
    It must not land on song one, and it must not claim to be playing while
    nothing is.
    """
    someone = person(backend, media_factory, "resume", lengths=(7, 8, 9, 10))
    order = _queue_from_favourites(ui, someone)
    wait_sounding(ui, order[0], someone.seconds(order[0]))
    press_bar(ui, "Next")
    second = ui.now_playing()
    assert second != order[0], "Next did not move the queue on"
    wait_sounding(ui, second, someone.seconds(second))

    # Let it run, then pause: a pause is a saved position.
    ui.wait_player(lambda s: s if s and (s.get("currentTime") or 0) > 1.5 else None, "the second song never got going")
    press_bar(ui, "Pause")
    paused = ui.wait_player(lambda s: s if s and s.get("paused") else None, "the pause never landed")
    position = paused.get("currentTime") or 0

    ui.reload()
    ui.wait_shell()

    state = ui.wait_player(
        lambda s: s if s and abs((s.get("currentTime") or 0) - position) < 2.5 else None,
        f"the reload did not come back to {position:.1f}s",
        timeout=25,
    )
    assert ui.now_playing() == second, f"the reload came back to {ui.now_playing()!r}, not {second!r}"
    assert state.get("paused") is True, "a restored queue must not start playing by itself"

    press_bar(ui, "Play")
    ui.wait_player(lambda s: s if s and not s.get("paused") else None, "Play after a restore did nothing", timeout=20)
    ui.assert_no_errors("reloading in the middle of a queue")