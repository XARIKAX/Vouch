/* ============================================================================
   PixelLaunch — the launchpad's own scene. A floating pad over night water, a
   gantry with retracting arms, a rocket assembling ring by ring with the Vouch
   check on its hull, countdown lights, ignition with particle exhaust and
   smoke, lift-off, and a slow hover. Same pixel language as the tower and the
   city (orthographic camera, logical buffer, nearest-neighbour upscale), a
   different subject.

   mountPixelLaunch(canvas, { duration, zoom }) →
     { destroy(), replay(), setView(yaw, pitch), progress, phase }
   ========================================================================== */

const LW = 360, LH = 450;                    // portrait logical buffer (4:5)

const PAL = {
  skyTop: '#07061a', skyMid: '#120f33', skyLow: '#2a1f5e', haze: '#4a3686', horizon: '#6a4aa0',
  water: '#0a0820', waterLine: '#2b2360', star: '#c9bfff', cloud: ['#1a1640', '#2b2466', '#3d2f80'],
  far: '#120f2c', farWin: '#c9b67e',
  pad: '#2b2552', padTop: '#3a3270', padRim: '#17132c', padRing: '#8f7cff', lamp: '#f3d27a', hazard: '#d9ad46',
  mast: ['#2c3150', '#353b5e', '#232842'], mastLight: '#8f7cff', beacon: '#ff3b3b', arm: '#8f7cff',
  hull: ['#f2f0ea', '#e6e3dc', '#d9d4c7'], band: ['#5b3df0', '#4e3fb0'], nose: '#2a2250', fin: ['#8f7cff', '#6a55ff'],
  window: '#f3d27a', check: '#5b3df0', engine: ['#3a3a4e', '#4a4a62'], nozzle: '#1d1d2a',
  flameCore: '#fff7d6', flame: '#ffd36b', flameOut: '#ff7a3c', plume: '#8f7cff', smoke: ['#3a3160', '#2a2450', '#1e1a3c'],
  glow: '#5b3df0',
};

