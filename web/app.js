import { DirectionWheel, RangeSlider } from './controls.js?v=9';
import { sunPosition, sunElevationTangents, sunlitMask, horizonCrossing }
  from './sun.js?v=2';

/* The region is 91,000 km2 and one signature set is 294 MB, so nothing here
 * loads the whole thing. Two levels of tiles are fetched for whatever is on
 * screen, and the overlay is rendered for the current viewport rather than as
 * one fixed image over the region. */

/* A phone has a fraction of the fill rate and of the memory, so it scores a
 * smaller window into a smaller bitmap and keeps fewer tiles resident. */
const MOBILE = matchMedia('(max-width: 720px)').matches;
const CANVAS_MAX = MOBILE ? 700 : 1100;         // long edge of the overlay bitmap
const CELL_BUDGET = (MOBILE ? 480 : 700) ** 2;  // cells we will score for one frame
const CACHE_MAX = MOBILE ? 40 : 160;            // resident payloads, ~2.3 MB each
const OPEN_GROUND_M = 2;          // canopy below this counts as open ground
const DROP_SCALE = 4;             // sustained descent stored in quarter-degrees
const SUN_HALO_M = 20000;         // terrain pulled in up-sun, beyond the view
const NO_CANOPY_LIMIT = Infinity; // the site-cover filter, switched off

const state = {
  basemap: 'sat',
  vegetation: 'trees',            // 'trees' or 'bare'
  eyeCm: 170,
  requireWater: false,
  contours: true,
  maxSiteCanopyM: NO_CANOPY_LIMIT,
  minDescentDeg: 0,
  sunFilter: false,
  sunWhen: new Date(),
};
let meta, wheel, range, map, markers = [];

const BLANK = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 1;
  return c.toDataURL();
})();
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const invMercY = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------------------------------------------------------------- loading */

/* Payloads ship gzipped and are inflated here rather than left to the host.
 * Static hosts negotiate Content-Encoding for text but not for
 * application/octet-stream, which is what a .bin is, and this region is 2.3 GB
 * raw. The magic-byte test keeps one code path correct on a host that *does*
 * decompress in transit. */
async function inflate(buf) {
  const h = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  if (h[0] !== 0x1f || h[1] !== 0x8b) return buf;
  if (typeof DecompressionStream === 'undefined')
    throw new Error('this browser cannot inflate gzip');
  return new Response(new Blob([buf]).stream()
    .pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

async function fetchBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return inflate(await r.arrayBuffer());
}

/* Every payload carries the build id, which is what makes a year of immutable
 * caching safe: a rebuild changes the URL rather than the file's freshness. */
const versioned = url => meta.build ? `${url}?v=${meta.build}` : url;

/* Payload cache, least-recently-used first (Map keeps insertion order).
 *
 * Tiles are ~2.3 MB each and the detail level has 153 of them, so holding
 * everything is several hundred megabytes - enough for a phone to kill the tab.
 *
 * Keys used while drawing the current frame are recorded and never evicted.
 * Without that, a working set larger than the limit evicts exactly what the
 * next frame is about to ask for; the refetch triggers a re-render, which
 * evicts again, and it never stops. Measured with the limit forced below the
 * working set, that loop issued 70 requests a second on a map nobody was
 * touching. With it, over-subscribing merely means the cache stops helping. */
const cache = new Map();
const inflight = new Map();
const usedThisFrame = new Set();

function useTile(key) {
  usedThisFrame.add(key);
  if (!cache.has(key)) return;
  const payload = cache.get(key);
  cache.delete(key);
  cache.set(key, payload);          // re-insert at the most-recent end
}

function evictUnusedTiles() {
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_MAX) break;
    if (!usedThisFrame.has(key)) cache.delete(key);
  }
}

/** Edge tiles are short, so a tile's real size is not always the nominal one. */
function tileShape(level, tileY, tileX) {
  const grid = meta.levels[level];
  return [Math.min(grid.tile_rows, grid.rows - tileY * grid.tile_rows),
          Math.min(grid.tile_cols, grid.cols - tileX * grid.tile_cols)];
}

/* Fetches one cache entry: a list of [filename, TypedArray] pairs that arrive
 * together and are keyed by the filename's stem, so `dist_trees_170.bin`
 * becomes `dist`. */
function loadPayload(key, level, tileY, tileX, parts) {
  if (inflight.has(key)) return;
  const dir = `region/L${level}/${tileY}_${tileX}/`;
  const extension = meta.bin_ext || '.bin';
  inflight.set(key, Promise.all(parts.map(([file, ArrayType]) =>
    fetchBuffer(versioned(dir + file + extension)).then(b => new ArrayType(b))
  )).then(arrays => {
    const payload = {};
    parts.forEach(([file], i) => { payload[file.split('_')[0]] = arrays[i]; });
    cache.set(key, payload);
    inflight.delete(key);
    scheduleRender();
  }).catch(err => {
    inflight.delete(key);
    // Null stands for "asked, got nothing", so the tile reads as empty instead
    // of being requested again every frame. Eviction can drop the marker, and
    // a later frame will then retry - which is what you want for a request
    // that failed because the network was down.
    cache.set(key, null);
    console.warn('tile unavailable', key, err.message);
    scheduleRender();                 // or the busy indicator never clears
  }));
}

