/** Apply each mutation to the latest successfully saved collection. */
export function createCollectionWriter<T>(options: {
  read: () => T[];
  persist: (items: T[]) => Promise<T[]>;
  accept: (items: T[]) => void;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  return (update: (items: T[]) => T[]): Promise<T[]> => {
    const pending = tail.then(async () => {
      const current = options.read();
      const next = update(current);
      // 内容没变就不写盘也不触发界面更新（观察池每分钟合并一次，多数时候没有新股票）。
      if (next === current || JSON.stringify(next) === JSON.stringify(current)) return current;
      const saved = await options.persist(next);
      options.accept(saved);
      return saved;
    });
    tail = pending.catch(() => undefined);
    return pending;
  };
}
