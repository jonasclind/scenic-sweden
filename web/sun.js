/* Where the sun is, and which ground can see it.
 *
 * Two independent pieces: NOAA's solar position algorithm, and a shadow sweep
 * over a height grid. Neither knows anything about the rest of the app.
 */

const rad = deg => deg * Math.PI / 180;
const deg = rad => rad * 180 / Math.PI;
const wrap = (value, period) => ((value % period) + period) % period;
const clampUnit = v => (v > 1 ? 1 : v < -1 ? -1 : v);

/* Half the sun's apparent width. "Can you see the sun" is a question about the
 * upper limb, not the centre: the two are nearly three minutes apart at these
 * latitudes, and the whole of a sunset happens inside that gap. */
const SUN_SEMIDIAMETER_DEG = 0.2665;

/* Sunrise and sunset are defined against this geometric elevation of the
 * centre. The figure already carries refraction and the semidiameter, which is
 * why it is compared against the *un*refracted angle. */
const HORIZON_CROSSING_DEG = -0.833;

/* Atmospheric refraction in arcseconds, NOAA's piecewise fit.
 *
 * Not a rounding detail: at the horizon it lifts the sun by about 0.57
 * degrees, more than its own diameter, which is why you can still watch it
 * after it has geometrically set. */
function refractionArcsec(elevationDeg) {
  if (elevationDeg > 85) return 0;
  const tanElevation = Math.tan(rad(elevationDeg));
  if (elevationDeg > 5)
    return 58.1 / tanElevation - 0.07 / tanElevation ** 3
         + 0.000086 / tanElevation ** 5;
  if (elevationDeg > -0.575)
    return 1735 + elevationDeg * (-518.2 + elevationDeg
         * (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)));
  return -20.772 / tanElevation;
}

/* The half of the solar algorithm that depends only on the instant, not the
 * place. Names follow NOAA's published sheet closely enough to check against
 * it. Everything is UTC; routing through a local timezone would only be a
 * chance to be an hour wrong twice a year. */
function solarInstant(when) {
  const julianDay = when.getTime() / 86400000 + 2440587.5;
  const centuries = (julianDay - 2451545.0) / 36525.0;
  const t = centuries;

  const meanLongitude = wrap(280.46646 + t * (36000.76983 + t * 0.0003032), 360);
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const equationOfCentre =
      Math.sin(rad(meanAnomaly)) * (1.914602 - t * (0.004817 + 0.000014 * t))
    + Math.sin(rad(2 * meanAnomaly)) * (0.019993 - 0.000101 * t)
    + Math.sin(rad(3 * meanAnomaly)) * 0.000289;

  const moonNode = 125.04 - 1934.136 * t;
  const apparentLongitude = meanLongitude + equationOfCentre
    - 0.00569 - 0.00478 * Math.sin(rad(moonNode));
  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos(rad(moonNode));
  const declination =
    deg(Math.asin(Math.sin(rad(obliquity)) * Math.sin(rad(apparentLongitude))));

  const y = Math.tan(rad(obliquity / 2)) ** 2;
  const equationOfTimeMin = 4 * deg(
      y * Math.sin(2 * rad(meanLongitude))
    - 2 * eccentricity * Math.sin(rad(meanAnomaly))
    + 4 * eccentricity * y * Math.sin(rad(meanAnomaly))
        * Math.cos(2 * rad(meanLongitude))
    - 0.5 * y * y * Math.sin(4 * rad(meanLongitude))
    - 1.25 * eccentricity * eccentricity * Math.sin(2 * rad(meanAnomaly)));

  const minutesUtc = when.getUTCHours() * 60 + when.getUTCMinutes()
                   + when.getUTCSeconds() / 60;
  return { declination, equationOfTimeMin, minutesUtc };
}

/** Hour angle in degrees: 0 at local solar noon, +15 per hour after it. */
function hourAngleDeg({ equationOfTimeMin, minutesUtc }, lonDeg) {
  return wrap(minutesUtc + equationOfTimeMin + 4 * lonDeg, 1440) / 4 - 180;
}

/* Sun azimuth (degrees clockwise from north) and elevation, for a moment and a
 * place. Good to about 0.01 degrees over the years this will see, far finer
 * than the terrain grid it gets compared against. */
export function sunPosition(when, latDeg, lonDeg) {
  const instant = solarInstant(when);
  const { declination } = instant;
  const hourAngle = hourAngleDeg(instant, lonDeg);

  const cosZenith = Math.sin(rad(latDeg)) * Math.sin(rad(declination))
    + Math.cos(rad(latDeg)) * Math.cos(rad(declination)) * Math.cos(rad(hourAngle));
  const zenith = deg(Math.acos(clampUnit(cosZenith)));
  const geometric = 90 - zenith;

  const sinZenith = Math.sin(rad(zenith));
  let azimuth = 180;                     // sun overhead: bearing is undefined
  if (Math.abs(sinZenith) > 1e-9) {
    const cosAzimuth =
      (Math.sin(rad(latDeg)) * Math.cos(rad(zenith)) - Math.sin(rad(declination)))
      / (Math.cos(rad(latDeg)) * sinZenith);
    const fromNorth = deg(Math.acos(clampUnit(cosAzimuth)));
    azimuth = hourAngle > 0 ? wrap(fromNorth + 180, 360) : wrap(540 - fromNorth, 360);
  }
  return {
    azimuth,
    geometric,                                                   // unrefracted
    elevation: geometric + refractionArcsec(geometric) / 3600,   // as it looks
    declination,
  };
}

