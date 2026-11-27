"use strict";

/**
 * 涨停封单实时推送（涨停监控的涨停池 + 从涨停监控点开的个股页）。
 *
 * - 数据：封单数字以同花顺涨停池为准（见 ths-seal-source.cjs，同花顺约每 1~10 秒更新一次），
 *   个股页的五档盘口用腾讯实时五档（同花顺免费盘口有约 1 分钟缓存）。封单 = 涨停价上的买一量（手），
 *   封单额 = 封单手数 × 100 × 涨停价。交易所 Level-1 快照每 3 秒一次，数据一变就推给页面。
 * - 状态：封死（涨停价买一、卖盘为空）/ 涨停有抛压（涨停价上还有卖单）/ 炸板（今天摸过涨停、现在打开）/
 *   跌停封死 / 未涨停。
 * - 变化：记录当天封单额走势（只在变化时记一个点，最多 historyMax 个），算峰值、较峰值回落和 1 分钟增减，
 *   封单快速减少往往是炸板前兆。
 * - 订阅：按 owner（如 "pool"、"detail"）分别租约，页面每 10 秒续一次，30 秒没续自动退订；
 *   没有任何订阅时不发请求。连续 30 秒行情没变（收盘、午休）就放慢到每 5 秒一次。
 * 取不到的数一律 null，不当 0。
 */

const POLL_MS = 1000;
const IDLE_POLL_MS = 5000;
const IDLE_AFTER_MS = 30_000;
const EPS = 0.0005;

const finite = value => typeof value === "number" && Number.isFinite(value);
const STATUS_LABEL = Object.freeze({ sealed: "封死涨停", contested: "涨停有抛压", broken: "炸板", downSealed: "跌停封死", open: "未涨停" });

/** 由一条带五档的行情算封单状态。纯函数。 */
function computeSeal(quote) {
  const latest = finite(quote?.latest) ? quote.latest : null;
  const limitUp = finite(quote?.limitUp) && quote.limitUp > 0 ? quote.limitUp : null;
  const limitDown = finite(quote?.limitDown) && quote.limitDown > 0 ? quote.limitDown : null;
  const bids = Array.isArray(quote?.bids) ? quote.bids : [];
  const asks = Array.isArray(quote?.asks) ? quote.asks : [];
  const bid1 = bids[0] || null;
  const ask1 = asks[0] || null;
  const atUp = latest !== null && limitUp !== null && latest >= limitUp - EPS;
  const atDown = latest !== null && limitDown !== null && latest <= limitDown + EPS;
  const bidAtUp = bid1 && limitUp !== null && Math.abs(bid1.price - limitUp) < EPS;
  const askAtDown = ask1 && limitDown !== null && Math.abs(ask1.price - limitDown) < EPS;
  let status = "open";
  let sealLots = null;
  let sealPrice = null;
  // 同花顺涨停池里的票但没给封单量：按「封死」记、封单未知（null），不能因为盘口为空就说成「涨停有抛压」。
  if (atUp && quote?.sealUnknown === true && !bid1 && !ask1) { status = "sealed"; sealLots = null; sealPrice = limitUp; }
  else if (atUp && bidAtUp && !ask1) { status = "sealed"; sealLots = bid1.volumeLots; sealPrice = limitUp; }
  else if (atUp) { status = "contested"; sealLots = bidAtUp ? bid1.volumeLots : null; sealPrice = limitUp; }
  else if (quote?.brokenHint === true || (limitUp !== null && finite(quote?.high) && quote.high >= limitUp - EPS)) status = "broken";
  else if (atDown && askAtDown && !bid1) { status = "downSealed"; sealLots = ask1.volumeLots; sealPrice = limitDown; }
  // 同花顺涨停池给出的封单手数优先（和同花顺 App 一致）；盘口只用来判断是否封死。
  if ((status === "sealed" || status === "contested") && finite(quote?.thsSealLots) && quote.thsSealLots > 0) sealLots = quote.thsSealLots;
  const sealAmount = sealLots !== null && sealPrice !== null ? sealLots * 100 * sealPrice : null;
  const floatCap = finite(quote?.floatMarketCap) && quote.floatMarketCap > 0 ? quote.floatMarketCap : null;
  return {
    status,
    statusLabel: STATUS_LABEL[status],
    sealLots,
    sealAmount,
    sealFloatRatio: sealAmount !== null && floatCap !== null ? sealAmount / floatCap : null
  };
}

