'use strict';
const { createJobLifecycle } = require('./job-lifecycle.cjs');
const { producerContext } = require('./service-context.cjs');
const { BoundedCache } = require('./bounded-cache.cjs');
const { createHash } = require('node:crypto');

function semanticKey(value) {
  const normalize = input => Array.isArray(input) ? input.map(normalize)
    : input && typeof input === 'object'
      ? Object.fromEntries(Object.keys(input).sort().filter(key => !['requestId', 'signal', 'timeoutMs'].includes(key)).map(key => [key, normalize(input[key])]))
      : input;
  return createHash('sha256').update(JSON.stringify(normalize(value)) ?? 'null').digest('hex');
}
function createServiceRuntime({ controller = new AbortController(), jobOptions = {}, cacheJobOptions = {}, now = () => Date.now() } = {}) {
  const jobs = createJobLifecycle(jobOptions);
  const cacheJobs = createJobLifecycle({ maxActive: 256, maxQueued: 0, maxSubscribers: 2048, ...cacheJobOptions });
  const records = new WeakSet(), objectAdapters = new WeakMap();
  let sequence = 0;
  function checkpoint() { controller.signal.throwIfAborted(); producerContext.getStore()?.throwIfAborted(); }
  function signal(extra) {
    const signals = [...new Set([controller.signal, producerContext.getStore()?.signal, extra].filter(Boolean))];
    return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  }
  function track(factory) { checkpoint(); const ctx = producerContext.getStore(); return ctx ? ctx.track(factory) : (typeof factory === 'function' ? factory() : factory); }
  function run(operation, key, request = {}, producer) {
    const id = String(request.requestId || `local:${++sequence}`);
    const result = jobs.subscribe({ operation, key, owner: request.owner ?? 'local', requestId: id,
      signal: signal(request.signal), timeoutMs: request.timeoutMs }, ctx => producerContext.run(ctx, () => producer(ctx)));
    return result;
  }
  function cached(cache, key, ttlMs, loader, options = {}) {
    try {
      checkpoint();
      const parent = producerContext.getStore();
      const previous = cache.get(key);
      const forceRefresh = options === true || options.forceRefresh === true;
      if (!forceRefresh && previous && Object.hasOwn(previous, 'value') && previous.expiresAt > now()) return Promise.resolve(previous.value);
      let record = previous?.promise;
      if (!record || !records.has(record) || record.signal?.aborted || (forceRefresh && !record.forceRefresh)) {
        record = { id: `cache:${++sequence}`, forceRefresh, started: false };
        records.add(record);
        const settled = previous ? Object.fromEntries(Object.entries(previous).filter(([name]) => !['promise','forceRefresh','promiseForceRefresh'].includes(name))) : null;
        record.restore = () => {
          if (cache.get(key)?.promise !== record) return;
          if (settled && Object.hasOwn(settled, 'value')) cache.set(key, settled); else cache.delete(key);
        };
        record.producer = ctx => producerContext.run(ctx, async () => {
          record.started = true;
          try {
            ctx.throwIfAborted();
            const value = await ctx.track(loader);
            ctx.throwIfAborted();
            if (cache.get(key)?.promise === record && (!options.shouldCache || options.shouldCache(value))) {
              const expiresAt = now() + Math.max(0, Number(typeof ttlMs === 'function' ? ttlMs(value) : ttlMs) || 0);
              cache.set(key, { value, expiresAt, ...(options.staleTtlMs ? { staleUntil: now() + options.staleTtlMs } : {}) });
            }
            return value;
          } finally { record.restore(); }
        });
        cache.set(key, { ...settled, promise: record, forceRefresh, expiresAt: previous?.expiresAt || 0 });
      }
      const subscription = cacheJobs.subscribe({ operation: 'cache', key: record.id, owner: 'cache-subscriber',
        requestId: `sub:${++sequence}`, signal: signal() }, record.producer);
      // A cancelled producer may still be physically draining. Its record can
      // no longer be shared, including when cancellation happened while queued.
      // An independent replacement must not reuse the old loader/restore guard.
      if (subscription.producerSignal) record.signal = subscription.producerSignal;
      else if (!record.started) record.restore();
      // Keep admission-failed pending placeholders out of the cache too.
      subscription.drained.then(() => { if (!record.started) record.restore(); });
      if (parent) parent.track(subscription);
      return subscription;
    } catch (error) { return Promise.reject(error); }
  }
  function cachedObject(object, ttlMs, loader, options = {}) {
    let adapter = objectAdapters.get(object);
    if (!adapter) {
      const budget = new BoundedCache({ maxEntries: 1, maxBytes: options.maxBytes || 2 * 1024 * 1024, now });
      const reset = () => {
        for (const key of Object.keys(object)) delete object[key];
        Object.assign(object, { value: null, expiresAt: 0, promise: null, promiseForceRefresh: false });
      };
      adapter = { get: () => object, set: (_, value) => {
        budget.set('value', value);
        const retained = budget.get('value');
        reset();
        if (retained) Object.assign(object, retained);
      }, delete: () => { budget.clear(); reset(); } };
      objectAdapters.set(object, adapter);
    }
    return cached(adapter, 'value', ttlMs, loader, options);
  }
  return { run, cached, cachedObject, signal, checkpoint, track,
    cancel: (request, reason) => jobs.cancel(request, reason),
    cancelOwner: (owner, reason) => jobs.cancelOwner(owner, reason),
    shutdown(reason = new DOMException('应用正在退出，任务已取消', 'AbortError')) {
      controller.abort(reason);
      return Promise.allSettled([jobs.shutdown(reason), cacheJobs.shutdown(reason)]).then(() => undefined);
    },
    getDiagnostics: () => ({ jobs: jobs.getDiagnostics(), cache: cacheJobs.getDiagnostics() })
  };
}
module.exports = { createServiceRuntime, semanticKey };
