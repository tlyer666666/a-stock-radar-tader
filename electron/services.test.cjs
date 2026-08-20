const test = require("node:test");
const assert = require("node:assert/strict");
const {
  priceLimitRate,
  isRiskStockName,
  toSecurity,
  searchSecurities,
  analyzeSecurity,
  getQuoteSnapshot,
  getChart,
  conceptRootName,
  extractThsConceptRows,
  extractThsSectorMembers,
  parseSinaSectorCatalog,
  matchSinaSector,
  normalizeSinaSectorMembers,
  buildSectorStrengthFromData,
  SECTOR_PROVIDER_PRIORITY,
  buildFreeConceptGroups,
  buildSectorBreadthDiagnostics,
  eastPriceFromRaw,
  normalizeEastQuote,
  normalizeTencentQuote,
  publicQuoteWithFallback,
  dataByProvider,
  thsStockAnnouncements,
  eastStockAnnouncements,
  loadStockAnnouncements,
  resetStockAnnouncementCache,
  applyStockAnnouncementEvidence,
  isConvertibleBondCode,
  assetTypeFromExactCode,
  searchableAssetType,
  normalizeSearchSecurity,
  resolveBacktestSecurity,
  analyzeHistory,
  buildTradeExecutionReadiness,
  strategyDefinitionsFor,
  validateHistoryRows,
  withSingleFlightCache,
  selectLimitUpTradingDates,
  normalizeThsLimitUpItem,
  extractThsTable,
  normalizeThsHistoryTable,
  discoverLimitUps,
  currentLadderPools,
  buildSequentialSamplePath,
  buildSingleStockTradeLedger,
  singleStockBenchmarkReturns,
  singleStockBacktestLookbackBars,
  normalizeSingleBacktestDate,
  loadBacktestHistory,
  getStrategyDefinitions,
  curlExecutable,
  serviceRequestPolicy,
  serviceFetchJson,
  runPortfolioBacktest,
  runBacktest,
  mergeBacktestSettings,
  safeBacktestStrategyProfile
} = require("./services.cjs");

const recentDate = (offset = 0) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

const shanghaiDate = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

const compactDate = (date = shanghaiDate()) => String(date).replaceAll("-", "");

const mockRecentSinaHistory = (length = 24) => {
  const end = new Date(`${shanghaiDate()}T00:00:00Z`);
  return Array.from({ length }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (length - 1 - index));
    return {
      day: date.toISOString().slice(0, 10),
      open: "10",
      close: "10.1",
      high: "10.2",
      low: "9.9",
      volume: "100000"
    };
  });
};

const mockRecentEastHistory = (length = 24) => mockRecentSinaHistory(length).map((row) => [
  row.day,
  row.open,
  row.close,
  row.high,
  row.low,
  row.volume,
  "1010000",
  "3",
  "1",
  "0.1",
  "1.2"
].join(","));

const mockJsonResponse = (value) => ({
  ok: true,
  json: async () => value
});

test("curl fallback resolves the native executable for each desktop platform", () => {
  assert.equal(curlExecutable("win32"), "curl.exe");
  assert.equal(curlExecutable("darwin"), "curl");
  assert.equal(curlExecutable("linux"), "curl");
});

test("single-stock benchmark windows use close-to-close returns", () => {
  const history = [100, 110, 120, 130, 140, 150].map((close, index) => ({
    date: `2026-08-${String(index + 1).padStart(2, "0")}`,
    open: 10 + index,
    close
  }));
  const result = singleStockBenchmarkReturns(history, 5);

  assert.equal(result.r1, (150 / 140 - 1) * 100);
  assert.equal(result.r3, 25);
  assert.equal(result.r5, 50);
  assert.equal(result.spanBars, 5);
});

test("service JSON transport applies shared origin policy and retry classification", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let attempts = 0;
  global.fetch = async (_url, options) => {
    attempts += 1;
    assert.equal(options.headers.Accept, "application/json, text/plain, */*");
    assert.equal(options.headers["User-Agent"], "AStockRadar/0.9");
    if (attempts === 1) {
      return {
        ok: false,
        status: 429,
        headers: { get: (name) => name === "retry-after" ? "0" : null }
      };
    }
    return mockJsonResponse({ ok: true });
  };

  assert.deepEqual(
    await serviceFetchJson("https://quantapi.51ifind.com/api/v1/ping", {}, 1000),
    { ok: true }
  );
  assert.equal(attempts, 2);
  assert.equal(
    serviceRequestPolicy("https://quantapi.51ifind.com/api/v1/ping").minimumGapMs,
    250
  );
  assert.equal(
    serviceRequestPolicy("https://push2.eastmoney.com/api/qt/stock/get").minimumGapMs,
    120
  );

  attempts = 0;
  global.fetch = async () => {
    attempts += 1;
    return { ok: false, status: 400, headers: { get: () => null } };
  };
  await assert.rejects(
    serviceFetchJson("https://example.test/permanent", {}, 1000),
    /HTTP 400/
  );
  assert.equal(attempts, 1);
});

test("invalid Eastmoney key prices trigger the Tencent quote relay", async () => {
  const security = toSecurity("600519");
  const invalidPayload = {
    data: {
      f43: 0,
      f44: 1250,
      f45: 1200,
      f46: 1210,
      f57: "600519",
      f58: "贵州茅台",
      f59: 2,
      f60: 1220
    }
  };
  assert.throws(
    () => normalizeEastQuote(security, invalidPayload),
    /有效最新价/
  );
  assert.throws(
    () => normalizeEastQuote(security, {
      data: { ...invalidPayload.data, f43: 1234, f60: 0 }
    }),
    /有效昨收价/
  );

  let tencentCalls = 0;
  const result = await publicQuoteWithFallback(security, 1000, {
    eastmoney: async () => normalizeEastQuote(security, invalidPayload),
    tencent: async () => {
      tencentCalls += 1;
      return {
        securityCode: "600519",
        securityName: "贵州茅台",
        latest: 12.34,
        preClose: 12.2,
        open: 12.1,
        high: 12.5,
        low: 12
      };
    }
  });
  assert.equal(tencentCalls, 1);
  assert.equal(result.actualProvider, "tencent");
  assert.equal(result.quote.latest, 12.34);
  assert.match(result.warning, /腾讯公开行情/);
});

test("THS quote remains primary when only THS history needs Eastmoney fallback", async () => {
  const security = toSecurity("600519");
  const fallbackHistory = [{
    date: "2026-08-19",
    open: 12,
    high: 12.5,
    low: 11.9,
    close: 12.4,
    volume: 1000
  }];
  const result = await dataByProvider(
    security,
    { provider: "ths", refreshToken: "configured", fallbackEnabled: true },
    {
      thsQuote: async () => ({
        code: "600519",
        name: "THS名称",
        latest: 12.34,
        source: "ths"
      }),
      thsHistory: async () => {
        throw new Error("history rate limited");
      },
      publicQuote: async () => ({
        quote: {
          name: "贵州茅台",
          industry: "白酒",
          secid: "1.600519",
          limitUp: 13.42,
          limitDown: 10.98
        },
        actualProvider: "eastmoney",
        warning: ""
      }),
      eastHistory: async () => fallbackHistory
    }
  );

  assert.equal(result.actualProvider, "ths");
  assert.equal(result.quote.latest, 12.34);
  assert.equal(result.quote.name, "贵州茅台");
  assert.equal(result.history, fallbackHistory);
  assert.equal(result.historyProvider, "eastmoney");
  assert.equal(result.primaryStatus, "partial");
  assert.match(result.warning, /同花顺历史行情连接失败/);
});

test("THS stock announcement query follows the official per-code report contract", async () => {
  const security = toSecurity("600519");
  let requestUrl = "";
  let requestOptions = null;
  const rows = await thsStockAnnouncements(
    security,
    { refreshToken: "configured" },
    {
      withToken: async (refreshToken, request) => {
        assert.equal(refreshToken, "configured");
        return request("access-token");
      },
      fetchJson: async (url, options) => {
        requestUrl = String(url);
        requestOptions = options;
        return {
          errorcode: 0,
          tables: [{
            thscode: "600519.SH",
            table: {
              reportTitle: ["贵州茅台收到证监会立案告知书并提示退市风险"],
              seq: ["ann-1"],
              ctime: ["2026-08-19 10:00:00"],
              reportDate: ["2026-08-19"],
              secName: ["贵州茅台"],
              pdfURL: ["https://www.sse.com.cn/disclosure/ann-1.pdf"]
            }
          }]
        };
      }
    }
  );

  const payload = JSON.parse(requestOptions.body);
  assert.match(requestUrl, /quantapi\.51ifind\.com\/api\/v1\/report_query$/);
  assert.equal(requestOptions.headers.access_token, "access-token");
  assert.equal(payload.codes, "600519.SH");
  assert.equal(payload.functionpara.reportType, "901");
  assert.match(payload.beginrDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(payload.endrDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].art_code, "ann-1");
  assert.equal(rows[0].transportProvider, "同花顺 QuantAPI");
  assert.equal(rows[0].impactScore, rows[0].importanceScore);
  assert.equal(rows[0].riskSeverity, 3);
});

