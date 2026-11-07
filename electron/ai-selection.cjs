"use strict";

/**
 * AI 选股助手：在规则选股结果之上做三件事，外加大白话建策略。
 *  1. rankPicks   —— 给规则选出的股票逐只打分（0–100）、评级，并写看点 / 风险 / 次日关注点；
 *                    分数只用于排序与筛选展示，股票是否入选仍由规则决定。
 *  2. dailySummary —— 收盘后对本轮选股结果写一段复盘小结。
 *  3. draftStrategy —— 把一句话描述翻译成「我的策略」条件组合，交给编辑器由用户确认后保存。
 *  4. rankProfiles / reviewStock —— 任意股票（不一定来自选股）按日线「体检数据」打分；单只股票写详细点评。
 *
 * 发给模型的只有股票代码、名称、行业和规则算出的指标，不含任何账户、持仓或密钥。
 * 模型的输出逐字段校验：代码必须来自输入、分数夹在 0–100、文字限长；不合格的条目丢弃。
 */
const customStrategy = require("./custom-strategy.cjs");
const frameworks = require("./ai-frameworks.cjs");
const catalog = require("../config/strategy-custom-conditions.json");

const MAX_PICKS = 40;
// 每次请求最多评 10 只、同时最多 3 个请求：40 只一次性评估时输出常超过模型的输出上限（被截断成无效 JSON）或超时。
const BATCH_SIZE = 10;
const BATCH_CONCURRENCY = 3;

/** 分批调用：返回每批的结果或错误（按批次顺序）。 */
async function inBatches(list, worker) {
  const batches = [];
  for (let index = 0; index < list.length; index += BATCH_SIZE) batches.push(list.slice(index, index + BATCH_SIZE));
  const outcomes = new Array(batches.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, async () => {
    while (cursor < batches.length) {
      const index = cursor++;
      try { outcomes[index] = { ok: true, batch: batches[index], value: await worker(batches[index]) }; }
      catch (error) { outcomes[index] = { ok: false, batch: batches[index], error }; }
    }
  }));
  if (outcomes.every(item => !item.ok)) throw outcomes[0].error;
  return outcomes;
}
const RATINGS = ["重点关注", "关注", "观望", "回避"];
const clip = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
};
const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const round = (value, digits = 2) => finite(value) === null ? null : Number(value.toFixed(digits));

/** 渲染进程传来的股票：只保留需要的字段并限长，最多 40 只。 */
function sanitizePicks(input) {
  const seen = new Set();
  const picks = [];
  for (const raw of Array.isArray(input) ? input : []) {
    const code = String(raw?.code || "");
    if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    picks.push({
      code, name: clip(raw?.name || code, 12), industry: clip(raw?.industry || "", 12),
      latest: round(finite(raw?.latest)), changePct: round(finite(raw?.changePct)), turnover: round(finite(raw?.turnover)),
      amountYi: finite(raw?.amount) === null ? null : round(raw.amount / 1e8),
      limitDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.limitDate || "")) ? raw.limitDate : "",
      daysSinceLimit: Number.isInteger(raw?.daysSinceLimit) ? raw.daysSinceLimit : null,
      consecutiveBoards: Number.isInteger(raw?.consecutiveBoards) ? raw.consecutiveBoards : null,
      signalStrength: finite(raw?.signalStrength), overheatCount: Number.isInteger(raw?.overheatCount) ? raw.overheatCount : null,
      strategies: (Array.isArray(raw?.strategies) ? raw.strategies : []).map(item => clip(item, 20)).filter(Boolean).slice(0, 8),
      notes: (Array.isArray(raw?.notes) ? raw.notes : []).map(item => clip(item, 60)).filter(Boolean).slice(0, 4),
      reasons: (Array.isArray(raw?.reasons) ? raw.reasons : []).map(item => clip(item, 40)).filter(Boolean).slice(0, 3),
      limitReason: clip(raw?.limitReason || "", 40)
    });
    if (picks.length >= MAX_PICKS) break;
  }
  return picks;
}

