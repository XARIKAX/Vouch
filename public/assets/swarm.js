/* ============================================================================
   PixelSwarm — the agents page's hero. No scene, no ground: a swarm of pixel
   robots hovering over the page itself. Each one is a clear figure (a boxy
   head with a visor and two lit eyes, an antenna, a torso with a shoulder
   band and the Vouch check on its chest, arms, hover thrusters), outlined in
   ink so it reads on paper. They assemble block by block, wake eye by eye,
   then idle: hovering, turning a little, thrusters glowing, and trading
   packets with one another. Drag to turn the whole swarm.

   mountPixelSwarm(canvas, { zoom, duration }) →
     { destroy(), replay(), setView(yaw, pitch), progress, phase, online, total }
   ========================================================================== */

const LW = 400, LH = 480;                    // logical buffer, upscaled nearest-neighbour

const PAL = {
  ink: '#121216',
  hull: ['#f6f4ee', '#e4e1d8', '#cfcabd'],          // cream, lit → shaded
  hullAlt: ['#8f7cff', '#6a55ff', '#5b3df0'],       // a few robots are purple
  band: ['#5b3df0', '#4529c4'], bandAlt: ['#f6f4ee', '#e4e1d8'], bandGold: ['#f3d27a', '#d9ad46'],
  joint: ['#3a3a4e', '#2c2c3c'], tread: ['#24242f', '#1b1b24'],
  visor: '#1b1b24', eye: '#f3d27a', eyeOff: '#3a3a4e', eyeFrozen: '#ff3b3b',
  check: '#5b3df0', checkAlt: '#f6f4ee', antenna: '#3a3a4e', tip: '#8f7cff', tipFrozen: '#ff3b3b',
  thrust: '#8f7cff', thrustCore: '#dcd4ff', packet: '#5b3df0', packetCore: '#dcd4ff', ok: '#22c55e', no: '#ff3b3b',
};

