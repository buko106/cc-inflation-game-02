const test = require('node:test');
const assert = require('node:assert/strict');
const BigNum = require('../js/bignum.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test('normalize keeps mantissa in [1, 10)', () => {
  const b = BigNum.from(12345);
  close(b.m, 1.2345);
  assert.equal(b.e, 4);
  const s = BigNum.from(0.05);
  close(s.m, 5);
  assert.equal(s.e, -2);
  assert.ok(BigNum.from(0).isZero());
});

test('arithmetic matches Number for small values', () => {
  const a = BigNum.from(1234.5);
  const b = BigNum.from(99.25);
  close(a.add(b).toNumber(), 1333.75);
  close(a.sub(b).toNumber(), 1135.25);
  close(a.mul(b).toNumber(), 1234.5 * 99.25);
  close(a.div(b).toNumber(), 1234.5 / 99.25);
  close(BigNum.from(2).pow(10).toNumber(), 1024);
  close(BigNum.from(81).sqrt().toNumber(), 9);
});

test('handles values beyond Number.MAX_VALUE', () => {
  const big = BigNum.from('1e300').mul('1e300');
  assert.equal(big.e, 600);
  close(big.m, 1);
  const huge = BigNum.from(10).pow(1e6);
  assert.equal(huge.e, 1e6);
  assert.ok(huge.gt(big));
  assert.equal(big.toNumber(), Infinity);
  close(big.div('1e599').toNumber(), 10);
});

test('adding numbers with very different exponents ignores the tiny one', () => {
  const a = BigNum.from('1e100');
  assert.ok(a.add(1).eq(a));
  assert.ok(BigNum.from(1).add(a).eq(a));
});

test('comparison handles signs and zero', () => {
  assert.ok(BigNum.from(-5).lt(3));
  assert.ok(BigNum.from(-5).lt(-2));
  assert.ok(BigNum.from(0).gt(-1));
  assert.ok(BigNum.from('1e50').gt('9e49'));
  assert.equal(BigNum.from(7).cmp(7), 0);
  assert.ok(BigNum.from(3).max(9).eq(9));
  assert.ok(BigNum.from(3).min(9).eq(3));
});

test('floor', () => {
  assert.equal(BigNum.from(12.9).floor().toNumber(), 12);
  assert.equal(BigNum.from(0.9).floor().toNumber(), 0);
  assert.ok(BigNum.from('1.5e40').floor().eq('1.5e40'));
});

test('JSON round trip', () => {
  const x = BigNum.from('3.14e12345');
  const y = BigNum.from(JSON.parse(JSON.stringify({ x })).x);
  assert.ok(x.eq(y));
  assert.ok(BigNum.from({ m: 2, e: 3 }).eq(2000));
});

test('Japanese formatting', () => {
  assert.equal(BigNum.format(0), '0');
  assert.equal(BigNum.format(1234), '1,234');
  assert.equal(BigNum.format(12345), '1.234万');
  assert.equal(BigNum.format(123456789), '1.234億');
  assert.equal(BigNum.format(5e12), '5兆');
  assert.equal(BigNum.format('9.999e71'), '9999無量大数');
  assert.equal(BigNum.format('1.5e72'), '1.500e72');
  assert.equal(BigNum.format('1e1234567'), 'e123.4万');
  assert.equal(BigNum.format(-12345), '-1.234万');
});

test('scientific formatting', () => {
  assert.equal(BigNum.format(123456, 'sci'), '123,456');
  assert.equal(BigNum.format(1234567, 'sci'), '1.234e6');
  assert.equal(BigNum.format('2e400', 'sci'), '2.000e400');
  assert.equal(BigNum.format('1e1234567', 'sci'), 'e1.234e6');
});
