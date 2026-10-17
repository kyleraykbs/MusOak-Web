# Decisions

## 2026-10-15 The hand-over reads play intent, not the element's paused flag
- Decision: `player._wantsSound()` (`_playingWanted || audio.paused === false`)
  is what `_handOverTo`'s callers pass as "was paused", and the paused branch
  stops the element it leaves.
- Why: `audio.paused` alone is still true between a play press and the element
  actually starting, so a hand-over landing in that window adopted a paused
  element and left the sounding one behind - the bar naming silence.
- Reversible: yes.

## 2026-10-15 The e2e runner adds `./e2e` only when no file is named
- Decision: the flake app passes `./e2e` when no `*.py`/`*::*` argument is
  present, instead of always passing it beside whatever was named.
- Why: `pytest ./e2e e2e/test_rooms.py` collects the whole suite, so the
  README's "one file" invocation ran everything.
- Reversible: yes.

## 2026-10-15 One IndexedDB connection, closed on a version change
- Decision: `offline.js` memoises the `indexedDB.open` promise and clears it on
  `versionchange`/`close`/error.
- Why: a connection per read and write leaked them, and a later schema upgrade
  would have been blocked by whichever was still open.
- Reversible: yes.

## 2026-10-15 A song's transfer has its own deadline (5 minutes)
- Decision: `fetchSongBytes` aborts a kept-song download after
  `DOWNLOAD_TIMEOUT_MS`, alongside the caller's own signal.
- Why: `READY_TIMEOUT_MS` only covered the wait for the server, so a transfer
  that stalled held its slot in the download queue for the session. Five
  minutes, because a song over a slow line is slow rather than stuck.
- Reversible: yes (the constant is one line).

## 2026-10-15 `/ui/config` is fetched with a 5 s deadline
- Decision: `loadConfig` aborts the request after `CONFIG_TIMEOUT_MS` and falls
  back to the stored answer or the defaults.
- Why: the page cannot be laid out without this answer on a first visit, and
  the page itself had already arrived from the same origin, so an answer slower
  than this is a request that is hanging.
- Reversible: yes.

## 2026-10-15 `keepShell` stopped forcing the HTTP cache
- Decision: the shell files are fetched with no `cache` option, so an entry the
  browser still trusts costs nothing and a stale one is revalidated.
- Why: `force-cache` takes a stored entry even when it is stale, which is how
  the shell could hold a module from an older load beside this load's own. It
  had been chosen to stop a second download, and it did - by accepting bytes
  that might not be the ones running.
- Reversible: yes (the e2e `test_caching.py` covers what a reload costs).

## 2026-10-15 A range answer reads the copy only when it has to slice
- Decision: `fromCache` takes the size from the stored `Content-Length`, hands
  the cached response back untouched for a `bytes=0-` request, answers `416`
  without reading, and drops the `clone()` before `blob()`.
- Why: the clone teed the body, holding a second copy of the whole song while
  the answer was handed over. The remaining read for a real seek is linear but
  bounded to one song, which the player's own offline budget already allows.
- Reversible: yes.

## 2026-10-15 A background pass leaves a rendition the store has already failed
- Decision: `prefetch.Media` gains `Failed`, and `pass` skips those variants; a failure is paced like a fetch (the same gap), and the pass reports how many it skipped.
- Why: measured on the live server (the log, over an hour): a pass every ~10 minutes, each running the full retry ladder - three attempts with an exponential wait, then `media download failed` - for renditions already known to be unavailable, several seconds each. That is the box's own load, and it is what a listener's request queues behind. `Ensure` is unchanged: a person who presses play is worth the attempt.
- Reversible: yes (one method on the interface, one check in the pass).

## 2026-10-15 The resolve says which kind of "no source" it means
- Decision: `MatchTrackSource` tracks whether any provider offered a candidate above the threshold, and logs "no provider had a candidate" (with the title) rather than pointing at a duplicate track when none was ever found.
- Why: the hint sent a reader to look for duplicate tracks that were not there. The log is the only place this is visible, so a wrong hint costs more than it saves.
- Reversible: yes.

## 2026-10-15 A song the client cannot play is retried on a growing wait
- Decision: the room's per-item resolve backoff doubles per try, 5 s to 5 min.
- Why: a song whose source the server cannot find was asked for again every five seconds for ever, and each ask is a provider round trip on the server. A few quick tries cover a provider having a bad minute; after that, one ask every five minutes is enough, and the status line stops repeating itself.
- Reversible: yes (one constant and one map).

## 2026-10-15 One position, applied by every source change
- Decision: the song's position is never derived from a comparison of `src`
  strings (`_streamOffsetMs` reads the recorded stream), and every hand-over onto
  a source that carries no `?start=` leaves the position pending on the element
  (`_waitForFile`'s whole-file case sets `_pendingSeek` from the position it
  captured *before* letting the stream go).
- Why: a picked-up song played from the beginning. The position lived in three
  places - the URL's `?start=`, `_pendingSeek`, and `_streamOffsetMs() + clock` -
  and either of the last two could be empty when a source was handed over, with
  nothing left to seek the element. The `src` comparison also read as "no offset
  at all" after a redirect or a proxy resolved the URL differently, which zeroed
  the *saved* position too, so the next pick-up genuinely restored the top.
