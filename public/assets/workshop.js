/* ============================================================================
   Workshop — the providers page's hero. One pixel robot (the same figure as
   the agents swarm) at a bench. Tasks drop from a chute onto the bench, the
   robot works them (sparks), then slides the output into a scanner gate
   with the Vouch check on it. A pass lights the gate green and a coin flies
   onto the robot's bond stack; a fail lights it red, shreds the output, and
   a coin is chipped off the bond. Outlined pixel art floating on the page.

   mountWorkshop(canvas, { zoom }) →
     { destroy(), replay(), setView(yaw, pitch), progress, stats }
   ========================================================================== */
import { buildRobot } from '/assets/swarm.js';

const LW = 440, LH = 400;

const PAL = {
  ink: '#121216',
  hull: ['#f6f4ee', '#e4e1d8', '#cfcabd'], band: ['#5b3df0', '#4529c4'], joint: ['#3a3a4e', '#2c2c3c'], tread: ['#24242f', '#1b1b24'],
  visor: '#1b1b24', eye: '#f3d27a', check: '#5b3df0', antenna: '#3a3a4e', tip: '#8f7cff',
  bench: ['#3a3a4e', '#2c2c3c', '#24242f'], benchTop: ['#d9d4c7', '#e6e3dc', '#cfcabd'], leg: ['#24242f', '#1b1b24'],
  chute: ['#5b3df0', '#4529c4', '#3a2fa0'], chuteLip: '#8f7cff',
  gate: ['#2c3150', '#353b5e', '#232842'], gateEdge: '#8f7cff', gateCheck: '#f6f4ee', beam: '#8f7cff', beamOk: '#22c55e', beamNo: '#ff3b3b',
  pedestal: ['#3a3a4e', '#2c2c3c', '#24242f'], coin: ['#f3d27a', '#d9ad46', '#b8902f'], coinEdge: '#8a6a1f',
  crate: ['#e6e3dc', '#cfcabd', '#bdb7a8'], crateBand: '#5b3df0', crateLabel: '#f3d27a', done: ['#8f7cff', '#6a55ff', '#5b3df0'],
  spark: '#f3d27a', sparkCore: '#fff7d6', ok: '#22c55e', no: '#ff3b3b', shred: ['#e6e3dc', '#cfcabd', '#5b3df0'],
};

