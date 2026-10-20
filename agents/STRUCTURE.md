# Structure

This repo is the web side of MusOak: the browser app, the tiny server that
serves it, and the browser suite that drives both. The music API is a different
repo (`../musoak`), reached through the proxy below.

## Binaries

- `cmd/musoak-web` - the only binary here. Serves the frontend from `web/`,
  serves the pages, and proxies the API and the event stream to a backend.

## `internal/web`

- `server.go` - the frontend server: asset stamping (a content digest in the
  URL query), gzip, ETag/`Last-Modified` answers, and the reverse proxy.
  Live mode (`--web-dir DIR`) serves a checkout instead of the embedded copy.
- `proxy.go` - the API proxy: everything under the API prefix goes to the
  backend, so the page and the API share one origin.

## `web/js` - the app (browser ES modules, no build step)

- `app.js` - boot, layout, view routing, the notification poll.
- `player.js` - the audio engine: the queue, the one element, the page's own
  copies (which are what plays - a song is downloaded once and handed to the
  element), the queue's download marks, save/restore of playback. A track change
  stops the song and never takes its source off the element: the page's media
  session (the phone's lock screen, and its exemption from background throttling)
  lives on that element, and an emptied one loses it.
- `client.js` - the REST + event-stream client, session, in-flight dedupe.
- `state.js` - the localStorage session and navigation state.
- `offline.js` - IndexedDB store of kept songs, their download queue and sync.
- `sw.js` - the service worker: the shell cache, and the range answers that play
  a kept song with no server.
- `rooms-state.js`, `rooms/playback.js` - listen-along state and the room's
  playback clock.
- `dom.js`, `platforms.js`, `importer.js`, `views/*.js` - helpers, the platform
  list, the file importer, and one module per screen.

## `e2e` - the browser suite

Real Firefox, the real `musoakd` (built from `../musoak`) and the real
`musoak-web` on free ports with a temporary store. `servers.py` starts them,
`harness.py` is the Selenium driver (`ui`), `conftest.py` the fixtures
(`backend`, `ui`, `signed_in`), `rooms_helpers.py` the listen-along helpers, and
`test_*.py` the scenarios. `flake.nix` wires the tools into `nix run .#e2e`.

## `web/js/tests`

Node's own runner (`node --test`) over the pure functions: no DOM, no server.