const LEVEL = /^[\u4e00-\u9fa5\w]{1,12}$/;
/** 任意股票的「体检数据」（主进程用日线算出）：只保留需要的字段，最多 40 只。 */
function sanitizeProfiles(input) {
  const seen = new Set();
  const list = [];
  const num = value => round(finite(value));
  const levels = value => (Array.isArray(value) ? value : []).map(item => ({ label: clip(item?.label, 12), price: num(item?.price) }))
    .filter(item => LEVEL.test(item.label) && item.price !== null && item.price > 0).slice(0, 3);
  for (const raw of Array.isArray(input) ? input : []) {
    const code = String(raw?.code || "");
    if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    list.push({
      code, name: clip(raw?.name || code, 12), industry: clip(raw?.industry || "", 12),
      asOfDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.asOfDate || "")) ? raw.asOfDate : "",
      latest: num(raw?.latest), changePct: num(raw?.changePct), turnover: num(raw?.turnover), amountYi: num(raw?.amountYi),
      avgAmount20Yi: num(raw?.avgAmount20Yi), volumeRatio: num(raw?.volumeRatio),
      return5: num(raw?.return5), return20: num(raw?.return20), return60: num(raw?.return60),
      trend: clip(raw?.trend || "", 30),
      ma: Object.fromEntries(["ma5", "ma10", "ma20", "ma60"].map(key => [key, num(raw?.ma?.[key])])),
      fromHigh20Pct: num(raw?.fromHigh20Pct), fromLow20Pct: num(raw?.fromLow20Pct),
      high20: num(raw?.high20), low20: num(raw?.low20), high60: num(raw?.high60), low60: num(raw?.low60),
      limitUps20: Number.isInteger(raw?.limitUps20) ? raw.limitUps20 : null, broken20: Number.isInteger(raw?.broken20) ? raw.broken20 : null,
      consecutiveBoards: Number.isInteger(raw?.consecutiveBoards) ? raw.consecutiveBoards : null,
      lastLimitDate: /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.lastLimitDate || "")) ? raw.lastLimitDate : "",
      daysSinceLimit: Number.isInteger(raw?.daysSinceLimit) ? raw.daysSinceLimit : null,
      support: levels(raw?.support), resistance: levels(raw?.resistance),
      macd: raw?.macd && typeof raw.macd === "object" ? { dif: round(finite(raw.macd.dif), 3), dea: round(finite(raw.macd.dea), 3), hist: round(finite(raw.macd.hist), 3),
        histTrend: ["放大", "缩小"].includes(raw.macd.histTrend) ? raw.macd.histTrend : "", cross: ["金叉", "死叉"].includes(raw.macd.cross) ? raw.macd.cross : "",
        crossDays: Number.isInteger(raw.macd.crossDays) ? raw.macd.crossDays : null } : null,
      rsi6: num(raw?.rsi6), rsi14: num(raw?.rsi14), bias5: num(raw?.bias5),
      alignment: ["多头排列", "空头排列", "短期多头排列", "短期空头排列", "均线交织"].includes(raw?.alignment) ? raw.alignment : "",
      above: raw?.above && typeof raw.above === "object" ? Object.fromEntries(["ma5", "ma10", "ma20", "ma60"].map(key => [key, typeof raw.above[key] === "boolean" ? raw.above[key] : null])) : null,
      gaps: (Array.isArray(raw?.gaps) ? raw.gaps : []).filter(gap => ["向上缺口", "向下缺口"].includes(gap?.type)).slice(-3)
        .map(gap => ({ type: gap.type, date: /^\d{4}-\d{2}-\d{2}$/.test(String(gap.date || "")) ? gap.date : "", top: num(gap.top), bottom: num(gap.bottom) })),
      strategies: (Array.isArray(raw?.strategies) ? raw.strategies : []).map(item => clip(item, 20)).filter(Boolean).slice(0, 8),
      notes: (Array.isArray(raw?.notes) ? raw.notes : []).map(item => clip(item, 60)).filter(Boolean).slice(0, 4),
      announcements: (Array.isArray(raw?.announcements) ? raw.announcements : []).slice(0, 5).map(item => ({
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(item?.date || "")) ? item.date : "", title: clip(item?.title, 40),
        direction: ["利好", "利空", "多空交织", "中性"].includes(item?.direction) ? item.direction : "中性",
        risk: Number.isInteger(item?.risk) ? Math.max(0, Math.min(3, item.risk)) : 0 })).filter(item => item.title),
      ...(raw?.announcementsAvailable === false ? { announcementsAvailable: false } : {}),
      ...(Array.isArray(raw?.context) && raw.context.length ? { context: raw.context.map(item => clip(item, 60)).filter(Boolean).slice(0, 8) } : {}),
      limitReason: clip(raw?.limitReason || "", 40)
    });
    if (list.length >= MAX_PICKS) break;
  }
  return list;
}

