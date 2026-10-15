"""The suite's fixtures: one server, one web UI, and a browser per test.

The servers are session-scoped because starting them is the slow part; a
browser is per-test because a browser carries state (its service worker, its
queue, its session) and a test that inherits the last one's state is a test
that passes for the wrong reason.

Everything a failure needs is written to e2e/artifacts/<run>: screenshots, the
page's HTML, the console, the resource table, and both process logs.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import uuid

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import harness  # noqa: E402
import servers  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def pytest_addoption(parser):
    parser.addoption("--musoakd", default=None, help="path to the musoakd binary to test")
    parser.addoption("--musoak-web", default=None, help="path to the musoak-web binary to test")
    parser.addoption("--artifacts", default=None, help="where to write run artifacts")
    parser.addoption("--headful", action="store_true", help="show the browser window")
    parser.addoption("--keep-servers", action="store_true", help="leave the servers running after the run")
    parser.addoption("--frontend", default=None, help="serve the frontend from this directory (default: the repo's web/)")


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: takes more than a few seconds")
    config.addinivalue_line("markers", "browsers: needs more than one browser session")


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """On failure, write down what the page looked like.

    A browser test that fails with a bare assertion gives a person nothing to
    work with: the screenshot and the page dump are the difference between
    reading a failure and guessing at it.
    """
    outcome = yield
    report = outcome.get_result()
    if report.when == "call" and report.failed:
        for name in ("ui", "host", "guest"):
            ui = item.funcargs.get(name)
            if isinstance(ui, harness.Ui):
                written = ui.dump(f"FAILED-{item.name}")
                if written:
                    report.sections.append((f"{name} artifacts", "\n".join(written)))


@pytest.fixture(scope="session")
def run_dir(request, tmp_path_factory):
    if request.config.getoption("--artifacts"):
        path = request.config.getoption("--artifacts")
        shutil.rmtree(path, ignore_errors=True)
    else:
        path = str(tmp_path_factory.mktemp("musoak-e2e"))
    os.makedirs(path, exist_ok=True)
    return path


@pytest.fixture(scope="session")
def binaries(request, run_dir):
    bin_dir = os.path.join(run_dir, "bin")
    os.makedirs(bin_dir, exist_ok=True)
    musoakd, how_musoakd = servers.resolve_musoakd(request.config.getoption("--musoakd"), bin_dir)
    musoak_web, how_web = servers.resolve_musoak_web(request.config.getoption("--musoak-web"), bin_dir)
    resolved = {
        "musoakd": musoakd,
        "musoakd_from": how_musoakd,
        "musoakd_checkout": servers.checkout_head(os.path.join(servers.SIBLING, "musoak")),
        "musoak-web": musoak_web,
        "musoak-web_from": how_web,
        "musoak-web_checkout": servers.checkout_head(os.path.join(servers.SIBLING, "musoak-web")),
    }
    # Printed rather than assumed: a run that tested something other than the
    # tree beside it has to be visible in the output, not discovered later.
    print("\n--- what this run tests")
    print(f"    musoakd    {servers.identity(musoakd)}   [{how_musoakd}]")
    print(f"    musoak     {resolved['musoakd_checkout']}")
    print(f"    musoak-web {servers.identity(musoak_web)}   [{how_web}]")
    print(f"    web        {resolved['musoak-web_checkout']}")
    return resolved


@pytest.fixture(scope="session")
def backend(binaries, run_dir, request):
    directory = os.path.join(run_dir, "musoakd")
    os.makedirs(directory, exist_ok=True)
    server = servers.Backend(binaries["musoakd"], directory)
    server.wait_ready()
    yield server
    if request.config.getoption("--keep-servers"):
        print(f"\nkeeping musoakd: {server.url} ({server.process.log_path})")
        return
    server.stop()


@pytest.fixture(scope="session")
def frontend(binaries, backend, run_dir, request):
    directory = os.path.join(run_dir, "musoak-web")
    os.makedirs(directory, exist_ok=True)
    web_dir = request.config.getoption("--frontend") or os.path.join(REPO, "web")
    server = servers.Frontend(binaries["musoak-web"], directory, backend.url, web_dir)
    yield server
    if request.config.getoption("--keep-servers"):
        print(f"\nkeeping musoak-web: {server.url} ({server.process.log_path})")
        return
    server.stop()


@pytest.fixture(scope="session")
def headless(request):
    return not request.config.getoption("--headful")


@pytest.fixture
def ui(frontend, run_dir, headless, request):
    name = request.node.name.replace("[", "-").replace("]", "")
    session = harness.open_ui(frontend.url, os.path.join(run_dir, "artifacts"), name=name[:40], headless=headless)
    try:
        yield session
    finally:
        session.driver.quit()


@pytest.fixture
def host(frontend, run_dir, headless, request):
    """A room's host: one person, one browser."""
    name = "host-" + request.node.name.replace("[", "-").replace("]", "")[:32]
    session = harness.open_ui(frontend.url, os.path.join(run_dir, "artifacts"), name=name, headless=headless)
    try:
        yield session
    finally:
        session.driver.quit()


