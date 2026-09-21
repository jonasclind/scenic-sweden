import { DirectionWheel, RangeSlider } from './controls.js?v=8';

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

const state = { base: 'sat', veg: 'trees', eye: 170, waterOnly: false,
                contours: true, siteMax: 99, minDrop: 0 };
let meta, wheel, range, map, markers = [];
const cache = new Map();
const inflight = new Map();
let objUrl = null, pending = false;

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
const ver = url => meta.build ? `${url}?v=${meta.build}` : url;

/* Tiles are ~2.3 MB each and there are 153 of them at detail level, so an
 * unbounded cache is several hundred megabytes - enough to have a phone kill
 * the tab. Everything on screen is touched every frame, so the least-recent
 * end of the map is never something currently being drawn. */
function touch(key) {
  if (!cache.has(key)) return;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v);
}

function evict() {
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_MAX) return;
    cache.delete(k);
  }
}

function tileShape(L, iy, ix) {
  const lv = meta.levels[L];
  return [Math.min(lv.tile_rows, lv.rows - iy * lv.tile_rows),
          Math.min(lv.tile_cols, lv.cols - ix * lv.tile_cols)];
}

function loadParts(key, L, iy, ix, parts) {
  if (inflight.has(key)) return;
  const base = `region/L${L}/${iy}_${ix}/`;
  inflight.set(key, Promise.all(parts.map(([f, T]) =>
    fetchBuffer(ver(base + f + (meta.bin_ext || '.bin'))).then(b => new T(b))
  )).then(vals => {
    const o = {};
    parts.forEach(([f], i) => { o[f.split('_')[0]] = vals[i]; });
    cache.set(key, o);
    inflight.delete(key);
    scheduleRender();
  }).catch(e => {
    inflight.delete(key);
    cache.set(key, null);              // missing tile: treat as empty, not retried
    console.warn('tile unavailable', key, e.message);
  }));
}

/** Returns the tile if resident, otherwise starts fetching and returns null. */
function tile(L, iy, ix) {
  const combo = `${state.veg}_${state.eye}`;
  const kd = `${L}/${iy}/${ix}/${combo}`, kb = `${L}/${iy}/${ix}/base`;
  if (!cache.has(kd)) loadParts(kd, L, iy, ix,
    [[`dist_${combo}`, Uint8Array], [`water_${combo}`, Uint32Array]]);
  if (!cache.has(kb)) loadParts(kb, L, iy, ix,
    [['valid', Uint8Array], ['elev', Int16Array], ['canopy', Uint8Array],
     ['drop', Uint8Array]]);
  touch(kd); touch(kb);
  const d = cache.get(kd), b = cache.get(kb);
  return (d && b) ? { ...d, ...b } : null;
}

/* ------------------------------------------------------------- view window */

function viewWindow() {
  const b = map.getBounds();
  const W = Math.max(b.getWest(), meta.lon0), E = Math.min(b.getEast(), meta.lon1);
  const S = Math.max(b.getSouth(), meta.lat0), N = Math.min(b.getNorth(), meta.lat1);
  if (E <= W || N <= S) return null;

  let L = map.getZoom() >= meta.detail_min_zoom ? 1 : 0;
  for (;;) {
    const lv = meta.levels[L];
    const x0 = clamp(Math.floor((W - lv.lon0) / lv.dlon), 0, lv.cols - 1);
    const x1 = clamp(Math.ceil((E - lv.lon0) / lv.dlon), 0, lv.cols - 1);
    const y0 = clamp(Math.floor((S - lv.lat0) / lv.dlat), 0, lv.rows - 1);
    const y1 = clamp(Math.ceil((N - lv.lat0) / lv.dlat), 0, lv.rows - 1);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    // Too much to score in a frame: drop to the coarser level rather than
    // freezing the page.
    if (w * h > CELL_BUDGET && L > 0) { L--; continue; }
    return { L, lv, x0, x1, y0, y1, w, h, W, E, S, N };
  }
}