test("Eastmoney announcement pagination marks an incomplete 120-day risk window", async () => {
  let calls = 0;
  const rows = await eastStockAnnouncements("600519", {
    fetchJson: async (url) => {
      calls += 1;
      const page = Number(new URL(String(url)).searchParams.get("page_index"));
      return {
        data: {
          list: Array.from({ length: 50 }, (_, index) => ({
            art_code: `page-${page}-ann-${index}`,
            title: `分页公告 ${page}-${index}`,
            display_time: `${shanghaiDate()} 10:00:00`,
            codes: [{ stock_code: "600519", short_name: "贵州茅台", market_code: "1" }],
            columns: [{ column_name: "公司公告" }]
          }))
        }
      };
    }
  });

  assert.equal(calls, 5);
  assert.equal(rows.length, 250);
  assert.equal(rows.coverageTruncated, true);
  assert.ok(rows.every((item) => item.id && item.sourceUrl && item.publishedAt));
});

test("stock announcements use THS first, then Eastmoney, and expose unknown dual-source failure", async (t) => {
  resetStockAnnouncementCache();
  t.after(resetStockAnnouncementCache);
  const security = toSecurity("600519");
  let eastmoneyCalls = 0;
  const primary = await loadStockAnnouncements(
    security,
    { refreshToken: "configured", fallbackEnabled: true, forceRefresh: true },
    {
      ths: async () => [{ title: "同花顺公告" }],
      eastmoney: async () => {
        eastmoneyCalls += 1;
        return [{ title: "东方财富公告" }];
      }
    }
  );
  assert.equal(primary.items[0].title, "同花顺公告");
  assert.equal(primary.dataQuality.actualProvider, "ths");
  assert.equal(primary.dataQuality.riskKnown, true);
  assert.equal(eastmoneyCalls, 0);

  const emptyPrimary = await loadStockAnnouncements(
    security,
    { refreshToken: "configured", fallbackEnabled: true, forceRefresh: true },
    {
      ths: async () => [],
      eastmoney: async () => { throw new Error("must remain on THS"); }
    }
  );
  assert.deepEqual(emptyPrimary.items, []);
  assert.equal(emptyPrimary.dataQuality.status, "active");
  assert.equal(emptyPrimary.dataQuality.riskKnown, true);

  const fallback = await loadStockAnnouncements(
    security,
    { refreshToken: "configured", fallbackEnabled: true, forceRefresh: true },
    {
      ths: async () => { throw new Error("THS rate limited"); },
      eastmoney: async () => [{ title: "东方财富公告" }]
    }
  );
  assert.equal(fallback.items[0].title, "东方财富公告");
  assert.equal(fallback.dataQuality.status, "fallback");
  assert.equal(fallback.dataQuality.actualProvider, "eastmoney");
  assert.equal(fallback.dataQuality.fallbackUsed, true);
  assert.equal(fallback.dataQuality.riskKnown, true);
  assert.match(fallback.warning, /东方财富公告次源接力/);

  const cappedRows = Array.from({ length: 250 }, (_, index) => ({
    title: `分页公告${index + 1}`
  }));
  Object.defineProperty(cappedRows, "coverageTruncated", {
    value: true,
    enumerable: false
  });
  const partialCoverage = await loadStockAnnouncements(
    security,
    { refreshToken: "configured", fallbackEnabled: true, forceRefresh: true },
    {
      ths: async () => { throw new Error("THS unavailable"); },
      eastmoney: async () => cappedRows
    }
  );
  assert.equal(partialCoverage.dataQuality.status, "partial");
  assert.equal(partialCoverage.dataQuality.complete, false);
  assert.equal(partialCoverage.dataQuality.riskKnown, false);
  assert.equal(partialCoverage.dataQuality.truncated, true);
  assert.match(partialCoverage.warning, /120日风险覆盖不完整/);

  let disabledFallbackCalls = 0;
  const missingTokenError = new Error("同花顺公告主源未配置 Refresh Token");
  missingTokenError.code = "THS_ANNOUNCEMENT_TOKEN_MISSING";
  const strictUnknown = await loadStockAnnouncements(
    security,
    { refreshToken: "", fallbackEnabled: false, forceRefresh: true },
    {
      ths: async () => { throw missingTokenError; },
      eastmoney: async () => {
        disabledFallbackCalls += 1;
        return [];
      }
    }
  );
  assert.equal(disabledFallbackCalls, 0);
  assert.equal(strictUnknown.dataQuality.status, "unknown");
  assert.equal(strictUnknown.dataQuality.primaryStatus, "missing_token");
  assert.equal(strictUnknown.dataQuality.riskKnown, false);
  assert.match(strictUnknown.warning, /备用公告源已关闭/);

  const unknown = await loadStockAnnouncements(
    security,
    { refreshToken: "configured", fallbackEnabled: true, forceRefresh: true },
    {
      ths: async () => { throw new Error("THS unavailable"); },
      eastmoney: async () => { throw new Error("Eastmoney unavailable"); }
    }
  );
  assert.deepEqual(unknown.items, []);
  assert.equal(unknown.dataQuality.status, "unknown");
  assert.equal(unknown.dataQuality.complete, false);
  assert.equal(unknown.dataQuality.riskKnown, false);
  assert.equal(unknown.dataQuality.sources.every((source) => source.ok === false), true);
  assert.match(unknown.warning, /公告风险状态未知/);

  const knownEvidence = applyStockAnnouncementEvidence(
    { riskPenalty: 5, risks: [] },
    [],
    fallback.dataQuality
  );
  assert.equal(knownEvidence.infoScore, 50);
  assert.equal(knownEvidence.infoRiskSeverity, 0);
  assert.equal(knownEvidence.riskPenalty, 5);

  const ninthRisk = applyStockAnnouncementEvidence(
    { riskPenalty: 0, risks: [] },
    [
      ...Array.from({ length: 8 }, (_, index) => ({
        title: `普通公告${index + 1}`,
        direction: "neutral",
        riskSeverity: 0
      })),
      {
        title: "收到证监会立案告知书",
        direction: "negative",
        impactScore: 95,
        riskSeverity: 3
      }
    ],
    fallback.dataQuality
  );
  assert.equal(ninthRisk.infoRiskSeverity, 3);
  assert.equal(ninthRisk.infoRiskPenalty, 25);
  assert.match(ninthRisk.risks[0], /证监会立案告知书/);

  const unknownEvidence = applyStockAnnouncementEvidence(
    { riskPenalty: 5, risks: [] },
    [],
    unknown.dataQuality
  );
  assert.equal(unknownEvidence.infoScore, 0);
  assert.equal(unknownEvidence.infoRiskSeverity, null);
  assert.equal(unknownEvidence.infoRiskPenalty, 15);
  assert.equal(unknownEvidence.riskPenalty, 20);
  assert.match(unknownEvidence.risks[0], /公告风险状态未知/);

  const definitions = strategyDefinitionsFor({
    announcementRiskKnown: unknown.dataQuality.riskKnown,
    infoScore: 50,
    infoRiskSeverity: 0,
    limitEvent: null,
    heldSupport: true,
    avwap: 0,
    maBull: true,
    slopesUp: true,
    trendLabel: "多头排列",
    volumeRatio: 0.8,
    relativeTurnover: 1,
    divergence: 0,
    closePosition: 0.8,
    stockReturn3: 1,
    sectorScore: 70,
    rsSector: 1,
    maxDrawdown: 3,
    eventCount60: 0,
    preLimitReturn20: 0,
    isLowFirstBoard: false,
    platformHigh: 0,
    platformRange: 0,
    sectorLadderScore: 0,
    marketEmotion: null
  }, { latest: 10 });
  const information = definitions.find((item) => item.id === "information");
  const riskVeto = definitions.find((item) => item.id === "riskVeto");
  assert.equal(information.matched, false);
  assert.match(information.detail, /风险状态未知/);
  assert.equal(riskVeto.matched, false);
  assert.match(riskVeto.detail, /公告风险数据不可用/);
});

test("stock announcement cache deduplicates requests, honors TTL, and preserves force refresh", async (t) => {
  resetStockAnnouncementCache();
  t.after(resetStockAnnouncementCache);
  const security = toSecurity("600519");
  let nowMs = 1_000_000;
  let calls = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const loaders = {
    now: () => nowMs,
    ths: async () => {
      calls += 1;
      const callNumber = calls;
      if (callNumber === 1) await firstGate;
      return [{ title: `公告请求 ${callNumber}` }];
    },
    eastmoney: async () => {
      throw new Error("THS success must not use fallback");
    }
  };
  const settings = { refreshToken: "configured", fallbackEnabled: true };

  const firstRequest = loadStockAnnouncements(security, settings, loaders);
  const concurrentRequest = loadStockAnnouncements(security, settings, loaders);
  assert.equal(calls, 1);
  releaseFirst();
  const [first, concurrent] = await Promise.all([firstRequest, concurrentRequest]);
  assert.strictEqual(first, concurrent);
  assert.equal(calls, 1);

  nowMs += 44_999;
  const cached = await loadStockAnnouncements(security, settings, loaders);
  assert.strictEqual(cached, first);
  assert.equal(calls, 1);

  nowMs += 1;
  const expired = await loadStockAnnouncements(security, settings, loaders);
  assert.equal(expired.items[0].title, "公告请求 2");
  assert.equal(calls, 2);

  const forceSettings = { ...settings, forceRefresh: true };
  const [forced, forcedConcurrent] = await Promise.all([
    loadStockAnnouncements(security, forceSettings, loaders),
    loadStockAnnouncements(security, forceSettings, loaders)
  ]);
  assert.strictEqual(forced, forcedConcurrent);
  assert.equal(forced.items[0].title, "公告请求 3");
  assert.equal(calls, 3);

  const rotatedToken = await loadStockAnnouncements(
    security,
    { ...settings, refreshToken: "rotated-token" },
    loaders
  );
  assert.equal(rotatedToken.items[0].title, "公告请求 4");
  assert.equal(calls, 4);
});

