"""The things a person actually does, end to end, in one browser (or three).

Every other file here tests a seam: the download pipeline, the room's clock,
the artwork, a reload. This one tests the *flows* - a playlist shuffled and
heard through, three people filling a room, a search that ends in a song
playing to its last second - because those are the paths a bug arrives by, and
a seam can be green while the flow it belongs to is broken.

Providers are off in this suite, so "a search" means the library: an upload is
found by its title, its artist or its album, and an artist's page is built from
the albums their tracks were imported with. What a provider would add (an
artist's catalogue, a platform release) has its own coverage and needs a
network; these tests are about the shape of the journey.

A track that plays here is a file on disk, and every tone has its own length -
two tones of one length are indistinguishable in the element's own reading, so
the length is what says *which* song is sounding (see `test_library`).
"""

from __future__ import annotations

import base64
import os
import subprocess
import time
import uuid

import pytest

import harness
import rooms_helpers
from conftest import DIALOG, sign_in_ui
from rooms_helpers import (
    create_room,
    in_room_mode,
    join_room,
    make_member,
    queue_favourites,
    wait_for,
    wait_members,
    wait_playing,
    wait_queue_size,
)
from test_library import Account, wait_sounding

pytestmark = [pytest.mark.slow]

PASSWORD = "correct horse battery staple"

#: Distinct lengths, so the element's own duration names the song it is playing
#: and a queue that skips one cannot hide behind a label.
PLAYLIST_LENGTHS = [3, 4, 5, 6, 7, 8]


# --- helpers ----------------------------------------------------------------


def _import_playlist(backend, media_factory, account, lengths=PLAYLIST_LENGTHS, name="Shuffle test"):
    """A playlist of tones whose lengths differ, made through the API."""
    tracks = []
    for index, seconds in enumerate(lengths):
        made = media_factory.import_track(
            account.token,
            title=f"{name} {index + 1} {account.username[-4:]}",
            seconds=seconds,
            frequency=300 + 50 * index,
        )
        tracks.append(made)
    status, playlist = backend.post("/api/v1/me/playlists", {"name": name}, token=account.token)
    assert status in (200, 201) and (playlist or {}).get("id"), f"playlist create: {status} {playlist}"
    status, payload = backend.post(
        f"/api/v1/me/playlists/{playlist['id']}/items",
        {"trackIds": [track["trackId"] for track in tracks]},
        token=account.token,
    )
    assert status == 200, f"playlist add: {status} {payload}"
    return playlist, tracks


def _open_playlist(ui, name):
    """The playlist's own page, from the Playlists list."""
    ui.click_tab("Playlists")
    ui.wait_xpath(
        "//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)="
        f"{name!r}]]",
        f"the row for {name!r}",
    )
    ui.click_xpath(
        "//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)="
        f"{name!r}]]",
        f"the row for {name!r}",
    )


def _wait_row_title(ui, title, message, timeout=20.0):
    """Wait until a row on the page is named exactly this (a search result)."""
    ui.wait(lambda: title in (ui.texts(".row .title") or []), message, timeout)
    return ui


def _history_track_ids(backend, token, limit=40):
    status, payload = backend.get(f"/api/v1/me/history?limit={limit}", token=token)
    assert status == 200, f"history answered {status}: {payload!r}"
    plays = payload.get("plays") if isinstance(payload, dict) else payload
    # A play carries the whole track, not just its id: the history view draws
    # the song, so the id is inside it.
    return [((play.get("track") or {}).get("id")) for play in (plays or [])]


def _hear_each_song(ui, message, deadline=150.0):
    """Watch the element until the queue is over, and say what sounded, when.

    A song counts as heard only while it is *sounding*: the bar names it and the
    element is running it past its first moment. A title that appears with the
    clock at zero and is gone again is a song the player skipped through, which
    is exactly what "without missing any songs" must not allow.
    """
    heard = []
    quiet_from = None
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        state = ui.player()
        title = ui.now_playing()
        sounding = bool(
            state
            and state.get("src")
            and not state.get("paused")
            and not state.get("ended")
            and (state.get("currentTime") or 0) > 0.05
            and (state.get("duration") or 0) > 0
        )
        if sounding:
            quiet_from = None
            if not heard or heard[-1]["title"] != title:
                heard.append({"title": title, "duration": state["duration"]})
        else:
            # The queue is over when nothing has sounded for a while and the
            # bar has stopped moving: the last song ends and stays ended.
            quiet_from = quiet_from or time.monotonic()
            if heard and time.monotonic() - quiet_from > 4.0:
                break
        time.sleep(0.1)
    assert heard, f"{message}: nothing ever sounded"
    return heard


# --- 1. a playlist, shuffled, heard through ---------------------------------


