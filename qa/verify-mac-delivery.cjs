'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { verifyAppBundleIntegrity, readPackagedPackageJson } = require('./delivery-verification.cjs');
const { verifyBuildArtifact } = require('./build-artifact-verification.cjs');

function verifyMacMetadata({ manifestVersion, packagedVersion, info, headerString }) {
  const versions = [manifestVersion, packagedVersion, info.CFBundleShortVersionString, info.CFBundleVersion];
  if (versions.some(value => value !== manifestVersion)) throw new Error('Source, asar and Info.plist versions differ');
  const integrity = info.ElectronAsarIntegrity?.['Resources/app.asar'];
  const headerHash = createHash('sha256').update(headerString).digest('hex');
  if (integrity?.algorithm !== 'SHA256' || integrity.hash !== headerHash) throw new Error('Electron asar header integrity mismatch');
  return { version: manifestVersion, headerHash };
}

/** allowSourceDrift: only the deploy override (--allow-receipt-mismatch) may tolerate
 * source-tree drift; the packaged outputs must still match the receipt exactly. */
function verifyMacDelivery(appPath, repoRoot, { allowSourceDrift = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS delivery verification requires macOS');
  const result = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(appPath, 'Contents/Info.plist')], { encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Unable to read application Info.plist');
  const archive = path.join(appPath, 'Contents/Resources/app.asar');
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar');
  asar.uncache(archive);
  const metadata = verifyMacMetadata({
    manifestVersion: JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version,
    packagedVersion: readPackagedPackageJson(appPath).version,
    info: JSON.parse(result.stdout), headerString: asar.getRawHeader(archive).headerString
  });
  const artifact = verifyBuildArtifact(appPath, repoRoot);
  if ((!artifact.consistent && !allowSourceDrift) || !artifact.artifactConsistent) throw new Error('Application differs from current source or build receipt');
  const bundle = verifyAppBundleIntegrity(appPath);
  return { ...metadata, artifact, bundle, asarSha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex') };
}

if (require.main === module) {
  try { console.log(JSON.stringify(verifyMacDelivery(path.resolve(process.argv[2]), path.resolve(process.argv[3] || process.cwd())), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { verifyMacMetadata, verifyMacDelivery };
