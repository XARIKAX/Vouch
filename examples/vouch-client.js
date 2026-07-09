// Vouch client — a zero-dependency wrapper around the REST API for agents.
// Node 18+ (global fetch) or any modern runtime. Usage:
//
//   import { VouchClient } from './vouch-client.js';
//   const vouch = new VouchClient({ baseUrl: 'https://api.vouch.example' });
//   await vouch.mintKey('my-agent');        // or new VouchClient({ key })
//   await vouch.deposit(2);
//   const task = await vouch.run({           // post + wait for the verified result
//     capability: 'text.generate',
//     input: { prompt: 'why verification beats retries' },
//     acceptance: { checks: [{ assert: 'word_count', min: 40 }] },
//     budget: 0.03, deadline_ms: 10000, retry: true,
//   });
//   console.log(task.status, task.output);

export class VouchClient {
  constructor({ baseUrl = 'http://localhost:4402', key } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.key = key ?? null;
  }

  async _req(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(this.key ? { Authorization: 'Bearer ' + this.key } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ? `${data.error.code}: ${data.error.message}` : `HTTP ${res.status}`);
    return data;
  }

  // ---- keys & balance ----
  async mintKey(name = 'agent') { const k = await this._req('POST', '/v1/keys', { name }); this.key = k.key; return k; }
  deposit(amount) { return this._req('POST', '/v1/escrow/deposit', { amount }); }
  balance() { return this._req('GET', '/v1/balance'); }
  createSubKey(opts) { return this._req('POST', '/v1/keys/sub', opts); }

  // ---- catalog ----
  capabilities() { return this._req('GET', '/v1/capabilities'); }
  offers(params = {}) {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
    return this._req('GET', '/v1/offers' + (q ? '?' + q : ''));
  }
  providers() { return this._req('GET', '/v1/providers'); }

  // ---- tasks ----
  postTask(body) { return this._req('POST', '/v1/tasks', body); }
  getTask(id) { return this._req('GET', `/v1/tasks/${id}`); }
  attestation(id) { return this._req('GET', `/v1/tasks/${id}/attestation`); }

  // Poll a task to a terminal state.
  async waitTask(id, { timeoutMs = 30000, intervalMs = 300 } = {}) {
    const start = Date.now();
    for (;;) {
      const t = await this.getTask(id);
      if (t.status === 'settled' || t.status === 'refunded') return t;
      if (Date.now() - start > timeoutMs) throw new Error(`task ${id} did not settle within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  // Post a task and return once it reaches a terminal state (or was cache-served).
  async run(body, opts) {
    const t = await this.postTask(body);
    if (t.status === 'settled' || t.status === 'refunded') return t; // cache hit / instant
    return this.waitTask(t.id, opts);
  }

  // ---- verification-as-a-service ----
  verify(body) { return this._req('POST', '/v1/verify', body); }

  // ---- workflows ----
  createWorkflow(steps) { return this._req('POST', '/v1/workflows', { steps }); }
  getWorkflow(id) { return this._req('GET', `/v1/workflows/${id}`); }
  async runWorkflow(steps, { timeoutMs = 60000, intervalMs = 400 } = {}) {
    const wf = await this.createWorkflow(steps);
    const start = Date.now();
    for (;;) {
      const w = await this.getWorkflow(wf.id);
      if (w.status === 'completed' || w.status === 'failed') return w;
      if (Date.now() - start > timeoutMs) throw new Error(`workflow ${wf.id} did not finish`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export default VouchClient;
