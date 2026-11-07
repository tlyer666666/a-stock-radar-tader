'use strict';
const { BoundedCache } = require('./bounded-cache.cjs');

const ORIGINS = ['https://push2.eastmoney.com/api/qt', 'https://push2delay.eastmoney.com/api/qt'];
const numberOrNull = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 北京时间的日期（YYYY-MM-DD）。 */
const shanghaiDate = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);

/**
 * 板块成分的「主力净流入」，同一个请求顺带取实时行情（最新价、涨跌幅、成交额、换手、昨收）。
 * 同花顺成分页在集合竞价和开盘前后显示的还是上一交易日的成交额/换手，所以行情以这里为准：
 * 东方财富返回的更新时间是今天时，用它覆盖成分页的数值，并标注行情时间。
 */
function createSectorFundFlowSource({ fetchJson, runtime, identify, now = Date.now }) {
  const cache = new BoundedCache({ maxEntries: 128, maxBytes: 1024 * 1024, now });
  async function batch(securities, forceRefresh) {
    const key = securities.map(item => item.secid).join(',');
    return runtime.cached(cache, key, 60000, async () => {
      const requested = new Set(securities.map(item => item.secid));
      const callerSignal = runtime.signal();
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(6000)]);
      let lastError;
      for (let index = 0; index < ORIGINS.length; index++) {
        try {
          signal.throwIfAborted();
          const query = new URLSearchParams({ fltt: '2', fields: 'f2,f3,f5,f6,f8,f12,f13,f15,f16,f17,f18,f62,f124', secids: key });
          const json = await fetchJson(`${ORIGINS[index]}/ulist.np/get?${query}`, { signal }, 2500);
          if (json?.rc && json.rc !== 0) throw new Error('资金源返回错误状态');
          if (!Array.isArray(json?.data?.diff)) throw new Error('资金源未返回有效个股记录');
          const rows = new Map(), conflicts = new Set();
          const checkedAt = new Date(now()).toISOString();
          for (const raw of json.data.diff) {
            if (!raw || !/^[01]$/.test(String(raw.f13)) || !/^\d{6}$/.test(String(raw.f12))) continue;
            const secid = `${raw.f13}.${raw.f12}`;
            if (!requested.has(secid) || conflicts.has(secid)) continue;
            const amount = numberOrNull(raw.f62);
            const latest = numberOrNull(raw.f2);
            if (amount === null && latest === null) continue;
            const epoch = numberOrNull(raw.f124);
            const asOf = epoch !== null && epoch > 0 && epoch * 1000 <= now() + 60000
              ? new Date(epoch * 1000).toISOString() : null;
            const previous = rows.get(secid);
            if (previous && (previous.mainNetInflow !== amount || previous.fundFlowAsOf !== asOf)) {
              rows.delete(secid); conflicts.add(secid); continue;
            }
            const source = index === 0 ? '东方财富' : '东方财富延迟节点';
            rows.set(secid, { ...(amount === null ? {} : { mainNetInflow: amount, fundFlowAsOf: asOf, fundFlowCheckedAt: checkedAt, fundFlowSource: source, fundFlowStatus: 'ready' }),
              ...(latest !== null && latest > 0 ? { quote: { latest, changePct: numberOrNull(raw.f3), amount: numberOrNull(raw.f6), turnover: numberOrNull(raw.f8),
                preClose: numberOrNull(raw.f18), high: numberOrNull(raw.f15), low: numberOrNull(raw.f16), open: numberOrNull(raw.f17), asOf, source } } : {}) });
          }
          return { rows: [...rows.entries()], checkedAt };
        } catch (error) {
          callerSignal.throwIfAborted();
          if (['QUEUE_FULL', 'QUEUE_TIMEOUT', 'RESPONSE_TOO_LARGE'].includes(error?.code)) throw error;
          lastError = error;
        }
      }
      throw lastError || new Error('个股资金源暂不可用');
    }, { forceRefresh, shouldCache: value => value.rows.length > 0 });
  }

  async function load(members = [], options = {}) {
    runtime.signal(options.signal).throwIfAborted();
    const inputs = (Array.isArray(members) ? members : []).filter(member => member && typeof member === 'object' && !Array.isArray(member));
    const identities = new Map();
    for (const member of inputs) {
      try {
        const security = identify(member);
        if (security.assetType && security.assetType !== 'stock') continue;
        if (identities.size < 1000) identities.set(security.secid, security);
      } catch { /* Unsupported or inconsistent identities never reach the provider. */ }
    }
    const securities = [...identities.values()].sort((a, b) => a.secid.localeCompare(b.secid));
    const chunks = [];
    for (let index = 0; index < securities.length; index += 100) chunks.push(securities.slice(index, index + 100));
    const values = new Map();
    let cursor = 0, failed = false;
    const startedAt = now();
    await Promise.all(Array.from({ length: Math.min(2, chunks.length) }, async () => {
      while (cursor < chunks.length && !failed && now() - startedAt < 8000) {
        runtime.signal(options.signal).throwIfAborted();
        const chunk = chunks[cursor++];
        try {
          const result = await batch(chunk, options.forceRefresh === true);
          for (const [secid, value] of result.rows) values.set(secid, value);
        } catch {
          runtime.signal(options.signal).throwIfAborted();
          failed = true;
        }
      }
    }));
    runtime.signal(options.signal).throwIfAborted();
    const checkedAt = new Date(now()).toISOString();
    const rows = inputs.map(member => {
      let identity;
      try { identity = identify(member); } catch { /* Preserve the original row without requesting an unsafe identifier. */ }
      const value = identity ? values.get(identity.secid) : null;
      const { quote, ...flow } = value || {};
      // 行情时间是今天才覆盖（东方财富在开盘前也可能返回上一交易日的数）。
      const live = quote && quote.asOf && shanghaiDate(Date.parse(quote.asOf)) === shanghaiDate(now())
        ? { latest: quote.latest, ...(quote.changePct !== null ? { changePct: quote.changePct } : {}), ...(quote.amount !== null ? { amount: quote.amount } : {}),
          ...(quote.turnover !== null ? { turnover: quote.turnover } : {}), ...(quote.preClose !== null ? { preClose: quote.preClose } : {}),
          ...(quote.high !== null ? { high: quote.high } : {}), ...(quote.low !== null ? { low: quote.low } : {}), ...(quote.open !== null ? { open: quote.open } : {}),
          quoteAsOf: quote.asOf, quoteSource: quote.source, quoteStatus: 'live' }
        : {};
      const existing = numberOrNull(member.mainNetInflow);
      if (flow.fundFlowStatus) return { ...member, ...flow, ...live };
      return { ...member, ...live, mainNetInflow: existing, fundFlowStatus: existing === null ? 'unavailable' : 'unconfirmed' };
    });
    const loaded = rows.filter(row => row.mainNetInflow !== null).length;
    const liveRows = rows.filter(row => row.quoteStatus === 'live');
    const quoteTimes = liveRows.map(row => row.quoteAsOf).filter(Boolean).sort();
    const dates = rows.map(row => row.fundFlowAsOf).filter(Boolean).sort();
    const sources = [...new Set(rows.map(row => row.fundFlowSource).filter(Boolean))];
    return { rows, fundFlow: { source: sources.join(' + ') || '东方财富', metric: '主力净流入', unit: 'CNY',
      loaded, total: rows.length, status: loaded === 0 ? 'unavailable' : loaded === rows.length ? 'ready' : 'partial',
      asOf: dates.at(-1) || null, checkedAt, cacheSeconds: 60,
      quotes: { source: [...new Set(liveRows.map(row => row.quoteSource))].join(' + ') || '东方财富', loaded: liveRows.length, total: rows.length, asOf: quoteTimes.at(-1) || null } } };
  }
  return { load, getDiagnostics: () => cache.getDiagnostics() };
}
module.exports = { createSectorFundFlowSource };
