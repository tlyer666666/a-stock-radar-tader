'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyReviewBuild } = require('./verify-review-build.cjs');
const { launchPackaged, appExecutable } = require('./packaged-session.cjs');
async function run() {
  const appPath = path.resolve(process.argv[2] || 'release-builder/mac-arm64/A股雷达趋势版.app');
  const output = path.resolve('artifacts/ui-remediation-20261019/native'); fs.mkdirSync(output, { recursive: true });
  const integrity = verifyReviewBuild(appPath);
  let session;
  try {
    session = await launchPackaged(appExecutable(appPath));
    const { context, page: main } = session;
    const errors = []; main.on('pageerror', error => errors.push(error.message));
    await main.locator('[data-professional-review-nav]').waitFor({ timeout: 20000 });
    const version = await main.evaluate(() => window.stockApi.getVersion());
    assert.equal(version, require('../package.json').version);
    const expectedElectron = require('../package.json').devDependencies.electron;
    const runtime = await main.evaluate(() => window.stockApi.getRuntimeInfo());
    assert.equal(runtime.versions.electron, expectedElectron);
    assert.equal(runtime.versions.undici, '7.29.1');
    const next = context.waitForEvent('page', { timeout: 20000 }); await main.evaluate(() => window.stockApi.openProfessionalReviewWindow());
    const review = await next; review.on('pageerror', error => errors.push(error.message));
    await review.locator('.professional-review').waitFor({ timeout: 20000 });
    const capabilities = await review.evaluate(() => Object.keys(window.stockApi).sort());
    assert.deepEqual(capabilities, ['analyze', 'getProfessionalReview', 'getReviewTheme', 'search']);
    const theme = await review.evaluate(() => window.stockApi.getReviewTheme()); assert.ok(['system', 'light', 'dark'].includes(theme.theme));
    await main.evaluate(() => window.stockApi.openProfessionalReviewWindow());
    assert.equal(context.pages().length, 2);
    await review.locator('.review-loading').waitFor({ state: 'hidden', timeout: 60000 });
    const reviewState = await review.locator('.review-dimension').count() ? 'market-data-rendered' : await review.locator('.review-error').count() ? 'source-error-displayed' : 'unrecognized';
    assert.notEqual(reviewState, 'unrecognized');
    await review.screenshot({ path: path.join(output, 'independent-review.png'), animations: 'disabled' });
    await main.screenshot({ path: path.join(output, 'main.png'), animations: 'disabled' });
    assert.deepEqual(errors, []);
    const report = { version, runtime, integrity, independentReview: true, reviewState, readOnlyCapabilities: capabilities, duplicateWindows: false, rendererErrors: errors };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally {
    await session?.close();
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
