import { readBody } from './api.js';
import { ApiError } from './engine.js';

// Minimal Model Context Protocol server over Streamable HTTP (JSON-RPC 2.0,
// single-response mode). Discovery (initialize, tools/list) is open;
// tools/call requires a bearer key — matching the docs.

const TOOLS = [
  {
    name: 'vouch_find_offers',
    description: 'Browse standing offers by capability, price ceiling, and track score.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: 'Capability id or prefix, e.g. "image"' },
        max_price: { type: 'number' },
        min_track: { type: 'number' },
      },
    },
  },
  {
    name: 'vouch_post_task',
    description: 'Post a task with acceptance criteria and budget; returns the committed quote. Escrow locks at the quoted price.',
    inputSchema: {
      type: 'object',
      required: ['capability', 'input', 'budget', 'deadline_ms'],
      properties: {
        capability: { type: 'string' },
        input: { type: 'object' },
        acceptance: {
          type: 'object',
          properties: {
            checks: { type: 'array', items: { type: 'object' } },
            rubric: { type: 'string' },
            webhook: { type: 'string' },
          },
        },
        budget: { type: 'number', description: 'Maximum spend in USDC' },
        deadline_ms: { type: 'integer' },
        min_track: { type: 'number' },
        idempotency_key: { type: 'string' },
      },
    },
  },
  {
    name: 'vouch_task_status',
    description: 'Check a task; returns output and settlement once settled, or the refund reason.',
    inputSchema: {
      type: 'object', required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
  },
  {
    name: 'vouch_dispute',
    description: 'Escalate a settled task with a reason and evidence within the 24h window.',
    inputSchema: {
      type: 'object', required: ['task_id', 'reason'],
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
        evidence: { type: 'object' },
      },
    },
  },
  {
    name: 'vouch_balance',
    description: 'Read escrow balance, locked amounts, and recent settlement history.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export function createMcp(engine) {
  function callTool(key, name, args = {}) {
    switch (name) {
      case 'vouch_find_offers': return { offers: engine.offers(args) };
      case 'vouch_post_task': return engine.createTask(key, args).task;
      case 'vouch_task_status': return engine.getTask(key, args.task_id);
      case 'vouch_dispute': return engine.openDispute(key, args.task_id, args);
      case 'vouch_balance': return engine.balance(key);
      default: throw new ApiError(404, 'unknown_tool', `No tool "${name}".`);
    }
  }

  return async function handle(req, res) {
    const reply = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET') {
      return reply({ name: 'vouch', transport: 'streamable-http', hint: 'POST JSON-RPC 2.0 here' });
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST' });
      return res.end();
    }

    let rpc;
    try { rpc = await readBody(req); }
    catch { return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

    const { id = null, method, params = {} } = rpc ?? {};
    const ok = (result) => reply({ jsonrpc: '2.0', id, result });
    const err = (code, message, data) => reply({ jsonrpc: '2.0', id, error: { code, message, data } });

    try {
      switch (method) {
        case 'initialize':
          return ok({
            protocolVersion: params.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'vouch', version: '0.1.0' },
          });
        case 'notifications/initialized':
          res.writeHead(202); return res.end();
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: TOOLS });
        case 'tools/call': {
          const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
          const key = engine.authenticate(m?.[1] ?? '');
          const result = callTool(key, params.name, params.arguments);
          return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
        }
        default:
          return err(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      if (e instanceof ApiError) {
        return ok({
          content: [{ type: 'text', text: JSON.stringify({ error: { code: e.code, message: e.message, ...e.extra } }) }],
          isError: true,
        });
      }
      return err(-32603, e.message);
    }
  };
}
