"""The library, driven the way a person drives it.

Everything here goes through the page a person sees: the registration form, the
upload view's file picker, a song row's own menu, the Queue page, and the
transport in the player bar. The audio element is the truth about what is
playing and the bar is what the app *says*; every assertion that a song plays
reads both and requires them to agree, because the two disagreeing is the bug
this suite exists to catch.

Two things this file measures rather than assumes:

* how long a press of Next takes to make a sound. The app warms the songs ahead
  of the playhead (and keeps the first few on this device), so the next song is
  a hand-over, not a download - the user's "songs take a while to load" is that
  hand-over failing, and the number is printed and bounded;
* how many media requests a second play of the same song costs. A repeated load
  that clears the element's source is a reload storm, and the count is the
  evidence.

One gap is asserted as it is and reported: the README's player-key table
(k/j volume, l/h track, q quit) belongs to the `musoak play` CLI's status line.
The web UI binds only `space`; see `test_the_keyboard_...`.
"""

from __future__ import annotations

import base64
import itertools
import json
import os
import re
import subprocess
import time
import uuid

import pytest

from conftest import DIALOG, register_ui, sign_in_ui

pytestmark = [pytest.mark.slow]

#: Every tone this file makes is given a frequency no other tone in this run
#: shares: an upload whose bytes are already stored is refused (409), so the
#: files have to differ in content, not only in name.
_TONES = itertools.count()
_FREQUENCY_BASE = 1200


def tone(media_factory, seconds):
    """A local file of `seconds`, unique in this run, made on the spot."""
    return media_factory.tone("Suite tone", seconds, _FREQUENCY_BASE + next(_TONES))


def cover_png(backend, name):
    """A small picture for the upload dialog's cover-art tile."""
    path = os.path.join(backend.media_dir, name)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "color=c=red:s=96x96:d=1", "-frames:v", "1", path],
        check=True,
    )
    return path


class Account:
    """A person the API knows about, for a test that is not about the form."""

    def __init__(self, backend, prefix="library"):
        self.username = f"{prefix}-{uuid.uuid4().hex[:8]}"
        self.password = "correct horse battery staple"
        self.token = backend.register(self.username, self.password)


def upload_via_api(backend, account, path, title):
    """Put one file in the account's library through the API.

    The upload *view* has its own test; a playback test should not spend its
    first steps on the form. The row this makes is the same row the view makes.
    """
    with open(path, "rb") as handle:
        data = base64.b64encode(handle.read()).decode("ascii")
    status, payload = backend.post(
        "/api/v1/uploads",
        {
            "filename": os.path.basename(path),
            "contentType": "audio/ogg",
            "data": data,
            "title": title,
            "artists": ["The Suite"],
            "album": "",
            "durationMs": 0,
            "associateTrackId": "",
        },
        token=account.token,
    )
    assert status in (200, 201), f"uploading {title!r} through the API failed: {status} {payload}"
    upload = (payload or {}).get("upload") or {}
    assert upload.get("trackId") and upload.get("variantId"), (
        f"{title!r} came back without a track and a variant: {payload}"
    )
    return upload


def library_of(backend, media_factory, wanted):
    """An account with one uploaded tone per `(title, seconds)` in `wanted`."""
    account = Account(backend)
    uploads = []
    for title, seconds in wanted:
        uploads.append(upload_via_api(backend, account, tone(media_factory, seconds), title))
    return account, uploads


# --- the page ---------------------------------------------------------------


def enter(ui, account):
    """Sign in through the form and let the app's own boot settle."""
    sign_in_ui(ui, account)
    ui.wait_quiet()
    return ui


def lit(value):
    """An XPath string literal for `value`."""
    return json.dumps(value)


def row_xpath(title):
    """The row whose own title is `title`, whatever list it is in."""
    return (
        "//div[contains(@class,'row')]"
        f"[.//div[contains(@class,'title')][normalize-space(.)={lit(title)}]]"
    )


def open_manage(ui):
    ui.click_tab("Manage")
    ui.wait_quiet()


def click_row_menu(ui, title, button="More"):
    ui.click_xpath(row_xpath(title) + f"//button[@title={lit(button)}]", f"the menu of the {title!r} row")


