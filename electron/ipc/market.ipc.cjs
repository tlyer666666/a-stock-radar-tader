"use strict";

function registerMarketIpc({
  handleTrustedIpc,
  serviceRequestRuntime = () => ({}),
  trackAbortableRequest = null,
  settingsForService,
  readExternalFactorStore,
  searchSecurities,
  analyzeSecurity,
  getQuoteSnapshot,
  getMarketSourceHealth,
  resetMarketSourceHealth = () => ({ ok: true }),
  getConvertibleBonds,
  getEtfMarket,
  getIndexBoard = async () => { throw new Error("指数行情暂不可用"); },
  subscribeIndexStream = () => ({ active: false, connected: 0, total: 0, lastTickAt: "", quotes: [] }),
  subscribeLimitSeals = () => ({ active: false, items: [] }),
  alertRules = null,
  screenFactors = async () => { throw new Error("多因子选股暂不可用"); },
  getEtfRotation = async () => { throw new Error("ETF 轮动暂不可用"); },
  resolveStockIndustries = async () => new Map(),
  getBatchQuotes,
  getFuyaoReviewData,
  getDataFederation,
  getChart,
  discoverLimitUps,
  discoverRecentLimitUps,
  getPreviousLimitUpFailedBoardSnapshot,
  thsWebView
}) {
  handleTrustedIpc("market:search", (_, query) => searchSecurities(query));
  handleTrustedIpc("market:analyze", (_, security, options = {}) =>
    analyzeSecurity(security, {
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true,
      externalFactorSnapshots: readExternalFactorStore().snapshots
    })
  );
  handleTrustedIpc("market:quote", (_, security) =>
    getQuoteSnapshot(security, settingsForService())
  );
  handleTrustedIpc("market:source-health", () => getMarketSourceHealth());
  handleTrustedIpc("market:source-reset", () => resetMarketSourceHealth());
  handleTrustedIpc("bond:list", (_, options = {}) => getConvertibleBonds(options));
  handleTrustedIpc("etf:list", (_, options = {}) => getEtfMarket({ forceRefresh: options?.forceRefresh === true }));
  handleTrustedIpc("market:index-board", (_, options = {}) => getIndexBoard({ forceRefresh: options?.forceRefresh === true, withTrends: options?.withTrends !== false }));
  handleTrustedIpc("market:seal-stream", (_, input = {}) => subscribeLimitSeals({
    owner: String(input?.owner || "default"),
    codes: Array.isArray(input?.codes) ? input.codes : [],
    active: input?.active !== false,
    withHistory: input?.withHistory === true
  }));
  const withAbortableRuntime = async (event, payload, fn) => {
    const baseRuntime = typeof serviceRequestRuntime === "function" ? (serviceRequestRuntime(event, payload) || {}) : {};
    if (baseRuntime.signal) return fn(baseRuntime);
    if (typeof trackAbortableRequest === "function") {
      const tracked = trackAbortableRequest(baseRuntime);
      const runtime = { ...baseRuntime, signal: tracked.signal };
      try {
        return await fn(runtime);
      } finally {
        tracked.cleanup();
      }
    }
    return fn(baseRuntime);
  };
  // 指标预警：一个通道按 op 分发（list / save / remove / run / dry / clear）。
  handleTrustedIpc("alerts:rules", async (event, input = {}) => {
    const hub = alertRules?.();
    if (!hub) throw new Error("指标预警暂不可用");
    const op = String(input?.op || "list");
    if (op === "save") return hub.saveRule(input.rule);
    if (op === "remove") return hub.removeRule(String(input.id || "").slice(0, 40));
    if (op === "clear") return hub.clearHistory();
    if (op === "run") {
      const result = await withAbortableRuntime(event, input, runtime => hub.run({ signal: runtime?.signal }));
      return { ...hub.list(), run: { at: result.at, triggered: result.triggered || 0, evaluated: result.results.length } };
    }
    if (op === "dry") {
      const result = await withAbortableRuntime(event, input, runtime => hub.run({ dryRuleId: String(input.id || "").slice(0, 40), signal: runtime?.signal }));
      return { ...hub.list(), dry: result.results.slice(0, 40) };
    }
    return hub.list();
  });
  handleTrustedIpc("market:industries", async (_, codes) => {
    const map = await resolveStockIndustries([...new Set(codes)]);
    return Object.fromEntries([...map].filter(([, industry]) => industry && industry !== "未分类"));
  });
  handleTrustedIpc("market:index-stream", (_, options = {}) => subscribeIndexStream({ active: options?.active !== false }));
  handleTrustedIpc("etf:rotation", (event, config = {}) => {
    const payload = config && typeof config === "object" ? config : {};
    return withAbortableRuntime(event, payload, runtime => getEtfRotation(payload, { signal: runtime?.signal }));
  });
  handleTrustedIpc("screen:factors", (event, input = {}) => {
    const payload = input && typeof input === "object" ? input : {};
    const top = Math.max(1, Math.min(50, Math.round(Number(payload.top) || 20)));
    return withAbortableRuntime(event, payload, runtime => screenFactors({ strategyId: String(payload.strategyId || "").slice(0, 40), top, signal: runtime?.signal }));
  });
  handleTrustedIpc("market:batch-quotes", (_, securities) => getBatchQuotes(securities));
  // 沪深港通：同花顺数据中心网页嵌入（独立会话，用户自行登录同花顺账号）。
  handleTrustedIpc("ths-web:show", (_, options = {}) =>
    thsWebView().show({
      bounds: options?.bounds,
      page: options?.page === "login" ? "login" : options?.page === "hsgt" ? "hsgt" : undefined
    })
  );
  handleTrustedIpc("ths-web:bounds", (_, options = {}) => thsWebView().setBounds({ bounds: options?.bounds }));
  handleTrustedIpc("ths-web:hide", () => thsWebView().hide());
  handleTrustedIpc("ths-web:command", (_, options = {}) => thsWebView().command({ action: typeof options?.action === "string" ? options.action : "" }));
  handleTrustedIpc("ths-web:state", () => thsWebView().state());
  handleTrustedIpc("market:limit-ecology", (_, options = {}) => getFuyaoReviewData({ forceRefresh: options?.forceRefresh === true }));
  handleTrustedIpc("market:federation", (_, security) =>
    getDataFederation(security, settingsForService())
  );
  handleTrustedIpc("market:chart", (event, security, interval, options = {}) =>
    getChart(security, interval, options, serviceRequestRuntime(event, options))
  );
  handleTrustedIpc("market:limit-ups", async (_, options = {}) => {
    return discoverLimitUps({
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true
    });
  });
  handleTrustedIpc("market:recent-limit-ups", (_, days, options = {}) =>
    discoverRecentLimitUps(days, {
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true
    })
  );
  handleTrustedIpc("market:previous-limit-up-failed-boards", (_, options = {}) =>
    getPreviousLimitUpFailedBoardSnapshot({
      ...settingsForService(),
      forceRefresh: options?.forceRefresh === true,
      refreshDate: typeof options?.refreshDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(options.refreshDate)
        ? options.refreshDate
        : undefined
    })
  );
}

module.exports = { registerMarketIpc };