function createLimitSealStream({
  readSeals = null,
  readBatch = null,
  emit = () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = handle => clearTimeout(handle),
  pollMs = POLL_MS,
  idlePollMs = IDLE_POLL_MS,
  leaseMs = 30_000,
  maxCodes = 300,
  historyMax = 400,
  // 是否在交易时段：盘外封单不会变，每 offSessionPollMs 取一次就够。
  inSession = () => true,
  isTradingDate = null,
  offSessionPollMs = 30_000,
  log = () => {}
} = {}) {
  if (typeof readSeals !== "function" && typeof readBatch !== "function") throw new TypeError("readSeals or readBatch is required");
  // readSeals({ codes, detailCodes }) 是同花顺优先的数据源；readBatch(securities) 是只给代码的批量五档（测试与兜底）。
  const read = typeof readSeals === "function"
    ? (codes, detailCodes, signal) => readSeals({ codes, detailCodes }, { signal })
    : (codes, _detailCodes, signal) => readBatch(codes.map(code => ({ code })), { signal });
  const owners = new Map();     // owner → { codes: Set, leaseUntil }
  const records = new Map();    // code → 最新封单记录
  const histories = new Map();  // code → [{ t, amount, status, date }]
  const peaks = new Map();      // code → { date, amount }（不随 historyMax 头部裁剪丢失峰值）
  const maxTracked = Math.max(maxCodes * 3, 1000);
  let controller = null;
  let wakeSleep = null;
  let lastChangeAt = 0;
  let stopped = false;

  const cnDate = ms => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
  const safeInSession = () => {
    try { return Boolean(inSession()); }
    catch (error) { log(`limit-seal inSession ${error?.message || error}`); return false; }
  };
  const isTradingToday = ms => {
    const today = cnDate(ms);
    if (typeof isTradingDate === "function") {
      try { return isTradingDate(today) !== false; }
      catch (error) { log(`limit-seal isTradingDate ${error?.message || error}`); }
    }
    return ![0, 6].includes(new Date(ms + 8 * 3600_000).getUTCDay());
  };
  // pollOnce() 与 snapshot() 共用同一套日期策略：
  // 交易日只接受当天记录（拒绝盘前残留的昨日涨停）；休市日（周末/节假日）一致允许最近交易日记录，避免回访个股面板永久空白。
  const acceptRecordDate = (quoteDate, ms = now()) => {
    if (!quoteDate) return true;
    const today = cnDate(ms);
    if (isTradingToday(ms)) return quoteDate === today;
    return quoteDate <= today;
  };

  function activeCodes() {
    const at = now();
    for (const [owner, entry] of owners) if (entry.leaseUntil <= at) owners.delete(owner);
    const codes = new Set();
    // 个股页（detail）的代码排在前面：涨停池满 300 只时也不会把正在看的那只挤掉。
    const ordered = [...owners.entries()].sort(([a], [b]) => Number(b.startsWith("detail")) - Number(a.startsWith("detail")));
    for (const [, entry] of ordered) for (const code of entry.codes) { if (codes.size < maxCodes) codes.add(code); }
    return [...codes];
  }

  function pruneInactiveCaches(activeSet) {
    if (records.size <= maxTracked && histories.size <= maxTracked && peaks.size <= maxTracked) return;
    for (const code of records.keys()) {
      if (records.size <= maxTracked) break;
      if (!activeSet.has(code)) { records.delete(code); histories.delete(code); peaks.delete(code); }
    }
    for (const code of histories.keys()) {
      if (histories.size <= maxTracked) break;
      if (!activeSet.has(code)) { histories.delete(code); peaks.delete(code); }
    }
    for (const code of peaks.keys()) {
      if (peaks.size <= maxTracked) break;
      if (!activeSet.has(code)) peaks.delete(code);
    }
  }

  function historyOf(code) { return histories.get(code) || []; }

  function remember(code, record) {
    let history = histories.get(code);
    if (!history || (history.length && history.at(-1).date !== record.quoteDate)) {
      history = [];
      histories.set(code, history);
      peaks.delete(code);
    }
    if (finite(record.sealAmount)) {
      const currentPeak = peaks.get(code);
      if (!currentPeak || currentPeak.date !== record.quoteDate || record.sealAmount > currentPeak.amount) {
        peaks.set(code, { date: record.quoteDate, amount: record.sealAmount });
      }
    }
    const last = history.at(-1);
    if (last && last.amount === record.sealAmount && last.status === record.status) return;
    history.push({ t: Date.parse(record.quoteAt) || now(), amount: record.sealAmount, status: record.status, date: record.quoteDate });
    if (history.length > historyMax) history.splice(0, history.length - historyMax);
  }

  function enrich(code, record, referenceMs = null) {
    const history = historyOf(code);
    const amounts = history.map(point => point.amount).filter(finite);
    const trackedPeak = peaks.get(code);
    const historyPeak = amounts.length ? Math.max(...amounts) : null;
    const peakAmount = trackedPeak && trackedPeak.date === record.quoteDate
      ? (historyPeak === null ? trackedPeak.amount : Math.max(trackedPeak.amount, historyPeak))
      : historyPeak;
    const t = finite(referenceMs) ? referenceMs : (Date.parse(record.quoteAt) || now());
    const ago = [...history].reverse().find(point => point.t <= t - 60_000);
    const change1mAmount = finite(record.sealAmount) && ago && finite(ago.amount) ? record.sealAmount - ago.amount : null;
    return {
      ...record,
      peakAmount,
      fromPeakPct: finite(record.sealAmount) && finite(peakAmount) && peakAmount > 0 ? ((record.sealAmount - peakAmount) / peakAmount) * 100 : null,
      change1mAmount,
      change1mPct: change1mAmount !== null && ago.amount > 0 ? (change1mAmount / ago.amount) * 100 : null
    };
  }

  function toRecord(code, quote) {
    const seal = computeSeal(quote);
    return {
      code, name: String(quote.name || code),
      latest: finite(quote.latest) ? quote.latest : null,
      changePct: finite(quote.changePct) ? quote.changePct : null,
      high: finite(quote.high) ? quote.high : null,
      limitUp: finite(quote.limitUp) ? quote.limitUp : null,
      limitDown: finite(quote.limitDown) ? quote.limitDown : null,
      floatMarketCap: finite(quote.floatMarketCap) ? quote.floatMarketCap : null,
      ...seal,
      bids: Array.isArray(quote.bids) ? quote.bids.slice(0, 5) : [],
      asks: Array.isArray(quote.asks) ? quote.asks.slice(0, 5) : [],
      source: String(quote.source || ""),
      quoteAt: String(quote.quoteAt || ""),
      quoteDate: String(quote.quoteDate || "")
    };
  }

  // 不含行情时间：涨停池一行没有自己的时间戳（取的是请求时刻），封单和价格都没变就不必重推。
  const fingerprint = record => record ? `${record.quoteDate}|${record.source}|${record.latest}|${record.changePct}|${record.status}|${record.sealLots}|${JSON.stringify(record.bids)}|${JSON.stringify(record.asks)}` : "";

  async function pollOnce(signal) {
    if (signal.aborted || controller?.signal !== signal) return false;
    const codes = activeCodes();
    if (!codes.length) return false;
    const detailCodes = [...owners.entries()].filter(([owner]) => owner.startsWith("detail")).flatMap(([, entry]) => [...entry.codes]).filter(code => codes.includes(code));
    const result = await read(codes, [...new Set(detailCodes)], signal);
    if (signal.aborted || controller?.signal !== signal) return false;
    const quotes = result?.quotes instanceof Map ? result.quotes : new Map(Object.entries(result?.quotes || {}));
    const at = now();
    const changed = [];
    for (const code of codes) {
      const quote = quotes.get(code);
      if (!quote) continue;
      const record = toRecord(code, quote);
      if (!acceptRecordDate(record.quoteDate, at)) {
        const stale = records.get(code);
        if (stale && !acceptRecordDate(stale.quoteDate, at)) records.delete(code);
        continue;
      }
      const previous = records.get(code);
      if (fingerprint(record) === fingerprint(previous)) {
        // 封单剧烈变化后如果持续平稳超过 1 分钟，刷新归零过期的「1 分钟变化」，避免旧跌幅告警长驻界面。
        const lastPoint = historyOf(code).at(-1);
        const sampleTime = Date.parse(record.quoteAt) || at;
        if (
          previous &&
          finite(previous.change1mAmount) &&
          previous.change1mAmount !== 0 &&
          lastPoint &&
          sampleTime - lastPoint.t >= 60_000
        ) {
          const refreshed = enrich(code, record, sampleTime);
          if (refreshed.change1mAmount !== previous.change1mAmount || refreshed.change1mPct !== previous.change1mPct) {
            records.set(code, refreshed);
            changed.push({ ...refreshed, point: lastPoint });
          }
        }
        continue;
      }
      remember(code, record);
      const enriched = enrich(code, record);
      records.set(code, enriched);
      changed.push({ ...enriched, point: historyOf(code).at(-1) || null });
    }
    pruneInactiveCaches(new Set(codes));
    if (changed.length && !signal.aborted && controller?.signal === signal) {
      lastChangeAt = now();
      try { emit({ atMs: lastChangeAt, at: new Date(lastChangeAt).toISOString(), items: changed }); } catch { /* 页面不在不影响 */ }
    }
    return true;
  }

  function sleep(wait, signal, wakeIf = null) {
    if (signal.aborted || controller?.signal !== signal) return Promise.resolve();
    const checkWake = () => {
      try { return Boolean(wakeIf()); }
      catch (error) { log(`limit-seal wakeIf ${error?.message || error}`); return false; }
    };
    if (typeof wakeIf === "function" && checkWake()) return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      let timer = null;
      let probe = null;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimer(timer);
        if (probe !== null) clearTimer(probe);
        signal.removeEventListener("abort", done);
        if (wakeSleep === done) wakeSleep = null;
        resolve();
      };
      timer = setTimer(done, wait);
      if (!settled) wakeSleep = done;
      if (!settled && typeof wakeIf === "function") {
        const check = () => {
          probe = null;
          if (settled || signal.aborted || controller?.signal !== signal) { done(); return; }
          if (checkWake()) done();
          else if (!settled) probe = setTimer(check, 1000);
        };
        probe = setTimer(check, 1000);
      }
      if (!settled) signal.addEventListener("abort", done, { once: true });
    });
  }

  async function loop(signal) {
    try {
      while (!signal.aborted && controller?.signal === signal) {
        const started = now();
        let hadCodes = false;
        try { hadCodes = await pollOnce(signal); }
        catch (error) { if (signal.aborted || controller?.signal !== signal) break; log(`limit-seal ${error?.message || error}`); }
        if (signal.aborted || controller?.signal !== signal) break;
        if (!hadCodes && !owners.size) break; // 全部退订：停下，等下一次订阅
        const live = safeInSession();
        const interval = !live ? Math.max(idlePollMs, offSessionPollMs) : now() - lastChangeAt > IDLE_AFTER_MS ? idlePollMs : pollMs;
        const wait = Math.max(50, interval - (now() - started));
        await sleep(wait, signal, live ? null : safeInSession);
      }
    } finally {
      if (controller?.signal === signal) controller = null;
    }
  }

  function snapshot(codes, withHistory) {
    const at = now();
    return codes.map(code => records.get(code)).filter(record => record && acceptRecordDate(record.quoteDate, at)).map(record => withHistory
      ? { ...record, history: historyOf(record.code).map(({ t, amount, status }) => ({ t, amount, status })) }
      : record);
  }

  /**
   * 订阅、续租或退订。
   * @param {{ owner?: string, codes?: string[], active?: boolean, withHistory?: boolean }} input
   */
  function subscribe({ owner = "default", codes = [], active = true, withHistory = false } = {}) {
    const key = String(owner || "default").slice(0, 24);
    if (stopped || !active) {
      owners.delete(key);
      if (!owners.size) wakeSleep?.();
      return { active: false, items: [] };
    }
    const list = [...new Set((Array.isArray(codes) ? codes : []).map(String).filter(code => /^\d{6}$/.test(code)))].slice(0, maxCodes);
    if (!list.length) {
      owners.delete(key);
      if (!owners.size) wakeSleep?.();
      return { active: Boolean(controller && owners.size), items: [] };
    }
    const previousEntry = owners.get(key);
    const hasNewCode = !previousEntry || list.some(code => !previousEntry.codes.has(code));
    owners.set(key, { codes: new Set(list), leaseUntil: now() + leaseMs });
    if (!controller) {
      controller = new AbortController();
      lastChangeAt = now();
      void loop(controller.signal).catch(error => log(`limit-seal loop ${error?.message || error}`));
    } else if (hasNewCode) {
      // 新切个股或新增订阅代码时立即唤醒空闲休眠，避免等待 5 秒。
      lastChangeAt = now();
      wakeSleep?.();
    }
    return { active: Boolean(controller), items: snapshot(list, withHistory) };
  }

  function shutdown() {
    stopped = true;
    owners.clear();
    if (controller) { controller.abort(new Error("shutdown")); controller = null; }
  }

  return { subscribe, shutdown, status: () => ({ active: Boolean(controller), owners: owners.size, codes: activeCodes().length }) };
}

module.exports = { createLimitSealStream, computeSeal, STATUS_LABEL };