/* The clock time at which the sun sets (or rises) on a given day, or null on a
 * day where it does not cross at all. Scanned a minute at a time: exact enough
 * for a control that only offers whole minutes, and 1440 evaluations is
 * nothing. */
export function horizonCrossing(onDay, latDeg, lonDeg, setting = true) {
  const midnight = new Date(onDay.getFullYear(), onDay.getMonth(), onDay.getDate());
  let wasUp = null;
  for (let minute = 0; minute <= 1440; minute++) {
    const at = new Date(midnight.getTime() + minute * 60000);
    const isUp = sunPosition(at, latDeg, lonDeg).geometric > HORIZON_CROSSING_DEG;
    if (wasUp !== null && wasUp !== isUp && isUp !== setting) return at;
    wasUp = isUp;
  }
  return null;
}

const SIN_5_DEG = Math.sin(rad(5));
const SIN_85_DEG = Math.sin(rad(85));

/* tan of the apparent elevation of the sun's upper limb, given sin of the true
 * elevation of its centre.
 *
 * Both corrections are wanted at every angle - refraction is still 0.16 degrees
 * at five degrees up, and the limb is always 0.27 above the centre - so they
 * cannot be branched away above some threshold without leaving a step in the
 * mask. Instead the correction is carried onto the tangent through its own
 * derivative, sec^2 = 1 + tan^2, which keeps the whole field free of arcsines
 * and tangents. Measured against the exact form the worst error is a small
 * fraction of the sun's own radius. */
function tanApparentLimb(sinCentreElevation) {
  const s = sinCentreElevation;
  const tanCentre = s / Math.sqrt(1 - s * s);
  // Near the zenith refraction has gone and no ground can shadow anything, so
  // the raw tangent is answer enough - which is as well, since the derivative
  // below runs away as tan does.
  if (s > SIN_85_DEG) return tanCentre;

  let arcsec;
  if (s > SIN_5_DEG) {
    arcsec = 58.1 / tanCentre - 0.07 / tanCentre ** 3 + 0.000086 / tanCentre ** 5;
  } else {
    // NOAA switches to a polynomial in the angle itself down here, and
    // asin(s) = s(1 + s^2/6) is good to a millionth of a radian this low.
    const elevationDeg = deg(s * (1 + s * s / 6));
    arcsec = elevationDeg > -0.575
      ? 1735 + elevationDeg * (-518.2 + elevationDeg
          * (103.4 + elevationDeg * (-12.79 + elevationDeg * 0.711)))
      : -20.772 / rad(elevationDeg);
  }
  const lift = rad(arcsec / 3600 + SUN_SEMIDIAMETER_DEG);
  return tanCentre + lift * (1 + tanCentre * tanCentre);
}

/* tan(apparent elevation of the upper limb) for every cell of a lat/lon grid,
 * at one instant.
 *
 * Per cell, not one value for the window: across the whole region the sun's
 * elevation varies by four and a half degrees, which around sunset is the
 * difference between broad daylight and an hour past dark. It is affordable
 * because the costly half of the algorithm depends only on the instant, and
 * what is left factors into a per-row term and a per-column one. */
export function sunElevationTangents(when, grid) {
  const { lat0, dlat, lon0, dlon, width, height } = grid;
  const instant = solarInstant(when);
  const sinDeclination = Math.sin(rad(instant.declination));
  const cosDeclination = Math.cos(rad(instant.declination));

  const rowSinTerm = new Float64Array(height);
  const rowCosTerm = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    const lat = rad(lat0 + y * dlat);
    rowSinTerm[y] = Math.sin(lat) * sinDeclination;
    rowCosTerm[y] = Math.cos(lat) * cosDeclination;
  }
  const columnCosHourAngle = new Float64Array(width);
  for (let x = 0; x < width; x++)
    columnCosHourAngle[x] = Math.cos(rad(hourAngleDeg(instant, lon0 + x * dlon)));

  const tangents = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sinTerm = rowSinTerm[y], cosTerm = rowCosTerm[y], row = y * width;
    for (let x = 0; x < width; x++)
      tangents[row + x] = tanApparentLimb(sinTerm + cosTerm * columnCosHourAngle[x]);
  }
  return tangents;
}

/* Sentinel for "no blocker found yet". A number rather than -Infinity, so that
 * interpolating between two of them stays a number instead of going NaN. */
const NO_BLOCKER = -1e9;

