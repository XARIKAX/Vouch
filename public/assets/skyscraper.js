/* ============================================================================
   PixelSkyscraper — a 3D voxel city, constructed piece by piece, that you can
   grab and turn.

   The scene is a voxel model (tri-wing tower with spiralling setbacks, core,
   spire, podium, surrounding blocks). An orthographic camera with yaw + pitch
   projects it into a small logical pixel buffer that is upscaled with
   nearest-neighbour sampling, so the result stays a crisp pixel object while
   being fully 3D: faces shade against a fixed light as the model rotates, and
   only exposed, camera-facing faces are drawn.

   mountPixelSkyscraper(canvas, { speed, detail, palette }) →
     { destroy(), replay(), seek(p), setView(yaw, pitch) }
   ========================================================================== */

const LW = 240, LH = 360, S = 3;            // logical buffer, px per block
const HORIZON = 318;                        // backdrop water line

export const DEFAULT_PALETTE = {
  sky: ['#0b1544', '#10195a', '#182268', '#232b74', '#352f7c', '#4a3681', '#654184', '#86507f', '#ad6174', '#d07a60', '#ea9752', '#f4b65e'],
  cloud: ['#2b2f7a', '#5a3f88', '#9a5b7a', '#df8d5c'],
  glass: ['#141c3e', '#192348', '#1f2b57', '#263464', '#2d3d72'],
  glassEdge: '#7f95d8',
  window: ['#f2a845', '#ffd07a', '#e8902e', '#ffe39d'],
  plate: '#1c2042', plateRim: '#121634', plateLight: '#ffd58a',
  city: '#161c3f', cityWin: '#c98a44',
  spire: '#9fb2e6', spireTip: '#fff4c2',
  water: '#0c1434', shadow: '#070b22',
};

