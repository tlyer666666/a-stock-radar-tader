"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { registerMarketIpc } = require("./ipc/market.ipc.cjs");
const { registerNewsReviewIpc } = require("./ipc/news-review.ipc.cjs");
const { validateIpcPayload } = require("./ipc/contract.cjs");
const { prefilterTrendStock } = require("./trend-screener-engine.cjs");
const { createTrendMarketData } = require("./trend-screener-adapter.cjs");
const { withDerivedFields } = require("./ths-free-market.cjs");
const { mergeForRestore, createBackupService } = require("./data-backup.cjs");
const { normalizeEastAnnouncement, dedupeItems } = require("./news-service.cjs");
const { createConvertibleSource, normalizeBondQuote } = require("./ths-convertible.cjs");
const { createBeijingSectorSource } = require("./ths-beijing.cjs");
const { tencentQuote } = require("./data-federation.cjs");
const { fees, DEFAULT_COSTS } = require("./backtest-costs.cjs");

function buildTradingDates(count = 260) {
  const dates = [];
  let cursor = Date.parse("2025-01-02T00:00:00Z");
  while (dates.length < count) {
    const day = new Date(cursor).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86400000;
  }
  return dates;
}

test("R3-IPC: market:analyze and review-window:analyze preserve forceRefresh and externalFactorSnapshots", async () => {
  const handlers = new Map();
  const calls = [];
  const snapshots = { "2026-11-17": { phase: "主升" } };
  // Simulate main.cjs settingsForService whitelist stripping unknown keys like forceRefresh
  const settingsForService = () => ({ provider: "eastmoney", fallbackEnabled: true });
  const handleTrustedIpc = (channel, fn) => handlers.set(channel, fn);

  registerMarketIpc({
    handleTrustedIpc,
    serviceRequestRuntime: () => ({}),
    settingsForService,
    readExternalFactorStore: () => ({ snapshots }),
    searchSecurities: async () => [],
    analyzeSecurity: async (sec, opts) => { calls.push({ channel: "market", sec, opts }); return { ok: true }; },
    getQuoteSnapshot: async () => ({}),
    getMarketSourceHealth: () => ({}),
    getConvertibleBonds: async () => ({}),
    getFuyaoReviewData: async () => ({}),
    getDataFederation: async () => ({}),
    getChart: async () => ({}),
    discoverLimitUps: async () => [],
    discoverRecentLimitUps: async () => [],
    getPreviousLimitUpFailedBoardSnapshot: async () => ({}),
    thsWebView: () => ({ show() {}, setBounds() {}, hide() {}, command() {}, state() { return {}; } })
  });

  const recorded = [];
  registerNewsReviewIpc({
    handleTrustedIpc,
    aiPayload: (v) => v || {},
    readJson: () => [],
    normalizeHoldings: (v) => v,
    normalizeWatchlist: (v) => v,
    usableHoldings: () => true,
    usableWatchlist: () => true,
    settingsForService,
    getSectorStrengthBoard: async () => [],
    getNewsFeed: async () => ({ items: [] }),
    resetNewsCache: () => {},
    buildNewsImpactPromptInput: () => ({}),
    aiService: () => ({}),
    getProfessionalReview: async (opts) => ({ date: "2026-11-18", refreshed: opts?.refresh === true }),
    readExternalFactorStore: () => ({ snapshots }),
    recordExternalFactorSnapshot: (entry) => recorded.push(entry),
    reviewWindows: { open: () => {}, getWebContents: () => null },
    searchSecurities: async () => [],
    analyzeSecurity: async (sec, opts) => { calls.push({ channel: "review", sec, opts }); return { ok: true }; },
    getThemeMode: () => "dark"
  });

  validateIpcPayload("review-window:analyze", [{ code: "600519" }, { forceRefresh: true }]);
  await handlers.get("market:analyze")({}, { code: "600519" }, { forceRefresh: true });
  await handlers.get("review-window:analyze")({}, { code: "600519" }, { forceRefresh: true });
  await handlers.get("review-window:market")({}, { refresh: true });

  assert.equal(calls[0].opts.forceRefresh, true);
  assert.deepEqual(calls[0].opts.externalFactorSnapshots, snapshots);
  assert.equal(calls[1].opts.forceRefresh, true);
  assert.deepEqual(calls[1].opts.externalFactorSnapshots, snapshots);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].review.refreshed, true);
});

