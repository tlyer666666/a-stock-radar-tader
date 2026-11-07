"use strict";

/**
 * 行情来源健康度与熔断。
 *
 * 目的：任一路（同花顺免费网关 / 东方财富 / 腾讯）被限流或断网时，不再让每次 5 秒
 * 一轮的报价轮询都先在这条坏线路上等满超时（东方财富单次 12s × 2 次 ≈ 24s），而是：
 *   · 连续失败 2 次 → 熔断 30 秒；之后每再失败一次时长翻倍，最长 4 分钟；
 *   · 熔断期间跳过该路，直接走下一路；
 *   · 熔断到期后放行一次「试探」请求，成功即恢复；
 *   · 所有线路都在熔断时仍按顺序尝试（宁可慢，也不因熔断而无数据）。
 *
 * 同时记录每一路的最近成功/失败时间、耗时与原因，供界面「数据源状态」使用。
 */

const SOURCES = Object.freeze({
  fuyao: { name: "同花顺扶摇行情", kind: "同花顺官方数据接口 · API Key" },
  fuyao_history: { name: "同花顺扶摇日线", kind: "同花顺官方数据接口 · API Key" },
  ths_free: { name: "同花顺免费行情", kind: "同花顺官方网页行情 · 免费" },
  eastmoney: { name: "东方财富行情", kind: "免费公开行情" },
  tencent: { name: "腾讯行情", kind: "免费公开行情" },
  ths_free_history: { name: "同花顺免费日线", kind: "同花顺官方网页行情 · 免费" },
  ths_free_time: { name: "同花顺实时分时", kind: "同花顺官方网页行情 · 免费" },
  eastmoney_history: { name: "东方财富日线", kind: "免费公开行情" },
  tencent_history: { name: "腾讯日线", kind: "免费公开行情" }
});

/**
 * 只有「线路本身」的故障才计入熔断：超时、断网、HTTP 错误、响应不是预期格式（多为反爬页面）、
 * 盘中陈旧。某只股票本身没有数据（停牌、退市、代码不存在）不代表线路坏了，不能因此把整条线路熔断。
 */
function isProviderFault(error) {
  if (!error || ["JOB_CANCELLED", "JOB_TIMEOUT", "JOB_SHUTDOWN", "SERVICE_BUSY", "QUEUE_TIMEOUT", "QUEUE_FULL"].includes(error.code)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "SyntaxError" || error instanceof SyntaxError) return true;
  if (Number(error.status) > 0) return true;
  const code = String(error.code || error.cause?.code || "");
  if (/^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR|THS_FREE_STALE|THS_TIMEOUT|THS_HTTP|FUYAO_NETWORK|FUYAO_RATE_LIMITED|FUYAO_STALE|FUYAO_AUTH|FUYAO_FORBIDDEN|RESPONSE_TOO_LARGE|QUEUE_)/.test(code)) return true;
  const message = String(error.message || error);
  if (/fetch failed|network|socket|timeout|超时|JSONP|非JSON|HTTP \d{3}|备用通道失败/i.test(message)) return true;
  return false;
}

const BASE_OPEN_MS = 30 * 1000;
const MAX_OPEN_MS = 4 * 60 * 1000;
const FAILURES_TO_OPEN = 2;