/** Copy the visible rectangle out of whatever tiles are resident. */
function gather(vwin) {
  const { L, lv, x0, y0, w, h } = vwin;
  const A = meta.azimuths;
  const dist = new Uint8Array(w * h * A);
  const water = new Uint32Array(w * h);
  const valid = new Uint8Array(w * h);
  const elev = new Int16Array(w * h);
  const canopy = new Uint8Array(w * h);
  const drop = new Uint8Array(w * h * A);
  let missing = 0;

  const iy0 = Math.floor(y0 / lv.tile_rows), iy1 = Math.floor(vwin.y1 / lv.tile_rows);
  const ix0 = Math.floor(x0 / lv.tile_cols), ix1 = Math.floor(vwin.x1 / lv.tile_cols);
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const t = tile(L, iy, ix);
      if (!t) { missing++; continue; }
      const [th, tw] = tileShape(L, iy, ix);
      const ty = iy * lv.tile_rows, tx = ix * lv.tile_cols;
      const ys = Math.max(y0, ty), ye = Math.min(vwin.y1, ty + th - 1);
      const xs = Math.max(x0, tx), xe = Math.min(vwin.x1, tx + tw - 1);
      for (let y = ys; y <= ye; y++) {
        const srcRow = (y - ty) * tw, dstRow = (y - y0) * w;
        for (let x = xs; x <= xe; x++) {
          const si = srcRow + (x - tx), di = dstRow + (x - x0);
          water[di] = t.water[si];
          valid[di] = t.valid[si];
          elev[di] = t.elev[si];
          canopy[di] = t.canopy[si];
          drop.set(t.drop.subarray(si * A, si * A + A), di * A);
          dist.set(t.dist.subarray(si * A, si * A + A), di * A);
        }
      }
    }
  }
  return { dist, water, valid, elev, canopy, drop, missing };
}

/* ----------------------------------------------------------------- scoring */

function selection() {
  const A = meta.azimuths, bins = [];
  let mask = 0;
  for (let b = 0; b < A; b++)
    if (wheel.covers(b * 360 / A)) { bins.push(b); mask |= (1 << b); }
  return { bins, mask };
}

function score(vwin, data) {
  const { w, h, lv } = vwin, A = meta.azimuths, n = w * h;
  const { bins, mask } = selection();
  const k = meta.max_dist_km * 1000 / 255;

  // 1. How far you see, for every cell that is land. No filtering yet.
  const raw = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    if (!data.valid[c]) continue;
    let sum = 0; const base = c * A;
    for (let i = 0; i < bins.length; i++) sum += data.dist[base + bins[i]];
    raw[c] = sum / bins.length * k;
  }

  // 2. Does the score hold up across a plot? Radius in metres; at coarse levels
  // one cell is already wider than the radius, so skip rather than smooth over
  // kilometres and claim a precision the data has not got.
  const r = Math.round(50 / lv.step_m);
  let held = raw;
  if (r >= 1) {
    held = new Float32Array(n);
    const win = new Float32Array((2 * r + 1) ** 2);
    for (let y = r; y < h - r; y++) {
      for (let x = r; x < w - r; x++) {
        let m = 0;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) win[m++] = raw[(y + dy) * w + x + dx];
        const q = Math.floor(m * 0.25);
        for (let i = 0; i <= q; i++) {
          let mi = i;
          for (let j = i + 1; j < m; j++) if (win[j] < win[mi]) mi = j;
          const t = win[i]; win[i] = win[mi]; win[mi] = t;
        }
        held[y * w + x] = win[q];
      }
    }
  }

  // 3. Now the filters, as a mask over the finished score. Applying them before
  // the step above let a filtered-out neighbour drag a qualifying cell to zero,
  // which punished a spot for its surroundings failing a test it passed.
  const loM = range.lo * 1000;
  const hiM = range.capped() ? Infinity : range.hi * 1000;
  const out = new Float32Array(n);
  for (let c = 0; c < n; c++) {
    const v = held[c];
    if (!(v > 0)) continue;
    if (v < loM || v > hiM) continue;
    if (data.canopy[c] > state.siteMax) continue;
    if (state.waterOnly && !(data.water[c] & mask)) continue;
    if (state.minDrop > 0) {
      // Mean sustained descent across the chosen directions, not the best one:
      // a single steep gully should not qualify an otherwise flat field.
      let ds = 0; const db = c * A;
      for (let i = 0; i < bins.length; i++) ds += data.drop[db + bins[i]];
      if (ds / bins.length / DROP_SCALE < state.minDrop) continue;
    }
    out[c] = v;
  }
  return out;
}