@pytest.fixture
def guest(frontend, run_dir, headless, request):
    """A second person, with their own browser, storage and session."""
    name = "guest-" + request.node.name.replace("[", "-").replace("]", "")[:32]
    session = harness.open_ui(frontend.url, os.path.join(run_dir, "artifacts"), name=name, headless=headless)
    try:
        yield session
    finally:
        session.driver.quit()


@pytest.fixture(scope="session")
def media_factory(backend, run_dir):
    """Local tracks, made on the spot with ffmpeg, imported into the library.

    Providers are disabled in the suite's config, so a track that can be played
    has to be a file. Sine tones of different lengths: distinct durations are
    what the room's clock and the matcher both read.
    """

    class Factory:
        def __init__(self):
            self.made = 0

        def tone(self, title="Tone", seconds=12, frequency=440):
            self.made += 1
            path = os.path.join(backend.media_dir, f"{title.replace(' ', '-')}-{self.made}.ogg")
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                 "-f", "lavfi", "-i", f"sine=frequency={frequency}:duration={seconds}",
                 "-c:a", "libopus", path],
                check=True,
            )
            return path

        def import_track(self, token, title="Tone", seconds=12, frequency=440):
            path = self.tone(title, seconds, frequency)
            status, payload = backend.post("/api/v1/library/import", {"path": path}, token=token)
            if status != 200:
                raise servers.StartupError(f"import {path} -> {status} {payload}")
            imported = (payload or {}).get("imported") or []
            if not imported:
                raise servers.StartupError(f"import {path} reported nothing: {payload}")
            entry = imported[0]
            track = entry.get("track") or {}
            variant = entry.get("variant") or {}
            track_id, variant_id = track.get("id"), variant.get("id")
            if not track_id or not variant_id:
                raise servers.StartupError(f"import {path} answered without ids: {entry}")
            # The rendition's state is in the answer: a local file is stored
            # before the import returns, so a test can play it immediately.
            media = variant.get("media") or {}
            if media.get("state") != "ready":
                raise servers.StartupError(f"imported {track_id} is not ready: {media}")
            return {"track": track, "trackId": track_id, "variantId": variant_id, "variant": variant}

    return Factory()


@pytest.fixture
def signed_in(backend, media_factory):
    """A registered account with a couple of local tracks, made through the API.

    Suites that are about playback or rooms should not spend their first ten
    steps on a registration form; the registration and upload *UI* has its own
    test in test_library.py, which drives the real form.
    """

    class Account:
        def __init__(self):
            self.username = f"kyle-{uuid.uuid4().hex[:8]}"
            self.password = "correct horse battery staple"
            self.token = backend.register(self.username, self.password)
            self.tracks = [
                media_factory.import_track(self.token, title=f"Tone A {self.username[-4:]}", seconds=12, frequency=440),
                media_factory.import_track(self.token, title=f"Tone B {self.username[-4:]}", seconds=12, frequency=660),
                media_factory.import_track(self.token, title=f"Tone C {self.username[-4:]}", seconds=12, frequency=880),
            ]

    return Account()


DIALOG = "//*[contains(@class,'dialog')]"


def sign_in_ui(ui, account):
    """Sign a browser in through the form, which is the path a person takes.

    The dialog is reached the way it is reached by hand: the Account tab, and
    the guest card's own Sign in. A session written straight into localStorage
    would leave the whole sign-in path untested, which is the path that produces
    the token every other screen depends on.
    """
    ui.goto("/")
    ui.click_tab("Account")
    ui.click_xpath("//*[contains(@class,'card')]//button[normalize-space(.)='Sign in']", "the guest card's Sign in")
    ui.type(f"{DIALOG}//input[@placeholder='username']", account.username)
    ui.type(f"{DIALOG}//input[@placeholder='password']", account.password)
    ui.click_xpath(f"{DIALOG}//button[normalize-space(.)='Sign in']", "the Sign in submit")
    # A token, not a member id: every guest has a member id for the rooms, so
    # that alone cannot tell a signed-in person from a nobody.
    ui.wait(lambda: ui.token() != "", f"signing in as {account.username} never produced a token", timeout=25)
    return ui


def register_ui(ui, username, password):
    """Make an account through the same dialog, in its create mode."""
    ui.goto("/")
    ui.click_tab("Account")
    ui.click_xpath("//*[contains(@class,'card')]//button[normalize-space(.)='Sign in']", "the guest card's Sign in")
    ui.click_xpath(f"{DIALOG}//button[normalize-space(.)='Create an account']", "the create toggle")
    ui.type(f"{DIALOG}//input[@placeholder='username']", username)
    ui.type(f"{DIALOG}//input[@placeholder='password']", password)
    ui.click_xpath(f"{DIALOG}//button[normalize-space(.)='Create account']", "the create submit")
    ui.wait(lambda: ui.token() != "", f"creating {username} never produced a token", timeout=25)
    return ui