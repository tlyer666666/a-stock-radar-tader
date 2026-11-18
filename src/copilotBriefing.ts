import type { WorkspaceView } from "./workspaceView";
import { isTradingDay } from "./features/notes/notesModel";
import { isActionable, type TAnalysis } from "./features/t-assistant/tEngine";

export type MarketSessionPhase = {
  id: "preopen" | "intraday" | "midday" | "afterclose" | "closed";
  label: string;
  tip: string;
};

export type CopilotAlertItem = {
  id: string;
  kind: "risk" | "source" | "note" | "t-signal" | "monitor";
  tag: string;
  title: string;
  detail: string;
  targetView: WorkspaceView;
  stock?: { code: string; name: string; secid?: string | undefined } | undefined;
};

export function resolveMarketSessionPhase(now = Date.now()): MarketSessionPhase {
  const cn = new Date(now + 8 * 3600_000);
  const date = cn.toISOString().slice(0, 10);
  const minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  if (!isTradingDay(date)) {
    return { id: "closed", label: "休市研究", tip: "复盘近期 AI 选股胜率与历史策略回测" };
  }
  if (minute < 9 * 60) {
    return { id: "closed", label: "开盘前", tip: "整理昨日持仓与随心记待办" };
  }
  if (minute < 9 * 60 + 30) {
    return { id: "preopen", label: "盘前准备", tip: "核对隔夜资讯、持仓风控与条件提醒" };
  }
  if (minute < 11 * 60 + 30 || (minute >= 13 * 60 && minute < 15 * 60)) {
    return { id: "intraday", label: "盘中盯盘", tip: "关注条件触发、做T偏离与模拟风控阈值" };
  }
  if (minute < 13 * 60) {
    return { id: "midday", label: "午间休市", tip: "复查上午触发信号与午后做T计划" };
  }
  return { id: "afterclose", label: "盘后复盘", tip: "运行智能复盘并校准次日观察清单" };
}

export function buildCopilotAlerts(input: {
  notes?: Array<{
    id: string;
    text: string;
    done?: boolean;
    remindAt?: string | null;
    firedFor?: string | null;
    conditionHit?: { at: string; detail: string } | null;
    stock?: { code: string; name: string; secid?: string } | null;
  }>;
  monitorAlerts?: Array<{ id: string; code: string; name: string; triggeredAt: string; detail: string }>;
  tItems?: Array<{ code: string; name: string; secid?: string }>;
  tRuntimes?: Record<string, { analysis?: TAnalysis | null; signalNote?: string }>;
  paperSummary?: {
    dailyStopped?: boolean;
    portfolioKill?: boolean;
    portfolioKillWarning?: boolean;
    lossStreakBlocked?: boolean;
    portfolioKillReasons?: string[];
  } | null;
  sourceNotice?: { key?: string; message?: string; tone?: string } | null;
}): CopilotAlertItem[] {
  const items: CopilotAlertItem[] = [];
  const seen = new Set<string>();
  const push = (entry: CopilotAlertItem) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    items.push(entry);
  };

  if (input.sourceNotice?.tone === "down" && input.sourceNotice.message) {
    push({
      id: `source:${input.sourceNotice.key || "down"}`,
      kind: "source",
      tag: "数据源",
      title: "行情连接受限",
      detail: input.sourceNotice.message,
      targetView: "settings"
    });
  }

  const paper = input.paperSummary;
  if (paper && (paper.dailyStopped || paper.portfolioKill || paper.portfolioKillWarning || paper.lossStreakBlocked)) {
    const reasons: string[] = [];
    if (paper.dailyStopped) reasons.push("当日亏损触及上限");
    if (paper.portfolioKill) reasons.push("组合硬风控触发");
    else if (paper.portfolioKillWarning) reasons.push("组合风险接近警戒线");
    if (paper.lossStreakBlocked) reasons.push("连续亏损保护已降频");
    if (Array.isArray(paper.portfolioKillReasons) && paper.portfolioKillReasons.length) {
      reasons.push(String(paper.portfolioKillReasons[0]));
    }
    push({
      id: "risk:paper",
      kind: "risk",
      tag: "风控",
      title: "模拟风控提示",
      detail: reasons.join(" · "),
      targetView: "holdings"
    });
  }

  for (const note of input.notes || []) {
    if (note.done) continue;
    const fired = Boolean(note.conditionHit) || Boolean(note.remindAt && note.firedFor === note.remindAt);
    if (!fired) continue;
    const stock = note.stock && /^\d{6}$/.test(note.stock.code) ? note.stock : undefined;
    push({
      id: `note:${note.id}`,
      kind: "note",
      tag: note.conditionHit ? "价格条件" : "随心记",
      title: stock ? `${stock.name}（${stock.code}）` : "随心记提醒",
      detail: note.conditionHit?.detail || note.text.slice(0, 60),
      targetView: stock ? "dashboard" : "notes",
      ...(stock ? { stock } : {})
    });
  }

  for (const tItem of input.tItems || []) {
    const runtime = input.tRuntimes?.[tItem.code];
    const sig = runtime?.analysis?.signal;
    if (!sig || !isActionable(sig)) continue;
    push({
      id: `t:${tItem.code}:${sig.action}`,
      kind: "t-signal",
      tag: "做T信号",
      title: `${tItem.name}（${tItem.code}）· ${sig.title}`,
      detail: sig.reasons[0] || runtime?.signalNote || `参考价 ${sig.price.toFixed(2)}`,
      targetView: "t-assistant",
      stock: { code: tItem.code, name: tItem.name, ...(tItem.secid ? { secid: tItem.secid } : {}) }
    });
  }

  for (const alert of (input.monitorAlerts || []).slice(0, 5)) {
    push({
      id: `monitor:${alert.id}`,
      kind: "monitor",
      tag: "自选监控",
      title: `${alert.name}（${alert.code}）`,
      detail: alert.detail,
      targetView: "favorites",
      ...(/^\d{6}$/.test(alert.code) ? { stock: { code: alert.code, name: alert.name } } : {})
    });
  }

  return items.slice(0, 12);
}
