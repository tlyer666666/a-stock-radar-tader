import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowLeft,
  BarChart3,
  BookOpenCheck,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Download,
  Gauge,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
  X
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { loadSafeLocalJson, saveSafeLocalJson } from "./safeStorage";

type ReviewTab = "market" | "stock" | "archive";
type Security = {
  code: string;
  name?: string;
  secid?: string;
  thscode?: string;
  marketName?: string;
  assetType?: "stock" | "etf" | "convertibleBond";
  defaultVisible?: boolean;
};
type ReviewRecord = {
  id: string;
  type: "market" | "stock";
  title: string;
  date: string;
  score: number;
  verdict: string;
  note: string;
  createdAt: string;
  snapshot: any;
};

const REVIEW_ARCHIVE_KEY = "a-stock-radar-professional-review-v1";
const MAX_REVIEW_RECORDS = 80;
export const FACTOR_GROUPS = [
  {
    id: "structure",
    label: "结构与筹码",
    description: "关键位、成本、趋势、动量、量价与波动形态",
    factors: ["support", "avwap", "trend", "momentum", "volume", "volatility", "pattern"]
  },
  {
    id: "leadership",
    label: "主线与地位",
    description: "板块强度、涨停梯队、封板质量与市场环境",
    factors: ["sector", "ladder", "firstBoard", "market"]
  },
  {
    id: "catalyst",
    label: "催化与交易条件",
    description: "信息催化与成交流动性",
    factors: ["information", "liquidity"]
  },
  {
    id: "validation",
    label: "验证与风控",
    description: "历史样本、执行准备度与风险否决",
    factors: ["historical", "execution", "risk"]
  },
  {
    id: "certainty",
    label: "证据确定性",
    description: "数据完整、多源一致、独立证据共振与失效边界；不是收益保证",
    factors: ["dataCertainty", "sourceConsensus", "evidenceConvergence", "boundaryClarity"]
  }
];

