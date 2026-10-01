/* ============================================================================
   The Vouch flywheel — a chunky isometric voxel wheel, rendered on a 2D canvas.
   Zero dependencies. It spins, it grows (the core ratchets up as verified work
   compounds, then releases), and you can drag to turn it. One slash burns a
   voxel red now and then, and it heals.

   mountFlywheel(canvasEl, { accent, accentBright, core, ink }) → controller
   ========================================================================== */
export function mountFlywheel(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const C = {
    ring: opts.accent || '#2f6b45',
    node: opts.accentBright || '#3f9159',
    core: opts.core || '#cdeb4a',
    base: opts.base || '#20231c',
    burn: '#b23b2e',
    shadow: 'rgba(22,24,15,0.16)',
  };

  // ---- geometry ------------------------------------------------------------
  const RAD = (d) => (d * Math.PI) / 180;
  const ANGLES = [0, 60, 120, 180, 240, 300].map(RAD); // the six stages
  const key = (x, y, z) => `${x},${y},${z}`;

  // Static voxels, built once. Each: {x,y,z, kind}
  const vox = [];
  const seen = new Set();
  const add = (x, y, z, kind) => { const k = key(x, y, z); if (seen.has(k)) return; seen.add(k); vox.push({ x, y, z, kind }); };

  // dark base slab (the ledger the wheel rests on)
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) {
    if (Math.hypot(x, z) <= 6.2) add(x, -2, z, 'base');
  }
  // the wheel: a two-thick annulus
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) {
    const d = Math.hypot(x, z);
    if (d >= 3.1 && d <= 4.9) { add(x, 0, z, 'ring'); add(x, -1, z, 'ring'); }
  }
  // six spokes from hub to rim
  for (const a of ANGLES) {
    for (let r = 1.6; r <= 4.4; r += 0.4) {
      add(Math.round(Math.cos(a) * r), 0, Math.round(Math.sin(a) * r), 'spoke');
    }
  }
  // six node pillars on the rim (the stages)
  ANGLES.forEach((a, i) => {
    const nx = Math.round(Math.cos(a) * 4.2), nz = Math.round(Math.sin(a) * 4.2);
    for (let y = 0; y <= 2; y++) add(nx, y + 1, nz, i === 0 ? 'node0' : 'node');
  });

  // ---- color helpers -------------------------------------------------------
  const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const shade = (rgb, m) => `rgb(${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * m)))).join(',')})`;
  const RGB = { ring: hex2rgb(C.ring), node: hex2rgb(C.node), core: hex2rgb(C.core), base: hex2rgb(C.base), burn: hex2rgb(C.burn) };

  // ---- state ---------------------------------------------------------------
  let spin = RAD(35), spinVel = 0, dragging = false, lastX = 0, autoVel = 0.16;
  let burn = null; // {x,z, until}
  let nextBurn = performance.now() + 4200;
  let W = 0, H = 0, DPR = 1, u = 16, cx = 0, cy = 0;

  function resize() {
    const r = canvas.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    u = Math.min(W, H) / 24;      // voxel unit
    cx = W / 2; cy = H * 0.58;
  }

  // project a voxel center to screen
  function project(x, y, z, a) {
    const ca = Math.cos(a), sa = Math.sin(a);
    const rx = x * ca - z * sa, rz = x * sa + z * ca;
    const hw = u, hh = u * 0.5, vh = u * 0.82;
    return {
      sx: cx + (rx - rz) * hw,
      sy: cy + (rx + rz) * hh - y * vh,
      depth: (rx + rz) + y * 0.4,
      rx, rz, hw, hh, vh,
    };
  }

  function cube(p, topC, leftC, rightC) {
    const { sx, sy, hw, hh, vh } = p;
    // left face
    ctx.fillStyle = leftC;
    ctx.beginPath(); ctx.moveTo(sx - hw, sy); ctx.lineTo(sx, sy + hh); ctx.lineTo(sx, sy + hh + vh); ctx.lineTo(sx - hw, sy + vh); ctx.closePath(); ctx.fill();
    // right face
    ctx.fillStyle = rightC;
    ctx.beginPath(); ctx.moveTo(sx, sy + hh); ctx.lineTo(sx + hw, sy); ctx.lineTo(sx + hw, sy + vh); ctx.lineTo(sx, sy + hh + vh); ctx.closePath(); ctx.fill();
    // top face
    ctx.fillStyle = topC;
    ctx.beginPath(); ctx.moveTo(sx, sy - hh); ctx.lineTo(sx + hw, sy); ctx.lineTo(sx, sy + hh); ctx.lineTo(sx - hw, sy); ctx.closePath(); ctx.fill();
  }

  function frame(t) {
    // spin
    if (!dragging) spin += autoVel * 0.016 + spinVel * 0.016;
    spinVel *= 0.92;

    // growth: core ratchets 1→6 then releases
    const cycle = 7200, step = cycle / 6;
    const phase = (t % cycle);
    const coreH = 1 + Math.floor(phase / step);
    const popY = Math.floor(phase / step);           // newest voxel index
    const popScale = 1 - Math.min(1, (phase % step) / 220); // quick pop on appear

    // slash burn scheduling
    if (t > nextBurn && !burn) {
      const rim = vox.filter((v) => v.kind === 'ring' && v.y === 0);
      const pick = rim[Math.floor(Math.random() * rim.length)];
      if (pick) burn = { x: pick.x, z: pick.z, until: t + 620 };
      nextBurn = t + 5200 + Math.random() * 3000;
    }
    if (burn && t > burn.until) burn = null;

    // assemble this frame's voxels (static + dynamic core)
    const frameVox = vox.slice();
    for (let y = 0; y < coreH; y++) frameVox.push({ x: 0, y: y + 1, z: 0, kind: 'core', pop: y === popY ? popScale : 0 });
    // the glowing token cap
    frameVox.push({ x: 0, y: coreH + 1, z: 0, kind: 'cap', pop: popScale });

    const drawn = frameVox.map((v) => ({ v, p: project(v.x, v.y, v.z, spin) })).sort((a, b) => a.p.depth - b.p.depth);

    ctx.clearRect(0, 0, W, H);

    // ground shadow
    const sh = project(0, -2, 0, spin);
    ctx.save();
    ctx.translate(sh.sx, sh.sy + u * 1.2);
    ctx.scale(1, 0.42);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, u * 7);
    g.addColorStop(0, C.shadow); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, u * 7, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // highlight angle that travels the rim as it spins (a moving sheen)
    for (const { v, p } of drawn) {
      let base, top, mTop = 1, mLeft = 0.72, mRight = 0.55;
      if (v.kind === 'base') { base = RGB.base; }
      else if (v.kind === 'core' || v.kind === 'cap') {
        base = RGB.core;
        // glow halo behind the token cap
        if (v.kind === 'cap') {
          ctx.save();
          const gg = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, u * 3.4);
          gg.addColorStop(0, 'rgba(205,235,74,0.5)'); gg.addColorStop(1, 'rgba(205,235,74,0)');
          ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(p.sx, p.sy, u * 3.4, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }
      else if (v.kind === 'node0' || v.kind === 'node') { base = RGB.node; }
      else if (v.kind === 'spoke') { base = RGB.ring; mTop = 0.92; }
      else { base = RGB.ring; }

      // burnt voxel
      if (burn && v.kind === 'ring' && v.x === burn.x && v.z === burn.z) base = RGB.burn;

      // spinning sheen: brighten voxels whose rotated angle faces the light
      const ang = Math.atan2(p.rz, p.rx);
      const sheen = 0.5 + 0.5 * Math.cos(ang - RAD(-40));
      const lift = v.kind === 'ring' ? 0.12 * sheen : 0;

      // pop animation (newest core voxel scales in)
      if (v.pop) { mTop += 0.25 * v.pop; }

      cube(p, shade(base, (mTop + lift)), shade(base, mLeft), shade(base, mRight));

      // thin top outline on rim for crispness
      if (v.kind === 'ring' && v.y === 0) {
        ctx.strokeStyle = shade(base, 1.25 + lift); ctx.lineWidth = 0.6;
        ctx.beginPath(); ctx.moveTo(p.sx, p.sy - p.hh); ctx.lineTo(p.sx + p.hw, p.sy); ctx.lineTo(p.sx, p.sy + p.hh); ctx.lineTo(p.sx - p.hw, p.sy); ctx.closePath(); ctx.stroke();
      }
    }
    raf = requestAnimationFrame(frame);
  }

  // ---- interaction ---------------------------------------------------------
  const onDown = (e) => { dragging = true; lastX = (e.touches ? e.touches[0].clientX : e.clientX); canvas.style.cursor = 'grabbing'; };
  const onMove = (e) => {
    if (!dragging) return;
    const x = (e.touches ? e.touches[0].clientX : e.clientX);
    const dx = x - lastX; lastX = x; spin += dx * 0.01; spinVel = dx * 0.4;
    if (e.cancelable) e.preventDefault();
  };
  const onUp = () => { dragging = false; canvas.style.cursor = 'grab'; };
  canvas.style.cursor = 'grab';
  canvas.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: true }); canvas.addEventListener('touchmove', onMove, { passive: false }); window.addEventListener('touchend', onUp);

  let raf = 0;
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  resize();
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { autoVel = 0; }
  raf = requestAnimationFrame(frame);

  return { destroy() { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('touchend', onUp); } };
}
