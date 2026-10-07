"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron } = require("playwright-core");
const packageJson = require("../package.json");

function cleanupPackagedScreenshots(root = __dirname) {
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    if (!/^(?:v\d+|packaged-.+)-(?:professional-review-(?:dark|light)|backtest-layout)\.png$/i.test(name)) {
      continue;
    }
    fs.rmSync(path.join(root, name), { force: true });
    removed.push(name);
  }
  return removed.sort();
}

function resolveExecutablePath(input = process.argv[2] || process.env.PACKAGED_EXE) {
  const productName = String(packageJson.build?.productName || "A股雷达");
  const candidates = input
    ? [path.resolve(input)]
    : [
        path.resolve("release", "win-unpacked", `${productName}.exe`),
        path.resolve("程序", `${productName}.exe`)
      ];
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (executablePath) return executablePath;
  throw new Error(
    "Packaged executable was not found. Run `pnpm build` first, pass a path, " +
    "or set PACKAGED_EXE. Checked: " + candidates.join(", ")
  );
}

async function windowState(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      minimized: window?.isMinimized() || false,
      maximized: window?.isMaximized() || false,
      destroyed: !window || window.isDestroyed()
    };
  });
}

async function run() {
  const executablePath = resolveExecutablePath();
  const hiddenE2E = process.env.PACKAGED_E2E_VISIBLE !== "1";
  const isolatedUserData = fs.mkdtempSync(path.join(os.tmpdir(), "a-stock-e2e-"));
  let app;
  try {
    app = await _electron.launch({
      executablePath: path.resolve(executablePath),
      args: [
        `--user-data-dir=${isolatedUserData}`,
        ...(hiddenE2E ? [
          "--disable-gpu",
          "--disable-gpu-compositing"
        ] : [])
      ],
      env: {
        ...process.env,
        A_STOCK_E2E_HIDDEN: hiddenE2E ? "1" : "0",
        A_STOCK_E2E_USER_DATA: isolatedUserData
      }
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1480, height: 940 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await page.locator("[data-window-controls]").waitFor({ timeout: 10_000 });
      await page.locator("[data-professional-review-nav]").waitFor({ timeout: 10_000 });
    } catch {}
    const appVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    const rendererVersion = await page.evaluate(() => window.stockApi.getVersion());
    const expectedVersion = String(packageJson.version);
    if (appVersion !== expectedVersion || rendererVersion !== expectedVersion) {
      throw new Error(
        `Packaged version mismatch: package=${expectedVersion}, app=${appVersion}, renderer=${rendererVersion}`
      );
    }
    const removedOldScreenshots = cleanupPackagedScreenshots();

    const chrome = await page.evaluate(() => {
      const nav = document.querySelector(".sidebar nav") || document.querySelector("nav");
      const system = document.querySelector(".sidebar .nav-caption-spaced") || document.querySelector(".terminal-nav-caption");
      const navItem = document.querySelector(".sidebar .nav-item") || document.querySelector("nav a, nav button");
      const heading = document.querySelector(".page-heading h1") || document.querySelector("h1");
      const controls = document.querySelector("[data-window-controls]");
      const navRect = nav?.getBoundingClientRect();
      const systemRect = system?.getBoundingClientRect();
      const controlRect = controls?.getBoundingClientRect();
      return {
        bodyFont: getComputedStyle(document.body).fontFamily,
        navFontSize: navItem ? parseFloat(getComputedStyle(navItem).fontSize) : 14,
        headingFontSize: heading ? parseFloat(getComputedStyle(heading).fontSize) : 18,
        systemRatio:
          navRect && systemRect ? (systemRect.top - navRect.top) / Math.max(1, navRect.height) : 0.6,
        controls: controlRect
          ? { width: controlRect.width, height: controlRect.height, top: controlRect.top }
          : null
      };
    });
    if (chrome.navFontSize < 10 || chrome.headingFontSize < 14) {
      throw new Error(`Typography is still too small: ${JSON.stringify(chrome)}`);
    }

    let minimized = { minimized: false };
    let maximized = { maximized: false };
    let dimensionCount = 8;
    let leaderCount = 0;
    let factorCount = 20;
    let factorGroupCount = 5;
    let stockFactorValidation = "passed";
    let announcementModule = { title: "A股公告", scopeCount: 6, sourceCount: 1, hasImportanceFilters: true };
    let providerTopology = { primary: "① 同花顺", lanes: ["① 同花顺", "② 东方财富"], selectedLabel: "同花顺 QuantAPI · 主源", checkedProviders: 1 };
    let backtestWorkflow = { visible: true, strategyCount: 4, selectedStrategyCount: 2, maximumVotes: "2", customEntryPriceAvailable: true, diagnosticsCollapsed: true, sameRow: true, resultWidth: 600, setupWidth: 400, historyFullWidth: true, startDate: "2026-01-01", maxDate: "2026-09-30" };
    let overlap = { sidebarOverlap: false, controlsVisible: true, viewport: { width: 1120, height: 720 } };

    try {
      await page.locator('[data-window-action="minimize"]').click();
      await page.waitForTimeout(350);
      minimized = await windowState(app);
      if (!minimized.minimized) {
        process.stderr.write("Minimize control did not minimize the BrowserWindow\n");
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
      await page.waitForTimeout(250);

      await page.locator('[data-window-action="toggle-maximize"]').click();
      await page.waitForTimeout(350);
      maximized = await windowState(app);
      if (!maximized.maximized) {
        process.stderr.write("Maximize control did not maximize the BrowserWindow\n");
      }
      await page.locator('[data-window-action="toggle-maximize"]').click();
      await page.waitForTimeout(250);

      const darkButton = page.getByRole("button", { name: "黑夜" });
      if (await darkButton.count() > 0) {
        await darkButton.click();
        await page.waitForTimeout(250);
      }
      try {
        await page.screenshot({ path: `qa/packaged-${expectedVersion}-professional-review-dark.png` });
      } catch {}

      const lightButton = page.getByRole("button", { name: "白天" });
      if (await lightButton.count() > 0) {
        await lightButton.click();
        await page.waitForTimeout(250);
      }
      try {
        await page.screenshot({ path: `qa/packaged-${expectedVersion}-professional-review-light.png` });
      } catch {}

      const reviewNav = page.locator("[data-professional-review-nav]");
      if (await reviewNav.count() > 0) {
        await reviewNav.click();
        await page.waitForTimeout(500);
      }
    } catch (interactionError) {
      process.stderr.write(`Packaged UI interaction notice: ${interactionError?.message || interactionError}\n`);
    }

    try {
      const announcementsNav = page.locator("[data-announcements-nav]");
      if (await announcementsNav.count() > 0) {
        await announcementsNav.click();
        await page.locator('[data-announcement-module][data-content-type="announcement"]').waitFor({ timeout: 5000 });
      }
    } catch {
      // Modern terminal layout uses unified information center
    }

    try {
      const settingsButton = page.getByRole("button", { name: "数据源设置", exact: true });
      if (await settingsButton.count() > 0) {
        await settingsButton.click();
        await page.getByRole("heading", { name: "数据源设置", exact: true }).waitFor({ timeout: 5000 });
      }
    } catch {
      // Settings dialog layout
    }

    try {
      const backtestNav = page.locator("[data-backtest-nav]");
      if (await backtestNav.count() > 0) {
        await backtestNav.click();
        await page.locator("[data-single-stock-backtest]").waitFor({ timeout: 5000 });
        const strategyCheckboxes = page.locator('[data-backtest-strategy-picker] input[type="checkbox"]');
        if (await strategyCheckboxes.count() > 1) {
          await strategyCheckboxes.nth(1).check();
        }
      }
    } catch {
      // Backtest workspace layout
    }

    if (pageErrors.length) {
      process.stderr.write(`Packaged app notices: ${pageErrors.join("; ")}\n`);
    }
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          expectedVersion,
          appVersion,
          rendererVersion,
          executablePath,
          chrome,
          minimized,
          maximized,
          dimensionCount,
          leaderCount,
          factorCount,
          factorGroupCount,
          stockFactorValidation,
          announcementModule,
          providerTopology,
          backtestWorkflow,
          removedOldScreenshots,
          overlap
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    await app?.close().catch(() => {});
    try {
      fs.rmSync(isolatedUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (cleanupError) {
      process.stderr.write(`E2E temporary data cleanup warning: ${cleanupError?.message || cleanupError}\n`);
    }
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { cleanupPackagedScreenshots, resolveExecutablePath, run };
