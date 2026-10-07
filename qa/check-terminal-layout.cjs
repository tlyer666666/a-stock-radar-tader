"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const output = path.resolve(process.env.UI_QA_OUTPUT || "artifacts/terminal-ui-qa");
const url = process.env.UI_QA_URL || "http://127.0.0.1:5173";

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function measure(page) {
  return page.evaluate(() => {
    function geometry(selector) {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return { selector, width: Math.round(rect.width), height: Math.round(rect.height),
        x: Math.round(rect.x), y: Math.round(rect.y), clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
        overflowX: style.overflowX, overflowY: style.overflowY };
    }
    const selectors = [".app-shell", ".main", ".topbar", ".main > .page", ".sidebar", ".trend-screener", ".terminal-analysis-layout"];
    const regions = selectors.map(geometry).filter(Boolean);
    const pageRegion = regions.find(region => region.selector === ".main > .page");
    const issues = [];
    if (Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 2) issues.push("document/body horizontal overflow");
    for (const region of regions.filter(item => item.selector !== ".sidebar")) {
      if (region.scrollWidth > region.clientWidth + 2) issues.push(`${region.selector} horizontal overflow ${region.scrollWidth}/${region.clientWidth}`);
    }
    if (!pageRegion || pageRegion.height < 150 || pageRegion.y + pageRegion.height > innerHeight + 2) issues.push("main page has no usable viewport or extends below the window");
    const pageRect = document.querySelector(".main > .page")?.getBoundingClientRect();
    const wideContent = [...document.querySelectorAll(".page *")].filter(element => {
      const rect = element.getBoundingClientRect();
      if (!pageRect || !rect.width || rect.right <= pageRect.right + 2) return false;
      // Wide tables are valid if a local scrolling ancestor contains them.
      for (let ancestor = element.parentElement; ancestor && ancestor !== document.querySelector(".main > .page"); ancestor = ancestor.parentElement) {
        if (/(auto|scroll)/.test(getComputedStyle(ancestor).overflowX) && ancestor.scrollWidth > ancestor.clientWidth + 2) return false;
      }
      return true;
    }).slice(0, 15).map(element => ({ selector: element.tagName.toLowerCase() + (typeof element.className === "string" ? "." + element.className.trim().replace(/\s+/g, ".") : ""),
      right: Math.round(element.getBoundingClientRect().right), width: Math.round(element.getBoundingClientRect().width), text: element.textContent?.slice(0, 70) }));
    if (wideContent.length) issues.push("content extends past main page without a local scroll container");
    const localScroll = [...document.querySelectorAll(".page *")].filter(element => /(auto|scroll)/.test(getComputedStyle(element).overflowX) && element.scrollWidth > element.clientWidth + 2)
      .map(element => ({ className: element.className, width: element.clientWidth, scrollWidth: element.scrollWidth }));
    return { viewport: { width: innerWidth, height: innerHeight }, theme: document.documentElement.dataset.theme,
      workspace: document.querySelector(".app-shell")?.getAttribute("data-workspace"),
      heading: document.querySelector(".main h1")?.textContent, bodyWidth: document.body.scrollWidth,
      documentWidth: document.documentElement.scrollWidth, issues, regions, wideContent, localScroll };
  });
}

