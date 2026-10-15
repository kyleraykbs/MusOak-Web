"""A song that is not downloaded yet plays now, and plays through to the end.

The backend can hand out a rendition it does not hold yet from the provider's
own fetch: the audio arrives as it is fetched, the download runs behind it, and
once the file lands the same URL answers with the whole file. This file drives
the app through that story the way a person does - a search row clicked, a seek
range dragged - and measures what the audio element actually does, because the
bar's label is not the truth about what is playing (see e2e/README.md).

Three things make that observable rather than hopeful, all of them in the
`-tags e2e` fake (`internal/provider/e2e_provider.go` in the sibling checkout):

* its download takes several seconds (a fetch in ten chunks, a settle, a
  reported conversion), so "the song started before its file existed" is a
  window and not a race;
* its stream is paced - one 32 KB piece every 250 ms - so the bytes arrive over
  seconds while the file is still being written;
* it writes every `start=` it is asked for to the server's own log
  (`e2e-slow: stream start=<ms>`), which is the only place a browser test can
  see what the provider received rather than only what a URL said.

Every test uses a song of its own. A rendition that already has a file is served
from disk and never streamed, and the suite's backend is shared by a whole run,
so the second test to ask for one song would find it downloaded.

Two readings the first afternoon of this file cost, both measured rather than
guessed:

* **A media element's own requests are not in Resource Timing.** The service
  worker answers `/api/v1/media/…` (it passes an unkept song's request through,
  Range header and all), and a worker's fetch is not the page's - so the page's
  performance timeline never shows the bytes. What the element was *asked* for
  is therefore read from the element's own `src`, which is the URL the app handed
  it and the request it made; what the provider *received* is read from the
  server log. Between them the URL and the fetch can be checked against each
  other, which is the pair a request that was ignored by the backend would fail.
* **The element's `duration` is not a stream/file marker.** Firefox estimates a
  duration for an Ogg stream from the bytes it has so far (measured: ~25 s for a
  30 s song whose stream is still arriving), so a finite duration does not mean
  a file. The app's own marker is the `start=` in the URL a stream is asked for.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.parse

import pytest

from conftest import sign_in_ui
from rooms_helpers import api_room, create_room, in_room_mode, observe, wait_for
from test_library import Account, row_xpath

pytestmark = [pytest.mark.slow]

#: The fake provider and the length every one of its songs has.
PROVIDER = "e2e-slow"
SONG_MS = 30_000

#: How often the element is sampled. The page repaints several times a second,
#: so this is finer than any reading the app could have missed.
STEP = 0.2
#: How long "it does not stop" watches the element. Long enough to cross the
#: moment the download lands and the file takes over.
WATCH_SECONDS = 6.5
#: How long the room's clock runs before the second member joins. Well inside
#: the fake's ~4.5 s download, so the join lands on a source still being fetched.
ROOM_WARMUP = 2.5
#: A first sound has to arrive inside this, measured from the click that asked
#: for it. The old behaviour - wait for the whole file - is several times over
#: it; a stream starts as soon as the provider's first piece is written.
FIRST_SOUND_BUDGET = 2.5
#: How far a position may be from the room's before it is not "roughly the
#: room's position": the join takes a moment, and the room's clock runs through
#: it.
ROOM_TOLERANCE_MS = 2500
#: How far a request's `start` may be from the position the app itself computed
#: for the seek. The position travels through the URL and the provider, and the
#: only rounding either of them does is to whole milliseconds.
SEEK_TOLERANCE_MS = 1500

#: What the fake writes for every stream request it answers:
#: `e2e-slow: stream start=15000`.
OFFSET_LINE = re.compile(r"e2e-slow: stream start=(\d+)")
STATUS_PATH = "/api/v1/media/{}/status"


# --- the API's truth --------------------------------------------------------


def fake_variant(backend, token, title):
    """The fake's rendition of `title`, as the API sees it: the id the page will
    fetch, so its requests can be checked against the right song."""
    query = urllib.parse.quote(title)
    status, payload = backend.get(f"/api/v1/search?q={query}&limit=5", token=token)
    assert status == 200, f"search for {title!r} answered {status}: {payload!r}"
    for group in (payload or {}).get("groups") or []:
        track = group.get("track") or {}
        if track.get("title") != title:
            continue
        for variant in group.get("variants") or []:
            if variant.get("provider") == PROVIDER:
                return variant
    raise AssertionError(
        f"the search answer never named a {PROVIDER!r} rendition of {title!r}: {payload!r}"
    )


def fresh_variant(backend, token, title):
    """A rendition with no file yet - the only kind that can be streamed."""
    variant = fake_variant(backend, token, title)
    state = (variant.get("media") or {}).get("state")
    assert state != "ready", (
        f"{title!r} is already downloaded (state {state!r}): a rendition served from disk is never "
        "streamed, so this test would not be about the thing it is named for"
    )
    return variant


def media_status(backend, token, variant_id):
    status, payload = backend.get(STATUS_PATH.format(variant_id), token=token)
    assert status == 200, f"the status of {variant_id} answered {status}: {payload!r}"
    return payload if isinstance(payload, dict) else {}


# --- the position in a URL, and what the provider actually got --------------


def start_param(url):
    """The position a media URL names, or None when it names none.

    That is the app's own marker for "this is a stream": a stream begins where
    its request said, and a whole file is asked for without a position."""
    raw = urllib.parse.parse_qs(urllib.parse.urlparse(url or "").query).get("start", [""])[0]
    return int(raw) if raw.isdigit() else None


def without_start(url):
    """The same media URL with no position: what the finished file answers."""
    parsed = urllib.parse.urlsplit(url)
    kept = [(name, value) for name, value in urllib.parse.parse_qsl(parsed.query) if name != "start"]
    return urllib.parse.urlunsplit((
        parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(kept), parsed.fragment,
    ))


def stream_offsets(backend, since=0):
    """Every `start=` the fake provider has been asked for since a log mark.

    The provider writes one line per stream request it answers, so this is what
    reached the provider rather than what a URL asked for - the other half of
    every position assertion in this file."""
    offsets = []
    for line in backend.process.log()[since:]:
        found = OFFSET_LINE.search(line)
        if found:
            offsets.append(int(found.group(1)))
    return offsets


def log_mark(backend):
    return len(backend.process.log())


def wait_for_offset(backend, since, position, tolerance, message):
    """Wait until the provider was asked to start at `position`.

    The found offset is returned inside a dict on purpose: zero is a position,
    and a bare `0` would read as "not yet"."""
    def found():
        for offset in stream_offsets(backend, since):
            if abs(offset - position) <= tolerance:
                return {"offset": offset}
        return None

    return wait_for(
        found,
        f"{message}\n  the provider was asked for {stream_offsets(backend, since)}",
        timeout=20,
    )["offset"]


# --- the page ---------------------------------------------------------------


def play_from_search(ui, title):
    """A search result clicked, which is how a person starts a provider song."""
    ui.click_tab("Search")
    ui.type("input[type='search']", title)
    ui.click("button[title='Search again']")
    ui.wait_xpath(row_xpath(title), f"the {title!r} search result")
    ui.click_xpath(row_xpath(title), f"the {title!r} search result")


def wait_streaming(ui, title, timeout=20.0):
    """Wait until the element is playing *that* song, from wherever it is.

    Not `test_library.wait_sounding`: that compares the element's own duration
    with the song's, which a streamed answer cannot answer (see the module
    docstring). The bar's title names the song; the element's clock is what it is
    doing."""
    def check():
        state = ui.player()
        if not state or not state["src"] or state["paused"]:
            return None
        if state["currentTime"] <= 0.05:
            return None
        if ui.now_playing() != title:
            return None
        return state

    return ui.wait(
        check,
        f"{title!r} never started playing: the bar says {ui.now_playing()!r} and the element is "
        f"{ui.player()!r}",
        timeout,
    )


def hand_element(state):
    """The element the player is on: the one the app names `data-e2e=audio`.

    Not the harness's own pick (the live or furthest element) - `_adoptCopy` moves
    that name to whichever element is playing at a hand-over, and it is the one
    the app's position arithmetic describes."""
    for element in state.get("elements") or []:
        if element.get("name") == "audio":
            return element
    return state


