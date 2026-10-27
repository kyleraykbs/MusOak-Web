
## 2026-10-27 Artist catalogue UI

The artist API now returns a complete, newest-first album list plus catalogue progress and a searchable/paged song endpoint. The web artist page renders two independently scrollable panels: Albums and Songs. Opening an artist starts a background provider read; the status is polled and the panels refresh as releases land. Singles are hidden as individual release rows and collected into the top `Singles` row, which uses `icon-64.png`. Album GETs complete the tracklist server-side, so the old visible Sync controls and client-side sync fallback are gone.
