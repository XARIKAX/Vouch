import crypto from 'node:crypto';

// Portable proof-of-verified-work. Every settled task (and every standalone
// verification) is signed with an ed25519 key so the holder can prove, to any
// third party, that Vouch verified an output — without trusting Vouch at claim
// time. Zero dependencies (node:crypto).
//
// Key source, in order: cfg.attestKey / VOUCH_ATTEST_KEY (a PKCS8 PEM private
// key, stable across restarts) → otherwise an ephemeral keypair per boot (fine
// for the sandbox; attestations don't verify across cold starts until a key is
// set). The matching public key is served at /v1/attestation/key.

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
    privateKey = undefined; // fall through to ephemeral on a bad key
  }
  if (!privateKey) {
    const kp = crypto.generateKeyPairSync('ed25519');
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;
  }
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyId = crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16);

  function attest(kind, payload) {
    const body = { kind, ...payload, key_id: keyId, attested_at: Date.now() };
    const signature = crypto.sign(null, Buffer.from(canonical(body)), privateKey).toString('base64');
    return { payload: body, alg: 'ed25519', key_id: keyId, signature };
  }

  return { attest, publicKeyPem, keyId };
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
