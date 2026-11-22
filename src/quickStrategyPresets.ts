import { strategyPresets } from "./domain/settings";

export type QuickStrategyPreset = (typeof strategyPresets)[number] & { measured?: boolean };

// These select the stock-analysis factors supported by Settings. The analysis
// engine keeps its percentage score and risk/exact-node gates. Exact named
// selections also require their core shapes under analysis policy v1.1.0.
const corePresetDetails: Record<string, string> = {
  steady: "均线趋势为必要条件，叠加承接、板块与风险过滤",
  firstBoard: "低位首板与首板质量均为必要条件；封板快照不足时不满足",
  leader: "板块龙头为必要条件，辅以板块、资讯与市场情绪",
  secondWave: "波动压缩或二次突破至少成立一项，观察整理与突破的不同阶段",
  turnStrong: "弱转强形态为必要条件，辅以承接、情绪与收盘表现"
};
/**
 * 实测方向的快捷组合（2026-11-21）：只用「实测因子」（不过热 / 低位涨停 / 深跌底部）做必要条件，
 * 不要求均线多头、收盘高位这类在全A回放里对涨停后收益是负贡献的条件。
 * 说明：因子阈值来自全A日线实测；组合本身的胜率要看个股页的历史回放，不在这里承诺。
 */
export const measuredStrategyPresets: QuickStrategyPreset[] = [
  {
    id: "deepBaseBoard",
    name: "深跌底部首板",
    detail: "深跌底部与低位涨停均为必要条件，叠加涨停低点防守与不过热；对应精选策略「深跌底部首板」",
    strategies: ["deepBase", "lowPositionBoard", "support", "notOverheated", "riskVeto"],
    measured: true
  },
  {
    id: "baseQuietPullback",
    name: "底部首板缩量回踩",
    detail: "低位涨停与缩量均为必要条件，结合抛压代理与涨停低点防守；对应「首板后缩量回踩 / 温和首板后承接」",
    strategies: ["lowPositionBoard", "contraction", "chipLock", "support", "notOverheated", "riskVeto"],
    measured: true
  },
  {
    id: "deepBaseReclaim",
    name: "深跌后弱转强",
    detail: "深跌底部与弱转强均为必要条件，结合锚定均价承接与不过热",
    strategies: ["deepBase", "weakToStrong", "avwap", "notOverheated", "riskVeto"],
    measured: true
  },
  {
    id: "coolSupport",
    name: "不追高承接",
    detail: "不过热与涨停低点防守均为必要条件，结合锚定均价与缩量；避开实测中收益最差的过热追涨",
    strategies: ["notOverheated", "support", "avwap", "contraction", "riskVeto"],
    measured: true
  },
  {
    id: "coolSector",
    name: "强板块不过热",
    detail: "不过热与强板块共振均为必要条件，结合板块梯队、市场情绪与涨停低点防守",
    strategies: ["notOverheated", "sector", "sectorLadder", "support", "marketEmotion", "riskVeto"],
    measured: true
  }
];

export const quickStrategyPresets: QuickStrategyPreset[] = [
  ...measuredStrategyPresets,
  ...strategyPresets.map(preset => ({ ...preset, detail: corePresetDetails[preset.id] || preset.detail })),
  {
    id: "anchoredTrend",
    name: "锚定趋势",
    detail: "均线趋势与涨停 AVWAP 承接均为必要条件，结合回撤收盘表现",
    strategies: ["support", "avwap", "trend", "volatility", "riskVeto"]
  },
  {
    id: "volumeSupport",
    name: "缩量承接",
    detail: "缩量与涨停低点防守均为必要条件，辅以锚定均价承接",
    strategies: ["support", "avwap", "contraction", "volatility", "riskVeto"]
  },
  {
    id: "breakoutOrigin",
    name: "突破源头",
    detail: "低位首板与平台突破来源均为必要条件，结合关键位保持",
    strategies: ["lowFirstBoard", "originBreakout", "support", "avwap", "riskVeto"]
  },
  {
    id: "compressionWatch",
    name: "压缩待变",
    detail: "波动压缩为必要条件，结合缩量与抛压代理表现",
    strategies: ["vcpCompression", "chipLock", "contraction", "support", "volatility", "riskVeto"]
  },
  {
    id: "lowBaseAccumulation",
    name: "低位缩量观察",
    detail: "低位首板为必要条件，结合量能、抛压代理与 AVWAP 承接",
    strategies: ["lowFirstBoard", "chipLock", "contraction", "support", "avwap", "riskVeto"]
  },
  {
    id: "leaderSupport",
    name: "龙头承接",
    detail: "板块龙头为必要条件，结合缩量整理与涨停关键位承接",
    strategies: ["sectorLeader", "sector", "avwap", "contraction", "support", "riskVeto"]
  },
  {
    id: "sectorBreadth",
    name: "梯队共振",
    detail: "板块梯队为必要条件，结合市场情绪、均线趋势与收盘表现",
    strategies: ["sector", "sectorLadder", "marketEmotion", "trend", "volatility", "riskVeto"]
  },
  {
    id: "catalystTrend",
    name: "催化趋势",
    detail: "资讯确认与均线趋势均为必要条件，结合板块与关键位防守",
    strategies: ["information", "trend", "avwap", "sector", "support", "riskVeto"]
  },
  {
    id: "firstBoardNode",
    name: "首板观察节点",
    detail: "首板质量与低位首板均为必要条件；额外要求 T+3/5/7/9 节点",
    strategies: ["firstBoardQuality", "lowFirstBoard", "exactNode", "avwap", "support", "riskVeto"]
  },
  {
    id: "breakoutFollow",
    name: "突破跟随",
    detail: "平台二次突破为必要条件，结合均线趋势、板块领先与收盘表现",
    strategies: ["secondBreakout", "trend", "avwap", "sectorLeader", "volatility", "support", "riskVeto"]
  }
];
