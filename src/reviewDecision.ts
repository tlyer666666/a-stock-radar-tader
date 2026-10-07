export type ReviewDecision = {
  version: string; asOf: string; status: "insufficient" | "blocked" | "watch" | "conditional";
  headline: string; stage: string; marketGate: "unknown" | "blocked" | "open"; canPlan: boolean;
  sourceNature: string; steps: { id: string; title: string; state: string; facts: string[] }[];
  levels: Record<string, number | null>; limitations: string[];
  scenarios: { name: string; condition: string; response: string; confirmation?: string; invalidation?: string }[];
  metrics?: { id: string; label: string; value: number | null; unit: string; detail: string }[];
  evidence?: { id: string; title: string; tone: "support" | "risk" | "missing" | "neutral"; priority: number; detail: string; basis: string }[];
  observedLevels?: { id: string; label: string; price: number | null; asOf: string; role: string; distancePct: number | null; basis: string }[];
  context?: { id: string; label: string; state: string; facts: string[] }[];
};

const positive = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null;
};
const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
};
const date = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? value : "";
};
const chinaDay = (value: unknown) => {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms + 28800000).toISOString().slice(0, 10) : "";
};
const price = (n: number | null) => n === null ? "待补" : n.toFixed(2);

/** Ordered evidence, not an additive score. Never creates an order or synthetic risk prices. */
export function buildStockReviewDecision(payload: any, marketSnapshot?: any): ReviewDecision {
  const rows: any[] = Array.isArray(payload?.history) ? payload.history : [];
  const analysis = payload?.analysis || {};
  const security = payload?.security || payload?.quote || {};
  const asOf = date(rows.at(-1)?.date);
  const observedDay = chinaDay(payload?.updatedAt);
  const errors: string[] = [];
  if (rows.length < 65) errors.push(`日线只有 ${rows.length} 根，MA60 与 MA20 斜率需要至少 65 根。`);
  if (!observedDay) errors.push("缺少有效采集时间，不能确认日线是否属于未来。");
  const invalid = rows.some((r, i) => {
    const d = date(r?.date), o = positive(r?.open), h = positive(r?.high), l = positive(r?.low), c = positive(r?.close);
    return !d || (i > 0 && d <= rows[i-1].date) || (observedDay && d > observedDay) || o === null || h === null || l === null || c === null || h < Math.max(o, c, l) || l > Math.min(o, c, h);
  });
  if (invalid) errors.push("日线有无效价格、重复/倒序日期或未来日期，不能据此确认阶段。");
  const usable = !errors.length;
  const avg = (period: number, offset = 0) => usable ? rows.slice(-(period + offset), offset ? -offset : undefined).reduce((s, r) => s + Number(r.close), 0) / period : null;
  const close = usable ? positive(rows.at(-1)?.close) : null;
  const ma20 = avg(20), ma60 = avg(60), previousMa20 = avg(20, 5);
  const rising = close !== null && ma20 !== null && ma60 !== null && previousMa20 !== null && close > ma20 && ma20 > ma60 && ma20 > previousMa20;
  const eventDate = date(analysis.limitEvent?.date);
  const eventIndex = usable && eventDate ? rows.findIndex(r => r.date === eventDate) : -1;
  const eventAge = eventIndex >= 0 ? rows.length - 1 - eventIndex : null;
  const recentEvent = eventAge !== null && eventAge < 15;
  const eventLow = eventIndex >= 0 ? positive(rows[eventIndex]?.low) : null;
  const recentHigh = usable ? Math.max(...rows.slice(-21, -1).map(r => Number(r.high))) : null;
  const intraday = Boolean(asOf && asOf === observedDay && payload?.updatedAt && new Date(Date.parse(payload.updatedAt) + 28800000).getUTCHours() < 15);
  const stale = Boolean(asOf && observedDay && Date.parse(observedDay) - Date.parse(asOf) > 7 * 86400000);
  const market = marketSnapshot?.decision;
  const marketGate = !stale && !intraday && market?.asOf === asOf && (market.marketGate === "open" || market.marketGate === "blocked") ? market.marketGate : "unknown";
  const vetoes: string[] = [];
  if (!/^(?:60\d{4}|68\d{4}|00\d{4}|30\d{4}|[48]\d{5}|920\d{3})$/.test(String(security.code || ""))) vetoes.push("证券代码不在可识别的沪深北 A 股代码范围，范围检查不通过。");
  if (security.assetType && security.assetType !== "stock") vetoes.push("该证券不属于本复盘的 A 股近期涨停趋势范围。");
  if (security.isST === true || security.st === true || payload?.quote?.isST === true || payload?.quote?.st === true || /ST|退市|退$/i.test(String(security.name || payload?.quote?.name || ""))) vetoes.push("证券含明确 ST / 退市状态或名称标记，不通过本范围的证券风险检查。");
  if (analysis.qualification?.riskVetoPassed === false) vetoes.push("上游风险否决已触发，需逐项解除后再复核。");
  const reportedRisks = Array.isArray(analysis.risks) ? analysis.risks.filter((r: unknown) => typeof r === "string" && r.trim()) : [];
  if (marketGate === "blocked") vetoes.push("同日市场关口不通过：中证全指收盘位于 MA60 下方。");
  const belowAnchor = close !== null && eventLow !== null && close < eventLow;
  if (belowAnchor && !intraday && !stale) vetoes.push(`收盘低于同一日线口径的涨停锚点低点 ${price(eventLow)}，原结构失效。`);
  const sectorRs = finite(analysis.rsSector);
  const stage = !usable ? "阶段不可判断" : close! < ma20! ? "趋势转弱观察" : rising && recentEvent ? "趋势延续观察" : rising ? "上升趋势，涨停锚点待确认" : "整理等待确认";
  const sourceNature = /preview|synthetic|demo/i.test(String(payload?.actualProvider || "")) || payload?.isPreview ? "合成 / 预览资料，不是实盘验证" : `行情来源：${payload?.actualProvider || "未标明"}`;
  const limitations = ["尚未逐日核对交易所日历与停牌记录；日线条数不等于已确认的市场交易日覆盖。", "涨停锚点来自上游识别，未提供官方当日限价与证券状态的独立复核。", "日线用于结构观察；复权口径未独立核验，次日成交价、限价与止损必须在同一明确口径重新核验。"];
  if (intraday) limitations.unshift("最新日线尚在盘中，本次阶段是临时观察，须以收盘数据复核。");
  if (stale) limitations.unshift("日线距采集日超过 7 个自然日，资料陈旧；保留历史结构，不确认当前市场或交易条件。");
  const conflicts = [...vetoes];
  if (belowAnchor && intraday) conflicts.push(`盘中暂破锚点低点 ${price(eventLow)}，待收盘确认，不能判为已完成的收盘失效。`);
  if (belowAnchor && stale) conflicts.push(`历史日线低于锚点低点 ${price(eventLow)}，当前结构需要更新资料后复核。`);
  conflicts.push(...reportedRisks.map((risk: string) => `上游风险提示：${risk}`));
  if (sectorRs !== null && sectorRs < 0) conflicts.push(`个股相对板块偏弱（${sectorRs.toFixed(2)}），与上升趋势可能冲突；窗口沿用上游，未当作第二张趋势赞成票。`);
  if (!recentEvent) conflicts.push(eventAge === null ? "缺少可对应到日线的近期涨停锚点。" : `涨停锚点距今 ${eventAge} 根日线，已超出最近 15 根范围。`);
  if (!conflicts.length) conflicts.push("已取到的结构证据未触发上述否决；这不代表公告与交易限制已全部排除。");
  const status = !usable ? "insufficient" : vetoes.length ? "blocked" : rising && recentEvent && marketGate === "open" && !intraday && !stale ? "conditional" : "watch";
  const headline = !usable ? "数据不足，阶段暂不可判" : vetoes.length ? `${stage} · 规则不通过` : stale ? `${stage} · 资料陈旧待更新` : `${stage} · 交易条件待核验`;
  const plan = analysis.tradePlan || payload?.tradePlan || {};
  const distance = (value: number | null, base: number | null) => value !== null && base !== null && base > 0 ? (value / base - 1) * 100 : null;
  const last20 = rows.slice(-20), prior20 = rows.slice(-21, -1);
  const measuredMean = (sample: any[], key: string, count: number) => usable && sample.length === count && sample.every(r => positive(r[key]) !== null) ? sample.reduce((sum, r) => sum + Number(r[key]), 0) / count : null;
  const priorVolume20 = measuredMean(prior20, "volume", 20);
  const currentVolume = usable ? positive(rows.at(-1)?.volume) : null;
  const volumeRatio20 = currentVolume !== null && priorVolume20 !== null ? currentVolume / priorVolume20 : null;
  const amount20 = measuredMean(last20, "amount", 20);
  const atr14 = usable ? rows.slice(-14).reduce((sum, r, i) => { const prev = Number(rows[rows.length - 15 + i].close); return sum + Math.max(Number(r.high) - Number(r.low), Math.abs(Number(r.high) - prev), Math.abs(Number(r.low) - prev)); }, 0) / 14 : null;
  const recent10 = usable ? rows.slice(-10) : [];
  const lowRow = recent10.reduce<any>((best, r) => !best || Number(r.low) < Number(best.low) ? r : best, null);
  const highRow = usable ? prior20.reduce<any>((best, r) => !best || Number(r.high) > Number(best.high) ? r : best, null) : null;
  const metric = (id: string, label: string, value: number | null, unit: string, detail: string) => ({ id, label, value, unit, detail });
  const metrics = [
    metric("return5", "5 根涨跌", usable ? distance(close, positive(rows.at(-6)?.close)) : null, "%", "最新收盘 / 5 根前收盘 − 1；日线观察，不是策略收益"),
    metric("return20", "20 根涨跌", usable ? distance(close, positive(rows.at(-21)?.close)) : null, "%", "最新收盘 / 20 根前收盘 − 1；同一行情口径"),
    metric("ma20Distance", "偏离 MA20", distance(close, ma20), "%", "最新收盘相对 20 根收盘均值；偏离不等于可买空间"),
    metric("ma20Slope", "MA20 五根变化", distance(ma20, previousMa20), "%", "当前 MA20 / 5 根前 MA20 − 1；与趋势同属一组证据"),
    metric("volumeRatio20", "当日 / 前20均量", volumeRatio20, "倍", "仅比较同源日线量；缺一根量即待补，盘中量不可与全天等同"),
    metric("amount20", "20 根平均成交额", amount20, "元", "20 根成交额完整且为正才计算；沿用上游元单位"),
    metric("atr14", "14 根真实波幅均值", atr14, "元", "max(高−低, |高−前收|, |低−前收|) 的简单均值；不生成止损"),
    metric("anchorAge", "距涨停锚点", usable ? eventAge : null, "根", "来自上游锚点与日线定位；尚未独立确认官方限价")
  ];
  const observedLevels = [
    { id: "prior20High", label: "前 20 根最高价", price: recentHigh, asOf: highRow?.date || "", role: "上沿观察", basis: "不含当日的前 20 根最高价；突破须等待收盘与后续承接" },
    { id: "ma20", label: "MA20", price: ma20, asOf, role: "趋势参照", basis: "随日线变化的均值，不能视为固定支撑保证" },
    { id: "recent10Low", label: "近 10 根低点", price: usable ? positive(lowRow?.low) : null, asOf: lowRow?.date || "", role: "短期结构", basis: "含当日的最近 10 根实际最低价，后续破位需要收盘确认" },
    { id: "eventLow", label: "涨停锚点低点", price: eventLow, asOf: eventIndex >= 0 ? eventDate : "", role: "锚点边界", basis: "锚点当日日线低点；跌破则原锚点结构不再成立" }
  ].map(level => ({ ...level, distancePct: distance(close, level.price) }));
  const evidence: NonNullable<ReviewDecision["evidence"]> = [];
  const addEvidence = (id: string, title: string, tone: "support" | "risk" | "missing" | "neutral", priority: number, detail: string, basis: string) => evidence.push({id,title,tone,priority,detail,basis});
  vetoes.forEach((detail, i) => addEvidence(`veto-${i}`, "规则否决", "risk", 0, detail, "范围 / 同日市场 / 已完成日线的结构检查"));
  if (!usable) addEvidence("data", "价格证据不可用", "missing", 1, errors.join(" "), "无效输入不继续计算结构量值");
  if (intraday || stale) addEvidence("freshness", intraday ? "盘中尚未确认" : "资料陈旧", "missing", 1, limitations[0]!, "以采集时间和最后日线日期核对，交易日历仍待核验");
  if (usable && !rising) addEvidence("structure", "趋势组合未齐", "risk", 2, `收盘 ${price(close)}、MA20 ${price(ma20)}、MA60 ${price(ma60)}；价格在 MA20 上方、MA20 高于 MA60 且抬升未全部满足。`, "这些相关均线只构成一个趋势证据组");
  if (usable && belowAnchor && intraday) addEvidence("anchor-intraday", "盘中暂破锚点", "risk", 2, `暂价低于 ${price(eventLow)}，仍须收盘确认。`, "不把未完成 K 线当作收盘失效");
  if (!recentEvent) addEvidence("anchor", "近期锚点未确认", "missing", 2, eventAge === null ? "上游事件未能对应到有效日线。" : `锚点距今 ${eventAge} 根，超出最近 15 根范围。`, "保留均线事实，不假造近期涨停事件");
  reportedRisks.forEach((detail: string, i: number) => addEvidence(`reported-${i}`, "上游风险待复核", "risk", 3, detail, "原始风险提示；不推算发生概率"));
  if (sectorRs !== null && sectorRs < 0) addEvidence("sector-relative", "相对板块偏弱", "risk", 3, `上游相对板块值 ${sectorRs.toFixed(2)} 与个股上行假设形成分歧。`, "窗口 / 板块覆盖未确认，不重复计票");
  if (marketGate === "unknown") addEvidence("market-gap", "同日市场条件缺口", "missing", 4, "未取得同日、有效、完成收盘的市场关口。", "有个股结构不等于入场环境已通过");
  if (volumeRatio20 === null || amount20 === null) addEvidence("flow-gap", "量额资料不完整", "missing", 4, "缺少完整同源量额，不能确认放量或流动性。", "缺数不按零量或中性强度处理");
  addEvidence("execution-gap", "执行条件尚未冻结", "missing", 4, "官方限价、证券当日状态与价格复权口径尚未独立确认；本复盘没有生成委托。", "观察价位不自动变成止损、目标或仓位");
  if (rising) addEvidence("trend", "均线结构向上", "support", 5, "价格在 MA20 上方，MA20 高于 MA60 且较 5 根前抬升。", "一个趋势证据组，不是三项独立胜算");
  if (recentEvent) addEvidence("event", "近期事件可定位", "neutral", 5, `${eventDate} 对应实际日线，距今 ${eventAge} 根，低点 ${price(eventLow)}。`, "仅定位上游事件，官方限价与证券状态另核");
  evidence.sort((a,b) => a.priority - b.priority);
  const context = [
    {id:"market",label:"同日市场",state:marketGate === "open" ? "趋势条件通过" : marketGate === "blocked" ? "规则不通过" : "资料待补",facts:[`个股截至 ${asOf || "待补"}；市场截至 ${market?.asOf || "未取得"}。`, ...(Array.isArray(market?.steps) ? market.steps.find((step: any) => step.id === "market")?.facts?.slice(0,2) || [] : []), "市场快照仅作为本次上下文保存；档案不自动引用后来的行情。"]},
    {id:"sector",label:payload?.sector?.name || "所属板块",state:"口径待核",facts:[sectorRs === null ? "未提供个股相对板块数据。" : `个股相对板块 ${sectorRs.toFixed(2)}（上游窗口）。`, "板块成分、观察窗口、行情日期与样本覆盖尚未独立核对，不能从名称或排名推导主线确认。"]}
  ];
  return {
    version: "ordered-evidence-v2", asOf, status, headline, stage, marketGate, canPlan: false, sourceNature,
    metrics, observedLevels, evidence, context,
    levels: { close, ma20, ma60, eventLow, prior20High: recentHigh, stop: positive(plan.stopPrice), target: positive(plan.takeProfitPrice || plan.targetPrice) }, limitations,
    steps: [
      { id: "data", title: "数据是否可用", state: !usable ? "不可判" : stale ? "陈旧 / 历史观察" : intraday ? "盘中待确认" : "可观察", facts: usable ? [`截至 ${asOf}，${rows.length} 根日线顺序与 OHLC 校验通过。`, sourceNature, ...(intraday || stale ? [limitations[0]!] : [])] : errors },
      { id: "market", title: "市场与板块", state: marketGate === "blocked" ? "不通过" : marketGate === "open" ? "市场通过 / 板块另核" : "市场不可判", facts: [marketGate === "unknown" ? "缺少同日中证全指 MA60 复盘，保留个股观察但不能确认市场条件。" : marketGate === "open" ? "同日中证全指高于 MA60，只通过市场趋势一项。" : "同日中证全指低于 MA60，不新增本策略计划。", sectorRs === null ? "板块相对强弱未提供；行业名称不能代替板块走势。" : `${payload?.sector?.name || "所属板块"}相对强弱 ${sectorRs.toFixed(2)}（上游口径），只作背景，不重复累计趋势分数。`] },
      { id: "stock", title: "阶段与关键证据", state: stage, facts: usable ? [`${intraday ? "盘中暂价" : stale ? "历史收盘" : "收盘"} ${price(close)}；MA20 ${price(ma20)}；MA60 ${price(ma60)}；MA20 相比 5 根前${ma20! > previousMa20! ? "上升" : "未上升"}。`, eventIndex >= 0 ? `上游涨停锚点 ${eventDate}，距最新日线 ${eventAge} 根；该日日线低点 ${price(eventLow)}。` : "日线中未找到可核对的涨停锚点。", `前 20 根最高价 ${price(recentHigh)} 是观察位，不是自动委托价。`] : ["补齐可信日线后再判断均线、阶段与锚点，旧评分不替代这些数据。"] },
      { id: "conflicts", title: "冲突与失效", state: vetoes.length ? "规则不通过" : "逐项核验", facts: conflicts },
      { id: "next", title: "次日条件情景", state: "尚未形成可执行计划", facts: ["先核验收盘数据、同日市场、证券状态与官方限价，再使用趋势策略页已冻结的次日条件计划。", "复盘不补造止损、目标或仓位；2–6 周观察期间按原计划的失效条件与时间退出规则复核。"] }
    ],
    scenarios: [
      { name: "延续", condition: `下一完整收盘保持在 MA20（本次 ${price(ma20)}）之上，并观察能否越过前20根高点 ${price(recentHigh)}。`, confirmation: "市场关口通过、锚点有效；突破后的回落承接和同源全天量额须再核对。", invalidation: "仅盘中冲高后回落、收盘失守均线或风险否决，均不构成延续确认。", response: "继续跟踪；只有冻结计划的次日价格和成交条件同时满足，才进入执行检查。" },
      { name: "整理", condition: `未站上前20根高点 ${price(recentHigh)}，但 MA20 ${price(ma20)} 与锚点低点 ${price(eventLow)} 尚未确认失守。`, confirmation: "用后续完整日线观察是否守住实际边界；缩量只能在量数据完整时描述。", invalidation: "收盘失守结构边界转入偏弱情景；确认突破后重新复核偏强条件。", response: "保留观察，不因分数提高或单个指标交叉而补出入场价。" },
      { name: "失效", condition: eventLow === null ? "市场关口不通过、风险否决触发，或经核验的结构失效。" : `收盘跌破锚点低点 ${price(eventLow)}、市场关口不通过，或风险否决触发。`, confirmation: "结构失效须由有效完成日线确认；证券风险否决可以单独成立，缺数不能当作破位。", invalidation: "即使重新站回边界，也应重新建立条件记录，不自动恢复旧委托。", response: "停止沿用原入场假设；已有持仓按原计划和 T+1、涨跌停等成交约束处理，不能假设立即成交。" }
    ]
  };
}

export function legacyReviewDecision(scope: string, asOf = ""): ReviewDecision {
  return { version: "legacy-unqualified", asOf, status: "insufficient", headline: "旧结构记录未保存有序证据摘要", stage: "可查看原始详情", marketGate: "unknown", canPlan: false, sourceNature: `${scope}历史 / 预览结构`, levels: {}, limitations: ["不会用当前行情回填历史档案。重新计算会生成新的复盘，原档案保持原样。"], scenarios: [], steps: [
    {id:"data",title:"数据是否可用",state:"摘要缺失",facts:["该记录保留原有数据，但没有保存新版日期、覆盖与价格检查结果。"]},
    {id:"market",title:"市场与板块",state:"不可判",facts:["展开详情可查原始市场与板块资料；不能从旧综合分推断关口通过。"]},
    {id:"stock",title:"阶段与关键证据",state:"待重新计算",facts:["原有指标仍保留在详情；本次不追溯补造阶段。"]},
    {id:"conflicts",title:"冲突与失效",state:"待核验",facts:["旧记录的完整性与交易条件未按新规则验证。"]},
    {id:"next",title:"次日条件情景",state:"条件未满足",facts:["需要当前数据重新计算后，才可形成新的条件观察。"]}
  ] };
}
