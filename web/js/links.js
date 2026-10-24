// The addresses a share menu offers: this app's own pages, and the page each
// matched platform keeps for the same song, album or artist.
//
// This app's links are a query - `?track=`, `?album=`, `?artist=` - because the
// page is served for any route a static file does not claim: a query needs
// nothing from the web server and survives a deployment under a subdirectory.

const KINDS = ["track", "album", "artist"];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The address of one item in this app, based on `base` (a page URL). */
export function itemLink(kind, id, base) {
  if (!KINDS.includes(kind)) return "";
  const value = String(id || "").trim();
  if (!value) return "";
  try {
    const url = new URL(base || location.href);
    // A page can already name another item - a song shared from its album's
    // page - and a link names exactly one. Other parameters (a server) stay.
    for (const other of KINDS) {
      if (other !== kind) url.searchParams.delete(other);
    }
    url.searchParams.set(kind, value);
    return url.href;
  } catch {
    return "";
  }
}

/** The item a page URL names, or null when it names none (or a malformed id). */
export function linkedItem(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  for (const kind of KINDS) {
    if (!url.searchParams.has(kind)) continue;
    const id = String(url.searchParams.get(kind) || "").trim();
    return ID.test(id) ? { kind, id } : null;
  }
  return null;
}

/** What a platform is called where a person reads it. */
export function platformName(provider) {
  switch (String(provider || "").toLowerCase()) {
    case "ytmusic":
      return "YouTube Music";
    case "youtube":
      return "YouTube";
    case "spotify":
      return "Spotify";
    default:
      return String(provider || "");
  }
}

/**
 * The public page of one provider's rendition, or "" when the platform has no
 * page for that kind of thing - a local file lives nowhere else, and plain
 * YouTube has videos rather than albums or artist pages.
 */
export function platformLink(provider, kind, id) {
  const value = String(id || "").trim();
  if (!value || !KINDS.includes(kind)) return "";
  const suffix = encodeURIComponent(value);
  switch (String(provider || "").toLowerCase()) {
    case "spotify":
      return `https://open.spotify.com/${kind}/${suffix}`;
    case "ytmusic":
      if (kind === "track") return `https://music.youtube.com/watch?v=${suffix}`;
      if (kind === "album") return `https://music.youtube.com/browse/${suffix}`;
      return `https://music.youtube.com/channel/${suffix}`;
    case "youtube":
      return kind === "track" ? `https://www.youtube.com/watch?v=${suffix}` : "";
    default:
      return "";
  }
}

/**
 * The platforms a track, album or artist has been matched with, in the order
 * the renditions arrived, each with the page its rendition lives on.
 *
 * One entry per platform: a track can hold two renditions from the same place,
 * and two links to the same song on the same platform is not a choice.
 */
export function platformLinks(kind, variants = []) {
  const out = [];
  const seen = new Set();
  for (const variant of variants || []) {
    const provider = String(variant?.provider || "");
    if (!provider || seen.has(provider)) continue;
    const id =
      kind === "track"
        ? variant.providerTrackId
        : kind === "album"
          ? variant.providerAlbumId
          : variant.providerArtistId;
    const url = platformLink(provider, kind, id);
    if (!url) continue;
    seen.add(provider);
    out.push({ provider, label: platformName(provider), url });
  }
  return out;
}