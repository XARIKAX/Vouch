// Solana in the browser, zero dependencies: wallet discovery through the
// Wallet Standard (Phantom, Solflare, Backpack and the rest register
// themselves), with Phantom's injected API as a fallback; signing a sign-in
// message; compiling, simulating, co-signing and sending instructions the
// server prepared; fresh mint keypairs through WebCrypto. Vouch never sees
// a private key: the wallet signs, and a mint key lives in this browser only.
import { compileMessage, serializeMessage, serializeTransaction, b58encode, b58decode } from '/assets/solmsg.js';

export const err = (code, message) => Object.assign(new Error(message), { code });
const CHAIN = 'solana:mainnet';
const WALLET_PREF = 'vouch_sol_wallet';
export const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64encode = (b) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };

// ---- wallets ---------------------------------------------------------------
let registry = null;
function discovered() {
  if (registry) return registry;
  const list = [];
  const api = { register(...ws) { for (const w of ws) if (w && !list.includes(w)) list.push(w); return () => {}; } };
  try {
    window.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail(api); } catch { /* not a wallet */ } });
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  } catch { /* no window */ }
  registry = list;
  return list;
}
const usable = (w) => w?.features?.['standard:connect'] && w.features['solana:signAndSendTransaction'] && w.features['solana:signMessage'] && (w.chains || []).some((c) => String(c).startsWith('solana:'));
export function availableWallets() { return discovered().filter(usable).map((w) => ({ name: w.name, icon: w.icon })); }
// Which wallet: the one the visitor chose before, else Phantom when it is
// installed, else the only one. With several installed and no choice made
// yet (or when asked to switch), a chooser is shown: MetaMask and others
// now announce themselves as Solana wallets too, and picking silently
// would open the wrong one.
async function pick({ preferred, choose } = {}) {
  const list = discovered().filter(usable);
  if (!list.length) return null;
  let pref = preferred; try { pref = pref || localStorage.getItem(WALLET_PREF); } catch { /* private mode */ }
  const stored = list.find((w) => w.name === pref);
  if (!choose && stored) return stored;
  const phantom = list.find((w) => /phantom/i.test(w.name));
  if (!choose && (list.length === 1 || phantom)) return phantom || list[0];
  return chooser(list);
}
function chooser(list) {
  return new Promise((resolve, reject) => {
    const host = document.createElement('div');
    host.setAttribute('style', 'position:fixed;inset:0;z-index:99999;background:rgba(10,10,20,.72);display:flex;align-items:center;justify-content:center;font-family:ui-monospace,Menlo,monospace');
    const box = document.createElement('div');
    box.setAttribute('style', 'background:#0f0f1a;color:#f2efe4;border:1px solid rgba(242,239,228,.25);padding:22px 22px 18px;min-width:280px;max-width:92vw;box-shadow:12px 12px 0 #5b4df0');
    box.innerHTML = '<div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:rgba(242,239,228,.6);margin-bottom:14px">Choose a Solana wallet</div>';
    for (const w of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('style', 'display:flex;align-items:center;gap:12px;width:100%;margin:0 0 8px;padding:12px 14px;background:transparent;color:#f2efe4;border:1px solid rgba(242,239,228,.35);font:inherit;font-size:14px;cursor:pointer;text-align:left');
      b.innerHTML = `${w.icon ? `<img src="${w.icon}" alt="" style="width:22px;height:22px;border-radius:4px">` : ''}<span>${String(w.name).replace(/[<>&]/g, '')}</span>`;
      b.onclick = () => { host.remove(); resolve(w); };
      box.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.setAttribute('style', 'margin-top:6px;background:transparent;color:rgba(242,239,228,.6);border:none;font:inherit;font-size:12px;cursor:pointer;letter-spacing:.1em;text-transform:uppercase');
    cancel.onclick = () => { host.remove(); reject(err('cancelled', 'No wallet chosen.')); };
    box.appendChild(cancel);
    host.appendChild(box);
    host.addEventListener('click', (e) => { if (e.target === host) cancel.onclick(); });
    document.body.appendChild(host);
  });
}
let current = null;   // { kind: 'standard', wallet, account } | { kind: 'phantom', provider, address }
const named = (name, e) => Object.assign(e instanceof Error ? e : new Error(String(e?.message || e)), { wallet: name, message: `${name}: ${e?.message || (e?.code === 4001 ? 'the request was rejected in the wallet' : 'the wallet refused')}` });

export async function connect({ preferred, choose } = {}) {
  const w = await pick({ preferred, choose });
  if (w) {
    let accounts;
    try { ({ accounts } = await w.features['standard:connect'].connect()); } catch (e) { throw named(w.name, e); }
    const account = (accounts || []).find((a) => (a.chains || []).some((c) => String(c).startsWith('solana:'))) || accounts?.[0];
    if (!account) throw err('no_account', `${w.name} returned no Solana account. Open the wallet and add or unlock a Solana account.`);
    current = { kind: 'standard', wallet: w, account };
    try { localStorage.setItem(WALLET_PREF, w.name); } catch { /* optional */ }
    return account.address;
  }
  const p = window.phantom?.solana || window.solana;
  if (p?.connect) {
    let r;
    try { r = await p.connect(); } catch (e) { throw named('Phantom', e); }
    const address = r?.publicKey?.toString?.() || p.publicKey?.toString?.();
    if (!address) throw err('no_account', 'Phantom returned no account.');
    current = { kind: 'phantom', provider: p, address };
    return address;
  }
  throw err('no_wallet', 'No Solana wallet found. Install Phantom, Solflare or Backpack and reload.');
}
export function forgetWalletChoice() { try { localStorage.removeItem(WALLET_PREF); } catch { /* optional */ } }
export const address = () => (current?.kind === 'standard' ? current.account.address : current?.address) || null;
export const walletName = () => (current?.kind === 'standard' ? current.wallet.name : current ? 'Phantom' : null);
const need = () => { if (!current) throw err('not_connected', 'Connect a wallet first.'); return current; };

// A signature over a UTF-8 message, base58, as the server verifies it.
export async function signMessage(text) {
  const c = need(); const bytes = new TextEncoder().encode(text);
  if (c.kind === 'standard') { const [out] = await c.wallet.features['solana:signMessage'].signMessage({ account: c.account, message: bytes }); return b58encode(out.signature); }
  const r = await c.provider.signMessage(bytes, 'utf8');
  return b58encode(r.signature instanceof Uint8Array ? r.signature : Uint8Array.from(r.signature));
}
// The wallet adds its signature to a serialized transaction and sends it. Returns the signature (base58).
export async function signAndSend(txBytes) {
  const c = need();
  if (c.kind === 'standard') {
    const [out] = await c.wallet.features['solana:signAndSendTransaction'].signAndSendTransaction({ account: c.account, transaction: txBytes, chain: CHAIN, options: { preflightCommitment: 'confirmed' } });
    return b58encode(out.signature);
  }
  const r = await c.provider.request({ method: 'signAndSendTransaction', params: { message: b58encode(txBytes) } });
  const sig = r?.signature ?? r; if (typeof sig !== 'string') throw err('bad_signature', 'The wallet returned no signature.');
  return sig;
}

// ---- RPC -----------------------------------------------------------------------
let n = 0;
export async function rpc(url, method, params = []) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }) });
  if (!res.ok) throw err('rpc', `RPC ${method} failed: ${res.status}`);
  const body = await res.json();
  if (body.error) throw err('rpc', `RPC ${method} failed: ${body.error.message || JSON.stringify(body.error)}`);
  return body.result;
}
export const toIx = (i) => ({ programId: i.program_id, keys: i.keys.map((k) => ({ pubkey: k.pubkey, isSigner: !!k.is_signer, isWritable: !!k.is_writable })), data: b64decode(i.data) });

