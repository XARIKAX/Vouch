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
// state) in place. Collections union by id with local winning; pools and
// counters stay local (this invocation is the one that moved them).
export function mergeStates(local, remote) {
  if (!remote || typeof remote !== 'object') return local;
  for (const c of COLLECTIONS) {
    if (!remote[c] || typeof remote[c] !== 'object') continue;
    local[c] ??= {};
    for (const [id, rec] of Object.entries(remote[c])) {
      if (!(id in local[c])) local[c][id] = rec;
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

  const load = async () => {
    const [raw, ver] = await Promise.all([command(['GET', key], 'read'), command(['GET', versionKey], 'read')]);
    loadedVersion = ver == null ? 0 : Number(ver) || 0;
    if (raw == null) return null;
    const state = JSON.parse(raw);
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
      // our records on top of the newer snapshot, and retry.
      const remote = await load();
      mergeStates(state, remote);
    }
    throw new Error(`state store write conflict: another invocation kept winning (${CAS_ATTEMPTS} attempts); this invocation's writes were not persisted`);
  };

  return { load, save, flush, path, get version() { return loadedVersion; } };
}
