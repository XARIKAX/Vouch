import { stateReplacer } from './store.js';

// Upstash Redis (REST API) persistence for serverless deployments, where the
// filesystem is read-only/ephemeral. Zero dependencies — plain fetch against
// the REST endpoint. The whole state graph is one JSON value under one key,
// matching the file store's snapshot model. Writes are last-write-wins: fine
// for the sandbox tier this deployment mode targets.
//
// Reads env vars from either the Upstash integration or the Vercel KV names:
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   KV_REST_API_URL        / KV_REST_API_TOKEN
// Returns null when neither pair is configured.

export function createUpstashStore(opts = {}) {
  const url = (opts.url ?? process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL ?? '').replace(/\/$/, '');
  const token = opts.token ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  const key = opts.key ?? process.env.VOUCH_STATE_KEY ?? 'vouch:state';
  if (!url || !token) return null;

  const headers = { Authorization: `Bearer ${token}` };
  let dirty = null; // latest state reference awaiting flush

  const load = async () => {
    const res = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers });
    if (!res.ok) throw new Error(`state store read failed: ${res.status}`);
    const body = await res.json();
    return body.result == null ? null : JSON.parse(body.result);
  };

  // save() is called synchronously from the engine after every mutation;
  // the actual network write happens once, in flush(), before the serverless
  // invocation returns.
  const save = (state) => { dirty = state; };

  const flush = async () => {
    if (!dirty) return;
    const snapshot = JSON.stringify(dirty, stateReplacer);
    dirty = null;
    const res = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers,
      body: snapshot,
    });
    if (!res.ok) throw new Error(`state store write failed: ${res.status}`);
  };

  return { load, save, flush, path: `${url} (${key})` };
}
