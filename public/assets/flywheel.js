/* ============================================================================
   The Vouch proof tower — a chunky isometric voxel stack, rendered on a 2D
   canvas. Zero dependencies.

   Every verified task drops a signed "receipt" brick down through a verification
   beam and locks it onto the agent's record; the tower rises on work that
   passed. A failed verdict flashes a brick red and crumbles it (a clawback).
   Each full cycle emits a gold settlement pulse. Drag to turn it.

   mountFlywheel(canvasEl, { accent, accentBright, core, base }) → controller
   (name kept for call-site compatibility.)
   ========================================================================== */
export function mountFlywheel(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const C = {
    brick: opts.accent || '#2f6b45',
    brightMix: opts.accentBright || '#3f9159',
    core: opts.core || '#cdeb4a',
    base: opts.base || '#20231c',
    burn: '#b23b2e',
    shadow: 'rgba(22,24,15,0.16)',
  };
  const FP = [];                       // 4x4 brick footprint (16 voxels)
  for (let x = -2; x <= 1; x++) for (let z = -2; z <= 1; z++) FP.push([x, z]);

  // ---- color helpers -------------------------------------------------------
  const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
  const shade = (rgb, m) => `rgb(${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * m)))).join(',')})`;
  const RGB = { brick: hex2rgb(C.brick), bright: hex2rgb(C.brightMix), core: hex2rgb(C.core), base: hex2rgb(C.base), burn: hex2rgb(C.burn) };

  // ---- static base slab ----------------------------------------------------
  const slab = [];
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) if (Math.hypot(x, z) <= 6.2) { slab.push([x, -2, z]); slab.push([x, -3, z]); }

  // ---- tower state ---------------------------------------------------------
  const MAX = 9, ADD_MS = 620;
  let courses = [];                    // {y, target, glow, born, slashing, fall, scatter, color}
  const mkCourse = (target) => ({ y: target + 2.6, target, glow: 1, slashing: false, fall: 0, scatter: FP.map(() => [(Math.random() - .5), (Math.random() - .5)]), });
  for (let i = 0; i < 3; i++) { const c = mkCourse(i); c.y = i; c.glow = 0; courses.push(c); }

  let lastAdd = 0, nextSlash = 2600, pulse = null; // pulse: {t0}
  let spin = (35 * Math.PI) / 180, spinVel = 0, autoVel = 0.14, dragging = false, lastX = 0;
  let W = 0, H = 0, DPR = 1, u = 16, cx = 0, cy = 0, beam = 0;

  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    u = Math.min(W, H) / 27;
    cx = W / 2; cy = H * 0.70;
  }

  function project(x, y, z, a) {
    const ca = Math.cos(a), sa = Math.sin(a);
    const rx = x * ca - z * sa, rz = x * sa + z * ca;
    const hw = u, hh = u * 0.5, vh = u * 0.82;
    return { sx: cx + (rx - rz) * hw, sy: cy + (rx + rz) * hh - y * vh, depth: (rx + rz) + y * 0.45, hw, hh, vh };
  }
  function cube(p, topC, leftC, rightC, outline) {
    const { sx, sy, hw, hh, vh } = p;
    ctx.fillStyle = leftC; ctx.beginPath(); ctx.moveTo(sx - hw, sy); ctx.lineTo(sx, sy + hh); ctx.lineTo(sx, sy + hh + vh); ctx.lineTo(sx - hw, sy + vh); ctx.closePath(); ctx.fill();
    ctx.fillStyle = rightC; ctx.beginPath(); ctx.moveTo(sx, sy + hh); ctx.lineTo(sx + hw, sy); ctx.lineTo(sx + hw, sy + vh); ctx.lineTo(sx, sy + hh + vh); ctx.closePath(); ctx.fill();
    ctx.fillStyle = topC; ctx.beginPath(); ctx.moveTo(sx, sy - hh); ctx.lineTo(sx + hw, sy); ctx.lineTo(sx, sy + hh); ctx.lineTo(sx - hw, sy); ctx.closePath(); ctx.fill();
    if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = 0.7; ctx.stroke(); }
  }

  function frame(t) {
    if (!dragging) spin += autoVel * 0.016 + spinVel * 0.016;
    spinVel *= 0.9;

    // grow: drop a new brick on top through the beam
    if (t - lastAdd > ADD_MS && courses.length < MAX && !courses.some((c) => c.slashing)) {
      courses.push(mkCourse(courses.length)); lastAdd = t;
    }
    // full tower → settlement pulse, then reset to base
    if (courses.length >= MAX && !pulse && courses.every((c) => Math.abs(c.y - c.target) < 0.05)) {
      pulse = { t0: t };
    }
    if (pulse && t - pulse.t0 > 900) { courses = [0, 1, 2].map((i) => { const c = mkCourse(i); c.y = i; c.glow = 0; return c; }); pulse = null; lastAdd = t; nextSlash = t + 2600; }

    // slash: flash a locked brick red, then crumble it
    if (t > nextSlash && !pulse && courses.length > 4 && !courses.some((c) => c.slashing)) {
      const i = 1 + Math.floor(Math.random() * (courses.length - 2));
      courses[i].slashing = true; courses[i].glow = 1;
      nextSlash = t + 5200 + Math.random() * 3200;
    }
    for (let i = courses.length - 1; i >= 0; i--) {
      const c = courses[i];
      if (c.slashing) { c.fall += 0.016; if (c.fall > 0.5) { courses.splice(i, 1); courses.forEach((cc, j) => { cc.target = j; }); } }
    }
    // ease y toward target; decay glow
    for (const c of courses) { c.y += (c.target - c.y) * 0.18; c.glow *= 0.93; }
    beam = 0.35 + 0.15 * Math.sin(t / 300);

    // ---- draw ----
    ctx.clearRect(0, 0, W, H);
    // ground shadow
    const sh = project(0, -3, 0, spin);
    ctx.save(); ctx.translate(sh.sx, sh.sy + u * 1.3); ctx.scale(1, 0.42);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, u * 7.5); g.addColorStop(0, C.shadow); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, u * 7.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();

    // settlement pulse ring on the slab
    if (pulse) {
      const k = (t - pulse.t0) / 900; const pc = project(0, -1, 0, spin);
      ctx.save(); ctx.translate(pc.sx, pc.sy); ctx.scale(1, 0.5);
      ctx.strokeStyle = `rgba(205,235,74,${0.5 * (1 - k)})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, u * (2 + k * 7), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
    }

    // collect all voxels (slab + brick courses) for one depth sort
    const items = [];
    for (const [x, y, z] of slab) items.push({ x, y, z, kind: 'base' });
    const topIdx = courses.length - 1;
    courses.forEach((c, ci) => {
      FP.forEach(([fx, fz], vi) => {
        let x = fx, z = fz;
        if (c.slashing) { x += c.scatter[vi][0] * c.fall * 6; z += c.scatter[vi][1] * c.fall * 6; }
        items.push({ x, y: c.y, z, kind: 'brick', c, ci, top: ci === topIdx, fade: c.slashing ? Math.max(0, 1 - c.fall * 2) : 1 });
      });
    });

    // verification beam above the frontier (where the next brick descends)
    const beamTop = project(-0.5, MAX + 3, -0.5, spin), beamBot = project(-0.5, courses.length, -0.5, spin);
    const bg = ctx.createLinearGradient(beamTop.sx, beamTop.sy, beamBot.sx, beamBot.sy);
    bg.addColorStop(0, 'rgba(205,235,74,0)'); bg.addColorStop(1, `rgba(205,235,74,${beam * 0.5})`);
    ctx.fillStyle = bg; ctx.fillRect(beamBot.sx - u * 1.6, beamTop.sy, u * 3.2, beamBot.sy - beamTop.sy);

    const drawn = items.map((it) => ({ it, p: project(it.x, it.y, it.z, spin) })).sort((a, b) => a.p.depth - b.p.depth);
    for (const { it, p } of drawn) {
      let base, mTop = 1.14, mLeft = 0.78, mRight = 0.6, outline = null;
      if (it.kind === 'base') { base = RGB.base; mTop = 1; mLeft = 0.72; mRight = 0.55; }
      else {
        // alternate course shade so the stack reads as discrete receipts
        base = it.ci % 2 ? mix(RGB.brick, RGB.bright, 0.5) : RGB.brick.slice();
        if (it.c.slashing) base = mix(RGB.burn, RGB.core, it.c.glow * 0.3);
        else if (it.c.glow > 0.02) base = mix(base, RGB.core, Math.min(0.85, it.c.glow)); // freshly verified → lime flash
        outline = shade(base, 1.3);
        if (it.fade < 1) ctx.globalAlpha = it.fade;
      }
      // glow halo for the live frontier / a flashing brick
      if (it.kind === 'brick' && it.top && !it.c.slashing) {
        ctx.save(); const gg = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, u * 3);
        gg.addColorStop(0, 'rgba(205,235,74,0.28)'); gg.addColorStop(1, 'rgba(205,235,74,0)');
        ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(p.sx, p.sy, u * 3, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      cube(p, shade(base, mTop), shade(base, mLeft), shade(base, mRight), outline);
      ctx.globalAlpha = 1;
    }
    raf = requestAnimationFrame(frame);
  }

  // ---- interaction ---------------------------------------------------------
  const onDown = (e) => { dragging = true; lastX = (e.touches ? e.touches[0].clientX : e.clientX); canvas.style.cursor = 'grabbing'; };
  const onMove = (e) => { if (!dragging) return; const x = (e.touches ? e.touches[0].clientX : e.clientX); const dx = x - lastX; lastX = x; spin += dx * 0.01; spinVel = dx * 0.4; if (e.cancelable) e.preventDefault(); };
  const onUp = () => { dragging = false; canvas.style.cursor = 'grab'; };
  canvas.style.cursor = 'grab';
  canvas.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: true }); canvas.addEventListener('touchmove', onMove, { passive: false }); window.addEventListener('touchend', onUp);

  let raf = 0;
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) autoVel = 0;
  raf = requestAnimationFrame(frame);
  return { destroy() { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('touchend', onUp); } };
}
