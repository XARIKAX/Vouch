// Model spend guard. Every model call reports its token usage; the guard
// prices it, keeps a daily total in state, and switches the deployment to
// the simulator and the heuristic grader when the daily budget is spent or
// the API says the account is out of credit, instead of letting every task
// time out and refund. The status endpoint and the console show the state.

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = () => Math.floor(Date.now() / DAY_MS);
// list prices per million tokens [input, output]; unknown models use the sonnet rate
const PRICES = [
  ['opus', [15, 75]], ['sonnet', [3, 15]], ['haiku', [0.8, 4]], ['fable', [15, 75]], ['mythos', [15, 75]],
];
export function priceOf(model, usage = {}) {
  const m = String(model || '').toLowerCase();
  const [, rate] = PRICES.find(([k]) => m.includes(k)) || ['', [3, 15]];
  return ((usage.input_tokens || 0) * rate[0] + (usage.output_tokens || 0) * rate[1]) / 1e6;
}

export function createSpend(state, { budgetUsd = Number(process.env.VOUCH_MODEL_BUDGET_USD) || 5, persist = () => {} } = {}) {
  state.spend ??= { day: utcDay(), usd: 0, calls: 0, input_tokens: 0, output_tokens: 0, degraded_until: 0, reason: null, total_usd: 0 };
  const s = state.spend;
  const roll = () => { if (s.day !== utcDay()) { s.day = utcDay(); s.usd = 0; s.calls = 0; s.input_tokens = 0; s.output_tokens = 0; if (s.reason === 'budget') { s.degraded_until = 0; s.reason = null; } } };
  return {
    // why model calls are off right now, or null
    blocked() {
      roll();
      if (s.degraded_until && Date.now() < s.degraded_until) return s.reason === 'credit' ? 'model account out of credit' : 'model budget exhausted for today';
      if (s.degraded_until && s.reason === 'credit') { s.degraded_until = 0; s.reason = null; }
      if (budgetUsd > 0 && s.usd >= budgetUsd) { s.reason = 'budget'; s.degraded_until = (s.day + 1) * DAY_MS; return 'model budget exhausted for today'; }
      return null;
    },
    record(model, usage) {
      roll();
      const usd = priceOf(model, usage);
      s.usd = Math.round((s.usd + usd) * 1e6) / 1e6; s.total_usd = Math.round((s.total_usd + usd) * 1e6) / 1e6;
      s.calls++; s.input_tokens += usage?.input_tokens || 0; s.output_tokens += usage?.output_tokens || 0;
      persist();
    },
    // an API error: a credit or billing problem pauses model calls for an hour
    fail(status, message) {
      const m = String(message || '').toLowerCase();
      if (status === 400 && /credit|billing|balance/.test(m) || status === 402) { s.reason = 'credit'; s.degraded_until = Date.now() + 60 * 60 * 1000; persist(); }
    },
    summary() {
      roll();
      const blocked = this.blocked();
      return { today_usd: s.usd, budget_usd: budgetUsd, calls_today: s.calls, input_tokens: s.input_tokens, output_tokens: s.output_tokens, total_usd: s.total_usd, degraded: !!blocked, reason: blocked, degraded_until: blocked ? new Date(s.degraded_until).toISOString() : null };
    },
  };
}
