/* Shared site behaviour: scroll reveal, live ticker/stat hydration, count-up. */
export function revealOn() {
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.12 });
  document.querySelectorAll('.rv').forEach((el) => io.observe(el));
}

export const fmtUsd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();
export const fmtNum = (n) => Math.round(Number(n) || 0).toLocaleString();

// Animate a number element from 0 to its data-count target when it scrolls in.
export function countUp(el, target, { prefix = '', dur = 1100 } = {}) {
  const t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = prefix + Math.round(target * e).toLocaleString();
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// The proof tower. Mounts every [data-proof-tower] figure: triggers the build-up
// when it scrolls into view, then (fine pointers only) tilts the object a few
// degrees toward the cursor with the receipt layer and glow offset for depth.
// All transforms are GPU-friendly; the rAF loop sleeps once settled.
export function mountProofTower(fig) {
  const stage = fig.querySelector('.pt-stage');
  const obj = fig.querySelector('.pt-obj');
  const receipt = fig.querySelector('.pt-receipt');
  const glow = fig.querySelector('.pt-glow');
  if (!stage || !obj) return;

  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { fig.classList.add('in'); io.disconnect(); }
  }), { threshold: 0.35 });
  io.observe(stage);

  const fine = window.matchMedia('(pointer:fine)').matches;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!fine || still) return;

  let tx = 0, ty = 0, cx = 0, cy = 0, raf = 0, active = false;
  const MAX_Y = 4.5, MAX_X = 3.2;  // degrees — subtle, physical
  const tick = () => {
    cx += (tx - cx) * 0.085; cy += (ty - cy) * 0.085;
    obj.style.transform = `rotateX(${(-cy * MAX_X).toFixed(3)}deg) rotateY(${(cx * MAX_Y).toFixed(3)}deg)`;
    if (receipt) receipt.style.setProperty('--px', `${(cx * 9).toFixed(2)}px`);
    if (receipt) receipt.style.setProperty('--py', `${(cy * 5).toFixed(2)}px`);
    if (glow) glow.style.transform = `translate3d(${(-cx * 10).toFixed(2)}px,${(-cy * 6).toFixed(2)}px,0)`;
    const settled = Math.abs(tx - cx) < 0.002 && Math.abs(ty - cy) < 0.002;
    if (settled && !active) { raf = 0; return; }
    raf = requestAnimationFrame(tick);
  };
  const wake = () => { if (!raf) raf = requestAnimationFrame(tick); };
  const onMove = (e) => {
    const r = stage.getBoundingClientRect();
    tx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width - 0.5) * 2));
    ty = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height - 0.5) * 2));
    active = true; wake();
  };
  const onLeave = () => { tx = 0; ty = 0; active = false; wake(); };
  fig.addEventListener('mousemove', onMove);
  fig.addEventListener('mouseleave', onLeave);
}
export function initProofTowers() { document.querySelectorAll('[data-proof-tower]').forEach(mountProofTower); }

// Best-effort live hydration. Every call is wrapped so a blocked backend
// (sandbox) leaves the page's static fallbacks in place.
export async function hydrate(handlers = {}) {
  const get = async (p) => { const r = await fetch(p); if (!r.ok) throw 0; return r.json(); };
  await Promise.allSettled([
    handlers.providers && get('/v1/providers').then((j) => handlers.providers(j.providers || [])),
    handlers.capabilities && get('/v1/capabilities').then((j) => handlers.capabilities(j.capabilities || [])),
    handlers.insurance && get('/v1/insurance').then((j) => handlers.insurance(j)),
    handlers.agents && get('/v1/agents').then((j) => handlers.agents(j.agents || [])),
  ].filter(Boolean));
}
