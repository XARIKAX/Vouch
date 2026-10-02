import vm from 'node:vm';
import { validateOutput, primaryValue } from './catalog.js';
import { hash01 } from './util.js';
import { claudeGrade } from './grader.js';
import { fetchImage } from './image.js';
import { assertPublicUrl, fetchWithTimeout, OUTBOUND_TIMEOUT_MS } from './netguard.js';

// ---------------------------------------------------------------------------
// Verification pipeline: schema → checks → rubric → webhook.
// First failure stops the pipeline; nothing settles without a full pass.
// Returns { pass, verified_by: [...], failed?: { validator, detail, criteria_error? } }.
// `criteria_error` marks a failure caused by the buyer's own acceptance
// criteria (a check that could not run), never by the provider's output.
// ---------------------------------------------------------------------------

export const KNOWN_ASSERTS = new Set([
  'length_between', 'contains_none', 'contains_all', 'regex', 'equals', 'links_resolve',
  'word_count', 'numeric_between', 'one_of', 'json_parseable',
]);

// Regex guard rails: pattern and subject are size-capped, patterns with
// nested quantifiers (the classic catastrophic-backtracking shape) are
// refused up front, and the match runs under a hard CPU timeout.
export const REGEX_MAX_PATTERN = 200;
export const REGEX_MAX_TEXT = 20000;
export const REGEX_TIMEOUT_MS = 250;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,?\d*\})\??(?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,?\d*\})/;

export function regexProblem(pattern) {
  if (typeof pattern !== 'string' || !pattern.length) return 'pattern must be a non-empty string';
  if (pattern.length > REGEX_MAX_PATTERN) return `pattern longer than ${REGEX_MAX_PATTERN} characters`;
  if (NESTED_QUANTIFIER.test(pattern)) return 'pattern has nested quantifiers (catastrophic backtracking risk)';
  try { new RegExp(pattern); } catch { return `invalid pattern "${pattern}"`; }
  return null;
}

// Run re.test(text) in a vm context with a timeout. V8 interrupts regex
// execution on termination, so a pathological match ends after the budget.
export function safeRegexTest(re, text) {
  const ctx = vm.createContext({ re, text: String(text).slice(0, REGEX_MAX_TEXT) });
  return vm.runInContext('re.test(text)', ctx, { timeout: REGEX_TIMEOUT_MS });
}

const atPath = (output, path) => (path ? output?.[path] : undefined);
const textOf = (task, output) => {
  const v = primaryValue(task.capability, output);
  return typeof v === 'string' ? v : JSON.stringify(output ?? '');
};
const LINKS_MAX = 10;

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
      return hit !== undefined ? `output contains forbidden value "${hit}"` : null;
    }
    case 'contains_all': {
      const missing = (check.values || []).find((v) => !text.toLowerCase().includes(String(v).toLowerCase()));
      return missing !== undefined ? `output missing required value "${missing}"` : null;
    }
    case 'regex': {
      const problem = regexProblem(check.pattern);
      if (problem) return problem;
      let ok;
      try { ok = safeRegexTest(new RegExp(check.pattern), text); }
      catch { return `pattern /${check.pattern}/ exceeded the ${REGEX_TIMEOUT_MS} ms match budget`; }
      return ok ? null : `output does not match /${check.pattern}/`;
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
      try { parsed = typeof src === 'object' && src !== null ? src : JSON.parse(String(src)); }
      catch { return 'output is not valid JSON'; }
      for (const key of check.has ?? []) {
        if (parsed === null || typeof parsed !== 'object' || !(key in parsed)) return `parsed JSON missing key "${key}"`;
      }
      return null;
    }
    case 'links_resolve': {
      const urls = [...text.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)].map((m) => m[0]);
      if (urls.length > LINKS_MAX) return `output has ${urls.length} links; links_resolve checks at most ${LINKS_MAX}`;
      for (const url of urls) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), cfg.linkTimeoutMs ?? 4000);
        try {
          const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
          if (!res.ok && res.status !== 405) return `link ${url} returned ${res.status}`;
        } catch {
          return `link ${url} did not resolve`;
        } finally {
          clearTimeout(t);
        }
      }
      return null;
    }
    default:
      return `unknown assert "${check.assert}"`;
  }
}

// Rubric panel: three independent graders, majority wins. Grader resolution:
//   1. VOUCH_GRADER_URL      — your own endpoint ({input, output, rubric, grader, context} -> {pass})
//   2. ANTHROPIC_API_KEY + VOUCH_GRADER_MODEL — a model judge panel (three personas, see grader.js)
//   3. deterministic heuristic — offline fallback so the stack runs anywhere
// `context` carries dispute material (reason + evidence) on a re-review; every
// grader backend receives it.
async function gradeOnce(task, output, rubric, graderIdx, cfg, context = null, diag = null) {
  if (!cfg.graderUrl && cfg.anthropicKey && cfg.graderModel) {
    return claudeGrade(task, output, rubric, graderIdx, cfg, context, diag);
  }
  if (cfg.graderUrl) {
    try {
      const res = await fetchWithTimeout(cfg.graderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: task.input, output, rubric, grader: graderIdx, ...(context ? { context } : {}) }),
      }, cfg.graderTimeoutMs ?? OUTBOUND_TIMEOUT_MS);
      const body = await res.json();
      return !!body.pass;
    } catch (e) {
      diag?.errors?.push(`grader webhook: ${e.message}`);
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
  // Deterministic per-grader jitter stands in for model disagreement (rare:
  // a single seat dissents on ~0.5% of tasks; the majority still passes).
  return hash01(task.id + 'grader' + graderIdx) > 0.005;
}

