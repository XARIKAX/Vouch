/* ============================================================================
   PixelCity — a whole voxel city, built block by block, that you can grab,
   turn and zoom. The same technique as the homepage tower (skyscraper.js):
   an orthographic camera with yaw + pitch projects a voxel model into a small
   logical pixel buffer that is upscaled with nearest-neighbour sampling, so
   the city is crisp pixel art while being fully 3D.

   The hero tower from the homepage stands in the middle; a grid of glass
   blocks and towers grows outward from it in waves. One building per lot on
   a street grid, a plaza around the tower, lamps along the streets.

   mountPixelCity(canvas, { palette, duration, detail }) →
     { destroy(), replay(), zoom(delta), setView(yaw, pitch) }
   ========================================================================== */

const LW = 480, LH = 270;                    // logical buffer (16:9)

export const CITY_PALETTE = {
  ground: '#0d0b1c', groundLight: '#17132c', rim: '#09081a', shadow: '#050411',
  street: '#141127', lamp: '#f3d27a', plaza: '#1b1736',
  glass: ['#141c3e', '#192348', '#1f2b57', '#263464', '#2d3d72'],
  violet: ['#2a2270', '#352b85', '#41359a', '#4e3fb0', '#5b4bc4'],
  glassEdge: '#8f7cff',
  window: ['#f3d27a', '#ffe9a8', '#e9c35f', '#fff4cc'],
  spire: '#9fb2e6', spireTip: '#fff7d6', glow: '#5b3df0', star: '#c9bfff',
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

  // --- the hero tower: the homepage tri-wing form, at city scale ---
  const CORE_H = 46, SPIRE_H = 14;
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

  // --- the grid: lots between streets, one building per lot ---
  const LOT = 6, STREET = 2, PITCH = LOT + STREET, R = detail === 'lite' ? 28 : 38;
  const PLAZA = 9;                             // radius kept clear around the tower
  const buildings = [];
  let b = 0;
  for (let gx = -R; gx <= R - LOT; gx += PITCH) for (let gz = -R; gz <= R - LOT; gz += PITCH) {
    const cx = gx + LOT / 2, cz = gz + LOT / 2;
    const d = Math.hypot(cx, cz);
    if (d > R - 2 || d < PLAZA) continue;
    const r1 = h2(gx, gz), r2 = h2(gz, gx), r3 = h2(gx + 1, gz + 3);
    if (r1 < (d < R * 0.5 ? 0.06 : 0.22)) continue;                 // empty lot (park)
    const w = 3 + Math.floor(r2 * 3), dd = 3 + Math.floor(r3 * 3);  // 3..5 footprint
    const x0 = gx + Math.floor((LOT - w) * h2(gx + 5, gz)), z0 = gz + Math.floor((LOT - dd) * h2(gz + 5, gx));
    const near = 1 - clamp((d - PLAZA) / (R - PLAZA), 0, 1);
    const h = Math.max(3, Math.round(4 + near * near * 26 + r1 * 10 * (0.4 + near)));
    const shade = Math.floor(h2(gx + 9, gz + 9) * 5);
    const violet = h2(gx + 3, gz + 7) < 0.18;                        // a few violet-glass towers
    const setback = h > 14 && h2(gx + 2, gz + 2) < 0.5 ? Math.round(h * (0.55 + 0.25 * h2(gx, gz + 1))) : null;
    const antenna = h > 18 && h2(gx + 4, gz + 4) < 0.35;
    const id = b++;
    buildings.push({ id, x0, z0, w, d: dd, h, cx: x0 + w / 2, cz: z0 + dd / 2, dist: d });
    for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + dd; z++) for (let y = 0; y < h; y++) {
      if (setback !== null && y >= setback && (x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + dd - 1)) continue;
      put(x, y, z, violet ? 'violet' : 'city', { b: id, shade });
    }
    if (antenna) { const ax = x0 + Math.floor(w / 2), az = z0 + Math.floor(dd / 2); for (let y = h; y < h + 3; y++) put(ax, y, az, 'spire', { b: id }); }
  }
  const maxD = R;

  // --- shells, faces, timing, windows ---
  const vox = [];
  const towerT = (y) => y >= CORE_H ? 0.90 + 0.08 * ((y - CORE_H) / SPIRE_H) : 0.22 + 0.66 * Math.pow(y / CORE_H, 0.8);
  for (const v of occ.values()) {
    let f = 0;
    if (!occ.has(key(v.x, v.y + 1, v.z))) f |= TOP;
    if (!occ.has(key(v.x + 1, v.y, v.z))) f |= PX;
    if (!occ.has(key(v.x - 1, v.y, v.z))) f |= NX;
    if (!occ.has(key(v.x, v.y, v.z + 1))) f |= PZ;
    if (!occ.has(key(v.x, v.y, v.z - 1))) f |= NZ;
    if (!f) continue;
    v.f = f;
    if (v.b === -1) {
      v.shade = Math.floor(h2(v.x * 1.7, v.z * 0.9) * 5);
      v.t0 = (v.kind === 'tower' ? towerT(v.y) + (h2(v.x, v.z + v.y) - 0.5) * 0.02 : towerT(v.y));
    } else {
      const bd = buildings[v.b];
      // waves from the centre outward; each building rises floor by floor
      v.t0 = 0.06 + 0.70 * Math.pow(bd.dist / maxD, 0.95) + (v.y / Math.max(1, bd.h)) * 0.10 + (h2(v.b, v.y) - 0.5) * 0.015;
    }
    v.win = 0;
    if (v.kind === 'tower' || v.kind === 'city' || v.kind === 'violet') {
      const lit = v.kind === 'tower'
        ? (h1(v.y * 3.3) < 0.64 && h2(Math.floor(v.x / 2) + 40, v.y + Math.floor(v.z / 2)) < 0.8)
        : (v.y % 2 === 0 && h2(v.x, v.z + v.y) < 0.55);
      if (lit) { v.win = v.f & (PX | NX | PZ | NZ); v.wc = Math.floor(h2(v.x + 2, v.z + v.y) * 4); v.wt = v.t0 + 0.03 + h2(v.y, v.x + 7) * 0.08; v.on = true; }
    }
    vox.push(v);
  }
  const windows = vox.filter((v) => v.win);
  const colMap = new Map();
  for (const v of vox) { const k = v.x + ',' + v.z; if (!colMap.has(k)) colMap.set(k, { x: v.x, z: v.z, vs: [] }); colMap.get(k).vs.push(v); }
  const cols = [...colMap.values()]; cols.forEach((c) => c.vs.sort((a, b) => a.y - b.y));

  // street lamps: along street centre lines, every few blocks
  const lamps = [];
  for (let g = -R; g <= R; g += PITCH) {
    const s = g - STREET / 2 - 0.5;
    for (let t = -R; t <= R; t += 4) {
      if (Math.hypot(s, t) > R - 1 || Math.hypot(s, t) < PLAZA - 2) continue;
      lamps.push({ x: s, z: t, t0: 0.5 + 0.4 * (Math.hypot(s, t) / R) });
      lamps.push({ x: t, z: s, t0: 0.5 + 0.4 * (Math.hypot(t, s) / R) });
    }
  }
  return { vox, cols, windows, lamps, buildings, tipY, CORE_H, R, PLAZA };
}

