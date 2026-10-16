"""A song with no source: the page asks what it is, and the answer plays it.

A song whose sources cannot be found is a state the product really has - a
playlist imported from a service buys names, not files - and it is the one the
room cannot do anything about on its own: the resolve finds nothing, so the item
has nothing to hand the player, and the room's clock runs out over a song nobody
heard. The page's answer is to ask: the search page's own Find a source dialog,
which searches the platforms and attaches whichever result is picked to the song
it was asked about.

Both fakes are the test build's (`internal/provider/ghost_e2e.go`): `e2e-ghost`
answers a search and can fetch nothing, which is the song with no source, and
`e2e-slow` answers the same words with a rendition it downloads slowly, which is
the answer. The two are deliberately different lengths, so no matching pass can
quietly attach one to the other and hide the state under test.

What is asserted is the *page's* behaviour, because that is what was missing:
the question appears with the song's name on it, the search is already run, a
pick plays the song, and the question comes down when the room moves on.
"""

from __future__ import annotations

from urllib.parse import quote

import pytest

from rooms_helpers import (
    api_room,
    current_item,
    open_scene,
    playing_now,
    seed_room_queue,
    wait_for,
)

pytestmark = [pytest.mark.slow, pytest.mark.browsers]

#: The fake that answers a search and cannot be fetched: the song with no source.
GHOST = "E2E Ghost Tone"
#: The fake that answers the same words with something playable: the answer.
PLAYABLE = "E2E Slow Tone"

DIALOG = "//div[contains(@class,'dialog') and not(contains(@class,'dialog-backdrop'))]"
DIALOG_ROW = DIALOG + "//button[contains(@class,'find-source-row')]"


def ghost_track(backend, token, title=GHOST):
    """The canonical track the search-only fake's hit becomes."""
    status, answer = backend.get(f"/api/v1/search?q={quote(title)}&limit=5", token=token)
    assert status == 200, f"the search answered {status}: {answer!r}"
    for group in (answer or {}).get("groups") or []:
        track = group.get("track") or {}
        if track.get("title") == title:
            return track
    raise AssertionError(f"the search never named {title!r}: {answer!r}")


def test_a_song_with_no_source_is_asked_about_and_the_answer_plays_it(
    host, guest, backend, media_factory
):
    scene = open_scene(host, guest, backend, media_factory, host_tracks=1, guest_tracks=1)
    ghost = ghost_track(backend, scene.host_member.token)
    own = scene.host_member.track_ids()[0]
    # The song with no source goes on first, so it is the room's current item;
    # the host's own tone is owed next, which is where a skip takes the room.
    seed_room_queue(backend, scene.room_id, scene.host_member.token, [ghost["id"], own])

    # The resolve finds nothing, and the page asks: the dialog names the song,
    # and the search it ran already offered the platform's own rendition of it.
    host.wait_xpath(DIALOG, "the page never asked what the unsourced song is", timeout=30.0)
    question = host.text(DIALOG)
    assert GHOST in question, f"the question does not name the song: {question!r}"
    host.wait_xpath(DIALOG_ROW, "the search the dialog ran offered nothing playable", timeout=30.0)
    rows = host.texts(DIALOG_ROW)
    assert any(PLAYABLE in row for row in rows), (
        f"no playable rendition among the rows the dialog offered: {rows!r}"
    )

    # Picking one attaches it to the song. That is what makes the room able to
    # play it: the question is answered and comes down, and the element ends up
    # running the rendition that was picked.
    host.click_xpath(DIALOG_ROW, "the rendition the dialog offered")
    host.wait_gone(DIALOG, "the question stayed up after it was answered", timeout=30.0)

    def playing_the_song():
        state = host.player()
        if not state or state.get("paused") or (state.get("currentTime") or 0) <= 0.2:
            return None
        # The bar names the song, the element runs the file the answer attached.
        if host.now_playing() != GHOST:
            return None
        return state

    state = host.wait(
        playing_the_song,
        "the song the source was attached to never played",
        timeout=60.0,
    )
    assert "/api/v1/media/" in state["src"], (
        f"the element is not running a stored rendition of the answer: {state['src']!r}"
    )
    room = api_room(backend, scene.room_id, scene.host_member.token)
    assert current_item(room)["trackId"] == ghost["id"], (
        "the room moved off the song that was just given a source"
    )