test("stock announcement cache evicts the least recently used stock after 200 keys", async (t) => {
  resetStockAnnouncementCache();
  t.after(resetStockAnnouncementCache);
  let calls = 0;
  const loaders = {
    now: () => 2_000_000,
    ths: async () => {
      calls += 1;
      return [];
    }
  };
  const settings = { refreshToken: "configured", fallbackEnabled: true };
  const securities = Array.from({ length: 201 }, (_, index) => ({
    code: String(index).padStart(6, "0"),
    thscode: `${String(index).padStart(6, "0")}.SZ`
  }));
  for (const security of securities) {
    await loadStockAnnouncements(security, settings, loaders);
  }
  assert.equal(calls, 201);

  await loadStockAnnouncements(securities[0], settings, loaders);
  assert.equal(calls, 202);
});

test("single-stock backtest dates reject impossible calendar values", () => {
  assert.equal(normalizeSingleBacktestDate("2026-02-28"), "2026-02-28");
  assert.equal(normalizeSingleBacktestDate("2024-02-29"), "2024-02-29");
  assert.equal(normalizeSingleBacktestDate("2026-02-29"), "");
  assert.equal(normalizeSingleBacktestDate("2026-02-30"), "");
  assert.equal(normalizeSingleBacktestDate("2026-02-28junk"), "");
});

test("trade readiness uses its documented fill-rate fallback instead of a clamp boundary", () => {
  const result = buildTradeExecutionReadiness(
    { qualification: { riskVetoPassed: true }, riskPenalty: 0, mrs: 80 },
    { signal: "BUY", positionSizePercent: 10, riskReward: 2 },
    { minExecutionRatePercent: 90 }
  );

  assert.equal(result.status, "PASS");
  assert.equal(result.canExecute, true);
  assert.equal(result.reasons.some((reason) => reason.includes("预计成交率")), false);
});

test("history validation rejects malformed, duplicate and stale rows before strategy use", () => {
  const valid = validateHistoryRows([
    { date: recentDate(-2), open: 10, high: 10.5, low: 9.8, close: 10.2, volume: 100 },
    { date: recentDate(-1), open: 10.2, high: 10.8, low: 10.1, close: 10.6, volume: 200 },
    { date: recentDate(-1), open: 10.2, high: 10.8, low: 10.1, close: 10.6, volume: 200 },
    { date: recentDate(0), open: 10.6, high: 10.2, low: 10.5, close: 10.4, volume: 50 }
  ], { source: "test", minimumRows: 2 });
  assert.equal(valid.length, 2);
  assert.throws(() => validateHistoryRows([
    { date: "2020-01-02", open: 10, high: 11, low: 9, close: 10, volume: 10 }
  ], { source: "test" }), /stale/i);
  assert.throws(() => validateHistoryRows([
    { date: recentDate(0), open: 10, high: 9, low: 10, close: 10, volume: 10 }
  ], { source: "test" }), /usable rows/i);
});

test("public quote and chart entry points return their documented production contracts", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const chartRows = Array.from({ length: 140 }, (_, index) => {
    const date = new Date("2026-01-01T00:00:00Z");
    date.setUTCDate(date.getUTCDate() + index);
    const close = 10 + index / 100;
    return [
      date.toISOString().slice(0, 10),
      close - 0.05,
      close,
      close + 0.1,
      close - 0.1,
      100000 + index,
      1000000 + index,
      2,
      0.5,
      0.05,
      1.2
    ].join(",");
  });
  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("/stock/get?")) {
      return mockJsonResponse({
        data: {
          f43: 1234,
          f44: 1250,
          f45: 1200,
          f46: 1210,
          f47: 100000,
          f48: 123400000,
          f50: 110,
          f51: 1357,
          f52: 1111,
          f57: "600519",
          f58: "贵州茅台",
          f59: 2,
          f60: 1220,
          f116: 1000000000,
          f117: 800000000,
          f127: "白酒",
          f168: 250,
          f169: 14,
          f170: 115,
          f171: 410
        }
      });
    }
    if (requestUrl.includes("/stock/kline/get?")) {
      return mockJsonResponse({ data: { klines: chartRows } });
    }
    throw new Error(`unexpected test request: ${requestUrl}`);
  };

  const quote = await getQuoteSnapshot("600519", { provider: "eastmoney" });
  assert.equal(quote.actualProvider, "eastmoney");
  assert.equal(quote.primaryStatus, "active");
  assert.equal(quote.quote.code, "600519");
  assert.equal(quote.quote.latest, 12.34);
  assert.ok(Number.isFinite(Date.parse(quote.updatedAt)));

  const chart = await getChart("600518", "101", {
    range: "3m",
    limit: 20,
    adjustment: "front",
    forceRefresh: true
  });
  assert.ok(Array.isArray(chart.rows));
  assert.equal(chart.rows.length, 140);
  assert.equal(chart.interval, "101");
  assert.equal(chart.visibleLimit, 20);
  assert.equal(chart.dataSource, "eastmoney");
  assert.equal(chart.availableFrom, chart.rows[0].date);
  assert.equal(chart.availableTo, chart.rows.at(-1).date);
});

test("service entry points reject inconsistent identifiers before any network request", async () => {
  const invalid = { code: "600519", secid: "0.600519", thscode: "600519.SH" };
  await assert.rejects(getQuoteSnapshot(invalid), /Invalid secid/);
  await assert.rejects(getChart(invalid, "101"), /Invalid secid/);
  await assert.rejects(analyzeSecurity(invalid), /Invalid secid/);
});

test("THS official nested tables are unwrapped and truncated without date-price misalignment", () => {
  const table = extractThsTable({
    tables: [{
      thscode: "600000.SH",
      time: ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"],
      table: {
        open: [10, 11, 12, 13],
        high: [10.5, 11.5, 12.5, 13.5],
        low: [9.5, 10.5, 11.5, 12.5],
        close: [10.2, 11.2, 12.2, 13.2],
        volume: [100, 110, 120, 130],
        amount: [1000, 1100, 1200, 1300],
        changeRatio: [1, 2, 3, 4],
        turnoverRatio: [0.5, 0.6, 0.7, 0.8]
      }
    }]
  });
  assert.equal(table.thscode, "600000.SH");
  assert.deepEqual(table.open, [10, 11, 12, 13]);
  const rows = normalizeThsHistoryTable(table, 2);
  assert.deepEqual(rows.map((row) => row.date), ["2026-08-05", "2026-08-06"]);
  assert.deepEqual(rows.map((row) => row.open), [12, 13]);
  assert.deepEqual(rows.map((row) => row.close), [12.2, 13.2]);
});

test("market-wide loaders share a single in-flight request", async () => {
  const cache = { value: null, expiresAt: 0, promise: null };
  let calls = 0;
  const load = () => withSingleFlightCache(cache, 1000, async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value: 7 };
  });
  const rows = await Promise.all([load(), load(), load(), load()]);
  assert.equal(calls, 1);
  assert.deepEqual(rows, [{ value: 7 }, { value: 7 }, { value: 7 }, { value: 7 }]);
  assert.equal(cache.promise, null);
  assert.equal((await load()).value, 7);
  assert.equal(calls, 1);
});

test("forced single-flight refresh bypasses a fresh cached value", async () => {
  const cache = {
    value: { value: "old" },
    expiresAt: Date.now() + 60_000,
    promise: null
  };
  let calls = 0;
  const fresh = await withSingleFlightCache(cache, 1000, async () => {
    calls += 1;
    return { value: "fresh" };
  }, { forceRefresh: true });
  assert.equal(calls, 1);
  assert.equal(fresh.value, "fresh");
  assert.equal(cache.value.value, "fresh");
});

test("concurrent forced refreshes share one fresh request", async () => {
  const cache = { value: null, expiresAt: 0, promise: null };
  let calls = 0;
  const load = () => withSingleFlightCache(cache, 1000, async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value: "fresh" };
  }, { forceRefresh: true });
  const values = await Promise.all([load(), load(), load()]);
  assert.equal(calls, 1);
  assert.deepEqual(values, [
    { value: "fresh" },
    { value: "fresh" },
    { value: "fresh" }
  ]);
});

