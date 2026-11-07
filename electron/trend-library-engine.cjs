"use strict";

const catalog = require("../config/trend-strategy-library.json");
const { trendMath } = require("./trend-screener-engine.cjs");
const indicators = require("./trend-indicators.cjs");
const { prepareAlignedTrendSeries, maAt, atr14, ceilCents, floorCents } = trendMath;
const finite = value => typeof value === "number" && Number.isFinite(value);
const evidence = (label, passed, value, rule) => ({ label, passed: Boolean(passed), value: String(value), rule });
const format = value => finite(value) ? value.toFixed(6) : "无法计算";
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const entryById = new Map(catalog.map(item => [item.id, item]));

// The facade evaluates the limit-free trend base once (evaluateTrendBase).
// Its candidate establishes the shared universe/trend/liquidity gates; technical
// triggers remain independent of classic A/B entry qualification and of any limit-up.
function prepareTrendLibrary(input, base) {
  if (base.kind !== "candidate") return { result: base };
  const prepared = prepareAlignedTrendSeries(input);
  if (prepared.kind !== "prepared") return { result: prepared };
  const { raw, adjusted, prices, factor, benchmark } = prepared;
  if (!benchmark) return { result: { kind: "unavailable", reason: "缺少基准交易日历，无法核对80日窗口" } };
  const aligned21 = raw.slice(-21).every((row, i) =>
    Math.abs((row.close / adjusted[adjusted.length - 21 + i].close) / factor - 1) <= .002);
  const last = prices.length - 1, today = prices[last], closes = prices.map(row => row.close);
  const ma = Object.fromEntries([5, 10, 20, 60].map(period => [period, indicators.rollingMean(closes, period)]));
  const previousAtr = atr14(prices.slice(0, -1));
  const atrKnown = finite(previousAtr) && previousAtr > 0;
  const extensionAtr = atrKnown ? (today.close - ma[20][last]) / previousAtr : null;
  const start = benchmark.find(row => row.date === prices[last - 20].date);
  const end = benchmark.at(-1);
  const relativeStrength20 = ((today.close / prices[last - 20].close - 1) - (end.close / start.close - 1)) * 100;
  const params = id => entryById.get(id).parameters;
  const m = params("macd-zero-cross-v1"), b = params("boll-squeeze-breakout-v1");
  const d = params("dmi-trend-strength-v1"), k = params("kdj-trend-cross-v1");
  const series = {
    macd: indicators.macd(closes, m.fastPeriod, m.slowPeriod, m.signalPeriod),
    boll: indicators.boll(closes, b.bollPeriod, b.bollMultiplier),
    dmi: indicators.dmi(prices, d.dmiPeriod, d.adxPeriod),
    obv: indicators.obv(prices),
    kdj: indicators.kdj(prices, k.rsvPeriod, k.kPeriod, k.dPeriod),
    rsi: indicators.rsi(closes, params("rsi-midline-recovery-v1").period),
    cci: indicators.cci(prices, params("cci-strength-breakout-v1").period),
    roc: indicators.roc(closes, params("roc-zero-recovery-v1").period),
    emv: indicators.emv(prices, params("emv-zero-recovery-v1").period, params("emv-zero-recovery-v1").volumeDivisor),
    mfi: indicators.mfi(prices, params("mfi-midline-recovery-v1").period),
    donchian: indicators.donchian(prices, params("donchian-55-breakout-v1").channelPeriod), ma,
    // 经典技术策略（v1.5）：海龟20日通道、120日收盘新高。
    turtle: indicators.donchian(prices, params("turtle-20-breakout-v1").channelPeriod),
    priorHighClose: closes.map((_, i) => {
      const lookback = params("new-high-120-v1").highLookback;
      return i >= lookback ? Math.max(...closes.slice(i - lookback, i)) : null;
    })
  };
  return { base, prices, raw, last, today, series, aligned21, previousAtr, atrKnown, extensionAtr,
    relativeStrength20, marketOpen: end.close >= maAt(benchmark, benchmark.length - 1, 60),
    ma60Rising: ma[60][last] >= ma[60][last - 5],
    // 近期涨停且仍有支撑时，涨停日最低价参与止损；没有涨停的股票只用前低减0.5ATR。
    t0Low: base.candidate.limitDate ? prices[raw.findIndex(row => row.date === base.candidate.limitDate)]?.low ?? null : null };
}

