'use strict';
const assert = require('node:assert/strict');
const { test, before, after, beforeEach } = require('node:test');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
let restore, subject, originalWindow, values;
before(() => { restore = registerTypeScript(); subject = require('./safeStorage.ts'); originalWindow = global.window; });
after(() => { restore(); if (originalWindow === undefined) delete global.window; else global.window = originalWindow; });
beforeEach(() => { values = new Map(); global.window = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) } }; });

test('a wrong-shape but parseable primary cannot hide a recoverable collection', () => {
  for (const bad of ['null', '{}', '7', '"oops"']) {
    values.set('list', bad); values.set('list:last-good', '["saved"]');
    assert.deepEqual(subject.loadSafeLocalJson('list', []), ['saved']);
    assert.equal(values.get('list'), bad, 'reads never overwrite the original record');
  }
});
test('a wrong-shape primary is not promoted over the last valid collection during a failed write', () => {
  values.set('list', '{}'); values.set('list:last-good', '["saved"]');
  window.localStorage.setItem = (key, value) => { if (key === 'list') throw Error('quota'); values.set(key, String(value)); };
  assert.equal(subject.saveSafeLocalJson('list', ['next']), false);
  assert.equal(values.get('list:last-good'), '["saved"]');
});
test('unserializable values fail without writing or replacing a recoverable backup', () => {
  values.set('list', '["current"]'); values.set('list:last-good', '["older"]');
  assert.equal(subject.saveSafeLocalJson('list', undefined), false);
  assert.deepEqual([...values], [['list', '["current"]'], ['list:last-good', '["older"]']]);
});
test('record fallback rejects arrays while healthy arrays and primitive fallback types retain their values', () => {
  values.set('record', '[]'); values.set('record:last-good', '{"saved":true}');
  assert.deepEqual(subject.loadSafeLocalJson('record', {}), {saved:true});
  values.set('list', '[]'); assert.deepEqual(subject.loadSafeLocalJson('list', ['fallback']), []);
  values.set('flag', 'false'); assert.equal(subject.loadSafeLocalJson('flag', true), false);
});
test('a failed first primary write never publishes an uncommitted candidate on reload', () => {
  window.localStorage.setItem = (key, value) => { if (key === 'first') throw Error('quota'); values.set(key, String(value)); };
  assert.equal(subject.saveSafeLocalJson('first', ['staged']), false);
  assert.deepEqual(subject.loadSafeLocalJson('first', []), []);
});


test('explicit schema validation recovers a nested document and protects its backup on failure', () => {
  const schema = value => value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.rows);
  values.set('nested', '{"rows":null}'); values.set('nested:last-good', '{"rows":["saved"]}');
  assert.deepEqual(subject.loadSafeLocalJson('nested', {rows:[]}, schema), {rows:['saved']});
  window.localStorage.setItem = (key, value) => { if(key==='nested') throw Error('quota'); values.set(key, String(value)); };
  assert.equal(subject.saveSafeLocalJson('nested', {rows:['next']}, schema), false);
  assert.equal(values.get('nested:last-good'), '{"rows":["saved"]}');
});
test('matching primitive documents and null remain backward compatible', () => {
  for (const [value, fallback] of [[false,true], [0,1], ['', 'fallback'], [null,null]]) {
    assert.equal(subject.saveSafeLocalJson('primitive', value), true);
    assert.equal(subject.loadSafeLocalJson('primitive', fallback), value);
  }
});

test('a committed first primary remains successful if optional backup allocation fails', () => {
  window.localStorage.setItem = (key, value) => { if (key.endsWith(':last-good')) throw Error('quota'); values.set(key, String(value)); };
  assert.equal(subject.saveSafeLocalJson('first', ['committed']), true);
  assert.deepEqual(subject.loadSafeLocalJson('first', []), ['committed']);
});