/* Terrain: elevation, canopy, the land mask and the descent angles. Split from
 * the view signatures because the sun sweep wants terrain far outside the view
 * and none of the signatures out there. Resident if returned, otherwise a fetch
 * has been started and this is null. */
function terrainTile(level, tileY, tileX) {
  const key = `${level}/${tileY}/${tileX}/terrain`;
  if (!cache.has(key)) loadPayload(key, level, tileY, tileX,
    [['valid', Uint8Array], ['elev', Int16Array], ['canopy', Uint8Array],
     ['drop', Uint8Array]]);
  useTile(key);
  return cache.get(key) || null;
}

/* Terrain plus the view signatures for the current eye height and vegetation
 * state, which is what scoring needs. */
function viewTile(level, tileY, tileX) {
  const variant = `${state.vegetation}_${state.eyeCm}`;
  const key = `${level}/${tileY}/${tileX}/${variant}`;
  if (!cache.has(key)) loadPayload(key, level, tileY, tileX,
    [[`dist_${variant}`, Uint8Array], [`water_${variant}`, Uint32Array]]);
  useTile(key);
  const signatures = cache.get(key), terrain = terrainTile(level, tileY, tileX);
  return (signatures && terrain) ? { ...signatures, ...terrain } : null;
}

/** Elevation, canopy and the land mask over any rectangle of cells. */
function terrainRect(level, y0, y1, x0, x1) {
  const grid = meta.levels[level];
  const width = x1 - x0 + 1, height = y1 - y0 + 1;
  const valid = new Uint8Array(width * height);
  const elev = new Int16Array(width * height);
  const canopy = new Uint8Array(width * height);
  let missingTiles = 0;

  for (let tileY = Math.floor(y0 / grid.tile_rows);
           tileY <= Math.floor(y1 / grid.tile_rows); tileY++) {
    for (let tileX = Math.floor(x0 / grid.tile_cols);
             tileX <= Math.floor(x1 / grid.tile_cols); tileX++) {
      const tile = terrainTile(level, tileY, tileX);
      if (!tile) { missingTiles++; continue; }
      const [tileHeight, tileWidth] = tileShape(level, tileY, tileX);
      const originY = tileY * grid.tile_rows, originX = tileX * grid.tile_cols;
      const fromY = Math.max(y0, originY);
      const toY = Math.min(y1, originY + tileHeight - 1);
      const fromX = Math.max(x0, originX);
      const toX = Math.min(x1, originX + tileWidth - 1);
      for (let y = fromY; y <= toY; y++) {
        const tileRow = (y - originY) * tileWidth, outRow = (y - y0) * width;
        for (let x = fromX; x <= toX; x++) {
          const from = tileRow + (x - originX), to = outRow + (x - x0);
          valid[to] = tile.valid[from];
          elev[to] = tile.elev[from];
          canopy[to] = tile.canopy[from];
        }
      }
    }
  }
  return { valid, elev, canopy, missingTiles };
}

/* ------------------------------------------------------------- view window */

/* The rectangle of cells currently on screen, at whichever level can be scored
 * inside one frame. `x1`/`y1` are inclusive. */
function viewWindow() {
  const bounds = map.getBounds();
  const west = Math.max(bounds.getWest(), meta.lon0);
  const east = Math.min(bounds.getEast(), meta.lon1);
  const south = Math.max(bounds.getSouth(), meta.lat0);
  const north = Math.min(bounds.getNorth(), meta.lat1);
  if (east <= west || north <= south) return null;

  let level = map.getZoom() >= meta.detail_min_zoom ? 1 : 0;
  for (;;) {
    const grid = meta.levels[level];
    const x0 = clamp(Math.floor((west - grid.lon0) / grid.dlon), 0, grid.cols - 1);
    const x1 = clamp(Math.ceil((east - grid.lon0) / grid.dlon), 0, grid.cols - 1);
    const y0 = clamp(Math.floor((south - grid.lat0) / grid.dlat), 0, grid.rows - 1);
    const y1 = clamp(Math.ceil((north - grid.lat0) / grid.dlat), 0, grid.rows - 1);
    const width = x1 - x0 + 1, height = y1 - y0 + 1;
    // Too much to score in a frame: drop to the coarser level rather than
    // freezing the page.
    if (width * height > CELL_BUDGET && level > 0) { level--; continue; }
    return { level, grid, x0, x1, y0, y1, width, height, west, east, south, north };
  }
}

