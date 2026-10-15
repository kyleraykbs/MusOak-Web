"""The rooms suite's own helpers: two members, one room, and the readings.

This is not a second harness. `harness.py` drives one browser and `conftest.py`
makes the browsers; this file is about the *room*: who is in it, what the server
says its play order is, what each page draws of it, and what a page asks the
network for while it does. Anything only one test needs stays in that test.

The rule the whole file is built around: **the server decides the play order**
(`masterQueue` on `GET /api/v1/rooms/{id}`), and a page may only *render* it. So
every order assertion reads both - the API and the DOM - and compares them,
rather than working out in Python what the order ought to be.
"""

from __future__ import annotations

import json
import re
import time
import uuid

import harness
from conftest import sign_in_ui

#: One password for every account in the suite; the strength rules have their
#: own test, and a room test that fails on a password rule is testing the wrong
#: thing.
PASSWORD = "correct horse battery staple"


# --- accounts ---------------------------------------------------------------


class Member:
    """One room member: an account, its token, and the tracks it can queue."""

    def __init__(self, username, password, token, tracks):
        self.username = username
        self.password = password
        self.token = token
        self.tracks = tracks

    def track_ids(self):
        return [track["trackId"] for track in self.tracks]


def make_member(backend, media_factory, prefix="member", tracks=2, seconds=30):
    """A registered account with its own local tracks, made through the API.

    Tracks are tones of a chosen length: the room's clock and a member's
    playback are both measured, so a track shorter than the assertion reading it
    would have the room advance in the middle of a test.
    """
    username = f"{prefix}-{uuid.uuid4().hex[:8]}"
    token = backend.register(username, PASSWORD)
    made = [
        media_factory.import_track(
            token,
            title=f"{prefix} {index + 1} {username[-4:]}",
            seconds=seconds,
            frequency=440 + index * 110,
        )
        for index in range(tracks)
    ]
    # Starred, so the member has a screen of its own songs to play from: the
    # Favourites list is a person's way into this account's library, and playing
    # from it is what queues into a room (see `queue_favourites`).
    favourite(backend, token, [track["trackId"] for track in made])
    return Member(username, PASSWORD, token, made)


def favourite(backend, token, track_ids):
    """Star tracks through the account's own endpoint."""
    for track_id in track_ids:
        status, payload = backend.post("/api/v1/me/favorites", {"trackId": track_id}, token=token)
        assert status in (200, 201, 204), f"favouriting {track_id} answered {status}: {payload!r}"


# --- the API's truth --------------------------------------------------------


def api_room(backend, room_id, token=""):
    """The room as the server has it, which is the only play order there is."""
    status, payload = backend.get(f"/api/v1/rooms/{room_id}", token=token)
    assert status == 200, f"GET /api/v1/rooms/{room_id} answered {status}: {payload!r}"
    room = payload.get("room") if isinstance(payload, dict) else None
    return room or payload


def current_item(room):
    return ((room or {}).get("current") or {}).get("item") or {}


def item_ids(room):
    """Everything the room holds, in its own order: the song on, then the order."""
    items = [current_item(room)] if current_item(room) else []
    items += list((room or {}).get("masterQueue") or [])
    return [item.get("id") for item in items]


def member_id(room, username):
    for member in (room or {}).get("members") or []:
        if member.get("name") == username:
            return member.get("id")
    return ""


# --- plain waits ------------------------------------------------------------


def wait_for(check, message, timeout=15.0, interval=0.05):
    """Poll a callable of the *server's* state until it is truthy, or fail."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = check()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"{message}\n  after {timeout:.1f}s the last reading was {last!r}")


def observe(ui, seconds, message):
    """Sit still for a measured window.

    This is a measurement, not a sleep for synchronisation: a negative assertion
    ("the room did *not* skip") can only be made by watching the room over a
    window and finding it unchanged, and the window has to be real. Everything
    that *waits for* something uses `ui.wait*` instead.
    """
    deadline = time.monotonic() + seconds
    ui.wait(lambda: time.monotonic() >= deadline, message, timeout=seconds + 10, interval=0.02)


def counts_of(entries):
    """What a page asked for, by the shape of the request.

    `resolve` is the one that names the other half of the reported overload: a
    player that re-resolved a rendition and reloaded it on every state change
    spends requests here (and on `media`), and one that does not leaves this at
    zero.
    """
    return {
        "total": len(entries),
        "media": len(match(entries, r"/api/v1/media/")),
        "media-status": len(match(entries, r"/media/[^/]+/status")),
        "resolve": len(match(entries, r"/api/v1/(tracks|sources|variants)(/|\?|$)")),
        "room-commands": len(match(entries, r"/rooms/[^/]+/(skip|pause|resume|seek|vote)")),
        "room-reads": len(match(entries, r"/api/v1/rooms")),
        "writes": len([entry for entry in entries if entry.get("type") in {"fetch", "xmlhttprequest"}]),
    }


def match(entries, pattern):
    rx = re.compile(pattern)
    return [entry for entry in entries if rx.search(entry["name"] or "")]


class Window:
    """A stretch of one page's network timeline, measured from a mark."""

    def __init__(self, ui, seconds):
        self.ui = ui
        self.seconds = seconds
        self.mark = ui.mark()
        self.started = time.monotonic()

    def close(self):
        """Let the window finish and hand back every request it carried."""
        deadline = self.started + self.seconds
        self.ui.wait(
            lambda: time.monotonic() >= deadline,
            f"the {self.seconds:.1f}s network window never closed",
            timeout=self.seconds + 10,
            interval=0.02,
        )
        return self.ui.resources(self.mark)


