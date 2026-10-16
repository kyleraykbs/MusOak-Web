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
ROW = "//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)=%s]]" % json.dumps(TITLE)
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
    status, payload = backend.get(f"/api/v1/search?q={urllib.parse.quote(QUERY)}&limit=5", token=token)
    assert status == 200, f"search answered {status}: {payload!r}"
    for group in (payload or {}).get("groups") or []:
        track = group.get("track") or {}
        if track.get("title") != TITLE:
            continue
        for variant in group.get("variants") or []:
            if variant.get("provider") == PROVIDER:
                return variant
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
    variant = find_variant(backend, signed_in.token)
    variant_id = variant["id"]
    sign_in_ui(ui, signed_in)
    ui.click_tab("Search")
    ui.type("input[type='search']", QUERY)
    ui.click("button[title='Search again']")
    ui.wait_xpath(ROW, f"the {TITLE!r} search result")
    ui.click_xpath(ROW, f"the {TITLE!r} search result")

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
        percent = bar_kind(sample["bar"].get("text"))[1]
        width = sample["bar"].get("fill", "")
        assert width == f"{percent}%"

    ui.wait(lambda: not (ui.js(BAR_JS) or {}).get("shown"), "progress bar never hid", timeout=15)
    state = ui.wait_player(lambda value: value if value.get("src") and "start=" not in value["src"] else None,
                           "the complete file was never handed to audio")
    assert f"/api/v1/media/{variant_id}" in state["src"]
    wait_sounding(ui, TITLE, SONG_SECONDS)
    assert_clock_moves(ui, TITLE)
    ui.assert_no_errors("download progress playback")
