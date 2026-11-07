"use strict";

/**
 * AI 复盘：在软件算好的复盘数据之上写结论。
 *  1. marketReview —— 专业复盘 → 市场复盘：情绪周期、主线、梯队、指数、次日策略、风险。
 *  2. lookback     —— 回看上一次 AI 市场复盘的判断，用今天的数据逐条核对兑现情况。
 *  3. interpret    —— 涨停生态、炸板观察、板块强度三个页面的「AI 解读」。
 *
 * 发给模型的只有公开行情统计（涨跌家数、涨停/炸板/连板、指数、板块、题材），不含账户、持仓或密钥。
 * 模型输出逐字段校验、限长；主线名称必须来自输入里的板块或题材，回看结论只能是固定的几种。
 */

const { skillCatalogText } = require("./review-skills.cjs");

const clip = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
};
const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const round = (value, digits = 2) => finite(value) === null ? null : Number(value.toFixed(digits));
const pct = value => finite(value) === null ? null : round(value * 100, 1);
const list = (value, max) => (Array.isArray(value) ? value : []).slice(0, max);
const texts = (value, maxItems, maxLength) => list(value, maxItems * 2).map(item => clip(item, maxLength)).filter(Boolean).slice(0, maxItems);
const bad = message => Object.assign(new Error(message), { code: "AI_BAD_OUTPUT" });

const CYCLES = ["冰点", "启动", "发酵", "高潮", "分歧", "退潮", "修复", "混沌"];
const VERDICTS = ["兑现", "部分兑现", "未兑现", "无法判断"];
const CONFIDENCE = ["高", "中", "低"];

/** 专业复盘快照 → 交给 AI 的精简版（只留统计和名称）。 */
function compactMarketSnapshot(snapshot) {
  const s = snapshot && typeof snapshot === "object" ? snapshot : {};
  const ecology = s.ecology || {};
  const market = s.market || {};
  const fuyao = s.fuyao?.available ? s.fuyao : null;
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(s.date || "")) ? s.date : "",
    session: clip(s.session?.label || s.session || "", 12),
    softwareRegime: { name: clip(s.regime?.name, 12), posture: clip(s.regime?.posture, 30), score: finite(s.score) },
    dimensions: Object.fromEntries(Object.entries(s.dimensions || {}).filter(([, value]) => finite(value) !== null).slice(0, 10)),
    breadth: market.available === false ? null : { up: finite(market.upCount), down: finite(market.downCount), flat: finite(market.flatCount),
      upRatioPct: pct(market.breadth), averageReturnPct: round(finite(market.averageReturn)) },
    limits: {
      limitUp: finite(ecology.limitUpCount), limitDown: finite(ecology.limitDownCount), failedBoards: finite(ecology.failedBoards),
      failedRatePct: pct(ecology.failedRate), promotionRatePct: pct(ecology.promotionRate), firstBoards: finite(ecology.firstBoards),
      continuationBoards: finite(ecology.continuationBoards), maxHeight: finite(ecology.maxHeight ?? ecology.thsMaxBoards),
      sealRatePct: pct(ecology.sealRate), previousLimitUp: finite(ecology.previousLimitUpCount)
    },
    themes: list(ecology.themes, 6).map(item => ({ reason: clip(item?.reason, 16), count: finite(item?.count) })).filter(item => item.reason),
    indices: list(s.indices, 6).filter(item => item?.available !== false).map(item => ({
      name: clip(item?.name, 8), r1: round(finite(item?.returns?.r1)), r5: round(finite(item?.returns?.r5)),
      aboveMa20: finite(item?.close) !== null && finite(item?.ma20) !== null ? item.close >= item.ma20 : null, volumeRatio: round(finite(item?.volumeRatio)) })),
    sectors: list(s.focusSectors, 8).map(item => ({ name: clip(item?.name, 12), score: finite(item?.score) === null ? null : Math.round(item.score),
      verdict: clip(item?.verdict, 8), relativeReturn: round(finite(item?.relativeReturn)), limitUpSharePct: pct(finite(item?.poolShare)) })).filter(item => item.name),
    leaders: list(s.leaders, 10).map(item => ({ name: clip(item?.name, 8), boards: finite(item?.consecutiveBoards), industry: clip(item?.industry, 10),
      reason: clip(item?.thsReason || "", 20), openBoards: finite(item?.openBoardCount) })).filter(item => item.name),
    hot: fuyao ? list(fuyao.hotLists?.day?.hot || fuyao.hot, 8).map(item => clip(item?.name, 8)).filter(Boolean) : [],
    softwareRisks: texts(s.riskSignals, 6, 50)
  };
}

