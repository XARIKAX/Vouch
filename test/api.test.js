import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { sleep } from '../src/util.js';

async function boot(cfg = {}) {
  const { server, engine } = createApp({ fast: true, ...cfg });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, path, { key, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { server, engine, base, call };
}

test('full HTTP loop: key → deposit → offers → task → settled', async () => {
  const { server, call } = await boot();
  try {
    const keyRes = await call('POST', '/v1/keys', { body: { name: 'api-test' } });
    assert.equal(keyRes.status, 201);
    const KEY = keyRes.body.key;
    assert.match(KEY, /^vch_/);

    const dep = await call('POST', '/v1/escrow/deposit', { key: KEY, body: { amount: 3 } });
    assert.equal(dep.status, 200);

    const offers = await call('GET', '/v1/offers?capability=math', { key: KEY });
    assert.equal(offers.status, 200);
    assert.ok(offers.body.offers.length >= 1);
    assert.ok(offers.headers.get('x-ratelimit-remaining'));

    const created = await call('POST', '/v1/tasks', {
      key: KEY,
      body: {
        capability: 'math.eval', input: { expression: '6*7' },
        acceptance: { checks: [{ assert: 'equals', path: 'result', value: 42 }] },
        budget: 0.01, deadline_ms: 5000,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'dispatched');
    assert.ok(created.headers.get('x-escrow-ceiling-remaining'));

    let task;
    for (let i = 0; i < 100; i++) {
      task = (await call('GET', `/v1/tasks/${created.body.id}`, { key: KEY })).body;
      if (task.status === 'settled') break;
      await sleep(20);
    }
    assert.equal(task.status, 'settled');
    assert.equal(task.output.result, 42);
  } finally {
    server.close();
  }
});

test('launchpad HTTP: launch → harvest → price-drop → unbond over /v1/agents (owner-gated)', async () => {
  const { server, call } = await boot();
  try {
    const KEY = (await call('POST', '/v1/keys', { body: { name: 'launcher' } })).body.key;
    const OTHER = (await call('POST', '/v1/keys', { body: { name: 'stranger' } })).body.key;

    // Launch requires a Bearer key and records who launched.
    const anon = await call('POST', '/v1/agents', { body: { symbol: 'CALC' } });
    assert.equal(anon.status, 401);
    const launched = await call('POST', '/v1/agents', {
      key: KEY, body: { owner: '0xowner', symbol: 'CALC', twap_usdg: 1, pool_liquidity_usdg: 5000 },
    });
    assert.equal(launched.status, 201);
    const id = launched.body.id;
    assert.match(id, /^agt_/);
    const me = (await call('GET', '/v1/me', { key: KEY })).body;
    assert.equal(launched.body.owner_key_id, me.key_id);
    assert.equal(typeof launched.body.pending_slash_usdg, 'number');

    const list = await call('GET', '/v1/agents');
    assert.ok(list.body.agents.some((a) => a.id === id));

    // Writes: the owner's key works; another key and no key are 403 not_owner.
    const stranger = await call('POST', `/v1/agents/${id}/harvest`, { key: OTHER, body: { fee_amount: 1000 } });
    assert.equal(stranger.status, 403);
    assert.equal(stranger.body.error.code, 'not_owner');
    const nobody = await call('POST', `/v1/agents/${id}/price`, { body: { twap_usdg: 0.5 } });
    assert.equal(nobody.status, 403);
    assert.equal(nobody.body.error.code, 'not_owner');

    const harvested = await call('POST', `/v1/agents/${id}/harvest`, { key: KEY, body: { fee_amount: 1000 } });
    assert.equal(harvested.status, 200);
    assert.deepEqual(harvested.body.split, { bond: 500, operating: 300, creator: 150, treasury: 50 });

    const got = await call('GET', `/v1/agents/${id}`);
    assert.equal(got.body.bond.capacity_usdg, 125); // 500 * 0.5 / 2

    const priced = await call('POST', `/v1/agents/${id}/price`, { key: KEY, body: { twap_usdg: 0.5 } });
    assert.equal(priced.body.bond.capacity_usdg, 62.5); // capacity halves with price

    const unbond = await call('POST', `/v1/agents/${id}/unbond`, { key: KEY, body: { token_qty: 100 } });
    assert.equal(unbond.status, 202);
    assert.ok(unbond.body.unbonding.release_at > Date.now());

    // The admin token substitutes for the owner key.
    process.env.VOUCH_ADMIN_TOKEN = 'adm-token';
    try {
      const res = await fetch(`${(await call('GET', '/health')).headers.get('x-noop') ?? ''}`.length ? '' : `${server.address().port}`).catch(() => null);
      void res;
      const asAdmin = await fetch(`http://localhost:${server.address().port}/v1/agents/${id}/price`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': 'adm-token' }, body: JSON.stringify({ twap_usdg: 1 }),
      });
      assert.equal(asAdmin.status, 200);
    } finally { delete process.env.VOUCH_ADMIN_TOKEN; }
  } finally {
    server.close();
  }
});

test('auth: missing or bad key → 401 unauthorized', async () => {
  const { server, call } = await boot();
  try {
    const noKey = await call('GET', '/v1/balance');
    assert.equal(noKey.status, 401);
    assert.equal(noKey.body.error.code, 'unauthorized');
    // a present-but-invalid key is rejected even on public routes
    const badKey = await call('GET', '/v1/offers', { key: 'vch_not_real' });
    assert.equal(badKey.status, 401);
  } finally {
    server.close();
  }
});

test('rate limiting: burst past the tier limit → 429 with Retry-After', async () => {
  const { server, call } = await boot({ rpm: { sandbox: 5, startup: 600, scale: 6000 } });
  try {
    const KEY = (await call('POST', '/v1/keys', { body: {} })).body.key;
    let limited;
    for (let i = 0; i < 10; i++) {
      const res = await call('GET', '/v1/balance', { key: KEY });
      if (res.status === 429) { limited = res; break; }
    }
    assert.ok(limited, 'expected a 429 within the burst');
    assert.equal(limited.body.error.code, 'rate_limited');
    assert.ok(limited.headers.get('retry-after'));
  } finally {
    server.close();
  }
});

test('SSE event stream replays history and closes on terminal state', async () => {
  const { server, call, base } = await boot();
  try {
    const KEY = (await call('POST', '/v1/keys', { body: {} })).body.key;
    const created = await call('POST', '/v1/tasks', {
      key: KEY,
      body: {
        capability: 'math.eval', input: { expression: '1+1' },
        budget: 0.01, deadline_ms: 5000,
      },
    });
    const res = await fetch(`${base}/v1/tasks/${created.body.id}/events`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text(); // stream ends at the terminal event
    const events = text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
    assert.equal(events[0].status, 'dispatched');
    assert.equal(events.at(-1).status, 'settled');
  } finally {
    server.close();
  }
});

test('MCP: tools/list is open, tools/call requires a key and works end to end', async () => {
  const { server, call, base } = await boot();
  try {
    const rpc = async (payload, key) => {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...payload }),
      });
      return res.json();
    };

    const init = await rpc({ method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'vouch');

    const list = await rpc({ method: 'tools/list' });
    const names = list.result.tools.map((t) => t.name);
    assert.equal(names.length, 17);
    assert.deepEqual(names.sort(), [
      'vouch_balance', 'vouch_create_subkey', 'vouch_create_workflow', 'vouch_dispute', 'vouch_dispute_status',
      'vouch_find_offers', 'vouch_freeze_subkey', 'vouch_get_agent', 'vouch_get_attestation', 'vouch_list_agents',
      'vouch_list_providers', 'vouch_list_subkeys', 'vouch_post_task', 'vouch_revoke_subkey', 'vouch_task_status',
      'vouch_verify', 'vouch_workflow_status',
    ]);

    const KEY = (await call('POST', '/v1/keys', { body: {} })).body.key;
    const posted = await rpc({
      method: 'tools/call',
      params: {
        name: 'vouch_post_task',
        arguments: {
          capability: 'math.eval', input: { expression: '10/4' },
          budget: 0.01, deadline_ms: 5000,
        },
      },
    }, KEY);
    const task = JSON.parse(posted.result.content[0].text);
    assert.equal(task.status, 'dispatched');

    await sleep(400);
    const status = await rpc({
      method: 'tools/call',
      params: { name: 'vouch_task_status', arguments: { task_id: task.id } },
    }, KEY);
    const done = JSON.parse(status.result.content[0].text);
    assert.equal(done.status, 'settled');
    assert.equal(done.output.result, 2.5);

    // a new tool: verify-as-a-service over MCP
    const verified = await rpc({
      method: 'tools/call',
      params: {
        name: 'vouch_verify',
        arguments: {
          capability: 'math.eval', input: { expression: '2+2' }, output: { result: 4 },
          acceptance: { checks: [{ assert: 'equals', path: 'result', value: 4 }] },
        },
      },
    }, KEY);
    const vres = JSON.parse(verified.result.content[0].text);
    assert.equal(vres.pass, true);
    assert.ok(vres.attestation);

    const unauth = await rpc({
      method: 'tools/call',
      params: { name: 'vouch_balance', arguments: {} },
    });
    assert.equal(unauth.result.isError, true);
  } finally {
    server.close();
  }
});

