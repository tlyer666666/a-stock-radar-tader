import type { SavedTrendPlan } from "../../trendWorkspace";
import type { StockMonitorConfig, StockMonitorEvaluation } from "../../stockMonitorRules";
import type { TItem } from "../t-assistant/tStore";
import type { TRuntime } from "../t-assistant/useTAssistant";
import type { MarketSessionPhase } from "../../copilotBriefing";
import { isTradingDay } from "../notes/notesModel";
import { inferSecid } from "../../domain/securityIdentifiers";

export type CockpitSessionMode = "preopen" | "intraday" | "afterclose";

export type CockpitQuote = {
  code: string;
  name?: string | undefined;
  price?: number | null | undefined;
  latest?: number | null | undefined;
  changePct?: number | null | undefined;
  open?: number | null | undefined;
  high?: number | null | undefined;
  low?: number | null | undefined;
  prevClose?: number | null | undefined;
  volume?: number | null | undefined;
  amount?: number | null | undefined;
  updatedAt?: string | undefined;
};

export type UnifiedSentinelRow = {
  code: string;
  name: string;
  secid: string;
  roles: string[];
  latestPrice: number | null;
  changePct: number | null;
  planStop: number | null;
  planBandLabel: string;
  monitorSummary: string;
  monitorTone: "ok" | "warn" | "alert" | "";
  tSummary: string;
  tTone: "buy" | "sell" | "wait" | "";
  paperSummary: string;
  holdingPnlPct: number | null;
  priority: number;
};

export type PlanReconciliationRow = {
  plan: SavedTrendPlan;
  latestPrice: number | null;
  changePct: number | null;
  planBaseline: number | null;
  diffFromEntryPct: number | null;
  status: "stop-hit" | "above-band" | "in-band" | "below-band" | "pending";
  statusLabel: string;
  detail: string;
};

const toNum = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const toSignedNum = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function resolveDefaultCockpitMode(
  phase: Pick<MarketSessionPhase, "id">,
  now = Date.now()
): CockpitSessionMode {
  if (phase.id === "intraday" || phase.id === "midday") return "intraday";
  if (phase.id === "afterclose") return "afterclose";
  if (phase.id === "preopen") return "preopen";
  const cn = new Date(now + 8 * 3600_000);
  const date = cn.toISOString().slice(0, 10);
  const minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  if (isTradingDay(date) && minute < 9 * 60 + 30) return "preopen";
  return "afterclose";
}

