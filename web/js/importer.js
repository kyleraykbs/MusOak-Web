// Copying a playlist from another MusOak backend onto this one.
//
// The two backends share no ids: a song is matched by what it is called and who
// it is by, the way the GTK client does it. Matching here is strict about the
// song's identity — a remix, a live take, or a different artist's song of the
// same name is a different song — but lenient about the packaging providers
// bolt onto titles ("(Official Video)", "- Remastered", "feat. …"). Where the
// two disagree the copy is honest about it: songs with no counterpart are
// skipped and counted.

// Packaging that providers append to a title without changing which song it is.
const DECORATION = /^(?:official\s+)?(?:music\s+)?(?:video|audio|lyric(?:\s+video)?|lyrics|visuali[sz]er|mv|m\/v|hd|hq|4k|1080p|remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?)$/i;

// The tail of a title that credits a guest without changing the song.
const FEATURE = /^(?:feat|ft|featuring)\.?\s/i;

/**
 * The words of a title with the decorations providers wrap around it removed,
 * spacing kept: "(Official Video)" and "- Remastered 2011" vanish while "live"
 * and "remix" stay. This is the shape to search with.
 */
function cleanTitle(raw) {
  let title = String(raw === null || raw === undefined ? "" : raw);

  // Bracketed asides: drop the ones that are packaging, keep the rest's words.
  title = title.replace(/[([{]([^)\]}]*)[)\]}]/g, (_whole, inner) => {
    const body = String(inner).trim();
    if (!body || FEATURE.test(body) || DECORATION.test(body)) return " ";
    return ` ${body} `;
  });

  // A trailing " - Remastered" and friends are decoration; " - Part 2" is not.
  const segments = title.split(/\s+[-\u2013\u2014]\s+/);
  while (segments.length > 1 && DECORATION.test(segments[segments.length - 1].trim())) segments.pop();
  title = segments.join(" ");

  // "Song feat. Someone" outside brackets.
  title = title.replace(/\s+(?:feat|ft|featuring)\.?\s+.*$/i, " ");

  return title.replace(/\s+/g, " ").trim();
}

/**
 * The letters and digits of a title, with the decorations providers wrap around
 * it removed. Two songs are the same song only when these keys are equal, so
 * "(Official Video)" and "- Remastered 2011" vanish while "live" and "remix"
 * stay and keep those takes apart.
 */
