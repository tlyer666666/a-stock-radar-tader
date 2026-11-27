import { createPreviewMarketMethods } from "./preview/mockMarketData";
import { createPreviewStrategyMethods } from "./preview/strategyPreview";
import { createPreviewAiAndWorkspaceMethods } from "./preview/aiPreview";
import { ALERT_TYPE_OPTIONS, defaultParams, type AlertRule, type AlertRulesRequest, type AlertRulesState } from "./features/collections/alertRulesModel";
import type { DecisionSignal, DecisionSignalList, SignalSummary } from "./features/ai-agent/decisionSignalModel";
import type { EtfRotationConfig, EtfRotationReport } from "./features/etf/etfRotationModel";
import { FACTOR_STRATEGY_OPTIONS, type FactorScreenResult } from "./features/strategy-selection/factorScreenModel";

const PREVIEW_INDUSTRIES: Record<string, string> = {
  "600519": "白酒",
  "000858": "白酒",
  "300750": "电池",
  "000001": "银行",
  "601318": "保险",
  "002594": "汽车整车"
};

const emptySignalSummary = (): SignalSummary => ({
  total: 0, completed: 0, hit: 0, miss: 0, neutral: 0, unable: 0,
  enough: false, minSample: 10, hitRatePct: null, avgReturnPct: null, maxAdversePct: null
});

const buildPreviewSignalList = (signals: DecisionSignal[]): DecisionSignalList => ({
  signals: structuredClone(signals),
  stats: {
    total: signals.length,
    active: signals.filter(item => item.status === "active").length,
    byDays: {
      "1": emptySignalSummary(),
      "3": emptySignalSummary(),
      "5": emptySignalSummary(),
      "10": emptySignalSummary()
    },
    byAction: {},
    feedback: {
      useful: signals.filter(item => item.feedback === "useful").length,
      notUseful: signals.filter(item => item.feedback === "not_useful").length
    },
    minSample: 10,
    hitPct: 1
  },
  evaluation: null
});