export function buildUnifiedSentinels(input: {
  holdings: HoldingItem[];
  favorites: WatchItem[];
  openPaperPositions: Array<{
    code: string;
    name: string;
    secid?: string;
    entryPrice: number;
    latestPrice: number;
    shares: number;
    stopPrice?: number;
    takePrice?: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
  }>;
  plans: SavedTrendPlan[];
  tItems: TItem[];
  tRuntimes: Record<string, TRuntime>;
  monitorConfigs: Record<string, StockMonitorConfig>;
  monitorRuntimes: Record<string, StockMonitorEvaluation>;
  monitorQuotes: Record<string, Record<string, unknown>>;
  liveQuotes: Record<string, CockpitQuote>;
}): UnifiedSentinelRow[] {
  const map = new Map<string, UnifiedSentinelRow>();
  const ensure = (code: string, name: string, secid?: string): UnifiedSentinelRow => {
    const cleanCode = String(code || "").trim();
    let row = map.get(cleanCode);
    if (!row) {
      const q = input.liveQuotes[cleanCode] || input.monitorQuotes[cleanCode];
      const latestPrice = toNum(q?.latest ?? q?.price);
      const changePct = toSignedNum(q?.changePct);
      row = {
        code: cleanCode,
        name: String(name || q?.name || cleanCode),
        secid: String(secid || inferSecid(cleanCode)),
        roles: [],
        latestPrice,
        changePct,
        planStop: null,
        planBandLabel: "",
        monitorSummary: "",
        monitorTone: "",
        tSummary: "",
        tTone: "",
        paperSummary: "",
        holdingPnlPct: null,
        priority: 0
      };
      map.set(cleanCode, row);
    } else if ((!row.name || row.name === row.code) && name) {
      row.name = name;
    }
    return row;
  };

  for (const h of input.holdings) {
    if (!/^\d{6}$/.test(h.code)) continue;
    const row = ensure(h.code, h.name, h.secid);
    if (!row.roles.includes("持仓")) row.roles.push("持仓");
    row.priority += 30;
    const cost = toNum(h.costPrice);
    if (cost && row.latestPrice) {
      row.holdingPnlPct = Math.round(((row.latestPrice - cost) / cost) * 10000) / 100;
    }
  }

  for (const pos of input.openPaperPositions) {
    if (!/^\d{6}$/.test(pos.code)) continue;
    const row = ensure(pos.code, pos.name, pos.secid);
    if (!row.roles.includes("模拟")) row.roles.push("模拟");
    if (!row.latestPrice && toNum(pos.latestPrice)) row.latestPrice = toNum(pos.latestPrice);
    const stop = toNum(pos.stopPrice ?? pos.stopLossPrice);
    const take = toNum(pos.takePrice ?? pos.takeProfitPrice);
    const pnlPct = pos.entryPrice > 0 && row.latestPrice
      ? ((row.latestPrice - pos.entryPrice) / pos.entryPrice) * 100
      : null;
    const parts: string[] = [];
    if (pnlPct !== null) parts.push(`浮盈亏 ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`);
    if (stop) parts.push(`止损 ${stop.toFixed(2)}`);
    if (take) parts.push(`止盈 ${take.toFixed(2)}`);
    row.paperSummary = parts.join(" · ");
    if (row.latestPrice && stop && row.latestPrice <= stop * 1.015) row.priority += 45;
    else row.priority += 25;
  }

  for (const plan of input.plans) {
    if (plan.archivedAt) continue;
    const code = plan.candidate?.security?.code || "";
    if (!/^\d{6}$/.test(code)) continue;
    const row = ensure(code, plan.candidate.security.name, plan.candidate.security.secid);
    if (!row.roles.includes("计划")) row.roles.push("计划");
    row.priority += 22;
    const p = plan.candidate.plan;
    if (p) {
      row.planStop = toNum(p.stop);
      const minE = toNum(p.minEntry);
      const maxE = toNum(p.maxEntry);
      if (minE && maxE) row.planBandLabel = `${minE.toFixed(2)}~${maxE.toFixed(2)} / 损 ${p.stop.toFixed(2)}`;
      else if (maxE) row.planBandLabel = `≤${maxE.toFixed(2)} / 损 ${p.stop.toFixed(2)}`;
      if (row.latestPrice && p.stop > 0 && row.latestPrice <= p.stop * 1.02) row.priority += 35;
    }
  }

  for (const t of input.tItems) {
    if (!/^\d{6}$/.test(t.code)) continue;
    const row = ensure(t.code, t.name, t.secid);
    if (!row.roles.includes("做T")) row.roles.push("做T");
    row.priority += 18;
    const rt = input.tRuntimes[t.code];
    const sig = rt?.analysis?.signal;
    if (sig && sig.action !== "wait") {
      row.tSummary = `${sig.title} ${sig.shares ? `${sig.shares}股` : ""}@${sig.price.toFixed(2)}`;
      row.tTone = sig.action === "buy" || sig.action === "buyBack" || sig.action === "closeSellBack" || sig.action === "stopSellBack"
        ? "buy"
        : "sell";
      row.priority += 40;
    } else if (rt?.analysis) {
      row.tSummary = `可卖 ${t.config.sellableShares}股 · 偏离 ${rt.analysis.deviationPct >= 0 ? "+" : ""}${rt.analysis.deviationPct.toFixed(2)}%`;
      row.tTone = "wait";
    }
  }

  for (const fav of input.favorites) {
    if (!/^\d{6}$/.test(fav.code)) continue;
    const row = ensure(fav.code, fav.name, fav.secid);
    if (!row.roles.includes("自选")) row.roles.push("自选");
    row.priority += 6;
  }

  for (const [code, cfg] of Object.entries(input.monitorConfigs)) {
    if (!cfg || !/^\d{6}$/.test(code)) continue;
    const row = map.get(code);
    if (!row) continue;
    if (!row.roles.includes("盯盘")) row.roles.push("盯盘");
    const evalRt = input.monitorRuntimes[code];
    if (evalRt?.status === "triggered") {
      row.monitorSummary = evalRt.detail || "盯盘条件触发";
      row.monitorTone = "alert";
      row.priority += 50;
    } else if (evalRt?.detail) {
      row.monitorSummary = evalRt.detail;
      row.monitorTone = evalRt.status === "watching" ? "ok" : "warn";
      row.priority += 10;
    }
  }

  return [...map.values()].sort(
    (a, b) => b.priority - a.priority || Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0) || a.code.localeCompare(b.code)
  );
}