/* ----------------------------------------------------------------- drawing */

let ramp;
function draw(vwin, sc, top) {
  const { w, h, W, E, S, N, lv, x0, y0 } = vwin;
  // Both spans must be in Mercator units. Mercator x is proportional to
  // longitude in RADIANS; comparing degrees against a Mercator y span made the
  // canvas the wrong shape by a factor of ~57, collapsing one axis to a few
  // pixels and banding the overlay when it was stretched back out.
  let cw = CANVAS_MAX, ch = CANVAS_MAX;
  const spanX = (E - W) * Math.PI / 180;
  const spanY = mercY(N) - mercY(S);
  if (spanX / spanY > 1) ch = Math.max(64, Math.round(CANVAS_MAX * spanY / spanX));
  else cw = Math.max(64, Math.round(CANVAS_MAX * spanX / spanY));

  const cv = document.getElementById('ovcanvas');
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(cw, ch);
  const px = img.data;
  const lo = range.lo * 1000;
  const hi = range.capped() ? Math.max(top, lo + 500) : range.hi * 1000;
  const last = ramp.length - 1;
  const myN = mercY(N), myS = mercY(S);

  for (let j = 0; j < ch; j++) {
    const lat = invMercY(myN + (j / (ch - 1)) * (myS - myN));
    const gy = Math.round((lat - lv.lat0) / lv.dlat) - y0;
    const o = j * cw * 4;
    if (gy < 0 || gy >= h) { for (let i = 0; i < cw; i++) px[o + i * 4 + 3] = 0; continue; }
    const row = gy * w;
    for (let i = 0; i < cw; i++) {
      const lon = W + (i / (cw - 1)) * (E - W);
      const gx = Math.round((lon - lv.lon0) / lv.dlon) - x0;
      const p = o + i * 4;
      if (gx < 0 || gx >= w) { px[p + 3] = 0; continue; }
      const v = sc[row + gx];
      if (!(v > 0)) { px[p + 3] = 0; continue; }
      const t = Math.sqrt(clamp((v - lo) / (hi - lo), 0, 1));
      const f = t * last, kk = Math.min(last - 1, f | 0), g = f - kk;
      px[p]     = ramp[kk][0] + (ramp[kk + 1][0] - ramp[kk][0]) * g;
      px[p + 1] = ramp[kk][1] + (ramp[kk + 1][1] - ramp[kk][1]) * g;
      px[p + 2] = ramp[kk][2] + (ramp[kk + 1][2] - ramp[kk][2]) * g;
      px[p + 3] = (0.22 + 0.72 * t) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const src = map.getSource('ov');
  if (src) {
    cv.toBlob(b => {
      const url = URL.createObjectURL(b);
      src.updateImage({ url, coordinates: [[W, N], [E, N], [E, S], [W, S]] });
      const stale = objUrl;
      if (stale) setTimeout(() => URL.revokeObjectURL(stale), 4000);
      objUrl = url;
    }, 'image/png');
  }
}

function topSpots(vwin, sc, count = 10) {
  const { w, h, lv, x0, y0 } = vwin;
  const sep = Math.max(3, Math.round(2000 / lv.step_m));
  const a = Float32Array.from(sc), out = [];
  for (let k = 0; k < count; k++) {
    let best = 0, bi = -1;
    for (let c = 0; c < a.length; c++) if (a[c] > best) { best = a[c]; bi = c; }
    if (bi < 0) break;
    const y = (bi / w) | 0, x = bi % w;
    out.push({ km: best / 1000,
               lat: lv.lat0 + (y + y0) * lv.dlat,
               lon: lv.lon0 + (x + x0) * lv.dlon });
    for (let dy = -sep; dy <= sep; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      for (let dx = -sep; dx <= sep; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= w) continue;
        a[yy * w + xx] = 0;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------- frame */

let lastElev = null;
function scheduleRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (!map || !map.isStyleLoaded()) { setTimeout(scheduleRender, 120); return; }
    const t0 = performance.now();
    const vwin = viewWindow();
    const stat = document.getElementById('stat');
    if (!vwin) { stat.textContent = 'outside the region'; return; }
    const data = gather(vwin);
    lastElev = { vwin, elev: data.elev };
    const sc = score(vwin, data);
    let top = 0;
    for (let i = 0; i < sc.length; i++) if (sc[i] > top) top = sc[i];
    draw(vwin, sc, top);
    const spots = topSpots(vwin, sc);
    placeMarkers(spots);
    evict();
    document.getElementById('busy').hidden = inflight.size === 0;

    const sp = wheel.span();
    stat.innerHTML =
      (sp >= 359.8 ? 'all directions'
        : `${wheel.start.toFixed(0)}°–${wheel.end.toFixed(0)}° (${sp.toFixed(0)}°)`)
      + ` · best ${spots.length ? spots[0].km.toFixed(1) : '—'} km`
      + `<span class="dim"> · ${vwin.lv.step_m} m grid · ${(performance.now() - t0) | 0} ms`
      + (data.missing ? ` · ${data.missing} tiles loading` : '') + '</span>';
  });
}

function placeMarkers(spots) {
  markers.forEach(m => m.remove());
  markers = spots.map((sp, i) => {
    const el = document.createElement('div');
    el.className = 'spot'; el.textContent = i + 1;
    const pop = new maplibregl.Popup({ offset: 14 }).setHTML(
      `<b>#${i + 1} — ${sp.km.toFixed(1)} km</b><br>${sp.lat.toFixed(5)}, ${sp.lon.toFixed(5)}<br>` +
      `<a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/?api=1&query=${sp.lat.toFixed(5)},${sp.lon.toFixed(5)}">open in Google Maps</a>`);
    return new maplibregl.Marker({ element: el }).setLngLat([sp.lon, sp.lat])
      .setPopup(pop).addTo(map);
  });
}

function elevationAt(lat, lon) {
  if (!lastElev) return '';
  const { vwin, elev } = lastElev, lv = vwin.lv;
  const gy = Math.round((lat - lv.lat0) / lv.dlat) - vwin.y0;
  const gx = Math.round((lon - lv.lon0) / lv.dlon) - vwin.x0;
  if (gy < 0 || gx < 0 || gy >= vwin.h || gx >= vwin.w) return 'outside the region';
  const v = elev[gy * vwin.w + gx];
  return v === -32768 ? 'no data' : `${v} m`;
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
  ramp = ['#FFF3E0', '#FBD89B', '#F5B35A', '#E8891C', '#C4620A', '#853B06', '#431C02']
    .map(h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16)));
  meta.ramp = ['#FFF3E0', '#FBD89B', '#F5B35A', '#E8891C', '#C4620A', '#853B06', '#431C02'];
  buildUI();
  buildMap();
})();

