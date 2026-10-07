'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseArgs, captureSourceManifest, assessContinuity } = require('./run-stability-soak.cjs');

const script = path.join(__dirname, 'run-stability-soak.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function launch(output, extra = []) {
  const child = spawn(process.execPath, ['--expose-gc', script, '--output', output, '--duration-ms', '2400',
    '--wave-interval-ms', '100', '--checkpoint-ms', '300', '--worker-every', '1', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}
async function until(predicate) {
  const deadline = Date.now() + 7000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'bounded wait for actual checkpoint'); await delay(20); }
}
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-soak-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('CLI defaults to eight hours and rejects accidental unbounded or excessive rate inputs', () => {
  const defaults = parseArgs(['--output', '/tmp/qa-example']);
  assert.equal(defaults.durationMs, 28_800_000);
  assert.equal(defaults.waveIntervalMs, 10_000);
  assert.equal(defaults.checkpointMs, 60_000);
  for (const args of [['--duration-ms', 'NaN'], ['--duration-ms', '0'], ['--wave-interval-ms', '1'], ['--unknown', 'x']]) {
    assert.throws(() => parseArgs(['--output', '/tmp/qa-example', ...args]));
  }
});

test('elapsed eight hours cannot pass when sleep or too few actual work waves breaks load continuity', () => {
  const normal = { durationMs: 28_800_000, waveIntervalMs: 10000, waveActiveMs: 3000000, completedWaves: 2880, maximumWallGapMs: 60010 };
  assert.equal(assessContinuity(normal).complete, true);
  assert.equal(assessContinuity({ ...normal, maximumWallGapMs: 28_000_000 }).complete, false);
  assert.equal(assessContinuity({ ...normal, completedWaves: 1, waveActiveMs: 1000 }).complete, false);
  assert.equal(assessContinuity({ ...normal, completedWaves: 0 }).complete, false);
});

test('short CLI exercises real HTTP bodies, aborts, failures, worker and cache, then drains and hashes evidence', { timeout: 15000 }, async t => {
  const output = path.join(temporary(t), 'run');
  const run = launch(output);
  t.after(() => { if (run.child.exitCode === null) run.child.kill('SIGTERM'); });
  const result = await run.done;
  assert.equal(result.code, 0, result.stderr);
  const startup = JSON.parse(fs.readFileSync(path.join(output, 'startup.json'), 'utf8'));
  const checkpoint = JSON.parse(fs.readFileSync(path.join(output, 'checkpoint.json'), 'utf8'));
  const bytes = fs.readFileSync(path.join(output, 'summary.json'));
  const summary = JSON.parse(bytes);
  assert.equal(summary.status, 'passed');
  assert.equal(summary.eightHoursCompleted, false);
  assert.equal(summary.unexpectedErrors.length, 0);
  assert.ok(summary.completedWaves >= 1);
  for (const field of ['httpSuccesses', 'httpSlowBodies', 'rawCancelled', 'callerCancelled', 'bodyTimeouts', 'httpFailures', 'workerCompleted', 'cacheOversizeRejected']) {
    assert.ok(summary.counts[field] >= 1, `the real ${field} path was exercised`);
  }
  assert.equal(summary.finalResources.transport.active, 0);
  assert.equal(summary.finalResources.transport.pending, 0);
  assert.equal(summary.finalResources.workers, 0);
  assert.equal(summary.finalResources.sockets, 0);
  assert.equal(summary.finalResources.serverResponses, 0);
  assert.equal(summary.finalResources.resources.includes('Timeout'), false, 'the QA cleanup watchdog is removed before final resource sampling');
  assert.equal(summary.finalResources.cache.accountedBytes, 0);
  assert.equal(summary.sourceHash, startup.sourceHash);
  assert.equal(startup.pid, run.child.pid);
  assert.equal(startup.exposedGc, true);
  assert.ok(checkpoint.samples.length <= 60);
  assert.ok(bytes.length < 150_000);
  assert.equal(fs.readFileSync(path.join(output, 'summary.sha256'), 'utf8').trim(), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(fs.readdirSync(output).some(name => name.includes('.tmp-')), false);
});

test('SIGTERM writes interrupted evidence and physically drains instead of reporting an eight-hour pass', { timeout: 15000 }, async t => {
  const output = path.join(temporary(t), 'run');
  const run = launch(output, ['--duration-ms', '30000']);
  t.after(() => { if (run.child.exitCode === null) run.child.kill('SIGTERM'); });
  await until(() => fs.existsSync(path.join(output, 'checkpoint.json')));
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.code, 2, result.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'interrupted');
  assert.equal(summary.eightHoursCompleted, false);
  assert.equal(summary.finalResources.sockets, 0);
  assert.equal(summary.finalResources.workers, 0);
  assert.equal(summary.finalResources.transport.active, 0);
  assert.ok(fs.existsSync(path.join(output, 'failure.json')));
});

