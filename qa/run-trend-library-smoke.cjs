"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const catalog = require("../config/trend-strategy-library.json");

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1050 }, acceptDownloads: true });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const output = path.resolve("artifacts/strategy-library-qa"); fs.mkdirSync(output, { recursive: true });
  const macd = catalog.find(item => item.id === "macd-zero-cross-v1");
  const card = (id, code = "DEMO-A01") => page.locator(`.trend-candidate[data-strategy-id="${id}"][data-code="${code}"]`);
  const scan = () => page.getByRole("button", { name: "扫描全 A 股", exact: true }).first().click();
  const selectResult = id => page.getByLabel("结果策略", { exact: true }).selectOption(id);
  const plans = () => page.getByRole("button", { name: /^我的计划/ }).click();
  const candidates = () => page.getByRole("button", { name: /^研究候选/ }).click();
  try {
    await page.goto(process.env.QA_BASE_URL || "http://127.0.0.1:5174", { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "趋势筛选", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "多策略联合扫描", exact: true }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".trend-library-choice input:checked").count(), 7);
    assert.equal(await page.locator(".trend-library-choice input").count(), 8);
    await scan();
    await page.waitForFunction(() => document.querySelectorAll(".trend-candidate").length === 21);
    assert.match(await page.locator(".trend-results-context").innerText(), /21 条结果 \/ 3 只股票/);
    assert.equal(await page.locator(".trend-strategy-coverage > div").count(), 7);
    const combined = await page.evaluate(() => window.stockApi.getTrendScan());
    assert.equal(combined.strategy, undefined); assert.equal(combined.strategies.length, 7);
    assert.equal(combined.processed, 8); assert.equal(combined.isPreview, true);
    assert.equal(combined.candidates.length, 21);
    await selectResult(macd.id);
    assert.equal(await page.locator(".trend-candidate").count(), 3);
    assert.equal(await page.getByRole("button", { name: /^全部候选\s*3$/ }).count(), 1);
    assert.equal(await page.getByRole("button", { name: /^A 回踩转强\s*0$/ }).count(), 1);
    assert.equal(await page.getByRole("button", { name: /^有效信号\s*2$/ }).count(), 1);
    await card(macd.id).getByRole("button", { name: "加入我的计划", exact: true }).click();
    assert.doesNotMatch(await card(macd.id).locator(".trend-shape-tags").innerText(), /A 回踩转强|B 平台突破/);
    await selectResult("quality-v2");
    await card("quality-v2").getByRole("button", { name: "加入我的计划", exact: true }).click();
    await selectResult("all"); await plans();
    assert.equal(await page.locator(".trend-candidate").count(), 2);
    const frozen = await page.evaluate(() => JSON.parse(localStorage.getItem("a-stock-radar:trend-plans:v1")));
    assert.equal(new Set(frozen.plans.map(plan => plan.id)).size, 2);
    assert.ok(frozen.plans.every(plan => plan.isPreview && plan.candidate.plan.minEntry === 12.3));
    await page.getByRole("button", { name: "单策略扫描", exact: true }).click();
    await page.getByLabel("扫描策略", { exact: true }).selectOption(macd.id);
    await scan();
    await page.locator(".trend-strategy-current").getByText(new RegExp(`1 个策略 · ${macd.name}`)).waitFor();
    assert.doesNotMatch(await card(macd.id).locator(".trend-snapshot-notice").innerText(), /本次未验证/);
    assert.match(await card("quality-v2").locator(".trend-snapshot-notice").innerText(), /本次未验证/);
    assert.match(await card(macd.id).locator(".trend-reference-plan").innerText(), /11.42/);
    // A later partial scan cannot establish absence; matching complete coverage can.
    await page.evaluate(() => {
      window.__originalTrendStatus = window.stockApi.getTrendScan;
      window.__completeLibraryCoverage = false;
      window.stockApi.getTrendScan = async () => {
        const state = await window.__originalTrendStatus();
        state.asOf = "2026-09-30"; state.candidates = [];
        state.coverageComplete = true;
        state.strategyStats.forEach(stat => { stat.coverageComplete = window.__completeLibraryCoverage; });
        return state;
      };
    });
    await page.getByRole("button", { name: "刷新扫描状态", exact: true }).click();
    await card(macd.id).getByText(/本次未验证/).waitFor();
    assert.doesNotMatch(await card(macd.id).innerText(), /最新扫描中未找到/);
    await page.evaluate(() => { window.__completeLibraryCoverage = true; });
    await page.getByRole("button", { name: "刷新扫描状态", exact: true }).click();
    await card(macd.id).getByText(/最新扫描中未找到该股/).waitFor();
    assert.match(await card("quality-v2").innerText(), /本次未验证/);
    assert.match(await card(macd.id).locator(".trend-reference-plan").innerText(), /11.42/);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出计划 CSV", exact: true }).click();
    const csv = fs.readFileSync(await (await downloadPromise).path(), "utf8");
    for (const token of [macd.id, "quality-v2", "DEMO", "参数快照", "独立信号", "最低参考入场", "12.3"]) assert.ok(csv.includes(token), token);
    await page.reload({ waitUntil: "networkidle" }); await plans();
    assert.equal(await page.locator(".trend-candidate").count(), 2);
    for (const row of await page.locator(".trend-candidate").all()) assert.match(await row.innerText(), /11.42/);
    await candidates(); await scan();
    await page.waitForFunction(() => document.querySelectorAll(".trend-candidate").length === 21);
    assert.equal(await card(macd.id).getByRole("button", { name: "已保存快照", exact: true }).count(), 1);
    const beforeEmpty = (await page.evaluate(() => window.stockApi.getTrendScan())).strategySetHash;
    while (await page.locator(".trend-library-choice input:checked").count()) await page.locator(".trend-library-choice input:checked").first().uncheck();
    await scan();
    await page.getByRole("alert").filter({ hasText: "请至少选择一个扫描策略" }).waitFor();
    assert.equal((await page.evaluate(() => window.stockApi.getTrendScan())).strategySetHash, beforeEmpty);
    for (const choice of await page.locator(".trend-library-choice").all()) if (!(await choice.innerText()).includes("原版趋势 v1")) await choice.getByRole("checkbox").check();
    await scan();
    assert.equal(await page.locator(".trend-candidate").count(), 21);
    await page.locator(".trend-library-reference > summary").click();
    for (const definition of catalog) {
      const article = page.locator(".trend-library-reference article").filter({ hasText: definition.name });
      assert.equal(await article.count(), 1); assert.ok(await article.locator("a").count() >= 1);
      assert.match(await article.innerText(), /[a-zA-Z]+=\d/);
    }
    await page.locator(".trend-library-reference > summary").click();
    for (const [width, theme] of [[1480, "dark"], [1024, "dark"], [760, "dark"], [1480, "light"]]) {
      await page.setViewportSize({ width, height: 1050 });
      await page.getByRole("button", { name: theme === "light" ? /^(白天|白昼)$/ : /^(黑夜|暮夜)$/ }).click();
      await page.waitForTimeout(250); // Let the existing theme color transition settle before capturing.
      await page.locator(".main > .page").evaluate(element => element.scrollTo(0, 0));
      assert.equal(await page.locator(".trend-screener").evaluate(element => element.scrollWidth > element.clientWidth + 2), false, `${width} ${theme} overflow`);
      await page.screenshot({ path: path.join(output, `library-${width}-${theme}.png`), fullPage: true });
    }
    await selectResult(macd.id); await card(macd.id).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, "library-saved-card.png"), fullPage: true });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, "smoke.json"), JSON.stringify({ passed: true, syntheticUiOnly: true, checks: ["default seven strategies", "21 results / 3 securities", "strategy-scoped counts", "single/multi identity", "independent labels", "frozen saved prices", "cross-strategy isolation", "per-strategy partial absence", "CSV metadata", "reload", "empty selection rejected", "official source links", "1480/1024/760 dark and light"] }, null, 2));
    console.log("Trend library smoke passed (synthetic UI fixtures only).");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
