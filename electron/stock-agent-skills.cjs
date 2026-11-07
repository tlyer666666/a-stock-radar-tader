"use strict";

/**
 * AI 问股的「分析打法」（1.6.54）：每种打法是一套方法论——必须查哪些数据、按哪些要点判断、回答侧重什么。
 * 用户每次可以任选 1–3 种叠加（不选 = AI 自己决定怎么分析），也可以自己写打法保存。
 * 打法里的「软件实测」只写本软件在 2021–2026 全A日线回放里两段一致的结论，不写没验证过的胜率。
 */

const MAX_SELECTED = 3;
const MAX_CUSTOM = 20;
const MAX_CUSTOM_TOOLS = 6;
const MAX_METHOD = 600;
const MAX_PREFETCH = 12;

const SKILL_GROUPS = ["短线情绪", "波段趋势", "量价技术", "消息资金", "持仓风控"];

/** tools：这个打法必须看的数据（工具 id，`kline:30` 表示看 30 根日K）。 */
const BUILTIN_SKILLS = [
  { id: "relay_board", group: "短线情绪", name: "打板接力", summary: "连板股能不能接、次日怎么接",
    tools: ["limit_status", "market", "sector", "intraday", "kline:10"],
    method: [
      "先看情绪：涨停家数、封板率、最高连板、跌停家数；炸板多、跌停多、高度被压缩时属于退潮期，不接力",
      "个股地位：连板高度在市场梯队里的位置，是否板块内最高板、最先涨停；涨停原因是否在当日涨停原因前列（主线）",
      "封板质量：首封时间越早越好，开板次数少，封单额占流通市值高，换手不过度",
      "龙虎榜与热度：游资、机构净买入，热股榜排名",
      "软件实测：2021–2026 全A回放里，当日涨停或连板的股票次日开盘买入，之后 5 日平均跑输全市场（两段一致）；只有情绪上升期的龙头才值得接"
    ],
    focus: "给出可接 / 观望 / 不接，写清次日的入场条件（高开幅度、竞价与开盘承接）和放弃条件（炸板、低开破位）" },
  { id: "first_board", group: "短线情绪", name: "首板挖掘", summary: "首板的位置、质量和二板可能",
    tools: ["limit_status", "sector", "market", "kline:30", "announcements"],
    method: [
      "位置：离 60 日高点、低点和 60 日线的距离；深跌后的底部首板好于高位首板",
      "质量：首封时间、封单额、开板次数，放量倍数（对比 20 日均量）",
      "题材：涨停原因是否属于当日主线、板块有无跟风涨停，公告或消息能否持续",
      "软件实测：精选策略「深跌底部首板」在 2021–2023、2024–2026 两段的 10 日或 20 日表现都跑赢全市场；20 日涨幅大、5 日乖离大的股票之后平均跑输"
    ],
    focus: "判断首板属于哪一类（底部启动 / 题材跟风 / 高位加速），二板的条件和次日应对" },
  { id: "dragon_leader", group: "短线情绪", name: "龙头战法", summary: "是不是板块龙头、龙头还在不在",
    tools: ["limit_status", "sector", "market", "sector_rank"],
    method: [
      "辨识度：在板块内涨幅、连板高度是否第一，是否最早涨停，热股榜排名",
      "板块效应：板块涨停家数和上涨家数，有无跟风梯队；板块是否当日主线",
      "空间：与市场最高板的关系，是否空间板",
      "龙头断板后看能否守住关键位、是否出现分歧转一致；跟风股不按龙头对待"
    ],
    focus: "明确它是龙头、跟风还是补涨，龙头地位是否还在，以及对应的参与方式" },
  { id: "weak_to_strong", group: "短线情绪", name: "弱转强反包", summary: "炸板或大阴后能否转强",
    tools: ["limit_status", "intraday", "kline:10", "market"],
    method: [
      "前提：前一两日炸板、烂板或放量大阴，当前位置不在明显高位",
      "转强信号：高开、放量，股价站稳分时均价线，反包前一日阴线实体",
      "失败信号：高开低走、跌破前一日最低价、分时长时间在均价线下方",
      "情绪配合：当日市场炸板率、板块是否回流"
    ],
    focus: "判断是否出现弱转强，给出确认价位和失败离场价位" },
  { id: "pullback_low", group: "短线情绪", name: "低吸回踩", summary: "强势股回调到哪里能低吸",
    tools: ["kline:20", "intraday", "limit_status", "strategies"],
    method: [
      "前提：近 10 个交易日内有涨停或连板，属于强势股",
      "回调要缩量：回调期间日均量明显低于涨停日（不到六成为佳）",
      "支撑要守住：不破涨停日最低价，回踩 5 日或 10 日线企稳；跌破即放弃",
      "不追高、分批，止损放在涨停日低点下方",
      "软件实测：「连板后缩量回调」在 2021–2023、2024–2026 两段都好于随便买一只近期涨停股，「深跌首板后缩量回踩」两段都跑赢全市场"
    ],
    focus: "给出低吸区间、确认信号和止损位，说明现在是否已到低吸位置" },
  { id: "avoid_risk", group: "短线情绪", name: "避雷排雷", summary: "逐条排查风险，决定要不要回避",
    tools: ["announcements", "news", "limit_status", "diagnosis"],
    method: [
      "公告风险：减持、问询函、立案调查、业绩预亏或下修、质押、异常波动公告后的监管",
      "交易风险：炸板、跌停、龙虎榜机构卖出、高位放量滞涨、连板后放量长上影",
      "流动性：20 日均成交额过低、换手异常",
      "软件综合研判里的风险提示与 ATR 止损位"
    ],
    focus: "按高、中、低列出风险清单，给出是否回避及理由" },

  { id: "trend_follow", group: "波段趋势", name: "趋势跟随", summary: "趋势是否成立、能拿多久",
    tools: ["kline:30", "diagnosis", "strategies"],
    method: [
      "均线：多头排列，20 日和 60 日线向上，股价沿 10 或 20 日线运行",
      "量价：上涨放量、回调缩量；回撤幅度不破前低",
      "MACD 在零轴上方，没有明显顶背离",
      "趋势破坏：收盘有效跌破 20 日线并放量，或出现顶背离后跌破前低"
    ],
    focus: "判断趋势阶段（启动 / 主升 / 末端），给出持有条件和趋势破坏的价位" },
  { id: "bottom_reversal", group: "波段趋势", name: "底部反转", summary: "深跌之后是否止跌转向",
    tools: ["kline:40", "strategies", "score"],
    method: [
      "跌幅深度：离 60 日线的距离、60 日跌幅",
      "止跌信号：缩量、长下影、底分型，不再创新低",
      "启动信号：首次放量阳线或底部首板，收复 10 日线",
      "软件实测：离 60 日线越远的深跌股之后表现越好（2021–2023、2024–2026 两段一致）；但只看跌得深、没有止跌或启动信号的纯超跌规则，按信号日等权反而跑输",
      "失败条件：再创新低或跌破启动阳线最低价"
    ],
    focus: "判断处在下跌中继、止跌还是反转确认，给出试探买点和失败位" },
  { id: "platform_breakout", group: "波段趋势", name: "平台突破", summary: "横盘整理后的突破真假",
    tools: ["kline:40", "intraday"],
    method: [
      "平台：近 20 日高低振幅小（约 15% 以内），整理期缩量",
      "突破：放量（量比 1.5 以上）收在平台上沿之上",
      "确认：突破后回踩不破平台上沿；假突破是冲高回落、收盘回到平台内"
    ],
    focus: "给出平台上下沿价位，判断突破真假和回踩确认的位置" },
  { id: "ma_pullback", group: "波段趋势", name: "均线回踩", summary: "回踩 10/20/60 日线能否企稳",
    tools: ["kline:30"],
    method: [
      "前提：均线多头或至少 20、60 日线向上",
      "回踩：股价回到 10、20 或 60 日线附近，缩量",
      "企稳：长下影、阳包阴等止跌 K 线；有效跌破该均线即止损"
    ],
    focus: "指出正在回踩哪条均线、是否企稳，给出买点和止损" },
  { id: "swing_band", group: "波段趋势", name: "区间高抛低吸", summary: "在震荡区间里怎么做波段",
    tools: ["kline:40", "diagnosis"],
    method: [
      "区间：近 20、60 日高低点构成的震荡区间，现价在区间的位置",
      "靠近支撑、缩量时低吸；靠近压力、放量滞涨时减仓",
      "参考软件给出的支撑压力位和 ATR 止损止盈；区间被放量突破或跌破时改按趋势处理"
    ],
    focus: "给出区间上下沿、当前位置和对应的高抛低吸价位" },

  { id: "volume_price", group: "量价技术", name: "量价分析", summary: "从量价关系看资金进出",
    tools: ["kline:20", "intraday"],
    method: [
      "量比、换手、成交额与 20 日均量对比",
      "量价组合：放量上涨、缩量回调为健康；放量滞涨、高位天量、缩量上涨要警惕",
      "分时：上午与下午成交额分布，股价在均价线上方的时间占比"
    ],
    focus: "说明当前的量价关系属于哪种、透露了什么资金意图" },
  { id: "indicator_resonance", group: "量价技术", name: "指标共振", summary: "MACD、RSI、乖离是否同向",
    tools: ["kline:30", "diagnosis"],
    method: [
      "MACD：金叉死叉、零轴位置、红绿柱放大或缩小",
      "RSI6 与 RSI14：超买（80 以上）、超卖（20 到 30 以下）",
      "5 日乖离：偏离 5 日线过大容易回落；背离：价格新高而指标没新高",
      "几项同向才算共振；软件实测 RSI 过高、5 日乖离过大的股票之后平均跑输"
    ],
    focus: "逐项列出指标状态，判断是否共振以及方向" },
  { id: "intraday_t", group: "量价技术", name: "分时做T", summary: "盘中高抛低吸的价位",
    tools: ["intraday", "quote", "kline:5"],
    method: [
      "看分时均价线：价格在上方偏强、在下方偏弱",
      "早盘冲高回落、尾盘拉升或跳水，日内高低点出现的时间",
      "高抛价位、低吸价位只能用分时里出现过的价格、均价和昨收；收盘后或休市时改为次日预案"
    ],
    focus: "给出日内（或次日）的高抛价、低吸价和不做T的情形" },

  { id: "news_catalyst", group: "消息资金", name: "消息驱动", summary: "公告和消息的影响与持续性",
    tools: ["announcements", "news", "limit_status", "sector"],
    method: [
      "逐条看公告和资讯的利好利空、影响大小（订单、业绩、重组、减持等）",
      "是否已被股价反映：消息出来后的涨跌幅",
      "题材是否在当日涨停原因前列、有无异动原因说明",
      "持续性：一次性消息与业绩、订单类消息区别对待"
    ],
    focus: "说清消息的性质和力度、已反映多少、后续还能不能发酵" },
  { id: "sector_rotation", group: "消息资金", name: "板块轮动", summary: "所在板块强不强、在不在主线",
    tools: ["sector", "market", "sector_rank"],
    method: [
      "所属行业在行业榜的排名、涨跌家数、主力净流入",
      "是否当日主线：涨停原因前列、板块涨停家数",
      "个股在板块内的地位（领涨、跟风或落后）",
      "轮动节奏：强板块分歧时谁能接力，弱板块是否有补涨"
    ],
    focus: "判断板块处在启动、高潮、分歧还是退潮，个股应如何对待" },
  { id: "capital_game", group: "消息资金", name: "资金博弈", summary: "龙虎榜和热度里的资金动向",
    tools: ["limit_status", "sector", "intraday"],
    method: [
      "龙虎榜：买卖总额、净买入、机构与游资各自净买、上榜席位",
      "热度：24 小时热股榜、飙升榜排名，异动原因",
      "板块资金净流入方向",
      "软件拿不到逐笔主力资金数据，不推测「主力」动向，只用以上数据说话"
    ],
    focus: "判断资金是在接力、分歧还是出货，以及对后续走势的含义" },

  { id: "holding_check", group: "持仓风控", name: "持仓诊断", summary: "已持有时该拿、减还是走",
    tools: ["diagnosis", "kline:20", "intraday"],
    method: [
      "问题里提到成本价时算出当前盈亏比例；没提到就按现价分析",
      "止损：软件 ATR 止损价、关键支撑位，跌破即离场",
      "止盈与减仓：接近压力位、放量滞涨、指标过热时分批",
      "继续持有的前提条件要写具体；不给具体仓位比例"
    ],
    focus: "分情景给出继续持有、减仓、离场的触发价位" },
  { id: "risk_reward", group: "持仓风控", name: "风险收益比", summary: "买点、止损、目标，值不值得做",
    tools: ["diagnosis", "kline:30"],
    method: [
      "买点：按现价或回踩到的支撑位",
      "止损：最近的有效支撑或软件 ATR 止损价，取更近、更明确的那个",
      "目标：上方第一、第二压力位（前高、缺口、均线）",
      "风险收益比 =（目标 − 买点）÷（买点 − 止损），不到 2 倍的不值得做；写出计算过程，价位只用数据里出现过的"
    ],
    focus: "列出买点、止损、目标和风险收益比，给出做或不做" }
];