def element_now(ui):
    """The element in hand, read the way `sample` reads it."""
    state = ui.player() or {}
    element = hand_element(state)
    return {
        "src": element.get("src") or "",
        "currentTime": float(element.get("currentTime") or 0),
        "paused": bool(element.get("paused")),
        "duration": float(element.get("duration") or 0),
    }


def song_position_ms(element):
    """Where in the song the element is.

    A streamed answer begins where its request named, so the element's clock is
    that much short of the song's and the src carries the offset; a file is the
    song's own clock. The src's own `start` is what says which."""
    played = max(0.0, float(element.get("currentTime") or 0)) * 1000
    return played + (start_param(element.get("src")) or 0)


def sample(ui):
    element = element_now(ui)
    element["title"] = ui.now_playing()
    return element


def watch(ui, seconds, interval=STEP):
    """Sample the element for a measured window.

    Wall-clock time is measured, never waited on (see e2e/README.md: the only
    wait is between samples)."""
    samples = []
    deadline = time.monotonic() + seconds
    while True:
        samples.append(sample(ui))
        if time.monotonic() >= deadline:
            return samples
        time.sleep(interval)


def player_table(samples):
    return "\n".join(
        f"    {index:>2}  clock={item['currentTime']:6.2f}s  paused={str(item['paused']):<5}  "
        f"element-duration={item['duration']:>7.2f}s  bar={item['title']!r}"
        for index, item in enumerate(samples)
    )


