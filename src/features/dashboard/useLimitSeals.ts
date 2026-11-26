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
    const api = typeof window !== "undefined" ? window.stockApi : undefined;
    if (!enabled || !list.length || typeof api?.subscribeLimitSeals !== "function" || typeof api?.onLimitSealTick !== "function") return undefined;
    let alive = true;
    const wanted = new Set(list);
    const unlisten = api.onLimitSealTick(tick => {
      const items = Array.isArray(tick?.items) ? tick.items.filter(item => wanted.has(item.code)) : [];
      if (!alive || !items.length) return;
      setRecords(previous => mergeSealTick(previous, items, 400, withHistory));
      setLastTickAt(Number(tick.atMs) || Date.now());
    });
    const renew = (first: boolean) => {
      void api.subscribeLimitSeals!({ owner, codes: list, withHistory: first && withHistory }).then(result => {
        if (!alive || !first || !Array.isArray(result?.items) || !result.items.length) return;
        setRecords(previous => mergeSealTick(previous, result.items, 400, withHistory));
        setLastTickAt(Date.now());
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
