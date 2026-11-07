'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
const restore = registerTypeScript();
const { selectBonds, toggleBondSort, bondSortState } = require('./features/bonds/bondTypes.ts');
after(restore);

const bond = (code, latest, changePct, patch = {}) => ({ code, name: `转债${code}`, market: code.startsWith('11') ? 19 : 35, stockCode: '', stockName: '', listingDate: '', expireDate: '',
  source: 'discovered', latest, preClose: null, changePct, amount: latest ? latest * 1e6 : null, volume: null, turnover: null, amplitude: null, high: null, low: null,
  quoteAt: '', quoteStatus: latest ? 'ready' : 'unavailable', remainingYears: null, secid: '', thscode: '', ...patch });

test('bonds filter by exchange, price band and text, and sort with missing quotes last', () => {
  const rows = [bond('113052', 112.1, -0.1), bond('123288', 131.5, 0.5, { stockName: '隆华新材料', stockCode: '301149' }), bond('128136', null, null), bond('118077', 105, 1.8)];
  assert.deepEqual(selectBonds(rows, { query: '', market: 'all', price: 'all', sort: 'change-desc' }).map(b => b.code), ['118077', '123288', '113052', '128136']);
  assert.deepEqual(selectBonds(rows, { query: '', market: 'sh', price: 'all', sort: 'price-asc' }).map(b => b.code), ['118077', '113052']);
  assert.deepEqual(selectBonds(rows, { query: '', market: 'all', price: 'low', sort: 'change-desc' }).map(b => b.code), ['118077']);
  assert.deepEqual(selectBonds(rows, { query: '', market: 'all', price: 'mid', sort: 'change-desc' }).map(b => b.code), ['113052']);
  assert.deepEqual(selectBonds(rows, { query: '隆华', market: 'all', price: 'all', sort: 'change-desc' }).map(b => b.code), ['123288']);
  assert.deepEqual(selectBonds(rows, { query: '301149', market: 'sz', price: 'all', sort: 'amount-desc' }).map(b => b.code), ['123288']);
});

test('clicking a bond column header sorts largest first, then smallest first', () => {
  assert.equal(toggleBondSort('change-desc', 'amount'), 'amount-desc');
  assert.equal(toggleBondSort('amount-desc', 'amount'), 'amount-asc');
  assert.equal(toggleBondSort('amount-asc', 'amount'), 'amount-desc');
  assert.equal(toggleBondSort('price-asc', 'change'), 'change-desc');
  assert.equal(bondSortState('amount-asc', 'amount'), 'ascending');
  assert.equal(bondSortState('amount-asc', 'change'), 'none');
  const rows = [bond('113052', 112.1, -0.1), bond('123288', 131.5, 0.5), bond('128136', null, null), bond('118077', 105, 1.8)];
  assert.deepEqual(selectBonds(rows, { query: '', market: 'all', price: 'all', sort: 'amount-asc' }).map(b => b.code), ['118077', '113052', '123288', '128136']);
  assert.deepEqual(selectBonds(rows, { query: '', market: 'all', price: 'all', sort: 'change-asc' }).map(b => b.code), ['113052', '123288', '118077', '128136']);
});
