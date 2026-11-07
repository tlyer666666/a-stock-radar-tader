"use strict";

/**
 * 复盘技能（1.6.44）：AI 写市场复盘时可以自主调用的数据分析能力。
 * 每个技能只读软件已有的数据源（同花顺扶摇涨停/炸板/跌停池、连板天梯、热榜、龙虎榜、异动解读，板块强度榜，
 * 板块成分，个股日线体检，本机保存的历次 AI 复盘），返回精简后的统计和一句话摘要。
 * 不含账户、持仓或密钥；结果有长度上限。
 */

const clip = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
};
const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const round = (value, digits = 2) => finite(value) === null ? null : Number(value.toFixed(digits));
const yi = value => finite(value) === null ? null : round(value / 1e8, 2);
const take = (value, max) => (Array.isArray(value) ? value : []).slice(0, max);
const intArg = (value, low, high, fallback) => {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.max(low, Math.min(high, parsed)) : fallback;
};
const unavailable = what => { throw Object.assign(new Error(`${what}暂不可用（同花顺扶摇未配置或本次未取到）`), { code: "SKILL_UNAVAILABLE" }); };

const SKILLS = [
  { id: "sector_strength", name: "板块强度", description: "行业或概念板块当日涨幅、涨停家数、主力净流入排行", args: '{"kind":"industry|concept","sortBy":"change|limitUps|netInflow","top":10}' },
  { id: "limit_reasons", name: "涨停原因", description: "当日涨停股按同花顺涨停原因归类：题材、家数和代表股", args: '{"top":12}' },
  { id: "ladder", name: "连板梯队", description: "近 5 个交易日连板天梯（每档股票、次日是否晋级）和今日高度板", args: "{}" },
  { id: "broken_boards", name: "炸板与跌停", description: "炸板池、跌停池数量和代表股，封板率", args: "{}" },
  { id: "hot_stocks", name: "热股榜", description: "同花顺热股榜和飙升榜（人气与资金关注）", args: '{"period":"day|hour"}' },
  { id: "dragon_tiger", name: "龙虎榜", description: "龙虎榜净买入前列个股与活跃游资席位", args: "{}" },
  { id: "anomalies", name: "异动解读", description: "当日涨停、急涨、跌停、急跌个股的异动原因", args: '{"top":12}' },
  { id: "sector_members", name: "板块成分", description: "指定板块的成分股涨跌、涨停家数和广度（每次复盘最多查 2 个板块）", args: '{"name":"板块名称"}' },
  { id: "stock_check", name: "个股体检", description: "用日线给指定个股做体检：涨幅、均线排列、量比、连板、炸板、RSI、乖离、情境标签（最多 3 只）", args: '{"codes":["600000"]}' },
  { id: "history_reviews", name: "历次复盘", description: "本机保存的前几次 AI 市场复盘结论（情绪周期、主线、次日姿态），用于对比延续性", args: '{"count":3}' }
];
const SKILL_BY_ID = new Map(SKILLS.map(skill => [skill.id, skill]));

/** 写进提示词的技能清单。 */
function skillCatalogText() {
  return SKILLS.map(skill => `- ${skill.id}「${skill.name}」：${skill.description}；参数 ${skill.args}`).join("\n");
}

/**
 * @param {{ loadFuyao: () => Promise<any>, loadSectorBoard: () => Promise<any>, analyzeSector: (name: string) => Promise<any>,
 *   loadProfiles: (list: Array<{code: string, name: string}>) => Promise<{profiles: any[]}>, previousReviews: (count: number) => any[],
 *   situationOf?: (profile: any) => string[] }} sources
 */
