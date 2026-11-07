'use strict';
// electron-builder `afterPack` hook: harden the packaged runtime with Electron fuses.
//
// Only capability-removal fuses are flipped. The two tamper-resistance fuses that need
// supporting build artefacts (`OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation`)
// are deliberately left at their defaults: the app depends on `app.asar.unpacked` for its
// worker entry points, and asar integrity validation needs matching metadata in the bundle.
// Both would have to be enabled only alongside a signed build that can actually be
// launched and smoke-tested.
const path = require('node:path');
const fs = require('node:fs');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

function electronBinaryPath(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const productName = packager.appInfo.productFilename;
  if (electronPlatformName === 'darwin') {
    return path.join(appOutDir, `${productName}.app`, 'Contents', 'MacOS', productName);
  }
  if (electronPlatformName === 'win32') return path.join(appOutDir, `${productName}.exe`);
  return path.join(appOutDir, packager.executableName || productName.toLowerCase());
}

function completeMacRuntimeResources(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const resources = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  // hardenRuntime also invokes this hook for fuse-only verification fixtures.
  if (!fs.existsSync(resources)) return;
  const configured = context.packager.config?.electronDist;
  if (configured !== undefined && typeof configured !== 'string') throw new Error('electronDist must name the verified local runtime directory');
  const runtime = configured
    ? path.resolve(context.packager.projectDir || process.cwd(), configured)
    : path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
  const vendorResources = path.join(runtime, 'Electron.app', 'Contents', 'Resources');
  const locales = fs.readdirSync(vendorResources, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.endsWith('.lproj'));
  if (!locales.length) throw new Error('Verified Electron distribution has no locale directories');
  // electron-builder omits empty top-level locale folders when copying a local
  // distribution. Preserve the vendor folders without modifying framework bytes.
  for (const entry of locales) fs.cpSync(path.join(vendorResources, entry.name), path.join(resources, entry.name), { recursive: true });
  fs.copyFileSync(path.join(runtime, 'LICENSE'), path.join(resources, 'LICENSE.electron.txt'));
  fs.copyFileSync(path.join(runtime, 'LICENSES.chromium.html'), path.join(resources, 'LICENSES.chromium.html'));
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
}

module.exports = async function afterPack(context) {
  completeMacRuntimeResources(context);
  const binary = electronBinaryPath(context);
  const { electronPlatformName } = context;
  await flipFuses(binary, {
    version: FuseVersion.V1,
    // The packaged app never needs to behave as plain Node, expose an inspector, or read
    // NODE_OPTIONS; each of those is a documented escalation path if left enabled.
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    resetAdHocDarwinSignature: electronPlatformName === 'darwin'
  });
  console.log(`  • electron fuses applied  binary=${binary}`);
};
