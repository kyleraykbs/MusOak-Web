"""Listen Together: the room's order, its skip, its votes, and its clock.

The room's play order is the *server's*: `masterQueue` on
`GET /api/v1/rooms/{id}` is the rule (the member whose last turn is oldest goes
first; a member who has never had a turn goes before everybody who has; ties by
join order), and every client is sent it on every `queue_updated` and in every
snapshot. A page may only *render* that order. The web client once derived its
own join-order round robin, and the divergence made a skip thrash.

So every order assertion here reads both sides - the API with the member's own
token, and the DOM the member is looking at - and compares them item for item.
Where the *room's* behaviour is asserted (a skip advances once, a vote short of
the rules does not skip), it is read from the API, which is the room. Where a
*member's* behaviour is asserted (the element runs the new song, the pause
landed, the position converged), it is read from that browser's `<audio>`
element, which is the truth about what that person hears.
"""

from __future__ import annotations

import time

import pytest

from rooms_helpers import (
    Window,
    api_room,
    assert_listening,
    assert_order_matches,
    counts_of,
    current_item,
    item_ids,
    listening_rows,
    observe,
    open_scene,
    playing_now,
    queue_favourites,
    room_rows,
    seed_room_queue,
    votes_view,
    wait_for,
    wait_order_matches,
    wait_playing,
    wait_queue_size,
    wait_room_view,
)

pytestmark = [pytest.mark.slow, pytest.mark.browsers]

#: The room's own controls. The playbar carries its own Pause/Next, so the
#: room's buttons are named inside a card - this is also literally the selector
#: the report named for a skip. Any element carrying the class, not a `div`:
#: the panels were standardised onto `section`, and a selector that named the
#: tag went on matching nothing while the controls sat right there.
ROOM_CARD = "//*[contains(@class,'card')]"
SKIP_BUTTON = ROOM_CARD + "//button[@title='Skip to the next track']"
PAUSE_BUTTON = ROOM_CARD + "//button[@title='Pause']"
RESUME_BUTTON = ROOM_CARD + "//button[@title='Resume']"
VOTE_BAD = ROOM_CARD + "//button[@title='1 · bad']"
LEAVE_BUTTON = ROOM_CARD + "//button[starts-with(@title, 'Leave')]"


def _elapsed(start):
    return time.monotonic() - start


#: What one page may ask for in the three seconds after a skip. The healthy
#: number is one to four (the skip itself, a read or two, the page's own
#: bookkeeping); the bound is here for the *storm* the report described - a
#: page that polled `media/*/status` or reloaded a variant on every state
#: change, which is dozens to hundreds of requests, not five.
SKIP_REQUESTS_MAX = 20
SKIP_STATUS_MAX = 5


def _assert_bounded(what, host_counts, guest_counts, seconds=3.0):
    """The requests a member's page made, against the storm bound."""
    for side, counts in (("host", host_counts), ("guest", guest_counts)):
        per_second = counts["total"] / seconds
        print(f"    {side}: {per_second:.1f} requests/second")
        assert counts["total"] <= SKIP_REQUESTS_MAX, (
            f"{what} cost the {side} {counts['total']} requests in {seconds:.0f} seconds "
            f"({per_second:.1f}/s): {counts}"
        )
        assert counts["media-status"] <= SKIP_STATUS_MAX, (
            f"{what} cost the {side} {counts['media-status']} `media/*/status` polls in "
            f"{seconds:.0f} seconds: {counts}"
        )


def _playing_something_else(ui, before):
    """This element is running a song, and it is not the one it was on."""
    state = ui.player()
    if not state or state.get("paused") or (state.get("currentTime") or 0) <= 0.2:
        return None
    if state.get("src") == before:
        return None
    return state


def _running(ui, message):
    """Wait for this element to be running a song at all, and return its reading."""
    return ui.wait(
        lambda: (lambda state: state if state and not state.get("paused") and (state.get("currentTime") or 0) > 0.2 else None)(ui.player()),
        message,
        timeout=25,
    )


