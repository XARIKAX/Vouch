// End-to-end demo: boots the platform in-process and walks the whole thesis —
// a verified settlement, a cheap provider failing verification (refund +
// slash), a no-quotes rejection with the nearest miss, and a dispute.
//
//   npm run demo
import { createApp } from '../server.js';
import { sleep } from '../src/util.js';

const { server, engine } = createApp({ fast: true });
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}`;

const section = (title) => console.log(`\n━━━ ${title} ${'━'.repeat(Math.max(0, 60 - title.length))}`);
const show = (label, obj) => console.log(`  ${label}:`, JSON.stringify(obj, null, 2).replace(/\n/g, '\n  '));

async function call(method, pathname, { key, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function waitTerminal(key, taskId) {
  for (let i = 0; i < 200; i++) {
    const { body } = await call('GET', `/v1/tasks/${taskId}`, { key });
    if (['settled', 'refunded'].includes(body.status)) return body;
    await sleep(25);
  }
  throw new Error('task did not reach a terminal state');
}

section('1. Bootstrap: key + escrow');
const { body: keyRes } = await call('POST', '/v1/keys', { body: { name: 'demo' } });
const KEY = keyRes.key;
await call('POST', '/v1/escrow/deposit', { key: KEY, body: { amount: 2 } });
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

section('4. Rubric-verified text from a high-track provider');
const { body: textTask } = await call('POST', '/v1/tasks', {
  key: KEY,
  body: {
    capability: 'text.generate',
    input: { prompt: 'why verification beats reputation for autonomous agents' },
    acceptance: {
      checks: [
        { assert: 'length_between', min: 120, max: 4000 },
        { assert: 'contains_none', values: ['###', 'ERROR'] },
      ],
      rubric: 'engages the prompt substantively; no filler or error markers',
    },
    budget: 0.03,
    deadline_ms: 10000,
    min_track: 90,
  },
});
const textDone = await waitTerminal(KEY, textTask.id);
console.log(`  ${textDone.status} by ${textDone.settlement.provider}, verified by [${textDone.settlement.verified_by}]`);
console.log(`  output: "${textDone.output.text.slice(0, 110)}…"`);

section('5. The thesis: the cheapest bid ships junk — and pays for it');
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
    budget: 0.006, // only the cheap, unreliable provider quotes this low
    deadline_ms: 10000,
  },
});
console.log(`  quote: ${cheapTask.quote.provider} (cheapest) committed $${cheapTask.quote.price}`);
const cheapDone = await waitTerminal(KEY, cheapTask.id);
show('refunded', { status: cheapDone.status, refund: cheapDone.refund, slash: cheapDone.slash });
console.log(`  prv_shade stake: $${shadeBefore} → $${engine.state.providers.prv_shade.stake} (slashed)`);
console.log(`  your escrow was returned automatically — you paid $0 for the failure.`);

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

section('7. Dispute a settlement (independent re-review)');
const { body: dispute } = await call('POST', `/v1/tasks/${textTask.id}/dispute`, {
  key: KEY,
  body: { reason: 'output reads as generic', evidence: {} },
});
await sleep(300);
const { body: disputeDone } = await call('GET', `/v1/disputes/${dispute.id}`, { key: KEY });
console.log(`  dispute ${disputeDone.status} — ${disputeDone.status === 'rejected'
  ? 'settlement stands, payment released back to the provider'
  : 'refund issued and provider slashed at 200%'}`);

section('8. Final ledger');
const { body: finalBal } = await call('GET', '/v1/balance', { key: KEY });
show('balance', { balance: finalBal.balance, locked: finalBal.locked });
show('providers', Object.fromEntries(Object.values(engine.state.providers).map((p) =>
  [p.id, { stake: p.stake, earnings: p.earnings, track: Math.round(p.track), settled: p.settledCount, slashed: p.slashedCount }])));

console.log('\n✓ demo complete\n');
server.close();
