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
  el.innerHTML = '<span class="pct">00%</span><div class="prail-track"><i class="prail-mark"></i></div><span>VCH</span>';
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
    // respect hand-numbered eyebrows ("01 / …" or an existing .n)
    if (e.querySelector('.n') || /^\s*\d{2}\b/.test(e.textContent)) { e.dataset.numbered = '1'; return; }
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

// ---------------------------------------------------------------------------
// Shared sandbox API helper. One real key per browser, kept in localStorage
// under `vouch_key`; every page talks to the same backend with it.
// ---------------------------------------------------------------------------
export const KEY_STORE = 'vouch_key';
export function getKey() { try { return localStorage.getItem(KEY_STORE) || null; } catch { return null; } }
export function setKey(k) { try { if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE); } catch {} }

// api(path, { method, body, key }) → parsed JSON. Throws an Error with
// .status, .code and .detail on any non-2xx so pages can show the real reason.
export async function api(path, { method = 'GET', body, key = getKey(), headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    const e = new Error(json?.error?.message || `${res.status} ${res.statusText}`);
    e.status = res.status; e.code = json?.error?.code || 'http_error'; e.detail = json?.error ?? null; e.body = json;
    throw e;
  }
  return json;
}

// Mint a sandbox key once and remember it. Re-mints if the stored key is rejected.
export async function ensureKey(name = 'sandbox') {
  const have = getKey();
  if (have) {
    try { await api('/v1/balance', { key: have }); return have; } catch (e) { if (e.status !== 401) return have; setKey(null); }
  }
  const made = await api('/v1/keys', { method: 'POST', body: { name }, key: null });
  setKey(made.key);
  return made.key;
}

// ---------------------------------------------------------------------------
// Wallet sign-in and real funds. The wallet signs a one-time message (no
// transaction, no cost); the server mints or recovers the wallet's account and
// the key is kept like any other. Deposits are a USDG transfer the wallet
// sends to the treasury, confirmed by its receipt.
// ---------------------------------------------------------------------------
export const WALLET_STORE = 'vouch_wallet';
export function getWallet() { try { return localStorage.getItem(WALLET_STORE) || null; } catch { return null; } }
const walletProvider = () => { const p = window.ethereum; if (!p?.request) throw Object.assign(new Error('No wallet found. Install a browser wallet (MetaMask, Rabby, Coinbase Wallet) and reload.'), { code: 'no_wallet' }); return p; };
export async function signInWithWallet() {
  const p = walletProvider();
  const [address] = await p.request({ method: 'eth_requestAccounts' });
  if (!address) throw new Error('The wallet returned no account.');
  const { message } = await api('/v1/auth/nonce', { method: 'POST', body: { address }, key: null });
  const signature = await p.request({ method: 'personal_sign', params: [message, address] });
  const out = await api('/v1/auth/verify', { method: 'POST', body: { address, signature }, key: null });
  setKey(out.key);
  try { localStorage.setItem(WALLET_STORE, out.wallet); } catch {}
  return out;
}
// Send `amount` USDG from the signed-in wallet to the treasury, then confirm
// it with the server until the receipt is in. Resolves with the credit.
export async function depositUsdg(amount, { onStep = () => {} } = {}) {
  const p = walletProvider();
  const funds = await api('/v1/funds', { key: null });
  if (!funds.enabled) throw Object.assign(new Error('This deployment runs on sandbox credits; real deposits are off.'), { code: 'sandbox_mode' });
  const [from] = await p.request({ method: 'eth_requestAccounts' });
  const want = funds.chain_id_hex, have = await p.request({ method: 'eth_chainId' });
  if (String(have).toLowerCase() !== want.toLowerCase()) {
    try { await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }); }
    catch (e) { if (e?.code === 4902) await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId: want, chainName: funds.network, rpcUrls: [funds.rpc], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: [funds.explorer] }] }); else throw e; }
  }
  const units = BigInt(Math.round(Number(amount) * 10 ** funds.token.decimals));
  const data = funds.transfer_selector + funds.treasury.slice(2).toLowerCase().padStart(64, '0') + units.toString(16).padStart(64, '0');
  onStep('Confirm the transfer in your wallet');
  const tx_hash = await p.request({ method: 'eth_sendTransaction', params: [{ from, to: funds.token.address, data }] });
  onStep('Sent. Waiting for the chain');
  const t0 = Date.now();
  for (;;) {
    const out = await api('/v1/escrow/deposits/confirm', { method: 'POST', body: { tx_hash } });
    if (!out.pending) return { ...out, tx_hash, explorer: `${funds.explorer}/tx/${tx_hash}` };
    if (Date.now() - t0 > 240000) throw Object.assign(new Error(`Still pending. Confirm later with transaction ${tx_hash}.`), { code: 'still_pending', tx_hash });
    await new Promise((r) => setTimeout(r, 4000));
  }
}

// Poll a task until it reaches a terminal state (settled / refunded) or the timeout.
// A just-created task can take a moment to become visible to other serverless
// instances, so a 404 inside the first `graceMs` is treated as "not yet", not
// as an error.
export async function waitTask(id, { key = getKey(), timeoutMs = 60000, every = 400, graceMs = 12000, onUpdate } = {}) {
  const t0 = Date.now();
  for (;;) {
    let t;
    try { t = await api(`/v1/tasks/${id}`, { key }); }
    catch (e) {
      if (e.status === 404 && Date.now() - t0 < graceMs) { await new Promise((r) => setTimeout(r, every)); continue; }
      throw e;
    }
    onUpdate?.(t);
    if (t.status === 'settled' || t.status === 'refunded') return t;
    if (Date.now() - t0 > timeoutMs) return t;
    await new Promise((r) => setTimeout(r, every));
  }
}