const h1 = (a) => { const x = Math.sin(a * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const h2 = (a, b) => h1(a * 7.31 + b * 19.17);
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const css = (c, m = 1, a = 1) => `rgba(${Math.min(255, c[0] * m) | 0},${Math.min(255, c[1] * m) | 0},${Math.min(255, c[2] * m) | 0},${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOutBack = (k) => { const c1 = 1.15, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const easeInOut = (k) => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const easeIn = (k) => k * k;
const TOP = 1, PX = 2, NX = 4, PZ = 8, NZ = 16;

// ---- models -----------------------------------------------------------------
function finish(occ, height) {
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const vox = [];
  for (const v of occ.values()) {
    let f = 0;
    if (!occ.has(key(v.x, v.y + 1, v.z))) f |= TOP;
    if (!occ.has(key(v.x + 1, v.y, v.z))) f |= PX;
    if (!occ.has(key(v.x - 1, v.y, v.z))) f |= NX;
    if (!occ.has(key(v.x, v.y, v.z + 1))) f |= PZ;
    if (!occ.has(key(v.x, v.y, v.z - 1))) f |= NZ;
    if (!f && !v.paint) continue;
    v.f = f || NZ;
    v.t0 = clamp((v.y / height) * 0.85 + h2(v.x, v.z + v.y * 3) * 0.12, 0, 0.88);   // never 1: a block must be able to land
    vox.push(v);
  }
  const colMap = new Map();
  for (const v of vox) { const k = v.x + ',' + v.z; if (!colMap.has(k)) colMap.set(k, { x: v.x, z: v.z, vs: [] }); colMap.get(k).vs.push(v); }
  const cols = [...colMap.values()]; cols.forEach((c) => c.vs.sort((a, b) => a.y - b.y));
  return { vox, cols };
}
const occOf = () => { const occ = new Map(); occ.put = (x, y, z, c, extra = {}) => occ.set(x + ',' + y + ',' + z, { x, y, z, c, ...extra }); return occ; };

// the bench: a cream top on a dark frame, two legs each side, a drawer band
function buildBench() {
  const o = occOf();
  for (let x = -7; x <= 7; x++) for (let z = -2; z <= 1; z++) { o.put(x, 5, z, 'benchTop', { shade: (x + 7) % 3 }); o.put(x, 4, z, 'bench', { shade: 0 }); }
  for (let x = -7; x <= 7; x++) for (let z = -2; z <= 1; z++) o.put(x, 3, z, 'bench', { shade: (x + z) & 1 ? 1 : 2 });
  for (const lx of [-6, 6]) for (const lz of [-1, 0]) for (let y = 0; y <= 2; y++) o.put(lx, y, lz, 'leg', { shade: y & 1 });
  for (let x = -5; x <= 5; x++) o.put(x, 1, 0, 'leg', { shade: 1 });
  return finish(o, 6);
}
// the chute above the bench: a hopper with an accent lip
function buildChute() {
  const o = occOf();
  for (let y = 0; y < 5; y++) { const r = 1 + Math.floor(y / 2); for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) if (Math.abs(x) === r || Math.abs(z) === r) o.put(x, y, z, 'chute', { shade: (x + z + y) & 1 }); }
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (Math.abs(x) === 3 || Math.abs(z) === 3) o.put(x, 5, z, 'chuteLip');
  for (let y = 6; y < 24; y++) o.put(0, y, 0, 'leg', { shade: y & 1 });   // the hanger runs off the top of the frame
  return finish(o, 24);
}
// the scanner gate: an arch with the Vouch check on its lintel
function buildGate() {
  const o = occOf();
  for (const px_ of [-3, 3]) for (let y = 0; y < 11; y++) for (let z = -2; z <= 2; z++) o.put(px_, y, z, 'gate', { shade: (y + z) & 1 ? 1 : 0 });
  for (let x = -3; x <= 3; x++) for (let y = 11; y < 14; y++) for (let z = -2; z <= 2; z++) o.put(x, y, z, 'gate', { shade: (x + y) & 1 ? 1 : 2 });
  for (const [cx, cy] of [[-2, 12], [-1, 11], [0, 12], [1, 13]]) o.put(cx, cy, -2, 'gateCheck', { paint: true });
  for (let x = -3; x <= 3; x++) for (let z = -2; z <= 2; z++) if (Math.abs(x) === 3 || Math.abs(z) === 2) o.put(x, 14, z, 'gateEdge');
  for (const px_ of [-3, 3]) for (let z = -2; z <= 2; z++) o.put(px_, 10, z, 'gateEdge', { paint: true });
  return finish(o, 15);
}
// the bond: a pedestal with a stack of coins; rebuilt when the count changes
function buildPedestal(coins) {
  const o = occOf();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 0; y < 4; y++) o.put(x, y, z, 'pedestal', { shade: y === 3 ? 0 : (x + z + y) & 1 ? 1 : 2 });
  for (let i = 0; i < coins; i++) { const y = 4 + i; const ox = Math.round((h1(i * 3.3) - 0.5) * 0.9), oz = Math.round((h1(i * 5.7) - 0.5) * 0.9); for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (Math.abs(x) + Math.abs(z) < 2 || (x === 0 || z === 0)) o.put(x + ox, y, z + oz, 'coin', { shade: i % 3 }); }
  return finish(o, 4 + coins);
}
// one task crate: a cream cube with a purple band and a label pixel; `done` paints it purple
function buildCrate(done) {
  const o = occOf();
  for (let x = -1; x <= 1; x++) for (let y = 0; y < 3; y++) for (let z = -1; z <= 1; z++) o.put(x, y, z, done ? 'done' : 'crate', { shade: (x + 1 + y) % 3 });
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (Math.abs(x) === 1 || Math.abs(z) === 1) o.put(x, 1, z, done ? 'gateCheck' : 'crateBand', { paint: true });
  o.put(0, 2, -1, 'crateLabel', { paint: true });
  return finish(o, 3);
}
function buildCoin() { const o = occOf(); for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) if (x === 0 || z === 0) o.put(x, 0, z, 'coin', { shade: 0 }); return finish(o, 1); }

// ---- renderer ---------------------------------------------------------------
export function mountWorkshop(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const C = {}; for (const [k, v] of Object.entries({ ...PAL, ...(opts.palette || {}) })) C[k] = Array.isArray(v) ? v.map(hex) : hex(v);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DUR = (opts.duration || 5000) / (opts.speed || 1);
  const M = { robot: buildRobot(), bench: buildBench(), chute: buildChute(), gate: buildGate(), crate: buildCrate(false), done: buildCrate(true), coin: buildCoin() };
  let pedestal = buildPedestal(8);
  const lo = document.createElement('canvas'); lo.width = LW; lo.height = LH; const g = lo.getContext('2d');
  const tmp = document.createElement('canvas'); tmp.width = LW; tmp.height = LH; const gt = tmp.getContext('2d');
  const ink = document.createElement('canvas'); ink.width = LW; ink.height = LH; const gi = ink.getContext('2d');

  let yaw = opts.yaw ?? -0.5, pitch = opts.pitch ?? 0.3, vyaw = 0, dragging = false, lastX = 0, lastT = 0, idleSince = 0;
  const zoom = opts.zoom || 1, S = 9.6 * zoom, XOFF = 3;   // the scene's centre sits at world x = 3
  let W = 0, H = 0, DPR = 1, scale = 1, ox = 0, oy = 0;
  let t0 = 0, p = reduce ? 1 : 0, raf = 0, lastFrame = 0;
  const CX = LW / 2, CY = LH * 0.82;
  const light = [-0.5, 0.8, -0.45];

  // layout, in blocks: the robot behind the bench; the chute over its left; the gate to the right; the bond to the left
  const POS = { robot: { x: -2, y: 0, z: 3 }, bench: { x: 0, y: 0, z: -2 }, chute: { x: -3, y: 19, z: -2 }, gate: { x: 11, y: 0, z: -2 }, pedestal: { x: -13, y: 0, z: -2 } };
  const BENCH_TOP = 6, WORK_X = -3, GATE_X = 11, EXIT_X = 19;
  const stats = { settled: 0, slashed: 0, earned: 0, bond: 8 };
  const crates = [], sparks = [], shreds = [], coins = [], glyphs = [];
  let gateFlash = null, nextTask = 0, taskN = 0;
  const robot = { awake: true, frozen: false, purple: false, gold: false, byaw: 0, hover: 0 };

  function resize() { const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height)); canvas.width = W * DPR; canvas.height = H * DPR; scale = Math.min(W / LW, H / LH); ox = (W - LW * scale) / 2; oy = (H - LH * scale) / 2; }
  const phaseOf = (now) => now < 1 ? 'setting up' : 'working';

  let cy_, sy_, cp_, sp_, riseY;
  const projG = (x, y, z) => { x -= XOFF; const rx = x * cy_ - z * sy_, rz = x * sy_ + z * cy_; return { sx: CX + rx * S, sy: CY - (y * cp_ - rz * sp_) * S, d: rz * cp_ + y * sp_ }; };
  const depth = (x, z) => (x * sy_ + z * cy_) * cp_;
  let G = g;
  const face = (sx, sy, o, col) => { G.fillStyle = col; G.beginPath(); G.moveTo(Math.round(sx + o[0][0]), Math.round(sy + o[0][1])); for (let i = 1; i < 4; i++) G.lineTo(Math.round(sx + o[i][0]), Math.round(sy + o[i][1])); G.closePath(); G.fill(); };
  const px = (x, y, col, w = 1, h = 1) => { G.fillStyle = col; G.fillRect(Math.round(x), Math.round(y), w, h); };
  const shadeOf = (c, v) => Array.isArray(c[0]) ? c[(v.shade ?? 0) % c.length] : c;
  const colFor = (v, ent) => {
    if (v.eye) return ent?.frozen ? C.no : C.eye;
    return shadeOf(C[v.c] || C.hull, v);
  };

  // one model at a world position, with its own yaw; faces merge into vertical runs
  function drawModel(model, ex, ey, ez, localNow, ent, eyaw = 0) {
    const q0 = projG(ex, ey, ez), cs = q0.sx, csy = q0.sy;
    const yawE = yaw + eyaw, cy = Math.cos(yawE), sy = Math.sin(yawE);
    const proj = (x, y, z) => { const rx = x * cy - z * sy, rz = x * sy + z * cy; return { sx: cs + rx * S, sy: csy - (y * cp_ - rz * sp_) * S }; };
    const c = (x, y, z) => { const q = proj(x, y, z); return [q.sx - cs, q.sy - csy]; };
    const O = { top: [c(-.5, 1, -.5), c(.5, 1, -.5), c(.5, 1, .5), c(-.5, 1, .5)], px: [c(.5, 0, -.5), c(.5, 0, .5), c(.5, 1, .5), c(.5, 1, -.5)], nx: [c(-.5, 0, .5), c(-.5, 0, -.5), c(-.5, 1, -.5), c(-.5, 1, .5)], pz: [c(.5, 0, .5), c(-.5, 0, .5), c(-.5, 1, .5), c(.5, 1, .5)], nz: [c(-.5, 0, -.5), c(.5, 0, -.5), c(.5, 1, -.5), c(-.5, 1, -.5)] };
    const nzv = (nx, nzz) => nx * sy + nzz * cy;
    const lum = (nx, ny, nzz) => { const rx = nx * cy - nzz * sy, rz = nx * sy + nzz * cy; const d = rx * light[0] + ny * light[1] + rz * light[2]; return 0.72 + 0.4 * Math.max(0, d); };
    const sides = [[NX, O.nx, nzv(-1, 0) < 0, lum(-1, 0, 0)], [PZ, O.pz, nzv(0, 1) < 0, lum(0, 0, 1)], [NZ, O.nz, nzv(0, -1) < 0, lum(0, 0, -1)], [PX, O.px, nzv(1, 0) < 0, lum(1, 0, 0)]];
    const Ltop = 1.0 + 0.2 * lum(0, 1, 0);
    const dep = (x, z) => (x * sy + z * cy) * cp_;
    for (const col of model.cols) col.d = dep(col.x, col.z);
    model.cols.sort((a, b) => b.d - a.d);
    for (const col of model.cols) {
      const runs = new Map(), tops = [];
      const flush = (bit) => { const r = runs.get(bit); if (!r) return; runs.delete(bit); const q = proj(col.x, r.y0, col.z), h = r.y1 - r.y0 + 1, o = r.o; face(q.sx, q.sy, [o[0], o[1], [o[1][0], o[1][1] + riseY * h], [o[0][0], o[0][1] + riseY * h]], css(r.col, r.lm)); };
      const flushAll = () => { for (const [bit] of sides) flush(bit); };
      for (const v of col.vs) {
        if (localNow < v.t0) { flushAll(); continue; }
        const k = clamp((localNow - v.t0) / 0.1, 0, 1);
        const cc = colFor(v, ent);
        if (k < 1) { flushAll(); const e = easeOutBack(k), q = proj(v.x, v.y + (1 - e) * 4, v.z); for (const [bit, o, show, lm] of sides) if (show && (v.f & bit)) face(q.sx, q.sy, o, css(cc, lm)); if (v.f & TOP) face(q.sx, q.sy, O.top, css(cc, Ltop)); continue; }
        for (const [bit, o, show, lm] of sides) {
          if (!show || !(v.f & bit)) { flush(bit); continue; }
          const r = runs.get(bit);
          if (r && r.y1 === v.y - 1 && r.col === cc) r.y1 = v.y; else { flush(bit); runs.set(bit, { y0: v.y, y1: v.y, o, lm, col: cc }); }
        }
        if (v.f & TOP) tops.push(v);
      }
      flushAll();
      for (const v of tops) { const q = proj(v.x, v.y, v.z); face(q.sx, q.sy, O.top, css(colFor(v, ent), Ltop)); }
    }
    return proj;
  }
  // render into the scratch canvas, outline it in ink, blit both
  function drawOutlined(model, ex, ey, ez, localNow, ent, eyaw, bw, bh, by) {
    const q = projG(ex, ey, ez);
    const x0 = Math.round(q.sx - bw / 2), y0 = Math.round(q.sy - by);
    gt.clearRect(x0 - 2, y0 - 2, bw + 4, bh + 4);
    G = gt; const proj = drawModel(model, ex, ey, ez, localNow, ent, eyaw); G = g;
    gi.globalCompositeOperation = 'source-over'; gi.clearRect(x0 - 2, y0 - 2, bw + 4, bh + 4); gi.drawImage(tmp, x0, y0, bw, bh, x0, y0, bw, bh);
    gi.globalCompositeOperation = 'source-in'; gi.fillStyle = css(C.ink); gi.fillRect(x0, y0, bw, bh);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.drawImage(ink, x0, y0, bw, bh, x0 + dx, y0 + dy, bw, bh);
    g.drawImage(tmp, x0, y0, bw, bh, x0, y0, bw, bh);
    return proj;
  }

  // ---- the work loop ----------------------------------------------------------
  // A crate: drop → work → slide → verdict → exit (pass) or shred (fail).
  function spawnTask(tm) { taskN++; crates.push({ id: taskN, x: WORK_X, y: BENCH_TOP + 24, z: -2, phase: 'drop', t: 0, pass: h1(taskN * 7.7) > 0.18, done: false }); }
  function update(now, tm, dt) {
    robot.hover = now >= 1 && !reduce ? 0.12 * Math.sin(tm / 700) + 0.12 : 0;
    if (now < 1 || reduce) return;
    if (tm > nextTask && !crates.some((c) => c.phase !== 'exit')) { nextTask = tm + 600; spawnTask(tm); }
    for (let i = crates.length - 1; i >= 0; i--) {
      const c = crates[i]; c.t += dt;
      if (c.phase === 'drop') { const k = clamp(c.t / 0.55, 0, 1); c.y = BENCH_TOP + 24 - 24 * easeIn(k); if (k >= 1) { c.y = BENCH_TOP; c.phase = 'work'; c.t = 0; } }
      else if (c.phase === 'work') {
        if (h1(tm + c.id) < 0.7) sparks.push({ x: c.x + (h1(tm * 3 + c.id) - 0.5) * 2.4, y: c.y + 3 + h1(tm * 2) * 1.5, z: c.z + (h1(tm * 5 + c.id) - 0.5) * 2, vy: 4 + 5 * h1(tm + c.id * 2), vx: (h1(tm * 7 + c.id) - 0.5) * 3, life: 1 });
        c.wobble = 0.25 * Math.sin(c.t * 28);
        if (c.t > 1.5) { c.phase = 'slide'; c.t = 0; c.done = true; c.wobble = 0; }
      }
      else if (c.phase === 'slide') { const k = clamp(c.t / 0.9, 0, 1); c.x = WORK_X + (GATE_X - WORK_X) * easeInOut(k); if (k >= 1) { c.phase = 'verdict'; c.t = 0; gateFlash = { ok: c.pass, t: 0 }; } }
      else if (c.phase === 'verdict') {
        if (c.t > 0.5) {
          if (c.pass) { c.phase = 'exit'; c.t = 0; stats.settled++; stats.earned += 0.02 + Math.round(h1(c.id) * 40) / 1000; coins.push({ kind: 'earn', k: 0, from: { x: GATE_X, y: BENCH_TOP + 8, z: -2 }, to: { x: POS.pedestal.x, y: 4 + stats.bond, z: -2 } }); glyphs.push({ x: GATE_X, y: BENCH_TOP + 15, z: -2, kind: 'ok', life: 1 }); }
          else { crates.splice(i, 1); stats.slashed++; for (let s = 0; s < 26; s++) shreds.push({ x: c.x + (h1(s) - 0.5), y: c.y + 1 + h1(s * 2), z: c.z + (h1(s * 3) - 0.5), vx: (h1(s * 5) - 0.5) * 9, vy: 3 + h1(s * 7) * 7, vz: (h1(s * 11) - 0.5) * 6, life: 1, shade: s % 3 }); glyphs.push({ x: GATE_X, y: BENCH_TOP + 15, z: -2, kind: 'no', life: 1 }); if (stats.bond > 0) { stats.bond--; pedestal = buildPedestal(stats.bond); coins.push({ kind: 'slash', k: 0, from: { x: POS.pedestal.x, y: 4 + stats.bond, z: -2 }, to: { x: POS.pedestal.x - 4, y: 4 + stats.bond + 14, z: -2 } }); } continue; }
        }
      }
      else if (c.phase === 'exit') { const k = clamp(c.t / 0.8, 0, 1); c.x = GATE_X + (EXIT_X - GATE_X) * k; c.fade = 1 - k; if (k >= 1) crates.splice(i, 1); }
    }
    if (gateFlash) { gateFlash.t += dt; if (gateFlash.t > 0.9) gateFlash = null; }
    for (let i = sparks.length - 1; i >= 0; i--) { const s = sparks[i]; s.x += s.vx * dt; s.y += s.vy * dt; s.vy -= 18 * dt; s.life -= dt * 2.6; if (s.life <= 0) sparks.splice(i, 1); }
    for (let i = shreds.length - 1; i >= 0; i--) { const s = shreds[i]; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt; s.vy -= 22 * dt; s.life -= dt * 1.1; if (s.life <= 0 || s.y < 0) shreds.splice(i, 1); }
    for (let i = coins.length - 1; i >= 0; i--) { const c = coins[i]; c.k += dt * (c.kind === 'earn' ? 1.1 : 1.4); if (c.k >= 1) { coins.splice(i, 1); if (c.kind === 'earn') { stats.bond = Math.min(14, stats.bond + 1); pedestal = buildPedestal(stats.bond); } } }
    for (let i = glyphs.length - 1; i >= 0; i--) { const gl = glyphs[i]; gl.life -= dt * 0.8; if (gl.life <= 0) glyphs.splice(i, 1); }
  }

  function draw(now, tm) {
    cy_ = Math.cos(yaw); sy_ = Math.sin(yaw); cp_ = Math.cos(pitch); sp_ = Math.sin(pitch); riseY = -cp_ * S;
    g.clearRect(0, 0, LW, LH);
    const setup = (k0, k1) => clamp((now - k0) / (k1 - k0), 0, 1);
    const ents = [
      { d: depth(POS.bench.x, POS.bench.z), draw: () => drawOutlined(M.bench, POS.bench.x, POS.bench.y, POS.bench.z, setup(0, 0.3), null, 0, 24 * S, 12 * S, 9 * S) },
      { d: depth(POS.robot.x, POS.robot.z), draw: () => drawOutlined(M.robot, POS.robot.x, POS.robot.y + robot.hover, POS.robot.z, setup(0.15, 0.6), robot, 0, 14 * S, 27 * S, 24.5 * S) },
      { d: depth(POS.chute.x, POS.chute.z) - 2, draw: () => drawOutlined(M.chute, POS.chute.x, POS.chute.y, POS.chute.z, setup(0.4, 0.75), null, 0, 12 * S, 32 * S, 28 * S) },
      { d: depth(POS.gate.x, POS.gate.z), draw: () => drawOutlined(M.gate, POS.gate.x, POS.gate.y, POS.gate.z, setup(0.5, 0.9), null, 0, 12 * S, 22 * S, 18 * S) },
      { d: depth(POS.pedestal.x, POS.pedestal.z), draw: () => drawOutlined(pedestal, POS.pedestal.x, POS.pedestal.y, POS.pedestal.z, setup(0.6, 1), null, 0, 10 * S, 24 * S, 22 * S) },
    ];
    for (const c of crates) ents.push({ d: depth(c.x, c.z) - 0.01, draw: () => { if (c.fade != null) g.globalAlpha = c.fade; drawOutlined(c.done ? M.done : M.crate, c.x + (c.wobble || 0), c.y, c.z, 1, null, (c.wobble || 0) * 0.4, 6 * S, 7 * S, 5 * S); g.globalAlpha = 1; } });
    for (const c of coins) { const k = c.kind === 'earn' ? easeInOut(c.k) : c.k; const x = c.from.x + (c.to.x - c.from.x) * k, y = c.from.y + (c.to.y - c.from.y) * k + Math.sin(k * Math.PI) * (c.kind === 'earn' ? 9 : 4), z = c.from.z; ents.push({ d: depth(x, z) - 0.02, draw: () => { if (c.kind === 'slash') g.globalAlpha = 1 - c.k; drawOutlined(M.coin, x, y, z, 1, null, c.k * 6, 4 * S, 3 * S, 2 * S); g.globalAlpha = 1; } }); }
    ents.sort((a, b) => b.d - a.d);
    for (const e of ents) e.draw();
    // the scanner beam between the gate's pillars
    if (now >= 0.9) {
      const col = gateFlash ? (gateFlash.ok ? C.beamOk : C.beamNo) : C.beam, a = gateFlash ? 0.55 - 0.3 * gateFlash.t : 0.22 + 0.08 * Math.sin(tm / 300);
      const q1 = projG(GATE_X, 0.5, -2), q2 = projG(GATE_X, 10.5, -2);
      g.fillStyle = css(col, 1, a); g.fillRect(Math.round(q1.sx - 1.5 * S), Math.round(q2.sy), Math.round(3 * S), Math.round(q1.sy - q2.sy));
      if (gateFlash) { g.fillStyle = css(col, 1, 0.25 * (1 - gateFlash.t)); g.beginPath(); g.ellipse(q1.sx, (q1.sy + q2.sy) / 2, 5 * S * (1 + gateFlash.t), 7 * S * (1 + gateFlash.t * 0.5), 0, 0, Math.PI * 2); g.fill(); }
    }
    // sparks over the work, shreds from a failed output, verdict glyphs
    for (const s of sparks) { const q = projG(s.x, s.y, s.z); px(q.sx, q.sy, css(s.life > 0.5 ? C.sparkCore : C.spark, 1, clamp(s.life * 1.5, 0, 1)), 2, 2); }
    for (const s of shreds) { const q = projG(s.x, s.y, s.z); px(q.sx - 1, q.sy - 1, css(C.shred[s.shade], 1, clamp(s.life * 1.4, 0, 1)), 3, 3); }
    for (const gl of glyphs) {
      const q = projG(gl.x, gl.y + (1 - gl.life) * 5, gl.z), a = clamp(gl.life * 1.6, 0, 1);
      if (gl.kind === 'ok') { const col = css(C.ok, 1, a); [[-3, 0], [-2, 1], [-1, 2], [0, 1], [1, 0], [2, -1], [3, -2]].forEach(([dx, dy]) => { px(q.sx + dx * 2, q.sy - dy * 2, col, 2, 2); }); }
      else { const col = css(C.no, 1, a); [[-2, -2], [-1, -1], [0, 0], [1, 1], [2, 2], [-2, 2], [-1, 1], [1, -1], [2, -2]].forEach(([dx, dy]) => px(q.sx + dx * 2, q.sy + dy * 2, col, 2, 2)); }
    }
    // the robot's eyes glow
    if (now >= 0.6) { const q = projG(POS.robot.x, 12.5 + robot.hover, POS.robot.z - 2.2); g.fillStyle = css(C.eye, 1, .14); g.beginPath(); g.ellipse(q.sx, q.sy, 3.2 * S, 1.4 * S, 0, 0, Math.PI * 2); g.fill(); }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lo, Math.round(ox), Math.round(oy), Math.round(LW * scale), Math.round(LH * scale));
  }

  function frame(tm) {
    const dt = lastFrame ? Math.min(0.05, (tm - lastFrame) / 1000) : 0.016; lastFrame = tm;
    if (p < 1) p = clamp((tm - t0) / DUR, 0, 1);
    update(p, tm, dt);
    if (!dragging) { yaw += vyaw; vyaw *= 0.93; if (!reduce && tm - idleSince > 2600) yaw += (-0.5 + 0.12 * Math.sin(tm / 7000) - yaw) * 0.01; }
    draw(p, tm);
    raf = requestAnimationFrame(frame);
  }
  const pos = (e) => e.touches ? e.touches[0].clientX : e.clientX;
  const onDown = (e) => { dragging = true; lastX = pos(e); lastT = performance.now(); vyaw = 0; canvas.style.cursor = 'grabbing'; };
  const onMove = (e) => { if (!dragging) return; const x = pos(e), t = performance.now(), dt = Math.max(1, t - lastT); const dx = x - lastX; yaw += dx * 0.008; vyaw = (dx * 0.008) * Math.min(1, 16 / dt); lastX = x; lastT = t; idleSince = t + 6000; if (e.cancelable && !e.touches) e.preventDefault(); };
  const onUp = () => { if (!dragging) return; dragging = false; idleSince = performance.now() + 6000; canvas.style.cursor = 'grab'; };
  canvas.style.cursor = 'grab'; canvas.style.touchAction = 'pan-y';
  canvas.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: true }); canvas.addEventListener('touchmove', onMove, { passive: true }); window.addEventListener('touchend', onUp);
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  t0 = performance.now() + 200; idleSince = t0;
  raf = requestAnimationFrame(frame);
  return {
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('touchend', onUp); },
    replay() { p = 0; t0 = performance.now(); crates.length = 0; sparks.length = 0; shreds.length = 0; coins.length = 0; glyphs.length = 0; gateFlash = null; stats.settled = 0; stats.slashed = 0; stats.earned = 0; stats.bond = 8; pedestal = buildPedestal(8); nextTask = t0 + DUR + 400; },
    setView(y, pt) { yaw = y; pitch = clamp(pt, 0.05, 0.9); idleSince = performance.now() + 6000; },
    get progress() { return p; },
    get phase() { return phaseOf(p); },
    stats,
  };
}