const h1 = (a) => { const x = Math.sin(a * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const h2 = (a, b) => h1(a * 7.31 + b * 19.17);
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const css = (c, m = 1, a = 1) => `rgba(${(c[0] * m) | 0},${(c[1] * m) | 0},${(c[2] * m) | 0},${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOutBack = (k) => { const c1 = 1.15, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };

// face bits
const TOP = 1, PX = 2, NX = 4, PZ = 8, NZ = 16;

// ---- geometry ---------------------------------------------------------------
// Tri-wing plan around a core (the Burj form): each wing is a 3-wide bar that
// steps down in segments as it reaches outward; the three wings' setbacks are
// offset so the silhouette spirals as the tower rises.
export function buildCity3D(detail = 'full') {
  const occ = new Map();                      // "x,y,z" -> voxel
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const put = (x, y, z, kind, extra = {}) => { const k = key(x, y, z); if (!occ.has(k)) occ.set(k, { x, y, z, kind, ...extra }); };

  const CORE_H = 74, SPIRE_H = 22;
  // core 3x3
  for (let y = 0; y < CORE_H; y++) for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) put(x, y, z, 'tower');
  // wings
  const SEG = 2, SEGS = 7;
  for (let k = 0; k < 3; k++) {
    const a = (Math.PI / 2) + k * (2 * Math.PI / 3);
    const dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
    for (let j = 0; j < SEGS; j++) {
      const H = Math.max(6, CORE_H - 4 - j * 8 - k * 3);
      for (let t = 0; t < SEG; t++) {
        const r = 1.5 + j * SEG + t;
        for (let w = -1; w <= 1; w++) {
          const x = Math.round(dx * r + px * w), z = Math.round(dz * r + pz * w);
          for (let y = 0; y < H; y++) put(x, y, z, 'tower', { wing: k, j });
        }
      }
    }
  }
  // spire: single column, then a 2-wide collar at its base
  for (let y = CORE_H; y < CORE_H + SPIRE_H; y++) put(0, y, 0, y < CORE_H + 3 ? 'collar' : 'spire');
  const tipY = CORE_H + SPIRE_H;

  // surrounding blocks on the plate
  const specs = detail === 'lite'
    ? [[-16, -12, 4, 4, 14], [15, 9, 4, 5, 18], [12, -15, 3, 3, 9], [-13, 13, 5, 3, 11]]
    : [[-17, -12, 4, 4, 14], [-20, -4, 3, 3, 9], [15, 9, 4, 5, 18], [19, 2, 3, 4, 12], [12, -16, 3, 3, 9], [-13, 14, 5, 3, 11], [4, 18, 3, 3, 7], [-5, -19, 3, 3, 8], [18, -9, 3, 3, 6]];
  specs.forEach(([x0, z0, w, d, h], i) => { for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + d; z++) for (let y = 0; y < h; y++) put(x, y, z, 'city', { b: i }); });

  // shell extraction + exposed faces + construction timing + windows
  const vox = [];
  const rowT = (y) => y >= CORE_H ? 0.90 + 0.085 * ((y - CORE_H) / SPIRE_H) : 0.30 + 0.58 * Math.pow(y / CORE_H, 0.78);
  for (const v of occ.values()) {
    let f = 0;
    if (!occ.has(key(v.x, v.y + 1, v.z))) f |= TOP;
    if (!occ.has(key(v.x + 1, v.y, v.z))) f |= PX;
    if (!occ.has(key(v.x - 1, v.y, v.z))) f |= NX;
    if (!occ.has(key(v.x, v.y, v.z + 1))) f |= PZ;
    if (!occ.has(key(v.x, v.y, v.z - 1))) f |= NZ;
    if (!f) continue;                         // fully enclosed: never drawn
    v.f = f;
    v.shade = Math.floor(h2(v.x * 1.7, v.z * 0.9) * 5);   // uniform per column: glass reads as vertical bands, and columns merge into single quads
    if (v.kind === 'tower') v.t0 = rowT(v.y) + (h2(v.x, v.z + v.y) - 0.5) * 0.02;
    else if (v.kind === 'spire' || v.kind === 'collar') v.t0 = rowT(v.y);
    else v.t0 = 0.15 + 0.2 * (v.b / 9) + (v.y / 18) * 0.06 + h2(v.x, v.z) * 0.02;
    // windows: on exposed side faces, clustered by floor, dark floors between
    v.win = 0;
    if (v.kind === 'tower' || v.kind === 'city') {
      const lit = v.kind === 'tower' ? (h1(v.y * 3.3) < 0.64 && h2(Math.floor(v.x / 2) + 40, v.y + Math.floor(v.z / 2)) < 0.8) : (v.y % 2 === 0 && h2(v.x, v.z + v.y) < 0.5);
      if (lit) { v.win = v.f & (PX | NX | PZ | NZ); v.wc = Math.floor(h2(v.x + 2, v.z + v.y) * 4); v.wt = v.t0 + 0.02 + h2(v.y, v.x + 7) * 0.06; v.on = true; }
    }
    vox.push(v);
  }
  const windows = vox.filter((v) => v.win);
  // vertical columns (x,z) of shell voxels, sorted by height — the render unit
  const colMap = new Map();
  for (const v of vox) { const k = v.x + ',' + v.z; if (!colMap.has(k)) colMap.set(k, { x: v.x, z: v.z, vs: [] }); colMap.get(k).vs.push(v); }
  const cols = [...colMap.values()]; cols.forEach((c) => c.vs.sort((a, b) => a.y - b.y));
  // clouds for the backdrop
  const clouds = [];
  for (let i = 0; i < (detail === 'lite' ? 4 : 7); i++) {
    const rects = []; for (let k = 0; k < 4; k++) rects.push({ dx: Math.round((h2(i, k) - .5) * 30), dy: Math.round((h2(k, i) - .5) * 8), w: 12 + Math.round(h2(i + 1, k) * 26), h: 3 + Math.round(h2(k + 1, i) * 5) });
    const cy = 24 + h1(i * 7.7) * 190;
    clouds.push({ cx: 10 + h1(i * 5.1) * 220, cy, band: Math.min(3, Math.floor(cy / 70)), rects, t0: 0.04 + h1(i) * 0.1, drift: 0.15 + h1(i * 3) * 0.2 });
  }
  return { vox, cols, windows, clouds, tipY, CORE_H, plateR: 23 };
}

// ---- renderer ---------------------------------------------------------------
export function mountPixelSkyscraper(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const P = { ...DEFAULT_PALETTE, ...(opts.palette || {}) };
  const C = { sky: P.sky.map(hex), cloud: P.cloud.map(hex), glass: P.glass.map(hex), glassEdge: hex(P.glassEdge), win: P.window.map(hex),
    plate: hex(P.plate), plateRim: hex(P.plateRim), plateLight: hex(P.plateLight), city: hex(P.city), cityWin: hex(P.cityWin),
    spire: hex(P.spire), spireTip: hex(P.spireTip), water: hex(P.water), shadow: hex(P.shadow) };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = !window.matchMedia('(pointer:fine)').matches;
  const detail = opts.detail && opts.detail !== 'auto' ? opts.detail : (coarse || window.innerWidth < 720 ? 'lite' : 'full');
  const DUR = (opts.duration || 6800) / (opts.speed || 1);
  const city = buildCity3D(detail);

  const lo = document.createElement('canvas'); lo.width = LW; lo.height = LH; const g = lo.getContext('2d');
  const sky = document.createElement('canvas'); sky.width = LW; sky.height = LH; const sg = sky.getContext('2d');
  (() => {                                     // static backdrop: quantised, dithered sky + water band
    const bands = C.sky.length, bh = Math.ceil(HORIZON / bands);
    for (let i = 0; i < bands; i++) { sg.fillStyle = css(C.sky[i]); sg.fillRect(0, i * bh, LW, bh); }
    for (let i = 1; i < bands; i++) { sg.fillStyle = css(C.sky[i]); for (let x = 0; x < LW; x++) { if (h2(i, x) < .5) sg.fillRect(x, i * bh - 1, 1, 1); if (h2(i + 40, x) < .22) sg.fillRect(x, i * bh - 2, 1, 1); } }
    sg.fillStyle = css(C.water); sg.fillRect(0, HORIZON, LW, LH - HORIZON);
    for (let i = 0; i < 3; i++) { sg.fillStyle = css(C.sky[bands - 1], 1, .1); sg.fillRect(0, HORIZON - 22 + i * 7, LW, 7 - i * 2); }
  })();

  // ---- camera / state ----
  let yaw = -0.55, pitch = 0.34, vyaw = 0, vpitch = 0, dragging = false, lastX = 0, lastY = 0, lastT = 0, idleSince = 0;
  let W = 0, H = 0, DPR = 1, scale = 1, ox = 0, oy = 0;
  let t0 = 0, p = reduce ? 1 : 0, seeked = null, started = reduce, raf = 0, nextFlick = 0;
  const CX = LW / 2, CY = LH * 0.88;        // screen position of the plate centre
  const light = [-0.55, 0.75, -0.42];        // fixed world light: upper-left-front

  function resize() {
    const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = W * DPR; canvas.height = H * DPR;
    scale = Math.min(W / LW, H / LH); ox = (W - LW * scale) / 2; oy = (H - LH * scale) / 2;
  }

  // per-frame projection basis
  let cy_, sy_, cp_, sp_;
  const proj = (x, y, z) => {                 // world → screen (logical px) + depth
    const rx = x * cy_ - z * sy_, rz = x * sy_ + z * cy_;
    return { sx: CX + rx * S, sy: CY - (y * cp_ - rz * sp_) * S, d: rz * cp_ + y * sp_ };
  };
  function face(sx, sy, o, col, a = 1) {     // o: 4 corner offsets [[dx,dy]..]
    g.fillStyle = typeof col === 'string' ? col : css(col, 1, a);
    g.beginPath(); g.moveTo(Math.round(sx + o[0][0]), Math.round(sy + o[0][1]));
    for (let i = 1; i < 4; i++) g.lineTo(Math.round(sx + o[i][0]), Math.round(sy + o[i][1]));
    g.closePath(); g.fill();
  }

  function draw(now, tm) {
    const done = now >= 1;
    cy_ = Math.cos(yaw); sy_ = Math.sin(yaw); cp_ = Math.cos(pitch); sp_ = Math.sin(pitch);
    // unit-cube corner offsets for this camera (orthographic → same for every voxel)
    const c = (x, y, z) => { const q = proj(x, y, z); return [q.sx - CX, q.sy - CY]; };
    const O = { // faces as corner offset quads (voxel spans x,z ∈ [-.5,.5], y ∈ [0,1])
      top: [c(-.5, 1, -.5), c(.5, 1, -.5), c(.5, 1, .5), c(-.5, 1, .5)],
      px: [c(.5, 0, -.5), c(.5, 0, .5), c(.5, 1, .5), c(.5, 1, -.5)],
      nx: [c(-.5, 0, .5), c(-.5, 0, -.5), c(-.5, 1, -.5), c(-.5, 1, .5)],
      pz: [c(.5, 0, .5), c(-.5, 0, .5), c(-.5, 1, .5), c(.5, 1, .5)],
      nz: [c(-.5, 0, -.5), c(.5, 0, -.5), c(.5, 1, -.5), c(-.5, 1, -.5)],
    };
    // camera-facing sides: a side is visible when its rotated normal points toward the viewer (-z')
    const nz = (nx, nzz) => nx * sy_ + nzz * cy_;    // z' component of a rotated horizontal normal
    const showPX = nz(1, 0) < 0, showNX = nz(-1, 0) < 0, showPZ = nz(0, 1) < 0, showNZ = nz(0, -1) < 0;
    // lighting per face normal (rotated), fixed light
    const lum = (nx, ny, nzz) => { const rx = nx * cy_ - nzz * sy_, rz = nx * sy_ + nzz * cy_; const d = rx * light[0] + ny * light[1] + rz * light[2]; return 0.68 + 0.5 * Math.max(0, d); };
    const L = { top: 0.95 + 0.45 * lum(0, 1, 0), px: lum(1, 0, 0), nx: lum(-1, 0, 0), pz: lum(0, 0, 1), nzf: lum(0, 0, -1) };

    // --- backdrop ---
    g.clearRect(0, 0, LW, LH);
    g.globalAlpha = clamp(now / 0.12, 0, 1); g.drawImage(sky, 0, 0); g.globalAlpha = 1;
    for (const cl of city.clouds) { const a = clamp((now - cl.t0) / .06, 0, 1); if (a <= 0) continue; const drift = Math.round((tm / 1000) * cl.drift); g.fillStyle = css(C.cloud[cl.band], 1, .5 * a); for (const r of cl.rects) { let x = ((Math.round(cl.cx + r.dx + drift) + 30) % (LW + 60)) - 30; g.fillRect(x, Math.round(cl.cy + r.dy), r.w, r.h); } }
    // water shimmer lines
    for (let y = HORIZON + 2; y < LH; y += 3) { const o = Math.round(2 * Math.sin(y * .7 + tm / 900)); g.fillStyle = css(C.sky[C.sky.length - 2], 1, .05 + .04 * h1(y)); g.fillRect(o + (y * 13) % 40, y, 26, 1); }

    // --- plate: a rounded square slab, drawn as polygons (cheap, crisp) ---
    const pa = clamp((now - 0.12) / 0.1, 0, 1);
    if (pa > 0) {
      const R = city.plateR, n = 24, top = [], bot = [];
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; const sq = (v) => Math.sign(v) * Math.pow(Math.abs(v), 0.6) * R; const x = sq(Math.cos(a)), z = sq(Math.sin(a)); top.push(proj(x, 0, z)); bot.push(proj(x, -2, z)); }
      // shadow on the water beneath
      g.fillStyle = css(C.shadow, 1, .55 * pa); g.beginPath(); top.forEach((q, i) => i ? g.lineTo(Math.round(q.sx + 3), Math.round(q.sy + 7)) : g.moveTo(Math.round(q.sx + 3), Math.round(q.sy + 7))); g.closePath(); g.fill();
      // rim: only the segments facing the camera
      for (let i = 0; i < n; i++) { const a = top[i], b = top[(i + 1) % n], a2 = bot[i], b2 = bot[(i + 1) % n]; if (b.sx - a.sx <= 0) continue; g.fillStyle = css(C.plateRim, 1, pa); g.beginPath(); g.moveTo(Math.round(a.sx), Math.round(a.sy)); g.lineTo(Math.round(b.sx), Math.round(b.sy)); g.lineTo(Math.round(b2.sx), Math.round(b2.sy)); g.lineTo(Math.round(a2.sx), Math.round(a2.sy)); g.closePath(); g.fill(); }
      g.fillStyle = css(C.plate, 1, pa); g.beginPath(); top.forEach((q, i) => i ? g.lineTo(Math.round(q.sx), Math.round(q.sy)) : g.moveTo(Math.round(q.sx), Math.round(q.sy))); g.closePath(); g.fill();
      // fountain lights ring on the plate
      if (now > 0.25) for (let i = 0; i < 18; i++) { const a = (i / 18) * Math.PI * 2; const q = proj(Math.cos(a) * 9, 0, Math.sin(a) * 9); g.fillStyle = css(C.plateLight, 1, .8); g.fillRect(Math.round(q.sx), Math.round(q.sy), 1, 1); }
    }

    // --- voxels, by vertical column, far → near. Under an orthographic camera
    // vertical columns never interleave, so column order is an exact painter's
    // order; within a column, settled faces merge into one quad per vertical
    // run (dozens of fills instead of thousands). Blocks still animating in are
    // drawn individually so the construction stays piece-by-piece.
    const glassFor = (v) => v.kind === 'city' ? C.city : v.kind === 'spire' ? C.spire : v.kind === 'collar' ? C.glassEdge : C.glass[v.shade];
    const sides = [[NX, O.nx, showNX, L.nx], [PZ, O.pz, showPZ, L.pz], [NZ, O.nz, showNZ, L.nzf], [PX, O.px, showPX, L.px]];
    const cols = city.cols;
    for (const c of cols) c.d = (c.x * sy_ + c.z * cy_) * cp_;
    cols.sort((a, b) => b.d - a.d);
    const riseY = -cp_ * S;                                  // screen Δy for +1 world y
    const list = [];                                         // settled voxels drawn this frame (for shimmer)
    for (const col of cols) {
      const runs = new Map(), tops = [], wins = [];
      const flush = (bit) => { const r = runs.get(bit); if (!r) return; runs.delete(bit);
        const q = proj(col.x, r.y0, col.z), h = r.y1 - r.y0 + 1, o = r.o;
        const quad = [o[0], o[1], [o[1][0], o[1][1] + riseY * (h - 1)], [o[0][0], o[0][1] + riseY * (h - 1)]];
        face(q.sx, q.sy, quad, css(r.col, r.lm)); };
      const flushAll = () => { for (const [bit] of sides) flush(bit); };
      for (const v of col.vs) {
        if (now < v.t0) { flushAll(); continue; }
        const k = clamp((now - v.t0) / 0.045, 0, 1);
        if (k < 1) {                                        // still rising into place: draw alone
          flushAll();
          const e = easeOutBack(k), q = proj(v.x, v.y - (1 - e) * 1.6, v.z), cc = glassFor(v);
          for (const [bit, o, show, lm] of sides) if (show && (v.f & bit)) face(q.sx, q.sy, o, css(cc, lm));
          if (v.f & TOP) face(q.sx, q.sy, O.top, css(cc, L.top));
          if (k > 0.3) { g.fillStyle = css(C.glassEdge, 1, (1 - k) * .8); g.fillRect(Math.round(q.sx), Math.round(q.sy - S), 1, 1); }
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
      for (const v of wins) { const q = proj(v.x, v.y, v.z); for (const [bit, o, show] of sides) if (show && (v.win & bit)) win(q, o, v, now); }
    }
    function win(q, o, v, now) {
      if (!v.on || now < v.wt) return;
      const a = clamp((now - v.wt) / 0.03, 0, 1);
      // the window is the face parallelogram scaled about its centre
      const mx = (o[0][0] + o[2][0]) / 2, my = (o[0][1] + o[2][1]) / 2;
      const sc = v.kind === 'city' ? .36 : .5;
      const w = o.map(([x, y]) => [mx + (x - mx) * sc, my + (y - my) * sc]);
      face(q.sx, q.sy, w, css(C.win[v.wc ?? 1], 1, .95 * a));
    }
    // spire tip + summit illumination
    if (now >= 0.99) { const k = clamp((now - .99) / .01, 0, 1); const q = proj(0, city.tipY + 0.5, 0); g.fillStyle = css(C.spireTip, 1, k); g.fillRect(Math.round(q.sx), Math.round(q.sy), 1, 1); g.fillStyle = css(C.spireTip, 1, .35 * k); g.fillRect(Math.round(q.sx) - 1, Math.round(q.sy) - 1, 3, 3); }
    if (now > 0.985) { const k = clamp((now - .985) / .015, 0, 1) * (done ? .75 + .25 * Math.sin(tm / 1400) : 1); const q = proj(0, city.CORE_H - 6, 0); [[26, .03], [17, .05], [10, .08]].forEach(([r, a]) => { g.fillStyle = css(C.win[1], 1, a * k); g.beginPath(); g.ellipse(q.sx, q.sy, r, r * 1.5, 0, 0, Math.PI * 2); g.fill(); }); }
    // living shimmer
    if (done && detail !== 'lite') for (let i = 0; i < 3; i++) { const v = list[Math.floor(h2(Math.floor(tm / 90), i) * list.length)]; if (v) { const q = proj(v.x, v.y, v.z); g.fillStyle = css(C.glassEdge, 1, .35); g.fillRect(Math.round(q.sx), Math.round(q.sy - S + 1), 1, 1); } }

    // --- upscale, nearest neighbour ---
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lo, Math.round(ox), Math.round(oy), LW * scale, LH * scale);
  }

  // adaptive detail: if frames run slow for a while on a weak machine, drop the
  // surrounding city and shimmer rather than stutter
  let slowFrames = 0, lastFrame = 0, degraded = false;
  function frame(tm) {
    if (lastFrame && tm - lastFrame > 28) {
      if (++slowFrames > 40 && !degraded) {
        degraded = true;
        // never remove blocks that are already standing — only simplify what hasn't been built yet
        const nowP = seeked !== null ? seeked : p;
        if (nowP < 0.15) city.cols = city.cols.filter((c) => c.vs[0].kind !== 'city');
      }
    } else slowFrames = Math.max(0, slowFrames - 1);
    lastFrame = tm;
    if (started && seeked === null && p < 1) p = clamp((tm - t0) / DUR, 0, 1);
    const now = seeked !== null ? seeked : p;
    // orbit physics: inertia after release, gentle idle turn once construction is complete
    if (!dragging) {
      yaw += vyaw; pitch = clamp(pitch + vpitch, -0.08, 0.95); vyaw *= 0.93; vpitch *= 0.9;
      if (!reduce && now >= 1 && tm - idleSince > 2600) yaw += 0.0022;
    }
    if (now >= 1 && tm > nextFlick) { const w = city.windows[Math.floor(h1(tm) * city.windows.length)]; if (w) w.on = w.on ? h1(tm * 1.3) > 0.18 : h1(tm * 1.7) < 0.45; nextFlick = tm + 700 + h1(tm) * 900; }
    draw(now, tm);
    if (reduce && now >= 1 && !dragging && Math.abs(vyaw) < 1e-4) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
  }

  // ---- interaction: grab and turn ----
  const pos = (e) => e.touches ? [e.touches[0].clientX, e.touches[0].clientY] : [e.clientX, e.clientY];
  const onDown = (e) => { dragging = true; [lastX, lastY] = pos(e); lastT = performance.now(); vyaw = vpitch = 0; canvas.style.cursor = 'grabbing'; if (!raf) raf = requestAnimationFrame(frame); };
  const onMove = (e) => {
    if (!dragging) return;
    const [x, y] = pos(e), t = performance.now(), dt = Math.max(1, t - lastT);
    const dx = x - lastX, dy = y - lastY;
    yaw += dx * 0.009; if (!e.touches) pitch = clamp(pitch - dy * 0.006, -0.08, 0.95);
    vyaw = (dx * 0.009) * Math.min(1, 16 / dt); vpitch = e.touches ? 0 : (-dy * 0.006) * Math.min(1, 16 / dt);
    lastX = x; lastY = y; lastT = t; idleSince = t;
    if (e.cancelable && !e.touches) e.preventDefault();
  };
  const onUp = () => { if (!dragging) return; dragging = false; idleSince = performance.now(); canvas.style.cursor = 'grab'; };
  canvas.style.cursor = 'grab'; canvas.style.touchAction = 'pan-y';
  canvas.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: true }); canvas.addEventListener('touchmove', onMove, { passive: true }); window.addEventListener('touchend', onUp);

  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && !started) { started = true; t0 = performance.now() + 120; idleSince = t0 + DUR; io.disconnect(); } }), { threshold: 0.25 });
  if (!reduce) io.observe(canvas);
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  raf = requestAnimationFrame(frame);

  return {
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('touchend', onUp); },
    replay() { seeked = null; p = 0; started = true; t0 = performance.now(); if (!raf) raf = requestAnimationFrame(frame); },
    seek(v) { seeked = v === null ? null : clamp(v, 0, 1); if (!raf) raf = requestAnimationFrame(frame); },
    setView(y, pt) { yaw = y; pitch = clamp(pt, -0.08, 0.95); vyaw = vpitch = 0; idleSince = performance.now(); if (!raf) raf = requestAnimationFrame(frame); },
  };
}
