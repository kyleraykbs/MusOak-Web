
## 2026-10-27 Artist catalogue UI

The artist API now returns a complete, newest-first album list plus catalogue progress and a searchable/paged song endpoint. The web artist page renders two independently scrollable panels: Albums and Songs. Opening an artist starts a background provider read; the status is polled and the panels refresh as releases land. Singles are hidden as individual release rows and collected into the top `Singles` row, which uses `icon-64.png`. Album GETs complete the tracklist server-side, so the old visible Sync controls and client-side sync fallback are gone.

## 2026-10-27 The phone's card needs a player, not a word

`navigator.mediaSession.playbackState` is page-authored: Chrome does not derive
it from the element, so a page that never sets it reads "none" while a song
plays (measured in helium over CDP). What Chrome *does* derive is the session's
existence - it destroys a page's media session when no player in it is playing -
and that is the lock screen's card, the Bluetooth transport, and the page's
standing as a tab that is playing, which is what keeps a backgrounded phone from
throttling or freezing it. So `playbackState = "playing"` alone holds nothing;
something has to be playing at the moment the real element is not.

`_holdSession()` is that something: a detached `<audio>` with a generated tenth
of a second of silence, played and paused inside one task (`silenceWav` builds
the WAV; 8-bit PCM silence is 0x80, not zero). Detached on purpose - the e2e
harness reads `document.querySelectorAll('audio')` and treats the first
non-paused element with a source as "what the browser is playing", and a page's
list of its own elements should not grow a decoy. Unmuted on purpose: a muted
element is not "playing audio" to the browser, and a held card the browser
thinks is silent buys nothing.

Firefox has no media session, so nothing in the e2e suite can see any of this;
a green run says the queue still advances, never that the card stayed.

## 2026-10-27 `appendChild` takes one node, and a spread hides it

`sheet.appendChild(...playButtons(tracks))` on the album page appended the first
button and silently dropped the other three - `appendChild` is single-argument,
so the rest were ignored rather than throwing. The album page offered Play and
no Shuffle, Queue or Shuffle Queue, and nothing in the console said so. Use
`append(...nodes)` or wrap them in a container (`h("div", { class: "form-row" },
...playButtons(tracks))`, which is what the playlist page does). The one
occurrence in the tree was found by grepping `appendChild(\.\.\.`.

Worth remembering when chasing a phone report: a service worker holding the old
shell serves the cached module on the next load and only revalidates behind it,
so a fix can look absent until the SW and Cache Storage are cleared for the
origin. That cost a wrong turn here - the DOM showed the old markup after a fix
that was already live.

## 2026-10-27 Gecko 2056444, reproduced here and fixed in the player

LibreWolf 152.0.6-1 on this box, the bug's own repro page
(`vincent0700.github.io/firefox-arraybuffer-blob-video-repro`): the element sits
at `networkState=1 readyState=0 duration=NaN` with no error. Then the same
thing with musoak's own bytes: a real 12 MB Opus file, fetched, `new
Blob([arrayBuffer])`, `src`, `currentTime = 60`, `play()` - the **async script
never returned**; the read blocks the content process's main thread. The same
file through `Response.blob()` played and sought (`currentTime` 63.88 after
4s, duration 763.654). An 871 KB Opus from chunks did *not* hang, so a small
file is not a repro; real songs are.

The player's `readMedia` built `new Blob(chunks)` - the hanging path - and every
load that starts part way in seeks right after the source lands. `readMedia` now
returns `response.clone().blob()` and takes its progress count from the original
body; the clone is the response's own blob factory, which is the path the bug
report names as working.

A tab already wedged before that fix has a dead element and no browser-side way
out, so `sourceStalled` (pure, player.js) classifies two shapes: "unloadable"
(`readyState 0`, `networkState 0/1`, no duration, 5 s since the source was
assigned) and "frozen" (clock claims playing, has not moved for 3 s). The retry
tick escalates a `blob:` source through: replace the element, re-fetch the copy
with `Response.blob()`, then the backend's own URL - a network resource, which
the bug never touched. One turn each, stage reset by `playing` and by a new
source. A kept playlist's `/api/v1/media/...` URL is not escalated: the service
worker answers it, and a slow response there is not this bug. An element with
`error` set is left to the error handler.

Verified in LibreWolf 152 headless against a scratch `musoakd` + `musoak-web`
(this checkout, `-web-dir web`) with the real 12 MB variant: `readMedia` gave a
12,547,880-byte `audio/ogg` blob, progress ended at the full length, seek to 60
then play reached 63.88 s with `readyState 4` and no error.

## 2026-10-29 `Response.clone()` tees the body; a pre-clone reference is locked

```js
const body = response.body;          // the tee's SOURCE in Chromium
const made = response.clone().blob(); // tees it
body.getReader();                     // throws: already locked to a reader
```

Chromium (and node's undici, which is why a plain node test can pin it) locks
the stream that was in hand before `clone()`, and `response.body` afterwards is a
different, readable branch. `readMedia` did it in the wrong order for a day and
every song failed to arrive: `_fetchOffline` stored the error, `_awaitCopy` took
the failure road, and the queue skipped through itself one song at a time - the
"never plays, rapid fire" report. The Firefox browser suite cannot see it (Gecko
tolerates the stale reference), so a regression test has to use a real `Response`
and a real stream - the older test faked `clone()` and was blind to the tee.

Debug route worth keeping: a CDP-attached tab can be read in its MAIN world with
`page.target().createCDPSession()` + `Runtime.evaluate`, and `import("/js/player.js")`
there returns the same `player` singleton the app uses. `tab.run`'s own
`page.evaluate` is an isolated world and shows `window` as the app never sees it -
which had me chasing a phantom earlier.