def _queue(host, guest, scene, backend):
    """Host's songs in the room, then the guest's, with the room playing."""
    token, room_id = scene.host_member.token, scene.room_id
    queue_favourites(host, scene.name)
    wait_queue_size(host, backend, room_id, token, len(scene.host_member.tracks), "the host's songs never reached the room")
    wait_playing(host, backend, room_id, token, "the room never started playing the host's first song")
    queue_favourites(guest, scene.name)
    wait_queue_size(
        guest,
        backend,
        room_id,
        token,
        len(scene.host_member.tracks) + len(scene.guest_member.tracks),
        "the guest's song never reached the room",
    )
    return api_room(backend, room_id, token)


def test_a_room_shows_both_members(host, guest, backend, media_factory):
    """A room made in one browser and joined from the other has both in it.

    The panel is compared against the API's own member list, not against a name
    the test happens to know: what the page shows about who is listening must be
    what the server says.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=1, guest_tracks=1)
    assert scene.order() == [], f"a room nobody queued in already holds {scene.order()!r}"

    wanted = sorted(scene.names())
    for ui, side in ((host, "host"), (guest, "guest")):
        got = sorted(row["name"] for row in listening_rows(ui))
        assert got == wanted, f"the {side}'s Listening panel says {got!r}, not {wanted!r}"

    room = scene.room()
    assert room["memberCount"] == 2, f"the server counts {room['memberCount']} members, not 2: {room['members']!r}"
    assert_listening(host, room, "the host's view: ")
    assert_listening(guest, room, "the guest's view: ")

    # The marks are the page's own: a member is the host, is you, or is simply
    # listening. Both pages must wear them on the right rows.
    host_rows = {row["name"]: row["marks"] for row in listening_rows(host)}
    guest_rows = {row["name"]: row["marks"] for row in listening_rows(guest)}
    assert host_rows[scene.host_member.username] == "host, you", host_rows
    assert host_rows[scene.guest_member.username] == "listening", host_rows
    assert guest_rows[scene.host_member.username] == "host", guest_rows
    assert guest_rows[scene.guest_member.username] == "you", guest_rows

    # The list is a way back into the room as well as out of it: the room being
    # followed is a card with Open, and Open lands on the room's own page.
    host.click_xpath(ROOM_CARD + "//button[@title='Back to the rooms list']", "the room's back button")
    following = ROOM_CARD + "//button[normalize-space(.)='Open']"
    host.wait_xpath(following, "the room being followed never appeared as a card with Open")
    host.click_xpath(following, "Open on the room being followed")
    wait_room_view(host, scene.name)
    assert sorted(row["name"] for row in listening_rows(host)) == wanted, (
        "opening the room again lost a member: "
        f"{sorted(row['name'] for row in listening_rows(host))!r}"
    )

    print(f"\nroom {scene.name!r} ({scene.room_id}) holds {wanted}; host is {scene.host_member.username}")
    host.assert_no_errors("the host")
    guest.assert_no_errors("the guest")


def test_the_play_order_is_the_servers(host, guest, backend, media_factory):
    """The member with no turn yet goes first, and both pages draw that order.

    The host queues three songs, which starts its first, so the host has had a
    turn; the guest queues one and has never had one, so the guest's song is
    what the room owes next. A page deriving its own join-order round robin
    would put the host's second song there instead.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=3, guest_tracks=1)
    token, room_id = scene.host_member.token, scene.room_id

    queue_favourites(host, scene.name)
    wait_queue_size(host, backend, room_id, token, 3, "the host's three songs never reached the room")
    wait_playing(host, backend, room_id, token, "the host's first song never started, so the host never had a turn")
    assert current_item(scene.room())["addedBy"] == scene.who(scene.host_member.username), (
        "the room began with somebody other than the host on the first song"
    )

    queue_favourites(guest, scene.name)
    wait_queue_size(guest, backend, room_id, token, 4, "the guest's song never reached the room")

    guest_id = scene.who(scene.guest_member.username)
    room = wait_for(
        lambda: (
            lambda held: held if (held["masterQueue"] or [{}])[0].get("addedBy") == guest_id else None
        )(api_room(backend, room_id, token)),
        "the room never put the guest's song - the member with no turn yet - first",
        timeout=15,
    )
    order = room["masterQueue"]
    assert order, "the room emptied its order"
    assert order[0]["addedBy"] == guest_id, f"the song owed next is not the guest's: {order!r}"
    assert [item["addedBy"] for item in order[1:]] == [current_item(room)["addedBy"]] * len(order[1:]), (
        "the host's remaining songs are not the room's order after the guest's"
    )

    # Both pages, not just the guest's: each renders the server's order.
    wait_order_matches(guest, backend, room_id, token, "the guest's page never drew the server's order")
    wait_order_matches(host, backend, room_id, token, "the host's page never drew the server's order")
    rows = assert_order_matches(guest, room, "the guest's view: ")
    assert len(rows) == 4, f"the page draws {len(rows)} rows for a room holding four items: {rows!r}"
    assert rows[0]["now"] and rows[0]["playing_mark"], f"the song on is not marked as such: {rows[0]!r}"

    print("\nthe room's order (first row is the song on):")
    for item in [current_item(room), *order]:
        print(f"    {item['title']:28} queued by {_name(room, item['addedBy'])}")
    host.assert_no_errors("the host")
    guest.assert_no_errors("the guest")