const BUILTIN_BY_ID = new Map(BUILTIN_SKILLS.map(skill => [skill.id, skill]));
const clip = (value, max) => {
  const text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  return [...text].length > max ? [...text].slice(0, max).join("") : text;
};

/** "kline:30" → { tool: "kline", args: { days: 30 } }；其他工具只需要股票代码。 */
function parseToolSpec(spec) {
  const [tool, extra] = String(spec).split(":");
  return { tool, days: extra ? Number(extra) : null };
}

/** 自定义打法：名称 ≤12 字、方法 ≤600 字、数据最多 6 项（只能从工具清单里选）。 */
function normalizeCustomSkill(raw, { toolIds, id } = {}) {
  const name = clip(raw?.name, 12).replace(/\s+/g, " ");
  if (!name) throw Object.assign(new Error("请给打法起个名字"), { code: "AGENT_INVALID" });
  const method = clip(raw?.method, MAX_METHOD);
  if ([...method].length < 6) throw Object.assign(new Error("请写下这套打法的判断要点（至少 6 个字）"), { code: "AGENT_INVALID" });
  const allowed = toolIds instanceof Set ? toolIds : new Set(toolIds || []);
  const tools = [...new Set((Array.isArray(raw?.tools) ? raw.tools : []).map(String).filter(tool => allowed.has(tool) && tool !== "search_stock"))].slice(0, MAX_CUSTOM_TOOLS);
  return { id: id || String(raw?.id || ""), name, method, tools, group: "我的打法", custom: true };
}