# --- the page's view --------------------------------------------------------

LISTENING_ROWS_JS = """
const card = [...document.querySelectorAll(".card")].find((node) => {
  const title = node.querySelector(".section-title");
  return title && title.textContent.trim() === "Listening";
});
if (!card) return null;
return [...card.querySelectorAll(".list > .row")].map((row) => ({
  name: ((row.querySelector(".title") || {}).textContent || "").trim(),
  marks: ((row.querySelector(".subtitle") || {}).textContent || "").trim(),
}));
"""


def listening_rows(ui):
    """Who the page says is listening, and what it says about them."""
    return ui.js(LISTENING_ROWS_JS) or []


def listening_names(ui):
    return sorted(row["name"] for row in listening_rows(ui))


ROOM_ROWS_JS = """
const panel = document.querySelector(".queue-panel[data-panel='room']");
if (!panel) return null;
return [...panel.querySelectorAll(".list > .row")].map((row) => {
  const title = row.querySelector(".title");
  const time = row.querySelector(".time");
  return {
    key: (row.dataset && row.dataset.key) || "",
    title: title ? title.textContent.trim() : "",
    time: time ? time.textContent.trim() : "",
    now: row.classList.contains("now"),
  };
});
"""


def room_rows(ui):
    """The room's own column: what the page draws as the order to come.

    The first row is the song on (the app puts it back on top of the column and
    marks it, since the server's order holds only what is yet to come), and the
    rest must be the server's `masterQueue`, item for item.
    """
    return ui.js(ROOM_ROWS_JS) or []


VOTES_JS = """
const buttons = [...document.querySelectorAll("button")].filter((button) =>
  /^[1-5] · /.test(button.getAttribute("title") || ""));
const mine = buttons.find((button) => button.classList.contains("suggested"));
const summary = [...document.querySelectorAll(".subtitle")]
  .map((node) => node.textContent.trim())
  .find((text) => text.startsWith("mean ")) || "";
return { mine: mine ? mine.getAttribute("title") : "", summary: summary };
"""


def votes_view(ui):
    """What the room view says about the votes: your own, and the tally."""
    value = ui.js(VOTES_JS)
    return value or {"mine": "", "summary": ""}


def playing_now(ui):
    """The room view's own 'Playing now' reading: the title it draws."""
    return ui.js(
        "const card = [...document.querySelectorAll('.card')].find((node) => {"
        "  const title = node.querySelector('.section-title');"
        "  return title && title.textContent.trim() === 'Playing now';"
        "});"
        "if (!card) return null;"
        "const title = card.querySelector('.title');"
        "return {title: title ? title.textContent.trim() : '',"
        "  lines: [...card.querySelectorAll('.subtitle')].map((n) => n.textContent.trim())};"
    )


# --- getting there ----------------------------------------------------------


def wait_room_view(ui, name, timeout=20.0):
    """This page is the room's page: the queue column is drawn, for this room."""
    ui.wait_js(
        "Boolean(document.querySelector('.room-queue'))"
        f" && document.body.textContent.includes({json.dumps(name)})",
        f"{ui.name} never showed the room view for {name!r}",
        timeout,
    )
    return ui


def create_room(ui, name):
    """Open a room in this browser, the way a person does."""
    ui.goto("/")
    ui.click_tab("Rooms")
    ui.type("input[placeholder='New room name']", name)
    ui.click_text("Create", css="button")
    room_id = ui.wait(
        lambda: ((ui.storage() or {}).get("room") or {}).get("roomId") or "",
        f"creating {name!r} never left a room in this session",
    )
    wait_room_view(ui, name)
    return room_id