def choose_menu(ui, label):
    ui.click_xpath(
        f"//button[contains(@class,'menu-item')][normalize-space(.)={lit(label)}]",
        f"the {label!r} menu item",
    )


def play_from_manage(ui, title):
    """A song row's own Play: the queue becomes this one song, and it plays."""
    open_manage(ui)
    click_row_menu(ui, title)
    choose_menu(ui, "Play")


def queue_from_manage(ui, title):
    """A song row's own Queue: it goes to the end of what is already queued."""
    open_manage(ui)
    click_row_menu(ui, title)
    choose_menu(ui, "Queue")


def blur(ui):
    """Leave a field or a button before a key press, so the keyboard is the page's."""
    ui.js("if (document.activeElement && document.activeElement.blur) document.activeElement.blur();")


# --- the player -------------------------------------------------------------


def wait_sounding(ui, title, seconds, timeout=25):
    """Wait until the element is playing *that* song, and say so if it never does.

    The song is named twice over: the bar's title is what the app says, and the
    element's own length is what it is doing. Two test tones of the same length
    would be indistinguishable, so every track a test uses has its own length.
    """
    def check():
        state = ui.player()
        if not state or state["paused"] or not state["src"]:
            return None
        if state["currentTime"] <= 0.05:
            return None
        if ui.now_playing() != title:
            return None
        if abs(state["duration"] - seconds) > 0.6:
            return None
        return state

    return ui.wait(
        check,
        f"{title!r} never started playing: the bar says {ui.now_playing()!r} "
        f"and the element is {ui.player()!r}",
        timeout,
    )


def assert_clock_moves(ui, label, timeout=10):
    """A paused element with a src is not a song; the clock moving is."""
    before = ui.player()["currentTime"]
    ui.wait_player(
        lambda state: state if state["currentTime"] > before + 0.4 else None,
        f"{label} never advanced its clock (stuck at {before:.2f}s)",
        timeout,
    )


# ============================================================================


def test_a_person_registers_uploads_and_the_song_plays(ui, backend, media_factory):
    """The form, then the upload view, then the song: the whole way in."""
    username = f"library-{uuid.uuid4().hex[:8]}"
    register_ui(ui, username, "correct horse battery staple")
    assert ui.token(), "creating an account through the form produced no token"
    ui.wait_quiet()

    title = f"Uploaded {uuid.uuid4().hex[:6]}"
    seconds = 9
    path = tone(media_factory, seconds)
    filename = os.path.basename(path)
    art = cover_png(backend, f"cover-{title.split()[-1]}.png")

    # The upload view: its own Choose files opens the hidden <input type=file>,
    # and the dialog that follows is the one a person fills in.
    ui.click_tab("Manage")
    ui.wait_quiet()
    ui.click_text("Choose files")
    ui.send_file("input[type=file]", path)
    ui.wait_xpath(f"{DIALOG}//h2[normalize-space(.)={lit('Upload ' + filename)}]", "the upload dialog")
    ui.type(f"{DIALOG}//input[@placeholder='Title']", title)
    # The cover: the dialog's own tile opens a second file picker, and the
    # picture replaces the tile the moment it is chosen.
    ui.click_xpath(f"{DIALOG}//button[@title='Choose cover art']", "the dialog's cover-art tile")
    ui.send_file("input[type=file]", art)
    ui.wait(lambda: ui.has(f"{DIALOG}//img"), "the chosen cover never appeared in the upload dialog")
    ui.click_xpath(
        f"{DIALOG}//div[contains(@class,'actions')]//button[normalize-space(.)='Upload']",
        "the dialog's Upload",
    )

    # The API is the truth about what was uploaded, not the toast.
    def uploaded():
        status, payload = backend.get("/api/v1/uploads", token=ui.token())
        if status != 200 or not payload:
            return None
        found = [entry for entry in payload.get("uploads") or [] if entry.get("title") == title]
        return found[0] if found else None

    record = ui.wait(uploaded, f"the upload {title!r} never appeared in /api/v1/uploads", timeout=30)
    assert record.get("trackId"), f"the upload has no track of its own: {record}"
    variant = record["variantId"]
    status, media = backend.get(f"/api/v1/media/{variant}/status", token=ui.token())
    assert status == 200, f"the uploaded variant has no media status: {status} {media}"
    assert (media or {}).get("state") == "ready", f"the uploaded file is not stored: {media}"
    artwork = record.get("artworkUrl") or ""
    assert artwork, f"the uploaded cover was not kept: {record}"
    art_status, art_body = backend.get(artwork, token=ui.token())
    assert art_status == 200, f"the uploaded cover's URL answers {art_status}: {artwork} {art_body}"

    # And it plays: the row the view drew, its own menu, the element's clock.
    ui.wait_xpath(row_xpath(title), "the upload never appeared in the Manage list")
    row_art = ui.attr(row_xpath(title) + "//img[contains(@class,'art')]", "src")
    assert row_art, "the upload's cover never appeared on its row in the Manage list"
    click_row_menu(ui, title)
    choose_menu(ui, "Play")
    state = wait_sounding(ui, title, seconds)
    assert state["src"], "the uploaded song has no source on the element"
    assert ui.now_playing() == title, (
        f"the element plays {state['duration']:.1f}s of audio but the bar names {ui.now_playing()!r}"
    )
    bar_art = ui.attr(".player-bar img.art", "src")
    assert bar_art, "the player bar shows no cover for a song that has one"
    assert_clock_moves(ui, "the uploaded song")
    ui.assert_no_errors("registering, uploading and playing through the library")


