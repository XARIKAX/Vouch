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

test('auth: missing or bad key → 401 unauthorized', async () => {
  const { server, call } = await boot();
  try {
    const noKey = await call('GET', '/v1/offers');
    assert.equal(noKey.status, 401);
    assert.equal(noKey.body.error.code, 'unauthorized');
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
    assert.deepEqual(names.sort(), [
      'vouch_balance', 'vouch_dispute', 'vouch_find_offers', 'vouch_post_task', 'vouch_task_status',
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

    const unauth = await rpc({
      method: 'tools/call',
      params: { name: 'vouch_balance', arguments: {} },
    });
    assert.equal(unauth.result.isError, true);
  } finally {
    server.close();
  }
});