def join_room(ui, name):
    """Join a room from the rooms list, the way a person does."""
    ui.goto("/")
    ui.click_tab("Rooms")
    row = (
        "//div[contains(@class,'list')]//div[contains(@class,'row')]"
        f"[.//div[contains(@class,'title')][contains(., {json.dumps(name)})]]"
    )
    ui.wait_xpath(row, f"{name!r} never appeared in the rooms list")
    ui.click_xpath(row + "//button[contains(@title, 'Join')]", f"Join {name!r}")
    wait_room_view(ui, name)
    return ui


def wait_members(ui, backend, room_id, token, names, message, timeout=20.0):
    """Wait until the API and the page agree about who is listening."""
    wanted = sorted(names)

    def check():
        room = api_room(backend, room_id, token)
        if sorted(member.get("name") or "" for member in room.get("members") or []) != wanted:
            return None
        if listening_names(ui) != wanted:
            return None
        return room

    return ui.wait(check, message, timeout)


def assert_listening(ui, room, where=""):
    """The page's Listening panel is exactly the server's member list."""
    expected = sorted(member.get("name") or "" for member in (room or {}).get("members") or [])
    got = listening_names(ui)
    assert got == expected, (
        f"{where}the Listening panel and the room disagree: page {got!r}, server {expected!r}\n"
        f"  page rows: {listening_rows(ui)!r}"
    )
    return got


def in_room_mode(ui, room_id, timeout=15.0):
    """Wait until this page's player is under the room's orders.

    The bar grows a chip naming the room exactly while the player is following
    one, and it is the only reading of "songs played here go to the room" that
    does not reach into the app's modules. The room takes the player over from
    its follow tick, a moment after the join, so a song played before the chip
    appears would have gone into the local player instead.
    """
    ui.wait(
        lambda: ui.has(f".player-bar button[data-room='{room_id}']"),
        f"{ui.name} never put its player under the room's orders (no room chip in the player bar)",
        timeout,
    )
    return ui


# --- queueing ---------------------------------------------------------------
#
# Queueing is a *click* here, never a call into one of the app's modules.
#
# Not because a module call would be impolite: a page-side `import('/js/…')`
# re-instantiates the app's whole module graph in this browser. Measured, with
# the built app in front of the real service worker: one `import('/js/player.js')`
# fetched `/js/player.js`, `/js/rooms-state.js` and `/js/app.js` a second time
# and ran `boot()` again - the account, the room and the queue were replaced by a
# second app instance's empty ones, and the second instance's `<audio>` is what
# the harness would then have been measuring. So the suite drives the app the way
# a person does, and reads the DOM and the API.

def queue_favourites(ui, room_name):
    """Put this member's whole list in the room the way a person does.

    While a room is followed, a list's own header offers *Queue* - "Add these
    tracks to the room queue" - and that is the control for a list. Clicking a
    song's row is deliberately something else: it puts that song on and nothing
    else (`playOne`: "a list of songs is a menu of them, not a set to adopt, and
    a click that quietly takes the whole playlist makes every later choice a
    position in a list nobody asked to be in"). A test that wants a member's
    whole turn in the room therefore clicks the list's own button, not a row -
    and a member with one track of their own still gets one item, which is what
    the turn order is measured in.

    The member is put back on the room's own page before this returns: playing
    from Favourites means *being* on Favourites, and everything after this in a
    test reads the room the member is looking at.
    """
    ui.click_tab("Favourites")
    row = (
        "//div[contains(@class,'list')]//div[contains(@class,'row')]"
        "[contains(@class,'clickable')][.//div[contains(@class,'title')]]"
    )
    ui.wait_xpath(row, f"{ui.name}'s favourites never appeared")
    ui.click_xpath(
        "//button[@title='Add these tracks to the room queue']",
        "the list's Queue button",
    )
    ui.click_tab("Rooms")
    wait_room_view(ui, room_name)
    return ui


def seed_room_queue(backend, room_id, token, track_ids):
    """Put a run of tracks on a member's room queue, in one edit.

    This is the room's own endpoint - the same request the app makes, with the
    same batch semantics - used directly where a test needs a *long* queue and
    spending a minute clicking would only be testing the clicking.
    """
    status, payload = backend.post(f"/api/v1/rooms/{room_id}/queue", {"trackIds": list(track_ids)}, token=token)
    assert status == 200, f"seeding the room's queue answered {status}: {payload!r}"
    return payload