def drag_seek(ui, per_mille):
    """A hand on the bar: the element's own pointer events, then a value.

    The bar only accepts a value from a hand (`_seekingByHand`), which is the
    rule that stops a repaint from seeking the room - so a test has to be a hand.
    The value is per-mille of the song (`0..1000`).

    The element's own duration is read in the same round trip, just before the
    value is dispatched: it is what the app's own arithmetic uses, and a stream's
    estimate of it grows as the bytes arrive, so reading it a round trip earlier
    would be reading a different number."""
    return ui.js(
        "const audio = document.querySelector('audio[data-e2e=\"audio\"]');"
        "const measured = audio && Number.isFinite(audio.duration) ? audio.duration : 0;"
        "const s = document.querySelector('.player-bar input[title=\"Seek\"]');"
        "if (!s) return null;"
        "s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));"
        "s.value = arguments[0];"
        "s.dispatchEvent(new Event('input', { bubbles: true }));"
        "s.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));"
        "return {value: s.value, max: s.max, measured: measured};",
        str(per_mille),
    )


def sign_in(ui, backend, prefix):
    account = Account(backend, prefix=prefix)
    sign_in_ui(ui, account)
    ui.wait_quiet()
    return account


# ============================================================================


def test_a_streamed_song_starts_before_its_file_is_here(ui, backend):
    """The song is audible while its download is still running.

    The two readings have to agree, and that is the point: a bar that says
    "playing" over a silent element, and a song that was really played from a
    file that had already landed, both fail here.
    """
    title = "E2E Stream One"
    account = sign_in(ui, backend, "stream-one")
    variant = fresh_variant(backend, account.token, title)
    variant_id = variant["id"]
    log = log_mark(backend)

    play_from_search(ui, title)
    asked = time.monotonic()
    state = wait_streaming(ui, title)
    first_sound = time.monotonic() - asked
    # The clock moving is what makes it a song rather than a paused element with
    # a source.
    before = state["currentTime"]
    moved = ui.wait_player(
        lambda s: s if s["currentTime"] > before + 0.3 else None,
        f"the streamed {title!r} never advanced its clock past {before:.2f}s",
    )
    sounding = time.monotonic() - asked
    src = element_now(ui)["src"]
    api = media_status(backend, account.token, variant_id)
    offsets = wait_for_offset(
        backend, log, 0, 0, f"the provider was never asked for the beginning of {title!r}"
    )

    print(
        f"\nfirst sound {first_sound:.2f}s after the click ({state['currentTime']:.2f}s of audio), "
        f"clock still moving at {sounding:.2f}s; the file is {api.get('state')!r} "
        f"({api.get('stage')}, {api.get('bytes')}/{api.get('totalBytes')} bytes); the element is "
        f"playing {src!r}; the provider was asked for start={offsets}"
    )

    assert variant_id in src, (
        f"the element is playing something other than {variant_id}: {src!r} - this test would be "
        "measuring another song"
    )
    assert start_param(src) == 0, (
        f"the element was given {src!r}: no position, so it is not a stream - a whole file is asked "
        "for without a start"
    )
    assert api.get("state") == "downloading", (
        f"the file was {api.get('state')!r} by the time the song was sounding: playing a rendition "
        f"the backend already holds is not this test\n  {api!r}"
    )
    assert api.get("stage") == "download", (
        f"the download was past its fetch when the first sound arrived ({api.get('stage')!r}), so "
        f"the element cannot have been playing the provider's stream\n  {api!r}"
    )
    assert moved["currentTime"] > before > 0.05 and first_sound < FIRST_SOUND_BUDGET, (
        f"the first sound took {first_sound:.2f}s, over the {FIRST_SOUND_BUDGET}s budget: the "
        f"element was waiting for the file rather than playing the stream"
    )

    ui.assert_no_errors("streaming a song before its file exists")