test("R3-02 & R3-03: trend-screener adapter omits absent THS changePct and preserves missing raw basis against split fabrication", async () => {
  const dates = buildTradingDates(255);
  const benchmarkRows = dates.slice(-85).map((date) => ({ date, open: 100, high: 101, low: 99, close: 100 }));

  // THS unadjusted history (preserveMissingBasis=true) omits changePct on IPO bar 0 and historical bars; adapter must keep it omitted, not coerce to null
  const thsFetched = withDerivedFields(
    dates.map((date, idx) => {
      const isLimit = idx === dates.length - 1;
      const close = isLimit ? 11 : 10;
      return {
        date,
        open: close,
        high: close,
        low: isLimit ? 10.8 : 9.9,
        close,
        volume: 50000,
        amount: 300_000_000,
        ...(isLimit ? { preClose: 10, changePct: 10 } : {})
      };
    }),
    { preserveMissingBasis: true }
  );
  const adapter = createTrendMarketData({
    historyBars: 255,
    ths: {
      quote: async () => null,
      history: async () => thsFetched
    }
  });
  const adapted = await adapter.fetchHistory({ code: "600519", name: "贵州茅台", secid: "1.600519" }, "none");
  assert.equal(Object.hasOwn(adapted.rows[0], "changePct"), false, "adapter must not turn omitted THS changePct into null");
  const prefilter = prefilterTrendStock(
    { security: { code: "600519", name: "贵州茅台", secid: "1.600519" }, rawRows: adapted.rows, benchmarkRows, asOf: dates.at(-1) },
    { requireLimit: true }
  );
  assert.equal(prefilter, null, "omitted changePct on THS IPO/historical bars passes validRow cleanly");

  // Unadjusted THS derivation with preserveMissingBasis=true must NOT fabricate preClose on split bars
  const splitBars = withDerivedFields(
    [
      { date: "2026-10-19", open: 20, high: 20.5, low: 19.8, close: 20, volume: 1000, amount: 2e7 },
      { date: "2026-10-20", open: 10, high: 10.4, low: 9.9, close: 10.2, volume: 2000, amount: 2e7 },
      { date: "2026-10-21", open: 10.2, high: 10.5, low: 10.1, close: 10.4, preClose: 10.2, changePct: 1.96, volume: 2000, amount: 2e7 }
    ],
    { preserveMissingBasis: true }
  );
  assert.equal(Object.hasOwn(splitBars[1], "preClose"), false);
  assert.equal(Object.hasOwn(splitBars[1], "changePct"), false);
  assert.equal(splitBars[2].preClose, 10.2);

  // If historical bars omit preClose/changePct and ONLY the final bar has preClose, rawBasisChanged must return true (fall through to qfq)
  const fallingSplit = dates.map((date, idx) => {
    const close = idx < 220 ? 20 : 9.5;
    return {
      date,
      open: close,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 50000,
      amount: 300_000_000,
      ...(idx === dates.length - 1 ? { preClose: 9.5, changePct: 0 } : {})
    };
  });
  assert.equal(
    prefilterTrendStock(
      { security: { code: "600519", name: "贵州茅台", secid: "1.600519" }, rawRows: fallingSplit, benchmarkRows, asOf: dates.at(-1) },
      { requireLimit: false }
    ),
    null,
    "single-bar basis evidence must not certify 60 unverified historical bars as split-free"
  );
});

