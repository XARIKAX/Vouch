// Minimal Ethereum JSON-RPC over fetch: eth_call, receipts, chain id, and
// what a payout needs (nonce, fees, gas estimate, raw send). Zero
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
  const big = async (method, params) => BigInt(await call(method, params));
  return {
    url, call,
    chainId: async () => Number(await call('eth_chainId')),
    ethCall: (to, data, from) => call('eth_call', [from ? { from, to, data } : { to, data }, 'latest']),
    getTransactionReceipt: (hash) => call('eth_getTransactionReceipt', [hash]),
    getBalance: (addr) => big('eth_getBalance', [addr, 'latest']),
    getTransactionCount: async (addr) => Number(await big('eth_getTransactionCount', [addr, 'pending'])),
    gasPrice: () => big('eth_gasPrice', []),
    maxPriorityFeePerGas: async () => { try { return await big('eth_maxPriorityFeePerGas', []); } catch { return 0n; } },
    estimateGas: (tx) => big('eth_estimateGas', [tx]),
    sendRawTransaction: (raw) => call('eth_sendRawTransaction', [raw]),
  };
}