/** Copy the visible rectangle out of whatever tiles are resident. */
function gather(view) {
  const { level, grid, x0, y0, width, height } = view;
  const azimuths = meta.azimuths;
  const cells = width * height;
  const dist = new Uint8Array(cells * azimuths);
  const drop = new Uint8Array(cells * azimuths);
  const water = new Uint32Array(cells);
  const valid = new Uint8Array(cells);
  const elev = new Int16Array(cells);
  const canopy = new Uint8Array(cells);
  let missingTiles = 0;

  for (let tileY = Math.floor(y0 / grid.tile_rows);
           tileY <= Math.floor(view.y1 / grid.tile_rows); tileY++) {
    for (let tileX = Math.floor(x0 / grid.tile_cols);
             tileX <= Math.floor(view.x1 / grid.tile_cols); tileX++) {
      const tile = viewTile(level, tileY, tileX);
      if (!tile) { missingTiles++; continue; }
      const [tileHeight, tileWidth] = tileShape(level, tileY, tileX);
      const originY = tileY * grid.tile_rows, originX = tileX * grid.tile_cols;
      const fromY = Math.max(y0, originY);
      const toY = Math.min(view.y1, originY + tileHeight - 1);
      const fromX = Math.max(x0, originX);
      const toX = Math.min(view.x1, originX + tileWidth - 1);
      for (let y = fromY; y <= toY; y++) {
        const tileRow = (y - originY) * tileWidth, outRow = (y - y0) * width;
        for (let x = fromX; x <= toX; x++) {
          const from = tileRow + (x - originX), to = outRow + (x - x0);
          water[to] = tile.water[from];
          valid[to] = tile.valid[from];
          elev[to] = tile.elev[from];
          canopy[to] = tile.canopy[from];
          drop.set(tile.drop.subarray(from * azimuths, from * azimuths + azimuths),
                   to * azimuths);
          dist.set(tile.dist.subarray(from * azimuths, from * azimuths + azimuths),
                   to * azimuths);
        }
      }
    }
  }
  return { dist, water, valid, elev, canopy, drop, missingTiles };
}

/* --------------------------------------------------------------------- sun */

/* Which visible cells can see the sun at the chosen moment.
 *
 * Shadows at this hour are long - one degree of sun turns a 150 m ridge into an
 * 8 km shadow - so the sweep is fed terrain well past the view: 20 km up-sun,
 * which covers everything this relief can throw down to about half a degree of
 * elevation. Below that the sun is within its own diameter of the horizon.
 *
 * At the overview level the packed canopy is the *quietest* cover in each 400 m
 * block rather than the tallest, so trees under-block there. Zoom in for the
 * honest answer; the stat line already says which grid is in play. */
function sunlitCells(view) {
  const { level, grid, x0, y0, width, height } = view;
  const sun = sunPosition(state.sunWhen,
    grid.lat0 + (y0 + height / 2) * grid.dlat,
    grid.lon0 + (x0 + width / 2) * grid.dlon);

  const east = Math.sin(sun.azimuth * Math.PI / 180);
  const north = Math.cos(sun.azimuth * Math.PI / 180);
  const haloCells = Math.round(SUN_HALO_M / grid.step_m);
  // Extended towards the sun only: that is the one direction light arrives
  // from, and a halo on the other three sides would be terrain nothing reads.
  const sweepX0 = Math.max(0, x0 - (east < 0 ? haloCells : 0));
  const sweepX1 = Math.min(grid.cols - 1, view.x1 + (east > 0 ? haloCells : 0));
  const sweepY0 = Math.max(0, y0 - (north < 0 ? haloCells : 0));
  const sweepY1 = Math.min(grid.rows - 1, view.y1 + (north > 0 ? haloCells : 0));
  const sweepWidth = sweepX1 - sweepX0 + 1, sweepHeight = sweepY1 - sweepY0 + 1;

  const terrain = terrainRect(level, sweepY0, sweepY1, sweepX0, sweepX1);
  const eyeM = state.eyeCm / 100;
  const treesBlock = state.vegetation === 'trees';
  const blockingHeight = new Float32Array(sweepWidth * sweepHeight);
  const eyeHeight = new Float32Array(sweepWidth * sweepHeight);
  for (let i = 0; i < blockingHeight.length; i++) {
    // Sea and no-data both sit at zero: the sea really is there, and past the
    // region a flat surface casts no shadow it has not earned.
    const ground = terrain.valid[i] && terrain.elev[i] !== -32768 ? terrain.elev[i] : 0;
    blockingHeight[i] = ground + (treesBlock ? terrain.canopy[i] : 0);
    eyeHeight[i] = ground + eyeM;
  }

  const lit = sunlitMask({
    blockingHeight, eyeHeight,
    tanSunElevation: sunElevationTangents(state.sunWhen, {
      lat0: grid.lat0 + sweepY0 * grid.dlat, dlat: grid.dlat,
      lon0: grid.lon0 + sweepX0 * grid.dlon, dlon: grid.dlon,
      width: sweepWidth, height: sweepHeight,
    }),
    width: sweepWidth, height: sweepHeight,
    azimuth: sun.azimuth, cellMetres: grid.step_m,
  });

  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sweepRow = (y + y0 - sweepY0) * sweepWidth + (x0 - sweepX0);
    const maskRow = y * width;
    for (let x = 0; x < width; x++) {
      // Under a canopy taller than your eyes you are not in the sun whatever
      // the skyline does: your own cover is nearer than the first step the
      // sweep is able to take.
      mask[maskRow + x] = (treesBlock && terrain.canopy[sweepRow + x] > eyeM)
        ? 0 : lit[sweepRow + x];
    }
  }
  return { mask, position: sun, missingTiles: terrain.missingTiles };
}

/* ----------------------------------------------------------------- scoring */

