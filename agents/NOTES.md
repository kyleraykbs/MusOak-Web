# Notes

## The player has one audio element, and it plays the page's own copy

`player.audio` is the element everything reads (the bar, the position, the
room), named `data-e2e="audio"`. There is no second element: a song used to be
streamed from the server and handed over to a spare when the page's copy of it
landed mid-song, and both the stream and the hand-over are gone. The download is
one thing per song - the entry in `player._offline` - and `_load` waits for it and
then hands the element the copy in memory, so nothing is ever fetched twice. The
copy's state and its own count are what the queue's mark on the row is drawn from
(`player.offlineState` / `player.offlineProgress`).

## The playback e2e scenarios need a signed-in browser

`signed_in` in `conftest.py` registers the account over the API only. A scenario
that opens the Playlists tab or plays a song must call
`sign_in_ui(ui, signed_in)` first, or the page is a guest: the tab says "Sign
in", nothing saves on reload, and the restore scenario has nothing to restore.

## Temporary traces have to be errors

`harness.py` records the console's *errors* (Firefox's driver log), and
`ui.assert_no_errors()` fails a test that printed anything else. A temporary
`console.log` is therefore invisible in the failure artifact; use `console.error`
while tracing and remove it before committing.
## The media session dies with the element, and the phone is the only place that shows it

A phone's lock screen is `navigator.mediaSession`, and Chrome destroys a page's
session when the media element's source changes and playback does not start
immediately after. The notification, the Bluetooth transport buttons and the
lock screen's scrubber all go with it, and they do not come back until some
element on the page plays again. Two consequences worth keeping in mind:

- **A hidden tab that is not playing audio is throttled and frozen.** MDN's
  wording is the whole reason the retry logic has to be structured the way it
  is: "Tabs which are playing audio are considered foreground and aren't
  throttled." Chrome's intensive throttling takes a hidden page to one timer a
  minute, and Android may freeze it outright - so a recovery that rides a
  `setInterval` (the player's 4 s `_wantResume` retry) cannot be the only path
  back from a failed start. It is a backstop; sound must never have stopped in
  the first place.
- **`visibilitychange` is the only wake-up a frozen page is sure to get**, and
  on a locked phone that fires when the screen comes back. That is why a stall
  reads as "it plays when I unlock".

`play()` refused because the page is hidden is indistinguishable in the element's
own state from a listener's pause: `paused === true`, `currentTime === 0`, a
source still assigned. Anything that keys off "paused with a source at zero"
(watchdogs, "is it stuck" heuristics) will fire on that state, and the honest
signals to gate on are the player's intent (`_playingWanted`), `_loading`, and
`_blocked`.

Nothing in the Firefox e2e suite can see any of this: Firefox has no media
session, so a green run says the queue still advances, never that the card
stayed. The phone is the instrument.
