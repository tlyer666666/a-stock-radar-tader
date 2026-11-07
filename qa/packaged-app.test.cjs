"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assertInformationCenter,
  assertMinimumLayout,
  assertTypography,
  assertWindowChrome,
  expectedWindowControls
} = require("./packaged-layout.cjs");
const { cleanupPackagedScreenshots } = require("./packaged-app.cjs");

const projectRoot = path.resolve(__dirname, "..");
const validChrome = {
  bodyFont: '"PingFang SC", "Microsoft YaHei", sans-serif',
  navFontSize: 13,
  headingFontSize: 19,
  navGroupCount: 3,
  controls: { width: 141, height: 32, top: 0 }
};

test("packaged E2E removes screenshots left by older package runs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "a-stock-e2e-screenshots-"));
  try {
    for (const name of [
      "v068-professional-review-dark.png",
      "packaged-0.9.16-professional-review-light.png",
      "packaged-0.9.17-professional-review-dark.png",
      "packaged-0.9.18-backtest-layout.png",
      "keep-notes.txt"
    ]) {
      fs.writeFileSync(path.join(root, name), name);
    }
    assert.deepEqual(cleanupPackagedScreenshots(root), [
      "packaged-0.9.16-professional-review-light.png",
      "packaged-0.9.17-professional-review-dark.png",
      "packaged-0.9.18-backtest-layout.png",
      "v068-professional-review-dark.png"
    ]);
    assert.deepEqual(fs.readdirSync(root), ["keep-notes.txt"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("window-control assertions follow the native titlebar platform contract", () => {
  assert.equal(expectedWindowControls("darwin"), false);
  assert.equal(expectedWindowControls("win32"), true);
  assert.equal(expectedWindowControls("linux"), true);
  assert.doesNotThrow(() => assertWindowChrome("darwin", { ...validChrome, controls: null }));
  assert.throws(
    () => assertWindowChrome("darwin", validChrome),
    /native traffic lights/
  );
  assert.doesNotThrow(() => assertWindowChrome("win32", validChrome));
  assert.throws(
    () => assertWindowChrome("win32", { ...validChrome, controls: { width: 90, height: 20 } }),
    /not correctly sized/
  );
});

test("typography assertions enforce the compact desktop scale at both bounds", () => {
  assert.doesNotThrow(() => assertTypography(validChrome));
  assert.throws(
    () => assertTypography({ ...validChrome, navFontSize: 11 }),
    /compact desktop scale/
  );
  assert.throws(
    () => assertTypography({ ...validChrome, headingFontSize: 25 }),
    /responsive desktop scale/
  );
  assert.throws(
    () => assertTypography({ ...validChrome, bodyFont: "Arial" }),
    /desktop font stack/
  );
  assert.throws(
    () => assertTypography({ ...validChrome, navGroupCount: 2 }),
    /three navigation groups/
  );
});

test("packaged E2E measures headings from the active research workspace", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  assert.match(
    runner,
    /document\.querySelector\("\.page-heading h1, \.trend-header h1"\)/
  );
});

test("packaged E2E waits for visible professional review content after navigation", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  assert.match(
    runner,
    /getByText\("有序证据 · 2–6 周观察", \{ exact: true \}\)\.waitFor\(\{ timeout: 90_000 \}\)/
  );
  assert.match(runner, /await page\.waitForFunction\([\s\S]*?data-workspace[\s\S]*?review/);
  assert.match(runner, /locator\("\.review-dimension"\)\.count\(\)/);
});

test("packaged E2E opens legacy dimensions before asserting their methodology", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  assert.match(
    runner,
    /locator\("\.review-legacy-details"\)\s*\.filter\(\{ hasText: "展开原 8 维市场资料与诊断详情" \}\)\s*\.locator\("summary"\)\s*\.click\(\)/
  );
  assert.match(runner, /locator\("\.review-method-note:visible"\)\.innerText\(\)/);
});

test("packaged E2E expands the stock legacy details before factor assertions", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  assert.match(
    runner,
    /locator\("\.review-legacy-details"\)\s*\.filter\(\{ hasText: "展开原 20 因子与行情诊断详情" \}\)\s*\.locator\("summary"\)\s*\.click\(\)/
  );
  assert.match(runner, /locator\("\.review-factor-overview:visible"\)\.waitFor/);
});

test("information-center assertions require the announcement tab and filtered sources", () => {
  const validModule = {
    title: "资讯中心",
    contentType: "announcement",
    scopeCount: 6,
    sourceCount: 2,
    hasImportanceFilters: true,
    renderedContentTypes: []
  };
  assert.doesNotThrow(() => assertInformationCenter(validModule));
  assert.throws(
    () => assertInformationCenter({ ...validModule, contentType: "all" }),
    /Announcement route/
  );
  assert.throws(
    () => assertInformationCenter({ ...validModule, scopeCount: 5 }),
    /filters are incomplete/
  );
  assert.throws(
    () => assertInformationCenter({ ...validModule, sourceCount: 3 }),
    /unrelated news sources/
  );
});

test("information-center assertions count the filtered scope controls only", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  assert.match(
    runner,
    /document\.querySelectorAll\("\.information-filter-rail \.news-scope-tabs button"\)\.length/
  );
});

