"use strict";

/**
 * AI 打分的「分析框架」：先由软件按策略给每个维度打分、加权得到基础分，再让 AI 在基础分上下 15 分内调整并说明理由。
 * 维度分全部由代码按体检数据（stock-profile.cjs）计算，规则写在这里，结果可复现、可解释。
 *
 * 1.6.44 起有 14 套分析策略（连板接力、涨停后低吸、底部反转、趋势波段、突破、缩量回踩、超跌反弹、整理蓄势、
 * 题材情绪、消息驱动、高位风险排查、弱市防守，以及原来的短线涨停、技术面综合）和自定义框架。
 * 默认「AI 自动编排」：软件先识别每只股票的情境（连板中、深跌底部、多头趋势、突破新高…），给每套策略一个适配度，
 * 并按每套策略算好基础分；AI 再按情境自主挑 1–3 套策略、给权重组合使用，基础分按所选策略加权，
 * 命中所选策略的硬规则时最多给“观望”。AI 没有返回时由软件按适配度最高的两套组合。
 */

const MAX_ADJUST = 15;
const CAP_SCORE = 59;
const clamp = (value, low = 0, high = 100) => Math.max(low, Math.min(high, value));
const num = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const fmt = (value, digits = 1) => num(value) === null ? "--" : value.toFixed(digits);

