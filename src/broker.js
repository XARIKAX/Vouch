// Alpaca paper-trading adapter (server-side).
//
// Real market data + real orders against the deployer's Alpaca *paper* account.
// Keys come from environment variables and never reach the browser. When it is
// not configured, callers get { configured: false } and the trading desk stays
// on its simulated data source — nothing here places a real-money trade.
//
// Env:
//   ALPACA_KEY_ID          your Alpaca API key id (paper)
//   ALPACA_SECRET_KEY      your Alpaca API secret (paper)
//   ALPACA_BASE_URL        default https://paper-api.alpaca.markets  (KEEP paper)
//   ALPACA_DATA_URL        default https://data.alpaca.markets
//   BROKER_ORDER_TOKEN     optional; if set, POST /order requires a matching
//                          x-broker-token header (stops the public placing
//                          orders in your account)

const TRADE_BASE = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_BASE = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const KEY = process.env.ALPACA_KEY_ID || '';
const SECRET = process.env.ALPACA_SECRET_KEY || process.env.ALPACA_SECRET || '';
const ORDER_TOKEN = process.env.BROKER_ORDER_TOKEN || '';
// Guard rail: this adapter only ever talks to a *paper* endpoint. If someone
// points ALPACA_BASE_URL at the live host, refuse — real-money trading is a
// separate, regulated decision, not a config flip.
const IS_PAPER = /paper-api\.alpaca\.markets/.test(TRADE_BASE);

export function brokerConfigured() { return !!(KEY && SECRET && IS_PAPER); }
export function brokerStatus() {
  return {
    configured: brokerConfigured(),
    mode: 'paper',
    order_guard: !!ORDER_TOKEN,
    reason: !KEY || !SECRET ? 'set ALPACA_KEY_ID and ALPACA_SECRET_KEY'
      : !IS_PAPER ? 'ALPACA_BASE_URL must be the paper endpoint' : null,
  };
}
export function orderTokenOk(tok) { return !ORDER_TOKEN || tok === ORDER_TOKEN; }

const headers = () => ({
  'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET, 'Content-Type': 'application/json',
});

async function call(base, path, opts = {}) {
  if (!brokerConfigured()) { const e = new Error('broker not configured'); e.status = 503; throw e; }
  let res;
  try {
    res = await fetch(base + path, { ...opts, headers: headers() });
  } catch (e) { const err = new Error('broker unreachable: ' + e.message); err.status = 502; throw err; }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(body.message || ('alpaca ' + res.status)); err.status = res.status >= 500 ? 502 : 400; throw err; }
  return body;
}

const sym = (s) => String(s || '').toUpperCase().replace(/[^A-Z.]/g, '').slice(0, 8);

export async function account() {
  const a = await call(TRADE_BASE, '/v2/account');
  return { equity: +a.equity, cash: +a.cash, buying_power: +a.buying_power, status: a.status, currency: a.currency, mode: 'paper' };
}
export async function positions() {
  const p = await call(TRADE_BASE, '/v2/positions');
  return (Array.isArray(p) ? p : []).map((x) => ({
    symbol: x.symbol, qty: +x.qty, avg: +x.avg_entry_price, price: +x.current_price, pnl: +x.unrealized_pl,
  }));
}
export async function quote(symbol) {
  const s = sym(symbol);
  const d = await call(DATA_BASE, `/v2/stocks/${s}/trades/latest`);
  return { symbol: s, price: d.trade ? +d.trade.p : null, at: d.trade ? d.trade.t : null };
}
export async function placeOrder({ symbol, qty, side }) {
  const s = sym(symbol);
  const q = Math.max(1, Math.floor(Number(qty) || 0));
  if (!['buy', 'sell'].includes(side)) { const e = new Error('side must be buy or sell'); e.status = 400; throw e; }
  const o = await call(TRADE_BASE, '/v2/orders', {
    method: 'POST',
    body: JSON.stringify({ symbol: s, qty: q, side, type: 'market', time_in_force: 'day' }),
  });
  return { id: o.id, symbol: o.symbol, qty: +o.qty, side: o.side, status: o.status, submitted_at: o.submitted_at, mode: 'paper' };
}