/** The azimuth bins the direction wheel currently covers, as a list and a mask. */
function selectedBins() {
  const azimuths = meta.azimuths, bins = [];
  let mask = 0;
  for (let bin = 0; bin < azimuths; bin++)
    if (wheel.covers(bin * 360 / azimuths)) { bins.push(bin); mask |= (1 << bin); }
  return { bins, mask };
}

/* Mean reach over the chosen directions, made robust across a plot, then
 * filtered. The order matters: filtering before the robustness pass let a
 * disqualified neighbour drag a qualifying cell to zero, which punished a spot
 * for its surroundings failing a test it had passed itself. */
function score(view, data, sunMask) {
  const { width, height, grid } = view;
  const azimuths = meta.azimuths, cells = width * height;
  const { bins, mask } = selectedBins();
  const metresPerUnit = meta.max_dist_km * 1000 / 255;

  // 1. How far you see, for every cell that is land. No filtering yet.
  const reach = new Float32Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    if (!data.valid[cell]) continue;
    let total = 0;
    const base = cell * azimuths;
    for (let i = 0; i < bins.length; i++) total += data.dist[base + bins[i]];
    reach[cell] = total / bins.length * metresPerUnit;
  }

  // 2. Does the score hold up across a plot? The 25th percentile of a 50 m
  // neighbourhood, so one freak cell cannot carry a spot - but not the minimum,
  // which is an extreme and made the map square. At coarse levels one cell is
  // already wider than the radius, so skip rather than smooth over kilometres
  // and claim a precision the data has not got.
  const radiusCells = Math.round(50 / grid.step_m);
  let plotReach = reach;
  if (radiusCells >= 1) {
    plotReach = new Float32Array(cells);
    const span = 2 * radiusCells + 1;
    const neighbourhood = new Float32Array(span * span);
    const rank = Math.floor(span * span * 0.25);
    for (let y = radiusCells; y < height - radiusCells; y++) {
      for (let x = radiusCells; x < width - radiusCells; x++) {
        let n = 0;
        for (let dy = -radiusCells; dy <= radiusCells; dy++)
          for (let dx = -radiusCells; dx <= radiusCells; dx++)
            neighbourhood[n++] = reach[(y + dy) * width + x + dx];
        // Partial selection sort: only the smallest `rank + 1` need ordering.
        for (let i = 0; i <= rank; i++) {
          let smallest = i;
          for (let j = i + 1; j < n; j++)
            if (neighbourhood[j] < neighbourhood[smallest]) smallest = j;
          const swap = neighbourhood[i];
          neighbourhood[i] = neighbourhood[smallest];
          neighbourhood[smallest] = swap;
        }
        plotReach[y * width + x] = neighbourhood[rank];
      }
    }
  }

  // 3. The filters, as a mask over the finished score.
  const minReachM = range.lo * 1000;
  const maxReachM = range.capped() ? Infinity : range.hi * 1000;
  const scores = new Float32Array(cells);
  for (let cell = 0; cell < cells; cell++) {
    const metres = plotReach[cell];
    if (!(metres > 0)) continue;
    if (metres < minReachM || metres > maxReachM) continue;
    if (data.canopy[cell] > state.maxSiteCanopyM) continue;
    if (state.requireWater && !(data.water[cell] & mask)) continue;
    if (sunMask && !sunMask[cell]) continue;
    if (state.minDescentDeg > 0) {
      // Mean sustained descent across the chosen directions, not the best one:
      // a single steep gully should not qualify an otherwise flat field.
      let total = 0;
      const base = cell * azimuths;
      for (let i = 0; i < bins.length; i++) total += data.drop[base + bins[i]];
      if (total / bins.length / DROP_SCALE < state.minDescentDeg) continue;
    }
    scores[cell] = metres;
  }
  return scores;
}

/* ----------------------------------------------------------------- drawing */

/* Colour ramp for reach, pale to near-black. Shared with the range slider's
 * track, so the legend and the map cannot drift apart. */
const RAMP_HEX = ['#FFF3E0', '#FBD89B', '#F5B35A', '#E8891C',
                         '#C4620A', '#853B06', '#431C02'];
const RAMP_RGB = RAMP_HEX.map(hex => [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16)));

let overlayIssued = 0;      // frames that have started painting the overlay
let overlayApplied = 0;     // newest frame whose bitmap reached the map
let overlayUrl = null;

