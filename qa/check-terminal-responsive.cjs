"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

async function run() {
  const url = process.env.UI_QA_URL || "http://127.0.0.1:5173";
  const output = path.resolve(process.env.UI_QA_OUTPUT || "artifacts/terminal-ui-qa");
  const expectOverflow = process.env.UI_EXPECT_OVERFLOW === "1";
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [], views = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(url, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "趋势筛选", exact: true }).waitFor();
    const buttons = page.locator(".nav-item");
    const labels = await buttons.allInnerTexts();
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index].replace(/\s+/g, " ").trim();
      if (label.includes("涨停趋势")) continue;
      await buttons.nth(index).click();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const measurements = await page.evaluate(() => ({
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 2,
        heading: document.querySelector(".main h1")?.textContent || "",
        wideElements: [...document.querySelectorAll(".main, .topbar, .page, .card, .panel, table")]
          .map(element => ({ tag: element.tagName, className: element.className,
            right: Math.round(element.getBoundingClientRect().right), width: Math.round(element.getBoundingClientRect().width) }))
          .filter(element => element.right > innerWidth + 2).slice(0, 12)
      }));
      views.push({ label, ...measurements });
      await page.screenshot({ path: path.join(output, `view-${String(index + 1).padStart(2, "0")}.png`) });
    }
    const overflowing = views.filter(view => view.horizontalOverflow);
    const passed = errors.length === 0 && views.length > 0 && (expectOverflow ? overflowing.length > 0 : overflowing.length === 0);
    const report = { checkedAt: new Date().toISOString(), url, viewport: { width: 1024, height: 768 },
      expectation: expectOverflow ? "Record existing horizontal-overflow failure before redesign" : "No document/body horizontal overflow on every non-trend navigation view",
      passed, visited: views.length, overflowCount: overflowing.length, errors, views };
    const filename = path.join(output, "responsive-baseline.json");
    fs.writeFileSync(filename, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ passed, visited: views.length, overflowCount: overflowing.length,
      widths: views.map(view => ({ label: view.label, body: view.bodyWidth, document: view.documentWidth })), errors, report: filename }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally { await browser.close(); }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
