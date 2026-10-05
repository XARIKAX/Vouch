// The Solana primitives: base58, ed25519 signing and the curve check,
// program-derived addresses against pump.fun's published ones, the legacy
// message compiler round-tripped through the parser, SPL instructions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBase58, decodeBase58, isPubkey } from '../src/chain/base58.js';
import { isOnCurve, randomKeypair, sign, verify, verifyMessage, keypairFromSecret } from '../src/chain/ed25519.js';
import { PROGRAMS, findProgramAddress, associatedTokenAddress, anchorDiscriminator, borshString, ix, signTransaction, toBase64, fromBase64 } from '../src/chain/solana.js';
import { compileMessage, serializeMessage, parseTransaction, compactU16, readCompactU16, u64le, readU64le } from '../public/assets/solmsg.js';
import { pda, DISC, PUMP } from '../src/chain/pump.js';
import { USDT } from '../src/chain/funds.js';

test('base58: the system program is 32 zero bytes, USDT\'s mint round-trips, junk is refused', () => {
  const zeros = decodeBase58('11111111111111111111111111111111');
  assert.equal(zeros.length, 32); assert.ok(zeros.every((b) => b === 0));
  assert.equal(encodeBase58(zeros), '11111111111111111111111111111111');
  assert.equal(encodeBase58(decodeBase58(USDT.mint)), USDT.mint);
  assert.equal(isPubkey(USDT.mint), true); assert.equal(isPubkey('0xabc'), false); assert.equal(isPubkey('11111'), false);
  assert.throws(() => decodeBase58('0OIl'), /invalid base58/);
  assert.equal(encodeBase58(Uint8Array.of(0, 0, 1)), '112');
});

test('ed25519: sign and verify, wallet-style base58 and hex signatures, a 64-byte secret key, the curve check', () => {
  const kp = randomKeypair();
  const sig = sign(Buffer.from('hello'), kp.seed);
  assert.equal(sig.length, 64);
  assert.equal(verify(Buffer.from('hello'), sig, kp.publicKey), true);
  assert.equal(verify(Buffer.from('hellp'), sig, kp.publicKey), false);
  assert.equal(verifyMessage('hello', encodeBase58(sig), kp.address), true);
  assert.equal(verifyMessage('hello', Buffer.from(sig).toString('hex'), kp.address), true);
  assert.equal(verifyMessage('hello', encodeBase58(sig), randomKeypair().address), false);
  assert.throws(() => verifyMessage('hello', 'abc', kp.address), /64 bytes/);
  const secret64 = encodeBase58(Buffer.concat([Buffer.from(kp.seed), Buffer.from(kp.publicKey)]));
  assert.equal(keypairFromSecret(secret64).address, kp.address);
  assert.equal(keypairFromSecret(Buffer.from(kp.seed).toString('hex')).address, kp.address);
  assert.equal(keypairFromSecret(JSON.stringify([...kp.seed, ...kp.publicKey])).address, kp.address);
  assert.throws(() => keypairFromSecret(encodeBase58(Buffer.concat([Buffer.from(kp.seed), Buffer.alloc(32, 7)]))), /does not match/);
  // keypair public keys are on the curve; program-derived addresses never are
  assert.equal(isOnCurve(kp.publicKey), true);
  assert.equal(isOnCurve(decodeBase58(PROGRAMS.token)), true);
  assert.equal(isOnCurve(decodeBase58(associatedTokenAddress(kp.address, USDT.mint))), false);
});