def _name(room, member_id):
    for member in room.get("members") or []:
        if member.get("id") == member_id:
            return member.get("name") or ""
    return "?"


def test_a_skip_advances_the_room_once_and_both_pages_follow(host, guest, backend, media_factory):
    """The skip the user reported: does the room move, and do the pages agree?

    Both members must move to the room's next item (their own element running
    the new song), the room must advance exactly one step, the guest's rendered
    order must still equal the API's `masterQueue` afterwards, and the requests a
    skip causes over the next three seconds must stay bounded - a storm of
    `media/*/status` or repeated variant loads was the reported overload.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=3, guest_tracks=1)
    token, room_id = scene.host_member.token, scene.room_id

    before = _queue(host, guest, scene, backend)
    wait_playing(guest, backend, room_id, token, "the guest never started playing the room's song")
    wait_order_matches(guest, backend, room_id, token, "the guest's page never drew the room's order before the skip")

    before_ids = item_ids(before)
    before_current = current_item(before)["id"]
    host_id = scene.who(scene.host_member.username)
    guest_id = scene.who(scene.guest_member.username)
    next_item = before["masterQueue"][0]
    host_src = host.player()["src"]
    guest_src = guest.player()["src"]
    assert host_src and guest_src, "a member's element has no source before the skip"

    host_window = Window(host, 3.0)
    guest_window = Window(guest, 3.0)
    started = time.monotonic()
    host.click_xpath(SKIP_BUTTON, "the room's Skip button")

    after = wait_for(
        lambda: (
            lambda room: room if current_item(room).get("id") == next_item["id"] else None
        )(api_room(backend, room_id, token)),
        "the room never skipped: its current song did not move on",
        timeout=12,
    )
    t_server = _elapsed(started)
    host_state = host.wait(
        lambda: _playing_something_else(host, host_src),
        "the host's own element never moved to the room's next song",
        timeout=15,
    )
    t_host = _elapsed(started)
    guest_state = guest.wait(
        lambda: _playing_something_else(guest, guest_src),
        "the guest's own element never moved to the room's next song",
        timeout=15,
    )
    t_guest = _elapsed(started)

    # The room advanced once, and by exactly one item: the song on is what was
    # owed next, the song that was on has left its owner's queue, and nothing
    # else changed.
    assert current_item(after)["id"] == next_item["id"], (
        f"the room is on {current_item(after)!r}, not the item that was owed next ({next_item['id']!r})"
    )
    assert [item["id"] for item in after["masterQueue"]] == before_ids[2:], (
        "the room's order after one skip is not the order before it without the song on and the one it moved to:\n"
        f"  before: {before_ids!r}\n  after:  {item_ids(after)!r}"
    )
    assert [item["id"] for item in (after["queues"].get(host_id) or [])] == before_ids[2:], (
        f"the host's own queue after the skip is {(after['queues'].get(host_id) or [])!r}, not {before_ids[2:]!r}"
    )
    # A member's own queue keeps the song in flight until it has played out, so
    # the guest's queue now holds the song the room just moved to - and only it.
    assert [item["id"] for item in (after["queues"].get(guest_id) or [])] == [next_item["id"]], (
        f"the guest's queue after its song began is {(after['queues'].get(guest_id))!r}, not just {next_item['id']!r}"
    )
    assert before_current not in [item["id"] for item in after["queues"].get(host_id) or []], (
        "the song that was skipped is still in its owner's queue"
    )

    # And the guest's page draws the room's order as it now stands.
    wait_order_matches(guest, backend, room_id, token, "the guest's page does not draw the room's order after the skip")
    assert_order_matches(host, after, "the host's view after the skip: ")
    assert playing_now(guest)["title"] == next_item["title"], (
        f"the guest's room view says it is playing {playing_now(guest)!r}, not {next_item['title']!r}"
    )

    host_entries = host_window.close()
    guest_entries = guest_window.close()
    host_counts, guest_counts = counts_of(host_entries), counts_of(guest_entries)
    print(
        f"\nskip: the server moved on in {t_server * 1000:.0f} ms, the host's audio in {t_host * 1000:.0f} ms, "
        f"the guest's audio in {t_guest * 1000:.0f} ms"
    )
    print(f"  requests in the three seconds after the press - host: {host_counts}")
    print(f"  requests in the three seconds after the press - guest: {guest_counts}")
    _assert_bounded("a skip", host_counts, guest_counts)
    assert host_state["currentTime"] > 0.2 and guest_state["currentTime"] > 0.2
    host.assert_no_errors("the host")
    guest.assert_no_errors("the guest")


def test_a_forty_song_queue_still_skips(host, guest, backend, media_factory):
    """The 40-song case the user hit: a long order must not melt either page.

    Forty items are queued, a skip is pressed, and the room must still advance
    and the pages still agree - with the requests each page makes per second
    staying bounded while it does.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=2, guest_tracks=1)
    token, room_id = scene.host_member.token, scene.room_id
    # Seeded through the room's own endpoint: the queue is what is under test
    # here, not the clicking, and forty items is a minute of it.
    long_track = [scene.host_member.track_ids()[0]] * 40
    seed_room_queue(backend, room_id, token, long_track)
    wait_queue_size(host, backend, room_id, token, 40, "the forty songs never reached the room")
    wait_playing(host, backend, room_id, token, "the room never started on the long queue")
    wait_playing(guest, backend, room_id, token, "the guest never started on the long queue")

    before = api_room(backend, room_id, token)
    before_current = current_item(before)["id"]
    owed_next = before["masterQueue"][0]["id"]
    assert len(before["masterQueue"]) == 39, f"a forty-song queue left {len(before['masterQueue'])} items owed"

    host_window = Window(host, 3.0)
    guest_window = Window(guest, 3.0)
    started = time.monotonic()
    host.click_xpath(SKIP_BUTTON, "the room's Skip button")

    after = wait_for(
        lambda: (
            lambda room: room if current_item(room).get("id") == owed_next else None
        )(api_room(backend, room_id, token)),
        "the room never skipped with a forty-song queue",
        timeout=15,
    )
    t_server = _elapsed(started)
    host_running = _running(host, "the host's element stopped when a forty-song queue skipped")
    t_host = _elapsed(started)
    guest_running = _running(guest, "the guest's element stopped when a forty-song queue skipped")
    t_guest = _elapsed(started)

    assert current_item(after)["id"] != before_current, "the room is still on the song it skipped"
    assert_order_matches(guest, after, "the guest's view of the long queue: ")
    assert_order_matches(host, after, "the host's view of the long queue: ")
    rows = room_rows(guest) or []
    assert len(rows) == len(item_ids(after)), (
        f"the guest's page draws {len(rows)} rows for a room holding {len(item_ids(after))} items"
    )

    host_entries = host_window.close()
    guest_entries = guest_window.close()
    host_counts, guest_counts = counts_of(host_entries), counts_of(guest_entries)
    print(f"\nforty-song skip: the server moved on in {t_server * 1000:.0f} ms, the host's audio in "
          f"{t_host * 1000:.0f} ms, the guest's audio in {t_guest * 1000:.0f} ms")
    print(f"  requests in the three seconds after the press - host: {host_counts}")
    print(f"  requests in the three seconds after the press - guest: {guest_counts}")
    _assert_bounded("a skip on a forty-song queue", host_counts, guest_counts)
    assert host_running["currentTime"] > 0.2 and guest_running["currentTime"] > 0.2
    host.assert_no_errors("the host")
    guest.assert_no_errors("the guest")


