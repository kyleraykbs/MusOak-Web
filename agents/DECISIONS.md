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