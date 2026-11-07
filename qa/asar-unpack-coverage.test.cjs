'use strict';
// Packaging guard: every file a worker pulls in must be listed in `build.asarUnpack`.
//
// A `worker_threads.Worker` cannot be started from a path inside `app.asar`, so the
// worker entry points are unpacked next to the archive. Their *dependencies* therefore
// have to be unpacked too: an unpacked module resolves its own `require("./x.cjs")` or
// `require("../config/x.json")` relative to its real directory, not back inside the
// archive. Missing this produced two real failures while enabling asar (a missing
// sibling module, then a missing config JSON), and it is silent until a packaged build
// actually runs a worker. This test catches the whole class without needing a package.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'electron');
const { build } = require(path.join(ROOT, 'package.json'));
const patterns = build.asarUnpack || [];

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function isUnpacked(file) {
  const rel = relative(file);
  return patterns.some((pattern) => pattern.endsWith('/**')
    ? rel.startsWith(pattern.slice(0, -2))
    : rel === pattern);
}

/** Local (relative) require specifiers of a CommonJS file. */
function localRequires(file) {
  const source = fs.readFileSync(file, 'utf8');
  const found = new Set();
  for (const match of source.matchAll(/require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    const resolved = path.resolve(path.dirname(file), match[1]);
    if (fs.existsSync(resolved)) found.add(resolved);
  }
  return [...found];
}

function closureOf(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const next of localRequires(file)) if (!seen.has(next)) queue.push(next);
  }
  return [...seen].sort();
}

test('asar is enabled and the worker entry points are unpacked', () => {
  assert.equal(build.asar, true, 'asar must stay enabled for this guard to matter');
  const workers = fs.readdirSync(ELECTRON).filter((name) => name.endsWith('-worker.cjs'));
  assert.ok(workers.length >= 3, `expected the worker entry points, found ${workers.join(', ')}`);
  for (const worker of workers) {
    assert.ok(isUnpacked(path.join(ELECTRON, worker)), `${worker} would not be unpacked`);
  }
});

test('every file reachable from a worker is covered by build.asarUnpack', () => {
  const entries = fs.readdirSync(ELECTRON)
    .filter((name) => name.endsWith('-worker.cjs'))
    .map((name) => path.join(ELECTRON, name));
  const closure = closureOf(entries);
  const uncovered = closure.filter((file) => !isUnpacked(file)).map(relative);
  assert.deepEqual(uncovered, [],
    `these worker dependencies would not exist outside app.asar: ${uncovered.join(', ')}`);
  // Sanity: the closure must be non-trivial, otherwise this guard proves nothing.
  assert.ok(closure.length > 3, `worker dependency closure looks too small: ${closure.length}`);
});
