"""The loading bar reflects download progress before file playback begins."""

from __future__ import annotations

import json
import re
import time
import urllib.parse

import pytest

from conftest import sign_in_ui
from test_library import assert_clock_moves, wait_sounding

pytestmark = [pytest.mark.slow]

QUERY = TITLE = "E2E Slow Tone"
PROVIDER = "e2e-slow"
SONG_SECONDS = 30
CONVERT_TOTAL_MS = SONG_SECONDS * 1000
DOWNLOAD_TOTAL = SONG_SECONDS * 48_000 * 2 + 44
STEP = 0.25
WATCH_TIMEOUT = 40.0


def row_xpath(title):
    """The search result row whose own title is `title`."""
    return "//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)=%s]]" % json.dumps(title)


BAR_JS = """
const bar = document.querySelector('.player-bar');
const wrap = bar && bar.querySelector('.track-text .progress');
const fill = wrap && wrap.querySelector('.bar');
return {
  text: bar && bar.querySelector('.subtitle') ? bar.querySelector('.subtitle').textContent.trim() : '',
  shown: !!(wrap && wrap.style.display !== 'none'),
  indeterminate: !!(wrap && wrap.classList.contains('indeterminate')),
  fill: fill ? (fill.style.width || '') : '',
};
"""
DOWNLOAD_TEXT = re.compile(r"downloading (\d+(?:\.\d+)?(?: (?:B|KB|MB|GB|TB))?) of (\d+(?:\.\d+)? (?:B|KB|MB|GB|TB))$")
CONVERT_TEXT = re.compile(r"converting (\d+)%$")


def find_variant(backend, token):
    """The slow provider's rendition of the tone, wherever the matcher put it.

    The canonical track a provider hit lands on is not necessarily named after
    the hit: another test in the run may already have a track the matcher ties
    this one to (the suite shares one server). The variant is what this file is
    about, so the *variant's* provider and title are what it looks for.
    """
    status, payload = backend.get(f"/api/v1/search?q={urllib.parse.quote(QUERY)}&limit=5", token=token)
    assert status == 200, f"search answered {status}: {payload!r}"
    for group in (payload or {}).get("groups") or []:
        for variant in group.get("variants") or []:
            if variant.get("provider") == PROVIDER and variant.get("title") == TITLE:
                return variant, ((group.get("track") or {}).get("title") or TITLE)
    raise AssertionError(f"search never named {PROVIDER!r} for {TITLE!r}: {payload!r}")


def status(backend, token, variant_id):
    code, payload = backend.get(f"/api/v1/media/{variant_id}/status", token=token)
    assert code == 200, f"status answered {code}: {payload!r}"
    return payload if isinstance(payload, dict) else {}


def bytes_figure(value):
    amount, unit = value.split(" ")
    return float(amount) * {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}[unit]


def bar_kind(text):
    found = CONVERT_TEXT.search(text or "")
    if found:
        return "convert", int(found.group(1)), None
    found = DOWNLOAD_TEXT.search(text or "")
    if found:
        done, whole = found.groups()
        unit = whole.split(" ")[1]
        return "download", bytes_figure(done if " " in done else f"{done} {unit}"), bytes_figure(whole)
    return "other", None, None


def watch(ui, backend, token, variant_id):
    samples = []
    deadline = time.monotonic() + WATCH_TIMEOUT
    while True:
        bar = ui.js(BAR_JS) or {}
        state = ui.player() or {}
        code, answer = backend.get(f"/api/v1/media/{variant_id}/status", token=token)
        api = answer if isinstance(answer, dict) else {}
        samples.append({
            "bar": bar,
            "src": state.get("src") or "",
            "paused": bool(state.get("paused")),
            "currentTime": state.get("currentTime") or 0,
            "api": {"http": code, "state": api.get("state", ""), "stage": api.get("stage", ""),
                    "progress": api.get("progress"), "bytes": api.get("bytes") or 0,
                    "totalBytes": api.get("totalBytes") or 0},
        })
        if api.get("state") == "ready" or time.monotonic() >= deadline:
            return samples
        time.sleep(STEP)


def test_the_bar_draws_download_progress_before_playback(ui, backend, signed_in):
    variant, named = find_variant(backend, signed_in.token)
    variant_id = variant["id"]
    row = row_xpath(named)
    sign_in_ui(ui, signed_in)
    ui.click_tab("Search")
    ui.type("input[type='search']", QUERY)
    ui.click("button[title='Search again']")
    ui.wait_xpath(row, f"the {named!r} search result")
    ui.click_xpath(row, f"the {named!r} search result")

    samples = watch(ui, backend, ui.token(), variant_id)
    downloads = [sample for sample in samples if sample["api"]["stage"] == "download"]
    converts = [sample for sample in samples if sample["api"]["stage"] == "convert"]
    assert len(downloads) >= 4, f"too few download samples: {samples!r}"
    assert converts, f"conversion was never reported: {samples!r}"
    assert {sample["api"]["totalBytes"] for sample in downloads} == {DOWNLOAD_TOTAL}
    arrived = [sample["api"]["bytes"] for sample in downloads]
    assert arrived == sorted(arrived)
    assert max(arrived) == DOWNLOAD_TOTAL
    assert {sample["api"]["totalBytes"] for sample in converts} == {CONVERT_TOTAL_MS}

    bar_download = [sample for sample in samples if bar_kind(sample["bar"].get("text"))[0] == "download"]
    bar_convert = [sample for sample in samples if bar_kind(sample["bar"].get("text"))[0] == "convert"]
    assert len(bar_download) >= 4
    assert bar_convert
    assert not any(sample["src"] for sample in bar_download), "audio received a source before the file was ready"
    assert not any(not sample["paused"] and sample["currentTime"] > 0.1 for sample in bar_download)
    fills = [bar_kind(sample["bar"].get("text"))[1] for sample in bar_download]
    assert fills == sorted(fills)
    assert max(fills) >= 0.9 * DOWNLOAD_TOTAL
    for sample in bar_convert:
        # One loader, and it does not fill: the fraction the provider reports is
        # not a fraction of the wait a person is in, so the bar sweeps for the
        # whole of it. What the bar says in words still names the stage.
        assert sample["bar"].get("fill", "") == "", "a waiting bar filled instead of sweeping"
        assert sample["bar"].get("indeterminate"), "the waiting bar is not marked as a sweep"

    ui.wait(lambda: not (ui.js(BAR_JS) or {}).get("shown"), "progress bar never hid", timeout=15)
    state = ui.wait_player(lambda value: value if value.get("src") and "start=" not in value["src"] else None,
                           "the complete file was never handed to audio")
    assert f"/api/v1/media/{variant_id}" in state["src"]
    wait_sounding(ui, named, SONG_SECONDS)
    assert_clock_moves(ui, named)
    ui.assert_no_errors("download progress playback")
