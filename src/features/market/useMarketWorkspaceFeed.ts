import { FormEvent, type MutableRefObject, useCallback, useEffect, useRef, useState } from "react";
import { shanghaiDateTag } from "../../dateUtils";
import { enrichAnalysisWithExecution } from "../../domain/executionProjection";
import type { FailedBoardCache, FailedBoardViewState } from "../dashboard/PreviousLimitUpFailedBoards";
import type { AnalysisPayload } from "./analysisTypes";
import { limitPoolProviderLabel } from "./marketLabels";
import { LIMIT_POOL_REFRESH_EVENT } from "../dashboard/limitUpPoolModel";
import type { WorkspaceView as View } from "../../workspaceView";
import { isTradingDay } from "../notes/notesModel";
import { startVisibleInterval } from "../../visiblePolling";
import { userErrorText } from "../../userErrorText";

export type LimitPoolMeta = {
  dataDate: string;
  fetchedAt: string;
  checkedAt: string;
  providers: string[];
  count: number;
  trigger: "startup" | "auto" | "manual";
};

export type SectorStrengthExtra = Pick<
  SectorStrengthBoard,
  "concepts" | "themes" | "warnings" | "conceptLimitUpSource" | "limitUpTotal" | "fetchedAt"
>;

export type LimitPoolRowRecord = Record<string, unknown> & { code?: unknown };

/** 交给 AI 解读的板块强度榜：每个板块只留数字和文字字段，成分股只留前 3 个名称。 */
export function sectorsForAi(rows: Array<Record<string, unknown>>, extra?: SectorStrengthExtra | null) {
  const industries = rows.slice(0, 20).map(row => {
    const returns = row?.returns && typeof row.returns === "object"
      ? (row.returns as Record<string, unknown>)
      : null;
    const leaders = Array.isArray(row?.leaders) ? (row.leaders as Array<Record<string, unknown>>) : [];
    return {
      name: row?.name,
      changePct: returns?.r1 ?? row?.memberAverageReturn ?? null,
      limitUps: row?.poolLimitUps ?? row?.limitUps ?? null,
      netInflow: row?.netInflow ?? null,
      memberCount: row?.memberCount ?? null,
      leader: row?.leaderName || "",
      limitUpStocks: leaders.slice(0, 3).map(item => item?.name).filter(Boolean)
    };
  });
  if (!extra) return industries;
  const concepts = [...extra.concepts]
    .sort((a, b) => (b.limitUps ?? 0) - (a.limitUps ?? 0) || b.changePct - a.changePct)
    .slice(0, 15)
    .map(row => ({
      name: row.name,
      changePct: row.changePct,
      limitUps: row.limitUps,
      netInflow: row.netInflow,
      limitUpStocks: row.limitUpStocks.slice(0, 3).map(item => item.name)
    }));
  return {
    industries,
    concepts,
    themes: extra.themes.slice(0, 10).map(theme => ({
      reason: theme.reason,
      count: theme.count,
      stocks: theme.stocks.slice(0, 4).map(item => item.name)
    }))
  };
}

const limitPoolSignature = (rows: Array<Record<string, unknown>> = [], dataDate = "") => [
  String(dataDate || ""),
  ...rows
    .filter((item) => item && typeof item === "object")
    .slice()
    .sort((left, right) => String(left?.code || "").localeCompare(String(right?.code || "")))
    .map((item) => JSON.stringify([
      item?.code ?? "",
      item?.name ?? "",
      item?.industry ?? "",
      item?.limitReason ?? "",
      item?.latest ?? null,
      item?.changePct ?? null,
      item?.turnover ?? null,
      item?.amount ?? null,
      item?.firstSealTime ?? "",
      item?.lastSealTime ?? "",
      item?.sealedAmount ?? null,
      item?.sealFloatRatio ?? null,
      item?.openBoardCount ?? null,
      item?.consecutiveBoards ?? null
    ]))
].join("|");

