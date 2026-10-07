"use strict";

const finite = value => typeof value === "number" && Number.isFinite(value);

// These are local, versioned conventions, not a promise of terminal parity.
// EMA accepts a period (alpha=2/(N+1)), unlike AI Lab's alpha argument.
// SMA below is Chinese recursive smoothing with M=1, not an arithmetic MA.
function smooth(values, alpha, seed) {
  let previous = seed;
  return values.map(value => {
    if (!finite(value)) return null;
    previous = finite(previous) ? alpha * value + (1 - alpha) * previous : value;
    return previous;
  });
}
const ema = (values, period) => smooth(values, 2 / (period + 1));
const sma = (values, period, seed) => smooth(values, 1 / period, seed);

function rollingMean(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    const window = values.slice(i - period + 1, i + 1);
    return window.every(finite) ? window.reduce((a, b) => a + b, 0) / period : null;
  });
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const fastLine = ema(closes, fast), slowLine = ema(closes, slow);
  const dif = closes.map((_, i) => fastLine[i] - slowLine[i]);
  const dea = ema(dif, signal);
  return { dif, dea, histogram: dif.map((v, i) => 2 * (v - dea[i])) };
}

function boll(closes, period = 20, multiplier = 2) {
  const middle = rollingMean(closes, period);
  const upper = [], lower = [], width = [];
  for (let i = 0; i < closes.length; i++) {
    if (!finite(middle[i]) || middle[i] <= 0) {
      upper.push(null); lower.push(null); width.push(null); continue;
    }
    // Population variance, denominator N (STDP), not TDX's sample STD.
    const variance = closes.slice(i - period + 1, i + 1)
      .reduce((sum, value) => sum + (value - middle[i]) ** 2, 0) / period;
    const halfWidth = multiplier * Math.sqrt(variance);
    upper.push(middle[i] + halfWidth); lower.push(middle[i] - halfWidth);
    width.push(2 * halfWidth / middle[i]);
  }
  return { middle, upper, lower, width };
}

function dmi(rows, period = 14, adxPeriod = 6) {
  const tr = [null], positive = [null], negative = [null];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i], previous = rows[i - 1];
    const hd = row.high - previous.high, ld = previous.low - row.low;
    tr.push(Math.max(row.high - row.low, Math.abs(row.high - previous.close), Math.abs(row.low - previous.close)));
    positive.push(hd > 0 && hd > ld ? hd : 0);
    negative.push(ld > 0 && ld > hd ? ld : 0);
  }
  // Equal-period means cancel in DI ratios, equivalent to rolling SUM14.
  // ADX is an arithmetic MA6 of DX, not Wilder's recursive average or DDI.
  const trMean = rollingMean(tr, period), plusMean = rollingMean(positive, period), minusMean = rollingMean(negative, period);
  const pdi = [], mdi = [], dx = [];
  for (let i = 0; i < rows.length; i++) {
    const valid = finite(trMean[i]) && trMean[i] > 0;
    pdi.push(valid ? 100 * plusMean[i] / trMean[i] : null);
    mdi.push(valid ? 100 * minusMean[i] / trMean[i] : null);
    const denominator = valid ? pdi[i] + mdi[i] : 0;
    dx.push(denominator > 0 ? 100 * Math.abs(pdi[i] - mdi[i]) / denominator : null);
  }
  return { pdi, mdi, dx, adx: rollingMean(dx, adxPeriod) };
}

function obv(rows) {
  let current = 0;
  return rows.map((row, i) => {
    // Flat closes contribute zero. The initial offset never affects new highs.
    if (i) current += Math.sign(row.close - rows[i - 1].close) * row.volume;
    return current;
  });
}

