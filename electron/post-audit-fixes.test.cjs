"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createFuyaoQuoteSource } = require("./fuyao-quote.cjs");
const { createNoteParser, sanitizeNoteParse } = require("./ai-notes.cjs");
const { isExpectedRendererEntry } = require("./security-policy.cjs");
const { tightenUserDataPermissions } = require("./persistence.cjs");
const { createStrategySelectionService, getStrategyScanProgress } = require("./strategy-selection-service.cjs");
const { humanizeSourceError } = require("./market-source-health.cjs");

test("fuyao-quote resolves live *ST and N/C IPO names over code-placeholder security.name", async () => {
  const quoteSource = createFuyaoQuoteSource({
    now: () => Date.parse("2026-06-15T06:00:00Z"),
    loadProfile: async sec => (sec.code === "000506"
      ? { name: "*ST中润", latest: 4.2, totalMarketCap: 4.2e8, floatMarketCap: 4.2e8 }
      : { name: "N新股", latest: 45.0, totalMarketCap: 45e8, floatMarketCap: 22.5e8 }),
    fuyao: {
      snapshot: async () => new Map([
        ["000506.SZ", { latest: 4.2, preClose: 4.0, open: 4.05, high: 4.2, low: 4.0, volume: 10000, amount: 4100000, quoteAt: "2026-06-15T14:00:00+08:00" }],
        ["301999.SZ", { latest: 45.0, preClose: 25.0, open: 40.0, high: 48.0, low: 39.0, volume: 50000, amount: 220000000, quoteAt: "2026-06-15T14:00:00+08:00" }]
      ])
    }
  });

  const stQuote = await quoteSource.quote({ code: "000506", name: "000506", secid: "0.000506" });
  assert.equal(stQuote.name, "*ST中润");
  assert.equal(stQuote.limitUp, 4.2); // 5% ST limit prior to 2026-07-06

  const ipoQuote = await quoteSource.quote({ code: "301999", name: "301999", secid: "0.301999" });
  assert.equal(ipoQuote.name, "N新股");
  assert.equal(ipoQuote.limitUp, null); // No price limit on N-prefix IPO

  quoteSource.shutdown("test done");
});

test("ai-notes supports BSE 43xxxx, rejects B-share 900xxx, and refuses greedy fuzzy match on ordinary notes", async () => {
  assert.equal(sanitizeNoteParse({ text: "观察诺思兰德", code: "430047" }).code, "430047");
  assert.equal(sanitizeNoteParse({ text: "观察B股", code: "900901" }).code, null);

  const parser = createNoteParser({
    ai: {
      model: () => "mock",
      chat: async () => ({ text: "明天下午检查软件设置", code: null, stockName: null })
    },
    resolveStock: async query => (query.includes("软件") ? [{ code: "600536", name: "中国软件" }] : [])
  });
  const ordinary = await parser.parseNote({ text: "明天下午检查软件设置", now: "2026-11-18 18:00" });
  assert.equal(ordinary.code, null);
});

test("security-policy isExpectedRendererEntry normalizes Windows lowercase file:// drive letters", () => {
  assert.equal(
    isExpectedRendererEntry("file:///C:/App/resources/app.asar/dist/index.html", "file:///c:/App/resources/app.asar/dist/index.html"),
    true
  );
  assert.equal(
    isExpectedRendererEntry("file:///C:/App/resources/app.asar/dist/other.html", "file:///c:/App/resources/app.asar/dist/index.html"),
    false
  );
});

test("tightenUserDataPermissions creates missing first-run userData at 0o700 and never follows symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "astock-perm-audit-"));
  const outsideFile = path.join(root, "outside.txt");
  fs.writeFileSync(outsideFile, "secret", { mode: 0o644 });
  const freshUserData = path.join(root, "fresh-profile");
  try {
    tightenUserDataPermissions(freshUserData);
    assert.equal(fs.existsSync(freshUserData), true);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(freshUserData).mode & 0o777, 0o700);
      const symlinkPath = path.join(freshUserData, "evil.json");
      fs.symlinkSync(outsideFile, symlinkPath);
      tightenUserDataPermissions(freshUserData);
      assert.equal(fs.statSync(outsideFile).mode & 0o777, 0o644);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("strategy-selection-service keeps active=false after late worker unwinds on cancelled scan", async () => {
  let cancelled = false;

  const service = createStrategySelectionService({
    now: () => new Date("2026-11-18T16:00:00+08:00"),
    assertActive: () => {
      if (cancelled) {
        const err = new Error("scan cancelled");
        err.name = "AbortError";
        throw err;
      }
    },
    loadUniverse: async () => ({
      rows: [
        { code: "600519", name: "贵州茅台", secid: "1.600519", closeSnapshot: {} },
        { code: "000001", name: "平安银行", secid: "0.000001", closeSnapshot: {} }
      ],
      boards: [{ label: "沪市主板", expected: 2, loaded: 2, complete: true }]
    }),
    loadHistory: async sec => {
      if (sec.code === "600519") {
        cancelled = true;
        throw new Error("abort first");
      }
      await new Promise(resolve => setTimeout(resolve, 25));
      return [];
    },
    runEngine: async () => ({ mode: "selection", strategies: [], dataQuality: { processed: 0 } })
  });

  await assert.rejects(() => service.load());
  assert.equal(getStrategyScanProgress().active, false);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(getStrategyScanProgress().active, false);
});

test("humanizeSourceError prioritizes timeout over numeric counts containing 403 or 429", () => {
  assert.match(humanizeSourceError("读取 403/500 条日线 timeout"), /超时/);
  assert.match(humanizeSourceError("HTTP 429 Too Many Requests"), /频率|限制|备用/);
});
