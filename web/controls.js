/* Direction wheel: a circular range control over compass bearings.
 *
 * Drag either handle to move one end of the arc, or drag the arc itself to
 * swing the whole window round. Bearings are degrees clockwise from north and
 * the arc always runs clockwise from `start` to `end`, so a wedge that spans
 * north (say 340 -> 20) is expressed directly rather than as two ranges. */
export class DirectionWheel {
  constructor(svg, onChange, bins = 32) {
    this.svg = svg;
    this.onChange = onChange;
    this.bins = bins;
    this.step = 360 / bins;
    this.start = 0;
    this.end = 359.9;
    this.R = 54; this.cx = 70; this.cy = 70;
    this._build();
    this._bind();
    this.render();
  }

  /* Handles land on bin boundaries, so the arc always covers whole azimuth
   * bins. Anything finer would imply a precision the signature does not have:
   * the view is only ever computed in 32 directions. */
  snap(deg) {
    const half = this.step / 2;
    return (((Math.round((deg - half) / this.step) * this.step + half) % 360) + 360) % 360;
  }

  span() { return (this.end - this.start + 360) % 360 || 360; }

  covers(deg) {
    if (this.span() >= 359.8) return true;
    return ((deg - this.start + 360) % 360) <= this.span();
  }

  set(start, end, snap = true) {
    if (!snap) {
      this.start = ((start % 360) + 360) % 360;
      this.end = ((end % 360) + 360) % 360;
    } else {
      this.start = this.snap(start);
      this.end = this.snap(end);
      if (this.start === this.end) this.end = this.snap(this.start + this.step);
    }
    this.render();
    this.onChange();
  }

  _p(deg, r) {
    const a = (deg - 90) * Math.PI / 180;
    return [this.cx + Math.cos(a) * r, this.cy + Math.sin(a) * r];
  }

  _build() {
    const ns = 'http://www.w3.org/2000/svg';
    const el = (t, attrs) => {
      const e = document.createElementNS(ns, t);
      for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    };
    this.svg.setAttribute('viewBox', '0 0 140 140');
    this.svg.appendChild(el('circle', {cx: this.cx, cy: this.cy, r: this.R,
      fill: '#fff', stroke: '#e2ddd5', 'stroke-width': 1}));

    this.wedge = el('path', {fill: 'var(--accent)', 'fill-opacity': .22,
      stroke: 'var(--accent)', 'stroke-width': 1.5, 'stroke-linejoin': 'round',
      style: 'cursor:grab'});
    this.svg.appendChild(this.wedge);

    // One mark per azimuth bin boundary, so it is visible that the view is
    // only ever computed in `bins` directions and the handles land between
    // them.
    for (let i = 0; i < this.bins; i++) {
      const d = i * this.step + this.step / 2;
      const [x1, y1] = this._p(d, this.R - 5), [x2, y2] = this._p(d, this.R);
      this.svg.appendChild(el('line', {x1, y1, x2, y2,
        stroke: '#cdc5b7', 'stroke-width': 1}));
    }
    for (const [lbl, deg] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const [x1, y1] = this._p(deg, this.R - 5), [x2, y2] = this._p(deg, this.R);
      this.svg.appendChild(el('line', {x1, y1, x2, y2, stroke: '#c9c2b7', 'stroke-width': 1}));
      const [tx, ty] = this._p(deg, this.R - 15);
      const t = el('text', {x: tx, y: ty + 4, 'text-anchor': 'middle',
        'font-size': 11, fill: '#8a8a8a'});
      t.textContent = lbl;
      this.svg.appendChild(t);
    }
    // A 7-unit circle is a ~15 px target, which is under half what a fingertip
    // needs. The grab area is a transparent circle twice that size; the drawn
    // handle rides on top of it and takes no pointer events of its own.
    this.hits = [0, 1].map(i => {
      const g = el('circle', {r: 15, fill: 'transparent', style: 'cursor:grab'});
      g.dataset.h = i;
      this.svg.appendChild(g);
      return g;
    });
    this.handles = [0, 1].map(() => {
      const h = el('circle', {r: 7, fill: '#fff', stroke: 'var(--accent)',
        'stroke-width': 2.5, 'pointer-events': 'none'});
      this.svg.appendChild(h);
      return h;
    });
  }

  render() {
    const sp = this.span();
    if (sp >= 359.8) {
      this.wedge.setAttribute('d',
        `M ${this.cx} ${this.cy - this.R} A ${this.R} ${this.R} 0 1 1 ${this.cx - 0.01} ${this.cy - this.R} Z`);
    } else {
      const [x1, y1] = this._p(this.start, this.R);
      const [x2, y2] = this._p(this.end, this.R);
      this.wedge.setAttribute('d',
        `M ${this.cx} ${this.cy} L ${x1} ${y1} A ${this.R} ${this.R} 0 ${sp > 180 ? 1 : 0} 1 ${x2} ${y2} Z`);
    }
    [this.start, this.end].forEach((d, i) => {
      const [x, y] = this._p(d, this.R);
      for (const e of [this.handles[i], this.hits[i]]) {
        e.setAttribute('cx', x);
        e.setAttribute('cy', y);
        e.style.display = sp >= 359.8 ? 'none' : '';
      }
    });
  }

