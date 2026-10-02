import { verify } from './verification.js';

// The trading desk's gate: no broker order is placed until the agent's thesis
// passes verification. The checks here are the same validators /v1/verify
// runs (json_parseable, regex, length_between), so a thesis that passes
// /v1/verify with this acceptance also passes the order endpoint.
//
// Thesis shape (object, or a JSON string of one):
//   { direction: 'buy' | 'sell' | 'long' | 'short',
//     confidence: 0..1,
//     rationale: string (120+ characters),
//     symbol?: string, risk?: string }
//
// Verified as a `text.generate` deliverable: `text` is the canonical JSON of
// the thesis; direction / confidence / rationale are lifted beside it so the
// deterministic checks can target each field.

export const THESIS_CAPABILITY = 'text.generate';
export const THESIS_ACCEPTANCE = {
  checks: [
    { assert: 'json_parseable', path: 'text', has: ['direction', 'confidence', 'rationale'] },
    { assert: 'regex', path: 'direction', pattern: '^(buy|sell|long|short)$' },
    { assert: 'regex', path: 'confidence', pattern: '^(0(\\.\\d+)?|1(\\.0+)?)$' },
    { assert: 'length_between', path: 'rationale', min: 120 },
  ],
};

// Normalize a thesis into the output object the checks run against.
export function thesisOutput(thesis) {
  let obj = thesis;
  if (typeof thesis === 'string') {
    try { obj = JSON.parse(thesis); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { text: typeof thesis === 'string' ? thesis : JSON.stringify(thesis ?? null), direction: '', confidence: '', rationale: '' };
  }
  const direction = String(obj.direction ?? '').trim().toLowerCase();
  const confidence = obj.confidence === undefined || obj.confidence === null ? '' : String(obj.confidence).trim();
  const rationale = String(obj.rationale ?? obj.thesis ?? '');
  return { text: JSON.stringify({ ...obj, direction, rationale }), direction, confidence, rationale };
}

// Run the gate. Returns { pass, verified_by, failed } exactly like /v1/verify.
export async function checkThesis(thesis, cfg = {}) {
  if (thesis === undefined || thesis === null || thesis === '') {
    return { pass: false, verified_by: [], failed: { validator: 'thesis', detail: 'a thesis object is required before an order can be placed' } };
  }
  const output = thesisOutput(thesis);
  const synthetic = { id: 'thesis', capability: THESIS_CAPABILITY, input: {}, acceptance: THESIS_ACCEPTANCE };
  const verdict = await verify(synthetic, output, cfg);
  return { pass: verdict.pass, verified_by: verdict.verified_by ?? [], failed: verdict.failed ?? null };
}
