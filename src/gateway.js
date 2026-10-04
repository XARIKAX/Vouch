// The OpenAI-compatible gateway: chat completions, streaming, tool calls.
// Model names pass through unchanged. Each call is routed to the cheapest
// admissible offer, proxied, checked inline, and billed on the gateway's own
// token count. A call that fails before any token reaches the client is
// retried on the next offer inside the buyer's timeout; a failed call is
// never billed. Prompts and responses pass through and are never stored.
import { ApiError } from './errors.js';

const PASS = ['model', 'messages', 'temperature', 'top_p', 'n', 'stop', 'max_tokens', 'max_completion_tokens', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'user', 'tools', 'tool_choice', 'response_format', 'seed', 'stream', 'stream_options', 'parallel_tool_calls'];
const DEFAULT_MAX_OUT = 1024;

export function createGateway(engine) {
  const inf = engine.inference;

  function parseBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'invalid_input', 'body must be a JSON object');
    const model = String(body.model ?? '').trim();
    if (!model) throw new ApiError(400, 'invalid_input', 'model is required');
    if (!Array.isArray(body.messages) || !body.messages.length) throw new ApiError(400, 'invalid_input', 'messages must be a non-empty array');
    const prefs = body.vouch && typeof body.vouch === 'object' ? body.vouch : {};
    const upstream = {}; for (const k of PASS) if (body[k] !== undefined) upstream[k] = body[k];
    const maxOut = Number(body.max_completion_tokens ?? body.max_tokens) || DEFAULT_MAX_OUT;
    const tokensIn = inf.counts.messages(body.messages, Array.isArray(body.tools) ? body.tools : []);
    return { model, prefs, upstream, maxOut, tokensIn, stream: body.stream === true, timeoutMs: Math.min(120000, Math.max(2000, Number(prefs.timeout_ms) || 60000)) };
  }

  // policy: a frozen or revoked key cannot call; an allowlisted key needs inference.*
  function policy(key, est) {
    if (key.revoked) throw new ApiError(403, 'account_revoked', 'This key has been revoked.');
    if (key.frozen) throw new ApiError(403, 'account_frozen', 'This agentic account is frozen.');
    if (key.allow && !key.allow.some((a) => a === 'inference.chat' || a === 'inference.*' || a === '*')) throw new ApiError(403, 'capability_not_allowed', 'This account may not buy inference.', { allow: key.allow });
    if (key.perTaskCap != null && est > key.perTaskCap) throw new ApiError(403, 'per_task_cap_exceeded', `This call could cost up to $${est}, over the account's per-call cap of $${key.perTaskCap}.`, { per_task_cap: key.perTaskCap });
  }

  const upstreamHeaders = (o) => ({ 'Content-Type': 'application/json', ...(o.upstream_key ? { Authorization: `Bearer ${o.upstream_key}` } : {}), 'X-Vouch-Offer': o.id });

  // One non-streaming attempt against an offer. Returns { ok, message, finish_reason, reported, ttft_ms, tps, tokensOut, body } or { ok:false, reason }.
  async function attempt(o, upstream, timeoutMs) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(`${o.endpoint_url}/chat/completions`, { method: 'POST', headers: upstreamHeaders(o), body: JSON.stringify({ ...upstream, model: o.model, stream: false }), signal: ctrl.signal });
      const ttft_ms = Date.now() - t0;
      if (!res.ok) return { ok: false, reason: `upstream ${res.status}`, ttft_ms };
      const body = await res.json();
      const total = Date.now() - t0;
      const choice = body?.choices?.[0];
      const message = choice?.message, finish_reason = choice?.finish_reason;
      const tokensOut = inf.counts.completion(message);
      const gen = Math.max(1, total - ttft_ms);
      const tps = tokensOut >= 24 ? tokensOut / (gen / 1000) : null;
      return { ok: true, message, finish_reason, reported: body?.usage ?? null, ttft_ms, tps, tokensOut, body, total };
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'timed out' : `unreachable: ${e.message}`, ttft_ms: Date.now() - t0 };
    } finally { clearTimeout(timer); }
  }

  // The whole call, non-streaming: route, reserve, attempt, check, bill or strike and retry.
  async function complete(key, body, { payer = 'account' } = {}) {
    const req = parseBody(body);
    const { candidates, rejected } = inf.route({ model: req.model, tokensIn: req.tokensIn, maxOut: req.maxOut, prefs: req.prefs });
    if (!candidates.length) throw new ApiError(409, 'no_offers', `No admissible offer for "${req.model}".`, { rejected });
    const deadline = Date.now() + req.timeoutMs;
    const failures = [];
    for (const { offer: o, est } of candidates) {
      if (Date.now() >= deadline) break;
      let release = () => {};
      if (payer !== 'treasury') { policy(key, est); release = inf.reserve(key, est); }
      const a = await attempt(o, req.upstream, Math.max(1000, deadline - Date.now()));
      release();
      if (!a.ok) { inf.strike(o, a.reason, { ttft_ms: a.ttft_ms }); failures.push({ offer: o.id, reason: a.reason }); continue; }
      const bad = inf.inlineCheck(o, a);
      inf.noteSpeed(o, inf.speedMissed(o, a));
      if (bad) { inf.strike(o, bad, { ttft_ms: a.ttft_ms, tps: a.tps }); failures.push({ offer: o.id, reason: bad }); continue; }
      const billed = inf.bill({ key, payer, offer: o, tokensIn: req.tokensIn, tokensOut: a.tokensOut, reported: a.reported, ttft_ms: a.ttft_ms, tps: a.tps });
      const verdict = inf.evaluate(o);
      const out = { ...a.body, usage: { prompt_tokens: req.tokensIn, completion_tokens: a.tokensOut, total_tokens: req.tokensIn + a.tokensOut, reported: a.reported ?? null }, vouch: { call_id: billed.id, provider: o.provider, offer: o.id, model: o.model, cost: billed.cost, fee: billed.fee, ttft_ms: a.ttft_ms, tps: billed.tps, retries: failures.length, ...(verdict ? { verdict } : {}) } };
      if (payer !== 'treasury' && inf.wantsCanary(o)) inf.track(canary(o)).catch(() => {});
      return { status: 200, body: out };
    }
    throw new ApiError(502, 'all_offers_failed', `Every admissible offer failed; nothing was billed.`, { failures, rejected });
  }

  // Streaming: proxy SSE chunks as they arrive. Before the first token a
  // failure retries the next offer; after it, the stream ends with an error
  // event and nothing is billed.
  async function stream(key, body, res) {
    const req = parseBody(body);
    const { candidates, rejected } = inf.route({ model: req.model, tokensIn: req.tokensIn, maxOut: req.maxOut, prefs: req.prefs });
    if (!candidates.length) throw new ApiError(409, 'no_offers', `No admissible offer for "${req.model}".`, { rejected });
    const deadline = Date.now() + req.timeoutMs;
    const failures = [];
    let started = false;
    const begin = () => { if (started) return; started = true; res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' }); };
    for (const { offer: o, est } of candidates) {
      if (Date.now() >= deadline) break;
      policy(key, est);
      const release = inf.reserve(key, est);
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now()));
      const t0 = Date.now();
      let first = 0, content = '', toolArgs = '', finish = null, reported = null, chunks = 0;
      try {
        const up = await fetch(`${o.endpoint_url}/chat/completions`, { method: 'POST', headers: upstreamHeaders(o), body: JSON.stringify({ ...req.upstream, model: o.model, stream: true, stream_options: { include_usage: true } }), signal: ctrl.signal });
        if (!up.ok || !up.body) { release(); inf.strike(o, `upstream ${up.status}`); failures.push({ offer: o.id, reason: `upstream ${up.status}` }); continue; }
        const reader = up.body.getReader(), dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let j; try { j = JSON.parse(data); } catch { continue; }
            const d = j?.choices?.[0]?.delta;
            if (d?.content) { if (!first) first = Date.now(); content += d.content; }
            if (Array.isArray(d?.tool_calls)) { if (!first) first = Date.now(); for (const c of d.tool_calls) toolArgs += (c?.function?.name ?? '') + (c?.function?.arguments ?? ''); }
            if (j?.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
            if (j?.usage) reported = j.usage;
            begin(); res.write(`data: ${data}\n\n`); chunks++;
          }
        }
      } catch (e) {
        release();
        const reason = e.name === 'AbortError' ? 'timed out' : `unreachable: ${e.message}`;
        inf.strike(o, reason); failures.push({ offer: o.id, reason });
        if (first) { res.write(`data: ${JSON.stringify({ error: { code: 'upstream_failed', message: reason, billed: false } })}\n\ndata: [DONE]\n\n`); res.end(); return; }
        continue;
      } finally { clearTimeout(timer); }
      release();
      const total = Date.now() - t0, ttft_ms = (first || Date.now()) - t0;
      const tokensOut = inf.counts.text(content) + inf.counts.text(toolArgs);
      const gen = Math.max(1, total - ttft_ms), tps = tokensOut >= 24 ? tokensOut / (gen / 1000) : null;
      const message = { content, ...(toolArgs ? { tool_calls: [{ function: { name: '', arguments: toolArgs } }] } : {}) };
      const bad = inf.inlineCheck(o, { message, finish_reason: finish ?? (content || toolArgs ? 'stop' : null), ttft_ms, tps, tokensOut, reported, stream: true });
      inf.noteSpeed(o, inf.speedMissed(o, { ttft_ms, tps, tokensOut }));
      if (bad) {
        inf.strike(o, bad, { ttft_ms, tps }); failures.push({ offer: o.id, reason: bad });
        if (chunks) { res.write(`: vouch ${JSON.stringify({ billed: false, reason: bad })}\n\ndata: [DONE]\n\n`); res.end(); return; }
        continue;
      }
      const billed = inf.bill({ key, payer: 'account', offer: o, tokensIn: req.tokensIn, tokensOut, reported, ttft_ms, tps });
      inf.evaluate(o);
      begin();
      res.write(`: vouch ${JSON.stringify({ call_id: billed.id, provider: o.provider, offer: o.id, cost: billed.cost, fee: billed.fee, usage: { prompt_tokens: req.tokensIn, completion_tokens: tokensOut }, ttft_ms, tps: billed.tps })}\n\ndata: [DONE]\n\n`);
      res.end();
      if (inf.wantsCanary(o)) inf.track(canary(o)).catch(() => {});
      return;
    }
    throw new ApiError(502, 'all_offers_failed', 'Every admissible offer failed; nothing was billed.', { failures, rejected });
  }

  // A canary: one of the fixed prompts at temperature zero, paid by the
  // treasury, compared with the reference host for that model when one is
  // configured. Indistinguishable from a real call to the provider.
  async function canary(o) {
    const prompt = inf.canaryPrompt(o);
    const upstream = { model: o.model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 64 };
    const a = await attempt(o, upstream, 30000);
    if (!a.ok) return inf.recordCanary(o, false, a.reason);
    const bad = inf.inlineCheck(o, a);
    if (bad) return inf.recordCanary(o, false, bad);
    inf.bill({ key: null, payer: 'treasury', offer: o, tokensIn: inf.counts.messages(upstream.messages), tokensOut: a.tokensOut, reported: a.reported, ttft_ms: a.ttft_ms, tps: a.tps, canary: true });
    const ref = inf.referenceFor(o.model);
    if (!ref) return inf.recordCanary(o, true, 'no reference host: speed and shape only');
    try {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 30000);
      const r = await fetch(`${ref.endpoint_url.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ref.api_key ? { Authorization: `Bearer ${ref.api_key}` } : {}) }, body: JSON.stringify({ ...upstream, stream: false }), signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return inf.recordCanary(o, true, `reference unavailable (${r.status})`);
      const rb = await r.json();
      const sim = inf.similar(a.message?.content, rb?.choices?.[0]?.message?.content);
      return inf.recordCanary(o, sim >= 0.6, sim >= 0.6 ? 'matches reference' : `differs from reference (similarity ${sim.toFixed(2)})`);
    } catch (e) { return inf.recordCanary(o, true, `reference unreachable: ${e.message}`); }
  }

  return { complete, stream, canary, parseBody };
}
