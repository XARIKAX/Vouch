// Reference Vouch provider: a ~70-line HTTP server that registers itself on
// the network, bonds a (simulated) stake, and serves text.generate tasks.
// Every task it accepts is dispatched to /task as POST {task_id, capability,
// input, deadline_ms}; the JSON body it returns is submitted for verification.
// Ship junk and the platform slashes the stake — so don't.
//
//   VOUCH_URL=http://localhost:4402 node examples/provider-server.js
import http from 'node:http';

const VOUCH_URL = process.env.VOUCH_URL ?? 'http://localhost:4402';
const PORT = Number(process.env.PROVIDER_PORT ?? 4501);
const NAME = process.env.PROVIDER_NAME ?? 'Example Provider';

function generateText(prompt) {
  const words = String(prompt).split(/\W+/).filter((w) => w.length > 3);
  const focus = words.length ? words : ['the', 'request'];
  return [
    `Delivered work on "${prompt}".`,
    `The ${focus[0]} question rewards a direct treatment: state the constraint, show where it binds, and only then generalize.`,
    `In practice, ${focus[Math.min(1, focus.length - 1)]} interacts with the surrounding system in ways a summary can flatten, so the specifics above are kept concrete.`,
    `The result holds for ${focus[0]} and extends to adjacent cases without modification.`,
  ].join(' ');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/task') {
    res.writeHead(404); return res.end();
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const task = JSON.parse(body);
    console.log(`  ← dispatched ${task.task_id} (${task.capability})`);
    const output = task.capability === 'text.generate'
      ? { text: generateText(task.input.prompt) }
      : { error: `this provider only serves text.generate` };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(output));
  });
});

server.listen(PORT, async () => {
  console.log(`provider listening on :${PORT}, registering with ${VOUCH_URL}…`);
  const res = await fetch(`${VOUCH_URL}/v1/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: NAME,
      endpoint_url: `http://localhost:${PORT}/task`,
      offers: {
        'text.generate': { price_ceiling: 0.009, sla_deadline_ms: 10000 },
      },
      stake: 25,
    }),
  });
  const provider = await res.json();
  if (!res.ok) {
    console.error('registration failed:', provider.error);
    process.exit(1);
  }
  console.log(`✓ registered as ${provider.id} — stake $${provider.stake}, track ${provider.track}`);
  console.log(`  now quoting text.generate at ≤ $${provider.offers['text.generate'].price_ceiling}`);
});
