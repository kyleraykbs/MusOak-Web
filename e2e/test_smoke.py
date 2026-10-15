"""The pipeline itself, end to end, in one file.

Before anything is asserted about the app, the suite has to prove it can watch:
a real server, the real web UI in front of it, a real Firefox, a signed-in
person, a song that plays and a clock that moves. Every other file assumes this
passes, and when it fails the rest are noise.

Everything here drives the app the way a person does - clicks, not module
imports. A page-side `import('/js/player.js')` re-instantiates the app's module
graph under the service worker and boots a *second* app (empty state, its own
audio element, its own rooms), so a test that reaches into the modules ends up
measuring an app the user is not using. That trap cost this suite an afternoon
and is the reason the helpers below are click-only.
"""

import os
import time

import pytest

from conftest import register_ui
from test_library import blur, play_from_manage, tone, upload_via_api, wait_sounding

pytestmark = [pytest.mark.slow, pytest.mark.browsers]


class Person:
    """The API-side identity behind a browser that signed in through the form."""

    def __init__(self, token):
        self.token = token


def test_servers_come_up_and_the_shell_renders(ui, backend):
    ui.goto("/")
    assert ui.count("nav .nav-item") >= 5, f"the tab strip is missing: {ui.text('nav')!r}"
    assert ui.has(".player-bar"), "the player bar is missing"
    assert len(ui.texts("nav .nav-item")) == ui.count("nav .nav-item"), "a tab has no label"
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


def test_a_person_registers_uploads_and_a_song_plays(ui, backend, media_factory):
    """Register, upload a file, play it from its row, and watch the clock."""
    username = f"smoke-{os.urandom(3).hex()}"
    register_ui(ui, username, "correct horse battery staple")
    assert ui.token(), "a signed-in session has no token"

    title = f"Smoke {username[-4:]}"
    # A whole second longer than anything else this run makes, so the element's
    # own length says which song is sounding.
    seconds = 9
    upload = upload_via_api(backend, Person(ui.token()), tone(media_factory, seconds), title)
    assert upload["trackId"], f"the upload came back without a track: {upload}"

    ui.wait_quiet()
    started = time.monotonic()
    play_from_manage(ui, title)
    playing = wait_sounding(ui, title, seconds)
    first_audio = time.monotonic() - started
    print(f"\nfirst audio after {first_audio:.2f}s for an uploaded file (track {upload['trackId']})")

    # The clock moves: a paused element with a src is not a playing song, and
    # that distinction is the whole reason this file exists.
    before = playing["currentTime"]
    ui.wait_player(
        lambda state: state if state["currentTime"] > before + 0.4 else None,
        "the song's clock never advanced",
        timeout=10,
    )
    assert ui.now_playing() == title, f"the bar says {ui.now_playing()!r}, not {title!r}"
    blur(ui)
    ui.assert_no_errors("playing an uploaded song")


def test_the_browser_reports_a_console_error_when_there_is_one(ui):
    """The harness's own check: a collector that sees nothing must fail.

    Everything else in the suite leans on 'no console errors'. If the mechanism
    silently captured nothing, every one of those assertions would pass for the
    wrong reason - so the mechanism is asserted first, with a deliberate error.
    Two mechanisms are watched, because one of them can silently drop an entry:
    BiDi's `log.entryAdded` handler (Selenium's typed parse raises on an event
    with no stack trace, inside the socket thread, where nobody sees it) and the
    driver's own log, which carries Firefox's console output regardless.
    """
    ui.goto("/")
    ui.clear_errors()
    ui.js("console.error('the suite asked for this error');")
    ui.js("setTimeout(() => { window.__e2e_missing.boom; }, 0);")
    captured = ui.wait(lambda: ui.errors(), "a deliberate console error was never captured", timeout=10)
    texts = " ".join(entry["text"] for entry in captured)
    assert "the suite asked for this error" in texts, f"the console error was not captured: {captured}"
    assert any(entry["kind"] == "javascript" for entry in captured), (
        f"the uncaught exception was not captured: {captured}"
    )
    # The BiDi callback can arrive after the driver log has caught up, so a
    # deliberate error cannot be made to disappear synchronously. The important
    # contract is above: both collectors saw it. Leave this browser to fixture
    # teardown rather than making an asynchronous callback a false failure.
