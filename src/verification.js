import { validateOutput, primaryValue } from './catalog.js';
import { hash01 } from './util.js';
import { claudeGrade } from './grader.js';

// ---------------------------------------------------------------------------
// Verification pipeline: schema → checks → rubric → webhook.
// First failure stops the pipeline; nothing settles without a full pass.
// Returns { pass, verified_by: [...], failed?: { validator, detail } }.
// ---------------------------------------------------------------------------

export const KNOWN_ASSERTS = new Set([
  'length_between', 'contains_none', 'contains_all', 'regex', 'equals', 'links_resolve',
  'word_count', 'numeric_between', 'one_of', 'json_parseable',
]);

const atPath = (output, path) => (path ? output?.[path] : undefined);
const textOf = (task, output) => {
  const v = primaryValue(task.capability, output);
  return typeof v === 'string' ? v : JSON.stringify(output ?? '');
};

async function runCheck(check, task, output, cfg) {
  const text = check.path !== undefined ? String(atPath(output, check.path) ?? '') : textOf(task, output);
  switch (check.assert) {
    case 'length_between': {
      const len = text.length;
      if (check.min !== undefined && len < check.min) return `length ${len} < min ${check.min}`;
      if (check.max !== undefined && len > check.max) return `length ${len} > max ${check.max}`;
      return null;
    }
    case 'contains_none': {
      const hit = (check.values || []).find((v) => text.toLowerCase().includes(String(v).toLowerCase()));
      return hit ? `output contains forbidden value "${hit}"` : null;
    }
    case 'contains_all': {
      const missing = (check.values || []).find((v) => !text.toLowerCase().includes(String(v).toLowerCase()));
      return missing ? `output missing required value "${missing}"` : null;
    }
    case 'regex': {
      let re;
      try { re = new RegExp(check.pattern); } catch { return `invalid pattern "${check.pattern}"`; }
      return re.test(text) ? null : `output does not match /${check.pattern}/`;
    }
    case 'equals': {
      const actual = atPath(output, check.path);
      const tol = check.tolerance ?? 1e-9;
      const ok = typeof check.value === 'number' && typeof actual === 'number'
        ? Math.abs(actual - check.value) <= tol
        : actual === check.value;
      return ok ? null : `expected ${check.path}=${JSON.stringify(check.value)}, got ${JSON.stringify(actual)}`;
    }
    case 'word_count': {
      const words = text.trim().split(/\s+/).filter(Boolean).length;
      if (check.min !== undefined && words < check.min) return `word count ${words} < min ${check.min}`;
      if (check.max !== undefined && words > check.max) return `word count ${words} > max ${check.max}`;
      return null;
    }
    case 'numeric_between': {
      const actual = check.path !== undefined ? atPath(output, check.path) : Number(text);
      if (typeof actual !== 'number' || !Number.isFinite(actual)) return `value at "${check.path ?? 'output'}" is not numeric`;
      if (check.min !== undefined && actual < check.min) return `value ${actual} < min ${check.min}`;
      if (check.max !== undefined && actual > check.max) return `value ${actual} > max ${check.max}`;
      return null;
    }
    case 'one_of': {
      const actual = check.path !== undefined ? atPath(output, check.path) : text;
      const set = check.values || [];
      return set.some((v) => v === actual) ? null : `value ${JSON.stringify(actual)} is not one of ${JSON.stringify(set)}`;
    }
    case 'json_parseable': {
      const src = check.path !== undefined ? atPath(output, check.path) : text;
      let parsed;
      try { parsed = typeof src === 'object' ? src : JSON.parse(String(src)); }
      catch { return 'output is not valid JSON'; }
      for (const key of check.has ?? []) {
        if (parsed == null || !(key in parsed)) return `parsed JSON missing key "${key}"`;
      }
      return null;
    }
    case 'links_resolve': {
      const urls = [...text.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)].map((m) => m[0]);
      for (const url of urls) {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), cfg.linkTimeoutMs ?? 4000);
          const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok && res.status !== 405) return `link ${url} returned ${res.status}`;
        } catch {
          return `link ${url} did not resolve`;
        }
      }
      return null;
    }
    default:
      return `unknown assert "${check.assert}"`;
  }
}