const h1 = (a) => { const x = Math.sin(a * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const h2 = (a, b) => h1(a * 7.31 + b * 19.17);
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const css = (c, m = 1, a = 1) => `rgba(${(c[0] * m) | 0},${(c[1] * m) | 0},${(c[2] * m) | 0},${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (k) => k * k * (3 - 2 * k);
const easeOutBack = (k) => { const c1 = 1.15, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const TOP = 1, PX = 2, NX = 4, PZ = 8, NZ = 16;

// ---- model ------------------------------------------------------------------
// Parts carry a `g` group: pad, mast, arm, rocket (+ sub-kind), so the
// animation can move or remove whole groups.
export function buildLaunchModel() {
  const occ = new Map();
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const put = (x, y, z, c, g, extra = {}) => occ.set(key(x, y, z), { x, y, z, c, g, ...extra });

  // the pad: a rounded square slab, two deep, with a ring and a hatch
  const PR = 13;
  for (let x = -PR; x <= PR; x++) for (let z = -PR; z <= PR; z++) {
    const r = Math.pow(Math.abs(x / PR), 3.2) + Math.pow(Math.abs(z / PR), 3.2);
    if (r > 1) continue;
    const d = Math.hypot(x, z);
    const ring = Math.abs(d - 9) < 0.6, inner = d < 4.6;
    const edge = r > 0.82;
    const spoke = !inner && d > 5.5 && d < 8.4 && (Math.abs(x) < 0.6 || Math.abs(z) < 0.6 || Math.abs(Math.abs(x) - Math.abs(z)) < 0.6);
    const hazard = edge && Math.floor((Math.atan2(z, x) + Math.PI) / (Math.PI / 8)) % 2 === 0;
    put(x, -2, z, 'padRim', 'pad'); put(x, -1, z, 'padRim', 'pad');
    put(x, 0, z, ring ? 'padRing' : hazard ? 'hazard' : (inner || spoke) ? 'pad' : 'padTop', 'pad');
  }
  // the launch mount under the engines: a ring of struts the rocket stands on
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) { const d = Math.hypot(x, z); if (d >= 3.4 && d <= 4.6) for (let y = 1; y <= 2; y++) put(x, y, z, 'mast', 'pad', { shade: (x + z) & 1 }); }
  // two masts, left and right, lattice with braces; arms reach the rocket at two heights
  const MAST_H = 34;
  for (const sx of [-9, 9]) {
    for (let y = 1; y <= MAST_H; y++) {
      put(sx, y, -1, 'mast', 'mast', { shade: 0 }); put(sx, y, 1, 'mast', 'mast', { shade: 1 });
      put(sx + (sx < 0 ? -1 : 1), y, -1, 'mast', 'mast', { shade: 2 }); put(sx + (sx < 0 ? -1 : 1), y, 1, 'mast', 'mast', { shade: 2 });
      if (y % 4 === 0) { put(sx, y, 0, 'mastLight', 'mast'); put(sx + (sx < 0 ? -1 : 1), y, 0, 'mast', 'mast', { shade: 1 }); }
    }
    put(sx, MAST_H + 1, 0, 'beacon', 'mast', { beacon: true });
    for (const ay of [8, 22]) for (let d = 1; d <= 5; d++) put(sx + (sx < 0 ? d : -d), ay, 0, 'arm', 'arm', { arm: ay, d });
  }
  // the rocket, standing on the mount (BASE): body rings, nose, fins, engines,
  // bands, portholes, and the Vouch check painted on two faces of the hull
  const BODY_H = 26, R = 3.4, BASE = 3;
  const inBody = (x, z, r) => Math.hypot(x, z) <= r;
  const rk = (x, y, z, c, extra = {}) => put(x, y + BASE, z, c, 'rocket', { ring: y, ...extra });
  for (let y = 0; y < BODY_H; y++) for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) {
    if (!inBody(x, z, R)) continue;
    const band = (y >= 3 && y <= 4) || (y >= 15 && y <= 16);
    rk(x, y, z, band ? 'band' : 'hull', { shade: (x + 4) % 3 });
  }
  for (let y = BODY_H; y < BODY_H + 9; y++) {
    const r = R * (1 - (y - BODY_H + 1) / 10);
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) if (inBody(x, z, Math.max(0.6, r))) rk(x, y, z, y >= BODY_H + 6 ? 'nose' : 'hull', { shade: (x + 4) % 3 });
  }
  // the check: a short arm down, a long arm up, two cells thick, on the ±z faces, above the fins
  const checkCells = [[-3, 12], [-2, 11], [-1, 10], [0, 11], [1, 12], [2, 13], [2, 14]];
  for (const [cx, cy] of checkCells) for (const sz of [-1, 1]) for (const dy of [0, 1]) { const z = sz * 3; if (inBody(cx, z, R + 0.6)) rk(cx, cy + dy, z, 'check', { shade: 0, paint: true }); }
  for (const sz of [-1, 1]) rk(3, 16, sz * 3, 'check', { shade: 0, paint: true });
  // portholes near the top
  for (const [x, z] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) rk(x, 21, z, 'window', { shade: 0, paint: true });
  // fins: four, thin, at the base
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (let y = 0; y < 7; y++) {
    const reach = Math.round(3 + (6 - y) * 0.5);
    for (let d = 3; d <= reach; d++) rk(dx * d, y, dz * d, 'fin', { shade: (d + y) % 2 });
  }
  // engines: a skirt below the body and five nozzles
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (inBody(x, z, 3.2)) rk(x, -1, z, 'engine', { shade: (x + z + 6) % 2 });
  for (const [x, z] of [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]]) rk(x, -2, z, 'nozzle', { shade: 0 });

  const vox = [];
  for (const v of occ.values()) {
    let f = 0;
    if (!occ.has(key(v.x, v.y + 1, v.z))) f |= TOP;
    if (!occ.has(key(v.x + 1, v.y, v.z))) f |= PX;
    if (!occ.has(key(v.x - 1, v.y, v.z))) f |= NX;
    if (!occ.has(key(v.x, v.y, v.z + 1))) f |= PZ;
    if (!occ.has(key(v.x, v.y, v.z - 1))) f |= NZ;
    if (!f && !v.paint) continue;
    v.f = f || (PZ | NZ);
    // timing: pad first, masts rise, then the rocket stacks ring by ring, nose last, arms swing in
    if (v.g === 'pad') v.t0 = 0.02 + 0.06 * ((v.x + v.z + 26) / 52) + h2(v.x, v.z) * 0.02;
    else if (v.g === 'mast') v.t0 = 0.10 + 0.12 * (v.y / 36) + h2(v.x, v.y) * 0.01;
    else if (v.g === 'arm') v.t0 = 0.24 + 0.03 * v.d;
    else v.t0 = 0.26 + 0.30 * clamp((v.ring + 2) / 37, 0, 1) + h2(v.x, v.z + v.y) * 0.012;
    vox.push(v);
  }
  const colMap = new Map();
  for (const v of vox) { const k = v.x + ',' + v.z; if (!colMap.has(k)) colMap.set(k, { x: v.x, z: v.z, vs: [] }); colMap.get(k).vs.push(v); }
  const cols = [...colMap.values()]; cols.forEach((c) => c.vs.sort((a, b) => a.y - b.y));
  const clouds = [];
  for (let i = 0; i < 6; i++) { const rects = []; for (let k = 0; k < 4; k++) rects.push({ dx: Math.round((h2(i, k) - .5) * 40), dy: Math.round((h2(k, i) - .5) * 6), w: 14 + Math.round(h2(i + 1, k) * 30), h: 2 + Math.round(h2(k + 1, i) * 4) }); clouds.push({ cx: 20 + h1(i * 5.1) * 320, cy: 40 + h1(i * 7.7) * 150, band: Math.min(2, Math.floor(i / 2)), rects, drift: 0.1 + h1(i * 3) * 0.15 }); }
  const skyline = []; for (let x = 0; x < LW; x += 3 + Math.floor(h1(x) * 5)) skyline.push({ x, w: 3 + Math.floor(h1(x * 3) * 6), h: 6 + Math.floor(h1(x * 7) * 30) });
  return { vox, cols, clouds, skyline, PR, MAST_H, BODY_H };
}

// ---- renderer ---------------------------------------------------------------
export function mountPixelLaunch(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const C = {}; for (const [k, v] of Object.entries({ ...PAL, ...(opts.palette || {}) })) C[k] = Array.isArray(v) ? v.map(hex) : hex(v);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DUR = (opts.duration || 11000) / (opts.speed || 1);
  const m = buildLaunchModel();
  const lo = document.createElement('canvas'); lo.width = LW; lo.height = LH; const g = lo.getContext('2d');
  const stars = Array.from({ length: 90 }, (_, i) => ({ x: Math.floor(h1(i * 3.1) * LW), y: Math.floor(h1(i * 7.7) * LH * 0.62), a: 0.15 + h1(i) * 0.55 }));
  const HORIZON = Math.round(LH * 0.70);

  let yaw = opts.yaw ?? -0.5, pitch = opts.pitch ?? 0.26, vyaw = 0, dragging = false, lastX = 0, lastT = 0, idleSince = 0;
  let zoom = opts.zoom || 1, S = 4 * zoom;
  let W = 0, H = 0, DPR = 1, scale = 1, ox = 0, oy = 0;
  let t0 = 0, p = reduce ? 1 : 0, raf = 0, lastFrame = 0;
  const CX = LW / 2, CY = LH * 0.80;
  const light = [-0.55, 0.75, -0.42];
  const particles = [];                      // exhaust + smoke
  let shake = 0;

  function resize() { const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height)); canvas.width = W * DPR; canvas.height = H * DPR; scale = Math.max(W / LW, H / LH); ox = (W - LW * scale) / 2; oy = (H - LH * scale) / 2; }

  // the flight profile: lift (world y) and engine power. After the sequence
  // completes the rocket keeps accelerating until it has left the frame; the
  // smoke clears, and the next rocket assembles on the same pad.
  let flightT = 0, gone = false, goneAt = 0;
  const profile = (now) => {
    const ign = clamp((now - 0.70) / 0.06, 0, 1);               // ignition builds
    let lift = now < 0.78 ? 0 : 16 * Math.pow(clamp((now - 0.78) / 0.22, 0, 1), 1.9);
    if (now >= 1) lift = 16 + 9 * flightT + 16 * flightT * flightT;
    const power = gone ? 0 : now >= 1 ? 1 : ign * (0.6 + 0.6 * clamp((now - 0.78) / 0.1, 0, 1));
    return { ign, lift, power };
  };
  const phaseOf = (now) => gone ? 'next agent' : now < 0.26 ? 'pad' : now < 0.56 ? 'assembly' : now < 0.70 ? 'countdown' : now < 0.78 ? 'ignition' : now < 1 ? 'lift-off' : 'in flight';
  const relaunch = () => { p = 0.24; t0 = performance.now() - 0.24 * DUR; flightT = 0; gone = false; idleSince = performance.now() + DUR; };

  let cy_, sy_, cp_, sp_;
  const proj = (x, y, z) => { const rx = x * cy_ - z * sy_, rz = x * sy_ + z * cy_; return { sx: CX + rx * S, sy: CY - (y * cp_ - rz * sp_) * S, d: rz * cp_ + y * sp_ }; };
  const depth = (x, z) => (x * sy_ + z * cy_) * cp_;
  const face = (sx, sy, o, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(Math.round(sx + o[0][0]), Math.round(sy + o[0][1])); for (let i = 1; i < 4; i++) g.lineTo(Math.round(sx + o[i][0]), Math.round(sy + o[i][1])); g.closePath(); g.fill(); };
  const px = (x, y, col, w = 1, h = 1) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w, h); };
  // a palette entry is either one colour ([r,g,b]) or a list of shades ([[r,g,b], ...])
  const colFor = (v) => { const c = C[v.c] || C.hull[0]; return Array.isArray(c[0]) ? c[(v.shade ?? 0) % c.length] : c; };

  function draw(now, tm, dt) {
    const { ign, lift, power } = profile(now);
    void ign;
    cy_ = Math.cos(yaw); sy_ = Math.sin(yaw); cp_ = Math.cos(pitch); sp_ = Math.sin(pitch);
    const c = (x, y, z) => { const q = proj(x, y, z); return [q.sx - CX, q.sy - CY]; };
    const O = { top: [c(-.5, 1, -.5), c(.5, 1, -.5), c(.5, 1, .5), c(-.5, 1, .5)], px: [c(.5, 0, -.5), c(.5, 0, .5), c(.5, 1, .5), c(.5, 1, -.5)], nx: [c(-.5, 0, .5), c(-.5, 0, -.5), c(-.5, 1, -.5), c(-.5, 1, .5)], pz: [c(.5, 0, .5), c(-.5, 0, .5), c(-.5, 1, .5), c(.5, 1, .5)], nz: [c(-.5, 0, -.5), c(.5, 0, -.5), c(.5, 1, -.5), c(-.5, 1, -.5)] };
    const nzv = (nx, nzz) => nx * sy_ + nzz * cy_;
    const lum = (nx, ny, nzz) => { const rx = nx * cy_ - nzz * sy_, rz = nx * sy_ + nzz * cy_; const d = rx * light[0] + ny * light[1] + rz * light[2]; return 0.66 + 0.52 * Math.max(0, d); };
    const sides = [[NX, O.nx, nzv(-1, 0) < 0, lum(-1, 0, 0)], [PZ, O.pz, nzv(0, 1) < 0, lum(0, 0, 1)], [NZ, O.nz, nzv(0, -1) < 0, lum(0, 0, -1)], [PX, O.px, nzv(1, 0) < 0, lum(1, 0, 0)]];
    const Ltop = 0.95 + 0.45 * lum(0, 1, 0);
    const sh = shake > 0.01 ? [Math.round((h1(tm) - .5) * 4 * shake), Math.round((h1(tm * 1.7) - .5) * 3 * shake)] : [0, 0];

    // --- sky: bands, dither, stars, clouds, a far skyline, water ---
    // a smooth dusk: 16 bands interpolated through five keys, each edge dithered over three rows
    const keys = [C.skyTop, C.skyMid, C.skyLow, C.haze, C.horizon], NB = 16, bh = Math.ceil(HORIZON / NB);
    const bands = Array.from({ length: NB }, (_, i) => { const t = (i / (NB - 1)) * (keys.length - 1), k = Math.min(keys.length - 2, Math.floor(t)), f = t - k; return keys[k].map((v, j) => v + (keys[k + 1][j] - v) * f); });
    for (let i = 0; i < NB; i++) { g.fillStyle = css(bands[i]); g.fillRect(0, i * bh, LW, bh); }
    for (let i = 1; i < NB; i++) { g.fillStyle = css(bands[i]); for (let x = 0; x < LW; x++) { if (h2(i, x) < .5) g.fillRect(x, i * bh - 1, 1, 1); if (h2(i + 40, x) < .25) g.fillRect(x, i * bh - 2, 1, 1); if (h2(i + 80, x) < .08) g.fillRect(x, i * bh - 3, 1, 1); } }
    for (const s of stars) px(s.x, s.y, css(C.star, 1, s.a * (0.6 + 0.4 * Math.sin(tm / 700 + s.x))));
    for (const cl of m.clouds) { const drift = Math.round((tm / 1000) * cl.drift); g.fillStyle = css(C.cloud[cl.band], 1, .5); for (const r of cl.rects) { const x = ((Math.round(cl.cx + r.dx + drift) + 40) % (LW + 80)) - 40; g.fillRect(x, Math.round(cl.cy + r.dy), r.w, r.h); } }
    for (const b of m.skyline) { px(b.x, HORIZON - b.h, css(C.far), b.w, b.h); for (let y = HORIZON - b.h + 2; y < HORIZON - 1; y += 3) for (let x = b.x + 1; x < b.x + b.w - 1; x += 2) if (h2(x, y) < 0.35) px(x, y, css(C.farWin, 1, .7)); }
    g.fillStyle = css(C.water); g.fillRect(0, HORIZON, LW, LH - HORIZON);
    g.fillStyle = css(C.waterLine, 1, .6); g.fillRect(0, HORIZON, LW, 1);
    for (let y = HORIZON + 2; y < LH; y += 3) { const o = Math.round(2 * Math.sin(y * .7 + tm / 900)); px(o + (y * 13) % 48, y, css(C.haze, 1, .05 + .05 * h1(y)), 28, 1); }
    // the engine's light on the water
    if (power > 0) { [[120, .08], [70, .12], [30, .2]].forEach(([r, a]) => { g.fillStyle = css(C.flame, 1, a * power); g.beginPath(); g.ellipse(CX, CY + 8, r, r * 0.28, 0, 0, Math.PI * 2); g.fill(); }); }
    // the pad's shadow on the water
    { const q = proj(0, -2.5, 0); g.fillStyle = 'rgba(5,4,17,.6)'; g.beginPath(); g.ellipse(q.sx + 4, q.sy + 6, m.PR * S * 1.15, m.PR * S * 0.42, 0, 0, Math.PI * 2); g.fill(); }

    g.save(); g.translate(sh[0], sh[1]);
    // --- voxels by column; the rocket group rides on `lift`; arms retract ---
    const armGone = (v) => now > 0.62 + v.d * 0.012;
    const cols = m.cols; for (const col of cols) col.d = depth(col.x, col.z); cols.sort((a, b) => b.d - a.d);
    const riseY = -cp_ * S;
    for (const col of cols) {
      const runs = new Map(), tops = [];
      const flush = (bit) => { const r = runs.get(bit); if (!r) return; runs.delete(bit); const q = proj(col.x, r.y0 + r.off, col.z), h = r.y1 - r.y0 + 1, o = r.o; face(q.sx, q.sy, [o[0], o[1], [o[1][0], o[1][1] + riseY * h], [o[0][0], o[0][1] + riseY * h]], css(r.col, r.lm)); };
      const flushAll = () => { for (const [bit] of sides) flush(bit); };
      for (const v of col.vs) {
        if (now < v.t0 || (v.g === 'arm' && armGone(v)) || (gone && v.g === 'rocket')) { flushAll(); continue; }
        const off = v.g === 'rocket' ? lift : 0;
        const k = clamp((now - v.t0) / 0.05, 0, 1);
        const cc = colFor(v);
        if (k < 1) { flushAll(); const e = easeOutBack(k), q = proj(v.x, v.y + off + (1 - e) * (v.g === 'rocket' ? -2.2 : 1.6), v.z); for (const [bit, o, show, lm] of sides) if (show && (v.f & bit)) face(q.sx, q.sy, o, css(cc, lm)); if (v.f & TOP) face(q.sx, q.sy, O.top, css(cc, Ltop)); if (k > 0.3) px(q.sx, q.sy - S, css(C.mastLight, 1, (1 - k) * .9)); continue; }
        for (const [bit, o, show, lm] of sides) {
          if (!show || !(v.f & bit)) { flush(bit); continue; }
          const r = runs.get(bit);
          if (r && r.y1 === v.y - 1 && r.col === cc && r.off === off) r.y1 = v.y; else { flush(bit); runs.set(bit, { y0: v.y, y1: v.y, o, lm, col: cc, off }); }
        }
        if (v.f & TOP) tops.push(v);
      }
      flushAll();
      for (const v of tops) { const q = proj(v.x, v.y + (v.g === 'rocket' ? lift : 0), v.z); face(q.sx, q.sy, O.top, css(colFor(v), Ltop)); }
    }
    // pad ring lamps and countdown: lamps chase around the ring before ignition
    if (now > 0.08) for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; const q = proj(Math.cos(a) * 10.5, 0.6, Math.sin(a) * 10.5); const chase = now > 0.56 && now < 0.78 ? (Math.floor(tm / 90) % 24 === i ? 1 : 0.25) : 0.85; px(q.sx, q.sy, css(C.lamp, 1, chase)); }
    // beacons blink
    { const blink = Math.floor(tm / 600) % 2 === 0; for (const v of m.vox) if (v.beacon && now >= v.t0) { const q = proj(v.x, v.y + 1, v.z); px(q.sx, q.sy, css(C.beacon, 1, blink ? .95 : .3)); } }
    // porthole glow once assembled
    if (now > 0.6 && !gone) { const q = proj(0, 24.5 + lift, 0); g.fillStyle = css(C.window, 1, .10 + .05 * Math.sin(tm / 400)); g.beginPath(); g.ellipse(q.sx, q.sy, 10, 4, 0, 0, Math.PI * 2); g.fill(); }

    // --- exhaust: a bright column under the nozzles, then particles and smoke ---
    const NOZ = 0.6;                                              // world y of the nozzle mouths (mount height minus the skirt)
    if (power > 0) {
      const q = proj(0, NOZ + lift, 0), len = (lift > 0.5 ? 9 : 3.2) * S * power, w = 2.2 * S;
      const gr = g.createLinearGradient(0, q.sy, 0, q.sy + len);
      gr.addColorStop(0, css(C.flameCore, 1, .95)); gr.addColorStop(0.35, css(C.flame, 1, .8)); gr.addColorStop(0.7, css(C.flameOut, 1, .45)); gr.addColorStop(1, css(C.plume, 1, 0));
      g.fillStyle = gr; g.beginPath(); g.moveTo(q.sx - w / 2, q.sy); g.lineTo(q.sx + w / 2, q.sy); g.lineTo(q.sx + w * 0.9, q.sy + len); g.lineTo(q.sx - w * 0.9, q.sy + len); g.closePath(); g.fill();
    }
    if (power > 0 && !reduce) {
      const n = Math.round(14 * power);
      for (let i = 0; i < n; i++) { const a = h1(tm + i) * Math.PI * 2, r = h1(tm * 1.3 + i) * 1.1; particles.push({ x: Math.cos(a) * r, y: NOZ + lift, z: Math.sin(a) * r, vx: Math.cos(a) * 0.6 * h1(i + tm), vy: -(10 + 8 * h1(tm * 2 + i)) * power, vz: Math.sin(a) * 0.6 * h1(i * 3 + tm), life: 1, kind: 'flame' }); }
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i];
      pt.x += pt.vx * dt; pt.y += pt.vy * dt; pt.z += pt.vz * dt;
      if (pt.kind === 'flame') { pt.life -= dt * 2.2; if (pt.y <= 0.2) { pt.kind = 'smoke'; pt.y = 0.2; const a = Math.atan2(pt.z, pt.x) + (h1(i) - .5); const sp = 6 + 8 * h1(i * 2); pt.vx = Math.cos(a) * sp; pt.vz = Math.sin(a) * sp; pt.vy = 0.6 + h1(i * 3) * 1.4; pt.life = 1; } }
      else { pt.life -= dt * 0.55; pt.vx *= 0.97; pt.vz *= 0.97; pt.vy *= 0.98; }
      if (pt.life <= 0 || particles.length > 420) { particles.splice(i, 1); continue; }
    }
    particles.sort((a, b) => depth(b.x, b.z) - depth(a.x, a.z));
    for (const pt of particles) {
      const q = proj(pt.x, pt.y, pt.z);
      if (pt.kind === 'flame') { const col = pt.life > 0.7 ? C.flameCore : pt.life > 0.4 ? C.flame : pt.life > 0.2 ? C.flameOut : C.plume; const s = pt.life > 0.5 ? 3 : 2; px(q.sx - 1, q.sy, css(col, 1, clamp(pt.life * 1.4, 0, 1)), s, s); }
      else { const col = C.smoke[Math.min(2, Math.floor((1 - pt.life) * 3))]; const s = 3 + Math.round((1 - pt.life) * 7); px(q.sx - s / 2, q.sy - s / 2, css(col, 1, .5 * pt.life), s, Math.max(2, Math.round(s * 0.6))); }
    }
    // engine core glow
    if (power > 0) { const q = proj(0, NOZ + lift, 0); [[16, .22], [9, .45], [4, .95]].forEach(([r, a]) => { g.fillStyle = css(C.flameCore, 1, a * power); g.beginPath(); g.ellipse(q.sx, q.sy + 1, r, r * 0.6, 0, 0, Math.PI * 2); g.fill(); }); }
    g.restore();

    // vignette and the brand glow at the top
    const grd = g.createRadialGradient(CX, LH * 0.55, LH * 0.3, CX, LH * 0.55, LH * 0.78); grd.addColorStop(0, 'rgba(5,4,17,0)'); grd.addColorStop(1, 'rgba(5,4,17,.65)'); g.fillStyle = grd; g.fillRect(0, 0, LW, LH);

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lo, Math.round(ox), Math.round(oy), LW * scale, LH * scale);
  }

  function frame(tm) {
    const dt = lastFrame ? Math.min(0.05, (tm - lastFrame) / 1000) : 0.016; lastFrame = tm;
    if (p < 1) p = clamp((tm - t0) / DUR, 0, 1);
    const now = p;
    if (now >= 1 && !gone) {
      flightT += dt;
      // off the top of the frame: the nose is above the buffer
      const { lift } = profile(now);
      cy_ = Math.cos(yaw); sy_ = Math.sin(yaw); cp_ = Math.cos(pitch); sp_ = Math.sin(pitch);
      if (proj(0, lift, 0).sy < -8 * S) { gone = true; goneAt = tm; }
    }
    if (gone && tm - goneAt > 2600 && !reduce) relaunch();
    shake = now > 0.70 && now < 0.86 ? 1 - Math.abs((now - 0.78) / 0.08) : shake * 0.9;
    if (!dragging) { yaw += vyaw; vyaw *= 0.93; if (!reduce && tm - idleSince > 2600) yaw += 0.0012; }
    draw(now, tm, dt);
    raf = requestAnimationFrame(frame);
  }
  const pos = (e) => e.touches ? e.touches[0].clientX : e.clientX;
  const onDown = (e) => { dragging = true; lastX = pos(e); lastT = performance.now(); vyaw = 0; canvas.style.cursor = 'grabbing'; };
  const onMove = (e) => { if (!dragging) return; const x = pos(e), t = performance.now(), dt = Math.max(1, t - lastT); const dx = x - lastX; yaw += dx * 0.008; vyaw = (dx * 0.008) * Math.min(1, 16 / dt); lastX = x; lastT = t; idleSince = t; if (e.cancelable && !e.touches) e.preventDefault(); };
  const onUp = () => { if (!dragging) return; dragging = false; idleSince = performance.now(); canvas.style.cursor = 'grab'; };
  canvas.style.cursor = 'grab'; canvas.style.touchAction = 'pan-y';
  canvas.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: true }); canvas.addEventListener('touchmove', onMove, { passive: true }); window.addEventListener('touchend', onUp);
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  t0 = performance.now() + 200; idleSince = t0 + DUR;
  raf = requestAnimationFrame(frame);
  return {
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('touchend', onUp); },
    replay() { p = 0; t0 = performance.now(); particles.length = 0; flightT = 0; gone = false; idleSince = t0 + DUR; },
    relaunch,
    setView(y, pt) { yaw = y; pitch = clamp(pt, 0.05, 0.9); idleSince = performance.now(); },
    get progress() { return p; },
    get phase() { return phaseOf(p); },
  };
}