/** 选中的打法 id → 打法对象（内置或自定义），去重、最多 3 个，不认识的忽略。 */
function resolveSkills(ids, custom = []) {
  const byId = new Map([...BUILTIN_BY_ID, ...custom.map(skill => [skill.id, skill])]);
  return [...new Set((Array.isArray(ids) ? ids : []).map(String))].map(id => byId.get(id)).filter(Boolean).slice(0, MAX_SELECTED);
}

/** 这几个打法要求的数据里，能在第一轮前直接读的（需要股票的工具要有关注股票）。 */
function skillPrefetchCalls(skills, focus, base = []) {
  const calls = new Map(base.map(tool => [tool, { tool, args: focus ? { code: focus.code } : {} }]));
  for (const skill of skills) {
    for (const spec of skill.tools || []) {
      const { tool, days } = parseToolSpec(spec);
      if (tool === "market") { calls.set(tool, { tool, args: {} }); continue; }
      if (tool === "sector_rank") { calls.set(tool, { tool, args: { kind: "industry", sortBy: "change", top: 10 } }); continue; }
      if (!focus) continue;
      const previous = calls.get(tool);
      if (tool === "kline") {
        const want = Math.max(days || 20, previous?.args?.days || 0);
        calls.set(tool, { tool, args: { code: focus.code, days: Math.min(60, want) } });
      } else if (!previous) calls.set(tool, { tool, args: { code: focus.code } });
    }
  }
  return [...calls.values()].slice(0, MAX_PREFETCH);
}