const MARKET_SYSTEM = `你是A股短线复盘助手。下面是软件收盘（或盘中）算好的市场复盘数据：涨跌家数、涨停/跌停/炸板/晋级率/连板高度、封板率、核心指数、强势板块、连板龙头、涨停题材和热股，以及软件自己的情绪判断（softwareRegime）和风险信号。请写一份盘后复盘。
要求：
- 只根据输入数据判断，引用具体数字；不要编造新闻、政策、资金流向或个股消息；输入没有的就不要提。
- headline：一句话结论（≤30字）。
- cycle.phase：情绪周期阶段，只能是 冰点/启动/发酵/高潮/分歧/退潮/修复/混沌 之一；cycle.reason：依据（≤80字，引用数字）。可以不同意软件的判断，但要说明理由。
- market：赚钱效应与情绪（≤150字）。
- mainlines：主线方向（最多4个），name 必须来自输入的 sectors 名称或 themes 题材，comment 写强度和持续性（≤60字）。
- ladder：连板梯队与高度空间（≤100字）。indices：指数结构（≤80字）。
- nextDay：posture 次日总体姿态（≤30字）；focus 次日重点关注（最多5条，每条≤40字）；avoid 次日回避（最多4条，每条≤40字）。
- risks：风险（最多4条，每条≤40字）。confidence：结论把握，高/中/低。
- 不构成投资建议，不给仓位比例，不说保证收益的话。
只输出 JSON：{"headline":"…","cycle":{"phase":"分歧","reason":"…"},"market":"…","mainlines":[{"name":"…","comment":"…"}],"ladder":"…","indices":"…","nextDay":{"posture":"…","focus":["…"],"avoid":["…"]},"risks":["…"],"confidence":"中"}`;

const MAX_SKILL_ROUNDS = 3;
const MAX_CALLS_PER_ROUND = 4;
/** 复盘技能模式：AI 自主决定调用哪些技能、调用几轮，最后写复盘。 */
const AGENT_SYSTEM = `你是A股盘后复盘分析师。输入 overview 是软件算好的市场概况（涨跌家数、涨停/跌停/炸板/晋级率/连板高度、封板率、指数、强势板块、连板龙头、题材、热股，以及软件自己的情绪判断 softwareRegime 和风险信号）。
你可以调用下面的「复盘技能」获取更多数据，自己决定先查什么、再查什么：
${skillCatalogText()}

工作方式（每一轮只输出一个 JSON）：
- 需要数据时输出 {"thought":"这一轮想弄清什么（≤60字）","calls":[{"skill":"技能id","args":{…}}]}，一轮最多 ${MAX_CALLS_PER_ROUND} 个技能；软件执行后把结果（skillResults）发给你。
- 信息足够时输出 {"thought":"…","final":{复盘 JSON}}。最多 ${MAX_SKILL_ROUNDS} 轮调用，之后必须给 final。
- 建议思路：先判断情绪周期（涨停/跌停/炸板/晋级率/高度），再找主线（板块强度、涨停原因、龙虎榜交叉验证，主线要有持续性和梯队），再看风险（炸板、跌停、高位股），必要时查龙头个股或板块成分，最后对照历次复盘看延续性。不是每个技能都要用，按需选择。
final 的要求：
- 只根据 overview 和技能结果判断，引用具体数字；不要编造新闻、政策、资金流向或个股消息；技能返回“暂不可用”的就不要提那部分。
- headline：一句话结论（≤30字）。cycle.phase 只能是 冰点/启动/发酵/高潮/分歧/退潮/修复/混沌 之一，cycle.reason 写依据（≤80字）。
- market：赚钱效应与情绪（≤150字）。mainlines：主线方向（最多4个），name 必须是 overview 或技能结果里出现过的板块、概念或涨停原因名称，comment 写强度与持续性（≤60字）。
- ladder：连板梯队与高度空间（≤100字）。indices：指数结构（≤80字）。
- nextDay：posture 次日总体姿态（≤30字），focus 次日重点关注（最多5条，每条≤40字），avoid 次日回避（最多4条，每条≤40字）。
- risks：风险（最多4条，每条≤40字）。confidence：高/中/低。
- 不构成投资建议，不给仓位比例，不说保证收益的话。
final 的格式：{"headline":"…","cycle":{"phase":"分歧","reason":"…"},"market":"…","mainlines":[{"name":"…","comment":"…"}],"ladder":"…","indices":"…","nextDay":{"posture":"…","focus":["…"],"avoid":["…"]},"risks":["…"],"confidence":"中"}`;