def test_the_song_row_queues_it_and_it_plays_from_the_queue(ui, backend, media_factory):
    """A row's menu queues one song; the Queue page shows it and plays it."""
    tag = uuid.uuid4().hex[:6]
    title_a, title_b = f"Row A {tag}", f"Row B {tag}"
    account, _ = library_of(backend, media_factory, [(title_a, 9), (title_b, 10)])
    enter(ui, account)

    play_from_manage(ui, title_a)
    wait_sounding(ui, title_a, 9)

    queue_from_manage(ui, title_b)
    ui.click_tab("Queue")
    ui.wait_xpath(row_xpath(title_b), "the queued song never appeared in the Queue page")
    ui.click_xpath(row_xpath(title_b), f"the {title_b!r} queue row")

    state = wait_sounding(ui, title_b, 10)
    assert ui.now_playing() == title_b, (
        f"the queue row played {state['duration']:.1f}s of audio while the bar said {ui.now_playing()!r}"
    )
    assert_clock_moves(ui, "the song played from the queue")
    ui.assert_no_errors("queueing a row and playing it from the Queue page")


def test_next_starts_the_warmed_song_and_the_wait_is_measured(ui, backend, media_factory):
    """Next: the queue's own next entry starts, and how long it took is printed."""
    tag = uuid.uuid4().hex[:6]
    titles = [f"Next A {tag}", f"Next B {tag}", f"Next C {tag}"]
    account, uploads = library_of(
        backend, media_factory, [(titles[0], 9), (titles[1], 10), (titles[2], 11)]
    )
    enter(ui, account)

    play_from_manage(ui, titles[0])
    wait_sounding(ui, titles[0], 9)
    queue_from_manage(ui, titles[1])
    queue_from_manage(ui, titles[2])
    # The warm-ahead is a burst of its own: let it settle, so what is measured
    # is the hand-over to a song that is already here.
    ui.wait_quiet(quiet_for=0.4, timeout=10)

    variant_b = uploads[1]["variantId"]
    mark = ui.mark()
    started = time.monotonic()
    ui.click(".player-bar button[title='Next']")
    wait_sounding(ui, titles[1], 10)
    elapsed = time.monotonic() - started

    media = ui.requests_matching(re.escape(f"/api/v1/media/{variant_b}"), mark)
    print(
        f"\n[library] Next made {titles[1]!r} audible after {elapsed:.2f}s "
        f"(the songs ahead are warmed while the current one plays)"
    )
    print(f"[library] {len(media)} request(s) for the next song's file while it started")
    for entry in media:
        print(
            f"[library]   +{entry['start']:.0f}ms took {entry['duration']:.0f}ms, "
            f"{entry['transfer']}B transferred, {entry['status']} {entry['name'].split('?')[0]}"
        )

    assert ui.now_playing() == titles[1], f"the bar names {ui.now_playing()!r}, not the next queue entry"
    assert_clock_moves(ui, "the next song")
    assert elapsed < 5.0, (
        f"pressing Next took {elapsed:.2f}s to make sound, and every song here is a local "
        f"file the app was told to warm ahead; a hand-over this slow is a load that waited"
    )
    ui.assert_no_errors("advancing to the next song")


