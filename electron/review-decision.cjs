// Ordered evidence is separate from the retained, correlated legacy diagnostic scores.
function validBreadth(market) {
  const keys = ["stockCount", "upCount", "downCount", "flatCount"];
  return keys.every(k => market?.[k] !== null && market?.[k] !== undefined && market?.[k] !== "" && Number.isInteger(Number(market[k])) && Number(market[k]) >= 0) &&
    Number(market.stockCount) > 0 && Number(market.upCount) + Number(market.downCount) + Number(market.flatCount) === Number(market.stockCount);
}
function marketScenarios() {
  return [
    {id:"attack",name:"趋势延续",tone:"attack",conditions:["中证全指收盘在 60 日线上方", "板块和个股的数据是同一天的", "个股的支撑位、走势和交易限制都核对过"],action:"可以继续按 2–6 周的趋势思路观察；第二天要不要买，看你在驾驶舱定好的买点和止损，分数不决定仓位。",invalidation:"大盘跌破 60 日线，或个股跌破你设好的止损位。"},
    {id:"balance",name:"震荡分歧",tone:"neutral",conditions:["大盘趋势还没坏", "板块轮动快、个股承接有分歧", "还没有定好新的买点和止损"],action:"先观察，等信号统一；不要因为板块轮动或某一根K线就追高。",invalidation:"今天大盘偏弱或出现风险信号，先别开新仓。"},
    {id:"defense",name:"转入防守",tone:"defense",conditions:["大盘收在 60 日线下方，或个股出现风险信号", "走势破位已经被收盘价确认", "数据没取到时只是“暂时判断不了”，不能当成跌破"],action:"暂停新开仓；已有持仓按原来定好的止损和持有时间执行，遇到跌停不要假设能马上卖出。",invalidation:"之后的收盘数据显示风险解除，再重新观察。"}
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
  const dataFacts = [primaryUsable ? `${asOf} 中证全指有 ${primary.historyBars} 根日线，完整 MA60 可计算。` : "中证全指日线没取全（不足 60 根或日期不对），暂时判断不了大盘趋势。"];
  if (!aligned) dataFacts.push(`情绪数据是 ${emotionDate} 的，指数数据是 ${asOf} 的，日期对不上，不放在一起下结论。`);
  if (intraday) dataFacts.push("今天还没收盘，盘中数据只作参考，今天的大盘结论 15:00 收盘后给出。");
  if (stale) dataFacts.push("指数数据已经是 7 天前的了，只能看历史走势，不能代表现在的大盘。");
  if (!breadthAvailable) dataFacts.push("没取到全市场涨跌家数，暂时判断不了是普涨还是普跌（不会拿一个中间值凑数）。");
  const marketFacts = [primaryUsable ? `中证全指 ${Number(primary.close).toFixed(2)} / MA60 ${Number(primary.ma60).toFixed(2)}，${Number(primary.close) >= Number(primary.ma60) ? "在 60 日线上方" : "在 60 日线下方"}。` : "没有大盘参考数据，个股可以继续看，但没法确认现在适不适合买入。"];
  if (breadthAvailable) marketFacts.push(`上涨 ${input.market.upCount} / 下跌 ${input.market.downCount} / 平盘 ${input.market.flatCount}，总数 ${input.market.stockCount}；这只是今天的一个快照，作为背景参考。`);
  const sectors = snapshot.focusSectors.slice(0, 3).map(s => `${s.name}：涨停 ${s.poolLimitUps ?? s.limitUps ?? "未取到"} 家，${s.relativeReturn == null ? "相对大盘强弱：未取到" : `比大盘${Number(s.relativeReturn) >= 0 ? "强" : "弱"} ${Math.abs(Number(s.relativeReturn)).toFixed(2)}`}`);
  const conflicts = [];
  if (marketGate === "blocked") conflicts.push("大盘偏弱：中证全指收在 60 日线下方，先别开新仓。");
  if (!failedAvailable) conflicts.push("没取到炸板数据，不能当成“没有炸板”。");
  if (!emotionAvailable) conflicts.push("没取到涨跌停数据，短线情绪看不全。");
  if (!snapshot.focusSectors.length) conflicts.push("没取到板块数据，判断不了主线。");
  if (!conflicts.length) conflicts.push("目前没有发现大盘层面的风险信号；个股风险和板块能不能持续，还要逐只看。");
  const numberOrNull = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
  const metrics = [
    {id:"ma60Distance",label:"中证全指离 60 日线",value:primaryUsable ? (Number(primary.close)/Number(primary.ma60)-1)*100 : null,unit:"%",detail:"收盘价比 60 日线高（正数）或低（负数）多少，表示趋势强弱，不是预期收益"},
    {id:"breadth",label:"上涨股票占比",value:breadthAvailable ? Number(input.market.upCount)/Number(input.market.stockCount)*100 : null,unit:"%",detail:breadthAvailable ? `上涨 ${input.market.upCount} / 下跌 ${input.market.downCount} / 平盘 ${input.market.flatCount}，共 ${input.market.stockCount} 只` : "没取到全市场涨跌家数（或数字对不上），暂不显示"},
    {id:"limitUp",label:"涨停家数",value:emotionAvailable ? Number(input.emotion.limitUpCount) : null,unit:"家",detail:`数据日期 ${emotionDate || "未提供"}；只代表当天`},
    {id:"limitDown",label:"跌停家数",value:emotionAvailable ? Number(input.emotion.limitDownCount) : null,unit:"家",detail:"没取到时显示为空，不会当成 0 家"},
    {id:"failedBoards",label:"炸板股票",value:failedAvailable ? input.ladderPools.failedPool.length : null,unit:"条",detail:"炸板池里的实际数量"}
  ];
  const context = snapshot.indices.map((item, i) => {
    const valid = item.available !== false && item.historyValid !== false && Number(item.historyBars) >= 60 && Number(item.close) > 0 && Number(item.ma60) > 0;
    const sameDate = normalizeDate(item.date) === asOf;
    return {id:`index-${i}`,label:item.name || item.code || "指数",state:!valid ? "数据不足" : !sameDate ? "日期不一致" : "今日数据",facts:[`数据截至 ${item.date || "未取到"}。`,valid ? `收盘 ${Number(item.close).toFixed(2)}，60 日线 ${Number(item.ma60).toFixed(2)}，${Number(item.close) >= Number(item.ma60) ? "高于" : "低于"} 60 日线 ${Math.abs((Number(item.close)/Number(item.ma60)-1)*100).toFixed(2)}%。` : "日线不够，算不出 60 日线。"]};
  });
  snapshot.focusSectors.slice(0,6).forEach((sector,i) => context.push({id:`sector-${i}`,label:sector.name || "未命名板块",state:"日期 / 覆盖待核",facts:[`涨停 ${numberOrNull(sector.poolLimitUps ?? sector.limitUps) ?? "未取到"} 家；比大盘 ${numberOrNull(sector.relativeReturn)?.toFixed(2) ?? "未取到"}。`, `数据日期 ${sector.asOf || sector.date || "未提供"}；成分股 ${numberOrNull(sector.stockCount) ?? "未提供"} 只。`,"排名只按涨停池统计，不代表整个板块都在涨，也不代表会继续涨。"]}));
  if (!snapshot.focusSectors.length) context.push({id:"sector-missing",label:"板块背景",state:"缺少资料",facts:["没有板块数据，判断不了主线。"]});
  const evidence = [];
  if (marketGate === "blocked") evidence.push({id:"market-veto",title:"大盘偏弱",tone:"risk",priority:0,detail:conflicts[0],basis:"依据：中证全指收盘价和 60 日线"});
  if (!primaryUsable || marketGate === "unknown") evidence.push({id:"market-data",title:"今天的大盘结论还不能下",tone:"missing",priority:1,detail:dataFacts.join(" "),basis:"需要：完整的收盘数据、日期一致"});
  if (breadthAvailable && Number(input.market.downCount) > Number(input.market.upCount)) evidence.push({id:"breadth-divergence",title:"下跌的股票更多",tone:"risk",priority:2,detail:`下跌 ${input.market.downCount} 家多于上涨 ${input.market.upCount} 家，指数涨了也可能只是少数权重股在撑。`,basis:"依据：全市场涨跌家数（今天的快照）"});
  if (emotionAvailable && Number(input.emotion.limitDownCount) > Number(input.emotion.limitUpCount)) evidence.push({id:"emotion-divergence",title:"跌停比涨停多",tone:"risk",priority:2,detail:`跌停 ${input.emotion.limitDownCount} 家多于涨停 ${input.emotion.limitUpCount} 家，短线情绪偏差。`,basis:`数据日期 ${emotionDate || "未取到"}`});
  if (!breadthAvailable || !emotionAvailable || !failedAvailable) evidence.push({id:"coverage",title:"有些数据没取到",tone:"missing",priority:3,detail:conflicts.filter(x=>/没取到/.test(x)).join(" ") || "没取到全市场涨跌家数，暂时判断不了是普涨还是普跌。",basis:"没取到不代表没有风险，也不代表行情变差"});
  evidence.push({id:"sector-quality",title:"板块能不能持续还不确定",tone:"missing",priority:4,detail:"板块排名和涨停家数只能说明今天的强弱，能不能持续要看后面几天。",basis:"一天的热度不代表主线"});
  if (marketGate === "open") evidence.push({id:"market-support",title:"大盘环境允许开新仓",tone:"support",priority:5,detail:`中证全指 ${Number(primary.close).toFixed(2)} 在 60 日线 ${Number(primary.ma60).toFixed(2)} 上方。`,basis:"只说明大盘环境，个股能不能买还要单独看"});
  evidence.sort((a,b)=>a.priority-b.priority);
  return {
    version: "ordered-evidence-v2", metrics, context, evidence, observedLevels: [], asOf, status: !primaryUsable ? "insufficient" : marketGate === "blocked" ? "blocked" : marketGate === "unknown" ? "watch" : "conditional",
    headline: marketGate === "blocked" ? "今天大盘偏弱，先别开新仓" : marketGate === "open" ? "大盘环境允许开新仓，个股还要逐只看" : intraday ? "盘中还没收盘，今天的大盘结论 15:00 后给出" : "数据还不全，暂时判断不了大盘",
    stage: primaryUsable ? Number(primary.close) >= Number(primary.ma60) ? "大盘在 60 日线上方" : "大盘在 60 日线下方" : "大盘阶段暂时判断不了",
    marketGate, canPlan: false, sourceNature: "公开行情和涨停池数据；不是收益回测", levels: {close: primaryUsable ? Number(primary.close) : null, ma60: primaryUsable ? Number(primary.ma60) : null},
    limitations: ["只看最新一根日线，没有逐日核对交易日历。", "板块排名、情绪和均线常常同涨同跌，不能当成三个独立的好信号相加。", "大盘复盘不给个股买点、止损和仓位；具体操作请在驾驶舱里给个股定计划。"],
    steps: [
      {id:"data",title:"数据是否齐全",state:!primaryUsable ? "数据不全" : intraday || !aligned || stale ? "待确认" : "齐全",facts:dataFacts},
      {id:"market",title:"大盘与板块",state:marketGate === "blocked" ? "偏弱" : marketGate === "open" ? "允许开新仓" : "待定",facts:[...marketFacts,...sectors]},
      {id:"stock",title:"个股要单独看",state:"逐只看",facts:["大盘好不代表个股好。到「个股复盘」里看近期涨停、20/60 日线、承接和有没有破位。", ...(emotionAvailable ? [`今天涨停 ${input.emotion.limitUpCount} 家 / 跌停 ${input.emotion.limitDownCount} 家。`] : [])]},
      {id:"conflicts",title:"风险与缺口",state:marketGate === "blocked" ? "偏弱" : "逐条看",facts:conflicts},
      {id:"next",title:"明天怎么应对",state:"分情况",facts:["大盘环境允许时再看板块和个股；暂时判断不了只是数据不全，不等于大盘不好。", "明天能不能买到，看你定的买入区间、涨跌停限制、停牌和 T+1；软件不根据分数给仓位。"]}
    ],
    scenarios: marketScenarios().map(s=>({name:s.name,condition:s.conditions.join("；"),response:s.action,confirmation:s.id === "attack" ? `看下一个收盘价是否还在 60 日线上方；本次中证全指 ${primaryUsable ? Number(primary.close).toFixed(2) : "未取到"}、60 日线 ${primaryUsable ? Number(primary.ma60).toFixed(2) : "未取到"}，仅作参考。` : s.id === "balance" ? "对比明天的上涨家数、涨停池和板块变化；数据不全时先不下结论。" : "大盘破位要看收盘价确认；个股出现风险和“数据没取到”是两回事，分开处理。",invalidation:s.invalidation}))
  };
}
module.exports = { buildMarketReviewDecision, marketScenarios, validBreadth };
