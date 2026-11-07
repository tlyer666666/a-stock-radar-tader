"use strict";

/**
 * 个股 → 同花顺行业 的本机索引。
 * 同花顺涨停池、炸板池不带行业字段，这里用同花顺行业板块（约 90 个二级行业）的完整成分股反查。
 * - 行业名单：同花顺行业资金流（data.10jqka，含 881xxx 板块代码）；
 * - 成分股：同花顺扶摇接口（完整成分）；未配置扶摇时不建索引，交给调用方的其他补充来源。
 * 结果保存在本机（主进程注入 store），每天最多重建一次；重建失败时继续用上一次的结果。
 */
const { createServiceRuntime } = require("./service-runtime.cjs");
const { producerContext } = require("./service-context.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;
const UNCLASSIFIED = "未分类";

const knownIndustry = value => {
  const text = String(value ?? "").trim();
  return text && text !== UNCLASSIFIED && text !== "--" ? text : "";
};

function validIndex(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Number.isFinite(Number(value.builtAt)) && value.industries !== null && typeof value.industries === "object";
}

function createStockIndustryIndex({ listIndustries, loadMembers, store = null, now = () => Date.now(), maxAgeMs = DAY_MS, concurrency = 3,
  minIndustries = 40, minStocks = 2000 } = {}) {
  let state = null;
  try { const stored = store?.read?.(); if (validIndex(stored)) state = stored; } catch { state = null; }
  const runtime = createServiceRuntime({ jobOptions: { maxActive: 1, maxQueued: 0 } });
  let lastFailureAt = -Infinity;

  const fresh = () => state && now() - Number(state.builtAt) < maxAgeMs;

  async function build({ signal, track }) {
    const industries = (await track(() => listIndustries({ signal, track })) || [])
      .map(row => ({ code: String(row?.code || ""), name: knownIndustry(row?.name) }))
      .filter(row => /^\d{6}$/.test(row.code) && row.name);
    signal.throwIfAborted();
    if (!industries.length) throw new Error("同花顺行业名单为空");
    const map = {};
    let ok = 0, cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, industries.length) }, async () => {
      while (cursor < industries.length) {
        signal?.throwIfAborted?.();
        const industry = industries[cursor++];
        try {
          const members = await track(() => loadMembers(`${industry.code}.TI`, { signal, track }));
          signal.throwIfAborted();
          const codes = Array.isArray(members) ? members.map(member => String(member?.code || "")).filter(code => /^\d{6}$/.test(code)) : [];
          if (!codes.length) continue;
          ok += 1;
          for (const code of codes) if (!map[code]) map[code] = industry.name;
        } catch (error) {
          if (signal?.aborted) throw error;
        }
      }
    }));
    signal.throwIfAborted();
    const stocks = Object.keys(map).length;
    if (ok !== industries.length || ok < minIndustries || stocks < minStocks) throw new Error(`同花顺行业成分不完整（${ok}/${industries.length} 个行业、${stocks} 只股票）`);
    const next = { builtAt: now(), source: "同花顺行业板块成分（扶摇）", industryCount: ok, industries: map };
    state = next;
    try { store?.write?.(next); } catch { /* 本机保存失败不影响本次使用 */ }
    return next;
  }

  /** 需要时重建（同一时间只建一次；失败后 30 分钟内不重试）。返回当前可用的索引（可能为 null）。 */
  function ensure({ signal } = {}) {
    try {
      runtime.signal(signal).throwIfAborted();
      if (fresh()) return Promise.resolve(state);
      if (now() - lastFailureAt < 30 * 60 * 1000) return Promise.resolve(state);
      const parent = producerContext.getStore();
      const subscription = runtime.run("scan", "industry-index", { signal }, async ctx => {
        try { return await build({ signal: ctx.signal, track: factory => ctx.track(factory) }); }
        catch (error) {
          ctx.throwIfAborted();
          lastFailureAt = now();
          return state;
        }
      });
      if (parent) parent.track(subscription);
      return subscription;
    } catch (error) { return Promise.reject(error); }
  }

  function lookup(code) {
    return state?.industries?.[String(code || "")] || "";
  }

  return { ensure, lookup, shutdown: reason => runtime.shutdown(reason), status: () => state ? { builtAt: state.builtAt, source: state.source, stocks: Object.keys(state.industries).length } : null };
}

module.exports = { createStockIndustryIndex, knownIndustry, UNCLASSIFIED };
