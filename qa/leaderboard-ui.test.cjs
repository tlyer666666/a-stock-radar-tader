"use strict";
// 策略实测榜界面：回测中心入口、排行展开与口径文字（2026-11-21）。
const test = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright-core");
const path = require("node:path");
const { spawn } = require("node:child_process");
const http = require("node:http");

const CHROME = process.env.QA_CHROMIUM_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 5173;
const root = path.resolve(__dirname, "..");

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    const ok = await new Promise(resolve => {
      const req = http.get(url, res => { res.resume(); resolve(true); });
      req.on("error", () => resolve(false));
      req.setTimeout(1500, () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

test("leaderboard view opens from backtest center, shows the report and expands a strategy row", async () => {
  const server = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(PORT)], { cwd: root, stdio: "ignore" });
  try {
    assert.equal(await waitForServer(`http://127.0.0.1:${PORT}/`), true, "vite server did not start");
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
      // 侧栏默认只显示核心模块：先切回全部再进回测中心。
      const focusToggle = page.locator(".sidebar-focus-toggle.active");
      if (await focusToggle.count()) await focusToggle.evaluate(node => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await page.waitForFunction(() => [...document.querySelectorAll("aside button")].some(b => b.textContent.trim() === "回测中心"));
      await page.evaluate(() => { const btn = [...document.querySelectorAll("aside button")].find(b => b.textContent.trim() === "回测中心"); btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await page.locator("[data-backtest-leaderboard-entry]").click();
      const row = page.locator(".lb-table tbody tr").filter({ hasText: "深跌底部首板" });
      await row.first().waitFor();
      assert.match(await page.locator(".lb-verdict b").innerText(), /最稳的是「/);
      const first = page.locator(".lb-table tbody tr").first();
      await first.evaluate(node => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      await page.locator(".lb-detail").waitFor();
      assert.match(await page.locator(".lb-detail").innerText(), /持有期|优势/);
      await page.locator(".lb-method summary").evaluate(node => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      assert.match(await page.locator(".lb-method").innerText(), /次日开盘买入/);
      // 展开后再次点击同一行应收起。
      await first.evaluate(node => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
      assert.equal(await page.locator(".lb-detail").count(), 0);
      await browser.close();
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    server.kill();
  }
});
