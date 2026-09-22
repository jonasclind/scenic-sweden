/* Where the sun is, and which ground can see it.
 *
 * Two pieces that only meet at the end: NOAA's solar position algorithm, and a
 * shadow sweep over the terrain. Neither knows anything about the rest of the
 * app.
 */

const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;
const mod = (v, m) => ((v % m) + m) % m;

/* Refraction near the horizon, NOAA's piecewise fit, in degrees.
 *
 * This is not a rounding detail. At the horizon the atmosphere lifts the sun
 * by about 0.57 degrees - more than its own diameter - which is exactly why
 * you can still watch it after it has geometrically set. A sunset tool that
 * ignored it would close the show a couple of minutes early. */
function refraction(e) {
  if (e > 85) return 0;
  const t = Math.tan(rad(e));
  let r;
  if (e > 5) r = 58.1 / t - 0.07 / t ** 3 + 0.000086 / t ** 5;
  else if (e > -0.575) r = 1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)));
  else r = -20.772 / t;
  return r / 3600;
}

/* The part of the solar algorithm that depends only on the instant, not the
 * place. Everything here is UTC: going through a local timezone would only be
 * a chance to get an hour wrong twice a year. */
function solarParams(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525.0;

  const L0 = mod(280.46646 + T * (36000.76983 + T * 0.0003032), 360);
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const ecc = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const ctr = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T))
            + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T)
            + Math.sin(rad(3 * M)) * 0.000289;

  const omega = 125.04 - 1934.136 * T;
  const appLong = L0 + ctr - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const meanObliq = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(obliq)) * Math.sin(rad(appLong))));

  const vy = Math.tan(rad(obliq / 2)) ** 2;
  const eqTime = 4 * deg(
      vy * Math.sin(2 * rad(L0))
    - 2 * ecc * Math.sin(rad(M))
    + 4 * ecc * vy * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
    - 0.5 * vy * vy * Math.sin(4 * rad(L0))
    - 1.25 * ecc * ecc * Math.sin(2 * rad(M)));

  const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes()
               + date.getUTCSeconds() / 60;
  return { decl, eqTime, utcMin };
}

/* Sun azimuth (degrees clockwise from north) and apparent elevation, for a
 * moment and a place. Good to about 0.01 degrees over the years this will see,
 * which is far finer than the terrain grid it gets compared against. */
export function sunPosition(date, lat, lon) {
  const { decl, eqTime, utcMin } = solarParams(date);
  const ha = mod(utcMin + eqTime + 4 * lon, 1440) / 4 - 180;

  const cosZ = Math.sin(rad(lat)) * Math.sin(rad(decl))
             + Math.cos(rad(lat)) * Math.cos(rad(decl)) * Math.cos(rad(ha));
  const zenith = deg(Math.acos(Math.min(1, Math.max(-1, cosZ))));
  const geometric = 90 - zenith;

  const sinZ = Math.sin(rad(zenith));
  let azimuth;
  if (Math.abs(sinZ) < 1e-9) {
    azimuth = 180;                       // sun overhead: bearing is undefined
  } else {
    const c = (Math.sin(rad(lat)) * Math.cos(rad(zenith)) - Math.sin(rad(decl)))
            / (Math.cos(rad(lat)) * sinZ);
    const a = deg(Math.acos(Math.min(1, Math.max(-1, c))));
    azimuth = ha > 0 ? mod(a + 180, 360) : mod(540 - a, 360);
  }
  // The geometric elevation comes back too: sunrise and sunset are defined
  // against it (-0.833 degrees, which already allows for refraction and the
  // sun's own radius), not against the apparent one.
  return { azimuth, elevation: geometric + refraction(geometric), geometric,
           declination: decl, eqTime };
}

/* The local clock time of sunset (or sunrise) on a given day, as a Date, or
 * null where the sun does not cross the horizon at all. Found by scanning the
 * day a minute at a time, which is exact enough for a control that only offers
 * whole minutes and costs nothing at 1440 evaluations. */
