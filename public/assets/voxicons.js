/* ============================================================================
   VoxIcons — small 3D voxel objects in the Vouch pixel language, rendered the
   same way as the city and the tower (orthographic camera into a tiny logical
   buffer, nearest-neighbour upscale), turning slowly on their stand.

   mountVoxIcon(canvas, kind, { palette, pitch, speed }) → { destroy() }
   kinds: 'coin' (a token with the Vouch check inlaid), 'vault' (a bond safe
   with a ring door), 'receipt' (a signed slip with a stamp), 'beacon' (a
   stepped block with a light on top)
   ========================================================================== */

const LW = 112, LH = 112, S = 5;
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const css = (c, m = 1, a = 1) => `rgba(${(c[0] * m) | 0},${(c[1] * m) | 0},${(c[2] * m) | 0},${a})`;
const TOP = 1, PX = 2, NX = 4, PZ = 8, NZ = 16;

const PAL = {
  gold: ['#e9c35f', '#f3d27a', '#d9ad46'], goldDark: '#8a6a22', cream: '#fff4cc',
  violet: ['#5b4bc4', '#6a55ff', '#4e3fb0'], violetDeep: '#2a2270', violetBright: '#8f7cff',
  steel: ['#20243a', '#272c46', '#1a1d2e'], paper: '#f2f0ea', paperShade: '#d9d4c7', ink: '#111210',
  green: '#34c97f', red: '#ff5a3c', edge: '#8f7cff',
};

function model(kind) {
  const occ = new Map();
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const put = (x, y, z, c) => occ.set(key(x, y, z), { x, y, z, c });
  if (kind === 'coin') {
    // a thick disc, the Vouch check inlaid on the face in violet, a square dot at its tip
    const R = 7.2;
    for (let x = -7; x <= 7; x++) for (let z = -7; z <= 7; z++) if (Math.hypot(x, z) <= R) for (let y = 0; y < 3; y++) put(x, y, z, Math.hypot(x, z) > R - 1.3 ? 'goldDark' : 'gold');
    // the check, inlaid in the top layer: a short arm down, a long arm up, two voxels thick
    const cells = [];
    for (let t = 0; t < 4; t++) cells.push([-5 + t, -1 + t]);
    for (let t = 0; t < 7; t++) cells.push([-2 + t, 2 - t]);
    for (const [x, z] of cells) { put(x, 2, z, 'violet'); put(x + 1, 2, z, 'violet'); }
    put(5, 2, -5, 'violetBright'); put(6, 2, -5, 'violetBright'); put(5, 2, -6, 'violetBright');
  } else if (kind === 'vault') {
    // a cube safe with a ring door on the front and a lock dot
    for (let x = -5; x <= 5; x++) for (let y = 0; y < 11; y++) for (let z = -5; z <= 5; z++) {
      const edge = [x, z].some((v) => Math.abs(v) === 5) && (y === 0 || y === 10) || (Math.abs(x) === 5 && Math.abs(z) === 5);
      put(x, y, z, edge ? 'steel2' : 'steel');
    }
    for (let x = -3; x <= 3; x++) for (let y = 2; y <= 8; y++) { const d = Math.hypot(x, y - 5); if (d <= 3.4 && d > 2.2) put(x, y, -6, 'violet'); }
    put(0, 5, -6, 'gold'); put(0, 5, -7, 'cream');
    for (let y = 3; y <= 7; y++) put(-5, y, 6, 'violetDeep');
  } else if (kind === 'receipt') {
    // a slip of paper lying on a slab, ruled lines, a violet stamp square, a green tick
    for (let x = -7; x <= 7; x++) for (let z = -5; z <= 5; z++) put(x, 0, z, 'steel');
    for (let x = -6; x <= 6; x++) for (let z = -4; z <= 4; z++) put(x, 1, z, (z === -4 && x > 2) ? 'paperShade' : 'paper');
    for (const z of [-2, 0, 2]) for (let x = -5; x <= 1; x++) put(x, 2, z, 'ink');
    for (let x = 3; x <= 5; x++) for (let z = 1; z <= 3; z++) put(x, 2, z, 'violet');
    put(4, 3, 2, 'green');
  } else {
    // beacon: stepped block with an antenna and a light
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = 0; y < 4; y++) put(x, y, z, 'violetDeep');
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 4; y < 9; y++) put(x, y, z, 'violet');
    for (let y = 9; y < 12; y++) put(0, y, 0, 'steel2');
    put(0, 12, 0, 'red');
  }
  const vox = [];
  for (const v of occ.values()) {
    let f = 0;
    if (!occ.has(key(v.x, v.y + 1, v.z))) f |= TOP;
    if (!occ.has(key(v.x + 1, v.y, v.z))) f |= PX;
    if (!occ.has(key(v.x - 1, v.y, v.z))) f |= NX;
    if (!occ.has(key(v.x, v.y, v.z + 1))) f |= PZ;
    if (!occ.has(key(v.x, v.y, v.z - 1))) f |= NZ;
    if (f) { v.f = f; vox.push(v); }
  }
  const colMap = new Map();
  for (const v of vox) { const k = v.x + ',' + v.z; if (!colMap.has(k)) colMap.set(k, { x: v.x, z: v.z, vs: [] }); colMap.get(k).vs.push(v); }
  const cols = [...colMap.values()]; cols.forEach((c) => c.vs.sort((a, b) => a.y - b.y));
  let maxY = 0; for (const v of vox) maxY = Math.max(maxY, v.y);
  return { cols, maxY };
}