test("R3-Backup: cross-machine same-origin AI key preservation & absent store cleanup on restore", async () => {
  const merged = mergeForRestore(
    "ai-profiles",
    {
      activeId: "remote-uuid",
      profiles: [{ id: "remote-uuid", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" }]
    },
    {
      activeId: "local-uuid",
      profiles: [{ id: "local-uuid", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1/chat", model: "deepseek-chat", apiKey: "enc-local-key" }]
    }
  );
  assert.equal(merged.profiles[0].apiKey, "enc-local-key");

  // Absent non-credential store in backup is removed when restoring onto a dirty state
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-r3-backup-"));
  try {
    const diskStores = new Map([["watchlist", [{ code: "600519", name: "贵州茅台", secid: "1.600519" }]]]);
    let cfg = { folder: tmpDir, auto: false, keep: 5, lastBackupAt: "", lastError: "", password: "" };
    const svc = createBackupService({
      readConfig: () => cfg,
      writeConfig: (next) => { cfg = next; },
      readStore: (name) => (diskStores.has(name) ? diskStores.get(name) : null),
      writeStore: (name, val) => diskStores.set(name, val),
      removeStore: (name) => diskStores.delete(name),
      validateStore: () => true,
      encryptSecret: (s) => s,
      decryptSecret: (s) => s,
      appVersion: "1.6.71"
    });
    const created = await svc.run({ local: {} });
    // Post-backup: user adds holdings that did not exist at backup time
    diskStores.set("holdings", [{ code: "000001", name: "平安银行", shares: 100, costPrice: 11 }]);
    await svc.restore(created.name);
    assert.equal(diskStores.has("holdings"), false, "post-backup holdings must be removed on restore");
    assert.equal(diskStores.has("watchlist"), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("R3-News: parseTime interprets date-only and timezone-less strings in Asia/Shanghai (+08:00)", () => {
  const ann = normalizeEastAnnouncement({
    art_code: "AN1",
    title: "测试年度分红公告",
    notice_date: "2020-05-10",
    codes: [{ stock_code: "600519", short_name: "贵州茅台", market_code: "1" }]
  });
  assert.equal(ann.isOld, true);
  const deduped = dedupeItems([
    { id: "cls-1", dedupeKey: "same", title: "重大业绩快讯", publishedAt: "2026-11-18T00:10:00.000Z", sourceLevel: "B", importanceScore: 70 },
    { id: "em-1", dedupeKey: "same", title: "重大业绩快讯", publishedAt: "2026-11-18 08:15:00", sourceLevel: "B", importanceScore: 70 }
  ]);
  assert.equal(deduped.length, 1);
  // 08:15+08:00 (00:15Z) is NEWER than 00:10Z (08:10+08:00), and dedupeItems sorts newest first
  assert.equal(deduped[0].id, "em-1");
});

test("R3-Connectors: ths-convertible and ths-beijing honor forceRefresh during pending and isolate caller aborts", async () => {
  const fixedNow = Date.parse("2026-10-23T02:00:00Z");
  let bondBuilds = 0;
  const bondSource = createConvertibleSource({
    now: () => fixedNow,
    store: { read: () => ({ discoveredAt: new Date(fixedNow).toISOString(), bonds: [] }), write: () => {} },
    readFeed: async () => {
      bondBuilds += 1;
      await new Promise((r) => setTimeout(r, 25));
      return {
        list: [{ bond_code: "123288", bond_name: "隆新转债", code: "301149", name: "隆华新材料", market_id: 35, stock_market_id: 33, sub_date: "2026-09-29", listing_date: "2026-10-19", expire_date: "2032-09-29" }]
      };
    },
    readQuote: async (_market, code) => normalizeBondQuote(code, {
      items: {
        5: code, 10: String(120 + bondBuilds), 6: "120", 7: "120", 8: "125", 9: "119", 13: "1000",
        19: "120000", 199112: "1.0", 264648: "1.0", 1968584: "2.0", 526792: "1.5", 69: "144", 70: "96",
        name: "隆新转债", updateTime: "2026-10-22 15:00", time: "2026-10-23 10:00:00 北京时间"
      }
    })
  });

  const abort1 = new AbortController();
  const p1 = bondSource.load({ signal: abort1.signal });
  const p2 = bondSource.load();
  abort1.abort(new DOMException("caller1 cancelled", "AbortError"));
  await assert.rejects(p1, /caller1 cancelled|Abort/);
  const res2 = await p2;
  assert.equal(res2.members[0].latest, 121, "caller 2 must complete despite caller 1 aborting");

  // Concurrent forceRefresh calls coalesce into one fresh build instead of running duplicate flights
  const p3 = bondSource.load({ forceRefresh: true });
  const p4 = bondSource.load({ forceRefresh: true });
  const [, res4] = await Promise.all([p3, p4]);
  assert.equal(bondBuilds, 2, "concurrent forceRefresh calls coalesce into one fresh build");
  assert.equal(res4.members[0].latest, 122);

  let bjBuilds = 0;
  const bjSource = createBeijingSectorSource({
    readUniverse: async () => {
      bjBuilds += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { complete: true, total: 1, members: [{ code: "920001", name: "测试北交", symbol: "bj920001" }] };
    },
    readQuote: async () => ({ code: "920001", name: "测试北交", latest: 10 + bjBuilds, preClose: 10, open: 10, high: 11, low: 9.8, volume: 500, amount: 500000, changePct: 2, quoteStatus: "ready", quoteAsOf: "2026-11-18 15:00" })
  });
  const bjAbort = new AbortController();
  const bj1 = bjSource.load({ signal: bjAbort.signal });
  const bj2 = bjSource.load();
  bjAbort.abort(new DOMException("bj caller1 cancelled", "AbortError"));
  await assert.rejects(bj1);
  const bjRes = await bj2;
  assert.equal(bjRes.members[0].latest, 11);
});

test("R3-Federation & Costs: tencentQuote infers SH/BJ from secid/code without thscode, and roundMoney handles half-cents", async (t) => {
  const originalFetch = global.fetch;
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    return {
      ok: true,
      arrayBuffer: async () => Buffer.from('v_sh000001="1~上证指数~000001~3300.00~3290.00~3295.00~100000~0~0~~~~~~~~~~~~~~~~~~~~~~20261118150000~~10.00~0.30~3310.00~3285.00~~100000~50000000~0.5~~~~~~~~~";', "utf8")
    };
  };
  t.after(() => { global.fetch = originalFetch; });

  await tencentQuote({ code: "000001", name: "上证指数", secid: "1.000001" });
  assert.match(requestedUrls[0], /q=sh000001$/, "Shanghai Composite secid 1.000001 without thscode must query sh000001, not sz000001");

  const f = fees(38214.2857, "buy", { ...DEFAULT_COSTS, commissionBps: 7, minCommission: 5 });
  assert.equal(f.commission, 26.75, "26.75 half-cent boundary rounds consistently with trend-research-account");
});