function draw(view, scores, bestMetres) {
  const { width, height, west, east, south, north, grid, x0, y0 } = view;
  // Both spans must be in Mercator units. Mercator x is proportional to
  // longitude in RADIANS; comparing degrees against a Mercator y span made the
  // canvas the wrong shape by a factor of ~57, collapsing one axis to a few
  // pixels and banding the overlay when it was stretched back out.
  const spanX = (east - west) * Math.PI / 180;
  const spanY = mercY(north) - mercY(south);
  let canvasW = CANVAS_MAX, canvasH = CANVAS_MAX;
  if (spanX > spanY) canvasH = Math.max(64, Math.round(CANVAS_MAX * spanY / spanX));
  else canvasW = Math.max(64, Math.round(CANVAS_MAX * spanX / spanY));

  const canvas = document.getElementById('ovcanvas');
  canvas.width = canvasW; canvas.height = canvasH;
  const context = canvas.getContext('2d');
  const image = context.createImageData(canvasW, canvasH);
  const pixels = image.data;

  const rampLow = range.lo * 1000;
  const rampHigh = range.capped() ? Math.max(bestMetres, rampLow + 500)
                                  : range.hi * 1000;
  const lastStop = RAMP_RGB.length - 1;
  const mercNorth = mercY(north), mercSouth = mercY(south);

  for (let row = 0; row < canvasH; row++) {
    const lat = invMercY(mercNorth + (row / (canvasH - 1)) * (mercSouth - mercNorth));
    const cellY = Math.round((lat - grid.lat0) / grid.dlat) - y0;
    const rowStart = row * canvasW * 4;
    if (cellY < 0 || cellY >= height) {
      for (let col = 0; col < canvasW; col++) pixels[rowStart + col * 4 + 3] = 0;
      continue;
    }
    const cellRow = cellY * width;
    for (let col = 0; col < canvasW; col++) {
      const lon = west + (col / (canvasW - 1)) * (east - west);
      const cellX = Math.round((lon - grid.lon0) / grid.dlon) - x0;
      const pixel = rowStart + col * 4;
      if (cellX < 0 || cellX >= width) { pixels[pixel + 3] = 0; continue; }
      const metres = scores[cellRow + cellX];
      if (!(metres > 0)) { pixels[pixel + 3] = 0; continue; }
      // Square root, because reach is heavily skewed: on a linear ramp almost
      // everything lands in the palest step and the interesting tail vanishes.
      const t = Math.sqrt(clamp((metres - rampLow) / (rampHigh - rampLow), 0, 1));
      const position = t * lastStop;
      const stop = Math.min(lastStop - 1, position | 0);
      const blend = position - stop;
      for (let channel = 0; channel < 3; channel++)
        pixels[pixel + channel] = RAMP_RGB[stop][channel]
          + (RAMP_RGB[stop + 1][channel] - RAMP_RGB[stop][channel]) * blend;
      pixels[pixel + 3] = (0.22 + 0.72 * t) * 255;
    }
  }
  context.putImageData(image, 0, 0);

  const source = map.getSource('ov');
  if (!source) return;
  const frame = ++overlayIssued;
  canvas.toBlob(blob => {
    // toBlob finishes asynchronously, so a slow frame can land after a newer
    // one has already been shown. Dropping it keeps the overlay from flicking
    // backwards onto stale scores.
    if (frame < overlayApplied) return;
    overlayApplied = frame;
    const url = URL.createObjectURL(blob);
    source.updateImage({ url, coordinates: [[west, north], [east, north],
                                            [east, south], [west, south]] });
    const previous = overlayUrl;
    // MapLibre reads the blob after updateImage returns, so the old one cannot
    // be released on the spot.
    if (previous) setTimeout(() => URL.revokeObjectURL(previous), 4000);
    overlayUrl = url;
  }, 'image/png');
}

/* The best cells, with each pick blanking a 2 km disc around it so the list is
 * ten places rather than ten pixels of one hillside. */
function topSpots(view, scores, count = 10) {
  const { width, height, grid, x0, y0 } = view;
  const separation = Math.max(3, Math.round(2000 / grid.step_m));
  const remaining = Float32Array.from(scores);
  const spots = [];
  for (let n = 0; n < count; n++) {
    let bestMetres = 0, bestCell = -1;
    for (let cell = 0; cell < remaining.length; cell++)
      if (remaining[cell] > bestMetres) { bestMetres = remaining[cell]; bestCell = cell; }
    if (bestCell < 0) break;
    const y = (bestCell / width) | 0, x = bestCell % width;
    spots.push({ km: bestMetres / 1000,
                 lat: grid.lat0 + (y + y0) * grid.dlat,
                 lon: grid.lon0 + (x + x0) * grid.dlon });
    for (let dy = -separation; dy <= separation; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -separation; dx <= separation; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        remaining[ny * width + nx] = 0;
      }
    }
  }
  return spots;
}

/* ------------------------------------------------------------------- frame */

let frameQueued = false;
let lastScoredView = null;      // kept so a map click can report an elevation

function scheduleRender() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(renderFrame);
}

