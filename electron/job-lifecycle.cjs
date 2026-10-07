'use strict';

const { performance } = require('node:perf_hooks');
const { busyError } = require('./worker-runner.cjs');
const DEFAULT_OPERATION_TIMEOUTS = Object.freeze({ single: 180000, portfolio: 300000, scan: 600000, cache: 180000 });

function jobError(code, message, name = 'Error') { return Object.assign(new Error(message), { code, name }); }
function cancelledError() { return jobError('JOB_CANCELLED', '任务已取消', 'AbortError'); }
function timeoutError() { return jobError('JOB_TIMEOUT', '任务已达到总时限，请缩小范围后重试', 'TimeoutError'); }
function withDrain(promise, drained, producerSignal) {
  Object.defineProperty(promise, 'drained', { value: drained });
  if (producerSignal) Object.defineProperty(promise, 'producerSignal', { value: producerSignal });
  return promise;
}
function refused(error) { return withDrain(Promise.reject(error), Promise.resolve()); }
function positive(value, fallback, maximum = Infinity) {
  const number = Number(value);
  return Math.min(maximum, Number.isFinite(number) && number > 0 ? Math.max(1, Math.floor(number)) : fallback);
}

// Caller settlement and physical ownership are deliberately separate. A task
// must track original HTTP/child promises or worker promises with .drained;
// tracking a logical cancellation race cannot establish physical settlement.
function createJobLifecycle({ maxActive = 2, maxQueued = 0, maxSubscribers = 256, operationTimeouts = {} } = {}) {
  maxActive = positive(maxActive, 2);
  maxQueued = Number.isFinite(Number(maxQueued)) ? Math.max(0, Math.min(256, Math.floor(Number(maxQueued)))) : 0;
  maxSubscribers = positive(maxSubscribers, 256);
  const timeouts = Object.fromEntries(Object.entries(DEFAULT_OPERATION_TIMEOUTS)
    .map(([name, limit]) => [name, positive(operationTimeouts[name], limit, limit)]));
  const identities = new Map(), requests = new Map(), active = new Set(), flights = new Set(), queue = [];
  let closed = false, closingReason, shutdownPromise, subscribers = 0;
  const stats = { peakActive: 0, peakPending: 0, admitted: 0, completed: 0 };

  function finishSubscriber(subscriber, outcome) {
    if (subscriber.settled) return;
    subscriber.settled = true;
    subscribers--;
    clearTimeout(subscriber.timer);
    subscriber.signal?.removeEventListener('abort', subscriber.abort);
    if (outcome.ok) subscriber.resolve(outcome.value); else subscriber.reject(outcome.error);
  }
  function forgetIdentity(flight) {
    if (identities.get(flight.identity) === flight) identities.delete(flight.identity);
  }
  function completePhysical(flight) {
    if (flight.finished || !flight.returned || flight.resources.size) return;
    flight.finished = true;
    clearTimeout(flight.timer);
    forgetIdentity(flight);
    active.delete(flight); flights.delete(flight);
    for (const subscriber of flight.subscribers) requests.delete(subscriber.id);
    stats.completed++;
    flight.release();
    pump();
  }
  function abortProducer(flight, reason) {
    if (flight.finished) return;
    forgetIdentity(flight);
    if (!flight.controller.signal.aborted) flight.controller.abort(reason);
    for (const subscriber of flight.subscribers) finishSubscriber(subscriber, { ok: false, error: reason });
    if (!flight.started) {
      const index = queue.indexOf(flight);
      if (index >= 0) queue.splice(index, 1);
      flight.returned = true;
      completePhysical(flight);
    }
  }
  function cancelSubscriber(subscriber, reason) {
    if (!subscriber || subscriber.settled) return false;
    finishSubscriber(subscriber, { ok: false, error: reason });
    if (![...subscriber.flight.subscribers].some(item => !item.settled)) abortProducer(subscriber.flight, reason);
    return true;
  }
  function checkpoint(flight) {
    if (!flight.controller.signal.aborted && performance.now() >= flight.deadlineAt) abortProducer(flight, timeoutError());
    flight.controller.signal.throwIfAborted();
  }
  function contextFor(flight) {
    return Object.freeze({
      signal: flight.controller.signal,
      deadlineAt: flight.deadlineAt,
      remainingMs: () => Math.max(0, flight.deadlineAt - performance.now()),
      throwIfAborted: () => checkpoint(flight),
      track(promiseOrFactory) {
        const isFactory = typeof promiseOrFactory === 'function';
        // A factory has not started yet, so cancellation must prevent its side
        // effects. An existing promise already owns real work: register that
        // lifetime even if its caller was cancelled before reaching this line.
        if (isFactory) checkpoint(flight);
        if (flight.finished || (isFactory && flight.returned)) throw jobError('JOB_FINISHED', '任务已结束，不能再启动工作');
        const value = isFactory ? promiseOrFactory() : promiseOrFactory;
        const physical = Promise.resolve(value?.drained ?? value);
        flight.resources.add(physical);
        const release = () => { flight.resources.delete(physical); completePhysical(flight); };
        physical.then(release, release);
        return value;
      }
    });
  }
  function publish(flight, outcome) {
    if (!flight.controller.signal.aborted && performance.now() >= flight.deadlineAt) abortProducer(flight, timeoutError());
    flight.returned = true;
    flight.outcome = flight.controller.signal.aborted ? { ok: false, error: flight.controller.signal.reason } : outcome;
    for (const subscriber of flight.subscribers) {
      if (flight.outcome.ok && performance.now() >= subscriber.deadlineAt) cancelSubscriber(subscriber, timeoutError());
      else finishSubscriber(subscriber, flight.outcome);
    }
    completePhysical(flight);
  }
  function start(flight) {
    if (flight.finished) return;
    if (performance.now() >= flight.deadlineAt) { abortProducer(flight, timeoutError()); return; }
    flight.started = true;
    active.add(flight);
    stats.admitted++; stats.peakActive = Math.max(stats.peakActive, active.size);
    try {
      const result = flight.producer(contextFor(flight));
      // A producer may directly return a worker or nested job with its own
      // physical lifetime, even if its logical promise rejects earlier.
      if (result?.drained) {
        const physical = Promise.resolve(result.drained);
        flight.resources.add(physical);
        physical.then(() => { flight.resources.delete(physical); completePhysical(flight); },
          () => { flight.resources.delete(physical); completePhysical(flight); });
      }
      Promise.resolve(result).then(value => publish(flight, { ok: true, value }), error => publish(flight, { ok: false, error: error || jobError('JOB_FAILED', '任务执行失败') }));
    } catch (error) { publish(flight, { ok: false, error: error || jobError('JOB_FAILED', '任务执行失败') }); }
  }
  function pump() {
    if (closed) return;
    while (active.size < maxActive && queue.length) start(queue.shift());
  }
  function requestIdentity(owner, requestId) {
    if (!['string', 'number'].includes(typeof owner) || !String(owner).trim() ||
        typeof requestId !== 'string' || !requestId.trim()) throw new TypeError('owner 和 requestId 不能为空');
    return JSON.stringify([String(owner), requestId]);
  }

  return {
    subscribe(options, producer) {
      try {
        if (closed) return refused(closingReason);
        const { operation, key, owner, requestId, signal, timeoutMs } = options || {};
        const id = requestIdentity(owner, requestId);
        if (!Object.hasOwn(timeouts, operation) || typeof key !== 'string' || !key || typeof producer !== 'function') {
          throw new TypeError('operation、key 和 producer 无效');
        }
        if (signal?.aborted) return refused(signal.reason ?? cancelledError());
        if (requests.has(id)) return refused(jobError('JOB_DUPLICATE_REQUEST', '该请求仍在运行或清理中'));
        if (requests.size >= maxSubscribers) return refused(busyError('任务订阅已满，请稍后重试'));
        const identity = JSON.stringify([operation, key]);
        let flight = identities.get(identity), created = false;
        if (flight?.controller.signal.aborted) flight = undefined;
        if (!flight) {
          if (active.size >= maxActive && queue.length >= maxQueued) return refused(busyError());
          created = true;
          flight = { identity, producer, controller: new AbortController(), resources: new Set(), subscribers: new Set(),
            deadlineAt: performance.now() + timeouts[operation], started: false, returned: false, finished: false };
          flight.drained = new Promise(resolve => { flight.release = resolve; });
          flight.timer = setTimeout(() => abortProducer(flight, timeoutError()), timeouts[operation]);
          identities.set(identity, flight); flights.add(flight);
        }
        const waitMs = positive(timeoutMs, timeouts[operation], timeouts[operation]);
        const subscriber = { id, owner: String(owner), signal, flight, settled: false, deadlineAt: performance.now() + waitMs };
        const result = withDrain(new Promise((resolve, reject) => { subscriber.resolve = resolve; subscriber.reject = reject; }), flight.drained, flight.controller.signal);
        requests.set(id, subscriber); flight.subscribers.add(subscriber); subscribers++;
        subscriber.abort = () => cancelSubscriber(subscriber, signal.reason ?? cancelledError());
        signal?.addEventListener('abort', subscriber.abort, { once: true });
        subscriber.timer = setTimeout(() => cancelSubscriber(subscriber, timeoutError()), waitMs);
        if (flight.outcome) finishSubscriber(subscriber, flight.outcome);
        if (created) {
          if (active.size < maxActive) start(flight);
          else { queue.push(flight); stats.peakPending = Math.max(stats.peakPending, queue.length); }
        }
        return result;
      } catch (error) { return refused(error); }
    },
    cancel({ owner, requestId } = {}, reason = cancelledError()) {
      let id; try { id = requestIdentity(owner, requestId); } catch { return false; }
      return cancelSubscriber(requests.get(id), reason || cancelledError());
    },
    cancelOwner(owner, reason = cancelledError()) {
      let count = 0;
      for (const subscriber of requests.values()) if (subscriber.owner === String(owner) && cancelSubscriber(subscriber, reason || cancelledError())) count++;
      return count;
    },
    shutdown(reason = jobError('JOB_SHUTDOWN', '应用正在退出，任务已取消', 'AbortError')) {
      if (shutdownPromise) return shutdownPromise;
      reason ||= jobError('JOB_SHUTDOWN', '应用正在退出，任务已取消', 'AbortError');
      closed = true; closingReason = reason;
      const remaining = [...flights];
      for (const flight of remaining) abortProducer(flight, reason);
      shutdownPromise = Promise.all(remaining.map(flight => flight.drained)).then(() => undefined);
      return shutdownPromise;
    },
    getDiagnostics() { return { ...stats, active: active.size, pending: queue.length, subscribers, requests: requests.size, closed }; }
  };
}

module.exports = { createJobLifecycle, DEFAULT_OPERATION_TIMEOUTS };
