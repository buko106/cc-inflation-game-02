/*
 * BigNum: 仮数部 m (1 <= |m| < 10) と指数部 e で数値を表す巨大数クラス。
 * JavaScript の Number の上限 (約 1.8e308) を超えるインフレ数値を扱うために使う。
 * すべての演算はイミュータブルで、新しい BigNum を返す。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BigNum = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // これ以上指数が離れた数の加算は、小さい方を無視しても精度が変わらない
  const MAX_SIGNIFICANT_DIGITS = 17;

  class BigNum {
    constructor(m, e) {
      this.m = m;
      this.e = e;
    }

    static normalize(m, e) {
      if (m === 0 || Number.isNaN(m)) return ZERO;
      if (!Number.isFinite(m)) return m > 0 ? BigNum.fromLog10(Number.MAX_SAFE_INTEGER) : BigNum.fromLog10(Number.MAX_SAFE_INTEGER).neg();
      const abs = Math.abs(m);
      if (abs >= 1 && abs < 10) return new BigNum(m, e);
      let d = Math.floor(Math.log10(abs));
      let nm = m / Math.pow(10, d);
      // 浮動小数点誤差の補正
      if (Math.abs(nm) >= 10) { nm /= 10; d += 1; }
      else if (Math.abs(nm) < 1) { nm *= 10; d -= 1; }
      return new BigNum(nm, e + d);
    }

    static from(x) {
      if (x instanceof BigNum) return x;
      if (typeof x === 'number') return BigNum.normalize(x, 0);
      if (typeof x === 'string') return BigNum.parse(x);
      if (x && typeof x === 'object' && 'm' in x && 'e' in x) return BigNum.normalize(Number(x.m), Number(x.e));
      return ZERO;
    }

    static parse(s) {
      s = String(s).trim();
      const idx = s.toLowerCase().indexOf('e');
      if (idx < 0) return BigNum.normalize(Number(s), 0);
      const mPart = idx === 0 ? 1 : Number(s.slice(0, idx));
      const ePart = Number(s.slice(idx + 1));
      if (!Number.isFinite(mPart) || !Number.isFinite(ePart)) return ZERO;
      const whole = Math.floor(ePart);
      const frac = ePart - whole;
      return BigNum.normalize(mPart * Math.pow(10, frac), whole);
    }

    static fromLog10(l) {
      if (l === -Infinity) return ZERO;
      const e = Math.floor(l);
      return BigNum.normalize(Math.pow(10, l - e), e);
    }

    isZero() { return this.m === 0; }
    sign() { return Math.sign(this.m); }
    neg() { return new BigNum(-this.m, this.e); }
    abs() { return this.m < 0 ? this.neg() : this; }

    add(other) {
      const b = BigNum.from(other);
      if (this.m === 0) return b;
      if (b.m === 0) return this;
      const diff = this.e - b.e;
      if (diff > MAX_SIGNIFICANT_DIGITS) return this;
      if (diff < -MAX_SIGNIFICANT_DIGITS) return b;
      if (diff >= 0) return BigNum.normalize(this.m + b.m * Math.pow(10, -diff), this.e);
      return BigNum.normalize(b.m + this.m * Math.pow(10, diff), b.e);
    }

    sub(other) { return this.add(BigNum.from(other).neg()); }

    mul(other) {
      const b = BigNum.from(other);
      if (this.m === 0 || b.m === 0) return ZERO;
      return BigNum.normalize(this.m * b.m, this.e + b.e);
    }

    div(other) {
      const b = BigNum.from(other);
      if (b.m === 0) throw new RangeError('BigNum: division by zero');
      if (this.m === 0) return ZERO;
      return BigNum.normalize(this.m / b.m, this.e - b.e);
    }

    // 負でない数のみ対応
    pow(n) {
      if (this.m === 0) return n === 0 ? ONE : ZERO;
      if (this.m < 0) throw new RangeError('BigNum: pow of negative number');
      return BigNum.fromLog10(this.log10() * n);
    }

    sqrt() { return this.pow(0.5); }

    log10() {
      if (this.m <= 0) return -Infinity;
      return Math.log10(this.m) + this.e;
    }

    floor() {
      if (this.e >= 15) return this;
      if (this.e < 0) return this.m < 0 ? BigNum.from(-1) : ZERO;
      return BigNum.normalize(Math.floor(this.m * Math.pow(10, this.e)), 0);
    }

    cmp(other) {
      const b = BigNum.from(other);
      const sa = Math.sign(this.m);
      const sb = Math.sign(b.m);
      if (sa !== sb) return sa > sb ? 1 : -1;
      if (sa === 0) return 0;
      if (this.e !== b.e) {
        const r = this.e > b.e ? 1 : -1;
        return sa > 0 ? r : -r;
      }
      if (this.m === b.m) return 0;
      return this.m > b.m ? 1 : -1;
    }

    gt(o) { return this.cmp(o) > 0; }
    gte(o) { return this.cmp(o) >= 0; }
    lt(o) { return this.cmp(o) < 0; }
    lte(o) { return this.cmp(o) <= 0; }
    eq(o) { return this.cmp(o) === 0; }

    max(o) { const b = BigNum.from(o); return this.gte(b) ? this : b; }
    min(o) { const b = BigNum.from(o); return this.lte(b) ? this : b; }

    toNumber() {
      if (this.e > 308) return this.m > 0 ? Infinity : -Infinity;
      if (this.e < -324) return 0;
      return this.m * Math.pow(10, this.e);
    }

    toJSON() { return this.m + 'e' + this.e; }
    toString() { return this.toJSON(); }
  }

  const ZERO = new BigNum(0, 0);
  const ONE = new BigNum(1, 0);
  BigNum.ZERO = ZERO;
  BigNum.ONE = ONE;

  // ---------------------------------------------------------------------------
  // 表示用フォーマット
  // ---------------------------------------------------------------------------
  const JP_UNITS = ['', '万', '億', '兆', '京', '垓', '秭', '穣', '溝', '澗', '正', '載', '極',
    '恒河沙', '阿僧祇', '那由他', '不可思議', '無量大数'];
  const JP_LIMIT_EXP = JP_UNITS.length * 4; // 1e72 未満は漢数字の単位で表示

  function withCommas(n) {
    return Math.floor(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // 1 <= v < 10000 を有効数字4桁程度で表示
  function shortDigits(v) {
    if (v >= 1000) return String(Math.floor(v));
    if (v >= 100) return trimZeros((Math.floor(v * 10) / 10).toFixed(1));
    if (v >= 10) return trimZeros((Math.floor(v * 100) / 100).toFixed(2));
    return trimZeros((Math.floor(v * 1000) / 1000).toFixed(3));
  }

  function trimZeros(s) {
    return s.indexOf('.') < 0 ? s : s.replace(/\.?0+$/, '');
  }

  function formatScientific(b) {
    if (b.e < 6) return withCommas(b.toNumber());
    const m = Math.floor(b.m * 1000) / 1000;
    if (b.e < 1e6) return m.toFixed(3) + 'e' + withCommas(b.e);
    return 'e' + formatScientific(BigNum.from(b.e));
  }

  function formatJapanese(b) {
    if (b.e < 4) return withCommas(b.toNumber());
    if (b.e < JP_LIMIT_EXP) {
      const unitIdx = Math.floor(b.e / 4);
      const v = b.m * Math.pow(10, b.e - unitIdx * 4);
      return shortDigits(v) + JP_UNITS[unitIdx];
    }
    const m = Math.floor(b.m * 1000) / 1000;
    if (b.e < 1e6) return m.toFixed(3) + 'e' + withCommas(b.e);
    // 指数自体もインフレしたら「e」の後ろを漢数字で表示
    return 'e' + formatJapanese(BigNum.from(b.e));
  }

  BigNum.format = function (x, notation) {
    const b = BigNum.from(x);
    if (b.m === 0) return '0';
    if (b.m < 0) return '-' + BigNum.format(b.neg(), notation);
    if (b.e < 0) return trimZeros(b.toNumber().toFixed(2));
    return notation === 'sci' ? formatScientific(b) : formatJapanese(b);
  };

  return BigNum;
});