def test_a_shuffled_playlist_plays_every_song_exactly_once(ui, backend, media_factory):
    """Press Shuffle on a playlist and hear all of it, in some order.

    What is asserted is the flow: every song of the list sounds, each exactly
    once, each at its own length - and each one is recorded as a listen. A queue
    that skipped a song after a failed download, or replayed one, fails here;
    so does a shuffle that drops an item while reordering.
    """
    account = Account(backend, prefix="shuffle")
    name = f"Shuffle {account.username[-4:]}"
    _, tracks = _import_playlist(backend, media_factory, account, name=name)
    lengths = {track["track"]["title"]: seconds for track, seconds in zip(tracks, PLAYLIST_LENGTHS)}

    sign_in_ui(ui, account)
    _open_playlist(ui, name)
    ui.click_text("Shuffle")

    heard = _hear_each_song(ui, "the shuffled playlist never finished")

    titles = [entry["title"] for entry in heard]
    assert len(titles) == len(set(titles)), f"a song was heard more than once: {titles}"
    assert set(titles) == set(lengths), (
        "the shuffle did not play the whole playlist: "
        f"heard {sorted(titles)}, missing {sorted(set(lengths) - set(titles))}"
    )
    for entry in heard:
        want = lengths[entry["title"]]
        assert abs(entry["duration"] - want) <= 0.6, (
            f"{entry['title']!r} sounded for {entry['duration']:.1f}s, and that song is {want}s"
        )

    # A song that sounded is also a song the account heard: the listen is
    # recorded when the track changes, and this is what a person's history is.
    # The server keeps listens of at least five seconds and nothing shorter - a
    # tone skipped straight through is not a listen - so the short ones in this
    # playlist are checked to be absent as well as the long ones present.
    played = set(_history_track_ids(backend, account.token))
    heard_long = [track for track, seconds in zip(tracks, PLAYLIST_LENGTHS) if seconds >= 5]
    missing = [track["trackId"] for track in heard_long if track["trackId"] not in played]
    assert not missing, f"{len(missing)} of the playlist's songs were never recorded as heard"
    short = [track for track, seconds in zip(tracks, PLAYLIST_LENGTHS) if seconds < 5]
    skipped = [track["trackId"] for track in short if track["trackId"] in played]
    assert not skipped, f"a song under five seconds was recorded as a listen: {skipped}"

    ui.assert_no_errors("shuffling a playlist and hearing it through")


# --- 2. three people, one room ----------------------------------------------


@pytest.mark.browsers
def test_three_people_each_queue_a_song_and_the_room_plays_them(
    host, guest, frontend, run_dir, headless, backend, media_factory
):
    """Three accounts in one room, each queueing a song of their own.

    The room's order must hold all three, queued by three different people, and
    the room must play each of them to every member - the flow a household is
    actually in when it uses this. The third person has their own browser,
    opened here rather than by a fixture: the suite's two are for the common
    two-person cases and a third is only needed by tests like this one.
    """
    prefix = uuid.uuid4().hex[:6]
    members = [
        make_member(backend, media_factory, prefix=f"host{prefix}", tracks=1, seconds=8),
        make_member(backend, media_factory, prefix=f"guest{prefix}", tracks=1, seconds=8),
        make_member(backend, media_factory, prefix=f"third{prefix}", tracks=1, seconds=8),
    ]
    sign_in_ui(host, members[0])
    sign_in_ui(guest, members[1])
    third = harness.open_ui(
        frontend.url, os.path.join(run_dir, "artifacts"), name=f"third-{prefix}", headless=headless
    )
    try:
        sign_in_ui(third, members[2])

        room_name = f"three {prefix}"
        room_id = create_room(host, room_name)
        join_room(guest, room_name)
        join_room(third, room_name)
        names = [member.username for member in members]
        for ui in (host, guest, third):
            wait_members(ui, backend, room_id, members[0].token, names, f"{ui.name} never saw all three arrive")
            in_room_mode(ui, room_id)

        # Each person queues their own song, the way a person does: the list's
        # own Queue button. The room starts playing as soon as the first lands.
        queue_favourites(host, room_name)
        wait_queue_size(host, backend, room_id, members[0].token, 1, "the host's song never reached the room")
        wait_playing(host, backend, room_id, members[0].token, "the room never started on the host's song")
        queue_favourites(guest, room_name)
        wait_queue_size(guest, backend, room_id, members[0].token, 2, "the guest's song never reached the room")
        queue_favourites(third, room_name)
        room = wait_queue_size(third, backend, room_id, members[0].token, 3, "the third song never reached the room")

        # Three songs, three different people who put them there.
        items = [rooms_helpers.current_item(room)] + list(room.get("masterQueue") or [])
        assert len(items) == 3, f"the room holds {len(items)} items, want 3: {items}"
        queued_by = {item.get("addedBy") for item in items if item.get("addedBy")}
        member_ids = {rooms_helpers.member_id(room, name) for name in names}
        assert queued_by == member_ids, f"the queue was put there by {queued_by}, want {member_ids}"
        want_tracks = {track["trackId"] for member in members for track in member.tracks}
        got_tracks = {item.get("trackId") for item in items}
        assert got_tracks == want_tracks, f"the room holds {got_tracks}, want {want_tracks}"

        # Each song is played to everybody: every member's element runs each of
        # the three titles, and no member hears a fourth.
        wanted = [member.tracks[0]["track"]["title"] for member in members]
        heard_by = {ui.name: [] for ui in (host, guest, third)}

        def check():
            for ui in (host, guest, third):
                state = ui.player()
                title = ui.now_playing()
                sounding = bool(
                    state
                    and not state.get("paused")
                    and not state.get("ended")
                    and (state.get("currentTime") or 0) > 0.05
                )
                if sounding and title in wanted and title not in heard_by[ui.name]:
                    heard_by[ui.name].append(title)
            return all(len(heard) == 3 for heard in heard_by.values()) or None

        host.wait(check, f"not every member heard every song: {heard_by}", timeout=90)
        for name, heard in heard_by.items():
            assert sorted(heard) == sorted(wanted), f"{name} heard {sorted(heard)}, want {sorted(wanted)}"

        for page in (host, guest, third):
            page.assert_no_errors(f"{page.name} in a three-person room")
    finally:
        third.driver.quit()


