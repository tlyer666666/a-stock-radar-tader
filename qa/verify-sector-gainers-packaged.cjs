'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launchPackaged, appExecutable } = require('./packaged-session.cjs');

async function verify(appPath) {
  const executable = appExecutable(path.resolve(appPath));
  const session = await launchPackaged(executable);
  const page = session.page;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const output = path.resolve(__dirname, '../artifacts/sector-gainers');
  await fs.mkdir(output, { recursive: true });
  try {
    await page.setViewportSize({ width: 1480, height: 960 });
    await page.locator('.workspace-navigation').waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '板块强度', exact: true }).first().click();
    const rows = page.locator('.sector-gainers-row[aria-expanded]');
    await rows.first().waitFor({ timeout: 120000 });
    assert.equal(await page.getByText('板块涨幅排行', { exact: true }).count(), 1);
    const rowCount = await rows.count();
    const requestedName = process.env.VERIFY_SECTOR_NAME || '';
    const selectedRow = requestedName ? page.getByRole('button', { name: `${requestedName}，展开个股`, exact: true }) : rows.first();
    const code = await selectedRow.locator('small').innerText();
    if (requestedName === '北交所') assert.match(code, /京证A股/);
    else assert.match(code, /^\d{6}$/);
    const label = await selectedRow.getAttribute('aria-label');
    const name = label.split('，')[0];
    await selectedRow.click();
    const region = page.getByRole('region', { name: `${name} 成分股`, exact: true });
    const stock = region.locator('.member-row:not(.member-head)').first();
    await stock.waitFor({ timeout: 120000 });
    const stockText = await stock.innerText();
    assert.match(stockText, /\d{6}/);
    const fundSource = await region.locator('.sector-fund-flow-source').innerText();
    assert.match(fundSource, /主力净流入：东方财富/);
    const stockFundRows = await region.locator('.member-row:not(.member-head)').evaluateAll(rows => rows.map(row => {
      const cells = row.querySelectorAll(':scope > span');
      return { stock: cells[0]?.textContent || '', amount: cells[5]?.textContent || '', provenance: cells[5]?.getAttribute('title') || '' };
    }));
    const fundedRows = stockFundRows.filter(row => /\d/.test(row.amount) && row.provenance.includes('东方财富'));
    assert.ok(fundedRows.length > 0, `No real member funds rendered: ${JSON.stringify({ fundSource, stockFundRows })}`);
    assert.ok(await region.getByRole('button', { name: '刷新个股数据', exact: true }).isVisible());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await stock.boundingBox();
    const viewport = await page.locator('.sector-gainers-panel .sector-comparison-table').boundingBox();
    assert.ok(bounds.y >= Math.max(0, viewport.y) && bounds.y + bounds.height <= Math.min(960, viewport.y + viewport.height), `stock clipped by board table: ${JSON.stringify({ bounds, viewport })}`);
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height < 960, `stock should be visible: ${JSON.stringify(bounds)}`);
    assert.equal(await region.evaluate(el => el.previousElementSibling.getAttribute('aria-expanded')), 'true');
    const loadedLabel = await region.locator('.panel-title').innerText();
    const prefix = requestedName === '北交所' ? 'beijing-' : '';
    await page.screenshot({ path: path.join(output, `${prefix}packaged-expanded.png`) });
    await page.getByRole('button', { name: `${name}，收起个股`, exact: true }).click();
    assert.equal(await page.locator('.sector-inline-detail').count(), 0);
    assert.deepEqual(errors, []);
    const result = { observedAt: new Date().toISOString(), executable, rowCount, selected: { name, code }, loadedLabel, firstStock: stockText,
      fundSource, fundedVisibleRows: fundedRows.length, stockFundRows, stockVisible: true, collapsed: true, pageErrors: errors };
    await fs.writeFile(path.join(output, `${prefix}packaged-verification.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await session.close(); }
}
if (require.main === module) verify(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