/** 维度库：每个维度根据体检数据给 0–100 分并附一句依据。 */
const DIMENSIONS = {
  limit: {
    label: "涨停强度",
    detail: "连板高度、近 20 日涨停次数、距最近涨停的天数",
    score(p) {
      const boards = num(p.consecutiveBoards) || 0, count = num(p.limitUps20) || 0, days = num(p.daysSinceLimit);
      if (boards >= 1) return { score: clamp(70 + Math.min(boards, 5) * 6), note: `${boards}连板` };
      if (days !== null && days <= 5) return { score: clamp(68 - days * 3 + Math.min(count, 4) * 5), note: `距最近涨停 ${days} 天，近20日涨停 ${count} 次` };
      if (count > 0) return { score: 50, note: `近20日涨停 ${count} 次` };
      return { score: 30, note: "近期没有涨停" };
    }
  },
  trend: {
    label: "均线趋势",
    detail: "均线多头/空头排列、站上几条均线",
    score(p) {
      const above = Object.values(p.above || {}).filter(value => value === true).length;
      if (p.alignment === "多头排列") return { score: 88, note: "多头排列" };
      if (p.alignment === "短期多头排列") return { score: 72, note: "短期多头排列" };
      if (p.alignment === "空头排列") return { score: 15, note: "空头排列" };
      if (p.alignment === "短期空头排列") return { score: 28, note: "短期空头排列" };
      return { score: clamp(35 + above * 10), note: `均线交织，站上 ${above} 条均线` };
    }
  },
  macd: {
    label: "MACD",
    detail: "金叉/死叉、红绿柱放大或缩小、零轴上下",
    score(p) {
      const m = p.macd || {};
      const dif = num(m.dif), dea = num(m.dea);
      if (dif === null || dea === null) return { score: 50, note: "数据不足" };
      const zone = dif > 0 ? "零轴上" : "零轴下";
      if (m.cross === "金叉" && num(m.crossDays) !== null && m.crossDays <= 3) return { score: dif > 0 ? 88 : 72, note: `${zone}金叉（${m.crossDays === 0 ? "当天" : `${m.crossDays} 天前`}）` };
      if (m.cross === "死叉" && num(m.crossDays) !== null && m.crossDays <= 3) return { score: dif > 0 ? 35 : 22, note: `${zone}死叉` };
      if (dif > dea) return m.histTrend === "放大" ? { score: dif > 0 ? 80 : 68, note: `${zone}红柱放大` } : { score: dif > 0 ? 62 : 52, note: `${zone}红柱缩小` };
      return m.histTrend === "缩小" ? { score: 45, note: `${zone}绿柱缩小` } : { score: 28, note: `${zone}绿柱放大` };
    }
  },
  rsi: {
    label: "RSI",
    detail: "RSI(14) 强弱与超买超卖",
    score(p) {
      const value = num(p.rsi14);
      if (value === null) return { score: 50, note: "数据不足" };
      const note = `RSI14 ${fmt(value)}`;
      if (value > 80) return { score: 25, note: `${note}，超买` };
      if (value > 70) return { score: 60, note: `${note}，偏强接近超买` };
      if (value >= 50) return { score: 82, note: `${note}，强势区` };
      if (value >= 40) return { score: 58, note };
      if (value >= 30) return { score: 42, note: `${note}，偏弱` };
      return { score: 38, note: `${note}，超卖` };
    }
  },
  volume: {
    label: "量能",
    detail: "量比与涨跌配合（放量上涨、缩量回调为佳），日均成交额",
    score(p) {
      const ratio = num(p.volumeRatio), change = num(p.changePct);
      if (ratio === null || change === null) return { score: 50, note: "数据不足" };
      let score, note;
      if (change > 0) {
        if (ratio > 4) { score = 45; note = "放巨量上涨"; }
        else if (ratio >= 2.5) { score = 65; note = "明显放量上涨"; }
        else if (ratio >= 1.2) { score = 85; note = "温和放量上涨"; }
        else if (ratio >= 0.8) { score = 62; note = "平量上涨"; }
        else { score = 50; note = "缩量上涨"; }
      } else if (ratio < 0.8) { score = 72; note = "缩量回调"; }
      else if (ratio <= 1.5) { score = 48; note = "平量下跌"; }
      else { score = 25; note = "放量下跌"; }
      const amount = num(p.avgAmount20Yi);
      if (amount !== null && amount < 1) { score -= 10; note += "，成交偏小"; }
      return { score: clamp(score), note: `${note}（量比 ${fmt(ratio, 2)}）` };
    }
  },
  position: {
    label: "位置乖离",
    detail: "5日线乖离率、近 20 日涨幅（防追高）",
    score(p) {
      const bias = num(p.bias5), r20 = num(p.return20);
      if (bias === null) return { score: 50, note: "数据不足" };
      let score = bias > 8 ? 20 : bias > 5 ? 40 : bias > 2 ? 65 : bias >= -2 ? 78 : bias >= -5 ? 62 : 42;
      let note = `5日乖离 ${fmt(bias)}%`;
      if (r20 !== null && r20 > 50) { score -= 15; note += `，20日已涨 ${fmt(r20, 0)}%`; }
      return { score: clamp(score), note };
    }
  },
  levels: {
    label: "支撑压力",
    detail: "离最近支撑/压力的距离、未回补缺口",
    score(p) {
      const latest = num(p.latest);
      if (latest === null) return { score: 50, note: "数据不足" };
      let score = 60;
      const notes = [];
      const support = (p.support || [])[0], resistance = (p.resistance || [])[0];
      if (support && num(support.price)) {
        const gap = (latest / support.price - 1) * 100;
        if (gap <= 3) { score += 15; notes.push(`贴近${support.label}`); }
        else if (gap > 10) { score -= 10; notes.push("离支撑较远"); }
      } else { score -= 15; notes.push("下方无明显支撑"); }
      if (resistance && num(resistance.price) && (resistance.price / latest - 1) * 100 <= 2) { score -= 10; notes.push(`临近${resistance.label}`); }
      const gaps = Array.isArray(p.gaps) ? p.gaps : [];
      if (gaps.some(gap => gap.type === "向上缺口")) { score += 10; notes.push("有未补向上缺口"); }
      if (gaps.some(gap => gap.type === "向下缺口")) { score -= 10; notes.push("上方有未补向下缺口"); }
      return { score: clamp(score), note: notes.join("，") || "位置中性" };
    }
  },
  theme: {
    label: "题材情绪",
    detail: "当日涨停原因、市场涨停数与封板率、命中策略数",
    score(p, market) {
      let score = 50;
      const notes = [];
      if (p.limitReason) { score += 20; notes.push(`题材：${p.limitReason}`); }
      const limitUps = num(market?.limitUpCount), seal = num(market?.sealRatePct);
      if (limitUps !== null) {
        if (limitUps >= 80) { score += 10; notes.push(`市场涨停 ${limitUps} 家`); }
        else if (limitUps < 30) { score -= 15; notes.push(`市场涨停仅 ${limitUps} 家`); }
      }
      if (seal !== null) { if (seal >= 70) score += 5; else if (seal < 55) { score -= 5; notes.push(`封板率 ${fmt(seal, 0)}%`); } }
      const hits = Array.isArray(p.strategies) ? p.strategies.length : 0;
      if (hits >= 3) { score += 10; notes.push(`命中 ${hits} 套策略`); }
      return { score: clamp(score), note: notes.join("，") || "无明确题材信息" };
    }
  },
  news: {
    label: "消息公告",
    detail: "近 30 天公司公告：利好/利空、重大风险（立案、处罚、退市、冻结等）",
    score(p) {
      if (p.announcementsAvailable === false) return { score: 50, note: "公告未取到，按中性" };
      const list = Array.isArray(p.announcements) ? p.announcements : [];
      if (!list.length) return { score: 55, note: "近30天无公告" };
      const positive = list.filter(item => item.direction === "利好").length;
      const negative = list.filter(item => item.direction === "利空" || item.direction === "多空交织").length;
      const severe = list.filter(item => (num(item.risk) ?? 0) >= 3).length;
      const score = clamp(55 + Math.min(positive, 3) * 8 - Math.min(negative, 3) * 12 - (severe ? 40 : 0));
      const notes = [`近30天公告 ${list.length} 条`];
      if (positive) notes.push(`利好 ${positive}`);
      if (negative) notes.push(`利空 ${negative}`);
      if (severe) notes.push("有重大风险公告");
      return { score, note: notes.join("，") };
    }
  },
  risk: {
    label: "风险控制",
    detail: "炸板、超买、高乖离、短期涨幅过大、大跌、流动性（分越高风险越小）",
    score(p) {
      let score = 100;
      const notes = [];
      const broken = num(p.broken20) || 0;
      if (broken) { score -= Math.min(broken, 3) * 15; notes.push(`近20日炸板 ${broken} 次`); }
      if ((num(p.rsi14) ?? 0) > 80) { score -= 20; notes.push("RSI 超买"); }
      if ((num(p.bias5) ?? 0) > 8) { score -= 25; notes.push("乖离过大"); }
      if ((num(p.return20) ?? 0) > 40) { score -= 20; notes.push("20日涨幅过大"); }
      if ((num(p.changePct) ?? 0) < -5) { score -= 20; notes.push("当日大跌"); }
      if ((num(p.avgAmount20Yi) ?? 99) < 0.5) { score -= 20; notes.push("成交太小"); }
      return { score: clamp(score), note: notes.join("，") || "未见明显风险" };
    }
  }
  ,
  deep: {
    label: "超跌深度",
    detail: "离 60 日线多远、近 60 日跌幅（实测：底部首板后跌得越深，后续相对越强）",
    score(p) {
      const latest = num(p.latest), ma60 = num(p.ma?.ma60), r60 = num(p.return60);
      if (latest === null || ma60 === null || !(ma60 > 0)) return { score: 50, note: "数据不足" };
      const gap = (latest / ma60 - 1) * 100;
      const score = gap <= -25 ? 92 : gap <= -15 ? 80 : gap <= -10 ? 66 : gap <= -5 ? 54 : gap <= 5 ? 42 : 30;
      return { score, note: `离60日线 ${fmt(gap)}%${r60 !== null ? `，60日 ${fmt(r60, 0)}%` : ""}` };
    }
  },
  breakout: {
    label: "突破强度",
    detail: "是否站上近 20/60 日高点、放量配合",
    score(p) {
      const latest = num(p.latest), high20 = num(p.high20), high60 = num(p.high60), ratio = num(p.volumeRatio), from20 = num(p.fromHigh20Pct);
      if (latest === null || high20 === null) return { score: 50, note: "数据不足" };
      let score, note;
      if (high60 !== null && latest >= high60 * 0.99) { score = 86; note = "创/逼近60日新高"; }
      else if (latest >= high20 * 0.99) { score = 76; note = "创/逼近20日新高"; }
      else if (from20 !== null && from20 >= -5) { score = 58; note = `距20日高点 ${fmt(from20)}%`; }
      else { score = 35; note = `距20日高点 ${fmt(from20)}%`; }
      if (ratio !== null && score >= 70) { if (ratio >= 1.3 && ratio <= 3.5) { score += 8; note += "，放量"; } else if (ratio < 0.9) { score -= 12; note += "，缩量突破"; } else if (ratio > 4) { score -= 10; note += "，巨量"; } }
      return { score: clamp(score), note };
    }
  },
  contraction: {
    label: "收敛蓄势",
    detail: "近 20 日振幅收窄、量能收缩（整理充分）",
    score(p) {
      const high20 = num(p.high20), low20 = num(p.low20), ratio = num(p.volumeRatio);
      if (high20 === null || low20 === null || !(low20 > 0)) return { score: 50, note: "数据不足" };
      const range = (high20 / low20 - 1) * 100;
      let score = range <= 10 ? 86 : range <= 15 ? 74 : range <= 25 ? 56 : 34;
      if (ratio !== null) score += ratio < 0.8 ? 8 : ratio > 1.8 ? -10 : 0;
      return { score: clamp(score), note: `20日振幅 ${fmt(range, 0)}%${ratio !== null ? `，量比 ${fmt(ratio, 2)}` : ""}` };
    }
  },
  pullback: {
    label: "回踩质量",
    detail: "多头里缩量回到 10/20 日线附近企稳",
    score(p) {
      const latest = num(p.latest), ma10 = num(p.ma?.ma10), ma20 = num(p.ma?.ma20), ratio = num(p.volumeRatio), change = num(p.changePct);
      if (latest === null || ma10 === null || ma20 === null) return { score: 50, note: "数据不足" };
      const bullish = p.alignment === "多头排列" || p.alignment === "短期多头排列";
      const near = [["10日线", ma10], ["20日线", ma20]].map(([label, price]) => ({ label, gap: (latest / price - 1) * 100 })).sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap))[0];
      let score = Math.abs(near.gap) <= 2 ? 80 : Math.abs(near.gap) <= 4 ? 64 : near.gap > 4 ? 40 : 30;
      const notes = [`离${near.label} ${fmt(near.gap)}%`];
      if (!bullish) { score -= 20; notes.push("均线未多头"); }
      if (ratio !== null && ratio < 0.85) { score += 8; notes.push("缩量"); } else if (ratio !== null && ratio > 1.5 && (change ?? 0) < 0) { score -= 15; notes.push("放量下跌"); }
      return { score: clamp(score), note: notes.join("，") };
    }
  }
  ,
  edge: {
    label: "实测胜率",
    detail: "按 2021–2026 全A日线实测（次日开盘买入、5 日相对全市场收益）：追当日涨停/连板、乖离大、RSI 高、短期涨幅大、近期多次涨停或炸板的相对跑输；深跌离 60 日线远的相对跑赢",
    score(p) {
      let score = 60;
      const minus = [], plus = [];
      const step = (value, edges, points) => { if (value === null) return 0; const index = edges.findIndex(edge => value <= edge); return points[index === -1 ? points.length - 1 : index]; };
      const add = (points, text) => { if (!points) return; score += points; (points > 0 ? plus : minus).push([points, text]); };
      const bias = num(p.bias5), r20 = num(p.return20), rsi14 = num(p.rsi14), latest = num(p.latest), ma60 = num(p.ma?.ma60);
      const boards = num(p.consecutiveBoards) || 0, count = num(p.limitUps20) || 0, broken = num(p.broken20) || 0, change = num(p.changePct);
      add(step(bias, [-3, 2, 4, 6, 9], [6, 0, -4, -7, -10, -15]), `5日乖离 ${fmt(bias)}%`);
      add(step(r20, [0, 13, 23, 30, 45], [3, 0, -4, -7, -11, -15]), `20日涨幅 ${fmt(r20, 0)}%`);
      add(step(rsi14, [45, 58, 68, 74], [4, 0, -4, -7, -11]), `RSI14 ${fmt(rsi14, 0)}`);
      if (latest !== null && ma60 !== null && ma60 > 0) { const gap = (latest / ma60 - 1) * 100; add(gap <= -15 ? 12 : gap <= -10 ? 5 : gap > 5 ? -5 : 0, `离60日线 ${fmt(gap, 0)}%`); }
      add(step(count, [0, 1, 2, 3], [0, -2, -6, -10, -13]), `近20日涨停 ${count} 次`);
      add(boards >= 1 ? -15 : 0, boards >= 2 ? `${boards}连板次日追入` : "当日涨停次日追入");
      add(step(broken, [0, 1], [0, -3, -7]), `近20日炸板 ${broken} 次`);
      if (change !== null) add(change > 4 && boards < 1 ? -5 : change < -5 ? -4 : 0, `当日${change > 0 ? "大涨" : "大跌"} ${fmt(change)}%`);
      // 依据按分值大小排，扣分在前；界面只显示 40 字，最重要的放前面。
      const top = (list, count) => list.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])).slice(0, count).map(item => item[1]).join("、");
      const note = [minus.length ? `扣：${top(minus, plus.length ? 2 : 3)}` : "", plus.length ? `加：${top(plus, minus.length ? 1 : 3)}` : ""].filter(Boolean).join("；") || "各项中性";
      return { score: clamp(score), note };
    }
  }
};