# --- 3. search, artist, album, a song played to its end ---------------------


def _tagged_tone(backend, title, artist, album, seconds, frequency):
    """A tone carrying tags, so importing it makes an artist and an album.

    The suite's other tones are untagged, which leaves their artist blank; the
    browse flow needs a song that names somebody to be found *by*.
    """
    path = os.path.join(backend.media_dir, f"{title.replace(' ', '-')}-tagged.ogg")
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"sine=frequency={frequency}:duration={seconds}",
            "-c:a", "libopus",
            "-metadata", f"title={title}",
            "-metadata", f"artist={artist}",
            "-metadata", f"album={album}",
            path,
        ],
        check=True,
    )
    return path


def _upload(backend, token, path, title, artist, album):
    """Put a file in the account's library the way the upload view does.

    The library's search is over *uploads* - what the household put there
    itself - so a file imported from disk is not findable and an upload is.
    """
    with open(path, "rb") as handle:
        data = base64.b64encode(handle.read()).decode()
    status, payload = backend.post(
        "/api/v1/uploads",
        {"filename": os.path.basename(path), "title": title, "artists": [artist], "album": album, "data": data},
        token=token,
    )
    assert status in (200, 201), f"upload {title!r} -> {status} {payload}"
    return payload.get("upload") or {}


def test_search_a_song_and_an_artist_then_play_an_album_through(ui, backend):
    """Find a song, walk to its artist and album, and play the album out.

    The journey: search the song's title (found), search the artist's name
    (found - the library's search matches an artist, not only a title), open
    the artist from the song's own artist line, open the album from their page,
    and press Play. The song has to finish: the element reaches its end, not
    merely start.
    """
    delta = uuid.uuid4().hex[:6]
    artist = f"Scenery Artist {delta}"
    album = f"Scenery Album {delta}"
    title = f"Scenery Song {delta}"
    account = Account(backend, prefix="browse")
    seconds = 8
    uploaded = _upload(
        backend,
        account.token,
        _tagged_tone(backend, title, artist, album, seconds, frequency=350 + int(delta[:2], 16)),
        title,
        artist,
        album,
    )
    assert uploaded.get("trackId"), f"the upload answered without a track: {uploaded}"

    sign_in_ui(ui, account)

    # A song by its title.
    ui.click_tab("Search")
    ui.type("input[placeholder='Search tracks']", title)
    _wait_row_title(ui, title, f"searching {title!r} found nothing")

    # An artist by their name: the library's search is over titles, artists and
    # albums alike, so the same song comes back.
    ui.click_tab("Search")
    ui.type("input[placeholder='Search tracks']", artist)
    _wait_row_title(ui, title, f"searching {artist!r} found no song by them")

    # The song's artist line is the way to the artist, as it is on every row.
    ui.click_xpath(f"//button[@title={'Go to ' + artist!r}]", f"{artist!r}'s link in the result")
    ui.wait_text(".collection-header-title", artist, "the artist's page never opened", timeout=20)

    # Their album, from the page the artist lives on.
    ui.wait_xpath(
        f"//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)={album!r}]]",
        f"the album row for {album!r}",
    )
    ui.click_xpath(
        f"//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)={album!r}]]",
        f"the album row for {album!r}",
    )
    ui.wait_text(".collection-header-title", album, "the album's page never opened", timeout=20)

    # Every button the album offers, Play among them.
    ui.click_xpath("//button[@title='Play these tracks']", "the album's Play")

    wait_sounding(ui, title, seconds)
    state = ui.wait_player(
        lambda s: s if s and s.get("ended") else None,
        "the album's song never finished",
        timeout=40,
    )
    assert (state["currentTime"] or 0) >= seconds - 0.6, (
        f"the song ended at {state['currentTime']:.2f}s of {seconds}s"
    )

    played = set(_history_track_ids(backend, account.token))
    assert any(track_id for track_id in played), "playing the album recorded no listen"

    ui.assert_no_errors("searching, browsing to the album and playing it out")