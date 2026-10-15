"""How the page's pictures behave: the shell's own, and the songs' covers.

"Images load slow" was two things. The brand and the favicon were the 1080px
`icon.png` - a third of a megabyte - drawn at 26px, and a cover request held the
`<img>` for up to twenty seconds waiting for a provider download, which over
HTTP/1.1 blocked every other image on the page behind it.

So this file measures three things a person actually feels. The shell must draw
pictures the size of what it draws them at. A song that has a cover must show
it. And no picture on the page - a cover included - may hold the page up while
it arrives.

One thing the suite cannot do with providers off: make a cover wait on a
provider CDN. `artwork.Fetch` only consults a CDN for a track whose recorded
artwork is a provider URL, and the only two ways that is recorded are a provider
search (providers are off) and the matcher adopting a provider hit (none, off).
The budget below is still that 2.5s ceiling, but what is measured against it is
a cover served from disk.
"""

from __future__ import annotations

import base64
import itertools
import json
import os
import subprocess
import time

import pytest

from conftest import register_ui
from test_library import click_row_menu, choose_menu, open_manage

pytestmark = [pytest.mark.slow, pytest.mark.browsers]

#: The password every test account is registered with.
PASSWORD = "correct horse battery staple"

#: The shell's own image bytes on a first load: the 64px brand (5.3 KB), a
#: possible second copy behind the tab icon, and the phone's home-screen icon
#: (25 KB) if the browser asks for it. A 1080px icon.png is 349 KB on its own,
#: so it cannot hide under this.
SHELL_IMAGE_BUDGET = 40 * 1024
#: No *single* image a first load draws may be bigger than this; the 25 KB
#: apple-touch-icon fits, the 349 KB icon.png does not.
SHELL_SINGLE_IMAGE_BUDGET = 30 * 1024

#: Resource Timing `duration` is milliseconds. A cover used to be held for up to
#: 20 s (`artwork.fetchTimeout`) while a provider download ran; the fix answers
#: after `artwork.waitForImage` (2 s). 2.5 s is one answer that waited the whole
#: grace plus room for the wire.
IMAGE_REQUEST_BUDGET_MS = 2500

#: A queue of local songs must draw every cover well inside this.
ROW_IMAGES_BUDGET_S = 5.0
#: Many rows at once: rows render, then their pictures. This is the whole
#: budget for the page to be done with the lot.
ALL_IMAGES_BUDGET_S = 5.0
#: A tab click through the middle of that must land promptly.
TAB_CLICK_BUDGET_MS = 2000

#: The rows of whatever collection view is open, and their picture tiles.
ROW_SELECTOR = ".content .page .list .row"
ROW_IMAGE_SELECTOR = f"{ROW_SELECTOR} img"

ROW_COUNT_JS = f"return document.querySelectorAll({json.dumps(ROW_IMAGE_SELECTOR)}).length;"
ROW_IMAGES_DONE_JS = (
    f"const imgs = [...document.querySelectorAll({json.dumps(ROW_IMAGE_SELECTOR)})];"
    "return imgs.length > 0 && imgs.every((img) => img.complete);"
)
ROW_IMAGE_STATE_JS = (
    f"return [...document.querySelectorAll({json.dumps(ROW_IMAGE_SELECTOR)})].map((img) => ({{"
    "  src: img.currentSrc || img.src, complete: img.complete,"
    "  width: img.naturalWidth, height: img.naturalHeight"
    "}));"
)

#: Carriers are the (valid, tiny) audio the local upload cover path rides on.
#: Distinct bytes each, or the second would be refused as a duplicate file.
_CARRIERS = itertools.count()


# --- the local cover path ---------------------------------------------------


def _register(ui):
    """A fresh account, made through the real form, and its token."""
    username = f"images-{os.urandom(3).hex()}"
    register_ui(ui, username, PASSWORD)
    token = ui.token()
    assert token, f"registering {username} never produced a token"
    return token


def _fetch_track(backend, token, track_id):
    """The track the API would hand a page, so `artworkUrl` is the server's."""
    status, payload = backend.get(f"/api/v1/tracks/{track_id}", token=token)
    assert status == 200, f"track {track_id} -> {status} {payload}"
    return payload


