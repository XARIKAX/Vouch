/* ============================================================================
   PixelSkyscraper — a city constructed piece-by-piece in Canvas 2D.

   Everything is drawn into a small logical pixel buffer (LW x LH) and scaled
   to the screen with nearest-neighbour sampling, so every pixel is a real,
   intentional pixel. The scene is a data model (tiers, wings, buildings,
   windows, spire) built once; the renderer draws it at a construction
   progress p in [0,1] and then keeps it alive.

   mountPixelSkyscraper(canvas, { speed, detail, palette }) →
     { destroy(), replay(), seek(p) }
   ========================================================================== */

const LW = 200, LH = 300, U = 3;          // logical buffer + block unit
const HORIZON = 262, PODIUM_H = 3;         // water starts at HORIZON
const TOWER_BASE = HORIZON - PODIUM_H * U;

export const DEFAULT_PALETTE = {
  sky: ['#0b1544', '#10195a', '#182268', '#232b74', '#352f7c', '#4a3681', '#654184', '#86507f', '#ad6174', '#d07a60', '#ea9752', '#f4b65e'],
  cloud: ['#2b2f7a', '#5a3f88', '#9a5b7a', '#df8d5c'],
  distant: '#1f2360',
  glass: ['#121a38', '#171f44', '#1c2650', '#222e5c', '#2a3869'],
  glassHi: '#4a5f9e', glassEdge: '#7389cc',
  window: ['#f2a845', '#ffd07a', '#e8902e', '#ffe39d'],
  podium: '#2a2d4f', podiumLight: '#ffd58a',
  back: '#141a3c', backWin: '#9c6a34',
  front: '#1b2148', frontWin: '#f0a648',
  spire: '#8ea3dc', spireTip: '#fff4c2',
  water: '#0c1434',
};