// ---- renderer ---------------------------------------------------------------
export function mountPixelCity(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const P = { ...CITY_PALETTE, ...(opts.palette || {}) };
  const C = { ground: hex(P.ground), groundLight: hex(P.groundLight), rim: hex(P.rim), shadow: hex(P.shadow), street: hex(P.street), lamp: hex(P.lamp), plaza: hex(P.plaza),
    glass: P.glass.map(hex), violet: P.violet.map(hex), glassEdge: hex(P.glassEdge), win: P.window.map(hex), spire: hex(P.spire), spireTip: hex(P.spireTip), glow: hex(P.glow), star: hex(P.star) };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = !window.matchMedia('(pointer:fine)').matches;
  const detail = opts.detail && opts.detail !== 'auto' ? opts.detail : (coarse || window.innerWidth < 720 ? 'lite' : 'full');
  const DUR = (opts.duration || 9000) / (opts.speed || 1);
  const city = buildCityModel(detail);

  const lo = document.createElement('canvas'); lo.width = LW; lo.height = LH; const g = lo.getContext('2d');
  const stars = Array.from({ length: 70 }, (_, i) => ({ x: Math.floor(h1(i * 3.1) * LW), y: Math.floor(h1(i * 7.7) * LH * 0.9), a: 0.2 + h1(i) * 0.5 }));

  let yaw = -0.62, pitch = 0.58, vyaw = 0, vpitch = 0, dragging = false, lastX = 0, lastY = 0, lastT = 0, idleSince = 0;
  let zoom = opts.zoom || 1, S = 2 * zoom;
  let W = 0, H = 0, DPR = 1, scale = 1, ox = 0, oy = 0;
  let t0 = 0, p = reduce ? 1 : 0, started = false, raf = 0, nextFlick = 0;
  const CX = LW / 2, CY = LH * 0.66;
  const light = [-0.55, 0.75, -0.42];

  function resize() {
    const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = W * DPR; canvas.height = H * DPR;
    scale = Math.max(W / LW, H / LH); ox = (W - LW * scale) / 2; oy = (H - LH * scale) / 2; // cover
  }

  let cy_, sy_, cp_, sp_;
  const proj = (x, y, z) => { const rx = x * cy_ - z * sy_, rz = x * sy_ + z * cy_; return { sx: CX + rx * S, sy: CY - (y * cp_ - rz * sp_) * S, d: rz * cp_ + y * sp_ }; };
  function face(sx, sy, o, col) {
    g.fillStyle = col;
    g.beginPath(); g.moveTo(Math.round(sx + o[0][0]), Math.round(sy + o[0][1]));
    for (let i = 1; i < 4; i++) g.lineTo(Math.round(sx + o[i][0]), Math.round(sy + o[i][1]));
    g.closePath(); g.fill();
  }
  const poly = (pts, col) => { g.fillStyle = col; g.beginPath(); pts.forEach((q, i) => i ? g.lineTo(Math.round(q.sx), Math.round(q.sy)) : g.moveTo(Math.round(q.sx), Math.round(q.sy))); g.closePath(); g.fill(); };

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
    const nz = (nx, nzz) => nx * sy_ + nzz * cy_;
    const showPX = nz(1, 0) < 0, showNX = nz(-1, 0) < 0, showPZ = nz(0, 1) < 0, showNZ = nz(0, -1) < 0;
    const lum = (nx, ny, nzz) => { const rx = nx * cy_ - nzz * sy_, rz = nx * sy_ + nzz * cy_; const d = rx * light[0] + ny * light[1] + rz * light[2]; return 0.68 + 0.5 * Math.max(0, d); };
    const L = { top: 0.95 + 0.45 * lum(0, 1, 0), px: lum(1, 0, 0), nx: lum(-1, 0, 0), pz: lum(0, 0, 1), nzf: lum(0, 0, -1) };

    // --- night backdrop: ground colour, star dust, the glow at the centre ---
    g.fillStyle = css(C.ground); g.fillRect(0, 0, LW, LH);
    for (const s of stars) { g.fillStyle = css(C.star, 1, s.a * (0.6 + 0.4 * Math.sin(tm / 700 + s.x))); g.fillRect(s.x, s.y, 1, 1); }
    const ga = clamp(now / 0.3, 0, 1);
    [[150, .05], [100, .07], [56, .10]].forEach(([r, a]) => { g.fillStyle = css(C.glow, 1, a * ga); g.beginPath(); g.ellipse(CX, CY, r, r * 0.55, 0, 0, Math.PI * 2); g.fill(); });

    // --- the plate: a rounded square slab with streets and a plaza ---
    const pa = clamp(now / 0.08, 0, 1);
    const R = city.R, n = 28, top = [], bot = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const sq = (v) => Math.sign(v) * Math.pow(Math.abs(v), 0.55) * (R + 2); const x = sq(Math.cos(a)), z = sq(Math.sin(a)); top.push(proj(x, 0, z)); bot.push(proj(x, -2.5, z)); }
    g.fillStyle = css(C.shadow, 1, .6 * pa); g.beginPath(); top.forEach((q, i) => i ? g.lineTo(Math.round(q.sx + 4), Math.round(q.sy + 9)) : g.moveTo(Math.round(q.sx + 4), Math.round(q.sy + 9))); g.closePath(); g.fill();
    for (let i = 0; i < n; i++) { const a = top[i], b = top[(i + 1) % n], a2 = bot[i], b2 = bot[(i + 1) % n]; if (b.sx - a.sx <= 0) continue; g.fillStyle = css(C.rim, 1, pa); g.beginPath(); g.moveTo(Math.round(a.sx), Math.round(a.sy)); g.lineTo(Math.round(b.sx), Math.round(b.sy)); g.lineTo(Math.round(b2.sx), Math.round(b2.sy)); g.lineTo(Math.round(a2.sx), Math.round(a2.sy)); g.closePath(); g.fill(); }
    poly(top, css(C.groundLight, 1, pa));
    // streets as dark bands (two directions) and the plaza disc
    const PITCH = 8, STREET = 2;
    g.fillStyle = css(C.street, 1, pa);
    for (let gx = -R - 1; gx <= R; gx += PITCH) {
      const s0 = gx - STREET - 0.5, s1 = gx - 0.5;
      poly([proj(s0, 0.02, -R), proj(s1, 0.02, -R), proj(s1, 0.02, R), proj(s0, 0.02, R)], css(C.street, 1, pa));
      poly([proj(-R, 0.02, s0), proj(R, 0.02, s0), proj(R, 0.02, s1), proj(-R, 0.02, s1)], css(C.street, 1, pa));
    }
    const plaza = []; for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; plaza.push(proj(Math.cos(a) * city.PLAZA, 0.04, Math.sin(a) * city.PLAZA)); }
    poly(plaza, css(C.plaza, 1, pa));
    if (now > 0.2) for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; const q = proj(Math.cos(a) * 6.5, 0.1, Math.sin(a) * 6.5); g.fillStyle = css(C.lamp, 1, .8 * clamp((now - .2) / .1, 0, 1)); g.fillRect(Math.round(q.sx), Math.round(q.sy), 1, 1); }

    // --- voxels, by column, far → near; settled runs merge into single quads ---
    const glassFor = (v) => v.kind === 'violet' ? C.violet[v.shade] : v.kind === 'spire' ? C.spire : v.kind === 'collar' ? C.glassEdge : C.glass[v.shade];
    const sides = [[NX, O.nx, showNX, L.nx], [PZ, O.pz, showPZ, L.pz], [NZ, O.nz, showNZ, L.nzf], [PX, O.px, showPX, L.px]];
    const cols = city.cols;
    for (const col of cols) col.d = (col.x * sy_ + col.z * cy_) * cp_;
    cols.sort((a, b) => b.d - a.d);
    const riseY = -cp_ * S;
    const list = [];
    // lamps are on the ground: draw those behind a column before it (approximate by depth bucket)
    const lampsSorted = city.lamps.map((l) => ({ ...l, d: (l.x * sy_ + l.z * cy_) * cp_ })).sort((a, b) => b.d - a.d);
    let li = 0;
    const drawLampsUntil = (d) => { for (; li < lampsSorted.length && lampsSorted[li].d >= d; li++) { const l = lampsSorted[li]; if (now < l.t0) continue; const q = proj(l.x, 0.6, l.z); g.fillStyle = css(C.lamp, 1, .9); g.fillRect(Math.round(q.sx), Math.round(q.sy), 1, 1); g.fillStyle = css(C.lamp, 1, .18); g.fillRect(Math.round(q.sx) - 1, Math.round(q.sy) + 1, 3, 1); } };
    for (const col of cols) {
      drawLampsUntil(col.d);
      const runs = new Map(), tops = [], wins = [];
      const flush = (bit) => { const r = runs.get(bit); if (!r) return; runs.delete(bit);
        const q = proj(col.x, r.y0, col.z), h = r.y1 - r.y0 + 1, o = r.o;
        face(q.sx, q.sy, [o[0], o[1], [o[1][0], o[1][1] + riseY * (h - 1)], [o[0][0], o[0][1] + riseY * (h - 1)]], css(r.col, r.lm)); };
      const flushAll = () => { for (const [bit] of sides) flush(bit); };
      for (const v of col.vs) {
        if (now < v.t0) { flushAll(); continue; }
        const k = clamp((now - v.t0) / 0.04, 0, 1);
        if (k < 1) {
          flushAll();
          const e = easeOutBack(k), q = proj(v.x, v.y - (1 - e) * 1.6, v.z), cc = glassFor(v);
          for (const [bit, o, show, lm] of sides) if (show && (v.f & bit)) face(q.sx, q.sy, o, css(cc, lm));
          if (v.f & TOP) face(q.sx, q.sy, O.top, css(cc, L.top));
          if (k > 0.3) { g.fillStyle = css(C.glassEdge, 1, (1 - k) * .9); g.fillRect(Math.round(q.sx), Math.round(q.sy - S), 1, 1); }
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
      for (const v of tops) { const q = proj(v.x, v.y, v.z); face(q.sx, q.sy, O.top, css(glassFor(v), L.top)); }
      if (S >= 1.5) for (const v of wins) { const q = proj(v.x, v.y, v.z); for (const [bit, o, show] of sides) if (show && (v.win & bit)) win(q, o, v, now); }
    }
    drawLampsUntil(-Infinity);
    function win(q, o, v, now) {
      const a = clamp((now - v.wt) / 0.03, 0, 1);
      const mx = (o[0][0] + o[2][0]) / 2, my = (o[0][1] + o[2][1]) / 2;
      const sc = v.kind === 'tower' ? .5 : .42;
      face(q.sx, q.sy, o.map(([x, y]) => [mx + (x - mx) * sc, my + (y - my) * sc]), css(C.win[v.wc ?? 1], 1, .95 * a));
    }
    // spire tip + summit glow
    if (now >= 0.98) { const k = clamp((now - .98) / .02, 0, 1); const q = proj(0, city.tipY + 0.5, 0); g.fillStyle = css(C.spireTip, 1, k); g.fillRect(Math.round(q.sx), Math.round(q.sy), 1, 1); g.fillStyle = css(C.spireTip, 1, .35 * k); g.fillRect(Math.round(q.sx) - 1, Math.round(q.sy) - 1, 3, 3); }
    if (now > 0.97) { const k = clamp((now - .97) / .03, 0, 1) * (done ? .75 + .25 * Math.sin(tm / 1400) : 1); const q = proj(0, city.CORE_H - 5, 0); [[22, .03], [14, .05], [8, .08]].forEach(([r, a]) => { g.fillStyle = css(C.win[1], 1, a * k); g.beginPath(); g.ellipse(q.sx, q.sy, r, r * 1.5, 0, 0, Math.PI * 2); g.fill(); }); }
    if (done && detail !== 'lite') for (let i = 0; i < 4; i++) { const v = list[Math.floor(h2(Math.floor(tm / 90), i) * list.length)]; if (v) { const q = proj(v.x, v.y, v.z); g.fillStyle = css(C.glassEdge, 1, .35); g.fillRect(Math.round(q.sx), Math.round(q.sy - S + 1), 1, 1); } }

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lo, Math.round(ox), Math.round(oy), LW * scale, LH * scale);
  }

  let slowFrames = 0, lastFrame = 0, degraded = false;
  function frame(tm) {
    if (lastFrame && tm - lastFrame > 28) {
      if (++slowFrames > 40 && !degraded) { degraded = true; if (p < 0.2) { city.cols = city.cols.filter((c) => c.vs[0].b === -1 || h1(c.x * 3 + c.z) < 0.6); } }
    } else slowFrames = Math.max(0, slowFrames - 1);
    lastFrame = tm;
    if (started && p < 1) p = clamp((tm - t0) / DUR, 0, 1);
    const now = p;
    if (!dragging) {
      yaw += vyaw; pitch = clamp(pitch + vpitch, 0.2, 1.1); vyaw *= 0.93; vpitch *= 0.9;
      if (!reduce && tm - idleSince > 2600) yaw += now >= 1 ? 0.0016 : 0.0009;
    }
    if (now >= 1 && tm > nextFlick) { const w = city.windows[Math.floor(h1(tm) * city.windows.length)]; if (w) w.on = w.on ? h1(tm * 1.3) > 0.18 : h1(tm * 1.7) < 0.45; nextFlick = tm + 500 + h1(tm) * 700; }
    draw(now, tm);
    if (reduce && now >= 1 && !dragging && Math.abs(vyaw) < 1e-4) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
  }

  const pos = (e) => e.touches ? [e.touches[0].clientX, e.touches[0].clientY] : [e.clientX, e.clientY];
  const onDown = (e) => { dragging = true; [lastX, lastY] = pos(e); lastT = performance.now(); vyaw = vpitch = 0; canvas.style.cursor = 'grabbing'; if (!raf) raf = requestAnimationFrame(frame); };
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
  // builds as soon as it is on screen (the page opens on it)
  const start = () => { if (started) return; started = true; t0 = performance.now() + 150; idleSince = t0 + DUR; };
  if (reduce) { started = true; p = 1; } else start();
  raf = requestAnimationFrame(frame);

  return {
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('touchend', onUp); },
    replay() { p = 0; started = true; t0 = performance.now(); idleSince = t0 + DUR; if (!raf) raf = requestAnimationFrame(frame); },
    zoom(delta) { zoom = clamp(zoom * (delta > 0 ? 1.25 : 0.8), 0.5, 2.6); S = 2 * zoom; idleSince = performance.now(); if (!raf) raf = requestAnimationFrame(frame); return zoom; },
    setView(y, pt) { yaw = y; pitch = clamp(pt, 0.2, 1.1); vyaw = vpitch = 0; idleSince = performance.now(); if (!raf) raf = requestAnimationFrame(frame); },
    get progress() { return p; },
    counts: { buildings: city.buildings.length + 1, blocks: city.vox.length },
  };
}
