'use strict';
const path = require('node:path');
const { getCurrentFuseWire, FuseV1Options, FuseState } = require('@electron/fuses');

async function verifyRuntimeFuses(binary) {
  const wire = await getCurrentFuseWire(binary);
  for (const option of ['RunAsNode', 'EnableNodeCliInspectArguments', 'EnableNodeOptionsEnvironmentVariable']) {
    if (wire[FuseV1Options[option]] !== FuseState.DISABLE) throw Error(`Production fuse remains enabled: ${option}`);
  }
  return { passed: true, disabled: 3 };
}
async function hardenRuntime(binary, platform = process.platform) {
  const productFilename = path.basename(binary, platform === 'win32' ? '.exe' : '');
  await require('./after-pack-fuses.cjs')({ appOutDir: path.dirname(binary), electronPlatformName: platform,
    packager: { appInfo: { productFilename } } });
  return verifyRuntimeFuses(binary);
}
if (require.main === module) {
  const [, , binary, platform] = process.argv;
  (platform === '--verify' ? verifyRuntimeFuses(binary) : hardenRuntime(binary, platform))
    .then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { hardenRuntime, verifyRuntimeFuses };
