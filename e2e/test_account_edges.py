"""The edges around an account: a guest, two tabs, and a file from disk.

Each of these is a state the app has to survive rather than a feature it
advertises: somebody listening without an account, one account open twice, and
a song that arrived from a file rather than a platform. They are the states
where bookkeeping (who is signed in, which page owns the queue) goes wrong.
"""

from __future__ import annotations

import base64
import os
import subprocess
import uuid

import pytest

import harness
from conftest import sign_in_ui
from journeys import PASSWORD, Person, person, press, queue_titles, titles
from test_library import Account, wait_sounding

pytestmark = [pytest.mark.slow, pytest.mark.browsers]


def _tagged_tone(backend, title, artist, album, seconds, frequency):
    path = os.path.join(backend.media_dir, f"{uuid.uuid4().hex[:8]}-{frequency}.ogg")
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


def _upload(backend, token, path, title, artists, album):
    with open(path, "rb") as handle:
        data = base64.b64encode(handle.read()).decode()
    status, payload = backend.post(
        "/api/v1/uploads",
        {
            "filename": os.path.basename(path),
            "title": title,
            "artists": artists,
            "album": album,
            "data": data,
        },
        token=token,
    )
    assert status in (200, 201), f"upload {title!r} -> {status} {payload}"
    return payload.get("upload") or {}


def test_a_guest_can_play_a_song_from_a_search(ui, backend):
    """Listening without an account: search, click a result, hear it.

    A guest has no queue to save and no account to save it to, so this is the
    one path where the player has to work with nothing behind it. It must not
    ask anybody to sign in to play a song the library already holds.
    """
    delta = uuid.uuid4().hex[:6]
    owner = Account(backend, prefix="host-lib")
    title = f"Guest Song {delta}"
    uploaded = _upload(
        backend,
        owner.token,
        _tagged_tone(backend, title, f"Guest Artist {delta}", f"Guest Album {delta}", 8, 410),
        title,
        [f"Guest Artist {delta}"],
        f"Guest Album {delta}",
    )
    assert uploaded.get("trackId")

    ui.goto("/")   # a guest: no sign-in, no token
    ui.click_tab("Search")
    ui.type("input[placeholder='Search tracks']", title)
    ui.wait(lambda: title in (ui.texts(".row .title") or []), f"a guest's search never found {title!r}", timeout=20)
    ui.click_xpath(f"//div[contains(@class,'row')][.//div[@class='title'][normalize-space(.)={title!r}]]", f"the row for {title!r}")

    wait_sounding(ui, title, 8)
    ui.assert_no_errors("a guest playing a song")


def test_a_guest_can_queue_songs_without_an_account(ui, backend):
    """A guest queues one search result behind another and plays the queue.

    An account is what keeps a queue, not what makes one work: the page's own
    queue is local, and a signed-out listener can add a song behind the one
    already playing without a login wall.
    """
    delta = uuid.uuid4().hex[:6]
    owner = Account(backend, prefix="guest-queue")
    titles = [f"Queued Guest {index} {delta}" for index in range(2)]
    for index, title in enumerate(titles):
        _upload(
            backend,
            owner.token,
            _tagged_tone(backend, title, f"Queue Artist {delta}", f"Queue Album {delta}", 8 + index, 420 + 20 * index),
            title,
            [f"Queue Artist {delta}"],
            f"Queue Album {delta}",
        )

    ui.goto("/")
    for title in titles:
        ui.click_tab("Search")
        ui.type("input[placeholder='Search tracks']", title)
        ui.wait(lambda: title in (ui.texts(".row .title") or []), f"a guest's search never found {title!r}", timeout=20)
        ui.click_xpath(
            f"//div[contains(@class,'row')][.//div[@class='title'][normalize-space(.)={title!r}]]"
            "//button[@title='Queue']",
            f"the Queue button on {title!r}",
        )

    first = titles[0]
    wait_sounding(ui, first, 8)
    ui.click_tab("Queue")
    ui.wait(
        lambda: titles[1] in (queue_titles(ui) or []) or None,
        f"the guest's second song never reached the queue: {queue_titles(ui)}",
        timeout=20,
    )
    assert ui.now_playing() == first, f"the guest's queue plays {ui.now_playing()!r}, want {first!r}"
    ui.assert_no_errors("a guest queueing songs")


