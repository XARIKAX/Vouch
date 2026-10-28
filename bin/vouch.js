#!/usr/bin/env node
// The Vouch command line. Phase 1 of Vouch Credit: reads.
//
//   vouch credit score  <id>        score, tier, fee, credit line
//   vouch credit report <id>        every input, the point breakdown, the on-chain record
//   vouch credit line   <id>        how much the score sizes, and why
//   vouch credit doctor             is the credit layer configured and reachable?
//
//   VOUCH_URL   the deployment (default http://localhost:4402)
//   VOUCH_KEY   a bearer key, for writes
import { readDeployment, DEFAULT_DEPLOYMENTS_DIR } from '../src/credit/chain.js';

const BASE = (process.env.VOUCH_URL || 'http://localhost:4402').replace(/\/$/, '');
const KEY = process.env.VOUCH_KEY || '';
const [, , group, cmd, ...rest] = process.argv;

const usage = () => {
  console.log(`vouch credit score|report|line <id>\nvouch credit doctor\n\n  <id> is a provider id (prv_…), an agent id (agt_…) or a linked ERC-8004 agentId.\n  VOUCH_URL=${BASE}`);
  process.exit(1);
};

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json.error?.code ?? ''}: ${json.error?.message ?? res.statusText}`);
  return json;
}

const usd = (n) => `$${Number(n ?? 0).toFixed(2)}`;
const line = (k, v) => console.log(`  ${k.padEnd(26)} ${v}`);

async function score(id) {
  const s = await api('GET', `/v1/credit/score/${encodeURIComponent(id)}`);
  console.log(`credit score for ${s.subject}${s.agent_id ? ` (agentId ${s.agent_id}${s.verified_identity ? '' : ', unverified'})` : ''}`);
  line('score', `${s.score} / 1000`);
  line('tier', ['0 · no credit', '1 · thin', '2 · established', '3 · prime'][s.tier]);
  line('fee per 30 days', `${s.fee_bps_30d} bps`);
  line('credit line', usd(s.credit_line_usd));
  line('recent volume', usd(s.recent_volume_usd));
}

async function report(id) {
  const r = await api('GET', `/v1/credit/report/${encodeURIComponent(id)}`);
  await score(id);
  console.log('\npoints');
  for (const [k, v] of Object.entries(r.points)) line(k, String(v));
  console.log('\ninputs');
  for (const [k, v] of Object.entries(r.inputs)) line(k, /usd$/.test(k) ? usd(v) : String(v));
  console.log(`\nevents (${r.events_total})`);
  for (const e of r.events.slice(-10)) line(new Date(e.ts).toISOString().slice(0, 19), `${e.kind.padEnd(13)} ${usd(e.amount).padStart(10)}  ${e.ref}`);
  console.log('\nchain');
  line('enabled', String(r.chain.enabled) + (r.chain.reason ? ` (${r.chain.reason})` : ''));
  if (r.chain.report) { line('on-chain score', String(r.chain.score)); line('on-chain line', usd(r.chain.report.credit_line_usd)); }
  if (r.chain.error) line('error', r.chain.error);
  if (r.identity) line('outbox', `${r.identity.outbox.posted} posted · ${r.identity.outbox.pending} pending · ${r.identity.outbox.failed} failed`);
}

async function creditLine(id) {
  const l = await api('GET', `/v1/credit/line/${encodeURIComponent(id)}`);
  console.log(`credit line for ${l.subject}`);
  line('line', `${usd(l.credit_line_usd)} of a ${usd(l.cap_usd)} cap`);
  line('score / tier', `${l.score} / ${l.tier}`);
  line('fee per 30 days', `${l.fee_bps_30d} bps`);
  line('recent volume', usd(l.recent_volume_usd));
  line('basis', l.basis);
  if (l.note) line('note', l.note);
}

async function doctor() {
  let ok = true;
  const check = (good, what, detail = '') => { ok = ok && good; console.log(`  ${good ? 'ok ' : 'no '} ${what}${detail ? `  ${detail}` : ''}`); };
  console.log(`vouch credit doctor · ${BASE}`);
  let st;
  try { st = await api('GET', '/v1/credit'); check(true, 'server answers /v1/credit', `phase ${st.phase}`); }
  catch (e) { check(false, 'server answers /v1/credit', e.message); return process.exit(1); }
  const c = st.chain;
  check(!!c.chain_id, 'VOUCH_CREDIT_CHAIN_ID set', c.chain_id ? `chain ${c.chain_id}` : (c.reason ?? ''));
  const rec = c.chain_id ? readDeployment(c.chain_id) : null;
  check(!!rec, `deployment record contracts/deployments/${c.chain_id || '<chainId>'}.json`, rec ? `identity ${rec.identityRegistry} · usdg ${rec.usdg}` : `looked in ${DEFAULT_DEPLOYMENTS_DIR}`);
  check(!!c.contracts?.credit_registry, 'CreditRegistry deployed', c.contracts?.credit_registry ?? (c.reason ?? ''));
  check(c.enabled, 'credit chain enabled on the server', c.reason ?? '');
  check(c.can_write, 'attester key configured (events are posted)', c.attester ? `attester ${c.attester}` : 'read-only');
  console.log(`\n  records ${st.records} · events ${st.events} · identities ${st.identities} · outbox ${st.outbox.posted} posted / ${st.outbox.pending} pending / ${st.outbox.failed} failed`);
  if (!c.enabled) console.log('\n  Scores still work: they are computed from the engine\'s own record. The chain only adds the public, replayable copy.');
  process.exit(ok ? 0 : 2);
}

(async () => {
  if (group !== 'credit') usage();
  const id = rest[0];
  try {
    if (cmd === 'score' && id) await score(id);
    else if (cmd === 'report' && id) await report(id);
    else if (cmd === 'line' && id) await creditLine(id);
    else if (cmd === 'doctor') await doctor();
    else usage();
  } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
})();