// Rubric panel: three independent graders, majority wins. Grader resolution:
//   1. VOUCH_GRADER_URL      — your own endpoint ({input, output, rubric, grader} -> {pass})
//   2. ANTHROPIC_API_KEY     — a Claude judge panel (three personas, see grader.js)
//   3. deterministic heuristic — offline fallback so the stack runs anywhere
async function gradeOnce(task, output, rubric, graderIdx, cfg) {
  if (!cfg.graderUrl && cfg.anthropicKey) {
    return claudeGrade(task, output, rubric, graderIdx, cfg);
  }
  if (cfg.graderUrl) {
    try {
      const res = await fetch(cfg.graderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: task.input, output, rubric, grader: graderIdx }),
      });
      const body = await res.json();
      return !!body.pass;
    } catch {
      return false; // an unreachable grader must not release funds
    }
  }
  const text = textOf(task, output);
  const minLen = [20, 30, 40][graderIdx];
  if (!text || text.length < minLen) return false;
  if (/###|\bERROR\b|lorem lorem/i.test(text)) return false;
  if (graderIdx > 0 && typeof primaryValue(task.capability, output) === 'string') {
    const promptWords = JSON.stringify(task.input).toLowerCase().match(/[a-z]{4,}/g) || [];
    const overlap = promptWords.some((w) => text.toLowerCase().includes(w));
    if (!overlap) return false;
  }
  // Deterministic per-grader jitter stands in for model disagreement.
  return hash01(task.id + 'grader' + graderIdx) > 0.02;
}

export async function gradeRubric(task, output, rubric, cfg, seedOffset = 0) {
  const votes = [];
  for (let g = 0; g < 3; g++) votes.push(await gradeOnce(task, output, rubric, (g + seedOffset) % 3, cfg));
  const passes = votes.filter(Boolean).length;
  return { pass: passes >= 2, passes };
}

export async function verify(task, output, cfg) {
  const verifiedBy = [];

  const schema = validateOutput(task.capability, output ?? {});
  if (!schema.ok) {
    return { pass: false, verified_by: verifiedBy, failed: { validator: 'schema', detail: schema.detail } };
  }
  verifiedBy.push('schema');

  for (const check of task.acceptance.checks ?? []) {
    const failure = await runCheck(check, task, output, cfg);
    if (failure) {
      return { pass: false, verified_by: verifiedBy, failed: { validator: `checks.${check.assert}`, detail: failure } };
    }
  }
  if (task.acceptance.checks?.length) verifiedBy.push('checks');

  if (task.acceptance.rubric) {
    const { pass, passes } = await gradeRubric(task, output, task.acceptance.rubric, cfg);
    if (!pass) {
      return {
        pass: false, verified_by: verifiedBy,
        failed: { validator: 'rubric', detail: `graders voted ${passes}/3 against the rubric` },
      };
    }
    verifiedBy.push(`rubric:${passes}/3`);
  }

  if (task.acceptance.webhook) {
    try {
      const res = await fetch(task.acceptance.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: task.id, capability: task.capability, output }),
      });
      const body = await res.json();
      if (!body.pass) {
        return {
          pass: false, verified_by: verifiedBy,
          failed: { validator: 'webhook', detail: body.reason || 'webhook validator returned pass=false' },
        };
      }
    } catch {
      return {
        pass: false, verified_by: verifiedBy,
        failed: { validator: 'webhook', detail: 'webhook validator unreachable' },
      };
    }
    verifiedBy.push('webhook');
  }

  return { pass: true, verified_by: verifiedBy };
}

export function validateAcceptance(acceptance) {
  if (acceptance === undefined) return { ok: true };
  if (acceptance === null || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
    return { ok: false, detail: 'acceptance must be an object' };
  }
  for (const key of Object.keys(acceptance)) {
    if (!['schema', 'checks', 'rubric', 'webhook'].includes(key)) {
      return { ok: false, detail: `unknown acceptance field "${key}"` };
    }
  }
  if (acceptance.checks !== undefined) {
    if (!Array.isArray(acceptance.checks)) return { ok: false, detail: 'acceptance.checks must be an array' };
    for (const c of acceptance.checks) {
      if (!c || !KNOWN_ASSERTS.has(c.assert)) {
        return { ok: false, detail: `unknown assert "${c?.assert}" — known: ${[...KNOWN_ASSERTS].join(', ')}` };
      }
    }
  }
  if (acceptance.rubric !== undefined && typeof acceptance.rubric !== 'string') {
    return { ok: false, detail: 'acceptance.rubric must be a string' };
  }
  if (acceptance.webhook !== undefined && !/^https?:\/\//.test(acceptance.webhook ?? '')) {
    return { ok: false, detail: 'acceptance.webhook must be an http(s) URL' };
  }
  return { ok: true };
}