test("intraday limit-up dates prefer a server-confirmed today over yesterday daily bars", () => {
  const dates = selectLimitUpTradingDates(
    "2026-08-06",
    {
      date: "2026-08-06",
      serverTradingDate: "2026-08-06",
      pool: [{ code: "002180" }]
    },
    ["2026-08-05", "2026-08-04", "2026-08-03"],
    3
  );
  assert.deepEqual(dates, ["2026-08-06", "2026-08-05", "2026-08-04"]);
});

test("a confirmed trading day remains current when the valid limit-up pool is empty", () => {
  const dates = selectLimitUpTradingDates(
    "2026-08-06",
    {
      date: "2026-08-06",
      serverTradingDate: "2026-08-06",
      pool: []
    },
    ["2026-08-05", "2026-08-04"],
    2
  );
  assert.deepEqual(dates, ["2026-08-06", "2026-08-05"]);
});

test("a holiday candidate falls back to the latest server-confirmed trading date", () => {
  const dates = selectLimitUpTradingDates(
    "2026-08-08",
    {
      date: "2026-08-08",
      serverTradingDate: "2026-08-07",
      pool: []
    },
    ["2026-08-07", "2026-08-06", "2026-08-05"],
    2
  );
  assert.deepEqual(dates, ["2026-08-07", "2026-08-06"]);
});

test("THS normalization preserves missing fields as unknown and does not invent first-seal or industry data", () => {
  const lastSealEpoch = Math.floor(Date.parse("2026-08-06T09:31:15+08:00") / 1000);
  const row = normalizeThsLimitUpItem({
    code: "603221",
    name: "爱丽家居",
    latest: 24.79,
    change_rate: 9.9823,
    turnover_rate: 6.6058,
    order_volume: 2641531,
    last_limit_up_time: String(lastSealEpoch),
    reason_type: "复牌+拟收购欧康诺+存储测试+PVC地板",
    limit_up_type: "T字板",
    high_days: "",
    is_again_limit: 1
  }, "2026-08-06");

  assert.equal(row.amount, null);
  assert.equal(row.floatMarketCap, null);
  assert.equal(row.totalMarketCap, null);
  assert.equal(row.openBoardCount, null);
  assert.equal(row.consecutiveBoards, null);
  assert.equal(row.firstSealTime, "");
  assert.equal(row.firstSealRaw, null);
  assert.equal(row.lastSealTime, "09:31:15");
  assert.equal(row.industry, "未分类");
  assert.equal(row.limitReason, "复牌+拟收购欧康诺+存储测试+PVC地板");
  assert.equal(row.boardType, "T字板");
  assert.equal(row.sealFloatRatio, null);
  assert.equal(row.tradedFloatRatio, null);
});

test("THS primary pool is enriched from Eastmoney and retains Eastmoney-only Beijing stocks", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const today = shanghaiDate();
  const todayCompact = compactDate(today);
  const lastSealEpoch = Math.floor(Date.parse(`${today}T09:31:15+08:00`) / 1000);
  const thsRow = {
    code: "603221",
    name: "爱丽家居",
    latest: 24.79,
    change_rate: 9.9823,
    turnover_rate: 6.6058,
    order_volume: 2641531,
    last_limit_up_time: String(lastSealEpoch),
    reason_type: "复牌+拟收购欧康诺+存储测试+PVC地板",
    limit_up_type: "T字板",
    high_days: "10天10板",
    is_again_limit: 1
  };
  const eastRows = [
    {
      c: "603221", m: 1, n: "爱丽家居", p: 24790, zdp: 9.9823,
      amount: 396490928, ltsz: 6005873300, tshare: 6005873300,
      hs: 6.6058, lbc: 10, fbt: 92501, lbt: 93115,
      fund: 65483553, zbc: 1, hybk: "家居用品", zttj: { days: 21, ct: 11 }
    },
    {
      c: "920117", m: 0, n: "龙鑫智能", p: 18120, zdp: 29.989,
      amount: 128000000, ltsz: 1800000000, tshare: 2600000000,
      hs: 8.2, lbc: 1, fbt: 94500, lbt: 94500,
      fund: 21000000, zbc: 0, hybk: "专用设备", zttj: { days: 1, ct: 1 }
    }
  ];

  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("data.10jqka.com.cn/dataapi/limit_up/limit_up_pool")) {
      return mockJsonResponse({
        status_code: 0,
        data: { info: [thsRow], page: { total: 1 } }
      });
    }
    if (requestUrl.includes("push2ex.eastmoney.com/getTopicZTPool")) {
      return mockJsonResponse({
        data: { qdate: todayCompact, tc: eastRows.length, pool: eastRows }
      });
    }
    if (requestUrl.includes("quotes.sina.cn/")) {
      return mockJsonResponse({ result: { data: mockRecentSinaHistory() } });
    }
    throw new Error(`unexpected test request: ${requestUrl}`);
  };

  const snapshot = await discoverLimitUps({
    provider: "ths",
    fallbackEnabled: true,
    multiSourceEnabled: true,
    forceRefresh: true
  });
  const { rows, meta } = snapshot;
  const shared = rows.find((item) => item.code === "603221");
  const beijingOnly = rows.find((item) => item.code === "920117");

  assert.equal(rows.length, 2);
  assert.ok(shared);
  assert.equal(shared.industry, "家居用品");
  assert.equal(shared.amount, 396490928);
  assert.equal(shared.floatMarketCap, 6005873300);
  assert.equal(shared.totalMarketCap, 6005873300);
  assert.equal(shared.firstSealTime, "09:25:01");
  assert.equal(shared.openBoardCount, 1);
  assert.equal(shared.dataProvider, "ths_public_limit_up");
  assert.deepEqual(shared.verificationProviders, ["eastmoney_topic_pool"]);
  assert.ok(beijingOnly);
  assert.equal(beijingOnly.thscode, "920117.BJ");
  assert.equal(beijingOnly.dataProvider, "eastmoney_topic_pool");
  assert.equal(beijingOnly.primaryProviderMissing, true);
  assert.deepEqual(meta.providers, [
    "ths_public_limit_up",
    "eastmoney_topic_pool"
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).meta, meta);
});

test("a valid but empty THS response does not hide a non-empty Eastmoney pool", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const todayCompact = compactDate();
  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("data.10jqka.com.cn/dataapi/limit_up/limit_up_pool")) {
      return mockJsonResponse({
        status_code: 0,
        data: { info: [], page: { total: 0 } }
      });
    }
    if (requestUrl.includes("push2ex.eastmoney.com/getTopicZTPool")) {
      return mockJsonResponse({
        data: {
          qdate: todayCompact,
          tc: 1,
          pool: [{
            c: "600003", m: 1, n: "东财补位样本", p: 13200, zdp: 10,
            amount: 88000000, ltsz: 900000000, tshare: 1100000000,
            hs: 4, lbc: 1, fbt: 93200, lbt: 93200,
            fund: 9000000, zbc: 0, hybk: "机械设备", zttj: { days: 1, ct: 1 }
          }]
        }
      });
    }
    if (requestUrl.includes("quotes.sina.cn/")) {
      return mockJsonResponse({ result: { data: mockRecentSinaHistory() } });
    }
    throw new Error(`unexpected test request: ${requestUrl}`);
  };

  const snapshot = await discoverLimitUps({
    provider: "ths",
    fallbackEnabled: true,
    multiSourceEnabled: true,
    forceRefresh: true
  });
  const { rows, meta } = snapshot;

  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "600003");
  assert.equal(rows[0].dataProvider, "eastmoney_topic_pool");
  assert.equal(rows[0].primaryProviderMissing, true);
  assert.deepEqual(meta.providers, [
    "ths_public_limit_up",
    "eastmoney_topic_pool"
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)).meta, meta);
});

test("ladder caches are isolated by configured primary provider", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const today = shanghaiDate();
  const todayCompact = compactDate(today);
  const lastSealEpoch = Math.floor(Date.parse(`${today}T09:35:00+08:00`) / 1000);

  global.fetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.includes("data.10jqka.com.cn/dataapi/limit_up/limit_up_pool")) {
      return mockJsonResponse({
        status_code: 0,
        data: {
          info: [{
            code: "600002",
            name: "THS独立样本",
            latest: 12,
            change_rate: 10,
            turnover_rate: 3,
            order_volume: 10000,
            first_limit_up_time: String(lastSealEpoch),
            last_limit_up_time: String(lastSealEpoch),
            high_days: "1天1板",
            change_tag: "FIRST_LIMIT"
          }],
          page: { total: 1 }
        }
      });
    }
    if (requestUrl.includes("push2ex.eastmoney.com/getTopicZBPool")) {
      return mockJsonResponse({ data: { qdate: todayCompact, tc: 0, pool: [] } });
    }
    if (requestUrl.includes("push2ex.eastmoney.com/getTopicZTPool")) {
      return mockJsonResponse({
        data: {
          qdate: todayCompact,
          tc: 1,
          pool: [{
            c: "600001", m: 1, n: "东财独立样本", p: 11000, zdp: 10,
            amount: 1000000, ltsz: 10000000, tshare: 12000000,
            hs: 2, lbc: 1, fbt: 93000, lbt: 93000,
            fund: 100000, zbc: 0, hybk: "测试行业", zttj: { days: 1, ct: 1 }
          }]
        }
      });
    }
    if (requestUrl.includes("quotes.sina.cn/")) {
      return mockJsonResponse({ result: { data: mockRecentSinaHistory() } });
    }
    throw new Error(`unexpected test request: ${requestUrl}`);
  };

  const eastmoney = await currentLadderPools({
    provider: "eastmoney",
    fallbackEnabled: false,
    multiSourceEnabled: false,
    forceRefresh: true
  });
  const ths = await currentLadderPools({
    provider: "ths",
    fallbackEnabled: false,
    multiSourceEnabled: false,
    forceRefresh: false
  });

  assert.equal(eastmoney.currentPool[0].code, "600001");
  assert.equal(ths.currentPool[0].code, "600002");
  assert.notStrictEqual(eastmoney, ths);
});