/** 硬规则：命中后最终分最多 59（“观望”）。 */
const CAPS = {
  overbought: { label: "RSI14 超过 80 不给关注", test: p => (num(p.rsi14) ?? 0) > 80 },
  chase: { label: "高于 5 日线 5% 以上不追高", test: p => (num(p.bias5) ?? 0) > 5 },
  downtrend: { label: "均线空头排列不给关注", test: p => p.alignment === "空头排列" },
  broken: { label: "近 20 日炸板 2 次以上且未连板不给关注", test: p => (num(p.broken20) ?? 0) >= 2 && !(num(p.consecutiveBoards) > 0) },
  riskNotice: { label: "近 30 天有重大风险公告不给关注", test: p => (Array.isArray(p.announcements) ? p.announcements : []).some(item => (num(item?.risk) ?? 0) >= 3) },
  illiquid: { label: "近 20 日日均成交额不足 5000 万不给关注", test: p => (num(p.avgAmount20Yi) ?? 99) < 0.5 },
  extended: { label: "近 20 日涨幅超过 50% 不给关注", test: p => (num(p.return20) ?? 0) > 50 }
};

/**
 * 情境识别：软件按体检数据给股票打情境标签（AI 编排策略时参考）。
 * 只用日线算出的客观数据。
 */
