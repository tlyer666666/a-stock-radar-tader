let sequence = 0;
const session = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Backend request ownership is assigned by Electron; this identifies only one invocation. */
export function createServiceJobScope(cancel: (requestId: string) => Promise<unknown> = id => window.stockApi.cancelServiceJob(id)) {
  const pending = new Set<string>();
  return {
    async run<T>(operation: (requestId: string) => Promise<T>): Promise<T> {
      const id = `${session}:${++sequence}`;
      pending.add(id);
      try { return await operation(id); }
      finally { pending.delete(id); }
    },
    cancelAll(): Promise<void> {
      const ids = [...pending];
      pending.clear();
      return Promise.allSettled(ids.map(id => {
        try { return cancel(id); } catch (error) { return Promise.reject(error); }
      })).then(() => undefined);
    }
  };
}
