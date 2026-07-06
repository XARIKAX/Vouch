import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// JSON snapshot persistence. Debounced writes, atomic rename, and a replacer
// that drops runtime-only fields (timers) so the state graph stays
// serializable. Pass a null path for fully in-memory operation (tests).

const DROP_KEYS = new Set(['timer']);

// Shared by every store backend: drops runtime-only fields from snapshots.
export const stateReplacer = (k, v) => (DROP_KEYS.has(k) ? undefined : v);

export function createStore(filePath) {
  if (!filePath) {
    return { load: () => null, save: () => {}, path: null };
  }

  const load = () => {
    try {
      return JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  };

  let pending = null;
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
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      writeNow(state);
    }, 250);
    pending.unref?.();
  };

  return { load, save, path: filePath };
}