def _cover_png(backend, colour="orange"):
    """A small real PNG, made with the same ffmpeg the suite already needs."""
    path = os.path.join(backend.media_dir, f"cover-{colour}.png")
    if not os.path.exists(path):
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", f"color=c={colour}:s=64x64:d=1", "-frames:v", "1", path],
            check=True,
        )
    with open(path, "rb") as handle:
        return handle.read()


def _cover_a_track(backend, media_factory, token, track_id, cover):
    """Give a track a cover through the local upload path.

    With providers off this is the only way a song gets one - see the module
    docstring. The cover is stored where the artwork cache keeps any other, so
    serving it needs no network: the request that a row's `<img>` makes is
    answered from disk.
    """
    number = next(_CARRIERS)
    carrier = media_factory.tone(f"cover-carrier-{number}", seconds=1 + (number % 4), frequency=150 + 3 * number + 2)
    with open(carrier, "rb") as handle:
        audio = base64.b64encode(handle.read()).decode()
    status, payload = backend.post(
        "/api/v1/uploads",
        {
            "filename": os.path.basename(carrier),
            "title": f"cover carrier {number}",
            "data": audio,
            "artworkData": base64.b64encode(cover).decode(),
            "artworkContentType": "image/png",
            "associateTrackId": track_id,
        },
        token=token,
    )
    assert status == 201, f"attaching a cover to {track_id} -> {status} {payload}"


# --- the page ---------------------------------------------------------------


def _queue_and_open(ui, tracks, backend, token):
    """Put the songs through a real playlist control, then show Queue.

    A page-side import of player.js boots a second app under the service worker;
    that was useful for an early probe but is not a user path and makes the test
    measure the wrong player. The playlist page's own Play button is the same
    queue mutation a person uses.
    """
    playlist_name = f"Image queue {os.urandom(3).hex()}"
    status, playlist = backend.post("/api/v1/me/playlists", {"name": playlist_name}, token=token)
    assert status in (200, 201) and playlist.get("id"), f"playlist create: {status} {playlist}"
    status, _ = backend.post(
        f"/api/v1/me/playlists/{playlist['id']}/items",
        {"trackIds": [track["id"] for track in tracks]},
        token=token,
    )
    assert status == 200, f"playlist add: {status}"
    ui.wait_quiet()
    ui.click_tab("Playlists")
    ui.click_xpath(
        f"//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)={json.dumps(playlist_name)}]]",
        "the image playlist row",
    )
    ui.click("button[title='Play these tracks']")
    ui.click_tab("Queue")
    return playlist

def _wait_for_row_images(ui, expected, timeout):
    """Wait until `expected` row pictures exist and every one has finished."""
    ui.wait(
        lambda: ui.js(ROW_COUNT_JS) == expected,
        f"the queue drew {ui.js(ROW_COUNT_JS)} artwork tile(s), not {expected}",
    )
    ui.wait(lambda: ui.js(ROW_IMAGES_DONE_JS), "the queue's artwork images never finished loading", timeout=timeout)
    return ui.js(ROW_IMAGE_STATE_JS)


def _assert_images_loaded(imgs):
    failed = [img for img in imgs if img["complete"] and img["width"] == 0]
    assert not failed, f"{len(failed)} song image(s) failed to load: {[img['src'] for img in failed]}"
    pending = [img for img in imgs if not img["complete"]]
    assert not pending, f"{len(pending)} song image(s) never finished: {[img['src'] for img in pending]}"
    assert imgs, "there were no song images to read at all"


def _print_image_requests(label, entries, limit=8):
    total = sum(entry["transfer"] or 0 for entry in entries)
    print(f"\n{label}: {len(entries)} image request(s), {total} bytes ({total / 1024:.1f} KB) over the wire")
    for entry in sorted(entries, key=lambda item: item["duration"], reverse=True)[:limit]:
        print(f"    {entry['duration']:8.1f} ms  {entry['transfer'] or 0:>8} B  {entry['name']}")


def _image_requests(ui, since=0):
    return [entry for entry in ui.resources(since) if entry.get("type") == "img"]


# --- 1. the shell draws small pictures --------------------------------------


