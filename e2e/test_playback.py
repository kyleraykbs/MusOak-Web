"""A song starts quickly, and once it is sounding it never stops, rewinds or reloads.

This is the player's contract, measured on the element a listener hears rather
than on the bar's label (see e2e/README.md). Each scenario reaches a song a
different way and asserts the same invariants:

* a song from search - it may stream before its file exists and hand over to
  the file once it lands;
* a song already on disk, played again - it must not be re-sourced while it
  plays (the mid-play reload this file was written against);
* a shuffled playlist - the first song starts promptly and the change to the
  next song is not a rewind;
* a song restored after a reload - Play must start at the position it was left,
  not at the head;
* a room member joining a song already on disk - the first sound is at the
  room's position, with a larger budget and a forward re-sync allowed.

Invariants (`assert_smooth`): the first sound is inside the budget; the bar
keeps naming the song; the song position never moves back by more than
`BACKSTEP_MS` between sounding samples; the song keeps `KEEP_PACE` of wall time;
and the element passes through no more distinct sources than the scenario allows.
"""

from __future__ import annotations

import json
import os
import time

from conftest import sign_in_ui
from rooms_helpers import api_room, create_room, in_room_mode, join_room, observe, wait_for
from test_streaming import (
    SONG_MS,
    STEP,
    WATCH_SECONDS,
    drag_seek,
    element_now,
    fresh_variant,
    log_mark,
    media_status,
    play_from_search,
    player_table,
    sign_in,
    song_position_ms,
    start_param,
    stream_offsets,
    wait_streaming,
    watch,
)

# --- the contract's numbers ---------------------------------------------------

#: First sound from the press that asked for it: the budget test_streaming holds
#: a search song to.
FIRST_SOUND_BUDGET = 2.5
#: A room join is a second person into a clock already running, so its first
#: sound is allowed longer.
ROOM_FIRST_SOUND_BUDGET = 5.0
#: How far the song position may move back between two sounding samples before
#: it is a backstep. Samples are STEP apart and the clock only moves forward, so
#: this is slack for the sampler and never a real rewind.
BACKSTEP_MS = 400
#: The share of wall time the song must gain while sounding. A healthy stream or
#: file keeps pace; a hitch that holds the clock still falls well below this.
KEEP_PACE = 0.8
#: How far the audio may start from the position asked for. The position travels
#: through a URL and the provider rounds to whole ms, and a room clock moves
#: while the join takes a moment.
POSITION_TOLERANCE_MS = 1500
#: The position the restore scenario plays to before the reload. Well past the
#: head, and short of the fake's SONG_MS end.
POSITION_MS = 12_000
#: How long a room's song runs before the guest joins.
ROOM_WARMUP = 3.0


# --- the checks -----------------------------------------------------------------


def wait_first_sound(ui, title, budget, since_click, where):
    """Block until `title` is sounding, and fail if it took longer than `budget`
    from the press. `since_click` is the monotonic time of that press, so the
    budget is what a listener waited."""
    wait_streaming(ui, title, timeout=budget + 10)
    elapsed = time.monotonic() - since_click
    assert elapsed <= budget, (
        f"{where}: the first sound took {elapsed:.2f}s, over the {budget:.1f}s budget"
    )
    return elapsed


