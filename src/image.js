// Real image generation. Images are served by URL from an image API that
// renders on first fetch, so a native provider's "work" is the URL it
// commits to, and verification fetches the bytes: the picture must exist,
// be an image, and (with a rubric) match the prompt in the eyes of the
// vision-capable grader panel. Without an image provider the simulator
// returns a placeholder that says so on its face.
//
//   VOUCH_IMAGE_PROVIDER   pollinations | none   (default: pollinations when
//                          ANTHROPIC_API_KEY is set, none otherwise)
//   VOUCH_IMAGE_BASE_URL   override the image API base (default
//                          https://image.pollinations.ai)
//   VOUCH_IMAGE_MODEL      model name passed to the image API (default flux)

import { hash01 } from './util.js';

export const imageOn = (cfg) => !!cfg.imageProvider && cfg.imageProvider !== 'none';

const dim = (v, d) => { const n = Number(v); return Number.isInteger(n) && n >= 64 && n <= 2048 ? n : d; };

// The URL a native provider commits to for an image task. Deterministic per
// task (seed from the task id) so a retry or a re-review sees the same image.
export function buildImageUrl(cfg, task) {
  const prompt = String(task.input?.prompt ?? '').trim().slice(0, 800);
  const w = dim(task.input?.width, 1024), h = dim(task.input?.height, 1024);
  const seed = Math.floor(hash01(task.id) * 1e9);
  const base = String(cfg.imageBaseUrl || 'https://image.pollinations.ai').replace(/\/$/, '');
  const q = new URLSearchParams({ width: String(w), height: String(h), seed: String(seed), nologo: 'true', model: cfg.imageModel || 'flux' });
  return `${base}/prompt/${encodeURIComponent(prompt)}?${q}`;
}

// The sandbox stand-in: a dark tile that prints "SANDBOX PLACEHOLDER" and the
// prompt, so nobody mistakes it for a generated picture.
export function placeholderImageUrl(task) {
  const prompt = String(task.input?.prompt ?? '').trim().slice(0, 60);
  const w = dim(task.input?.width, 1024), h = dim(task.input?.height, 1024);
  const text = encodeURIComponent(`SANDBOX PLACEHOLDER\n${prompt}`).replace(/%0A/g, '\\n');
  return `https://placehold.co/${w}x${h}/0d0b1c/8f7cff/png?text=${text}`;
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Fetch an image for verification: bounded in time and size, must answer
// 200 with an image content type. Returns { ok, media_type, bytes } or
// { ok: false, error }.
export async function fetchImage(url, { timeoutMs = 40000, maxBytes = 8 * 1024 * 1024 } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'image/*' } });
    if (!res.ok) return { ok: false, error: `image URL answered ${res.status}` };
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return { ok: false, error: `image URL returned ${type || 'no content type'}, not an image` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'image URL returned an empty body' };
    if (buf.length > maxBytes) return { ok: false, error: `image is ${buf.length} bytes, over the ${maxBytes} byte limit` };
    return { ok: true, media_type: type, bytes: buf };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' || e.name === 'AbortError' ? `image URL did not answer within ${timeoutMs} ms` : `image URL unreachable: ${e.message}` };
  }
}