test("historical sample path uses real dates, costs and non-overlapping settled samples", () => {
  const samplePath = buildSequentialSamplePath([
    { entryDate: "2026-01-02", exitDate: "2026-01-08", node: 3, r5: 10 },
    { entryDate: "2026-01-05", exitDate: "2026-01-09", node: 5, r5: 80 },
    { entryDate: "2026-01-09", exitDate: "2026-01-15", node: 3, r5: -4 }
  ], {
    startingCapital: 100000,
    positionPercent: 50,
    roundTripCostPercent: 0.2
  });
  assert.equal(samplePath.points.length, 2);
  assert.equal(samplePath.skippedOverlaps, 1);
  assert.equal(samplePath.points[0].entryDate, "2026-01-02");
  assert.equal(samplePath.points[0].netReturnPercent, 9.8);
  assert.equal(samplePath.points[1].exitDate, "2026-01-15");
  assert.ok(samplePath.endingCapital > 100000);
});

test("single-stock backtest history window follows the selected start date", () => {
  const now = new Date("2026-08-11T00:00:00Z");
  assert.equal(singleStockBacktestLookbackBars(undefined), 120);
  assert.equal(singleStockBacktestLookbackBars(720), 720);
  assert.equal(singleStockBacktestLookbackBars(80), 120);
  assert.equal(singleStockBacktestLookbackBars(120, "2025-08-11", now), 381);
  assert.equal(singleStockBacktestLookbackBars(120, "2026-08-01", now), 128);
  assert.equal(singleStockBacktestLookbackBars(120, "2010-01-01", now), 4000);
});

test("single-stock trade ledger preserves every trade and compounds account profit", () => {
  const ledger = buildSingleStockTradeLedger([
    {
      signalDate: "2026-01-01",
      strategyId: "low_first_board",
      strategyIds: ["low_first_board", "trend_first_board"],
      entryPriceSource: "custom_limit_price",
      entryDate: "2026-01-02",
      exitDate: "2026-01-08",
      entryPrice: 10,
      exitPrice: 11,
      grossReturn: 10.2,
      netReturn: 10,
      benchmarkReturn: 1,
      excessReturn: 9
    },
    {
      signalDate: "2026-01-08",
      entryDate: "2026-01-09",
      exitDate: "2026-01-15",
      entryPrice: 20,
      exitPrice: 19,
      grossReturn: -4.8,
      netReturn: -5,
      benchmarkReturn: -1,
      excessReturn: -4
    }
  ], {
    startingCapital: 100000,
    positionPercent: 100,
    roundTripCostPercent: 0.2
  });
  assert.equal(ledger.trades.length, 2);
  assert.equal(ledger.trades[0].entryPrice, 10);
  assert.deepEqual(ledger.trades[0].strategyIds, ["low_first_board", "trend_first_board"]);
  assert.equal(ledger.trades[0].entryPriceSource, "custom_limit_price");
  assert.equal(ledger.trades[1].exitDate, "2026-01-15");
  assert.equal(ledger.summary.profitableTrades, 1);
  assert.equal(ledger.summary.losingTrades, 1);
  assert.equal(ledger.summary.winRatePercent, 50);
  assert.equal(ledger.summary.endingCapital, 104500);
  assert.equal(ledger.summary.totalProfitAmount, 4500);
  assert.equal(ledger.summary.totalNetReturnPercent, 4.5);
  assert.equal(ledger.summary.maxDrawdownPercent, -5);
});

test("price limit rates follow board and ST rules", () => {
  assert.equal(priceLimitRate("600000", "浦发银行"), 0.1);
  assert.equal(priceLimitRate("300750", "宁德时代"), 0.2);
  assert.equal(priceLimitRate("688981", "中芯国际"), 0.2);
  assert.equal(priceLimitRate("600000", "ST测试"), 0.05);
  assert.equal(priceLimitRate("920000", "北交所测试"), 0.3);
});

test("security identifiers are normalized", () => {
  assert.equal(toSecurity("600000").secid, "1.600000");
  assert.equal(toSecurity("000001").thscode, "000001.SZ");
  assert.equal(
    toSecurity({ code: "600519", industry: "白酒" }).industry,
    "白酒"
  );
});

test("security identifiers are canonical and exchange-consistent for SH, SZ and BJ", () => {
  assert.deepEqual(
    ["600519", "000001", "300750", "688981", "430047", "830799", "920117"]
      .map((code) => {
        const security = toSecurity(code);
        return [security.code, security.secid, security.thscode];
      }),
    [
      ["600519", "1.600519", "600519.SH"],
      ["000001", "0.000001", "000001.SZ"],
      ["300750", "0.300750", "300750.SZ"],
      ["688981", "1.688981", "688981.SH"],
      ["430047", "0.430047", "430047.BJ"],
      ["830799", "0.830799", "830799.BJ"],
      ["920117", "0.920117", "920117.BJ"]
    ]
  );
  assert.equal(toSecurity("920117.bj").thscode, "920117.BJ");
});

test("malicious or inconsistent code, secid, QuoteID and thscode values fail closed", async () => {
  assert.throws(
    () => toSecurity({ code: "600519&fields=f43" }),
    /exactly 6 digits/i
  );
  assert.throws(
    () => toSecurity({ code: "600519", secid: "1.600519&fields=f43" }),
    /Invalid secid/i
  );
  assert.throws(
    () => toSecurity({ code: "600519", QuoteID: "0.600519" }),
    /Invalid QuoteID/i
  );
  assert.throws(
    () => toSecurity({ code: "600519", thscode: "600519.SH,000001.SZ" }),
    /Invalid thscode/i
  );
  assert.throws(
    () => toSecurity({ code: "600519", secid: "0.600519" }),
    /Invalid secid/i
  );
  assert.throws(
    () => toSecurity({ code: "920117", thscode: "920117.SZ" }),
    /Invalid thscode/i
  );
  await assert.rejects(
    resolveBacktestSecurity({ code: "600519&provider=ths" }),
    /exactly 6 digits/i
  );

  assert.equal(normalizeSearchSecurity({
    Code: "600519&fields=f43",
    Name: "malicious",
    Classify: "AStock",
    MktNum: "1",
    QuoteID: "1.600519"
  }), null);
  assert.equal(normalizeSearchSecurity({
    Code: "600519",
    Name: "malicious",
    Classify: "AStock",
    MktNum: "1",
    QuoteID: "1.600519&fields=f43"
  }), null);
  assert.equal(normalizeSearchSecurity({
    Code: "600519",
    Name: "wrong exchange",
    Classify: "AStock",
    MktNum: "0",
    QuoteID: "0.600519"
  }), null);
});

test("search query metacharacters stay inside the encoded input parameter", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  let capturedUrl = "";
  global.fetch = async (url) => {
    capturedUrl = String(url);
    return mockJsonResponse({ QuotationCodeTable: { Data: [] } });
  };

  const maliciousQuery = "600000&count=999&type=1#fragment";
  assert.deepEqual(await searchSecurities(maliciousQuery), []);
  const parsed = new URL(capturedUrl);
  assert.equal(parsed.searchParams.get("input"), maliciousQuery);
  assert.deepEqual(parsed.searchParams.getAll("count"), ["40"]);
  assert.deepEqual(parsed.searchParams.getAll("type"), ["14"]);
  assert.equal(parsed.hash, "");
});

test("backtest security resolver accepts a code or one uniquely matched A-share name", async () => {
  let searchCalls = 0;
  const search = async (query) => {
    searchCalls += 1;
    assert.equal(query, "贵州茅台");
    return [
      {
        code: "600519",
        name: "贵州茅台",
        secid: "1.600519",
        thscode: "600519.SH",
        assetType: "stock"
      },
      {
        code: "600199",
        name: "金种子酒",
        secid: "1.600199",
        thscode: "600199.SH",
        assetType: "stock"
      }
    ];
  };
  const byName = await resolveBacktestSecurity("贵州茅台", search);
  assert.equal(byName.code, "600519");
  assert.equal(byName.name, "贵州茅台");
  assert.equal(byName.assetType, "stock");
  assert.equal(searchCalls, 1);

  const byCode = await resolveBacktestSecurity("000001.SZ", async () => {
    throw new Error("代码输入不应调用证券搜索");
  });
  assert.equal(byCode.code, "000001");
  assert.equal(byCode.thscode, "000001.SZ");
});

