/* ============================================================================
   Cityscape — the services hero, seen from the street. A perspective camera
   stands on the central avenue at second-floor height, looking down the
   avenue toward the Vouch tower. Towers rise floor by floor on both sides,
   nearest first, the Vouch tower last under a crane; windows light up as
   each one tops out. Crisp pixel art: a low-resolution buffer upscaled
   nearest-neighbour, flat cel shading, one-pixel ink edges, distance haze.
   Nothing behind the city: it stands on the page.

   mountCityscape(canvas, { duration, zoom }) →
     { destroy(), replay(), zoom(delta), setView(yaw, pitch), progress, counts }
   ========================================================================== */

const PAL = {
  ink: '#121216', fog: '#e9e6df',
  asphalt: '#2b2b3a', lane: '#d9ad46', kerb: '#8d8aa0', walk: '#cfccc3',
  glass: ['#1b2447', '#232f5c', '#2b3a70'], violet: ['#33297a', '#41359a', '#4e3fb0'], steel: ['#262a3f', '#303650', '#3a4160'], cream: ['#d9d4c7', '#e6e3dc', '#f2f0ea'],
  roof: '#1a1d2e', plant: '#3a4160', spire: '#9fb2e6', spireTip: '#fff7d6', beacon: '#ff3b3b',
  window: ['#f3d27a', '#ffe9a8', '#e9c35f', '#fff4cc'], windowOff: '#141a33', retail: '#ffd9a0',
  trunk: '#4a3a5a', leaf: ['#2f7a6c', '#3b8f7d', '#4aa58f'], lamp: '#f3d27a', post: '#3a3a4e',
  crane: '#f3d27a', craneDark: '#b8902f', cable: '#3a3a4e',
};

