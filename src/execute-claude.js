// Real model execution. When ANTHROPIC_API_KEY and a model (VOUCH_EXEC_MODEL
// or VOUCH_GRADER_MODEL) are configured, native providers do actual work
// through the model instead of the deterministic sandbox simulator. Returns
// null for anything it can't serve (unsupported capability, no key, no model,
// or an API error) so the caller falls back to the simulator — the sandbox
// stays fully offline and tests stay deterministic.
//
// Mirrors the request shape in grader.js. api.anthropic.com is reachable in
// most environments (it is on the proxy allowlist); the executor's own timeout
// keeps a slow model from blowing the task deadline.

const stripFences = (t) => t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

const SPECS = {
  'text.generate': {
    max_tokens: 700,
    system: 'You are a capable assistant fulfilling a paid task. Respond directly and substantively to the request. No preamble, no meta-commentary, no filler — deliver the work itself.',
    user: (input) => String(input?.prompt ?? ''),
    wrap: (text) => ({ text }),
  },
  'text.summarize': {
    max_tokens: 512,
    system: 'You summarize the user\'s text faithfully and concisely. Preserve the key claims; add nothing. Return only the summary.',
    user: (input) => String(input?.text ?? ''),
    wrap: (text) => ({ summary: text }),
  },
  'code.generate': {
    max_tokens: 1500,
    system: 'You are an expert programmer. Return only the code that fulfills the request — no explanation, no markdown fences.',
    user: (input) => (input?.language ? `Language: ${input.language}\n\n` : '') + String(input?.prompt ?? ''),
    wrap: (text) => ({ code: stripFences(text) }),
  },
  'translate.text': {
    max_tokens: 1024,
    system: 'You are a professional translator. Return only the translation — no notes, no original text.',
    user: (input) => `Translate the following into ${input?.target_lang ?? 'English'}:\n\n${String(input?.text ?? '')}`,
    wrap: (text) => ({ translation: text }),
  },
  'extract.structured': {
    max_tokens: 1024,
    system: 'Extract the requested information as a single valid JSON object. Return only JSON — no markdown, no commentary.',
    user: (input) => (input?.fields ? `Extract these fields: ${input.fields}\n\n` : 'Extract the key facts.\n\n') + `Text:\n${String(input?.text ?? '')}`,
    wrap: (text) => { try { return { data: JSON.parse(stripFences(text)) }; } catch { return null; } },
  },
  'classify.text': {
    max_tokens: 32,
    system: 'Classify the text into exactly one of the given labels. Reply with only the chosen label, verbatim: no punctuation, no quotes, no explanation.',
    user: (input) => `Labels: ${JSON.stringify(input?.labels ?? [])}\n\nText:\n${String(input?.text ?? '')}`,
    wrap: (text, input) => ({ label: matchLabel(text, input?.labels) }),
  },
};

// A model asked for a verbatim label still answers "Positive." or
// "**positive**" now and then. When the reply clearly names exactly one of the
// offered labels, return that label as the buyer spelled it, so a strict
// one_of check judges the classification and not the punctuation. Anything
// ambiguous is returned as-is and fails verification honestly.
export function matchLabel(text, labels) {
  const raw = String(text).trim();
  if (!Array.isArray(labels) || !labels.length) return raw;
  const fold = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const exact = labels.find((l) => String(l) === raw);
  if (exact !== undefined) return String(exact);
  const folded = fold(raw);
  const loose = labels.find((l) => fold(l) === folded);
  if (loose !== undefined) return String(loose);
  const named = labels.filter((l) => fold(l) && ` ${folded} `.includes(` ${fold(l)} `));
  if (named.length === 1) return String(named[0]);
  return raw;
}

// Capabilities a native provider serves through the model when one is configured.
export const MODEL_CAPABILITIES = new Set(Object.keys(SPECS));

// True when native providers will execute through the model for this capability.
export const modelBacked = (cfg, capability) =>
  !!(cfg.anthropicKey && (cfg.execModel || cfg.graderModel) && MODEL_CAPABILITIES.has(capability));

// A short, secret-free description of a failed API response: the status
// plus the API's own error message ("model: x not found", "invalid x-api-key").
export async function describeApiError(res) {
  let msg = '';
  try { const j = await res.json(); msg = j?.error?.message || j?.error?.type || ''; } catch { /* no JSON body */ }
  return `${res.status}${msg ? ' ' + String(msg).slice(0, 240) : ''}`;
}

// `diag.error` receives why the model did not answer (the caller records it
// on the task) so a fallback to the simulator is never silent.
export async function claudeExecute(task, cfg, diag = {}) {
  const spec = SPECS[task.capability];
  const model = cfg.execModel || cfg.graderModel;
  if (!spec || !cfg.anthropicKey || !model) return null;
  const prompt = spec.user(task.input);
  if (!prompt) return null;

  // Never wait longer than the quote the provider committed to.
  const budget = Math.min(cfg.execTimeoutMs ?? 60000, Number(task.quote?.deadline_ms) || 60000);
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), budget);
  try {
    const res = await fetch(`${cfg.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: spec.max_tokens,
        system: spec.system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) { diag.error = `model API ${await describeApiError(res)}`; return null; }
    const body = await res.json();
    if (body.stop_reason === 'refusal') { diag.error = 'model refused the request'; return null; }
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) { diag.error = 'model returned no text'; return null; }
    const out = spec.wrap(text, task.input);
    if (!out) diag.error = 'model output could not be parsed';
    return out;
  } catch (e) {
    // fall back to the simulator on any error/timeout, and say why
    diag.error = e.name === 'AbortError' ? `model call timed out after ${budget} ms` : `model API unreachable: ${e.message}`;
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// One minimal call (max_tokens 1) to confirm the key and model actually
// work. Used by GET /v1/status?probe=1 so a wrong model id or a rejected key
// shows up as text instead of as silent simulator fallbacks.
export async function probeModel(cfg, model) {
  if (!cfg.anthropicKey) return { ok: false, model: model ?? null, error: 'no API key configured' };
  if (!model) return { ok: false, model: null, error: 'no model configured' };
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), cfg.probeTimeoutMs ?? 15000);
  try {
    const res = await fetch(`${cfg.anthropicBaseUrl}/v1/messages`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    if (!res.ok) return { ok: false, model, status: res.status, error: await describeApiError(res), ms: Date.now() - t0 };
    return { ok: true, model, status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, model, error: e.name === 'AbortError' ? 'timed out' : `unreachable: ${e.message}`, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timeout);
  }
}
