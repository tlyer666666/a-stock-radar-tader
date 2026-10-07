// Ordered evidence is separate from the retained, correlated legacy diagnostic scores.
function validBreadth(market) {
  const keys = ["stockCount", "upCount", "downCount", "flatCount"];
  return keys.every(k => market?.[k] !== null && market?.[k] !== undefined && market?.[k] !== "" && Number.isInteger(Number(market[k])) && Number(market[k]) >= 0) &&
    Number(market.stockCount) > 0 && Number(market.upCount) + Number(market.downCount) + Number(market.flatCount) === Number(market.stockCount);
}
function marketScenarios() {
  return [
    {id:"attack",name:"趋势延续观察",tone:"attack",conditions:["中证全指收盘高于完整 MA60", "板块与个股证据日期一致", "个股锚点、价格结构和交易限制均已复核"],action:"继续观察 2–6 周趋势；次日执行须另行满足冻结计划，评分不决定仓位。",invalidation:"市场跌破 MA60，或个股冻结计划的失效条件触发。"},
    {id:"balance",name:"分歧整理",tone:"neutral",conditions:["市场趋势尚未失守", "板块扩散或个股承接仍有分歧", "未形成新的已冻结价格条件"],action:"保留观察，补齐冲突证据；不因轮动或单个交叉追价。",invalidation:"同日市场关口不通过，或风险否决出现。"},
    {id:"defense",name:"防守触发",tone:"defense",conditions:["市场关口不通过或证券风险否决", "结构失效已由可信收盘证据确认", "数据缺失时先标不可判，不能当作跌破"],action:"停止新增本策略计划；已有持仓服从原风险与时间退出约束，不能假设跌停时立即成交。",invalidation:"可信同日资料确认风险解除后，重新建立条件观察。"}
  ];
}

