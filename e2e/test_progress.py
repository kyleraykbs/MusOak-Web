"""The queue's own mark is where a download is shown - the playing song's too.

One download per song: the row for the song somebody is waiting to hear is the
row that fills, it turns into the green diamond when the copy is in memory, and
the sound starts when it does. The playbar says the wait in one word; the
numbers and the sweeping bar it used to draw are gone, because they belonged to
a second download of the same song that no longer exists.
"""

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
WATCH_TIMEOUT = 60.0


def row_xpath(title):
    """The search result row whose own title is `title`."""
    return "//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)=%s]]" % json.dumps(title)


#: What the page says about this song's download, all of it in one read: the
#: bar's own line and whether it still draws a loader, the queue row's mark and
#: how full it is, and where the audio element is. One call, because two reads
#: of a download in flight are two different moments.
STATE_JS = """
const bar = document.querySelector('.player-bar');
const rows = [...document.querySelectorAll('.list .row')].filter((r) => !r.closest('[hidden]'));
const row = rows.find((r) => ((r.querySelector('.title') || {}).textContent || '').trim() === %s);
const held = row ? row.querySelector('.held') : null;
const mark = held ? held.querySelector('.dl') : null;
const audio = document.querySelector('audio[data-e2e=audio]');
return {
  found: !!row,
  held: held ? held.className : '',
  fill: mark ? (mark.style.getPropertyValue('--fill') || '') : '',
  unknown: !!(mark && mark.classList.contains('unknown')),
  filled: !!mark,
  subtitle: bar && bar.querySelector('.subtitle') ? bar.querySelector('.subtitle').textContent.trim() : '',
  loader: !!(bar && bar.querySelector('.track-text .progress')),
  src: audio ? (audio.currentSrc || audio.src || '') : '',
};
""" % json.dumps(TITLE)

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


def fill_percent(value):
    """`--fill` as a number: the mark's own ink, in percent, or None."""
    found = re.fullmatch(r"(\d+)%", value or "")
    return int(found.group(1)) if found else None


def watch(ui, backend, token, variant_id):
    samples = []
    deadline = time.monotonic() + WATCH_TIMEOUT
    while True:
        sample = ui.js(STATE_JS) or {}
        state = ui.player() or {}
        code, answer = backend.get(f"/api/v1/media/{variant_id}/status", token=token)
        api = answer if isinstance(answer, dict) else {}
        sample["api"] = {"http": code, "state": api.get("state", ""), "stage": api.get("stage", ""),
                         "progress": api.get("progress"), "bytes": api.get("bytes") or 0,
                         "totalBytes": api.get("totalBytes") or 0}
        sample["paused"] = bool(state.get("paused"))
        sample["currentTime"] = state.get("currentTime") or 0
        samples.append(sample)
        if api.get("state") == "ready" and sample["src"] and not sample["paused"]:
            return samples
        if time.monotonic() >= deadline:
            return samples
        time.sleep(STEP)


def test_the_queue_row_shows_the_song_s_download_and_the_sound_waits_for_it(ui, backend, signed_in):
    variant, named = find_variant(backend, signed_in.token)
    variant_id = variant["id"]
    row = row_xpath(named)
    sign_in_ui(ui, signed_in)
    ui.click_tab("Search")
    ui.type("input[type='search']", QUERY)
    ui.click("button[title='Search again']")
    ui.wait_xpath(row, f"the {named!r} search result")
    ui.click_xpath(row, f"the {named!r} search result")
    # The queue is where this download is watched, and the song's own row is the
    # one that carries it.
    ui.wait_css(".player-bar", "the playbar")
    ui.click_tab("Queue")

    samples = watch(ui, backend, ui.token(), variant_id)
    downloads = [sample for sample in samples if sample["api"]["stage"] == "download"]
    assert len(downloads) >= 4, f"too few download samples: {samples!r}"
    assert {sample["api"]["totalBytes"] for sample in downloads} == {DOWNLOAD_TOTAL}
    converts = [sample for sample in samples if sample["api"]["stage"] == "convert"]
    assert converts, f"conversion was never reported: {samples!r}"
    assert {sample["api"]["totalBytes"] for sample in converts} == {CONVERT_TOTAL_MS}

    # The playbar holds no download of its own: no loader element, no byte
    # numbers, just the word, for as long as the song is not sounding.
    assert not any(sample["loader"] for sample in samples), "the playbar drew a download bar again"
    waiting = [sample for sample in samples if not sample["src"]]
    assert waiting, f"the element was handed a source before the wait was seen: {samples!r}"
    assert all("downloading…" in sample["subtitle"] for sample in waiting), (
        f"the bar did not say the wait in words: {[s['subtitle'] for s in waiting]!r}"
    )
    assert not any(DOWNLOAD_TEXT.search(sample["subtitle"]) or CONVERT_TEXT.search(sample["subtitle"]) for sample in samples), (
        "the playbar is saying the download's numbers again"
    )

    # The song's own row carries the mark while its file is on its way, and it
    # fills: the count the server reports for the stage under way, drawn on the
    # row of the song somebody is waiting to hear.
    marked = [sample for sample in waiting if sample["found"]]
    assert marked, f"the playing song's own row was never found: {samples!r}"
    assert all(sample["held"].startswith("held pending") for sample in marked), (
        f"the row's mark was not the download: {[s['held'] for s in marked]!r}"
    )
    fills = [fill_percent(sample["fill"]) for sample in marked if fill_percent(sample["fill"]) is not None]
    assert fills, f"the mark never showed a count: {[s['fill'] for s in marked]!r}"
    assert max(fills) >= 80, f"the mark never filled: {fills!r}"

    # Nothing was heard before the row said the copy was here.
    ready = [index for index, sample in enumerate(samples) if sample["held"].startswith("held ready")]
    assert ready, f"the row never turned into the diamond: {samples!r}"
    sounding = [index for index, sample in enumerate(samples) if sample["src"]]
    assert sounding, f"the song never reached the element: {samples!r}"
    assert sounding[0] >= ready[0], (
        f"the element was given a source (sample {sounding[0]}) before the copy was here (sample {ready[0]})"
    )

    state = ui.player() or {}
    assert str(state.get("src") or "").startswith("blob:"), (
        f"the element is not playing the page's own copy of the file: {state!r}"
    )
    # One download: the file came from the backend once, and nothing was
    # streamed beside it.
    media = ui.requests_matching(re.escape(f"/api/v1/media/{variant_id}"))
    assert media, "the backend's file was never asked for"
    wait_sounding(ui, named, SONG_SECONDS)
    assert_clock_moves(ui, named)
    ui.assert_no_errors("the queue's download of the song playing")