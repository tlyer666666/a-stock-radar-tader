"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { buildStrategySignalReport } = require("../electron/strategy-signal-engine.cjs");
const { enrichStrategySignalReport } = require("../electron/services.cjs");
const catalog = require("../config/strategy-signal-combinations.json");

async function main() {
  const output = path.resolve("artifacts/signal-combinations-v13-qa");
  fs.mkdirSync(output, { recursive: true });
  const report = enrichStrategySignalReport(buildStrategySignalReport(), [], {});
  report.mode = "合成界面验收：无收益样本，未发布";
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1050 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(process.env.QA_BASE_URL || "http://127.0.0.1:5175", { waitUntil: "networkidle" });
    await page.evaluate(input => {
      window.stockApi.scanStrategySignals = async () => input;
      window.stockApi.openExternal = async url => { window.__externalUrl = url; };
    }, report);
    await page.getByRole("button", { name: "策略信号", exact: true }).click();
    const tabs = page.locator(".strategy-signal-tab-list button");
    await tabs.filter({ hasText: catalog[0].name }).waitFor();
    assert.equal(await tabs.count(), 24);
    const seen = [];
    for (const item of catalog) {
      await tabs.filter({ hasText: item.name }).click();
      await page.getByText(/^公式来源与适配/).waitFor();
      assert.match(await page.locator(".strategy-rule-panel").innerText(), /固定参数/);
      assert.match(await page.locator(".strategy-rule-panel").innerText(), /未经收益优越性验证/);
      const source = item.sources[1];
      await page.getByRole("button", { name: source.title, exact: true }).click();
      assert.equal(await page.evaluate(() => window.__externalUrl), source.url);
      seen.push(item.id);
    }
    await tabs.filter({ hasText: catalog[0].name }).click();
    for (const [width, theme] of [[1480, "dark"], [760, "dark"], [1480, "light"]]) {
      await page.setViewportSize({ width, height: 1050 });
      await page.getByRole("button", { name: theme === "light" ? /^(白天|白昼)$/ : /^(黑夜|暮夜)$/ }).click();
      await page.waitForTimeout(200);
      await page.locator(".main > .page").evaluate(element => element.scrollTo(0, 0));
      assert.equal(await page.locator(".main > .page").evaluate(element => element.scrollWidth > element.clientWidth + 2), false, `${width} ${theme} overflow`);
      await page.screenshot({ path: path.join(output, `signals-${width}-${theme}.png`), fullPage: true });
      await page.getByText(/^公式来源与适配/).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `sources-${width}-${theme}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, "smoke.json"), JSON.stringify({ passed: true, syntheticUiOnly: true, strategies: 24, composites: 10, newIds: seen, checks: ["24 visible rules", "6 official-source panels", "source buttons", "fixed parameters", "unverified adaptation wording", "insufficient evidence retained", "dark/light responsive no overflow"], pageErrors: errors }, null, 2));
    console.log("Signal combinations UI smoke passed (synthetic interface data, no return claim).");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