export function normalizeTitle(raw) {
  return cleanTitle(raw).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The artists a track credits, as lower-case names. */
function artistNames(track) {
  const raw = track?.artists;
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined || raw === "" ? [] : [raw];
  return list
    .map((entry) => (entry && typeof entry === "object" ? entry.name : entry))
    .map((name) => String(name === null || name === undefined ? "" : name).trim().toLowerCase())
    .filter(Boolean);
}

/** How close two lengths are, 1 when within a few seconds and 0 when far. */
function durationScore(a, b) {
  const left = Number(a?.durationMs) || 0;
  const right = Number(b?.durationMs) || 0;
  if (left <= 0 || right <= 0) return 1; // unknown lengths never split a match
  const delta = Math.abs(left - right);
  if (delta <= 5000) return 1;
  if (delta >= 20000) return 0;
  return 1 - (delta - 5000) / 15000;
}

/** How many artists two tracks share, 0 when they share none. */
function artistOverlap(a, b) {
  const left = new Set(artistNames(a));
  const right = new Set(artistNames(b));
  if (!left.size || !right.size) return 1; // one side says nothing: do not split
  let shared = 0;
  for (const name of left) if (right.has(name)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** A candidate scoring at least this is the same song. */
const MATCH_THRESHOLD = 0.6;

/**
 * How sure one track is the same song as another, 0 when it cannot be: a title
 * that differs once the packaging is gone is 0, and so are two tracks of the
 * same name by artists who share nothing. Otherwise the artists' agreement sets
 * the score and a length within a few seconds breaks close calls.
 */
export function matchScore(a, b) {
  const wanted = normalizeTitle(a?.title);
  const candidate = normalizeTitle(b?.title);
  if (!wanted || !candidate || wanted !== candidate) return 0;

  const overlap = artistOverlap(a, b);
  if (overlap === 0) return 0;

  return 0.6 + 0.25 * overlap + 0.15 * durationScore(a, b);
}

/**
 * The counterpart each provider track has among the candidates, aligned by
 * index. An entry is the matched candidate's id, or "" when the target server
 * has no version of that song.
 */
export function matchTracks(providerTracks, candidates) {
  const pool = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  return (Array.isArray(providerTracks) ? providerTracks : []).map((track) => {
    let best = "";
    let bestScore = MATCH_THRESHOLD;
    for (const candidate of pool) {
      const score = matchScore(track, candidate);
      if (score >= bestScore && score > 0) {
        bestScore = score;
        best = String(candidate?.id ?? "");
      }
    }
    return best;
  });
}

/** The artists of a track as the search line the GTK client sends. */
function artistLine(track) {
  const names = artistNames(track);
  if (!names.length) return "Unknown artist";
  return Array.isArray(track?.artists)
    ? track.artists.map((name) => String(name).trim()).filter(Boolean).join(", ")
    : String(track.artists).trim();
}

/** The searches to try for one track, most precise first. */
function searchQueries(track) {
  const queries = [];
  const clean = cleanTitle(track?.title);
  if (clean) queries.push(clean);
  const raw = String(track?.title ?? "").trim();
  if (raw && raw !== clean) queries.push(raw);
  const artist = artistLine(track);
  if (artist && artist !== "Unknown artist") queries.push(artist);
  return queries;
}

/**
 * The target's counterpart of one track, or "". Searches by title first and
 * only falls back to the artist (a backend often cannot satisfy a title+artist
 * phrase), letting matchScore decide which hit, if any, is the same song.
 */
async function findOnTarget(to, track) {
  for (const query of searchQueries(track)) {
    let candidates = [];
    try {
      const result = await to.search(query, 5);
      candidates = (result?.groups || []).map((group) => group?.track).filter(Boolean);
    } catch {
      candidates = []; // a search that fails is a song left behind, not a stopped copy
    }
    const [found] = matchTracks([track], candidates);
    if (found) return found;
  }
  return "";
}

async function sourceTracks(from, playlistId) {
  try {
    return await from.syncPlaylist(playlistId);
  } catch (error) {
    // A playlist of the source's own is not a provider playlist; its tracks are
    // already canonical there, so read it directly.
    if (error?.status === 401) throw error;
    return from.playlist(playlistId);
  }
}

/**
 * Copy one playlist across, song by song: pull its tracks onto the source, find
 * each one's counterpart on the target by searching for its title (falling back
 * to its artist), then build a playlist of the matches there.
 *
 * `onProgress` is called once per source track with the position, the running
 * match/skip counts and the track just looked at. The promise resolves with the
 * new playlist's id and how many songs matched and were left behind.
 */
export async function copyPlaylist({ from, to, providerPlaylist, onProgress } = {}) {
  if (!from || !to) throw new Error("copying a playlist needs a source and a target server");

  const playlistId = String(providerPlaylist?.id ?? "");
  if (!playlistId) throw new Error("no playlist to copy");

  const synced = await sourceTracks(from, playlistId);
  const tracks = (synced?.tracks || []).filter(Boolean);
  const total = tracks.length;

  const matched = [];
  let looked = 0;
  for (const track of tracks) {
    const found = await findOnTarget(to, track);
    if (found) matched.push(found);
    looked += 1;
    onProgress?.({
      position: looked,
      total,
      matched: matched.length,
      skipped: looked - matched.length,
      track,
    });
  }

  const name =
    String(providerPlaylist?.name ?? providerPlaylist?.title ?? "").trim() ||
    String(synced?.playlist?.name ?? synced?.playlist?.title ?? "").trim() ||
    "Imported playlist";

  const created = await to.createPlaylist(name);
  const playlist = created?.playlist || created || {};
  const playlistIdOnTarget = String(playlist.id ?? created?.id ?? "");
  if (matched.length && playlistIdOnTarget) await to.addToPlaylist(playlistIdOnTarget, matched);

  return {
    name: String(playlist.name ?? name),
    playlistId: playlistIdOnTarget,
    matched: matched.length,
    skipped: total - matched.length,
    total,
  };
}
