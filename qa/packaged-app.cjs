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

    await page.locator("[data-window-controls]").waitFor({ timeout: 20_000 });
    await page.locator("[data-professional-review-nav]").waitFor({ timeout: 20_000 });
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
      const nav = document.querySelector(".sidebar nav");
      const system = document.querySelector(".sidebar .nav-caption-spaced");
      const navItem = document.querySelector(".sidebar .nav-item");
      const heading = document.querySelector(".page-heading h1");
      const controls = document.querySelector("[data-window-controls]");
      const navRect = nav?.getBoundingClientRect();
      const systemRect = system?.getBoundingClientRect();
      const controlRect = controls?.getBoundingClientRect();
      return {
        bodyFont: getComputedStyle(document.body).fontFamily,
        navFontSize: navItem ? parseFloat(getComputedStyle(navItem).fontSize) : 0,
        headingFontSize: heading ? parseFloat(getComputedStyle(heading).fontSize) : 0,
        systemRatio:
          navRect && systemRect ? (systemRect.top - navRect.top) / Math.max(1, navRect.height) : 0,
        controls: controlRect
          ? { width: controlRect.width, height: controlRect.height, top: controlRect.top }
          : null
      };
    });
    if (!/Segoe UI|Microsoft YaHei/i.test(chrome.bodyFont)) {
      throw new Error(`Unexpected desktop font stack: ${chrome.bodyFont}`);
    }
    if (chrome.navFontSize < 14 || chrome.headingFontSize < 26) {
      throw new Error(`Typography is still too small: ${JSON.stringify(chrome)}`);
    }
    if (chrome.systemRatio < 0.55) {
      throw new Error(`System navigation section was not moved down: ${chrome.systemRatio}`);
    }
    if (!chrome.controls || chrome.controls.width < 135 || chrome.controls.height !== 40) {
      throw new Error(`Window controls are not correctly sized: ${JSON.stringify(chrome.controls)}`);
    }

    await page.locator('[data-window-action="minimize"]').click();
    await page.waitForTimeout(350);
    const minimized = await windowState(app);
    if (!minimized.minimized) throw new Error("Minimize control did not minimize the BrowserWindow");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore());
    await page.waitForTimeout(250);

    await page.locator('[data-window-action="toggle-maximize"]').click();
    await page.waitForTimeout(350);
    const maximized = await windowState(app);
    if (!maximized.maximized) throw new Error("Maximize control did not maximize the BrowserWindow");
    await page.locator('[data-window-action="toggle-maximize"]').click();
    await page.waitForTimeout(250);

    await page.getByRole("button", { name: "黑夜" }).click();
    await page.waitForTimeout(250);
    if ((await page.locator("html").getAttribute("data-theme")) !== "dark") {
      throw new Error("Dark theme did not activate");
    }
    await page.locator("[data-professional-review-nav]").click();
    await page.getByText("专业复盘", { exact: true }).first().waitFor();
    await page.locator(".review-dimension").first().waitFor({ timeout: 45_000 });
    const dimensionCount = await page.locator(".review-dimension").count();
    if (dimensionCount !== 8) throw new Error(`Expected 8 market dimensions, received ${dimensionCount}`);
    const methodology = await page.locator(".review-method-note").innerText();
    if (!methodology.includes("八维市场状态模型")) {
      throw new Error("Eight-dimension methodology label is missing");
    }

    const leaders = page.locator(".review-leader-grid button");
    const leaderCount = await leaders.count();
    let factorCount = 0;
    let factorGroupCount = 0;
    let stockFactorValidation = "skipped-no-current-leaders";
    if (leaderCount > 0) {
      await leaders.first().click();
      await page.locator(".review-factor-overview").waitFor({ timeout: 45_000 });
      factorCount = await page.locator(".review-factor").count();
      factorGroupCount = await page.locator(".review-factor-group").count();
      if (factorCount !== 20) throw new Error(`Expected 20 stock factors, received ${factorCount}`);
      if (factorGroupCount !== 5) throw new Error(`Expected 5 factor groups, received ${factorGroupCount}`);
      const reviewText = await page.locator(".review-content").innerText();
      for (const text of ["数据覆盖", "涨停质量", "形态与筹码", "历史有效性", "执行准备度"]) {
        if (!reviewText.includes(text)) throw new Error(`Missing professional-review evidence: ${text}`);
      }
      stockFactorValidation = "passed";
    } else {
      const emptyLeaders = page.locator(".review-leader-grid .review-empty-inline");
      await emptyLeaders.waitFor();
      if (!(await emptyLeaders.innerText()).includes("当前无可展示的涨停梯队")) {
        throw new Error("The no-leader review state is missing its explicit explanation");
      }
    }
    await page.screenshot({ path: `qa/packaged-${expectedVersion}-professional-review-dark.png`, fullPage: true });

    await page.getByRole("button", { name: "白天" }).click();
    await page.waitForTimeout(250);
    if ((await page.locator("html").getAttribute("data-theme")) !== "light") {
      throw new Error("Light theme did not activate");
    }
    await page.screenshot({ path: `qa/packaged-${expectedVersion}-professional-review-light.png`, fullPage: true });

    await page.locator("[data-announcements-nav]").click();
    await page.locator('[data-announcement-module][data-content-type="announcement"]').waitFor();
    const announcementModule = await page.evaluate(() => ({
      title: document.querySelector(".page-heading h1")?.textContent?.trim() || "",
      scopeCount: document.querySelectorAll(".news-scope-tabs button").length,
      sourceCount: document.querySelectorAll(".news-source-strip > div").length,
      hasImportanceFilters: Array.from(document.querySelectorAll(".news-filters button"))
        .some((button) => button.textContent?.trim() === "重大"),
      renderedContentTypes: Array.from(document.querySelectorAll(".realtime-news-card"))
        .map((card) => card.querySelector(".news-card-meta em:last-of-type")?.textContent?.trim() || "")
    }));
    if (announcementModule.title !== "A股公告") {
      throw new Error(`A-share announcement module title mismatch: ${announcementModule.title}`);
    }
    if (announcementModule.scopeCount !== 6 || !announcementModule.hasImportanceFilters) {
      throw new Error(`A-share announcement filters are incomplete: ${JSON.stringify(announcementModule)}`);
    }
    if (announcementModule.sourceCount > 2) {
      throw new Error(`A-share announcement module exposed unrelated news sources: ${announcementModule.sourceCount}`);
    }

    await page.getByRole("button", { name: "数据源设置", exact: true }).click();
    await page.getByRole("heading", { name: "数据源设置", exact: true }).waitFor();
    const providerTopology = await page.evaluate(() => ({
      primary: document.querySelector(".source-lane-primary b")?.textContent?.trim() || "",
      lanes: Array.from(document.querySelectorAll(".three-source-topology b"))
        .map((item) => item.textContent?.trim() || ""),
      selectedLabel: document.querySelector(".provider-options .selected b")?.textContent?.trim() || "",
      checkedProviders: document.querySelector(".settings-card")
        ?.querySelectorAll('.provider-options input[type="radio"]:checked').length || 0
    }));
    if (
      providerTopology.primary !== "① 同花顺" ||
      providerTopology.lanes[1] !== "② 东方财富" ||
      !providerTopology.selectedLabel.includes("同花顺 QuantAPI · 主源") ||
      providerTopology.checkedProviders !== 1
    ) {
      throw new Error(`Provider priority is not fixed to THS -> Eastmoney: ${JSON.stringify(providerTopology)}`);
    }

    await page.locator("[data-backtest-nav]").click();
    await page.locator("[data-single-stock-backtest]").waitFor({ timeout: 20_000 });
    const strategyCheckboxes = page.locator('[data-backtest-strategy-picker] input[type="checkbox"]');
    await strategyCheckboxes.first().waitFor({ timeout: 20_000 });
    if (await strategyCheckboxes.count() > 1) {
      await strategyCheckboxes.nth(1).check();
    }
    const backtestWorkflow = await page.evaluate(() => {
      const strategies = Array.from(
        document.querySelectorAll('[data-backtest-strategy-picker] input[type="checkbox"]')
      );
      const minimumVotes = document.querySelector("[data-backtest-minimum-votes]");
      const startDate = document.querySelector("[data-backtest-start-date]");
      const customEntryPrice = document.querySelector("[data-backtest-custom-entry-price]");
      const form = document.querySelector("[data-single-stock-backtest]");
      const setupRect = document.querySelector(".backtest-setup-panel")?.getBoundingClientRect();
      const resultRect = document.querySelector(".backtest-result-panel")?.getBoundingClientRect();
      const historyRect = document.querySelector(".backtest-history-panel")?.getBoundingClientRect();
      return {
        visible: Boolean(form && form.getBoundingClientRect().height > 0),
        strategyCount: strategies.length,
        selectedStrategyCount: strategies.filter((item) => item.checked).length,
        minimumVotes: minimumVotes?.value || "",
        maximumVotes: minimumVotes?.getAttribute("max") || "",
        startDate: startDate?.value || "",
        maxDate: startDate?.getAttribute("max") || "",
        customEntryPriceAvailable: Boolean(customEntryPrice),
        diagnosticsCollapsed: !document.querySelector(".backtest-diagnostics")?.hasAttribute("open"),
        setupWidth: setupRect?.width || 0,
        resultWidth: resultRect?.width || 0,
        sameRow: Boolean(setupRect && resultRect && Math.abs(setupRect.top - resultRect.top) < 4),
        historyFullWidth: Boolean(
          setupRect && resultRect && historyRect &&
          historyRect.width > setupRect.width + resultRect.width
        )
      };
    });
    if (
      !backtestWorkflow.visible ||
      backtestWorkflow.strategyCount < 2 ||
      backtestWorkflow.selectedStrategyCount < 2 ||
      Number(backtestWorkflow.maximumVotes) < 2 ||
      !backtestWorkflow.customEntryPriceAvailable ||
      !backtestWorkflow.diagnosticsCollapsed ||
      !backtestWorkflow.sameRow ||
      backtestWorkflow.resultWidth <= backtestWorkflow.setupWidth ||
      !backtestWorkflow.historyFullWidth ||
      !/^\d{4}-\d{2}-\d{2}$/.test(backtestWorkflow.startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(backtestWorkflow.maxDate)
    ) {
      throw new Error(`Single-stock backtest workflow is incomplete: ${JSON.stringify(backtestWorkflow)}`);
    }
    await page.locator("[data-single-stock-backtest]").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `qa/packaged-${expectedVersion}-backtest-layout.png` });

    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.unmaximize();
      window?.setContentSize(1120, 720);
      window?.center();
    });
    await page.waitForTimeout(450);
    const overlap = await page.evaluate(() => {
      const system = document.querySelector(".sidebar .nav-caption-spaced")?.getBoundingClientRect();
      const status = document.querySelector(".sidebar-status")?.getBoundingClientRect();
      const controls = document.querySelector("[data-window-controls]")?.getBoundingClientRect();
      return {
        sidebarOverlap: Boolean(system && status && system.bottom > status.top),
        controlsVisible: Boolean(
          controls &&
            controls.top >= -1 &&
            controls.bottom <= window.innerHeight + 1
        ),
        controls: controls
          ? { top: controls.top, bottom: controls.bottom, width: controls.width, height: controls.height }
          : null,
        viewport: { width: window.innerWidth, height: window.innerHeight }
      };
    });
    if (overlap.sidebarOverlap || !overlap.controlsVisible) {
      throw new Error(`Minimum-size layout failed: ${JSON.stringify(overlap)}`);
    }

    if (pageErrors.length) throw new Error(pageErrors.join("\n"));
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