function situationOf(p = {}, market = null) {
  const tags = [];
  const latest = num(p.latest), ma60 = num(p.ma?.ma60), ma10 = num(p.ma?.ma10), ma20 = num(p.ma?.ma20);
  const gap60 = latest !== null && ma60 ? (latest / ma60 - 1) * 100 : null;
  const boards = num(p.consecutiveBoards) || 0, days = num(p.daysSinceLimit);
  const bullish = p.alignment === "多头排列" || p.alignment === "短期多头排列";
  if (boards >= 2) tags.push("连板中");
  else if (boards === 1) tags.push("当日涨停");
  if (boards === 0 && days !== null && days >= 1 && days <= 10) tags.push("涨停后回调");
  if (gap60 !== null && gap60 <= -15) tags.push(days !== null && days <= 15 ? "深跌底部首板后" : "深跌底部");
  else if ((num(p.return60) ?? 0) <= -25) tags.push("深跌底部");
  if (p.alignment === "多头排列") tags.push("多头趋势"); else if (p.alignment === "短期多头排列") tags.push("短期多头");
  if (p.alignment === "空头排列" || p.alignment === "短期空头排列") tags.push("空头趋势");
  const high20 = num(p.high20), high60 = num(p.high60), low20 = num(p.low20);
  if (latest !== null && high60 !== null && latest >= high60 * 0.99) tags.push("逼近60日新高");
  else if (latest !== null && high20 !== null && latest >= high20 * 0.99) tags.push("逼近20日新高");
  if (high20 !== null && low20 && (high20 / low20 - 1) * 100 <= 15 && (num(p.volumeRatio) ?? 1) < 0.95) tags.push("缩量整理");
  if (bullish && latest !== null && [ma10, ma20].some(ma => ma && Math.abs(latest / ma - 1) <= 0.02) && (num(p.changePct) ?? 0) <= 1.5) tags.push("回踩均线");
  if ((num(p.rsi14) ?? 50) < 30 || (num(p.return20) ?? 0) <= -20) tags.push("超跌");
  if ((num(p.bias5) ?? 0) > 8 || (num(p.rsi14) ?? 0) > 80 || (num(p.return20) ?? 0) > 40) tags.push("高位过热");
  if ((num(p.broken20) ?? 0) >= 2) tags.push("炸板多");
  if (p.limitReason) tags.push("有涨停题材");
  const notices = Array.isArray(p.announcements) ? p.announcements : [];
  if (notices.some(item => (num(item?.risk) ?? 0) >= 3)) tags.push("重大风险公告");
  else if (notices.some(item => item?.direction === "利好")) tags.push("近期利好公告");
  if ((num(p.avgAmount20Yi) ?? 99) < 0.5) tags.push("流动性差");
  const limitUps = num(market?.limitUpCount), seal = num(market?.sealRatePct);
  if ((limitUps !== null && limitUps < 30) || (seal !== null && seal < 55)) tags.push("弱市");
  else if (limitUps !== null && limitUps >= 80) tags.push("强市");
  return tags;
}

/**
 * 策略库：每套策略 = 维度权重 + 硬规则 + 要点 + 适用情境（fit：0–100，越适合当前情境越高）。
 * 原来的「短线涨停」「技术面综合」保留。
 */
