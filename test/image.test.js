import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { buildImageUrl, placeholderImageUrl, fetchImage } from '../src/image.js';

const waitTerminal = async (engine, id) => { await engine.drain(); return engine.state.tasks[id]; };
const onlyProvider = (engine) => {
  engine.state.providers = { prv_real: {
    id: 'prv_real', name: 'Real', stake: 100, stakeReserved: 0, earnings: 0, track: 90, settledCount: 0, slashedCount: 0, reliability: 1,
    offers: { 'image.generate': { price_ceiling: 0.03, sla_deadline_ms: 12000 } },
  } };
};
// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// Routes: the image API serves bytes (or fails), the model API grades.
function fakeNet({ imageStatus = 200, imageType = 'image/png', verdict = 'PASS' } = {}) {
  const original = globalThis.fetch;
  const calls = { image: [], model: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://img.test/')) { calls.image.push(u); return new Response(imageStatus === 200 ? PNG : 'nope', { status: imageStatus, headers: { 'content-type': imageType } }); }
    if (u.startsWith('https://fake.model.test')) { calls.model.push(JSON.parse(String(opts.body))); return new Response(JSON.stringify({ content: [{ type: 'text', text: verdict }], stop_reason: 'end_turn' }), { status: 200 }); }
    return original(url, opts);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('image URLs: the provider commits to a deterministic image API URL; the placeholder says what it is', () => {
  const cfg = { imageBaseUrl: 'https://img.test', imageModel: 'flux' };
  const task = { id: 'tsk_abc', input: { prompt: 'a cute cat', width: 512, height: 768 } };
  const url = buildImageUrl(cfg, task);
  assert.ok(url.startsWith('https://img.test/prompt/a%20cute%20cat?'));
  assert.match(url, /width=512/); assert.match(url, /height=768/); assert.match(url, /seed=\d+/); assert.match(url, /model=flux/);
  assert.equal(buildImageUrl(cfg, task), url, 'same task, same URL');
  assert.notEqual(buildImageUrl(cfg, { ...task, id: 'tsk_other' }), url, 'another task, another seed');
  const ph = placeholderImageUrl(task);
  assert.ok(ph.startsWith('https://placehold.co/512x768/'));
  assert.match(decodeURIComponent(ph), /SANDBOX PLACEHOLDER/);
  assert.match(decodeURIComponent(ph), /a cute cat/);
});

test('image task: the picture is fetched, checked, and shown to the vision graders before the agent is paid', async () => {
  const net = fakeNet();
  try {
    const engine = createEngine({ fast: true, imageProvider: 'pollinations', imageBaseUrl: 'https://img.test', anthropicKey: 'sk-test', graderModel: 'grade-y', anthropicBaseUrl: 'https://fake.model.test' });
    onlyProvider(engine);
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, { capability: 'image.generate', input: { prompt: 'a cute cat' }, acceptance: { rubric: 'depicts a cat' }, budget: 0.03, deadline_ms: 12000 });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'settled');
    assert.equal(done.execution.mode, 'image');
    assert.ok(done.output.url.startsWith('https://img.test/prompt/a%20cute%20cat'));
    assert.deepEqual(done.settlement.verified_by, ['schema', 'image', 'rubric:3/3']);
    assert.equal(net.calls.image.length, 1, 'fetched once by verification; the graders reuse the bytes');
    assert.equal(net.calls.model.length, 3);
    const content = net.calls.model[0].messages[0].content;
    assert.equal(content[0].type, 'image');
    assert.equal(content[0].source.media_type, 'image/png');
    assert.equal(content[0].source.data, PNG.toString('base64'));
    assert.match(content[1].text, /attached image/);
  } finally { net.restore(); }
});

test('image task: a URL that does not yield an image fails the image validator and refunds', async () => {
  const net = fakeNet({ imageStatus: 503 });
  try {
    const engine = createEngine({ fast: true, imageProvider: 'pollinations', imageBaseUrl: 'https://img.test' });
    onlyProvider(engine);
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, { capability: 'image.generate', input: { prompt: 'x' }, acceptance: {}, budget: 0.03, deadline_ms: 12000 });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'refunded');
    assert.match(done.refund.detail, /image: image URL answered 503/);
  } finally { net.restore(); }
});

test('image task: a vision panel that votes FAIL refunds the buyer', async () => {
  const net = fakeNet({ verdict: 'FAIL' });
  try {
    const engine = createEngine({ fast: true, imageProvider: 'pollinations', imageBaseUrl: 'https://img.test', anthropicKey: 'sk-test', graderModel: 'grade-y', anthropicBaseUrl: 'https://fake.model.test' });
    onlyProvider(engine);
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, { capability: 'image.generate', input: { prompt: 'a cute cat' }, acceptance: { rubric: 'depicts a cat' }, budget: 0.03, deadline_ms: 12000 });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'refunded');
    assert.match(done.refund.detail, /rubric: graders voted 0\/3/);
  } finally { net.restore(); }
});

test('without an image provider the simulator returns the labelled placeholder and nothing is fetched', async () => {
  const net = fakeNet();
  try {
    const engine = createEngine({ fast: true, imageProvider: 'none' });
    onlyProvider(engine);
    const key = engine.createKey('t');
    const { task } = engine.createTask(key, { capability: 'image.generate', input: { prompt: 'a cute cat' }, acceptance: {}, budget: 0.03, deadline_ms: 12000 });
    const done = await waitTerminal(engine, task.id);
    assert.equal(done.status, 'settled');
    assert.equal(done.execution.mode, 'simulated');
    assert.match(done.output.url, /placehold\.co/);
    assert.equal(net.calls.image.length, 0);
  } finally { net.restore(); }
});

test('fetchImage: rejects non-image content types', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
  try {
    const r = await fetchImage('https://img.test/x');
    assert.equal(r.ok, false); assert.match(r.error, /text\/html, not an image/);
  } finally { globalThis.fetch = original; }
});