export function reconcilePlansAfterClose(
  plans: SavedTrendPlan[],
  quotes: Record<string, CockpitQuote>
): PlanReconciliationRow[] {
  return plans
    .filter(plan => !plan.archivedAt)
    .map(plan => {
      const code = plan.candidate.security.code;
      const q = quotes[code];
      const latestPrice = toNum(q?.latest ?? q?.price);
      const changePct = toSignedNum(q?.changePct);
      const p = plan.candidate.plan;
      const minE = toNum(p?.minEntry) ?? toNum(p?.maxEntry);
      const maxE = toNum(p?.maxEntry) ?? minE;
      const stop = toNum(p?.stop);
      const trigger = toNum(plan.candidate.setup?.triggerPrice);
      const planBaseline = maxE || trigger || toNum(plan.candidate.metrics?.close);

      if (!latestPrice) {
        return {
          plan,
          latestPrice: null,
          changePct,
          planBaseline,
          diffFromEntryPct: null,
          status: "pending",
          statusLabel: "待刷新收盘价",
          detail: "点击右上刷新报价后自动对照计划执行区与止损线"
        };
      }

      const diffFromEntryPct = planBaseline
        ? Math.round(((latestPrice - planBaseline) / planBaseline) * 10000) / 100
        : null;

      if (stop && latestPrice <= stop) {
        return {
          plan,
          latestPrice,
          changePct,
          planBaseline,
          diffFromEntryPct,
          status: "stop-hit",
          statusLabel: "触发止损位",
          detail: `现价 ${latestPrice.toFixed(2)} 已跌破预设止损 ${stop.toFixed(2)}，应核对失效纪律`
        };
      }
      if (minE && maxE && latestPrice >= minE && latestPrice <= maxE) {
        return {
          plan,
          latestPrice,
          changePct,
          planBaseline,
          diffFromEntryPct,
          status: "in-band",
          statusLabel: "处于买点区间",
          detail: `现价落在预设买点区间 ${minE.toFixed(2)}~${maxE.toFixed(2)} 内`
        };
      }
      if (maxE && latestPrice > maxE) {
        return {
          plan,
          latestPrice,
          changePct,
          planBaseline,
          diffFromEntryPct,
          status: "above-band",
          statusLabel: "高于上限/已启动",
          detail: `较买点上限 ${maxE.toFixed(2)} 高出 ${diffFromEntryPct !== null ? `${diffFromEntryPct.toFixed(1)}%` : "--"}`
        };
      }
      if (minE && latestPrice < minE) {
        return {
          plan,
          latestPrice,
          changePct,
          planBaseline,
          diffFromEntryPct,
          status: "below-band",
          statusLabel: "回落接近防守",
          detail: stop ? `距离止损 ${stop.toFixed(2)} 还有 ${(((latestPrice - stop) / stop) * 100).toFixed(1)}% 缓冲` : "低于计划入场下限"
        };
      }
      return {
        plan,
        latestPrice,
        changePct,
        planBaseline,
        diffFromEntryPct,
        status: "pending",
        statusLabel: "已跟踪",
        detail: `现价 ${latestPrice.toFixed(2)}`
      };
    });
}

export type PreopenAuctionRow = {
  code: string;
  name: string;
  secid: string;
  isHolding: boolean;
  hasPlan: boolean;
  hasMonitor: boolean;
  latestPrice: number | null;
  referencePrice: number | null;
  changePct: number | null;
  planStop: number | null;
  gapTone: "chase-warn" | "weak-alert" | "stop-hit" | "in-band" | "neutral";
  gapLabel: string;
};

export type MorningPriorityItem = {
  id: string;
  tag: string;
  tone: "danger" | "warn" | "good" | "muted";
  title: string;
  detail: string;
  actionLabel?: string | undefined;
  actionKind: "enable-batch-stop" | "open-stock" | "navigate";
  stock?: { code: string; name: string; secid?: string | undefined } | undefined;
  targetView?: string | undefined;
};