- Also: the e2e position assertion now reads the element's clock exactly when the
  element holds a whole source. `max(element clock, provider offset)` is what hid
  this: a file playing from the top passed whenever the provider had been asked
  for the position.
- Reversible: yes.

## 2026-10-16 The queue's own download is what plays, and its row is where it shows
- Decision: one download per song. The song being played is an entry in the same
  pipeline as the songs behind it (`player._offline`), at play priority and for
  the rendition the load chose; the load waits for those bytes and hands the
  element the copy in memory, so nothing is streamed from the server beside it.
  The queue's mark on the song's own row is the only place a download is drawn:
  the green diamond once the copy is here, the download arrow filled with yellow
  as the bytes arrive (a sweep when nothing can be counted). The playbar's own
  loader and byte numbers are gone; its subtitle says "downloading…" and no more.
- Why: Kyle asked for downloads to be handled entirely by the side queue,
  including the song playing, with no double download and with the sound starting
  only once the queue's download is done. The bar's own bar had never used the
  counts it was handed (`_setProgress` tracked a fraction nothing drew), and the
  one-pipeline rule deletes the whole mid-song hand-over the second transfer
  existed for: `_swapToOffline`, `_handOverTo`, `_adoptLate`, the spare element,
  `_whenPlayable`, `_loadCopy`, `_moveOntoTarget`, the fade, `_hidden`,
  `_elementUrl` and their constants.
- Cost, named: the first sound now waits for this page's whole transfer of the
  song rather than starting while the server's file is streamed. The bytes are
  the same as before (the playing song was going to get a copy once it was in the
  window) but they no longer arrive during playback. A room is unaffected: its
  next songs are copied while the previous one plays.
- Reversible: yes - the window filter in `_prefetch` and `_awaitCopy`.

## 2026-10-16 The preload count is songs, and one download runs at a time
- Decision: the device setting is `preloadAhead` - how many songs *after* the one
  playing this page fetches ahead of the playhead, 5 by default - and it is the
  window: `prefetchWindow(queue, index, preloadAhead())`, which the copy pipeline
  and the room's warm-ahead both use. Downloads run one at a time, always: the
  shared slot queue is `DOWNLOAD_CONCURRENCY = 1`, the copy pump starts the next
  song only when the one before it is here, and `_prefetch` no longer fires a
  parallel `warm` for each song in the window (a copy fetches the file it needs
  as part of making the copy). The eager/tail split, the 15 s tail pacing and the
  "All songs at a time" option are gone.