function renderFrame() {
  // Stay queued across the wait, so the many callers that arrive while the
  // style is loading share this one retry. Clearing the flag first let each of
  // them start a timer of its own: eight callers left four chains polling for
  // ever, and nothing ever merged them back.
  if (!map || !map.isStyleLoaded()) {
    setTimeout(() => { frameQueued = false; scheduleRender(); }, 120);
    return;
  }
  frameQueued = false;
  usedThisFrame.clear();

  const startedAt = performance.now();
  const stat = document.getElementById('stat');
  const view = viewWindow();
  if (!view) {
    stat.textContent = 'outside the region';
    document.getElementById('busy').hidden = inflight.size === 0;
    return;
  }

  const data = gather(view);
  lastScoredView = { view, elev: data.elev };
  const sun = state.sunFilter ? sunlitCells(view) : null;
  showSunPosition(sun && sun.position);

  const scores = score(view, data, sun && sun.mask);
  let bestMetres = 0;
  for (let i = 0; i < scores.length; i++)
    if (scores[i] > bestMetres) bestMetres = scores[i];

  draw(view, scores, bestMetres);
  placeMarkers(topSpots(view, scores));
  evictUnusedTiles();
  document.getElementById('busy').hidden = inflight.size === 0;

  // Halo tiles count too: while they are missing the sun sweep sees flat ground
  // up-sun and reports more sunlight than there is.
  const loading = data.missingTiles + (sun ? sun.missingTiles : 0);
  const arc = wheel.span();
  stat.innerHTML =
    (arc >= 359.8 ? 'all directions'
      : `${wheel.start.toFixed(0)}°–${wheel.end.toFixed(0)}° (${arc.toFixed(0)}°)`)
    + ` · best ${bestMetres ? (bestMetres / 1000).toFixed(1) : '—'} km`
    + `<span class="dim"> · ${view.grid.step_m} m grid`
    + ` · ${(performance.now() - startedAt) | 0} ms`
    + (loading ? ` · ${loading} tiles loading` : '') + '</span>';
}

/* The sun's position at the middle of the view, so the date and time fields
 * have something to answer back with. */
function showSunPosition(position) {
  const el = document.getElementById('sunv');
  if (!el || !position) return;
  const bearing = `bearing ${position.azimuth.toFixed(0)}°`;
  // Set, in the usual sense, is the upper limb leaving a *flat* horizon.
  // Standing high with the ground falling away you can still be looking at it,
  // which is exactly the ground this filter is for, so the map may well show
  // lit cells after this says the sun has gone.
  el.innerHTML =
      position.elevation > 0 ? `sun ${position.elevation.toFixed(1)}° up, ${bearing}`
    : position.geometric > -0.833 ? `sun on the horizon, ${bearing}`
    : `<span class="dim">sun has set · ${bearing}</span>`;
}

function placeMarkers(spots) {
  markers.forEach(m => m.remove());
  markers = spots.map((spot, i) => {
    const marker = document.createElement('div');
    marker.className = 'spot';
    marker.textContent = i + 1;
    const here = `${spot.lat.toFixed(5)},${spot.lon.toFixed(5)}`;
    const popup = new maplibregl.Popup({ offset: 14 }).setHTML(
      `<b>#${i + 1} — ${spot.km.toFixed(1)} km</b><br>${spot.lat.toFixed(5)}, ${spot.lon.toFixed(5)}<br>`
      + `<a target="_blank" rel="noopener noreferrer" `
      + `href="https://www.google.com/maps/search/?api=1&query=${here}">open in Google Maps</a>`);
    return new maplibregl.Marker({ element: marker }).setLngLat([spot.lon, spot.lat])
      .setPopup(popup).addTo(map);
  });
}

function elevationAt(lat, lon) {
  if (!lastScoredView) return '';
  const { view, elev } = lastScoredView, grid = view.grid;
  const cellY = Math.round((lat - grid.lat0) / grid.dlat) - view.y0;
  const cellX = Math.round((lon - grid.lon0) / grid.dlon) - view.x0;
  if (cellY < 0 || cellX < 0 || cellY >= view.height || cellX >= view.width)
    return 'outside the region';
  const metres = elev[cellY * view.width + cellX];
  return metres === -32768 ? 'no data' : `${metres} m`;
}

function setClarity(v) {
  const overlay = v <= 50 ? v / 50 : 1;
  const veil = v <= 50 ? 0 : (v - 50) / 50;
  if (map) {
    map.setPaintProperty('ov', 'raster-opacity', overlay);
    map.setPaintProperty('veil', 'background-opacity', veil);
  }
  document.getElementById('clarityv').textContent =
    veil > 0 ? `map faded ${Math.round(veil * 100)}%` : `overlay ${Math.round(overlay * 100)}%`;
}

/* -------------------------------------------------------------------- boot */

(async function () {
  meta = await fetch('region/meta.json').then(r => r.json());
  buildUI();
  buildMap();
})();

