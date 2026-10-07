"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const output = path.resolve("artifacts/terminal-ui-qa");
const url = process.env.UI_QA_URL || "http://127.0.0.1:5173";
async function run() {
  const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 768 } });
  const errors = [], captures = [], analysisChecks = [];
  page.on("pageerror", error => errors.push(error.message));
  async function settle() {
    await page.locator(".toast").waitFor({ state: "hidden", timeout: 5000 });
    await page.evaluate(() => {
      document.querySelector(".sidebar")?.scrollTo(0, 0);
      return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
  }
  async function capture(name) {
    await settle();
    const file = path.join(output, name + ".png");
    await page.screenshot({ path: file, animations: "disabled" });
    captures.push(file);
  }
  async function analysisGeometry(label) {
    const result = await page.evaluate(() => {
      const geometry = selector => {
        const element = document.querySelector(selector), r = element.getBoundingClientRect();
        return { selector, top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
      };
      const root = document.querySelector(".main > .page");
      const quote = geometry(".terminal-analysis-layout .hero-grid");
      const chart = geometry(".terminal-analysis-layout > .content-grid:not(.lower)");
      const signal = geometry(".terminal-analysis-layout > .signal-grid");
      return { quote, chart, signal, hasWarning: Boolean(document.querySelector(".terminal-analysis-layout > .warning-banner")),
        ordered: quote.bottom <= chart.top + 1 && chart.bottom <= signal.top + 1,
        pageClientWidth: root.clientWidth, pageScrollWidth: root.scrollWidth,
        documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
    });
    assert.ok(result.ordered, `${label}: quote → chart → signal`);
    assert.ok(result.pageScrollWidth <= result.pageClientWidth + 2, `${label}: page overflow`);
    assert.ok(result.documentWidth <= result.viewportWidth + 2, `${label}: body overflow`);
    analysisChecks.push({ label, ...result, passed: true });
  }
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "趋势筛选", exact: true }).waitFor();
    await page.getByRole("button", { name: "黑夜", exact: true }).click();
    await capture("dark-trend-screener-1440x768");
    await page.setViewportSize({ width: 1920, height: 768 });
    await capture("dark-trend-screener-1920x768");
    await page.setViewportSize({ width: 1440, height: 768 });
    await page.getByRole("button", { name: "白天", exact: true }).click();
    await capture("light-trend-1440x768");
    await page.getByRole("button", { name: "黑夜", exact: true }).click();
    await page.getByLabel("证券搜索：A股、ETF、可转债", { exact: true }).fill("600000");
    await page.getByLabel("证券搜索：A股、ETF、可转债", { exact: true }).press("Enter");
    await page.locator(".terminal-analysis-layout").waitFor();
    await settle();
    await analysisGeometry("with preview warning");
    await page.evaluate(() => {
      const root = document.querySelector(".main > .page");
      const quote = document.querySelector(".terminal-analysis-layout .hero-grid");
      root.scrollTop += quote.getBoundingClientRect().top - root.getBoundingClientRect().top - 14;
    });
    await capture("dark-analysis-1440x768");
    // Temporary local preview fixture only; do not change product or user data.
    await page.evaluate(() => {
      const analyze = window.stockApi.analyze;
      window.stockApi.analyze = async (...args) => ({ ...await analyze(...args), warning: undefined });
    });
    await page.getByRole("button", { name: "刷新个股", exact: true }).click();
    await page.locator(".terminal-analysis-layout").waitFor();
    await page.locator(".terminal-analysis-layout > .warning-banner").waitFor({ state: "hidden" });
    await settle();
    await analysisGeometry("without preview warning");
    assert.deepEqual(errors, []);
    const report = { checkedAt: new Date().toISOString(), url, packageVersion: require("../package.json").version,
      previewVersion: await page.locator(".version").innerText(), viewport: { width: 1440, height: 768 },
      captures, analysisChecks, errors, passed: true };
    fs.writeFileSync(path.join(output, "delivery-refresh.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
