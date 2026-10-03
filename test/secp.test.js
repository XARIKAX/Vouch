import test from 'node:test';
import assert from 'node:assert/strict';
import { addressFromPrivate, sign, recover, recoverAddress, personalHash, signPersonal, publicKey, addressOf, checksum, sigToBytes } from '../src/chain/secp256k1.js';
import { rlp, rlpDecode, signEip1559 } from '../src/chain/tx.js';
import { keccak256 } from '../src/chain/keccak.js';

test('secp256k1: known private keys give the known addresses', () => {
  assert.equal(addressFromPrivate('0x' + '0'.repeat(63) + '1').toLowerCase(), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  assert.equal(addressFromPrivate('0x' + '0'.repeat(63) + '2').toLowerCase(), '0x2b5ad5c4795c026514f8317c7a215e218dccd6cf');
  assert.equal(checksum('0x7e5f4552091a69125d5dfcb7b8c2659029395bdf'), '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
});

test('secp256k1: a signature recovers to its signer, is deterministic, and is low-s', () => {
  const priv = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
  const addr = addressFromPrivate(priv);
  const h = keccak256(Buffer.from('hello vouch'));
  const a = sign(h, priv), b = sign(h, priv);
  assert.deepEqual(a, b, 'RFC 6979: same message, same signature');
  assert.ok(a.s <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0n);
  assert.equal(addressOf(recover(h, a.r, a.s, a.recid)).toLowerCase(), addr.toLowerCase());
  assert.equal(recoverAddress(h, '0x' + sigToBytes(a).toString('hex')).toLowerCase(), addr.toLowerCase());
  // a wrong recovery id gives a different key
  assert.notEqual(addressOf(recover(h, a.r, a.s, a.recid ^ 1)).toLowerCase(), addr.toLowerCase());
  assert.equal(publicKey(priv).length, 64);
});

test('secp256k1: EIP-191 personal_sign round-trips and a tampered message fails', () => {
  const priv = '0x' + 'ab'.repeat(32);
  const addr = addressFromPrivate(priv);
  const msg = 'Vouch sign-in\n\nWallet: ' + addr + '\nNonce: abc123';
  const sig = signPersonal(msg, priv);
  assert.equal(recoverAddress(personalHash(msg), sig).toLowerCase(), addr.toLowerCase());
  assert.notEqual(recoverAddress(personalHash(msg + '!'), sig).toLowerCase(), addr.toLowerCase());
});

test('rlp + eip-1559: the raw transaction decodes to its fields and recovers to the sender', () => {
  assert.equal(rlp(Buffer.from([])).toString('hex'), '80');
  assert.equal(rlp(0n).toString('hex'), '80');
  assert.equal(rlp(Buffer.from('dog')).toString('hex'), '83646f67');
  assert.equal(rlp([Buffer.from('cat'), Buffer.from('dog')]).toString('hex'), 'c88363617483646f67');
  assert.equal(rlp(1024n).toString('hex'), '820400');
  const priv = '0x' + '11'.repeat(32), from = addressFromPrivate(priv);
  const tx = { chainId: 4663, nonce: 7, maxPriorityFeePerGas: 0n, maxFeePerGas: 200000000n, gas: 60000n, to: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', value: 0n, data: '0xa9059cbb' + '00'.repeat(12) + '22'.repeat(20) + '00'.repeat(31) + '0a' };
  const { raw, hash } = signEip1559(tx, priv);
  const bytes = Buffer.from(raw.slice(2), 'hex');
  assert.equal(bytes[0], 2);
  const fields = rlpDecode(bytes, 1).value;
  assert.equal(fields.length, 12);
  assert.equal(Number('0x' + fields[0].toString('hex')), 4663);
  assert.equal(Number('0x' + fields[1].toString('hex')), 7);
  assert.equal('0x' + fields[5].toString('hex'), tx.to);
  assert.equal('0x' + fields[7].toString('hex'), tx.data);
  // recover the sender from the signing hash
  const signing = keccak256(Buffer.concat([Buffer.from([2]), rlp(fields.slice(0, 9).map((b, i) => i === 8 ? [] : b))]));
  const v = fields[9].length ? fields[9][0] : 0, r = BigInt('0x' + fields[10].toString('hex')), s = BigInt('0x' + fields[11].toString('hex'));
  assert.equal(addressOf(recover(signing, r, s, v)).toLowerCase(), from.toLowerCase());
  assert.equal(hash.length, 66);
});