/** 写进系统提示词的打法说明。 */
function skillPromptText(skills, toolName = id => id) {
  if (!skills.length) return "";
  const blocks = skills.map(skill => {
    const tools = (skill.tools || []).map(spec => { const { tool, days } = parseToolSpec(spec); return `${toolName(tool)}${days ? `（${days}根）` : ""}`; });
    const method = (Array.isArray(skill.method) ? skill.method : String(skill.method || "").split(/\n+/)).map(line => line.replace(/^[\s\-•·*\d.、]+/, "").trim()).filter(Boolean);
    return `【${skill.name}】${skill.summary ? `：${skill.summary}` : ""}${skill.custom ? "（用户自己写的打法）" : ""}
  必看数据：${tools.length ? tools.join("、") : "按需"}
  判断要点：
${method.map(line => `  - ${line}`).join("\n")}${skill.focus ? `
  回答重点：${skill.focus}` : ""}`;
  });
  return `用户这次指定了分析打法，请按这些方法论分析（打法的判断要点优先于上面的通用结构）：
${blocks.join("\n")}
按打法分析的要求：
- 先查齐每个打法的必看数据（initialData 里已有的不用再查）。
- 回答用「### 打法：名称」分节，逐条对照判断要点写出这只股票的实际数据和结论；之后再写关键价位表和操作思路。
- 第一行的结论要回答：现在是否符合这些打法的参与条件。全文 500–1400 字，每个打法的对照写要点、不写套话。
- 在 final.skillVerdicts 里对每个打法给出 {"skill":"打法名称","verdict":"符合|接近|不符合|不适用","reason":"≤40字的依据"}；多个打法结论冲突时如实写出，并说明更倾向哪个。`;
}