test("packaged E2E opens the announcement source details before inspection", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  assert.match(
    runner,
    /locator\("\.information-disclosure"\)\s*\.filter\(\{ hasText: "来源状态" \}\)\s*\.locator\("summary"\)\s*\.click\(\)/
  );
  assert.match(
    runner,
    /locator\('\[data-announcement-module\]\[data-content-type="announcement"\]:visible'\)\.waitFor\(\)/
  );
});

test("packaged E2E uses the current navigation and announcement selectors", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  assert.match(runner, /data-information-center-nav/);
  assert.match(runner, /getByRole\("tab", \{ name: "公司公告", exact: true \}\)/);
  assert.match(runner, /data-content-type="announcement"/);
  assert.doesNotMatch(runner, /data-announcements-nav|nav-caption-spaced/);
});

test("packaged E2E launches hardened builds through the CDP session helper", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  assert.match(runner, /require\("\.\/packaged-session\.cjs"\)/);
  assert.match(runner, /launchPackaged\(/);
  assert.match(runner, /appExecutable\(/);
  assert.doesNotMatch(runner, /playwright-core/);
  assert.doesNotMatch(runner, /\b_electron\b/);
  assert.doesNotMatch(runner, /app\.evaluate\(/);
});

test("packaged E2E exercises every failed-board view and its published data contract", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  for (const text of [
    "previous-limit-up-failed",
    "昨日涨停今炸板",
    "当日炸板",
    "近五日炸板",
    "筛选口径与数据来源",
    "排除已识别一字板",
    "oneWordLabel",
    "selectedFailedBoardView",
    "当日炸板",
    ".puf-day-tabs",
    ".puf-table"
  ]) {
    assert.ok(runner.includes(text), `packaged E2E is missing ${text}`);
  }
});

test("packaged E2E requires explainable trend and strategy-signal states", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  for (const text of [
    "trend-results-context",
    "trend-logic-overview",
    "strategy-signals-view",
    "strategy-signal-tab-list",
    "strategy-stock-panel",
    "firstTabAudit",
    "empty"
  ]) {
    assert.ok(runner.includes(text), `packaged E2E is missing ${text}`);
  }
});

test("packaged E2E waits for failed-board requests and strategy scans to settle", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  assert.match(runner, /locator\("\.puf-refresh-button:not\(\[disabled\]\)"\)\.waitFor/);
  // 进入策略页会自动开始扫描，扫描期间按钮是「正在选股」且 disabled，
  // 所以先只等按钮出现（两种文案皆可），把"可用"判定留给后面要求「重新选股」可点的等待。
  assert.match(runner, /\["重新选股", "正在选股"\]/);
  assert.match(runner, /item\.textContent\?\.trim\(\) === "重新选股"/);
  assert.match(runner, /signal-test-status/);
});

test("packaged E2E rejects settled strategy and failed-board placeholders", () => {
  const runner = fs.readFileSync(path.join(projectRoot, "qa", "packaged-app.cjs"), "utf8");
  assert.match(runner, /!intersectionState\.table/);
  assert.match(runner, /intersectionState\.sortButtons < 3/);
  assert.match(runner, /signalState\.tabCount !== expectedSignalStrategyCount/);
  assert.match(runner, /signalState\.loading/);
  assert.match(runner, /signalState\.rows > 0 && signalState\.empty/);
});

test("minimum-size layout assertions distinguish native and custom window chrome", () => {
  const validLayout = {
    navigationOverflow: false,
    statusVisible: true,
    controlsVisible: true
  };
  assert.doesNotThrow(() => assertMinimumLayout("darwin", validLayout));
  assert.doesNotThrow(() => assertMinimumLayout("win32", validLayout));
  assert.throws(
    () => assertMinimumLayout("darwin", { ...validLayout, navigationOverflow: true }),
    /navigation overflows/
  );
  assert.throws(
    () => assertMinimumLayout("darwin", { ...validLayout, statusVisible: false }),
    /status bar is hidden/
  );
  assert.throws(
    () => assertMinimumLayout("win32", { ...validLayout, controlsVisible: false }),
    /window controls are clipped/
  );
});
