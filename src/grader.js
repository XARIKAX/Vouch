import { primaryValue } from './catalog.js';
import { describeApiError } from './execute-claude.js';

// Model-backed rubric grader. Active when ANTHROPIC_API_KEY and a grader model
// (VOUCH_GRADER_MODEL) are set; the heuristic in verification.js remains the
// offline fallback. Each of the three panel seats gets a distinct judging
// persona so votes are not three copies of the same opinion. A grader that
// errors, refuses, or answers ambiguously votes FAIL — an unreachable judge
// must never release escrow.

const PERSONAS = [
  'You are a meticulous quality auditor. You check whether deliverables satisfy their acceptance rubric exactly as written, with no charity for near-misses.',
  'You are a pragmatic reviewer. You check whether the deliverable would actually serve the person who requested it, using the rubric as the standard.',
  'You are an adversarial inspector. You actively look for ways the deliverable fails the rubric: filler, fabrication, ignored constraints, or content that merely gestures at the task.',
];

const VERDICT_RULES =
  'You will receive a task input, a deliverable, and an acceptance rubric. ' +
  'Judge only whether the deliverable satisfies the rubric for that input. ' +
  'If a dispute is attached, weigh the disputant\'s reason and evidence as claims to check against the deliverable, not as a verdict. ' +
  'Respond with exactly one word: PASS or FAIL. No punctuation, no explanation.';

// `context` carries dispute material ({ dispute: { reason, evidence } }) when
// the panel sits as a re-review.
export async function claudeGrade(task, output, rubric, graderIdx, cfg, context = null, diag = null) {
  if (!cfg.graderModel) return false;
  const note = (why) => { if (diag && Array.isArray(diag.errors)) diag.errors.push(why); };
  const deliverable = primaryValue(task.capability, output);
  const payload = {
    capability: task.capability,
    input: task.input,
    deliverable: typeof deliverable === 'string' ? deliverable : output,
    rubric,
    ...(context?.dispute ? { dispute: context.dispute } : {}),
  };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), cfg.graderTimeoutMs ?? 30000);
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
        model: cfg.graderModel,
        max_tokens: 16,
        system: `${PERSONAS[graderIdx % PERSONAS.length]} ${VERDICT_RULES}`,
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      }),
    });
    if (!res.ok) { note(`grader API ${await describeApiError(res)}`); return false; }
    const body = await res.json();
    if (body.stop_reason === 'refusal') { note('grader refused'); return false; }
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim()
      .toUpperCase();
    return text.includes('PASS') && !text.includes('FAIL');
  } catch (e) {
    note(e.name === 'AbortError' ? 'grader call timed out' : `grader API unreachable: ${e.message}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
