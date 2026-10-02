/* ============================================================================
   PixelCity — a whole voxel city, built block by block, that you can grab,
   turn and zoom. The same technique as the homepage tower (skyscraper.js):
   an orthographic camera with yaw + pitch projects a voxel model into a
   logical pixel buffer that is upscaled nearest-neighbour, so the city is
   crisp pixel art while being fully 3D.

   Scene: the homepage tri-wing tower in the middle on a lit plaza; a street
   grid of glass towers (podiums, setbacks, crowns, antennas, roof plant)
   growing outward in waves; parks with voxel trees; lamps with light pools;
   cars with headlights moving along the streets; cast shadows that lengthen
   as towers rise; depth fog; aviation lights; a shock ring that runs ahead
   of construction; a vignette.

   mountPixelCity(canvas, { palette, duration, detail, zoom }) →
     { destroy(), replay(), zoom(delta), setView(yaw, pitch), progress, counts }
   ========================================================================== */

const LW = 640, LH = 360;                    // logical buffer (16:9)

export const CITY_PALETTE = {
  ground: '#0d0b1c', slab: '#16132b', slabEdge: '#0a0818', shadow: '#050411', castShadow: '#07061a',
  street: '#110f22', lane: '#2a2546', plaza: '#1c1838', plazaRing: '#2b2552',
  lamp: '#f3d27a', head: '#fff4cc', tail: '#ff5a3c', beacon: '#ff3b3b',
  glass: ['#141c3e', '#192348', '#1f2b57', '#263464', '#2d3d72'],
  violet: ['#2a2270', '#352b85', '#41359a', '#4e3fb0', '#5b4bc4'],
  steel: ['#1a1d2e', '#20243a', '#272c46'],
  glassEdge: '#8f7cff', podium: '#1c1f3a',
  window: ['#f3d27a', '#ffe9a8', '#e9c35f', '#fff4cc'], retail: '#ffd9a0',
  trunk: '#3a2d4f', leaf: ['#27605a', '#2f7a6c', '#3b8f7d'],
  spire: '#9fb2e6', spireTip: '#fff7d6', glow: '#5b3df0', star: '#c9bfff', ring: '#8f7cff',
};