function sanitizeMarket(input) {
  if (!input || typeof input !== "object") return null;
  return {
    limitUpCount: Number.isInteger(input.limitUpCount) ? input.limitUpCount : null,
    maxBoards: Number.isInteger(input.maxBoards) ? input.maxBoards : null,
    sealRatePct: finite(input.sealRatePct) === null ? null : round(input.sealRatePct, 1),
    limitBreakCount: Number.isInteger(input.limitBreakCount) ? input.limitBreakCount : null,
    limitDownCount: Number.isInteger(input.limitDownCount) ? input.limitDownCount : null,
    topReasons: (Array.isArray(input.topReasons) ? input.topReasons : []).map(item => clip(item, 30)).filter(Boolean).slice(0, 8),
    hotStocks: (Array.isArray(input.hotStocks) ? input.hotStocks : []).map(item => clip(item, 12)).filter(Boolean).slice(0, 10)
  };
}

const RANK_SYSTEM = `你是A股短线交易研究助手。用户的软件已用固定规则从全市场（剔除ST）选出了一批股票，你的任务是对这些股票逐只做二次评估，帮助用户决定次日优先关注哪些。
要求：
- 只根据输入里给出的数据判断，不要编造新闻、公告、业绩或资金数据；输入没有的信息就不要提。
- 综合考虑：命中策略数量与类型、涨停后天数与连板高度、过热项数量、当日涨跌幅、换手与成交额（流动性）、涨停原因与市场热点是否一致、市场情绪。
- 分数 0–100（越高越值得次日优先关注），评级只能是“重点关注 / 关注 / 观望 / 回避”之一，与分数一致（≥75 重点关注，60–74 关注，40–59 观望，<40 回避）。
- 每只股票：highlights 写看点（≤40字），risks 写主要风险（≤40字），nextDay 写次日具体关注点（≤40字，例如竞价强弱、能否站稳某价位、量能）。
- 不构成投资建议，不要给出仓位或保证收益的说法。
只输出 JSON：{"items":[{"code":"600000","score":72,"rating":"关注","highlights":"…","risks":"…","nextDay":"…"}]}，覆盖输入里的每一只股票。`;

const PROFILE_FIELDS = `字段说明：latest 最新价，changePct 当日涨跌幅%，turnover 换手率%，amountYi 成交额(亿)，avgAmount20Yi 近20日日均成交额(亿)，volumeRatio 量比（当日量/前5日均量），return5/20/60 近5/20/60日涨幅%，trend 均线位置，ma 均线价，fromHigh20Pct / fromLow20Pct 距近20日最高/最低%，high20/low20/high60/low60 近20/60日最高最低价，limitUps20 近20日涨停次数，broken20 近20日炸板次数，consecutiveBoards 当前连板，lastLimitDate 最近涨停日，daysSinceLimit 距最近涨停的交易日数，support / resistance 软件算出的支撑位/压力位（含未回补缺口），macd（dif/dea/hist、红绿柱放大缩小、近几日金叉死叉），rsi6 / rsi14，bias5 5日线乖离%，alignment 均线排列，gaps 近期未回补缺口，strategies 命中的规则策略（只有策略候选才有），announcements 近30天公司公告（标题、日期、软件按关键词判断的方向和风险等级 risk 0–3），limitReason 当日同花顺涨停原因。消息面只能引用 announcements 里的公告，不要编造其他新闻。context（如有）是复盘页给出的诊断要点，可结合参考。`;