test('catalog is public: offers and capabilities need no key', async () => {
  const { server, call } = await boot();
  try {
    const offers = await call('GET', '/v1/offers');
    assert.equal(offers.status, 200);
    assert.ok(offers.body.offers.length >= 8);
    const caps = await call('GET', '/v1/capabilities');
    assert.equal(caps.status, 200);
    const ids = caps.body.capabilities.map((c) => c.id);
    assert.ok(ids.includes('text.summarize'));
    assert.ok(ids.includes('embed.text'));
    assert.ok(ids.includes('research.web')); // listed even with no providers
  } finally {
    server.close();
  }
});

test('new capabilities settle: summarize and embeddings', async () => {
  const { server, call } = await boot();
  try {
    const KEY = (await call('POST', '/v1/keys', { body: {} })).body.key;
    const poll = async (id) => {
      for (let i = 0; i < 100; i++) {
        const t = (await call('GET', `/v1/tasks/${id}`, { key: KEY })).body;
        if (['settled', 'refunded'].includes(t.status)) return t;
        await sleep(20);
      }
      throw new Error('not terminal');
    };

    const sum = await call('POST', '/v1/tasks', {
      key: KEY,
      body: {
        capability: 'text.summarize',
        input: { text: 'Escrow gates settlement on verification. Failed work refunds the buyer. Providers bond capital and lose it when they ship junk.' },
        acceptance: { checks: [{ assert: 'contains_none', values: ['###'] }] },
        budget: 0.01, deadline_ms: 8000, min_track: 90,
      },
    });
    const sumDone = await poll(sum.body.id);
    assert.equal(sumDone.status, 'settled');
    assert.ok(sumDone.output.summary.length > 10);

    const emb = await call('POST', '/v1/tasks', {
      key: KEY,
      body: {
        capability: 'embed.text',
        input: { text: 'vector me' },
        budget: 0.002, deadline_ms: 5000,
      },
    });
    const embDone = await poll(emb.body.id);
    assert.equal(embDone.status, 'settled');
    assert.equal(embDone.output.vector.length, 8);
  } finally {
    server.close();
  }
});