export function buildPreopenAuctionRows(input: {
  holdings: HoldingItem[];
  plans: SavedTrendPlan[];
  monitorConfigs: Record<string, StockMonitorConfig>;
  quotes: Record<string, CockpitQuote>;
}): PreopenAuctionRow[] {
  const byCode = new Map<string, {
    code: string;
    name: string;
    secid: string;
    isHolding: boolean;
    holdingCost: number | null;
    plan: SavedTrendPlan | null;
  }>();

  for (const h of input.holdings) {
    if (!/^\d{6}$/.test(h.code)) continue;
    byCode.set(h.code, {
      code: h.code,
      name: h.name || h.code,
      secid: h.secid || inferSecid(h.code),
      isHolding: true,
      holdingCost: toNum(h.costPrice),
      plan: null
    });
  }

  for (const plan of input.plans) {
    if (plan.archivedAt) continue;
    const sec = plan.candidate?.security;
    if (!sec?.code || !/^\d{6}$/.test(sec.code)) continue;
    const existing = byCode.get(sec.code);
    byCode.set(sec.code, {
      code: sec.code,
      name: sec.name || existing?.name || sec.code,
      secid: sec.secid || existing?.secid || inferSecid(sec.code),
      isHolding: Boolean(existing?.isHolding),
      holdingCost: existing?.holdingCost ?? null,
      plan
    });
  }

  const rows: PreopenAuctionRow[] = [];
  for (const item of byCode.values()) {
    const q = input.quotes[item.code];
    const latestPrice = toNum(q?.latest ?? q?.price);
    const changePct = toSignedNum(q?.changePct);
    const planStop = toNum(item.plan?.candidate?.plan?.stop);
    const minEntry = toNum(item.plan?.candidate?.plan?.minEntry) ?? toNum(item.plan?.candidate?.plan?.maxEntry);
    const maxEntry = toNum(item.plan?.candidate?.plan?.maxEntry);
    const hasMonitor = Boolean(input.monitorConfigs[item.code]?.enabled);

    let gapTone: PreopenAuctionRow["gapTone"] = "neutral";
    let gapLabel = changePct === null ? "待竞价/刷新" : "稳健开盘";

    if (latestPrice && planStop && latestPrice <= planStop) {
      gapTone = "stop-hit";
      gapLabel = "破计划止损线";
    } else if (changePct !== null && changePct >= 3.5) {
      gapTone = "chase-warn";
      gapLabel = "高开谨防追高";
    } else if (changePct !== null && changePct <= -3.0) {
      gapTone = "weak-alert";
      gapLabel = "低开警惕走弱";
    } else if (latestPrice && minEntry && maxEntry && latestPrice >= minEntry && latestPrice <= maxEntry) {
      gapTone = "in-band";
      gapLabel = "落在买点区";
    }

    rows.push({
      code: item.code,
      name: item.name,
      secid: item.secid,
      isHolding: item.isHolding,
      hasPlan: Boolean(item.plan),
      hasMonitor,
      latestPrice,
      referencePrice: item.holdingCost ?? toNum(item.plan?.candidate?.metrics?.close),
      changePct,
      planStop,
      gapTone,
      gapLabel
    });
  }

  return rows.sort((a, b) => {
    const score = (row: PreopenAuctionRow) => {
      let s = Math.abs(row.changePct ?? 0);
      if (row.gapTone === "stop-hit") s += 50;
      else if (row.gapTone === "weak-alert") s += 22;
      else if (row.gapTone === "chase-warn") s += 15;
      if (row.isHolding) s += 3;
      return s;
    };
    return score(b) - score(a);
  });
}