const PROFILE_RANK_SYSTEM = `你是A股短线交易研究助手。下面是用户自己挑的一批股票（不是规则选股的结果），软件已用日线算好每只的客观数据。请逐只评估次日是否值得优先关注。
要求：
- 只根据输入里给出的数据判断，不要编造新闻、公告、业绩或资金数据；输入没有的信息就不要提。
- 综合考虑：趋势与均线位置、近期涨幅与位置高低、量能与流动性、涨停/炸板记录与连板高度、涨停原因与市场热点、市场情绪。
- ${PROFILE_FIELDS}
- 分数 0–100（越高越值得次日优先关注），评级只能是“重点关注 / 关注 / 观望 / 回避”之一，与分数一致（≥75 重点关注，60–74 关注，40–59 观望，<40 回避）。
- 每只股票：highlights 写看点（≤40字），risks 写主要风险（≤40字），nextDay 写次日具体关注点（≤40字；提到价位时只能用输入里的 support / resistance / ma 价格），reason 写相对基础分加减分的理由（≤40字）。
- 不构成投资建议，不要给出仓位或保证收益的说法。
只输出 JSON：{"items":[{"code":"600000","score":72,"rating":"关注","highlights":"…","risks":"…","nextDay":"…","reason":"…"}]}，覆盖输入里的每一只股票。`;

const REVIEW_SYSTEM = `你是A股短线交易研究助手。请对用户指定的一只股票做详细点评，软件已用日线算好它的客观数据。
要求：
- 只根据输入里给出的数据判断，不要编造新闻、公告、业绩或资金数据；输入没有的信息就不要提。
- ${PROFILE_FIELDS}
- score 0–100（越高越值得次日优先关注），rating 只能是“重点关注 / 关注 / 观望 / 回避”之一，与分数一致（≥75 重点关注，60–74 关注，40–59 观望，<40 回避）。
- trend：趋势与所处位置（≤80字）；volume：量能与资金活跃度（≤60字）；highlights：看点（≤80字）；risks：主要风险（≤80字）；nextDay：次日具体关注点（≤80字）；keyLevels：关键价位怎么看（≤80字）；reason：相对基础分加减分的理由（≤40字）。
- 提到价位时只能使用输入里的 support / resistance / ma 价格，不要自己算新价位。
- 不构成投资建议，不要给出仓位或保证收益的说法。
只输出 JSON：{"score":65,"rating":"关注","trend":"…","volume":"…","highlights":"…","risks":"…","nextDay":"…","keyLevels":"…","reason":"…"}`;

const SUMMARY_SYSTEM = `你是A股短线复盘助手。用户的软件收盘后用固定规则从全市场（剔除ST）选出了一批股票，并附有当日涨停生态数据。请写一份简短的选股复盘。
要求：
- 只根据输入数据，不要编造新闻、政策或个股消息。
- headline：一句话结论（≤30字）。
- market：市场情绪与赚钱效应判断（≤150字），引用输入里的涨停数、封板率、最高连板等数字。
- themes：本轮选股集中的方向（最多5个），每个写名称和涉及的股票名称（来自输入）。
- focus：最值得次日重点跟踪的股票（最多6只，代码必须来自输入），每只写理由（≤40字）。
- risks：次日需要警惕的风险（最多4条，每条≤40字）。
- 不构成投资建议。
只输出 JSON：{"headline":"…","market":"…","themes":[{"name":"…","stocks":["…"]}],"focus":[{"code":"600000","name":"…","reason":"…"}],"risks":["…"]}`;

function validateRanking(result, picks) {
  const byCode = new Map(picks.map(item => [item.code, item]));
  const items = [];
  const seen = new Set();
  for (const raw of Array.isArray(result?.items) ? result.items : []) {
    const code = String(raw?.code || "").match(/\d{6}/)?.[0] || "";
    if (!byCode.has(code) || seen.has(code)) continue;
    const score = Math.round(Math.min(100, Math.max(0, Number(raw?.score))));
    if (!Number.isFinite(score)) continue;
    seen.add(code);
    const rating = RATINGS.includes(raw?.rating) ? raw.rating : score >= 75 ? "重点关注" : score >= 60 ? "关注" : score >= 40 ? "观望" : "回避";
    items.push({ code, name: byCode.get(code).name, score, rating,
      highlights: clip(raw?.highlights, 60), risks: clip(raw?.risks, 60), nextDay: clip(raw?.nextDay, 60) });
  }
  if (!items.length) throw Object.assign(new Error("AI 没有给出可用的评分，请重试或换一个模型"), { code: "AI_BAD_OUTPUT" });
  return items.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
}

