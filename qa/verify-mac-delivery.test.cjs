'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { verifyMacMetadata } = require('./verify-mac-delivery.cjs');
const headerString = '{"files":{"package.json":{"size":123}}}';
const fixture = () => ({ manifestVersion: '1.6.44', packagedVersion: '1.6.44', headerString,
  info: { CFBundleShortVersionString: '1.6.44', CFBundleVersion: '1.6.44', ElectronAsarIntegrity: {
    'Resources/app.asar': { algorithm: 'SHA256', hash: createHash('sha256').update(headerString).digest('hex') }
  } } });
test('delivery binds both macOS version fields and the actual asar header', () => {
  assert.equal(verifyMacMetadata(fixture()).version, '1.6.44');
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    const value = fixture(); value.info[key] = '1.6.30';
    assert.throws(() => verifyMacMetadata(value), /versions differ/);
  }
  assert.throws(() => verifyMacMetadata({ ...fixture(), packagedVersion: '1.6.43' }), /versions differ/);
  assert.throws(() => verifyMacMetadata({ ...fixture(), headerString: headerString + ' ' }), /integrity mismatch/);
  const missing = fixture(); delete missing.info.ElectronAsarIntegrity;
  assert.throws(() => verifyMacMetadata(missing), /integrity mismatch/);
});
