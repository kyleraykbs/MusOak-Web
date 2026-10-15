"""What a second load costs, and what the page can still do with the line cut.

The service worker serves the app's shell out of Cache Storage and revalidates
it behind the page; a navigation asks the network first and falls back to the
copy it has. The server sends `no-cache` + an ETag for unversioned files (so a
revalidation is a comparison of tags, not a body) and `immutable` for a
versioned one. A reload that carries the whole app over the wire again is the
defect this file exists to catch: it was once forced with `cache: "reload"` on
every shell file, and nothing but a Resource Timing table can see it.
"""

from __future__ import annotations

import json
import os
import re

import pytest

import harness
import servers
from conftest import REPO

pytestmark = [pytest.mark.slow, pytest.mark.browsers]

#: The app's own files, as sw.js names them (SHELL_PATH), with the page itself
#: left out because a navigation is not a Resource Timing entry.
SHELL = re.compile(
    r"^/(?:js/[\w./-]+\.js|fonts/[\w./-]+|theme\.css|icon\.png|icon-64\.png|apple-touch-icon\.png)$"
)

#: The playlist row's control for keeping a playlist on this machine, and the
#: same control once the playlist is kept (the row says so by renaming itself).
KEEP = "button[aria-label='Keep this playlist for offline play']"
KEPT = "button[aria-label^='Kept for offline play']"

#: The cache js/offline.js keeps a downloaded song's bytes in.
MEDIA_CACHE = "musoak-offline-v1"

#: One song's own media path, as sw.js names it (MEDIA_PATH) - the `/download`
#: and `/status` calls beside it are not the song's bytes.
MEDIA_PATH = re.compile(r"^/api/v1/media/[^/]+$")


def _path(entry):
    """The path of a resource URL, with its host and any query stripped."""
    return re.sub(r"^https?://[^/]+", "", entry["name"].split("?", 1)[0].split("#", 1)[0])


def _totals(entries):
    return sum(entry["transfer"] or 0 for entry in entries)


def _counts(entries):
    counted = {}
    for entry in entries:
        key = entry["status"] or "no-status"
        counted[key] = counted.get(key, 0) + 1
    return ", ".join(f"{key}:{value}" for key, value in sorted(counted.items(), key=lambda item: str(item[0])))


def _table(entries):
    rows = []
    for entry in entries:
        rows.append(
            f"    {str(entry['status'] or 'n/a'):>4}  transfer={(entry['transfer'] or 0):>7}"
            f"  encoded={(entry['encoded'] or 0):>7}  {entry['name']}"
        )
    return "\n".join(rows)


def _reload(ui, timeout=25.0):
    """Reload the way a person does, not the way WebDriver's `refresh` does.

    `driver.refresh()` in this Firefox is a hard reload: the new document has no
    service worker controller and the browser's cache is bypassed, so it
    re-downloads the app and cannot be used to measure a reload at all.
    `location.reload()` is the browser's own normal reload - the service worker
    answers the navigation, and the shell comes out of a cache.
    """
    origin = ui.js("return performance.timeOrigin;")
    ui.js(f"setTimeout(() => location.reload(), 0); return {origin};")
    ui.wait_js(f"performance.timeOrigin !== {origin}", "the page never reloaded", timeout=timeout)
    ui.wait_shell()
    ui.wait_quiet()
    return ui.resources()


def _load(ui):
    """Load the page cold, then reload it; each settled before it is read."""
    ui.goto("/")
    ui.wait_quiet()
    return ui.resources(), _reload(ui)


def _error_page(ui):
    """Whether the document on screen is Firefox's own error page."""
    return ui.count("#errorPageContainer, #neterror, .neterror") > 0


def _own_frontend(binaries, backend, run_dir, request, name):
    """A frontend of this test's own, on its own port, so it can be stopped."""
    web_dir = request.config.getoption("--frontend") or os.path.join(REPO, "web")
    directory = os.path.join(run_dir, name)
    os.makedirs(directory, exist_ok=True)
    return servers.Frontend(binaries["musoak-web"], directory, backend.url, web_dir)


