// Real model execution. When ANTHROPIC_API_KEY is configured, native
// providers do actual work through Claude instead of the deterministic
// sandbox simulator. Returns null for anything it can't serve (unsupported
// capability, no key, or an API error) so the caller falls back to the
// simulator — the sandbox stays fully offline and tests stay deterministic.
//
// Mirrors the request shape in grader.js. api.anthropic.com is reachable in
// most environments (it is on the proxy allowlist); the executor's own timeout
// keeps a slow model from blowing the task deadline.

const SPECS = {
  'text.generate': {
    max_tokens: 1024,
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
};

export async function claudeExecute(task, cfg) {
  const spec = SPECS[task.capability];
  if (!spec || !cfg.anthropicKey) return null;
  const prompt = spec.user(task.input);
  if (!prompt) return null;

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), cfg.execTimeoutMs ?? 60000);
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
        model: cfg.execModel || cfg.graderModel,
        max_tokens: spec.max_tokens,
        system: spec.system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body.stop_reason === 'refusal') return null;
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return text ? spec.wrap(text) : null;
  } catch {
    return null; // fall back to the simulator on any error/timeout
  } finally {
    clearTimeout(timeout);
  }
}