export function horizonCrossing(date, lat, lon, setting = true) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let prev = null;
  for (let t = 0; t <= 1440; t++) {
    const at = new Date(day.getTime() + t * 60000);
    const up = sunPosition(at, lat, lon).geometric > -0.833;
    if (prev !== null && prev !== up && up !== setting) return at;
    prev = up;
  }
  return null;
}

/* Half the sun's apparent width. "Can you see the sun" is a question about the
 * upper limb, not the centre - the two are nearly three minutes apart at these
 * latitudes, and the whole of a sunset happens inside that gap. */
const SEMIDIAMETER = 0.2665;

/* tan(apparent elevation of the sun's upper limb) for every cell of a lat/lon
 * grid, at one instant.
 *
 * Per cell, not one value for the window: across the whole region the sun's
 * elevation varies by four and a half degrees, which around sunset is the
 * difference between broad daylight and an hour past dark. It is affordable
 * because the costly part of the algorithm depends only on the date, and what
 * is left factors into a per-row term and a per-column one. Away from the
 * horizon the per-cell work is then a square root, since sin(elevation) is
 * what the factoring hands you; only within five degrees of the horizon, where
 * refraction has to be taken seriously, does it cost an arcsine.
 */
export function solarTanField(date, lat0, dlat, lon0, dlon, w, h) {
  const { decl, eqTime, utcMin } = solarParams(date);
  const sinDecl = Math.sin(rad(decl)), cosDecl = Math.cos(rad(decl));

  const A = new Float64Array(h), B = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    const la = rad(lat0 + y * dlat);
    A[y] = Math.sin(la) * sinDecl;
    B[y] = Math.cos(la) * cosDecl;
  }
  const C = new Float64Array(w);
  for (let x = 0; x < w; x++)
    C[x] = Math.cos(rad(mod(utcMin + eqTime + 4 * (lon0 + x * dlon), 1440) / 4 - 180));

  /* Near the horizon every cell needs refraction and the sun's own radius, and
   * at a region-wide sunset that is every cell there is. Doing it exactly costs
   * an arcsine and a tangent apiece, which measured at half a second a frame.
   *
   * At these angles both can be replaced by their leading terms: asin(s) is
   * s(1 + s^2/6), tan of a small angle is the angle, and adding a correction c
   * to a small angle adds c to its tangent. Checked against the exact form over
   * the whole band, the worst error is far below the sun's own radius. */
  const near = s => {
    const e = deg(s * (1 + s * s / 6));
    let r;
    if (e > -0.575) r = 1735 + e * (-518.2 + e * (103.4 + e * (-12.79 + e * 0.711)));
    else r = -20.772 / rad(e);
    return s / Math.sqrt(1 - s * s) + rad(r / 3600 + SEMIDIAMETER);
  };

  const SIN5 = Math.sin(rad(5));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const a = A[y], b = B[y], row = y * w;
    for (let x = 0; x < w; x++) {
      const s = a + b * C[x];                      // sin(centre elevation)
      if (s > SIN5) {
        // Well clear of the horizon both corrections are lost in the noise,
        // and sin is already in hand, so tan costs one square root.
        out[row + x] = s / Math.sqrt(1 - s * s);
      } else {
        out[row + x] = near(s);
      }
    }
  }
  return out;
}

const FAR = -1e9;      // "no blocker yet"; a sentinel rather than -Infinity so
                       // that interpolating between two of them stays a number

/* How far below the astronomical horizon the terrain is still allowed to argue
 * that the sun is in view.
 *
 * Standing high with the ground falling away, your horizon dips by
 * sqrt(2z/R) - 0.58 degrees for the 380 m of relief this region has - and
 * inside that band a hilltop genuinely sees a sun that has set for the valley
 * below. That band is the entire point of the feature, so it cannot be gated
 * away. Past it the sweep is cut off outright: deep at night the only cells it
 * could call lit are ones at the very edge of the loaded terrain, where there
 * is no data up-sun to cast a shadow. One degree covers relief up to 1,100 m. */