def assert_smooth(ui, title, *, budget, since_click, sources_allowed, seconds=WATCH_SECONDS, where):
    """Watch the song sound and assert it does not hitch. Returns the samples and
    the first-sound time."""
    first_sound = wait_first_sound(ui, title, budget, since_click, where)
    samples = watch(ui, seconds)
    table = player_table(samples)

    sounding = [item for item in samples if not item["paused"] and item["currentTime"] > 0.05]
    assert sounding, f"{where}: nothing was sounding during the watch:\n{table}"

    for item in samples:
        assert item["title"] == title, (
            f"{where}: the bar changed to {item['title']!r} while {title!r} was meant to play:\n{table}"
        )
    first_index = samples.index(sounding[0])
    assert not any(item["paused"] for item in samples[first_index:]), (
        f"{where}: the song paused after it had started sounding:\n{table}"
    )

    srcs = []
    for item in samples:
        if not srcs or srcs[-1] != item["src"]:
            srcs.append(item["src"])
    assert len(srcs) <= sources_allowed, (
        f"{where}: the element passed through {len(srcs)} sources, {sources_allowed} allowed - "
        f"a re-source while the song was playing:\n{table}\n  sources: {srcs}"
    )

    for before, after in zip(sounding, sounding[1:]):
        moved = song_position_ms(after) - song_position_ms(before)
        assert moved >= -BACKSTEP_MS, (
            f"{where}: the song went back {-moved:.0f}ms between two samples - a restart or a "
            f"re-source to an earlier place:\n{table}"
        )

    first, last = sounding[0], sounding[-1]
    gained = song_position_ms(last) - song_position_ms(first)
    wall = (samples.index(last) - first_index) * STEP
    if wall > 0:
        pace = gained / (wall * 1000)
        assert pace >= KEEP_PACE, (
            f"{where}: the song gained {gained:.0f}ms over {wall:.1f}s of wall time ({pace:.0%}); "
            f"a hitch held it still, below the {KEEP_PACE:.0%} the contract allows:\n{table}"
        )
    return {"samples": samples, "first_sound": first_sound, "sources": srcs}


def assert_audio_at(ui, backend, *, position_ms, since_log, where):
    """The audio is at the position asked for.

    Two honest readings, and which one is the truth depends on what the element
    in hand holds. A whole source - a file the server has, or the page's own copy
    - begins at the beginning of the song, so the element's own clock *is* the
    position, and it is asserted exactly: a file that plays from the top while
    the provider was asked for a section is the defect this catches. A stream's
    clock starts where its URL asked to, so there the position is that offset
    plus the clock, and the provider's own record of what it was asked (see
    `stream_offsets`) is what stands in for the offset the page recorded.

    Reading the larger of the two, which is what this used to do, passes a file
    playing from the top whenever the provider was asked for the position - which
    is exactly the "picked back up, plays from the beginning" a listener reported
    with the file already on disk."""
    element = element_now(ui)
    played = element["currentTime"] * 1000
    src = element.get("src") or ""
    whole = src.startswith("blob:") or "start=" not in src
    if whole:
        assert abs(played - position_ms) <= POSITION_TOLERANCE_MS, (
            f"{where}: the element in hand holds a whole source and its clock is at "
            f"{played:.0f}ms, the listener asked for {position_ms}ms, and nothing seeked it: {element!r}"
        )
        return
    offsets = stream_offsets(backend, since_log)
    provider = max(offsets) if offsets else 0
    audio_at = provider + played
    assert abs(audio_at - position_ms) <= POSITION_TOLERANCE_MS, (
        f"{where}: the audio is at {audio_at:.0f}ms, the listener asked for {position_ms}ms. "
        f"The element clock is {played:.0f}ms, the provider was asked for "
        f"{offsets or 'nothing'}, and the element is {element!r}"
    )


def wait_for_disk(backend, token, variant_id):
    """Wait until a rendition's file has landed on disk."""
    return wait_for(
        lambda: media_status(backend, token, variant_id).get("state") == "ready" or None,
        "the download never finished",
        timeout=40,
    )


def _playlist_row(name):
    """The XPath of a playlist's row in the Playlists tab, by its own name."""
    return (
        "//div[contains(@class,'row')]"
        f"[.//div[contains(@class,'title')][normalize-space(.)={json.dumps(name)}]]"
    )


def make_playlist(backend, token, name, track_ids):
    status, playlist = backend.post("/api/v1/me/playlists", {"name": name}, token=token)
    assert status in (200, 201) and (playlist or {}).get("id"), (
        f"creating the playlist answered {status}: {playlist}"
    )
    status, detail = backend.post(
        f"/api/v1/me/playlists/{playlist['id']}/items", {"trackIds": track_ids}, token=token
    )
    assert status == 200, f"adding tracks answered {status}: {detail}"
    return playlist["id"]