function buildUI() {
  document.querySelector('#range .fill').style.background =
    `linear-gradient(90deg, ${meta.ramp.join(',')})`;

  wheel = new DirectionWheel(document.getElementById('wheel'), scheduleRender,
                           meta.azimuths);
  range = new RangeSlider(document.getElementById('range'), {
    max: meta.max_dist_km, lo: 0, hi: meta.max_dist_km, onChange: scheduleRender });
  window.range = range; window.wheel = wheel;
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
    b.setAttribute('aria-pressed', String(e.cm === state.eye));
    b.innerHTML = `${e.cm === 0 ? 'Ground' : e.cm === 170 ? 'Standing' : 'Second floor'}<em>${e.m} m</em>`;
    eyes.appendChild(b);
  }
  eyes.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    [...eyes.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)));
    state.eye = +b.dataset.v; scheduleRender();
  });

  document.getElementById('base').addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    [...ev.currentTarget.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)));
    state.base = b.dataset.v;
    map.setLayoutProperty('base-sat', 'visibility', state.base === 'sat' ? 'visible' : 'none');
    map.setLayoutProperty('base-osm', 'visibility', state.base === 'osm' ? 'visible' : 'none');
  });

  document.getElementById('water').addEventListener('change', e => {
    state.waterOnly = e.target.checked; scheduleRender();
  });

  document.getElementById('bare').addEventListener('change', e => {
    state.veg = e.target.checked ? 'bare' : 'trees'; scheduleRender();
  });

  // "Skip spots in forest" is the site filter as a plain switch: 2 m of cover
  // is the line between standing in the open and standing under trees.
  document.getElementById('openonly').addEventListener('change', e => {
    state.siteMax = e.target.checked ? OPEN_GROUND_M : 99;
    scheduleRender();
  });

  const slope = document.getElementById('slope');
  const showSlope = () => {
    // Degrees are abstract at this scale - almost everything useful sits under
    // one degree - so show the equivalent drop per kilometre alongside.
    const el = document.getElementById('slopev');
    if (state.minDrop <= 0) { el.textContent = 'any'; return; }
    const mPerKm = Math.tan(state.minDrop * Math.PI / 180) * 1000;
    el.textContent = `≥ ${state.minDrop.toFixed(2)}° · ${mPerKm.toFixed(0)} m/km`;
  };
  slope.addEventListener('input', () => {
    state.minDrop = +slope.value / 100;
    showSlope(); scheduleRender();
  });
  showSlope();
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

  // On a phone the panel is a bottom sheet: tapping its title bar hands the
  // screen back to the map. On a desktop the bar is not a control at all.
  const panel = document.getElementById('panel');
  const bar = document.getElementById('sheetbar');
  const narrow = matchMedia('(max-width: 720px)');
  // The map's own controls sit just above the sheet's collapsed height, which
  // is the title bar plus the readout - both of which stay on screen when the
  // sheet is shut. Measured rather than guessed, so it survives a long stat
  // line wrapping to two rows.
  const fitBar = () => document.documentElement.style.setProperty('--bar',
    (bar.offsetHeight + document.getElementById('stat').offsetHeight) + 'px');
  bar.addEventListener('click', () => {
    if (!narrow.matches) return;
    panel.dataset.open = panel.dataset.open === 'false' ? 'true' : 'false';
  });
  // The readout starts empty and grows once a frame has been scored, so it is
  // observed rather than measured once at boot.
  const ro = new ResizeObserver(fitBar);
  ro.observe(bar);
  ro.observe(document.getElementById('stat'));
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
  fetchBuffer(ver('layers/contours_region' + (meta.geojson_ext || '.geojson')))
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
    attributionControl: { compact: MOBILE },
  });
  window.map = map;
  map.addControl(new maplibregl.NavigationControl({ showCompass: !MOBILE }),
                 'bottom-right');
  // The question on a road trip is "what is around me", which wants the
  // device's own position rather than a search box.
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true, showUserLocation: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), 'bottom-left');
  map.on('load', () => { setClarity(+document.getElementById('clarity').value); scheduleRender(); });
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
