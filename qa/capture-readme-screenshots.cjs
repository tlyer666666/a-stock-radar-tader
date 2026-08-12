"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

function resolveBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error("Chrome or Edge was not found. Set CHROME_PATH to a Chromium-compatible browser.");
  }
  return executablePath;
}

async function run() {
  const outputRoot = path.resolve("docs", "images");
  fs.mkdirSync(outputRoot, { recursive: true });

  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
    args: ["--disable-gpu"]
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    await page.goto("http://127.0.0.1:4173", { waitUntil: "networkidle" });
    await page.locator("[data-window-controls]").waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "黑夜" }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outputRoot, "dashboard.png"), fullPage: false });

    await page.locator("[data-backtest-nav]").click();
    await page.locator("[data-single-stock-backtest]").waitFor({ timeout: 20_000 });
    await page.locator("[data-backtest-strategy-picker] input[type=checkbox]").nth(1).check();
    await page.locator("[data-backtest-custom-entry-price]").fill("26.00");
    await page.evaluate(() => {
      const scroller = document.querySelector(".page");
      if (scroller instanceof HTMLElement) scroller.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outputRoot, "backtest-center.png"), fullPage: false });
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { resolveBrowserExecutable, run };
