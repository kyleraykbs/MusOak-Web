// The address of a song in this app: what the share menu's link copies, and
// what the page reads back when somebody opens it.
//
// A query rather than a path because the page is served for any route a static
// file does not claim: `?track=` needs nothing from the web server and survives
// a deployment that serves the app from a subdirectory.

/** The shareable address of one track, based on `base` (a page URL). */
export function trackLink(trackId, base) {
  const id = String(trackId || "").trim();
  if (!id) return "";
  try {
    const url = new URL(base || location.href);
    url.searchParams.set("track", id);
    return url.href;
  } catch {
    return "";
  }
}

/** The track a page URL names, or "" when it names none. */
export function linkedTrackId(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return "";
  }
  // The ids the server serves are UUIDs; anything else is not worth a request.
  const id = String(url.searchParams.get("track") || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "";
}