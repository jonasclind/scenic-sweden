/* Saved spots: a small store in the browser, and a way to put it in a link.
 *
 * There is no account behind this and no server. The site is a gigabyte of
 * static payloads on a CDN, so a login would mean adding a database for it to
 * write to - and that database would be the one part of the app that stops
 * working in a valley with no signal, which is exactly where the list is
 * wanted. The share link does the job an account would have done: it carries
 * the whole list, so moving spots from the laptop to the phone is one paste.
 */

const STORE_KEY = 'scenic.favourites.v1';
const SHARE_PARAM = 'f';

/** Coordinates rounded to ~1 m, which is both the identity and the dedupe. */
export const favouriteId = (lat, lon) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/* Every localStorage access is guarded. A private window, blocked site data or
 * a full quota all throw rather than returning empty, and a saved-spots list is
 * not worth taking the page down for. */
export function loadFavourites() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isSpot) : [];
  } catch {
    return [];
  }
}

export function saveFavourites(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

const isSpot = s => s && Number.isFinite(s.lat) && Number.isFinite(s.lon);

/** Adds unless the same 1 m square is already saved; newest first. */
export function withFavourite(list, spot) {
  if (!isSpot(spot)) return list;
  const id = favouriteId(spot.lat, spot.lon);
  if (list.some(s => favouriteId(s.lat, s.lon) === id)) return list;
  return [{ lat: spot.lat, lon: spot.lon, name: spot.name || '' }, ...list];
}

export function withoutFavourite(list, id) {
  return list.filter(s => favouriteId(s.lat, s.lon) !== id);
}

export function renameFavourite(list, id, name) {
  return list.map(s =>
    favouriteId(s.lat, s.lon) === id ? { ...s, name } : s);
}

/* Spots from a link are appended, never interleaved, so opening someone else's
 * list cannot reorder or displace your own. Returns the count as well, because
 * "nothing happened" and "you already had all five" look identical otherwise. */
export function mergeFavourites(existing, incoming) {
  const known = new Set(existing.map(s => favouriteId(s.lat, s.lon)));
  const added = [];
  for (const spot of incoming) {
    if (!isSpot(spot)) continue;
    const id = favouriteId(spot.lat, spot.lon);
    if (known.has(id)) continue;
    known.add(id);
    added.push({ lat: spot.lat, lon: spot.lon, name: spot.name || '' });
  }
  return { list: [...existing, ...added], added: added.length };
}

/* ------------------------------------------------------------------ sharing */

/* Tuples rather than objects in the payload: with twenty unnamed spots it is
 * the difference between a link that fits in a message and one that does not,
 * and gzip cannot recover the repeated key names entirely. */
const toTuples = list => list.map(s => [
  +s.lat.toFixed(5), +s.lon.toFixed(5), s.name || '']);
const fromTuples = rows => (Array.isArray(rows) ? rows : [])
  .map(([lat, lon, name]) => ({ lat: +lat, lon: +lon, name: name || '' }))
  .filter(isSpot);

function toBase64Url(bytes) {
  let binary = '';
  // Chunked: String.fromCharCode(...bytes) overflows the argument stack once a
  // list gets long, and it would do it only for the people with most to lose.
  for (let i = 0; i < bytes.length; i += 4096)
    binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - padded.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function through(stream, bytes) {
  return new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** The list as a URL fragment value. Gzipped when the browser can, raw when it
 *  cannot; the reader tells them apart by the gzip magic bytes. */
export async function encodeShare(list) {
  const json = new TextEncoder().encode(JSON.stringify(toTuples(list)));
  if (typeof CompressionStream === 'undefined') return toBase64Url(json);
  const zipped = await through(new CompressionStream('gzip'), json);
  // Below about a dozen spots the gzip header costs more than it saves.
  return toBase64Url(zipped.length < json.length ? zipped : json);
}

export async function decodeShare(text) {
  try {
    let bytes = fromBase64Url(text);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') return [];
      bytes = await through(new DecompressionStream('gzip'), bytes);
    }
    return fromTuples(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return [];                        // a mangled link is not worth an error
  }
}

export async function shareUrl(list, base = location.href) {
  const url = new URL(base);
  url.hash = `${SHARE_PARAM}=${await encodeShare(list)}`;
  return url.toString();
}

/** Spots carried in the current URL's fragment, if any. */
export async function favouritesInUrl(href = location.href) {
  const hash = new URL(href).hash.replace(/^#/, '');
  const match = new URLSearchParams(hash).get(SHARE_PARAM);
  return match ? decodeShare(match) : [];
}

/* ------------------------------------------------------------ google maps */

export const googleMapsSearchUrl = (lat, lon) =>
  `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lon.toFixed(5)}`;

/* A drive from wherever you are, through the list. The Maps URL API takes nine
 * waypoints plus a destination, so a longer list is cut rather than silently
 * dropping the end - the caller says so. */
export const ROUTE_MAX_STOPS = 10;

export function googleMapsRouteUrl(list) {
  const stops = list.slice(0, ROUTE_MAX_STOPS)
    .map(s => `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`);
  if (!stops.length) return null;
  const destination = stops[stops.length - 1];
  const waypoints = stops.slice(0, -1);
  let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
  if (waypoints.length)
    url += `&waypoints=${encodeURIComponent(waypoints.join('|'))}`;
  return url;
}