const has = (tags, ...names) => names.some(name => tags.includes(name));
const PLAYBOOKS = {
  shortline: {
    id: "shortline", name: "短线涨停",
    description: "看涨停强度、量能和题材情绪，适合打板、接力和涨停后低吸。",
    weights: { limit: 25, volume: 20, theme: 15, risk: 15, news: 10, position: 10, trend: 5 , edge: 25 },
    caps: ["broken", "riskNotice"],
    guidance: "侧重短线博弈：连板高度与封板质量、题材是否是市场主线、量能是否健康；高位放巨量、反复炸板要明显扣分。",
    fit: tags => has(tags, "连板中", "当日涨停") ? 70 : has(tags, "涨停后回调") ? 55 : 25
  },
  technical: {
    id: "technical", name: "技术面综合",
    description: "看均线排列、MACD、RSI、量能、位置乖离和支撑压力，适合趋势和波段。",
    weights: { trend: 25, macd: 20, rsi: 15, volume: 10, position: 10, levels: 10, news: 10 , edge: 25 },
    caps: ["overbought", "chase", "riskNotice"],
    guidance: "侧重技术面：多头排列且站稳均线、MACD 零轴上金叉或红柱放大、RSI 在 50–70 强势区、放量上涨或缩量回调为加分项；不追高，优先回踩支撑。",
    fit: tags => has(tags, "多头趋势", "短期多头") ? 55 : 40
  },
  relay: {
    id: "relay", name: "连板接力",
    description: "连板股看高度、封板质量、题材地位和市场情绪，适合龙头接力。",
    weights: { limit: 30, theme: 20, volume: 15, risk: 15, news: 10, position: 10 , edge: 25 },
    caps: ["broken", "riskNotice"],
    guidance: "只在情绪不差时接力：连板高度与晋级、题材是否主线、量能是否健康（缩量加速或温和换手好，天量分歧差）；弱市、炸板多、风险公告直接降级。",
    fit: tags => has(tags, "连板中") ? (has(tags, "弱市") ? 70 : 90) : has(tags, "当日涨停") ? 65 : 10
  },
  limit_pullback: {
    id: "limit_pullback", name: "涨停后低吸",
    description: "近 10 日涨停过、之后回调的股票，看回踩位置、缩量和涨停支撑是否守住。",
    weights: { pullback: 20, levels: 20, volume: 15, limit: 15, position: 10, risk: 10, news: 10 , edge: 25 },
    caps: ["broken", "riskNotice"],
    guidance: "低吸不追高：缩量回到 5/10 日线或涨停日支撑附近企稳为加分项；跌破涨停日低点、放量下跌、反复炸板要扣分。",
    fit: tags => has(tags, "涨停后回调") ? (has(tags, "回踩均线") ? 85 : 75) : 15
  },
  bottom_reversal: {
    id: "bottom_reversal", name: "底部反转",
    description: "深跌后（离 60 日线 15% 以上）出现首板的股票，看下跌深度、首板质量和企稳信号。",
    weights: { deep: 30, volume: 15, levels: 15, macd: 10, risk: 15, news: 15 , edge: 25 },
    caps: ["riskNotice", "illiquid"],
    guidance: "依据 2021–2026 全A实测：底部首板后股价离 60 日线越远，之后 20 日相对同日涨停股越强；首板不放巨量、之后缩量不破首板低点更好。底部二波板（再出第二个涨停去追）实测跑输，要扣分。",
    fit: tags => has(tags, "深跌底部首板后") ? 92 : has(tags, "深跌底部") ? 55 : 10
  },
  trend_swing: {
    id: "trend_swing", name: "趋势波段",
    description: "均线多头排列的趋势股，看趋势健康度、MACD 动能和是否过度乖离。",
    weights: { trend: 30, macd: 20, volume: 15, position: 15, levels: 10, news: 10 , edge: 25 },
    caps: ["overbought", "chase", "riskNotice"],
    guidance: "顺势而为：多头排列、MACD 零轴上、回踩均线有承接是加分项；乖离过大、RSI 超买、放量滞涨要扣分。",
    fit: tags => has(tags, "多头趋势") ? (has(tags, "高位过热") ? 60 : 82) : has(tags, "短期多头") ? 62 : 15
  },
  breakout: {
    id: "breakout", name: "突破",
    description: "逼近或站上近 20/60 日高点的股票，看突破是否放量、上方空间与追高风险。",
    weights: { breakout: 30, volume: 20, trend: 15, risk: 15, news: 10, position: 10 , edge: 25 },
    caps: ["overbought", "riskNotice"],
    guidance: "真突破要放量（量比 1.3–3.5）且收盘站稳；缩量突破、巨量冲高回落、上方紧贴压力位要扣分。",
    fit: tags => has(tags, "逼近60日新高") ? 85 : has(tags, "逼近20日新高") ? 70 : 10
  },
  support_pullback: {
    id: "support_pullback", name: "缩量回踩",
    description: "多头趋势里缩量回到 10/20 日线附近的股票，看回踩质量和支撑。",
    weights: { pullback: 30, trend: 20, levels: 15, volume: 15, risk: 10, news: 10 , edge: 25 },
    caps: ["riskNotice"],
    guidance: "多头趋势中的缩量回踩是相对低风险的介入点；放量跌破均线、均线拐头向下要扣分。",
    fit: tags => has(tags, "回踩均线") ? 85 : has(tags, "多头趋势", "短期多头") ? 45 : 10
  },
  oversold_bounce: {
    id: "oversold_bounce", name: "超跌反弹",
    description: "短期跌幅大、RSI 超卖的股票，看反弹条件（企稳、背离、支撑）。",
    weights: { deep: 20, rsi: 20, macd: 15, levels: 15, risk: 15, news: 15 , edge: 25 },
    caps: ["riskNotice", "illiquid"],
    guidance: "超跌只是条件不是理由：要有止跌迹象（缩量、MACD 绿柱缩小、贴近支撑）；仍在放量下跌、有利空公告的要明显扣分。",
    fit: tags => has(tags, "超跌") ? (has(tags, "空头趋势") ? 60 : 75) : 10
  },
  consolidation: {
    id: "consolidation", name: "整理蓄势",
    description: "振幅收窄、量能收缩的横盘整理股，看蓄势是否充分、方向选择。",
    weights: { contraction: 30, levels: 20, trend: 15, volume: 15, risk: 10, news: 10 , edge: 25 },
    caps: ["riskNotice"],
    guidance: "整理越充分（振幅窄、量缩）越好；位于均线之上、贴近平台上沿更好；破位下跌要扣分。",
    fit: tags => has(tags, "缩量整理") ? 78 : 15
  },
  theme_momentum: {
    id: "theme_momentum", name: "题材情绪",
    description: "有当日涨停题材的股票，看题材热度、市场情绪和在题材中的地位。",
    weights: { theme: 35, limit: 20, volume: 15, risk: 15, news: 15 , edge: 25 },
    caps: ["broken", "riskNotice"],
    guidance: "题材是否是当日主线、市场涨停家数与封板率是否支持；跟风、后排、题材分歧时要扣分。",
    fit: tags => has(tags, "有涨停题材") ? (has(tags, "强市") ? 85 : 72) : has(tags, "强市") && has(tags, "当日涨停", "连板中") ? 55 : 10
  },
  news_driven: {
    id: "news_driven", name: "消息驱动",
    description: "近期有利好公告的股票，看公告性质与股价是否已经反映。",
    weights: { news: 40, volume: 20, theme: 15, risk: 15, position: 10 , edge: 25 },
    caps: ["riskNotice", "chase"],
    guidance: "只引用输入里的公告标题；利好已大幅兑现（高位放量）要扣分，利空、风险公告直接降级。",
    fit: tags => has(tags, "近期利好公告") ? 68 : 5
  },
  risk_check: {
    id: "risk_check", name: "高位风险排查",
    description: "涨幅大、乖离大、超买或炸板多的股票，重点排查回撤风险。",
    weights: { risk: 40, position: 30, volume: 15, news: 15 , edge: 25 },
    caps: ["overbought", "chase", "broken", "riskNotice", "extended"],
    guidance: "以风控为先：高位放巨量、乖离过大、连续炸板、RSI 超买都是减分项；除非情绪极强，否则倾向观望。",
    fit: tags => has(tags, "高位过热") ? 90 : has(tags, "炸板多") ? 70 : has(tags, "重大风险公告") ? 80 : 10
  },
  defensive: {
    id: "defensive", name: "弱市防守",
    description: "市场情绪差（涨停少、封板率低）时，优先看风险、位置和支撑，宁缺毋滥。",
    weights: { risk: 30, levels: 20, position: 20, news: 15, trend: 15 , edge: 25 },
    caps: ["riskNotice", "illiquid"],
    guidance: "弱市里不追高、不接力：贴近支撑、位置不高、无利空的才给关注；其余倾向观望。",
    fit: tags => has(tags, "弱市") ? 70 : 15
  }
};
const PLAYBOOK_IDS = Object.keys(PLAYBOOKS);
/** 兼容旧名称：BUILTIN 仍指原来两套。 */
const BUILTIN = { shortline: PLAYBOOKS.shortline, technical: PLAYBOOKS.technical };