# --- scenario 1: a song from search ---------------------------------------------


def test_a_song_from_search_starts_quickly_and_never_hitches(ui, backend, signed_in):
    """A song with no file yet. The stream starts at once and hands over to the
    file when it lands; the handover must not be heard as a hitch. `fresh_variant`
    refuses a rendition already on disk, so the test is about the stream."""
    title = "E2E Stream Six"
    fresh_variant(backend, signed_in.token, title)
    ui.goto("/")
    ui.click_tab("Search")
    since = time.monotonic()
    play_from_search(ui, title)

    result = assert_smooth(
        ui,
        title,
        budget=FIRST_SOUND_BUDGET,
        since_click=since,
        sources_allowed=2,
        where="from search",
    )
    print(f"  first sound {result['first_sound']:.2f}s; sources {len(result['sources'])}")
    ui.assert_no_errors("playing a song from search")


# --- scenario 2: a song already on disk, played again ---------------------------


def test_a_song_on_disk_plays_again_without_a_reload(ui, backend, signed_in):
    """A downloaded song starts at once from the file and is not re-sourced while
    it plays. Once the first play has landed the file, a second play must not ask
    the provider for anything, and the element keeps one source for the watch. A
    second source here is the mid-play reload."""
    title = "E2E Stream Seven"
    variant = fresh_variant(backend, signed_in.token, title)
    ui.goto("/")
    ui.click_tab("Search")
    play_from_search(ui, title)
    wait_streaming(ui, title, timeout=30)
    wait_for_disk(backend, signed_in.token, variant["id"])

    ui.click_tab("Search")
    log = log_mark(backend)
    since = time.monotonic()
    play_from_search(ui, title)

    result = assert_smooth(
        ui,
        title,
        budget=FIRST_SOUND_BUDGET,
        since_click=since,
        sources_allowed=1,
        where="played again, on disk",
    )
    offsets = stream_offsets(backend, log)
    assert not offsets, (
        f"a song already on disk was streamed from the provider again: asked for {offsets}"
    )
    last = result["samples"][-1]
    assert start_param(last["src"]) is None, (
        f"the file was asked for at a position on a plain play: {last['src']!r}"
    )
    print(f"  first sound {result['first_sound']:.2f}s; one source; no provider request")
    ui.assert_no_errors("replaying a song on disk")


# --- scenario 3: a shuffled playlist --------------------------------------------


def test_a_shuffled_playlist_plays_through_without_hitches(ui, backend, signed_in):
    """A playlist of the user's own tracks, played shuffled. The first song starts
    promptly and holds, and the change to the next song is not a rewind of the
    song that was playing."""
    name = f"Shuffle {os.urandom(2).hex()}"
    make_playlist(backend, signed_in.token, name, [t["trackId"] for t in signed_in.tracks])

    sign_in_ui(ui, signed_in)
    ui.goto("/")
    ui.click_tab("Playlists")
    ui.click_xpath(_playlist_row(name), f"the row for {name!r}")
    ui.click_text("Shuffle", css="button")
    since = time.monotonic()

    first_title = ui.now_playing()
    wait_for(
        lambda: bool(ui.now_playing()) or None,
        "the shuffled playlist never named a song",
        timeout=FIRST_SOUND_BUDGET + 10,
    )
    first_title = ui.now_playing()
    result = assert_smooth(
        ui,
        first_title,
        budget=FIRST_SOUND_BUDGET,
        since_click=since,
        sources_allowed=1,
        seconds=min(WATCH_SECONDS, 4.0),
        where="shuffled, first song",
    )

    # Watch across the change of song.
    later = watch(ui, SONG_MS / 1000 * 0.5)
    changed = [item for item in later if item["title"] != first_title and not item["paused"]]
    assert changed, (
        f"the shuffled playlist never moved on from {first_title!r}:\n{player_table(later)}"
    )
    next_title = changed[0]["title"]
    seen_first_after = [item for item in later[later.index(changed[0]):] if item["title"] == first_title]
    assert not seen_first_after, (
        f"{first_title!r} came back after the change to {next_title!r}:\n{player_table(later)}"
    )
    for before, after in zip(later, later[1:]):
        if before["title"] != after["title"] or before["paused"] or after["paused"]:
            continue
        moved = song_position_ms(after) - song_position_ms(before)
        assert moved >= -BACKSTEP_MS, (
            f"{after['title']!r} went back {-moved:.0f}ms after the change of song:\n"
            f"{player_table(later)}"
        )
    print(f"  first sound {result['first_sound']:.2f}s; shuffled on to {next_title!r}")
    ui.assert_no_errors("playing a shuffled playlist")


