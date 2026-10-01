import { ApiError } from './errors.js';

// Outbound-request hygiene for URLs the *buyer* supplies (task webhook_url,
// acceptance.webhook). Those are fetched by the platform, so a caller could
// otherwise point them at the platform's own network (SSRF). Provider
// endpoint_url is deliberately not guarded here: operators register their own
// endpoints and tests run providers on localhost.

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function isPrivateHost(hostname = '') {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7));
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_V4.some((re) => re.test(h));
  return false;
}

// Throws 400 invalid_input unless `url` is an http(s) URL on a public host.
// `allowPrivate` (cfg.allowPrivateWebhooks) exists for tests and air-gapped
// deployments that run their validators next door.
export function assertPublicUrl(url, what, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(url)); } catch { throw new ApiError(400, 'invalid_input', `${what} must be an http(s) URL`); }
  if (!/^https?:$/.test(u.protocol)) throw new ApiError(400, 'invalid_input', `${what} must be an http(s) URL`);
  if (!allowPrivate && isPrivateHost(u.hostname)) {
    throw new ApiError(400, 'invalid_input', `${what} must point at a public host (private and loopback addresses are refused)`);
  }
  return u;
}

// fetch() with a hard timeout. Every outbound call the platform makes on a
// buyer's behalf is bounded so a stalled endpoint cannot pin a task.
export const OUTBOUND_TIMEOUT_MS = 5000;
export function fetchWithTimeout(url, opts = {}, ms = OUTBOUND_TIMEOUT_MS) {
  return fetch(url, { ...opts, signal: opts.signal ?? AbortSignal.timeout(ms) });
}
