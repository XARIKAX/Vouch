import { stateReplacer } from './store.js';
import { createRedisClient } from './redis-client.js';

// Upstash Redis (REST API) persistence for serverless deployments, where the
// filesystem is read-only/ephemeral. Zero dependencies — plain fetch against
// the REST endpoint. The whole state graph is one JSON value under one key,
// matching the file store's snapshot model.
//
// Concurrency: two invocations can load the same snapshot and both flush.
// Each flush is a compare-and-set on a version counter (one Lua EVAL, atomic
// on the server). On a conflict the store re-loads the newer snapshot, merges
// this invocation's records on top (record-level: ours win where both have
// the same id, theirs are kept where we have none) and retries, a few times.
//
// Reads env vars from either the Upstash integration or the Vercel KV names:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   KV_REST_API_URL        / KV_REST_API_TOKEN
// Returns null when neither pair is configured. The same snapshot + CAS
// logic also runs over a plain Redis connection (REDIS_URL, as Vercel's own
// Redis integration and Redis Cloud provide) via createRedisStore(); pick
// whichever is configured with createRemoteStore().

const COLLECTIONS = ['keys', 'accounts', 'providers', 'tasks', 'disputes', 'workflows', 'agents', 'cache'];
// How many times a flush re-loads, merges and retries after a lost compare-and-set.
const CAS_ATTEMPTS = 4;

// KEYS[1] = state key, KEYS[2] = version key.
// ARGV[1] = version we loaded, ARGV[2] = snapshot, ARGV[3] = next version.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[2])
if (cur == false and ARGV[1] == '0') or cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('SET', KEYS[2], ARGV[3])
  return 1
end
return 0`.trim();

// Merge `remote` (a newer snapshot) into `local` (this invocation's live
// state) in place.
//
// With `base` (the snapshot this invocation loaded) the merge is three-way:
//   - money and counters (account balances, locked escrow, provider stake and
//     earnings, the insurance and treasury pools) are merged by DELTA: what
//     this invocation moved is applied on top of what the other invocation
//     wrote, so two tasks locking escrow on the same account at the same time
//     both keep their lock, and nothing is applied twice;
//   - ledgers (account history, insurance claims, pending slashes) union by id;
//   - records (tasks, keys, disputes, ...) take the local copy only where this
//     invocation changed it; an untouched copy never reverts another
//     invocation's write. A task that the other side already finished stays
//     finished (the first terminal state wins).
// Without `base` (a fresh store with nothing loaded) collections union by id
// with local winning, and pools stay local.
const money = (n) => Math.round(n * 1e6) / 1e6;
const same = (a, b) => JSON.stringify(a ?? null, stateReplacer) === JSON.stringify(b ?? null, stateReplacer);
const TERMINAL = new Set(['settled', 'refunded']);
const DELTA_FIELDS = {
  accounts: ['balance', 'locked', 'lockedToday'],
  providers: ['stake', 'stakeReserved', 'earnings', 'track', 'settledCount', 'slashedCount'],
};
const NON_NEGATIVE = new Set(['locked', 'lockedToday', 'stakeReserved', 'balance', 'stake']);
const LEDGERS = { accounts: [['history', (e) => e.tx ?? `${e.ts}:${e.kind}:${e.amount}`]] };

function unionList(local = [], remote = [], keyOf) {
  const seen = new Set(local.map(keyOf));
  const out = local.slice();
  for (const e of remote) { const k = keyOf(e); if (!seen.has(k)) { seen.add(k); out.push(e); } }
  out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return out;
}

function mergeDeltaRecord(loc, rem, bas, fields, ledgers = []) {
  if (!bas) return loc;                                   // new here: ours as is
  const out = { ...rem };
  for (const f of fields) {
    if (typeof loc[f] !== 'number') continue;
    const delta = loc[f] - (typeof bas[f] === 'number' ? bas[f] : 0);
    let v = money((typeof rem[f] === 'number' ? rem[f] : 0) + delta);
    if (NON_NEGATIVE.has(f) && v < 0) v = 0;
    if (f === 'track') v = Math.min(100, Math.max(0, v));
    out[f] = v;
  }
  for (const [f, keyOf] of ledgers) out[f] = unionList(loc[f], rem[f], keyOf);
  // anything else: ours where we changed it, theirs otherwise
  for (const k of Object.keys(loc)) {
    if (fields.includes(k) || ledgers.some(([f]) => f === k)) continue;
    if (!same(loc[k], bas[k])) out[k] = loc[k];
    else if (!(k in rem)) out[k] = loc[k];
  }
  return out;
}

export function mergeStates(local, remote, base = null) {
  if (!remote || typeof remote !== 'object') return local;
  for (const c of COLLECTIONS) {
    if (!remote[c] || typeof remote[c] !== 'object') continue;
    local[c] ??= {};
    const ids = new Set([...Object.keys(local[c]), ...Object.keys(remote[c])]);
    for (const id of ids) {
      const loc = local[c][id], rem = remote[c][id], bas = base?.[c]?.[id];
      if (loc === undefined) { local[c][id] = rem; continue; }
      if (rem === undefined) continue;                     // ours only
      if (!base) continue;                                 // two-way: local wins
      if (DELTA_FIELDS[c]) { local[c][id] = mergeDeltaRecord(loc, rem, bas, DELTA_FIELDS[c], LEDGERS[c]); continue; }
      const changedHere = !same(loc, bas);
      if (!changedHere) { local[c][id] = rem; continue; }
      if (c === 'tasks' && TERMINAL.has(rem.status) && !TERMINAL.has(bas?.status)) local[c][id] = rem; // finished elsewhere first
      // otherwise ours
    }
  }
  if (base) {
    for (const pool of ['insurance', 'treasury']) {
      if (!remote[pool] || !local[pool]) continue;
      const fields = pool === 'insurance' ? ['balance', 'funded'] : ['balance', 'burned', 'buyback'];
      const merged = mergeDeltaRecord(local[pool], remote[pool], base[pool] ?? {}, fields,
        pool === 'insurance' ? [['claims', (e) => `${e.ts}:${e.task}:${e.amount}`]] : []);
      Object.assign(local[pool], merged);
    }
    if (remote.launchpad?.pending_slashes && local.launchpad) {
      local.launchpad.pending_slashes = unionList(local.launchpad.pending_slashes, remote.launchpad.pending_slashes, (s) => s.id ?? `${s.queued_at}:${s.agent_id}`);
    }
    if (remote.attest?.public_keys && local.attest) {
      local.attest.public_keys = { ...remote.attest.public_keys, ...(local.attest.public_keys ?? {}) };
    }
  }
  for (const k of Object.keys(remote)) {
    if (!(k in local) && k !== 'version') local[k] = remote[k];
  }
  return local;
}

export function createUpstashStore(opts = {}) {
  const url = (opts.url ?? process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? '').replace(/\/$/, '');
  const token = opts.token ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  const key = opts.key ?? process.env.VOUCH_STATE_KEY ?? 'vouch:state';
  if (!url || !token) return null;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  // One Redis command over REST: POST ["CMD", arg, ...] to the root.
  const command = async (args, what) => {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(args) });
    if (!res.ok) throw new Error(`state store ${what} failed: ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`state store ${what} failed: ${body.error}`);
    return body.result;
  };
  return snapshotStore({ command, key, path: `${url} (${key})` });
}