const ratingOf = score => score >= 75 ? "重点关注" : score >= 60 ? "关注" : score >= 40 ? "观望" : "回避";

/**
 * 按分析框架校验：AI 分落在基础分 ±15 内、命中硬规则封顶 59，评级按最终分重算；
 * AI 漏掉的股票按基础分给出，并注明。
 */
function validateFrameworkRanking(result, list, evaluations) {
  const byCode = new Map((Array.isArray(result?.items) ? result.items : []).map(raw => [String(raw?.code || "").match(/\d{6}/)?.[0] || "", raw]));
  const answered = list.filter(stock => byCode.has(stock.code)).length;
  if (!answered) throw Object.assign(new Error("AI 没有给出可用的评分，请重试或换一个模型"), { code: "AI_BAD_OUTPUT" });
  return list.map(stock => {
    const raw = byCode.get(stock.code);
    // 自动编排：按 AI 为这只股票选的策略和权重重新合成基础分；没选或选得无效时用软件默认组合。
    const evaluation = raw ? frameworks.applyOrchestration(evaluations.get(stock.code), raw.plays, clip(raw.orchestration, 40)) : evaluations.get(stock.code);
    const score = frameworks.settleScore(raw ? raw.score : evaluation.base, evaluation);
    return {
      code: stock.code, name: stock.name, score, rating: ratingOf(score),
      highlights: clip(raw?.highlights, 60), risks: clip(raw?.risks, 60), nextDay: clip(raw?.nextDay, 60),
      reason: raw ? clip(raw?.reason, 50) : "AI 没有评估这只，按基础分",
      ...frameworkFields(evaluation, score)
    };
  }).sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
}

function validateSummary(result, picks) {
  const byCode = new Map(picks.map(item => [item.code, item]));
  const names = new Set(picks.map(item => item.name));
  const headline = clip(result?.headline, 40);
  const market = clip(result?.market, 240);
  if (!headline && !market) throw Object.assign(new Error("AI 没有给出可用的总结，请重试"), { code: "AI_BAD_OUTPUT" });
  return {
    headline, market,
    themes: (Array.isArray(result?.themes) ? result.themes : []).slice(0, 5).map(theme => ({
      name: clip(theme?.name, 16),
      stocks: (Array.isArray(theme?.stocks) ? theme.stocks : []).map(item => clip(item, 12)).filter(name => names.has(name)).slice(0, 8)
    })).filter(theme => theme.name),
    focus: (Array.isArray(result?.focus) ? result.focus : []).map(item => {
      const code = String(item?.code || "").match(/\d{6}/)?.[0] || "";
      return byCode.has(code) ? { code, name: byCode.get(code).name, reason: clip(item?.reason, 60) } : null;
    }).filter(Boolean).slice(0, 6),
    risks: (Array.isArray(result?.risks) ? result.risks : []).map(item => clip(item, 60)).filter(Boolean).slice(0, 4)
  };
}

/** 交给 AI 的框架评估（基础分、各维度分和依据、命中的硬规则）；自动编排时给情境标签和各策略的预评估。 */
const frameworkInput = evaluation => evaluation.candidates ? {
  situation: evaluation.situation,
  candidates: evaluation.candidates.slice(0, 6).map(item => ({ id: item.id, name: item.name, fit: item.fit, base: item.base, ...(item.caps.length ? { caps: item.caps } : {}) })),
  softwareDefault: evaluation.plays.map(item => ({ id: item.id, weight: item.weight }))
} : { name: evaluation.name, base: evaluation.base, caps: evaluation.caps,
  dims: evaluation.dims.map(item => ({ label: item.label, weight: item.weight, score: item.score, note: item.note })) };