# --- scenario 4: a restored song ------------------------------------------------


def test_a_restored_song_starts_where_it_left_off(ui, backend, signed_in):
    """A song reloaded mid-listen. The page restores it paused, and Play must start
    the audio at the place it was left, not at the head.

    Reported defect: a fresh page has never asked about this song, so its first
    load is an unknown status, and the file is on disk. The file answers whole and
    ignores the position; nothing seeked the element, so it plays from the top
    under a bar that names the restored place, then jumps when the handover lands.

    Setup is the listener's own actions: play the song, drag the seek to
    `POSITION_MS`, wait for the file to land, reload. `pagehide` saves the
    position on the way out (player.js `savePlaybackNow`), so the reload restores
    the current place rather than the last 5 s save."""
    title = "E2E Stream Eight"
    variant = fresh_variant(backend, signed_in.token, title)
    sign_in_ui(ui, signed_in)
    ui.goto("/")
    ui.click_tab("Search")
    play_from_search(ui, title)
    wait_streaming(ui, title, timeout=30)
    wait_for_disk(backend, signed_in.token, variant["id"])
    drag_seek(ui, round(POSITION_MS / SONG_MS * 1000))
    wait_for(
        lambda: song_position_ms(element_now(ui)) >= POSITION_MS - POSITION_TOLERANCE_MS or None,
        f"the seek to {POSITION_MS}ms never took",
        timeout=20,
    )

    ui.reload()
    wait_for(
        lambda: ui.now_playing() == title and bool(element_now(ui)["src"]) or None,
        f"{title!r} was not restored after the reload",
        timeout=30,
    )
    log = log_mark(backend)
    since = time.monotonic()
    ui.click(".player-bar button.play")

    wait_first_sound(ui, title, FIRST_SOUND_BUDGET, since, "restored song")
    assert_audio_at(
        ui, backend, position_ms=POSITION_MS, since_log=log, where="restored song, first sound"
    )
    result = assert_smooth(
        ui,
        title,
        budget=FIRST_SOUND_BUDGET,
        since_click=since,
        sources_allowed=2,
        where="restored, after play",
    )
    print(f"  restored sound at the position; sources {len(result['sources'])}")
    ui.assert_no_errors("playing a restored song")


# --- scenario 4b: picked up with the file still coming ---------------------------