def test_the_transport_buttons(ui, backend, media_factory):
    """Pause/resume, Next and Previous each do what the bar says."""
    tag = uuid.uuid4().hex[:6]
    titles = [f"Transport A {tag}", f"Transport B {tag}", f"Transport C {tag}"]
    account, _ = library_of(
        backend, media_factory, [(titles[0], 9), (titles[1], 10), (titles[2], 11)]
    )
    enter(ui, account)

    play_from_manage(ui, titles[0])
    wait_sounding(ui, titles[0], 9)
    queue_from_manage(ui, titles[1])
    queue_from_manage(ui, titles[2])

    # Pause: the element stops, and the button offers Play.
    ui.click(".player-bar button.play")
    ui.wait_player(lambda state: state if state["paused"] else None, "the pause button did not stop the song")
    assert ui.attr(".player-bar button.play", "title") == "Play", (
        "the button does not offer Play while the song is paused"
    )
    # Resume: it starts again, and the button offers Pause.
    ui.click(".player-bar button.play")
    ui.wait_player(
        lambda state: state if not state["paused"] and not state["ended"] else None,
        "the play button did not start the song again",
    )
    assert ui.attr(".player-bar button.play", "title") == "Pause", (
        "the button does not offer Pause while the song is playing"
    )

    # Next: the next queue entry is what plays.
    ui.click(".player-bar button[title='Next']")
    state = wait_sounding(ui, titles[1], 10)
    assert ui.now_playing() == titles[1], f"Next played {state['duration']:.1f}s of the wrong song"

    # Previous: back to the song before it.
    ui.click(".player-bar button[title='Previous']")
    state = wait_sounding(ui, titles[0], 9)
    assert ui.now_playing() == titles[0], f"Previous played {state['duration']:.1f}s of the wrong song"
    assert_clock_moves(ui, "the song Previous came back to")
    ui.assert_no_errors("driving the transport")


def test_the_position_bar_and_the_mute_button(ui, backend, media_factory):
    """The seek range moves the song, and mute silences the element."""
    tag = uuid.uuid4().hex[:6]
    title = f"Seek {tag}"
    account, _ = library_of(backend, media_factory, [(title, 12)])
    enter(ui, account)

    play_from_manage(ui, title)
    state = wait_sounding(ui, title, 12)
    duration = state["duration"]
    assert duration > 6, f"the element reports a {duration:.1f}s file, too short to seek in"

    # A hand on the bar: the element's own pointer events, then a value. The bar
    # only accepts a value from a hand (`_seekingByHand`), which is the rule
    # that stops a repaint from seeking the room - so a test has to be a hand.
    ui.js(
        "const s = document.querySelector('.player-bar input[title=\"Seek\"]');"
        "if (!s) return null;"
        "s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));"
        "s.value = '500';"
        "s.dispatchEvent(new Event('input', { bubbles: true }));"
        "s.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));"
        "return s.value;"
    )
    half = duration / 2
    ui.wait_player(
        lambda s: s if abs(s["currentTime"] - half) < 1.5 else None,
        f"the seek bar did not move the song to the middle (wanted about {half:.1f}s)",
    )

    # Mute: the element is silent, and the button offers to undo it.
    ui.click(".player-bar button[title='Mute']")
    ui.wait_player(lambda state: state if state["muted"] else None, "the mute button did not mute the element")
    assert ui.attr(".player-bar button[title='Unmute']", "title") == "Unmute", (
        "the button does not offer Unmute while the element is muted"
    )
    ui.click(".player-bar button[title='Unmute']")
    ui.wait_player(lambda state: state if not state["muted"] else None, "unmuting did not restore the sound")
    assert ui.attr(".player-bar button[title='Mute']", "title") == "Mute", (
        "the button does not offer Mute once the element is unmuted"
    )
    ui.assert_no_errors("seeking and muting")