test("backtest security resolver rejects ambiguous, missing and non-stock inputs clearly", async () => {
  await assert.rejects(
    resolveBacktestSecurity("银行", async () => [
      { code: "000001", name: "平安银行", assetType: "stock" },
      { code: "600036", name: "招商银行", assetType: "stock" }
    ]),
    /对应多只A股.*000001.*600036.*6位代码/
  );
  await assert.rejects(
    resolveBacktestSecurity("不存在股份", async () => []),
    /未找到.*对应的A股/
  );
  await assert.rejects(
    resolveBacktestSecurity("沪深300ETF", async () => [
      { code: "510300", name: "沪深300ETF", assetType: "etf" }
    ]),
    /未找到.*对应的A股/
  );
  await assert.rejects(
    resolveBacktestSecurity({
      code: "510300",
      name: "沪深300ETF",
      assetType: "etf"
    }),
    /回测仅支持A股股票/
  );
});

test("backtest history uses THS first, Eastmoney second, then the public relay", async () => {
  const security = toSecurity({ code: "600519", name: "贵州茅台" });
  const calls = [];
  const thsRows = [{ date: "2026-07-31", close: 1400 }];
  const eastmoneyRows = [{ date: "2026-07-31", close: 1399.5 }];
  const publicRows = [{ date: "2026-07-31", close: 1399 }];
  const preferred = await loadBacktestHistory(
    security,
    { provider: "ths", refreshToken: "token", fallbackEnabled: true },
    260,
    {
      ths: async (target, bars) => {
        calls.push(`ths:${target.code}:${bars}`);
        return thsRows;
      },
      eastmoney: async () => {
        calls.push("eastmoney");
        return eastmoneyRows;
      },
      public: async () => {
        calls.push("public");
        return publicRows;
      }
    }
  );
  assert.equal(preferred, thsRows);
  assert.deepEqual(calls, ["ths:600519:260"]);

  calls.length = 0;
  const secondary = await loadBacktestHistory(
    security,
    { provider: "ths", refreshToken: "token", fallbackEnabled: true },
    260,
    {
      ths: async () => {
        calls.push("ths");
        throw new Error("timeout");
      },
      eastmoney: async () => {
        calls.push("eastmoney");
        return eastmoneyRows;
      },
      public: async () => {
        calls.push("public");
        return publicRows;
      }
    }
  );
  assert.equal(secondary, eastmoneyRows);
  assert.deepEqual(calls, ["ths", "eastmoney"]);

  calls.length = 0;
  const relay = await loadBacktestHistory(
    security,
    { provider: "ths", refreshToken: "token", fallbackEnabled: true },
    260,
    {
      ths: async () => {
        calls.push("ths");
        throw new Error("timeout");
      },
      eastmoney: async () => {
        calls.push("eastmoney");
        throw new Error("rate limited");
      },
      public: async () => {
        calls.push("public");
        return publicRows;
      }
    }
  );
  assert.equal(relay, publicRows);
  assert.deepEqual(calls, ["ths", "eastmoney", "public"]);

  await assert.rejects(
    loadBacktestHistory(
      security,
      { provider: "ths", refreshToken: "token", fallbackEnabled: false },
      260,
      { ths: async () => { throw new Error("token expired"); } }
    ),
    /同花顺历史行情获取失败.*token expired/
  );
});

test("renderer backtest settings cannot override or preserve sensitive service settings", () => {
  const normalMerge = mergeBacktestSettings(
    {
      provider: "ths",
      refreshToken: "trusted-service-token",
      fallbackEnabled: true
    },
    { maxPositionPercent: 35 }
  );
  assert.equal(normalMerge.provider, "ths");
  assert.equal(normalMerge.refreshToken, "trusted-service-token");
  assert.equal(normalMerge.fallbackEnabled, true);
  assert.equal(normalMerge.maxPositionPercent, 35);

  const merged = mergeBacktestSettings(
    {
      provider: "ths",
      refreshToken: "main-refresh-token",
      tushareToken: "main-tushare-token",
      fallbackEnabled: false,
      maxPositionPercent: 28,
      commissionBps: 7
    },
    {
      provider: "ths",
      refreshToken: "renderer-refresh-token",
      tushareToken: "renderer-tushare-token",
      fallbackEnabled: false,
      forceRefresh: true,
      backendApiKey: "renderer-api-key",
      maxPositionPercent: 41,
      commissionBps: 9,
      selectedStrategies: ["low_first_board"]
    }
  );

  assert.equal(merged.provider, undefined);
  assert.equal(merged.refreshToken, undefined);
  assert.equal(merged.tushareToken, undefined);
  assert.equal(merged.fallbackEnabled, undefined);
  assert.equal(merged.forceRefresh, undefined);
  assert.equal(merged.backendApiKey, undefined);
  assert.equal(merged.maxPositionPercent, 41);
  assert.equal(merged.commissionBps, 9);
  assert.deepEqual(merged.selectedStrategies, ["low_first_board"]);

  const profile = safeBacktestStrategyProfile({
    ...merged,
    provider: "eastmoney",
    refreshToken: "must-not-return",
    tushareToken: "must-not-return-either",
    internalPassword: "must-not-return-password",
    riskProfile: "balanced",
    lossStreakStepPercent: 18,
    lossStreakFloorPercent: 30
  }, ["low_first_board"]);
  assert.deepEqual(profile.selectedStrategies, ["low_first_board"]);
  assert.equal(profile.riskProfile, "balanced");
  assert.equal(profile.lossStepPercent, 18);
  assert.equal(profile.lossFloorPercent, 30);
  assert.equal("provider" in profile, false);
  assert.equal("refreshToken" in profile, false);
  assert.equal("tushareToken" in profile, false);
  assert.equal("internalPassword" in profile, false);
});

test("verified runBacktest returns only the safe strategy profile whitelist", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  const requestedUrls = [];
  global.fetch = async (url) => {
    const requestUrl = String(url);
    requestedUrls.push(requestUrl);
    if (requestUrl.includes("push2his.eastmoney.com/")) {
      return mockJsonResponse({ data: { klines: mockRecentEastHistory(140) } });
    }
    throw new Error(`unexpected test request: ${requestUrl}`);
  };

  const result = await runBacktest(
    { code: "603999", name: "安全回测样本", assetType: "stock" },
    {
      provider: "eastmoney",
      refreshToken: "SERVICE_REFRESH_CREDENTIAL",
      tushareToken: "SERVICE_TUSHARE_CREDENTIAL",
      internalApiKey: "SERVICE_INTERNAL_CREDENTIAL",
      riskProfile: "balanced",
      maxPositionPercent: 28,
      commissionBps: 7,
      slippageBps: 2
    },
    {
      startDate: recentDate(-60),
      signalStrategyIds: ["low_first_board", "trend_first_board"],
      strategyContext: {
        strategyId: "custom_strategy_vote",
        strategyName: "安全多策略回归",
        strategyIds: ["low_first_board", "trend_first_board"],
        minimumVotes: 1
      },
      minSamples: 8,
      settings: {
        provider: "ths",
        refreshToken: "RENDERER_REFRESH_CREDENTIAL",
        fallbackEnabled: false,
        forceRefresh: true,
        backendPassword: "RENDERER_PASSWORD_CREDENTIAL",
        riskProfile: "aggressive",
        maxPositionPercent: 37,
        commissionBps: 9,
        slippageBps: 3
      }
    }
  );

  assert.equal(result.backtestMode, "verified_signal_strategy");
  assert.equal(result.range.requestedFrom, recentDate(-60));
  assert.equal(result.range.signalFrom, recentDate(-60));
  assert.ok(Array.isArray(result.trades));
  assert.equal(result.strategyMode, "multi_strategy_vote");
  assert.equal(result.strategyBreakdown.length, 2);
  assert.deepEqual(
    result.strategyBreakdown.map((item) => item.strategyId),
    ["low_first_board", "trend_first_board"]
  );
  assert.equal(typeof result.profitSummary.totalNetReturnPercent, "number");
  assert.ok(result.trades.every((trade) => trade.signalDate >= recentDate(-60)));
  assert.deepEqual(result.strategyProfile.selectedStrategies, ["low_first_board", "trend_first_board"]);
  assert.equal(result.strategyProfile.riskProfile, "aggressive");
  assert.equal(result.strategyProfile.maxPositionPercent, 37);
  assert.equal(result.strategyProfile.commissionBps, 9);
  for (const forbidden of [
    "provider",
    "refreshToken",
    "tushareToken",
    "fallbackEnabled",
    "forceRefresh",
    "internalApiKey",
    "backendPassword"
  ]) {
    assert.equal(forbidden in result.strategyProfile, false, forbidden);
  }
  const serializedProfile = JSON.stringify(result.strategyProfile);
  for (const credential of [
    "SERVICE_REFRESH_CREDENTIAL",
    "SERVICE_TUSHARE_CREDENTIAL",
    "SERVICE_INTERNAL_CREDENTIAL",
    "RENDERER_REFRESH_CREDENTIAL",
    "RENDERER_PASSWORD_CREDENTIAL"
  ]) {
    assert.equal(serializedProfile.includes(credential), false, credential);
  }
  assert.equal(requestedUrls.length, 2);
  assert.ok(requestedUrls.every((url) => url.includes("push2his.eastmoney.com/")));
});

