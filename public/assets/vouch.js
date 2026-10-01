/* Shared site behaviour: scroll reveal, marquee ticker, scroll-progress rail,
   section numbering, live hydration, count-up. Self-initialises once on load;
   the named exports remain available for pages that want them directly. */
export function revealOn() {
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: 0.12 });
  document.querySelectorAll('.rv').forEach((el) => io.observe(el));
}

// The ticker becomes a seamless marquee: its items are wrapped in a track that
// is duplicated once and translated by half its width.
export function initTicker() {
  document.querySelectorAll('.ticker').forEach((t) => {
    const wrap = t.querySelector('.wrap'); if (!wrap || wrap.querySelector('.tk-track')) return;
    const track = document.createElement('div'); track.className = 'tk-track';
    while (wrap.firstChild) track.appendChild(wrap.firstChild);
    const clone = track.cloneNode(true); clone.setAttribute('aria-hidden', 'true');
    track.append(...clone.childNodes);
    wrap.appendChild(track);
    const len = track.scrollWidth / 2;
    t.style.setProperty('--tk-dur', Math.max(24, Math.round(len / 36)) + 's');
    t.classList.add('tk-run');
  });
}

// A thin vertical rail at the right edge showing scroll depth, like a reading position.
export function initProgressRail() {
  if (document.querySelector('.prail')) return;
  const el = document.createElement('div'); el.className = 'prail'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<span class="pct">00%</span><div class="bar"><i></i></div><span>VCH</span>';
  document.body.appendChild(el);
  const pct = el.querySelector('.pct'), i = el.querySelector('i');
  const upd = () => { const d = document.documentElement; const k = Math.max(0, Math.min(1, d.scrollTop / Math.max(1, d.scrollHeight - d.clientHeight))); pct.textContent = String(Math.round(k * 100)).padStart(2, '0') + '%'; i.style.top = (k * 96) + 'px'; };
  window.addEventListener('scroll', upd, { passive: true }); upd();
}

// Number each section's leading eyebrow: "01 / why vouch".
export function numberSections() {
  let n = 0;
  document.querySelectorAll('section').forEach((s) => {
    const e = s.querySelector(':scope .eyebrow, :scope .sec-head .eyebrow'); if (!e || e.dataset.numbered) return;
    n++; e.dataset.numbered = '1';
    const num = document.createElement('span'); num.className = 'n'; num.textContent = String(n).padStart(2, '0') + ' /';
    e.prepend(num);
  });
}

export const fmtUsd = (n) => '$' + Math.round(Number(n) || 0).toLocaleString();
export const fmtNum = (n) => Math.round(Number(n) || 0).toLocaleString();

export function countUp(el, target, { prefix = '', dur = 1100 } = {}) {
  const t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
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

// self-init (idempotent)
if (typeof window !== 'undefined' && !window.__vouchInit) {
  window.__vouchInit = true;
  const go = () => { revealOn(); initTicker(); initProgressRail(); numberSections(); };
  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', go) : go();
}
