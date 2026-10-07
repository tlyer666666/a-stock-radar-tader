'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BoundedCache } = require('./bounded-cache.cjs');
const entry = value => ({ value, expiresAt: 1000 });

test('completed cache values obey byte LRU independently of the entry count', () => {
  const cache = new BoundedCache({ maxEntries: 10, maxBytes: 100, now: () => 0 });
  cache.set('a', entry('abcdefghij'));
  cache.set('b', entry('abcdefghij'));
  cache.get('a');
  cache.set('c', entry('abcdefghij'));
  assert.deepEqual([...cache.keys()], ['a', 'c']);
  assert.equal(cache.getDiagnostics().accountedBytes, 90);
});

test('oversize results return normally to callers but replace no retained prior value', async () => {
  const cache = new BoundedCache({ maxBytes: 150, maxEntryBytes: 80, now: () => 0 });
  cache.set('x', entry('old'));
  const fresh = await Promise.resolve('x'.repeat(100)).then(value => { cache.set('x', entry(value)); return value; });
  assert.equal(fresh.length, 100);
  assert.equal(cache.has('x'), false);
  assert.equal(cache.getDiagnostics().accountedBytes, 0);
});

test('byte eviction retains pending producer identity even when completed entries fill the budget', () => {
  const cache = new BoundedCache({ maxEntries: 1, maxBytes: 50, now: () => 0 });
  const promise = new Promise(() => {});
  const pending = { promise, value: 'p'.repeat(10000), expiresAt: 0 };
  cache.set('pending', pending);
  cache.set('a', entry('small'));
  cache.set('b', entry('small'));
  assert.equal(cache.get('pending'), pending);
  assert.equal(cache.has('a'), false);
  assert.equal(cache.getDiagnostics().pendingEntries, 1);
  assert.equal(cache.getDiagnostics().completedEntries, 1);
  assert.ok(cache.getDiagnostics().accountedBytes <= 50);
  cache.set('pending', entry('p'.repeat(10000)));
  assert.equal(cache.has('pending'), false);
  assert.equal(cache.has('b'), true);
});

test('null values and entry metadata are counted and expire with the same accounting', () => {
  let now = 0;
  const cache = new BoundedCache({ maxBytes: 100, now: () => now });
  cache.set('n', { value: null, expiresAt: 10 });
  assert.equal(cache.getDiagnostics().accountedBytes, 35);
  cache.set('meta', { value: null, expiresAt: 100, details: 'm'.repeat(200) });
  assert.equal(cache.has('meta'), false);
  now = 11;
  assert.equal(cache.has('n'), false);
  assert.equal(cache.getDiagnostics().accountedBytes, 0);
});

test('write accounting preserves shared references and bypasses cyclic or unserializable values safely', () => {
  const cache = new BoundedCache({ maxBytes: 200, now: () => 0 });
  const part = { value: 'shared' }, value = [part, part];
  cache.set('shared', entry(value));
  assert.equal(cache.get('shared').value, value);
  assert.equal(cache.getDiagnostics().accountedBytes, 77);
  const cyclic = {}; cyclic.self = cyclic;
  assert.doesNotThrow(() => cache.set('cycle', entry(cyclic)));
  assert.equal(cache.has('cycle'), false);
  assert.doesNotThrow(() => cache.set('bigint', entry(1n)));
  assert.equal(cache.has('bigint'), false);
});

test('cache hits never serialize values and replacing, deleting and clearing balance write accounting', () => {
  let serializations = 0;
  const value = { toJSON() { serializations++; return 'payload'; } };
  const cache = new BoundedCache({ maxBytes: 1000, now: () => 0 });
  cache.set('a', entry(value));
  assert.equal(serializations, 1);
  for (let i = 0; i < 20; i++) { cache.get('a'); cache.has('a'); cache.getDiagnostics(); }
  assert.equal(serializations, 1);
  cache.set('a', entry('replacement'));
  assert.equal(cache.getDiagnostics().accountedBytes, 46);
  cache.delete('a');
  assert.equal(cache.getDiagnostics().accountedBytes, 0);
  cache.set('b', entry('value')); cache.clear();
  assert.equal(cache.getDiagnostics().accountedBytes, 0);
  assert.equal(cache.size, 0);
});

test('a bypassed oversized write still prunes unrelated expired completed entries', () => {
  let now = 0;
  const cache = new BoundedCache({ maxBytes: 80, now: () => now });
  cache.set('old', { value: false, expiresAt: 10 });
  now = 11;
  cache.set('oversized', entry('x'.repeat(100)));
  assert.equal(cache.size, 0);
});

test('fresh cache hits do not inspect unrelated entries on every lookup', () => {
  let expiryReads = 0;
  const cache = new BoundedCache({ maxEntries: 5000, now: () => 0 });
  for (let i = 0; i < 5000; i++) cache.set(i, {
    value: i,
    get expiresAt() { expiryReads++; return 1000; }
  });
  expiryReads = 0;
  for (let i = 0; i < 100; i++) {
    assert.equal(cache.get(i).value, i);
    assert.equal(cache.has(i), true);
  }
  assert.ok(expiryReads <= 200, `stable lookups inspected ${expiryReads} expiry values`);
});

test('expiry scheduling survives replaced minima, deletes, pending values and clear', () => {
  let now = 0;
  const cache = new BoundedCache({ maxEntries: 3, now: () => now });
  cache.set('first', { value: 1, expiresAt: 10 });
  cache.set('later', { value: 2, expiresAt: 20 });
  cache.set('first', { value: 3, expiresAt: 30 });
  cache.set('pending', { promise: Promise.resolve(4), expiresAt: 0 });
  now = 11;
  assert.equal(cache.get('first').value, 3);
  assert.equal(cache.getDiagnostics().completedEntries, 2);
  now = 20;
  assert.equal(cache.has('later'), false);
  assert.equal(cache.getDiagnostics().completedEntries, 1);
  cache.delete('first');
  cache.set('pending', { value: 4, expiresAt: 25, staleUntil: 40 });
  now = 30;
  assert.equal(cache.get('pending').value, 4);
  now = 40;
  assert.equal(cache.has('pending'), false);
  cache.set('after', { value: 5, expiresAt: 45 });
  cache.clear();
  cache.set('after-clear', { value: 6, expiresAt: 41 });
  now = 41;
  assert.equal(cache.has('after-clear'), false);
  assert.equal(cache.getDiagnostics().completedEntries, 0);
  assert.equal(cache.getDiagnostics().accountedBytes, 0);
});

test('non-expiring and pending cache entries survive unrelated expiry sweeps', () => {
  let now = 0;
  const cache = new BoundedCache({ maxEntries: 3, now: () => now });
  cache.set('permanent', { value: 1, expiresAt: Infinity });
  cache.set('metadata-only', { value: 2 });
  const pending = { promise: Promise.resolve(3), expiresAt: -1 };
  cache.set('pending', pending);
  cache.set('finite', { value: 4, expiresAt: 10 });
  now = 100;
  assert.equal(cache.has('finite'), false);
  assert.equal(cache.get('permanent').value, 1);
  assert.equal(cache.get('metadata-only').value, 2);
  assert.equal(cache.get('pending'), pending);
  assert.equal(cache.getDiagnostics().completedEntries, 2);
  assert.equal(cache.getDiagnostics().pendingEntries, 1);
});