def test_the_keyboard(ui, backend, media_factory):
    """Space pauses and resumes; the README's player keys are the CLI's.

    `space` is the one binding the web UI has (`app.js`'s keydown listener emits
    "toggle-play"), and it is asserted here. The README's key table (`k`/`j`
    volume, `l`/`h` next/previous, `q` quit) documents the `musoak play` CLI's
    status line, not this page: pressing those keys here does nothing, which
    this test records rather than pretends. What each key did is printed, and
    the mismatch is reported rather than hidden behind a relaxed assertion.
    """
    tag = uuid.uuid4().hex[:6]
    title = f"Keys {tag}"
    account, _ = library_of(backend, media_factory, [(title, 9)])
    enter(ui, account)

    play_from_manage(ui, title)
    wait_sounding(ui, title, 9)

    blur(ui)
    ui.key(" ")
    ui.wait_player(lambda state: state if state["paused"] else None, "space did not pause the song")
    blur(ui)
    ui.key(" ")
    ui.wait_player(
        lambda state: state if not state["paused"] and not state["ended"] else None,
        "space did not resume the song",
    )

    observed = []
    for key in ("l", "h", "k", "j", "q"):
        blur(ui)
        before = ui.player()
        before_title = ui.now_playing()
        ui.key(key)
        after = ui.player()
        observed.append(
            f"{key}: now_playing {before_title!r}->{ui.now_playing()!r}, "
            f"paused {before['paused']}->{after['paused']}, muted {before['muted']}->{after['muted']}"
        )
        # None of them is bound, so none of them may take the page anywhere or
        # leave it erroring; the song that was playing keeps playing.
        assert ui.now_playing() == before_title, (
            f"pressing {key!r} changed what is playing (the web UI has no binding for it, "
            f"so this is unexpected): {ui.now_playing()!r}"
        )
        assert not after["paused"], f"pressing {key!r} paused the song"
    print("\n[library] the README's player keys on the web UI (unbound here):")
    for line in observed:
        print(f"[library]   {line}")

    assert_clock_moves(ui, "the song after the keyboard")
    ui.assert_no_errors("the keyboard")


def test_the_same_song_plays_twice_without_a_reload_storm(ui, backend, media_factory):
    """A, then B, then A again: A starts from the top, and asks the server once.

    A repeated load used to stop the element and clear its source, so the file
    was thrown away as fast as it arrived. The count of media requests while the
    song is asked for a second time is the evidence that it is not happening.
    """
    tag = uuid.uuid4().hex[:6]
    title_a, title_b = f"Again A {tag}", f"Again B {tag}"
    account, uploads = library_of(backend, media_factory, [(title_a, 9), (title_b, 10)])
    enter(ui, account)

    play_from_manage(ui, title_a)
    wait_sounding(ui, title_a, 9)
    queue_from_manage(ui, title_b)

    ui.click(".player-bar button[title='Next']")
    wait_sounding(ui, title_b, 10)

    variant_a = uploads[0]["variantId"]
    mark = ui.mark()
    ui.click(".player-bar button[title='Previous']")
    state = wait_sounding(ui, title_a, 9)
    assert state["currentTime"] < 2.0, (
        f"the song came back at {state['currentTime']:.1f}s instead of the start"
    )

    requests = ui.requests_matching(re.escape(f"/api/v1/media/{variant_a}"), mark)
    fetches = [
        entry for entry in requests
        if "?" in entry["name"] and "/download" not in entry["name"] and "/status" not in entry["name"]
    ]
    print(
        f"\n[library] returning to {title_a!r}: {len(requests)} request(s) to its media "
        f"({len(fetches)} file fetch(es))"
    )
    for entry in requests:
        print(f"[library]   {entry['status']} {entry['name'].split('?')[0]}")
    assert len(fetches) <= 2, (
        f"the same song was fetched {len(fetches)} times on its second play; a repeated load "
        f"that clears the element's source is exactly this storm"
    )
    assert len(requests) < 25, (
        f"a request storm while replaying the same song: "
        f"{[entry['name'].split('?')[0] for entry in requests]}"
    )
    assert_clock_moves(ui, "the song on its second play")
    ui.assert_no_errors("playing the same song again")