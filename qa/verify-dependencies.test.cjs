"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseRootImporter, verifyVersions, evaluateAudit, run } = require("./verify-dependencies.cjs");

const lockText = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      '@types/react':
        specifier: 18.3.31
        version: 18.3.31
      electron:
        specifier: 43.5.0
        version: 43.5.0(supports-color@8.1.1)
  another:
    devDependencies:
      electron:
        specifier: 1.0.0
        version: 1.0.0
packages:
  electron@43.5.0: {}
`;
const manifest = { devDependencies: { '@types/react': '18.3.31', electron: '43.5.0' } };
const installed = { '@types/react': '18.3.31', electron: '43.5.0' };
function versions(overrides = {}) {
  return verifyVersions({ manifest, importer: parseRootImporter(lockText), installed, runtime: { electron: '43.5.0', node: '24.19.0', undici: '7.29.1' }, ...overrides });
}
function audit(advisories = {}, severity = {}) {
  return { advisories, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...severity } } };
}
const runtimeAdvisory = { module_name: 'electron', severity: 'high', github_advisory_id: 'GHSA-test-1234-5678', findings: [{ version: '43.3.0', paths: ['.>electron'], dev: true }] };

test('root lock parsing isolates workspace root and strips peer resolution suffix', () => {
  assert.deepEqual(parseRootImporter(lockText), { '@types/react': { specifier: '18.3.31', version: '18.3.31' }, electron: { specifier: '43.5.0', version: '43.5.0' } });
});
test('unsupported or incomplete lock importers fail closed', () => {
  for (const text of ['lockfileVersion: 8', 'lockfileVersion: 9\nimporters:\n  other: {}', lockText.replace('specifier: 43.5.0', 'specifier: 43.5.0\n        specifier: 43.3.0'), lockText.replace('version: 43.5.0(supports-color@8.1.1)', '')]) {
    assert.throws(() => parseRootImporter(text), /lock|importer|duplicate|specifier|version/i);
  }
});
test('all direct package versions and actual runtime must agree', () => {
  assert.equal(versions().directDependencies, 2);
});
test('manifest range or stale root lock specifier cannot pass release verification', () => {
  assert.throws(() => versions({ manifest: { devDependencies: { electron: '^43.5.0' } } }), /exact|pinned/);
  assert.throws(() => versions({ importer: { ...parseRootImporter(lockText), electron: { specifier: '43.3.0', version: '43.5.0' } } }), /electron.*lock/i);
});
test('installed packages and actual Electron executable cannot drift from lock', () => {
  assert.throws(() => versions({ installed: { ...installed, electron: '43.3.0' } }), /electron.*installed/i);
  assert.throws(() => versions({ runtime: { electron: '43.3.0' } }), /runtime.*43.3.0/i);
  assert.throws(() => versions({ installed: { electron: '43.5.0' } }), /@types\/react.*installed/i);
});
test('stale dependencies remaining in importer fail even if current dependencies match', () => {
  assert.throws(() => versions({ importer: { ...parseRootImporter(lockText), removed: { specifier: '1.0.0', version: '1.0.0' } } }), /removed|extra|stale/);
});
test('high runtime advisory blocks even when npm classifies Electron as dev only', () => {
  assert.throws(() => evaluateAudit(audit({ '1': runtimeAdvisory }, { high: 1 }), 1), /GHSA-test-1234-5678.*electron|electron.*GHSA-test-1234-5678/);
});
test('critical and high build-time advisories also block; moderate remains visible', () => {
  assert.throws(() => evaluateAudit(audit({ '1': { ...runtimeAdvisory, module_name: 'builder-tool', severity: 'critical' } }, { critical: 1 }), 1), /builder-tool/);
  const result = evaluateAudit(audit({ '1': { ...runtimeAdvisory, severity: 'moderate' } }, { moderate: 1 }), 1);
  assert.equal(result.records, 1);
  assert.equal(result.severity.moderate, 1);
});
test('audit transport errors, malformed payload and inconsistent counts never pass', () => {
  for (const payload of [{}, { error: { message: 'registry unavailable' } }, { advisories: {} }, audit({}, { high: 1 }), audit({}, { mystery: 2 })]) {
    assert.throws(() => evaluateAudit(payload, 1), /audit|count|severity/i);
  }
  assert.throws(() => evaluateAudit(audit(), 2), /audit.*exit|exit.*2/i);
  assert.throws(() => evaluateAudit(audit(), null), /audit.*exit/i);
});
test('successful clean audit reports zero rather than suppressing data', () => {
  assert.deepEqual(evaluateAudit(audit(), 0).severity, { info: 0, low: 0, moderate: 0, high: 0, critical: 0 });
});

test('an audit-clean npm graph cannot mask an affected embedded undici runtime', () => {
  assert.throws(() => versions({ runtime: { electron: '43.5.0', undici: '7.29.0' } }), /undici.*7.29.0.*7.29.1/);
  assert.throws(() => versions({ runtime: { electron: '43.5.0' } }), /undici/);
});

test('verification requires an installed binary without auto-installing or accepting an escaped path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-dependency-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), lockText);
  const electron = path.join(root, 'node_modules', 'electron');
  fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ version: '43.5.0' }));
  assert.throws(() => run(root), /binary is not installed/);
  assert.equal(fs.existsSync(path.join(electron, 'dist')), false);
  fs.writeFileSync(path.join(electron, 'path.txt'), '../package.json');
  assert.throws(() => run(root), /outside its installed distribution/);
});
