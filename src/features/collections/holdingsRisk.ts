/**
 * 持仓风险看板的计算（纯函数）。设计参考 daily_stock_analysis 的组合风险看板（MIT）。
 * 原则：数据不全时旗标显示「不可用」，不把缺行情的持仓当成 0 市值去算集中度，也不把「算不了」说成「正常」。
 */

export type RiskHolding = { code: string; name: string; shares: number; costPrice: number };
export type RiskQuote = { latest: number | null; industry: string; failed: boolean };
export type RiskFlagState = "ok" | "alert" | "unavailable";
export type RiskFlag = { id: "single" | "sector" | "stop" | "drawdown" | "ai" | "price"; label: string; state: RiskFlagState; value: string; detail: string };
/** key：当时的持仓指纹（代码 + 股数 + 成本价）。买卖或调成本之后指纹变了，之前的记录不再可比。 */
export type EquityPoint = { date: string; ratio: number; key?: string };
export type AiRiskSignal = { code: string; name: string; action: string; actionLabel: string };

export const RISK_LIMITS = { singlePct: 40, sectorPct: 60, stopNearPct: -5, stopBreachPct: -8, drawdownPct: 10 } as const;
export const EQUITY_KEY = "a-stock-radar:holdings-equity:v1";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const pct = (value: number) => `${value.toFixed(1)}%`;

/** 清洗本地缓存里的净值点，过滤 null 或结构损坏的条目。 */
export function sanitizeEquityHistory(raw: unknown): EquityPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((point): point is EquityPoint =>
    Boolean(
      point &&
      typeof point === "object" &&
      typeof (point as EquityPoint).date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test((point as EquityPoint).date) &&
      finite((point as EquityPoint).ratio) &&
      (point as EquityPoint).ratio > 0 &&
      ((point as EquityPoint).key === undefined || typeof (point as EquityPoint).key === "string")
    )
  );
}

export type RiskReport = {
  flags: RiskFlag[];
  positions: Array<{ code: string; name: string; weightPct: number; pnlPct: number | null; marketValue: number }>;
  sectors: Array<{ name: string; weightPct: number }>;
  totalValue: number | null;
  ratio: number | null;
};

/**
 * @param holdings 持仓
 * @param quotes 代码 → 行情（latest 为 null 或 failed 表示这只没有有效价格）
 * @param history 每日「市值 ÷ 成本」记录（升序），用来算回撤
 * @param aiSignals 仍在生效的 AI 防御建议（减仓 / 卖出 / 回避）；null 表示没读到
 */