export function createPreviewApi(): Window["stockApi"] {
  const market = createPreviewMarketMethods();
  const strategy = createPreviewStrategyMethods();
  const aiAndWorkspace = createPreviewAiAndWorkspaceMethods();
  let previewRules: AlertRule[] = [];
  let previewRuleHistory: AlertRulesState["history"] = [];
  let previewLastRunAt = "";
  let previewFeeds: Array<{ id: string; name: string; url: string; enabled: boolean }> = [];
  let previewSignals: DecisionSignal[] = [];
  let previewAgentMemory = "";
  let previewAgentSkillIds: string[] = [];

  const alertTypes = Object.fromEntries(ALERT_TYPE_OPTIONS.map(item => [item.id, item.label]));
  const todayIso = () => new Date().toISOString();
  const todayCn = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  return {
    ...market,
    ...strategy,
    ...aiAndWorkspace,
    async getStockIndustries(codes: string[]) {
      const result: Record<string, string> = {};
      for (const raw of Array.isArray(codes) ? codes : []) {
        const code = String(raw || "").trim();
        if (PREVIEW_INDUSTRIES[code]) result[code] = PREVIEW_INDUSTRIES[code]!;
      }
      return result;
    },
    async alertRules(input: AlertRulesRequest = { op: "list" }): Promise<AlertRulesState> {
      const op = input?.op || "list";
      if (op === "save" && "rule" in input && input.rule) {
        const id = input.rule.id || `preview-rule-${Date.now()}-${previewRules.length + 1}`;
        const nextRule: AlertRule = {
          id,
          type: input.rule.type,
          scope: input.rule.scope || (input.rule.type === "market_light" ? "market" : "watchlist"),
          code: String(input.rule.code || ""),
          name: String(input.rule.name || ""),
          params: input.rule.params || defaultParams(input.rule.type),
          enabled: input.rule.enabled !== false,
          cooldownHours: Number.isFinite(Number(input.rule.cooldownHours)) ? Math.max(0, Math.min(240, Math.round(Number(input.rule.cooldownHours)))) : 24,
          createdAt: input.rule.createdAt || todayIso(),
          text: input.rule.text || `${alertTypes[input.rule.type] || input.rule.type}（浏览器预览）`
        };
        const exists = previewRules.some(item => item.id === id);
        previewRules = exists ? previewRules.map(item => item.id === id ? nextRule : item) : [...previewRules, nextRule];
      } else if (op === "remove" && "id" in input) {
        previewRules = previewRules.filter(item => item.id !== input.id);
      } else if (op === "clear") {
        previewRuleHistory = [];
      } else if (op === "dry" && "id" in input) {
        return {
          rules: structuredClone(previewRules),
          history: structuredClone(previewRuleHistory),
          lastRunAt: previewLastRunAt,
          types: alertTypes,
          dry: [{ ruleId: input.id, target: "浏览器预览", code: "", status: "not_triggered", detail: "浏览器预览不连接实时日线" }]
        };
      } else if (op === "run") {
        previewLastRunAt = todayIso();
        return {
          rules: structuredClone(previewRules),
          history: structuredClone(previewRuleHistory),
          lastRunAt: previewLastRunAt,
          types: alertTypes,
          run: { at: previewLastRunAt, triggered: 0, evaluated: previewRules.filter(item => item.enabled).length }
        };
      }
      return {
        rules: structuredClone(previewRules),
        history: structuredClone(previewRuleHistory),
        lastRunAt: previewLastRunAt,
        types: alertTypes
      };
    },
    async getEtfRotation(config: Partial<EtfRotationConfig> = {}): Promise<EtfRotationReport> {
      const pool = Array.isArray(config.pool) && config.pool.length ? config.pool.slice(0, 6) : ["510300", "510500", "159915", "512890", "513100", "518880"];
      const lookback = Number.isFinite(Number(config.lookback)) ? Math.max(5, Math.min(500, Math.round(Number(config.lookback)))) : 60;
      const topN = Number.isFinite(Number(config.topN)) ? Math.max(1, Math.min(pool.length, Math.round(Number(config.topN)))) : Math.min(2, pool.length);
      const rebalance = config.rebalance === "monthly" ? "monthly" : "weekly";
      const asOf = todayCn();
      return {
        config: { pool, safeAsset: "511880", lookback, rebalance, topN, bufferPct: 2, costBps: 10, years: 8 },
        warnings: ["浏览器预览使用演示数据，真实 ETF 双动量回测请在桌面版计算。"],
        asOf,
        generatedAt: todayIso(),
        signal: {
          asOf,
          holdings: [{ code: "513100", name: "纳指ETF", safe: false }],
          targets: [{ code: "513100", name: "纳指ETF", weightPct: 50 }],
          idleWeightPct: 50,
          idleTo: "银华日利（货币）",
          needRebalance: false,
          isRebalanceDay: false,
          ranking: [
            { code: "513100", name: "纳指ETF", momentumPct: 6.4, selected: true, positive: true },
            { code: "510300", name: "沪深300ETF", momentumPct: -1.8, selected: false, positive: false }
          ]
        },
        performance: null,
        yearly: [],
        sweep: [],
        rebalances: [],
        rebalanceCount: 0,
        curve: []
      };
    },
    async screenFactors(input: { strategyId?: string; top?: number } = {}): Promise<FactorScreenResult> {
      const picked = FACTOR_STRATEGY_OPTIONS.find(item => item.id === input?.strategyId) || FACTOR_STRATEGY_OPTIONS[0];
      return {
        strategy: { id: picked.id, name: picked.name, summary: picked.summary, weights: [{ id: "roe", label: "ROE", weight: 50, higher: true }, { id: "pe", label: "滚动市盈率", weight: 50, higher: false }] },
        strategies: FACTOR_STRATEGY_OPTIONS.map(item => ({ id: item.id, name: item.name, summary: item.summary })),
        reportPeriod: "预览",
        generatedAt: todayIso(),
        warnings: ["浏览器预览不拉取全市场财务报表与行情，请在桌面版运行多因子选股。"],
        note: "浏览器预览模式仅展示结构，不产生真实选股结果。",
        funnel: { universe: 0, tradable: 0, passedFilters: 0, scored: 0, candidates: 0, barsFailed: 0, qualified: 0 },
        picks: []
      };
    },
    ...(aiAndWorkspace.ai ? {
      ai: {
        ...aiAndWorkspace.ai,
        agent: {
          async state(): Promise<AgentState> {
            return {
              configured: false,
              model: "",
              profileName: "",
              profileId: "",
              activeProfileId: "",
              profiles: [],
              memory: previewAgentMemory,
              conversations: [],
              tools: [],
              skillIds: [...previewAgentSkillIds]
            };
          },
          async conversation(): Promise<AgentConversation | null> { return null; },
          async start(): Promise<never> { throw new Error("浏览器预览不调用 AI 问股，请在桌面版使用"); },
          async poll(): Promise<never> { throw new Error("浏览器预览不调用 AI 问股，请在桌面版使用"); },
          async cancel(): Promise<null> { return null; },
          async remove(): Promise<AgentState> {
            return { configured: false, model: "", profileName: "", profileId: "", activeProfileId: "", profiles: [], memory: previewAgentMemory, conversations: [], tools: [], skillIds: [...previewAgentSkillIds] };
          },
          async settings(input: { memory?: string; profileId?: string; skillIds?: string[] }): Promise<AgentState> {
            if (typeof input.memory === "string") previewAgentMemory = input.memory;
            if (Array.isArray(input.skillIds)) previewAgentSkillIds = [...input.skillIds];
            return { configured: false, model: "", profileName: "", profileId: "", activeProfileId: "", profiles: [], memory: previewAgentMemory, conversations: [], tools: [], skillIds: [...previewAgentSkillIds] };
          },
          async feeds(input = { op: "list" }) {
            const op = input?.op || "list";
            if (op === "save" && input.url) {
              const id = input.id || `preview-feed-${Date.now()}-${previewFeeds.length + 1}`;
              const next = { id, name: (input.name || "").trim() || input.url.replace(/^https?:\/\//i, "").slice(0, 20), url: input.url.trim(), enabled: input.enabled !== false };
              const exists = previewFeeds.some(item => item.id === id);
              previewFeeds = exists ? previewFeeds.map(item => item.id === id ? next : item) : [...previewFeeds, next].slice(0, 12);
            } else if (op === "remove" && input.id) {
              previewFeeds = previewFeeds.filter(item => item.id !== input.id);
            } else if (op === "test") {
              return { feeds: structuredClone(previewFeeds), maxFeeds: 12, test: { count: 0, sample: ["浏览器预览不发起外部 RSS 请求"] } };
            }
            return { feeds: structuredClone(previewFeeds), maxFeeds: 12 };
          },
          async signals(input = {}) {
            const filtered = previewSignals.filter(item => {
              if (input.status && item.status !== input.status) return false;
              if (input.code && item.code !== input.code) return false;
              return true;
            });
            return buildPreviewSignalList(filtered);
          },
          async updateSignal(input) {
            if (input.remove) {
              previewSignals = previewSignals.filter(item => item.id !== input.id);
            } else {
              previewSignals = previewSignals.map(item => {
                if (item.id !== input.id) return item;
                return {
                  ...item,
                  ...(input.status ? { status: input.status } : {}),
                  ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
                  updatedAt: todayIso()
                };
              });
            }
            return buildPreviewSignalList(previewSignals);
          }
        }
      }
    } : {})
  };
}