export function buildMorningPriorities(input: {
  holdings: HoldingItem[];
  monitorConfigs: Record<string, StockMonitorConfig>;
  copilotAlerts: Array<{
    id: string;
    tag: string;
    title: string;
    detail: string;
    targetView: string;
    severity?: string | undefined;
    stock?: { code: string; name: string; secid?: string | undefined } | undefined;
  }>;
  planReconciliation: PlanReconciliationRow[];
  tItems: TItem[];
  urgentNotesCount: number;
  newsItems: Array<{
    title?: string | undefined;
    type?: string | undefined;
    codes?: string[] | undefined;
    relatedStocks?: Array<{ code?: string | undefined }> | undefined;
    importance?: string | undefined;
    importanceScore?: number | undefined;
  }>;
}): MorningPriorityItem[] {
  const priorities: MorningPriorityItem[] = [];

  for (const alert of input.copilotAlerts.slice(0, 2)) {
    priorities.push({
      id: `prio-alert-${alert.id}`,
      tag: alert.tag || "高优预警",
      tone: alert.severity === "critical" ? "danger" : "warn",
      title: alert.title,
      detail: alert.detail,
      actionLabel: alert.stock ? "查看个股" : "前去处理",
      actionKind: alert.stock && alert.targetView === "dashboard" ? "open-stock" : "navigate",
      ...(alert.stock ? { stock: alert.stock } : {}),
      targetView: alert.targetView
    });
  }

  const unmonitoredHoldings = input.holdings.filter(h => /^\d{6}$/.test(h.code) && !input.monitorConfigs[h.code]?.enabled);
  if (unmonitoredHoldings.length > 0) {
    priorities.push({
      id: "prio-unmonitored-holdings",
      tag: "风控补漏",
      tone: "warn",
      title: `${unmonitoredHoldings.length} 只持仓尚未设止损盯盘`,
      detail: `${unmonitoredHoldings.slice(0, 3).map(h => h.name).join("、")}${unmonitoredHoldings.length > 3 ? "等" : ""}建议开盘前加 -5% 防守预警`,
      actionLabel: "一键加 -5% 止损",
      actionKind: "enable-batch-stop"
    });
  }

  const stopOrBuyPlan = input.planReconciliation.find(r => r.status === "stop-hit") || input.planReconciliation.find(r => r.status === "in-band");
  if (stopOrBuyPlan) {
    const sec = stopOrBuyPlan.plan.candidate.security;
    priorities.push({
      id: `prio-plan-${stopOrBuyPlan.plan.id}`,
      tag: stopOrBuyPlan.status === "stop-hit" ? "计划止损" : "计划买点",
      tone: stopOrBuyPlan.status === "stop-hit" ? "danger" : "good",
      title: `${sec.name} ${stopOrBuyPlan.statusLabel}`,
      detail: stopOrBuyPlan.detail,
      actionLabel: "看K线对照",
      actionKind: "open-stock",
      stock: { code: sec.code, name: sec.name, secid: sec.secid }
    });
  }

  const holdingCodes = new Set(input.holdings.map(h => h.code));
  const hitAnnouncement = input.newsItems.find(item => {
    const itemCodes = [
      ...(Array.isArray(item.codes) ? item.codes.map(String) : []),
      ...(Array.isArray(item.relatedStocks) ? item.relatedStocks.map(stock => String(stock?.code || "")).filter(Boolean) : [])
    ];
    return itemCodes.some(code => holdingCodes.has(code));
  });
  if (hitAnnouncement) {
    priorities.push({
      id: "prio-holding-news",
      tag: hitAnnouncement.type === "announcement" ? "持仓公告" : "关联快讯",
      tone: "warn",
      title: String(hitAnnouncement.title || "持仓关联重点信息").slice(0, 46),
      detail: "与当前持仓标的直接相关，建议开盘前确认利好/风险属性",
      actionLabel: "查看资讯",
      actionKind: "navigate",
      targetView: "news"
    });
  }

  const unlockedT = input.tItems.find(item => Number(item.config?.sellableShares || 0) > 0);
  if (unlockedT) {
    priorities.push({
      id: `prio-t-${unlockedT.code}`,
      tag: "做T就绪",
      tone: "good",
      title: `${unlockedT.name} T+1 可卖底仓 ${unlockedT.config.sellableShares} 股`,
      detail: `成本基准 ${unlockedT.config.costPrice > 0 ? unlockedT.config.costPrice.toFixed(2) : "自动跟踪"}，等待冲高/急跌偏离信号`,
      actionLabel: "打开做T",
      actionKind: "navigate",
      targetView: "t-assistant"
    });
  }

  if (input.urgentNotesCount > 0) {
    priorities.push({
      id: "prio-notes",
      tag: "随心记待办",
      tone: "muted",
      title: `还有 ${input.urgentNotesCount} 条交易条件备忘待处理`,
      detail: "可在下方随心记列表直接打勾完成或前往细化提醒条件",
      actionLabel: "随心记",
      actionKind: "navigate",
      targetView: "notes"
    });
  }

  return priorities.slice(0, 3);
}
