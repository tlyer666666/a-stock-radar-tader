"use strict";

/**
 * Canonical Electron IPC channel registry & boundary payload validator.
 * Kept in sync with src/shared/ipc-contract.ts, electron/preload.cjs, and
 * electron/review-preload.cjs via electron/ipc-contract.test.cjs.
 */

const MAIN_IPC_CHANNELS = Object.freeze([
  "agent:cancel",
  "agent:conversation",
  "agent:delete",
  "agent:feeds",
  "agent:poll",
  "agent:settings",
  "agent:signal-update",
  "agent:signals",
  "agent:skill-delete",
  "agent:skill-save",
  "agent:start",
  "agent:state",
  "agent:sync-workspace",
  "ai:cached",
  "ai:custom-cached",
  "ai:custom-list",
  "ai:custom-mutate",
  "ai:custom-rank",
  "ai:custom-save",
  "ai:framework-save",
  "ai:frameworks",
  "ai:history",
  "ai:history-day",
  "ai:interpret",
  "ai:interpret-cached",
  "ai:lookback",
  "ai:market-review",
  "ai:market-review-cached",
  "ai:note-parse",
  "ai:outcomes-leaderboard",
  "ai:profile-activate",
  "ai:profile-delete",
  "ai:profile-save",
  "ai:profiles",
  "ai:rank",
  "ai:rank-models",
  "ai:review",
  "ai:review-cached",
  "ai:status",
  "ai:strategy-draft",
  "ai:summary",
  "ai:test",
  "alerts:rules",
  "app:notify",
  "app:set-theme",
  "app:set-zoom",
  "app:version",
  "app:window-control",
  "backtest:run",
  "backtest:run-portfolio",
  "backup:cancel-restore",
  "backup:choose-folder",
  "backup:configure",
  "backup:inspect",
  "backup:prepare-restore",
  "backup:restore",
  "backup:run",
  "backup:status",
  "bond:list",
  "diagnostics:corrupted-on-load",
  "etf:list",
  "etf:rotation",
  "holdings:get",
  "holdings:save",
  "market:analyze",
  "market:analyze-sector",
  "market:batch-quotes",
  "market:chart",
  "market:concept-chain",
  "market:federation",
  "market:index-board",
  "market:index-stream",
  "market:industries",
  "market:limit-ecology",
  "market:limit-up-sectors",
  "market:limit-ups",
  "market:previous-limit-up-failed-boards",
  "market:quote",
  "market:recent-limit-ups",
  "market:seal-stream",
  "market:search",
  "market:search-sectors",
  "market:sector-limit-count",
  "market:sector-strength",
  "market:source-health",
  "market:source-reset",
  "news:analyze-impact",
  "news:get-feed",
  "news:refresh",
  "notes:interval-sync",
  "notes:watch-sync",
  "review:get-market",
  "review:open-window",
  "screen:factors",
  "sector:cancel",
  "sector:catalog",
  "sector:classifications",
  "sector:detail",
  "sector:quotes",
  "security:master-clear",
  "security:master-set",
  "security:master-status",
  "security:master-unlock",
  "service:cancel",
  "settings:get",
  "settings:save",
  "settings:test-provider",
  "shell:open-external",
  "storage:cleanup",
  "storage:kv-get",
  "storage:kv-set",
  "strategy:custom:delete",
  "strategy:custom:import-settings",
  "strategy:custom:list",
  "strategy:custom:save",
  "strategy:definitions",
  "strategy:external-archive",
  "strategy:leaderboard",
  "strategy:scan",
  "ths-web:bounds",
  "ths-web:command",
  "ths-web:hide",
  "ths-web:show",
  "ths-web:state",
  "trend-screener:cancel",
  "trend-screener:execution-check",
  "trend-screener:research",
  "trend-screener:start",
  "trend-screener:status",
  "watchlist:get",
  "watchlist:save"
]);

const REVIEW_IPC_CHANNELS = Object.freeze([
  "review-window:analyze",
  "review-window:market",
  "review-window:search",
  "review-window:theme"
]);

