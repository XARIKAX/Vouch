// End-to-end demo: boots the platform in-process and walks the whole thesis —
// a verified settlement, an unreliable provider failing verification (refund +
// slash), a no-quotes rejection with the nearest miss, a cache hit, a dispute,
// and the launchpad's queued slash behind the guardian.
//
//   npm run demo            (VOUCH_FAST=1 is implied: the demo always runs fast)
import { createApp } from '../server.js';
import { sleep } from '../src/util.js';

process.env.VOUCH_ADMIN_TOKEN ??= 'demo-admin';
const { server, engine } = createApp({ fast: true, persistPath: null });
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;

const section = (title) => console.log(`\n━━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}`);
const show = (label, obj) => console.log(`  ${label}:`, JSON.stringify(obj, null, 2).replace(/\n/g, '\n  '));

async function call(method, pathname, { key, body, headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function waitTerminal(key, taskId) {
  for (let i = 0; i < 400; i++) {
    const { body } = await call('GET', `/v1/tasks/${taskId}`, { key });
    if (['settled', 'refunded'].includes(body.status)) return body;
    await sleep(25);
  }
  throw new Error('task did not reach a terminal state');
}

try {
  section('1. Bootstrap: key + escrow');
  const { body: keyRes } = await call('POST', '/v1/keys', { body: { name: 'demo' } });
  const KEY = keyRes.key;
  await call('POST', '/v1/escrow/deposit', { key: KEY, body: { amount: 2 } });
  show('me', (await call('GET', '/v1/me', { key: KEY })).body);
  show('balance', (await call('GET', '/v1/balance', { key: KEY })).body);

  section('2. The catalog: standing offers');
  const { body: offers } = await call('GET', '/v1/offers?capability=text.generate', { key: KEY });
  show('text.generate offers', offers.offers.map(({ provider, price_ceiling, sla_deadline_ms, track, stake_available }) =>
    ({ provider, price_ceiling, sla_deadline_ms, track, stake_available })));

  section('3. Happy path: exact math, verified by an equals check');
  const { body: mathTask } = await call('POST', '/v1/tasks', {
    key: KEY,
    body: {
      capability: 'math.eval',
      input: { expression: '12 * (3 + 4) - 10 / 4' },
      acceptance: { checks: [{ assert: 'equals', path: 'result', value: 81.5 }] },
      budget: 0.01,
      deadline_ms: 5000,
    },
  });
  console.log(`  quote: ${mathTask.quote.provider} committed $${mathTask.quote.price} within ${mathTask.quote.deadline_ms}ms`);
  const mathDone = await waitTerminal(KEY, mathTask.id);
  show('settled', { status: mathDone.status, output: mathDone.output, settlement: mathDone.settlement });

  section('4. Plain text.generate settles by default (the homepage example)');
  const { body: textTask } = await call('POST', '/v1/tasks', {
    key: KEY,
    body: {
      capability: 'text.generate',
      input: { prompt: 'brief: why escrow beats retries' },
      acceptance: {
        checks: [{ assert: 'length_between', min: 120 }],
        rubric: 'answers the prompt; no filler',
      },
      budget: 0.03,
      deadline_ms: 30000,
    },
  });
  const textDone = await waitTerminal(KEY, textTask.id);
  if (textDone.status === 'settled') {
    console.log(`  settled by ${textDone.settlement.provider}, verified by [${textDone.settlement.verified_by}]`);
    console.log(`  output: "${textDone.output.text.slice(0, 110)}…"`);
  } else {
    console.log(`  refunded (${textDone.refund.reason}: ${textDone.refund.detail}) — escrow returned, provider slashed`);
  }

  section('5. The thesis: the only node that promises a 6 s turnaround ships junk — and pays for it');
  const shadeBefore = engine.state.providers.prv_shade.stake;
  const { body: cheapTask } = await call('POST', '/v1/tasks', {
    key: KEY,
    body: {
      capability: 'text.generate',
      input: { prompt: 'a short note on escrow' },
      acceptance: {
        checks: [
          { assert: 'length_between', min: 120, max: 4000 },
          { assert: 'contains_none', values: ['###', 'ERROR'] },
        ],
      },
      budget: 0.03,
      deadline_ms: 6000, // tighter than any reliable provider's SLA: only prv_shade can promise it
    },
  });
  console.log(`  quote: ${cheapTask.quote.provider} committed $${cheapTask.quote.price} within ${cheapTask.quote.deadline_ms}ms`);
  const cheapDone = await waitTerminal(KEY, cheapTask.id);
  show('refunded', { status: cheapDone.status, refund: cheapDone.refund, slash: cheapDone.slash });
  console.log(`  prv_shade stake: $${shadeBefore} → $${engine.state.providers.prv_shade.stake} (slashed)`);
  console.log('  your escrow was returned automatically — you paid $0 for the failure.');

  section('6. No admissible quote: 409 with the nearest miss');
  const noQuotes = await call('POST', '/v1/tasks', {
    key: KEY,
    body: {
      capability: 'research.web',
      input: { question: 'anything' },
      budget: 0.5,
      deadline_ms: 60000,
    },
  });
  show(`${noQuotes.status} no_quotes`, noQuotes.body.error);

  section('7. Cache: the same verified task again, instantly, for a fraction');
  const cacheBody = {
    capability: 'math.eval', input: { expression: '12 * (3 + 4) - 10 / 4' },
    acceptance: { checks: [{ assert: 'equals', path: 'result', value: 81.5 }] },
    budget: 0.01, deadline_ms: 5000, cache: true,
  };
  const cached = await call('POST', '/v1/tasks', { key: KEY, body: cacheBody });
  console.log(`  ${cached.status} cached=${cached.body.cached} provider=${cached.body.settlement?.provider} price=$${cached.body.settlement?.price} (source task ${cached.body.source_task_id ?? 'n/a'})`);

  section('8. Dispute a settlement (independent re-review with your evidence)');
  const disputeTarget = textDone.status === 'settled' ? textTask.id : mathTask.id;
  const { body: dispute } = await call('POST', `/v1/tasks/${disputeTarget}/dispute`, {
    key: KEY,
    body: { reason: 'output reads as generic', evidence: { note: 'compare against the prompt' } },
  });
  await sleep(300);
  const { body: disputeDone } = await call('GET', `/v1/disputes/${dispute.id}`, { key: KEY });
  console.log(`  dispute ${disputeDone.status} — ${disputeDone.status === 'rejected'
    ? 'settlement stands, payment released back to the provider'
    : 'refund issued and provider slashed at 200%'}`);
  const again = await call('POST', `/v1/tasks/${disputeTarget}/dispute`, { key: KEY, body: { reason: 'again' } });
  console.log(`  a second dispute on the same task → ${again.status} ${again.body.error?.code}`);

  section('9. Launchpad: a queued token-bond slash behind the guardian');
  const { body: agent } = await call('POST', '/v1/agents', {
    key: KEY,
    body: { symbol: 'DEMO', name: 'demo-agent', owner: '0xdemo', twap_usdg: 1, pool_liquidity_usdg: 5000,
      endpoint_url: 'http://localhost:1/task', offers: { 'math.eval': { price_ceiling: 0.02, sla_deadline_ms: 1000 } } },
  });
  await call('POST', `/v1/agents/${agent.id}/harvest`, { key: KEY, body: { fee_amount: 100 } });
  await call('POST', '/v1/admin/guardian', { headers: { 'X-Admin-Token': process.env.VOUCH_ADMIN_TOKEN }, body: { paused: true } });
  const { body: agentTask } = await call('POST', '/v1/tasks', {
    key: KEY,
    body: { capability: 'math.eval', input: { expression: '1+1' }, budget: 0.03, deadline_ms: 1000, min_track: 50,
      acceptance: { checks: [{ assert: 'equals', path: 'result', value: 2 }] } },
  });
  if (agentTask.quote?.provider === agent.provider_id) {
    await waitTerminal(KEY, agentTask.id);
    const paused = (await call('GET', `/v1/agents/${agent.id}`)).body;
    console.log(`  guardian paused: bond ${paused.bond.token_qty} tokens, pending slash $${paused.pending_slash_usdg}`);
    await call('POST', '/v1/admin/guardian', { headers: { 'X-Admin-Token': process.env.VOUCH_ADMIN_TOKEN }, body: { paused: false } });
    const resumed = (await call('GET', `/v1/agents/${agent.id}`)).body;
    console.log(`  guardian resumed: bond ${resumed.bond.token_qty} tokens, slashed $${resumed.totals.slashed_usdg}, pending $${resumed.pending_slash_usdg}`);
  } else {
    console.log(`  (another provider won the quote: ${agentTask.quote?.provider ?? agentTask.error?.code}; skipping)`);
    await call('POST', '/v1/admin/guardian', { headers: { 'X-Admin-Token': process.env.VOUCH_ADMIN_TOKEN }, body: { paused: false } });
  }

  section('10. Final ledger');
  const { body: finalBal } = await call('GET', '/v1/balance', { key: KEY });
  show('balance', { balance: finalBal.balance, locked: finalBal.locked });
  show('insurance', (await call('GET', '/v1/insurance')).body);
  show('providers', Object.fromEntries(Object.values(engine.state.providers).map((p) =>
    [p.id, { stake: p.stake, earnings: p.earnings, track: Math.round(p.track), settled: p.settledCount, slashed: p.slashedCount }])));

  console.log('\n✓ demo complete\n');
} catch (e) {
  console.error('\n✗ demo failed:', e);
  process.exitCode = 1;
} finally {
  server.close();
}