/** 打分条目里的框架字段：基础分、AI 调整、维度明细、硬规则；自动编排另带所选策略、情境和编排理由。 */
const frameworkFields = (evaluation, score) => ({
  base: evaluation.base, adjust: score - evaluation.base, framework: evaluation.name, dims: evaluation.dims, caps: evaluation.caps,
  ...(evaluation.plays ? { plays: evaluation.plays, situation: evaluation.situation, orchestration: evaluation.orchestration } : {})
});

function strategyCatalogText(patterns) {
  const factors = catalog.factors.map(item => `factor:${item.id} — ${item.label}：${item.detail}${item.group === "external" ? "（需个股数据，批量选股时为待确认）" : ""}${item.gate ? "（门槛条件）" : ""}`);
  const rules = patterns.map(item => `pattern:${item.id} — ${item.name}：${clip(item.detail, 60)}`);
  const filters = catalog.filters.map(item => `${item.key}：${item.label}（${item.min}–${item.max}${item.unit}${item.integer ? "，整数" : ""}）`);
  return [
    "可用条件（ref）：", ...factors, ...rules, "",
    "可选数值过滤（filters）：", ...filters,
    "filters.excludeOnePriceToday: true 表示排除当日一字涨停",
    `filters.boards：板块范围，取值 ${catalog.boards.map(item => `${item.id}(${item.label})`).join("、")}，不填表示全部板块`,
    `universe：${catalog.universes.map(item => `${item.id}(${item.label})`).join("、")}`
  ].join("\n");
}

const STRATEGY_SYSTEM = `你是A股选股软件的策略配置助手。用户用大白话描述想要的选股条件，你要把它翻译成软件「我的策略」的配置。
规则：
- 只能使用下面列出的条件 ref 和过滤项，不能自创条件；描述里无法对应的部分写进 notes 说明“无法实现”。
- conditions 是数组，每项 {"ref":"factor:xxx 或 pattern:xxx","required":true/false}；required=true 表示必须满足。
- minMatchPercent：非必要条件中至少满足的比例（0–100 整数，默认 70）。
- requiredAnyGroups：可选，“至少满足其一”的分组，每组是两个以上已选 ref 的数组。
- name ≤ 20 字，description ≤ 80 字。
只输出 JSON：{"name":"…","description":"…","universe":"limit_pool","conditions":[{"ref":"…","required":true}],"requiredAnyGroups":[],"minMatchPercent":70,"filters":{},"notes":"…"}`;

/** 用户在设置里写的额外要求：追加在系统提示后面，内置规则（不编造、输出格式、分数范围）仍然优先。 */
function withInstructions(system, instructions) {
  const extra = clip(instructions, 1000);
  return extra ? `${system}

用户的额外要求（请尽量照做；与上面的规则或输出格式冲突时，以上面为准）：
${extra}` : system;
}