def _shell_cache(ui):
    """What the service worker is holding, so a fallback test cannot pass empty."""
    return ui.js_async(
        "const cache = await caches.open('musoak-shell');"
        "const keys = await cache.keys();"
        "return keys.map((request) => new URL(request.url).pathname).sort();"
    )


def _media_cache(ui):
    """The song URLs js/offline.js has kept here, out of its own Cache Storage."""
    return ui.js_async(
        "const cache = await caches.open(arguments[0]);"
        "const keys = await cache.keys();"
        "return keys.map((request) => request.url);",
        MEDIA_CACHE,
    )


def _playlist_row(name):
    """The XPath of a playlist's row in the Playlists tab, by its own name."""
    return (
        "//div[contains(@class,'row')]"
        f"[.//div[contains(@class,'title')][normalize-space(.)={json.dumps(name)}]]"
    )


def test_a_reload_is_cheap(ui):
    """A reload must not carry the app over the wire a second time."""
    first, second = _load(ui)
    print(
        f"\n  first load: {len(first):>3} requests, {_totals(first):>8} bytes transferred"
        f"  [{_counts(first)}]"
    )
    print(
        f"  reload:     {len(second):>3} requests, {_totals(second):>8} bytes transferred"
        f"  [{_counts(second)}]"
    )
    print("  the reload, request by request:")
    print(_table(second))

    assert _totals(first) > 0, "the first load transferred nothing, so there is nothing to compare"
    # A small fraction, with a floor for the handful of API calls a boot makes:
    # config, session, library, the queue ahead. Anything approaching the first
    # load means the shell came over the wire again.
    assert _totals(second) <= max(_totals(first) * 0.25, 30_000), (
        f"the reload transferred {_totals(second)} bytes against the first load's {_totals(first)}"
        f" - the app was downloaded again\n{_table(second)}"
    )

    fresh = [
        entry
        for entry in second
        if SHELL.match(_path(entry)) and entry["status"] == 200 and (entry["transfer"] or 0) > 0
    ]
    assert not fresh, (
        "the reload downloaded shell files again, as fresh 200s with a body:\n" + _table(fresh)
    )
    ui.assert_no_errors("a first load and a reload")


def test_the_reload_uses_the_browser_cache_not_the_wire(ui):
    """js/app.js on a reload is a revalidation or a cache answer, never a 200 body.

    This is the assertion that fails if `cache: "reload"` ever comes back: the
    module arrives as a fresh 200 with its whole body on the wire.
    """
    _load(ui)
    entries = [entry for entry in ui.resources() if _path(entry) == "/js/app.js"]
    assert entries, f"the reload's resource table has no js/app.js entry: {_counts(ui.resources())}"
    print(f"\n  js/app.js on the reload: {_table(entries)}")

    fresh = [entry for entry in entries if entry["status"] == 200 and (entry["transfer"] or 0) > 0]
    assert not fresh, (
        "js/app.js arrived on a reload as a fresh 200 with a body, so the copy the browser"
        " already had was bypassed:\n" + _table(fresh)
    )
    reused = [entry for entry in entries if entry["status"] == 304 or (entry["transfer"] or 0) == 0]
    assert reused, (
        f"js/app.js was neither revalidated (304) nor served from a cache (transferSize 0):\n"
        + _table(entries)
    )
    ui.assert_no_errors("a reload's js/app.js")


