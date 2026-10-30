"""Shared ground for the journey tests: a person, a library, and a queue.

The seam files each build their own fixture because each seam is different.
Journeys are not: they all start with somebody signed in, a few songs with
distinct lengths, and a list to play them from - so that lives here once.
"""

from __future__ import annotations

import uuid

PASSWORD = "correct horse battery staple"


class Person:
    """An account with its own songs, their titles, and their lengths."""

    def __init__(self, username, token, tracks, lengths):
        self.username = username
        self.password = PASSWORD
        self.token = token
        self.tracks = tracks
        self.titles = [track["track"]["title"] for track in tracks]
        self.lengths = list(lengths)

    def seconds(self, title):
        return self.lengths[self.titles.index(title)]

    def track_id(self, title):
        return self.tracks[self.titles.index(title)]["trackId"]


def person(backend, media_factory, prefix, lengths=(4, 5, 6, 7), *, favourite=True):
    """A registered account holding one tone per length, starred by default.

    Distinct lengths are the point: the element's own duration is what says
    *which* song is playing, so no bar label can make a skip look like a pass.
    Starring them puts them on Favourites, which is a list with its own Play,
    Shuffle and Queue - a person's way into their own library.
    """
    username = f"{prefix}-{uuid.uuid4().hex[:6]}"
    token = backend.register(username, PASSWORD)
    tracks = [
        media_factory.import_track(
            token,
            title=f"{prefix} {index + 1} {username[-4:]}",
            seconds=seconds,
            frequency=330 + 40 * index,
        )
        for index, seconds in enumerate(lengths)
    ]
    if favourite:
        for track in tracks:
            status, payload = backend.post("/api/v1/me/favorites", {"trackId": track["trackId"]}, token=token)
            assert status in (200, 201, 204), f"favouriting {track['trackId']} answered {status}: {payload!r}"
    return Person(username, token, tracks, lengths)


# --- the page ---------------------------------------------------------------


def open_favourites(ui, expected):
    """The Favourites list, with `expected` rows drawn."""
    ui.click_tab("Favourites")
    ui.wait(
        lambda: len(ui.js("return [...document.querySelectorAll('.content .row .title')].map((el) => el.textContent.trim());") or []) >= expected,
        f"the favourites list never drew {expected} songs",
        timeout=20,
    )
    return titles(ui)


def titles(ui):
    """The song titles on the page, in the order they are drawn."""
    return ui.js("return [...document.querySelectorAll('.content .row .title')].map((el) => el.textContent.trim());")


def queue_titles(ui):
    """The queue's *upcoming* songs, in order.

    The page draws the songs still to come, numbered, and then the song that is
    playing, unnumbered, at the end. A drag or a removal is about the numbered
    rows - moving the playing song is a different thing - so this answers those.
    """
    return ui.js("""
        return [...document.querySelectorAll('.content .page .list .row')]
          .filter((row) => (row.querySelector('.time')?.textContent || '').trim())
          .map((row) => row.querySelector('.title')?.textContent.trim());
    """)


def open_queue(ui):
    ui.click_tab("Queue")
    ui.wait(lambda: ui.count(".content .page .list .row") >= 0 or None, "the queue never opened", timeout=15)
    return ui


def press(ui, label, scope=".favourites-actions"):
    """A list's own Play / Shuffle / Queue button, by its exact label.

    Scoped on purpose: the tab strip has a button named "Queue" too, and an
    unscoped XPath clicks the tab instead of the list's control - which reads
    as "the queue never filled" rather than as a selector that found the wrong
    thing.
    """
    ui.click_xpath(
        f"//*[contains(@class,{scope.strip(chr(46))!r})]//button[normalize-space(.)={label!r}]",
        f"the {label!r} button",
    )


def press_bar(ui, title):
    ui.click(f".player-bar button[title={title!r}]")


def sounding(ui):
    """The element's reading while it is running a song, or None."""
    state = ui.player()
    if not state or state.get("paused") or state.get("ended"):
        return None
    if (state.get("currentTime") or 0) <= 0.05 or (state.get("duration") or 0) <= 0:
        return None
    return state


def drag_row(ui, source_title, target_title):
    """Drag the row named `source_title` onto the row named `target_title`.

    Rows are found by their title, not by their position in the list: the queue
    page draws the upcoming songs (numbered) and then the song playing
    (unnumbered) at the end, so `:last-child` is the song being heard, not the
    last of the queue - which is exactly the row a person does not mean.
    """
    moved = ui.js_async(
        """
        const rows = [...document.querySelectorAll('.content .page .list .row')];
        const named = (title) => rows.find((row) => (row.querySelector('.title')?.textContent || '').trim() === title);
        const source = named(arguments[0]);
        const target = named(arguments[1]);
        if (!source || !target) return false;
        const grip = source.querySelector('.drag-handle') || source;
        const from = grip.getBoundingClientRect();
        const to = target.getBoundingClientRect();
        const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
        // A little into the target row: the row under the pointer is the drop.
        const end = { x: to.x + to.width / 2, y: to.y + Math.min(8, to.height / 2) };
        const send = (node, type, point) => node.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, composed: true,
          pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
          clientX: point.x, clientY: point.y,
        }));
        send(grip, 'pointerdown', start);
        send(document, 'pointermove', { x: start.x + 10, y: start.y + 6 });
        send(document, 'pointermove', end);
        send(document, 'pointerup', end);
        return true;
        """,
        source_title,
        target_title,
    )
    assert moved, f"could not drag {source_title!r} onto {target_title!r}"
    return ui
