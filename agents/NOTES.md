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