test('existing evidence is never silently replaced by a new run', { timeout: 5000 }, async t => {
  const output = temporary(t);
  fs.writeFileSync(path.join(output, 'startup.json'), '{"sentinel":true}\n');
  const result = await launch(output).done;
  assert.equal(result.code, 1);
  assert.equal(fs.readFileSync(path.join(output, 'startup.json'), 'utf8'), '{"sentinel":true}\n');
});

test('source identity changes on production content drift and ignores test artifact edits', t => {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'electron')); fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(path.join(root, 'qa'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"0.0.0"}');
  fs.writeFileSync(path.join(root, 'electron', 'example.cjs'), 'exports.x = 1;');
  fs.writeFileSync(path.join(root, 'qa', 'run-stability-soak.cjs'), '// harness');
  const first = captureSourceManifest(root);
  fs.writeFileSync(path.join(root, 'electron', 'example.test.cjs'), '// changed test');
  assert.equal(captureSourceManifest(root).sourceHash, first.sourceHash);
  fs.writeFileSync(path.join(root, 'electron', 'example.cjs'), 'exports.x = 2;');
  assert.notEqual(captureSourceManifest(root).sourceHash, first.sourceHash);
});

test('a startup module failure leaves explicit failed evidence instead of an orphan running startup', { timeout: 5000 }, async t => {
  const root = temporary(t), output = path.join(root, 'evidence');
  for (const directory of ['qa', 'electron', 'config']) fs.mkdirSync(path.join(root, directory));
  fs.copyFileSync(script, path.join(root, 'qa', 'run-stability-soak.cjs'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"qa-broken-startup"}');
  const child = spawn(process.execPath, ['--expose-gc', path.join(root, 'qa', 'run-stability-soak.cjs'), '--output', output], { stdio: 'ignore' });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 1);
  const failure = JSON.parse(fs.readFileSync(path.join(output, 'failure.json'), 'utf8'));
  assert.equal(failure.status, 'failed');
  assert.equal(failure.reason.code, 'MODULE_NOT_FOUND');
  assert.equal(failure.pid, child.pid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8')).status, 'failed');
});

test('an actual uncaught runtime exception writes failed evidence and drains the dedicated QA process', { timeout: 10000 }, async t => {
  const output = path.join(temporary(t), 'run');
  const code = `const fs=require('node:fs');const {runSoak,parseArgs}=require(${JSON.stringify(script)});
    const output=${JSON.stringify(output)};const p=runSoak(parseArgs(['--output',output,'--duration-ms','30000']));
    const probe=setInterval(()=>{if(fs.existsSync(output+'/checkpoint.json')){clearInterval(probe);throw new Error('QA intentional uncaught fault');}},10);
    p.then(result=>{process.exitCode=result.status==='failed'?1:0;});`;
  const child = spawn(process.execPath, ['--expose-gc', '-e', code], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  assert.equal(await new Promise(resolve => child.once('close', resolve)), 1);
  const summary = JSON.parse(fs.readFileSync(path.join(output, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'failed'); assert.equal(summary.eightHoursCompleted, false);
  assert.equal(summary.unexpectedErrors.length, 1);
  assert.match(summary.unexpectedErrors[0].message, /intentional uncaught fault/);
  assert.equal(summary.finalResources.transport.active, 0); assert.equal(summary.finalResources.workers, 0);
});
