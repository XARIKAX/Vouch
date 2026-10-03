/* ============================================================================
   PixelSwarm — the agents page's own scene. A floating depot at night: a key
   tower with the Vouch check on its face, and a formation of small pixel
   robots (the agents) that assemble block by block around it, wake up visor
   by visor, then buy work: packets fly to the tower, receipts come back, and
   now and then one agent walks up to the gate, trades, and returns to its
   slot. Same pixel language as the tower, the city and the launch pad
   (orthographic camera, logical buffer, nearest-neighbour upscale).

   mountPixelSwarm(canvas, { duration, zoom }) →
     { destroy(), replay(), setView(yaw, pitch), progress, phase, online }
   ========================================================================== */

const LW = 360, LH = 450;                    // portrait logical buffer (4:5)

const PAL = {
  skyTop: '#07061a', skyMid: '#120f33', skyLow: '#2a1f5e', haze: '#4a3686', horizon: '#6a4aa0',
  ground: '#0a0820', grid: '#2b2360', star: '#c9bfff', cloud: ['#1a1640', '#2b2466', '#3d2f80'],
  far: '#120f2c', farWin: '#c9b67e',
  pad: '#2b2552', padTop: '#3a3270', seam: '#231d48', padRim: '#17132c', slot: '#4e3fb0', ring: '#8f7cff', hazard: '#d9ad46', lamp: '#f3d27a',
  tower: ['#5a5488', '#6a63a0', '#4a4470'], towerBand: '#5b3df0', towerEdge: '#b4a6ff', towerCap: '#8f7cff', check: '#f2f0ea', gate: '#f3d27a', beacon: '#ff3b3b',
  hull: ['#f2f0ea', '#e6e3dc', '#d9d4c7'], band: ['#5b3df0', '#4e3fb0'], bandGold: ['#d9ad46', '#b8902f'], bandDeep: ['#2a2250', '#3a3270'],
  tread: ['#2c3150', '#353b5e'], joint: ['#3a3a4e', '#4a4a62'], botCheck: '#5b3df0',
  visor: '#f3d27a', visorOff: '#2a2250', visorFrozen: '#ff3b3b', antenna: '#8f7cff', eye: '#fff7d6',
  packet: '#8f7cff', packetCore: '#dcd4ff', receipt: '#f3d27a', receiptCore: '#fff7d6', ok: '#4ade80', frozen: '#ff3b3b',
};

