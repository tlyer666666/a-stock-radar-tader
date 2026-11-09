import type { WorkspaceView } from "./workspaceView";

/** Stable route IDs are also used by saved navigation state. */
export function simpleAnalysisOrigin(view: WorkspaceView): { view: WorkspaceView; label: string } | null {
  const labels: Partial<Record<WorkspaceView, string>> = {
    "trend-screener": "返回策略选股",
    "previous-limit-up-failed": "返回炸板观察",
    favorites: "返回自选板块",
    holdings: "返回持仓股",
    sectors: "返回板块强度",
    beijing: "返回北交所",
    bonds: "返回可转债",
    signals: "返回策略选股",
    "ai-picks": "返回 AI 选股",
    "ai-agent": "返回 AI 问股",
    "t-assistant": "返回做T助手",
    compare: "返回多股同列",
    review: "返回专业复盘",
    settings: "返回数据源设置",
    backtest: "返回回测结果"
  };
  return labels[view] ? { view, label: labels[view]! } : null;
}

export function canRefreshAnalysis(view: WorkspaceView, mode: "pool" | "analysis") {
  return view === "dashboard" && mode === "analysis";
}
