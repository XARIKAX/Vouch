import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';

// JSON snapshot persistence. Debounced writes, atomic rename, and a replacer
// that drops runtime-only values (Node timers) so the state graph stays
// serializable. Pass a null path for fully in-memory operation (tests).

// A Node Timeout handle, wherever it appears. Only runtime handles are
// dropped: a user field that happens to be *named* "timer" is kept intact.
const isTimer = (v) => v !== null && typeof v === 'object'
  && typeof v.unref === 'function' && typeof v.refresh === 'function' && typeof v.hasRef === 'function';

// Shared by every store backend.
export const stateReplacer = (k, v) => (isTimer(v) ? undefined : v);

export function createStore(filePath) {
  if (!filePath) {
    return { load: () => null, save: () => {}, flush: () => {}, path: null };
  }

  // A missing file means a fresh install. Anything else (unreadable, not
  // JSON) is a real problem: back the file up and refuse to seed over it.
  const load = () => {
    let raw;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      const backup = `${filePath}.corrupt-${Date.now()}`;
      try { copyFileSync(filePath, backup); } catch { /* best effort */ }
      const err = new Error(`vouch: state file ${filePath} is not valid JSON (${e.message}); backed up to ${backup}. Refusing to seed over it.`);
      err.code = 'STATE_CORRUPT';
      err.backup = backup;
      throw err;
    }
  };

  let pending = null;
  let latest = null;
  const writeNow = (state) => {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, stateReplacer));
      renameSync(tmp, filePath);
    } catch (e) {
      console.error(`vouch: failed to persist state to ${filePath}: ${e.message}`);
    }
  };

  const save = (state) => {
    latest = state;
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      writeNow(latest);
    }, 250);
    pending.unref?.();
  };

  // Write any pending snapshot right now (shutdown path).
  const flush = () => {
    if (pending) { clearTimeout(pending); pending = null; }
    if (latest) writeNow(latest);
  };

  return { load, save, flush, path: filePath };
}
