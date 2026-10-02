import net from 'node:net';
import tls from 'node:tls';

// Minimal Redis client over the RESP2 wire protocol. Zero dependencies.
// Enough for the state store: GET, SET, EVAL, AUTH, SELECT, PING. Commands
// are serialised one at a time (the serverless store issues a handful per
// invocation), each with its own timeout, over a socket that is opened on
// first use and can be closed explicitly.
//
// URL forms accepted (what Vercel's Redis integration and Redis Cloud emit):
//   redis://[user[:password]@]host[:port][/db]
//   rediss://...   (TLS)

export function parseRedisUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new Error(`unsupported Redis URL scheme ${u.protocol}`);
  const db = Number((u.pathname || '/').slice(1) || 0);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    tls: u.protocol === 'rediss:',
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    db: Number.isFinite(db) ? db : 0,
  };
}

const CRLF = '\r\n';

export function encodeCommand(args) {
  const parts = [Buffer.from(`*${args.length}${CRLF}`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
    parts.push(Buffer.from(`$${b.length}${CRLF}`), b, Buffer.from(CRLF));
  }
  return Buffer.concat(parts);
}

// Parse one RESP2 reply from `buf` starting at `pos`. Returns [value, nextPos]
// or null when the buffer does not yet hold a complete reply.
export function parseReply(buf, pos = 0) {
  if (pos >= buf.length) return null;
  const type = buf[pos];
  const eol = buf.indexOf(CRLF, pos + 1);
  if (eol === -1) return null;
  const line = buf.toString('utf8', pos + 1, eol);
  const after = eol + 2;
  switch (type) {
    case 0x2b: return [line, after];                                   // + simple string
    case 0x2d: { const e = new Error(line); e.redis = true; return [e, after]; } // - error
    case 0x3a: return [Number(line), after];                           // : integer
    case 0x24: {                                                        // $ bulk string
      const len = Number(line);
      if (len === -1) return [null, after];
      if (buf.length < after + len + 2) return null;
      return [buf.toString('utf8', after, after + len), after + len + 2];
    }
    case 0x2a: {                                                        // * array
      const n = Number(line);
      if (n === -1) return [null, after];
      const out = []; let p = after;
      for (let i = 0; i < n; i++) {
        const r = parseReply(buf, p); if (!r) return null;
        out.push(r[0]); p = r[1];
      }
      return [out, p];
    }
    default: throw new Error(`unexpected RESP byte ${String.fromCharCode(type)}`);
  }
}

export function createRedisClient(url, { timeoutMs = 5000 } = {}) {
  const cfg = parseRedisUrl(url);
  let socket = null;
  let buffer = Buffer.alloc(0);
  const waiting = [];      // { resolve, reject, timer } in send order
  let connecting = null;

  const fail = (err) => {
    while (waiting.length) { const w = waiting.shift(); clearTimeout(w.timer); w.reject(err); }
  };
  const onData = (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    let pos = 0;
    for (;;) {
      let r;
      try { r = parseReply(buffer, pos); } catch (e) { fail(e); destroy(); return; }
      if (!r) break;
      pos = r[1];
      const w = waiting.shift();
      if (w) { clearTimeout(w.timer); r[0] instanceof Error ? w.reject(r[0]) : w.resolve(r[0]); }
    }
    buffer = pos ? buffer.subarray(pos) : buffer;
  };
  const destroy = () => { if (socket) { socket.destroy(); socket = null; } buffer = Buffer.alloc(0); };

  const connect = () => {
    if (socket && !socket.destroyed) return Promise.resolve();
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      const onError = (e) => { connecting = null; fail(e); destroy(); reject(e); };
      const s = cfg.tls
        ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
        : net.connect({ host: cfg.host, port: cfg.port });
      s.setNoDelay(true);
      s.once(cfg.tls ? 'secureConnect' : 'connect', () => { connecting = null; resolve(); });
      s.on('error', onError);
      s.on('close', () => { if (socket === s) { socket = null; fail(new Error('redis connection closed')); } });
      s.on('data', onData);
      socket = s;
    }).then(async () => {
      if (cfg.password) await raw(cfg.username ? ['AUTH', cfg.username, cfg.password] : ['AUTH', cfg.password]);
      if (cfg.db) await raw(['SELECT', String(cfg.db)]);
    });
    return connecting;
  };

  const raw = (args) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = waiting.findIndex((w) => w.timer === timer);
      if (i >= 0) waiting.splice(i, 1);
      destroy();
      reject(new Error(`redis command ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    waiting.push({ resolve, reject, timer });
    socket.write(encodeCommand(args));
  });

  return {
    async command(args) { await connect(); return raw(args); },
    close() { destroy(); fail(new Error('redis client closed')); },
    get connected() { return !!socket && !socket.destroyed; },
  };
}