function createMarketSourceHealth({ now = () => Date.now() } = {}) {
  const states = new Map();

  function state(id) {
    let current = states.get(id);
    if (!current) {
      current = { id, failures: 0, openUntil: 0, lastOkAt: 0, lastFailAt: 0, lastError: "", lastLatencyMs: null, successCount: 0, failureCount: 0 };
      states.set(id, current);
    }
    return current;
  }

  function isOpen(id) {
    return state(id).openUntil > now();
  }

  function recordSuccess(id, latencyMs = null) {
    const current = state(id);
    current.failures = 0;
    current.openUntil = 0;
    current.lastOkAt = now();
    current.successCount += 1;
    if (Number.isFinite(latencyMs)) current.lastLatencyMs = Math.round(latencyMs);
  }

  function recordFailure(id, error, latencyMs = null, signal) {
    if (signal?.aborted) return;
    const current = state(id);
    if (Number.isFinite(latencyMs)) current.lastLatencyMs = Math.round(latencyMs);
    if (!isProviderFault(error)) {
      // 个股数据缺失：线路是通的，不计入连续失败，也不改变线路状态。
      current.lastDataIssue = String(error?.message || error || "").slice(0, 160);
      return;
    }
    current.failures += 1;
    current.failureCount += 1;
    current.lastFailAt = now();
    current.lastError = String(error?.message || error || "未知错误").slice(0, 160);
    if (current.failures >= FAILURES_TO_OPEN) {
      const exponent = Math.min(4, current.failures - FAILURES_TO_OPEN);
      current.openUntil = now() + Math.min(MAX_OPEN_MS, BASE_OPEN_MS * (2 ** exponent));
    }
  }

  /**
   * 依次尝试各路，跳过熔断中的线路；全部熔断时退回按原顺序逐一尝试。
   * steps: [{ id, run: () => Promise<value> }]；shouldStop(error) 为真时立即抛出（应用退出/调用方取消）。
   * 返回 { value, id, attempts: [{ id, ok, error, skipped }] }；全部失败时抛出带 attempts 的错误。
   */
  async function runChain(steps, { shouldStop = () => false, signal } = {}) {
    signal?.throwIfAborted();
    const usable = steps.filter(Boolean);
    const attempts = [];
    const tryStep = async (step) => {
      const startedAt = now();
      try {
        signal?.throwIfAborted();
        const value = await step.run();
        signal?.throwIfAborted();
        recordSuccess(step.id, now() - startedAt);
        attempts.push({ id: step.id, ok: true });
        return { value, id: step.id, attempts };
      } catch (error) {
        // 单次请求超时在 http-client 里表现为 TimeoutError（ETIMEDOUT），只有调用方明确
        // 处于退出/取消状态（shouldStop）时才中止整条链，否则按本路失败处理并接力。
        signal?.throwIfAborted();
        if (shouldStop(error)) throw error;
        recordFailure(step.id, error, now() - startedAt);
        attempts.push({ id: step.id, ok: false, error: String(error?.message || error) });
        return null;
      }
    };
    const closed = usable.filter((step) => !isOpen(step.id));
    for (const step of usable) if (isOpen(step.id)) attempts.push({ id: step.id, ok: false, skipped: true, error: "熔断中，暂时跳过" });
    for (const step of closed) {
      const result = await tryStep(step);
      if (result) return result;
    }
    if (!closed.length) {
      for (const step of usable) {
        const result = await tryStep(step);
        if (result) return result;
      }
    }
    const summary = attempts.filter((item) => !item.ok && !item.skipped).map((item) => `${SOURCES[item.id]?.name || item.id}：${item.error}`).join("；");
    const error = new Error(`行情来源均不可用${summary ? `（${summary}）` : ""}`);
    error.attempts = attempts;
    throw error;
  }

  function snapshot(ids = Object.keys(SOURCES)) {
    const at = now();
    return ids.map((id) => {
      const current = state(id);
      const open = current.openUntil > at;
      const status = open
        ? "open"
        : current.lastOkAt === 0 && current.lastFailAt === 0
          ? "idle"
          : current.lastFailAt > current.lastOkAt
            ? "degraded"
            : "ok";
      return {
        id,
        name: SOURCES[id]?.name || id,
        kind: SOURCES[id]?.kind || "",
        status,
        consecutiveFailures: current.failures,
        retryAt: open ? new Date(current.openUntil).toISOString() : null,
        lastOkAt: current.lastOkAt ? new Date(current.lastOkAt).toISOString() : null,
        lastFailAt: current.lastFailAt ? new Date(current.lastFailAt).toISOString() : null,
        lastError: current.lastFailAt > current.lastOkAt ? current.lastError : "",
        lastLatencyMs: current.lastLatencyMs,
        successCount: current.successCount,
        failureCount: current.failureCount
      };
    });
  }

  function reset() { states.clear(); }

  return { isOpen, recordSuccess, recordFailure, runChain, snapshot, reset };
}

module.exports = { SOURCES, BASE_OPEN_MS, MAX_OPEN_MS, FAILURES_TO_OPEN, isProviderFault, createMarketSourceHealth };
