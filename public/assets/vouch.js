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