def test_a_streamed_song_plays_through_without_stopping(ui, backend):
    """Six seconds of one streamed song: the clock only ever goes forwards.

    This window crosses the moment the download lands, so it is also where a
    hand-over that rewound the song, restarted it, or left it paused would show.
    """
    title = "E2E Stream Two"
    account = sign_in(ui, backend, "stream-two")
    variant = fresh_variant(backend, account.token, title)
    variant_id = variant["id"]

    play_from_search(ui, title)
    wait_streaming(ui, title)
    samples = watch(ui, WATCH_SECONDS)
    api = media_status(backend, account.token, variant_id)

    print("\n--- six seconds of a streamed song")
    print(player_table(samples))
    print(f"    the file behind it is {api.get('state')!r}")

    paused = [index for index, item in enumerate(samples) if item["paused"]]
    assert not paused, (
        f"the element was paused at sample(s) {paused}: a stream that stops is the silence this "
        f"exists to prevent\n{player_table(samples)}"
    )
    assert all(item["src"] for item in samples), (
        f"the element lost its source mid-song\n{player_table(samples)}"
    )
    # Monotonic, and never back to the top: a restart is a stop, which is the
    # thing this song must not do. Measured against the highest reading so far,
    # with a small allowance for a sample taken during a hand-over (two elements
    # are alive for a moment, and a sample may catch either).
    highest = 0.0
    back = []
    for index, item in enumerate(samples):
        if item["currentTime"] < highest - 0.3:
            back.append((index, highest, item["currentTime"]))
        highest = max(highest, item["currentTime"])
    assert not back, (
        f"the clock went backwards at {back} (sample, highest before it, reading): a song that "
        f"restarts is a song that stopped\n{player_table(samples)}"
    )
    assert highest > 5, (
        f"the streamed song only ever reached {highest:.2f}s: it did not play through\n"
        f"{player_table(samples)}"
    )
    moved = [index for index, item in enumerate(samples) if item["title"] != title]
    assert not moved, (
        f"the bar stopped naming {title!r} at sample(s) {moved}: the app advanced away from a song "
        f"that was still playing (it said {samples[moved[0]]['title']!r})\n{player_table(samples)}"
    )

    ui.assert_no_errors("watching a streamed song play through")


