// Minimal Ethereum JSON-RPC over fetch: eth_call, receipts, chain id. Zero
// dependencies. Every call is bounded by a timeout.

export function createRpc(url, { timeoutMs = 8000 } = {}) {
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
    url, call,
    chainId: async () => Number(await call('eth_chainId')),
    ethCall: (to, data) => call('eth_call', [{ to, data }, 'latest']),
    getTransactionReceipt: (hash) => call('eth_getTransactionReceipt', [hash]),
    getBalance: async (addr) => BigInt(await call('eth_getBalance', [addr, 'latest'])),
  };
}