test('program-derived addresses match pump.fun\'s published ones; discriminators match the IDL', () => {
  assert.equal(pda.global(), '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  assert.equal(pda.mintAuthority(), 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
  assert.equal(pda.eventAuthority(), 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  assert.deepEqual([...DISC.create], [24, 30, 200, 40, 5, 28, 7, 119]);
  assert.deepEqual([...DISC.buy], [102, 6, 61, 18, 1, 218, 235, 234]);
  assert.deepEqual([...DISC.sell], [51, 230, 133, 164, 1, 127, 131, 173]);
  assert.deepEqual([...anchorDiscriminator('collect_creator_fee')], [20, 22, 86, 123, 198, 28, 219, 132]);
  const { address, bump } = findProgramAddress(['global'], PUMP.program);
  assert.equal(address, pda.global()); assert.ok(bump >= 0 && bump <= 255);
  // a curve PDA depends on the mint; the ATA on owner and mint
  const mint = randomKeypair().address;
  assert.notEqual(pda.bondingCurve(mint), pda.bondingCurve(randomKeypair().address));
  assert.equal(associatedTokenAddress(mint, USDT.mint), associatedTokenAddress(mint, USDT.mint));
  assert.deepEqual([...borshString('ab')], [2, 0, 0, 0, 97, 98]);
});

test('messages: compact-u16, u64, the account ordering the runtime wants, serialize and parse round-trip, signatures in order', () => {
  assert.deepEqual(compactU16(0), [0]); assert.deepEqual(compactU16(127), [127]); assert.deepEqual(compactU16(128), [128, 1]); assert.deepEqual(compactU16(300), [172, 2]);
  assert.deepEqual(readCompactU16(Uint8Array.from([172, 2, 9]), 0), [300, 2]);
  assert.equal(readU64le(u64le(12345678901234n)), 12345678901234n);
  const payer = randomKeypair(), other = randomKeypair(), ro = randomKeypair().address, w = randomKeypair().address;
  const blockhash = encodeBase58(Buffer.alloc(32, 9));
  const instructions = [
    { programId: PROGRAMS.system, keys: [{ pubkey: payer.address, isSigner: true, isWritable: true }, { pubkey: w, isSigner: false, isWritable: true }], data: Uint8Array.of(1, 2, 3) },
    { programId: PROGRAMS.token, keys: [{ pubkey: ro, isSigner: false, isWritable: false }, { pubkey: other.address, isSigner: true, isWritable: false }], data: new Uint8Array(0) },
  ];
  const msg = compileMessage({ feePayer: payer.address, instructions, recentBlockhash: blockhash });
  assert.deepEqual(msg.accountKeys, [payer.address, other.address, w, ro, PROGRAMS.system, PROGRAMS.token]);
  assert.deepEqual(msg.header, { numRequiredSignatures: 2, numReadonlySignedAccounts: 1, numReadonlyUnsignedAccounts: 3 });
  assert.deepEqual(msg.instructions[0], { programIdIndex: 4, accounts: [0, 2], data: Uint8Array.of(1, 2, 3) });
  const bytes = serializeMessage(msg);
  assert.equal(bytes.length, 3 + 1 + 6 * 32 + 32 + 1 + (1 + 1 + 2 + 1 + 3) + (1 + 1 + 2 + 1));
  const signed = signTransaction({ feePayer: payer.address, instructions, recentBlockhash: blockhash }, [other, payer]);
  const parsed = parseTransaction(signed.bytes);
  assert.equal(parsed.signatures.length, 2);
  assert.equal(verify(parsed.messageBytes, parsed.signatures[0], payer.publicKey), true, 'the fee payer signs first');
  assert.equal(verify(parsed.messageBytes, parsed.signatures[1], other.publicKey), true);
  assert.equal(signed.signature, encodeBase58(parsed.signatures[0]));
  assert.deepEqual(parsed.accountKeys, msg.accountKeys); assert.equal(parsed.recentBlockhash, blockhash);
  assert.deepEqual(parsed.instructions[1], { programIdIndex: 5, accounts: [3, 1], data: new Uint8Array(0) });
  assert.deepEqual(fromBase64(toBase64(signed.bytes)), signed.bytes);
  assert.throws(() => signTransaction({ feePayer: payer.address, instructions, recentBlockhash: blockhash }, [payer]), /no key for required signer/);
});

test('instructions: SPL transferChecked and the idempotent associated token account', () => {
  const owner = randomKeypair().address, to = randomKeypair().address;
  const t = ix.transferChecked(associatedTokenAddress(owner, USDT.mint), USDT.mint, associatedTokenAddress(to, USDT.mint), owner, 12_250000n, 6);
  assert.equal(t.programId, PROGRAMS.token);
  assert.equal(t.data[0], 12); assert.equal(readU64le(t.data, 1), 12_250000n); assert.equal(t.data[9], 6);
  assert.deepEqual(t.keys.map((k) => [k.isSigner, k.isWritable]), [[false, true], [false, false], [false, true], [true, false]]);
  const a = ix.createAtaIdempotent(owner, to, USDT.mint);
  assert.equal(a.programId, PROGRAMS.associatedToken); assert.deepEqual([...a.data], [1]);
  assert.equal(a.keys[1].pubkey, associatedTokenAddress(to, USDT.mint)); assert.equal(a.keys[0].pubkey, owner);
  const s = ix.systemTransfer(owner, to, 5n);
  assert.deepEqual([...s.data], [2, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0]);
});
