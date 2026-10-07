import { useCallback, useEffect, useRef, useState } from "react";
import { loadSafeLocalJson, saveSafeLocalJson } from "./safeStorage";
import {
  evaluateStockMonitor,
  normalizeStockMonitorConfig,
  normalizeStockMonitorRules,
  type StockMonitorConfig,
  type StockMonitorEvaluation,
  type StockMonitorSnapshot
} from "./stockMonitorRules";

export type StockMonitorAlert = { id: string; code: string; name: string; triggeredAt: string; detail: string };
type MonitorStorage = { configs: Record<string, StockMonitorConfig>; alerts: StockMonitorAlert[] };
export const STOCK_MONITOR_STORAGE_KEY = "a-stock-radar:stock-monitors:v1";

type PollingOptions = {
  getSnapshot: (item: Security) => Promise<StockMonitorSnapshot>;
  onSnapshot: (item: Security, snapshot: StockMonitorSnapshot, config: StockMonitorConfig) => void;
  onError: (item: Security, error: unknown, config: StockMonitorConfig) => void;
  onRefreshing: (refreshing: boolean) => void;
};

// One shared in-flight batch survives reconfiguration so replacing a rule or
// pausing never creates another set of four concurrent requests.
export function createStockMonitorPolling(options: PollingOptions) {
  let generation = 0;
  let enabled = false;
  let busy = false;
  let fingerprint = "";
  let items: Security[] = [];
  let configs: Record<string, StockMonitorConfig> = {};
  const configure = (nextItems: Security[], nextConfigs: Record<string, StockMonitorConfig>, live: boolean) => {
    items = nextItems;
    configs = nextConfigs;
    const nextFingerprint = JSON.stringify([live, nextItems.filter(item => nextConfigs[item.code]?.enabled).map(item => [item.code, nextConfigs[item.code]]).sort((left, right) => String(left[0]).localeCompare(String(right[0])))]);
    if (fingerprint === nextFingerprint) return false;
    fingerprint = nextFingerprint;
    generation += 1;
    enabled = live;
    if (!live) options.onRefreshing(false);
    return true;
  };
  const poll = async (): Promise<void> => {
    if (busy || !enabled) return;
    const epoch = generation;
    const pending = items.filter(item => configs[item.code]?.enabled);
    if (!pending.length) return;
    busy = true;
    options.onRefreshing(true);
    try {
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
        while (pending.length && enabled && epoch === generation) {
          const item = pending.shift();
          if (!item) return;
          const config = configs[item.code];
          if (!config?.enabled) continue;
          try {
            const snapshot = await options.getSnapshot(item);
            if (enabled && epoch === generation) options.onSnapshot(item, snapshot, config);
          } catch (error) {
            if (enabled && epoch === generation) options.onError(item, error, config);
          }
        }
      }));
    } finally {
      busy = false;
      if (enabled) options.onRefreshing(false);
      if (enabled && epoch !== generation) await poll();
    }
  };
  return { configure, poll, stop: () => configure([], {}, false) };
}

export function reconcileStockMonitorRuntimes(current: Record<string, StockMonitorEvaluation>, items: Security[], configs: Record<string, StockMonitorConfig>, live: boolean): Record<string, StockMonitorEvaluation> {
  const next: Record<string, StockMonitorEvaluation> = {};
  for (const item of items) {
    const config = configs[item.code];
    if (!config) continue;
    const previous = current[item.code];
    const waiting = evaluateStockMonitor(config, null, previous?.runtime);
    if (!live) {
      next[item.code] = { ...waiting, status: "disabled", detail: "实时刷新已暂停", runtime: { ...waiting.runtime, initialized: false, lastSampleAt: null } };
    } else if (previous && config.enabled && previous.status !== "disabled" && waiting.runtime.configSignature === previous.runtime.configSignature) {
      next[item.code] = previous;
    } else {
      next[item.code] = waiting;
    }
  }
  return next;
}

export function isUsableMonitorStorage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const configs = (value as Partial<MonitorStorage>).configs;
  if (!configs || typeof configs !== "object" || Array.isArray(configs)) return false;
  // An empty dictionary is an intentional clear. Mixed documents keep their
  // usable current rules; a wholly corrupt dictionary may recover the backup.
  return Object.keys(configs).length === 0 || Object.keys(normalizeStockMonitorRules(configs)).length > 0;
}

export function loadMonitors(): MonitorStorage {
  const saved = loadSafeLocalJson<unknown>(STOCK_MONITOR_STORAGE_KEY, {}, isUsableMonitorStorage);
  if (!saved || typeof saved !== "object") return { configs: {}, alerts: [] };
  const value = saved as Partial<MonitorStorage>;
  const alerts = Array.isArray(value.alerts) ? value.alerts.filter(alert => alert && typeof alert.id === "string" && /^\d{6}$/.test(alert.code) && typeof alert.name === "string" && typeof alert.detail === "string" && Number.isFinite(Date.parse(alert.triggeredAt))).slice(0, 20) : [];
  return { configs: normalizeStockMonitorRules(value.configs), alerts };
}