const VERDICTS = ["符合", "接近", "不符合", "不适用"];
function normalizeVerdicts(raw, skills) {
  if (!skills.length || !Array.isArray(raw)) return [];
  const names = new Map(skills.map(skill => [skill.name, skill]));
  return raw.map(item => {
    const skill = names.get(String(item?.skill || "").trim());
    if (!skill) return null;
    // 依据要求 ≤40 字，模型常常多写几个字：放宽到 64 字，超出时加省略号（别把「1.3 倍」截成「1.」）。
    const reason = String(item?.reason || "").replace(/\s+/g, " ").trim();
    return { skill: skill.name, id: skill.id, verdict: VERDICTS.includes(item?.verdict) ? item.verdict : "不适用", reason: [...reason].length > 64 ? `${[...reason].slice(0, 63).join("")}…` : reason };
  }).filter(Boolean).filter((item, index, list) => list.findIndex(other => other.id === item.id) === index);
}

/** 页面用的打法目录。 */
function skillCatalog(custom = [], toolName = id => id) {
  const describe = skill => ({ id: skill.id, name: skill.name, group: skill.group, summary: skill.summary || "", custom: skill.custom === true,
    tools: (skill.tools || []).map(spec => toolName(parseToolSpec(spec).tool)), ...(skill.custom ? { method: skill.method, toolIds: skill.tools } : {}) });
  return { groups: [...SKILL_GROUPS, "我的打法"], skills: [...BUILTIN_SKILLS.map(describe), ...custom.map(describe)], maxSelected: MAX_SELECTED, maxCustom: MAX_CUSTOM };
}

module.exports = { BUILTIN_SKILLS, SKILL_GROUPS, MAX_SELECTED, MAX_PREFETCH, MAX_CUSTOM, MAX_CUSTOM_TOOLS, MAX_METHOD, VERDICTS,
  parseToolSpec, normalizeCustomSkill, resolveSkills, skillPrefetchCalls, skillPromptText, normalizeVerdicts, skillCatalog };