const IPC_EVENT_CHANNELS = Object.freeze([
  "ai:stream",
  "app:notification-clicked",
  "market:index-tick",
  "market:seal-tick",
  "review-window:theme-changed"
]);

const ALL_IPC_CHANNELS = Object.freeze([...MAIN_IPC_CHANNELS, ...REVIEW_IPC_CHANNELS]);

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isOptionalPlainObject = value => value === undefined || value === null || isPlainObject(value);
const isSecurityOrText = value => typeof value === "string" || isPlainObject(value);
const isOptionalText = value => value === undefined || value === null || typeof value === "string";

function invalidPayload(message) {
  return Object.assign(new TypeError(message), { code: "INVALID_IPC_PAYLOAD" });
}

const VALIDATORS = new Map([
  ["watchlist:save", args => Array.isArray(args[0]) ? null : "观察池保存参数必须为数组"],
  ["holdings:save", args => Array.isArray(args[0]) ? null : "持仓保存参数必须为数组"],
  ["ai:custom-save", args => Array.isArray(args[0]) ? null : "自选股票列表必须为数组"],
  ["ai:rank-models", args => (args[0] === undefined || Array.isArray(args[0])) ? null : "模型筛选参数必须为数组"],
  ["strategy:custom:save", args => isPlainObject(args[0]) ? null : "策略保存参数无效"],
  ["strategy:custom:delete", args => (typeof args[0] === "string" && args[0].length > 0 && args[0].length <= 128) ? null : "策略编号无效"],
  ["service:cancel", args => (typeof args[0] === "string" && args[0].trim().length > 0 && args[0].length <= 256) ? null : "任务编号无效"],
  ["news:analyze-impact", args => (isPlainObject(args[0]) && isPlainObject(args[0].item)) ? null : "请提供要分析的资讯或公告条目"],
  ["ai:interpret", args => isPlainObject(args[0]) ? null : "AI 解读参数无效"],
  ["ai:custom-mutate", args => isPlainObject(args[0]) ? null : "股票清单操作无效"],
  ["shell:open-external", args => typeof args[0] === "string" ? null : "外部链接参数必须为字符串"],
  ["app:window-control", args => typeof args[0] === "string" ? null : "窗口操作参数无效"],
  ["app:set-theme", args => typeof args[0] === "string" ? null : "主题参数必须为字符串"],
  ["app:set-zoom", args => (typeof args[0] === "number" && Number.isFinite(args[0])) ? null : "缩放倍率参数无效"],
  ["security:master-set", args => isPlainObject(args[0]) ? null : "主密码设置参数无效"],
  ["security:master-unlock", args => (isPlainObject(args[0]) || typeof args[0] === "string") ? null : "主密码解锁参数无效"],
  ["security:master-clear", args => (isOptionalPlainObject(args[0]) || typeof args[0] === "string") ? null : "主密码清除参数无效"],
  ["storage:cleanup", args => isPlainObject(args[0]) ? null : "存储清理参数无效"],
  ["storage:kv-get", args => (typeof args[0] === "string" && args[0].trim().length > 0 && args[0].length <= 128) ? null : "键值读取键名无效"],
  ["storage:kv-set", args => (isPlainObject(args[0]) && typeof args[0].key === "string" && args[0].key.trim().length > 0 && args[0].key.length <= 128 && typeof args[0].value === "string") ? null : "键值写入参数无效"],
  ["market:analyze", args => (isSecurityOrText(args[0]) && isOptionalPlainObject(args[1])) ? null : "个股分析参数无效"],
  ["market:quote", args => isSecurityOrText(args[0]) ? null : "行情请求标的参数无效"],
  ["market:federation", args => isSecurityOrText(args[0]) ? null : "多源融合请求参数无效"],
  ["market:chart", args => (isSecurityOrText(args[0]) && (isOptionalText(args[1]) || typeof args[1] === "number") && isOptionalPlainObject(args[2])) ? null : "图表请求参数无效"],
  ["market:recent-limit-ups", args => ((args[0] === undefined || (typeof args[0] === "number" && Number.isFinite(args[0]))) && isOptionalPlainObject(args[1])) ? null : "近期涨停参数无效"],
  ["market:sector-limit-count", args => ((args[0] === undefined || args[0] === null || isPlainObject(args[0])) && isOptionalPlainObject(args[1])) ? null : "板块涨停计数参数无效"],
  ["market:concept-chain", args => (args[0] === undefined || typeof args[0] === "string" || isPlainObject(args[0])) ? null : "概念产业链查询参数无效"],
  ["backtest:run", args => ((args[0] === undefined || isSecurityOrText(args[0])) && isOptionalPlainObject(args[1])) ? null : "单股回测参数无效"],
  ["backtest:run-portfolio", args => isOptionalPlainObject(args[0]) ? null : "组合回测参数必须为对象"],
  ["backup:prepare-restore", args => (isOptionalText(args[0]) && isOptionalText(args[1])) ? null : "恢复准备参数无效"],
  ["backup:restore", args => typeof args[0] === "string" ? null : "恢复令牌必须为字符串"],
  ["backup:cancel-restore", args => (args[0] === undefined || typeof args[0] === "string") ? null : "取消恢复令牌必须为字符串"],
  ["backup:inspect", args => (isOptionalText(args[0]) && isOptionalText(args[1])) ? null : "备份校验参数无效"],
  ["backup:run", args => (isOptionalPlainObject(args[0]) && isOptionalPlainObject(args[1])) ? null : "备份执行参数无效"],
  ["market:search", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 120) ? null : "证券搜索关键词无效"],
  ["market:search-sectors", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 120) ? null : "板块搜索关键词无效"],
  ["market:analyze-sector", args => (args[0] === undefined || args[0] === null || isSecurityOrText(args[0])) ? null : "板块分析参数无效"],
  ["market:seal-stream", args => {
    const input = args[0];
    if (!isPlainObject(input)) return "封单订阅参数无效";
    if (input.owner !== undefined && (typeof input.owner !== "string" || input.owner.length > 24)) return "封单订阅参数无效";
    if (input.codes !== undefined && !(Array.isArray(input.codes) && input.codes.length <= 300 && input.codes.every(code => typeof code === "string" && /^\d{6}$/.test(code)))) return "封单订阅代码无效";
    return null;
  }],
  ["market:industries", args => (Array.isArray(args[0]) && args[0].length <= 300 && args[0].every(code => typeof code === "string" && /^\d{6}$/.test(code))) ? null : "行业查询参数无效"],
  ["market:batch-quotes", args => (Array.isArray(args[0]) && args[0].length <= 1200 && args[0].every(item => isPlainObject(item) && typeof item.code === "string" && /^\d{6}$/.test(item.code))) ? null : "批量行情参数无效"],
  ["sector:cancel", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 256) ? null : "板块取消请求编号无效"],
  ["review-window:search", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 120) ? null : "复盘搜索关键词无效"],
  ["review-window:analyze", args => (isSecurityOrText(args[0]) && isOptionalPlainObject(args[1])) ? null : "复盘分析标的参数无效"],
  ["ai:review-cached", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 40) ? null : "点评缓存股票代码无效"],
  ["ai:history-day", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 40) ? null : "AI 历史日期参数无效"],
  ["ai:market-review-cached", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 40) ? null : "AI 复盘缓存日期无效"],
  ["ai:profile-activate", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 128) ? null : "AI 配置编号无效"],
  ["ai:profile-delete", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 128) ? null : "AI 配置编号无效"],
  ["agent:conversation", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 128) ? null : "对话编号无效"],
  ["agent:poll", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 128) ? null : "运行编号无效"],
  ["agent:cancel", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 128) ? null : "运行编号无效"],
  ["agent:delete", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 128) ? null : "对话编号无效"],
  ["agent:skill-delete", args => (isOptionalText(args[0]) && String(args[0] ?? "").length <= 128) ? null : "技能编号无效"],
  ["trend-screener:status", args => (args[0] === undefined || args[0] === null || isPlainObject(args[0]) || typeof args[0] === "string" || typeof args[0] === "number") ? null : "趋势扫描状态游标无效"],
  ["alerts:rules", args => {
    const input = args[0];
    if (input === undefined || input === null) return null;
    if (!isPlainObject(input)) return "指标预警参数必须为对象";
    if (input.op !== undefined && !["list", "save", "remove", "run", "dry", "clear"].includes(input.op)) return "指标预警操作类型无效";
    if (input.id !== undefined && (typeof input.id !== "string" || input.id.length > 64)) return "指标预警规则编号无效";
    if (input.rule !== undefined && !isPlainObject(input.rule)) return "指标预警规则对象无效";
    if (input.op === "save" && !isPlainObject(input.rule)) return "指标预警保存缺少规则对象";
    // 试跑和删除必须指明规则：没有编号的「试跑」会被当成一次真实评估（发通知、记历史）。
    if ((input.op === "dry" || input.op === "remove") && !(typeof input.id === "string" && input.id.trim())) return "指标预警操作缺少规则编号";
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || input.requestId.length > 128)) return "请求编号无效";
    return null;
  }],
  ["etf:rotation", args => {
    const input = args[0];
    if (input === undefined || input === null) return null;
    if (!isPlainObject(input)) return "ETF 轮动参数必须为对象";
    if (input.pool !== undefined) {
      const okStr = typeof input.pool === "string" && input.pool.length <= 300;
      const okArr = Array.isArray(input.pool) && input.pool.length <= 20 && input.pool.every(item => typeof item === "string" && item.length <= 16);
      if (!okStr && !okArr) return "ETF 轮动风险池参数无效";
    }
    if (input.safeAsset !== undefined && (typeof input.safeAsset !== "string" || input.safeAsset.length > 16)) return "防守资产代码无效";
    if (input.rebalance !== undefined && !["weekly", "monthly"].includes(input.rebalance)) return "调仓周期参数无效";
    for (const [field, low, high] of [["lookback", 5, 500], ["topN", 1, 10], ["bufferPct", 0, 20], ["costBps", 0, 100], ["years", 1, 15]]) {
      const value = input[field];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high)) return `ETF 轮动参数 ${field} 超出范围`;
    }
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || input.requestId.length > 128)) return "请求编号无效";
    return null;
  }],
  ["screen:factors", args => {
    const input = args[0];
    if (input === undefined || input === null) return null;
    if (!isPlainObject(input)) return "多因子选股参数必须为对象";
    if (input.strategyId !== undefined && (typeof input.strategyId !== "string" || input.strategyId.length > 40)) return "多因子策略编号无效";
    if (input.top !== undefined && (typeof input.top !== "number" || !Number.isFinite(input.top) || input.top < 1 || input.top > 50)) return "多因子返回数量必须在 1 到 50 之间";
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || input.requestId.length > 128)) return "请求编号无效";
    return null;
  }],
  ["agent:feeds", args => {
    const input = args[0];
    if (input === undefined || input === null) return null;
    if (!isPlainObject(input)) return "自订资讯源参数必须为对象";
    if (input.op !== undefined && !["list", "save", "remove", "test"].includes(input.op)) return "自订资讯源操作类型无效";
    if (input.id !== undefined && (typeof input.id !== "string" || input.id.length > 64)) return "自订资讯源编号无效";
    if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 80)) return "自订资讯源名称无效";
    if (input.url !== undefined && (typeof input.url !== "string" || input.url.length > 500)) return "自订资讯源地址无效";
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") return "自订资讯源启用开关无效";
    return null;
  }],
  ["agent:signals", args => {
    const input = args[0];
    if (input === undefined || input === null) return null;
    if (!isPlainObject(input)) return "AI 建议池查询参数必须为对象";
    if (input.status !== undefined && !["", "active", "expired", "invalidated", "closed"].includes(input.status)) return "AI 建议状态筛选无效";
    if (input.code !== undefined && (typeof input.code !== "string" || (input.code !== "" && !/^\d{6}$/.test(input.code)))) return "AI 建议股票代码无效";
    if (input.evaluate !== undefined && typeof input.evaluate !== "boolean") return "AI 建议验证参数无效";
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || input.requestId.length > 128)) return "请求编号无效";
    return null;
  }],
  ["agent:signal-update", args => {
    const input = args[0];
    if (!isPlainObject(input)) return "AI 建议更新参数必须为对象";
    if (typeof input.id !== "string" || !input.id.trim() || input.id.length > 64) return "AI 建议编号无效";
    if (input.status !== undefined && !["closed", "invalidated"].includes(input.status)) return "AI 建议状态无效";
    if (input.feedback !== undefined && input.feedback !== null && !["useful", "not_useful"].includes(input.feedback)) return "AI 建议反馈值无效";
    if (input.remove !== undefined && typeof input.remove !== "boolean") return "AI 建议删除参数无效";
    return null;
  }]
]);