def test_votes_skip_a_track_only_when_enough_members_vote(host, guest, backend, media_factory):
    """One bad vote is not a skip; the second one is.

    The suite's server runs `minVotersForSkip: 2` and `skipThreshold: 2`, so one
    member alone cannot skip a track however much they dislike it, and two can.
    The votes must be visible in the room view while they are pending.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=2, guest_tracks=1)
    token, room_id = scene.host_member.token, scene.room_id

    queue_favourites(host, scene.name)
    wait_queue_size(host, backend, room_id, token, 2, "the host's songs never reached the room")
    wait_playing(host, backend, room_id, token, "the room never started playing")
    wait_playing(guest, backend, room_id, token, "the guest never started playing")

    room = scene.room()
    assert room["skip"]["minVotersForSkip"] == 2, f"the server's rules are not the suite's: {room['skip']!r}"
    before_current = current_item(room)["id"]
    owed_next = room["masterQueue"][0]

    # One member votes the song bad. Not enough voters: the room must not skip.
    host.click_xpath(VOTE_BAD, "the room's '1 · bad' vote button")

    def voted(room, count):
        return len((room.get("current") or {}).get("votes") or {}) == count

    wait_for(
        lambda: (lambda held: held if voted(held, 1) else None)(api_room(backend, room_id, token)),
        "the host's vote never reached the room",
        timeout=12,
    )
    voting = votes_view(host)
    assert voting["mine"] == "1 · bad", f"the host's own vote is not shown as cast: {voting!r}"
    assert "mean 1.00 from 1 vote(s)" in voting["summary"], f"the room view's tally is {voting['summary']!r}"
    wait_for(
        lambda: next(
            (row for row in listening_rows(host) if "voted 1" in row["marks"]),
            None,
        ),
        "the host's own vote is not on the Listening panel",
        timeout=12,
    )
    wait_for(
        lambda: next(
            (row for row in listening_rows(guest) if row["name"] == scene.host_member.username and "voted 1" in row["marks"]),
            None,
        ),
        "the host's vote never reached the guest's Listening panel",
        timeout=12,
    )

    # Nothing may skip on one member's vote, so the room's song must stand still.
    observe(host, 2.2, "the room's beat while one vote stands")
    still = api_room(backend, room_id, token)
    assert current_item(still)["id"] == before_current, (
        f"one vote skipped the room: it moved from {before_current!r} to {current_item(still)!r} "
        f"with {len((still.get('current') or {}).get('votes') or {})} vote(s)"
    )

    # The second member votes the same way, and now the rule is satisfied.
    guest.click_xpath(VOTE_BAD, "the guest's '1 · bad' vote button")

    def skipped():
        held = api_room(backend, room_id, token)
        return held if current_item(held).get("id") == owed_next["id"] else None

    after = wait_for(skipped, "two bad votes never skipped the room's track", timeout=15)
    assert current_item(after)["id"] == owed_next["id"], (
        f"the room is on {current_item(after)!r}, not {owed_next['title']!r}"
    )
    skipped_votes = (after.get("current") or {}).get("votes") or {}
    assert 1 not in skipped_votes.values(), (
        "the bad vote that skipped the song is held against the new one: "
        f"{skipped_votes!r}"
    )
    wait_order_matches(guest, backend, room_id, token, "the guest's page after a vote-skip")
    wait_playing(guest, backend, room_id, token, "the guest never moved on after a vote-skip")
    print(f"\nvotes: one member voting 1 did not skip {before_current[:8]}; two did "
          f"(now on {owed_next['title']!r})")
    host.assert_no_errors("the host")
    guest.assert_no_errors("the guest")


def test_a_pause_reaches_every_member(host, guest, backend, media_factory):
    """The host pauses and both elements stop; the host resumes and both go.

    A pause has to travel: the room's state is the only thing that may stop a
    member's music, so a member whose element kept running while the room sat
    paused is a room whose members hear different things.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=1, guest_tracks=1)
    token, room_id = scene.host_member.token, scene.room_id

    queue_favourites(host, scene.name)
    wait_queue_size(host, backend, room_id, token, 1, "the host's song never reached the room")
    wait_playing(host, backend, room_id, token, "the room never started playing")
    wait_playing(guest, backend, room_id, token, "the guest never started playing")

    started = time.monotonic()
    host.click_xpath(PAUSE_BUTTON, "the room's Pause button")

    def paused():
        room = api_room(backend, room_id, token)
        if not (room.get("current") or {}).get("paused"):
            return None
        if host.player()["paused"] is not True or guest.player()["paused"] is not True:
            return None
        return room

    room = host.wait(
        lambda: paused(),
        "the room's pause never reached both members' elements",
        timeout=15,
    )
    t_pause = _elapsed(started)
    for ui, side in ((host, "host"), (guest, "guest")):
        state = ui.player()
        assert state["paused"], f"the {side}'s element is not paused: {state!r}"
        ui.wait_xpath(RESUME_BUTTON, f"the {side}'s room view never offered Resume")

    # And back: a pause is a state, not a one-way door.
    started = time.monotonic()
    host.click_xpath(RESUME_BUTTON, "the room's Resume button")

    def resumed():
        room = api_room(backend, room_id, token)
        if (room.get("current") or {}).get("paused"):
            return None
        if host.player()["paused"] or guest.player()["paused"]:
            return None
        return room

    wait_for(resumed, "the room's resume never reached both members' elements", timeout=15)
    # Both clocks have to be running again, not just unpaused.
    host_before, guest_before = host.player()["currentTime"], guest.player()["currentTime"]
    host.wait_player(lambda state: state["currentTime"] > host_before + 0.4, "the host's clock never resumed", timeout=10)
    guest.wait_player(lambda state: state["currentTime"] > guest_before + 0.4, "the guest's clock never resumed", timeout=10)
    t_resume = _elapsed(started)
    print(f"\npause: both elements paused {t_pause * 1000:.0f} ms after the press; both resumed {t_resume * 1000:.0f} ms after Resume")
    host.assert_no_errors("the host")
    guest.assert_no_errors("the guest")