test("portfolio backtest service keeps a no-signal basket as an all-cash diagnostic", async () => {
  const rows = Array.from({ length: 150 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index));
    const close = 10 + index * 0.001;
    return {
      date: date.toISOString().slice(0, 10),
      open: close,
      high: close * 1.01,
      low: close * 0.99,
      close,
      volume: 100000,
      amount: close * 100000,
      turnover: 1
    };
  });
  const result = await runPortfolioBacktest(
    {
      securities: [
        { code: "600001", name: "组合甲", assetType: "stock" },
        { code: "000001", name: "组合乙", assetType: "stock" }
      ],
      strategyIds: ["low_first_board"],
      minimumVotes: 1,
      startingCapital: 200000,
      maxPositions: 2,
      maxPositionPercent: 28,
      lookbackBars: 720,
      commissionBps: 7,
      slippageBps: 2,
      lotSize: 100,
      benchmark: "000985"
    },
    { provider: "eastmoney", maxPositionPercent: 28 },
    {
      resolveSecurity: async (security) => toSecurity(security),
      loadHistory: async () => rows
    }
  );

  assert.equal(result.backtestMode, "verified_strategy_portfolio");
  assert.equal(result.status, "DIAGNOSTIC");
  assert.equal(result.validation.accepted, false);
  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.metrics.totalReturnPercent, 0);
  assert.equal(result.metrics.endingCapital, 200000);
  assert.equal(result.equityCurve.length, 120);
  assert.equal(result.universe.usedCount, 2);
  assert.equal(result.contributions.length, 2);
  assert.match(result.methodology.summary, /共享现金/);
});

test("strategy-derived portfolio is labeled separately from a manual basket", async () => {
  const rows = Array.from({ length: 150 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10),
    open: 10,
    high: 10.1,
    low: 9.9,
    close: 10,
    volume: 100000,
    amount: 1000000,
    turnover: 1
  }));
  const result = await runPortfolioBacktest(
    {
      securities: [{ code: "600001", name: "策略命中股", assetType: "stock" }],
      strategyIds: ["low_first_board"],
      universeSource: "strategy_current_matches",
      lookbackBars: 120
    },
    {},
    {
      resolveSecurity: async (security) => toSecurity(security),
      loadHistory: async () => rows
    }
  );
  assert.equal(result.universe.selectionMode, "strategy_current_matches");
  assert.equal(result.universe.selectionLabel, "所选策略本轮命中股票");
  assert.match(result.statusReasons[0], /并非手工先选股/);
  assert.equal(result.universe.pointInTime, false);
});

test("sector diagnostics distinguish broad participation from a few crowded leaders", () => {
  const broad = buildSectorBreadthDiagnostics([
    { f3: 3, f6: 100, f62: 10 },
    { f3: 2, f6: 100, f62: 8 },
    { f3: 1, f6: 100, f62: 5 },
    { f3: 0.5, f6: 100, f62: 2 },
    { f3: -0.2, f6: 100, f62: -1 },
    { f3: 0.3, f6: 100, f62: 1 }
  ]);
  const crowded = buildSectorBreadthDiagnostics([
    { f3: 8, f6: 900, f62: 20 },
    { f3: -2, f6: 20, f62: -5 },
    { f3: -1.5, f6: 20, f62: -4 },
    { f3: -1, f6: 20, f62: -3 },
    { f3: -0.5, f6: 20, f62: -2 },
    { f3: -0.2, f6: 20, f62: -1 }
  ]);
  assert.ok(broad.advancingAmountShare > 0.7);
  assert.ok(broad.positiveInflowRatio > 0.7);
  assert.ok(broad.leadershipQualityScore > crowded.leadershipQualityScore);
  assert.ok(crowded.top5AmountShare > broad.top5AmountShare);
  assert.equal(broad.coveragePercent, 100);
});

test("Sina industry catalog and constituents normalize into canonical A-share rows", () => {
  const catalog = parseSinaSectorCatalog(
    'var S_Finance_bankuai_sinaindustry = {"new_dlhy":"new_dlhy,电力行业,3,10.2,0.12,1.18,2000,3000,sh600001,10.02,11,1,甲公司"};'
  );
  const sector = matchSinaSector(catalog, "电力");
  assert.equal(sector.node, "new_dlhy");
  assert.equal(sector.changePct, 1.18);
  const members = normalizeSinaSectorMembers([
    {
      symbol: "sh600001",
      code: "600001",
      name: "甲公司",
      trade: "11.00",
      settlement: "10.00",
      changepercent: "10.00",
      turnoverratio: "3.2",
      amount: "123456"
    },
    { symbol: "usAAPL", name: "非A股", trade: "1" }
  ]);
  assert.equal(members.length, 1);
  assert.equal(members[0].code, "600001");
  assert.equal(members[0].secid, "1.600001");
  assert.equal(members[0].isLimitUp, true);
});

test("THS smart-picking columns normalize into sector member rows", () => {
  const members = extractThsSectorMembers({
    tables: [{
      table: {
        thscode: ["600001.SH", "000001.SZ"],
        股票简称: ["甲公司", "乙公司"],
        最新价: [11, 9.5],
        涨跌幅: [10, -1.2],
        成交额: [100000, 80000],
        换手率: [4.2, 2.1],
        昨收价: [10, 9.62]
      }
    }]
  });
  assert.deepEqual(members.map((item) => item.code), ["600001", "000001"]);
  assert.equal(members[0].isLimitUp, true);
  assert.equal(members[1].changePct, -1.2);
});

test("sector fallback scoring never turns missing history into zero returns", () => {
  assert.deepEqual(SECTOR_PROVIDER_PRIORITY.slice(0, 3), [
    "同花顺 QuantAPI",
    "东方财富实时",
    "东方财富延迟节点"
  ]);
  const realtime = buildSectorStrengthFromData({
    sector: { code: "", name: "电力行业", secid: "" },
    members: [
      { code: "600001", name: "甲", changePct: 2, turnover: 3, amount: 100, isLimitUp: false },
      { code: "000001", name: "乙", changePct: -1, turnover: 2, amount: 80, isLimitUp: false }
    ],
    history: [],
    benchmark: [],
    context: { marketBreadth: 0.5, marketAverageReturn: 0.2 },
    source: "新浪行业实时"
  });
  assert.equal(realtime.returns.r1, 0.5);
  assert.equal(realtime.returns.r3, null);
  assert.equal(realtime.returns.r5, null);
  assert.ok(Number.isFinite(realtime.score));
  assert.equal(realtime.partial, true);

  const summaryOnly = buildSectorStrengthFromData({
    sector: { code: "", name: "电力行业", secid: "" },
    members: [],
    history: [],
    benchmark: [],
    context: {},
    source: "新浪行业摘要",
    summary: { memberCount: 100, changePct: 1.2 }
  });
  assert.equal(summaryOnly.score, null);
  assert.equal(summaryOnly.breadth, null);
  assert.equal(summaryOnly.returns.r3, null);
  assert.equal(summaryOnly.memberCount, 100);
});

test("portfolio service accepts one stock and fixes the return window at 120 bars with warmup", async () => {
  const rows = Array.from({ length: 340 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index));
    return {
      date: date.toISOString().slice(0, 10),
      open: 10,
      high: 10.1,
      low: 9.9,
      close: 10,
      volume: 100000,
      amount: 1000000,
      turnover: 1
    };
  });
  const requestedBars = [];
  const result = await runPortfolioBacktest(
    {
      securities: [{ code: "600001", name: "单股样本", assetType: "stock" }],
      strategyIds: ["low_first_board"],
      lookbackBars: 720
    },
    {},
    {
      resolveSecurity: async (security) => toSecurity(security),
      loadHistory: async (_security, _settings, bars) => {
        requestedBars.push(bars);
        return rows;
      }
    }
  );

  assert.equal(result.lookbackBars, 120);
  assert.equal(result.universe.usedCount, 1);
  assert.equal(result.equityCurve.length, 120);
  assert.equal(result.dataQuality.signalWindow.bars, 120);
  assert.equal(result.dataQuality.warmupBarsRequested, 80);
  assert.equal(result.dataQuality.warmupBarsAvailable, 80);
  assert.equal(result.dataQuality.benchmarkHistoryBarsLoaded, 200);
  assert.deepEqual(requestedBars, [200, 200]);
});

