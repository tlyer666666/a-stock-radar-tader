/** Serialize patches against the last successfully persisted settings. */
export function createLatestSettingsWriter<T extends object>(options: {
  read: () => T; normalize: (value: T) => T;
  persist: (value: T) => Promise<T>; accept: (value: T) => void;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  return (patch: Partial<T> | ((current: T) => Partial<T>)): Promise<T> => {
    const pending = tail.then(async () => {
      const current = options.read();
      const next = options.normalize({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
      const saved = options.normalize(await options.persist(next));
      options.accept(saved);
      return saved;
    });
    tail = pending.catch(() => undefined);
    return pending;
  };
}
