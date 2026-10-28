
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