const h1 = (a) => { const x = Math.sin(a * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const h2 = (a, b) => h1(a * 7.31 + b * 19.17);
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const css = (c, m = 1, a = 1) => `rgba(${(c[0] * m) | 0},${(c[1] * m) | 0},${(c[2] * m) | 0},${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOutBack = (k) => { const c1 = 1.15, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const easeInOut = (k) => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
const TOP = 1, PX = 2, NX = 4, PZ = 8, NZ = 16;

// ---- models -----------------------------------------------------------------
// Each model is a set of voxels with visible faces, grouped by column. `t0` is
// the voxel's own moment inside its model's assembly window (0..1).
function finish(occ, timing) {
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
    v.f = f || (PZ | NZ);
    v.t0 = timing(v);
    vox.push(v);
  }
  const colMap = new Map();
  for (const v of vox) { const k = v.x + ',' + v.z; if (!colMap.has(k)) colMap.set(k, { x: v.x, z: v.z, vs: [] }); colMap.get(k).vs.push(v); }
  const cols = [...colMap.values()]; cols.forEach((c) => c.vs.sort((a, b) => a.y - b.y));
  return { vox, cols };
}
const occOf = () => { const occ = new Map(); occ.put = (x, y, z, c, extra = {}) => occ.set(x + ',' + y + ',' + z, { x, y, z, c, ...extra }); return occ; };

export const P = 22;                                        // platform half-extent
export const TOWER = { x: 0, z: 13, w: 3, d: 2, h: 26 };     // the key tower: 7 wide, 5 deep, 26 tall
// agents are 7 blocks wide; nine apart leaves an aisle between every two
export const SLOTS = (() => { const s = []; for (const z of [1, -8, -17]) for (const x of [-18, -9, 0, 9, 18]) s.push({ x, z }); return s; })();
export const GATE = { x: 0, z: TOWER.z - TOWER.d - 3 };      // where an agent stands to trade
// the walk from a slot to the gate: sidestep into the aisle, up the aisle, across to the gate
export const pathTo = (s) => { const ax = s.x === 0 ? 4.5 : s.x - Math.sign(s.x) * 4.5; return [{ x: s.x, z: s.z }, { x: ax, z: s.z }, { x: ax, z: GATE.z }, { x: GATE.x, z: GATE.z }]; };

export function buildSwarmModel() {
  // the platform: a rounded slab, seams every six tiles, a ring under every slot, hazard dashes on the rim
  const pf = occOf();
  for (let x = -P; x <= P; x++) for (let z = -P; z <= P; z++) {
    const r = Math.pow(Math.abs(x / P), 4) + Math.pow(Math.abs(z / P), 4);
    if (r > 1) continue;
    const edge = r > 0.84;
    const hazard = edge && Math.floor((Math.atan2(z, x) + Math.PI) / (Math.PI / 14)) % 2 === 0;
    const seam = !edge && ((x + P) % 6 === 0 || (z + P) % 6 === 0);
    let c = edge ? (hazard ? 'hazard' : 'padRim') : seam ? 'seam' : 'padTop';
    for (const s of SLOTS) { const d = Math.max(Math.abs(x - s.x), Math.abs(z - s.z)); if (d === 2) c = 'slot'; else if (d < 2) c = 'pad'; }
    const dg = Math.max(Math.abs(x - GATE.x), Math.abs(z - GATE.z)); if (dg === 2) c = 'ring'; else if (dg < 2) c = 'pad';
    pf.put(x, -2, z, 'padRim'); pf.put(x, -1, z, 'padRim'); pf.put(x, 0, z, c);
  }
  const platform = finish(pf, (v) => clamp(((v.x + v.z + 2 * P) / (4 * P)) * 0.9 + h2(v.x, v.z) * 0.08, 0, 1));

  // the key tower: a dark lattice block with a cream check on its face, a lit gate, a cap ring and a beacon
  const tw = occOf();
  const { x: tx, z: tz, w, d, h } = TOWER;
  for (let y = 0; y < h; y++) for (let x = -w; x <= w; x++) for (let z = -d; z <= d; z++) {
    const outer = Math.abs(x) === w || Math.abs(z) === d;
    if (!outer && y > 1) continue;                                  // hollow
    const corner = Math.abs(x) === w && Math.abs(z) === d;
    const band = y % 6 === 5;
    tw.put(tx + x, y, tz + z, corner ? 'towerEdge' : band ? 'towerBand' : 'tower', { shade: ((x + z + y) & 1) ? 1 : (y % 5 === 0 ? 2 : 0) });
  }
  // the check, two cells thick, on the front face (−z) and the back
  const checkCells = [[-3, 12], [-2, 11], [-1, 10], [0, 11], [1, 12], [2, 13], [3, 14], [3, 15]];
  for (const [cx, cy] of checkCells) for (const dy of [0, 1]) for (const sz of [-d, d]) tw.put(tx + cx, cy + dy, tz + sz, 'check', { paint: true });
  // the gate: a lit doorway at the foot of the front face
  for (let x = -1; x <= 1; x++) for (let y = 1; y <= 4; y++) tw.put(tx + x, y, tz - d, 'gate', { paint: true, gate: true });
  for (let x = -w; x <= w; x++) for (let z = -d; z <= d; z++) tw.put(tx + x, h, tz + z, (Math.abs(x) === w || Math.abs(z) === d) ? 'towerCap' : 'tower', { shade: 2 });
  tw.put(tx, h + 1, tz, 'tower', { shade: 1 }); tw.put(tx, h + 2, tz, 'beacon', { beacon: true });
  const tower = finish(tw, (v) => clamp((v.y / (h + 3)) * 0.92 + h2(v.x, v.z + v.y) * 0.06, 0, 1));

  // one agent: treads, a hull with a band and a small check, arms, a head with a visor, an antenna
  const bt = occOf();
  for (const sx of [-1, 1]) for (const x of [1, 2]) for (let z = -1; z <= 1; z++) for (const y of [0, 1]) bt.put(sx * x, y, z, 'tread', { shade: y });
  for (let y = 2; y <= 6; y++) for (let x = -2; x <= 2; x++) for (let z = -1; z <= 1; z++) bt.put(x, y, z, y === 4 ? 'band' : 'hull', { shade: (x + 2) % 3 });
  for (const [cx, cy] of [[-1, 4], [0, 3], [1, 4], [1, 5]]) bt.put(cx, cy, -1, 'botCheck', { paint: true });
  for (const sx of [-3, 3]) { for (let y = 3; y <= 5; y++) bt.put(sx, y, 0, 'joint', { shade: y & 1 }); bt.put(sx, 2, 0, 'band', { shade: 1 }); }
  for (let y = 7; y <= 9; y++) for (let x = -2; x <= 2; x++) for (let z = -1; z <= 1; z++) bt.put(x, y, z, 'hull', { shade: (x + 3) % 3 });
  for (let x = -1; x <= 1; x++) bt.put(x, 8, -1, 'visor', { paint: true, visor: true });
  for (const sx of [-3, 3]) bt.put(sx, 8, 0, 'joint', { shade: 0 });
  bt.put(0, 10, 0, 'antenna'); bt.put(0, 11, 0, 'antenna'); bt.put(0, 12, 0, 'beacon', { beacon: true });
  const bot = finish(bt, (v) => clamp((v.y / 13) * 0.85 + h2(v.x, v.z + v.y * 3) * 0.12, 0, 1));

  const clouds = [];
  for (let i = 0; i < 6; i++) { const rects = []; for (let k = 0; k < 4; k++) rects.push({ dx: Math.round((h2(i, k) - .5) * 40), dy: Math.round((h2(k, i) - .5) * 6), w: 14 + Math.round(h2(i + 1, k) * 30), h: 2 + Math.round(h2(k + 1, i) * 4) }); clouds.push({ cx: 20 + h1(i * 5.1) * 320, cy: 40 + h1(i * 7.7) * 150, band: Math.min(2, Math.floor(i / 2)), rects, drift: 0.1 + h1(i * 3) * 0.15 }); }
  const skyline = []; for (let x = 0; x < LW; x += 3 + Math.floor(h1(x + 9) * 5)) skyline.push({ x, w: 3 + Math.floor(h1(x * 3 + 1) * 6), h: 6 + Math.floor(h1(x * 7 + 2) * 34) });
  return { platform, tower, bot, clouds, skyline };
}

// ---- renderer ---------------------------------------------------------------
export function mountPixelSwarm(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const C = {}; for (const [k, v] of Object.entries({ ...PAL, ...(opts.palette || {}) })) C[k] = Array.isArray(v) ? v.map(hex) : hex(v);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DUR = (opts.duration || 12000) / (opts.speed || 1);
  const m = buildSwarmModel();
  const lo = document.createElement('canvas'); lo.width = LW; lo.height = LH; const g = lo.getContext('2d');
  const stars = Array.from({ length: 90 }, (_, i) => ({ x: Math.floor(h1(i * 3.3) * LW), y: Math.floor(h1(i * 7.9) * LH * 0.6), a: 0.15 + h1(i + 2) * 0.55 }));
  const HORIZON = Math.round(LH * 0.66);

  let yaw = opts.yaw ?? -0.62, pitch = opts.pitch ?? 0.36, vyaw = 0, dragging = false, lastX = 0, lastT = 0, idleSince = 0;
  let zoom = opts.zoom || 1, S = 4.8 * zoom;
  let W = 0, H = 0, DPR = 1, scale = 1, ox = 0, oy = 0;
  let t0 = 0, p = reduce ? 1 : 0, raf = 0, lastFrame = 0;
  const CX = LW / 2, CY = LH * 0.72;
  const light = [-0.55, 0.75, -0.42];

  // the agents: a slot each, assembled in a ripple out from the gate, woken row by row
  const bots = SLOTS.map((s, i) => ({ i, sx: s.x, sz: s.z, x: s.x, z: s.z, rank: 0, variant: i % 7 === 3 ? 'bandGold' : i % 5 === 2 ? 'bandDeep' : 'band', awakeAt: 1, start: 0, frozenUntil: 0, job: null, bob: h1(i * 9.7) * 6.28 }));
  const byDist = [...bots].sort((a, b) => Math.hypot(a.sx - GATE.x, a.sz - GATE.z) - Math.hypot(b.sx - GATE.x, b.sz - GATE.z));
  byDist.forEach((b, r) => { b.rank = r; b.start = 0.26 + 0.46 * (r / (bots.length - 1)); b.awakeAt = 0.80 + 0.17 * (r / (bots.length - 1)); });
  const packets = [], glyphs = [];
  let nextAmbient = 0, nextRunner = 0, nextFreeze = 0, beaconPulse = 0;

  function resize() { const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height)); canvas.width = W * DPR; canvas.height = H * DPR; scale = Math.max(W / LW, H / LH); ox = (W - LW * scale) / 2; oy = (H - LH * scale) / 2; }

  const phaseOf = (now) => now < 0.12 ? 'platform' : now < 0.28 ? 'key tower' : now < 0.80 ? 'swarm' : now < 1 ? 'online' : 'buying work';

  let cy_, sy_, cp_, sp_;
  const proj = (x, y, z) => { const rx = x * cy_ - z * sy_, rz = x * sy_ + z * cy_; return { sx: CX + rx * S, sy: CY - (y * cp_ - rz * sp_) * S, d: rz * cp_ + y * sp_ }; };
  const depth = (x, z) => (x * sy_ + z * cy_) * cp_;
  const face = (sx, sy, o, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(Math.round(sx + o[0][0]), Math.round(sy + o[0][1])); for (let i = 1; i < 4; i++) g.lineTo(Math.round(sx + o[i][0]), Math.round(sy + o[i][1])); g.closePath(); g.fill(); };
  const px = (x, y, col, w = 1, h = 1) => { g.fillStyle = col; g.fillRect(Math.round(x), Math.round(y), w, h); };
  // a palette entry is either one colour ([r,g,b]) or a list of shades ([[r,g,b], ...])
  const shadeOf = (c, v) => Array.isArray(c[0]) ? c[(v.shade ?? 0) % c.length] : c;
  const colFor = (v, ent) => {
    if (v.visor) return ent?.frozen ? C.visorFrozen : ent?.awake ? C.visor : C.visorOff;
    if (v.c === 'band' && ent?.variant) return shadeOf(C[ent.variant], v);
    return shadeOf(C[v.c] || C.hull, v);
  };

  // Draw one model at a world offset. `localNow` is its assembly progress; voxels
  // drop in with a small overshoot. Faces are merged into vertical runs.
  let O, sides, Ltop, riseY;
  function drawModel(model, ex, ey, ez, localNow, ent, dropFrom) {
    for (const col of model.cols) col.d = depth(col.x + ex, col.z + ez);
    model.cols.sort((a, b) => b.d - a.d);
    for (const col of model.cols) {
      const runs = new Map(), tops = [];
      const flush = (bit) => { const r = runs.get(bit); if (!r) return; runs.delete(bit); const q = proj(col.x + ex, r.y0 + ey, col.z + ez), h = r.y1 - r.y0 + 1, o = r.o; face(q.sx, q.sy, [o[0], o[1], [o[1][0], o[1][1] + riseY * h], [o[0][0], o[0][1] + riseY * h]], css(r.col, r.lm)); };
      const flushAll = () => { for (const [bit] of sides) flush(bit); };
      for (const v of col.vs) {
        if (localNow < v.t0) { flushAll(); continue; }
        const k = clamp((localNow - v.t0) / 0.08, 0, 1);
        const cc = colFor(v, ent);
        if (k < 1) { flushAll(); const e = easeOutBack(k), q = proj(v.x + ex, v.y + ey + (1 - e) * dropFrom, v.z + ez); for (const [bit, o, show, lm] of sides) if (show && (v.f & bit)) face(q.sx, q.sy, o, css(cc, lm)); if (v.f & TOP) face(q.sx, q.sy, O.top, css(cc, Ltop)); if (k > 0.3) px(q.sx, q.sy - S, css(C.antenna, 1, (1 - k) * .9)); continue; }
        for (const [bit, o, show, lm] of sides) {
          if (!show || !(v.f & bit)) { flush(bit); continue; }
          const r = runs.get(bit);
          if (r && r.y1 === v.y - 1 && r.col === cc) r.y1 = v.y; else { flush(bit); runs.set(bit, { y0: v.y, y1: v.y, o, lm, col: cc }); }
        }
        if (v.f & TOP) tops.push(v);
      }
      flushAll();
      for (const v of tops) { const q = proj(v.x + ex, v.y + ey, v.z + ez); face(q.sx, q.sy, O.top, css(colFor(v, ent), Ltop)); }
    }
  }

  // an arc between two world points, for packets
  const arc = (a, b, k, lift) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k + Math.sin(k * Math.PI) * lift, z: a.z + (b.z - a.z) * k });
  const towerTop = { x: TOWER.x, y: TOWER.h + 2, z: TOWER.z };
  const sendPacket = (bot, kind, done) => packets.push({ bot, kind, k: 0, speed: kind === 'req' ? 1.6 : 1.3, done });
  const trade = (bot, big) => {
    sendPacket(bot, 'req', () => { beaconPulse = 1; const ok = h1(performance.now() + bot.i) > 0.12; setTimeout(() => sendPacket(bot, ok ? 'receipt' : 'deny', () => glyphs.push({ bot, kind: ok ? 'ok' : 'no', life: 1, big })), 120 + 200 * h1(bot.i + 3)); });
  };

  function updateSwarm(now, tm, dt) {
    const online = now >= 1;
    for (const b of bots) { b.awake = now >= b.awakeAt; b.frozen = tm < b.frozenUntil; }
    if (!online || reduce) return;
    // ambient traffic: a random awake agent buys work
    if (tm > nextAmbient) { nextAmbient = tm + 420 + h1(tm) * 700; const pool = bots.filter((b) => b.awake && !b.frozen && !b.job); if (pool.length) trade(pool[Math.floor(h1(tm * 1.7) * pool.length)], false); }
    // a runner walks to the gate, trades, walks back
    if (tm > nextRunner) {
      nextRunner = tm + 5200 + h1(tm * 2.3) * 2400;
      const pool = bots.filter((b) => b.awake && !b.frozen && !b.job);
      if (pool.length) { const b = pool[Math.floor(h1(tm * 3.1) * pool.length)]; const path = pathTo(b); let len = 0; for (let i = 1; i < path.length; i++) len += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z); b.job = { t: 0, path, len, out: len / 7, wait: 1.1, back: len / 7, traded: false }; }
    }
    // the kill switch: one agent goes dark for a moment, then is unfrozen
    if (tm > nextFreeze) { nextFreeze = tm + 9000 + h1(tm * 0.7) * 6000; const pool = bots.filter((b) => b.awake && !b.job); if (pool.length) { const b = pool[Math.floor(h1(tm * 5.3) * pool.length)]; b.frozenUntil = tm + 2600; glyphs.push({ bot: b, kind: 'frozen', life: 1, big: true }); } }
    for (const b of bots) {
      if (!b.job) { b.x = b.sx; b.z = b.sz; b.hop = 0; continue; }
      const j = b.job; j.t += dt;
      // position along the polyline at distance `d` from the slot
      const along = (d) => { let acc = 0; for (let i = 1; i < j.path.length; i++) { const a = j.path[i - 1], c2 = j.path[i], seg = Math.hypot(c2.x - a.x, c2.z - a.z); if (d <= acc + seg || i === j.path.length - 1) { const k = seg > 0 ? clamp((d - acc) / seg, 0, 1) : 1; return { x: a.x + (c2.x - a.x) * k, z: a.z + (c2.z - a.z) * k }; } acc += seg; } return j.path[j.path.length - 1]; };
      if (j.t < j.out) { const q = along(easeInOut(j.t / j.out) * j.len); b.x = q.x; b.z = q.z; b.hop = Math.abs(Math.sin(j.t * 9)) * 0.5; }
      else if (j.t < j.out + j.wait) { b.x = GATE.x; b.z = GATE.z; b.hop = 0; if (!j.traded) { j.traded = true; trade(b, true); } }
      else if (j.t < j.out + j.wait + j.back) { const q = along((1 - easeInOut((j.t - j.out - j.wait) / j.back)) * j.len); b.x = q.x; b.z = q.z; b.hop = Math.abs(Math.sin(j.t * 9)) * 0.5; }
      else { b.job = null; b.x = b.sx; b.z = b.sz; b.hop = 0; }
    }
    for (let i = packets.length - 1; i >= 0; i--) { const pk = packets[i]; pk.k += dt * pk.speed; if (pk.k >= 1) { packets.splice(i, 1); pk.done?.(); } }
    for (let i = glyphs.length - 1; i >= 0; i--) { const gl = glyphs[i]; gl.life -= dt * (gl.big ? 0.55 : 0.9); if (gl.life <= 0) glyphs.splice(i, 1); }
    beaconPulse *= 0.94;
  }

  function draw(now, tm) {
    cy_ = Math.cos(yaw); sy_ = Math.sin(yaw); cp_ = Math.cos(pitch); sp_ = Math.sin(pitch);
    const c = (x, y, z) => { const q = proj(x, y, z); return [q.sx - CX, q.sy - CY]; };
    O = { top: [c(-.5, 1, -.5), c(.5, 1, -.5), c(.5, 1, .5), c(-.5, 1, .5)], px: [c(.5, 0, -.5), c(.5, 0, .5), c(.5, 1, .5), c(.5, 1, -.5)], nx: [c(-.5, 0, .5), c(-.5, 0, -.5), c(-.5, 1, -.5), c(-.5, 1, .5)], pz: [c(.5, 0, .5), c(-.5, 0, .5), c(-.5, 1, .5), c(.5, 1, .5)], nz: [c(-.5, 0, -.5), c(.5, 0, -.5), c(.5, 1, -.5), c(-.5, 1, -.5)] };
    const nzv = (nx, nzz) => nx * sy_ + nzz * cy_;
    const lum = (nx, ny, nzz) => { const rx = nx * cy_ - nzz * sy_, rz = nx * sy_ + nzz * cy_; const d = rx * light[0] + ny * light[1] + rz * light[2]; return 0.66 + 0.52 * Math.max(0, d); };
    sides = [[NX, O.nx, nzv(-1, 0) < 0, lum(-1, 0, 0)], [PZ, O.pz, nzv(0, 1) < 0, lum(0, 0, 1)], [NZ, O.nz, nzv(0, -1) < 0, lum(0, 0, -1)], [PX, O.px, nzv(1, 0) < 0, lum(1, 0, 0)]];
    Ltop = 0.95 + 0.45 * lum(0, 1, 0);
    riseY = -cp_ * S;

    // --- sky: dusk bands with dithered edges, stars, clouds, a far skyline; a dark floor with a perspective grid ---
    const keys = [C.skyTop, C.skyMid, C.skyLow, C.haze, C.horizon], NB = 16, bh = Math.ceil(HORIZON / NB);
    const bands = Array.from({ length: NB }, (_, i) => { const t = (i / (NB - 1)) * (keys.length - 1), k = Math.min(keys.length - 2, Math.floor(t)), f = t - k; return keys[k].map((v, j) => v + (keys[k + 1][j] - v) * f); });
    for (let i = 0; i < NB; i++) { g.fillStyle = css(bands[i]); g.fillRect(0, i * bh, LW, bh); }
    for (let i = 1; i < NB; i++) { g.fillStyle = css(bands[i]); for (let x = 0; x < LW; x++) { if (h2(i, x) < .5) g.fillRect(x, i * bh - 1, 1, 1); if (h2(i + 40, x) < .25) g.fillRect(x, i * bh - 2, 1, 1); if (h2(i + 80, x) < .08) g.fillRect(x, i * bh - 3, 1, 1); } }
    for (const s of stars) px(s.x, s.y, css(C.star, 1, s.a * (0.6 + 0.4 * Math.sin(tm / 700 + s.x))));
    for (const cl of m.clouds) { const drift = Math.round((tm / 1000) * cl.drift); g.fillStyle = css(C.cloud[cl.band], 1, .5); for (const r of cl.rects) { const x = ((Math.round(cl.cx + r.dx + drift) + 40) % (LW + 80)) - 40; g.fillRect(x, Math.round(cl.cy + r.dy), r.w, r.h); } }
    for (const b of m.skyline) { px(b.x, HORIZON - b.h, css(C.far), b.w, b.h); for (let y = HORIZON - b.h + 2; y < HORIZON - 1; y += 3) for (let x = b.x + 1; x < b.x + b.w - 1; x += 2) if (h2(x, y) < 0.35) px(x, y, css(C.farWin, 1, .7)); }
    g.fillStyle = css(C.ground); g.fillRect(0, HORIZON, LW, LH - HORIZON);
    g.fillStyle = css(C.grid, 1, .6); g.fillRect(0, HORIZON, LW, 1);
    // the floor grid far below the platform, fading with distance
    g.save(); g.beginPath(); g.rect(0, HORIZON + 1, LW, LH - HORIZON); g.clip();
    g.lineWidth = 1;
    for (let i = -72; i <= 72; i += 6) {
      const a = proj(-72, -9, i), b = proj(72, -9, i), c2 = proj(i, -9, -72), d2 = proj(i, -9, 72);
      g.strokeStyle = css(C.grid, 1, .22); g.beginPath(); g.moveTo(a.sx, a.sy); g.lineTo(b.sx, b.sy); g.stroke();
      g.beginPath(); g.moveTo(c2.sx, c2.sy); g.lineTo(d2.sx, d2.sy); g.stroke();
    }
    g.restore();
    // the tower's light on the floor, and the platform's shadow
    { const q = proj(0, -8, 0); g.fillStyle = 'rgba(5,4,17,.65)'; g.beginPath(); g.ellipse(q.sx + 6, q.sy + 4, P * S * 1.2, P * S * 0.45, 0, 0, Math.PI * 2); g.fill(); }
    if (now > 0.28) { const q = proj(TOWER.x, -8, TOWER.z); g.fillStyle = css(C.towerCap, 1, .08 + .06 * beaconPulse); g.beginPath(); g.ellipse(q.sx, q.sy, 60, 20, 0, 0, Math.PI * 2); g.fill(); }

    // --- platform ---
    drawModel(m.platform, 0, 0, 0, clamp(now / 0.14, 0, 1), null, 1.8);
    // shadows under the agents and the tower
    for (const b of bots) { const k = clamp((now - b.start) / 0.14, 0, 1); if (k <= 0) continue; const q = proj(b.x, 0.02, b.z); g.fillStyle = `rgba(5,4,17,${0.45 * k})`; g.beginPath(); g.ellipse(q.sx + 2, q.sy + 1, 3.4 * S, 1.3 * S, 0, 0, Math.PI * 2); g.fill(); }
    if (now > 0.12) { const q = proj(TOWER.x + 2, 0.02, TOWER.z); g.fillStyle = 'rgba(5,4,17,.5)'; g.beginPath(); g.ellipse(q.sx + 6, q.sy + 2, (TOWER.w + 3) * S, (TOWER.d + 1.5) * S, 0, 0, Math.PI * 2); g.fill(); }

    // --- entities back to front: the tower and every agent ---
    const ents = [{ kind: 'tower', d: depth(TOWER.x, TOWER.z) }];
    for (const b of bots) if (now >= b.start) ents.push({ kind: 'bot', b, d: depth(b.x, b.z) });
    ents.sort((a, b) => b.d - a.d);
    for (const e of ents) {
      if (e.kind === 'tower') { drawModel(m.tower, 0, 0, 0, clamp((now - 0.12) / 0.18, 0, 1), null, 2.4); continue; }
      const b = e.b, local = clamp((now - b.start) / 0.14, 0, 1);
      const bob = b.awake && !b.frozen && now >= 1 && !reduce ? 0.18 * Math.sin(tm / 520 + b.bob) + 0.18 : 0;
      drawModel(m.bot, b.x, bob + (b.hop || 0), b.z, local, b, -3);
      if (local >= 1 && b.awake) {
        // visor glow and the antenna light
        const q = proj(b.x, 8.5 + bob + (b.hop || 0), b.z - 1), col = b.frozen ? C.frozen : C.visor;
        g.fillStyle = css(col, 1, b.frozen ? .25 : .14); g.beginPath(); g.ellipse(q.sx, q.sy, 6, 3, 0, 0, Math.PI * 2); g.fill();
        const a = proj(b.x, 13 + bob + (b.hop || 0), b.z); const blink = b.frozen ? (Math.floor(tm / 160) % 2 === 0) : (Math.floor((tm + b.i * 230) / 900) % 3 !== 0);
        px(a.sx, a.sy, css(b.frozen ? C.frozen : C.antenna, 1, blink ? .95 : .3));
      }
    }
    // gate ring lamps
    if (now > 0.2) for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; const q = proj(GATE.x + Math.cos(a) * 2.6, 0.6, GATE.z + Math.sin(a) * 2.6); const on = now >= 1 ? (Math.floor(tm / 120) % 12 === i ? 1 : 0.35) : 0.6; px(q.sx, q.sy, css(C.lamp, 1, on)); }
    // the tower beacon and its gate glow
    if (now > 0.28) {
      const blink = Math.floor(tm / 600) % 2 === 0; const q = proj(TOWER.x, TOWER.h + 3, TOWER.z); px(q.sx, q.sy, css(C.beacon, 1, blink ? .95 : .3));
      const gq = proj(TOWER.x, 2.5, TOWER.z - TOWER.d - 0.6); g.fillStyle = css(C.gate, 1, .10 + .18 * beaconPulse); g.beginPath(); g.ellipse(gq.sx, gq.sy + 2, 14, 7, 0, 0, Math.PI * 2); g.fill();
      if (beaconPulse > 0.05) { const t = proj(TOWER.x, TOWER.h + 2, TOWER.z); g.fillStyle = css(C.towerCap, 1, .35 * beaconPulse); g.beginPath(); g.ellipse(t.sx, t.sy, 10 + 14 * (1 - beaconPulse), 5 + 7 * (1 - beaconPulse), 0, 0, Math.PI * 2); g.fill(); }
    }
    // --- packets: requests up to the tower, receipts back down ---
    for (const pk of packets) {
      const b = pk.bot, from = { x: b.x, y: 13 + (b.hop || 0), z: b.z };
      const a = pk.kind === 'req' ? from : towerTop, bq = pk.kind === 'req' ? towerTop : from;
      const w = arc(a, bq, pk.k, 7), q = proj(w.x, w.y, w.z);
      const core = pk.kind === 'req' ? C.packetCore : pk.kind === 'deny' ? C.frozen : C.receiptCore, halo = pk.kind === 'req' ? C.packet : pk.kind === 'deny' ? C.frozen : C.receipt;
      for (let t = 1; t <= 4; t++) { const wq = arc(a, bq, clamp(pk.k - t * 0.05, 0, 1), 7), qq = proj(wq.x, wq.y, wq.z); px(qq.sx, qq.sy, css(halo, 1, .5 - t * .1)); }
      px(q.sx - 1, q.sy - 1, css(halo, 1, .6), 3, 3); px(q.sx, q.sy, css(core, 1, 1));
    }
    // --- glyphs: a check or a cross floating up from the agent ---
    for (const gl of glyphs) {
      const b = gl.bot, rise = (1 - gl.life) * (gl.big ? 10 : 6), q = proj(b.x, 15 + rise, b.z), a = clamp(gl.life * 1.6, 0, 1);
      if (gl.kind === 'ok') { const col = css(C.ok, 1, a); [[-2, 0], [-1, 1], [0, 2], [1, 1], [2, 0], [3, -1]].forEach(([dx, dy]) => px(q.sx + dx, q.sy - dy, col)); }
      else { const col = css(C.frozen, 1, a); [[-2, -2], [-1, -1], [0, 0], [1, 1], [2, 2], [-2, 2], [-1, 1], [1, -1], [2, -2]].forEach(([dx, dy]) => px(q.sx + dx, q.sy + dy, col)); }
      if (gl.big) { g.fillStyle = css(gl.kind === 'ok' ? C.ok : C.frozen, 1, .12 * a); g.beginPath(); g.ellipse(q.sx, q.sy, 9, 5, 0, 0, Math.PI * 2); g.fill(); }
    }

    // vignette
    const grd = g.createRadialGradient(CX, LH * 0.55, LH * 0.3, CX, LH * 0.55, LH * 0.78); grd.addColorStop(0, 'rgba(5,4,17,0)'); grd.addColorStop(1, 'rgba(5,4,17,.65)'); g.fillStyle = grd; g.fillRect(0, 0, LW, LH);

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lo, Math.round(ox), Math.round(oy), LW * scale, LH * scale);
  }

  function frame(tm) {
    const dt = lastFrame ? Math.min(0.05, (tm - lastFrame) / 1000) : 0.016; lastFrame = tm;
    if (p < 1) p = clamp((tm - t0) / DUR, 0, 1);
    updateSwarm(p, tm, dt);
    if (!dragging) { yaw += vyaw; vyaw *= 0.93; if (!reduce && tm - idleSince > 2600) yaw += 0.0011; }
    draw(p, tm);
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
    replay() { p = 0; t0 = performance.now(); packets.length = 0; glyphs.length = 0; for (const b of bots) { b.job = null; b.frozenUntil = 0; b.x = b.sx; b.z = b.sz; } idleSince = t0 + DUR; },
    setView(y, pt) { yaw = y; pitch = clamp(pt, 0.05, 0.9); idleSince = performance.now(); },
    get progress() { return p; },
    get phase() { return phaseOf(p); },
    get online() { return bots.filter((b) => b.awake && !b.frozen).length; },
    get total() { return bots.length; },
  };
}