export default function useStockMonitors({ items, live, refreshSeconds, onAlert }: {
  items: Security[];
  live: boolean;
  refreshSeconds: number;
  onAlert?: (alert: StockMonitorAlert) => void;
}) {
  const [saved, setSaved] = useState<MonitorStorage>(loadMonitors);
  const [runtimes, setRuntimes] = useState<Record<string, StockMonitorEvaluation>>({});
  const [latestQuotes, setLatestQuotes] = useState<Record<string, StockMonitorSnapshot>>({});
  const [storageError, setStorageError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const savedRef = useRef(saved);
  const runtimeRef = useRef(runtimes);
  const alertRef = useRef(onAlert);
  alertRef.current = onAlert;
  const pollerRef = useRef<ReturnType<typeof createStockMonitorPolling> | null>(null);
  if (!pollerRef.current) pollerRef.current = createStockMonitorPolling({
    getSnapshot: item => window.stockApi.getQuoteSnapshot(item),
    onRefreshing: setRefreshing,
    onSnapshot: (item, snapshot, config) => {
      const previousAlert = savedRef.current.alerts.find(alert => alert.code === item.code);
      const previous = runtimeRef.current[item.code]?.runtime;
      const lastAlertAt = previous?.lastAlertAt ?? (previousAlert ? Date.parse(previousAlert.triggeredAt) : null);
      const evaluation = evaluateStockMonitor(config, snapshot, previous ? { ...previous, lastAlertAt } : { configSignature: "", initialized: false, matched: null, lastAlertAt, lastSampleAt: null });
      const nextRuntimes = { ...runtimeRef.current, [item.code]: evaluation };
      runtimeRef.current = nextRuntimes;
      setRuntimes(nextRuntimes);
      setLatestQuotes(current => ({ ...current, [item.code]: snapshot }));
      if (!evaluation.shouldAlert) return;
      const triggeredAt = new Date(evaluation.runtime.lastAlertAt!).toISOString();
      const alert: StockMonitorAlert = { id: `${item.code}-${triggeredAt}`, code: item.code, name: item.name, triggeredAt, detail: evaluation.detail };
      const nextSaved = { ...savedRef.current, alerts: [alert, ...savedRef.current.alerts].slice(0, 20) };
      if (!saveSafeLocalJson(STOCK_MONITOR_STORAGE_KEY, nextSaved, isUsableMonitorStorage)) setStorageError("提醒记录保存失败；本次提醒仍已显示，请检查本机存储空间。");
      savedRef.current = nextSaved;
      setSaved(nextSaved);
      alertRef.current?.(alert);
    },
    onError: (item, _error, config) => {
      const waiting = evaluateStockMonitor(config, null, runtimeRef.current[item.code]?.runtime);
      const next = { ...runtimeRef.current, [item.code]: { ...waiting, status: "unavailable" as const, detail: "行情获取失败，等待下次重试" } };
      runtimeRef.current = next;
      setRuntimes(next);
    }
  });

  useEffect(() => {
    const poller = pollerRef.current!;
    // List identity/name changes preserve the baseline; the pure evaluator
    // resets only a changed stock's configuration. Pauses reset all baselines.
    const activeCodes = new Set(items.map(item => item.code));
    const nextRuntimes = reconcileStockMonitorRuntimes(runtimeRef.current, items, saved.configs, live);
    runtimeRef.current = nextRuntimes;
    setRuntimes(nextRuntimes);
    setLatestQuotes(current => Object.fromEntries(Object.entries(current).filter(([code]) => activeCodes.has(code))));
    if (poller.configure(items, saved.configs, live)) void poller.poll();
  }, [items, live, saved.configs]);

  useEffect(() => {
    const timer = live ? window.setInterval(() => void pollerRef.current?.poll(), Math.max(5, Number(refreshSeconds) || 5) * 1000) : undefined;
    return () => window.clearInterval(timer);
  }, [live, refreshSeconds]);

  useEffect(() => () => { pollerRef.current?.stop(); }, []);

  const save = useCallback((code: string, config: StockMonitorConfig): boolean => {
    const normalized = normalizeStockMonitorConfig(config);
    if (!/^\d{6}$/.test(code) || !normalized) { setStorageError("监控条件无效，请检查数值后重试。"); return false; }
    const next = { ...savedRef.current, configs: { ...savedRef.current.configs, [code]: normalized } };
    if (!saveSafeLocalJson(STOCK_MONITOR_STORAGE_KEY, next, isUsableMonitorStorage)) { setStorageError("监控条件保存失败，已保留原配置。请检查本机存储空间。"); return false; }
    savedRef.current = next;
    setSaved(next);
    setStorageError("");
    return true;
  }, []);

  const remove = useCallback((code: string): boolean => {
    const configs = { ...savedRef.current.configs };
    delete configs[code];
    const next = { ...savedRef.current, configs };
    if (!saveSafeLocalJson(STOCK_MONITOR_STORAGE_KEY, next, isUsableMonitorStorage)) { setStorageError("移除监控条件失败，已保留原配置。"); return false; }
    savedRef.current = next;
    setSaved(next);
    setStorageError("");
    return true;
  }, []);

  return { configs: saved.configs, runtimes, latestQuotes, alerts: saved.alerts, save, remove, storageError, refreshing };
}
