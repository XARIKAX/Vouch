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

export function createAttestor(cfg = {}) {
  let privateKey;
  let publicKey;
  const pem = cfg.attestKey || process.env.VOUCH_ATTEST_KEY;
  try {
    if (pem) {
      privateKey = crypto.createPrivateKey(pem);
      publicKey = crypto.createPublicKey(privateKey);
    }
  } catch {
    privateKey = undefined; // fall through to a generated key on a bad PEM
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

  return { attest, publicKeyPem, privateKeyPem, keyId };
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
