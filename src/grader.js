import { primaryValue } from './catalog.js';
import { describeApiError } from './execute-claude.js';
import { fetchImage } from './image.js';

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
  const blocked = cfg.spend?.blocked?.();
  if (blocked) { note(`grader off: ${blocked}`); return false; }
  const deliverable = primaryValue(task.capability, output);
  // An image task is judged on the picture: verification passes the fetched
  // bytes in context.image; a re-review (dispute) fetches them again.
  let image = context?.image ?? null;
  if (!image && task.capability === 'image.generate' && typeof deliverable === 'string') {
    const got = await fetchImage(deliverable, { timeoutMs: cfg.imageFetchTimeoutMs ?? 40000 });
    if (!got.ok) { note(`grader could not fetch the image: ${got.error}`); return false; }
    image = { media_type: got.media_type, bytes: got.bytes };
  }
  const payload = {
    capability: task.capability,
    input: task.input,
    deliverable: image ? '(the attached image)' : typeof deliverable === 'string' ? deliverable : output,
    rubric,
    ...(context?.dispute ? { dispute: context.dispute } : {}),
  };
  const content = image
    ? [{ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.bytes.toString('base64') } }, { type: 'text', text: JSON.stringify(payload) }]
    : JSON.stringify(payload);

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
        messages: [{ role: 'user', content }],
      }),
    });
    if (!res.ok) { const why = await describeApiError(res); cfg.spend?.fail?.(res.status, why); note(`grader API ${why}`); return false; }
    const body = await res.json();
    cfg.spend?.record?.(cfg.graderModel, body.usage);
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