def test_the_shell_opens_with_the_server_gone(binaries, backend, run_dir, headless, request):
    """Load the app, stop its server, reload: the shell still opens.

    Nothing is restored afterwards - the frontend here is this test's own, on
    its own port, in front of the shared backend, and it is disposed of in the
    `finally` either way.
    """
    front = _own_frontend(binaries, backend, run_dir, request, "frontend-shell-gone")
    ui = harness.open_ui(front.url, os.path.join(run_dir, "artifacts"), name="shell-gone", headless=headless)
    try:
        ui.goto("/")
        assert ui.count("nav .nav-item") >= 5, f"the app never drew (it said {ui.text('body')[:200]!r})"
        ui.wait_quiet()
        ui.wait_js("!!navigator.serviceWorker.controller", "the service worker never took the page")

        # The first load runs before the worker is in control, so its shell is
        # not in the cache yet: one reload is what fills Cache Storage. Without
        # this the fallback has nothing to serve, and the test would be about a
        # cache rather than about the app.
        _reload(ui)
        held = _shell_cache(ui)
        print(f"\n  the service worker is holding {len(held)} shell files, including: {held[:6]}")
        assert "/" in held, f"the service worker never kept the page itself: {held}"
        assert "/js/app.js" in held, f"the service worker never kept the app's modules: {held}"

        front.stop()

        _reload(ui)
        assert not _error_page(ui), (
            f"reloading with {front.url} stopped showed the browser's error page instead of the"
            f" app's own copy\n{_table(ui.resources())}"
        )
        assert ui.count("nav .nav-item") >= 5, (
            f"the shell did not open from the service worker's copy with {front.url} stopped"
        )
        assert ui.has(".player-bar"), "the player bar did not open with the frontend stopped"
        ui.assert_no_errors("opening the shell with its server gone")
    except Exception:
        # The suite writes a failing test's page down; a session this test made
        # for itself is not one the fixture hook knows about.
        ui.dump("FAILED")
        raise
    finally:
        ui.driver.quit()
        front.stop()


def test_a_cold_cache_is_not_timed_out_into_a_blank_page(ui):
    """The first load has nothing to fall back to, so nothing may time it out.

    SHELL_TIMEOUT_MS only applies to a request that has a copy behind it. A cold
    load that was cut off would show the browser's error page; one that arrived
    must show an app a person can use.
    """
    ui.goto("/")
    entries = ui.resources()
    print(
        f"\n  a cold load: {len(entries)} requests, {_totals(entries)} bytes transferred"
        f"  [{_counts(entries)}]"
    )
    assert not _error_page(ui), "the first load fell back to the browser's error page"
    assert ui.count("nav .nav-item") >= 5, f"the shell did not draw on a cold load: {ui.text('body')[:200]!r}"
    assert ui.has(".player-bar"), "the player bar did not draw on a cold load"
    # A cold load really is cold: the app came over the wire, not out of a cache
    # that a previous test left behind.
    assert _totals(entries) > 100_000, (
        f"the 'cold' load transferred only {_totals(entries)} bytes, so it was not cold\n{_table(entries)}"
    )

    # Usable, not merely painted: the account tab draws the guest card the boot
    # fetched its config for.
    ui.click_tab("Account")
    ui.wait_css(
        "//*[contains(@class,'card')]//button[normalize-space(.)='Sign in']",
        "the account view never drew on a cold load",
    )
    ui.assert_no_errors("a cold first load")


