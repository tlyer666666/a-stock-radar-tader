/** Apply each mutation to the latest successfully saved collection. */
export function createCollectionWriter<T>(options: {
  read: () => T[];
  persist: (items: T[]) => Promise<T[]>;
  accept: (items: T[]) => void;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  return (update: (items: T[]) => T[]): Promise<T[]> => {
    const pending = tail.then(async () => {
      const saved = await options.persist(update(options.read()));
      options.accept(saved);
      return saved;
    });
    tail = pending.catch(() => undefined);
    return pending;
  };
}