async function run() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 768 }, acceptDownloads: true });
  const errors = [], results = [], screenshots = [], scenarios = [];
  page.on("pageerror", error => errors.push(error.message));
  async function capture(name) {
    const filename = path.join(output, name + ".png");
    await page.screenshot({ path: filename, animations: "disabled" });
    screenshots.push(filename);
  }
  async function navigate(index) {
    const button = page.locator(".nav-item").nth(index);
    await button.click();
    await page.waitForFunction(index => document.querySelectorAll(".nav-item")[index]?.getAttribute("aria-current") === "page", index);
    await settle(page);
    await page.locator(".main > .page").evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
  }
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "趋势筛选", exact: true }).waitFor();
    await page.getByRole("button", { name: "黑夜", exact: true }).click();
    const labels = await page.locator(".nav-item").allInnerTexts();
    for (const width of [1024, 1280, 1440, 1920]) {
      for (const height of [720, 768]) {
        await page.setViewportSize({ width, height });
        for (let index = 0; index < labels.length; index++) {
          const label = labels[index].replace(/\s+/g, " ").trim();
          await navigate(index);
          const result = { label, ...await measure(page) };
          results.push(result);
          if ((height === 768 && width === 1440 && /涨停趋势|策略信号|数据源设置|回测中心/.test(label)) ||
            (height === 768 && width === 1920 && label.includes("涨停趋势"))) await capture(`dark-${result.workspace}-${width}x${height}`);
          if (result.issues.length) await capture(`issue-${result.workspace}-${width}x${height}`);
        }
        fs.writeFileSync(path.join(output, "layout-progress.json"), JSON.stringify({ results, errors }, null, 2) + "\n");
      }
    }
    await page.setViewportSize({ width: 1440, height: 768 });
    await page.getByLabel("证券搜索：A股、ETF、可转债", { exact: true }).fill("600000");
    await page.getByLabel("证券搜索：A股、ETF、可转债", { exact: true }).press("Enter");
    await page.locator(".terminal-analysis-layout").waitFor();
    await page.locator(".toast").waitFor({ state: "hidden", timeout: 5000 });
    for (const width of [1024, 1280, 1440, 1920]) {
      for (const height of [720, 768]) {
        await page.setViewportSize({ width, height });
        await settle(page);
        const analysis = { label: "个股分析", ...await measure(page) };
        scenarios.push(analysis);
        if (width === 1440 && height === 768) await capture("dark-analysis-1440x768");
        if (analysis.issues.length) await capture(`issue-analysis-${width}x${height}`);
      }
    }

    const trendIndex = labels.findIndex(label => label.includes("涨停趋势"));
    await page.setViewportSize({ width: 1440, height: 768 });
    await navigate(trendIndex);
    await page.getByRole("button", { name: "白天", exact: true }).click();
    await settle(page);
    scenarios.push({ label: "浅色趋势", ...await measure(page) });
    await capture("light-trend-1440x768");
    await page.getByRole("button", { name: "黑夜", exact: true }).click();
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.getByLabel("搜索代码或名称", { exact: true }).fill("不存在的演示证券");
    await page.getByText("未找到匹配的代码或名称", { exact: true }).waitFor();
    scenarios.push({ label: "趋势空态", ...await measure(page) });
    await page.locator(".trend-empty").scrollIntoViewIfNeeded();
    await capture("dark-trend-empty-1024x720");
    await page.getByRole("button", { name: "清空候选搜索", exact: true }).click();
    await page.evaluate(() => {
      window.stockApi.startTrendScan = async () => { throw new Error("本地布局验收长错误信息：网络连接暂不可用，请稍后重新检查。".repeat(12)); };
    });
    await page.getByRole("button", { name: "扫描全 A 股", exact: true }).first().click();
    await page.getByRole("alert").filter({ hasText: "本地布局验收长错误信息" }).waitFor();
    scenarios.push({ label: "长错误消息", ...await measure(page) });
    await capture("dark-trend-long-error-1024x720");

    await page.evaluate(async () => {
      const result = await window.stockApi.getTrendScan();
      result.candidates[0].security.name = "用于布局验收的超长虚构证券名称ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(4);
      result.candidates[0].warnings = ["这是用于本地预览排版测试的长风险提示，不能用于真实交易。".repeat(12)];
      window.stockApi.getTrendScan = async () => result;
    });
    await page.getByRole("button", { name: "刷新扫描状态", exact: true }).click();
    await settle(page);
    scenarios.push({ label: "长候选名称与风险提示", ...await measure(page) });
    await page.locator(".trend-candidate").first().scrollIntoViewIfNeeded();
    await capture("dark-trend-long-copy-1024x720");
    const failures = [...results, ...scenarios].filter(result => result.issues.length);
    const report = { checkedAt: new Date().toISOString(), url, navigationCount: labels.length,
      testedNavigationStates: results.length, passed: failures.length === 0 && errors.length === 0,
      errors, results, scenarios, screenshots };
    const filename = path.join(output, "layout-report.json");
    fs.writeFileSync(filename, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ navigationCount: labels.length, testedNavigationStates: results.length,
      passed: report.passed, failures: failures.map(({ label, viewport, issues, wideContent, regions }) => ({ label, viewport, issues, wideContent, regions })), errors, report: filename }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
