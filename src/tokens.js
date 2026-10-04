// The gateway's own token count. Deterministic and dependency-free, so it is
// an approximation of a model's tokenizer, not that tokenizer: words and
// punctuation are split on, long words are broken into four-character
// pieces, and every chat message carries a small fixed overhead. Billing
// uses this count; a provider's reported count is only checked against it
// within a tolerance.
const PIECE = 4;

export function countText(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let n = 0;
  for (const part of s.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { if (part.length > 1) n += Math.floor(part.length / 4); continue; }
    // split a run into words, numbers and punctuation
    for (const tok of part.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g) ?? []) {
      if (/^[A-Za-z]+$/.test(tok)) n += Math.max(1, Math.ceil(tok.length / PIECE));
      else if (/^\d+$/.test(tok)) n += Math.max(1, Math.ceil(tok.length / 3));
      else n += 1;
    }
  }
  return n;
}

// content may be a string or the OpenAI array form of text and image parts
export function countContent(content) {
  if (typeof content === 'string') return countText(content);
  if (Array.isArray(content)) return content.reduce((s, part) => s + (part?.type === 'text' ? countText(part.text) : 85), 0);
  if (content && typeof content === 'object') return countText(JSON.stringify(content));
  return 0;
}

export function countMessages(messages = [], tools = []) {
  let n = 3;                                                     // the reply priming
  for (const m of messages) {
    n += 4 + countContent(m?.content);
    if (m?.name) n += countText(m.name);
    if (Array.isArray(m?.tool_calls)) for (const c of m.tool_calls) n += 6 + countText(c?.function?.name) + countText(c?.function?.arguments);
  }
  for (const t of tools) n += 8 + countText(JSON.stringify(t));
  return n;
}

// a completion: the text, plus any tool calls, counted the same way
export function countCompletion(message) {
  if (!message) return 0;
  let n = countContent(message.content);
  if (Array.isArray(message.tool_calls)) for (const c of message.tool_calls) n += 6 + countText(c?.function?.name) + countText(c?.function?.arguments);
  return n;
}
