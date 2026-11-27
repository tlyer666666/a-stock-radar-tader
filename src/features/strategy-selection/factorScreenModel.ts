/** 多因子选股（主进程 electron/factor-screen.cjs）的类型。 */
export type FactorExplanation = { code: string; text: string; quality: "observed" | "inferred" | "unknown"; source: string };
export type FactorPick = {
  rank: number; code: string; name: string; industry: string; score: number | null; coveragePct: number | null;
  latest: number | null; changePct: number | null; marketCapYi: number | null;
  factors: Record<string, { label: string; unit: string; value: number | null; score: number | null; weight: number }>;
  whySelected: FactorExplanation[]; whyNow: FactorExplanation[];
  explanationQuality: { whySelected: "ok" | "partial" | "unknown"; whyNow: "ok" | "partial" | "unknown" };
  reportLabel: string; reportPeriod: string;
};
export type FactorScreenResult = {
  strategy: { id: string; name: string; summary: string; weights: Array<{ id: string; label: string; weight: number; higher: boolean }> };
  strategies: Array<{ id: string; name: string; summary: string }>;
  reportPeriod: string; generatedAt: string; warnings: string[]; note: string;
  funnel: { universe: number; amountFilter?: string; tradable: number; passedFilters: number; scored: number; candidates: number; barsFailed: number; qualified?: number };
  picks: FactorPick[];
};

export const FACTOR_STRATEGY_OPTIONS = [
  { id: "quality_value", name: "质量价值", summary: "赚钱能力强、估值不贵" },
  { id: "blue_chip_value", name: "蓝筹低估", summary: "大市值、盈利稳、估值低" },
  { id: "growth_quality", name: "成长质量", summary: "营收利润双增、ROE 高" },
  { id: "momentum_quality", name: "动量质量", summary: "近期强势且业绩撑得住" },
  { id: "low_vol_quality", name: "低波质量", summary: "波动小、盈利稳、估值合理" },
  { id: "oversold_reversal", name: "超跌反转", summary: "基本面没坏、跌得多" }
] as const;

/** 漏斗一句话。 */
export function funnelText(funnel: FactorScreenResult["funnel"]): string {
  const parts = [`全市场 ${funnel.universe} 只`, `能正常交易且不太小 ${funnel.tradable} 只`, `过基本面条件 ${funnel.passedFilters} 只`, `进候选 ${funnel.candidates} 只`];
  if (typeof funnel.qualified === "number" && funnel.qualified !== funnel.candidates) parts.push(`满足量价条件 ${funnel.qualified} 只`);
  return `${parts.join(" → ")}${funnel.amountFilter && funnel.amountFilter !== "全天 5000 万" ? `（成交额门槛：${funnel.amountFilter}）` : ""}`;
}

export const weightsText = (weights: FactorScreenResult["strategy"]["weights"]) => weights.map(item => `${item.label}${item.higher ? "↑" : "↓"} ${item.weight}%`).join(" · ");