function evaluatePreparedTrendLibrary(prepared, strategy) {
  if (prepared.result) return prepared.result;
  const { base, prices, last: n, today, series, aligned21, previousAtr, atrKnown, extensionAtr,
    relativeStrength20, marketOpen, ma60Rising, t0Low } = prepared;
  const config = strategy.config, entry = entryById.get(strategy.id), close = today.close;
  let triggerPrice = close;
  const conditions = [], values = { atr14Previous: previousAtr, extensionAtr, relativeStrength20,
    ma5: series.ma[5][n], ma10: series.ma[10][n], ma20: series.ma[20][n], ma60: series.ma[60][n] };
  const add = (label, passed, value, rule) => conditions.push(evidence(label, passed, value, rule));
  const cross = indicators.crossedAbove;
  switch (strategy.id) {
    case "macd-zero-cross-v1": {
      const { dif, dea, histogram } = series.macd;
      Object.assign(values, { dif: dif[n], dea: dea[n], macdHistogram: histogram[n], difPrevious: dif[n - 1], deaPrevious: dea[n - 1] });
      add("MACD金叉", cross(dif[n - 1], dea[n - 1], dif[n], dea[n]), `${format(dif[n])} / ${format(dea[n])}`, "昨日DIF≤DEA且今日DIF>DEA");
      add("MACD零轴", dif[n] > 0 && dea[n] > 0, `${format(dif[n])} / ${format(dea[n])}`, "今日DIF与DEA均严格大于0");
      break;
    }
    case "boll-squeeze-breakout-v1": {
      const { upper, width } = series.boll;
      const history = width.slice(n - config.squeezeLookback, n);
      const widthMedian = history.length === config.squeezeLookback && history.every(finite) ? median(history) : null;
      triggerPrice = upper[n - 1];
      Object.assign(values, { bollUpperPrevious: triggerPrice, bollWidthPrevious: width[n - 1], bollWidthMedian: widthMedian });
      add("布林收口", finite(widthMedian) && width[n - 1] <= widthMedian, `${format(width[n - 1])} / ${format(widthMedian)}`, "昨日带宽不超过截至昨日60日带宽中位数；总体标准差");
      add("布林突破", finite(triggerPrice) && prices[n - 1].close <= triggerPrice && close > triggerPrice, format(triggerPrice), "昨日收盘≤昨日上轨且今日收盘>昨日上轨");
      break;
    }
    case "dmi-trend-strength-v1": {
      const { pdi, mdi, adx } = series.dmi;
      Object.assign(values, { pdi: pdi[n], mdi: mdi[n], adx: adx[n], pdiPrevious: pdi[n - 1], mdiPrevious: mdi[n - 1], adxPrevious: adx[n - 1] });
      add("方向占优", finite(pdi[n]) && finite(mdi[n]) && pdi[n] > mdi[n], `${format(pdi[n])} / ${format(mdi[n])}`, "PDI严格大于MDI；方向相等时正负DM均为0");
      add("趋势强度", finite(adx[n]) && finite(adx[n - 1]) && adx[n] >= config.adxThreshold && adx[n] > adx[n - 1], `${format(adx[n - 1])} → ${format(adx[n])}`, `ADX至少${config.adxThreshold}且上升；DM/TR滚动14日、DX算术均值6日`);
      add("方向或强度新交叉", cross(pdi[n - 1], mdi[n - 1], pdi[n], mdi[n]) || cross(adx[n - 1], config.adxThreshold, adx[n], config.adxThreshold), format(adx[n]), "今日PDI金叉MDI，或ADX从≤20上穿至>20");
      break;
    }
    case "obv-volume-breakout-v1": {
      const highObv = Math.max(...series.obv.slice(n - config.breakoutPeriod, n));
      triggerPrice = Math.max(...prices.slice(n - config.breakoutPeriod, n).map(row => row.close));
      Object.assign(values, { obv: series.obv[n], obvPreviousHigh: highObv, closePreviousHigh: triggerPrice });
      add("方向量创新高", series.obv[n] > highObv, `${format(series.obv[n])} / ${format(highObv)}`, "OBV严格超过此前20日高点；涨加跌减、平收不变");
      add("收盘创新高", close > triggerPrice, format(triggerPrice), "收盘严格超过此前20日最高收盘；参照窗不含今日");
      break;
    }
    case "kdj-trend-cross-v1": {
      const { k, d, j, rsv } = series.kdj;
      Object.assign(values, { k: k[n], d: d[n], j: j[n], rsv: rsv[n], kPrevious: k[n - 1], dPrevious: d[n - 1] });
      add("随机指标金叉", finite(rsv[n]) && cross(k[n - 1], d[n - 1], k[n], d[n]), `${format(k[n])} / ${format(d[n])}`, "昨日K≤D且今日K>D；九日振幅须大于0");
      add("随机指标温度", finite(k[n]) && k[n] <= config.maxK, format(k[n]), `K不超过${config.maxK}；K/D按50初始化并递推`);
      add("收盘回升", close > prices[n - 1].close, format(close), "今日收盘严格高于昨日收盘");
      break;
    }
    case "ma-pullback-resume-v1": {
      const { ma } = series;
      const touchCount = prices.slice(n - config.pullbackPeriod, n).filter((row, i) =>
        row.low <= ma[config.middlePeriod][n - config.pullbackPeriod + i] && row.close >= ma[config.trendPeriod][n - config.pullbackPeriod + i]).length;
      triggerPrice = prices[n - 1].high;
      Object.assign(values, { pullbackTouchCount: touchCount, previousHigh: triggerPrice });
      add("均线多头排列", ma[config.fastPeriod][n] > ma[config.middlePeriod][n] && ma[config.middlePeriod][n] > ma[config.trendPeriod][n] && ma[config.trendPeriod][n] > ma[config.longPeriod][n], `${format(ma[5][n])} / ${format(ma[10][n])}`, "MA5>MA10>MA20>MA60");
      add("均线回踩承接", touchCount > 0, touchCount, "此前五日至少一日最低价≤该日MA10且收盘≥该日MA20");
      add("回踩后再起", close > triggerPrice && close > ma[config.fastPeriod][n], format(triggerPrice), "今日收盘高于昨日最高价且高于MA5");
      break;
    }
    case "rsi-midline-recovery-v1":
    case "cci-strength-breakout-v1":
    case "roc-zero-recovery-v1":
    case "emv-zero-recovery-v1":
    case "mfi-midline-recovery-v1": {
      const key = strategy.id.split("-")[0], valuesNow = series[key], threshold = config.threshold ?? 0;
      triggerPrice = prices[n - 1].high;
      Object.assign(values, { [key]: valuesNow[n], [`${key}Previous`]: valuesNow[n - 1], previousHigh: triggerPrice });
      add(entry.technicalLabels[0], cross(valuesNow[n - 1], threshold, valuesNow[n], threshold), `${format(valuesNow[n - 1])} → ${format(valuesNow[n])}`, `昨日${key.toUpperCase()}≤${threshold}，今日严格>${threshold}`);
      if (config.maxRsi !== undefined || config.maxMfi !== undefined) {
        const cap = config.maxRsi ?? config.maxMfi;
        add(entry.technicalLabels[1], finite(valuesNow[n]) && valuesNow[n] <= cap, format(valuesNow[n]), `${key.toUpperCase()}不超过${cap}`);
      }
      add("价格确认", close > triggerPrice, format(triggerPrice), "今日收盘严格突破昨日最高价");
      break;
    }
    case "donchian-55-breakout-v1": {
      triggerPrice = series.donchian.upper[n];
      Object.assign(values, { donchianUpper: triggerPrice, donchianUpperPrevious: series.donchian.upper[n - 1], donchianLower: series.donchian.lower[n] });
      add("55日通道突破", finite(triggerPrice) && close > triggerPrice, format(triggerPrice), "收盘严格突破此前55日最高价，参照窗不含今日");
      add("首日突破", finite(series.donchian.upper[n - 1]) && prices[n - 1].close <= series.donchian.upper[n - 1], format(prices[n - 1].close), "昨日收盘未突破昨日对应55日上轨");
      break;
    }
    case "ma-golden-cross-v1": {
      const fast = series.ma[config.fastPeriod], slow = series.ma[config.slowPeriod];
      Object.assign(values, { maFastPrevious: fast[n - 1], maSlowPrevious: slow[n - 1], maSlowEarlier: slow[n - config.slopeSessions] });
      add("MA5上穿MA20", cross(fast[n - 1], slow[n - 1], fast[n], slow[n]), `${format(fast[n])} / ${format(slow[n])}`, "昨日MA5≤MA20且今日MA5>MA20");
      add("MA20向上", finite(slow[n - config.slopeSessions]) && slow[n] > slow[n - config.slopeSessions], `${format(slow[n - config.slopeSessions])} → ${format(slow[n])}`, `MA20严格高于${config.slopeSessions}个交易日前`);
      add("站上MA20", close > slow[n], format(close), "今日收盘严格高于MA20");
      break;
    }
    case "turtle-20-breakout-v1": {
      triggerPrice = series.turtle.upper[n];
      Object.assign(values, { turtleUpper: triggerPrice, turtleUpperPrevious: series.turtle.upper[n - 1], turtleLower: series.turtle.lower[n] });
      add("20日通道突破", finite(triggerPrice) && close > triggerPrice, format(triggerPrice), "收盘严格突破此前20日最高价，参照窗不含今日");
      add("首日突破", finite(series.turtle.upper[n - 1]) && prices[n - 1].close <= series.turtle.upper[n - 1], format(prices[n - 1].close), "昨日收盘未突破昨日对应20日上轨");
      break;
    }
    case "new-high-120-v1": {
      triggerPrice = series.priorHighClose[n];
      const previousHigh = series.priorHighClose[n - 1];
      Object.assign(values, { priorHighClose: triggerPrice, priorHighClosePrevious: previousHigh });
      add("半年收盘新高", finite(triggerPrice) && close > triggerPrice, format(triggerPrice), `收盘严格高于此前${config.highLookback}个交易日最高收盘，参照窗不含今日`);
      add("首日新高", finite(previousHigh) && prices[n - 1].close <= previousHigh, format(prices[n - 1].close), "昨日收盘未创出对应的半年新高");
      break;
    }
    case "ma-bull-alignment-v1": {
      const { ma } = series;
      const aligned = i => [ma[config.fastPeriod][i], ma[config.middlePeriod][i], ma[config.trendPeriod][i], ma[config.longPeriod][i]].every(finite) &&
        ma[config.fastPeriod][i] > ma[config.middlePeriod][i] && ma[config.middlePeriod][i] > ma[config.trendPeriod][i] && ma[config.trendPeriod][i] > ma[config.longPeriod][i];
      add("多头排列首日", aligned(n) && !aligned(n - 1), `${format(ma[5][n])} / ${format(ma[10][n])} / ${format(ma[20][n])} / ${format(ma[60][n])}`, "今日MA5>MA10>MA20>MA60，昨日尚未同时满足");
      add("MA20向上", finite(ma[config.trendPeriod][n - config.slopeSessions]) && ma[config.trendPeriod][n] > ma[config.trendPeriod][n - config.slopeSessions], format(ma[20][n]), `MA20严格高于${config.slopeSessions}个交易日前`);
      break;
    }
    default: throw new TypeError("未知策略库ID");
  }
  const priorLow = Math.min(...prices.slice(n - config.stopLookback, n).map(row => row.low));
  const stop = ceilCents(finite(t0Low) ? Math.max(t0Low, priorLow - .5 * previousAtr) : priorLow - .5 * previousAtr);
  const stopDistanceAtr = atrKnown ? (close - stop) / previousAtr : null;
  const entryType = entry.entryType;
  const minEntry = entryType === "close-confirmation" ? ceilCents(stop + .01)
    : finite(triggerPrice) ? ceilCents(Math.max(triggerPrice + .01, stop + .01)) : null;
  const maxEntry = floorCents(Math.min(1.03 * close, stop / .92, close + config.entryAtrAllowance * previousAtr));
  const entryValid = finite(minEntry) && finite(maxEntry) && stop < minEntry && minEntry <= maxEntry;
  const deviation = (close / series.ma[20][n] - 1) * 100;
  const common = [
    evidence("交易日历", true, "80日一致", "最近80个市场交易日与个股日期严格对齐；原始/复权共用250日窗口"),
    evidence("21日复权口径", aligned21, aligned21 ? "一致" : "变化", "最近21根原始/复权价格因子相对变化不超过0.2%"),
    evidence("MA60方向", ma60Rising, format(series.ma[60][n]), "MA60不低于五个交易日前"),
    evidence("相对强度", relativeStrength20 > 0, format(relativeStrength20), "未舍入20日超额涨幅严格大于0"),
    evidence("昨日波动", atrKnown, format(previousAtr), "ATR14仅使用截至昨日的14个TR，且严格大于0"),
    evidence("当日振幅", today.high > today.low, format(today.high - today.low), "当日最高价严格大于最低价"),
    evidence("偏离MA20", deviation <= 10 && atrKnown && extensionAtr <= config.maxExtensionAtr, `${format(deviation)}% / ${format(extensionAtr)}ATR`, "收盘距MA20不超过10%且不超过3倍昨日ATR"),
    evidence("止损波动距离", atrKnown && stopDistanceAtr >= config.minStopAtr, format(stopDistanceAtr), "收盘至冻结止损至少0.5倍昨日ATR"),
    evidence("独立入场区间", entryValid, entryValid ? `${minEntry.toFixed(2)}–${maxEntry.toFixed(2)}` : "无有效区间", entryType === "close-confirmation" ? "收盘确认：S<P≤Pmax；最低入场为止损+0.01，允许平开或低于信号收盘，最多1.03C、S/0.92和C+0.5昨日ATR的较低值" : "结构突破：S<入场下限≤入场上限；突破位+0.01，最多1.03C、S/0.92和C+0.5昨日ATR的较低值"),
    evidence("市场门槛", marketOpen, marketOpen ? "通过" : "暂停", "中证全指收盘不低于MA60")
  ];
  const signal = [...conditions, ...common].every(row => row.passed);
  const plan = signal ? { entryType, stop, minEntry, maxEntry,
    maxRiskPercent: Number(((maxEntry - stop) / maxEntry * 100).toFixed(2)),
    holdingDays: "目标持有10–30个交易日；收盘跌破止损或连续两日低于MA20则下一可交易日退出，第30日开盘离场" } : null;
  Object.assign(values, { stopDistanceAtr });
  return { kind: "candidate", reason: `${entry.name}${signal ? "信号" : "观察"}`, candidate: {
    ...base.candidate, strategy, patterns: [], primaryPattern: null, stage: signal ? "signal" : "watch", plan,
    setup: { id: strategy.id, label: entry.name, triggerPrice: finite(triggerPrice) ? triggerPrice : close,
      stopBasis: finite(t0Low) ? "近期涨停日最低价与此前五日最低价减0.5倍昨日ATR14的较高者，向上取分" : "此前五日最低价减0.5倍昨日ATR14，向上取分" },
    technical: { indicators: Object.fromEntries(Object.entries(values).filter(([, value]) => finite(value))) },
    metrics: { ...base.candidate.metrics, relativeStrength20 },
    evidence: [...base.candidate.evidence.filter(row => ["收盘涨停", "近期涨停", "趋势", "成交额"].includes(row.label)), ...common, ...conditions],
    warnings: [...base.candidate.warnings, "公开指标的独立适配规则；固定参数与排序未经收益验证，不代表官方推荐"]
  } };
}

module.exports = { prepareTrendLibrary, evaluatePreparedTrendLibrary };
