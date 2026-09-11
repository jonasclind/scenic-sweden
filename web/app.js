import { DirectionWheel, RangeSlider, sunsetAzimuth } from './controls.js';

const CANVAS = 1024;                       // Mercator-aligned overlay resolution
const state = { base: 'sat', veg: 'trees', waterOnly: false };
let D, data, wheel, range, map, markers = [], srcRow, srcCol, ramp;

const BLANK = (() => {                       // a 1x1 transparent seed image
  const c = document.createElement('canvas'); c.width = c.height = 1;
  return c.toDataURL();
})();
let objUrl = null;

const mercY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const invMercY = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

const bin = (p, T) => fetch(p).then(r => r.arrayBuffer()).then(b => new T(b));

(async function () {
  data = await fetch('data.json').then(r => r.json());
  ramp = data.ramp.map(h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16)));
  D = {};
  for (const tag of data.states) {
    D[tag] = {
      dist: await bin(`layers/dist_${tag}.bin`, Uint8Array),
      water: await bin(`layers/water_${tag}.bin`, Uint32Array),
      valid: await bin(`layers/valid_${tag}.bin`, Uint8Array),
    };
  }
  buildLookup();
  buildUI();
  buildMap();
})();

/* Mercator is separable, so one row table and one column table suffice. */
function buildLookup() {
  const [W, S, E, N] = data.bounds, n = data.n;
  srcRow = new Int32Array(CANVAS);
  srcCol = new Int32Array(CANVAS);
  const myN = mercY(N), myS = mercY(S);
  for (let j = 0; j < CANVAS; j++) {
    const lat = invMercY(myN + (j / (CANVAS - 1)) * (myS - myN));
    const f = (lat - S) / (N - S) * (n - 1);          // data row 0 is the south edge
    srcRow[j] = Math.max(0, Math.min(n - 1, Math.round(f)));
  }
  for (let i = 0; i < CANVAS; i++) {
    const f = (i / (CANVAS - 1)) * (n - 1);
    srcCol[i] = Math.max(0, Math.min(n - 1, Math.round(f)));
  }
}

function selection() {
  const A = data.azimuths, bins = [];
  let mask = 0;
  for (let b = 0; b < A; b++) {
    if (wheel.covers(b * 360 / A)) { bins.push(b); mask |= (1 << b); }
  }
  return { bins, mask };
}

function computeScore() {
  const n = data.n, A = data.azimuths, cells = n * n;
  const { bins, mask } = selection();
  const d = D[state.veg], k = data.max_dist_km * 1000 / 255;
  const raw = new Float32Array(cells);
  const loM = range.lo * 1000;
  const hiM = range.capped() ? Infinity : range.hi * 1000;

  for (let c = 0; c < cells; c++) {
    if (!d.valid[c]) continue;
    if (state.waterOnly && !(d.water[c] & mask)) continue;
    let sum = 0, base = c * A;
    for (let i = 0; i < bins.length; i++) sum += d.dist[base + bins[i]];
    const v = sum / bins.length * k;
    raw[c] = (v >= loM && v <= hiM) ? v : 0;
  }

  // 25th percentile over a 3x3 patch: the score must hold up across a plot, not
  // at a point, and a single blind cell must not condemn its neighbours.
  const out = new Float32Array(cells);
  const w = new Float32Array(9);
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      let m = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) w[m++] = raw[(y + dy) * n + x + dx];
      for (let i = 0; i < 3; i++) {                 // partial selection sort
        let mi = i;
        for (let j = i + 1; j < 9; j++) if (w[j] < w[mi]) mi = j;
        const t = w[i]; w[i] = w[mi]; w[mi] = t;
      }
      out[y * n + x] = w[2];
    }
  }
  return out;
}

function draw(score, top) {
  const cv = document.getElementById('ovcanvas');
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(CANVAS, CANVAS);
  const px = img.data;
  // When the upper handle is at "and above" there is no ceiling to colour
  // against, and using the slider's 20 km would paint every survivor in the
  // palest step - worst for exactly the spots the filter just isolated. Colour
  // against what is actually on screen instead.
  const lo = range.lo * 1000;
  const hi = range.capped() ? Math.max(top, lo + 500) : range.hi * 1000;
  const n = data.n, last = ramp.length - 1;

  for (let j = 0; j < CANVAS; j++) {
    const row = srcRow[j] * n, o = j * CANVAS * 4;
    for (let i = 0; i < CANVAS; i++) {
      const v = score[row + srcCol[i]], p = o + i * 4;
      if (!(v > 0)) { px[p + 3] = 0; continue; }
      // sqrt to match the slider: the distribution is long-tailed
      const t = Math.sqrt(Math.max(0, Math.min(1, (v - lo) / (hi - lo))));
      const f = t * last, k = Math.min(last - 1, f | 0), g = f - k;
      px[p]     = ramp[k][0] + (ramp[k + 1][0] - ramp[k][0]) * g;
      px[p + 1] = ramp[k][1] + (ramp[k + 1][1] - ramp[k][1]) * g;
      px[p + 2] = ramp[k][2] + (ramp[k + 1][2] - ramp[k][2]) * g;
      px[p + 3] = (0.25 + 0.60 * t) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function topSpots(score, count = 10, sep = 20) {
  const n = data.n, a = Float32Array.from(score), out = [];
  const [W, S, E, N] = data.bounds;
  for (let k = 0; k < count; k++) {
    let best = -1, bi = -1;
    for (let c = 0; c < a.length; c++) if (a[c] > best) { best = a[c]; bi = c; }
    if (!(best > 0)) break;
    const y = (bi / n) | 0, x = bi % n;
    out.push({
      km: best / 1000,
      lat: S + (y / (n - 1)) * (N - S),
      lon: W + (x / (n - 1)) * (E - W),
    });
    for (let dy = -sep; dy <= sep; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= n) continue;
      for (let dx = -sep; dx <= sep; dx++) {
        const xx = x + dx; if (xx < 0 || xx >= n) continue;
        a[yy * n + xx] = -1;
      }
    }
  }
  return out;
}

let pending = false;
function refresh() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const t0 = performance.now();
    const score = computeScore();
    let top = 0;
    for (let i = 0; i < score.length; i++) if (score[i] > top) top = score[i];
    draw(score, top);
    const spots = topSpots(score);

    const src = map && map.getSource('ov');
    if (src) {
      document.getElementById('ovcanvas').toBlob(b => {
        const url = URL.createObjectURL(b);
        src.updateImage({ url });
        const stale = objUrl;                    // let the in-flight load finish
        if (stale) setTimeout(() => URL.revokeObjectURL(stale), 4000);
        objUrl = url;
      }, 'image/png');
    }
    if (map) placeMarkers(spots);

    const sp = wheel.span();
    const n = spots.length;
    document.getElementById('stat').innerHTML =
      `${sp >= 359.8 ? 'all directions' : `${wheel.start.toFixed(0)}°–${wheel.end.toFixed(0)}° (${sp.toFixed(0)}° wide)`}`
      + ` &middot; best ${n ? spots[0].km.toFixed(1) : '—'} km`
      + `<span class="dim"> &middot; ${(performance.now() - t0).toFixed(0)} ms</span>`;
  });
}