// Compile a server-prepared intent with a fresh blockhash and co-sign it with
// any local keys (a mint). The wallet's slot stays empty for it to fill.
export async function buildTx(intent, { rpc: url, extraSigners = [] } = {}) {
  const { value } = await rpc(url, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const msg = compileMessage({ feePayer: intent.fee_payer, instructions: intent.instructions.map(toIx), recentBlockhash: value.blockhash });
  const bytes = serializeMessage(msg);
  const sigs = [];
  for (let i = 0; i < msg.header.numRequiredSignatures; i++) {
    const signer = extraSigners.find((s) => s.address === msg.accountKeys[i]);
    sigs.push(signer ? await signer.sign(bytes) : null);
  }
  return { bytes: serializeTransaction(bytes, sigs), message: msg, blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
}
// Dry-run before any signature is asked for; a failure surfaces here with the program logs.
export async function simulate(url, txBytes) {
  const out = await rpc(url, 'simulateTransaction', [b64encode(txBytes), { sigVerify: false, replaceRecentBlockhash: true, encoding: 'base64', commitment: 'confirmed' }]);
  const v = out?.value;
  if (v?.err) {
    const logs = (v.logs || []).filter((l) => /error|failed|insufficient/i.test(l)).slice(-3).join(' · ');
    throw err('would_revert', 'The transaction would fail: ' + (logs || JSON.stringify(v.err)) + '. Nothing was sent.');
  }
  return v;
}
// Wait until the cluster confirms a signature. Throws if it failed.
export async function confirmed(url, signature, { timeoutMs = 90000, every = 2000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const [s] = (await rpc(url, 'getSignatureStatuses', [[signature], { searchTransactionHistory: true }]))?.value ?? [];
    if (s?.err) throw err('tx_failed', 'The transaction failed on-chain: ' + JSON.stringify(s.err));
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return s;
    if (Date.now() - t0 > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}

// ---- mint keypairs ---------------------------------------------------------------
// A fresh mint for a launch, kept in this browser (keyed by agent id) so the
// launch can be signed later from the agent's page. Never sent to the server.
const MINT_STORE = (agentId) => `vouch_mint_${agentId}`;
const subtle = () => { const s = globalThis.crypto?.subtle; if (!s) throw err('no_crypto', 'This browser cannot generate keys (no WebCrypto).'); return s; };
async function wrap(privateKey, publicKey) {
  const raw = new Uint8Array(await subtle().exportKey('raw', publicKey));
  return { address: b58encode(raw), sign: async (msg) => new Uint8Array(await subtle().sign({ name: 'Ed25519' }, privateKey, msg)), privateKey, publicKey };
}
export async function newMint() {
  let kp;
  try { kp = await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']); }
  catch { throw err('no_ed25519', 'This browser cannot create Ed25519 keys. Use a current Chrome, Safari or Firefox.'); }
  return wrap(kp.privateKey, kp.publicKey);
}
export async function storeMint(agentId, mint) {
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', mint.privateKey));
  try { localStorage.setItem(MINT_STORE(agentId), JSON.stringify({ address: mint.address, pkcs8: b64encode(pkcs8) })); } catch { /* private mode: the launch must finish now */ }
}
export async function storedMint(agentId) {
  let raw; try { raw = localStorage.getItem(MINT_STORE(agentId)); } catch { raw = null; }
  if (!raw) return null;
  const { address, pkcs8 } = JSON.parse(raw);
  const privateKey = await subtle().importKey('pkcs8', b64decode(pkcs8), { name: 'Ed25519' }, true, ['sign']);
  const jwk = await subtle().exportKey('jwk', privateKey); delete jwk.d; jwk.key_ops = ['verify'];
  const publicKey = await subtle().importKey('jwk', jwk, { name: 'Ed25519' }, true, ['verify']);
  const m = await wrap(privateKey, publicKey);
  if (m.address !== address) return null;
  return m;
}
export function forgetMint(agentId) { try { localStorage.removeItem(MINT_STORE(agentId)); } catch { /* optional */ } }
export { b58encode, b58decode };