/** 技能结果里出现过的板块、概念、题材名称（主线名称可以引用它们）。 */
function namesFromResults(results) {
  const names = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 4 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.slice(0, 60).forEach(item => visit(item, depth + 1)); return; }
    for (const key of ["name", "reason"]) if (typeof value[key] === "string" && value[key].length <= 16) names.add(value[key]);
    for (const item of Object.values(value)) visit(item, depth + 1);
  };
  for (const result of results) if (result.ok && ["sector_strength", "limit_reasons", "sector_members"].includes(result.skill)) visit(result.data);
  return [...names];
}

const LOOKBACK_SYSTEM = `你是A股复盘助手，要对上一次的复盘判断做“事后核对”。输入 previous 是上一次 AI 复盘（日期、情绪周期、主线、次日重点关注、回避、风险），today 是今天软件算好的市场数据。
要求：
- 逐条核对 previous 里可以被今天数据验证的判断（情绪周期、主线是否延续、次日关注/回避方向、风险是否出现），最多 6 条。
- 每条：claim 写原判断（≤40字，来自 previous），result 只能是 兑现/部分兑现/未兑现/无法判断，evidence 写今天的数据依据（≤60字，引用数字）；今天数据无法验证的写“无法判断”，不要猜。
- summary：一句话总评（≤60字）；lessons：下次复盘要注意的地方（最多3条，每条≤50字）。
- 只根据输入数据，不要编造个股涨跌或新闻。
只输出 JSON：{"summary":"…","verdicts":[{"claim":"…","result":"兑现","evidence":"…"}],"lessons":["…"]}`;

const INTERPRET = {
  ecology: { title: "涨停生态", system: `你是A股短线复盘助手。下面是当日涨停生态数据（涨停/跌停/炸板数量、封板率、最高连板、涨停原因分布、连板股、热股等）。请解读当天的短线情绪和题材结构。` },
  "failed-boards": { title: "炸板观察", system: `你是A股短线复盘助手。下面是“前一交易日涨停、今日炸板或回落”的观察数据（股票、连板、炸板次数、今日表现、所属题材等）。请解读炸板情况反映的接力情绪，以及哪些值得继续观察、哪些要回避。` },
  sectors: { title: "板块强度", system: `你是A股复盘助手。下面是板块强度数据（板块名称、强度分、涨跌幅、涨停家数、领涨股等）。请解读当前主线和轮动结构。` }
};
const INTERPRET_RULES = `
要求：
- 只根据输入数据，引用具体数字；不要编造新闻、政策或个股消息。
- headline：一句话结论（≤30字）；points：要点（最多5条，每条≤60字）；risks：风险（最多3条，每条≤50字）；watch：接下来要观察什么（最多4条，每条≤50字）。
- 不构成投资建议，不给仓位比例。
只输出 JSON：{"headline":"…","points":["…"],"risks":["…"],"watch":["…"]}`;

/** 页面传来的数据：只留字符串、数字、布尔，限深度、限条数，总长度不超过约 12KB。 */
function compactData(value, depth = 0, maxDepth = 4) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? round(value, 3) : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return clip(value, 60);
  if (depth >= maxDepth) return null;
  if (Array.isArray(value)) return value.slice(0, 30).map(item => compactData(item, depth + 1, maxDepth)).filter(item => item !== null);
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (!/^[\w一-龥-]{1,30}$/.test(key) || /key|token|secret|password|cookie/i.test(key)) continue;
      const next = compactData(item, depth + 1, maxDepth);
      if (next !== null && !(Array.isArray(next) && !next.length)) out[key] = next;
    }
    return out;
  }
  return null;
}
function boundedJson(value, limit = 12000, maxDepth = 4) {
  let data = compactData(value, 0, maxDepth);
  let text = JSON.stringify(data);
  // 太长时逐步减少数组条数。
  for (const keep of [20, 12, 8, 5, 3]) {
    if (text.length <= limit) break;
    const shrink = item => Array.isArray(item) ? item.slice(0, keep).map(shrink) : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).map(([k, v]) => [k, shrink(v)])) : item;
    data = shrink(data);
    text = JSON.stringify(data);
  }
  return text.length <= limit * 1.5 ? text : "{}";
}

