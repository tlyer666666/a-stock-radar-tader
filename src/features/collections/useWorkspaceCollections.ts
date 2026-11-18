import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createCollectionWriter } from "../../collectionWriter";
import { initialSettings, normalizeSettings } from "../../domain/settings";
import { createLatestSettingsWriter } from "../../latestSettingsWriter";
import { mergeObservationPool } from "../../observationPool";
import type { AnalysisPayload } from "../market/analysisTypes";
import { appendHoldingTradeRecord, applyHoldingTrade, type HoldingTradeSide } from "./holdingsLedger";

type UseWorkspaceCollectionsOptions = {
  payload: AnalysisPayload | null;
  showToast: (message: string) => void;
};

export function useWorkspaceCollections({
  payload,
  showToast
}: UseWorkspaceCollectionsOptions) {
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [holdings, setHoldings] = useState<HoldingItem[]>([]);
  const [settings, setSettings] = useState<Settings>(initialSettings);
  const [settingsLoadState, setSettingsLoadState] = useState<"loading" | "ready" | "failed">("loading");
  const [version, setVersion] = useState("0.1.0");

  const watchlistRef = useRef<WatchItem[]>([]);
  const holdingsRef = useRef<HoldingItem[]>([]);
  const watchlistLoaded = useRef(false);
  const watchlistReady = useRef<Promise<boolean>>(Promise.resolve(false));
  const holdingsLoaded = useRef(false);
  const settingsRef = useRef<Settings>(normalizeSettings(initialSettings));
  const settingsLoaded = useRef(false);

  const watchlistWriter = useRef<ReturnType<typeof createCollectionWriter<WatchItem>> | null>(null);
  const holdingsWriter = useRef<ReturnType<typeof createCollectionWriter<HoldingItem>> | null>(null);
  const settingsWriterRef = useRef<ReturnType<typeof createLatestSettingsWriter<Settings>> | null>(null);

  if (!watchlistWriter.current) {
    watchlistWriter.current = createCollectionWriter<WatchItem>({
      read: () => watchlistRef.current,
      persist: next => window.stockApi.saveWatchlist(next),
      accept: saved => {
        watchlistRef.current = saved;
        setWatchlist(saved);
      }
    });
  }
  if (!holdingsWriter.current) {
    holdingsWriter.current = createCollectionWriter<HoldingItem>({
      read: () => holdingsRef.current,
      persist: next => window.stockApi.saveHoldings(next),
      accept: saved => {
        holdingsRef.current = saved;
        setHoldings(saved);
      }
    });
  }
  if (!settingsWriterRef.current) {
    settingsWriterRef.current = createLatestSettingsWriter<Settings>({
      read: () => settingsRef.current,
      normalize: normalizeSettings,
      persist: next => window.stockApi.saveSettings(next),
      accept: saved => {
        settingsRef.current = saved;
        setSettings(saved);
      }
    });
  }

  useEffect(() => {
    settingsRef.current = normalizeSettings(settings);
  }, [settings]);

  useEffect(() => {
    let active = true;
    let reportedFailure = false;
    const failed = () => {
      if (active && !reportedFailure) {
        reportedFailure = true;
        showToast("部分本地设置未加载，可继续使用趋势工作台");
      }
    };
    // Independent reads publish independently; a slow collection must not hide
    // another successful read. The promise boundary also contains sync bridges.
    watchlistReady.current = Promise.resolve().then(() => window.stockApi.getWatchlist()).then(value => {
      if (!active) return false;
      if (!Array.isArray(value)) { failed(); return false; }
      watchlistLoaded.current = true;
      watchlistRef.current = value;
      setWatchlist(value);
      return true;
    }).catch(() => { failed(); return false; });
    Promise.resolve().then(() => window.stockApi.getHoldings()).then(value => {
      if (!active) return;
      if (!Array.isArray(value)) { failed(); return; }
      holdingsLoaded.current = true;
      holdingsRef.current = value;
      setHoldings(value);
    }).catch(failed);
    Promise.resolve().then(() => window.stockApi.getVersion()).then(value => {
      if (active) setVersion(value);
    }).catch(failed);
    return () => { active = false; };
  }, [showToast]);

  useEffect(() => {
    let active = true;
    window.stockApi.getSettings().then(value => {
      if (!active) return;
      const loaded = normalizeSettings(value);
      settingsRef.current = loaded;
      settingsLoaded.current = true;
      setSettings(loaded);
      setSettingsLoadState("ready");
    }).catch(() => {
      if (active) setSettingsLoadState("failed");
    });
    return () => { active = false; };
  }, []);

  const persistSettings = useCallback((patch: Partial<Settings> | ((current: Settings) => Partial<Settings>)) => {
    if (!settingsLoaded.current) {
      return Promise.reject(new Error("本地设置尚未成功读取，请重新加载后再保存，原配置未更改。"));
    }
    return settingsWriterRef.current!(patch);
  }, []);

  const setThemeMode = useCallback(async (theme: Settings["theme"]) => {
    try { await persistSettings({ theme }); }
    catch { showToast("主题保存失败"); }
  }, [persistSettings, showToast]);

  const mergeWatchlistObservations = useCallback(async (recent: WatchItem[], waitForReady = false) => {
    if (!recent.length) return;
    if (waitForReady && !(await watchlistReady.current)) return;
    if (!watchlistLoaded.current) return;
    await watchlistWriter.current!(current => mergeObservationPool(current, recent));
  }, []);

  const observationItems = useMemo(
    () => watchlist.filter(item =>
      item.autoAdded &&
      Number(item.tradingDaysSince) >= 1 &&
      Number(item.tradingDaysSince) <= 10
    ),
    [watchlist]
  );
  const favoriteItems = useMemo(
    () => watchlist.filter(item => item.favorite || !item.autoAdded),
    [watchlist]
  );
  const favoriteCodes = useMemo(() => new Set(favoriteItems.map(item => item.code)), [favoriteItems]);
  const isFavorite = useMemo(
    () => !!payload && favoriteItems.some(item => item.code === payload.security.code),
    [payload, favoriteItems]
  );

  const toggleFavorite = useCallback(async (security = payload?.security) => {
    if (!security) return;
    if (!watchlistLoaded.current) { showToast("自选列表尚未加载，请稍后重试"); return; }
    const displayed = watchlistRef.current.find(item => item.code === security.code);
    const currentlyFavorite = Boolean(displayed && (displayed.favorite || !displayed.autoAdded));
    try {
      await watchlistWriter.current!(current => {
        const existing = current.find(item => item.code === security.code);
        const next: WatchItem[] = currentlyFavorite
          ? existing?.autoAdded
            ? current.map(item =>
                item.code === security.code
                  ? (() => {
                      const updated = { ...item, favorite: false };
                      delete updated.favoriteAddedAt;
                      return updated;
                    })()
                  : item
              )
            : current.filter(item => item.code !== security.code)
          : existing
            ? current.map(item =>
                item.code === security.code
                  ? { ...item, favorite: true, favoriteAddedAt: new Date().toISOString() }
                  : item
              )
            : [
                ...current,
                {
                  ...security,
                  createdAt: new Date().toISOString(),
                  favoriteAddedAt: new Date().toISOString(),
                  favorite: true,
                  autoAdded: false,
                  note: ""
                }
              ];
        return next;
      });
      showToast(currentlyFavorite ? "已移出自选板块" : "已加入自选板块");
    } catch { showToast("自选保存失败，已保留原有列表"); }
  }, [payload?.security, showToast]);

  const removeObservation = useCallback(async (security: WatchItem) => {
    if (!watchlistLoaded.current) { showToast("观察列表尚未加载，请稍后重试"); return; }
    try {
      await watchlistWriter.current!(current => current.flatMap(item => item.code !== security.code
        ? [item]
        : item.favorite || !item.autoAdded ? [{ ...item, autoAdded: false }] : []));
      showToast("已从当前观察列表移除");
    } catch { showToast("观察列表保存失败，已保留原有列表"); }
  }, [showToast]);

  const saveHoldings = useCallback(async (update: (items: HoldingItem[]) => HoldingItem[]) => {
    if (!holdingsLoaded.current) { showToast("持仓列表尚未加载，请稍后重试"); return false; }
    let validationError: Error | null = null;
    try {
      await holdingsWriter.current!(current => {
        try {
          return update(current);
        } catch (err) {
          validationError = err instanceof Error ? err : new Error(String(err));
          throw validationError;
        }
      });
      return true;
    } catch {
      if (validationError) throw validationError;
      showToast("持仓保存失败，未覆盖原有数据");
      return false;
    }
  }, [showToast]);

  const addFavoriteSecurity = useCallback(async (security: Security) => {
    if (!security?.code) return;
    if (favoriteCodes.has(security.code)) {
      showToast(`${security.name} ${security.code} 已在自选股中`);
      return;
    }
    await toggleFavorite(security);
  }, [favoriteCodes, showToast, toggleFavorite]);

  const handleQuickHoldingTrade = useCallback(async (input: {
    code: string;
    name?: string;
    secid?: string;
    side: HoldingTradeSide;
    shares: number;
    price: number;
    diluteCost?: boolean;
  }) => {
    const preview = applyHoldingTrade({
      items: holdingsRef.current,
      code: input.code,
      ...(input.name ? { name: input.name } : {}),
      ...(input.secid ? { secid: input.secid } : {}),
      side: input.side,
      shares: input.shares,
      price: input.price,
      ...(input.diluteCost !== undefined ? { diluteCost: input.diluteCost } : {})
    });
    if (!preview.ok) {
      showToast(preview.error);
      return false;
    }
    let feedback = preview.summary;
    let settledRealizedPnl: number | null = preview.realizedPnl;
    let settledName = input.name || holdingsRef.current.find(item => item.code === input.code)?.name || input.code;
    let validationMessage = "";
    try {
      const saved = await saveHoldings(current => {
        const prevItem = current.find(item => item.code === input.code);
        const outcome = applyHoldingTrade({
          items: current,
          code: input.code,
          ...(input.name ? { name: input.name } : {}),
          ...(input.secid ? { secid: input.secid } : {}),
          side: input.side,
          shares: input.shares,
          price: input.price,
          ...(input.diluteCost !== undefined ? { diluteCost: input.diluteCost } : {})
        });
        if (!outcome.ok) {
          validationMessage = outcome.error;
          throw new Error(outcome.error);
        }
        feedback = outcome.summary;
        settledRealizedPnl = outcome.realizedPnl;
        settledName = input.name || prevItem?.name || outcome.nextItems.find(item => item.code === input.code)?.name || input.code;
        return outcome.nextItems;
      });
      if (saved && feedback) {
        appendHoldingTradeRecord({
          code: input.code,
          name: settledName,
          side: input.side,
          shares: input.shares,
          price: input.price,
          realizedPnl: settledRealizedPnl
        });
        showToast(feedback);
        return true;
      }
      return false;
    } catch (error) {
      showToast(validationMessage || (error instanceof Error ? error.message : "加减仓记账失败"));
      return false;
    }
  }, [saveHoldings, showToast]);

  return {
    watchlist,
    holdings,
    settings,
    settingsRef,
    settingsLoadState,
    version,
    persistSettings,
    setThemeMode,
    mergeWatchlistObservations,
    observationItems,
    favoriteItems,
    favoriteCodes,
    isFavorite,
    toggleFavorite,
    removeObservation,
    saveHoldings,
    addFavoriteSecurity,
    handleQuickHoldingTrade
  };
}
