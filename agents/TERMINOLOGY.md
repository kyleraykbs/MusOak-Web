# Terminology

user term → code/file/concept it maps to

- "the side queue" / "the side queue system" → the queue panel: the Queue page and
  the playbar's drawer (`views/queue.js`), and the page's own download pipeline
  they display (`player._offline`). "Downloads" in his vocabulary are those device
  copies, not the backend's fetch of a provider's file.
- "the green diamond" → the `diamond` icon in `dom.js`, drawn by `heldBadge` for a
  song whose copy is in memory; "the download icon" is the `download` glyph beside
  it, filled by `--fill` while the copy is on its way.
- "phony" → a placeholder rather than a measured number (his word for what a
  loading indicator may show when nothing countable is known).