function buildUI() {
  document.querySelector('#range .fill').style.background =
    `linear-gradient(90deg, ${RAMP_HEX.join(',')})`;

  wheel = new DirectionWheel(document.getElementById('wheel'), scheduleRender,
                           meta.azimuths);
  range = new RangeSlider(document.getElementById('range'), {
    max: meta.max_dist_km, lo: 0, hi: meta.max_dist_km, onChange: scheduleRender });
  renderTicks();

  document.getElementById('presets').addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    const v = b.dataset.v;
    if (v === 'all') wheel.set(0, 359.9, false);   // full circle, not a snapped arc
    else { const a = +v; wheel.set(a - 45, a + 45); }
  });

  const eyes = document.getElementById('eye');
  for (const e of meta.eyes) {
    const b = document.createElement('button');
    b.dataset.v = e.cm;
    b.setAttribute('aria-pressed', String(e.cm === state.eyeCm));
    b.innerHTML = `${e.cm === 0 ? 'Ground' : e.cm === 170 ? 'Standing' : 'Second floor'}<em>${e.m} m</em>`;
    eyes.appendChild(b);
  }
  eyes.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    [...eyes.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)));
    state.eyeCm = +b.dataset.v; scheduleRender();
  });

  document.getElementById('base').addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    [...ev.currentTarget.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)));
    state.basemap = b.dataset.v;
    map.setLayoutProperty('base-sat', 'visibility',
      state.basemap === 'sat' ? 'visible' : 'none');
    map.setLayoutProperty('base-osm', 'visibility',
      state.basemap === 'osm' ? 'visible' : 'none');
  });

  document.getElementById('water').addEventListener('change', e => {
    state.requireWater = e.target.checked; scheduleRender();
  });

  document.getElementById('bare').addEventListener('change', e => {
    state.vegetation = e.target.checked ? 'bare' : 'trees'; scheduleRender();
  });

  // "Skip spots in forest" is the site-cover filter as a plain switch: 2 m of
  // canopy is the line between standing in the open and standing under trees.
  document.getElementById('openonly').addEventListener('change', e => {
    state.maxSiteCanopyM = e.target.checked ? OPEN_GROUND_M : NO_CANOPY_LIMIT;
    scheduleRender();
  });

  const slope = document.getElementById('slope');
  const showDescent = () => {
    // Degrees are abstract at this scale - almost everything useful sits under
    // one degree - so show the equivalent drop per kilometre alongside.
    const el = document.getElementById('slopev');
    if (state.minDescentDeg <= 0) { el.textContent = 'any'; return; }
    const metresPerKm = Math.tan(state.minDescentDeg * Math.PI / 180) * 1000;
    el.textContent =
      `≥ ${state.minDescentDeg.toFixed(2)}° · ${metresPerKm.toFixed(0)} m/km`;
  };
  slope.addEventListener('input', () => {
    state.minDescentDeg = +slope.value / 100;
    showDescent(); scheduleRender();
  });
  showDescent();
  const cont = document.getElementById('contours');
  cont.addEventListener('change', e => {
    state.contours = e.target.checked;
    ensureContours();
    for (const id of ['contour-minor', 'contour-major'])
      if (map.getLayer(id))
        map.setLayoutProperty(id, 'visibility', state.contours ? 'visible' : 'none');
  });
  const clarity = document.getElementById('clarity');
  clarity.addEventListener('input', () => setClarity(+clarity.value));

  // The date and time are read as the device's own local time, which is the
  // Swedish clock for anyone who is actually standing in the region.
  const sunOn = document.getElementById('sunon');
  const sunDate = document.getElementById('sundate');
  const sunTime = document.getElementById('suntime');
  const pad = n => String(n).padStart(2, '0');
  const readSun = () => {
    const d = new Date(`${sunDate.value}T${sunTime.value || '12:00'}`);
    if (!isNaN(d)) state.sunWhen = d;
  };
  const setTime = d => { sunTime.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const now = new Date();
  sunDate.value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  setTime(now);
  readSun();

  sunOn.addEventListener('change', e => {
    state.sunFilter = e.target.checked;
    document.getElementById('sunfields').hidden = !state.sunFilter;
    scheduleRender();
  });
  for (const el of [sunDate, sunTime])
    el.addEventListener('change', () => { readSun(); scheduleRender(); });

  // Sunset is the whole point of asking, and hunting for it a minute at a time
  // through a time field would be miserable.
  document.getElementById('tosunset').addEventListener('click', () => {
    const c = map.getCenter();
    const t = horizonCrossing(state.sunWhen, c.lat, c.lng, true);
    if (!t) return;                    // midnight sun, or a day with none
    setTime(t);
    readSun();
    scheduleRender();
  });

  // On a phone the panel is a bottom sheet: tapping its title bar hands the
  // screen back to the map. On a desktop the bar is not a control at all.
  const panel = document.getElementById('panel');
  const bar = document.getElementById('sheetbar');
  const narrow = matchMedia('(max-width: 720px)');
  // The map's own controls sit just above the sheet's collapsed height: the
  // title bar plus the readout, both of which stay on screen when the sheet is
  // shut. Measured rather than guessed, so a stat line that wraps to two rows
  // does not end up behind the zoom buttons.
  const stat = document.getElementById('stat');
  let barHeight = -1;
  const fitBar = () => {
    if (!narrow.matches) return;        // --bar is only read by the phone rules
    const height = bar.offsetHeight + stat.offsetHeight;
    // The readout is rewritten every frame, so this fires constantly; reading
    // offsetHeight forces layout, and writing the variable back would too.
    if (height === barHeight) return;
    barHeight = height;
    document.documentElement.style.setProperty('--bar', height + 'px');
  };
  bar.addEventListener('click', () => {
    if (!narrow.matches) return;
    panel.dataset.open = panel.dataset.open === 'false' ? 'true' : 'false';
  });
  // The readout starts empty and grows once a frame has been scored, so its
  // height is observed rather than measured once at boot.
  const observer = new ResizeObserver(fitBar);
  observer.observe(bar);
  observer.observe(stat);
  narrow.addEventListener('change', () => { barHeight = -1; fitBar(); });
  addEventListener('resize', fitBar);
}