function buildMarketReviewDecision(input, snapshot) {
  const primary = snapshot.indices.find(item => item.code === "000985");
  const normalizeDate = value => /^\d{8}$/.test(String(value || "")) ? `${String(value).slice(0,4)}-${String(value).slice(4,6)}-${String(value).slice(6)}` : String(value || "");
  const asOf = normalizeDate(primary?.date || input.emotion?.date || "");
  const observed = new Date(Date.parse(snapshot.generatedAt) + 28800000);
  const observedDay = Number.isFinite(observed.getTime()) ? observed.toISOString().slice(0,10) : "";
  const ms = Date.parse(`${asOf}T00:00:00Z`);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(asOf) && Number.isFinite(ms) && new Date(ms).toISOString().slice(0,10) === asOf && asOf <= observedDay;
  const primaryUsable = Boolean(primary?.available !== false && primary?.historyValid !== false && Number(primary?.historyBars) >= 60 && Number(primary?.ma60) > 0 && Number(primary?.close) > 0 && validDate);
  const intraday = asOf === observedDay && observed.getUTCHours() < 15;
  const emotionDate = normalizeDate(input.emotion?.date);
  const aligned = !emotionDate || emotionDate === asOf;
  const stale = Boolean(validDate && Date.parse(observedDay) - ms > 7 * 86400000);
  const marketGate = !primaryUsable || !aligned || intraday || stale ? "unknown" : Number(primary.close) < Number(primary.ma60) ? "blocked" : "open";
  const breadthAvailable = input.sourceAvailability?.market !== false && validBreadth(input.market);
  const emotionAvailable = input.sourceAvailability?.emotion !== false && input.emotion != null && input.emotion.limitUpCount != null && input.emotion.limitDownCount != null && Number.isInteger(Number(input.emotion.limitUpCount)) && Number(input.emotion.limitUpCount) >= 0 && Number.isInteger(Number(input.emotion.limitDownCount)) && Number(input.emotion.limitDownCount) >= 0;
  const failedAvailable = input.ladderPools?.failedPoolAvailable !== false && Array.isArray(input.ladderPools?.failedPool);
  const dataFacts = [primaryUsable ? `${asOf} 中证全指有 ${primary.historyBars} 根日线，完整 MA60 可计算。` : "中证全指日线缺失、日期无效或不足 60 根，市场趋势不可判。"];
  if (!aligned) dataFacts.push(`情绪日期 ${emotionDate} 与指数日期 ${asOf} 不一致，不合并成同日确认。`);
  if (intraday) dataFacts.push("当日日线尚未收盘，只保留盘中观察，不通过收盘关口。");
  if (stale) dataFacts.push("指数资料距采集日超过 7 个自然日，保留历史结构但不确认当前市场条件。");
  if (!breadthAvailable) dataFacts.push("全市场涨跌家数缺失，广度不可判；没有用中性分代替实测数据。");
  const marketFacts = [primaryUsable ? `中证全指 ${Number(primary.close).toFixed(2)} / MA60 ${Number(primary.ma60).toFixed(2)}，${Number(primary.close) >= Number(primary.ma60) ? "位于均线上方" : "位于均线下方"}。` : "缺少市场锚点，个股有趋势证据仍可观察，但不能确认入场环境。"];
  if (breadthAvailable) marketFacts.push(`上涨 ${input.market.upCount} / 下跌 ${input.market.downCount} / 平盘 ${input.market.flatCount}，总数 ${input.market.stockCount}；该截面只作背景，不与均线重复计票。`);
  const sectors = snapshot.focusSectors.slice(0, 3).map(s => `${s.name}：涨停 ${s.poolLimitUps ?? s.limitUps ?? "待补"} 家，相对市场 ${s.relativeReturn == null ? "待补" : Number(s.relativeReturn).toFixed(2)}（上游窗口）`);
  const conflicts = [];
  if (marketGate === "blocked") conflicts.push("规则不通过：中证全指收盘低于 MA60，停止新增本趋势策略计划。");
  if (!failedAvailable) conflicts.push("炸板池不可用，炸板数量与炸板率不能按零解释。");
  if (!emotionAvailable) conflicts.push("涨跌停情绪源缺失，回退计数不等于完整市场生态。");
  if (!snapshot.focusSectors.length) conflicts.push("板块资料缺失，不能确认主线扩散。");
  if (!conflicts.length) conflicts.push("已取到的证据未触发市场关口否决；仍需核验个股风险与板块同日持续性。");
  const numberOrNull = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const metrics = [
    {id:"ma60Distance",label:"中证全指偏离 MA60",value:primaryUsable ? (Number(primary.close)/Number(primary.ma60)-1)*100 : null,unit:"%",detail:"同一指数日线的收盘 / 完整 MA60 − 1；是趋势距离，不是预期收益"},
    {id:"breadth",label:"上涨家数占比",value:breadthAvailable ? Number(input.market.upCount)/Number(input.market.stockCount)*100 : null,unit:"%",detail:breadthAvailable ? `上涨 ${input.market.upCount} / 下跌 ${input.market.downCount} / 平盘 ${input.market.flatCount}；样本 ${input.market.stockCount}，行情日期未独立确认` : "全市场家数缺失或合计不一致，不使用中性值代替"},
    {id:"limitUp",label:"涨停家数",value:emotionAvailable ? Number(input.emotion.limitUpCount) : null,unit:"家",detail:`专题源日期 ${emotionDate || "未提供"}；不代表历史持续性`},
    {id:"limitDown",label:"跌停家数",value:emotionAvailable ? Number(input.emotion.limitDownCount) : null,unit:"家",detail:"负数 / 非整数计数视为无效，不把数据降级当作零跌停"},
    {id:"failedBoards",label:"炸板池记录",value:failedAvailable ? input.ladderPools.failedPool.length : null,unit:"条",detail:"仅记录该专题池的实际条数，池覆盖与日期另核验"}
  ];
  const context = snapshot.indices.map((item, i) => {
    const valid = item.available !== false && item.historyValid !== false && Number(item.historyBars) >= 60 && Number(item.close) > 0 && Number(item.ma60) > 0;
    const sameDate = normalizeDate(item.date) === asOf;
    return {id:`index-${i}`,label:item.name || item.code || "指数",state:!valid ? "历史不足" : !sameDate ? "日期不一致" : "同日价格观察",facts:[`日线截至 ${item.date || "待补"}；${item.historyBars || 0} 根。`,valid ? `收盘 ${Number(item.close).toFixed(2)} / MA60 ${Number(item.ma60).toFixed(2)}；偏离 ${((Number(item.close)/Number(item.ma60)-1)*100).toFixed(2)}%。` : "无法确认完整 MA60；原诊断分不代替实际均线。"]};
  });
  snapshot.focusSectors.slice(0,6).forEach((sector,i) => context.push({id:`sector-${i}`,label:sector.name || "未命名板块",state:"日期 / 覆盖待核",facts:[`专题池涨停 ${numberOrNull(sector.poolLimitUps ?? sector.limitUps) ?? "待补"} 家；相对市场 ${numberOrNull(sector.relativeReturn)?.toFixed(2) ?? "待补"}（上游窗口）。`, `板块行情日期 ${sector.asOf || sector.date || "未提供"}；样本数 ${numberOrNull(sector.stockCount) ?? "未提供"}。`,"榜单由专题池形成，不能证明完整板块成分上涨，也不据排名推断持续收益。"]}));
  if (!snapshot.focusSectors.length) context.push({id:"sector-missing",label:"板块背景",state:"缺少资料",facts:["没有板块记录，不能据此判断主线强弱或扩散。"]});
  const evidence = [];
  if (marketGate === "blocked") evidence.push({id:"market-veto",title:"市场趋势否决",tone:"risk",priority:0,detail:conflicts[0],basis:"完成且有效的中证全指日线与 MA60"});
  if (!primaryUsable || marketGate === "unknown") evidence.push({id:"market-data",title:"市场确认条件未齐",tone:"missing",priority:1,detail:dataFacts.join(" "),basis:"日期、历史长度、采集时点与源间一致性"});
  if (breadthAvailable && Number(input.market.downCount) > Number(input.market.upCount)) evidence.push({id:"breadth-divergence",title:"个股广度偏弱",tone:"risk",priority:2,detail:`下跌 ${input.market.downCount} 家多于上涨 ${input.market.upCount} 家，指数走势可能没有广泛跟随。`,basis:"全市场截面；未经日期独立确认，不作为另一个趋势否决"});
  if (emotionAvailable && Number(input.emotion.limitDownCount) > Number(input.emotion.limitUpCount)) evidence.push({id:"emotion-divergence",title:"极端下跌更多",tone:"risk",priority:2,detail:`同源跌停 ${input.emotion.limitDownCount} 家多于涨停 ${input.emotion.limitUpCount} 家。`,basis:`专题源日期 ${emotionDate || "待补"}；不与涨跌广度重复计票`});
  if (!breadthAvailable || !emotionAvailable || !failedAvailable) evidence.push({id:"coverage",title:"市场生态存在缺口",tone:"missing",priority:3,detail:conflicts.filter(x=>/缺失|不可用/.test(x)).join(" ") || "全市场家数缺失或无效，广度不可判。",basis:"缺数不等于风险消失，也不等于行情转弱"});
  evidence.push({id:"sector-quality",title:"板块持续性尚待证明",tone:"missing",priority:4,detail:"板块来源的成分、窗口与日期尚未完整核对，排名和涨停数量只是背景。",basis:"不把行业标签、短期热度和均线合成虚假独立胜算"});
  if (marketGate === "open") evidence.push({id:"market-support",title:"市场趋势条件通过",tone:"support",priority:5,detail:`中证全指 ${Number(primary.close).toFixed(2)} 高于或等于 MA60 ${Number(primary.ma60).toFixed(2)}。`,basis:"只说明本次市场趋势条件，不保证个股结构或可成交"});
  evidence.sort((a,b)=>a.priority-b.priority);
  return {
    version: "ordered-evidence-v2", metrics, context, evidence, observedLevels: [], asOf, status: !primaryUsable ? "insufficient" : marketGate === "blocked" ? "blocked" : marketGate === "unknown" ? "watch" : "conditional",
    headline: marketGate === "blocked" ? "市场趋势关口不通过" : marketGate === "open" ? "市场趋势可观察，个股条件另核" : "市场关口不可判，保留已知证据",
    stage: primaryUsable ? Number(primary.close) >= Number(primary.ma60) ? "市场位于 MA60 上方" : "市场位于 MA60 下方" : "市场阶段不可判",
    marketGate, canPlan: false, sourceNature: "公开行情与专题池快照；不是收益验证", levels: {close: primaryUsable ? Number(primary.close) : null, ma60: primaryUsable ? Number(primary.ma60) : null},
    limitations: ["未逐日核对交易所日历，无法仅凭最新一根确认已经覆盖最近交易日。", "板块排名、情绪与均线存在相关性，作为不同背景资料，不累计成独立胜算。", "市场复盘不生成个股入场、止损、目标或仓位，2–6 周计划需要另行冻结与执行核验。"],
    steps: [
      {id:"data",title:"数据是否可用",state:!primaryUsable ? "不可判" : intraday || !aligned || stale ? "待确认" : "可观察",facts:dataFacts},
      {id:"market",title:"市场与板块",state:marketGate === "blocked" ? "不通过" : marketGate === "open" ? "市场关口通过" : "不可判",facts:[...marketFacts,...sectors]},
      {id:"stock",title:"阶段与关键证据",state:"逐股确认",facts:["市场强弱不能替代个股判断。进入个股复盘，核对近期涨停锚点、MA20/MA60、承接与结构失效。", ...(emotionAvailable ? [`涨停 ${input.emotion.limitUpCount} / 跌停 ${input.emotion.limitDownCount}；只描述该源当日计数。`] : [])]},
      {id:"conflicts",title:"冲突与失效",state:marketGate === "blocked" ? "规则不通过" : "逐项核验",facts:conflicts},
      {id:"next",title:"次日条件情景",state:"条件预案",facts:["市场关口通过后，才继续核验板块与个股；不可判需要补数据，不等于规则否决。", "次日有无成交取决于冻结价格区间、官方限价、停牌与 T+1；不根据综合分给出仓位区间。"]}
    ],
    scenarios: marketScenarios().map(s=>({name:s.name,condition:s.conditions.join("；"),response:s.action,confirmation:s.id === "attack" ? `核对下一完整收盘与当时 MA60；本次指数 ${primaryUsable ? Number(primary.close).toFixed(2) : "待补"}、MA60 ${primaryUsable ? Number(primary.ma60).toFixed(2) : "待补"} 仅作观察参照。` : s.id === "balance" ? "比较同日期上涨家数、专题池和板块覆盖变化；源缺失或日期不齐时保留分歧，不推断轮动成功。" : "市场破位须以有效完成日线确认；个股风险触发与数据不可判分别处理。",invalidation:s.invalidation}))
  };
}
module.exports = { buildMarketReviewDecision, marketScenarios, validBreadth };