def test_a_song_picked_up_while_its_file_was_still_coming_starts_where_it_was(
    ui, backend, signed_in
):
    """The same press, one second into the song, with the file not on disk yet.

    The pick-up above reloads a song the server already holds, and the page can
    hand the element that whole file. Here it cannot: a second of the song has
    been heard and the download behind it is still running, so the sound comes
    from the provider's stream - and the position has to survive that, and the
    file landing behind it while the song plays. That hand-over is what a
    listener over a network hears as "it starts, then stops and loads again", and
    the position is what they hear as "it started from the beginning"."""
    title = "E2E Stream Ten"
    variant = fresh_variant(backend, signed_in.token, title)
    sign_in_ui(ui, signed_in)
    ui.goto("/")
    ui.click_tab("Search")
    play_from_search(ui, title)
    wait_streaming(ui, title, timeout=30)
    time.sleep(1.2)

    ui.reload()
    wait_for(
        lambda: ui.now_playing() == title and bool(element_now(ui)["src"]) or None,
        f"{title!r} was not restored after the reload",
        timeout=30,
    )
    # What the app itself says it picked up is what the press has to honour.
    status, document = backend.get("/api/v1/me/playback", token=signed_in.token)
    picked_from = int(document["state"]["positionMs"])
    assert picked_from > 500, f"there was nothing to pick up: {document!r}"
    print(f"  picked up from {picked_from}ms with the file {media_status(backend, signed_in.token, variant['id']).get('state')}")

    log = log_mark(backend)
    since = time.monotonic()
    ui.click(".player-bar button.play")
    wait_first_sound(ui, title, FIRST_SOUND_BUDGET, since, "picked up mid-download")
    assert_audio_at(
        ui,
        backend,
        position_ms=picked_from,
        since_log=log,
        where="picked up while its file was still coming",
    )
    result = assert_smooth(
        ui,
        title,
        budget=FIRST_SOUND_BUDGET,
        since_click=since,
        sources_allowed=2,
        where="picked up while its file was still coming",
    )
    print(f"  picked-up sound at the position; sources {len(result['sources'])}")
    ui.assert_no_errors("playing a song picked up mid-download")


# --- scenario 5: a room member joins a song already on disk ----------------------


def test_a_guest_joining_a_downloaded_song_starts_at_the_room_position(
    ui, host, guest, backend
):
    """A member joins a room whose song is already on disk. Their first sound is at
    the room's position and does not restart or rewind once heard. A room may
    re-sync forward and has a larger first-sound budget, since a second person is
    joining a clock already running. A backward move or a start from the top is
    never allowed; a downloaded song is what makes that sharp, because a file
    ignores `?start=` and the guest must be seeked to the room's position."""
    title = "E2E Stream Nine"
    host_account = sign_in(host, backend, "playback-room-host")
    guest_account = sign_in(guest, backend, "playback-room-guest")
    variant = fresh_variant(backend, host_account.token, title)
    play_from_search(host, title)
    wait_streaming(host, title, timeout=30)
    wait_for_disk(backend, host_account.token, variant["id"])
    host.wait_quiet()

    name = f"playback-{os.urandom(3).hex()}"
    room_id = create_room(host, name)
    in_room_mode(host, room_id)
    play_from_search(host, title)
    wait_for(
        lambda: _room_is_playing(backend, room_id, host_account.token, title),
        f"the room never started {title!r}",
        timeout=25,
    )
    observe(host, ROOM_WARMUP, "the room's song was not a few seconds in")

    join_room(guest, name)
    in_room_mode(guest, room_id)
    room = api_room(backend, room_id, guest_account.token)
    current = room["current"]
    room_ms = current["positionMs"] + (room["serverNowMs"] - current["atMs"])

    log = log_mark(backend)
    since = time.monotonic()
    wait_first_sound(guest, title, ROOM_FIRST_SOUND_BUDGET, since, "guest joining a room")
    assert_audio_at(
        guest,
        backend,
        position_ms=room_ms,
        since_log=log,
        where="guest joining a downloaded room song",
    )
    result = assert_smooth(
        guest,
        title,
        budget=ROOM_FIRST_SOUND_BUDGET,
        since_click=since,
        sources_allowed=2,
        where="guest in a room",
    )
    print(f"  guest first sound {result['first_sound']:.2f}s at the room's position")
    guest.assert_no_errors("a guest joining a room song")


def _room_is_playing(backend, room_id, token, title):
    current = (api_room(backend, room_id, token) or {}).get("current") or {}
    if (current.get("item") or {}).get("title") == title and current.get("started"):
        return True
    return None

