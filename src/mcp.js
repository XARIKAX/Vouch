import { readBody } from './api.js';
import { ApiError } from './errors.js';

// Minimal Model Context Protocol server over Streamable HTTP (JSON-RPC 2.0,
// single-response mode) served at /mcp only. Discovery (initialize,
// tools/list) is open; tools/call requires a bearer key and runs through the
// same per-key rate limiter as the REST API.

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
        budget: { type: 'number', description: 'Maximum spend in USDG' },
        deadline_ms: { type: 'integer' },
        min_track: { type: 'number' },
        idempotency_key: { type: 'string' },
        retry: { description: 'true (or { max_attempts }) to reroute past failures until verified' },
        consensus: { type: 'integer', description: 'Run N providers in parallel (2-3); settle the best that passes' },
        cache: { type: 'boolean', description: 'Serve an identical, already-verified task instantly from cache' },
      },
    },
  },
  {
    name: 'vouch_verify',
    description: 'Verify output you already have against acceptance criteria — no escrow, no execution. Returns a signed attestation on pass.',
    inputSchema: {
      type: 'object', required: ['capability', 'output'],
      properties: {
        capability: { type: 'string' },
        input: { type: 'object' },
        output: { type: 'object' },
        acceptance: { type: 'object' },
      },
    },
  },
  {
    name: 'vouch_create_workflow',
    description: 'Run a verified multi-step task graph. Later steps reference earlier verified output via {{steps.N.output.path}}.',
    inputSchema: {
      type: 'object', required: ['steps'],
      properties: { steps: { type: 'array', items: { type: 'object' } } },
    },
  },
  {
    name: 'vouch_workflow_status',
    description: 'Check a workflow: per-step status and the final output once completed.',
    inputSchema: { type: 'object', required: ['workflow_id'], properties: { workflow_id: { type: 'string' } } },
  },
  {
    name: 'vouch_list_providers',
    description: 'List providers with track record, reliability, and slashable stake.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vouch_get_attestation',
    description: 'Fetch the ed25519 proof-of-verified-work for a settled task, plus the public key to verify it.',
    inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } },
  },
  {
    name: 'vouch_create_subkey',
    description: 'Open an agentic account (capped, policy-bound sub-key) for a child agent: fund it from the parent, optionally restrict to a capability allowlist (ids or prefixes like "text.*") and a per-task spend cap.',
    inputSchema: {
      type: 'object', required: ['fund'],
      properties: {
        fund: { type: 'number', description: 'USDG to transfer from the parent to the account (its dedicated budget)' },
        allow: { type: 'array', items: { type: 'string' }, description: 'Capability allowlist: exact ids or prefixes such as "text.*"' },
        per_task_cap: { type: 'number', description: 'Maximum USDG any single task may spend' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'vouch_list_subkeys',
    description: 'List the agentic accounts (sub-keys) under this key with their allowlist, balance, frozen and revoked state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vouch_freeze_subkey',
    description: 'Freeze (or unfreeze) an agentic account: a frozen account keeps its balance but cannot post tasks. Instant and reversible.',
    inputSchema: {
      type: 'object', required: ['sub_key_id'],
      properties: {
        sub_key_id: { type: 'string' },
        frozen: { type: 'boolean', description: 'true to freeze (default), false to unfreeze' },
      },
    },
  },
  {
    name: 'vouch_revoke_subkey',
    description: 'Revoke an agentic account permanently and return its unspent balance to the parent.',
    inputSchema: { type: 'object', required: ['sub_key_id'], properties: { sub_key_id: { type: 'string' } } },
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
    name: 'vouch_dispute_status',
    description: 'Check a dispute: reviewing, upheld (refund + slash) or rejected (settlement stands).',
    inputSchema: { type: 'object', required: ['dispute_id'], properties: { dispute_id: { type: 'string' } } },
  },
  {
    name: 'vouch_balance',
    description: 'Read escrow balance, locked amounts, and recent settlement history.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vouch_list_agents',
    description: 'List launched agents (token-wrapped providers) with their token-bond value, haircut capacity, and routed-revenue totals — so you can size the bond standing behind a quote before you trust it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vouch_get_agent',
    description: 'Inspect one launched agent: its token bond (raw / haircut / open-quote capacity), unbonding status, pending slashes, and lifetime owner/buyback/burn/slash totals.',
    inputSchema: { type: 'object', required: ['agent_id'], properties: { agent_id: { type: 'string' } } },
  },
  {
    name: 'vouch_inference_offers',
    description: 'List bonded inference offers (model, price per million input/output tokens, speed terms, context, privacy, declared source, audit record), cheapest first. Filter by model.',
    inputSchema: { type: 'object', properties: { model: { type: 'string' }, provider: { type: 'string' } } },
  },
  {
    name: 'vouch_price_book',
    description: 'The price book: per model, the cheapest bonded offer with its provider, track, audit record and declared source.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'vouch_compute_balance',
    description: 'Read this account\'s compute balance (for an agent key) or escrow balance, with inference spend by day and model.',
    inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
  },
  {
    name: 'vouch_set_top_up',
    description: 'Set a launched agent\'s compute top-up rule: while its compute balance is under `threshold`, `share` of each settled job\'s net payout moves into it from the owner\'s share (owner key only, share within the cap).',
    inputSchema: { type: 'object', required: ['agent_id'], properties: { agent_id: { type: 'string' }, threshold: { type: 'number' }, share: { type: 'number' } } },
  },
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, X-Admin-Token',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '600',
};

export function createMcp(engine, { limit } = {}) {
  const asObject = (v, what) => {
    if (v === undefined || v === null) return {};
    if (typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'invalid_input', `${what} must be an object`);
    return v;
  };

  async function callTool(key, name, args = {}) {
    const a = asObject(args, 'arguments');
    switch (name) {
      case 'vouch_find_offers': return { offers: engine.offers(a) };
      case 'vouch_post_task': return engine.createTask(key, a).task;
      case 'vouch_task_status': return engine.getTask(key, a.task_id);
      case 'vouch_dispute': return engine.openDispute(key, a.task_id, a);
      case 'vouch_dispute_status': return engine.getDispute(key, a.dispute_id);
      case 'vouch_balance': return engine.balance(key);
      case 'vouch_verify': return engine.verifyOutput(key, a);
      case 'vouch_create_workflow': return engine.createWorkflow(key, a);
      case 'vouch_workflow_status': return engine.getWorkflow(key, a.workflow_id);
      case 'vouch_list_providers': return { providers: engine.listProviders() };
      case 'vouch_list_agents': return { agents: engine.listAgents() };
      case 'vouch_get_agent': return engine.getAgent(a.agent_id);
      case 'vouch_get_attestation': return engine.getAttestation(key, a.task_id);
      case 'vouch_create_subkey': return engine.createSubKey(key, a);
      case 'vouch_list_subkeys': return { sub_keys: engine.listSubKeys(key) };
      case 'vouch_freeze_subkey': return engine.freezeSubKey(key, a.sub_key_id, a.frozen === undefined ? true : a.frozen === true);
      case 'vouch_revoke_subkey': return engine.revokeSubKey(key, a.sub_key_id);
      case 'vouch_inference_offers': return { offers: engine.listInferenceOffers({ model: a.model, provider: a.provider }) };
      case 'vouch_price_book': return { models: engine.priceBook() };
      case 'vouch_compute_balance': return engine.inferenceUsage(key, { days: a.days || 30 });
      case 'vouch_set_top_up': return engine.setTopUpRule(a.agent_id, a, { key });
      default: throw new ApiError(404, 'unknown_tool', `No tool "${name}".`);
    }
  }

  return async function handle(req, res) {
    const reply = (body, headers = {}) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS, ...headers });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    if (req.method === 'GET') {
      return reply({ name: 'vouch', transport: 'streamable-http', endpoint: '/mcp', hint: 'POST JSON-RPC 2.0 here' });
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST, OPTIONS', ...CORS });
      return res.end();
    }

    let rpc;
    try { rpc = await readBody(req); }
    catch { return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }

    const { id = null, method, params = {} } = rpc ?? {};
    const ok = (result, headers) => reply({ jsonrpc: '2.0', id, result }, headers);
    const err = (code, message, data) => reply({ jsonrpc: '2.0', id, error: { code, message, data } });
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};

    try {
      switch (method) {
        case 'initialize':
          return ok({
            protocolVersion: p.protocolVersion ?? '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'vouch', version: '0.1.0' },
          });
        case 'notifications/initialized':
          res.writeHead(202, CORS); return res.end();
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: TOOLS });
        case 'tools/call': {
          const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '');
          const key = engine.authenticate(m?.[1] ?? '');
          const rl = limit ? limit(key) : {};
          const result = await callTool(key, p.name, p.arguments);
          return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }, rl);
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
      console.error('vouch: mcp call failed:', e);
      return err(-32603, 'Internal error');
    }
  };
}

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);