/* How far below the astronomical horizon the terrain is still allowed to argue
 * that the sun is in view.
 *
 * Standing high with the ground falling away, your horizon dips by sqrt(2z/R) -
 * 0.58 degrees for the 380 m of relief this region has - and inside that band a
 * hilltop genuinely sees a sun the valley below has lost. That band is the
 * point of the whole feature, so it cannot be gated away at zero. Past it the
 * sweep is cut off outright: deep at night the only cells it could call lit are
 * ones at the edge of the loaded grid, where there is no data up-sun to cast a
 * shadow. One degree covers relief up to 1,100 m. */
const TAN_LOWEST_USEFUL_SUN = Math.tan(rad(-1));

/* Which cells can see the sun.
 *
 * Marching each cell's ray towards the sun would be a couple of hundred samples
 * per cell - a hundred million for a screenful, and seconds. This sweeps the
 * grid once in the sun's direction instead, carrying a shadow envelope from one
 * line to the next: the envelope at a cell is whatever the previous line
 * reached, dropped by one step's worth of the sun's angle. Stepping a whole
 * line at a time (rows or columns, whichever the sun leans towards) keeps the
 * two cells being interpolated on a line that is already finished, so the
 * recurrence is well ordered and the cost is O(cells) rather than
 * O(cells x ray).
 *
 * Dropping the envelope by the *local* angle at each step is what accounts for
 * the curve of the earth: the sun stands higher by one part in R for every
 * metre you walk towards it, so a ray integrated along the path falls short of
 * a flat-earth one by u^2/2R, which is exactly the curvature term. Only
 * refraction's share of it is missed, 13% of 27 m over the longest shadow this
 * terrain can throw.
 *
 * One azimuth serves the whole grid. It varies by three degrees across the full
 * region, which slews a ten-kilometre shadow sideways by less than one 400 m
 * cell.
 */
export function sunlitMask({ blockingHeight, eyeHeight, tanSunElevation,
                             width, height, azimuth, cellMetres }) {
  const east = Math.sin(rad(azimuth)), north = Math.cos(rad(azimuth));

  // Sweep along whichever axis the sun leans towards, so that one step is one
  // whole line and the drift across it stays inside a single cell.
  const alongRows = Math.abs(north) >= Math.abs(east);
  const lineCount = alongRows ? height : width;    // lines to sweep through
  const lineLength = alongRows ? width : height;   // cells on each line
  const lineStride = alongRows ? width : 1;        // index step between lines
  const cellStride = alongRows ? 1 : width;        // index step along a line
  const sunAlong = alongRows ? north : east;
  const sunAcross = alongRows ? east : north;

  const towardSun = sunAlong > 0 ? 1 : -1;
  const driftPerLine = sunAcross / Math.abs(sunAlong);
  const metresPerStep = cellMetres * Math.sqrt(1 + driftPerLine * driftPerLine);

  const shadowHeight = new Float32Array(width * height);
  const envelope = new Float32Array(lineLength);
  const firstLine = towardSun > 0 ? lineCount - 1 : 0;
  const pastLastLine = towardSun > 0 ? -1 : lineCount;

  for (let line = firstLine; line !== pastLastLine; line -= towardSun) {
    const lineStart = line * lineStride;
    const sunwardLine = line + towardSun;
    if (sunwardLine < 0 || sunwardLine >= lineCount) {      // nothing beyond
      for (let cell = 0; cell < lineLength; cell++)
        shadowHeight[lineStart + cell * cellStride] = NO_BLOCKER;
      continue;
    }
    // Highest thing the light has grazed by the time it reaches that line,
    // resolved before interpolating: max and interpolation do not commute.
    const sunwardStart = sunwardLine * lineStride;
    for (let cell = 0; cell < lineLength; cell++) {
      const i = sunwardStart + cell * cellStride;
      envelope[cell] = blockingHeight[i] > shadowHeight[i]
        ? blockingHeight[i] : shadowHeight[i];
    }
    for (let cell = 0; cell < lineLength; cell++) {
      const i = lineStart + cell * cellStride;
      const source = cell + driftPerLine;
      // Past the end of the line there is no data, so cast no shadow. Clamping
      // to the edge cell instead smears it outwards for ever and builds a wall
      // of false shadow along the sun-ward border - measurably, it was 95% of
      // this sweep's disagreement with a brute-force ray march.
      if (source < 0 || source > lineLength - 1) {
        shadowHeight[i] = NO_BLOCKER;
        continue;
      }
      const lower = source | 0;
      const upper = lower + 1 < lineLength ? lower + 1 : lower;
      const blend = source - lower;
      shadowHeight[i] = envelope[lower]
        + (envelope[upper] - envelope[lower]) * blend
        - tanSunElevation[i] * metresPerStep;
    }
  }

  const lit = new Uint8Array(width * height);
  for (let i = 0; i < lit.length; i++)
    lit[i] = (tanSunElevation[i] > TAN_LOWEST_USEFUL_SUN
              && eyeHeight[i] >= shadowHeight[i]) ? 1 : 0;
  return lit;
}