const h1 = (a) => { const x = Math.sin(a * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const h2 = (a, b) => h1(a * 7.31 + b * 19.17);
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const css = (c, m = 1, a = 1) => `rgba(${Math.min(255, c[0] * m) | 0},${Math.min(255, c[1] * m) | 0},${Math.min(255, c[2] * m) | 0},${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOutBack = (k) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const easeOut = (k) => 1 - Math.pow(1 - k, 3);

// ---- the city --------------------------------------------------------------
// Units: one floor is one unit tall; lots are 6 wide; streets 3; the avenue 10.
export const LOT = 6, STREET = 3, PITCH = LOT + STREET, AVE = 10, ROWS = 9;
export function buildCityscape() {
  const buildings = [], trees = [], lamps = [];
  let id = 0;
  for (let zi = 0; zi < ROWS; zi++) {
    const z0 = 4 + zi * PITCH;
    for (const side of [-1, 1]) for (let xi = 0; xi < 4; xi++) {
      const edge = AVE / 2 + 1 + xi * PITCH;                       // inner edge of the lot, from the avenue
      const x0 = side < 0 ? -(edge + LOT) : edge;
      const r = h2(zi * 4 + xi, side + 3);
      if (xi === 0 && zi === 0 && r < 0.5) continue;               // keep the mouth of the avenue open now and then
      const w = LOT - Math.floor(h2(xi, zi + side * 7) * 2), d = LOT - Math.floor(h2(zi, xi * 3 + side) * 2);
      const far = zi / (ROWS - 1), near = 1 - far;
      const floors = 8 + Math.floor(h2(zi * 9 + xi, side * 5) * (10 + 14 * far)) + Math.round(near * 10);
      const kind = r < 0.14 ? 'violet' : r < 0.3 ? 'cream' : r < 0.58 ? 'steel' : 'glass';
      const setback = floors > 9 && h2(xi + 2, zi + 5) < 0.5 ? Math.floor(floors * 0.6) : null;
      const crown = floors > 8 && h2(xi + 9, zi + 1) < 0.35, antenna = floors > 11 && h2(xi + 4, zi + 8) < 0.45, plant = !antenna && h2(xi + 6, zi + 2) < 0.5;
      buildings.push({ id: id++, x0: x0 + (side < 0 ? LOT - w : 0), z0: z0 + Math.floor(h2(zi, xi) * (LOT - d + 1)) * 0, w, d, floors, kind, setback, crown, antenna, plant, side, zi, xi, retail: zi < 5 && h2(xi + 1, zi) < 0.7 });
    }
    // trees and lamps along both sidewalks of the avenue, alternating
    for (const side of [-1, 1]) {
      const x = side * (AVE / 2 + 0.5);
      if (zi % 2 === 0) trees.push({ x, z: z0 + 1.5, h: 2 + Math.floor(h2(zi, side) * 2) }); else lamps.push({ x, z: z0 + 2 });
      trees.push({ x, z: z0 + 5.5, h: 2 + Math.floor(h2(zi + 3, side) * 2) });
    }
  }
  // the Vouch tower at the end of the avenue: a tri-stepped block with a collar and a spire
  const TZ = 4 + ROWS * PITCH + 2;
  const tower = { id: id++, x0: -7, z0: TZ, w: 14, d: 14, floors: 44, kind: 'glass', setback: 28, setback2: 37, crown: true, antenna: false, spire: 14, tower: true, side: 0, zi: ROWS, xi: 0, retail: false };
  buildings.push(tower);
  // build order: nearest the camera first, the tower last
  const camZ = -6;
  for (const b of buildings) { b.dist = Math.hypot(b.x0 + b.w / 2, b.z0 + b.d / 2 - camZ); }
  const maxD = Math.max(...buildings.filter((b) => !b.tower).map((b) => b.dist));
  for (const b of buildings) { b.t0 = b.tower ? 0.50 : 0.04 + 0.52 * (b.dist / maxD) + h1(b.id) * 0.04; b.dur = b.tower ? 0.42 : 0.16 + 0.1 * (b.floors / 20); }
  const blocks = buildings.reduce((s, b) => s + b.w * b.d * b.floors, 0);
  return { buildings, trees, lamps, tower, TZ, maxZ: TZ + 16, blocks };
}

// ---- renderer ---------------------------------------------------------------
export function mountCityscape(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const C = {}; for (const [k, v] of Object.entries({ ...PAL, ...(opts.palette || {}) })) C[k] = Array.isArray(v) ? v.map(hex) : hex(v);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DUR = (opts.duration || 10000) / (opts.speed || 1);
  const city = buildCityscape();
  const PXS = opts.pixel || 2.4;                      // screen pixels per buffer pixel
  const lo = document.createElement('canvas'), g = lo.getContext('2d');
  const inkC = document.createElement('canvas'), outC = document.createElement('canvas');
  let LW = 360, LH = 400, W = 0, H = 0, DPR = 1, scale = 1;

  const cam = { x: 0, y: 6, z: -6 };
  let yaw = opts.yaw ?? 0, pitch = opts.pitch ?? 0.08, zoom = opts.zoom || 1;
  let vyaw = 0, dragging = false, lastX = 0, lastY = 0, lastT = 0, idleSince = 0;
  let t0 = 0, p = reduce ? 1 : 0, raf = 0, lastFrame = 0, nextFlick = 0;
  const NEAR = 0.9;
  const windows = [];                                  // flicker pool, filled as buildings top out

  function resize() {
    const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = W * DPR; canvas.height = H * DPR;
    LW = clamp(Math.round(W / PXS), 120, 640); scale = W / LW; LH = clamp(Math.round(H / scale), 120, 720);
    lo.width = inkC.width = outC.width = LW; lo.height = inkC.height = outC.height = LH;
  }

  // camera space → screen. Polygons are clipped against the near plane first.
  let cy_, sy_, cp_, sp_, F, CX, CY;
  const toCam = (x, y, z) => { const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z; const rx = dx * cy_ - dz * sy_, rz = dx * sy_ + dz * cy_; return { x: rx, y: dy * cp_ - rz * sp_, z: rz * cp_ + dy * sp_ }; };
  const toScr = (q) => ({ sx: CX + F * q.x / q.z, sy: CY - F * q.y / q.z });
  const clipNear = (pts) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], ain = a.z >= NEAR, bin = b.z >= NEAR;
      if (ain) out.push(a);
      if (ain !== bin) { const k = (NEAR - a.z) / (b.z - a.z); out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: NEAR }); }
    }
    return out;
  };
  const poly = (world, fill, edge) => {
    const pts = clipNear(world.map(([x, y, z]) => toCam(x, y, z)));
    if (pts.length < 3) return null;
    const s = pts.map(toScr);
    g.fillStyle = fill; g.beginPath(); s.forEach((q, i) => i ? g.lineTo(Math.round(q.sx), Math.round(q.sy)) : g.moveTo(Math.round(q.sx), Math.round(q.sy))); g.closePath(); g.fill();
    if (edge) { g.strokeStyle = edge; g.lineWidth = 1; g.beginPath(); s.forEach((q, i) => i ? g.lineTo(Math.round(q.sx) + .5, Math.round(q.sy) + .5) : g.moveTo(Math.round(q.sx) + .5, Math.round(q.sy) + .5)); g.closePath(); g.stroke(); }
    return s;
  };
  const px = (x, y, col, w = 1, h = 1) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w, h); };
  const haze = (dist) => clamp((dist - 24) / 110, 0, 1) * 0.62;
  const shade = (base, dist, m) => css(mix(base, C.fog, haze(dist)), m);
  const inkAt = (dist) => css(C.ink, 1, 1 - haze(dist) * 0.8);

  // one building: the built floors as a box, the floor under construction
  // dropping in on top, windows, roof details
  function drawBuilding(b, now, tm) {
    const k = clamp((now - b.t0) / b.dur, 0, 1);
    if (k <= 0) return;
    const base = C[b.kind] || C.glass;
    const { x0, z0, w, d } = b, x1 = x0 + w, z1 = z0 + d;
    const built = easeOut(k) * b.floors, full = Math.floor(built), frac = built - full;
    const dist = b.dist;
    const edge = inkAt(dist);
    // a box from y0 to y1 over a footprint; faces visible from the camera
    const box = (bx0, bz0, bx1, bz1, y0, y1, cols, topCol) => {
      const front = [[bx0, y0, bz0], [bx1, y0, bz0], [bx1, y1, bz0], [bx0, y1, bz0]];
      if (cam.x < bx0) poly([[bx0, y0, bz1], [bx0, y0, bz0], [bx0, y1, bz0], [bx0, y1, bz1]], cols[1], edge);   // -x face
      if (cam.x > bx1) poly([[bx1, y0, bz0], [bx1, y0, bz1], [bx1, y1, bz1], [bx1, y1, bz0]], cols[2], edge);   // +x face
      poly(front, cols[0], edge);
      if (cam.y > y1) poly([[bx0, y1, bz0], [bx1, y1, bz0], [bx1, y1, bz1], [bx0, y1, bz1]], topCol, edge);
    };
    const cols = [shade(base[1], dist), shade(base[2], dist, 1.05), shade(base[0], dist)];
    const roof = shade(C.roof, dist);
    // footprints: a setback narrows the upper floors
    const seg = (y0, y1, inset) => box(x0 + inset, z0 + inset, x1 - inset, z1 - inset, y0, y1, cols, roof);
    const topOf = (fl) => b.setback2 != null && fl > b.setback2 ? 2.5 : b.setback != null && fl > b.setback ? (b.tower ? 1.5 : 1) : 0;
    if (full > 0) {
      // draw in up to three segments so setbacks read as steps
      const cuts = [0, b.setback, b.setback2, full].filter((v) => v != null && v < full).sort((a, b2) => a - b2);
      const bounds = [...new Set([...cuts, full])];
      for (let i = 0; i < bounds.length - 1; i++) seg(bounds[i], bounds[i + 1], topOf(bounds[i] + 1));
    }
    if (k < 1 && full < b.floors) {
      // the floor under construction lands from above with a little overshoot
      const e = easeOutBack(clamp(frac, 0, 1)), drop = (1 - e) * 3, inset = topOf(full + 1);
      box(x0 + inset, z0 + inset, x1 - inset, z1 - inset, full + drop, full + 1 + drop, cols, roof);
    }
    // windows on the front face and the avenue-facing side, one per unit, lit after top-out
    const litAt = b.t0 + b.dur;
    const ws = Math.max(1, Math.round(0.42 * F / dist));
    const drawWin = (x, y, z, i) => {
      const q = toCam(x, y, z); if (q.z < NEAR) return;
      const s = toScr(q);
      const on = now >= litAt + h2(i, b.id) * 0.12 && (b.winState?.[i] ?? h2(i * 3, b.id * 7) > 0.32);
      const col = on ? C.window[Math.floor(h2(i, b.id + 1) * 4)] : C.windowOff;
      px(s.sx - ws / 2, s.sy - ws / 2, css(mix(col, C.fog, haze(dist) * (on ? 0.5 : 1)), 1, on ? 1 : 0.8), ws, Math.max(1, Math.round(ws * 0.8)));
    };
    const floorsBuilt = Math.min(full, b.floors);
    let wi = 0;
    for (let fl = 0; fl < floorsBuilt; fl++) {
      const inset = topOf(fl + 1), fx0 = x0 + inset, fx1 = x1 - inset, fz0 = z0 + inset;
      const retail = b.retail && fl === 0;
      for (let i = 0; i < Math.floor(fx1 - fx0); i++) { const x = fx0 + 0.5 + i; if (retail) { const q = toCam(x, 0.5, fz0); if (q.z >= NEAR) { const s = toScr(q); px(s.sx - ws / 2, s.sy - ws / 2, css(mix(C.retail, C.fog, haze(dist) * .5), 1, .9), ws, Math.max(1, Math.round(ws * 1.1))); } } else drawWin(x, fl + 0.5, fz0, wi); wi++; }
      // the side that faces the avenue
      const sideX = b.side < 0 ? fx1 : fx0;
      if ((b.side < 0 && cam.x > sideX) || (b.side > 0 && cam.x < sideX)) for (let i = 0; i < Math.floor(z1 - z0 - 2 * inset); i++) { drawWin(sideX, fl + 0.5, fz0 + 0.5 + i, wi); wi++; }
    }
    // roof: crown band, antenna with a beacon, plant box; the tower's spire
    if (k >= 1) {
      const inset = topOf(b.floors), top = b.floors, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (b.crown) poly([[x0 + inset, top, z0 + inset], [x1 - inset, top, z0 + inset], [x1 - inset, top + 0.35, z0 + inset], [x0 + inset, top + 0.35, z0 + inset]], shade(C.spire, dist), edge);
      if (b.antenna) { const q = toCam(cx, top, cz), q2 = toCam(cx, top + 3, cz); if (q.z >= NEAR && q2.z >= NEAR) { const a = toScr(q), b2 = toScr(q2); g.strokeStyle = edge; g.beginPath(); g.moveTo(Math.round(a.sx) + .5, Math.round(a.sy)); g.lineTo(Math.round(b2.sx) + .5, Math.round(b2.sy)); g.stroke(); px(b2.sx, b2.sy - 1, css(C.beacon, 1, Math.floor(tm / 650) % 2 ? .95 : .3)); } }
      if (b.plant) box(cx - 1, cz - 1, cx + 1, cz + 1, top, top + 0.6, [shade(C.plant, dist), shade(C.plant, dist, .9), shade(C.plant, dist, 1.1)], shade(C.plant, dist, 1.2));
      if (b.spire) {
        const s0 = toCam(cx, top, cz), s1 = toCam(cx, top + b.spire, cz);
        if (s0.z >= NEAR) { const a = toScr(s0), b2 = toScr(s1); const wdt = Math.max(1, Math.round(0.6 * F / dist)); g.fillStyle = shade(C.spire, dist); g.fillRect(Math.round(a.sx - wdt / 2), Math.round(b2.sy), wdt, Math.round(a.sy - b2.sy)); g.strokeStyle = edge; g.strokeRect(Math.round(a.sx - wdt / 2) + .5, Math.round(b2.sy) + .5, wdt, Math.round(a.sy - b2.sy)); px(b2.sx - 1, b2.sy - 2, css(C.spireTip, 1, .9), 3, 2); px(b2.sx, b2.sy - 3, css(C.beacon, 1, Math.floor(tm / 650) % 2 ? .95 : .3)); }
      }
    }
    // the crane on the tower while it rises
    if (b.tower && k > 0 && k < 1) {
      const top = full + 1, cx = x0 + 3, cz = z0 + 4, mastH = 9, jib = 11, ang = tm / 2600;
      const line = (a, c, col) => { const qa = toCam(...a), qc = toCam(...c); if (qa.z < NEAR || qc.z < NEAR) return; const A = toScr(qa), B = toScr(qc); g.strokeStyle = col; g.lineWidth = 1; g.beginPath(); g.moveTo(Math.round(A.sx) + .5, Math.round(A.sy) + .5); g.lineTo(Math.round(B.sx) + .5, Math.round(B.sy) + .5); g.stroke(); };
      const mast = [cx, top + mastH, cz], tipX = cx + Math.cos(ang) * jib, tipZ = cz + Math.sin(ang) * jib, backX = cx - Math.cos(ang) * 4, backZ = cz - Math.sin(ang) * 4;
      box(cx - 0.4, cz - 0.4, cx + 0.4, cz + 0.4, top, top + mastH, [shade(C.crane, dist), shade(C.craneDark, dist), shade(C.crane, dist)], shade(C.crane, dist));
      line(mast, [tipX, top + mastH, tipZ], shade(C.crane, dist)); line(mast, [backX, top + mastH, backZ], shade(C.craneDark, dist));
      line([cx, top + mastH + 2, cz], [tipX, top + mastH, tipZ], shade(C.cable, dist)); line([cx, top + mastH + 2, cz], [backX, top + mastH, backZ], shade(C.cable, dist));
      const hookY = top + mastH - 2 - 3 * Math.abs(Math.sin(tm / 1400));
      line([tipX, top + mastH, tipZ], [tipX, hookY, tipZ], shade(C.cable, dist));
      box(tipX - 0.6, tipZ - 0.6, tipX + 0.6, tipZ + 0.6, hookY - 1, hookY, cols, roof);
    }
  }

  function drawGround(now) {
    const reach = city.maxZ * clamp(now / 0.12, 0, 1);
    if (reach <= 0) return;
    const ink = css(C.ink, 1, .5);
    // the avenue, its kerbs and lane dashes
    poly([[-AVE / 2, 0, 0], [AVE / 2, 0, 0], [AVE / 2, 0, reach], [-AVE / 2, 0, reach]], css(C.asphalt), null);
    for (const sx of [-1, 1]) poly([[sx * AVE / 2, 0, 0], [sx * (AVE / 2 + 1), 0, 0], [sx * (AVE / 2 + 1), 0, reach], [sx * AVE / 2, 0, reach]], css(C.walk), ink);
    for (let z = 1; z < reach; z += 3) { const a = toCam(0, 0.01, z), b = toCam(0, 0.01, Math.min(reach, z + 1.4)); if (a.z < NEAR) continue; const A = toScr(a), B = toScr(b); const wdt = Math.max(1, Math.round(0.25 * F / a.z)); g.fillStyle = css(mix(C.lane, C.fog, haze(z) * .6)); g.fillRect(Math.round(A.sx - wdt / 2), Math.round(B.sy), wdt, Math.max(1, Math.round(A.sy - B.sy))); }
    // cross streets
    for (let zi = 1; zi < ROWS; zi++) { const z = 4 + zi * PITCH - STREET; if (z > reach) break; for (const sx of [-1, 1]) poly([[sx * AVE / 2, 0, z], [sx * 44, 0, z], [sx * 44, 0, z + STREET], [sx * AVE / 2, 0, z + STREET]], css(mix(C.asphalt, C.fog, haze(z) * .8)), null); }
  }
  function drawTree(t, now) {
    const k = clamp((now - (0.04 + 0.52 * (Math.hypot(t.x, t.z - cam.z) / 95))) / 0.1, 0, 1); if (k <= 0) return;
    const dist = Math.hypot(t.x - cam.x, t.z - cam.z), e = easeOutBack(k), h = t.h * e, edge = inkAt(dist);
    const bx = (x0, z0, x1, z1, y0, y1, c) => { if (cam.x < x0) poly([[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], shade(c, dist, .85), edge); if (cam.x > x1) poly([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], shade(c, dist, .85), edge); poly([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], shade(c, dist), edge); if (cam.y > y1) poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], shade(c, dist, 1.15), edge); };
    bx(t.x - 0.2, t.z - 0.2, t.x + 0.2, t.z + 0.2, 0, h * 0.5, C.trunk);
    bx(t.x - 0.9, t.z - 0.9, t.x + 0.9, t.z + 0.9, h * 0.45, h * 1.1, C.leaf[1]);
    bx(t.x - 0.5, t.z - 0.5, t.x + 0.5, t.z + 0.5, h * 1.1, h * 1.45, C.leaf[2]);
  }
  function drawLamp(l, now, tm) {
    const k = clamp((now - (0.04 + 0.52 * (Math.hypot(l.x, l.z - cam.z) / 95))) / 0.1, 0, 1); if (k <= 0) return;
    const dist = Math.hypot(l.x - cam.x, l.z - cam.z), a = toCam(l.x, 0, l.z), b = toCam(l.x, 3.2 * k, l.z); if (a.z < NEAR) return;
    const A = toScr(a), B = toScr(b); g.strokeStyle = shade(C.post, dist); g.lineWidth = 1; g.beginPath(); g.moveTo(Math.round(A.sx) + .5, Math.round(A.sy)); g.lineTo(Math.round(B.sx) + .5, Math.round(B.sy)); g.stroke();
    if (k >= 1) { const s = Math.max(1, Math.round(0.3 * F / dist)); px(B.sx - s / 2, B.sy - s, css(C.lamp, 1, .95), s, s); g.fillStyle = css(C.lamp, 1, .12); g.beginPath(); g.ellipse(B.sx, B.sy - s / 2, s * 2.5, s * 1.6, 0, 0, Math.PI * 2); g.fill(); }
  }

  function draw(now, tm) {
    cy_ = Math.cos(yaw); sy_ = Math.sin(yaw); cp_ = Math.cos(pitch); sp_ = Math.sin(pitch);
    F = 0.75 * LW * zoom; CX = LW / 2; CY = LH * 0.58;
    g.clearRect(0, 0, LW, LH);
    drawGround(now);
    // everything else back to front by distance to the camera
    const items = [];
    for (const b of city.buildings) { const nx = clamp(cam.x, b.x0, b.x0 + b.w), nz = clamp(cam.z, b.z0, b.z0 + b.d); items.push({ d: Math.hypot(nx - cam.x, nz - cam.z) + (b.tower ? 0 : 0), kind: 'b', b }); }
    for (const t of city.trees) items.push({ d: Math.hypot(t.x - cam.x, t.z - cam.z), kind: 't', t });
    for (const l of city.lamps) items.push({ d: Math.hypot(l.x - cam.x, l.z - cam.z), kind: 'l', l });
    items.sort((a, b) => b.d - a.d);
    for (const it of items) { if (it.kind === 'b') drawBuilding(it.b, now, tm); else if (it.kind === 't') drawTree(it.t, now); else drawLamp(it.l, now, tm); }
    // ink silhouette a pixel each way, then the city on top
    const gi = inkC.getContext('2d'), go = outC.getContext('2d');
    gi.globalCompositeOperation = 'source-over'; gi.clearRect(0, 0, LW, LH); gi.drawImage(lo, 0, 0);
    gi.globalCompositeOperation = 'source-in'; gi.fillStyle = css(C.ink); gi.fillRect(0, 0, LW, LH);
    go.clearRect(0, 0, LW, LH);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) go.drawImage(inkC, dx, dy);
    go.drawImage(lo, 0, 0);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(outC, 0, 0, LW, LH, 0, 0, Math.round(LW * scale), Math.round(LH * scale));
  }

  function frame(tm) {
    const dt = lastFrame ? Math.min(50, tm - lastFrame) : 16; lastFrame = tm;
    if (p < 1) p = clamp((tm - t0) / DUR, 0, 1);
    if (!dragging) { yaw += vyaw; vyaw *= 0.92; if (!reduce && tm - idleSince > 2600) { yaw += (0.05 * Math.sin(tm / 5000) - yaw) * 0.01; } }
    if (!reduce) { cam.y = 6 + 0.15 * Math.sin(tm / 2600); cam.z = -6 + 0.6 * Math.sin(tm / 9000); }
    if (p >= 1 && tm > nextFlick) { const b = city.buildings[Math.floor(h1(tm) * city.buildings.length)]; if (b) { b.winState = b.winState || {}; const i = Math.floor(h1(tm * 1.3) * b.floors * (b.w + b.d)); b.winState[i] = h1(tm * 1.7) > 0.35; } nextFlick = tm + 160 + h1(tm) * 300; }
    void dt;
    draw(p, tm);
    raf = requestAnimationFrame(frame);
  }
  const pos = (e) => e.touches ? [e.touches[0].clientX, e.touches[0].clientY] : [e.clientX, e.clientY];
  const onDown = (e) => { dragging = true; [lastX, lastY] = pos(e); lastT = performance.now(); vyaw = 0; canvas.style.cursor = 'grabbing'; };
  const onMove = (e) => { if (!dragging) return; const [x, y] = pos(e), t = performance.now(), dt = Math.max(1, t - lastT); const dx = x - lastX, dy = y - lastY; yaw = clamp(yaw - dx * 0.004, -0.7, 0.7); if (!e.touches) pitch = clamp(pitch + dy * 0.003, -0.1, 0.45); vyaw = (-dx * 0.004) * Math.min(1, 16 / dt); lastX = x; lastY = y; lastT = t; idleSince = t; if (e.cancelable && !e.touches) e.preventDefault(); };
  const onUp = () => { if (!dragging) return; dragging = false; idleSince = performance.now(); canvas.style.cursor = 'grab'; };
  canvas.style.cursor = 'grab'; canvas.style.touchAction = 'pan-y';
  canvas.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: true }); canvas.addEventListener('touchmove', onMove, { passive: true }); window.addEventListener('touchend', onUp);
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  t0 = performance.now() + 150; idleSince = t0 + DUR;
  raf = requestAnimationFrame(frame);
  return {
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('touchend', onUp); },
    replay() { p = 0; t0 = performance.now(); idleSince = t0 + DUR; for (const b of city.buildings) b.winState = null; },
    zoom(delta) { zoom = clamp(zoom * (delta > 0 ? 1.2 : 1 / 1.2), 0.6, 2.2); idleSince = performance.now(); return zoom; },
    setView(y, pt) { yaw = clamp(y, -0.7, 0.7); pitch = clamp(pt, -0.1, 0.45); idleSince = performance.now(); },
    get progress() { return p; },
    counts: { buildings: city.buildings.length, blocks: city.blocks, trees: city.trees.length },
  };
}