// `errors` lists why grader seats could not vote (API errors, timeouts), so a
// refund caused by an unreachable judge says so instead of looking like a
// quality verdict.
export async function gradeRubric(task, output, rubric, cfg, seedOffset = 0, context = null) {
  const votes = [];
  const diag = { errors: [] };
  for (let g = 0; g < 3; g++) votes.push(await gradeOnce(task, output, rubric, (g + seedOffset) % 3, cfg, context, diag));
  const passes = votes.filter(Boolean).length;
  return { pass: passes >= 2, passes, errors: [...new Set(diag.errors)] };
}

export async function verify(task, output, cfg, context = null) {
  const verifiedBy = [];

  const schema = validateOutput(task.capability, output ?? {});
  if (!schema.ok) {
    return { pass: false, verified_by: verifiedBy, failed: { validator: 'schema', detail: schema.detail } };
  }
  verifiedBy.push('schema');

  // A generated image must really exist: fetch it (bounded), require an
  // image content type, and hand the bytes to the rubric graders so a
  // vision-capable panel judges the picture itself, not its URL.
  if (task.capability === 'image.generate' && task.execution?.mode === 'image') {
    const img = await fetchImage(String(output.url), { timeoutMs: cfg.imageFetchTimeoutMs ?? 40000 });
    if (!img.ok) return { pass: false, verified_by: verifiedBy, failed: { validator: 'image', detail: img.error } };
    verifiedBy.push('image');
    context = { ...(context ?? {}), image: { media_type: img.media_type, bytes: img.bytes } };
  }

  for (const check of task.acceptance?.checks ?? []) {
    let failure;
    try {
      failure = await runCheck(check, task, output, cfg);
    } catch (e) {
      // The check itself could not run: a buyer-side criteria problem, never
      // the provider's fault. Reported as such so the engine refunds without
      // slashing.
      return {
        pass: false, verified_by: verifiedBy,
        failed: { validator: `checks.${check.assert}`, detail: `check could not run: ${e.message}`, criteria_error: true },
      };
    }
    if (failure) {
      return { pass: false, verified_by: verifiedBy, failed: { validator: `checks.${check.assert}`, detail: failure } };
    }
  }
  if (task.acceptance?.checks?.length) verifiedBy.push('checks');

  if (task.acceptance?.rubric) {
    const { pass, passes, errors } = await gradeRubric(task, output, task.acceptance.rubric, cfg, 0, context);
    if (!pass) {
      const why = errors?.length ? `; grader errors: ${errors.join('; ')}` : '';
      return {
        pass: false, verified_by: verifiedBy,
        failed: { validator: 'rubric', detail: `graders voted ${passes}/3 against the rubric${why}` },
      };
    }
    verifiedBy.push(`rubric:${passes}/3`);
  }

  if (task.acceptance?.webhook) {
    try {
      const res = await fetchWithTimeout(task.acceptance.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_id: task.id, capability: task.capability, output, ...(context ? { context } : {}) }),
      }, cfg.webhookTimeoutMs ?? OUTBOUND_TIMEOUT_MS);
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

// ---- acceptance validation (400 on bad criteria) --------------------------
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPrimitive = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function checkProblem(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'each check must be an object';
  if (!KNOWN_ASSERTS.has(c.assert)) return `unknown assert "${c?.assert}" — known: ${[...KNOWN_ASSERTS].join(', ')}`;
  const at = `checks.${c.assert}`;
  if (c.path !== undefined && typeof c.path !== 'string') return `${at}.path must be a string`;
  for (const k of ['min', 'max', 'tolerance']) {
    if (c[k] !== undefined && !isNum(c[k])) return `${at}.${k} must be a number`;
  }
  if (c.min !== undefined && c.max !== undefined && c.min > c.max) return `${at}: min exceeds max`;
  switch (c.assert) {
    case 'contains_none':
    case 'contains_all':
    case 'one_of':
      if (!Array.isArray(c.values) || !c.values.every(isPrimitive)) return `${at}.values must be an array of strings or numbers`;
      if (!c.values.length) return `${at}.values must not be empty`;
      break;
    case 'regex': {
      const p = regexProblem(c.pattern);
      if (p) return `${at}.pattern: ${p}`;
      break;
    }
    case 'equals':
      if (!('value' in c)) return `${at}.value is required`;
      if (typeof c.path !== 'string') return `${at}.path is required`;
      if (c.value !== null && typeof c.value === 'object') return `${at}.value must be a string, number, boolean or null`;
      break;
    case 'json_parseable':
      if (c.has !== undefined && (!Array.isArray(c.has) || !c.has.every((k) => typeof k === 'string'))) return `${at}.has must be an array of key names`;
      break;
    case 'length_between':
    case 'word_count':
    case 'numeric_between':
      if (c.min === undefined && c.max === undefined) return `${at} needs min and/or max`;
      break;
    default:
      break;
  }
  return null;
}

export function validateAcceptance(acceptance, cfg = {}) {
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
    if (acceptance.checks.length > 32) return { ok: false, detail: 'acceptance.checks is capped at 32 checks' };
    for (const c of acceptance.checks) {
      const problem = checkProblem(c);
      if (problem) return { ok: false, detail: problem };
    }
  }
  if (acceptance.rubric !== undefined && typeof acceptance.rubric !== 'string') {
    return { ok: false, detail: 'acceptance.rubric must be a string' };
  }
  if (acceptance.webhook !== undefined) {
    try { assertPublicUrl(acceptance.webhook, 'acceptance.webhook', { allowPrivate: !!cfg.allowPrivateWebhooks }); }
    catch (e) { return { ok: false, detail: e.message }; }
  }
  return { ok: true };
}