const NO_ARG_CHANNELS = new Set([
  "agent:state",
  "ai:custom-cached",
  "ai:custom-list",
  "ai:frameworks",
  "ai:history",
  "ai:profiles",
  "ai:status",
  "app:version",
  "backup:choose-folder",
  "backup:status",
  "diagnostics:corrupted-on-load",
  "holdings:get",
  "market:source-health",
  "market:source-reset",
  "review:open-window",
  "review-window:theme",
  "security:master-status",
  "settings:get",
  "strategy:custom:import-settings",
  "strategy:custom:list",
  "strategy:definitions",
  "strategy:external-archive",
  "ths-web:hide",
  "ths-web:state",
  "trend-screener:cancel",
  "watchlist:get"
]);

const OPTIONAL_OBJECT_CHANNELS = new Set([
  "bond:list",
  "etf:list",
  "market:index-board",
  "market:index-stream",
  "ths-web:show",
  "ths-web:bounds",
  "ths-web:command",
  "ai:rank",
  "ai:summary",
  "ai:cached",
  "ai:market-review",
  "ai:lookback",
  "ai:interpret-cached",
  "ai:framework-save",
  "ai:outcomes-leaderboard",
  "ai:review",
  "ai:custom-rank",
  "ai:strategy-draft",
  "ai:note-parse",
  "ai:profile-save",
  "ai:test",
  "agent:start",
  "agent:settings",
  "agent:skill-save",
  "agent:sync-workspace",
  "market:limit-ecology",
  "market:limit-ups",
  "market:previous-limit-up-failed-boards",
  "strategy:scan",
  "sector:classifications",
  "sector:catalog",
  "sector:quotes",
  "sector:detail",
  "trend-screener:research",
  "trend-screener:execution-check",
  "trend-screener:start",
  "market:limit-up-sectors",
  "market:sector-strength",
  "strategy:leaderboard",
  "review:get-market",
  "review-window:market",
  "news:get-feed",
  "news:refresh",
  "settings:save",
  "settings:test-provider",
  "notes:interval-sync",
  "notes:watch-sync",
  "backup:configure",
  "app:notify"
]);

function validateIpcPayload(channel, args = []) {
  const custom = VALIDATORS.get(channel);
  if (custom) {
    const reason = custom(args);
    if (reason) throw invalidPayload(reason);
    return;
  }
  if (OPTIONAL_OBJECT_CHANNELS.has(channel) && !isOptionalPlainObject(args[0])) {
    throw invalidPayload(`${channel} 参数必须为对象`);
  }
  if (NO_ARG_CHANNELS.has(channel) && args.some(arg => arg !== undefined)) {
    throw invalidPayload(`${channel} 不接受多余调用参数`);
  }
}

module.exports = {
  MAIN_IPC_CHANNELS,
  REVIEW_IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  ALL_IPC_CHANNELS,
  VALIDATED_CHANNELS: new Set([...VALIDATORS.keys(), ...OPTIONAL_OBJECT_CHANNELS, ...NO_ARG_CHANNELS]),
  VALIDATORS,
  OPTIONAL_OBJECT_CHANNELS,
  NO_ARG_CHANNELS,
  validateIpcPayload,
  invalidPayload
};