def test_members_converge_on_the_rooms_position(host, guest, backend, media_factory):
    """A room moved on the server drags both members' own playheads with it.

    The server's anchor is read from the API and each member's position from its
    own element; a member more than the room's tolerance away from the anchor is
    a member hearing a different part of the song.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=1, guest_tracks=1, seconds=120)
    token, room_id = scene.host_member.token, scene.room_id

    queue_favourites(host, scene.name)
    wait_queue_size(host, backend, room_id, token, 1, "the host's song never reached the room")
    wait_playing(host, backend, room_id, token, "the room never started playing")
    wait_playing(guest, backend, room_id, token, "the guest never started playing")

    # The room owns the position, so the move is asked of the room. The members'
    # job is to follow it, which is what the rest of this test measures.
    seek_to = 40000
    status, payload = backend.post(f"/api/v1/rooms/{room_id}/seek", {"positionMs": seek_to}, token=token)
    assert status == 200, f"seeking the room answered {status}: {payload!r}"
    started = time.monotonic()
    wait_for(
        lambda: (lambda room: room if ((room.get("current") or {}).get("positionMs") or 0) >= seek_to - 1000 else None)(
            api_room(backend, room_id, token)
        ),
        "the room never took the seek",
        timeout=12,
    )

    tolerance = 2500  # the client's own tolerance is 2000 ms

    def reading(ui):
        room = api_room(backend, room_id, token)
        current = room.get("current") or {}
        if not current.get("started") or current.get("paused"):
            return None
        room_ms = current["positionMs"] + (room["serverNowMs"] - current["atMs"])
        state = ui.player()
        if not state:
            return None
        local_ms = (state.get("currentTime") or 0) * 1000
        if local_ms < seek_to - 5000:
            return None
        if abs(local_ms - room_ms) > tolerance:
            return None
        return {"local": local_ms, "room": room_ms, "drift": local_ms - room_ms}

    for ui, side in ((host, "host"), (guest, "guest")):
        found = ui.wait(
            lambda ui=ui: reading(ui),
            f"the {side} never converged on the room's position after the seek",
            timeout=25,
        )
        t = _elapsed(started)
        print(f"\ndrift: the {side} reached {found['local'] / 1000:.2f}s of the room's {found['room'] / 1000:.2f}s "
              f"(drift {found['drift']:+.0f} ms) {t * 1000:.0f} ms after the seek")
    host.assert_no_errors("the host")
    guest.assert_no_errors("the guest")


def test_leaving_removes_the_member_on_both_sides(host, guest, backend, media_factory):
    """A member leaving is gone from the room, on the server and on the page.

    The host's Listening panel is the one that has to forget the guest, and the
    guest's own page has to stop being the room.
    """
    scene = open_scene(host, guest, backend, media_factory, host_tracks=1, guest_tracks=1)
    token, room_id = scene.host_member.token, scene.room_id
    assert scene.room()["memberCount"] == 2

    guest.click_xpath(LEAVE_BUTTON, f"the Leave button for {scene.name!r}")

    wait_for(
        lambda: (
            lambda room: room if [member.get("name") for member in room.get("members") or []] == [scene.host_member.username] else None
        )(api_room(backend, room_id, token)),
        "the room still counts the guest after they left",
        timeout=15,
    )
    wait_for(
        lambda: [(row["name"]) for row in listening_rows(host)] == [scene.host_member.username],
        "the host's Listening panel still shows the guest",
        timeout=15,
    )
    assert_listening(host, scene.room(), "the host's view after the guest left: ")

    # The guest's own page is no longer in the room: it is back at the list.
    guest.wait_js(
        "Boolean(document.querySelector(\"input[placeholder='New room name']\"))"
        " && !document.querySelector('.room-queue')",
        "the guest's page still looks like the room it left",
        timeout=15,
    )
    guest.wait(lambda: not (guest.storage() or {}).get("room"), "the guest's session still remembers the room it left")
    print(f"\nleaving: {scene.guest_member.username} left {scene.name!r}; the room now holds "
          f"{[member['name'] for member in scene.room()['members']]}")
    host.assert_no_errors("the host")
    guest.assert_no_errors("the guest")