export function buildRiskReport(holdings: RiskHolding[], quotes: Record<string, RiskQuote | undefined>, history: EquityPoint[], aiSignals: AiRiskSignal[] | null): RiskReport {
  const active = holdings.filter(item => finite(item.shares) && item.shares > 0);
  const priced = active.map(item => {
    const quote = quotes[item.code];
    const latest = quote && !quote.failed && finite(quote.latest) && quote.latest > 0 ? quote.latest : null;
    return { ...item, latest, industry: quote?.industry?.trim() || "", stale: Boolean(quote?.failed) };
  });
  const missing = priced.filter(item => item.latest === null);
  const complete = active.length > 0 && missing.length === 0;
  const rawTotalValue = complete ? priced.reduce((sum, item) => sum + item.shares * (item.latest as number), 0) : null;
  const totalValue = rawTotalValue !== null && finite(rawTotalValue) && rawTotalValue > 0 ? rawTotalValue : null;
  const badCost = active.filter(item => !finite(item.costPrice) || item.costPrice <= 0);
  const hasValidCost = active.length > 0 && badCost.length === 0;
  const rawTotalCost = hasValidCost ? active.reduce((sum, item) => sum + item.shares * item.costPrice, 0) : 0;
  const totalCost = hasValidCost && finite(rawTotalCost) && rawTotalCost > 0 ? rawTotalCost : 0;
  const positions = complete && totalValue ? priced.map(item => ({
    code: item.code, name: item.name, marketValue: item.shares * (item.latest as number),
    weightPct: item.shares * (item.latest as number) / totalValue * 100,
    pnlPct: finite(item.costPrice) && item.costPrice > 0 ? ((item.latest as number) / item.costPrice - 1) * 100 : null
  })).sort((a, b) => b.weightPct - a.weightPct) : [];
  const flags: RiskFlag[] = [];
  const unavailable = (id: RiskFlag["id"], label: string, detail: string): RiskFlag => ({ id, label, state: "unavailable", value: "不可用", detail });
  const noPrice = active.length === 0 ? "还没有持仓" : `${missing.length} 只没有有效行情，暂不计算`;

  // 个股集中
  if (!positions.length) flags.push(unavailable("single", "个股集中", noPrice));
  else {
    const top = positions[0]!;
    flags.push({ id: "single", label: "个股集中", state: top.weightPct >= RISK_LIMITS.singlePct && positions.length > 1 ? "alert" : "ok", value: pct(top.weightPct),
      detail: positions.length === 1 ? `只持有 ${top.name} 一只` : `${top.name} 占 ${pct(top.weightPct)}（超过 ${RISK_LIMITS.singlePct}% 提示）` });
  }

  // 行业集中：任何一只没有行业就不算完整，不给结论。
  const sectorMap = new Map<string, number>();
  let sectors: RiskReport["sectors"] = [];
  if (!positions.length) flags.push(unavailable("sector", "行业集中", noPrice));
  else {
    const unclassified = priced.filter(item => !item.industry || item.industry === "未分类");
    if (unclassified.length) flags.push(unavailable("sector", "行业集中", `${unclassified.length} 只没有行业分类（${unclassified.slice(0, 3).map(item => item.name).join("、")}）`));
    else {
      for (const item of priced) sectorMap.set(item.industry, (sectorMap.get(item.industry) || 0) + item.shares * (item.latest as number));
      sectors = [...sectorMap].map(([name, value]) => ({ name, weightPct: value / (totalValue as number) * 100 })).sort((a, b) => b.weightPct - a.weightPct);
      const top = sectors[0]!;
      flags.push({ id: "sector", label: "行业集中", state: top.weightPct >= RISK_LIMITS.sectorPct && sectors.length > 1 ? "alert" : "ok", value: pct(top.weightPct),
        detail: sectors.length === 1 ? `全部在「${top.name}」一个行业` : `「${top.name}」占 ${pct(top.weightPct)}（超过 ${RISK_LIMITS.sectorPct}% 提示）` });
    }
  }

  // 止损：按成本算浮亏；缺价或成本价无效时不算，避免把占位价当成触发或掩盖浮亏。
  if (!positions.length) flags.push(unavailable("stop", "止损", noPrice));
  else if (!hasValidCost) {
    flags.push(unavailable("stop", "止损", `${badCost.length} 只持仓成本价无效（${badCost.slice(0, 3).map(item => item.name).join("、")}），暂不计算`));
  } else {
    const breach = positions.filter(item => item.pnlPct !== null && item.pnlPct <= RISK_LIMITS.stopBreachPct);
    const near = positions.filter(item => item.pnlPct !== null && item.pnlPct > RISK_LIMITS.stopBreachPct && item.pnlPct <= RISK_LIMITS.stopNearPct);
    flags.push({ id: "stop", label: "止损", state: breach.length || near.length ? "alert" : "ok", value: breach.length ? `${breach.length} 只破位` : near.length ? `${near.length} 只接近` : "正常",
      detail: breach.length || near.length
        ? [...breach.map(item => `${item.name} ${pct(item.pnlPct as number)}（已亏超 ${Math.abs(RISK_LIMITS.stopBreachPct)}%）`), ...near.map(item => `${item.name} ${pct(item.pnlPct as number)}`)].slice(0, 4).join("；")
        : `没有持仓浮亏超过 ${Math.abs(RISK_LIMITS.stopNearPct)}%` });
  }

  // 回撤：每日「市值 ÷ 成本」从最高点到现在的回落。买入、卖出、加减仓或改成本价都会让这个比值跳变（和涨跌无关），
  // 所以只用「持仓指纹没变过」的那段记录；持仓一变就重新开始记，避免把调仓当成回撤。至少两天记录。
  const rawRatio = totalValue !== null && totalCost > 0 ? totalValue / totalCost : null;
  const ratio = rawRatio !== null && finite(rawRatio) && rawRatio > 0 ? rawRatio : null;
  const key = holdingsKey(active);
  const safeHistory = Array.isArray(history) ? history : [];
  const points = safeHistory.filter(point => Boolean(point && typeof point === "object" && finite(point.ratio) && point.ratio > 0 && point.key === key));
  if (ratio === null || points.length < 2) {
    const reason = ratio === null
      ? (complete && !hasValidCost ? "部分持仓成本价无效，暂不算回撤" : noPrice)
      : "持仓不变的记录不到两天，还算不了回撤（每天打开持仓页会记一次；买卖之后重新开始记）";
    flags.push(unavailable("drawdown", "回撤", reason));
  } else {
    const peak = Math.max(...points.map(point => point.ratio), ratio);
    const drawdown = (1 - ratio / peak) * 100;
    flags.push({ id: "drawdown", label: "回撤", state: drawdown >= RISK_LIMITS.drawdownPct ? "alert" : "ok", value: pct(drawdown), detail: `盈亏比例从最高点回落 ${pct(drawdown)}（${points.length} 天记录，超过 ${RISK_LIMITS.drawdownPct}% 提示）` });
  }

  // AI 防御信号
  if (aiSignals === null) flags.push(unavailable("ai", "AI 信号", "AI 建议没读到"));
  else {
    const held = new Set(active.map(item => item.code));
    const hits = aiSignals.filter(item => held.has(item.code));
    flags.push({ id: "ai", label: "AI 信号", state: hits.length ? "alert" : "ok", value: hits.length ? `${hits.length} 条防御` : "无",
      detail: hits.length ? hits.slice(0, 4).map(item => `${item.name}：${item.actionLabel}`).join("；") : "持仓里没有仍在生效的减仓 / 卖出 / 回避建议" });
  }

  // 价格质量
  if (!active.length) flags.push(unavailable("price", "价格质量", "还没有持仓"));
  else flags.push({ id: "price", label: "价格质量", state: missing.length ? "alert" : "ok", value: missing.length ? `${missing.length} 只缺价` : "正常",
    detail: missing.length ? `${missing.slice(0, 4).map(item => item.name).join("、")} 没有有效行情，上面的集中度和止损因此不可用` : "全部持仓都有有效行情" });

  return { flags, positions, sectors, totalValue, ratio };
}