function placeMarkers(spots) {
  markers.forEach(m => m.remove());
  markers = spots.map((sp, i) => {
    const el = document.createElement('div');
    el.className = 'spot';
    el.textContent = i + 1;
    const pop = new maplibregl.Popup({ offset: 14 }).setHTML(
      `<b>#${i + 1} &mdash; ${sp.km.toFixed(1)} km</b><br>` +
      `${sp.lat.toFixed(5)}, ${sp.lon.toFixed(5)}<br>` +
      `<a target="_blank" href="https://www.google.com/maps/search/?api=1&query=${sp.lat.toFixed(5)},${sp.lon.toFixed(5)}">open in Google Maps</a>`);
    return new maplibregl.Marker({ element: el }).setLngLat([sp.lon, sp.lat])
      .setPopup(pop).addTo(map);
  });
}

function buildUI() {
  document.querySelector('#range .fill').style.background =
    `linear-gradient(90deg, ${data.ramp.join(',')})`;
  document.getElementById('canopy').textContent = data.canopy_m;

  const cv = document.getElementById('ovcanvas');
  cv.width = cv.height = CANVAS;

  wheel = new DirectionWheel(document.getElementById('wheel'), refresh);
  range = new RangeSlider(document.getElementById('range'), {
    max: data.max_dist_km, lo: 0, hi: data.max_dist_km, onChange: refresh });
  renderTicks();
  window.range = range; window.wheel = wheel;   // handy from the console

  document.getElementById('presets').addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    const v = b.dataset.v;
    if (v === 'all') wheel.set(0, 359.9);
    else if (v === 'sunset') {
      const doy = Math.floor((Date.now() - Date.UTC(new Date().getFullYear(), 0, 0)) / 864e5);
      const az = sunsetAzimuth(data.centre[0], doy);
      wheel.set(az - 25, az + 25);
    } else { const a = +v; wheel.set(a - 45, a + 45); }
  });

  for (const grp of ['base', 'view'])
    document.getElementById(grp).addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      [...ev.currentTarget.children].forEach(c => c.setAttribute('aria-pressed', String(c === b)));
      if (grp === 'base') {
        state.base = b.dataset.v;
        map.setLayoutProperty('base-sat', 'visibility', state.base === 'sat' ? 'visible' : 'none');
        map.setLayoutProperty('base-osm', 'visibility', state.base === 'osm' ? 'visible' : 'none');
      } else { state.waterOnly = b.dataset.v === 'water'; refresh(); }
    });

  document.getElementById('bare').addEventListener('change', e => {
    state.veg = e.target.checked ? 'bare' : 'trees'; refresh();
  });
  document.getElementById('op').addEventListener('input', e => {
    map.setPaintProperty('ov', 'raster-opacity', e.target.value / 100);
  });
}

/* Ticks sit at their square-root positions so they line up with the slider. */
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

function buildMap() {
  const [W, S, E, N] = data.bounds;
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
        // An image source fed from a blob, not a canvas source. MapLibre's
        // canvas upload path drops per-texel alpha here, which painted the
        // whole box opaque black; the image path honours it.
        ov: { type: 'image', url: BLANK,
          coordinates: [[W, N], [E, N], [E, S], [W, S]] },
      },
      layers: [
        { id: 'base-sat', type: 'raster', source: 'sat' },
        { id: 'base-osm', type: 'raster', source: 'osm', layout: { visibility: 'none' } },
        { id: 'ov', type: 'raster', source: 'ov',
          paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 } },
      ],
    },
    center: [data.centre[1], data.centre[0]], zoom: 9.4,
    attributionControl: { compact: false },
  });
  window.map = map;
  map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), 'bottom-left');
  map.on('load', refresh);
  map.on('click', e => {
    if (e.originalEvent.target.closest('.spot')) return;
    const { lat, lng } = e.lngLat;
    new maplibregl.Popup().setLngLat(e.lngLat).setHTML(
      `${lat.toFixed(5)}, ${lng.toFixed(5)}<br>` +
      `<a target="_blank" href="https://www.google.com/maps/search/?api=1&query=${lat.toFixed(5)},${lng.toFixed(5)}">open in Google Maps</a>`
    ).addTo(map);
  });
}
