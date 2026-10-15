"""The loading bar, drawn from the provider's own download progress.

The server reports what a provider is doing while it fetches a song: the stage
under way, that stage's own numbers, and the fraction of it that is done. This
test watches one real download - served by the `e2e-slow` provider a `-tags e2e`
build carries - and checks that the story reaches the page unaltered: the bar
fills as the bytes arrive, says the stage and its numbers, starts the next
stage's count when the stage changes, and gets out of the way when the file is
here and the song is playing.

Two things are measured at once, because they can disagree: what the page draws
(the progress element and the bar's own text) and what the status endpoint
answers with the same token the page is using. The second is the plumbing; the
first is what a person sees. A bar that moves while the status sits still, or
the other way round, is a bug either way.

A not-yet-downloaded song plays from the provider's own stream while the
download runs behind it (`internal/media/stream.go`), so the element is handed a
source - the stream - at the start rather than when the file lands. That is why
this test watches the download to its end rather than stopping at the first
sound, and why it reads the element's own `src`: the bar is drawing the
*download's* progress, not the song's position, and the two are only in the same
place if the fill is the endpoint's fraction. (The element's requests are not in
Resource Timing - the service worker answers `/api/v1/media/...`, so the bytes
belong to the worker's fetch - which is why the src is read from the element.)

Everything the fake reports is fixed - a source of 2,880,044 bytes (30 s of
48 kHz mono s16le, plus a header) streamed in ten chunks, then a conversion
reported as the song's 30,000 ms - so the assertions are about the numbers the
provider chose rather than about how a race went.
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

#: What the fake provider answers to, and what the test looks for on the page.
QUERY = "E2E Slow Tone"
TITLE = "E2E Slow Tone"
ARTIST = "E2E Suite"
PROVIDER = "e2e-slow"
#: The song's length, which is also the fake's conversion total in milliseconds.
SONG_SECONDS = 30
CONVERT_TOTAL_MS = SONG_SECONDS * 1000
#: The fake's fetched source: 30 s * 48,000 samples/s * 2 bytes + a 44-byte WAV
#: header. Fixed, so the download's total is a number this test can name.
DOWNLOAD_TOTAL = SONG_SECONDS * 48_000 * 2 + 44

#: How often the page is sampled and the status polled. The page asks the
#: status endpoint every 400 ms, so a quarter of a second is finer than what
#: the page itself can have seen.
STEP = 0.25
WATCH_TIMEOUT = 40.0

#: The search row whose own title is the fake's track.
ROW = "//div[contains(@class,'row')][.//div[contains(@class,'title')][normalize-space(.)=%s]]" % json.dumps(TITLE)

#: The page's own view of the loading bar: the text line, whether the bar is
#: drawn, and the fill the page painted into it. Read in one round trip so a
#: sample is one moment rather than three.
BAR_JS = """
const bar = document.querySelector('.player-bar');
const wrap = bar && bar.querySelector('.track-text .progress');
const fill = wrap && wrap.querySelector('.bar');
return {
  subtitle: bar && bar.querySelector('.subtitle') ? bar.querySelector('.subtitle').textContent.trim() : '',
  shown: !!(wrap && wrap.style.display !== 'none'),
  indeterminate: !!(wrap && wrap.classList.contains('indeterminate')),
  fill: fill ? (fill.style.width || '') : '',
};
"""

#: The bar's text as the web app writes it: "downloading 3.1 of 8.4 MB" while
#: the done figure shares the whole's unit, "downloading 281 KB of 2.7 MB"
#: while it does not. The whole always carries one.
DOWNLOAD_TEXT = re.compile(
    r"downloading (\d+(?:\.\d+)?(?: (?:B|KB|MB|GB|TB))?) of (\d+(?:\.\d+)? (?:B|KB|MB|GB|TB))$"
)
CONVERT_TEXT = re.compile(r"converting (\d+)%$")
STORE_TEXT = re.compile(r"storing")

def _find_variant(backend, token):
    """The fake's rendition, as the API sees it: the id the page will download.

    Asked for before the page is touched, so the test knows which rendition the
    download it is about to watch belongs to; the page's own requests are
    checked against this id afterwards.
    """
    query = urllib.parse.quote(QUERY)
    status, payload = backend.get(f"/api/v1/search?q={query}&limit=5", token=token)
    assert status == 200, f"search for {QUERY!r} answered {status}: {payload!r}"
    for group in (payload or {}).get("groups") or []:
        track = group.get("track") or {}
        if track.get("title") != TITLE:
            continue
        for variant in group.get("variants") or []:
            if variant.get("provider") == PROVIDER:
                return variant
    raise AssertionError(
        f"the search answer never named a {PROVIDER!r} rendition of {TITLE!r}: {payload!r}"
    )


def _percent(text):
    """The integer the app painted into the fill, or None when it painted none."""
    value = (text or "").strip()
    if not value.endswith("%"):
        return None
    try:
        return int(round(float(value[:-1])))
    except ValueError:
        return None


def _bytes_of(figure):
    """A "3.1 MB" figure back into bytes, within what its rounding allows."""
    amount, unit = figure.split(" ")
    scale = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}[unit]
    return float(amount) * scale


def _kind(text):
    """What the bar's text line says, and the numbers in it.

    The done figure is unitless when it shares the whole's unit - the app says
    the unit once - so it is read in the whole's unit, exactly as a person
    reading "1.1 of 2.7 MB" would.
    """
    found = CONVERT_TEXT.search(text or "")
    if found:
        return ("convert", int(found.group(1)), None)
    found = DOWNLOAD_TEXT.search(text or "")
    if found:
        done, whole = found.group(1), found.group(2)
        unit = whole.split(" ")[1]
        return ("download", _bytes_of(done if " " in done else f"{done} {unit}"), _bytes_of(whole))
    if STORE_TEXT.search(text or ""):
        return ("store", None, None)
    return ("other", None, None)


def _watch(ui, backend, token, variant_id):
    """Sample the page and the status endpoint every quarter second.

    Stops when the backend says the file is ready - the end of the story this
    test is about - or when the wait runs out, whichever comes first. Not at the
    first sound: a streamed song is sounding within a second, and stopping there
    would leave the download's own stages unread. Nothing here sleeps *for* the
    app: the only wait is between samples, and what ends the loop is a reading.
    """
    samples = []
    started = time.monotonic()
    deadline = started + WATCH_TIMEOUT
    while True:
        bar = ui.js(BAR_JS) or {}
        state = ui.player() or {}
        src = state.get("src") or ""
        status, answer = backend.get(f"/api/v1/media/{variant_id}/status", token=token)
        api = answer if isinstance(answer, dict) else {}
        samples.append({
            "t": round(time.monotonic() - started, 2),
            "fill": _percent(bar.get("fill")),
            "text": bar.get("subtitle", ""),
            "shown": bool(bar.get("shown")),
            "has_src": bool(src),
            # A stream is a media URL that names a position; a whole file names
            # none. This is the app's own marker, and the element's own src.
            "streaming": _start_param(src) is not None,
            "sounding": bool(src) and not state.get("paused") and (state.get("currentTime") or 0) > 0.1,
            "api": {
                "http": status,
                "state": api.get("state", ""),
                "stage": api.get("stage", ""),
                "progress": api.get("progress"),
                "bytes": api.get("bytes") or 0,
                "totalBytes": api.get("totalBytes") or 0,
            },
        })
        if samples[-1]["api"]["state"] == "ready" or time.monotonic() >= deadline:
            return samples
        time.sleep(STEP)


def _start_param(url):
    """The position a media URL names, or None when it names none."""
    raw = urllib.parse.parse_qs(urllib.parse.urlparse(url or "").query).get("start", [""])[0]
    return int(raw) if raw.isdigit() else None


def _table(samples):
    """Every sample, one line each: the evidence a failure is read from."""
    rows = ["    t     bar says                                   fill   bar  src   stream  sounding  api stage    api bytes/total"]
    for sample in samples:
        api = sample["api"]
        fill = "  -  " if sample["fill"] is None else f"{sample['fill']:>3}% "
        rows.append(
            f"    {sample['t']:>5.2f} {sample['text'][-42:]:<42} {fill}  "
            f"{'on ' if sample['shown'] else 'off'}  {'yes' if sample['has_src'] else 'no ':>3}  "
            f"{'stream' if sample['streaming'] else ('file  ' if sample['has_src'] else '  -   '):<6}  "
            f"{'yes' if sample['sounding'] else 'no ':>3}       "
            f"{(api['stage'] or '-'):<10} {api['bytes']}/{api['totalBytes']}"
        )
    return "\n".join(rows)


def _report(where, got, want):
    return f"{where}: got {got!r}, want {want}"


# ============================================================================


def test_the_bar_draws_the_download_the_provider_reports(ui, backend, signed_in):
    """A real (fake) provider's download, watched in the bar and at the API."""
    variant = _find_variant(backend, signed_in.token)
    variant_id = variant["id"]
    assert variant.get("providerTrackId"), f"the rendition has no provider track id: {variant!r}"

    sign_in_ui(ui, signed_in)
    token = ui.token()
    assert token, "the browser has no token after signing in"

    # The search and the click are how a person starts this download: a row in
    # the Tracks results, found by its own title.
    ui.click_tab("Search")
    ui.type("input[type='search']", QUERY)
    ui.click("button[title='Search again']")
    ui.wait_xpath(ROW, f"the {TITLE!r} search result")

    mark = ui.mark()
    ui.click_xpath(ROW, f"the {TITLE!r} search result")
    samples = _watch(ui, backend, token, variant_id)
    print("\n--- the bar, and the status it is drawn from")
    print(_table(samples))

    # The page asked about the rendition this test is watching: the drawing and
    # the plumbing are the same download, not two.
    asked = [
        re.search(r"/api/v1/media/([^/]+)/status", entry["name"]).group(1)
        for entry in ui.requests_matching(r"/api/v1/media/[^/]+/status", since=mark)
    ]
    assert variant_id in asked, (
        f"the page never asked about {variant_id}: it asked about {sorted(set(asked))} - "
        "this test would otherwise be comparing two different downloads"
    )

    api_download = [s for s in samples if s["api"]["stage"] == "download"]
    api_convert = [s for s in samples if s["api"]["stage"] == "convert"]
    bar_download = [s for s in samples if _kind(s["text"])[0] == "download"]
    bar_convert = [s for s in samples if _kind(s["text"])[0] == "convert"]

    # --- what the endpoint reports ------------------------------------------
    assert len(api_download) >= 4, (
        f"only {len(api_download)} download readings were sampled; the bar cannot be "
        f"judged against fewer\n{_table(samples)}"
    )
    assert api_convert, f"the conversion was never reported\n{_table(samples)}"

    totals = {s["api"]["totalBytes"] for s in api_download}
    assert totals == {DOWNLOAD_TOTAL}, _report(
        "the download's totalBytes", totals, f"{{{DOWNLOAD_TOTAL}}} (the provider's own source size)"
    )
    arrived = [s["api"]["bytes"] for s in api_download]
    assert arrived == sorted(arrived), _report("the download's bytes", arrived, "never decreasing")
    grew = [b for i, b in enumerate(arrived) if i == 0 or b != arrived[i - 1]]
    assert len(grew) >= 4 and all(b > a for a, b in zip(grew, grew[1:])), _report(
        "the download's bytes", grew, "at least four strictly growing readings"
    )
    assert max(arrived) == DOWNLOAD_TOTAL, _report(
        "the highest download reading", max(arrived), f"{DOWNLOAD_TOTAL} (the whole source)"
    )
    assert arrived[-1] >= 0.9 * DOWNLOAD_TOTAL, _report(
        "the last download reading", arrived[-1], f"at least 90% of {DOWNLOAD_TOTAL} bytes"
    )
    for sample in api_download:
        api = sample["api"]
        share = api["bytes"] / api["totalBytes"]
        assert abs((api["progress"] or 0) - share) < 0.02, _report(
            f"progress at {api['bytes']}/{api['totalBytes']} bytes", api["progress"], "the byte share"
        )
    convert_totals = {s["api"]["totalBytes"] for s in api_convert}
    assert convert_totals == {CONVERT_TOTAL_MS}, _report(
        "the conversion's totalBytes", convert_totals, f"{{{CONVERT_TOTAL_MS}}} (the song's own milliseconds)"
    )
    convert_steps = {s["api"]["bytes"] for s in api_convert}
    assert convert_steps <= {CONVERT_TOTAL_MS // 3, 2 * CONVERT_TOTAL_MS // 3, CONVERT_TOTAL_MS}, _report(
        "the conversion's milliseconds", sorted(convert_steps), "the provider's own three reports"
    )
    stages = [s["api"]["stage"] for s in samples if s["api"]["stage"]]
    assert stages.index("download") < stages.index("convert"), _report(
        "the stage order", stages, "download before convert"
    )
    assert samples[-1]["api"]["state"] == "ready", _report(
        "the last status", samples[-1]["api"], "a ready file"
    )

    # --- what the page draws ------------------------------------------------
    assert len(bar_download) >= 4, (
        f"the bar only ever said a downloading line in {len(bar_download)} samples\n{_table(samples)}"
    )
    for sample in bar_download:
        total = _kind(sample["text"])[2]
        assert abs(total - DOWNLOAD_TOTAL) / DOWNLOAD_TOTAL < 0.03, _report(
            "the bar's download total", total, f"~{DOWNLOAD_TOTAL} bytes in the bar's own rounding"
        )
    bar_bytes = [_kind(s["text"])[1] for s in bar_download]
    assert bar_bytes == sorted(bar_bytes), _report("the bar's byte figures", bar_bytes, "never decreasing")

    painted = [s["fill"] for s in bar_download if s["fill"] is not None]
    assert len(painted) >= 4, (
        f"the bar painted no fraction in {len(bar_download) - len(painted)} of its downloading "
        f"samples\n{_table(samples)}"
    )
    assert painted == sorted(painted), _report(
        "the painted fill while downloading", painted, "never decreasing within the stage"
    )
    moves = [f for i, f in enumerate(painted) if i == 0 or f != painted[i - 1]]
    assert len(moves) >= 4 and all(b > a for a, b in zip(moves, moves[1:])), _report(
        "the painted fill while downloading",
        moves,
        "at least four strictly growing values: the bar never sat still while bytes arrived",
    )
    assert max(painted) >= 90, _report("the highest painted fill while downloading", max(painted), "at least 90%")

    # The bar reached that far while the song was already playing: a streamed
    # song sounds within a second, and the fill is the download's own fraction,
    # not the song's position - which is the whole point of drawing it.
    assert bar_download[0]["streaming"], (
        "the element was not handed a stream when the song started: its src was "
        f"{bar_download[0]!r}\n{_table(samples)}"
    )
    assert all(s["streaming"] for s in bar_download), _report(
        "the kind of source on the element while the download was drawn",
        [("stream" if s["streaming"] else "file") for s in bar_download],
        "a stream throughout: the file is not here yet",
    )
    sounding = [s for s in bar_download if s["sounding"]]
    assert len(sounding) >= 4, (
        f"the song was only sounding in {len(sounding)} of the {len(bar_download)} samples where "
        f"the bar drew the download\n{_table(samples)}"
    )
    nearly = [s for s in sounding if s["api"]["bytes"] >= 0.9 * DOWNLOAD_TOTAL]
    assert nearly, (
        "the song was never sounding while the download was nearly finished: the bar would have "
        f"been describing a wait nobody was having\n{_table(samples)}"
    )
    assert all(s["api"]["state"] != "ready" for s in nearly), _report(
        "the status at those samples", [s["api"]["state"] for s in nearly], "still arriving"
    )

    # The conversion is its own count: the bar says its percent, paints exactly
    # that, and is not left showing the fetched file's 100%.
    assert bar_convert, f"the bar never said what the conversion was doing\n{_table(samples)}"
    for sample in bar_convert:
        percent = _kind(sample["text"])[1]
        assert sample["fill"] == percent, _report(
            f"the fill while converting {percent}%", sample["fill"], f"the conversion's own {percent}%"
        )
    assert min(_kind(s["text"])[1] for s in bar_convert) < 100, (
        "every converting sample read 100%: the fill was left at the fraction the download "
        f"ended on\n{_table(samples)}"
    )

    # While the bar cannot count - no report has named a stage and a total yet -
    # it must sweep rather than claim a fraction. A 0% fill over a download that
    # is already moving is a number the page does not have.
    uncounted = [s for s in samples if s["text"].endswith("downloading…")]
    assert uncounted, (
        f"the bar never showed its uncounted wording, so nothing was checked there\n{_table(samples)}"
    )
    for sample in uncounted:
        assert sample["fill"] is None, _report(
            f"the fill while the bar said {sample['text']!r}", f"{sample['fill']}%", "no fraction (a sweep)"
        )

    # --- the end of the story ----------------------------------------------
    ui.wait(
        lambda: not (ui.js(BAR_JS) or {}).get("shown"),
        "the progress element never hid once the file was here",
    )
    wait_sounding(ui, TITLE, SONG_SECONDS)
    assert_clock_moves(ui, TITLE)
    ui.assert_no_errors("watching a download in the bar")