def test_a_kept_playlist_still_plays_without_the_server(binaries, backend, signed_in, run_dir, headless, request):
    """Keep a playlist, stop its server, and the song still plays from the page.

    Every step is one a person takes: the playlist is kept with the row's own
    control, played with the playlist page's own Play button, and played again
    after the server has gone. What is asserted is the app's own `<audio>`
    element and the bytes the service worker serves, not a label.

    The keep has to be exercised while the server is there, and so does the
    first play: the app learns the file from the backend before it will hand the
    element a URL. A page whose server is *already* gone cannot start a kept
    song - `player.readyState()` never leaves "none" - which is a finding, not
    something this file papers over.
    """
    name = "Offline songs"
    status, playlist = backend.post("/api/v1/me/playlists", {"name": name}, token=signed_in.token)
    assert status in (200, 201) and (playlist or {}).get("id"), f"creating a playlist answered {status}: {playlist}"
    status, detail = backend.post(
        f"/api/v1/me/playlists/{playlist['id']}/items",
        {"trackIds": [signed_in.tracks[0]["trackId"]]},
        token=signed_in.token,
    )
    assert status == 200, f"adding a track answered {status}: {detail}"

    front = _own_frontend(binaries, backend, run_dir, request, "frontend-kept-playlist")
    ui = harness.open_ui(front.url, os.path.join(run_dir, "artifacts"), name="kept-playlist", headless=headless)
    try:
        from conftest import sign_in_ui

        sign_in_ui(ui, signed_in)
        ui.click_tab("Playlists")
        ui.wait_css(KEEP, "the playlist row drew no keep control")

        ui.click(KEEP)
        ui.wait(lambda: ui.has(KEPT), "the row never said the playlist was kept on this machine", timeout=40)
        held = _media_cache(ui)
        assert held, "the row says the playlist is kept but the page's media cache is empty"
        print(f"\n  kept on this machine: {held}")

        # The playlist page's own Play, while the server is still there: this is
        # what teaches the player which file the song is. The song must come out
        # of the page's own copy even here: the playlist is kept, so the service
        # worker answers the media request from Cache Storage and nothing about
        # the song crosses the wire.
        ui.click_xpath(_playlist_row(name), f"the row for {name!r}")
        since = ui.mark()
        ui.click_text("Play")
        ui.wait_player(
            lambda state: state if state and state["src"] and state["currentTime"] > 0.2 else None,
            "the kept playlist never played while the server was still up",
            timeout=30,
        )
        played = [entry for entry in ui.resources(since) if MEDIA_PATH.match(_path(entry))]
        print("  the app's own play of the kept playlist asked the page for:")
        print(_table(played) or "    (no media request at all)")
        assert played, "playing a kept playlist made no media request"
        carried = [entry for entry in played if (entry["encoded"] or 0) > 0]
        assert not carried, (
            "the song was carried over the wire even though the playlist is kept on this machine"
            " (a served-by-the-page answer reports no body size):\n" + _table(carried)
        )
        ui.click("[title='Pause']")
        ui.wait_player(lambda state: state and state["paused"], "the song never paused", timeout=10)

        front.stop()

        # The same Play again, with nothing to fetch it from but the page.
        ui.click_text("Play")
        playing = ui.wait_player(
            lambda state: state if state and state["src"] and state["currentTime"] > 0.5 else None,
            f"the kept song did not play with {front.url} stopped, so nothing served the page's own copy",
            timeout=30,
        )
        print(f"  with the server stopped the app played {playing['src']}")
        assert abs((playing["duration"] or 0) - 12) < 1.0, (
            f"what played is not the twelve-second song that was kept: {playing}"
        )

        served = ui.js_async(
            "const cache = await caches.open(arguments[0]);"
            "const keys = await cache.keys();"
            "const held = await cache.match(keys[0]);"
            "const response = await fetch(keys[0].url);"
            "const bytes = (await response.arrayBuffer()).byteLength;"
            "return { url: keys[0].url, status: response.status, bytes, kept: (await held.blob()).size };",
            MEDIA_CACHE,
        )
        print(f"  the page's own copy answered {served['status']} with {served['bytes']} bytes")
        assert served["status"] == 200, f"the page's own copy did not answer the song: {served}"
        assert served["bytes"] == served["kept"] and served["bytes"] > 0, (
            f"the page served {served['bytes']} bytes of the {served['kept']} it kept: {served}"
        )
        # A blob is the player's own copy of those bytes in memory; the routed
        # URL is the same copy served by the service worker. Anything else would
        # be a URL the stopped frontend cannot answer.
        source = playing["src"] or ""
        assert source.startswith("blob:") or source == served["url"], (
            f"what played ({source}) is neither the kept copy ({served['url']}) nor a blob the page"
            " built from it"
        )
        ui.assert_no_errors("playing a kept playlist with its server stopped")
    except Exception:
        ui.dump("FAILED")
        raise
    finally:
        ui.driver.quit()
        front.stop()