def wait_queue_size(ui, backend, room_id, token, size, message, timeout=20.0):
    """Wait until the room holds `size` items in total (the song on included)."""

    def check():
        room = api_room(backend, room_id, token)
        return room if len(item_ids(room)) == size else None

    return ui.wait(check, message, timeout)


def wait_playing(ui, backend, room_id, token, message, timeout=25.0):
    """Wait until the room has a song on and this member's element runs it."""

    def check():
        room = api_room(backend, room_id, token)
        current = room.get("current") or {}
        if not current.get("item") or not current.get("started"):
            return None
        state = ui.player()
        if not state or state.get("paused") or (state.get("currentTime") or 0) <= 0.2:
            return None
        return {"room": room, "player": state}

    return ui.wait(check, message, timeout)


# --- the order, the page versus the server ----------------------------------


def wait_order_matches(ui, backend, room_id, token, message, timeout=15.0):
    """Wait until the page's room column equals the server's order, or say why.

    The comparison is exact and positional: the song on first (the row the app
    marks), then `masterQueue` item for item. A page drawing any other order - a
    join-order round robin, the order its members queued them, last week's
    snapshot - is the divergence this suite exists to catch, so a timeout here
    is reported as that difference rather than as a wait.
    """
    last = {}

    def check():
        room = api_room(backend, room_id, token)
        rows = room_rows(ui)
        last["room"] = room
        last["rows"] = rows
        if rows is None:
            return None
        return room if [row.get("key") for row in rows] == item_ids(room) else None

    try:
        return ui.wait(check, message, timeout)
    except harness.WaitTimeout as error:
        raise AssertionError(
            order_failure(message, last.get("room") or {}, last.get("rows") or [])
        ) from error


def order_failure(message, room, rows):
    def spelled(ids, titles):
        return ", ".join(f"{titles.get(i) or '?'} ({str(i)[:8]})" for i in ids)

    titles = {item.get("id"): item.get("title") or "" for item in _all_items(room)}
    page_titles = {row.get("key"): row.get("title") or "" for row in rows}
    return (
        f"{message}\n"
        f"  the server's order: {spelled(item_ids(room), titles)}\n"
        f"  the page's order:   {spelled([row.get('key') for row in rows], page_titles)}"
    )


def _all_items(room):
    items = [current_item(room)] if current_item(room) else []
    items += list((room or {}).get("masterQueue") or [])
    return items


def assert_order_matches(ui, room, where=""):
    """The same comparison, once, with the difference spelled out."""
    rows = room_rows(ui) or []
    want = item_ids(room)
    got = [row.get("key") for row in rows]
    assert got == want, order_failure(f"{where}the page's order is not the server's:", room, rows)
    return rows


# --- the scene --------------------------------------------------------------


class Scene:
    """Two members, each with its own browser, together in one room."""

    def __init__(self, host, guest, backend, host_member, guest_member, room_id, name):
        self.host = host
        self.guest = guest
        self.backend = backend
        self.host_member = host_member
        self.guest_member = guest_member
        self.room_id = room_id
        self.name = name

    def room(self, token=""):
        """The room as the server has it. The host's token signs the call."""
        return api_room(self.backend, self.room_id, token or self.host_member.token)

    def order(self):
        return item_ids(self.room())

    def names(self):
        return [self.host_member.username, self.guest_member.username]

    def who(self, username):
        return member_id(self.room(), username)


def open_scene(host, guest, backend, media_factory, *, host_tracks=2, guest_tracks=2, seconds=30, name=None):
    """Sign two people in, open a room in one, join it from the other."""
    host_member = make_member(backend, media_factory, prefix="host", tracks=host_tracks, seconds=seconds)
    guest_member = make_member(backend, media_factory, prefix="guest", tracks=guest_tracks, seconds=seconds)
    sign_in_ui(host, host_member)
    sign_in_ui(guest, guest_member)

    room_name = name or f"room-{uuid.uuid4().hex[:6]}"
    room_id = create_room(host, room_name)
    # A room is only a room with somebody else in it: the guest is in before any
    # assertion is made, and both pages have said so.
    join_room(guest, room_name)
    scene = Scene(host, guest, backend, host_member, guest_member, room_id, room_name)
    names = scene.names()
    wait_members(host, backend, room_id, host_member.token, names, "the host never saw the guest arrive")
    wait_members(guest, backend, room_id, host_member.token, names, "the guest never saw both of them in the room")
    # Both pages have the room's player: from here a song played anywhere in the
    # app is a song queued for the room, which is what every test below assumes.
    in_room_mode(host, room_id)
    in_room_mode(guest, room_id)
    for ui in (host, guest):
        ui.assert_no_errors(f"{ui.name} while joining {room_name!r}")
    return scene