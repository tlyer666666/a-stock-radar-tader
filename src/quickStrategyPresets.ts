import { strategyPresets } from "./domain/settings";

export type QuickStrategyPreset = (typeof strategyPresets)[number];

// These select the stock-analysis factors supported by Settings. The analysis
// engine gives scoring factors equal weight; riskVeto/exactNode are hard gates.
export const quickStrategyPresets: QuickStrategyPreset[] = [
  ...strategyPresets,
  {
    id: "anchoredTrend",
    name: "锚定趋势",
    detail: "侧重均线趋势、涨停 AVWAP 承接与回撤收盘质量",
    strategies: ["support", "avwap", "trend", "volatility", "riskVeto"]
  },
  {
    id: "volumeSupport",
    name: "缩量承接",
    detail: "侧重涨停低点防守、缩量整理与锚定均价承接",
    strategies: ["support", "avwap", "contraction", "volatility", "riskVeto"]
  },
  {
    id: "breakoutOrigin",
    name: "突破源头",
    detail: "侧重低位首次涨停的平台突破来源与关键位保持",
    strategies: ["lowFirstBoard", "originBreakout", "support", "avwap", "riskVeto"]
  },
  {
    id: "compressionWatch",
    name: "压缩待变",
    detail: "侧重整理期波动压缩、筹码锁定与缩量表现",
    strategies: ["vcpCompression", "chipLock", "contraction", "support", "volatility", "riskVeto"]
  },
  {
    id: "lowBaseAccumulation",
    name: "低位锁筹",
    detail: "侧重低位首板后的筹码锁定、缩量与 AVWAP 承接",
    strategies: ["lowFirstBoard", "chipLock", "contraction", "support", "avwap", "riskVeto"]
  },
  {
    id: "leaderSupport",
    name: "龙头承接",
    detail: "侧重板块领先个股的缩量整理与涨停关键位承接",
    strategies: ["sectorLeader", "sector", "avwap", "contraction", "support", "riskVeto"]
  },
  {
    id: "sectorBreadth",
    name: "梯队共振",
    detail: "结合板块梯队、市场情绪、均线趋势与收盘质量",
    strategies: ["sector", "sectorLadder", "marketEmotion", "trend", "volatility", "riskVeto"]
  },
  {
    id: "catalystTrend",
    name: "催化趋势",
    detail: "结合正向资讯、板块强度与均线趋势，保留关键位防守",
    strategies: ["information", "trend", "avwap", "sector", "support", "riskVeto"]
  },
  {
    id: "firstBoardNode",
    name: "首板观察节点",
    detail: "低位首板质量与承接观察；额外要求 T+3/5/7/9 节点",
    strategies: ["firstBoardQuality", "lowFirstBoard", "exactNode", "avwap", "support", "riskVeto"]
  },
  {
    id: "breakoutFollow",
    name: "突破跟随",
    detail: "侧重平台二次突破、均线趋势、板块领先与收盘质量",
    strategies: ["secondBreakout", "trend", "avwap", "sectorLeader", "volatility", "support", "riskVeto"]
  }
];
