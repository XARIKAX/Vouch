import { hash01, sleep } from './util.js';

// ---------------------------------------------------------------------------
// Safe arithmetic evaluator (numbers, + - * / and parentheses only).
// ---------------------------------------------------------------------------
export function evalExpression(src) {
  let i = 0;
  const s = String(src);
  const skip = () => { while (s[i] === ' ') i++; };
  const num = () => {
    skip();
    const start = i;
    if (s[i] === '-') i++;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    const text = s.slice(start, i);
    if (!text || text === '-' || (text.match(/\./g) || []).length > 1) {
      throw new Error(`expected a number at position ${start}`);
    }
    return parseFloat(text);
  };
  const factor = () => {
    skip();
    if (s[i] === '(') {
      i++;
      const v = expr();
      skip();
      if (s[i] !== ')') throw new Error('unbalanced parentheses');
      i++;
      return v;
    }
    return num();
  };
  const term = () => {
    let v = factor();
    for (;;) {
      skip();
      if (s[i] === '*') { i++; v *= factor(); }
      else if (s[i] === '/') { i++; v /= factor(); }
      else return v;
    }
  };
  const expr = () => {
    let v = term();
    for (;;) {
      skip();
      if (s[i] === '+') { i++; v += term(); }
      else if (s[i] === '-') { i++; v -= term(); }
      else return v;
    }
  };
  const v = expr();
  skip();
  if (i < s.length) throw new Error(`unexpected character "${s[i]}"`);
  if (!Number.isFinite(v)) throw new Error('expression did not evaluate to a finite number');
  return v;
}

// ---------------------------------------------------------------------------
// Deterministic demo text composer — stands in for a real model so the whole
// loop runs offline. Output varies with the prompt but is reproducible.
// ---------------------------------------------------------------------------
const CONNECTIVES = [
  'In practical terms,', 'Concretely,', 'Beyond the obvious,', 'Taken together,',
  'On closer inspection,', 'As a working summary,',
];
function composeText(prompt, seed) {
  const words = String(prompt).split(/\W+/).filter((w) => w.length > 3);
  const focus = words.length ? words : ['the', 'request'];
  const pick = (arr, n) => arr[Math.floor(hash01(seed + n) * arr.length)];
  const lines = [`Delivered work on "${prompt}".`];
  for (let n = 0; n < 4; n++) {
    lines.push(
      `${pick(CONNECTIVES, n)} the ${pick(focus, n + 10)} aspect matters because it shapes ` +
      `how ${pick(focus, n + 20)} interacts with ${pick(focus, n + 30)} under real conditions, ` +
      `which is where most attempts fall short.`
    );
  }
  lines.push(`The result holds for ${focus[0]} and generalizes to adjacent cases.`);
  return lines.join(' ');
}

// ---------------------------------------------------------------------------
// Executors, keyed by provider id. A provider with reliability 1 always
// delivers; reliability 0 always ships junk — deterministic on purpose, so
// the refund-and-slash path is demonstrable and testable.
// ---------------------------------------------------------------------------
const junkFor = (capability) => {
  if (capability === 'math.eval') return null; // computed below (wrong answer)
  if (capability === 'image.generate' || capability === 'audio.speak') return { url: 'about:blank#failed' };
  if (capability === 'text.summarize') return { summary: '### ERROR ###' };
  if (capability === 'embed.text') return { vector: [] };
  return { text: '### ERROR ### lorem lorem ###' };
};

async function execute(provider, task, cfg) {
  const cap = task.capability;
  const latency = Math.max(5, Math.floor(task.quote.deadline_ms * (0.3 + 0.3 * hash01(provider.id + task.id))));
  await sleep(cfg.fast ? Math.min(latency, 60) : latency);

  const honest = hash01(provider.id + task.id + 'roll') < provider.reliability;

  if (cap === 'math.eval') {
    let result;
    try {
      result = evalExpression(task.input.expression);
    } catch (e) {
      return { error: e.message };
    }
    return { result: honest ? result : result + 1 };
  }
  if (!honest) return junkFor(cap);

  if (cap === 'text.generate') return { text: composeText(task.input.prompt, provider.id + task.id) };
  if (cap === 'text.summarize') {
    const src = String(task.input.text);
    const firstSentences = src.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
    return { summary: `${firstSentences} In short: ${src.slice(0, 80).trim()}${src.length > 80 ? '…' : ''}` };
  }
  if (cap === 'image.generate') {
    const seed = Math.floor(hash01(task.id) * 1e6);
    const w = task.input.width ?? 1024;
    const h = task.input.height ?? 1024;
    return { url: `https://picsum.photos/seed/${seed}/${w}/${h}` };
  }
  if (cap === 'audio.speak') {
    const seed = hash01(task.id + task.input.text).toString(16).slice(2, 12);
    return { url: `https://cdn.vouch.example/tts/${seed}.mp3` };
  }
  if (cap === 'embed.text') {
    const vector = Array.from({ length: 8 }, (_, i) =>
      Math.round((hash01(task.input.text + ':' + i) * 2 - 1) * 1e4) / 1e4);
    return { vector };
  }
  return { error: `provider ${provider.id} cannot serve ${cap}` };
}

// ---------------------------------------------------------------------------
// Seed network. Stake is USDC bonded by the provider; track is 0-100.
// prv_shade is the cautionary tale: cheapest quotes, reliability 0.
// ---------------------------------------------------------------------------
export function seedProviders(state) {
  const seed = [
    {
      id: 'prv_calder', name: 'Calder Labs', stake: 200, track: 96, reliability: 1,
      offers: {
        'text.generate': { price_ceiling: 0.02, sla_deadline_ms: 8000 },
        'text.summarize': { price_ceiling: 0.008, sla_deadline_ms: 5000 },
        'image.generate': { price_ceiling: 0.03, sla_deadline_ms: 12000 },
        'audio.speak': { price_ceiling: 0.012, sla_deadline_ms: 9000 },
        'embed.text': { price_ceiling: 0.001, sla_deadline_ms: 1500 },
        'math.eval': { price_ceiling: 0.005, sla_deadline_ms: 2000 },
      },
    },
    {
      id: 'prv_norn', name: 'Norn Compute', stake: 120, track: 88, reliability: 1,
      offers: {
        'text.generate': { price_ceiling: 0.012, sla_deadline_ms: 12000 },
        'text.summarize': { price_ceiling: 0.005, sla_deadline_ms: 8000 },
        'image.generate': { price_ceiling: 0.022, sla_deadline_ms: 15000 },
        'audio.speak': { price_ceiling: 0.009, sla_deadline_ms: 12000 },
        'embed.text': { price_ceiling: 0.0008, sla_deadline_ms: 2500 },
      },
    },
    {
      id: 'prv_shade', name: 'Shade Node', stake: 40, track: 62, reliability: 0,
      offers: {
        'text.generate': { price_ceiling: 0.006, sla_deadline_ms: 6000 },
      },
    },
  ];
  for (const p of seed) {
    state.providers[p.id] = {
      ...p,
      stakeReserved: 0,
      earnings: 0,
      settledCount: 0,
      slashedCount: 0,
    };
  }
}

export const runExecutor = execute;
