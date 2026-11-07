import { strategyPresets } from "./domain/settings";

export type QuickStrategyPreset = (typeof strategyPresets)[number];

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
export const quickStrategyPresets: QuickStrategyPreset[] = [
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
