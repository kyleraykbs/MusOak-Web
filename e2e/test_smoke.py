"""The pipeline itself, end to end, in one file.

Before anything is asserted about the app, the suite has to prove it can watch:
a real server, the real web UI in front of it, a real Firefox, a signed-in
person, a song that plays and a clock that moves. Every other file assumes this
passes, and when it fails the rest are noise.

The playback here is driven through the app's own player module rather than a
click, because this file is about the *pipeline*; the paths a person clicks
(register, upload, queue, next) have their own suites.
"""

import os
import time

import pytest

from conftest import register_ui

pytestmark = [pytest.mark.slow, pytest.mark.browsers]


def test_servers_come_up_and_the_shell_renders(ui, backend):
    ui.goto("/")
    assert ui.count("nav .nav-item") >= 5, f"the tab strip is missing: {ui.text('nav')!r}"
    assert ui.has(".player-bar"), "the player bar is missing"
    assert ui.count("nav .nav-item") == len(ui.texts("nav .nav-item")), "a tab has no label"
    # The suite's own contract. An empty page must not be able to pass as a
    # clean one, so every file ends up making this same call.
    ui.assert_no_errors("the first load")
    assert backend.get("/api/v1/providers")[0] == 200


def test_the_ui_can_reach_the_backend(ui, backend):
    """The web UI is a router: what it says about its backend must be true."""
    ui.goto("/")
    payload = ui.js("return fetch('/ui/config').then((r) => r.json());")
    assert payload["defaultServer"] == backend.url, (
        f"the UI is routing to {payload['defaultServer']!r}, not the backend under test {backend.url!r}"
    )


def test_a_person_registers_and_a_song_plays(ui, backend, media_factory):
    """Register, import a file, play it, and watch the clock it reports."""
    username = f"smoke-{os.urandom(3).hex()}"
    register_ui(ui, username, "correct horse battery staple")
    assert ui.token(), "a signed-in session has no token"

    track = media_factory.import_track(ui.token(), title=f"Smoke {username[-4:]}", seconds=12)

    # The player the app itself runs: imported on the page, so this is the real
    # module against the real server, not a copy of its logic.
    ui.js_async("const module = await import('/js/player.js'); window.__e2e = { ...(window.__e2e || {}), player: module.player };")
    ui.wait_js("window.__e2e && window.__e2e.player", "the player module never loaded on the page")

    # The app's own boot continues for a moment after sign-in (the session, the
    # saved playback, warming the queue ahead). Playing into that burst would
    # race the app rather than test it, so the suite waits for quiet first.
    ui.wait_quiet()

    started = time.monotonic()
    ui.js(
        "const p = window.__e2e.player;"
        "return p.playVariant({ id: arguments[0], title: arguments[1] }, arguments[2], { positionMs: 0, autoplay: true })"
        "  .then(() => true);",
        track["trackId"],
        track["track"].get("title") or "Smoke",
        track["variantId"],
    )

    # The reading is returned, not a boolean: the wait's result is the evidence
    # the assertions below are written against.
    playing = ui.wait_player(
        lambda state: state
        if state and state["src"] and state["currentTime"] > 0.2
        else None,
        "the imported song never started playing",
        timeout=30,
    )
    first_audio = time.monotonic() - started
    assert playing["duration"] > 0, "the element has no duration"
    print(f"\nfirst audio after {first_audio:.2f}s for a local file (variant {track['variantId']})")

    # The clock moves: a paused element with a src is not a playing song, and
    # that distinction is the whole reason this file exists.
    before = ui.player()["currentTime"]
    ui.wait_player(
        lambda state: state["currentTime"] > before + 0.5,
        "the song's clock never advanced",
        timeout=10,
    )
    assert not ui.player()["paused"], "the song stopped by itself"
    ui.assert_no_errors("playing an imported song")


def test_the_browser_reports_a_console_error_when_there_is_one(ui):
    """The harness's own check: a collector that sees nothing must fail.

    Everything else in the suite leans on 'no console errors'. If the mechanism
    silently captured nothing, every one of those assertions would pass for the
    wrong reason - so the mechanism is asserted first, with a deliberate error.
    """
    ui.goto("/")
    assert ui.console_available(), (
        "console capture is unavailable in this Firefox session (BiDi not negotiated, and the "
        "driver log carried nothing), so 'no errors' cannot be asserted anywhere in the suite"
    )
    ui.clear_errors()
    ui.js("console.error('the suite asked for this error');")
    ui.js("setTimeout(() => { window.__e2e_missing.boom; }, 0);")
    ui.wait(lambda: ui.errors(), "a deliberate console error was never captured", timeout=10)
    kinds = {entry["kind"] for entry in ui.errors()}
    assert "console" in kinds, f"the console error was not captured: {ui.errors()}"
    ui.clear_errors()