const h1 = (a) => { const x = Math.sin(a * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const h2 = (a, b) => h1(a * 7.31 + b * 19.17);
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const css = (c, m = 1, a = 1) => `rgba(${(c[0] * m) | 0},${(c[1] * m) | 0},${(c[2] * m) | 0},${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOutBack = (k) => { const c1 = 1.15, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const TOP = 1, PX = 2, NX = 4, PZ = 8, NZ = 16;

// ---- geometry ---------------------------------------------------------------
export function buildCityModel(detail = 'full') {
  const occ = new Map();
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const put = (x, y, z, kind, extra = {}) => { const k = key(x, y, z); if (!occ.has(k)) occ.set(k, { x, y, z, kind, ...extra }); };

  // --- the hero tower: the homepage tri-wing form ---
  const CORE_H = 48, SPIRE_H = 14;
  for (let y = 0; y < CORE_H; y++) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) put(x, y, z, 'tower', { b: -1 });
  const SEG = 2, SEGS = 4;
  for (let k = 0; k < 3; k++) {
    const a = (Math.PI / 2) + k * (2 * Math.PI / 3);
    const dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
    for (let j = 0; j < SEGS; j++) {
      const H = Math.max(6, CORE_H - 4 - j * 8 - k * 3);
      for (let t = 0; t < SEG; t++) {
        const r = 1.5 + j * SEG + t;
        for (let w = -1; w <= 1; w++) {
          const x = Math.round(dx * r + px * w), z = Math.round(dz * r + pz * w);
          for (let y = 0; y < H; y++) put(x, y, z, 'tower', { b: -1 });
        }
      }
    }
  }
  for (let y = CORE_H; y < CORE_H + SPIRE_H; y++) put(0, y, 0, y < CORE_H + 3 ? 'collar' : 'spire', { b: -1 });
  const tipY = CORE_H + SPIRE_H;

  // --- the grid ---
  const LOT = 6, STREET = 2, PITCH = LOT + STREET, R = detail === 'lite' ? 30 : 38, PLAZA = 9;
  const buildings = [], trees = [];
  let b = 0;
  for (let gx = -R; gx <= R - LOT; gx += PITCH) for (let gz = -R; gz <= R - LOT; gz += PITCH) {
    const cx = gx + LOT / 2, cz = gz + LOT / 2;
    const d = Math.hypot(cx, cz);
    if (d > R - 2 || d < PLAZA) continue;
    const r1 = h2(gx, gz), r2 = h2(gz, gx), r3 = h2(gx + 1, gz + 3);
    const near = 1 - clamp((d - PLAZA) / (R - PLAZA), 0, 1);
    if (r1 < (d < R * 0.5 ? 0.07 : 0.2)) {                       // a park: a few voxel trees
      const n = 2 + Math.floor(h2(gx + 8, gz) * 3);
      for (let i = 0; i < n; i++) {
        const tx = gx + 1 + Math.floor(h2(gx + i, gz + 2) * (LOT - 2)), tz = gz + 1 + Math.floor(h2(gz + i, gx + 2) * (LOT - 2));
        const th = 1 + Math.floor(h2(tx, tz) * 2), leaf = Math.floor(h2(tz, tx) * 3);
        trees.push({ x: tx, z: tz, dist: d });
        for (let y = 0; y < th; y++) put(tx, y, tz, 'trunk', { b: -2, dist: d });
        for (let y = th; y < th + 2; y++) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) { if (y === th + 1 && Math.abs(x) + Math.abs(z) === 2) continue; put(tx + x, y, tz + z, 'leaf', { b: -2, dist: d, shade: leaf }); }
      }
      continue;
    }
    const w = 3 + Math.floor(r2 * 3), dd = 3 + Math.floor(r3 * 3);
    const x0 = gx + Math.floor((LOT - w) * h2(gx + 5, gz)), z0 = gz + Math.floor((LOT - dd) * h2(gz + 5, gx));
    const h = Math.max(3, Math.round(4 + near * near * 28 + r1 * 10 * (0.4 + near)));
    const shade = Math.floor(h2(gx + 9, gz + 9) * 5);
    const kindRoll = h2(gx + 3, gz + 7);
    const kind = kindRoll < 0.16 ? 'violet' : kindRoll < 0.3 ? 'steel' : 'city';
    const podium = h > 10 && h2(gx + 6, gz + 1) < 0.45 ? 2 + Math.floor(h2(gx, gz + 4) * 2) : 0;   // wide base
    const setback = h > 14 && h2(gx + 2, gz + 2) < 0.55 ? Math.round(h * (0.55 + 0.25 * h2(gx, gz + 1))) : null;
    const crown = h > 18 && h2(gx + 7, gz + 7) < 0.4;                                             // lit top floors
    const antenna = h > 18 && h2(gx + 4, gz + 4) < 0.35;
    const plant = h >= 8 && !antenna && h2(gx + 11, gz + 5) < 0.5;                               // rooftop mechanical box
    const id = b++;
    buildings.push({ id, x0, z0, w, d: dd, h: h + (antenna ? 3 : 0), hBody: h, cx: x0 + w / 2, cz: z0 + dd / 2, dist: d, podium });
    if (podium) for (let x = x0 - 1; x < x0 + w + 1; x++) for (let z = z0 - 1; z < z0 + dd + 1; z++) for (let y = 0; y < podium; y++) put(x, y, z, 'podium', { b: id, shade });
    for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + dd; z++) for (let y = 0; y < h; y++) {
      const edge = x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + dd - 1;
      if (setback !== null && y >= setback && edge) continue;
      put(x, y, z, kind, { b: id, shade, crown: crown && y >= h - 2, retail: y === 0 && !podium });
    }
    const ax = x0 + Math.floor(w / 2), az = z0 + Math.floor(dd / 2);
    if (antenna) for (let y = h; y < h + 3; y++) put(ax, y, az, 'spire', { b: id, beacon: y === h + 2 });
    else if (plant) { const top = setback !== null ? h : h; put(ax, top, az, 'plant', { b: id }); if (w >= 4) put(ax - 1, top, az, 'plant', { b: id }); }
  }

  // --- shells, faces, timing, windows ---
  const vox = [];
  const towerT = (y) => y >= CORE_H ? 0.90 + 0.08 * ((y - CORE_H) / SPIRE_H) : 0.22 + 0.66 * Math.pow(y / CORE_H, 0.8);
  const waveT = (dist) => 0.06 + 0.70 * Math.pow(dist / R, 0.95);
  for (const v of occ.values()) {
    let f = 0;
    if (!occ.has(key(v.x, v.y + 1, v.z))) f |= TOP;
    if (!occ.has(key(v.x + 1, v.y, v.z))) f |= PX;
    if (!occ.has(key(v.x - 1, v.y, v.z))) f |= NX;
    if (!occ.has(key(v.x, v.y, v.z + 1))) f |= PZ;
    if (!occ.has(key(v.x, v.y, v.z - 1))) f |= NZ;
    if (!f) continue;
    v.f = f;
    if (v.b === -1) { v.shade = Math.floor(h2(v.x * 1.7, v.z * 0.9) * 5); v.t0 = towerT(v.y) + (v.kind === 'tower' ? (h2(v.x, v.z + v.y) - 0.5) * 0.02 : 0); }
    else if (v.b === -2) { v.t0 = waveT(v.dist) + 0.04 + v.y * 0.015 + h2(v.x, v.z) * 0.02; }
    else { const bd = buildings[v.b]; v.t0 = waveT(bd.dist) + (v.y / Math.max(1, bd.h)) * 0.10 + (h2(v.b, v.y) - 0.5) * 0.015; }
    v.win = 0;
    if (v.kind === 'tower' || v.kind === 'city' || v.kind === 'violet' || v.kind === 'steel') {
      const lit = v.crown || v.retail || (v.kind === 'tower'
        ? (h1(v.y * 3.3) < 0.64 && h2(Math.floor(v.x / 2) + 40, v.y + Math.floor(v.z / 2)) < 0.8)
        : (v.y % 2 === 0 && h2(v.x, v.z + v.y) < (v.kind === 'steel' ? 0.35 : 0.55)));
      if (lit) { v.win = v.f & (PX | NX | PZ | NZ); v.wc = v.crown ? 3 : Math.floor(h2(v.x + 2, v.z + v.y) * 4); v.wt = v.t0 + 0.03 + h2(v.y, v.x + 7) * 0.08; v.on = true; }
    }
    vox.push(v);
  }
  const windows = vox.filter((v) => v.win && !v.crown && !v.retail);
  const beacons = vox.filter((v) => v.beacon);
  const colMap = new Map();
  for (const v of vox) { const k = v.x + ',' + v.z; if (!colMap.has(k)) colMap.set(k, { x: v.x, z: v.z, vs: [] }); colMap.get(k).vs.push(v); }
  const cols = [...colMap.values()]; cols.forEach((c) => c.vs.sort((a, b) => a.y - b.y));

  // street lamps along street centre lines; cars on the streets
  const lamps = [], streets = [];
  for (let g = -R; g <= R + 1; g += PITCH) {
    const s = g - STREET / 2 - 0.5;
    if (Math.abs(s) > R) continue;
    streets.push({ axis: 'x', at: s }); streets.push({ axis: 'z', at: s });
    for (let t = -R + 2; t <= R - 2; t += 4) {
      for (const [x, z] of [[s - 0.9, t], [t, s - 0.9]]) {   // one lamp line per street, both directions
        if (Math.hypot(x, z) > R - 1 || Math.hypot(x, z) < PLAZA - 1.5) continue;
        lamps.push({ x, z, t0: waveT(Math.hypot(x, z)) + 0.12 });
      }
    }
  }
  const cars = [];
  const nCars = detail === 'lite' ? 10 : 22;
  for (let i = 0; i < nCars; i++) {
    const st = streets[Math.floor(h1(i * 2.3) * streets.length)];
    cars.push({ st, u: -R + h1(i * 5.7) * 2 * R, v: (h1(i * 9.1) < 0.5 ? -1 : 1) * (6 + h1(i * 1.9) * 7), lane: h1(i * 4.4) < 0.5 ? -0.5 : 0.5 });
  }
  return { vox, cols, windows, beacons, lamps, cars, buildings, trees, tipY, CORE_H, R, PLAZA, PITCH, STREET, waveT };
}

// ---- renderer ---------------------------------------------------------------
export function mountPixelCity(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const P = { ...CITY_PALETTE, ...(opts.palette || {}) };
  const C = Object.fromEntries(Object.entries(P).map(([k, v]) => [k, Array.isArray(v) ? v.map(hex) : hex(v)]));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = !window.matchMedia('(pointer:fine)').matches;
  const detail = opts.detail && opts.detail !== 'auto' ? opts.detail : (coarse || window.innerWidth < 720 ? 'lite' : 'full');
  const DUR = (opts.duration || 9000) / (opts.speed || 1);
  const city = buildCityModel(detail);

  const lo = document.createElement('canvas'); lo.width = LW; lo.height = LH; const g = lo.getContext('2d');
  const stars = Array.from({ length: 110 }, (_, i) => ({ x: Math.floor(h1(i * 3.1) * LW), y: Math.floor(h1(i * 7.7) * LH * 0.85), a: 0.15 + h1(i) * 0.5, s: 0.4 + h1(i * 2.2) * 1.2 }));
  const vignette = (() => { const c = document.createElement('canvas'); c.width = LW; c.height = LH; const vg = c.getContext('2d'); const gr = vg.createRadialGradient(LW * 0.55, LH * 0.6, LH * 0.35, LW * 0.55, LH * 0.6, LW * 0.72); gr.addColorStop(0, 'rgba(5,4,17,0)'); gr.addColorStop(1, 'rgba(5,4,17,0.75)'); vg.fillStyle = gr; vg.fillRect(0, 0, LW, LH); return c; })();

  let yaw = -0.62, pitch = 0.58, vyaw = 0, vpitch = 0, dragging = false, lastX = 0, lastY = 0, lastT = 0, idleSince = 0;
  let zoom = opts.zoom || 1, S = 2.6 * zoom;
  let W = 0, H = 0, DPR = 1, scale = 1, ox = 0, oy = 0;
  let t0 = 0, p = reduce ? 1 : 0, started = false, raf = 0, nextFlick = 0;
  const CX = LW * (opts.centerX ?? 0.5), CY = LH * (opts.centerY ?? 0.66);
  const light = [-0.55, 0.75, -0.42];
  const shadowDir = [0.55, 0.42];             // world x,z shift per unit height, opposite the light

  function resize() {
    const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = W * DPR; canvas.height = H * DPR;
    scale = Math.max(W / LW, H / LH); ox = (W - LW * scale) / 2; oy = (H - LH * scale) / 2;
  }

  let cy_, sy_, cp_, sp_;
  const proj = (x, y, z) => { const rx = x * cy_ - z * sy_, rz = x * sy_ + z * cy_; return { sx: CX + rx * S, sy: CY - (y * cp_ - rz * sp_) * S, d: rz * cp_ + y * sp_ }; };
  const depth = (x, z) => (x * sy_ + z * cy_) * cp_;
  function face(sx, sy, o, col) {
    g.fillStyle = col;
    g.beginPath(); g.moveTo(Math.round(sx + o[0][0]), Math.round(sy + o[0][1]));
    for (let i = 1; i < 4; i++) g.lineTo(Math.round(sx + o[i][0]), Math.round(sy + o[i][1]));
    g.closePath(); g.fill();
  }
  const poly = (pts, col) => { g.fillStyle = col; g.beginPath(); pts.forEach((q, i) => i ? g.lineTo(Math.round(q.sx), Math.round(q.sy)) : g.moveTo(Math.round(q.sx), Math.round(q.sy))); g.closePath(); g.fill(); };
  const px = (x, y, col) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), 1, 1); };

  function draw(now, tm) {
    const done = now >= 1;
    cy_ = Math.cos(yaw); sy_ = Math.sin(yaw); cp_ = Math.cos(pitch); sp_ = Math.sin(pitch);
    const c = (x, y, z) => { const q = proj(x, y, z); return [q.sx - CX, q.sy - CY]; };
    const O = {
      top: [c(-.5, 1, -.5), c(.5, 1, -.5), c(.5, 1, .5), c(-.5, 1, .5)],
      px: [c(.5, 0, -.5), c(.5, 0, .5), c(.5, 1, .5), c(.5, 1, -.5)],
      nx: [c(-.5, 0, .5), c(-.5, 0, -.5), c(-.5, 1, -.5), c(-.5, 1, .5)],
      pz: [c(.5, 0, .5), c(-.5, 0, .5), c(-.5, 1, .5), c(.5, 1, .5)],
      nz: [c(-.5, 0, -.5), c(.5, 0, -.5), c(.5, 1, -.5), c(-.5, 1, -.5)],
    };
    const nzv = (nx, nzz) => nx * sy_ + nzz * cy_;
    const showPX = nzv(1, 0) < 0, showNX = nzv(-1, 0) < 0, showPZ = nzv(0, 1) < 0, showNZ = nzv(0, -1) < 0;
    const lum = (nx, ny, nzz) => { const rx = nx * cy_ - nzz * sy_, rz = nx * sy_ + nzz * cy_; const d = rx * light[0] + ny * light[1] + rz * light[2]; return 0.66 + 0.52 * Math.max(0, d); };
    const L = { top: 0.95 + 0.45 * lum(0, 1, 0), px: lum(1, 0, 0), nx: lum(-1, 0, 0), pz: lum(0, 0, 1), nzf: lum(0, 0, -1) };
    const R = city.R;
    const dmax = R * cp_ * 1.05;                                   // depth range for fog
    const fog = (d) => 1 - 0.22 * clamp((dmax - d) / (2 * dmax), 0, 1); // far columns a touch darker

    // --- night backdrop ---
    g.fillStyle = css(C.ground); g.fillRect(0, 0, LW, LH);
    for (const s of stars) { const tw = 0.6 + 0.4 * Math.sin(tm / 700 + s.x); g.fillStyle = css(C.star, 1, s.a * tw); g.fillRect(s.x, s.y, s.s > 1.3 ? 2 : 1, 1); }
    const ga = clamp(now / 0.3, 0, 1);
    [[220, .05], [150, .07], [90, .10], [46, .12]].forEach(([r, a]) => { g.fillStyle = css(C.glow, 1, a * ga); g.beginPath(); g.ellipse(CX, CY, r, r * 0.5, 0, 0, Math.PI * 2); g.fill(); });

    // --- the slab: rounded square, rim, streets, lane marks, plaza ---
    const pa = clamp(now / 0.08, 0, 1);
    const n = 32, top = [], bot = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const sq = (v) => Math.sign(v) * Math.pow(Math.abs(v), 0.55) * (R + 2); top.push(proj(sq(Math.cos(a)), 0, sq(Math.sin(a)))); bot.push(proj(sq(Math.cos(a)), -3, sq(Math.sin(a)))); }
    g.fillStyle = css(C.shadow, 1, .6 * pa); g.beginPath(); top.forEach((q, i) => i ? g.lineTo(Math.round(q.sx + 5), Math.round(q.sy + 11)) : g.moveTo(Math.round(q.sx + 5), Math.round(q.sy + 11))); g.closePath(); g.fill();
    for (let i = 0; i < n; i++) { const a = top[i], b = top[(i + 1) % n], a2 = bot[i], b2 = bot[(i + 1) % n]; if (b.sx - a.sx <= 0) continue; g.fillStyle = css(C.slabEdge, 1, pa); g.beginPath(); g.moveTo(Math.round(a.sx), Math.round(a.sy)); g.lineTo(Math.round(b.sx), Math.round(b.sy)); g.lineTo(Math.round(b2.sx), Math.round(b2.sy)); g.lineTo(Math.round(a2.sx), Math.round(a2.sy)); g.closePath(); g.fill(); }
    poly(top, css(C.slab, 1, pa));
    const { PITCH, STREET } = city;
    for (let gx = -R; gx <= R + 1; gx += PITCH) {
      const s0 = gx - STREET - 0.5, s1 = gx - 0.5;
      if (Math.abs(s0) > R + 1) continue;
      poly([proj(s0, 0.02, -R), proj(s1, 0.02, -R), proj(s1, 0.02, R), proj(s0, 0.02, R)], css(C.street, 1, pa));
      poly([proj(-R, 0.02, s0), proj(R, 0.02, s0), proj(R, 0.02, s1), proj(-R, 0.02, s1)], css(C.street, 1, pa));
    }
    if (S >= 2.2) { // lane dashes
      g.fillStyle = css(C.lane, 1, .7 * pa);
      for (let gx = -R; gx <= R + 1; gx += PITCH) { const m = gx - STREET / 2 - 0.5; if (Math.abs(m) > R) continue; for (let t = -R; t < R; t += 2.5) { if (Math.hypot(m, t) < city.PLAZA) continue; const q = proj(m, 0.03, t), q2 = proj(t, 0.03, m); px(q.sx, q.sy, g.fillStyle); px(q2.sx, q2.sy, g.fillStyle); } }
    }
    const plaza = []; for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2; plaza.push(proj(Math.cos(a) * city.PLAZA, 0.04, Math.sin(a) * city.PLAZA)); }
    poly(plaza, css(C.plaza, 1, pa));
    for (const rr of [7.5, 5]) { const ring = []; for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; ring.push(proj(Math.cos(a) * rr, 0.05, Math.sin(a) * rr)); } g.strokeStyle = css(C.plazaRing, 1, pa); g.lineWidth = 1; g.beginPath(); ring.forEach((q, i) => i ? g.lineTo(Math.round(q.sx), Math.round(q.sy)) : g.moveTo(Math.round(q.sx), Math.round(q.sy))); g.closePath(); g.stroke(); }
    if (now > 0.18) for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; const q = proj(Math.cos(a) * 6.5, 0.1, Math.sin(a) * 6.5); px(q.sx, q.sy, css(C.lamp, 1, .85 * clamp((now - .18) / .1, 0, 1))); }

    // construction shock ring: runs ahead of the wave on the ground
    if (now > 0.06 && now < 0.8) {
      const rr = clamp(((now - 0.06) / 0.70), 0, 1) ** (1 / 0.95) * R;
      const ring = []; for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; ring.push(proj(Math.cos(a) * rr, 0.08, Math.sin(a) * rr)); }
      g.strokeStyle = css(C.ring, 1, .55); g.lineWidth = 1; g.beginPath(); ring.forEach((q, i) => i ? g.lineTo(Math.round(q.sx), Math.round(q.sy)) : g.moveTo(Math.round(q.sx), Math.round(q.sy))); g.closePath(); g.stroke();
      g.strokeStyle = css(C.ring, 1, .18); g.beginPath(); ring.forEach((q, i) => i ? g.lineTo(Math.round(q.sx), Math.round(q.sy) + 1) : g.moveTo(Math.round(q.sx), Math.round(q.sy) + 1)); g.closePath(); g.stroke();
    }

    // cast shadows: each footprint sheared away from the light by its built height
    g.fillStyle = css(C.castShadow, 1, .55);
    for (const bd of city.buildings) {
      const ts = city.waveT(bd.dist), k = clamp((now - ts) / 0.11, 0, 1);
      if (k <= 0) continue;
      const hb = bd.hBody * k, dx = shadowDir[0] * hb, dz = shadowDir[1] * hb;
      const { x0, z0, w, d } = bd, x1 = x0 + w, z1 = z0 + d;
      poly([proj(x0 - .5, 0.01, z0 - .5), proj(x1 - .5, 0.01, z0 - .5), proj(x1 - .5 + dx, 0.01, z0 - .5 + dz), proj(x1 - .5 + dx, 0.01, z1 - .5 + dz), proj(x0 - .5 + dx, 0.01, z1 - .5 + dz), proj(x0 - .5, 0.01, z1 - .5)], g.fillStyle);
    }
    { const k = clamp((now - 0.22) / 0.6, 0, 1); if (k > 0) { const hb = city.CORE_H * k, dx = shadowDir[0] * hb, dz = shadowDir[1] * hb; poly([proj(-5, .01, -5), proj(5, .01, -5), proj(5 + dx, .01, -5 + dz), proj(5 + dx, .01, 5 + dz), proj(-5 + dx, .01, 5 + dz), proj(-5, .01, 5)], css(C.castShadow, 1, .55)); } }

    // --- ground sprites (lamps with pools, cars) merged into the column pass by depth ---
    const sprites = [];
    for (const l of city.lamps) if (now >= l.t0) sprites.push({ d: depth(l.x, l.z), kind: 'lamp', x: l.x, z: l.z });
    if (now > 0.5) for (const car of city.cars) {
      const u = car.u, st = car.st; const x = st.axis === 'x' ? u : st.at + car.lane, z = st.axis === 'x' ? st.at + car.lane : u;
      if (Math.hypot(x, z) > R - 1 || Math.hypot(x, z) < city.PLAZA) continue;
      sprites.push({ d: depth(x, z), kind: 'car', x, z, axis: st.axis, dir: Math.sign(car.v) });
    }
    sprites.sort((a, b) => b.d - a.d);
    let si = 0;
    const drawSprites = (dLimit) => {
      for (; si < sprites.length && sprites[si].d >= dLimit; si++) {
        const s = sprites[si];
        if (s.kind === 'lamp') {
          const q = proj(s.x, 0.02, s.z), q2 = proj(s.x, 0.7, s.z);
          g.fillStyle = css(C.lamp, 1, .10); g.beginPath(); g.ellipse(q.sx, q.sy, 3.2 * S / 2.6, 1.6 * S / 2.6, 0, 0, Math.PI * 2); g.fill();
          px(q2.sx, q2.sy, css(C.lamp, 1, .95)); if (S >= 2.2) px(q2.sx, q2.sy + 1, css(C.lamp, 1, .35));
        } else {
          const q = proj(s.x, 0.15, s.z);
          const ahead = s.axis === 'x' ? proj(s.x + s.dir * 0.7, 0.15, s.z) : proj(s.x, 0.15, s.z + s.dir * 0.7);
          const behind = s.axis === 'x' ? proj(s.x - s.dir * 0.7, 0.15, s.z) : proj(s.x, 0.15, s.z - s.dir * 0.7);
          px(q.sx, q.sy, css(C.steel[2], 1, .9)); px(ahead.sx, ahead.sy, css(C.head, 1, .95)); px(behind.sx, behind.sy, css(C.tail, 1, .9));
        }
      }
    };

    // --- voxels, by column, far → near; settled runs merge into one quad each ---
    const glassFor = (v) => v.kind === 'violet' ? C.violet[v.shade] : v.kind === 'steel' ? C.steel[v.shade % 3] : v.kind === 'podium' ? C.podium : v.kind === 'plant' ? C.steel[1]
      : v.kind === 'spire' ? C.spire : v.kind === 'collar' ? C.glassEdge : v.kind === 'trunk' ? C.trunk : v.kind === 'leaf' ? C.leaf[v.shade] : C.glass[v.shade];
    const sides = [[NX, O.nx, showNX, L.nx], [PZ, O.pz, showPZ, L.pz], [NZ, O.nz, showNZ, L.nzf], [PX, O.px, showPX, L.px]];
    const cols = city.cols;
    for (const col of cols) col.d = depth(col.x, col.z);
    cols.sort((a, b) => b.d - a.d);
    const riseY = -cp_ * S;
    const list = [];
    for (const col of cols) {
      drawSprites(col.d);
      const fg = fog(col.d);
      const runs = new Map(), tops = [], wins = [];
      const flush = (bit) => { const r = runs.get(bit); if (!r) return; runs.delete(bit);
        const q = proj(col.x, r.y0, col.z), h = r.y1 - r.y0 + 1, o = r.o;
        face(q.sx, q.sy, [o[0], o[1], [o[1][0], o[1][1] + riseY * (h - 1)], [o[0][0], o[0][1] + riseY * (h - 1)]], css(r.col, r.lm * fg)); };
      const flushAll = () => { for (const [bit] of sides) flush(bit); };
      for (const v of col.vs) {
        if (now < v.t0) { flushAll(); continue; }
        const k = clamp((now - v.t0) / 0.04, 0, 1);
        if (k < 1) {
          flushAll();
          const e = easeOutBack(k), q = proj(v.x, v.y - (1 - e) * 1.8, v.z), cc = glassFor(v);
          for (const [bit, o, show, lm] of sides) if (show && (v.f & bit)) face(q.sx, q.sy, o, css(cc, lm * fg));
          if (v.f & TOP) face(q.sx, q.sy, O.top, css(cc, L.top * fg));
          if (k > 0.3) px(q.sx, q.sy - S, css(C.glassEdge, 1, (1 - k) * .9));
          continue;
        }
        const cc = glassFor(v);
        for (const [bit, o, show, lm] of sides) {
          if (!show || !(v.f & bit)) { flush(bit); continue; }
          const r = runs.get(bit);
          if (r && r.y1 === v.y - 1 && r.col === cc) r.y1 = v.y; else { flush(bit); runs.set(bit, { y0: v.y, y1: v.y, o, lm, col: cc }); }
        }
        if (v.f & TOP) tops.push(v);
        if (v.win && v.on && now >= v.wt) wins.push(v);
        list.push(v);
      }
      flushAll();
      for (const v of tops) {
        const q = proj(v.x, v.y, v.z); face(q.sx, q.sy, O.top, css(glassFor(v), L.top * fg));
        if (S >= 2.2 && v.kind !== 'leaf' && v.kind !== 'trunk') { const o = O.top; px(q.sx + o[0][0], q.sy + o[0][1], css(C.glassEdge, 1, .22)); } // parapet highlight
      }
      if (S >= 1.5) for (const v of wins) { const q = proj(v.x, v.y, v.z); for (const [bit, o, show] of sides) if (show && (v.win & bit)) win(q, o, v, now, fg); }
    }
    drawSprites(-Infinity);
    function win(q, o, v, now, fg) {
      const a = clamp((now - v.wt) / 0.03, 0, 1);
      const mx = (o[0][0] + o[2][0]) / 2, my = (o[0][1] + o[2][1]) / 2;
      const sc = v.retail ? .8 : v.crown ? .7 : v.kind === 'tower' ? .5 : .42;
      const col = v.retail ? C.retail : C.window[v.wc ?? 1];
      face(q.sx, q.sy, o.map(([x, y]) => [mx + (x - mx) * sc, my + (y - my) * sc]), css(col, fg, (v.retail ? .5 : .95) * a));
    }
    // aviation beacons on the tallest roofs + the spire tip
    const blink = Math.floor(tm / 650) % 2 === 0;
    if (done || now > 0.85) for (const v of city.beacons) { if (now < v.t0 + 0.05) continue; const q = proj(v.x, v.y + 1, v.z); px(q.sx, q.sy, css(C.beacon, 1, blink ? .95 : .25)); }
    if (now >= 0.98) { const k = clamp((now - .98) / .02, 0, 1); const q = proj(0, city.tipY + 0.5, 0); px(q.sx, q.sy, css(C.spireTip, 1, k)); g.fillStyle = css(C.spireTip, 1, .35 * k); g.fillRect(Math.round(q.sx) - 1, Math.round(q.sy) - 1, 3, 3); if (blink) px(q.sx, q.sy - 1, css(C.beacon, 1, .9)); }
    if (now > 0.97) { const k = clamp((now - .97) / .03, 0, 1) * (done ? .75 + .25 * Math.sin(tm / 1400) : 1); const q = proj(0, city.CORE_H - 5, 0); [[26, .03], [16, .05], [9, .08]].forEach(([r, a]) => { g.fillStyle = css(C.window[1], 1, a * k); g.beginPath(); g.ellipse(q.sx, q.sy, r, r * 1.5, 0, 0, Math.PI * 2); g.fill(); }); }
    if (done && detail !== 'lite') for (let i = 0; i < 5; i++) { const v = list[Math.floor(h2(Math.floor(tm / 90), i) * list.length)]; if (v) { const q = proj(v.x, v.y, v.z); px(q.sx, q.sy - S + 1, css(C.glassEdge, 1, .35)); } }

    g.drawImage(vignette, 0, 0);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lo, Math.round(ox), Math.round(oy), LW * scale, LH * scale);
  }

  let slowFrames = 0, lastFrame = 0, degraded = false;
  function frame(tm) {
    const dt = lastFrame ? Math.min(50, tm - lastFrame) : 16;
    if (lastFrame && tm - lastFrame > 28) {
      if (++slowFrames > 40 && !degraded) { degraded = true; city.cars.length = Math.min(city.cars.length, 8); if (p < 0.2) city.cols = city.cols.filter((c) => c.vs[0].b < 0 || h1(c.x * 3 + c.z) < 0.65); }
    } else slowFrames = Math.max(0, slowFrames - 1);
    lastFrame = tm;
    if (started && p < 1) p = clamp((tm - t0) / DUR, 0, 1);
    const now = p;
    if (!dragging) {
      yaw += vyaw; pitch = clamp(pitch + vpitch, 0.2, 1.1); vyaw *= 0.93; vpitch *= 0.9;
      if (!reduce && tm - idleSince > 2600) yaw += now >= 1 ? 0.0014 : 0.0008;
    }
    for (const car of city.cars) { car.u += car.v * dt / 1000; if (car.u > city.R) car.u = -city.R; if (car.u < -city.R) car.u = city.R; }
    if (now >= 1 && tm > nextFlick) { const w = city.windows[Math.floor(h1(tm) * city.windows.length)]; if (w) w.on = w.on ? h1(tm * 1.3) > 0.18 : h1(tm * 1.7) < 0.45; nextFlick = tm + 400 + h1(tm) * 600; }
    draw(now, tm);
    raf = requestAnimationFrame(frame);
  }

  const pos = (e) => e.touches ? [e.touches[0].clientX, e.touches[0].clientY] : [e.clientX, e.clientY];
  const onDown = (e) => { dragging = true; [lastX, lastY] = pos(e); lastT = performance.now(); vyaw = vpitch = 0; canvas.style.cursor = 'grabbing'; };
  const onMove = (e) => {
    if (!dragging) return;
    const [x, y] = pos(e), t = performance.now(), dt = Math.max(1, t - lastT);
    const dx = x - lastX, dy = y - lastY;
    yaw += dx * 0.008; if (!e.touches) pitch = clamp(pitch - dy * 0.006, 0.2, 1.1);
    vyaw = (dx * 0.008) * Math.min(1, 16 / dt); vpitch = e.touches ? 0 : (-dy * 0.006) * Math.min(1, 16 / dt);
    lastX = x; lastY = y; lastT = t; idleSince = t;
    if (e.cancelable && !e.touches) e.preventDefault();
  };
  const onUp = () => { if (!dragging) return; dragging = false; idleSince = performance.now(); canvas.style.cursor = 'grab'; };
  canvas.style.cursor = 'grab'; canvas.style.touchAction = 'pan-y';
  canvas.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: true }); canvas.addEventListener('touchmove', onMove, { passive: true }); window.addEventListener('touchend', onUp);

  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  if (reduce) { started = true; p = 1; } else { started = true; t0 = performance.now() + 150; idleSince = t0 + DUR; }
  raf = requestAnimationFrame(frame);

  return {
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('touchend', onUp); },
    replay() { p = 0; started = true; t0 = performance.now(); idleSince = t0 + DUR; },
    zoom(delta) { zoom = clamp(zoom * (delta > 0 ? 1.25 : 0.8), 0.45, 2.6); S = 2.6 * zoom; idleSince = performance.now(); return zoom; },
    setView(y, pt) { yaw = y; pitch = clamp(pt, 0.2, 1.1); vyaw = vpitch = 0; idleSince = performance.now(); },
    get progress() { return p; },
    counts: { buildings: city.buildings.length + 1, blocks: city.vox.length, trees: city.trees.length },
  };
}