// Plain Redis (RESP over TCP/TLS) using the same snapshot + compare-and-set
// logic. Configured by REDIS_URL (Vercel Redis integration, Redis Cloud, any
// Redis 6+). Returns null when REDIS_URL is unset.
export function createRedisStore(opts = {}) {
  const url = opts.url ?? process.env.REDIS_URL ?? process.env.KV_URL;
  const key = opts.key ?? process.env.VOUCH_STATE_KEY ?? 'vouch:state';
  if (!url) return null;
  const client = opts.client ?? createRedisClient(url, { timeoutMs: opts.timeoutMs ?? 5000 });
  const command = async (args, what) => {
    try { return await client.command(args); }
    catch (e) { throw new Error(`state store ${what} failed: ${e.message}`); }
  };
  const store = snapshotStore({ command, key, path: `${url.replace(/\/\/.*@/, '//***@')} (${key})` });
  store.close = () => client.close();
  return store;
}

// Whichever remote store the environment configures: Upstash REST first,
// then a plain REDIS_URL. Null means in-memory (demo) mode.
export function createRemoteStore(opts = {}) {
  return createUpstashStore(opts) ?? createRedisStore(opts);
}

function snapshotStore({ command, key, path }) {
  const versionKey = `${key}:version`;
  let dirty = null;        // latest state reference awaiting flush
  let loadedVersion = 0;   // version of the snapshot this invocation started from
  let base = null;         // untouched copy of what was loaded, for the three-way merge

  const load = async () => {
    const [raw, ver] = await Promise.all([command(['GET', key], 'read'), command(['GET', versionKey], 'read')]);
    loadedVersion = ver == null ? 0 : Number(ver) || 0;
    if (raw == null) { base = null; return null; }
    const state = JSON.parse(raw);
    base = JSON.parse(raw);
    if (typeof state.version === 'number' && !ver) loadedVersion = state.version;
    return state;
  };

  // save() is called synchronously from the engine after every mutation;
  // the actual network write happens once, in flush(), before the serverless
  // invocation returns.
  const save = (state) => { dirty = state; };

  const flush = async () => {
    if (!dirty) return null;
    const state = dirty;
    dirty = null;
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const next = loadedVersion + 1;
      state.version = next;
      const snapshot = JSON.stringify(state, stateReplacer);
      const ok = await command(['EVAL', CAS_SCRIPT, '2', key, versionKey, String(loadedVersion), snapshot, String(next)], 'write');
      if (Number(ok) === 1) {
        loadedVersion = next;
        return { version: next, merged: attempt > 0 };
      }
      // Conflict: another invocation flushed since we loaded. Re-load, merge
      // our changes on top of the newer snapshot (three-way, against the
      // snapshot we started from), and retry. After the merge our live state
      // equals the newer snapshot plus our deltas, so it becomes the new base.
      const myBase = base;
      const remote = await load();
      mergeStates(state, remote, myBase);
    }
    throw new Error(`state store write conflict: another invocation kept winning (${CAS_ATTEMPTS} attempts); this invocation's writes were not persisted`);
  };

  return { load, save, flush, path, get version() { return loadedVersion; } };
}