function validateMarketReview(result, input, extraNames = []) {
  const headline = clip(result?.headline, 40);
  const market = clip(result?.market, 220);
  if (!headline && !market) throw bad("AI 没有给出可用的复盘，请重试或换一个模型");
  const names = new Set([...input.sectors.map(item => item.name), ...input.themes.map(item => item.reason), ...extraNames]);
  const phase = CYCLES.includes(result?.cycle?.phase) ? result.cycle.phase : "混沌";
  return {
    headline, market,
    cycle: { phase, reason: clip(result?.cycle?.reason, 110) },
    mainlines: list(result?.mainlines, 8).map(item => ({ name: clip(item?.name, 16), comment: clip(item?.comment, 80) }))
      .filter(item => item.name && [...names].some(name => name && (name.includes(item.name) || item.name.includes(name)))).slice(0, 4),
    ladder: clip(result?.ladder, 140), indices: clip(result?.indices, 110),
    nextDay: { posture: clip(result?.nextDay?.posture, 40), focus: texts(result?.nextDay?.focus, 5, 50), avoid: texts(result?.nextDay?.avoid, 4, 50) },
    risks: texts(result?.risks, 4, 50),
    confidence: CONFIDENCE.includes(result?.confidence) ? result.confidence : "中",
    softwareRegime: input.softwareRegime.name || ""
  };
}

function validateLookback(result) {
  const verdicts = list(result?.verdicts, 10).map(item => ({ claim: clip(item?.claim, 50), result: VERDICTS.includes(item?.result) ? item.result : "无法判断", evidence: clip(item?.evidence, 80) }))
    .filter(item => item.claim).slice(0, 6);
  if (!verdicts.length) throw bad("AI 没有给出可用的回看结论，请重试");
  const judged = verdicts.filter(item => item.result !== "无法判断");
  const hit = judged.reduce((sum, item) => sum + (item.result === "兑现" ? 1 : item.result === "部分兑现" ? 0.5 : 0), 0);
  return { summary: clip(result?.summary, 80), verdicts, lessons: texts(result?.lessons, 3, 60),
    hitRatePct: judged.length ? Math.round(hit / judged.length * 100) : null, judged: judged.length };
}

function validateInterpret(result) {
  const headline = clip(result?.headline, 40);
  const points = texts(result?.points, 5, 80);
  if (!headline && !points.length) throw bad("AI 没有给出可用的解读，请重试");
  return { headline, points, risks: texts(result?.risks, 3, 60), watch: texts(result?.watch, 4, 60) };
}

/** 存档用的上一次复盘摘要（交给回看）。 */
function previousForLookback(review) {
  return review ? {
    date: String(review.asOfDate || ""), headline: clip(review.headline, 40), cycle: review.cycle?.phase || "",
    mainlines: list(review.mainlines, 4).map(item => item.name), posture: clip(review.nextDay?.posture, 40),
    focus: texts(review.nextDay?.focus, 5, 50), avoid: texts(review.nextDay?.avoid, 4, 50), risks: texts(review.risks, 4, 50)
  } : null;
}

function withInstructions(system, instructions) {
  const extra = clip(instructions, 1000);
  return extra ? `${system}\n\n用户的额外要求（请尽量照做；与上面的规则或输出格式冲突时，以上面为准）：\n${extra}` : system;
}