function kdj(rows, period = 9, kPeriod = 3, dPeriod = 3) {
  const rsv = [], k = [], d = [], j = [];
  let previousK = 50, previousD = 50;
  for (let i = 0; i < rows.length; i++) {
    const window = rows.slice(Math.max(0, i - period + 1), i + 1);
    const low = Math.min(...window.map(row => row.low)), high = Math.max(...window.map(row => row.high));
    if (window.length < period || high <= low) {
      rsv.push(null); k.push(null); d.push(null); j.push(null); continue;
    }
    const value = 100 * (rows[i].close - low) / (high - low);
    previousK = value / kPeriod + (1 - 1 / kPeriod) * previousK;
    previousD = previousK / dPeriod + (1 - 1 / dPeriod) * previousD;
    rsv.push(value); k.push(previousK); d.push(previousD); j.push(3 * previousK - 2 * previousD);
  }
  return { rsv, k, d, j };
}

function crossedAbove(previousA, previousB, currentA, currentB) {
  return [previousA, previousB, currentA, currentB].every(finite) && previousA <= previousB && currentA > currentB;
}

function rsi(closes, period = 14) {
  const changes = closes.map((close, i) => i && finite(close) && finite(closes[i - 1]) ? close - closes[i - 1] : null);
  const gain = sma(changes.map(value => finite(value) ? Math.max(value, 0) : null), period);
  const move = sma(changes.map(value => finite(value) ? Math.abs(value) : null), period);
  // First non-missing difference seeds both recursions. Require N changes
  // before publishing, and do not invent 50 for a constant-price series.
  return closes.map((_, i) => i >= period && finite(move[i]) && move[i] > 0 ? 100 * gain[i] / move[i] : null);
}
function cci(rows, period = 14) {
  const typical = rows.map(row => (row.high + row.low + row.close) / 3);
  const means = rollingMean(typical, period);
  return typical.map((value, i) => {
    if (!finite(means[i])) return null;
    const deviation = typical.slice(i - period + 1, i + 1).reduce((sum, x) => sum + Math.abs(x - means[i]), 0) / period;
    return deviation > 0 ? (value - means[i]) / (.015 * deviation) : null;
  });
}
function roc(closes, period = 12) {
  return closes.map((value, i) => i >= period && finite(value) && finite(closes[i - period]) && closes[i - period] > 0
    ? 100 * (value - closes[i - period]) / closes[i - period] : null);
}
function mfi(rows, period = 14) {
  const typical = rows.map(row => (row.high + row.low + row.close) / 3);
  const positive = [], negative = [];
  rows.forEach((row, i) => {
    if (!i || !finite(typical[i]) || !finite(typical[i - 1]) || !finite(row.volume) || row.volume <= 0) {
      positive.push(null); negative.push(null); return;
    }
    const flow = typical[i] * row.volume;
    // Match THS's published factor convention: flat TYP belongs to NMF.
    // This is an OHLCV proxy, never a claim of measured cash inflows.
    positive.push(typical[i] > typical[i - 1] ? flow : 0);
    negative.push(typical[i] > typical[i - 1] ? 0 : flow);
  });
  const pm = rollingMean(positive, period), nm = rollingMean(negative, period);
  return pm.map((value, i) => finite(value) && finite(nm[i]) && value + nm[i] > 0 ? 100 * value / (value + nm[i]) : null);
}
function emv(rows, period = 14, volumeDivisor = 100000000) {
  // TradingView's documented EOM convention. Not the alternate normalized
  // EMV formula found in some Chinese terminals. Scaling changes no zero-cross.
  const values = rows.map((row, i) => !i || !finite(row.volume) || row.volume <= 0 || !(row.high > row.low) ? null
    : ((row.high + row.low - rows[i - 1].high - rows[i - 1].low) / 2) * (row.high - row.low) * volumeDivisor / row.volume);
  return rollingMean(values, period);
}
function donchian(rows, period = 55) {
  const upper = [], lower = [];
  rows.forEach((_, i) => {
    const window = rows.slice(Math.max(0, i - period), i);
    const valid = window.length === period && window.every(row => finite(row.high) && finite(row.low));
    upper.push(valid ? Math.max(...window.map(row => row.high)) : null);
    lower.push(valid ? Math.min(...window.map(row => row.low)) : null);
  });
  return { upper, lower };
}

module.exports = { ema, sma, rollingMean, macd, boll, dmi, obv, kdj, rsi, cci, roc, mfi, emv, donchian, crossedAbove };