def test_the_shell_draws_images_the_size_it_shows(ui):
    """A first load must not fetch a picture bigger than the page draws it."""
    ui.goto("/")
    ui.wait_quiet()
    ui.wait(
        lambda: ui.js("const img = document.querySelector('.sidebar-top .brand img'); return !!img && img.complete;"),
        "the shell's brand image never finished loading",
    )

    src = ui.attr(".sidebar-top .brand img", "src")
    assert src == "icon-64.png", f"the shell's brand image is {src!r}, not the 64px file it draws at 26px"
    brand = ui.js(
        "const img = document.querySelector('.sidebar-top .brand img');"
        "return img ? { width: img.naturalWidth, src: img.currentSrc || img.src } : null;"
    )
    assert brand and brand["width"] > 0, f"the brand image did not decode: {brand}"

    entries = ui.resources()
    images = _image_requests(ui)
    _print_image_requests("the shell's own images on a first load", images)
    assert images, "no <img>-initiated request was recorded at all, so the budget below would pass vacuously"

    total = sum(entry["transfer"] or 0 for entry in images)
    assert total < SHELL_IMAGE_BUDGET, (
        f"the shell's own images total {total} bytes ({total / 1024:.1f} KB), over the {SHELL_IMAGE_BUDGET // 1024} KB budget: "
        + ", ".join(f"{entry['name']} {entry['transfer'] or 0} B" for entry in images)
    )
    oversize = [entry for entry in images if (entry["transfer"] or 0) > SHELL_SINGLE_IMAGE_BUDGET]
    assert not oversize, (
        f"a single shell image is bigger than {SHELL_SINGLE_IMAGE_BUDGET // 1024} KB - the 1080px icon.png is 349 KB and is "
        f"only the link preview: {[(entry['name'], entry['transfer']) for entry in oversize]}"
    )
    assert not [entry for entry in entries if entry["name"].split("?")[0].endswith("/icon.png")], (
        "the page fetched the 1080px icon.png; it belongs in the og:image meta tag, not on a page: "
        + ", ".join(entry["name"] for entry in entries if "icon.png" in entry["name"])
    )
    ui.assert_no_errors("the shell's first load")


# --- 2. artwork appears for a song that has some ----------------------------


def test_artwork_appears_for_a_song_that_has_a_cover(ui, backend, media_factory):
    """A row whose song has a cover must show a decoded picture, and only that."""
    token = _register(ui)
    bare = [media_factory.import_track(token, title=f"Song {index}", seconds=2, frequency=300 + 50 * index) for index in range(3)]

    # What the import path itself records. It reads a file's title, artist and
    # album and nothing else (`internal/media/library.go` readTags), so today a
    # local import carries no cover. That is an observation, not an assertion: a
    # song that *does* have one may have got it from the import or from the
    # local upload cover path, and the test should hold either way.
    imported_artwork = [(_fetch_track(backend, token, entry["trackId"]).get("artworkUrl") or "") for entry in bare]
    print(
        f"\nPOST /api/v1/library/import recorded artworkUrl for {sum(1 for url in imported_artwork if url)} of "
        f"{len(bare)} imported songs ({[url for url in imported_artwork if url]}); reading tags, not pictures, means a "
        "local import carries no cover, so the covers below are attached through the local upload cover path "
        "(POST /api/v1/uploads with associateTrackId), the only provider-free way a song gets one"
    )

    cover = _cover_png(backend)
    for entry in bare[:2]:
        _cover_a_track(backend, media_factory, token, entry["trackId"], cover)

    tracks = [_fetch_track(backend, token, entry["trackId"]) for entry in bare]
    assert tracks[0]["artworkUrl"] and tracks[1]["artworkUrl"], "the attached covers never reached the songs"

    # The rows that must show a picture are the songs the API says have one; a
    # song without a cover keeps a placeholder tile instead of an <img>, so it
    # cannot count as a failed image.
    expected = sum(1 for track in tracks if track.get("artworkUrl"))
    assert expected >= 2, f"only {expected} queued song(s) ended up with artwork: {[track.get('artworkUrl') for track in tracks]}"

    _queue_and_open(ui, tracks, backend, token)
    imgs = _wait_for_row_images(ui, expected=expected, timeout=ROW_IMAGES_BUDGET_S)
    _assert_images_loaded(imgs)

    rows = ui.js(f"return document.querySelectorAll({json.dumps(ROW_SELECTOR)}).length;")
    assert rows == 3, f"the queue drew {rows} rows, not the three songs that were queued"
    print(f"\nthe queue drew {rows} songs; the {len(imgs)} the API reports carry a cover all decoded, the rest kept a placeholder tile")
    ui.assert_no_errors("a queue of songs with covers")