  _angleAt(ev) {
    const r = this.svg.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width * 140 - this.cx;
    const y = (ev.clientY - r.top) / r.height * 140 - this.cy;
    return (Math.atan2(y, x) * 180 / Math.PI + 90 + 360) % 360;
  }

  _bind() {
    let drag = null, grabbed = 0;
    const down = ev => {
      const h = ev.target.dataset && ev.target.dataset.h;
      drag = h !== undefined && h !== null ? +h : (ev.target === this.wedge ? 'arc' : null);
      if (drag === null) return;
      grabbed = this._angleAt(ev);
      this.svg.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    };
    const move = ev => {
      if (drag === null) return;
      const angle = this._angleAt(ev);
      const wasStart = this.start, wasEnd = this.end;
      if (drag === 'arc') {
        const step = this.snap(this.start + (angle - grabbed)) - this.start;
        if (!step) return;
        grabbed += step;
        this.start = (this.start + step + 360) % 360;
        this.end = (this.end + step + 360) % 360;
      } else if (drag === 0) {
        this.start = this.snap(angle);
      } else {
        this.end = this.snap(angle);
      }
      // A collapsed arc has span() fall through to 360, so dragging the handles
      // together would read as "all directions" - the opposite of the gesture.
      // Refuse the move rather than leaving that showing until the next one.
      if (this.start === this.end) {
        this.start = wasStart; this.end = wasEnd;
        return;
      }
      this.render();
      this.onChange();
    };
    const up = ev => {
      if (drag !== null) this.svg.releasePointerCapture(ev.pointerId);
      drag = null;
    };
    this.svg.addEventListener('pointerdown', down);
    this.svg.addEventListener('pointermove', move);
    this.svg.addEventListener('pointerup', up);
    this.svg.addEventListener('pointercancel', up);
  }
}

/* Dual-handle range over the distance scale. It replaces a separate "minimum
 * view" control: the legend and the filter become the same thing, so the
 * colours always span exactly the band being asked for.
 *
 * The top handle at its maximum means "and above" rather than a ceiling -
 * otherwise the default view would hide the best spots, which are precisely
 * the ones out in the tail. */
export class RangeSlider {
  constructor(root, {max = 20, lo = 0, hi = 20, onChange}) {
    this.root = root; this.max = max; this.lo = lo; this.hi = hi;
    this.onChange = onChange;
    this.track = root.querySelector('.track');
    this.fill = root.querySelector('.fill');
    this.handles = [...root.querySelectorAll('.knob')];
    // the readout sits in the group header, above the slider, not inside it
    this.valEl = (root.closest('.grp') || document).querySelector('.rsval');
    this._bind();
    this.render();
  }

  /* Distances are heavily skewed - median 1.9 km against a 12.3 km best - so
   * the scale is square-root. On a linear ramp nearly everything lands in the
   * palest step and the interesting tail is invisible. */
  pos(v) { return Math.sqrt(Math.max(0, v) / this.max); }
  val(p) { return Math.max(0, Math.min(1, p)) ** 2 * this.max; }

  capped() { return this.hi >= this.max - 1e-9; }

  render() {
    const a = this.pos(this.lo) * 100, b = this.pos(this.hi) * 100;
    this.fill.style.left = a + '%';
    this.fill.style.width = (b - a) + '%';
    this.handles[0].style.left = a + '%';
    this.handles[1].style.left = b + '%';
    if (this.valEl) this.valEl.textContent =
      `${this.lo < 10 ? this.lo.toFixed(1) : this.lo.toFixed(0)} – `
      + `${this.hi.toFixed(0)}${this.capped() ? '+' : ''} km`;
  }

  _bind() {
    let drag = null;
    const at = ev => {
      const r = this.track.getBoundingClientRect();
      return this.val((ev.clientX - r.left) / r.width);
    };
    this.root.addEventListener('pointerdown', ev => {
      const k = ev.target.closest('.knob');
      const v = at(ev);
      drag = k ? +k.dataset.k : (Math.abs(v - this.lo) < Math.abs(v - this.hi) ? 0 : 1);
      this.root.setPointerCapture(ev.pointerId);
      this._move(v, drag);
      ev.preventDefault();
    });
    this.root.addEventListener('pointermove', ev => {
      if (drag !== null) this._move(at(ev), drag);
    });
    const up = ev => {
      if (drag !== null) this.root.releasePointerCapture(ev.pointerId);
      drag = null;
    };
    this.root.addEventListener('pointerup', up);
    this.root.addEventListener('pointercancel', up);
  }

  _move(v, which) {
    if (which === 0) this.lo = Math.min(v, this.hi - 0.2);
    else this.hi = Math.max(v, this.lo + 0.2);
    this.render();
    this.onChange();
  }
}
