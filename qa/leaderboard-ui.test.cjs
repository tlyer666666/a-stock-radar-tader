"use strict";
// 策略实测榜界面：回测中心入口、排行展开与口径文字（2026-11-21）。
// 使用 Vite 编程式随机端口（port: 0）替代 spawn("npx") 与写死 5173，兼容 Windows CI 且不与 pnpm dev 冲突。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPreview } = require("./frontend-v150.cjs");

test("leaderboard view opens from backtest center, shows the report and expands a strategy row", async (t) => {
  const preview = await createPreview();
  t.after(() => preview.close());
  const page = await preview.browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(preview.url, { waitUntil: "networkidle" });
    // 侧栏默认只显示核心模块：先切回全部再进回测中心。
    const focusToggle = page.locator(".sidebar-focus-toggle.active");
    if (await focusToggle.count()) await focusToggle.first().click();
    const backtestBtn = page.locator("aside button").filter({ hasText: /^回测中心$/ });
    await backtestBtn.first().waitFor();
    await backtestBtn.first().click();
    await page.locator("[data-backtest-leaderboard-entry]").click();
    const row = page.locator(".lb-table tbody tr").filter({ hasText: "深跌底部首板" });
    await row.first().waitFor();
    assert.match(await page.locator(".lb-verdict b").innerText(), /最稳的是「/);
    const first = page.locator(".lb-table tbody tr").first();
    await first.click();
    await page.locator(".lb-detail").waitFor();
    assert.match(await page.locator(".lb-detail").innerText(), /持有期|优势/);
    await page.locator(".lb-method summary").click();
    assert.match(await page.locator(".lb-method").innerText(), /次日开盘买入/);
    // 展开后再次点击同一行应收起。
    await first.click();
    assert.equal(await page.locator(".lb-detail").count(), 0);
  } finally {
    await page.close().catch(() => {});
  }
});
