// Minimal Solana JSON-RPC over fetch: what verifying a launch, reading a
// curve, checking a transfer and sending a signed transaction need. Zero
// dependencies. Every call is bounded by a timeout.

export function createRpc(url, { timeoutMs = 10000, commitment = 'confirmed' } = {}) {
  let n = 0;
  const call = async (method, params = []) => {
    const res = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method, params }),
    });
    if (!res.ok) throw new Error(`rpc ${method} failed: ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`rpc ${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
    return body.result;
  };
  return {
    url, call, commitment,
    // null while the signature is unknown to the cluster or not yet confirmed
    getTransaction: (signature) => call('getTransaction', [signature, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: 0 }]),
    getAccountInfo: async (address) => (await call('getAccountInfo', [address, { encoding: 'base64', commitment }]))?.value ?? null,
    getAccountData: async function (address) { const v = await this.getAccountInfo(address); return v ? new Uint8Array(Buffer.from(v.data[0], 'base64')) : null; },
    getBalance: async (address) => BigInt((await call('getBalance', [address, { commitment }]))?.value ?? 0),
    getTokenAccountBalance: async (ata) => { try { const v = (await call('getTokenAccountBalance', [ata, { commitment }]))?.value; return v ? BigInt(v.amount) : 0n; } catch { return 0n; } },
    getLatestBlockhash: async () => (await call('getLatestBlockhash', [{ commitment }])).value,
    getMinimumBalanceForRentExemption: (bytes) => call('getMinimumBalanceForRentExemption', [bytes]),
    sendTransaction: (base64) => call('sendTransaction', [base64, { encoding: 'base64', preflightCommitment: commitment, skipPreflight: false, maxRetries: 3 }]),
    getSignatureStatuses: async (sigs) => (await call('getSignatureStatuses', [sigs, { searchTransactionHistory: true }]))?.value ?? [],
    getSlot: () => call('getSlot', [{ commitment }]),
  };
}
