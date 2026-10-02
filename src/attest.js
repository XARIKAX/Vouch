import crypto from 'node:crypto';

// Portable proof-of-verified-work. Every settled task (and every standalone
// verification) is signed with an ed25519 key so the holder can prove, to any
// third party, that Vouch verified an output — without trusting Vouch at claim
// time. Zero dependencies (node:crypto).
//
// Key source, in order: cfg.attestKey / VOUCH_ATTEST_KEY (a PKCS8 PEM private
// key, stable across restarts) → otherwise a generated keypair. The engine
// persists a generated key inside its state so receipts keep verifying across
// restarts and serverless invocations. The matching public key is served at
// /v1/attestation/key.

// Deterministic serialization so a signature is reproducible byte-for-byte.
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

// Environment editors often flatten a pasted PEM onto one line or turn its
// line breaks into literal "\\n". Rebuild the canonical form from the base64
// body so either paste works.
export function normalizePem(raw) {
  if (!raw) return raw;
  let t = String(raw).trim()
    .replace(/\\n/g, '\n')
    .replace(/[\u2010-\u2015\u2212]/g, '-')            // typographic dashes → '-'
    .replace(/[\u00a0\u2000-\u200b\ufeff]/g, ' ')     // odd spaces → plain space
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^VOUCH_ATTEST_KEY=/, '')
    .trim();
  const m = t.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  const wrap = (label, body) => `-----BEGIN ${label}-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
  if (m) {
    // A '+' inside the base64 body often arrives as a space after a copy
    // through a form or URL-decoder; a 64-char ed25519 body is restored by
    // mapping single interior spaces back to '+'.
    let body = m[2].trim().replace(/\r?\n/g, '');
    if (/ /.test(body) && body.replace(/ /g, '+').length === 64) body = body.replace(/ /g, '+');
    return wrap(m[1], body.replace(/\s+/g, ''));
  }
  // A bare base64 body (the one line between the markers) is still usable.
  const bare = t.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]+=*$/.test(bare) && bare.length >= 60) return wrap('PRIVATE KEY', bare);
  return t;
}

// A secret-free description of a key value that failed to parse, for /v1/status.
export function describeKeyShape(raw) {
  if (!raw) return 'empty';
  const t = String(raw);
  const lines = t.split(/\r?\n/).length;
  const hasBegin = /BEGIN/.test(t), hasEnd = /END/.test(t);
  const parts = [`${t.length} chars`, `${lines} line${lines === 1 ? '' : 's'}`,
    `BEGIN ${hasBegin ? 'present' : 'missing'}`, `END ${hasEnd ? 'present' : 'missing'}`,
    `literal \\n ${/\\n/.test(t) ? 'present' : 'absent'}`];
  if (/[\u2010-\u2015\u2212]/.test(t)) parts.push('typographic dashes present');
  const m = t.match(/-----BEGIN [A-Z ]+-----([\s\S]*?)-----END/);
  if (m) {
    const body = m[1].replace(/\s+/g, '');
    const b64ok = /^[A-Za-z0-9+/]+=*$/.test(body);
    let decoded = 'n/a';
    if (b64ok) {
      const buf = Buffer.from(body, 'base64');
      decoded = `${buf.length} bytes` + (buf.subarray(0, 16).toString('hex') === '302e020100300506032b657004220420' ? ', ed25519 PKCS8 header ok' : ', not an ed25519 PKCS8 header');
    }
    parts.push(`body ${body.length} chars (expect 64)`, `base64 ${b64ok ? 'valid' : 'invalid'}`, `decoded ${decoded}`);
    if (/^[0-9a-f]{64}$/i.test(body)) parts.push('body looks like a 64-char hex token, not a key');
  }
  return parts.join(', ');
}

export function createAttestor(cfg = {}) {
  let privateKey;
  let publicKey;
  let source = 'generated';
  let detail = null;
  const rawKey = cfg.attestKey || process.env.VOUCH_ATTEST_KEY;
  const pem = normalizePem(rawKey);
  if (pem) {
    try {
      privateKey = crypto.createPrivateKey(pem);
      publicKey = crypto.createPublicKey(privateKey);
      source = 'configured';
    } catch (e) {
      privateKey = undefined; // fall through to a generated key on a bad PEM
      source = 'invalid';
      detail = `${e.message}; value is ${describeKeyShape(rawKey)}`;
      console.error(`vouch: VOUCH_ATTEST_KEY is not a valid PKCS8 ed25519 PEM (${detail}); using a generated key instead`);
    }
  }
  if (!privateKey) {
    const kp = crypto.generateKeyPairSync('ed25519');
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
  }
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyId = crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16);

  function attest(kind, payload) {
    const body = { kind, ...payload, key_id: keyId, attested_at: Date.now() };
    const signature = crypto.sign(null, Buffer.from(canonical(body)), privateKey).toString('base64');
    return { payload: body, alg: 'ed25519', key_id: keyId, signature };
  }

  return { attest, publicKeyPem, privateKeyPem, keyId, source, detail };
}

// Anyone holding the public key can verify an attestation offline.
export function verifyAttestation(att, publicKeyPem) {
  try {
    const pub = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(canonical(att.payload)), pub, Buffer.from(att.signature, 'base64'));
  } catch {
    return false;
  }
}
