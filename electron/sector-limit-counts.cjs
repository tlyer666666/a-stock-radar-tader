'use strict';
const { createServiceRuntime, semanticKey } = require('./service-runtime.cjs');
const { BoundedCache } = require('./bounded-cache.cjs');
const { createTradingCalendar, shanghaiClock, validDate } = require('./trend-trading-calendar.cjs');

const MEMBER_TTL = 4 * 60 * 60 * 1000;
const POOL_TTL = 60 * 1000;
const SOURCE = 'sector-members∩limit-up-pool';

function normalizeInput(input) {
  if (!input || !['industry', 'concept'].includes(input.boardType)) throw new TypeError('板块类型必须为 industry 或 concept');
  const boardType = input.boardType;
  const code = String(input.code ?? '').trim(), indexCode = String(input.indexCode ?? '').trim();
  const conceptCid = String(input.conceptCid ?? '').trim();
  if (boardType === 'industry') {
    if (!/^881\d{3}$/.test(indexCode || code) || (code && !/^881\d{3}$/.test(code)) ||
      (indexCode && !/^881\d{3}$/.test(indexCode)) || (code && indexCode && code !== indexCode) || conceptCid) {
      throw new TypeError('行业板块代码无效');
    }
  } else {
    if (!/^[1-9]\d{4,8}$/.test(conceptCid)) throw new TypeError('概念板块缺少有效 conceptCid');
    if ((indexCode && !/^88[56]\d{3}$/.test(indexCode)) ||
      (code && code !== conceptCid && !/^88[56]\d{3}$/.test(code)) ||
      (code && code !== conceptCid && indexCode && code !== indexCode)) throw new TypeError('概念板块代码无效');
  }
  const memberCount = Number.isSafeInteger(input.memberCount) && input.memberCount >= 0 ? input.memberCount : null;
  return { boardType, code, indexCode, conceptCid, name: String(input.name ?? '').trim().slice(0, 200), memberCount };
}

function normalizeDate(value) {
  const text = String(value ?? '');
  const date = /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}` : text;
  return validDate(date) ? date : null;
}

function stockRows(rows) {
  if (!Array.isArray(rows)) throw new Error('股票名单缺失');
  const stocks = new Map(); let valid = true;
  for (const row of rows) {
    const code = String(row?.code ?? '').trim();
    if (!/^(?:00\d{4}|30\d{4}|60\d{4}|68\d{4}|[48]\d{5}|92\d{4})$/.test(code)) { valid = false; continue; }
    if (!stocks.has(code)) stocks.set(code, { code, name: String(row?.name ?? '').trim() });
  }
  return { stocks: [...stocks.values()], valid };
}

function createSectorLimitCounts({ loadMembers, loadPool, now = Date.now } = {}) {
  if (typeof loadMembers !== 'function' || typeof loadPool !== 'function') throw new TypeError('需要板块成分和实时涨停池加载器');
  const runtime = createServiceRuntime({ now, jobOptions: { maxActive: 2, maxQueued: 40 } });
  const membersCache = new BoundedCache({ maxEntries: 256, maxBytes: 8 * 1024 * 1024, now });
  const poolCache = new BoundedCache({ maxEntries: 2, maxBytes: 2 * 1024 * 1024, now });
  const calendar = createTradingCalendar();
  let generation = 0;

  function count(input, options = {}) {
    let sector;
    try { sector = normalizeInput(input); } catch (error) { return Promise.reject(error); }
    const date = shanghaiClock(now()).date;
    const expectedDate = calendar.previousSession(date, true);
    const epoch = generation;
    const memberKey = `${epoch}:${date}:${sector.boardType}:${sector.boardType === 'concept' ? sector.conceptCid : sector.indexCode || sector.code}`;
    const forceRefresh = options.forceRefresh === true;
    const current = () => epoch === generation && shanghaiClock(now()).date === date;
    const matchesDate = value => normalizeDate(value) === expectedDate && expectedDate !== null;
    return runtime.run('single', semanticKey({ memberKey, memberCount: sector.memberCount, forceRefresh }), options, async () => {
      const unknown = (warning, pool, members) => ({
        limitUps: null, limitUpStocks: [], memberCount: sector.memberCount ?? (members?.complete ? members.stocks.length : null),
        countComplete: false, asOfDate: normalizeDate(pool?.asOfDate), fetchedAt: pool?.fetchedAt ?? new Date(now()).toISOString(), source: SOURCE, warning
      });
      let members, pool;
      try {
        // Sequential loading keeps underlying I/O within the two admitted jobs.
        // Cached loaders use their own producer signal, so cancelling one caller
        // does not cancel another caller's shared membership/pool request.
        members = await runtime.cached(membersCache, memberKey, MEMBER_TTL, async () => {
          const result = await runtime.track(() => loadMembers(sector, { signal: runtime.signal() }));
          const rows = stockRows(result?.members);
          return { ...rows, complete: result.complete === true && rows.valid, asOfDate: result.asOfDate };
        }, { shouldCache: value => current() && value.complete && (sector.memberCount === null || value.stocks.length >= sector.memberCount) && (!value.asOfDate || matchesDate(value.asOfDate)) });
        runtime.checkpoint();
        pool = await runtime.cached(poolCache, `${epoch}:${date}`, POOL_TTL, async () => {
          const result = await runtime.track(() => loadPool({ signal: runtime.signal(), forceRefresh }));
          const rows = stockRows(result?.stocks);
          return { ...rows, complete: result.complete === true && rows.valid, asOfDate: result.asOfDate,
            fetchedAt: result.fetchedAt ?? new Date(now()).toISOString(), stale: result.stale === true };
        }, { forceRefresh, shouldCache: value => current() && value.complete && !value.stale && matchesDate(value.asOfDate) });
        runtime.checkpoint();
      } catch (error) {
        runtime.checkpoint(); // Cancellation must reject, never become an unknown quote.
        return unknown(`涨停家数暂不可用：${error?.message || '数据加载失败'}`, pool, members);
      }
      if (!current() || !matchesDate(pool.asOfDate) || (members.asOfDate && normalizeDate(members.asOfDate) !== normalizeDate(pool.asOfDate))) {
        return unknown('板块成分与涨停池日期不一致，暂不能确认涨停家数', pool, members);
      }
      if (!pool.complete || pool.stale) return unknown('实时涨停池不完整或已过期，暂不能确认涨停家数', pool, members);
      const codes = new Set(members.stocks.map(stock => stock.code));
      const limitUpStocks = pool.stocks.filter(stock => codes.has(stock.code));
      const countComplete = members.complete && (sector.memberCount === null || members.stocks.length >= sector.memberCount);
      return { limitUps: countComplete || limitUpStocks.length ? limitUpStocks.length : null, limitUpStocks,
        memberCount: sector.memberCount ?? (countComplete ? members.stocks.length : null), countComplete,
        asOfDate: normalizeDate(pool.asOfDate), fetchedAt: pool.fetchedAt, source: SOURCE,
        warning: countComplete ? '' : limitUpStocks.length ? '板块成分未完整取得，涨停家数为已确认下限' : '板块成分未完整取得，暂不能确认涨停家数' };
    });
  }
  function clear() { generation++; membersCache.clear(); poolCache.clear(); }
  return { count, clear,
    shutdown: async reason => { await runtime.shutdown(reason); clear(); },
    getDiagnostics: () => ({ ...runtime.getDiagnostics(), members: membersCache.getDiagnostics(), pool: poolCache.getDiagnostics() }) };
}

module.exports = { createSectorLimitCounts };