function api(): any {
  return (window as any).stockApi;
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function nullableNumber(value: any): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function number(value: any, fallback = 0) {
  const result = nullableNumber(value);
  return result === null ? fallback : result;
}

function fmt(value: any, digits = 1) {
  const numeric = nullableNumber(value);
  return numeric === null ? "--" : numeric.toFixed(digits);
}

function pct(value: any, digits = 1) {
  const numeric = nullableNumber(value);
  if (numeric === null) return "--";
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(digits)}%`;
}

function unit(value: any, digits: number, suffix: string) {
  const numeric = nullableNumber(value);
  return numeric === null ? "--" : `${numeric.toFixed(digits)}${suffix}`;
}

function changeTone(value: any) {
  const numeric = nullableNumber(value);
  return numeric === null ? "" : numeric >= 0 ? "up" : "down";
}

function money(value: any) {
  const numeric = nullableNumber(value);
  if (numeric === null) return "--";
  if (Math.abs(numeric) >= 1e8) return `${(numeric / 1e8).toFixed(1)}亿`;
  if (Math.abs(numeric) >= 1e4) return `${(numeric / 1e4).toFixed(1)}万`;
  return numeric.toFixed(0);
}

function executionStatusLabel(value: any) {
  const status = String(value || "WAIT").toUpperCase();
  if (status === "PASS" || status === "APPROVED") return "允许执行";
  if (status === "BLOCK" || status === "BLOCKED" || status === "REJECTED") {
    return "不可执行（风险否决）";
  }
  return "等待条件确认";
}

function tradeSignalLabel(value: any) {
  const signal = String(value || "WAIT").toUpperCase();
  if (signal === "BUY_AGGRESSIVE") return "强势买入条件满足";
  if (signal === "BUY") return "买入条件满足";
  if (signal === "SELL") return "退出或回避";
  if (signal === "HOLD") return "继续观察";
  if (signal === "BLOCK") return "不可执行（风险否决）";
  return "等待条件确认";
}

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { hour12: false });
}

function loadArchive(): ReviewRecord[] {
  const value = loadSafeLocalJson<unknown>(REVIEW_ARCHIVE_KEY, []);
  return Array.isArray(value) ? value.slice(0, MAX_REVIEW_RECORDS) : [];
}

function downloadJson(value: any, filename: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function average(values: number[]) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, item) => sum + item, 0) / valid.length : 0;
}

function periodReturn(history: any[], days: number) {
  if (!Array.isArray(history) || history.length <= days) return null;
  const latest = nullableNumber(history.at(-1)?.close);
  const base = nullableNumber(history.at(-(days + 1))?.close);
  return latest !== null && base !== null && base > 0
    ? ((latest / base) - 1) * 100
    : null;
}

function technicalDiagnostics(history: any[]) {
  const rows = Array.isArray(history) ? history.filter((item) => number(item?.close) > 0) : [];
  const amplitudes = rows.slice(1).map((item, index) => {
    const previousClose = number(rows[index]?.close);
    return previousClose
      ? ((number(item.high) - number(item.low)) / previousClose) * 100
      : 0;
  });
  const trueRanges = rows.slice(1).map((item, index) => {
    const previousClose = number(rows[index]?.close);
    return Math.max(
      number(item.high) - number(item.low),
      Math.abs(number(item.high) - previousClose),
      Math.abs(number(item.low) - previousClose)
    );
  });
  const latest = nullableNumber(rows.at(-1)?.close);
  const atr14 = average(trueRanges.slice(-14));
  const recentAmplitude = amplitudes.length >= 3
    ? average(amplitudes.slice(-3))
    : null;
  const previousAmplitude = amplitudes.length >= 8
    ? average(amplitudes.slice(-8, -3))
    : null;
  return {
    available: rows.length >= 11,
    volatilityAvailable: rows.length >= 15,
    return1: periodReturn(rows, 1),
    return3: periodReturn(rows, 3),
    return5: periodReturn(rows, 5),
    return10: periodReturn(rows, 10),
    atrPercent:
      rows.length >= 15 && latest !== null && latest > 0
        ? (atr14 / latest) * 100
        : null,
    recentAmplitude,
    compressionRatio:
      recentAmplitude !== null &&
      previousAmplitude !== null &&
      previousAmplitude > 0
        ? recentAmplitude / previousAmplitude
        : null
  };
}

function factor(input: {
  id: string;
  name: string;
  score: number;
  passed: boolean;
  detail: string;
  weight: number;
  source: string;
  available?: boolean;
}) {
  const available = input.available !== false;
  const score = available ? Math.round(clamp(input.score)) : 50;
  const passed = available && input.passed;
  return {
    ...input,
    available,
    score,
    passed,
    status: !available
      ? "pending"
      : passed
        ? score >= 70
          ? "strong"
          : "neutral"
        : "risk"
  };
}

function stockReviewFromPayload(payload: any) {
  const quote = payload?.quote || {};
  const analysis = payload?.analysis || {};
  const history = Array.isArray(payload?.history) ? payload.history : [];
  const diagnostics = technicalDiagnostics(history);
  const latest = number(quote.latest || payload?.history?.at(-1)?.close);
  const support = number(analysis.limitEvent?.low || analysis.supportLow);
  const avwap = number(analysis.avwap);
  const platformHigh = number(analysis.platformHigh);
  const score = Math.round(clamp(analysis.mrs ?? analysis.score ?? 50));
  const qualification = analysis.qualification || {};
  const risks = Array.isArray(analysis.risks) ? analysis.risks : [];
  const tradePlan = analysis.tradePlan || {};
  const isSearchOnlyAsset = Boolean(analysis.isSearchOnlyAsset);
  const assetLabel = analysis.assetLabel || quote.assetLabel || "证券";
  const firstBoard = analysis.firstBoardQuality || {};
  const ladder = analysis.sectorLadder || {};
  const historicalEdge = analysis.historicalEdge || {};
  const executionReadiness = analysis.tradeExecutionReadiness || analysis.executionReadiness || {};
  const announcements = Array.isArray(payload?.announcements) ? payload.announcements : [];
  const actualProvider = String(payload?.actualProvider || "");
  const thsActive = /ths|同花顺/i.test(actualProvider);
  const quoteSource = thsActive ? "同花顺行情·本地计算" : "公开行情·本地计算";
  const stockReturn3 =
    nullableNumber(analysis.stockReturn3) ?? diagnostics.return3;
  const stockReturn5 = diagnostics.return5;
  const momentumScore = clamp(
    50 +
      number(stockReturn3) * 4 +
      number(stockReturn5) * 2 +
      (latest >= number(analysis.ma5) ? 10 : -10)
  );
  const volumeAvailable = number(analysis.volumeRatio) > 0;
  const volumePassed =
    volumeAvailable &&
    number(analysis.volumeRatio) <= 1.5 &&
    number(analysis.relativeTurnover) <= 1.8 &&
    number(analysis.closePosition) >= 0.5;
  const volumeScore = volumePassed
    ? number(analysis.volumeRatio) <= 0.9 ? 92 : 82
    : number(analysis.volumeRatio) > 2.2 || number(analysis.closePosition) < 0.25
      ? 25
      : 52;
  const volatilityPassed =
    diagnostics.volatilityAvailable &&
    nullableNumber(diagnostics.compressionRatio) !== null &&
    number(diagnostics.compressionRatio) <= 0.9 &&
    number(analysis.maxDrawdown) <= 10;
  const volatilityScore = diagnostics.volatilityAvailable
    ? clamp(
        88 -
          Math.max(0, number(diagnostics.compressionRatio) - 0.75) * 45 -
          Math.max(0, number(analysis.maxDrawdown) - 6) * 2
      )
    : 50;
  const sectorAvailable = !isSearchOnlyAsset && Boolean(payload?.sector || quote.industry);
  const ladderAvailable = !isSearchOnlyAsset && Boolean(analysis.sectorLadder);
  const firstBoardAvailable = !isSearchOnlyAsset && firstBoard.available === true && firstBoard.dataComplete !== false;
  const marketEmotion = analysis.marketEmotion || {};
  const marketAvailable = Boolean(analysis.marketEmotion) || Number.isFinite(Number(analysis.marketScore));
  const historicalAvailable = number(historicalEdge.sampleCount) > 0;
  const historicalScore = historicalAvailable
    ? clamp(
        42 +
          (number(historicalEdge.winRate5) - 45) * 1.25 +
          number(historicalEdge.average5) * 6 -
          Math.max(0, Math.abs(number(historicalEdge.worstMdd5)) - 12) * 0.8 +
          (historicalEdge.passed ? 15 : 0)
      )
    : 50;
  const amount = number(quote.amount);
  const turnover = number(quote.turnover);
  const liquidityAvailable = amount > 0;
  const liquidityPassed = liquidityAvailable && amount >= 1e8 && turnover >= 0.3 && turnover <= 25;
  const liquidityScore = !liquidityAvailable
    ? 50
    : amount >= 5e8 && turnover >= 1 && turnover <= 15
      ? 92
      : amount >= 1e8 && turnover <= 25
        ? 78
        : amount >= 3e7
          ? 58
          : 32;
  const patternLabels = [
    analysis.originBreakout ? "起涨突破" : "",
    analysis.vcpCompression ? "VCP收敛" : "",
    analysis.chipLock ? "筹码锁定" : "",
    analysis.weakToStrong ? "弱转强" : "",
    analysis.secondBreakout ? "二次突破" : ""
  ].filter(Boolean);
  const patternAvailable = !isSearchOnlyAsset && Boolean(analysis.limitEvent);
  const informationAvailable =
    nullableNumber(analysis.infoScore) !== null || announcements.length > 0;
  const patternScore = clamp(
    35 +
      patternLabels.length * 13 +
      Math.max(0, number(analysis.chipLockScore) - 50) * 0.25
  );
  const executionAvailable = Number.isFinite(Number(executionReadiness.score));
  const executionScore = number(executionReadiness.score, 50);
  const riskVetoPassed =
    qualification.riskVetoPassed !== false && risks.length === 0;
  const supportPassed = isSearchOnlyAsset
    ? true
    : support
      ? latest >= support
      : Boolean(analysis.heldSupport);
  const federation = payload?.dataFederation || {};
  const realtimeSourceCount = number(federation.realtimeCount);
  const quoteSpreadPct = nullableNumber(federation.spreadPct);
  const dataChecks = [
    latest > 0,
    history.length >= 60,
    number(analysis.ma5) > 0 && number(analysis.ma10) > 0 && number(analysis.ma20) > 0,
    amount > 0 && turnover > 0,
    marketAvailable,
    Boolean(tradePlan && Object.keys(tradePlan).length),
    isSearchOnlyAsset || sectorAvailable,
    isSearchOnlyAsset || historicalAvailable
  ];
  const dataCoverageRatio = dataChecks.filter(Boolean).length / dataChecks.length;
  const dataCertaintyScore = clamp(dataCoverageRatio * 100);
  const sourceConsensusAvailable = realtimeSourceCount > 0;
  const sourceConsensusScore = !sourceConsensusAvailable
    ? 50
    : realtimeSourceCount >= 2 && quoteSpreadPct !== null
      ? clamp(100 - quoteSpreadPct * 220)
      : 58;
  const convergenceChecks = [
    Boolean(analysis.maBull && analysis.slopesUp),
    volumePassed,
    isSearchOnlyAsset ? momentumScore >= 60 : number(analysis.sectorScore) >= 60 && number(analysis.rsSector) >= 0,
    marketAvailable && number(analysis.marketScore) >= 55,
    historicalAvailable && historicalEdge.passed === true,
    riskVetoPassed
  ];
  const convergenceCount = convergenceChecks.filter(Boolean).length;
  const convergenceScore = clamp((convergenceCount / convergenceChecks.length) * 100);
  let preliminaryTrigger = number(tradePlan.triggerPrice || tradePlan.entryPrice) ||
    Math.max(latest, platformHigh || 0, avwap || 0);
  if (!supportPassed && support) {
    preliminaryTrigger = Math.max(preliminaryTrigger, support, avwap || 0, platformHigh || 0);
  }
  let preliminaryStop = number(tradePlan.stopPrice) ||
    (support ? support * 0.98 : latest * 0.95);
  if (preliminaryStop >= preliminaryTrigger) preliminaryStop = preliminaryTrigger * 0.97;
  const preliminaryTarget = number(tradePlan.takeProfitPrice || tradePlan.targetPrice) ||
    (preliminaryTrigger + Math.max(preliminaryTrigger - preliminaryStop, preliminaryTrigger * 0.03) * 1.8);
  const preliminaryRiskReward = preliminaryTrigger > preliminaryStop
    ? (preliminaryTarget - preliminaryTrigger) / (preliminaryTrigger - preliminaryStop)
    : 0;
  const boundaryAvailable = preliminaryTrigger > 0 && preliminaryStop > 0 && preliminaryStop < preliminaryTrigger;
  const boundaryScore = boundaryAvailable
    ? clamp(48 + Math.min(2.5, preliminaryRiskReward) * 18 - Math.max(0, ((preliminaryTrigger - preliminaryStop) / preliminaryTrigger * 100) - 10) * 2)
    : 50;
  const factors = [
    factor({
      id: "support",
      name: "关键位防守",
      score: supportPassed ? 100 : 20,
      passed: supportPassed,
      available: !isSearchOnlyAsset && Boolean(support),
      weight: 8,
      source: quoteSource,
      detail: isSearchOnlyAsset
        ? `${assetLabel} 不适用涨停日低点锚定`
        : support
        ? `涨停日低点 ${fmt(support, 2)}，现价距离 ${fmt(((latest / support) - 1) * 100)}%`
        : "近期未识别到可用涨停锚点"
    }),
    factor({
      id: "avwap",
      name: isSearchOnlyAsset ? "近期均价" : "资金成本",
      score: avwap ? (latest >= avwap ? 90 : 30) : 45,
      passed: Boolean(avwap && latest >= avwap),
      available: Boolean(avwap),
      weight: 6,
      source: quoteSource,
      detail: avwap
        ? `${isSearchOnlyAsset ? "近10日成交均价" : "涨停锚定均价"} ${fmt(avwap, 2)}，现价 ${latest >= avwap ? "位于上方" : "位于下方"}`
        : "锚定均价暂不可用"
    }),
    factor({
      id: "trend",
      name: "趋势结构",
      score: analysis.maBull && analysis.slopesUp ? 95 : analysis.maBull ? 72 : 38,
      passed: Boolean(analysis.maBull && analysis.slopesUp),
      available: Boolean(number(analysis.ma5) && number(analysis.ma10) && number(analysis.ma20)),
      weight: 8,
      source: quoteSource,
      detail: `${analysis.trendLabel || "趋势待确认"} · MA5 ${fmt(analysis.ma5, 2)} / MA10 ${fmt(analysis.ma10, 2)} / MA20 ${fmt(analysis.ma20, 2)}`
    }),
    factor({
      id: "momentum",
      name: "多周期动量",
      score: momentumScore,
      passed:
        stockReturn3 !== null &&
        stockReturn5 !== null &&
        stockReturn3 >= 0 &&
        stockReturn5 >= 0 &&
        latest >= number(analysis.ma5),
      available: diagnostics.available,
      weight: 5,
      source: quoteSource,
      detail: `1/3/5/10日 ${pct(diagnostics.return1)} / ${pct(stockReturn3)} / ${pct(stockReturn5)} / ${pct(diagnostics.return10)}`
    }),
    factor({
      id: "volume",
      name: "量价承接",
      score: volumeScore,
      passed: volumePassed,
      available: volumeAvailable,
      weight: 7,
      source: quoteSource,
      detail: `量能倍数 ${fmt(analysis.volumeRatio, 2)}x · 收盘位置 ${fmt(number(analysis.closePosition) * 100)}% · 相对换手 ${fmt(analysis.relativeTurnover, 2)}x`
    }),
    factor({
      id: "volatility",
      name: "波动收敛",
      score: volatilityScore,
      passed: volatilityPassed,
      available: diagnostics.volatilityAvailable,
      weight: 5,
      source: quoteSource,
      detail: `ATR14 ${fmt(diagnostics.atrPercent, 2)}% · 近3日振幅 ${fmt(diagnostics.recentAmplitude, 2)}% · 收敛比 ${fmt(diagnostics.compressionRatio, 2)}x`
    }),
    factor({
      id: "pattern",
      name: "形态与筹码",
      score: patternScore,
      passed: patternLabels.length >= 2 && !analysis.chipLocalVeto,
      available: patternAvailable,
      weight: 5,
      source: "事件形态·筹码代理",
      detail: patternAvailable
        ? `${patternLabels.join("、") || "暂未形成共振形态"} · 筹码锁定 ${fmt(analysis.chipLockScore, 0)}${nullableNumber(analysis.chipLockScore) === null ? "" : "分"} · 下跌量占比 ${nullableNumber(analysis.downVolumeShare) === null ? "--" : `${fmt(number(analysis.downVolumeShare) * 100)}%`}`
        : "缺少涨停事件锚点，形态因子不计入"
    }),
    factor({
      id: "sector",
      name: "相对板块",
      score: clamp(number(analysis.sectorScore) * 0.55 + clamp(55 + number(analysis.rsSector) * 8) * 0.45),
      passed: number(analysis.rsSector) >= 0 && number(analysis.sectorScore) >= 60,
      available: sectorAvailable,
      weight: 8,
      source: "板块横向比较",
      detail: isSearchOnlyAsset
        ? `${assetLabel} 不纳入涨停板块横向排名`
        : `板块 ${fmt(analysis.sectorScore, 0)} 分 · 近3日相对强度 ${pct(analysis.rsSector)} · 个股排名 ${analysis.sectorRank ? `#${analysis.sectorRank}` : "--"}`
    }),
    factor({
      id: "ladder",
      name: "板块涨停梯队",
      score: number(analysis.sectorLadderScore),
      passed: number(analysis.sectorLadderScore) >= 65 && number(ladder.breakRate) <= 0.32,
      available: ladderAvailable,
      weight: 5,
      source: "涨停专题·梯队模型",
      detail: ladderAvailable
        ? `${ladder.state || "梯队待确认"} ${fmt(analysis.sectorLadderScore, 0)}分 · ${number(ladder.currentLimitUps)}只涨停 · 最高${number(ladder.maxHeight)}板 · 晋级${fmt(number(ladder.promotionRate) * 100)}%`
        : "板块梯队数据暂不可用，按缺失处理而非记0分"
    }),
    factor({
      id: "firstBoard",
      name: "涨停质量",
      score: number(firstBoard.score),
      passed: Boolean(firstBoard.matched),
      available: firstBoardAvailable,
      weight: 5,
      source: "涨停专题·封板字段",
      detail: firstBoardAvailable
        ? `${firstBoard.summary} · 首封 ${firstBoard.firstSealTime || "--"} · 开板 ${number(firstBoard.openBoardCount)}次 · 涨停换手 ${fmt(firstBoard.turnover)}%`
        : "首次封板、开板次数、封单/流通市值等待专题字段"
    }),
    factor({
      id: "market",
      name: "市场情绪",
      score: number(analysis.marketScore, 50),
      passed: number(analysis.marketScore) >= 60 && number(marketEmotion.limitDownRatio) <= 0.35,
      available: marketAvailable,
      weight: 5,
      source: "全市场宽度·涨跌停",
      detail: `${marketEmotion.state || "环境评分"} ${fmt(analysis.marketScore, 0)}${nullableNumber(analysis.marketScore) === null ? "" : "分"} · 涨停 ${fmt(marketEmotion.limitUpCount, 0)} / 跌停 ${fmt(marketEmotion.limitDownCount, 0)}`
    }),
    factor({
      id: "information",
      name: "信息催化",
      score: number(analysis.infoScore, 50),
      passed: number(analysis.infoScore) >= 60 && number(analysis.infoRiskSeverity) < 2,
      available: informationAvailable,
      weight: 6,
      source: thsActive ? "同花顺/公告/资讯聚合" : "公告/资讯聚合",
      detail: informationAvailable
        ? `有效事件 ${announcements.length} 条 · 催化 ${fmt(analysis.infoScore, 0)}${nullableNumber(analysis.infoScore) === null ? "" : "分"} · 风险级别 ${fmt(analysis.infoRiskSeverity, 0)}`
        : "公告与资讯催化字段暂不可用，本次不计入诊断分"
    }),
    factor({
      id: "historical",
      name: "历史有效性",
      score: historicalScore,
      passed: Boolean(historicalEdge.passed),
      available: historicalAvailable,
      weight: 6,
      source: "历史回放·样本门槛",
      detail: historicalAvailable
        ? `样本 ${number(historicalEdge.sampleCount)} · 5日胜率 ${fmt(historicalEdge.winRate5)}% · 均值 ${pct(historicalEdge.average5, 2)} · 最差回撤 ${fmt(historicalEdge.worstMdd5)}%`
        : "相同策略组合样本不足，不把未知结果当作负分"
    }),
    factor({
      id: "liquidity",
      name: "流动性质量",
      score: liquidityScore,
      passed: liquidityPassed,
      available: liquidityAvailable,
      weight: 4,
      source: quoteSource,
      detail: `成交额 ${money(amount)} · 换手 ${fmt(turnover)}% · ${liquidityPassed ? "满足基础流动性门槛" : "需注意冲击成本"}`
    }),
    factor({
      id: "execution",
      name: "执行准备度",
      score: executionScore,
      passed: Boolean(executionReadiness.canExecute) && executionScore >= 68,
      available: executionAvailable,
      weight: 7,
      source: "风控预算·成交条件",
      detail: executionAvailable
        ? `${executionStatusLabel(executionReadiness.status)} · ${executionReadiness.summary || "等待条件确认"} · 风险收益比 ${fmt(tradePlan.riskReward, 2)}x`
        : "执行准备度尚未计算"
    }),
    factor({
      id: "risk",
      name: "风险否决",
      score: riskVetoPassed ? clamp(100 - number(analysis.riskPenalty)) : 15,
      passed: riskVetoPassed,
      available: true,
      weight: 10,
      source: "硬规则·反证优先",
      detail: risks.length ? risks.slice(0, 3).join("；") : "未发现系统级硬风险；仍需服从结构失效价"
    }),
    factor({
      id: "dataCertainty",
      name: "关键数据完整度",
      score: dataCertaintyScore,
      passed: dataCoverageRatio >= 0.75,
      available: true,
      weight: 4,
      source: "行情·历史·板块·策略证据清单",
      detail: `${dataChecks.filter(Boolean).length}/${dataChecks.length} 类关键证据可用 · 日线 ${history.length} 根 · 缺失项不按0分伪装`
    }),
    factor({
      id: "sourceConsensus",
      name: "多源行情一致性",
      score: sourceConsensusScore,
      passed: realtimeSourceCount >= 2 && quoteSpreadPct !== null && quoteSpreadPct <= 0.2,
      available: sourceConsensusAvailable,
      weight: 4,
      source: "同花顺主线·东方财富·腾讯交叉校验",
      detail: sourceConsensusAvailable
        ? `${federation.status || "行情源状态待确认"} · 实时源 ${realtimeSourceCount} 个 · 价差 ${quoteSpreadPct === null ? "--" : `${fmt(quoteSpreadPct, 3)}%`}`
        : "本轮没有可核验的实时行情源状态"
    }),
    factor({
      id: "evidenceConvergence",
      name: "独立证据共振",
      score: convergenceScore,
      passed: convergenceCount >= 4 && riskVetoPassed,
      available: true,
      weight: 5,
      source: "趋势·量价·板块·市场·历史·风控",
      detail: `${convergenceCount}/${convergenceChecks.length} 类相互独立证据同向；同类技术指标不重复计票`
    }),
    factor({
      id: "boundaryClarity",
      name: "失效边界清晰度",
      score: boundaryScore,
      passed: boundaryAvailable && preliminaryRiskReward >= 1.5,
      available: boundaryAvailable,
      weight: 5,
      source: "确认价·失效价·目标参考",
      detail: boundaryAvailable
        ? `确认 ${fmt(preliminaryTrigger, 2)} · 失效 ${fmt(preliminaryStop, 2)} · 风险收益比 ${fmt(preliminaryRiskReward, 2)}x`
        : "确认位或结构失效位不足，不能形成可复核预案"
    })
  ];
  const availableFactors = factors.filter((item) => item.available);
  const availableWeight = availableFactors.reduce((sum, item) => sum + item.weight, 0);
  const weightedScore = availableWeight
    ? Math.round(
        availableFactors.reduce((sum, item) => sum + item.score * item.weight, 0) /
          availableWeight
      )
    : 50;
  const factorEngine = {
    total: factors.length,
    available: availableFactors.length,
    coverage: Math.round((availableFactors.length / factors.length) * 100),
    strong: availableFactors.filter((item) => item.status === "strong").length,
    neutral: availableFactors.filter((item) => item.status === "neutral").length,
    risk: availableFactors.filter((item) => !item.passed).length,
    weightedScore,
    thsActive,
    providerLabel: thsActive
      ? "同花顺行情增强已启用"
      : "免费行情计算模式（可选同花顺增强）",
    note: "缺失因子显示“待增强”且不按0分计入；确定性只衡量证据质量、来源一致和边界清晰，不代表收益确定。"
  };
  const certaintyFactors = factors.filter((item) =>
    ["dataCertainty", "sourceConsensus", "evidenceConvergence", "boundaryClarity"].includes(item.id)
  );
  const availableCertaintyFactors = certaintyFactors.filter((item) => item.available);
  const certaintyScore = availableCertaintyFactors.length
    ? Math.round(availableCertaintyFactors.reduce((sum, item) => sum + item.score, 0) / availableCertaintyFactors.length)
    : 50;
  const verdict =
    !supportPassed || qualification.riskVetoPassed === false || score < 50
      ? "风险观察"
      : score >= 80 && analysis.alertQualified
        ? "强势共振"
        : score >= 65
          ? "结构可跟踪"
          : "等待确认";
  let trigger =
    number(tradePlan.triggerPrice || tradePlan.entryPrice) ||
    Math.max(latest, platformHigh || 0, avwap || 0);
  if (!supportPassed && support) {
    trigger = Math.max(trigger, support, avwap || 0, platformHigh || 0);
  }
  let stop =
    number(tradePlan.stopPrice) ||
    (support ? support * 0.98 : latest * 0.95);
  if (stop >= trigger) stop = trigger * 0.97;
  const target =
    number(tradePlan.takeProfitPrice || tradePlan.targetPrice) ||
    (trigger + Math.max(trigger - stop, trigger * 0.03) * 1.8);
  const invalidations = isSearchOnlyAsset
    ? [
        "跌破近期结构低点且量能同步放大",
        avwap ? `放量跌破 ${fmt(avwap, 2)} 且次日不能收回` : "放量下跌且趋势同步转弱",
        "均线转为空头排列或波动率异常放大"
      ]
    : [
        support ? `收盘有效跌破 ${fmt(support, 2)}（涨停日最低价）` : "结构低点被有效跌破",
        avwap ? `放量跌破 ${fmt(avwap, 2)} 且次日不能收回` : "放量下跌且板块同步转弱",
        "板块强度连续两日跌出市场前50%"
      ];
  const validHistory = history.filter((item: any) => number(item?.close) > 0);
  const recent20 = validHistory.slice(-20);
  const recent60 = validHistory.slice(-60);
  const high20 = recent20.length >= 20
    ? Math.max(...recent20.map((item: any) => number(item.high)))
    : null;
  const low20 = recent20.length >= 20
    ? Math.min(...recent20.map((item: any) => number(item.low)))
    : null;
  const high60 = recent60.length >= 60
    ? Math.max(...recent60.map((item: any) => number(item.high)))
    : null;
  const low60 = recent60.length >= 60
    ? Math.min(...recent60.map((item: any) => number(item.low)))
    : null;
  const rangePosition20 =
    high20 !== null && low20 !== null && high20 > low20
      ? clamp(((latest - low20) / (high20 - low20)) * 100)
      : null;
  const strongFactors = availableFactors
    .filter((item) => item.passed && item.status === "strong")
    .sort((left, right) => right.score - left.score)
    .slice(0, 4);
  const riskFactors = availableFactors
    .filter((item) => !item.passed)
    .sort((left, right) => left.score - right.score)
    .slice(0, 4);
  const pendingFactors = factors.filter((item) => !item.available);
  const attackTrigger = Math.max(trigger, platformHigh || 0, number(analysis.ma5), latest);
  const balanceLevel = avwap || number(analysis.ma10) || support || latest;
  const defenseLevel = stop || support || low20 || latest * 0.95;
  const volumeCondition = volumeAvailable
    ? `${fmt(analysis.volumeRatio, 2)}x`
    : "待补";
  const attackCondition = isSearchOnlyAsset
    ? `收盘站稳 ${fmt(attackTrigger, 2)}，MA5/MA10 保持上行，量能 ${volumeCondition} 不出现失控放大`
    : `收盘站稳 ${fmt(attackTrigger, 2)}，量能 ${volumeCondition} 不出现失控放大，板块强度不低于 65 分`;
  const balanceInvalidation = isSearchOnlyAsset
    ? `放量跌破 ${fmt(balanceLevel, 2)}，或 MA20 与市场环境同步转弱`
    : `放量跌破 ${fmt(balanceLevel, 2)}，或相对板块强度继续转负`;
  const defenseCondition = isSearchOnlyAsset
    ? `收盘跌破 ${fmt(defenseLevel, 2)}，或风险否决、趋势转空、公告风险任一项触发`
    : `收盘跌破 ${fmt(defenseLevel, 2)}，或风险否决、板块退潮、公告风险任一项触发`;
  const scenarios = [
    {
      id: "attack",
      name: "进攻确认",
      probability:
        score >= 75 &&
        (isSearchOnlyAsset
          ? Boolean(analysis.maBull && analysis.slopesUp)
          : number(analysis.sectorScore) >= 65)
          ? "优先观察"
          : "条件不足",
      condition: attackCondition,
      action: "只记录突破后的承接和收盘质量；未同时满足量价与板块条件时不升级结论。",
      invalidation: `盘中突破但收盘重新跌回 ${fmt(balanceLevel, 2)} 下方`
    },
    {
      id: "balance",
      name: "承接整理",
      probability:
        supportPassed && volumeAvailable && number(analysis.volumeRatio) <= 1.5
          ? "基准情景"
          : volumeAvailable
            ? "需谨慎"
            : "量能待补",
      condition: `价格运行在 ${fmt(defenseLevel, 2)} 至 ${fmt(attackTrigger, 2)} 之间，量能保持温和或继续收敛`,
      action: "观察关键成本、MA5/MA10 与板块相对强度是否同步改善，等待新的确认信号。",
      invalidation: balanceInvalidation
    },
    {
      id: "defense",
      name: "防守触发",
      probability: riskFactors.length || !supportPassed ? "风险偏高" : "备用预案",
      condition: defenseCondition,
      action: "将结论降为风险观察，停止沿用原确认价和目标参考，重新等待结构建立。",
      invalidation: `重新站回 ${fmt(balanceLevel, 2)} 且风险项完成复核`
    }
  ];
  return {
    security: payload?.security || { code: quote.code, name: quote.name },
    quote,
    analysis,
    score,
    grade: analysis.grade || (score >= 85 ? "S" : score >= 75 ? "A" : score >= 60 ? "B" : "C"),
    verdict,
    factors,
    factorEngine,
    certainty: {
      score: certaintyScore,
      label: certaintyScore >= 80 ? "证据较完整" : certaintyScore >= 65 ? "中等确定性" : "仍需补证据",
      passed: availableCertaintyFactors.filter((item) => item.passed).length,
      available: availableCertaintyFactors.length,
      total: certaintyFactors.length,
      note: "该分数回答“证据有多可靠”，不回答“未来一定涨不涨”。"
    },
    risks,
    plan: {
      signal: supportPassed
        ? (tradePlan.signal || analysis.actionSignal || "WAIT")
        : "WAIT",
      trigger,
      stop,
      target,
      riskReward: trigger > stop ? (target - trigger) / (trigger - stop) : 0,
      position: number(tradePlan.positionSizePercent),
      invalidations
    },
    diagnostics: {
      available: diagnostics.available,
      volatilityAvailable: diagnostics.volatilityAvailable,
      return1: diagnostics.return1,
      return3: stockReturn3,
      return5: diagnostics.return5,
      return10: diagnostics.return10,
      atrPercent: diagnostics.atrPercent,
      recentAmplitude: diagnostics.recentAmplitude,
      compressionRatio: diagnostics.compressionRatio,
      high20,
      low20,
      high60,
      low60,
      rangePosition20,
      maxDrawdown: nullableNumber(analysis.maxDrawdown),
      maxDrawdownLabel: isSearchOnlyAsset ? "20日区间幅度" : "最大回撤",
      closePosition:
        nullableNumber(analysis.closePosition) === null
          ? null
          : number(analysis.closePosition) * 100,
      volumeRatio: nullableNumber(analysis.volumeRatio),
      relativeTurnover: nullableNumber(analysis.relativeTurnover)
    },
    keyLevels: [
      { id: "trigger", label: "确认位", value: attackTrigger, tone: "up", source: platformHigh ? "平台高点/系统触发" : "系统触发价" },
      { id: "avwap", label: "成本锚", value: avwap, tone: "", source: avwap ? (isSearchOnlyAsset ? "近10日成交均价" : "涨停锚定均价") : "当前缺失" },
      { id: "support", label: isSearchOnlyAsset ? "近期支撑" : "关键支撑", value: support, tone: "", source: support ? (isSearchOnlyAsset ? "近期结构低点" : "涨停日低点") : "当前缺失" },
      { id: "defense", label: "结构失效", value: defenseLevel, tone: "down", source: "系统止损/结构低点" },
      { id: "high20", label: "20日高点", value: high20, tone: "", source: high20 === null ? "历史不足" : "日线计算" },
      { id: "low20", label: "20日低点", value: low20, tone: "", source: low20 === null ? "历史不足" : "日线计算" }
    ],
    scenarios,
    factorLeaders: {
      strong: strongFactors,
      risk: riskFactors,
      pending: pendingFactors
    },
    checklist: {
      confirmed: strongFactors.map((item) => `${item.name}：${item.detail}`),
      risks: riskFactors.map((item) => `${item.name}：${item.detail}`),
      pending: pendingFactors.map((item) => `${item.name}：${item.detail}`)
    },
    evidence: isSearchOnlyAsset
      ? [
          `${assetLabel} 主动搜索结果，结构评分 ${score} 分，策略匹配率 ${number(analysis.strategyMatchRate)}%。`,
          `近3日涨跌 ${pct(analysis.stockReturn3)}，量能倍数 ${fmt(analysis.volumeRatio, 2)}x。`,
          `${analysis.trendLabel || "趋势待确认"}，收盘位置 ${fmt(number(analysis.closePosition) * 100)}%。`
        ]
      : [
          `当前 ${analysis.exactNode || analysis.nextNode || "非精确观察节点"}，MRS ${score} 分，策略匹配率 ${number(analysis.strategyMatchRate)}%。`,
          `最大回撤 ${fmt(analysis.maxDrawdown)}%，板前20日涨幅 ${fmt(analysis.preLimitReturn20)}%，近60日涨停 ${number(analysis.eventCount60)} 次。`,
          `个股近3/5日 ${pct(analysis.stockReturn3)} / ${pct(stockReturn5)}，相对板块 ${pct(analysis.rsSector)}。`,
          ladderAvailable
            ? `板块梯队 ${ladder.state || "待确认"}，最高 ${number(ladder.maxHeight)} 板，晋级率 ${fmt(number(ladder.promotionRate) * 100)}%，炸板率 ${fmt(number(ladder.breakRate) * 100)}%。`
            : "板块涨停梯队数据暂缺，本次不会用缺失字段推断强弱。",
          firstBoardAvailable
            ? `${firstBoard.summary}，首封 ${firstBoard.firstSealTime || "--"}，开板 ${number(firstBoard.openBoardCount)} 次。`
            : "封板专题字段暂缺；涨停质量因子标记为待增强。",
          historicalAvailable
            ? `历史同组合 ${number(historicalEdge.sampleCount)} 个样本，5日胜率 ${fmt(historicalEdge.winRate5)}%，平均收益 ${pct(historicalEdge.average5, 2)}。`
            : "历史同组合样本不足，当前不据此放大仓位。"
        ],
    updatedAt: payload?.updatedAt || new Date().toISOString()
  };
}

function restoreStockReviewSnapshot(snapshot: any) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const hasDetailedEvidence =
    snapshot.diagnostics &&
    Array.isArray(snapshot.keyLevels) &&
    snapshot.factorLeaders &&
    snapshot.checklist &&
    Array.isArray(snapshot.scenarios);
  if (hasDetailedEvidence) return snapshot;
  const factors = Array.isArray(snapshot.factors) ? snapshot.factors : [];
  return {
    ...snapshot,
    factors,
    factorEngine: snapshot.factorEngine || {
      total: factors.length,
      available: factors.filter((item: any) => item?.available !== false).length,
      coverage: 0,
      strong: 0,
      risk: 0,
      weightedScore: number(snapshot.score, 50),
      thsActive: false,
      providerLabel: "旧版复盘档案",
      note: "该档案未保存新版详细证据，系统不会用缺失字段回填历史结论。"
    },
    certainty: snapshot.certainty || {
      score: 50,
      label: "旧档案不可回填",
      passed: 0,
      available: 0,
      total: 4,
      note: "旧版没有保存确定性证据，不根据事后数据补写。"
    },
    risks: Array.isArray(snapshot.risks) ? snapshot.risks : [],
    evidence: Array.isArray(snapshot.evidence) ? snapshot.evidence : [],
    plan: {
      ...(snapshot.plan || {}),
      invalidations: Array.isArray(snapshot?.plan?.invalidations)
        ? snapshot.plan.invalidations
        : []
    },
    legacyDetailUnavailable: true
  };
}

export default function ProfessionalReview() {
  const [tab, setTab] = useState<ReviewTab>("market");
  const [market, setMarket] = useState<any>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState("");
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Security[]>([]);
  const [searching, setSearching] = useState(false);
  const [stockLoading, setStockLoading] = useState(false);
  const [stockError, setStockError] = useState("");
  const [stock, setStock] = useState<any>(null);
  const [marketNote, setMarketNote] = useState("");
  const [stockNote, setStockNote] = useState("");
  const [archive, setArchive] = useState<ReviewRecord[]>(loadArchive);
  const [toast, setToast] = useState("");
  const searchTimer = useRef<number>();
  const searchRequestId = useRef(0);
  const stockRequestId = useRef(0);
  const suppressNextSearch = useRef(false);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  };

  const persistArchive = (next: ReviewRecord[]) => {
    const safe = next.slice(0, MAX_REVIEW_RECORDS);
    if (saveSafeLocalJson(REVIEW_ARCHIVE_KEY, safe)) {
      setArchive(safe);
      return true;
    }
    notify("复盘档案保存失败，原档案未被覆盖");
    return false;
  };

  const loadMarket = async (refresh = false) => {
    setMarketLoading(true);
    setMarketError("");
    try {
      const result = await api().getProfessionalReview({ refresh });
      setMarket(result);
    } catch (error) {
      setMarketError(error instanceof Error ? error.message : "市场复盘生成失败");
    } finally {
      setMarketLoading(false);
    }
  };

  useEffect(() => {
    void loadMarket(false);
  }, []);

  useEffect(() => {
    const requestId = ++searchRequestId.current;
    window.clearTimeout(searchTimer.current);
    if (suppressNextSearch.current) {
      suppressNextSearch.current = false;
      setSuggestions([]);
      setSearching(false);
      return;
    }
    if (!query.trim()) {
      setSuggestions([]);
      setSearching(false);
      return;
    }
    const searchText = query.trim();
    searchTimer.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const next = await api().search(searchText);
        if (requestId === searchRequestId.current) setSuggestions(next);
      } catch {
        if (requestId === searchRequestId.current) setSuggestions([]);
      } finally {
        if (requestId === searchRequestId.current) setSearching(false);
      }
    }, 240);
    return () => {
      window.clearTimeout(searchTimer.current);
      if (requestId === searchRequestId.current) searchRequestId.current += 1;
    };
  }, [query]);

  const loadStock = async (security: Security | string) => {
    const requestId = ++stockRequestId.current;
    setStockLoading(true);
    setStockError("");
    setSuggestions([]);
    setTab("stock");
    try {
      const payload = await api().analyze(security);
      if (requestId !== stockRequestId.current) return;
      setStock(stockReviewFromPayload(payload));
      suppressNextSearch.current = true;
      setQuery(payload?.quote?.name || payload?.security?.name || payload?.security?.code || "");
      setSuggestions([]);
      setStockNote("");
    } catch (error) {
      if (requestId === stockRequestId.current) {
        setStockError(error instanceof Error ? error.message : "个股复盘生成失败");
      }
    } finally {
      if (requestId === stockRequestId.current) setStockLoading(false);
    }
  };

  const submitStock = async (event: FormEvent) => {
    event.preventDefault();
    if (suggestions[0]) {
      void loadStock(suggestions[0]);
      return;
    }
    const text = query.trim();
    if (!text) return;
    try {
      const matches = await api().search(text);
      if (matches[0]) {
        void loadStock(matches[0]);
        return;
      }
    } catch {
      // Keep the user-facing search error below.
    }
    setStockError("请输入 A股、ETF 或可转债代码/名称，并从搜索建议中选择");
  };

  const saveMarketReview = () => {
    if (!market) return;
    const record: ReviewRecord = {
      id: `market-${market.date}-${Date.now()}`,
      type: "market",
      title: `${market.date} 市场复盘`,
      date: market.date,
      score: market.score,
      verdict: market.regime?.name || "市场复盘",
      note: marketNote,
      createdAt: new Date().toISOString(),
      snapshot: market
    };
    if (persistArchive([record, ...archive])) {
      setMarketNote("");
      notify("本次市场复盘已保存");
    }
  };

  const saveStockReview = () => {
    if (!stock) return;
    const record: ReviewRecord = {
      id: `stock-${stock.security?.code}-${Date.now()}`,
      type: "stock",
      title: `${stock.quote?.name || stock.security?.name || stock.security?.code} 个股复盘`,
      date: stock.updatedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10),
      score: stock.score,
      verdict: stock.verdict,
      note: stockNote,
      createdAt: new Date().toISOString(),
      snapshot: stock
    };
    if (persistArchive([record, ...archive])) {
      setStockNote("");
      notify("个股复盘已写入档案");
    }
  };

  const openArchiveRecord = (record: ReviewRecord) => {
    if (record.type === "market") {
      setMarketNote(record.note || "");
      setMarket(record.snapshot);
      setTab("market");
    } else {
      setStockNote(record.note || "");
      setStock(restoreStockReviewSnapshot(record.snapshot));
      setTab("stock");
    }
  };

  return (
    <div className="professional-review">
      <header className="review-heading">
        <div>
          <span className="review-eyebrow"><BookOpenCheck size={15} /> PROFESSIONAL REVIEW</span>
          <h1>专业复盘</h1>
          <p>用事实还原市场，用条件管理明天：覆盖大盘、主线、涨停生态与个股交易结构。</p>
        </div>
        <div className="review-heading-actions">
          <span><CalendarDays size={15} /> {market?.date || new Date().toLocaleDateString("zh-CN")}</span>
          <button onClick={() => void loadMarket(true)} disabled={marketLoading}>
            <RefreshCw size={16} className={marketLoading ? "review-spin" : ""} />
            重新计算
          </button>
        </div>
      </header>

      <nav className="review-tabs" role="tablist" aria-label="专业复盘页面">
        {[
          { id: "market" as const, label: "市场复盘", icon: BarChart3 },
          { id: "stock" as const, label: "个股复盘", icon: Target },
          { id: "archive" as const, label: `复盘档案 ${archive.length}`, icon: Archive }
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={17} /> {item.label}
          </button>
        ))}
      </nav>

      {tab === "market" && (
        <MarketReview
          data={market}
          loading={marketLoading}
          error={marketError}
          note={marketNote}
          onNote={setMarketNote}
          onSave={saveMarketReview}
          onOpenStock={loadStock}
        />
      )}

      {tab === "stock" && (
        <StockReview
          query={query}
          onQuery={setQuery}
          suggestions={suggestions}
          searching={searching}
          onSubmit={submitStock}
          onSelect={loadStock}
          loading={stockLoading}
          error={stockError}
          data={stock}
          note={stockNote}
          onNote={setStockNote}
          onSave={saveStockReview}
          onBack={() => setTab("market")}
        />
      )}

      {tab === "archive" && (
        <ArchiveView
          records={archive}
          onOpen={openArchiveRecord}
          onExport={() => downloadJson(archive, `A股雷达-专业复盘-${new Date().toISOString().slice(0, 10)}.json`)}
        />
      )}
      {toast && <div className="review-toast" role="status" aria-live="polite"><CheckCircle2 size={17} />{toast}</div>}
    </div>
  );
}

function MarketReview({ data, loading, error, note, onNote, onSave, onOpenStock }: any) {
  if (loading && !data) return <ReviewLoading text="正在汇总指数、市场广度、涨停生态和主线板块…" />;
  if (error && !data) return <ReviewError text={error} />;
  if (!data) return null;
  const dimensionLabels: Record<string, string> = {
    trend: "指数趋势",
    breadth: "市场广度",
    emotion: "情绪温度",
    ecology: "涨停生态",
    leadership: "主线领导力",
    confirmation: "趋势确认",
    liquidity: "成交参与",
    diffusion: "主线扩散"
  };
  return (
    <div className="review-content">
      {error && <div className="review-inline-warning"><AlertTriangle size={16} />{error}</div>}
      <section className={`review-regime-card tone-${data.regime?.tone || "neutral"}`}>
        <div className="review-score-ring" style={{ "--score": data.score } as any}>
          <strong>{data.score}</strong><span>/100</span>
        </div>
        <div className="review-regime-main">
          <span>{data.session} · {data.date}</span>
          <h2>{data.regime?.name}</h2>
          <p>{data.regime?.posture}</p>
        </div>
        <div className="review-exposure">
          <span>条件仓位区间</span>
          <b>{data.exposure?.min}%–{data.exposure?.max}%</b>
          <small>{data.exposure?.label}</small>
        </div>
      </section>

      <section className="review-dimension-grid">
        {Object.entries(data.dimensions || {}).map(([key, raw]) => {
          const value = number(raw);
          return (
            <div className="review-panel review-dimension" key={key}>
              <span>{dimensionLabels[key] || key}</span>
              <b>{Math.round(value)}</b>
              <i><em style={{ width: `${clamp(value)}%` }} /></i>
              <small>{value >= 70 ? "强" : value >= 55 ? "中性偏强" : value >= 40 ? "中性偏弱" : "弱"}</small>
            </div>
          );
        })}
      </section>

      <section className="review-two-column">
        <div className="review-panel">
          <ReviewTitle icon={Activity} title="市场广度与情绪" subtitle="先看赚钱效应，再看指数涨跌" />
          <div className="review-breadth">
            <div>
              <span>上涨 <b className="review-up">{data.market.available ? data.market.upCount : "--"}</b></span>
              <span>平盘 <b>{data.market.available ? data.market.flatCount : "--"}</b></span>
              <span>下跌 <b className="review-down">{data.market.available ? data.market.downCount : "--"}</b></span>
            </div>
            <i>
              <em className="up" style={{ width: `${data.market.available ? data.market.breadth * 100 : 50}%` }} />
              <em className="flat" style={{ width: `${data.market.available && data.market.stockCount ? data.market.flatCount / data.market.stockCount * 100 : 0}%` }} />
            </i>
            <small>
              {data.market.available
                ? `上涨广度 ${(data.market.breadth * 100).toFixed(1)}% · 全市场代理涨幅 ${pct(data.market.averageReturn)}`
                : "涨跌家数接口暂时降级 · 广度维度按中性处理"}
            </small>
          </div>
          <div className="review-metric-grid">
            <ReviewMetric label="涨停" value={data.ecology.limitUpCount} tone="up" />
            <ReviewMetric label="跌停" value={data.ecology.limitDownCount} tone="down" />
            <ReviewMetric label="炸板" value={data.ecology.failedBoards} tone="warn" />
            <ReviewMetric label="晋级率" value={`${fmt(data.ecology.promotionRate * 100)}%`} />
            <ReviewMetric label="最高板" value={`${data.ecology.maxHeight}板`} tone="up" />
            <ReviewMetric label="首板/连板" value={`${data.ecology.firstBoards}/${data.ecology.continuationBoards}`} />
          </div>
        </div>
        <div className="review-panel">
          <ReviewTitle icon={Gauge} title="复盘结论的证据链" subtitle={data.methodology?.description} />
          <div className="review-evidence-list">
            {(data.evidence || []).map((item: string, index: number) => (
              <div key={item}><span>{index + 1}</span><p>{item}</p></div>
            ))}
          </div>
          <div className="review-risk-box">
            <b><ShieldAlert size={16} /> 风险检查</b>
            {(data.riskSignals || []).map((item: string) => <p key={item}>{item}</p>)}
          </div>
        </div>
      </section>

      <section className="review-panel">
        <ReviewTitle icon={TrendingUp} title="核心指数结构" subtitle="1/3/5日收益、均线位置与量能同步比较" />
        <div className="review-index-table">
          <div className="review-index-row head">
            <span>指数</span><span>1日</span><span>3日</span><span>5日</span><span>MA结构</span><span>量能</span><span>评分</span>
          </div>
          {(data.indices || []).map((item: any) => (
            <div className="review-index-row" key={item.code}>
              <span><b>{item.name}</b><small>{item.date}</small></span>
              <span className={item.returns.r1 >= 0 ? "review-up" : "review-down"}>{pct(item.returns.r1)}</span>
              <span className={item.returns.r3 >= 0 ? "review-up" : "review-down"}>{pct(item.returns.r3)}</span>
              <span className={item.returns.r5 >= 0 ? "review-up" : "review-down"}>{pct(item.returns.r5)}</span>
              <span><b>{item.trend}</b><small>MA5 {fmt(item.ma5, 0)} / MA20 {fmt(item.ma20, 0)}</small></span>
              <span>{fmt(item.volumeRatio, 2)}x</span>
              <span><strong>{item.score}</strong></span>
            </div>
          ))}
        </div>
      </section>

      <section className="review-panel">
        <ReviewTitle icon={Layers3} title="主线板块复盘" subtitle="板块强度、涨停扩散、相对市场和梯队持续性综合排序" />
        <div className="review-sector-table">
          <div className="review-sector-row head">
            <span>排名/板块</span><span>结论</span><span>涨停</span><span>1/3/5日</span><span>上涨广度</span><span>成交热度</span><span>强度</span>
          </div>
          {(data.focusSectors || []).map((item: any) => (
            <div className="review-sector-row" key={`${item.name}-${item.reviewRank}`}>
              <span><b>#{item.reviewRank} {item.name}</b><small>{item.state || "板块跟踪"}</small></span>
              <span><em>{item.verdict}</em></span>
              <span>{item.poolLimitUps ?? item.limitUps ?? 0}只</span>
              <span>{fmt(item.returns?.r1)} / {fmt(item.returns?.r3)} / {fmt(item.returns?.r5)}</span>
              <span>{fmt(number(item.breadth) * 100, 0)}%</span>
              <span>{fmt(item.amountHeat, 2)}x</span>
              <span><strong>{Math.round(number(item.score))}</strong></span>
            </div>
          ))}
        </div>
      </section>

      <section className="review-panel">
        <ReviewTitle icon={Sparkles} title="涨停核心梯队" subtitle="点击股票直接进入该股专业复盘" />
        <div className="review-leader-grid">
          {(data.leaders || []).map((item: any) => (
            <button key={item.code} onClick={() => onOpenStock(item)}>
              <span>{item.consecutiveBoards > 1 ? `${item.consecutiveBoards}连板` : "首板"}</span>
              <b>{item.name}</b>
              <small>{item.code} · {item.industry || "未分类"}</small>
              <em>{item.reason}<ChevronRight size={14} /></em>
            </button>
          ))}
          {!data.leaders?.length && <p className="review-empty-inline">当前无可展示的涨停梯队。</p>}
        </div>
      </section>

      <section className="review-scenario-grid">
        {(data.scenarios || []).map((scenario: any) => (
          <div className={`review-panel review-scenario tone-${scenario.tone}`} key={scenario.id}>
            <span>{scenario.name}</span>
            <ul>{scenario.conditions.map((item: string) => <li key={item}>{item}</li>)}</ul>
            <b>应对</b><p>{scenario.action}</p>
            <small>失效条件：{scenario.invalidation}</small>
          </div>
        ))}
      </section>

      <section className="review-two-column">
        <div className="review-panel">
          <ReviewTitle icon={ClipboardCheck} title="次日执行清单" subtitle="只在条件满足时行动" />
          <ReviewPlanGroup title="重点" items={data.nextPlan?.focus || []} tone="up" />
          <ReviewPlanGroup title="观察" items={data.nextPlan?.observe || []} tone="warn" />
          <ReviewPlanGroup title="回避" items={data.nextPlan?.avoid || []} tone="down" />
        </div>
        <ReviewJournal
          title="记录你的主观判断"
          note={note}
          onNote={onNote}
          onSave={onSave}
          placeholder="例如：今天指数上涨但广度没有同步，主线仍集中在机器人；明天只观察核心分歧承接，不做后排补涨。"
        />
      </section>
      <footer className="review-method-note">
        <span>{data.methodology?.name}</span>
        <p>{data.methodology?.note}</p>
        <small>数据源：{(data.sources || []).join(" · ")} · 生成时间 {dateTime(data.generatedAt)}</small>
      </footer>
    </div>
  );
}

function StockReview({
  query,
  onQuery,
  suggestions,
  searching,
  onSubmit,
  onSelect,
  loading,
  error,
  data,
  note,
  onNote,
  onSave,
  onBack
}: any) {
  return (
    <div className="review-content">
      <div className="review-stock-toolbar">
        {data && <button className="review-back" onClick={onBack}><ArrowLeft size={16} />返回市场复盘</button>}
        <form onSubmit={onSubmit}>
          <Search size={18} />
          <input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索 A股、ETF、可转债（代码或名称）" />
          {query && <button type="button" onClick={() => onQuery("")}><X size={15} /></button>}
          <button type="submit">{searching ? <LoaderCircle className="review-spin" size={17} /> : "开始复盘"}</button>
          {suggestions.length > 0 && (
            <div className="review-suggestions">
              {suggestions.map((item: Security) => (
                <button type="button" key={item.secid || item.code} onClick={() => onSelect(item)}>
                  <span><b>{item.name}</b><small>{item.code}</small></span><em>{item.marketName}</em>
                </button>
              ))}
            </div>
          )}
        </form>
      </div>
      {loading && <ReviewLoading text="正在读取行情、板块、公告与历史策略证据…" />}
      {error && !loading && <ReviewError text={error} />}
      {!loading && !error && !data && (
        <div className="review-panel review-stock-empty">
          <Target size={36} />
          <h2>选择 A股、ETF 或可转债开始专业复盘</h2>
          <p>ETF 与可转债仅在主动搜索时显示；默认涨停池、观察池和连板池仍只保留非 ST A 股。</p>
        </div>
      )}
      {!loading && data && (
        <>
          <section className="review-stock-hero">
            <div>
              <span>{data.analysis?.assetLabel || data.quote?.industry || "A股"} · {data.analysis?.isSearchOnlyAsset ? "搜索专属行情" : data.analysis?.exactNode || data.analysis?.nextNode || "结构复盘"}</span>
              <h2>{data.quote?.name || data.security?.name}<small>{data.security?.code}</small></h2>
              <p>{data.verdict} · {data.analysis?.trendLabel || "趋势待确认"}</p>
            </div>
            <div className="review-stock-price">
              <span>最新价</span><b>{fmt(data.quote?.latest, 2)}</b>
              <em className={number(data.quote?.changePct) >= 0 ? "review-up" : "review-down"}>{pct(data.quote?.changePct)}</em>
            </div>
            <div className="review-stock-grade"><strong>{data.score}</strong><span>{data.grade}级</span></div>
          </section>

          <section className="review-panel review-factor-overview">
            <div className="review-factor-overview-copy">
              <span><Sparkles size={16} /> INTELLIGENT FACTOR REVIEW</span>
              <b>{data.factorEngine.total} 因子专业复盘</b>
              <p>{data.factorEngine.note}</p>
            </div>
            <div className="review-factor-overview-metrics">
              <div><span>诊断加权分</span><b>{data.factorEngine.weightedScore}</b></div>
              <div><span>数据覆盖</span><b>{data.factorEngine.available}/{data.factorEngine.total}</b><small>{data.factorEngine.coverage}%</small></div>
              <div className="strong"><span>强项</span><b>{data.factorEngine.strong}</b></div>
              <div className="risk"><span>风险项</span><b>{data.factorEngine.risk}</b></div>
              <div className="certainty"><span>证据确定性</span><b>{data.certainty?.score ?? "--"}</b><small>{data.certainty?.label || "待复核"}</small></div>
            </div>
            <div className={`review-provider-state ${data.factorEngine.thsActive ? "active" : ""}`}>
              <span>{data.factorEngine.thsActive ? <CheckCircle2 size={15} /> : <Gauge size={15} />}</span>
              <div><b>{data.factorEngine.providerLabel}</b><small>行情、财务、资金、分钟指标与问财数据均按实际可用性降级，不伪造缺失值</small></div>
            </div>
          </section>

          {data.legacyDetailUnavailable && (
            <div className="review-inline-warning">
              <AlertTriangle size={16} />
              这是旧版复盘档案，未保存原始日线与新版详细证据；多周期诊断、关键价位和三情景不作事后回填。
            </div>
          )}

          {!data.legacyDetailUnavailable && (
            <>
            <section className="review-panel review-stock-diagnostics">
            <ReviewTitle
              icon={BarChart3}
              title="多周期走势与波动复核"
              subtitle="全部指标由当前返回的真实日线计算；历史不足时显示为待补，不用 0 代替"
            />
            <div className="review-diagnostic-grid">
              <ReviewMetric label="1日涨跌" value={pct(data.diagnostics.return1)} tone={changeTone(data.diagnostics.return1)} />
              <ReviewMetric label="3日涨跌" value={pct(data.diagnostics.return3)} tone={changeTone(data.diagnostics.return3)} />
              <ReviewMetric label="5日涨跌" value={pct(data.diagnostics.return5)} tone={changeTone(data.diagnostics.return5)} />
              <ReviewMetric label="10日涨跌" value={pct(data.diagnostics.return10)} tone={changeTone(data.diagnostics.return10)} />
              <ReviewMetric label="ATR14" value={unit(data.diagnostics.atrPercent, 2, "%")} />
              <ReviewMetric label="近3日振幅" value={unit(data.diagnostics.recentAmplitude, 2, "%")} />
              <ReviewMetric label="波动收敛比" value={unit(data.diagnostics.compressionRatio, 2, "x")} />
              <ReviewMetric label="20日位置" value={unit(data.diagnostics.rangePosition20, 0, "%")} />
              <ReviewMetric
                label={data.diagnostics.maxDrawdownLabel || "最大回撤"}
                value={unit(data.diagnostics.maxDrawdown, 2, "%")}
                tone="down"
              />
              <ReviewMetric label="收盘位置" value={unit(data.diagnostics.closePosition, 0, "%")} />
              <ReviewMetric label="量能倍数" value={unit(data.diagnostics.volumeRatio, 2, "x")} />
              <ReviewMetric label="相对换手" value={unit(data.diagnostics.relativeTurnover, 2, "x")} />
            </div>
          </section>

          <section className="review-two-column review-detail-map">
            <div className="review-panel">
              <ReviewTitle icon={Target} title="关键价位地图" subtitle="确认、成本、支撑与失效边界分开呈现" />
              <div className="review-key-level-grid">
                {data.keyLevels.map((item: any) => (
                  <div className={item.tone || ""} key={item.id}>
                    <span>{item.label}</span>
                    <b>{number(item.value) > 0 ? fmt(item.value, 2) : "--"}</b>
                    <small>{item.source}</small>
                  </div>
                ))}
              </div>
              <div className={`review-range-map ${nullableNumber(data.diagnostics.rangePosition20) === null ? "pending" : ""}`}>
                <span>20日区间</span>
                <div>
                  {nullableNumber(data.diagnostics.rangePosition20) !== null && (
                    <i style={{ width: `${clamp(data.diagnostics.rangePosition20)}%` }} />
                  )}
                </div>
                <small>
                  {fmt(data.diagnostics.low20, 2)} · 当前 {fmt(data.quote?.latest, 2)} · {fmt(data.diagnostics.high20, 2)}
                </small>
              </div>
            </div>
            <div className="review-panel review-checklist-panel">
              <ReviewTitle icon={ClipboardCheck} title="复核清单" subtitle="已确认、风险与待补证据不混在一起" />
              <div className="review-checklist-columns">
                <div className="confirmed">
                  <b>已确认 {data.factorLeaders.strong.length}</b>
                  {data.checklist.confirmed.map((item: string) => <p key={item}>{item}</p>)}
                  {!data.checklist.confirmed.length && <p>暂无达到强项阈值的因子</p>}
                </div>
                <div className="risks">
                  <b>未通过/风险 {data.factorLeaders.risk.length}</b>
                  {data.checklist.risks.map((item: string) => <p key={item}>{item}</p>)}
                  {!data.checklist.risks.length && <p>当前无未通过因子</p>}
                </div>
                <div className="pending">
                  <b>待补 {data.factorLeaders.pending.length}</b>
                  {data.checklist.pending.map((item: string) => <p key={item}>{item}</p>)}
                  {!data.checklist.pending.length && <p>当前因子覆盖完整</p>}
                </div>
              </div>
            </div>
          </section>

          <section className="review-panel review-scenario-panel">
            <ReviewTitle icon={Sparkles} title="次日三情景推演" subtitle="每个情景均给出触发条件、观察动作与失效标准" />
            <div className="review-scenario-grid">
              {data.scenarios.map((scenario: any) => (
                <article className={scenario.id} key={scenario.id}>
                  <header><b>{scenario.name}</b><span>{scenario.probability}</span></header>
                  <div><span>触发</span><p>{scenario.condition}</p></div>
                  <div><span>复核动作</span><p>{scenario.action}</p></div>
                  <div><span>失效</span><p>{scenario.invalidation}</p></div>
                </article>
              ))}
            </div>
            <small className="review-scenario-note">情景推演用于盘后研究和条件复核，不构成收益承诺或自动交易指令。</small>
          </section>
            </>
          )}

          {FACTOR_GROUPS.map((group) => {
            const groupFactors = group.factors
              .map((id) => data.factors.find((item: any) => item.id === id))
              .filter(Boolean);
            return (
              <section className="review-factor-group" key={group.id}>
                <header className="review-factor-group-title">
                  <div><i /><b>{group.label}</b><span>{group.description}</span></div>
                  <span>{groupFactors.filter((item: any) => item.available).length}/{groupFactors.length} 可用</span>
                </header>
                <div className="review-factor-grid">
                  {groupFactors.map((item: any) => (
                    <div className={`review-panel review-factor ${item.status}`} key={item.id}>
                      <div className="review-factor-head">
                        <span>
                          {!item.available
                            ? <Gauge size={16} />
                            : item.passed
                              ? <CheckCircle2 size={16} />
                              : <AlertTriangle size={16} />}
                          {item.name}
                        </span>
                        <em>{item.available ? item.source : "待增强"}</em>
                      </div>
                      <b>{item.available ? Math.round(item.score) : "--"}<small>{item.available ? "/100" : ""}</small></b>
                      <i><em style={{ width: `${clamp(item.score)}%` }} /></i>
                      <p>{item.detail}</p>
                      <footer>
                        <span>权重 {item.weight}%</span>
                        <span>{!item.available ? "不计入" : item.status === "strong" ? "强" : item.status === "risk" ? "风险" : "中性"}</span>
                      </footer>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}

          <section className="review-two-column">
            <div className="review-panel">
              <ReviewTitle icon={Activity} title="事实证据" subtitle="结论必须能追溯到行情与结构" />
              <div className="review-evidence-list">
                {data.evidence.map((item: string, index: number) => (
                  <div key={item}><span>{index + 1}</span><p>{item}</p></div>
                ))}
              </div>
              <div className="review-stock-metrics">
                <ReviewMetric label="成交额" value={money(data.quote?.amount)} />
                <ReviewMetric label="换手率" value={unit(data.quote?.turnover, 1, "%")} />
                <ReviewMetric label="量比" value={unit(data.quote?.volumeRatio, 2, "x")} />
                <ReviewMetric label="振幅" value={unit(data.quote?.amplitude, 1, "%")} />
              </div>
            </div>
            <div className="review-panel review-trade-plan">
              <ReviewTitle icon={Target} title="条件交易预案" subtitle={`系统信号：${tradeSignalLabel(data.plan.signal)}`} />
              <div className="review-plan-price-grid">
                <ReviewMetric label="确认价" value={fmt(data.plan.trigger, 2)} tone="up" />
                <ReviewMetric label="失效价" value={fmt(data.plan.stop, 2)} tone="down" />
                <ReviewMetric label="目标参考" value={fmt(data.plan.target, 2)} />
                <ReviewMetric label="风险收益比" value={`${fmt(data.plan.riskReward, 2)}x`} />
              </div>
              <b>结构失效条件</b>
              <ul>{data.plan.invalidations.map((item: string) => <li key={item}>{item}</li>)}</ul>
              <small>确认价和目标价只用于条件预案，必须结合实时流动性与市场状态再次检查。</small>
            </div>
          </section>

          <section className="review-two-column">
            <div className="review-panel">
              <ReviewTitle icon={ShieldAlert} title="风险与反证" subtitle="先寻找自己可能错在哪里" />
              <div className="review-counter-evidence">
                {data.risks.length
                  ? data.risks.map((item: string) => <p key={item}><TrendingDown size={15} />{item}</p>)
                  : <p className="safe"><CheckCircle2 size={15} />当前模型未发现硬否决；这不代表没有风险。</p>}
                <p><AlertTriangle size={15} />如果板块强度退潮，即使个股暂时抗跌也要降低预期。</p>
                <p><AlertTriangle size={15} />若放量跌破锚定均价，说明涨停后的平均持仓成本开始松动。</p>
              </div>
            </div>
            <ReviewJournal
              title="填写个股复盘"
              note={note}
              onNote={onNote}
              onSave={onSave}
              placeholder="写下原计划、实际走势、自己的执行偏差，以及下一次遇到相同结构要如何处理。"
            />
          </section>
          <footer className="review-method-note">
            <span>个股 {data.factorEngine.total} 因子复盘</span>
            <p>在结构、量价、板块、市场、历史、流动性、执行与风险否决之外，新增关键数据完整度、多源行情一致性、独立证据共振和失效边界清晰度。确定性分只表示证据可靠程度，不等同于未来收益概率。</p>
            <small>最后更新 {dateTime(data.updatedAt)}</small>
          </footer>
        </>
      )}
    </div>
  );
}

function ArchiveView({ records, onOpen, onExport }: any) {
  return (
    <div className="review-content">
      <section className="review-panel review-archive-head">
        <div><span>REVIEW JOURNAL</span><h2>复盘档案</h2><p>保留当时看到的数据与判断，防止事后用结果改写记忆。</p></div>
        <button onClick={onExport} disabled={!records.length}><Download size={16} />导出全部复盘</button>
      </section>
      {records.length ? (
        <section className="review-archive-list">
          {records.map((record: ReviewRecord) => (
            <button key={record.id} className="review-panel" onClick={() => onOpen(record)}>
              <span className={`type ${record.type}`}>{record.type === "market" ? "市场" : "个股"}</span>
              <div><b>{record.title}</b><small>{dateTime(record.createdAt)}</small></div>
              <p>{record.note || "本次复盘未填写主观备注。"}</p>
              <em>{record.verdict}</em>
              <strong>{record.score}</strong>
              <ChevronRight size={17} />
            </button>
          ))}
        </section>
      ) : (
        <div className="review-panel review-stock-empty">
          <Archive size={36} /><h2>还没有复盘档案</h2><p>在市场或个股复盘页填写笔记并保存后，会在这里形成时间序列记录。</p>
        </div>
      )}
    </div>
  );
}

function ReviewTitle({ icon: Icon, title, subtitle }: any) {
  return <div className="review-title"><Icon size={18} /><div><b>{title}</b><small>{subtitle}</small></div></div>;
}

function ReviewMetric({ label, value, tone = "" }: any) {
  return <div className={`review-metric ${tone}`}><span>{label}</span><b>{value}</b></div>;
}

function ReviewPlanGroup({ title, items, tone }: any) {
  return (
    <div className={`review-plan-group ${tone}`}>
      <b>{title}</b>
      <div>{items.map((item: string) => <p key={item}>{item}</p>)}</div>
    </div>
  );
}

function ReviewJournal({ title, note, onNote, onSave, placeholder }: any) {
  return (
    <div className="review-panel review-journal">
      <ReviewTitle icon={ClipboardCheck} title={title} subtitle="记录当时的判断，而不是事后解释" />
      <textarea value={note} onChange={(event) => onNote(event.target.value)} placeholder={placeholder} />
      <button onClick={onSave}><Save size={16} />保存本次复盘</button>
    </div>
  );
}

function ReviewLoading({ text }: { text: string }) {
  return <div className="review-panel review-loading"><LoaderCircle className="review-spin" size={27} /><b>正在生成专业复盘</b><p>{text}</p></div>;
}

function ReviewError({ text }: { text: string }) {
  return <div className="review-panel review-error"><AlertTriangle size={27} /><b>复盘生成失败</b><p>{text}</p></div>;
}