// ---- deterministic noise ----------------------------------------------------
const h1 = (a) => { const x = Math.sin(a * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const h2 = (a, b) => h1(a * 7.31 + b * 19.17);
const hex = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const css = (c, m = 1, a = 1) => `rgba(${c.map((v) => Math.max(0, Math.min(255, Math.round(v * m)))).join(',')},${a})`;
const easeOutBack = (k) => { const c1 = 1.15, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// ---- geometry ---------------------------------------------------------------
// Tiers: half-width (blocks) and height (rows), bottom → top. Setbacks follow
// the reference: a broad base that narrows through many tiers to a needle.
// Slender: ~3:1 height to width, eleven setbacks narrowing to a one-block needle.
const TIERS = [
  { h: 9, w: 10 }, { h: 7, w: 9 }, { h: 7, w: 8 }, { h: 7, w: 7 }, { h: 6, w: 6 }, { h: 6, w: 5 },
  { h: 6, w: 4 }, { h: 6, w: 3 }, { h: 6, w: 2 }, { h: 5, w: 1 }, { h: 3, w: 1 },
];
// Buttress wings widen the lower silhouette and step in at two heights.
const WINGS = [{ rows: 14, w: 13 }, { rows: 26, w: 11 }];
const SPIRE_PX = 26;

export function buildCity(detail = 'full') {
  const rows = TIERS.reduce((a, t) => a + t.h, 0);
  const halfAt = (r) => { let acc = 0; for (const t of TIERS) { if (r < acc + t.h) return t.w; acc += t.h; } return 1; };
  const timeForRow = (r) => 0.30 + 0.60 * Math.pow(r / rows, 0.78); // lower slow, upper fast
  const blocks = [], windows = [];

  for (let r = 0; r < rows; r++) {
    let w = halfAt(r);
    for (const wing of WINGS) if (r < wing.rows) w = Math.max(w, wing.w);
    const litFloor = h1(r * 3.3) < 0.58;
    for (let c = -w; c < w; c++) {
      const tier = (() => { let acc = 0, i = 0; for (const t of TIERS) { if (r < acc + t.h) return i; acc += t.h; i++; } return TIERS.length - 1; })();
      const mullion = ((c + 100) % 4) === 0;
      const t0 = timeForRow(r) + (h2(r, c) - 0.5) * 0.024 + (c / w) * 0.006;
      blocks.push({ x: c, y: r, tier, shade: Math.floor(h2(r * 1.7, c * 0.9) * 5), mullion, t0, slide: h2(c, r) < 0.22 ? (c < 0 ? -1 : 1) : 0, seed: h2(r + 9, c + 3) });
      if (!mullion && h2(Math.floor(c / 3) + 50, r) < (litFloor ? 0.72 : 0.08)) {
        windows.push({ x: c, y: r, color: Math.floor(h2(c + 1, r + 2) * 4), t0: t0 + 0.02 + h2(r, c + 77) * 0.07, lit: true });
      }
    }
  }
  const towerTop = TOWER_BASE - rows * U;

  // podium: a wide, low plinth with a line of warm fountain lights
  const podium = [];
  for (let r = 0; r < PODIUM_H; r++) for (let c = -19; c < 19; c++) podium.push({ x: c, y: r, t0: 0.16 + h2(r, c) * 0.1, light: r === 0 && ((c + 100) % 3 === 0) });

  // surrounding city, back (behind the tower) and front (in front, lower)
  const mk = (list, specs, t0a, t0b) => specs.forEach((s, i) => {
    for (let r = 0; r < s.h; r++) for (let c = 0; c < s.w; c++) {
      list.push({ x: s.x + c, y: r, t0: t0a + (t0b - t0a) * (i / specs.length + (r / s.h) * 0.35) + h2(c, r) * 0.03,
        win: ((r % 2) === 0 && (c % 2) === 1 && h2(s.x + c, r) < s.density) });
    }
  });
  const lite = detail === 'lite';
  const back = [], front = [];
  mk(back, lite ? [{ x: -30, w: 6, h: 14, density: .45 }, { x: 22, w: 7, h: 18, density: .45 }]
               : [{ x: -31, w: 6, h: 14, density: .45 }, { x: -24, w: 5, h: 22, density: .4 }, { x: 17, w: 6, h: 19, density: .45 }, { x: 24, w: 7, h: 12, density: .4 }, { x: -18, w: 3, h: 9, density: .3 }, { x: 14, w: 3, h: 7, density: .3 }], 0.15, 0.30);
  mk(front, lite ? [{ x: -33, w: 7, h: 9, density: .5 }, { x: 25, w: 7, h: 8, density: .5 }]
                : [{ x: -33, w: 8, h: 10, density: .5 }, { x: -25, w: 4, h: 6, density: .4 }, { x: 23, w: 5, h: 7, density: .5 }, { x: 28, w: 6, h: 9, density: .5 }], 0.22, 0.40);

  // distant skyline at the horizon
  const distant = [];
  for (let x = 0; x < LW; x += 3) { const hgt = 4 + Math.floor(h1(x * 0.37) * 10); distant.push({ x, h: hgt, t0: 0.12 + h1(x) * 0.08 }); }

  // pixel clouds: a few overlapping rects each, drifting slowly
  const clouds = [];
  const n = lite ? 4 : 7;
  for (let i = 0; i < n; i++) {
    const cx = 10 + h1(i * 5.1) * 180, cy = 20 + h1(i * 7.7) * 170, band = Math.min(3, Math.floor(cy / 60));
    const rects = []; for (let k = 0; k < 4; k++) rects.push({ dx: Math.round((h2(i, k) - 0.5) * 26), dy: Math.round((h2(k, i) - 0.5) * 7), w: 10 + Math.round(h2(i + 1, k) * 22), h: 3 + Math.round(h2(k + 1, i) * 4) });
    clouds.push({ cx, cy, band, rects, t0: 0.04 + h1(i) * 0.1, drift: 0.15 + h1(i * 3) * 0.2 });
  }

  // spire pixels, bottom → top, then the tip light
  const spire = []; for (let i = 0; i < SPIRE_PX; i++) spire.push({ y: towerTop - 1 - i, t0: 0.90 + 0.085 * (i / SPIRE_PX), wide: i < 5 });

  return { rows, towerTop, blocks, windows, podium, back, front, distant, clouds, spire };
}

// ---- renderer ---------------------------------------------------------------
export function mountPixelSkyscraper(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const P = { ...DEFAULT_PALETTE, ...(opts.palette || {}) };
  const C = { sky: P.sky.map(hex), cloud: P.cloud.map(hex), glass: P.glass.map(hex), win: P.window.map(hex),
    glassHi: hex(P.glassHi), glassEdge: hex(P.glassEdge), distant: hex(P.distant), podium: hex(P.podium), podiumLight: hex(P.podiumLight),
    back: hex(P.back), backWin: hex(P.backWin), front: hex(P.front), frontWin: hex(P.frontWin), spire: hex(P.spire), spireTip: hex(P.spireTip), water: hex(P.water) };

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = !window.matchMedia('(pointer:fine)').matches;
  const detail = opts.detail && opts.detail !== 'auto' ? opts.detail : (coarse || window.innerWidth < 720 ? 'lite' : 'full');
  const DUR = (opts.duration || 6800) / (opts.speed || 1);
  const city = buildCity(detail);

  // offscreen buffers
  const mkBuf = () => { const c = document.createElement('canvas'); c.width = LW; c.height = LH; return c; };
  const lo = mkBuf(), loc = lo.getContext('2d');
  const sky = mkBuf(), skyc = sky.getContext('2d');
  const mid = mkBuf(), midc = mid.getContext('2d');
  const fg = mkBuf(), fgc = fg.getContext('2d');

  // the sky is static: quantised bands (no smooth gradient), drawn once
  (() => {
    const bands = C.sky.length, bh = Math.ceil(HORIZON / bands);
    for (let i = 0; i < bands; i++) { skyc.fillStyle = css(C.sky[i]); skyc.fillRect(0, i * bh, LW, bh); }
    // a little dithering between bands for a cinematic, un-flat sky
    for (let i = 1; i < bands; i++) { skyc.fillStyle = css(C.sky[i]); for (let x = 0; x < LW; x++) { if (h2(i, x) < 0.5) skyc.fillRect(x, i * bh - 1, 1, 1); if (h2(i + 40, x) < 0.22) skyc.fillRect(x, i * bh - 2, 1, 1); } }
    skyc.fillStyle = css(C.water); skyc.fillRect(0, HORIZON, LW, LH - HORIZON);
  })();

  let W = 0, H = 0, DPR = 1, scale = 1, ox = 0, oy = 0;
  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = W * DPR; canvas.height = H * DPR;
    scale = Math.min(W / LW, H / LH); ox = (W - LW * scale) / 2; oy = (H - LH * scale) / 2;
  }

  // ---- state ----
  let t0 = 0, p = reduce ? 1 : 0, seeked = null, started = reduce, raf = 0, last = 0;
  let mx = 0, my = 0, cmx = 0, cmy = 0;
  const live = { nextFlick: 0, particles: [] };
  for (let i = 0; i < (detail === 'lite' ? 0 : 8); i++) live.particles.push({ x: 60 + h1(i * 3) * 80, y: 60 + h1(i * 9) * 160, v: 0.08 + h1(i) * 0.1, a: h1(i * 5) });

  // ---- draw helpers (all in logical pixels) ----
  const blockPos = (b) => ({ x: Math.round(LW / 2 + b.x * U), y: TOWER_BASE - (b.y + 1) * U });
  function appear(b, now) {             // local animation of a block: returns null if not yet, else {k, dx, dy}
    if (now < b.t0) return null;
    const k = clamp01((now - b.t0) / 0.045);
    const e = easeOutBack(k);
    return { k, dx: b.slide ? Math.round((1 - e) * 5 * b.slide) : 0, dy: Math.round((1 - e) * 6) };
  }
  function fragments(g, x, y, k, col, seed) {   // pixel fragments collapsing into the block
    if (k >= 0.35) return;
    const s = 1 - k / 0.35; g.fillStyle = css(col, 1.4, 0.75 * s + 0.2);
    const dirs = [[-1, -1], [1, -0.7]];
    dirs.forEach((d, i) => { const m = 2 + Math.round(h2(seed, i) * 2); g.fillRect(Math.round(x + U / 2 + d[0] * m * s), Math.round(y + U / 2 + d[1] * m * s), 1, 1); });
  }
  function voxel(g, x, y, col, a = 1) {    // a 3x3 block with pixel depth: light top edge, dark right edge
    g.fillStyle = css(col, 1, a); g.fillRect(x, y, U, U);
    g.fillStyle = css(col, 1.28, a); g.fillRect(x, y, U, 1);
    g.fillStyle = css(col, 0.66, a); g.fillRect(x + U - 1, y, 1, U);
  }

  function drawScene(now, tm) {
    const done = now >= 1;
    // --- sky + atmosphere ---
    loc.clearRect(0, 0, LW, LH);
    loc.globalAlpha = clamp01(now / 0.12); loc.drawImage(sky, 0, 0); loc.globalAlpha = 1;
    // horizon haze (quantised)
    const hz = clamp01((now - 0.06) / 0.1);
    for (let i = 0; i < 3; i++) { loc.fillStyle = css(C.sky[C.sky.length - 1], 1, 0.10 * hz); loc.fillRect(0, HORIZON - 22 + i * 7, LW, 7 - i * 2); }
    // clouds: pixel rect clusters, slow horizontal drift (integer steps keep them crisp)
    for (const cl of city.clouds) {
      const a = clamp01((now - cl.t0) / 0.06); if (a <= 0) continue;
      const drift = Math.round((tm / 1000) * cl.drift) % (LW + 60);
      loc.fillStyle = css(C.cloud[cl.band], 1, 0.55 * a);
      for (const r of cl.rects) { let x = Math.round(cl.cx + r.dx + drift) ; x = ((x + 30) % (LW + 60)) - 30; loc.fillRect(x, Math.round(cl.cy + r.dy), r.w, r.h); }
    }
    // distant skyline
    for (const d of city.distant) { if (now < d.t0) continue; loc.fillStyle = css(C.distant); loc.fillRect(d.x, HORIZON - d.h, 3, d.h); }

    // --- mid layer: back city, podium, tower, windows, spire ---
    midc.clearRect(0, 0, LW, LH);
    for (const b of city.back) { const ap = appear(b, now); if (!ap) continue; const x = Math.round(LW / 2 + b.x * U) + ap.dx, y = TOWER_BASE - (b.y + 1) * U + ap.dy; voxel(midc, x, y, C.back); if (b.win && ap.k > 0.6) { midc.fillStyle = css(C.backWin, 1, 0.8); midc.fillRect(x + 1, y + 1, 1, 1); } }
    for (const b of city.podium) { const ap = appear(b, now); if (!ap) continue; const x = Math.round(LW / 2 + b.x * U), y = HORIZON - (b.y + 1) * U + ap.dy; voxel(midc, x, y, C.podium); if (b.light && ap.k > 0.7) { midc.fillStyle = css(C.podiumLight); midc.fillRect(x + 1, y + U - 1, 1, 1); } }
    for (const b of city.blocks) {
      const ap = appear(b, now); if (!ap) continue;
      const { x, y } = blockPos(b); const col = b.mullion ? C.glassHi : C.glass[b.shade];
      if (ap.k < 1) fragments(midc, x, y, ap.k, col, b.seed);
      voxel(midc, x + ap.dx, y + ap.dy, col);
      // floor line every second row, reflective highlight on a few blocks
      if (b.y % 2 === 1) { midc.fillStyle = css(col, 0.78); midc.fillRect(x + ap.dx, y + ap.dy + U - 1, U, 1); }
      if (b.seed < 0.05 && ap.k >= 1) { midc.fillStyle = css(C.glassEdge, 1, 0.55); midc.fillRect(x, y, 1, 1); }
    }
    for (const w of city.windows) { if (!w.lit || now < w.t0) continue; const { x, y } = blockPos(w); const a = clamp01((now - w.t0) / 0.03); midc.fillStyle = css(C.win[w.color], 1, 0.92 * a); midc.fillRect(x + 1, y + 1, 1, 1); if (w.color === 1) midc.fillRect(x + 1, y + 1, 2, 1); }
    // spire: a needle assembled upward, then the tip
    const cx = LW / 2;
    for (const s of city.spire) { if (now < s.t0) continue; const k = clamp01((now - s.t0) / 0.03); midc.fillStyle = css(C.spire, 1, 0.5 + 0.5 * k); if (s.wide) midc.fillRect(cx - 1, s.y, 3, 1); else midc.fillRect(cx, s.y, 1, 1); }
    if (now >= 0.99) { const k = clamp01((now - 0.99) / 0.01); midc.fillStyle = css(C.spireTip, 1, k); midc.fillRect(cx, city.towerTop - SPIRE_PX - 1, 1, 1); midc.fillStyle = css(C.spireTip, 1, 0.35 * k); midc.fillRect(cx - 1, city.towerTop - SPIRE_PX - 2, 3, 3); }
    // final illumination: quantised rings around the upper tower, pulsing gently once alive
    if (now > 0.985) {
      const k = clamp01((now - 0.985) / 0.015) * (done ? 0.75 + 0.25 * Math.sin(tm / 1400) : 1);
      const gy = city.towerTop + 18;
      [[28, 0.03], [19, 0.05], [11, 0.09]].forEach(([r, a]) => { midc.fillStyle = css(C.win[1], 1, a * k); midc.beginPath(); midc.ellipse(cx, gy, r, r * 1.5, 0, 0, Math.PI * 2); midc.fill(); });
    }
    // living shimmer: a couple of glass blocks catch the light each frame
    if (done && detail !== 'lite') for (let i = 0; i < 3; i++) { const b = city.blocks[Math.floor(h2(Math.floor(tm / 90), i) * city.blocks.length)]; const { x, y } = blockPos(b); midc.fillStyle = css(C.glassEdge, 1, 0.3); midc.fillRect(x, y, 1, 1); }

    // --- front layer ---
    fgc.clearRect(0, 0, LW, LH);
    for (const b of city.front) { const ap = appear(b, now); if (!ap) continue; const x = Math.round(LW / 2 + b.x * U) + ap.dx, y = HORIZON - (b.y + 1) * U + ap.dy; voxel(fgc, x, y, C.front); if (b.win && ap.k > 0.6) { fgc.fillStyle = css(C.frontWin, 1, 0.9); fgc.fillRect(x + 1, y + 1, 1, 1); } }
    // haze particles, barely there
    if (done) for (const q of live.particles) { q.y -= q.v; if (q.y < 40) { q.y = 230; q.x = 60 + h1(tm + q.a) * 80; } fgc.fillStyle = css(C.win[1], 1, 0.18 + 0.1 * Math.sin(tm / 700 + q.a * 6)); fgc.fillRect(Math.round(q.x), Math.round(q.y), 1, 1); }

    // --- composite with parallax: bg slowest, mid, fg fastest ---
    const pxm = Math.round(cmx * 3), pym = Math.round(cmy * 1.5);
    loc.drawImage(mid, pxm, pym);
    // water: broken pixel reflection of what stands above the horizon
    const wa = clamp01((now - 0.3) / 0.2);
    if (wa > 0) {
      const depth = LH - HORIZON;
      for (let r = 0; r < depth; r++) {
        const srcY = HORIZON - 1 - r * 1.2; if (srcY < 0) break;
        const dx = Math.round(1.6 * Math.sin(r * 0.55 + tm / 900) + 0.8 * Math.sin(r * 1.7 - tm / 1300));
        loc.globalAlpha = wa * (0.42 - r / depth * 0.36);
        loc.drawImage(lo, 0, Math.round(srcY), LW, 1, dx, HORIZON + r, LW, 1);
      }
      loc.globalAlpha = 1;
      loc.fillStyle = css(C.water, 1, 0.35); loc.fillRect(0, HORIZON, LW, depth);
    }
    loc.drawImage(fg, Math.round(cmx * 6), Math.round(cmy * 2.5));

    // --- upscale, nearest neighbour ---
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(lo, Math.round(ox + cmx * 1.5), Math.round(oy), LW * scale, LH * scale);
  }

  function frame(tm) {
    if (started && seeked === null && p < 1) p = clamp01((tm - t0) / DUR);
    const now = seeked !== null ? seeked : p;
    cmx += (mx - cmx) * 0.06; cmy += (my - cmy) * 0.06;
    // living: a window flickers on/off now and then
    if (now >= 1 && tm > live.nextFlick) { const w = city.windows[Math.floor(h1(tm) * city.windows.length)]; w.lit = w.lit ? h1(tm * 1.3) > 0.18 : h1(tm * 1.7) < 0.45; live.nextFlick = tm + 700 + h1(tm) * 900; }
    drawScene(now, tm);
    if (reduce && now >= 1) { raf = 0; return; }   // static once complete
    raf = requestAnimationFrame(frame);
  }

  // ---- lifecycle ----
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting && !started) { started = true; t0 = performance.now() + 120; io.disconnect(); } }), { threshold: 0.25 });
  if (!reduce) io.observe(canvas);
  const onMove = (e) => { const r = canvas.getBoundingClientRect(); mx = clamp01((e.clientX - r.left) / r.width) * 2 - 1; my = clamp01((e.clientY - r.top) / r.height) * 2 - 1; };
  const onLeave = () => { mx = 0; my = 0; };
  const host = canvas.closest('[data-parallax-host]') || canvas;
  if (!coarse && !reduce) { host.addEventListener('mousemove', onMove); host.addEventListener('mouseleave', onLeave); }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  raf = requestAnimationFrame(frame);

  return {
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); host.removeEventListener('mousemove', onMove); host.removeEventListener('mouseleave', onLeave); },
    replay() { seeked = null; p = 0; started = true; t0 = performance.now(); if (!raf) raf = requestAnimationFrame(frame); },
    seek(v) { seeked = v === null ? null : clamp01(v); if (!raf) raf = requestAnimationFrame(frame); },
  };
}
