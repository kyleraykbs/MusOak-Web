# TODO

## The reliability audit's findings (2026-10-15)

Sniffed for slow or unstable loading. Frontend and this repo's server; the
backend's own three are in the other repo's TODO.

- [x] `web/js/offline.js`: one IndexedDB connection for the page, not one per
      read and write, closed on `versionchange`.
- [x] `web/js/offline.js`: a song's transfer carries its own deadline, so a
      connection that goes quiet frees its slot in the download queue.
- [x] `web/js/app.js`: `/ui/config` is fetched with a deadline, so a proxy that
      never answers cannot leave the first visit blank.
- [x] `web/sw.js`: a range answer reads the copy only when there is something to
      cut out of it - the whole-song range and a window past the end cost
      nothing - and the `clone()` that teed a second copy of the song is gone.
- [x] `web/sw.js`: `keepShell` asks for the shell the ordinary way, so what it
      keeps is what the load ran and never a stale HTTP-cache entry.
- [x] `internal/web/server.go`: the shared dialer has a timeout and the
      transport has `ResponseHeaderTimeout`, so a black-holed backend becomes a
      failure instead of a spin.
- [x] `internal/web/server.go`: a compressible asset is packed once per
      revision and served with its length.

## The download pipeline, centralized (2026-10-16)

One download per song, and its row in the queue is where it shows (see
DECISIONS.md, same date). Left open by it:

- [ ] `web/js/player.js`: `readMedia` has no fraction when the media response
      states no `Content-Length`, so that song's mark sweeps for the whole
      transfer. Everything this backend serves carries a length today.
- [ ] `web/js/player.js`: the mark's fill restarts at the server-stage →
      transfer boundary (`offlineProgress` reports one count at a time). A
      blended count would need the two stages' totals to be comparable, which
      they are not in general (the provider's source and the stored file differ).
- [ ] `web/js/player.js`: `_awaitCopy` bounds its wait at `READY_TIMEOUT_MS`
      (60 s) and reports a failure; the fetch it was waiting on keeps running
      and is dropped by the entry identity check when the retry replaces it.

## Medium and low findings, not yet done

- [ ] `web/js/app.js`: the current view is refetched every 30 s whether the
      notifications payload changed or not.
- [ ] `web/js/views/friend.js`: the listen-along poll is a fixed 2 s with no
      backoff and no stop after repeated failures.
- [ ] `web/js/offline.js`: `syncOne` replaces a variant id without deleting the
      superseded media-cache key.
- [ ] `web/js/app.js`: the `visualViewport` handlers write `style.height` on
      every event rather than once a frame.
- [ ] `web/js/state.js`: the localStorage server/icon maps are never pruned and
      a quota failure is swallowed.
- [ ] `web/sw.js`: the shell cache is keyed by full URL and never pruned.
- [ ] `internal/web/server.go`: one strong ETag is sent for the gzip and the
      identity representation of the same asset.
## Open on the phone, 2026-10-19

The lock screen kept its card through a changeover in the unit tests, but the
card itself can only be watched on a device (Firefox has no media session, and
headless has no notification). Kyle to check on Android Chrome:

- [ ] A queue of songs with the screen off: the card stays through the change,
      and the next song starts by itself.
- [ ] If it still drops across a *long* wait (a room changeover, where the next
      file is fetched at the advance rather than ahead of it), the fix is the
      documented workaround: a second, silent element played and paused
      synchronously at the changeover to hold the session open. Its cost: the
      notification then describes the silent player, so metadata and position
      have to be set on the session explicitly.