const NIGHT_TAN = Math.tan(rad(-1));

/* Which cells can see the sun.
 *
 * The obvious method - march every cell's ray towards the sun and look for
 * anything above it - is a couple of hundred samples per cell, which for a
 * screenful is a hundred million and takes seconds. This sweeps the grid once
 * instead, in the sun's direction, carrying the shadow envelope from each line
 * to the next: the envelope at a cell is whatever the previous line reached,
 * dropped by one step's worth of the sun's angle.
 *
 * The step is a whole row (or column, whichever the sun is more aligned with),
 * so the two cells being interpolated always lie on a line that is already
 * finished and the recurrence is well ordered. That is what makes it
 * O(cells) rather than O(cells x ray).
 *
 * `tanE` carries the sun's angle per cell, and dropping the envelope by the
 * *local* angle at each step is what accounts for the curve of the earth: the
 * sun stands higher by one part in R_earth for every metre you walk towards
 * it, so a ray integrated along the path falls short of a flat-earth one by
 * u^2/2R - exactly the curvature term. What it misses is refraction's effect
 * on that term, 13% of 27 m over the longest shadow this terrain can throw.
 *
 * `block` is what stops light - ground plus canopy - and `eye` is where the
 * observer's eyes are. Both are heights in metres over the same grid. A single
 * azimuth is used for the whole grid: it varies by three degrees across the
 * full region, which slews a ten-kilometre shadow sideways by less than one
 * 400 m cell.
 */
export function sunlitMask(block, eye, tanE, w, h, azimuth, stepM) {
  const ux = Math.sin(rad(azimuth)), uy = Math.cos(rad(azimuth));
  // Sweep along whichever axis the sun leans towards, so one step is one whole
  // line and the cross-line drift stays inside a single cell.
  const rows = Math.abs(uy) >= Math.abs(ux);
  const nMaj = rows ? h : w, nMin = rows ? w : h;
  const sMaj = rows ? w : 1, sMin = rows ? 1 : w;
  const uMaj = rows ? uy : ux, uMin = rows ? ux : uy;

  const dir = uMaj > 0 ? 1 : -1;                  // one step towards the sun
  const off = uMin / Math.abs(uMaj);              // cross-line drift per step
  const span = stepM * Math.sqrt(1 + off * off);  // metres covered by that step

  const S = new Float32Array(w * h);
  const env = new Float32Array(nMin);
  const start = dir > 0 ? nMaj - 1 : 0, stop = dir > 0 ? -1 : nMaj;

  for (let m = start; m !== stop; m -= dir) {
    const src = m + dir, base = m * sMaj;
    if (src < 0 || src >= nMaj) {                 // nothing beyond the edge
      for (let k = 0; k < nMin; k++) S[base + k * sMin] = FAR;
      continue;
    }
    const sbase = src * sMaj;
    for (let k = 0; k < nMin; k++) {
      const i = sbase + k * sMin;
      env[k] = block[i] > S[i] ? block[i] : S[i];
    }
    for (let k = 0; k < nMin; k++) {
      const i = base + k * sMin;
      const p = k + off;
      // Past the end of the line there is no data, so cast no shadow. Clamping
      // to the edge cell instead smears it outwards for ever, which builds a
      // wall of false shadow along the sun-ward border - measurably, it was
      // 95% of this sweep's disagreement with a brute-force ray march.
      if (p < 0 || p > nMin - 1) { S[i] = FAR; continue; }
      const i0 = p | 0, f = p - i0;
      const i1 = i0 + 1 < nMin ? i0 + 1 : i0;
      S[i] = env[i0] + (env[i1] - env[i0]) * f - tanE[i] * span;
    }
  }

  const lit = new Uint8Array(w * h);
  for (let c = 0; c < lit.length; c++)
    lit[c] = (tanE[c] > NIGHT_TAN && eye[c] >= S[c]) ? 1 : 0;
  return lit;
}
