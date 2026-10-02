import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, keccakHex } from '../src/chain/keccak.js';
import { encodeCall, encodeParams, decodeParams, eventTopic, selector, toHex } from '../src/chain/abi.js';

test('keccak-256 matches the Ethereum test vectors', () => {
  assert.equal(keccakHex(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccakHex('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(toHex(selector('transfer(address,uint256)')), '0xa9059cbb');
  assert.equal(toHex(selector('balanceOf(address)')), '0x70a08231');
  assert.equal(eventTopic('Transfer(address,address,uint256)'), '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  // a block longer than the rate (136 bytes) exercises multi-block absorption
  assert.equal(keccak256('a'.repeat(200)).length, 32);
  assert.notEqual(keccakHex('a'.repeat(200)), keccakHex('a'.repeat(201)));
});

test('abi: encodes a transfer call like every wallet does', () => {
  const data = encodeCall('transfer(address,uint256)', ['0x1111111111111111111111111111111111111111', 1000n]);
  assert.equal(data, '0xa9059cbb' + '0'.repeat(24) + '1'.repeat(40) + '0'.repeat(61) + '3e8');
});

test('abi: dynamic strings and nested tuples round-trip through encode and decode', () => {
  const types = ['(string,string,(string,string),address,uint16,bool,bytes32)', 'uint256', 'address'];
  const values = [['Calc agent', 'CALC', ['@calc', 'https://calc.example'], '0x2222222222222222222222222222222222222222', 250, true, '0x' + 'ab'.repeat(32)], 0n, '0x0000000000000000000000000000000000000000'];
  const enc = encodeParams(types, values);
  const dec = decodeParams(types, toHex(enc));
  assert.equal(dec[0][0], 'Calc agent'); assert.equal(dec[0][1], 'CALC');
  assert.deepEqual(dec[0][2], ['@calc', 'https://calc.example']);
  assert.equal(dec[0][3], '0x2222222222222222222222222222222222222222');
  assert.equal(dec[0][4], 250n); assert.equal(dec[0][5], true); assert.equal(dec[0][6], '0x' + 'ab'.repeat(32));
  assert.equal(dec[1], 0n); assert.equal(dec[2], '0x0000000000000000000000000000000000000000');
  // the tuple head is one offset word (dynamic), then uint256 and address words
  assert.equal(enc.length % 32, 0);
  assert.equal(enc.readUInt32BE(28), 96, 'the dynamic tuple starts right after the three head words');
});

test('abi: decodes the static words a curve returns', () => {
  const [q, t] = decodeParams(['uint256', 'uint256'], '0x' + (123n).toString(16).padStart(64, '0') + (456n).toString(16).padStart(64, '0'));
  assert.equal(q, 123n); assert.equal(t, 456n);
  const [b] = decodeParams(['bool'], '0x' + '0'.repeat(63) + '1');
  assert.equal(b, true);
});