- Why: Kyle's rule - "only download 1 song at a time, no multi-download at once" -
  and the option was always meant to be "the number of songs ahead we preload",
  not a concurrency limit (he had read it as the latter and it was the cause of
  the queue's noise). Five transfers at once buy nothing on one line; they put
  the song somebody is waiting on behind four others.
- Also: the ceiling is the deployment's. The web server's config carries
  `preloadMax` (default 15, hard ceiling 50), serves it in `/ui/config`, and the
  account page's number box with step buttons stops there. The server owns it
  because it owns the cost: preloading is bandwidth and disk on the machine that
  serves the queue.
- Supersedes this file's 2026-10-16 note that "the device download selector also
  supports All, while the shared download queue enforces the selected limit".
- Reversible: yes.

## 2026-10-16 The queue's mark fills only on the transfer that is happening
- Decision: `heldBadge` draws the yellow ink on one row: the song nearest the
  playhead whose copy is being fetched (`player.downloading` - in flight, and the
  first of the window's in-flight songs), filled by its own count and sweeping
  when nothing can be counted. The window behind it is chased two at a time, so a
  second transfer runs quietly and its row stays grey. A copy that is queued behind
  another - pending, but not in flight - is a plain grey arrow. A finished copy is
  the green diamond. `_startOffline` announces the moment a fetch starts, so a row
  that becomes the active one does not wait for its first status report to say so.
- Why: Kyle's rule - "only one download icon should do the yellow progress thing
  (the actively downloading one) the rest should just be gray". Every pending row
  sweeping at once is a list of arrows that says nothing about which song is being
  waited on, and six of them animating is noise. The pipeline already knows the
  difference; the mark just had not been asked.
- Reversible: yes (one predicate in `markState`).

## 2026-10-16 The queue drawer opens centred on the playing row
- Decision: a fresh draw of the playbar's drawer (`renderQueue(..., {compact})`)
  scrolls the playing row to the panel's middle with `scrollIntoView({block:
  "center"})`. Rows carry `data-playing="true"` so the row is findable in the DOM.
  Only a fresh draw does it: a repaint - a copy landing, a download reporting -
  never moves the list. The Queue *page* does not do it (it is a page a person is
  already reading; the drawer is what pops up over it).
- Why: a queue of any length opens at the top, and the row worth finding is the
  one that is playing - which, picking a session back up, can be sixteen rows
  down. Centred rather than at the top so the songs on both sides of it are in
  view.
- Reversible: yes.

## 2026-10-16 `tapOnly` returns the prop names `h()` attaches
- Decision: `tapOnly` answers `{onpointerdown, onclick}` instead of
  `{pointerdown, click}`.
- Why: `h()` attaches a listener only for a key that starts with `on`; a bare
  `click` prop was written as an attribute, so the queue row's handler had never
  run - clicking a row did not jump in the queue, and the guard against a scroll
  being read as a tap was guarding nothing. Found while writing the drawer test,
  which needed a row click to move the playing row and got row 8 for row 16
  (the driver kept aiming at rows that never reacted). The unit test now pins the
  names, which is what would have caught it.
- Reversible: yes.

## 2026-10-15 A late source does not reset the element that is playing
- Decision: `_handOverTo` only moves the element in hand onto a new source when
  that source is playable, or when nothing is playing. A source that is not ready
  in time is taken up by `_adoptLate` when it can be played, at the position the
  music has reached by then.
- Why: `FILE_READY_TIMEOUT_MS` is 4 s, and over a network a file does not always
  get there in 4 s. The old fallback reset the element in hand onto it anyway -
  the stream dropped and buffered again, which is the song stopping and loading
  again a remote listener reports - while the stream that was already sounding
  was the better thing to keep.
- Reversible: yes.
- Superseded 2026-10-16: there is no second source to hand over to any more - the
  copy of the song *is* what plays (see the entry above), so nothing adopts a
  source late.

## 2026-10-15 The song on the element is not one of the copies kept in memory
- Decision: `_prefetch`'s window for the page's own copies excludes the track the
  element is on.
- Why: it is already whole (the file the hand-over takes up) or streaming, so its
  copy was a whole song's transfer over the same link the listener is listening
  on, and one more source change when it landed. Over a network that is the
  largest avoidable cost in the start of a song, and the copies exist for the
  songs behind it, which have no file yet.
- Reversible: yes (the window is one filter).
- Also: `keepOffline` gets `offlineWindow()` minus the playing track, and the two
  unit tests that pinned the old sequence were updated to the new one - they
  asserted which songs get copies and in what order, which is the contract that
  changed (their intent, eager then paced, is unchanged).
- Superseded 2026-10-16: the playing track is one of the copies again, at the
  front of the window, because its copy is now what plays (see the entry above).
  The extra transfer is not extra: it is the only transfer, and the sound waits
  for it.

## 2026-10-15 A compressible asset is packed once, and carries `Content-Length`
- Decision: `assetEntry` holds the gzipped bytes, packed on the first request
  that takes gzip; `serveAsset` writes them with `Vary: Accept-Encoding` and the
  length. The page keeps its per-request `gzipWriter`.
- Why: the frontend is nearly a megabyte of JavaScript and every request
  compressed the same bytes again. The length is known once the bytes are
  packed, so the response is not left chunked.
- Reversible: yes.
- Note: one strong ETag still covers both representations (`agents/TODO.md`
  keeps that finding open). Changing it costs a re-download for any client whose
  `Accept-Encoding` changes, which is a worse trade than the theoretical risk.

## 2026-10-15 Playback waits for a stored file, and an unsourced room song asks the listener
- Decision: provider streaming is removed. The player resolves a variant, starts its download, waits for the file, then assigns the stored media URL and applies the in-file seek. If a room cannot resolve a source, the shell opens Find a source with the song prefilled; selecting a result associates it, retries immediately, and the dialogue closes when the room advances.
- Why: the provider stream added an unknown-length, unseekable second path and competed with the download. A stored file is durable and seekable. A room with no source needs a human association rather than a five-second retry loop with no explanation.
- Reversible: no for streaming; yes for the dialogue.

## 2026-10-16 Decimal ratings, explicit room auto-skip, and bounded downloads
- Decision: the favorite star opens a 0.1-step 0.1–5.0 rating slider; a saved rating is shown numerically and as partially filled stars, and a room submits it once when its item starts. Auto-skip is a visible opt-in room checkbox. The device download selector also supports All, while the shared download queue enforces the selected limit.
- Why: binary favorites lost useful preference information, automatic low-rating skips are disruptive unless requested, and displaying a concurrency setting without applying it made the server run more downloads than the user selected. Provider status polling now drives the visible progress label directly.
- Reversible: yes.

## 2026-10-16 Shared async states and artwork loading
- Decision: views use one persistent page container, shared loading blocks, stable artwork tiles with asynchronous decoding and failure fallback, consistent focus outlines, and common panel/row spacing.
- Why: navigation was visually jumpy because the shell was cleared before each view answered, loading states differed by view, and artwork implementations duplicated broken-image and lazy-loading behavior. The change improves cohesion without changing view contracts or backend calls.
- Reversible: yes.

## 2026-10-16 Navigation surfaces are isolated and mobile panels are bottom sheets
- Decision: navigation keeps one shell but gives each route a fresh surface, so late async responses cannot paint into a later page. Mobile dialogs use bottom-sheet geometry and safe-area padding; room positions use shared icons instead of text glyphs.
- Why: persistent view nodes made stale responses and page transitions visually inconsistent, while desktop-centered dialogs and glyph symbols were awkward on phones and dependent on font rendering.
- Reversible: yes.