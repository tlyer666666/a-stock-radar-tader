export function createRefreshGate(run: (force: boolean) => Promise<void>) {
  let current: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const start = (force: boolean): Promise<void> => {
    const task = (async () => { await run(force); })();
    current = task;
    const settle = () => { if (current === task) current = null; };
    task.then(settle, settle);
    return task;
  };
  const trigger = (force = false): Promise<void> => {
    if (!current) return start(force);
    if (!force) return current;
    queued ||= current.catch(() => undefined).then(() => { queued = null; return start(true); });
    return queued;
  };
  return { trigger, isBusy: () => current !== null || queued !== null };
}
