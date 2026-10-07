"use strict";

// Electron's before-quit event is synchronous. Keep exactly one cleanup attempt
// alive, then re-enter app.quit once, with a deadline if a resource never exits.
function createShutdownGate({ cleanup, complete, onError = () => {}, timeoutMs = 3000 }) {
  let started = false;
  let finished = false;
  let completion;
  function report(error) { try { onError(error); } catch { /* logging is best effort */ } }
  return function beforeQuit(event) {
    if (finished) return completion;
    event.preventDefault();
    if (started) return completion;
    started = true;
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        report(Object.assign(new Error("退出清理超过等待时限，继续关闭应用"), { code: "SHUTDOWN_TIMEOUT" }));
        resolve();
      }, timeoutMs);
    });
    const pending = Promise.resolve().then(cleanup).catch(report);
    completion = Promise.race([pending, timeout]).then(() => new Promise((resolve, reject) => {
      clearTimeout(timer);
      // Native before-quit emits a microtask checkpoint before Browser::Quit
      // records the prevented event. Re-entering from that checkpoint can have
      // its quit state overwritten by the original call. Use a separate turn.
      setImmediate(() => {
        finished = true;
        try {
          complete();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    }));
    return completion;
  };
}

module.exports = { createShutdownGate };
