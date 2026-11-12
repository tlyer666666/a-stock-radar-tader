import { useCallback, useEffect, useRef, useState } from 'react';
import { createServiceJobScope } from '../../serviceJobClient';
import { whenVisible } from '../../visiblePolling';
import { inTradingSession } from './tStore';
import { normalizeToolboxChart, T_FRAMES, type TChartData, type TFrame } from './tToolboxModel';

type Snapshot = { key: string; data: TChartData | null; loading: boolean; error: string };
/** One active history request per hook. Scope cancellation and generation checks
 * cover stock/frame changes, timeouts and unmount, including late IPC responses. */
function useHistoryChart(security: Security, frame: TFrame, adjustment: string, live: boolean, enabled = true) {
  const key = `${security.code}|${security.secid}|${frame}|${adjustment}`;
  const cache = useRef(new Map<string, { data: TChartData; at: number }>());
  const [snapshot, setSnapshot] = useState<Snapshot>({ key: '', data: null, loading: false, error: '' });
  const [revision, setRevision] = useState(0);
  const force = useRef(false);
  const refresh = useCallback(() => { force.current = true; setRevision(n => n + 1); }, []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, busy = false, generation = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const scope = createServiceJobScope();
    const cached = cache.current.get(key);
    setSnapshot({ key, data: cached?.data || null, loading: !cached, error: '' });
    const load = async (manual = false) => {
      if (disposed || busy || document.hidden) return;
      busy = true;
      const current = ++generation;
      const active = () => !disposed && current === generation;
      setSnapshot(old => ({ key, data: old.key === key ? old.data : null, loading: true, error: '' }));
      timeout = setTimeout(() => {
        if (!active()) return;
        generation++; busy = false;
        setSnapshot(old => ({ key, data: old.key === key ? old.data : null, loading: false, error: 'K线请求超时，请刷新重试' }));
        void scope.cancelAll();
      }, 30_000);
      try {
        const response = await scope.run(requestId => window.stockApi.getChart(security, frame, {
          range: T_FRAMES.find(entry => entry.id === frame)!.range, limit: 300, adjustment, forceRefresh: manual, requestId, timeoutMs: 25_000
        }));
        const data = normalizeToolboxChart(response);
        if (!active()) return;
        cache.current.delete(key); cache.current.set(key, { data, at: Date.now() });
        while (cache.current.size > 14) cache.current.delete(cache.current.keys().next().value!);
        setSnapshot({ key, data, loading: false, error: '' });
      } catch (error) {
        if (active()) setSnapshot(old => ({ key, data: old.key === key ? old.data : null, loading: false, error: error instanceof Error ? error.message : 'K线读取失败' }));
      } finally {
        if (active()) { clearTimeout(timeout); busy = false; }
      }
    };
    const manual = force.current; force.current = false;
    if (manual || !cached || Date.now() - cached.at >= 30_000) void load(manual);
    const tick = whenVisible(() => { if (live && inTradingSession()) void load(); });
    const interval = live ? window.setInterval(tick, 30_000) : undefined;
    const visible = () => { if (!cache.current.has(key)) void load(); else tick(); };
    document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; generation++; clearTimeout(timeout); window.clearInterval(interval); document.removeEventListener('visibilitychange', visible); void scope.cancelAll(); };
  }, [key, security.code, security.name, security.secid, frame, adjustment, live, enabled, revision]);
  return { ...(snapshot.key === key ? snapshot : { key, data: null, loading: enabled, error: '' }), refresh };
}
export function useTToolbox(security: Security, frame: TFrame, adjustment: string, live: boolean) {
  const selected = useHistoryChart(security, frame, adjustment, live);
  const same = frame === '101' && adjustment === 'front';
  const background = useHistoryChart(security, '101', 'front', live, !same);
  return { selected, daily: same ? selected : background,
    refresh: () => { selected.refresh(); if (!same) background.refresh(); } };
}