function createAiSelection({ ai }) {
  async function rankPicks({ picks, market, asOfDate, instructions } = {}, { signal } = {}) {
    const list = sanitizePicks(picks);
    if (!list.length) throw Object.assign(new Error("本轮没有可供 AI 评估的股票"), { code: "AI_NO_INPUT" });
    const cleanMarket = sanitizeMarket(market);
    const outcomes = await inBatches(list, async batch => {
      const user = JSON.stringify({ asOfDate: String(asOfDate || ""), market: cleanMarket, stocks: batch });
      const result = await ai.chat({ system: withInstructions(RANK_SYSTEM, instructions), user, json: true, temperature: 0.2, maxTokens: 4000, signal });
      return validateRanking(result, batch);
    });
    const items = outcomes.flatMap(item => item.ok ? item.value : []).sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
    const missed = outcomes.filter(item => !item.ok).reduce((sum, item) => sum + item.batch.length, 0);
    return { asOfDate: String(asOfDate || ""), model: ai.model(), generatedAt: new Date().toISOString(), items, evaluated: items.length, ...(missed ? { missed } : {}) };
  }

  async function dailySummary({ picks, market, asOfDate, strategyCounts, instructions } = {}, { signal } = {}) {
    const list = sanitizePicks(picks);
    if (!list.length) throw Object.assign(new Error("本轮没有选出股票，无法生成总结"), { code: "AI_NO_INPUT" });
    const counts = (Array.isArray(strategyCounts) ? strategyCounts : []).map(item => ({ name: clip(item?.name, 20), count: Number.isInteger(item?.count) ? item.count : 0 }))
      .filter(item => item.name && item.count > 0).slice(0, 40);
    const user = JSON.stringify({ asOfDate: String(asOfDate || ""), market: sanitizeMarket(market), strategyCounts: counts, stocks: list });
    const result = await ai.chat({ system: withInstructions(SUMMARY_SYSTEM, instructions), user, json: true, temperature: 0.4, maxTokens: 3000, signal });
    return { asOfDate: String(asOfDate || ""), model: ai.model(), generatedAt: new Date().toISOString(), ...validateSummary(result, list) };
  }

  async function draftStrategy({ text, patterns } = {}, { signal } = {}) {
    const request = clip(text, 400);
    if (!request) throw Object.assign(new Error("请先用一句话描述想要的选股条件"), { code: "AI_NO_INPUT" });
    const patternList = (Array.isArray(patterns) ? patterns : []).filter(item => item && /^[a-z0-9_]+$/i.test(String(item.id || "")))
      .map(item => ({ id: String(item.id), name: clip(item.name, 24), detail: clip(item.detail, 80) })).slice(0, 80);
    const patternIds = new Set(patternList.map(item => item.id));
    const user = `${strategyCatalogText(patternList)}\n\n用户描述：${request}`;
    const result = await ai.chat({ system: STRATEGY_SYSTEM, user, json: true, temperature: 0.1, maxTokens: 1500, signal });
    // 丢掉无法识别的条件后交给与保存相同的校验；校验不过就把原因告诉用户。
    const known = ref => /^factor:/.test(ref) ? catalog.factors.some(item => `factor:${item.id}` === ref) : /^pattern:/.test(ref) && patternIds.has(ref.slice(8));
    const conditions = (Array.isArray(result?.conditions) ? result.conditions : [])
      .map(item => ({ ref: String(item?.ref || "").trim(), required: item?.required === true })).filter(item => known(item.ref));
    const refs = new Set(conditions.map(item => item.ref));
    const draft = {
      name: clip(result?.name || "AI 生成策略", 20) || "AI 生成策略",
      description: clip(result?.description || request, 80),
      universe: catalog.universes.some(item => item.id === result?.universe) ? result.universe : catalog.defaults.universe,
      conditions,
      requiredAnyGroups: (Array.isArray(result?.requiredAnyGroups) ? result.requiredAnyGroups : [])
        .map(group => [...new Set((Array.isArray(group) ? group : []).map(String).filter(ref => refs.has(ref)))]).filter(group => group.length >= 2)
        .slice(0, catalog.limits.maxRequiredAnyGroups),
      minMatchPercent: Number.isFinite(Number(result?.minMatchPercent)) ? Math.round(Math.min(100, Math.max(0, Number(result.minMatchPercent)))) : catalog.defaults.minMatchPercent,
      filters: result?.filters && typeof result.filters === "object" && !Array.isArray(result.filters) ? result.filters : {}
    };
    let strategy;
    try { strategy = customStrategy.normalizeCustomStrategy(draft, { patternIds }); }
    catch (error) {
      // 过滤项不合法时去掉过滤再试一次，条件本身仍需有效。
      try { strategy = customStrategy.normalizeCustomStrategy({ ...draft, filters: {} }, { patternIds }); }
      catch { throw Object.assign(new Error(`AI 生成的策略不完整：${error?.message || error}。换个说法再试试`), { code: "AI_BAD_OUTPUT" }); }
    }
    return { strategy: { ...strategy, id: null, origin: "user" }, notes: clip(result?.notes, 200), model: ai.model() };
  }

  /** 用户自己挑的股票（体检数据）一起打分；输出与 rankPicks 相同的结构。 */
  async function rankProfiles({ profiles, market, asOfDate, instructions, framework } = {}, { signal } = {}) {
    const list = sanitizeProfiles(profiles);
    if (!list.length) throw Object.assign(new Error("还没有可供 AI 评估的股票"), { code: "AI_NO_INPUT" });
    const cleanMarket = sanitizeMarket(market);
    const evaluations = framework ? new Map(list.map(stock => [stock.code, frameworks.evaluateFramework(framework, stock, cleanMarket)])) : null;
    const system = framework ? `${PROFILE_RANK_SYSTEM}\n\n${frameworks.frameworkPrompt(framework)}` : PROFILE_RANK_SYSTEM;
    const outcomes = await inBatches(list, async batch => {
      const stocks = evaluations ? batch.map(stock => ({ ...stock, framework: frameworkInput(evaluations.get(stock.code)) })) : batch;
      const user = JSON.stringify({ asOfDate: String(asOfDate || ""), market: cleanMarket, stocks });
      const result = await ai.chat({ system: withInstructions(system, instructions), user, json: true, temperature: 0.2, maxTokens: framework?.id === "auto" ? 5500 : 4000, signal });
      return evaluations ? validateFrameworkRanking(result, batch, evaluations) : validateRanking(result, batch);
    });
    // 某一批失败：按框架时这批按基础分给出并注明，没有框架时这批不出分。
    const items = outcomes.flatMap(item => item.ok ? item.value : evaluations ? item.batch.map(stock => {
      const evaluation = evaluations.get(stock.code);
      const score = frameworks.settleScore(evaluation.base, evaluation);
      return { code: stock.code, name: stock.name, score, rating: ratingOf(score), highlights: "", risks: "", nextDay: "", reason: "AI 这一批没有返回，按基础分",
        fallback: true, ...frameworkFields(evaluation, score) };
    }) : []).sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
    const missed = outcomes.filter(item => !item.ok).reduce((sum, item) => sum + item.batch.length, 0);
    return { asOfDate: String(asOfDate || ""), model: ai.model(), generatedAt: new Date().toISOString(), items, evaluated: list.length - missed,
      ...(missed ? { missed } : {}), ...(framework ? { framework: framework.name } : {}) };
  }

  /** 单只股票详细点评：结构与打分条目相同，另加趋势、量能、关键价位三段。 */
  async function reviewStock({ profile, market, instructions, framework } = {}, { signal } = {}) {
    const [stock] = sanitizeProfiles([profile]);
    if (!stock) throw Object.assign(new Error("这只股票的日线数据不足，暂时无法点评"), { code: "AI_NO_INPUT" });
    const cleanMarket = sanitizeMarket(market);
    const evaluation = framework ? frameworks.evaluateFramework(framework, stock, cleanMarket) : null;
    const system = framework ? `${REVIEW_SYSTEM}\n\n${frameworks.frameworkPrompt(framework).replace("每只股票的 framework.base", "输入里 stock.framework.base").replace("每只股票的 framework.situation", "输入里 stock.framework.situation")}` : REVIEW_SYSTEM;
    const user = JSON.stringify({ market: cleanMarket, stock: evaluation ? { ...stock, framework: frameworkInput(evaluation) } : stock });
    const result = await ai.chat({ system: withInstructions(system, instructions), user, json: true, temperature: 0.3, maxTokens: 1500, signal });
    const [item] = evaluation ? validateFrameworkRanking({ items: [{ ...result, code: stock.code }] }, [stock], new Map([[stock.code, evaluation]]))
      : validateRanking({ items: [{ ...result, code: stock.code }] }, [stock]);
    const text = { trend: clip(result?.trend, 100), volume: clip(result?.volume, 80), highlights: clip(result?.highlights, 100),
      risks: clip(result?.risks, 100), nextDay: clip(result?.nextDay, 100), keyLevels: clip(result?.keyLevels, 100) };
    if (!text.trend && !text.highlights && !text.risks) throw Object.assign(new Error("AI 没有给出可用的点评，请重试或换一个模型"), { code: "AI_BAD_OUTPUT" });
    return { asOfDate: stock.asOfDate, model: ai.model(), generatedAt: new Date().toISOString(), evaluated: 1, items: [{ ...item, ...text }] };
  }

  return { rankPicks, dailySummary, draftStrategy, rankProfiles, reviewStock };
}

module.exports = { createAiSelection, sanitizePicks, sanitizeProfiles, validateFrameworkRanking, BATCH_SIZE, validateRanking, validateSummary, withInstructions, RATINGS, MAX_PICKS };
