'use strict';

const { Worker } = require('node:worker_threads');

function busyError(message = '计算任务繁忙，请等待当前任务结束后重试') {
  return Object.assign(new Error(message), { code: 'SERVICE_BUSY' });
}

// A slot belongs to the physical worker until exit/termination has completed,
// even when its caller has already been rejected by cancellation or timeout.
function createWorkerRunner({ WorkerClass = Worker, maxConcurrent = 2, maxQueued = 4, timeoutMs = 120000 } = {}) {
  const active = new Set();
  const queue = [];
  let closed = false;
  let closingReason;
  let shutdownPromise;

  function release(job) {
    if (job.released) return;
    job.released = true;
    job.worker?.removeAllListeners();
    active.delete(job);
    job.release();
    pump();
  }

  function finish(job, outcome, exited = false) {
    if (!job.settled) {
      job.settled = true;
      clearTimeout(job.timer);
      job.signal?.removeEventListener('abort', job.abort);
      // AbortSignal reasons may legitimately be null, false, 0 or ''. Presence
      // of an error outcome, rather than its truthiness, determines rejection.
      if (Object.hasOwn(outcome, 'error')) job.reject(outcome.error);
      else job.resolve(outcome.value);
    }
    if (job.released) return;
    if (!job.worker) {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      release(job);
    } else if (exited) {
      release(job);
    } else if (!job.terminating) {
      job.terminating = true;
      // Keep the error listener attached while terminate() is in progress.
      // The slot is released only after actual exit, never on caller settlement.
      try {
        Promise.resolve(job.worker.terminate()).then(() => release(job), () => {
          // A failed termination has not proved physical exit. Retain ownership
          // and the exit/error listeners instead of admitting another worker.
        });
      } catch {
        // As above, only a later exit can release this worker's slot.
      }
    }
  }

  function pump() {
    if (closed) return;
    while (active.size < maxConcurrent && queue.length) {
      const job = queue.shift();
      if (job.settled) continue;
      active.add(job);
      try {
        job.worker = new WorkerClass(job.filename, { workerData: job.data });
      } catch (error) {
        finish(job, { error });
        continue;
      }
      job.worker.once('message', message => {
        if (message?.ok) finish(job, { value: message.value });
        else finish(job, { error: new Error(String(message?.error || '工作线程计算失败')) });
      });
      job.worker.on('error', error => finish(job, { error }));
      job.worker.once('exit', code => finish(job, {
        error: new Error(`工作线程退出且未返回结果（退出码 ${code}）`)
      }, true));
    }
  }

  return {
    run(filename, data, { signal, timeoutMessage = '计算超时，已停止任务以保证软件可用' } = {}) {
      const rejected = error => Object.defineProperty(Promise.reject(error), 'drained', { value: Promise.resolve() });
      if (closed) return rejected(closingReason);
      if (signal?.aborted) return rejected(signal.reason);
      if (active.size >= maxConcurrent && queue.length >= maxQueued) return rejected(busyError());
      let physicalDrain;
      const result = new Promise((resolve, reject) => {
        const job = { filename, data, signal, resolve, reject, settled: false, released: false };
        job.done = new Promise(release => { job.release = release; });
        physicalDrain = job.done;
        job.abort = () => finish(job, { error: signal.reason });
        job.timer = setTimeout(() => finish(job, { error: new Error(timeoutMessage) }), timeoutMs);
        signal?.addEventListener('abort', job.abort, { once: true });
        queue.push(job);
        pump();
      });
      return Object.defineProperty(result, 'drained', { value: physicalDrain });
    },
    shutdown(reason = new DOMException('应用正在退出，任务已取消', 'AbortError')) {
      if (shutdownPromise) return shutdownPromise;
      closed = true;
      closingReason = reason;
      const jobs = [...queue, ...active];
      for (const job of jobs) finish(job, { error: reason });
      shutdownPromise = Promise.all(jobs.map(job => job.done)).then(() => undefined);
      return shutdownPromise;
    }
  };
}

module.exports = { createWorkerRunner, busyError };