const AUTO = {
  id: "auto", name: "AI 自动编排",
  description: "软件先识别每只股票的情境、给 14 套策略算适配度和基础分，AI 按情境自主挑 1–3 套策略组合使用；基础分再叠加按全A实测得出的「实测胜率」（追涨停、乖离大、短期涨幅大扣分，深跌离 60 日线远加分）。",
  guidance: "", weights: {}, caps: ["riskNotice"]
};

const DEFAULT_CUSTOM = { name: "自定义", weights: { ...PLAYBOOKS.technical.weights }, caps: [...PLAYBOOKS.technical.caps], note: "" };

function normalizeCustom(input = {}) {
  const weights = {};
  for (const id of Object.keys(DIMENSIONS)) {
    const value = Math.round(Number(input?.weights?.[id]));
    if (Number.isFinite(value) && value > 0) weights[id] = Math.min(100, value);
  }
  if (!Object.keys(weights).length) throw Object.assign(new TypeError("自定义框架至少要给一个维度设置权重"), { code: "INVALID_AI_FRAMEWORK" });
  return {
    name: String(input?.name || "自定义").replace(/\s+/g, " ").trim().slice(0, 12) || "自定义",
    weights,
    caps: [...new Set((Array.isArray(input?.caps) ? input.caps : []).map(String).filter(id => CAPS[id]))],
    note: String(input?.note || "").trim().slice(0, 500)
  };
}

const ACTIVE_IDS = ["auto", ...PLAYBOOK_IDS, "custom"];

/**
 * 本机保存的框架选择：{ v: 2, active, custom }。
 * 1.6.43 及以前没有 v，默认是「短线涨停」——当时是默认值而不是用户的选择，升级后改为 AI 自动编排；
 * 选过「技术面综合」或自定义的保持不变。
 */
function normalizeFrameworkState(value) {
  let active = ACTIVE_IDS.includes(value?.active) ? value.active : "auto";
  if (value?.v !== 2 && (active === "shortline" || !value?.active)) active = "auto";
  let custom;
  try { custom = normalizeCustom(value?.custom || DEFAULT_CUSTOM); } catch { custom = { ...DEFAULT_CUSTOM, weights: { ...DEFAULT_CUSTOM.weights }, caps: [...DEFAULT_CUSTOM.caps] }; }
  return { v: 2, active, custom };
}

/** 当前使用的框架（完整定义）。 */
function resolveFramework(state) {
  const { active, custom } = normalizeFrameworkState(state);
  if (active === "custom") return { id: "custom", name: custom.name, description: "你自己设定的维度权重和硬规则。", weights: custom.weights, caps: custom.caps, guidance: custom.note };
  if (active === "auto") return AUTO;
  return PLAYBOOKS[active];
}

