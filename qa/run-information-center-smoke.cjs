"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1050 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const output = path.resolve("artifacts/information-center-qa");
  fs.mkdirSync(output, { recursive: true });
  try {
    await page.goto(process.env.QA_BASE_URL || "http://127.0.0.1:5174", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      const stock = { code: "600519", name: "贵州茅台", secid: "1.600519", assetType: "stock" };
      const now = new Date().toISOString();
      const base = { summary: "合成UI验收内容", publishedAt: now, firstSeenAt: now, sourceLevel: "A", source: "合成官方披露源", sourceUrl: "https://example.invalid/disclosure", relatedStocks: [stock], relatedSectors: [], credibilityScore: 90, importanceScore: 85, freshnessScore: 100, ageMinutes: 0, riskSeverity: 0, direction: "positive", marketConfirmation: "待行情确认", impactHorizon: "短期", eventType: "业绩", status: "active", reasons: ["仅验证交互"], duplicateCount: 1 };
      window.__newsItems = [
        { ...base, id: "qa-flash", type: "flash", title: "合成市场快讯", source: "合成快讯源" },
        { ...base, id: "qa-announcement", type: "announcement", title: "合成公司业绩公告" },
        { ...base, id: "qa-corrected", type: "announcement", title: "合成公司监管更正公告", eventType: "监管风险", status: "corrected", direction: "negative", riskSeverity: 2 }
      ];
      window.__newsRequests = [];
      window.__makeNewsFeed = input => ({ items: window.__newsItems.filter(item => !input.contentType || input.contentType === "all" || item.type === input.contentType), sourceStatus: [{ id: "announcement", name: "合成官方披露源", level: "A", ok: true, message: "3条测试内容", pollSeconds: 15 }, { id: "fast", name: "合成快讯源", level: "B", ok: true, message: "1条测试内容" }], updatedAt: now, refreshAfterSeconds: 30, total: 3, mode: "合成UI验收" });
      window.stockApi.getNewsFeed = async input => { window.__newsRequests.push(input); return window.__makeNewsFeed(input); };
      window.stockApi.refreshNewsFeed = async input => { window.__forcedNewsInput = input; return window.__makeNewsFeed(input); };
      window.stockApi.openExternal = async url => { window.__externalUrl = url; };
    });
    assert.equal(await page.locator('[data-information-center-nav="true"]').count(), 1);
    assert.equal(await page.getByRole("button", { name: "A股公告", exact: true }).count(), 0);
    await page.getByRole("button", { name: "资讯中心", exact: true }).click();
    const tab = name => page.getByRole("tab", { name, exact: true });
    const cards = page.locator(".realtime-news-card");
    await cards.filter({ hasText: "合成市场快讯" }).waitFor();
    assert.equal(await tab("全部").getAttribute("aria-selected"), "true");
    assert.equal(await cards.count(), 3);
    await page.getByRole("button", { name: "自动刷新中", exact: true }).click();
    await tab("市场资讯").click();
    await cards.filter({ hasText: "合成市场快讯" }).waitFor();
    assert.equal(await cards.count(), 1);
    assert.equal((await page.evaluate(() => window.__newsRequests.at(-1))).contentType, "flash");
    assert.doesNotMatch(await page.locator(".news-source-strip").innerText(), /合成官方披露源/);
    await tab("公司公告").click();
    await cards.filter({ hasText: "合成公司业绩公告" }).waitFor();
    assert.equal(await cards.count(), 2);
    assert.match(await page.locator(".news-source-strip").innerText(), /合成官方披露源/);
    assert.doesNotMatch(await page.locator(".news-source-strip").innerText(), /合成快讯源/);
    await page.getByRole("button", { name: "更正/修订", exact: true }).click();
    assert.equal(await cards.count(), 1);
    await page.getByRole("button", { name: "监管风险", exact: true }).click();
    assert.equal(await cards.count(), 1);
    await cards.getByRole("button", { name: "查看原文" }).click();
    assert.equal(await page.evaluate(() => window.__externalUrl), "https://example.invalid/disclosure");
    await page.getByRole("button", { name: "立即刷新", exact: true }).click();
    assert.equal((await page.evaluate(() => window.__forcedNewsInput)).contentType, "announcement");
    // Hidden announcement-only filters must never filter the other two tabs.
    await tab("市场资讯").click();
    await cards.filter({ hasText: "合成市场快讯" }).waitFor();
    assert.equal(await cards.count(), 1);
    await tab("全部").click();
    await cards.filter({ hasText: "合成市场快讯" }).waitFor();
    assert.equal(await cards.count(), 3);
    await tab("公司公告").click();
    await cards.filter({ hasText: "合成公司监管更正公告" }).waitFor();
    await cards.getByRole("button", { name: /贵州茅台/ }).click();
    await page.getByRole("button", { name: "返回资讯中心 · 公司公告", exact: true }).first().click();
    assert.equal(await tab("公司公告").getAttribute("aria-selected"), "true");
    await cards.filter({ hasText: "合成公司业绩公告" }).waitFor();
    // Resolve a stale request only after the next tab has committed its response.
    await page.evaluate(() => {
      window.stockApi.getNewsFeed = input => {
        window.__newsRequests.push(input);
        if (input.contentType === "flash") return new Promise(resolve => { window.__resolveOldFeed = () => resolve({ ...window.__makeNewsFeed({ contentType: "all" }), items: [{ ...window.__newsItems[0], title: "不应显示的陈旧响应" }] }); });
        return Promise.resolve(window.__makeNewsFeed(input));
      };
    });
    await tab("市场资讯").click();
    await page.waitForFunction(() => typeof window.__resolveOldFeed === "function");
    await tab("公司公告").click();
    await cards.filter({ hasText: "合成公司业绩公告" }).waitFor();
    await page.evaluate(() => window.__resolveOldFeed());
    await page.waitForTimeout(80);
    assert.equal(await cards.count(), 2);
    assert.equal(await page.getByText("不应显示的陈旧响应").count(), 0);
    for (const [width, theme] of [[1480, "dark"], [760, "dark"], [1480, "light"]]) {
      await page.setViewportSize({ width, height: 1050 });
      await page.getByRole("button", { name: theme === "light" ? /^(白天|白昼)$/ : /^(黑夜|暮夜)$/ }).click();
      await page.waitForTimeout(250);
      await page.locator(".main > .page").evaluate(element => element.scrollTo(0, 0));
      assert.equal(await page.locator(".main > .page").evaluate(element => element.scrollWidth > element.clientWidth + 2), false, `${width} ${theme} overflow`);
      await page.screenshot({ path: path.join(output, `information-${width}-${theme}.png`), fullPage: true });
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, "smoke.json"), JSON.stringify({ passed: true, syntheticUiOnly: true, checks: ["single navigation", "default all", "three server-side content types", "disclosure filters", "source/time/original link", "manual refresh", "hidden-filter isolation", "analysis return tab", "stale request isolation", "responsive dark/light"] }, null, 2));
    console.log("Information center smoke passed (synthetic UI fixtures only).");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