# --- 3. no image request is slow --------------------------------------------

def test_no_image_request_is_slow(ui, backend, media_factory):
    """Every picture the page asks for must be answered inside the budget."""
    token = _register(ui)
    songs = [media_factory.import_track(token, title=f"Covered {index}", seconds=2, frequency=350 + 50 * index) for index in range(3)]
    cover = _cover_png(backend)
    for entry in songs:
        _cover_a_track(backend, media_factory, token, entry["trackId"], cover)

    tracks = [_fetch_track(backend, token, entry["trackId"]) for entry in songs]
    _queue_and_open(ui, tracks, backend, token)
    _wait_for_row_images(ui, expected=3, timeout=ROW_IMAGES_BUDGET_S)

    images = _image_requests(ui)
    _print_image_requests("every image request on the page", images)
    covers = [entry for entry in images if "/api/v1/artwork/" in entry["name"]]
    assert len(covers) >= 3, (
        f"only {len(covers)} cover request(s) reached Resource Timing; without them the budget would be read against the "
        f"wrong requests: {[entry['name'] for entry in images]}"
    )

    slow = [entry for entry in images if entry["duration"] > IMAGE_REQUEST_BUDGET_MS]
    assert not slow, (
        f"{len(slow)} image request(s) took longer than {IMAGE_REQUEST_BUDGET_MS:.0f} ms - a cover waiting on a provider "
        "used to hold for 20 s: "
        + ", ".join(f"{entry['name']} {entry['duration']:.0f} ms" for entry in slow)
    )
    ui.assert_no_errors("a page full of covers")


# --- 4. a page of many images stays responsive ------------------------------


def test_a_page_of_many_images_stays_responsive(ui, backend, media_factory):
    """Twenty rows of covers all load, and the page still answers a click."""
    token = _register(ui)
    songs = [media_factory.import_track(token, title=f"Row {index}", seconds=1, frequency=250 + 13 * index) for index in range(20)]
    cover = _cover_png(backend)
    for entry in songs:
        _cover_a_track(backend, media_factory, token, entry["trackId"], cover)

    tracks = [_fetch_track(backend, token, entry["trackId"]) for entry in songs]
    assert all(track.get("artworkUrl") for track in tracks), "not every row got a cover, so the count below would be wrong"

    started = time.monotonic()
    _queue_and_open(ui, tracks, backend, token)

    # The page's own interactions must not sit behind the covers arriving.
    click_started = time.monotonic()
    ui.click_tab("Account")
    ui.wait_text(".topbar h1", "Account", "the Account view never took over while the queue's covers were loading")
    ui.click_tab("Queue")
    click_ms = (time.monotonic() - click_started) * 1000

    imgs = _wait_for_row_images(ui, expected=20, timeout=ALL_IMAGES_BUDGET_S)
    elapsed = time.monotonic() - started
    _assert_images_loaded(imgs)

    print(
        f"\n{len(imgs)} song images were all decoded {elapsed * 1000:.0f} ms after the queue was set; "
        f"a tab click through the middle of it took {click_ms:.0f} ms"
    )
    assert elapsed < ALL_IMAGES_BUDGET_S, (
        f"the page's {len(imgs)} images took {elapsed:.2f}s to all load, over the {ALL_IMAGES_BUDGET_S:.1f}s budget"
    )
    assert click_ms < TAB_CLICK_BUDGET_MS, (
        f"a tab click took {click_ms:.0f} ms while the rows were loading, over the {TAB_CLICK_BUDGET_MS} ms budget"
    )
    ui.assert_no_errors("a queue of twenty songs")