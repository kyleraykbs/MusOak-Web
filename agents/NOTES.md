# Notes

## The player has two audio elements, and one of them is "in hand"

`player.audio` is the element everything reads (the bar, the position, the
room). `player._spare` is a second, hidden element the hand-over brings the next
source up on, so the switch is the spare's play rather than a source change on
the element in hand. `data-e2e="audio"` / `"audio-spare"` follow them through
`_adoptCopy`, so browser tests can read the one in hand. The suite's playback
tests assert complete-file downloads; provider streaming is not part of playback.

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