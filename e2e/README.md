# The browser suite

Real Firefox, the real server, the real web UI, and a person's actions. Nothing
here is stubbed: `e2e/` starts `musoakd` (from the sibling checkout) and
`musoak-web` (from this one) on free ports with a temporary storage directory,
and drives them through Selenium.

It exists because the frontend's own tests are pure functions with no DOM and no
server, and because the things that go wrong in this app go wrong in the seams:
a service worker that re-downloads the app, a room whose two clients disagree
about the order, a song that reports "loading" forever while the clock says it
is playing.

## Running it

```sh
# Everything: the flake app wires Firefox, geckodriver, Selenium, ffmpeg and Go.
nix run .#e2e

# One file, or one test, with a browser you can watch:
nix run .#e2e -- e2e/test_rooms.py
nix run .#e2e -- --headful -k "skip" -x

# Against a specific server build (the default is to build ../musoak):
nix run .#e2e -- --musoakd /path/to/musoakd
```

Without `nix run`, the same thing by hand:

```sh
nix shell --impure --expr 'let p = (builtins.getFlake "nixpkgs").legacyPackages.x86_64-linux;
  in [ p.firefox p.geckodriver p.ffmpeg p.go (p.python3.withPackages (ps: [ ps.selenium ps.pytest ])) ]' \
  -c python3 -m pytest e2e -c e2e/pytest.ini
```

The run prints what it is testing before it starts:

```
--- what this run tests
    musoakd    /tmp/.../bin/musoakd (19556147 bytes, built 2026-08-14T21:18:16)   [go build ./cmd/musoakd in ../musoak]
    musoak     eb5c925
    musoak-web /tmp/.../bin/musoak-web (11490881 bytes, built 2026-08-14T21:18:17)   [go build ./cmd/musoak-web in this checkout]
    web        f994b16 + working changes
```

A run that tested something other than the tree beside it says so, because the
alternative - a green suite against last week's binary - is worse than a red
one.

Options: `--musoakd PATH`, `--musoak-web PATH`, `--frontend DIR` (serve a
different frontend), `--artifacts DIR`, `--headful`, `--keep-servers`.

## What a failure gives you

Every failing test writes to `e2e/artifacts/` (or `--artifacts`): a screenshot,
the page's HTML, the console, the audio element's reading, the whole Resource
Timing table, and the geckodriver log. The test output names them. A browser
failure without those is a guess.

## Writing a test

```python
def test_the_next_song_starts_without_a_wait(ui, signed_in):
    ui.goto("/")
    ui.click_tab("Queue")           # tabs are named by their label
    ui.click("[title='Next']")      # controls are named by what a person sees
    ui.wait_player(
        lambda state: state if state["currentTime"] > 0.2 else None,
        "the next song never started",
    )
```

Rules the suite keeps, and a new test should keep:

- **No sleeps for synchronisation.** `ui.wait(predicate, "message")`,
  `ui.wait_css`, `ui.wait_text`, `ui.wait_js`, `ui.wait_player`, `ui.wait_quiet`,
  and the fixtures' own waits are all predicates with a deadline; a failure reads
  as a sentence and dumps the page. Wall-clock time is only *measured*, never
  waited on.
- **Selectors are CSS or XPath.** Either spelling; an XPath starts with `/` or
  `xpath:`. Prefer what a person sees (`button[title='Next']`, a tab's label) to
  a class that a restyle may rename.
- **Assert on the app, not on its labels.** The audio element's own fields
  (`ui.player()`) are the truth about what is playing; the bar is what the app
  *says*, and the difference between the two has been a bug twice.
- **Every test ends with `ui.assert_no_errors()`.** The console must be clean,
  and the harness's own self-check (`test_smoke.py`) proves the collector is
  live, so a clean console is evidence rather than silence.
- **Marks**: `@pytest.mark.slow` for anything over a few seconds,
  `@pytest.mark.browsers` for anything needing more than one browser session.
- **One browser per test.** `ui` is a fresh session (a fresh person, a fresh
  service worker, a fresh queue); `host` and `guest` are two of them for rooms.
  The two servers are shared for the whole run, so a test that needs a different
  server (an offline one, a different config) must build its own fixture.

## Fixtures

| fixture | what it is |
| --- | --- |
| `backend` | a `musoakd` on a free port, temp storage, every provider off, rate limits off |
| `frontend` | a `musoak-web` in front of it, serving `web/` from this checkout |
| `ui` | one Firefox session, fresh per test |
| `host`, `guest` | two Firefox sessions, for rooms |
| `signed_in` | a registered account with three local tracks, made through the API |
| `media_factory` | `tone(...)` files made on the spot with ffmpeg, `import_track(token, ...)` into the library |

Providers are off in the suite's config, so nothing here reaches YouTube or
Spotify and a track that plays is a file on disk. `signed_in` exists so a
playback test does not spend its first ten steps on a registration form;
`test_library.py` drives the real form, and `test_smoke.py` proves both.