function createAiReview({ ai }) {
  const stamp = (asOfDate, value) => ({ asOfDate, model: ai.model(), generatedAt: new Date().toISOString(), ...value });

  async function marketReview({ snapshot, instructions, skills } = {}, { signal } = {}) {
    const input = compactMarketSnapshot(snapshot);
    if (!input.date) throw Object.assign(new Error("市场复盘数据还没准备好，请先刷新复盘页"), { code: "AI_NO_INPUT" });
    if (skills?.runSkill) return skillReview(input, skills, instructions, signal);
    const result = await ai.chat({ system: withInstructions(MARKET_SYSTEM, instructions), user: JSON.stringify(input), json: true, temperature: 0.4, maxTokens: 3000, signal });
    return stamp(input.date, validateMarketReview(result, input));
  }

  /**
   * 技能模式：AI 每轮决定调用哪些技能（最多 3 轮、每轮 4 个），软件执行后把结果发回，AI 信息够了就写复盘。
   * 记录每一轮的思路和调用了哪些技能，界面上可以展开看。
   * AI 一直不给结论时，用已拿到的技能结果再按普通模式写一次。
   */
  async function skillReview(input, skills, instructions, signal) {
    const system = withInstructions(AGENT_SYSTEM, instructions);
    const messages = [{ role: "user", content: JSON.stringify({ overview: input, remainingRounds: MAX_SKILL_ROUNDS }) }];
    const steps = [], results = [];
    const done = new Set();
    for (let round = 0; round <= MAX_SKILL_ROUNDS; round += 1) {
      const reply = await ai.chat({ system, messages, json: true, temperature: 0.3, maxTokens: 3000, signal });
      const thought = clip(reply?.thought, 80);
      const final = reply?.final && typeof reply.final === "object" ? reply.final : (reply?.headline || reply?.market) ? reply : null;
      if (final) {
        steps.push({ thought, calls: [] });
        return stamp(input.date, { ...validateMarketReview(final, input, namesFromResults(results)), mode: "skills", steps: steps.filter(step => step.thought || step.calls.length) });
      }
      const calls = list(reply?.calls, 8).map(call => ({ skill: String(call?.skill || ""), args: call?.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {} }))
        .filter(call => call.skill && !done.has(`${call.skill}:${JSON.stringify(call.args)}`)).slice(0, MAX_CALLS_PER_ROUND);
      if (round === MAX_SKILL_ROUNDS || !calls.length) {
        if (round === MAX_SKILL_ROUNDS) break;
        messages.push({ role: "assistant", content: JSON.stringify(reply || {}) }, { role: "user", content: JSON.stringify({ instruction: "请调用技能，或直接输出 final。" }) });
        continue;
      }
      calls.forEach(call => done.add(`${call.skill}:${JSON.stringify(call.args)}`));
      const outcome = await Promise.all(calls.map(call => skills.runSkill(call.skill, call.args)));
      results.push(...outcome);
      steps.push({ thought, calls: outcome.map((item, index) => ({ skill: item.skill, name: item.name, ok: item.ok, summary: item.summary, args: clip(JSON.stringify(calls[index].args), 60) })) });
      const remaining = MAX_SKILL_ROUNDS - round - 1;
      messages.push({ role: "assistant", content: JSON.stringify({ thought, calls }) },
        { role: "user", content: boundedJson({ skillResults: outcome.map(item => ({ skill: item.skill, ok: item.ok, summary: item.summary, data: item.data })), remainingRounds: remaining,
          ...(remaining === 0 ? { instruction: "调用次数已用完，下一步必须输出 final。" } : {}) }, 14000, 7) });
    }
    // 兜底：AI 没给结论，用已拿到的技能结果按普通模式写一次。
    const fallback = await ai.chat({ system: withInstructions(MARKET_SYSTEM, instructions), json: true, temperature: 0.4, maxTokens: 3000, signal,
      user: boundedJson({ ...input, skillResults: results.filter(item => item.ok).map(item => ({ skill: item.skill, summary: item.summary, data: item.data })) }, 16000, 7) });
    return stamp(input.date, { ...validateMarketReview(fallback, input, namesFromResults(results)), mode: "skills", steps: steps.filter(step => step.thought || step.calls.length) });
  }

  async function lookback({ previous, snapshot } = {}, { signal } = {}) {
    const before = previousForLookback(previous);
    if (!before?.date) throw Object.assign(new Error("还没有更早的 AI 市场复盘可以回看：先在之前的交易日生成一次"), { code: "AI_NO_INPUT" });
    const today = compactMarketSnapshot(snapshot);
    if (!today.date) throw Object.assign(new Error("市场复盘数据还没准备好，请先刷新复盘页"), { code: "AI_NO_INPUT" });
    const result = await ai.chat({ system: LOOKBACK_SYSTEM, user: JSON.stringify({ previous: before, today }), json: true, temperature: 0.2, maxTokens: 2000, signal });
    return stamp(today.date, { previousDate: before.date, previousHeadline: before.headline, ...validateLookback(result) });
  }

  async function interpret({ kind, data, asOfDate, instructions } = {}, { signal } = {}) {
    const spec = INTERPRET[kind];
    if (!spec) throw Object.assign(new TypeError("不支持的解读类型"), { code: "INVALID_IPC_PAYLOAD" });
    const user = boundedJson(data);
    if (user.length < 10) throw Object.assign(new Error("页面数据还没加载好，请稍后再试"), { code: "AI_NO_INPUT" });
    const result = await ai.chat({ system: withInstructions(`${spec.system}\n${INTERPRET_RULES}`, instructions), user, json: true, temperature: 0.4, maxTokens: 1500, signal });
    return stamp(String(asOfDate || ""), { kind, title: spec.title, ...validateInterpret(result) });
  }

  return { marketReview, lookback, interpret };
}

module.exports = { createAiReview, AGENT_SYSTEM, MAX_SKILL_ROUNDS, namesFromResults, compactMarketSnapshot, compactData, boundedJson, validateMarketReview, validateLookback, validateInterpret, previousForLookback, CYCLES, VERDICTS, INTERPRET };