export function mountVoxIcon(canvas, kind, opts = {}) {
  const ctx = canvas.getContext('2d'); if (!ctx) return null;
  const P = { ...PAL, ...(opts.palette || {}) };
  const C = {};
  for (const [k, v] of Object.entries(P)) C[k] = Array.isArray(v) ? v.map(hex) : hex(v);
  const colFor = (name, i) => Array.isArray(C[name]) ? C[name][i % C[name].length] : C[name] || C.steel[0];
  const m = model(kind);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lo = document.createElement('canvas'); lo.width = LW; lo.height = LH; const g = lo.getContext('2d');
  let yaw = opts.yaw ?? -0.7, pitch = opts.pitch ?? 0.52, raf = 0, W = 0, H = 0, DPR = 1, scale = 1, ox = 0, oy = 0;
  const speed = (opts.speed ?? 1) * 0.0035;
  const CX = LW / 2, CY = LH * (opts.centerY ?? 0.72);
  const light = [-0.55, 0.75, -0.42];
  function resize() { const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height)); canvas.width = W * DPR; canvas.height = H * DPR; scale = Math.min(W / LW, H / LH); ox = (W - LW * scale) / 2; oy = (H - LH * scale) / 2; }
  function draw(tm) {
    const cy_ = Math.cos(yaw), sy_ = Math.sin(yaw), cp_ = Math.cos(pitch), sp_ = Math.sin(pitch);
    const proj = (x, y, z) => { const rx = x * cy_ - z * sy_, rz = x * sy_ + z * cy_; return { sx: CX + rx * S, sy: CY - (y * cp_ - rz * sp_) * S, d: rz * cp_ }; };
    const c = (x, y, z) => { const q = proj(x, y, z); return [q.sx - CX, q.sy - CY]; };
    const O = { top: [c(-.5, 1, -.5), c(.5, 1, -.5), c(.5, 1, .5), c(-.5, 1, .5)], px: [c(.5, 0, -.5), c(.5, 0, .5), c(.5, 1, .5), c(.5, 1, -.5)], nx: [c(-.5, 0, .5), c(-.5, 0, -.5), c(-.5, 1, -.5), c(-.5, 1, .5)], pz: [c(.5, 0, .5), c(-.5, 0, .5), c(-.5, 1, .5), c(.5, 1, .5)], nz: [c(-.5, 0, -.5), c(.5, 0, -.5), c(.5, 1, -.5), c(-.5, 1, -.5)] };
    const nzv = (nx, nzz) => nx * sy_ + nzz * cy_;
    const lum = (nx, ny, nzz) => { const rx = nx * cy_ - nzz * sy_, rz = nx * sy_ + nzz * cy_; const d = rx * light[0] + ny * light[1] + rz * light[2]; return 0.66 + 0.52 * Math.max(0, d); };
    const sides = [[NX, O.nx, nzv(-1, 0) < 0, lum(-1, 0, 0)], [PZ, O.pz, nzv(0, 1) < 0, lum(0, 0, 1)], [NZ, O.nz, nzv(0, -1) < 0, lum(0, 0, -1)], [PX, O.px, nzv(1, 0) < 0, lum(1, 0, 0)]];
    const Ltop = 0.95 + 0.45 * lum(0, 1, 0);
    g.clearRect(0, 0, LW, LH);
    // stand: a soft shadow ellipse and a thin ring
    g.fillStyle = 'rgba(5,4,17,.55)'; g.beginPath(); g.ellipse(CX + 2, CY + 3, 30, 11, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(143,124,255,.35)'; g.lineWidth = 1; g.beginPath(); g.ellipse(CX, CY + 1, 34, 13, 0, 0, Math.PI * 2); g.stroke();
    const cols = m.cols; for (const col of cols) col.d = (col.x * sy_ + col.z * cy_) * cp_; cols.sort((a, b) => b.d - a.d);
    const face = (sx, sy, o, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(Math.round(sx + o[0][0]), Math.round(sy + o[0][1])); for (let i = 1; i < 4; i++) g.lineTo(Math.round(sx + o[i][0]), Math.round(sy + o[i][1])); g.closePath(); g.fill(); };
    const bob = reduce ? 0 : Math.sin(tm / 900) * 0.25;
    for (const col of cols) for (const v of col.vs) {
      const q = proj(v.x, v.y + bob, v.z), cc = colFor(v.c, (v.x * 3 + v.z * 7 + 100) % 3);
      for (const [bit, o, show, lm] of sides) if (show && (v.f & bit)) face(q.sx, q.sy, o, css(cc, lm));
      if (v.f & TOP) face(q.sx, q.sy, O.top, css(cc, Ltop));
    }
    // a glint
    if (!reduce) { const k = (tm / 1600) % 1; const q = proj(-3 + k * 6, m.maxY + 1.2 + bob, -3 + k * 6); g.fillStyle = `rgba(255,247,214,${0.6 * Math.sin(k * Math.PI)})`; g.fillRect(Math.round(q.sx), Math.round(q.sy), 1, 1); }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false; ctx.drawImage(lo, Math.round(ox), Math.round(oy), LW * scale, LH * scale);
  }
  function frame(tm) { if (!reduce) yaw += speed; draw(tm); raf = requestAnimationFrame(frame); }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { if (!raf) raf = requestAnimationFrame(frame); } else { cancelAnimationFrame(raf); raf = 0; } }), { threshold: 0.05 });
  io.observe(canvas);
  draw(0);
  return { destroy() { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); } };
}
