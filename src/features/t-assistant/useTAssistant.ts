import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadSafeLocalJson, saveSafeLocalJson } from "../../safeStorage";
import { startVisibleInterval } from "../../visiblePolling";
import { buildTimeShare, type TimeShare } from "../market/timeShareModel";
import { analyzeT, isActionable, normalizeTConfig, settleTrades, type TAnalysis, type TConfig, type TReplay, type TTrade } from "./tEngine";
import {
  EMPTY_T_STORE, MAX_T_ITEMS, T_STORE_KEY, collectRolledTradeIdsThrough, inTradingSession, normalizeTStore, rolloverTStoreForDay, secidForCode, shanghaiClock, shanghaiDay, isFreshTQuote, previousOpenT, shouldAlert, withTrades,
  type AlertMemory, type TItem, type TStore
} from "./tStore";
import { userErrorText } from "../../userErrorText";
import { inferAssetType } from "../../domain/securityIdentifiers";

export type TRuntime = {
  share: TimeShare | null;
  analysis: TAnalysis | null;
  replay?: TReplay | null;
  loading: boolean;
  error: string;
  updatedAt: number | null;
  source: string;
  signalNote: string;
  previousOpenNote: string;
};
export type TAssistantApi = ReturnType<typeof useTAssistant>;

const REFRESH_MS = 10_000;
const isStore = (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * 做T助手的数据层（挂在 App 上，切到别的页面也继续跟踪和提醒）：
 * 交易时段每 10 秒（窗口可见时）刷新一次跟踪股票的分时，算出当前信号；出现新的操作信号时弹提示、可选语音播报。
 */
export function useTAssistant({ live, holdings, onAlert }: { live: boolean; holdings?: Array<{ code: string; shares?: number; costPrice?: number }> | undefined; onAlert: (message: string) => void }) {
  const [store, setStore] = useState<TStore>(() => normalizeTStore(loadSafeLocalJson<unknown>(T_STORE_KEY, EMPTY_T_STORE, isStore)));
  const [shares, setShares] = useState<Record<string, { share: TimeShare | null; loading: boolean; error: string; updatedAt: number | null; source: string }>>({});
  const [volatilities, setVolatilities] = useState<Record<string, number | null>>({});
  const volatilitiesRef = useRef(volatilities);
  volatilitiesRef.current = volatilities;
  const [saveError, setSaveError] = useState(false);
  const [clockTick, setClockTick] = useState(Date.now);
  const storeRef = useRef(store);
  const alerted = useRef<AlertMemory>({});
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;
  const mountedRef = useRef(true);
  const inSessionRef = useRef(inTradingSession());

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const commit = useCallback((update: (current: TStore) => TStore) => {
    const next = normalizeTStore(update(storeRef.current));
    storeRef.current = next;
    setStore(next);
    setSaveError(!saveSafeLocalJson(T_STORE_KEY, next, isStore));
  }, []);

  const holdingsRef = useRef(holdings);
  holdingsRef.current = holdings;
  const clockTickRef = useRef(clockTick);
  clockTickRef.current = clockTick;
  const todayKey = shanghaiDay(new Date(clockTick));
  const prevTodayKeyRef = useRef(todayKey);
  useEffect(() => {
    if (prevTodayKeyRef.current !== todayKey) {
      prevTodayKeyRef.current = todayKey;
      volatilitiesRef.current = {};
      setVolatilities({});
    }
    const result = rolloverTStoreForDay(storeRef.current, todayKey, holdingsRef.current);
    if (!result.changed) return;
    storeRef.current = result.store;
    setStore(result.store);
    setSaveError(!saveSafeLocalJson(T_STORE_KEY, result.store, isStore));
    if (result.rolled.length) {
      onAlertRef.current(`做T助手新交易日已自动滚动 T+1 可卖底仓：${result.rolled.map(r => `${r.name} ${r.sellableShares}股`).join("、")}`);
    }
  }, [todayKey, holdings]);

  useEffect(() => {
    return startVisibleInterval(() => {
      if (shanghaiDay() !== shanghaiDay(new Date(clockTickRef.current))) {
        setClockTick(Date.now());
      }
    }, 30_000, { resumeOnVisible: true });
  }, []);

  const busy = useRef(new Set<string>());
  const queuedManual = useRef(new Map<string, Pick<TItem, "code" | "name" | "secid">>());
  const loadOne = useCallback(async (item: Pick<TItem, "code" | "name" | "secid">, silent: boolean): Promise<void> => {
    if (!window.stockApi?.getChart) return;
    if (busy.current.has(item.code)) {
      if (!silent) {
        queuedManual.current.set(item.code, item);
        setShares(current => ({ ...current, [item.code]: { ...(current[item.code] || { share: null, updatedAt: null, source: "" }), loading: true, error: "" } }));
      }
      return;
    }
    busy.current.add(item.code);
    if (!silent) setShares(current => ({ ...current, [item.code]: { ...(current[item.code] || { share: null, updatedAt: null, source: "" }), loading: true, error: "" } }));
    try {
      const assetType = inferAssetType(item.code) === "etf" ? "etf" : "stock";
      const security: Security = { code: item.code, name: item.name, secid: item.secid, assetType };
      const response = await window.stockApi.getChart(security, "time", { forceRefresh: true });
      const rows = Array.isArray(response) ? response : response?.rows || [];
      const preClose = Number(response?.preClose);
      const volumeUnit = response?.volumeUnit === "lots" || response?.volumeUnit === "shares" ? response.volumeUnit : undefined;
      const share = buildTimeShare(rows, { preClose: Number.isFinite(preClose) && preClose > 0 ? preClose : null, assetType, unitsPerLot: response?.unitsPerLot, volumeUnit });
      if (!share) throw new Error("暂无分时数据");
      if (mountedRef.current) {
        setShares(current => ({ ...current, [item.code]: { share, loading: false, error: "", updatedAt: Date.now(), source: String(response?.source || "") } }));
      }
      if (volatilitiesRef.current[item.code] === undefined && window.stockApi?.getChart) {
        void window.stockApi.getChart(security, "101", { limit: 15 }).then((dailyRes) => {
          const bars = Array.isArray(dailyRes) ? dailyRes : dailyRes?.rows || [];
          const amplitudes: number[] = [];
          for (let i = Math.max(1, bars.length - 10); i < bars.length; i += 1) {
            const prevClose = Number(bars[i - 1]?.close);
            const high = Number(bars[i]?.high);
            const low = Number(bars[i]?.low);
            if (prevClose > 0 && high >= low && high > 0) amplitudes.push(((high - low) / prevClose) * 100);
          }
          const avgVol = amplitudes.length ? Number((amplitudes.reduce((s, v) => s + v, 0) / amplitudes.length).toFixed(2)) : null;
          if (mountedRef.current) setVolatilities(curr => ({ ...curr, [item.code]: avgVol }));
        }).catch(() => {
          // Leave transient fetch failures unset (undefined) instead of caching permanent null so subsequent refreshes retry.
        });
      }
    } catch (reason) {
      if (mountedRef.current) {
        const message = userErrorText(reason);
        setShares(current => ({ ...current, [item.code]: { ...(current[item.code] || { share: null, updatedAt: null, source: "" }), loading: false, error: message || "分时读取失败" } }));
      }
    } finally {
      busy.current.delete(item.code);
      const pendingItem = queuedManual.current.get(item.code);
      if (pendingItem) {
        queuedManual.current.delete(item.code);
        if (mountedRef.current) void loadOneRef.current(pendingItem, false);
      }
    }
  }, []);
  const loadOneRef = useRef(loadOne);
  loadOneRef.current = loadOne;

  const loadAll = useCallback(async (silent: boolean) => {
    const queue = [...storeRef.current.items];
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (item) await loadOne(item, silent);
      }
    }));
  }, [loadOne]);

  // 新加的股票、或打开软件时：读一次（非交易时段显示最近一个交易日的分时，方便复盘）。
  const codes = store.items.map(item => item.code).join(",");
  useEffect(() => {
    const missing = storeRef.current.items.filter(item => !shares[item.code]);
    missing.forEach(item => { void loadOne(item, false); });
  }, [codes, loadOne]);

  useEffect(() => {
    if (!live || !codes) return;
    const stopVisible = startVisibleInterval(() => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      const inSession = inTradingSession();
      if (inSession) {
        inSessionRef.current = true;
        setClockTick(Date.now());
        void loadAll(true);
      } else if (inSessionRef.current) {
        inSessionRef.current = false;
        setClockTick(Date.now());
        void loadAll(true);
      }
    }, REFRESH_MS);
    const canBgPoll =
      typeof window !== "undefined" &&
      typeof window.setInterval === "function" &&
      typeof document !== "undefined" &&
      Boolean(window.stockApi?.notify || storeRef.current.voice);
    const bgTimer = canBgPoll
      ? window.setInterval(() => {
          if (!window.stockApi?.notify && !storeRef.current.voice) return;
          if (typeof document === "undefined" || !document.hidden) return;
          if (typeof navigator !== "undefined" && navigator.onLine === false) return;
          const inSession = inTradingSession();
          if (inSession) {
            inSessionRef.current = true;
            setClockTick(Date.now());
            void loadAll(true);
          } else if (inSessionRef.current) {
            inSessionRef.current = false;
            setClockTick(Date.now());
            void loadAll(true);
          }
        }, 20_000)
      : undefined;
    return () => {
      stopVisible();
      if (bgTimer !== undefined) window.clearInterval(bgTimer);
    };
  }, [live, codes, loadAll, store.voice]);

  const runtimes = useMemo(() => {
    const result: Record<string, TRuntime> = {};
    const now = new Date();
    for (const item of store.items) {
      const entry = shares[item.code];
      const share = entry?.share || null;
      const trades = share ? store.trades[share.date]?.[item.code] || [] : [];
      let priorRounds = 0;
      let priorWins = 0;
      for (const [dayKey, dayMap] of Object.entries(store.trades || {})) {
        if (share && dayKey === share.date) continue;
        const list = dayMap?.[item.code];
        if (!Array.isArray(list) || !list.length) continue;
        const settled = settleTrades(list, item.config, item.code).stats;
        priorRounds += settled.rounds;
        priorWins += settled.wins ?? 0;
      }
      const context = { code: item.code, name: item.name };
      const prior = share ? previousOpenT(store, item.code, share.date) : null;
      result[item.code] = {
        share,
        analysis: analyzeT(share, context, item.config, trades, {
          priorRounds,
          priorWins,
          dailyVolatilityPct: volatilities[item.code] ?? null
        }),
        loading: entry?.loading ?? true,
        error: entry?.error || "",
        updatedAt: entry?.updatedAt ?? null,
        source: entry?.source || "",
        previousOpenNote: prior ? `${prior.date} 登记的${prior.open.kind === "reverse" ? "倒T未接回" : "正T未卖出"} ${prior.open.shares} 股。请核对券商实际持仓及今日可卖；旧成交不会自动转成今天的操作。` : "",
        signalNote: !live ? "已暂停实时刷新，下面保留上次分析供参考"
          : entry?.error ? "行情读取失败，暂停操作提示；下面保留上次分析供参考"
          : share && share.date !== shanghaiDay(now) ? `历史参考：${share.date} 分时，不是当前交易日的操作信号`
          : !inTradingSession(now) ? "非交易时段参考：不发实时操作提醒"
          : share && !isFreshTQuote(share.date, share.points.at(-1)?.time, now) ? "行情延迟或时间异常，暂停操作提示，请刷新核对"
          : ""
      };
    }
    return result;
  }, [store, shares, volatilities, clockTick, live]);

  // 新信号提醒：只在交易时段、只提醒最新一分钟的信号。
  useEffect(() => {
    if (!live || !inTradingSession()) return;
    const nowMs = Date.now(), clock = shanghaiClock();
    const messages: string[] = [];
    let primaryItem: TItem | null = null;
    for (const item of store.items) {
      const runtime = runtimes[item.code];
      const analysis = runtime?.analysis;
      if (!analysis || runtime.signalNote || !isActionable(analysis.signal)) continue;
      const { signal } = analysis;
      if (!shouldAlert(alerted.current, item.code, signal.action, analysis.time, nowMs, clock, runtime.share?.date)) continue;
      alerted.current[item.code] = { action: signal.action, at: nowMs, date: runtime.share?.date || "", signalTime: analysis.time };
      if (!primaryItem) primaryItem = item;
      messages.push(`${item.name}：${signal.title} ${signal.shares} 股，参考价 ${signal.price.toFixed(2)}`);
    }
    if (!messages.length) return;
    const alertText = `做T提示 · ${messages.join("；")}`;
    onAlertRef.current(alertText);
    const isBackgrounded =
      typeof document !== "undefined" &&
      (document.hidden || (typeof document.hasFocus === "function" && !document.hasFocus()));
    if (isBackgrounded && typeof window !== "undefined" && typeof window.stockApi?.notify === "function") {
      type NotifyFn = (message: {
        title: string;
        body?: string;
        code?: string;
        name?: string;
        secid?: string;
        targetView?: string;
      }) => Promise<{ shown: boolean }>;
      const notify = window.stockApi.notify as unknown as NotifyFn;
      const target = primaryItem;
      void notify({
        title: "做T助手盘中信号",
        body: alertText,
        ...(target ? { code: target.code, name: target.name, secid: target.secid, targetView: "dashboard" } : {})
      }).catch(() => undefined);
    }
    const synthesis = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (store.voice && synthesis && typeof SpeechSynthesisUtterance !== "undefined") {
      const utterance = new SpeechSynthesisUtterance(`做T提示，${messages.join("。")}`);
      utterance.lang = "zh-CN";
      utterance.rate = 1.05;
      synthesis.speak(utterance);
    }
  }, [runtimes, live, store.items, store.voice]);

  const addStock = useCallback((security: { code: string; name: string; secid?: string }, config?: Partial<TConfig>) => {
    const code = String(security.code || "");
    if (!/^\d{6}$/.test(code)) return "只支持 6 位代码的 A 股或 ETF";
    const exists = storeRef.current.items.find(item => item.code === code);
    if (!exists && storeRef.current.items.length >= MAX_T_ITEMS) return `最多同时跟踪 ${MAX_T_ITEMS} 只`;
    commit(current => {
      const others = current.items.filter(item => item.code !== code);
      const base = exists ? exists.config : null;
      const merged = normalizeTConfig({ ...(base || {}), ...(config || {}) }, code);
      const rolledTradeIds = config?.baseShares !== undefined
        ? collectRolledTradeIdsThrough(current, code, shanghaiDay())
        : exists?.rolledTradeIds;
      const next: TItem = {
        code,
        name: security.name || exists?.name || code,
        secid: security.secid || exists?.secid || secidForCode(code),
        config: merged,
        addedAt: exists?.addedAt || new Date().toISOString(),
        ...(rolledTradeIds ? { rolledTradeIds } : {})
      };
      return { ...current, items: exists ? current.items.map(item => item.code === code ? next : item) : [...others, next] };
    });
    return "";
  }, [commit]);

  const removeStock = useCallback((code: string) => {
    commit(current => ({ ...current, items: current.items.filter(item => item.code !== code) }));
    delete alerted.current[code];
    delete volatilitiesRef.current[code];
    setVolatilities(current => { const next = { ...current }; delete next[code]; return next; });
    setShares(current => { const next = { ...current }; delete next[code]; return next; });
  }, [commit]);

  const updateConfig = useCallback((code: string, patch: Partial<TConfig>) => {
    commit(current => ({
      ...current,
      items: current.items.map(item => {
        if (item.code !== code) return item;
        const rolledTradeIds = patch.baseShares !== undefined
          ? collectRolledTradeIdsThrough(current, code, shanghaiDay())
          : item.rolledTradeIds;
        return {
          ...item,
          config: normalizeTConfig({ ...item.config, ...patch }, code),
          ...(rolledTradeIds ? { rolledTradeIds } : {})
        };
      })
    }));
  }, [commit]);

  const addTrade = useCallback((day: string, code: string, trade: Omit<TTrade, "id">) => {
    try {
      commit(current => withTrades(current, day, code, list => [...list, { ...trade, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }]));
      return "";
    } catch (error) {
      return userErrorText(error, "成交登记失败");
    }
  }, [commit]);

  const removeTrade = useCallback((day: string, code: string, id: string) => {
    commit(current => withTrades(current, day, code, list => list.filter(trade => trade.id !== id)));
  }, [commit]);

  const setVoice = useCallback((voice: boolean) => {
    if (!voice) window.speechSynthesis?.cancel();
    commit(current => ({ ...current, voice }));
  }, [commit]);
  const setShowReplay = useCallback((showReplay: boolean) => commit(current => ({ ...current, showReplay })), [commit]);
  const refresh = useCallback((code?: string) => {
    const item = code ? storeRef.current.items.find(entry => entry.code === code) : null;
    return item ? loadOne(item, false) : loadAll(false);
  }, [loadAll, loadOne]);

  return { store, runtimes, saveError, addStock, removeStock, updateConfig, addTrade, removeTrade, setVoice, setShowReplay, refresh };
}
