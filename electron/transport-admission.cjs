'use strict';

function queueError(code, message) { return Object.assign(new Error(message), { code }); }

// Origin eligibility and the physical limit are decided together. A cooling
// origin never holds a physical lease or blocks another eligible origin.
function createTransportAdmission({ maxConcurrent = 8, maxPending = 256, now = Date.now } = {}) {
  const pending = [];
  const lastStarts = new Map();
  const stats = { active: 0, pending: 0, peakActive: 0, peakPending: 0, admitted: 0, completed: 0,
    rejected: 0, queuedCancelled: 0, queueTimeouts: 0 };
  let wakeTimer;

  function remove(job) {
    const index = pending.indexOf(job);
    if (index < 0) return false;
    pending.splice(index, 1);
    stats.pending = pending.length;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    return true;
  }

  function rejectQueued(job, error, kind) {
    if (!remove(job)) return;
    stats.rejected++;
    if (kind) stats[kind]++;
    job.reject(error);
    pump();
  }

  function pump() {
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
    while (stats.active < maxConcurrent && pending.length) {
      const current = now();
      let earliest = Infinity;
      const index = pending.findIndex(job => {
        const eligibleAt = (lastStarts.get(job.origin) ?? -Infinity) + job.minimumGapMs;
        earliest = Math.min(earliest, eligibleAt);
        return eligibleAt <= current;
      });
      if (index < 0) {
        wakeTimer = setTimeout(pump, Math.max(1, Math.min(2147483647, earliest - current)));
        break;
      }
      const job = pending[index];
      remove(job);
      lastStarts.set(job.origin, current);
      // Entries older than the largest allowed gap cannot affect a future
      // request. This avoids retaining every origin seen in a long session.
      if (lastStarts.size > 64) {
        for (const [origin, startedAt] of lastStarts) {
          if (current - startedAt > 60000) lastStarts.delete(origin);
        }
      }
      stats.active++;
      stats.admitted++;
      stats.peakActive = Math.max(stats.peakActive, stats.active);
      let released = false;
      job.resolve(() => {
        if (released) return;
        released = true;
        stats.active--;
        stats.completed++;
        pump();
      });
    }
  }

  return {
    acquire(url, { minimumGapMs = 0, signal, queueTimeoutMs = 30000 } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('请求已取消', 'AbortError'));
      let origin;
      try { origin = new URL(String(url)).origin; } catch (error) { return Promise.reject(error); }
      if (pending.length >= maxPending) {
        stats.rejected++;
        return Promise.reject(queueError('QUEUE_FULL', '行情请求队列已满，请稍后重试'));
      }
      return new Promise((resolve, reject) => {
        const job = { origin, resolve, reject, signal,
          minimumGapMs: Math.max(0, Math.min(60000, Number(minimumGapMs) || 0)) };
        job.abort = () => rejectQueued(job, signal.reason ?? new DOMException('请求已取消', 'AbortError'), 'queuedCancelled');
        job.timer = setTimeout(() => rejectQueued(job,
          queueError('QUEUE_TIMEOUT', '行情请求排队超时，请稍后重试'), 'queueTimeouts'),
        Math.max(1, Math.min(60000, Number(queueTimeoutMs) || 30000)));
        signal?.addEventListener('abort', job.abort, { once: true });
        pending.push(job);
        stats.pending = pending.length;
        stats.peakPending = Math.max(stats.peakPending, stats.pending);
        pump();
      });
    },
    getDiagnostics() { return { ...stats }; }
  };
}

module.exports = { createTransportAdmission };