/** 给前端展示的框架目录。 */
function frameworkCatalog(state) {
  const normalized = normalizeFrameworkState(state);
  const describe = framework => ({ id: framework.id, name: framework.name, description: framework.description, guidance: framework.guidance,
    dimensions: Object.entries(framework.weights).map(([id, weight]) => ({ id, label: DIMENSIONS[id].label, detail: DIMENSIONS[id].detail, weight })),
    caps: framework.caps.map(id => ({ id, label: CAPS[id].label })) });
  return {
    active: normalized.active,
    custom: normalized.custom,
    frameworks: [describe(AUTO), ...PLAYBOOK_IDS.map(id => describe(PLAYBOOKS[id])), describe(resolveFramework({ ...normalized, active: "custom" }))],
    dimensions: Object.entries(DIMENSIONS).map(([id, item]) => ({ id, label: item.label, detail: item.detail })),
    caps: Object.entries(CAPS).map(([id, item]) => ({ id, label: item.label }))
  };
}

/** 按一套策略给一只股票打基础分。 */
function evaluateFramework(framework, profile, market = null) {
  if (framework?.id === "auto") return evaluateAuto(profile, market);
  const dims = Object.entries(framework.weights).map(([id, weight]) => {
    const result = DIMENSIONS[id].score(profile || {}, market);
    return { id, label: DIMENSIONS[id].label, weight, score: Math.round(result.score), note: String(result.note || "").slice(0, 40) };
  });
  const total = dims.reduce((sum, item) => sum + item.weight, 0) || 1;
  const base = Math.round(dims.reduce((sum, item) => sum + item.score * item.weight, 0) / total);
  const hit = framework.caps.filter(id => CAPS[id].test(profile || {})).map(id => CAPS[id].label);
  return { id: framework.id, name: framework.name, base, dims, caps: hit, cap: hit.length ? CAP_SCORE : null };
}

/**
 * 自动编排的准备：情境标签 + 每套策略的适配度、基础分和命中的硬规则；
 * 默认组合 = 适配度最高的一套，第二套适配度不低于第一套的 70% 时一起用（按适配度给权重）。
 */
function evaluateAuto(profile, market = null) {
  const tags = situationOf(profile || {}, market);
  const plays = PLAYBOOK_IDS.map(id => {
    const playbook = PLAYBOOKS[id];
    const evaluation = evaluateFramework(playbook, profile, market);
    return { id, name: playbook.name, fit: Math.round(clamp(playbook.fit(tags, profile || {}, market))), base: evaluation.base, caps: evaluation.caps, dims: evaluation.dims };
  }).sort((a, b) => b.fit - a.fit || b.base - a.base);
  const [first, second] = plays;
  const chosen = second && second.fit >= first.fit * 0.7 ? [first, second] : [first];
  const total = chosen.reduce((sum, item) => sum + item.fit, 0) || 1;
  const raw = DIMENSIONS.edge.score(profile || {}, market);
  const edge = { id: "edge", label: DIMENSIONS.edge.label, score: Math.round(raw.score), note: String(raw.note || "").slice(0, 40) };
  return combinePlays(plays, chosen.map(item => ({ id: item.id, weight: Math.round(item.fit / total * 100) })), tags, "软件按情境适配度组合", edge);
}

/**
 * 自动编排里「实测胜率」单独再占基础分 30%（其余 70% 是所选策略的加权分，每套策略自身也含 20% 的实测胜率维度）。
 * 依据：2021–2026 全A日线（每 5 个交易日抽样、次日开盘买入、5 日相对同日全市场收益，开盘一字的剔除），
 * 原自动编排基础分的日均秩相关 0.006（近 10 日涨停过的股票里 0.026），改后 0.045 和 0.091；
 * 2021–2023 与 2024–2026 两段方向和幅度一致，五分组单调。原分最高的一组反而跑输中间组。
 */
const AUTO_EDGE_WEIGHT = 30;

/** 按选定的策略和权重合成：基础分加权、硬规则取所选策略的并集（重大风险公告始终生效）。 */
function combinePlays(plays, picks, tags, why = "", edge = null) {
  const byId = new Map(plays.map(item => [item.id, item]));
  const chosen = picks.map(pick => ({ ...byId.get(pick.id), weight: pick.weight })).filter(item => item.id && item.weight > 0);
  const total = chosen.reduce((sum, item) => sum + item.weight, 0) || 1;
  const normalized = chosen.map(item => ({ ...item, weight: Math.round(item.weight / total * 100) }));
  const blended = normalized.reduce((sum, item) => sum + item.base * item.weight, 0) / 100;
  const base = Math.round(edge ? blended * (100 - AUTO_EDGE_WEIGHT) / 100 + edge.score * AUTO_EDGE_WEIGHT / 100 : blended);
  const caps = [...new Set(normalized.flatMap(item => item.caps))];
  const primary = [...normalized].sort((a, b) => b.weight - a.weight)[0];
  const primaryDims = (primary?.dims || []).filter(item => item.id !== "edge");
  return {
    id: "auto", name: `AI 编排：${normalized.map(item => `${item.name}${normalized.length > 1 ? ` ${item.weight}%` : ""}`).join(" + ")}`,
    base, dims: edge ? [...primaryDims, { ...edge, weight: AUTO_EDGE_WEIGHT }] : primary?.dims || [], caps, cap: caps.length ? CAP_SCORE : null, edge,
    situation: tags, plays: normalized.map(item => ({ id: item.id, name: item.name, weight: item.weight, base: item.base, fit: item.fit })),
    candidates: plays, orchestration: String(why || "").slice(0, 60)
  };
}