@pytest.mark.browsers
def test_a_room_joined_mid_song_starts_near_where_it_is(host, guest, backend):
    """A second member joins a room whose song is a few seconds in, and the first
    bytes their page asks for name that position.

    Read from both sides of the same fact: the URL the joining page handed its
    element (which carries the position it wants), and the offset the provider
    was actually asked for (which is the only proof the request reached it).
    """
    title = "E2E Stream Three"
    host_account = sign_in(host, backend, "stream-room-host")
    guest_account = sign_in(guest, backend, "stream-room-guest")
    variant = fresh_variant(backend, host_account.token, title)
    variant_id = variant["id"]

    name = f"stream-{os.urandom(3).hex()}"
    room_id = create_room(host, name)
    in_room_mode(host, room_id)
    # In a room, playing a song queues it there instead of playing it locally -
    # and the room then starts it, which is the song the guest joins.
    play_from_search(host, title)
    wait_for(
        lambda: (
            lambda room: room
            if (room.get("current") or {}).get("item", {}).get("title") == title
            and (room.get("current") or {}).get("started")
            else None
        )(api_room(backend, room_id, host_account.token)),
        f"the room never started {title!r}",
        timeout=20,
    )
    wait_streaming(host, title)
    # Let the room's clock run: the guest is joining a song already under way.
    observe(host, ROOM_WARMUP, "the room's song never got a few seconds in")

    # The guest joins without a navigation, so nothing here depends on a reload
    # (and the log mark is only about which requests are this guest's).
    guest.click_tab("Rooms")
    row = (
        "//div[contains(@class,'list')]//div[contains(@class,'row')]"
        f"[.//div[contains(@class,'title')][contains(., {json.dumps(name)})]]"
    )
    guest.wait_xpath(row, f"{name!r} never appeared in the guest's rooms list")
    log = log_mark(backend)
    guest.click_xpath(row + "//button[contains(@title, 'Join')]", f"Join {name!r}")
    in_room_mode(guest, room_id)

    # The URL the guest's page gave its element for the room's song: a stream is
    # asked for at a position, and this is the position it asked for.
    src = guest.wait(
        lambda: (lambda url: url if url and start_param(url) is not None else None)(
            element_now(guest)["src"]
        ),
        f"the guest's element was never given {title!r} at a position - a member joining a song "
        f"already playing would be handed its head",
        timeout=25,
    )
    start_ms = start_param(src)
    state = wait_streaming(guest, title)
    # Where the room is, read while the guest's element is playing.
    room = api_room(backend, room_id, host_account.token)
    current = room.get("current") or {}
    room_ms = current.get("positionMs", 0) + (room.get("serverNowMs", 0) - current.get("atMs", 0))
    guest_ms = song_position_ms(element_now(guest))
    status = media_status(backend, guest_account.token, variant_id)
    reached = wait_for_offset(
        backend, log, start_ms, ROOM_TOLERANCE_MS,
        f"nothing was asked of the provider from the room's position ({start_ms}ms) after the guest "
        "joined",
    )

    print(
        f"\nthe room is at {room_ms / 1000:.2f}s; the guest's element was handed {src!r} and the "
        f"provider was asked for start={reached}; its element is at {guest_ms / 1000:.2f}s; the "
        f"rendition is {status.get('state')!r}"
    )

    assert abs(start_ms - room_ms) < ROOM_TOLERANCE_MS, (
        f"the guest was handed start={start_ms} while the room was at {room_ms:.0f}ms, more than the "
        f"{ROOM_TOLERANCE_MS}ms a join takes\n  {src}"
    )
    assert variant_id in src, f"the guest's element is playing another song: {src!r}"
    assert state["currentTime"] > 0.05 and not state["paused"], (
        f"the guest's element is not playing the room's song: {state!r}"
    )
    assert abs(guest_ms - room_ms) < ROOM_TOLERANCE_MS, (
        f"the guest is hearing {guest_ms:.0f}ms of the song while the room is at {room_ms:.0f}ms"
    )

    host.assert_no_errors("the host with a room joined mid-song")
    guest.assert_no_errors("the guest joining a room mid-song")