type UseMarketWorkspaceFeedParams = {
  view: View;
  dashboardMode: "pool" | "analysis";
  researchView: boolean;
  live: boolean;
  payload: AnalysisPayload | null;
  setPayload: React.Dispatch<React.SetStateAction<AnalysisPayload | null>>;
  latestAnalysis: MutableRefObject<AnalysisPayload | null>;
  analysisRequestId: MutableRefObject<number>;
  settings: Settings;
  settingsRef: MutableRefObject<Settings>;
  settingsLoadState: "loading" | "ready" | "failed";
  onPaperQuoteSync: (payload: AnalysisPayload) => void;
  onMergeWatchlistObservations: (recent: WatchItem[], waitForReady?: boolean) => Promise<void>;
  onOpenSecurity: (security: Security | string) => void;
  showToast: (message: string) => void;
};

export function useMarketWorkspaceFeed({
  view,
  dashboardMode,
  researchView,
  live,
  payload,
  setPayload,
  latestAnalysis,
  analysisRequestId,
  settings,
  settingsRef,
  settingsLoadState,
  onPaperQuoteSync,
  onMergeWatchlistObservations,
  onOpenSecurity,
  showToast
}: UseMarketWorkspaceFeedParams) {
  const legacyBootstrapped = useRef(false);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<Security[]>([]);
  const searchBoxRef = useRef<HTMLFormElement>(null);
  const [searchComposing, setSearchComposing] = useState(false);
  const searchComposingRef = useRef(false);
  const searchEditVersion = useRef(0);
  const [analysisTarget, setAnalysisTarget] = useState<Security | string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchComplete, setSearchComplete] = useState(false);
  const [error, setError] = useState("");
  const [sourceHealth, setSourceHealth] = useState<MarketSourceHealth | null>(null);
  const [limitUps, setLimitUps] = useState<LimitPoolRowRecord[]>([]);
  const [limitPoolMeta, setLimitPoolMeta] = useState<LimitPoolMeta>({
    dataDate: "",
    fetchedAt: "",
    checkedAt: "",
    providers: [],
    count: 0,
    trigger: "startup"
  });
  const failedBoardCache = useRef<FailedBoardCache | null>(null);
  const failedBoardViewState = useRef<FailedBoardViewState | undefined>(undefined);
  const rememberFailedBoardCache = useCallback((value: FailedBoardCache) => { failedBoardCache.current = value; }, []);
  const rememberFailedBoardViewState = useCallback((value: FailedBoardViewState) => { failedBoardViewState.current = value; }, []);
  const [discovering, setDiscovering] = useState(false);
  const [sectorLegacyOpen, setSectorLegacyOpen] = useState(false);
  const [sectorBoard, setSectorBoard] = useState<Array<Record<string, unknown>>>([]);
  const [sectorBoardLoading, setSectorBoardLoading] = useState(false);
  const [sectorBoardLoaded, setSectorBoardLoaded] = useState(false);
  const [sectorBoardError, setSectorBoardError] = useState("");
  const [sectorExtra, setSectorExtra] = useState<SectorStrengthExtra | null>(null);

  const searchTimer = useRef<number | undefined>(undefined);
  const searchRequestId = useRef(0);
  const limitPoolRequestId = useRef(0);
  const limitPoolSignatureRef = useRef("");
  // B-01：15s 轮询每次都会拿到一个新数组。若内容完全一致仍替换状态引用，依赖
  // limitUps 的页面（资讯中心）会把"引用变了"当成"股票池变了"，于是清空列表并重载，
  // 表现为每 15 秒闪一次。用内容快照比较，只有内容真的变化才更新引用。
  const limitPoolRowsJsonRef = useRef("");
  const limitPoolManualRefresh = useRef(false);
  const sectorBoardRequestId = useRef(0);
  const sectorBoardBusy = useRef(false);
  const activeAnalysisLoads = useRef(0);
  const sectorFetchedAtRef = useRef("");

  const paperSyncRef = useRef(onPaperQuoteSync);
  paperSyncRef.current = onPaperQuoteSync;
  const mergeObservationsRef = useRef(onMergeWatchlistObservations);
  mergeObservationsRef.current = onMergeWatchlistObservations;
  const openSecurityRef = useRef(onOpenSecurity);
  openSecurityRef.current = onOpenSecurity;

  const commitLimitUpPool = useCallback((snapshot: unknown, requestId: number, trigger: LimitPoolMeta["trigger"]) => {
    if (requestId !== limitPoolRequestId.current) return null;
    const obj = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as { rows?: unknown; meta?: Record<string, unknown> })
      : null;
    if (!Array.isArray(snapshot) && !Array.isArray(obj?.rows)) {
      throw new Error("涨停池响应结构异常，已保留上次有效数据");
    }
    const rows = (Array.isArray(snapshot) ? snapshot : obj!.rows) as LimitPoolRowRecord[];
    const responseMeta = obj?.meta && typeof obj.meta === "object" ? obj.meta : {};
    const dataDate = String(responseMeta.dataDate || rows[0]?.limitDate || "");
    const signature = limitPoolSignature(rows, dataDate);
    const previousSignature = limitPoolSignatureRef.current;
    const providers = Array.isArray(responseMeta.providers)
      ? responseMeta.providers.map(String)
      : [...new Set(rows.map((item) => String(item?.dataProvider || "")).filter(Boolean))];
    const nextMeta: LimitPoolMeta = {
      dataDate,
      fetchedAt: String(responseMeta.fetchedAt || new Date().toISOString()),
      checkedAt: new Date().toISOString(),
      providers,
      count: rows.length,
      trigger
    };
    limitPoolSignatureRef.current = signature;
    const rowsJson = JSON.stringify(rows);
    const rowsChanged = rowsJson !== limitPoolRowsJsonRef.current;
    limitPoolRowsJsonRef.current = rowsJson;
    if (rowsChanged) setLimitUps(rows);
    setLimitPoolMeta(nextMeta);
    return {
      changed: signature !== previousSignature,
      meta: nextMeta,
      rows
    };
  }, []);

  const loadSecurity = useCallback(async (
    security: Security | string,
    silent = false,
    forceRefresh = false
  ) => {
    activeAnalysisLoads.current++;
    const requestId = ++analysisRequestId.current;
    const submittedSearchVersion = searchEditVersion.current;
    if (!silent) {
      setAnalysisTarget(security);
      setPayload(null);
      setLoading(true);
      setError("");
      searchRequestId.current += 1;
      window.clearTimeout(searchTimer.current);
      setSuggestions([]);
      setSearching(false);
      setSearchError("");
      setSearchComplete(false);
    }
    try {
      const next = await window.stockApi.analyze(security, { forceRefresh });
      if (requestId !== analysisRequestId.current) return;
      const nextPayload = enrichAnalysisWithExecution(next, settingsRef.current);
      setPayload(nextPayload);
      setAnalysisTarget(nextPayload.security);
      paperSyncRef.current(nextPayload);
      if (!silent && searchEditVersion.current === submittedSearchVersion) setQuery("");
      if (next.warning) showToast(next.warning);
    } catch (e) {
      if (requestId !== analysisRequestId.current) return;
      if (silent) showToast("刷新失败，继续显示上次有效行情");
      else setError(userErrorText(e));
    } finally {
      activeAnalysisLoads.current--;
      if (requestId === analysisRequestId.current) setLoading(false);
    }
  }, [analysisRequestId, setPayload, settingsRef, showToast]);

  // Load the original market tools only when opened, keeping their network work
  // and five-day strategy controls out of the dedicated trend workflow.
  useEffect(() => {
    if (researchView || legacyBootstrapped.current) return;
    legacyBootstrapped.current = true;
    const requestId = ++limitPoolRequestId.current;
    void Promise.allSettled([
      Promise.resolve().then(() => window.stockApi.getLimitUpPoolSnapshot()),
      Promise.resolve().then(() => window.stockApi.discoverRecentLimitUps(11))
    ]).then(async ([poolResult, recentResult]) => {
      const recent = recentResult.status === "fulfilled" && Array.isArray(recentResult.value) ? recentResult.value : [];
      const snapshot = poolResult.status === "fulfilled"
        ? poolResult.value
        : { rows: recent.filter((item: WatchItem) => item.tradingDaysSince === 0), meta: {} };
      try {
        commitLimitUpPool(snapshot, requestId, "startup");
      } catch (reason) {
        const message = userErrorText(reason, "涨停行情响应异常，请稍后刷新");
        setError(message);
        showToast(message);
      }
      await mergeObservationsRef.current(recent, true);
      if (poolResult.status === "rejected" && recentResult.status === "rejected") setError("涨停行情暂时不可用，请稍后点击刷新");
    }).catch(reason => {
      setError(userErrorText(reason, "初始化涨停行情失败，请稍后刷新"));
    });
  }, [view, researchView, commitLimitUpPool, showToast]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && searchBoxRef.current?.contains(event.target)) return;
      searchRequestId.current += 1;
      window.clearTimeout(searchTimer.current);
      setSuggestions([]);
      setSearching(false);
      setSearchError("");
      setSearchComplete(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, []);

  const fetchSecuritySuggestions = useCallback(async (searchText: string, requestId: number) => {
    setSearching(true);
    setSearchError("");
    setSearchComplete(false);
    try {
      const result = await window.stockApi.search(searchText);
      if (requestId !== searchRequestId.current) return null;
      const next = Array.isArray(result) ? result : [];
      setSuggestions(next);
      setSearchComplete(true);
      return next;
    } catch {
      if (requestId !== searchRequestId.current) return null;
      setSuggestions([]);
      setSearchError("证券搜索暂不可用，请重试");
      return null;
    } finally {
      if (requestId === searchRequestId.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    const requestId = ++searchRequestId.current;
    window.clearTimeout(searchTimer.current);
    setSuggestions([]);
    setSearchError("");
    setSearchComplete(false);
    if (!query.trim() || searchComposing) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const searchText = query.trim();
    searchTimer.current = window.setTimeout(() => {
      void fetchSecuritySuggestions(searchText, requestId);
    }, 220);
    return () => {
      window.clearTimeout(searchTimer.current);
      if (requestId === searchRequestId.current) searchRequestId.current += 1;
    };
  }, [query, searchComposing, fetchSecuritySuggestions]);

  useEffect(() => {
    if (settingsLoadState !== "ready" || typeof window.stockApi?.getMarketSourceHealth !== "function") return;
    let active = true;
    const readHealth = async () => {
      try {
        const next = await window.stockApi.getMarketSourceHealth!();
        if (active) setSourceHealth(next);
      } catch {
        // 健康度只用于提示，读取失败不影响行情本身。
      }
    };
    const stop = startVisibleInterval(() => {
      void readHealth();
    }, 15_000, { immediate: true });
    return () => {
      active = false;
      stop();
    };
  }, [settingsLoadState]);

  useEffect(() => {
    if (!live || !payload || view !== "dashboard" || dashboardMode !== "analysis") return;
    let active = true;
    let busy = false;
    const security = payload.security;
    const refreshQuote = async () => {
      if (busy) return;
      busy = true;
      try {
        const analysisGeneration = analysisRequestId.current;
        const snapshot = await window.stockApi.getQuoteSnapshot(security);
        const current = latestAnalysis.current;
        if (!active || analysisGeneration !== analysisRequestId.current || !current || current.security.code !== security.code) return;
        const next = enrichAnalysisWithExecution({
          ...current,
          quote: {
            ...current.quote,
            ...snapshot.quote,
            name: snapshot.quote?.name || current.quote.name,
            industry: snapshot.quote?.industry || current.quote.industry
          },
          actualProvider: snapshot.actualProvider || current.actualProvider,
          updatedAt: snapshot.updatedAt || new Date().toISOString()
        }, settingsRef.current);
        latestAnalysis.current = next;
        setPayload(next);
        paperSyncRef.current(next);
      } catch {
        // The last valid quote stays visible; the slower full refresh can recover.
      } finally {
        busy = false;
      }
    };
    const stop = startVisibleInterval(
      () => { void refreshQuote(); },
      Math.max(3, Number(settings.quoteRefreshSeconds) || 5) * 1000
    );
    return () => {
      active = false;
      stop();
    };
  }, [analysisRequestId, dashboardMode, latestAnalysis, live, payload?.security.code, setPayload, settings.quoteRefreshSeconds, settingsRef, view]);

  useEffect(() => {
    if (
      !payload ||
      !live ||
      settings.multiSourceEnabled === false ||
      view !== "dashboard" ||
      dashboardMode !== "analysis"
    ) return;
    let active = true;
    let busy = false;
    const security = payload.security;
    const refreshFederation = async () => {
      if (busy) return;
      busy = true;
      try {
        const federation = await window.stockApi.getDataFederation(security);
        if (!active) return;
        setPayload((current) =>
          current?.security.code === security.code
            ? { ...current, dataFederation: federation }
            : current
        );
      } catch {
        // Primary quote remains available even if an auxiliary verifier fails.
      } finally {
        busy = false;
      }
    };
    const stop = startVisibleInterval(() => {
      void refreshFederation();
    }, 30_000, { immediate: true });
    return () => {
      active = false;
      stop();
    };
  }, [dashboardMode, live, payload?.security.code, setPayload, settings.multiSourceEnabled, view]);

  useEffect(() => {
    if (!live || !payload || view !== "dashboard" || dashboardMode !== "analysis") return;
    return startVisibleInterval(
      () => { if (activeAnalysisLoads.current === 0) void loadSecurity(payload.security, true); },
      Math.max(60, settings.refreshSeconds) * 1000
    );
  }, [live, payload?.security.code, settings.refreshSeconds, loadSecurity, view, dashboardMode]);

  useEffect(() => {
    if (!live || researchView) return;
    let active = true;
    let busy = false;
    const refreshPool = async () => {
      if (busy || limitPoolManualRefresh.current) return;
      busy = true;
      const requestId = ++limitPoolRequestId.current;
      try {
        const snapshot = await window.stockApi.getLimitUpPoolSnapshot();
        if (active) commitLimitUpPool(snapshot, requestId, "auto");
      } catch {
        // Keep the most recent complete pool during a transient source failure.
      } finally {
        busy = false;
      }
    };
    const stop = startVisibleInterval(() => { void refreshPool(); }, 15_000);
    return () => {
      active = false;
      stop();
    };
  }, [commitLimitUpPool, live, researchView]);

  useEffect(() => {
    if (!live || researchView) return;
    let active = true;
    let busy = false;
    const refreshObservationPool = async () => {
      if (busy) return;
      busy = true;
      try {
        const recent = await window.stockApi.discoverRecentLimitUps(11);
        if (!active) return;
        await mergeObservationsRef.current(recent);
      } catch {
        // Keep the last complete ten-day pool until the data source recovers.
      } finally {
        busy = false;
      }
    };
    const stop = startVisibleInterval(() => { void refreshObservationPool(); }, 60_000);
    return () => {
      active = false;
      stop();
    };
  }, [live, researchView]);

  const loadSectorBoard = useCallback(async (forceRefresh = false) => {
    if (sectorBoardBusy.current && !forceRefresh) return false;
    sectorBoardBusy.current = true;
    const requestId = ++sectorBoardRequestId.current;
    setSectorBoardLoading(true);
    try {
      // 1.6.43：行业 + 概念两张榜和今日涨停主线一次取回；旧接口只给行业榜。
      const board = window.stockApi.getSectorStrengthBoard ? await window.stockApi.getSectorStrengthBoard({ forceRefresh }) : null;
      const rows = board ? board.industries : await window.stockApi.getLimitUpSectorBoard({ forceRefresh });
      if (!Array.isArray(rows)) throw new Error("板块排行响应结构异常，已保留上次有效数据");
      if (requestId !== sectorBoardRequestId.current) return false;
      setSectorBoard(rows);
      if (board) {
        setSectorExtra({
          concepts: Array.isArray(board.concepts) ? board.concepts : [],
          themes: Array.isArray(board.themes) ? board.themes : [],
          warnings: Array.isArray(board.warnings) ? board.warnings : [],
          conceptLimitUpSource: board.conceptLimitUpSource || "",
          limitUpTotal: board.limitUpTotal ?? null,
          fetchedAt: board.fetchedAt || ""
        });
      }
      sectorFetchedAtRef.current = board?.fetchedAt || new Date().toISOString();
      setSectorBoardError("");
      setSectorBoardLoaded(true);
      if (forceRefresh) showToast("板块排行已刷新");
      return true;
    } catch (e) {
      if (requestId !== sectorBoardRequestId.current) return false;
      const message = userErrorText(e, "涨停板块对比加载失败");
      setSectorBoardError(message);
      showToast(message);
      return false;
    } finally {
      if (requestId === sectorBoardRequestId.current) {
        setSectorBoardLoading(false);
        sectorBoardBusy.current = false;
      }
    }
  }, [showToast]);

  // 板块强度页打开时，交易时段（北京时间工作日 9:15–11:30、13:00–15:05）每分钟静默刷新一次榜单；
  // 收盘后和午休不刷新（数据不变，也避免反复调用按次计费的扶摇接口）；页面不可见时跳过。
  useEffect(() => {
    if (view !== "sectors" || !live) return;
    const inSession = () => {
      const cn = new Date(Date.now() + 8 * 3600_000);
      const date = cn.toISOString().slice(0, 10);
      const minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
      return isTradingDay(date) && ((minute >= 9 * 60 + 15 && minute <= 11 * 60 + 30) || (minute >= 13 * 60 && minute <= 15 * 60 + 5));
    };
    // 从别的页面切回来时，手里的榜单可能是几分钟前的（比如开盘前看过一次，涨停家数还都是 0）：超过 30 秒就马上刷新，不等下一分钟。
    const age = Date.now() - Date.parse(sectorFetchedAtRef.current || "");
    if (sectorFetchedAtRef.current && inSession() && !(age < 30_000)) void loadSectorBoard(false);
    return startVisibleInterval(() => {
      if (!inSession()) return;
      void loadSectorBoard(false);
    }, 60_000);
  }, [view, live, loadSectorBoard]);

  useEffect(() => {
    // 榜单是主视图，进入「板块强度」即加载，不再等折叠块展开
    if (view === "sectors" && !sectorBoardLoaded && !sectorBoardLoading && !sectorBoardError) {
      void loadSectorBoard(false);
    }
  }, [view, sectorBoardLoaded, sectorBoardLoading, sectorBoardError, loadSectorBoard]);

  const handleSearch = async (event: FormEvent) => {
    event.preventDefault();
    if (searchComposingRef.current || !query.trim()) return;
    window.clearTimeout(searchTimer.current);
    const requestId = ++searchRequestId.current;
    if (suggestions[0]) {
      setSearchComplete(false);
      setSearchError("");
      setSearching(false);
      openSecurityRef.current(suggestions[0]);
    } else if (/^\d{6}$/.test(query.trim())) {
      setSearchComplete(false);
      setSearchError("");
      setSearching(false);
      openSecurityRef.current(query.trim());
    } else {
      const next = await fetchSecuritySuggestions(query.trim(), requestId);
      if (requestId === searchRequestId.current && next?.[0]) {
        setSearchComplete(false);
        openSecurityRef.current(next[0]);
      }
    }
  };

  const discover = async () => {
    if (limitPoolManualRefresh.current) return;
    limitPoolManualRefresh.current = true;
    setDiscovering(true);
    window.dispatchEvent(new CustomEvent(LIMIT_POOL_REFRESH_EVENT));
    const requestId = ++limitPoolRequestId.current;
    try {
      const snapshot = await window.stockApi.getLimitUpPoolSnapshot({ forceRefresh: true });
      const result = commitLimitUpPool(snapshot, requestId, "manual");
      if (!result) return;
      setError("");
      const source = limitPoolProviderLabel(result.meta.providers);
      const dateLabel = result.meta.dataDate || "最近交易日";
      const datePrefix = result.meta.dataDate && result.meta.dataDate !== shanghaiDateTag()
        ? `当前显示最近交易日 ${dateLabel}`
        : `${dateLabel}`;
      showToast(
        result.changed
          ? `${datePrefix} · 涨停池已更新：${result.rows.length}只 · ${source}`
          : `${datePrefix} · 涨停池已核对，暂无变化：${result.rows.length}只 · ${source}`
      );
    } catch (e) {
      showToast(userErrorText(e, "涨停池更新失败"));
    } finally {
      limitPoolManualRefresh.current = false;
      setDiscovering(false);
    }
  };

  return {
    query,
    setQuery,
    suggestions,
    setSuggestions,
    searchBoxRef,
    searchComposing,
    setSearchComposing,
    searchComposingRef,
    searchEditVersion,
    searchTimer,
    searchRequestId,
    analysisTarget,
    loading,
    searching,
    setSearching,
    searchError,
    setSearchError,
    searchComplete,
    setSearchComplete,
    error,
    sourceHealth,
    limitUps,
    limitPoolMeta,
    failedBoardCache,
    failedBoardViewState,
    rememberFailedBoardCache,
    rememberFailedBoardViewState,
    discovering,
    sectorLegacyOpen,
    setSectorLegacyOpen,
    sectorBoard,
    sectorBoardLoading,
    sectorBoardError,
    setSectorBoardError,
    sectorExtra,
    loadSecurity,
    fetchSecuritySuggestions,
    loadSectorBoard,
    handleSearch,
    discover
  };
}
