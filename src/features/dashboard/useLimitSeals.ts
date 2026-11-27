import { useEffect, useState } from "react";
import { startVisibleInterval } from "../../visiblePolling";
import { mergeSealTick, type LimitSealRecord } from "./limitSealModel";

/**
 * 订阅一组股票的实时封单：先拿一次当前值（可带当天走势），之后主进程封单一变就经推送合并进来；
 * 每 10 秒续一次租约（页面隐藏时不续，30 秒后主进程自动停止请求），卸载时立即退订。
 */
export function useLimitSeals(codes: string[], { owner, enabled = true, withHistory = false }: { owner: string; enabled?: boolean; withHistory?: boolean }) {
  const [records, setRecords] = useState<Record<string, LimitSealRecord>>({});
  const [lastTickAt, setLastTickAt] = useState(0);
  const key = codes.filter(code => /^\d{6}$/.test(code)).slice(0, 300).join(",");

  useEffect(() => {
    setLastTickAt(0);
    const list = key ? key.split(",") : [];
    const wanted = new Set(list);
    const prune = (table: Record<string, LimitSealRecord>): Record<string, LimitSealRecord> => {
      const entries = Object.entries(table).filter(([code]) => wanted.has(code));
      return entries.length === Object.keys(table).length ? table : Object.fromEntries(entries);
    };
    setRecords(previous => (enabled && list.length ? prune(previous) : Object.keys(previous).length ? {} : previous));
    const api = typeof window !== "undefined" ? window.stockApi : undefined;
    if (!enabled || !list.length || typeof api?.subscribeLimitSeals !== "function" || typeof api?.onLimitSealTick !== "function") return undefined;
    let alive = true;
    const liveSeen = new Set<string>();
    const unlisten = api.onLimitSealTick(tick => {
      const items = Array.isArray(tick?.items) ? tick.items.filter(item => wanted.has(item.code)) : [];
      if (!alive || !items.length) return;
      for (const item of items) liveSeen.add(item.code);
      // 合并后裁掉这批不再盯的代码：换股票、删自选留下的旧记录不留在内存里。
      setRecords(previous => prune(mergeSealTick(previous, items, 400, withHistory)));
      setLastTickAt(Number(tick.atMs) || Date.now());
    });
    const renew = (first: boolean) => {
      void api.subscribeLimitSeals!({ owner, codes: list, withHistory: first && withHistory }).then(result => {
        if (!alive || !first) return;
        const items = Array.isArray(result?.items) ? result.items.filter(item => wanted.has(item.code)) : [];
        const snapshotCodes = new Set(items.map(item => item.code));
        setRecords(previous => {
          const base: Record<string, LimitSealRecord> = {};
          for (const [code, record] of Object.entries(previous)) {
            if (wanted.has(code) && (snapshotCodes.has(code) || liveSeen.has(code))) base[code] = record;
          }
          // 等待初始快照期间已收到实时推送的代码：保留实时字段不回退，只按同日补齐更早的走势点。
          if (withHistory) {
            for (const item of items) {
              const liveRec = liveSeen.has(item.code) ? base[item.code] : undefined;
              if (!liveRec || !item.history?.length) continue;
              const sameDay = !liveRec.quoteDate || !item.quoteDate || liveRec.quoteDate === item.quoteDate;
              if (!sameDay) continue;
              const lastSnapT = item.history.at(-1)!.t;
              const newerLive = (liveRec.history || []).filter(point => point.t > lastSnapT);
              base[item.code] = { ...liveRec, history: [...item.history, ...newerLive].slice(-400) };
            }
          }
          const snapshotOnly = items.filter(item => !liveSeen.has(item.code));
          return snapshotOnly.length ? prune(mergeSealTick(base, snapshotOnly, 400, withHistory)) : base;
        });
        if (items.length) setLastTickAt(Date.now());
      }).catch(() => undefined);
    };
    renew(true);
    const stop = startVisibleInterval(() => renew(false), 10_000, { resumeOnVisible: true });
    return () => {
      alive = false;
      unlisten();
      stop();
      void api.subscribeLimitSeals!({ owner, active: false }).catch(() => undefined);
    };
  }, [key, owner, enabled, withHistory]);

  return { records, lastTickAt };
}