def test_a_seek_inside_a_stream_asks_for_the_position_and_keeps_playing(ui, backend):
    """A seek while the file is still downloading is a new request, not a range.

    A streamed answer has no length to seek within, so the position has to be
    part of a new request - and the provider has to be told it. Both are
    measured: the URL the page handed its element, and the offset the fake wrote
    down for it.
    """
    title = "E2E Stream Four"
    account = sign_in(ui, backend, "stream-seek")
    variant = fresh_variant(backend, account.token, title)
    variant_id = variant["id"]

    play_from_search(ui, title)
    wait_streaming(ui, title)
    ui.wait_player(
        lambda s: s if s["currentTime"] > 0.4 else None,
        "the streamed song never got going before the seek",
    )
    api = media_status(backend, account.token, variant_id)
    assert api.get("state") == "downloading", (
        f"the file was already {api.get('state')!r} before the seek: the seek was meant to land "
        "inside a stream"
    )
    playing_src = element_now(ui)["src"]
    log = log_mark(backend)
    bar = drag_seek(ui, 500)
    assert bar and bar.get("max") == "1000", f"the seek bar is not there: {bar!r}"
    # Half the song, which is a position the stream has no bytes for. The range
    # is per-mille of the length the app knows, and the fake's song is 30 s, so
    # the middle is 15000ms. The element's own figure is printed rather than
    # used: a stream's estimate grows as the bytes arrive (measured 6s, 12s,
    # 19s, 23s, 30s for this song), so a seek must be measured against the
    # length the app knows and not against the browser's guess.
    target = SONG_MS // 2

    src = ui.wait(
        lambda: (lambda url: url if url and url != playing_src and start_param(url) is not None else None)(
            element_now(ui)["src"]
        ),
        f"seeking inside {title!r} never gave the element a new position to play from",
        timeout=15,
    )
    reached = wait_for_offset(
        backend, log, target, SEEK_TOLERANCE_MS,
        f"the provider was never asked to start near the seek target {target}ms",
    )
    after = ui.wait_player(
        lambda s: s if not s["paused"] and s["currentTime"] > 0.3 else None,
        f"the seeked {title!r} never carried on playing",
    )

    print(
        f"\nthe seek bar was at {bar['value']}/1000; the element's own duration estimate was "
        f"{bar['measured']:.2f}s, the song's middle is {target}ms; the element was handed {src!r}; "
        f"the provider was asked for {reached}; it carried on {after['currentTime']:.2f}s into the "
        f"new stream (position {song_position_ms(element_now(ui))}ms)"
    )

    assert abs(start_param(src) - target) <= SEEK_TOLERANCE_MS, (
        f"a seek to the middle of the {SONG_MS}ms song was handed {src!r}: the position the app "
        f"knows the song to be is not the one it asked for"
    )
    assert 0 < start_param(src) < SONG_MS, (
        f"start={start_param(src)} is not a position inside the {SONG_MS}ms song"
    )
    assert abs(reached - target) <= SEEK_TOLERANCE_MS, (
        f"the provider was asked to start at {reached}ms, not the app's own target {target}ms: the "
        "URL and the fetch disagree about where the song should begin"
    )
    assert variant_id in src, f"the seek asked for another song: {src!r}"
    assert not after["paused"] and after["currentTime"] > 0.3, (
        f"the sound stopped when the seek reconnected the stream: {after!r}"
    )
    position = song_position_ms(element_now(ui))
    assert start_param(src) - 1 <= position <= SONG_MS, (
        f"after the seek the element is at {position:.0f}ms, outside the section it was handed "
        f"({start_param(src)}ms to the end)"
    )

    ui.assert_no_errors("seeking inside a stream")


