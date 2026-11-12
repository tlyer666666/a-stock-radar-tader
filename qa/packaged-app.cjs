"use strict";

const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");
const { appExecutable, launchPackaged } = require("./packaged-session.cjs");
const {
  assertInformationCenter,
  assertMinimumLayout,
  assertTypography,
  assertWindowChrome,
  expectedWindowControls
} = require("./packaged-layout.cjs");

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
        path.resolve("release-builder", "mac-arm64", "A股雷达趋势版.app"),
        path.resolve("release-builder", "mac", "A股雷达趋势版.app"),
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

async function run() {
  const phase = { name: "resolve-executable", startedAt: Date.now() };
  const mark = (name) => {
    phase.name = name;
    phase.startedAt = Date.now();
    process.stderr.write(`[packaged-e2e] ${name}\n`);
  };
  const executablePath = resolveExecutablePath();
  const hiddenE2E = process.env.PACKAGED_E2E_VISIBLE !== "1";
  const platform = process.platform;
  const hasCustomWindowControls = expectedWindowControls(platform);
  let session;
  try {
    mark("launch");
    session = await launchPackaged(appExecutable(executablePath), { hidden: hiddenE2E });
    mark("first-window");
    const page = session.page;
    await page.setViewportSize({ width: 1480, height: 940 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    if (hasCustomWindowControls) {
      mark("window-controls");
      await page.locator("[data-window-controls]").waitFor({ timeout: 20_000 });
    }
    mark("application-ready");
    await page.locator("[data-professional-review-nav]").waitFor({ timeout: 20_000 });
    const rendererVersion = await page.evaluate(() => window.stockApi.getVersion());
    const appVersion = rendererVersion;
    const expectedVersion = String(packageJson.version);
    if (appVersion !== expectedVersion || rendererVersion !== expectedVersion) {
      throw new Error(
        `Packaged version mismatch: package=${expectedVersion}, app=${appVersion}, renderer=${rendererVersion}`
      );
    }
    const removedOldScreenshots = cleanupPackagedScreenshots();

    mark("chrome-layout");
    const chrome = await page.evaluate(() => {
      const nav = document.querySelector(".sidebar nav");
      const navItem = document.querySelector(".sidebar .nav-item");
      const heading = document.querySelector(".page-heading h1, .trend-header h1");
      const controls = document.querySelector("[data-window-controls]");
      const controlRect = controls?.getBoundingClientRect();
      return {
        bodyFont: getComputedStyle(document.body).fontFamily,
        navFontSize: navItem ? parseFloat(getComputedStyle(navItem).fontSize) : 0,
        headingFontSize: heading ? parseFloat(getComputedStyle(heading).fontSize) : 0,
        navGroupCount: nav?.querySelectorAll(".workspace-nav-group").length || 0,
        controls: controlRect
          ? { width: controlRect.width, height: controlRect.height, top: controlRect.top }
          : null
      };
    });
    assertTypography(chrome);
    assertWindowChrome(platform, chrome);

    const minimized = { checked: false, cdpSession: true };
    let maximized = { checked: false, maximized: false };
    if (hasCustomWindowControls) {
      mark("window-actions");
      await page.locator('[data-window-action="minimize"]').click();
      await page.waitForTimeout(100);
      await page.locator('[data-window-action="toggle-maximize"]').click();
      await page.locator('[data-window-action="toggle-maximize"][aria-label="还原窗口"]').waitFor();
      maximized = { checked: true, maximized: true };
      await page.locator('[data-window-action="toggle-maximize"]').click();
      await page.locator('[data-window-action="toggle-maximize"][aria-label="最大化窗口"]').waitFor();
    }

    mark("professional-review-dark");
    await page.getByRole("button", { name: "黑夜" }).click();
    await page.waitForTimeout(250);
    if ((await page.locator("html").getAttribute("data-theme")) !== "dark") {
      throw new Error("Dark theme did not activate");
    }
    await page.locator("[data-professional-review-nav]").click();
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.getAttribute("data-workspace") === "review",
      undefined,
      { timeout: 20_000 }
    );
    // 窗口较窄时侧栏收成图标，导航里的「专业复盘」文字是隐藏的；这里等的是页面上可见的标题。
    await page.locator(':text-is("专业复盘"):visible').first().waitFor({ timeout: 60_000 });
    await page.getByText("有序证据 · 2–6 周观察", { exact: true }).waitFor({ timeout: 90_000 });
    await page.locator(".review-legacy-details")
      .filter({ hasText: "展开原 8 维市场资料与诊断详情" })
      .locator("summary")
      .click();
    const dimensionCount = await page.locator(".review-dimension").count();
    if (dimensionCount !== 8) throw new Error(`Expected 8 market dimensions, received ${dimensionCount}`);
    const methodology = await page.locator(".review-method-note:visible").innerText();
    if (!methodology.includes("八维市场状态模型")) {
      throw new Error("Eight-dimension methodology label is missing");
    }

    mark("professional-review-factors");
    const leaders = page.locator(".review-leader-grid button");
    const leaderCount = await leaders.count();
    let factorCount = 0;
    let factorGroupCount = 0;
    let stockFactorValidation = "skipped-no-current-leaders";
    if (leaderCount > 0) {
      await leaders.first().click();
      await page.getByText("展开原 20 因子与行情诊断详情", { exact: true }).waitFor({ timeout: 45_000 });
      await page.locator(".review-legacy-details")
        .filter({ hasText: "展开原 20 因子与行情诊断详情" })
        .locator("summary")
        .click();
      await page.locator(".review-factor-overview:visible").waitFor({ timeout: 45_000 });
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

    mark("professional-review-light");
    await page.getByRole("button", { name: "白天" }).click();
    await page.waitForTimeout(250);
    if ((await page.locator("html").getAttribute("data-theme")) !== "light") {
      throw new Error("Light theme did not activate");
    }
    await page.screenshot({ path: `qa/packaged-${expectedVersion}-professional-review-light.png`, fullPage: true });

    mark("failed-board-today");
    await page.getByRole("button", { name: "炸板观察", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.getAttribute("data-workspace") === "previous-limit-up-failed",
      undefined,
      { timeout: 20_000 }
    );
    await page.locator(".previous-limit-up-failed-page").waitFor({ timeout: 20_000 });
    await page.getByRole("heading", { name: "当日涨停后炸板", exact: true }).waitFor();
    await page.locator(".puf-refresh-button:not([disabled])").waitFor({ timeout: 45_000 });
    const failedBoardViews = await page.locator(".puf-view-tabs [role=tab]").allTextContents();
    const selectedFailedBoardView = await page.locator('.puf-view-tabs [role="tab"][aria-selected="true"]').innerText();
    if (
      !["当日炸板", "近五日炸板", "昨日涨停今炸板"].every((label) =>
        failedBoardViews.some((text) => text.trim() === label)
      ) ||
      selectedFailedBoardView.trim() !== "当日炸板"
    ) {
      throw new Error(`Failed-board views are incomplete or have the wrong default: ${JSON.stringify({ failedBoardViews, selectedFailedBoardView })}`);
    }
    const todayFailedBoard = await page.evaluate(() => ({
      hasTable: Boolean(document.querySelector(".puf-daily-table")),
      stateText: document.querySelector(".puf-state-card")?.textContent?.trim() || "",
      sourceText: document.querySelector(".puf-source-strip")?.textContent?.trim() || "",
      dayTabs: document.querySelectorAll(".puf-day-tabs [role=tab]").length
    }));
    if (
      (!todayFailedBoard.hasTable && !todayFailedBoard.stateText) ||
      !todayFailedBoard.sourceText ||
      todayFailedBoard.dayTabs !== 0
    ) {
      throw new Error(`Today's failed-board view is incomplete: ${JSON.stringify(todayFailedBoard)}`);
    }

    mark("failed-board-intersection");
    await page.getByRole("tab", { name: "昨日涨停今炸板", exact: true }).click();
    await page.getByRole("heading", { name: "昨日涨停 · 今日炸板", exact: true }).waitFor();
    await page.locator(".puf-refresh-button:not([disabled])").waitFor({ timeout: 45_000 });
    await page.locator(".puf-method-disclosure")
      .filter({ hasText: "筛选口径与数据来源" })
      .locator("summary")
      .click();
    const failedBoardMethod = await page.locator(".puf-method-disclosure").innerText();
    for (const text of ["T-1 涨停", "getTopicZBPool", "每 15 秒", "一字板默认纳入"]) {
      if (!failedBoardMethod.includes(text)) {
        throw new Error(`Failed-board methodology is missing: ${text}`);
      }
    }
    const intersectionState = await page.evaluate(() => {
      const pageRoot = document.querySelector(".previous-limit-up-failed-page");
      return {
        oneWordToggle: Boolean(pageRoot?.querySelector(".puf-one-word-toggle input")),
        oneWordLabel: pageRoot?.querySelector(".puf-one-word-toggle")?.textContent?.trim() || "",
        search: Boolean(pageRoot?.querySelector(".puf-search input")),
        table: Boolean(pageRoot?.querySelector(".puf-table")),
        sortButtons: pageRoot?.querySelectorAll(".puf-sort-button").length || 0,
        stateText: pageRoot?.querySelector(".puf-state-card, .puf-source-banner")?.textContent?.trim() || "",
        sourceStrip: pageRoot?.querySelector(".puf-source-strip")?.textContent?.trim() || ""
      };
    });
    if (
      !intersectionState.oneWordToggle ||
      !intersectionState.oneWordLabel.includes("排除已识别一字板") ||
      !intersectionState.search ||
      // 开盘前或当天没有炸板时，页面给出明确的「无符合记录」而不是表格，这同样是正确结果；加载中或其他占位仍然算失败。
      (!intersectionState.table && !intersectionState.stateText.includes("无符合记录")) ||
      (intersectionState.table && intersectionState.sortButtons < 3) ||
      !intersectionState.sourceStrip
    ) {
      throw new Error(`Failed-board intersection controls are incomplete: ${JSON.stringify(intersectionState)}`);
    }

    mark("failed-board-five-days");
    await page.getByRole("tab", { name: "近五日炸板", exact: true }).click();
    await page.getByRole("heading", { name: "近五日炸板", exact: true }).waitFor();
    await page.locator(".puf-day-tabs [role=tab]").first().waitFor({ timeout: 20_000 });
    const dayTabs = page.locator(".puf-day-tabs [role=tab]");
    const dayTabCount = await dayTabs.count();
    if (dayTabCount !== 5) {
      throw new Error(`Expected five independent failed-board days, received ${dayTabCount}`);
    }
    const firstDayText = (await dayTabs.first().innerText()).trim();
    await dayTabs.nth(4).click();
    const selectedDay = await dayTabs.nth(4).getAttribute("aria-selected");
    const selectedDayText = (await dayTabs.nth(4).innerText()).trim();
    if (selectedDay !== "true" || selectedDayText === firstDayText) {
      throw new Error(`Failed-board day selection did not change: ${JSON.stringify({ firstDayText, selectedDayText, selectedDay })}`);
    }
    const fiveDayState = await page.evaluate(() => ({
      selectedCount: document.querySelectorAll('.puf-day-tabs [role="tab"][aria-selected="true"]').length,
      hasTable: Boolean(document.querySelector(".puf-daily-table")),
      stateText: document.querySelector(".puf-state-card")?.textContent?.trim() || "",
      footer: document.querySelector(".puf-page-footer")?.textContent?.trim() || ""
    }));
    if (
      fiveDayState.selectedCount !== 1 ||
      (!fiveDayState.hasTable && !fiveDayState.stateText) ||
      !fiveDayState.footer.includes("每 15 秒")
    ) {
      throw new Error(`Five-day failed-board view is incomplete: ${JSON.stringify(fiveDayState)}`);
    }

    mark("information-center");
    await page.locator("[data-information-center-nav]").click();
    await page.getByRole("tab", { name: "公司公告", exact: true }).click();
    await page.locator(".information-disclosure")
      .filter({ hasText: "来源状态" })
      .locator("summary")
      .click();
    await page.locator('[data-announcement-module][data-content-type="announcement"]:visible').waitFor();
    const announcementModule = await page.evaluate(() => ({
      title: document.querySelector(".page-heading h1")?.textContent?.trim() || "",
      contentType: document.querySelector("[data-content-type]")?.getAttribute("data-content-type") || "",
      scopeCount: document.querySelectorAll(".information-filter-rail .news-scope-tabs button").length,
      sourceCount: document.querySelectorAll(".news-source-strip > div").length,
      hasImportanceFilters: Array.from(document.querySelectorAll(".news-filters button"))
        .some((button) => button.textContent?.trim() === "重大"),
      renderedContentTypes: Array.from(document.querySelectorAll(".realtime-news-card"))
        .map((card) => card.querySelector(".news-card-meta em:last-of-type")?.textContent?.trim() || "")
    }));
    assertInformationCenter(announcementModule);

    mark("settings");
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
    // 1.5.7 起主源文案从「同花顺 QuantAPI」改为「同花顺免费行情」（免 Token 网关），
    // 两种形态都是合法产品状态：无条件要求三线顺序与单选，文案二选一。
    const allowedPrimary = ["① 同花顺", "① 同花顺免费行情"];
    const allowedSelected = ["同花顺免费行情 · 主源", "同花顺扶摇行情 · 主源", "同花顺 QuantAPI · 主源"];
    const lanesOrdered =
      providerTopology.lanes.length >= 3 &&
      providerTopology.lanes[0].startsWith("① 同花顺") &&
      providerTopology.lanes[1] === "② 东方财富" &&
      providerTopology.lanes[2].startsWith("③ 腾讯");
    if (
      !allowedPrimary.includes(providerTopology.primary) ||
      !lanesOrdered ||
      !allowedSelected.some((label) => providerTopology.selectedLabel.includes(label)) ||
      providerTopology.checkedProviders !== 1
    ) {
      throw new Error(
        `Provider priority must stay THS -> Eastmoney -> Tencent with a single selection; ` +
        `expected one of ${JSON.stringify({ primary: allowedPrimary, lanes: ["① 同花顺*", "② 东方财富", "③ 腾讯*"], selectedLabel: allowedSelected, checkedProviders: 1 })}, ` +
        `actual ${JSON.stringify(providerTopology)}`
      );
    }

    mark("backtest");
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

    // 「涨停趋势」与「策略信号」已合并为「策略选股」：趋势模型从策略库打开，规则说明折叠在模型内。
    mark("trend-screener");
    await page.getByRole("button", { name: "策略选股", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.getAttribute("data-workspace") === "signals",
      undefined,
      { timeout: 20_000 }
    );
    await page.locator(".strategy-library-item.trend").first().click({ timeout: 20_000 });
    await page.locator(".trend-screener").waitFor({ timeout: 20_000 });
    await page.locator(".trend-logic-overview").waitFor({ state: "attached" });
    const trendState = await page.evaluate(() => {
      const context = document.querySelector(".trend-results-context");
      return {
        context: context?.textContent?.trim() || "",
        candidates: document.querySelectorAll(".trend-candidate").length,
        empty: document.querySelector(".trend-empty")?.textContent?.trim() || "",
        scanStatus: document.querySelector(".research-command-bar")?.textContent?.trim() || ""
      };
    });
    if (!trendState.context || (!trendState.candidates && !trendState.empty) || !trendState.scanStatus) {
      throw new Error(`Trend workspace lacks an explainable result state: ${JSON.stringify(trendState)}`);
    }

    mark("strategy-signals");
    await page.getByRole("button", { name: "策略选股", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector(".app-shell")?.getAttribute("data-workspace") === "signals",
      undefined,
      { timeout: 20_000 }
    );
    await page.locator(".strategy-signals-view").waitFor({ timeout: 20_000 });
    await page.locator(".strategy-signal-tab-list > button").first().waitFor({ timeout: 30_000 });
    await page.locator(".strategy-signal-tab-list > button").first().click();
    // 进入该页会自动开始扫描，扫描期间按钮文案是「正在选股」（StrategySignalsView.tsx:560），
    // 所以这里只等"扫描按钮出现"，空闲/可用状态交给下面的 180s 等待判定。
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll(".strategy-signals-view button"))
        .some((item) => ["重新选股", "正在选股"].includes(item.textContent?.trim() || "")),
      undefined,
      { timeout: 30_000 }
    );
    // 真实选股要遍历全市场并生成历史参考，受行情源健康度限制，实测单轮可超过 180s；预算 360s。
    // GitHub 托管机在海外，访问 A 股行情源很慢：CI 里到时仍在扫描时只核对页面结构和无报错，
    // 结果断言留给本机（非 CI）运行。
    const scanFinished = await page.waitForFunction(
      () => {
        const button = Array.from(document.querySelectorAll(".strategy-signals-view button"))
          .find((item) => item.textContent?.trim() === "重新选股");
        return Boolean(button && !button.disabled && !document.querySelector(".signal-test-status"));
      },
      undefined,
      { timeout: 360_000 }
    ).then(() => true, (error) => {
      if (!process.env.CI) throw error;
      console.log("[packaged-e2e] strategy-signals live scan still running on CI runner; checking page structure only");
      return false;
    });
    const signalState = await page.evaluate(() => {
      const panel = document.querySelector(".strategy-stock-panel");
      const empty = panel?.querySelector(".strategy-stock-empty")?.textContent?.trim() || "";
      const firstTab = document.querySelector(".strategy-signal-tab-list > button");
      return {
        tabCount: document.querySelectorAll(".strategy-signal-tab-list > button").length,
        panel: Boolean(panel),
        rows: panel?.querySelectorAll("tbody tr").length || 0,
        empty,
        firstTab: firstTab?.textContent?.trim() || "",
        firstTabAudit: firstTab?.querySelector(".strategy-signal-tab-audit")?.textContent?.trim() || "",
        loading: document.querySelector(".signal-test-status")?.textContent?.trim() || "",
        error: document.querySelector(".strategy-signals-view [role=alert]")?.textContent?.trim() || ""
      };
    });
    const expectedSignalStrategyCount = require("../electron/strategy-signal-engine.cjs").STRATEGY_DEFINITIONS.length;
    if (!scanFinished) {
      // 扫描中按设计只显示进度说明（还没有结果面板）：核对策略标签齐全、进度在走、没有报错。
      if (signalState.tabCount !== expectedSignalStrategyCount || !signalState.firstTab || !signalState.loading || signalState.error) {
        throw new Error(`Strategy signals page is broken while scanning: ${JSON.stringify(signalState)}`);
      }
    } else if (
      signalState.tabCount !== expectedSignalStrategyCount ||
      !signalState.panel ||
      !signalState.firstTab ||
      !signalState.firstTabAudit ||
      (signalState.rows === 0 && !signalState.empty) ||
      (signalState.rows > 0 && signalState.empty) ||
      signalState.loading ||
      signalState.error
    ) {
      throw new Error(`Strategy signals lack candidate rows or an explicit empty reason: ${JSON.stringify(signalState)}`);
    }

    mark("responsive-layout");
    // 「策略选股」属于 researchView（src/App.tsx:555），该视图按设计不渲染侧栏状态条
    // （src/App.tsx:3106 的 {!researchView && …}）。先回到复盘视图再量最小尺寸，
    // 让这条断言测到它该测的常驻状态栏，而不是把断言降级成"看不到就算了"。
    await page.locator("[data-professional-review-nav]").click();
    await page.waitForFunction(
      () => {
        const shell = document.querySelector(".app-shell");
        return Boolean(
          shell &&
          shell.getAttribute("data-workspace") === "review" &&
          document.querySelector(".sidebar-status")
        );
      },
      undefined,
      { timeout: 20_000 }
    );
    await page.setViewportSize({ width: 1120, height: 720 });
    await page.waitForTimeout(250);
    const overlap = await page.evaluate(() => {
      const status = document.querySelector(".sidebar-status")?.getBoundingClientRect();
      const controls = document.querySelector("[data-window-controls]")?.getBoundingClientRect();
      return {
        navigationOverflow: Boolean(
          document.querySelector(".workspace-navigation")?.scrollHeight >
          document.querySelector(".workspace-navigation")?.clientHeight
        ),
        statusVisible: Boolean(status && status.width > 0 && status.height > 0),
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
    assertMinimumLayout(platform, overlap);

    if (pageErrors.length) throw new Error(pageErrors.join("\n"));
    mark("complete");
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
          failedBoardViews,
          selectedFailedBoardView,
          intersectionState,
          todayFailedBoard,
          dayTabCount,
          selectedDayText,
          fiveDayState,
          trendState,
          signalState,
          removedOldScreenshots,
          overlap
        },
        null,
        2
      ) + "\n"
    );
  } finally {
    await session?.close().catch(() => {});
    if (process.exitCode) process.stderr.write(`[packaged-e2e] failed during ${phase.name} after ${Date.now() - phase.startedAt}ms\n`);
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { cleanupPackagedScreenshots, resolveExecutablePath, run };