/**
 * AI 选的策略组合 → 合成结果。只认策略库里的 id，最多 3 套，权重缺省平均；AI 没选或全无效时用软件默认组合。
 */
function applyOrchestration(evaluation, rawPlays, why) {
  if (!evaluation?.candidates) return evaluation;
  const picks = [];
  for (const raw of Array.isArray(rawPlays) ? rawPlays : []) {
    const id = String(typeof raw === "string" ? raw : raw?.id || "").trim();
    if (!PLAYBOOKS[id] || picks.some(item => item.id === id)) continue;
    const weight = Math.round(Number(typeof raw === "object" ? raw?.weight : NaN));
    picks.push({ id, weight: Number.isFinite(weight) && weight > 0 ? Math.min(100, weight) : null });
    if (picks.length === 3) break;
  }
  if (!picks.length) return evaluation;
  const even = Math.round(100 / picks.length);
  return combinePlays(evaluation.candidates, picks.map(item => ({ id: item.id, weight: item.weight ?? even })), evaluation.situation, why || "AI 按情境选择", evaluation.edge || null);
}

/** AI 给出的分数落到框架允许的范围：基础分 ±15，命中硬规则时封顶 59。 */
function settleScore(aiScore, evaluation) {
  const raw = Math.round(Number(aiScore));
  let score = Number.isFinite(raw) ? clamp(raw, evaluation.base - MAX_ADJUST, evaluation.base + MAX_ADJUST) : evaluation.base;
  score = clamp(score);
  if (evaluation.cap !== null) score = Math.min(score, evaluation.cap);
  return score;
}

const EDGE_NOTE = "「实测胜率」维度来自 2021–2026 全A日线实测（次日开盘买入、看 5 日相对全市场收益）：当日涨停/连板次日追入、5日乖离大、RSI 高、20日涨幅大、近20日多次涨停或炸板的平均相对跑输；离 60 日线越远的深跌股相对跑赢。你的加减分不要和它反着来——对追高型的股票，除非数据里有更强的理由，否则不要往上加分。";

/** 策略库的简要说明（写进提示词）。 */
function playbookLibraryText() {
  return PLAYBOOK_IDS.map(id => {
    const item = PLAYBOOKS[id];
    const dims = Object.entries(item.weights).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([dim]) => DIMENSIONS[dim].label).join("、");
    return `- ${id}「${item.name}」：${item.description} 侧重 ${dims}。要点：${item.guidance}`;
  }).join("\n");
}

/** 写进提示词的框架说明。 */
function frameworkPrompt(framework) {
  if (framework?.id === "auto") {
    return [
      "本次使用「AI 自动编排」：没有固定的分析入口，由你按每只股票的情境自主选择分析策略并组合使用。策略库：",
      playbookLibraryText(),
      `每只股票的 framework.situation 是软件识别的情境标签；framework.candidates 是软件对各策略的预评估（fit 适配度 0–100、base 该策略下的基础分、caps 命中的硬规则），按适配度排序。`,
      `请为每只股票选择 1–3 套最适合其情境的策略，写进 plays：[{"id":"策略id","weight":权重}]（权重合计 100；可以选不在前几名的策略，但要符合情境），并在 orchestration 里用一句话（≤30字）说明为什么这样组合。`,
      `软件按你选的策略和权重加权（占 ${100 - AUTO_EDGE_WEIGHT}%），再单独加上「实测胜率」（占 ${AUTO_EDGE_WEIGHT}%；各策略自身也含这一维度）得到基础分，命中所选策略的硬规则时最终最多“观望”。`,
      EDGE_NOTE,
      `你的 score 必须在这个加权基础分上下 ${MAX_ADJUST} 分以内，用 reason 一句话（≤40字）说明加减分理由；数据之外的信息不要作为理由。`,
      `输出的 JSON 里，每只股票（单只点评时就是那个对象）额外包含 "plays":[{"id":"bottom_reversal","weight":60},{"id":"limit_pullback","weight":40}] 和 "orchestration":"…"。`
    ].join("\n");
  }
  const dims = Object.entries(framework.weights).map(([id, weight]) => `${DIMENSIONS[id].label} ${weight}`).join("、");
  const caps = framework.caps.map(id => CAPS[id].label).join("；");
  return [
    `本次使用分析框架「${framework.name}」，维度与权重：${dims}。`,
    framework.guidance ? `框架要点：${framework.guidance}` : "",
    caps ? `硬规则（命中则最终最多“观望”）：${caps}。` : "",
    framework.weights.edge ? EDGE_NOTE : "",
    `每只股票的 framework.base 是软件按这个框架算出的基础分，framework.dims 是各维度得分和依据。你的 score 必须在 base 上下 ${MAX_ADJUST} 分以内，用 reason 一句话（≤40字）说明为什么加分或减分；数据之外的信息不要作为加减分理由。`
  ].filter(Boolean).join("\n");
}

/** 缓存键里的框架签名：换框架、改了自定义权重或策略库更新时重新生成。 */
const LIBRARY_VERSION = "2026-11-05";
function frameworkSignature(framework) {
  if (framework?.id === "auto") return JSON.stringify(["auto", LIBRARY_VERSION]);
  return JSON.stringify([framework.id, framework.weights, [...framework.caps].sort(), framework.guidance || ""]);
}

module.exports = {
  DIMENSIONS, CAPS, BUILTIN, PLAYBOOKS, PLAYBOOK_IDS, AUTO, MAX_ADJUST, CAP_SCORE, AUTO_EDGE_WEIGHT,
  normalizeCustom, normalizeFrameworkState, resolveFramework, frameworkCatalog, situationOf,
  evaluateFramework, evaluateAuto, applyOrchestration, settleScore, frameworkPrompt, frameworkSignature
};