const h1 = (a) => { const x = Math.sin(a * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const h2 = (a, b) => h1(a * 7.31 + b * 19.17);
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const css = (c, m = 1, a = 1) => `rgba(${Math.min(255, c[0] * m) | 0},${Math.min(255, c[1] * m) | 0},${Math.min(255, c[2] * m) | 0},${a})`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOutBack = (k) => { const c1 = 1.15, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const TOP = 1, PX = 2, NX = 4, PZ = 8, NZ = 16;

// ---- the robot ----------------------------------------------------------------
// Local space: x across, y up, z toward the viewer is −z. ~18 blocks tall.
export function buildRobot() {
  const occ = new Map();
  const put = (x, y, z, c, extra = {}) => occ.set(x + ',' + y + ',' + z, { x, y, z, c, ...extra });
  // thrusters (feet): two dark pods
  for (const sx of [-1, 1]) for (const x of [1, 2]) for (let z = -1; z <= 1; z++) for (const y of [0, 1]) put(sx * x, y, z, 'tread', { shade: y });
  // belt and torso, 7 wide, 5 deep
  for (let x = -3; x <= 3; x++) for (let z = -2; z <= 2; z++) put(x, 2, z, 'joint', { shade: 0 });
  for (let y = 3; y <= 7; y++) for (let x = -3; x <= 3; x++) for (let z = -2; z <= 2; z++) put(x, y, z, y === 6 ? 'band' : 'hull', { shade: (x + 3) % 3 });
  // the check on the chest: short arm down, long arm up
  for (const [cx, cy] of [[-2, 5], [-1, 4], [0, 3], [1, 4], [2, 5]]) put(cx, cy, -2, 'check', { paint: true });
  // shoulders and arms, hands
  for (const sx of [-4, 4]) { for (let z = -1; z <= 1; z++) put(sx, 7, z, 'band', { shade: 1 }); for (let y = 3; y <= 6; y++) put(sx, y, 0, 'joint', { shade: y & 1 }); put(sx, 2, 0, 'hull', { shade: 1 }); put(sx, 1, 0, 'hull', { shade: 2 }); }
  // neck
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) put(x, 8, z, 'joint', { shade: 1 });
  // head, 7 wide, 5 deep, 6 tall; a dark visor across the front with two eyes
  for (let y = 9; y <= 14; y++) for (let x = -3; x <= 3; x++) for (let z = -2; z <= 2; z++) put(x, y, z, 'hull', { shade: (x + 4) % 3 });
  for (let x = -2; x <= 2; x++) for (const y of [11, 12]) put(x, y, -2, 'visor', { paint: true });
  put(-1, 12, -2, 'eye', { paint: true, eye: true }); put(1, 12, -2, 'eye', { paint: true, eye: true });
  // ear pods and the antenna
  for (const sx of [-4, 4]) for (const y of [11, 12]) put(sx, y, 0, 'joint', { shade: 0 });
  put(0, 15, 0, 'antenna'); put(0, 16, 0, 'antenna'); put(0, 17, 0, 'tip', { tip: true });

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
    v.t0 = clamp((v.y / 18) * 0.85 + h2(v.x, v.z + v.y * 3) * 0.12, 0, 1);   // feet first, antenna last
    vox.push(v);
  }
  const colMap = new Map();
  for (const v of vox) { const k = v.x + ',' + v.z; if (!colMap.has(k)) colMap.set(k, { x: v.x, z: v.z, vs: [] }); colMap.get(k).vs.push(v); }
  const cols = [...colMap.values()]; cols.forEach((c) => c.vs.sort((a, b) => a.y - b.y));
  return { vox, cols, height: 18 };
}

// The swarm's formation: three ranks at different depths and heights, loosely
// staggered. Nearer ranks are drawn larger.
export const FORMATION = [
  { x: -18, y: 15, z: 10, s: 0.8 }, { x: -9, y: 13, z: 11, s: 0.8 }, { x: 0, y: 16, z: 12, s: 0.8 }, { x: 9, y: 13, z: 11, s: 0.8 }, { x: 18, y: 15, z: 10, s: 0.8 },
  { x: -14, y: 4, z: 0, s: 1.0 }, { x: -5, y: 6, z: 1, s: 1.0 }, { x: 5, y: 3, z: 1, s: 1.0 }, { x: 14, y: 5, z: 0, s: 1.0 },
  { x: -11, y: -8, z: -10, s: 1.2 }, { x: 0, y: -6, z: -11, s: 1.2 }, { x: 11, y: -9, z: -10, s: 1.2 },
  { x: -23, y: -1, z: -4, s: 1.0 }, { x: 23, y: 0, z: -4, s: 1.0 },
];

// ---- renderer ---------------------------------------------------------------
export function mountPixelSwarm(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const C = {}; for (const [k, v] of Object.entries({ ...PAL, ...(opts.palette || {}) })) C[k] = Array.isArray(v) ? v.map(hex) : hex(v);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DUR = (opts.duration || 7000) / (opts.speed || 1);
  const robot = buildRobot();
  const lo = document.createElement('canvas'); lo.width = LW; lo.height = LH; const g = lo.getContext('2d');

  let yaw = opts.yaw ?? -0.35, pitch = opts.pitch ?? 0.22, vyaw = 0, dragging = false, lastX = 0, lastT = 0, idleSince = 0;
  const zoom = opts.zoom || 1, S = 6.7 * zoom;
  // one robot is drawn into `tmp`, its ink silhouette into `ink`, then both are
  // blitted: one render per robot instead of five
  const tmp = document.createElement('canvas'); tmp.width = LW; tmp.height = LH; const gt = tmp.getContext('2d');
  const ink = document.createElement('canvas'); ink.width = LW; ink.height = LH; const gi = ink.getContext('2d');
  let W = 0, H = 0, DPR = 1, scale = 1, ox = 0, oy = 0;
  let t0 = 0, p = reduce ? 1 : 0, raf = 0, lastFrame = 0;
  const CX = LW / 2, CY = LH * 0.64;
  const light = [-0.5, 0.8, -0.45];

  const bots = FORMATION.map((f, i) => ({
    i, ...f, bx: f.x, by: f.y, bz: f.z,
    purple: i % 5 === 2, gold: i % 7 === 4, phase: h1(i * 9.7) * 6.28, spin: (h1(i * 3.3) - 0.5) * 0.5, spinRate: 0.4 + h1(i * 5.1) * 0.5,
    start: 0, awakeAt: 1, frozenUntil: 0, awake: false, frozen: false, byaw: 0, hover: 0,
  }));
  // assemble front to back in a ripple, wake in the same order
  const order = [...bots].sort((a, b) => a.z - b.z || a.x - b.x);
  order.forEach((b, r) => { b.start = 0.04 + 0.56 * (r / (bots.length - 1)); b.awakeAt = 0.78 + 0.2 * (r / (bots.length - 1)); });
  const packets = [], glyphs = [], sparks = [];
  let nextPacket = 0, nextFreeze = 0;

  function resize() { const r = canvas.getBoundingClientRect(); DPR = Math.min(2, window.devicePixelRatio || 1); W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height)); canvas.width = W * DPR; canvas.height = H * DPR; scale = Math.min(W / LW, H / LH); ox = (W - LW * scale) / 2; oy = (H - LH * scale) / 2; }
  const phaseOf = (now) => now < 0.6 ? 'assembling' : now < 1 ? 'waking' : 'online';

  // the global camera: where each robot's centre lands
  let cy_, sy_, cp_, sp_;
  const projG = (x, y, z) => { const rx = x * cy_ - z * sy_, rz = x * sy_ + z * cy_; return { sx: CX + rx * S, sy: CY - (y * cp_ - rz * sp_) * S, d: rz * cp_ + y * sp_ }; };
  let G = g;                                   // the context faces go to (the robot scratch canvas while a robot is drawn)
  const face = (sx, sy, o, col) => { G.fillStyle = col; G.beginPath(); G.moveTo(Math.round(sx + o[0][0]), Math.round(sy + o[0][1])); for (let i = 1; i < 4; i++) G.lineTo(Math.round(sx + o[i][0]), Math.round(sy + o[i][1])); G.closePath(); G.fill(); };
  const px = (x, y, col, w = 1, h = 1) => { G.fillStyle = col; G.fillRect(Math.round(x), Math.round(y), w, h); };
  const shadeOf = (c, v) => Array.isArray(c[0]) ? c[(v.shade ?? 0) % c.length] : c;
  const colFor = (v, b) => {
    if (v.eye) return b.frozen ? C.eyeFrozen : b.awake ? C.eye : C.eyeOff;
    if (v.tip) return b.frozen ? C.tipFrozen : C.tip;
    if (v.c === 'hull') return shadeOf(b.purple ? C.hullAlt : C.hull, v);
    if (v.c === 'band') return shadeOf(b.purple ? C.bandAlt : b.gold ? C.bandGold : C.band, v);
    if (v.c === 'check') return b.purple ? C.checkAlt : C.check;
    return shadeOf(C[v.c], v);
  };

  // Draw one robot with its own yaw and size at a screen centre. `tint`
  // paints every face one colour (the ink outline pass). Faces merge into
  // vertical runs.
  function drawRobot(b, csx, csy, Se, localNow, tint) {
    const yawE = yaw + b.byaw, cy = Math.cos(yawE), sy = Math.sin(yawE);
    const proj = (x, y, z) => { const rx = x * cy - z * sy, rz = x * sy + z * cy; return { sx: csx + rx * Se, sy: csy - (y * cp_ - rz * sp_) * Se }; };
    const c = (x, y, z) => { const q = proj(x, y, z); return [q.sx - csx, q.sy - csy]; };
    const O = { top: [c(-.5, 1, -.5), c(.5, 1, -.5), c(.5, 1, .5), c(-.5, 1, .5)], px: [c(.5, 0, -.5), c(.5, 0, .5), c(.5, 1, .5), c(.5, 1, -.5)], nx: [c(-.5, 0, .5), c(-.5, 0, -.5), c(-.5, 1, -.5), c(-.5, 1, .5)], pz: [c(.5, 0, .5), c(-.5, 0, .5), c(-.5, 1, .5), c(.5, 1, .5)], nz: [c(-.5, 0, -.5), c(.5, 0, -.5), c(.5, 1, -.5), c(-.5, 1, -.5)] };
    const nzv = (nx, nzz) => nx * sy + nzz * cy;
    const lum = (nx, ny, nzz) => { const rx = nx * cy - nzz * sy, rz = nx * sy + nzz * cy; const d = rx * light[0] + ny * light[1] + rz * light[2]; return 0.72 + 0.4 * Math.max(0, d); };
    const sides = [[NX, O.nx, nzv(-1, 0) < 0, lum(-1, 0, 0)], [PZ, O.pz, nzv(0, 1) < 0, lum(0, 0, 1)], [NZ, O.nz, nzv(0, -1) < 0, lum(0, 0, -1)], [PX, O.px, nzv(1, 0) < 0, lum(1, 0, 0)]];
    const Ltop = 1.0 + 0.2 * lum(0, 1, 0);
    const riseY = -cp_ * Se;
    const depth = (x, z) => (x * sy + z * cy) * cp_;
    for (const col of robot.cols) col.d = depth(col.x, col.z);
    robot.cols.sort((a, b2) => b2.d - a.d);
    const fill = (col, lm) => tint ? css(tint) : css(col, lm);
    for (const col of robot.cols) {
      const runs = new Map(), tops = [];
      const flush = (bit) => { const r = runs.get(bit); if (!r) return; runs.delete(bit); const q = proj(col.x, r.y0, col.z), h = r.y1 - r.y0 + 1, o = r.o; face(q.sx, q.sy, [o[0], o[1], [o[1][0], o[1][1] + riseY * h], [o[0][0], o[0][1] + riseY * h]], fill(r.col, r.lm)); };
      const flushAll = () => { for (const [bit] of sides) flush(bit); };
      for (const v of col.vs) {
        if (localNow < v.t0) { flushAll(); continue; }
        const k = clamp((localNow - v.t0) / 0.1, 0, 1);
        const cc = colFor(v, b);
        if (k < 1) { flushAll(); const e = easeOutBack(k), q = proj(v.x, v.y + (1 - e) * 4, v.z); for (const [bit, o, show, lm] of sides) if (show && (v.f & bit)) face(q.sx, q.sy, o, fill(cc, lm)); if (v.f & TOP) face(q.sx, q.sy, O.top, fill(cc, Ltop)); continue; }
        for (const [bit, o, show, lm] of sides) {
          if (!show || !(v.f & bit)) { flush(bit); continue; }
          const r = runs.get(bit);
          if (r && r.y1 === v.y - 1 && r.col === cc) r.y1 = v.y; else { flush(bit); runs.set(bit, { y0: v.y, y1: v.y, o, lm, col: cc }); }
        }
        if (v.f & TOP) tops.push(v);
      }
      flushAll();
      for (const v of tops) { const q = proj(v.x, v.y, v.z); face(q.sx, q.sy, O.top, fill(colFor(v, b), Ltop)); }
    }
    return proj;
  }

  const trade = (from, to) => packets.push({ from, to, k: 0, ok: h1(performance.now() + from.i) > 0.12 });
  function update(now, tm, dt) {
    for (const b of bots) {
      b.awake = now >= b.awakeAt; b.frozen = tm < b.frozenUntil;
      const live = b.awake && !b.frozen && now >= 1 && !reduce;
      b.hover = live ? 0.9 * Math.sin(tm / 900 + b.phase) : 0;
      b.byaw = live ? b.spin * Math.sin(tm / 1000 * b.spinRate + b.phase) : 0;
    }
    if (now < 1 || reduce) return;
    if (tm > nextPacket) { nextPacket = tm + 500 + h1(tm) * 900; const pool = bots.filter((b) => b.awake && !b.frozen); if (pool.length > 1) { const a = pool[Math.floor(h1(tm * 1.7) * pool.length)]; let c = pool[Math.floor(h1(tm * 2.9) * pool.length)]; if (c === a) c = pool[(pool.indexOf(a) + 1) % pool.length]; trade(a, c); } }
    if (tm > nextFreeze) { nextFreeze = tm + 9000 + h1(tm * 0.7) * 7000; const pool = bots.filter((b) => b.awake); if (pool.length) { const b = pool[Math.floor(h1(tm * 5.3) * pool.length)]; b.frozenUntil = tm + 2400; glyphs.push({ bot: b, kind: 'no', life: 1 }); } }
    for (let i = packets.length - 1; i >= 0; i--) { const pk = packets[i]; pk.k += dt * 1.4; if (pk.k >= 1) { packets.splice(i, 1); glyphs.push({ bot: pk.to, kind: pk.ok ? 'ok' : 'no', life: 1 }); } }
    for (let i = glyphs.length - 1; i >= 0; i--) { const gl = glyphs[i]; gl.life -= dt * 0.8; if (gl.life <= 0) glyphs.splice(i, 1); }
    // thruster sparks
    for (const b of bots) if (b.awake && !b.frozen && h1(tm + b.i * 7) < 0.5) sparks.push({ b, x: (h1(tm * 3 + b.i) - 0.5) * 3.2, z: (h1(tm * 5 + b.i) - 0.5) * 1.6, y: -0.5, vy: -(3 + 3 * h1(tm + b.i * 2)), life: 1 });
    for (let i = sparks.length - 1; i >= 0; i--) { const s = sparks[i]; s.y += s.vy * dt; s.life -= dt * 2.2; if (s.life <= 0 || sparks.length > 260) sparks.splice(i, 1); }
  }

  function draw(now, tm) {
    cy_ = Math.cos(yaw); sy_ = Math.sin(yaw); cp_ = Math.cos(pitch); sp_ = Math.sin(pitch);
    g.clearRect(0, 0, LW, LH);
    // robots back to front
    const ents = bots.filter((b) => now >= b.start).map((b) => ({ b, q: projG(b.bx, b.by + b.hover, b.bz) }));
    ents.sort((a, b2) => b2.q.d - a.q.d);
    for (const { b, q } of ents) {
      const Se = S * b.s, local = clamp((now - b.start) / 0.3, 0, 1);
      // thruster glow and sparks beneath, before the body
      if (b.awake && !b.frozen && local >= 1) {
        const t = projG(b.bx, b.by + b.hover - 1, b.bz);
        g.fillStyle = css(C.thrust, 1, .18); g.beginPath(); g.ellipse(t.sx, t.sy + 2, 3.2 * Se, 1.2 * Se, 0, 0, Math.PI * 2); g.fill();
        for (const s of sparks) if (s.b === b) { const sq = projG(b.bx + s.x, b.by + b.hover + s.y, b.bz + s.z); px(sq.sx, sq.sy, css(s.life > 0.5 ? C.thrustCore : C.thrust, 1, s.life)); }
      }
      // render the robot once into the scratch canvas, make its ink silhouette,
      // then blit the silhouette a pixel each way and the robot on top
      const bw = Math.ceil(14 * Se), bh = Math.ceil(27 * Se), bx = Math.round(q.sx - bw / 2), by = Math.round(q.sy - 24.5 * Se);
      gt.clearRect(bx - 2, by - 2, bw + 4, bh + 4);
      G = gt; const proj = drawRobot(b, q.sx, q.sy, Se, local, null); G = g;
      gi.globalCompositeOperation = 'source-over'; gi.clearRect(bx - 2, by - 2, bw + 4, bh + 4); gi.drawImage(tmp, bx, by, bw, bh, bx, by, bw, bh);
      gi.globalCompositeOperation = 'source-in'; gi.fillStyle = css(C.ink); gi.fillRect(bx, by, bw, bh);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g.drawImage(ink, bx, by, bw, bh, bx + dx, by + dy, bw, bh);
      g.drawImage(tmp, bx, by, bw, bh, bx, by, bw, bh);
      if (local >= 1 && b.awake) {
        // eye glow and the antenna light
        const col = b.frozen ? C.eyeFrozen : C.eye;
        for (const ex of [-1, 1]) { const e = proj(ex, 12.5, -2.2); g.fillStyle = css(col, 1, .22); g.beginPath(); g.ellipse(e.sx, e.sy, 2.2 * Se, 1.2 * Se, 0, 0, Math.PI * 2); g.fill(); }
        const a = proj(0, 18, 0); const blink = b.frozen ? Math.floor(tm / 160) % 2 === 0 : Math.floor((tm + b.i * 230) / 900) % 3 !== 0;
        if (blink) { px(a.sx - 1, a.sy - 1, css(b.frozen ? C.tipFrozen : C.tip, 1, .9), 3, 3); px(a.sx, a.sy, css(C.packetCore, 1, 1)); }
      }
    }
    // packets between robots
    for (const pk of packets) {
      const a = projG(pk.from.bx, pk.from.by + pk.from.hover + 18, pk.from.bz), b2 = projG(pk.to.bx, pk.to.by + pk.to.hover + 18, pk.to.bz);
      const at = (k) => ({ x: a.sx + (b2.sx - a.sx) * k, y: a.sy + (b2.sy - a.sy) * k - Math.sin(k * Math.PI) * 28 });
      for (let t = 1; t <= 4; t++) { const w = at(clamp(pk.k - t * 0.05, 0, 1)); px(w.x, w.y, css(C.packet, 1, .5 - t * .1)); }
      const w = at(pk.k); px(w.x - 1, w.y - 1, css(C.packet, 1, .7), 3, 3); px(w.x, w.y, css(C.packetCore, 1, 1));
    }
    // glyphs: a check or a cross rising above a robot
    for (const gl of glyphs) {
      const b = gl.bot, q = projG(b.bx, b.by + b.hover + 20 + (1 - gl.life) * 6, b.bz), a = clamp(gl.life * 1.6, 0, 1);
      if (gl.kind === 'ok') { const col = css(C.ok, 1, a); [[-3, 0], [-2, 1], [-1, 2], [0, 1], [1, 0], [2, -1], [3, -2]].forEach(([dx, dy]) => { px(q.sx + dx, q.sy - dy, col); px(q.sx + dx, q.sy - dy - 1, col); }); }
      else { const col = css(C.no, 1, a); [[-2, -2], [-1, -1], [0, 0], [1, 1], [2, 2], [-2, 2], [-1, 1], [1, -1], [2, -2]].forEach(([dx, dy]) => px(q.sx + dx, q.sy + dy, col)); }
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lo, Math.round(ox), Math.round(oy), Math.round(LW * scale), Math.round(LH * scale));
  }

  function frame(tm) {
    const dt = lastFrame ? Math.min(0.05, (tm - lastFrame) / 1000) : 0.016; lastFrame = tm;
    if (p < 1) p = clamp((tm - t0) / DUR, 0, 1);
    update(p, tm, dt);
    if (!dragging) { yaw += vyaw; vyaw *= 0.93; if (!reduce && tm - idleSince > 2600) yaw = -0.35 + 0.25 * Math.sin(tm / 6000); }
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
    replay() { p = 0; t0 = performance.now(); packets.length = 0; glyphs.length = 0; sparks.length = 0; for (const b of bots) b.frozenUntil = 0; },
    setView(y, pt) { yaw = y; pitch = clamp(pt, 0.05, 0.9); idleSince = performance.now() + 6000; },
    get progress() { return p; },
    get phase() { return phaseOf(p); },
    get online() { return bots.filter((b) => b.awake && !b.frozen).length; },
    get total() { return bots.length; },
  };
}