def test_the_file_takes_over_from_the_stream(ui, backend):
    """The download lands while the song plays, and the same song carries on from
    the file: no rewind, a seekable timeline, and a replay served from disk."""
    title = "E2E Stream Five"
    account = sign_in(ui, backend, "stream-file")
    variant = fresh_variant(backend, account.token, title)
    variant_id = variant["id"]

    play_from_search(ui, title)
    wait_streaming(ui, title)
    stream_src = element_now(ui)["src"]
    assert start_param(stream_src) == 0, (
        f"the element is not on a stream before the file lands: its src is {stream_src!r}"
    )

    ready = wait_for(
        lambda: (lambda s: s if s.get("state") == "ready" else None)(
            media_status(backend, account.token, variant_id)
        ),
        f"{title!r} never finished downloading",
        timeout=30,
    )
    # The hand-over is the app's own work: watch the clock across it.
    across = watch(ui, 2.0, interval=0.1)
    here = sample(ui)
    on_disk = os.path.join(backend.storage_dir, "media", f"{variant_id}.opus")

    # The app's own move onto the file: the URL the element is given no longer
    # names a position. (A whole file is asked for without one.)
    assert here["src"] != stream_src, (
        f"the element is still on the streaming URL after the file landed: {stream_src!r}"
    )
    assert start_param(here["src"]) is None, (
        f"the element's src still names a stream position after the file landed: {here['src']!r}"
    )
    # And the server answers the same rendition as the file: a range, an ETag, no
    # stream marker. This is a request the test makes from the page, because the
    # element's own requests are not in Resource Timing (see the module docstring).
    evidence = ui.js_async(
        "const response = await fetch(arguments[0], { headers: { Range: 'bytes=0-1023' } });"
        "await response.arrayBuffer();"
        "return {status: response.status,"
        "  stream: response.headers.get('X-Musoak-Stream'),"
        "  etag: response.headers.get('ETag'),"
        "  type: response.headers.get('Content-Type'),"
        "  contentRange: response.headers.get('Content-Range'),"
        "  duration: response.headers.get('X-Musoak-Duration')};",
        without_start(stream_src),
    )

    print("\n--- the hand-over")
    print(player_table(across))
    print(
        f"    the file landed: {ready.get('state')} durationMs={ready.get('durationMs')}; the "
        f"element's src is now {here['src']!r} (was {stream_src!r})"
    )
    print(f"    a ranged request for the same rendition answered {evidence}")
    print(f"    the file on disk: {on_disk} ({os.path.exists(on_disk)})")

    assert evidence["stream"] is None and evidence["etag"], (
        f"the finished rendition still answers as a stream rather than as the file it now is: "
        f"{evidence}"
    )
    assert evidence["status"] == 206 and evidence["contentRange"], (
        f"a byte range of the finished rendition was not answered as a range: {evidence}"
    )
    assert os.path.exists(on_disk), (
        f"the status said ready but {on_disk} is missing: the row and the file disagree"
    )

    # No rewind across the hand-over, and it is the same song playing.
    falls = [
        (index, across[index - 1]["currentTime"], item["currentTime"])
        for index, item in enumerate(across)
        if index and item["currentTime"] < across[index - 1]["currentTime"] - 0.3
    ]
    assert not falls, f"the hand-over rewound the song at {falls}\n{player_table(across)}"
    assert across[-1]["currentTime"] > across[0]["currentTime"], (
        f"the song did not carry on across the hand-over\n{player_table(across)}"
    )
    moved = [index for index, item in enumerate(across) if item["title"] != title]
    assert not moved, (
        f"the bar left {title!r} for {across[moved[0]]['title']!r} during the hand-over"
    )
    assert across[-1]["duration"] > 25, (
        f"the element still does not know the song's length ({across[-1]['duration']:.1f}s): it is "
        f"not on a whole source\n{player_table(across)}"
    )

    # A replay from the start is instant: a seek to the head of a source that is
    # already here is a jump within it, and the provider is not asked for
    # anything - which is what would happen if the element went back to a stream.
    replay_log = log_mark(backend)
    bar = drag_seek(ui, 0)
    at_head = ui.wait_player(
        lambda s: s if s["currentTime"] < 0.5 else None,
        "the replay did not jump to the start of the song",
        timeout=5,
    )
    # A negative assertion can only be made by watching a real window (see
    # e2e/README.md): a request that was going to be made would be in the log by
    # the end of it.
    observe(ui, 0.5, "the replay was not watched long enough to say it asked for nothing")
    fetched = stream_offsets(backend, replay_log)
    print(
        f"    a replay reached {at_head['currentTime']:.2f}s of the song; the provider was asked "
        f"for {fetched}; bar={bar}"
    )
    assert not fetched, (
        f"replaying from the start asked the provider for another stream: {fetched}"
    )

    ui.assert_no_errors("handing over from a stream to the file")