function renderTicks() {
  const el = document.getElementById('ticks');
  el.innerHTML = '';
  for (const v of [0, 1, 2, 5, 10, 20]) {
    const s = document.createElement('span');
    s.textContent = v;
    s.style.left = (range.pos(v) * 100) + '%';
    el.appendChild(s);
  }
}

const CONTOUR_MIN_ZOOM = 9;

/* Contours are 5.6 MB and only legible once you are zoomed in: across the whole
 * region they render as a grey mesh that hides the terrain they describe. The
 * source is added the first time the map is close enough to want them, so the
 * file is never fetched for a viewer who stays zoomed out. */
function ensureContours() {
  if (!state.contours || map.getSource('contours')) return;
  if (map.getZoom() < CONTOUR_MIN_ZOOM) return;
  map.addSource('contours',
    { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  fetchBuffer(versioned('layers/contours_region' + (meta.geojson_ext || '.geojson')))
    .then(b => map.getSource('contours')
      .setData(JSON.parse(new TextDecoder().decode(b))))
    .catch(e => console.warn('contours unavailable', e.message));
  map.addLayer({ id: 'contour-minor', type: 'line', source: 'contours',
    filter: ['!', ['get', 'major']], minzoom: 11,
    paint: { 'line-color': '#4a3f35', 'line-opacity': 0.45,
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 14, 1.0, 17, 1.6] } });
  map.addLayer({ id: 'contour-major', type: 'line', source: 'contours',
    filter: ['get', 'major'], minzoom: CONTOUR_MIN_ZOOM,
    paint: { 'line-color': '#332c25', 'line-opacity': 0.7,
      'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 12, 1.4, 15, 2.2, 17, 3.0] } });
}

function buildMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      sources: {
        sat: { type: 'raster', tileSize: 256,
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
        osm: { type: 'raster', tileSize: 256,
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          attribution: '&copy; OpenStreetMap contributors' },
        ov: { type: 'image', url: BLANK,
          coordinates: [[meta.lon0, meta.lat1], [meta.lon1, meta.lat1],
                        [meta.lon1, meta.lat0], [meta.lon0, meta.lat0]] },
      },
      layers: [
        { id: 'base-sat', type: 'raster', source: 'sat' },
        { id: 'base-osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
        { id: 'veil', type: 'background',
          paint: { 'background-color': '#ffffff', 'background-opacity': 0 } },
        { id: 'ov', type: 'raster', source: 'ov',
          paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } },
      ],
    },
    center: [(meta.lon0 + meta.lon1) / 2, (meta.lat0 + meta.lat1) / 2], zoom: 6.4,
    // The basemaps credit themselves through their own sources; the data the
    // overlay is actually made of does not, and TessaDEM is ODbL while the
    // canopy and land cover are CC BY 4.0. A public site has to say so.
    attributionControl: { compact: MOBILE, customAttribution:
      'Elevation <a target="_blank" rel="noopener noreferrer" href="https://tessadem.com/">TessaDEM</a> (ODbL) &middot; '
      + 'Canopy <a target="_blank" rel="noopener noreferrer" href="https://registry.opendata.aws/dataforgood-fb-forests/">Meta &amp; WRI</a> (CC BY 4.0, imagery &copy; 2016 Maxar) &middot; '
      + 'Land cover <a target="_blank" rel="noopener noreferrer" href="https://esa-worldcover.org/">ESA WorldCover</a> (CC BY 4.0)' },
  });
  // Deliberate: the map, wheel and slider are reachable from the console, which
  // is how everything in here gets checked against real ground.
  Object.assign(window, { map, wheel, range, state });
  map.addControl(new maplibregl.NavigationControl({ showCompass: !MOBILE }),
                 'bottom-right');
  // The question on a road trip is "what is around me", which wants the
  // device's own position rather than a search box.
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true, showUserLocation: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), 'bottom-left');
  // MapLibre's compact attribution opens itself and never closes, so on a
  // phone these credits sit across four lines of map for good. Shut it once the
  // map settles; the (i) button still opens it, which is what the licences ask.
  if (MOBILE) map.once('idle', () => document
    .querySelector('.maplibregl-ctrl-attrib.maplibregl-compact')
    ?.classList.remove('maplibregl-compact-show'));
  map.on('load', () => {
    setClarity(+document.getElementById('clarity').value);
    scheduleRender();
  });
  map.on('moveend', () => { ensureContours(); scheduleRender(); });

  map.on('mousemove', e => {
    const layers = ['contour-major', 'contour-minor'].filter(l => map.getLayer(l));
    const f = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : [];
    map.getCanvas().style.cursor = f.length ? 'crosshair' : '';
    const el = document.getElementById('hover');
    if (f.length) { el.hidden = false; el.textContent = `${f[0].properties.e} m`; }
    else el.hidden = true;
  });
  map.on('click', e => {
    if (e.originalEvent.target.closest('.spot')) return;
    const { lat, lng } = e.lngLat;
    new maplibregl.Popup().setLngLat(e.lngLat).setHTML(
      `<b>${elevationAt(lat, lng)}</b><br>${lat.toFixed(5)}, ${lng.toFixed(5)}<br>` +
      `<a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lng.toFixed(5)}">open in Google Maps</a>`
    ).addTo(map);
  });
}
