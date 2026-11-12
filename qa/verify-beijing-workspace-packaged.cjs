'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchPackaged, appExecutable } = require('./packaged-session.cjs');

async function verify(appPath) {
  const session = await launchPackaged(appExecutable(path.resolve(appPath)));
  const page = session.page;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(60000);
  const output = path.resolve(__dirname, '../artifacts/beijing-workspace');
  await fs.mkdir(output, { recursive: true });
  try {
    await page.setViewportSize({ width: 1480, height: 960 });
    const nav = page.locator('.workspace-navigation').getByRole('button', { name: '北交所', exact: true });
    await nav.waitFor();
    await nav.click();
    await page.locator('.app-shell[data-workspace="beijing"]').waitFor();
    const region = page.getByRole('region', { name: '北交所 成分股', exact: true });
    const stocks = region.locator('.member-row:not(.member-head)');
    await stocks.first().waitFor();
    await page.waitForFunction(() => !document.querySelector(".sector-members-panel .panel-title")?.textContent?.includes("读取中"), null, { timeout: 120000 });
    // B-09 / B-10（1.6.0 起）：北交所成分股不再一次渲染全量，改成首屏 50 行 +
    // 「加载更多」每次追加 50 行。覆盖范围不变，因此这里按新契约走一遍分页，
    // 再断言「全部名单都能到达」。1.5.x 的打包产物没有 .member-load-more，本脚本不适用于它。
    const firstPage = await stocks.count();
    assert.ok(firstPage > 0 && firstPage <= 50, `member table must page in 50-row chunks, got ${firstPage}`);
    const loadMore = region.locator('.member-load-more');
    let pagesLoaded = 1;
    while (await loadMore.count()) {
      const before = await stocks.count();
      await loadMore.click();
      pagesLoaded += 1;
      await page.waitForFunction(visible => document.querySelectorAll('.sector-members-panel .member-row:not(.member-head)').length > visible, before);
      assert.ok(pagesLoaded <= 40, '加载更多 must converge');
    }
    assert.ok(await stocks.count() >= 300, "complete Beijing roster must be reachable through 加载更多");
    assert.equal(await nav.getAttribute('aria-current'), 'page');
    assert.equal(await page.getByRole('heading', { name: '北交所', exact: true }).count(), 1);
    assert.equal(await page.locator('.sector-gainers-panel,.sector-search-panel').count(), 0);
    const stockTexts = await stocks.allInnerTexts();
    for (const text of stockTexts) assert.match(text, /\b(?:(?:43|83|87|88)\d{4}|920\d{3})\b/);
    const bounds = await stocks.first().boundingBox();
    assert.ok(bounds.y > 0 && bounds.y + bounds.height <= 960);
    const snapshot = await page.evaluate(() => window.stockApi.analyzeSector({ name: '北交所', code: 'THS:BJ', waitForQuotes: false }));
    assert.equal(snapshot.memberCoverage.complete, true);
    assert.equal(snapshot.memberCoverage.total, stockTexts.length);
    const filter = page.getByRole('textbox', { name: '筛选当前板块个股' });
    await filter.fill('920992');
    assert.equal(await stocks.count(), 1);
    assert.match(await stocks.first().innerText(), /中科美菱/);
    await filter.fill('');
    // 清空筛选会把分页重置回首屏（memberQuery 变化 → memberLimit 回落 50），
    // 因此这里断言「回到第一页 + 加载更多重新出现」，而不是旧的「恢复全量行」。
    await stocks.first().waitFor();
    assert.equal(await stocks.count(), firstPage, 'clearing the filter resets the member table to the first page');
    await region.locator('.member-load-more').waitFor();
    const coverageText = await region.locator('.panel-title').innerText();
    const warning = await region.locator('.beijing-coverage-note').innerText();
    await page.screenshot({ path: path.join(output, 'packaged-sidebar-light.png') });
    await page.getByRole('button', { name: '黑夜', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.screenshot({ path: path.join(output, 'packaged-sidebar-dark.png') });
    await stocks.first().click();
    await page.locator('.app-shell[data-workspace="dashboard"]').waitFor();
    await page.getByRole('button', { name: '返回北交所', exact: true }).click();
    await page.locator('.app-shell[data-workspace="beijing"]').waitFor();
    await stocks.first().waitFor();
    assert.equal(await nav.getAttribute('aria-current'), 'page');
    assert.deepEqual(errors, []);
    const result = { observedAt: new Date().toISOString(), executable: session.executable || appExecutable(path.resolve(appPath)),
      workspace: 'beijing', sidebarLabel: '北交所', independentPage: true, loadedCount: stockTexts.length,
      stockTexts, memberCoverage: snapshot.memberCoverage, quoteCoverage: snapshot.quoteCoverage, coverageText, warning, lastStockSearchVerified: true, stockVisible: true, analysisReturnVerified: true, themes: ['light', 'dark'], pageErrors: errors };
    await fs.writeFile(path.join(output, 'packaged-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, stockTexts: [stockTexts[0], stockTexts.at(-1)] }, null, 2));
  } finally { await session.close(); }
}
if (require.main === module) verify(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