function createReviewSkills(sources) {
  let fuyaoPromise = null, boardPromise = null, sectorCalls = 0;
  const fuyao = () => (fuyaoPromise ||= Promise.resolve().then(() => sources.loadFuyao()).then(value => value?.available ? value : null).catch(() => null));
  const board = () => (boardPromise ||= Promise.resolve().then(() => sources.loadSectorBoard()));

  const run = {
    async sector_strength(args) {
      const kind = args?.kind === "concept" ? "concept" : "industry";
      const sortBy = ["change", "limitUps", "netInflow"].includes(args?.sortBy) ? args.sortBy : "change";
      const top = intArg(args?.top, 3, 15, 10);
      const value = await board();
      const rows = kind === "concept"
        ? take(value?.concepts, 600).map(row => ({ name: row.name, changePct: round(row.changePct), limitUps: row.limitUps, netInflowYi: yi(row.netInflow), limitUpStocks: take(row.limitUpStocks, 4).map(item => item.name) }))
        : take(value?.industries, 200).map(row => ({ name: row.name, changePct: round(finite(row.returns?.r1) ?? finite(row.memberAverageReturn)), limitUps: finite(row.poolLimitUps ?? row.limitUps),
          netInflowYi: yi(row.netInflow), leader: clip(row.leaderName, 8) }));
      if (!rows.length) throw new Error(`${kind === "concept" ? "概念" : "行业"}板块榜暂不可用`);
      const key = sortBy === "change" ? "changePct" : sortBy === "limitUps" ? "limitUps" : "netInflowYi";
      const sorted = [...rows].sort((a, b) => (finite(b[key]) ?? -Infinity) - (finite(a[key]) ?? -Infinity)).slice(0, top);
      const weakest = kind === "industry" && sortBy === "change" ? [...rows].sort((a, b) => (finite(a.changePct) ?? Infinity) - (finite(b.changePct) ?? Infinity)).slice(0, 3) : [];
      return { summary: `${kind === "concept" ? "概念" : "行业"}按${{ change: "涨幅", limitUps: "涨停家数", netInflow: "净流入" }[sortBy]}前列：${sorted.slice(0, 4).map(row => row.name).join("、")}`,
        data: { kind, sortBy, total: rows.length, top: sorted, ...(weakest.length ? { weakest } : {}) } };
    },
    async limit_reasons(args) {
      const value = await fuyao();
      if (!value?.limitUp) unavailable("涨停原因");
      const top = intArg(args?.top, 3, 15, 12);
      const groups = take(value.limitUp.reasons, top).map(group => ({ reason: group.reason, count: group.count,
        stocks: take(group.stocks, 5).map(item => ({ code: item.code, name: item.name, boards: finite(item.boards) })) }));
      return { summary: `涨停 ${value.limitUp.count} 家，前列原因：${groups.slice(0, 4).map(group => `${group.reason}${group.count}`).join("、")}`,
        data: { limitUpCount: value.limitUp.count, maxBoards: value.limitUp.maxBoards, groups } };
    },
    async ladder() {
      const value = await fuyao();
      if (!value?.ladder && !value?.limitUp) unavailable("连板天梯");
      const days = take(value.ladder?.days, 5).map(day => ({ date: day.date,
        tiers: take(day.tiers, 6).filter(tier => tier.stocks?.length).map(tier => ({ level: tier.label,
          stocks: take(tier.stocks, 4).map(item => `${item.name}${item.nextDay ? `(次日${clip(item.nextDay, 6)})` : ""}`) })) }));
      const leaders = take(value.limitUp?.leaders, 10).map(item => ({ code: item.code, name: item.name, boards: finite(item.boards), reason: clip(item.reason, 20), sealYi: yi(item.sealMoney) }));
      return { summary: `今日最高 ${value.limitUp?.maxBoards ?? "--"} 板；高度板：${leaders.slice(0, 3).map(item => `${item.name}${item.boards}板`).join("、") || "--"}`,
        data: { boardCounts: take(value.limitUp?.boardCounts, 5), leaders, recentDays: days } };
    },
    async broken_boards() {
      const value = await fuyao();
      if (!value) unavailable("炸板/跌停池");
      const breaks = take(value.limitBreak?.top, 10).map(item => ({ code: item.code, name: item.name, changePct: round(finite(item.changePct)), openTimes: finite(item.openTimes) }));
      const downs = take(value.limitDown?.top, 10).map(item => ({ code: item.code, name: item.name, changePct: round(finite(item.changePct)) }));
      return { summary: `炸板 ${value.limitBreak?.count ?? "--"} 家，跌停 ${value.limitDown?.count ?? "--"} 家，封板率 ${finite(value.sealRate) === null ? "--" : `${Math.round(value.sealRate * 100)}%`}`,
        data: { limitBreakCount: value.limitBreak?.count ?? null, limitDownCount: value.limitDown?.count ?? null, sealRatePct: finite(value.sealRate) === null ? null : Math.round(value.sealRate * 100), breaks, downs } };
    },
    async hot_stocks(args) {
      const value = await fuyao();
      const period = args?.period === "hour" ? "hour" : "day";
      const lists = value?.hotLists?.[period];
      if (!lists) unavailable("热股榜");
      const row = item => ({ code: item.code, name: item.name, rank: finite(item.rank), changePct: round(finite(item.changePct)) });
      const hot = take(lists.hot, 15).map(row), skyrocket = take(lists.skyrocket, 10).map(row);
      return { summary: `${period === "hour" ? "1小时" : "24小时"}热股前列：${hot.slice(0, 5).map(item => item.name).join("、")}`, data: { period, hot, skyrocket } };
    },
    async dragon_tiger() {
      const value = await fuyao();
      if (!value?.dragonTiger) unavailable("龙虎榜");
      const topNet = take(value.dragonTiger.topNet, 10).map(item => ({ code: item.code, name: item.name, netYi: yi(item.net), changePct: round(finite(item.changePct)),
        reason: clip(item.reason, 20), concepts: take(item.concepts, 3), hotMoneyNetYi: yi(item.hotMoneyNet), orgNetYi: yi(item.orgNet) }));
      const desks = take(value.dragonTiger.desks, 6).map(desk => ({ name: clip(desk.name, 16), stocks: take(desk.stocks, 4).map(item => item.name) }));
      return { summary: `龙虎榜 ${value.dragonTiger.date || ""} 净买入前列：${topNet.slice(0, 3).map(item => item.name).join("、")}`, data: { date: value.dragonTiger.date, count: value.dragonTiger.count, topNet, desks } };
    },
    async anomalies(args) {
      const value = await fuyao();
      if (!value?.anomalies) unavailable("异动解读");
      const top = intArg(args?.top, 3, 15, 12);
      const rows = take(value.anomalies, top).map(item => ({ code: item.code, name: item.name, tag: clip(item.tag, 6), content: clip(item.content, 70), keywords: take(item.keywords, 4) }));
      return { summary: `异动 ${value.anomalies.length} 条，如：${rows.slice(0, 3).map(item => `${item.name}(${item.tag})`).join("、")}`, data: { rows } };
    },
    async sector_members(args) {
      const name = clip(args?.name, 16);
      if (!name) throw new Error("请给出板块名称");
      if (++sectorCalls > 2) throw new Error("每次复盘最多查 2 个板块的成分");
      const detail = await sources.analyzeSector(name);
      const members = take(detail?.constituents, 400);
      const up = members.filter(item => finite(item.changePct) > 0).length;
      const top = [...members].sort((a, b) => (finite(b.changePct) ?? -Infinity) - (finite(a.changePct) ?? -Infinity)).slice(0, 10)
        .map(item => ({ code: item.code, name: item.name, changePct: round(finite(item.changePct)), limitUp: item.isLimitUp === true }));
      return { summary: `${detail?.name || name}：成分 ${detail?.memberCount ?? members.length} 只，上涨 ${up} 只，涨停 ${finite(detail?.limitUps) ?? members.filter(item => item.isLimitUp).length} 只`,
        data: { name: detail?.name || name, memberCount: detail?.memberCount ?? members.length, upCount: up, loaded: members.length, limitUps: finite(detail?.limitUps),
          changePct: round(finite(detail?.returns?.r1) ?? finite(detail?.memberAverageReturn)), r5: round(finite(detail?.returns?.r5)), top } };
    },
    async stock_check(args) {
      const codes = [...new Set(take(args?.codes, 6).map(code => String(code || "").match(/\d{6}/)?.[0]).filter(Boolean))].slice(0, 3);
      if (!codes.length) throw new Error("请给出 6 位股票代码（可从涨停原因、梯队、热股等技能结果里拿到）");
      const { profiles } = await sources.loadProfiles(codes.map(code => ({ code, name: code })));
      const rows = take(profiles, 3).map(profile => {
        const ma60 = finite(profile.ma?.ma60), latest = finite(profile.latest);
        return { code: profile.code, name: profile.name, latest, changePct: profile.changePct, return5: profile.return5, return20: profile.return20, return60: profile.return60,
          alignment: profile.alignment, volumeRatio: profile.volumeRatio, consecutiveBoards: profile.consecutiveBoards, limitUps20: profile.limitUps20, broken20: profile.broken20,
          rsi14: profile.rsi14, bias5: profile.bias5, ma60GapPct: latest !== null && ma60 ? round((latest / ma60 - 1) * 100, 1) : null,
          situation: typeof sources.situationOf === "function" ? sources.situationOf(profile) : [] };
      });
      if (!rows.length) throw new Error("这些股票的日线没读到");
      return { summary: rows.map(row => `${row.name}：${row.situation.slice(0, 3).join("、") || row.alignment || "--"}`).join("；"), data: { stocks: rows } };
    },
    async history_reviews(args) {
      const count = intArg(args?.count, 1, 5, 3);
      const reviews = take(sources.previousReviews(count), count).map(review => ({ date: review.asOfDate, headline: clip(review.headline, 40), cycle: review.cycle?.phase || "",
        mainlines: take(review.mainlines, 4).map(item => item.name), posture: clip(review.nextDay?.posture, 30), confidence: review.confidence || "" }));
      return { summary: reviews.length ? `前几次：${reviews.map(item => `${item.date} ${item.cycle}`).join("、")}` : "本机还没有更早的 AI 复盘", data: { reviews } };
    }
  };

  /** 执行一个技能；失败时返回错误说明（让 AI 知道这条数据拿不到）。 */
  async function runSkill(id, args = {}) {
    const skill = SKILL_BY_ID.get(id);
    if (!skill) return { skill: id, name: id, ok: false, summary: "没有这个技能", data: null };
    try {
      const value = await run[id](args && typeof args === "object" && !Array.isArray(args) ? args : {});
      return { skill: id, name: skill.name, ok: true, summary: clip(value.summary, 90), data: value.data };
    } catch (error) {
      return { skill: id, name: skill.name, ok: false, summary: clip(error?.message || error, 90), data: null };
    }
  }

  return { catalog: SKILLS, runSkill };
}

module.exports = { createReviewSkills, SKILLS, skillCatalogText };