/** 持仓指纹：代码 + 股数 + 成本价（排序后）。 */
export function holdingsKey(holdings: Array<{ code: string; shares: number; costPrice?: number }>): string {
  return holdings
    .filter(item => finite(item.shares) && item.shares > 0)
    .map(item => `${item.code}:${item.shares}:${finite(item.costPrice) && item.costPrice > 0 ? Math.round(item.costPrice * 1000) : "na"}`)
    .sort()
    .join(",");
}

/** 记一条当天的「市值 ÷ 成本」；同一天覆盖；持仓指纹和之前不同的旧记录丢掉；最多保留 250 天。 */
export function recordEquity(history: EquityPoint[], date: string, ratio: number | null, key = ""): EquityPoint[] {
  if (!finite(ratio) || ratio <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Array.isArray(history) ? history : [];
  const safeHistory = Array.isArray(history) ? history : [];
  const next = safeHistory.filter(point =>
    Boolean(
      point &&
      typeof point === "object" &&
      typeof point.date === "string" &&
      point.date !== date &&
      /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
      finite(point.ratio) &&
      point.ratio > 0 &&
      (point.key ?? "") === key
    )
  );
  next.push({ date, ratio: Math.round(ratio * 10000) / 10000, key });
  return next.sort((a, b) => a.date.localeCompare(b.date)).slice(-250);
}