test("portfolio service lists a strategy-hit stock by signal date even when entry is rejected", async () => {
  const stockRows = Array.from({ length: 320 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, 1 + index));
    let open = 10;
    let high = 10.2;
    let low = 9.8;
    let close = 10;
    let volume = 100000;
    if (index === 220) {
      open = 10.1;
      high = 11;
      low = 10.05;
      close = 11;
      volume = 180000;
    } else if (index === 221) {
      open = 12.1;
      high = 12.1;
      low = 12.1;
      close = 12.1;
    }
    return {
      date: date.toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume,
      amount: close * volume,
      turnover: 1
    };
  });
  const benchmarkRows = stockRows.map((row) => ({
    ...row,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    volume: 1000000,
    amount: 100000000
  }));
  const tradableRows = stockRows.map((row, index) => index === 221
    ? {
        ...row,
        open: 10.85,
        high: 11.15,
        low: 10.8,
        close: 11.12,
        volume: 100000,
        amount: 1112000
      }
    : row);
  const result = await runPortfolioBacktest(
    {
      securities: [
        { code: "600001", name: "一字板命中", assetType: "stock" },
        { code: "600002", name: "实际成交", assetType: "stock" },
        { code: "600003", name: "容量拒绝", assetType: "stock" }
      ],
      strategyIds: ["low_first_board"],
      lookbackBars: 120,
      maxPositions: 1
    },
    {},
    {
      resolveSecurity: async (security) => toSecurity(security),
      loadHistory: async (security) => {
        if (security.code === "000985") return benchmarkRows;
        return security.code === "600001" ? stockRows : tradableRows;
      }
    }
  );

  const event = result.signalEvents.find(
    (item) => item.code === "600001" && item.signalDate === stockRows[220].date
  );
  assert.ok(event);
  assert.equal(event.status, "rejected");
  assert.equal(event.reason, "nextDayOnePriceLimitUp");
  assert.equal(result.signalTimeline[0].stocks.length, 3);
  assert.equal(result.signalTimeline[0].filledCount, 1);
  assert.equal(result.signalTimeline[0].rejectedCount, 2);
  assert.deepEqual(
    new Set(result.signalTimeline[0].stocks.map((item) => item.reason).filter(Boolean)),
    new Set(["nextDayOnePriceLimitUp", "capacity_limit"])
  );
  assert.equal(result.signalAudit.matched, 3);
  assert.equal(result.signalAudit.rejected, 2);
  assert.equal(result.metrics.tradeCount, 1);
});

test("portfolio strategy definition endpoint exposes the full auditable library", () => {
  const definitions = getStrategyDefinitions();
  assert.equal(definitions.length, 18);
  assert.ok(definitions.every((item) => item.id && item.name && item.detail));
  assert.ok(definitions.some((item) => item.type === "composite"));
  assert.equal(definitions.some((item) => typeof item.matches === "function"), false);
});

test("Tencent quote fallback preserves execution fields", () => {
  const quote = normalizeTencentQuote(
    {
      code: "600519",
      name: "贵州茅台",
      secid: "1.600519",
      thscode: "600519.SH",
      industry: "白酒"
    },
    {
      securityName: "贵州茅台",
      securityCode: "600519",
      latest: 1337.33,
      preClose: 1361.76,
      open: 1330.03,
      high: 1345,
      low: 1325.77,
      volume: 3791900,
      amount: 5054314019,
      turnover: 0.3,
      volumeRatio: 1.49,
      amplitude: 1.41,
      totalMarketCap: 16717.72e8,
      floatMarketCap: 16717.72e8,
      limitUp: 1497.94,
      limitDown: 1225.58,
      change: -24.43,
      changePct: -1.79
    }
  );
  assert.equal(quote.source, "tencent");
  assert.equal(quote.industry, "白酒");
  assert.equal(quote.latest, 1337.33);
  assert.equal(quote.amount, 5054314019);
  assert.equal(quote.turnover, 0.3);
  assert.equal(quote.limitUp, 1497.94);
});

test("search accepts exchange ETFs and convertible bonds but marks them search-only", () => {
  const etf = normalizeSearchSecurity({
    Code: "510300",
    Name: "沪深300ETF华泰柏瑞",
    Classify: "Fund",
    MktNum: "1",
    QuoteID: "1.510300"
  });
  const bond = normalizeSearchSecurity({
    Code: "118060",
    Name: "瑞可转债",
    Classify: "Bond",
    MktNum: "1",
    QuoteID: "1.118060"
  });
  assert.equal(searchableAssetType({ Code: "510300", Name: "沪深300ETF", Classify: "Fund" }), "etf");
  assert.equal(isConvertibleBondCode("118060"), true);
  assert.equal(etf.marketName, "ETF");
  assert.equal(etf.assetType, "etf");
  assert.equal(etf.defaultVisible, false);
  assert.equal(bond.marketName, "可转债");
  assert.equal(bond.assetType, "convertibleBond");
  assert.equal(bond.defaultVisible, false);
});

test("search excludes OTC funds and ordinary bonds", () => {
  assert.equal(searchableAssetType({
    Code: "000003",
    Name: "中海可转债债券A",
    Classify: "OTCFUND"
  }), null);
  assert.equal(searchableAssetType({
    Code: "019547",
    Name: "国债示例",
    Classify: "Bond"
  }), null);
});

test("quote prices respect the source precision for stocks, ETFs and convertible bonds", () => {
  assert.equal(eastPriceFromRaw(134882, 2), 1348.82);
  assert.equal(eastPriceFromRaw(4594, 3), 4.594);
  assert.equal(eastPriceFromRaw(171491, 3), 171.491);
});

test("exact searchable codes can fall back without the suggestion endpoint", () => {
  assert.equal(assetTypeFromExactCode("510300"), "etf");
  assert.equal(assetTypeFromExactCode("159919"), "etf");
  assert.equal(assetTypeFromExactCode("118060"), "convertibleBond");
  assert.equal(assetTypeFromExactCode("123236"), "convertibleBond");
  assert.equal(assetTypeFromExactCode("600519"), null);
});

test("ST and delisting-risk names are excluded", () => {
  assert.equal(isRiskStockName("*ST测试"), true);
  assert.equal(isRiskStockName("测试退"), true);
  assert.equal(isRiskStockName("正常股份"), false);
});

test("fine-grained concepts are parsed dynamically from THS smart-picking fields", () => {
  assert.equal(conceptRootName("PCB概念"), "PCB");
  assert.equal(conceptRootName("机器人行业Ⅱ"), "机器人");
  const rows = extractThsConceptRows({
    tables: [{
      table: {
        股票代码: ["300001.SZ", "600001.SH"],
        股票简称: ["甲公司", "乙公司"],
        所属同花顺概念: [
          "电子布;覆铜板;AI服务器",
          "电子级树脂;覆铜板"
        ]
      }
    }]
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    code: "300001",
    name: "甲公司",
    concepts: ["电子布", "覆铜板", "AI服务器"]
  });
});

test("free market fields generate dynamic industry and cross-concept groups", () => {
  const result = buildFreeConceptGroups("PCB", [
    { code: "600001", name: "甲", subIndustry: "专用设备", freeConcepts: ["PCB", "玻璃基板"] },
    { code: "600002", name: "乙", subIndustry: "专用设备", freeConcepts: ["PCB", "玻璃基板"] },
    { code: "600003", name: "丙", subIndustry: "电子化学品", freeConcepts: ["PCB", "先进封装"] },
    { code: "600004", name: "丁", subIndustry: "电子化学品", freeConcepts: ["PCB", "先进封装"] }
  ]);
  assert.equal(result.stockCount, 4);
  assert.ok(result.groups.some((group) => group.name === "成分行业细分"));
  assert.ok(result.groups.some((group) => group.name === "交叉概念细分"));
  assert.ok(result.groups.flatMap((group) => group.segments).some((item) => item.name === "玻璃基板"));
  assert.equal(result.groups.flatMap((group) => group.segments).some((item) => item.name === "PCB"), false);
});

test("analysis detects a limit-up event and exact node", () => {
  const history = [];
  let close = 10;
  for (let i = 0; i < 30; i += 1) {
    const date = `2026-06-${String(i + 1).padStart(2, "0")}`;
    if (i === 24) close = 11;
    else if (i > 24) close *= 1.003;
    history.push({
      date,
      open: close * 0.99,
      high: close,
      low: close * 0.98,
      close,
      volume: i === 24 ? 200000 : 100000,
      amount: close * 100000 * 100,
      turnover: 2
    });
  }
  const quote = { name: "测试股份" };
  const result = analyzeHistory(
    { code: "600001" },
    quote,
    history,
    { score: 65, returns: { r3: 1 } }
  );
  assert.equal(result.daysSince, 5);
  assert.equal(result.exactNode, "T+5");
  assert.ok(result.avwap > 0);
  assert.equal(result.eventCount60, 1);
  assert.equal(result.isLowFirstBoard, true);
  const strategies = strategyDefinitionsFor(
    {
      ...result,
      marketEmotion: {
        score: 82,
        state: "情绪强势",
        limitUpCount: 111,
        limitDownCount: 6,
        limitDownRatio: 6 / 111
      }
    },
    { latest: history.at(-1).close }
  );
  assert.equal(strategies.find((item) => item.id === "lowFirstBoard").matched, true);
  assert.ok(strategies.find((item) => item.id === "originBreakout"));
  assert.ok(strategies.find((item) => item.id === "vcpCompression"));
  assert.ok(strategies.find((item) => item.id === "chipLock"));
  assert.equal(strategies.find((item) => item.id === "marketEmotion").matched, true);
  assert.equal(strategies.find((item) => item.id === "riskVeto").matched, true);
});
