'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const RECEIPT = 'build-provenance.json';
const INPUT_FOLDERS = ['src', 'electron', 'config', '.github', 'qa', 'assets', 'public'];
const ROOT_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.ts', '.html', '.ico', '.png', '.svg']);
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function assertManagedPath(root, target) {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Build root symlink is not supported: ${root}`);
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe managed build path');
  let cursor = path.resolve(root);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let info;
    try { info = fs.lstatSync(cursor); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) throw new Error(`Build input/output symlink is not supported: ${cursor}`);
  }
}

function walkFiles(root, directory, accept, result) {
  assertManagedPath(root, directory);
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name === '.DS_Store') continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Build input/output symlink is not supported: ${file}`);
    if (entry.isDirectory()) walkFiles(root, file, accept, result);
    else if (entry.isFile() && accept(file)) result[path.relative(root, file).split(path.sep).join('/')] = sha(file);
  }
}
function sorted(object) { return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)); }

function snapshotBuildInputs(root) {
  const result = {};
  for (const folder of INPUT_FOLDERS) {
    assertManagedPath(root, path.join(root, folder));
    walkFiles(root, path.join(root, folder), file => !(folder === 'qa' && path.basename(file).startsWith('build-') && file.endsWith('-report.py')), result);
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ROOT_EXTENSIONS.has(path.extname(entry.name)) && entry.name !== '.npmrc') continue;
    if (entry.isSymbolicLink()) throw new Error(`Build input symlink is not supported: ${entry.name}`);
    if (entry.isFile()) result[entry.name] = sha(path.join(root, entry.name));
  }
  if (!Object.keys(result).length) throw new Error('No build inputs');
  return sorted(result);
}

function snapshotOutputs(directory, kind) {
  const result = {};
  walkFiles(directory, directory, file => {
    const relative = path.relative(directory, file).split(path.sep).join('/');
    return relative !== RECEIPT && !(kind === 'web' && relative.startsWith('review/'));
  }, result);
  if (!Object.keys(result).length) throw new Error('No build outputs');
  return sorted(result);
}

// Vite invokes these hooks around the actual build. A receipt created by a
// separate post-hoc script could accidentally bless stale renderer output.
function createBuildProvenancePlugin({ root, kind }) {
  if (!['web', 'review'].includes(kind)) throw new Error('Unknown build kind');
  root = path.resolve(root);
  const directory = path.join(root, kind === 'web' ? 'dist' : 'dist/review');
  const receiptPath = path.join(directory, RECEIPT);
  let inputs, failed = false;
  return {
    name: `radar-build-provenance-${kind}`,
    apply: 'build',
    enforce: 'post',
    buildStart() {
      failed = false;
      assertManagedPath(root, receiptPath);
      inputs = snapshotBuildInputs(root);
      fs.rmSync(receiptPath, { force: true });
    },
    buildEnd(error) { if (error) failed = true; },
    renderError() { failed = true; },
    closeBundle() {
      assertManagedPath(root, receiptPath);
      if (failed) { fs.rmSync(receiptPath, { force: true }); return; }
      if (!inputs || JSON.stringify(inputs) !== JSON.stringify(snapshotBuildInputs(root))) {
        fs.rmSync(receiptPath, { force: true });
        throw new Error('Build inputs changed during compilation; rebuild from a stable snapshot');
      }
      const receipt = {
        schemaVersion: 1, kind, status: 'passed',
        version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
        sourceHashes: inputs,
        outputHashes: snapshotOutputs(directory, kind)
      };
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    }
  };
}

module.exports = { createBuildProvenancePlugin, snapshotBuildInputs, snapshotOutputs };