def test_two_tabs_of_one_account_both_play_and_save_one_document(host, guest, backend, media_factory):
    """One account open twice: both pages play, and the saved queue stays sane.

    Two pages of one person write the same playback document, so the interesting
    assertions are that neither crashes and that what the server holds is still
    *a* queue of that person's - not two half-documents interleaved.
    """
    someone = person(backend, media_factory, "tabs", lengths=(8, 9))
    sign_in_ui(host, someone)
    sign_in_ui(guest, someone)

    for page in (host, guest):
        from journeys import open_favourites
        open_favourites(page, len(someone.titles))
        press(page, "Play")
        page.wait(lambda: (page.player() or {}).get("src") or None, "the queue never loaded", timeout=20)

    host_title = host.now_playing()
    guest_title = guest.now_playing()
    assert host_title in someone.titles and guest_title in someone.titles

    # Both keep playing: one page taking the queue does not stop the other.
    for page in (host, guest):
        before = (page.player() or {}).get("currentTime") or 0
        page.wait_player(
            lambda s, before=before: s if s and (s.get("currentTime") or 0) > before + 0.4 else None,
            f"{page.name} stopped when the other page played",
            timeout=15,
        )

    status, payload = backend.get("/api/v1/me/playback", token=someone.token)
    assert status == 200, f"the saved playback answered {status}"
    saved = (payload or {}).get("state") or payload or {}
    queue_titles = [entry.get("title") for entry in (saved.get("queue") or [])]
    assert queue_titles, f"the saved playback holds no queue: {saved}"
    assert set(queue_titles) <= set(someone.titles), f"the saved queue holds somebody else's songs: {queue_titles}"

    for page in (host, guest):
        page.assert_no_errors(f"{page.name} with the account open twice")


def test_a_tagged_file_imported_from_disk_reaches_its_artist(ui, backend, media_factory):
    """Import a file with tags: the song is playable and its artist page knows it.

    The import path is the library's own: tags become the artist and album, the
    track links to them, and the artist's page lists the album - which is what
    makes an imported collection browsable at all.
    """
    delta = uuid.uuid4().hex[:6]
    artist = f"Imported Artist {delta}"
    album = f"Imported Album {delta}"
    title = f"Imported Song {delta}"
    account = Account(backend, prefix="import")
    path = _tagged_tone(backend, title, artist, album, 8, 330 + int(delta[:2], 16))
    status, payload = backend.post("/api/v1/library/import", {"path": path}, token=account.token)
    assert status == 200, f"import -> {status} {payload}"
    imported = (payload or {}).get("imported") or []
    assert imported, f"the import reported nothing: {payload}"
    track = (imported[0].get("track") or {})
    assert track.get("title") == title, f"the file's tag did not become the title: {track}"
    assert artist in (track.get("artists") or []), f"the file's artist tag was not kept: {track}"
    track_id = track.get("id")

    status, detail = backend.get(f"/api/v1/tracks/{track_id}", token=account.token)
    assert status == 200, f"the track answered {status}: {detail}"
    artist_ids = detail.get("artistIds") or []
    assert artist_ids, f"an imported track names no artist id: {detail}"

    sign_in_ui(ui, account)
    ui.goto(f"/?artist={artist_ids[0]}")
    ui.wait_text(".collection-header-title", artist, "the artist's page never opened", timeout=25)
    ui.click_xpath(
        f"//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)={album!r}]]",
        f"the album row for {album!r}",
    )
    ui.wait_text(".collection-header-title", album, "the album's page never opened", timeout=25)
    ui.click_xpath("//button[@title='Play these tracks']", "the album's Play")
    wait_sounding(ui, title, 8)
    ui.assert_no_errors("importing a tagged file and playing it")