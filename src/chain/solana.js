// Solana building blocks for the server: program-derived addresses,
// associated token accounts, the system and SPL token instructions Vouch
// uses, and signing a compiled message with a local keypair.
import crypto from 'node:crypto';
import { encodeBase58, decodeBase58 } from './base58.js';
import { isOnCurve, sign } from './ed25519.js';
import { compileMessage, serializeMessage, serializeTransaction, u64le, utf8, concat } from '../../public/assets/solmsg.js';

export const PROGRAMS = Object.freeze({
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  rent: 'SysvarRent111111111111111111111111111111111',
  metadata: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
});
export const LAMPORTS_PER_SOL = 1_000_000_000n;

const sha256 = (b) => new Uint8Array(crypto.createHash('sha256').update(Buffer.from(b)).digest());
const seedBytes = (s) => (s instanceof Uint8Array ? s : typeof s === 'string' ? (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && decodeBase58(s).length === 32 ? decodeBase58(s) : utf8(s)) : Uint8Array.from(s));

// Program-derived address: sha256(seeds ‖ bump ‖ program ‖ "ProgramDerivedAddress"),
// the first bump from 255 down that lands off the curve.
export function findProgramAddress(seeds, programId) {
  const prog = decodeBase58(programId);
  const tail = utf8('ProgramDerivedAddress');
  const parts = seeds.map(seedBytes);
  for (const p of parts) if (p.length > 32) throw new Error('a PDA seed is at most 32 bytes');
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat(...parts, Uint8Array.of(bump), prog, tail));
    if (!isOnCurve(h)) return { address: encodeBase58(h), bump };
  }
  throw new Error('no program address found');
}
// The associated token account of `owner` for `mint` (classic token program).
export const associatedTokenAddress = (owner, mint, tokenProgram = PROGRAMS.token) => findProgramAddress([decodeBase58(owner), decodeBase58(tokenProgram), decodeBase58(mint)], PROGRAMS.associatedToken).address;
// Anchor's 8-byte instruction discriminator.
export const anchorDiscriminator = (name) => sha256(utf8(`global:${name}`)).subarray(0, 8);
// Borsh string: u32 length then utf8.
export const borshString = (s) => { const b = utf8(s); const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, b.length, true); return concat(len, b); };

const key = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

// ---- instructions -----------------------------------------------------------
export const ix = {
  // SystemProgram.transfer: u32 index 2, u64 lamports
  systemTransfer(from, to, lamports) {
    const data = concat(Uint8Array.of(2, 0, 0, 0), u64le(lamports));
    return { programId: PROGRAMS.system, keys: [key(from, true, true), key(to, false, true)], data };
  },
  // Create the associated token account if it is missing (idempotent).
  createAtaIdempotent(payer, owner, mint) {
    const ata = associatedTokenAddress(owner, mint);
    return { programId: PROGRAMS.associatedToken, keys: [key(payer, true, true), key(ata, false, true), key(owner), key(mint), key(PROGRAMS.system), key(PROGRAMS.token)], data: Uint8Array.of(1) };
  },
  // SPL token TransferChecked: index 12, u64 amount, u8 decimals.
  transferChecked(source, mint, destination, owner, amount, decimals) {
    const data = concat(Uint8Array.of(12), u64le(amount), Uint8Array.of(decimals));
    return { programId: PROGRAMS.token, keys: [key(source, false, true), key(mint), key(destination, false, true), key(owner, true)], data };
  },
};

// Compile, sign with the given keypairs (seed32 + address), and return the
// wire bytes with the transaction's id (the first signature, base58).
export function signTransaction({ feePayer, instructions, recentBlockhash }, signers) {
  const msg = compileMessage({ feePayer, instructions, recentBlockhash });
  const bytes = serializeMessage(msg);
  const byAddress = new Map(signers.map((s) => [s.address, s]));
  const sigs = [];
  for (let i = 0; i < msg.header.numRequiredSignatures; i++) {
    const s = byAddress.get(msg.accountKeys[i]);
    if (!s) throw new Error(`no key for required signer ${msg.accountKeys[i]}`);
    sigs.push(sign(bytes, s.seed));
  }
  return { bytes: serializeTransaction(bytes, sigs), signature: encodeBase58(sigs[0]), message: msg };
}
export const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
export const fromBase64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
