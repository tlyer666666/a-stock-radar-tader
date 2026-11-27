import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownUp,
  ArrowUpRight,
  BellRing,
  BookOpenCheck,
  Bot,
  Check,
  Crosshair,
  Gauge,
  Layers3,
  Newspaper,
  NotebookPen,
  Radar,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  X
} from "lucide-react";
import { archiveTrendPlan, expireStaleTrendPlans, readTrendPlans, PLAN_COCKPIT_TRADING_DAYS, type SavedTrendPlan } from "../../trendWorkspace";
import QuickPlanModal, { type QuickPlanTarget } from "../../components/QuickPlanModal";
import type { WorkspaceView } from "../../workspaceView";
import type { CopilotAlertItem, MarketSessionPhase } from "../../copilotBriefing";
import { inferAssetType, inferSecid } from "../../domain/securityIdentifiers";
import { startVisibleInterval } from "../../visiblePolling";
import { newsTimeText, shanghaiDateTag } from "../../dateUtils";
import type { NotesApi } from "../notes/useNotes";
import type { TAssistantApi } from "../t-assistant/useTAssistant";
import type { StockMonitorAlert } from "../../useStockMonitors";
import type { StockMonitorConfig, StockMonitorEvaluation } from "../../stockMonitorRules";
import { settleTrades } from "../t-assistant/tEngine";
import { buildStopLossMonitorConfig, maskSensitiveText } from "../collections/holdingsLedger";
import {
  buildMarketPulse,
  buildMorningPriorities,
  buildPreopenAuctionRows,
  buildUnifiedSentinels,
  reconcilePlansAfterClose,
  resolveDefaultCockpitMode,
  type CockpitQuote,
  type CockpitSessionMode,
  type MarketPulse,
  type MorningPriorityItem
} from "./cockpitModel";
import MarketPulseCard from "./MarketPulseCard";
import IndexBoard from "./IndexBoard";
import { applyIndexTick, inMarketStreamWindow, mergeIndexSnapshot, type IndexBoardSnapshot } from "./indexBoardModel";
import { canOpenAgent, openAgentForMarket } from "../ai-agent/agentModel";

const MODE_META: Record<CockpitSessionMode, { label: string; badge: string; focus: string }> = {
  preopen: {
    label: "盘前准备",
    badge: "开盘前",
    focus: "开盘前看一眼：昨晚的复盘结论、持仓和自选的公告、今天能卖的仓位和提醒条件"
  },
  intraday: {
    label: "盘中哨兵",
    badge: "盘中实时",
    focus: "持仓、模拟盘、观察股、价格提醒、做T 和随心记，触发了就排在最前面"
  },
  afterclose: {
    label: "收盘后对账",
    badge: "收盘后对账",
    focus: "看观察股收在什么位置、今天做T赚了多少、AI 复盘怎么说"
  }
};

function todayShanghaiDate() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

type NewsEntry = {
  id?: string;
  title?: string;
  type?: string;
  sourceName?: string;
  publishedAt?: string;
  importance?: string;
  importanceScore?: number;
  tags?: string[];
  codes?: string[];
  relatedStocks?: Array<{ code?: string; name?: string; secid?: string }>;
  confirmation?: { status?: string; label?: string; summary?: string };
};

import type { PaperPosition } from "../../domain/paperSimulationTypes";
import type { usePaperTrading } from "../paper-simulation/usePaperTrading";

const extractCockpitQuote = (rawInput: unknown, fallbackCode = ""): CockpitQuote | null => {
  if (!rawInput || typeof rawInput !== "object") return null;
  const raw = rawInput as Record<string, unknown>;
  const security = raw.security && typeof raw.security === "object" ? (raw.security as Record<string, unknown>) : null;
  const q = raw.quote && typeof raw.quote === "object" ? (raw.quote as Record<string, unknown>) : raw;
  const code = String(q.code || security?.code || fallbackCode || "").trim();
  const price = q.latest ?? q.price ?? null;
  const numericPrice = typeof price === "number" && Number.isFinite(price)
    ? price
    : (typeof price === "string" && price.trim() !== "" && Number.isFinite(Number(price)) ? Number(price) : null);
  const pct = q.changePct;
  const numericPct = typeof pct === "number" && Number.isFinite(pct)
    ? pct
    : (typeof pct === "string" && pct.trim() !== "" && Number.isFinite(Number(pct)) ? Number(pct) : null);
  return {
    code,
    name: typeof q.name === "string" ? q.name : typeof security?.name === "string" ? security.name : undefined,
    price: numericPrice,
    latest: numericPrice,
    changePct: numericPct,
    updatedAt: typeof q.updatedAt === "string" ? q.updatedAt : typeof raw.updatedAt === "string" ? raw.updatedAt : undefined
  };
};

const ONBOARDING_DISMISSED_KEY = "a-stock-radar:onboarding-dismissed:v1";

export interface TodayCockpitProps {
  phase: MarketSessionPhase;
  holdings: HoldingItem[];
  favorites: WatchItem[];
  watchlist: WatchItem[];
  limitUps: Array<Record<string, unknown>>;
  notesApi: NotesApi;
  tAssistant: TAssistantApi;
  stockMonitors: {
    configs: Record<string, StockMonitorConfig>;
    runtimes: Record<string, StockMonitorEvaluation>;
    latestQuotes: Record<string, Record<string, unknown>>;
    alerts: StockMonitorAlert[];
    save?: ((code: string, config: StockMonitorConfig) => boolean) | undefined;
  };
  paperSummary: ReturnType<typeof usePaperTrading>["paperSummary"];
  copilotAlerts: CopilotAlertItem[];
  live: boolean;
  isDefaultView: boolean;
  privacyMask?: boolean;
  onShowToast?: ((msg: string) => void) | undefined;
  onToggleDefaultView: (enabled: boolean) => void;
  onOpenStock: (security: Security, originLabel?: string) => void;
  onNavigate: (view: WorkspaceView) => void;
  onOpenSettings?: ((category?: string) => void) | undefined;
}

export default function TodayCockpitView({
  phase,
  holdings,
  favorites,
  watchlist,
  limitUps,
  notesApi,
  tAssistant,
  stockMonitors,
  paperSummary,
  copilotAlerts,
  live,
  isDefaultView,
  privacyMask = false,
  onShowToast,
  onToggleDefaultView,
  onOpenStock,
  onNavigate,
  onOpenSettings
}: TodayCockpitProps) {
  const [manualMode, setManualMode] = useState<CockpitSessionMode | null>(null);
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(() => {
    try {
      return typeof window !== "undefined" && window.localStorage?.getItem(ONBOARDING_DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const mode = manualMode || resolveDefaultCockpitMode(phase);

  const dismissOnboarding = () => {
    setOnboardingDismissed(true);
    try {
      window.localStorage?.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch {
      // ignore storage restrictions
    }
  };

  const openSettingsCategory = (category: "ai" | "sources") => {
    if (onOpenSettings) {
      onOpenSettings(category);
      return;
    }
    if (typeof window !== "undefined" && typeof window.__aStockOpenSettings === "function") {
      window.__aStockOpenSettings(category);
      return;
    }
    onNavigate("settings");
  };

  const showOnboarding = holdings.length === 0 && favorites.length === 0 && !onboardingDismissed;

  const [plans, setPlans] = useState<SavedTrendPlan[]>(() => {
    try {
      return typeof window !== "undefined" ? readTrendPlans(window.localStorage).plans : [];
    } catch {
      return [];
    }
  });
  const [marketReview, setMarketReview] = useState<AiMarketReview | null>(null);
  const [lookback, setLookback] = useState<AiLookback | null>(null);
  const [previousDate, setPreviousDate] = useState("");
  const [leaderboard, setLeaderboard] = useState<AiOutcomesLeaderboard | null>(null);
  const [newsItems, setNewsItems] = useState<NewsEntry[]>([]);
  const [liveQuotes, setLiveQuotes] = useState<Record<string, CockpitQuote>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [pulseLoading, setPulseLoading] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState("");
  const generation = useRef(0);
  const manualRefreshInFlight = useRef(false);
  const [marketPulse, setMarketPulse] = useState<MarketPulse | null>(null);
  const [pulseState, setPulseState] = useState<"loading" | "ready" | "error">("loading");
  const pulseSeqRef = useRef(0);
  const pulseLastOkRef = useRef(0);
  const pulseLastTryRef = useRef(0);
  const [indexBoard, setIndexBoard] = useState<IndexBoardSnapshot | null>(null);
  const [indexBoardState, setIndexBoardState] = useState<"loading" | "ready" | "error">("loading");
  const indexSeqRef = useRef(0);
  const [indexTickAt, setIndexTickAt] = useState(0);
  const indexTickRef = useRef(0);
  const indexFullRef = useRef(0);
  const indexTryRef = useRef(0);
  const indexLoadingRef = useRef(false);
  const indexLastFailedRef = useRef(false);

  const activePlans = useMemo(() => plans.filter(item => !item.archivedAt), [plans]);
  const planByCode = useMemo(() => new Map(activePlans.map(plan => [plan.candidate.security.code, plan])), [activePlans]);
  const [adjustTarget, setAdjustTarget] = useState<QuickPlanTarget | null>(null);
  const adjustPlan = (plan: SavedTrendPlan) => {
    const sec = plan.candidate.security;
    setAdjustTarget({ code: sec.code, name: sec.name, secid: sec.secid, referencePrice: plan.candidate.metrics.close });
  };
  const removePlan = (plan: SavedTrendPlan) => {
    if (typeof window === "undefined" || !window.localStorage) return;
    const ok = archiveTrendPlan(window.localStorage, plan.id);
    if (ok) setPlans(readTrendPlans(window.localStorage).plans);
    onShowToast?.(ok ? `${plan.candidate.security.name} 已移出今日驾驶舱，需要时在原页面再点「+驾驶舱」即可加回` : `${plan.candidate.security.name} 移出失败：本地存储不可写`);
  };
  const planActions = (code: string) => {
    const plan = planByCode.get(code);
    if (!plan) return null;
    const sec = plan.candidate.security;
    return <span className="cockpit-plan-actions">
      <button type="button" className="table-action" onClick={() => adjustPlan(plan)} aria-label={`调整 ${sec.name} 的买点与止损`}>调整</button>
      <button type="button" className="table-action" onClick={() => removePlan(plan)} aria-label={`把 ${sec.name} 移出今日驾驶舱`}><X size={11} />移出</button>
    </span>;
  };
  /** 盘中哨兵表里给观察计划补一个当前状态标签：破止损、在买点区、已高于买点。 */
  const planStatusChip = (code: string) => {
    const row = planStatusByCode.get(code);
    if (!row || row.status === "pending" || row.status === "below-band") return null;
    const tone = row.status === "stop-hit" ? "danger" : row.status === "in-band" ? "good" : "muted";
    const label = row.status === "stop-hit" ? "已破止损" : row.status === "in-band" ? "在买点区" : "高于买点";
    return <span className={`cockpit-chip ${tone}`} title={row.detail}>{label}</span>;
  };
  const planChip = (code: string) => {
    const plan = planByCode.get(code);
    return <span key="计划" className="cockpit-chip muted" title={plan ? `加入于 ${shanghaiDateTag(plan.savedAt)}，${PLAN_COCKPIT_TRADING_DAYS} 个交易日后自动移出` : undefined}>观察{plan?.source ? ` · ${plan.source}` : ""}</span>;
  };
  const openPaperPositions = useMemo(
    () => (Array.isArray(paperSummary?.normalized?.openPositions) ? paperSummary.normalized.openPositions : []),
    [paperSummary]
  );

  const sentinelCodes = useMemo(() => {
    const codes = new Set<string>();
    holdings.forEach(item => /^\d{6}$/.test(item.code) && codes.add(item.code));
    openPaperPositions.forEach((pos: PaperPosition) => /^\d{6}$/.test(String(pos.code || "")) && codes.add(String(pos.code)));
    activePlans.forEach(plan => /^\d{6}$/.test(plan.candidate?.security?.code || "") && codes.add(plan.candidate.security.code));
    tAssistant.store.items.forEach(item => /^\d{6}$/.test(item.code) && codes.add(item.code));
    favorites.slice(0, 12).forEach(item => /^\d{6}$/.test(item.code) && codes.add(item.code));
    return [...codes].slice(0, 28);
  }, [holdings, openPaperPositions, activePlans, tAssistant.store.items, favorites]);

  const refreshContextRef = useRef({
    favorites,
    holdings,
    limitUps,
    openPaperPositions,
    sentinelCodes,
    latestQuotes: stockMonitors.latestQuotes,
    tItems: tAssistant.store.items,
    watchlist
  });
  refreshContextRef.current = {
    favorites,
    holdings,
    limitUps,
    openPaperPositions,
    sentinelCodes,
    latestQuotes: stockMonitors.latestQuotes,
    tItems: tAssistant.store.items,
    watchlist
  };

  const refreshCockpit = useCallback(async (withQuotes = true, manual = false) => {
    if (!manual && manualRefreshInFlight.current) return;
    const requestId = ++generation.current;
    if (manual) manualRefreshInFlight.current = true;
    const ctx = refreshContextRef.current;
    const currentCodes = new Set<string>(ctx.sentinelCodes);
    setRefreshing(true);
    try {
      try {
        if (typeof window !== "undefined") {
          expireStaleTrendPlans(window.localStorage);
          const freshPlans = readTrendPlans(window.localStorage).plans;
          freshPlans
            .filter(item => !item.archivedAt)
            .forEach(plan => /^\d{6}$/.test(plan.candidate?.security?.code || "") && currentCodes.add(plan.candidate.security.code));
          setPlans(prev => (
            !manual &&
            prev.length === freshPlans.length &&
            prev.every((p, idx) => p.id === freshPlans[idx]?.id && p.archivedAt === freshPlans[idx]?.archivedAt && p.savedAt === freshPlans[idx]?.savedAt)
              ? prev
              : freshPlans
          ));
        }
      } catch {
        // ignore storage restrictions
      }
      const focusCodes = [...currentCodes].slice(0, 28);
      const api = typeof window !== "undefined" ? window.stockApi : undefined;
      const today = todayShanghaiDate();
      const reviewPromise = api?.ai?.cachedMarketReview
        ? api.ai.cachedMarketReview(today).catch(() => null)
        : Promise.resolve(null);
      const leaderboardPromise = api?.ai?.outcomesLeaderboard
        ? api.ai.outcomesLeaderboard({ days: 30 }).catch(() => null)
        : Promise.resolve(null);
      const newsPromise = api?.getNewsFeed
        ? api.getNewsFeed({
            scope: "all",
            limit: 40,
            limitUps: ctx.limitUps,
            watchlist: ctx.watchlist,
            holdings: ctx.holdings,
            favorites: ctx.favorites,
            contentType: "all"
          }).catch(() => null)
        : Promise.resolve(null);

      const [reviewData, leaderboardData, feedData] = await Promise.all([reviewPromise, leaderboardPromise, newsPromise]);
      if (generation.current !== requestId) return;

      if (reviewData) {
        setMarketReview(reviewData.review || null);
        setLookback(reviewData.lookback || null);
        setPreviousDate(reviewData.previousDate || "");
      }
      if (leaderboardData) setLeaderboard(leaderboardData);
      if (feedData && Array.isArray(feedData.items)) {
        const focusCodeSet = new Set(focusCodes);
        const focused = feedData.items.filter((item: NewsEntry) => {
          const itemCodes = [
            ...(Array.isArray(item.codes) ? item.codes.map(String) : []),
            ...(Array.isArray(item.relatedStocks) ? item.relatedStocks.map(stock => String(stock?.code || "")).filter(Boolean) : [])
          ];
          return item.type === "announcement"
            || itemCodes.some(c => focusCodeSet.has(c))
            || item.importance === "high"
            || Number(item.importanceScore || 0) >= 75;
        });
        setNewsItems((focused.length ? focused : feedData.items).slice(0, 8));
      }

      if (withQuotes && api?.getQuoteSnapshot && focusCodes.length > 0) {
        const toFetch = manual
          ? focusCodes.slice(0, 28)
          : focusCodes.filter(code => !refreshContextRef.current.latestQuotes[code]).slice(0, 16);
        if (toFetch.length > 0) {
          const settled = await Promise.allSettled(
            toFetch.map(code => {
              const secid = inferSecid(code);
              return api.getQuoteSnapshot({ code, secid, name: code, assetType: inferAssetType(code) });
            })
          );
          if (generation.current !== requestId) return;
          const nextMap: Record<string, CockpitQuote> = {};
          settled.forEach((res, idx) => {
            if (res.status !== "fulfilled" || !res.value) return;
            const extracted = extractCockpitQuote(res.value, toFetch[idx]);
            if (extracted && extracted.code) nextMap[extracted.code] = extracted;
          });
          setLiveQuotes(prev => ({ ...prev, ...nextMap }));
        }
      }
      setLastRefreshedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }));
    } finally {
      if (generation.current === requestId) {
        manualRefreshInFlight.current = false;
        setRefreshing(false);
      }
    }
  }, []);

  const loadMarketPulse = useCallback(async (refresh = false) => {
    const api = typeof window !== "undefined" ? window.stockApi : undefined;
    if (typeof api?.getProfessionalReview !== "function") {
      setPulseState("error");
      return;
    }
    const seq = ++pulseSeqRef.current;
    pulseLastTryRef.current = Date.now();
    setPulseLoading(true);
    try {
      const review = await api.getProfessionalReview({ refresh });
      if (pulseSeqRef.current !== seq) return;
      const next = buildMarketPulse(review, todayShanghaiDate());
      if (next) {
        setMarketPulse(next);
        pulseLastOkRef.current = Date.now();
      }
      setPulseState(next ? "ready" : "error");
    } catch {
      if (pulseSeqRef.current === seq) setPulseState("error");
    } finally {
      if (pulseSeqRef.current === seq) setPulseLoading(false);
    }
  }, []);

  // 指数条：先读一次完整快照（含分时）；盘中再订阅主进程的实时推送，行情一变立刻合并进来。
  // 推送 8 秒没动静就退回每 2 秒读一次快照；分时每 60 秒整体刷新一次；接口失败时按 60 秒（盘内）/ 5 分钟（盘外）节流。
  const loadIndexBoard = useCallback(async (refresh = false) => {
    const api = typeof window !== "undefined" ? window.stockApi : undefined;
    if (typeof api?.getIndexBoard !== "function") { setIndexBoardState("error"); return; }
    if (!refresh && indexLoadingRef.current) return;
    const seq = ++indexSeqRef.current;
    indexTryRef.current = Date.now();
    indexLoadingRef.current = true;
    try {
      const next = await api.getIndexBoard({ forceRefresh: refresh });
      if (indexSeqRef.current !== seq) return;
      if (next && Array.isArray(next.indices)) {
        indexFullRef.current = Date.now();
        indexLastFailedRef.current = false;
        setIndexBoard(prev => mergeIndexSnapshot(prev, next));
        setIndexBoardState("ready");
      } else {
        indexLastFailedRef.current = true;
        setIndexBoardState("error");
      }
    } catch {
      if (indexSeqRef.current === seq) {
        indexLastFailedRef.current = true;
        setIndexBoardState("error");
      }
    } finally {
      if (indexSeqRef.current === seq) indexLoadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void loadIndexBoard(false);
    return () => {
      indexSeqRef.current += 1;
      indexLoadingRef.current = false;
    };
  }, [loadIndexBoard]);

  useEffect(() => {
    if (!live) return;
    const api = typeof window !== "undefined" ? window.stockApi : undefined;
    const canStream = typeof api?.subscribeIndexStream === "function" && typeof api?.onIndexTick === "function";
    const unlisten = canStream ? api!.onIndexTick!(tick => {
      if (!tick || !Array.isArray(tick.quotes)) return;
      indexTickRef.current = Number(tick.atMs) || Date.now();
      setIndexTickAt(indexTickRef.current);
      setIndexBoard(prev => applyIndexTick(prev, tick));
    }) : () => {};
    const renew = () => { if (canStream) void api!.subscribeIndexStream!({ active: true }).catch(() => undefined); };
    renew();
    const stopRenew = startVisibleInterval(renew, 10_000, { resumeOnVisible: true });
    const stopFallback = startVisibleInterval(() => {
      if (indexLoadingRef.current) return;
      const at = Date.now();
      // 非交易窗口（与主进程 marketStreamLive 同口径）指数不会动：成功或失败都最多 5 分钟对一次表。
      if (!inMarketStreamWindow(at)) {
        if (at - indexFullRef.current > 5 * 60_000 && at - indexTryRef.current > 5 * 60_000) void loadIndexBoard(false);
        return;
      }
      // 盘内上次快照请求失败时按 60 秒节流，避免网络故障时每 2 秒狂刷。
      if (indexLastFailedRef.current) {
        if (at - indexTryRef.current > 60_000) void loadIndexBoard(false);
        return;
      }
      const pushQuiet = at - indexTickRef.current > 8_000;
      if (pushQuiet || at - indexFullRef.current > 60_000) void loadIndexBoard(false);
    }, 2_000, { resumeOnVisible: true });
    return () => {
      unlisten();
      stopRenew();
      stopFallback();
      if (canStream) void api!.subscribeIndexStream!({ active: false }).catch(() => undefined);
    };
  }, [live, loadIndexBoard]);

  const indexTrendByName = useMemo(
    () => Object.fromEntries((marketPulse?.indices || []).filter(item => item.trend).map(item => [item.name, item.trend])),
    [marketPulse]
  );

  useEffect(() => {
    void loadMarketPulse(false);
    return () => {
      pulseSeqRef.current += 1;
    };
  }, [loadMarketPulse]);

  useEffect(() => {
    if (!live) return;
    return startVisibleInterval(() => {
      const at = Date.now();
      if (at - pulseLastOkRef.current > 180_000 && at - pulseLastTryRef.current > 60_000) void loadMarketPulse(false);
    }, 15_000);
  }, [live, loadMarketPulse]);

  useEffect(() => {
    void refreshCockpit(true, false);
    return () => {
      generation.current += 1;
    };
  }, [refreshCockpit]);

  useEffect(() => {
    if (!live) return;
    return startVisibleInterval(() => {
      void refreshCockpit(true, false);
    }, 15_000);
  }, [live, refreshCockpit]);

  const mergedQuotes = useMemo(() => {
    const merged: Record<string, CockpitQuote> = { ...liveQuotes };
    for (const [code, raw] of Object.entries(stockMonitors.latestQuotes || {})) {
      const extracted = extractCockpitQuote(raw, code);
      if (extracted) merged[code] = extracted;
    }
    return merged;
  }, [liveQuotes, stockMonitors.latestQuotes]);

  const sentinels = useMemo(
    () =>
      buildUnifiedSentinels({
        holdings,
        favorites,
        openPaperPositions,
        plans: activePlans,
        tItems: tAssistant.store.items,
        tRuntimes: tAssistant.runtimes,
        monitorConfigs: stockMonitors.configs,
        monitorRuntimes: stockMonitors.runtimes,
        monitorQuotes: stockMonitors.latestQuotes,
        liveQuotes: mergedQuotes
      }),
    [holdings, favorites, openPaperPositions, activePlans, tAssistant.store.items, tAssistant.runtimes, stockMonitors.configs, stockMonitors.runtimes, stockMonitors.latestQuotes, mergedQuotes]
  );

  const planReconciliation = useMemo(
    () => reconcilePlansAfterClose(activePlans, mergedQuotes),
    [activePlans, mergedQuotes]
  );
  const planStatusByCode = useMemo(
    () => new Map(planReconciliation.map(row => [row.plan.candidate.security.code, row])),
    [planReconciliation]
  );

  const todayDate = todayShanghaiDate();
  const todayTradesByCode = tAssistant.store.trades[todayDate] || {};
  const todayTradeSummary = useMemo(() => {
    let count = 0;
    let realized = 0;
    for (const item of tAssistant.store.items) {
      const list = todayTradesByCode[item.code] || [];
      if (!list.length) continue;
      count += list.length;
      realized += settleTrades(list, item.config, item.code).stats.realized;
    }
    return { count, realized };
  }, [tAssistant.store.items, todayTradesByCode]);

  const activeNotes = useMemo(
    () => notesApi.store.notes.filter(note => !note.done),
    [notesApi.store.notes]
  );
  const urgentNotes = useMemo(
    () => activeNotes.filter(note => Boolean(note.conditionHit || note.firedFor || note.remindAt || note.condition)).slice(0, 6),
    [activeNotes]
  );

  const preopenRows = useMemo(
    () =>
      buildPreopenAuctionRows({
        holdings,
        plans: activePlans,
        monitorConfigs: stockMonitors.configs,
        quotes: mergedQuotes
      }),
    [holdings, activePlans, stockMonitors.configs, mergedQuotes]
  );

  const morningPriorities = useMemo(
    () =>
      buildMorningPriorities({
        holdings,
        monitorConfigs: stockMonitors.configs,
        copilotAlerts,
        planReconciliation,
        tItems: tAssistant.store.items,
        urgentNotesCount: urgentNotes.length,
        newsItems
      }),
    [holdings, stockMonitors.configs, copilotAlerts, planReconciliation, tAssistant.store.items, urgentNotes.length, newsItems]
  );

  const enableQuickStopLoss = useCallback((code: string, name: string, refPrice?: number | null) => {
    if (!stockMonitors.save) {
      onNavigate("holdings");
      return;
    }
    const qPrice = mergedQuotes[code]?.latest ?? mergedQuotes[code]?.price;
    const base = Number(qPrice) > 0 ? Number(qPrice) : Number(refPrice) > 0 ? Number(refPrice) : null;
    const cfg = buildStopLossMonitorConfig(base, -5, stockMonitors.configs[code]);
    if (cfg && stockMonitors.save(code, cfg)) {
      onShowToast?.(`${name} 已启用 -5% 止损盯盘`);
    }
  }, [stockMonitors, mergedQuotes, onNavigate, onShowToast]);

  const enableBatchStopLoss = useCallback(() => {
    if (!stockMonitors.save) {
      onNavigate("holdings");
      return;
    }
    let count = 0;
    for (const h of holdings) {
      if (!/^\d{6}$/.test(h.code) || stockMonitors.configs[h.code]?.enabled) continue;
      const qPrice = mergedQuotes[h.code]?.latest ?? mergedQuotes[h.code]?.price;
      const base = Number(qPrice) > 0 ? Number(qPrice) : h.costPrice;
      const cfg = buildStopLossMonitorConfig(base, -5, stockMonitors.configs[h.code]);
      if (cfg && stockMonitors.save(h.code, cfg)) count += 1;
    }
    onShowToast?.(count > 0 ? `已为 ${count} 只未设预警持仓开启 -5% 止损盯盘` : "所有持仓均已启用盯盘");
  }, [stockMonitors, holdings, mergedQuotes, onNavigate, onShowToast]);

  const handlePriorityAction = (item: MorningPriorityItem) => {
    if (item.actionKind === "enable-batch-stop") {
      enableBatchStopLoss();
    } else if (item.actionKind === "open-stock" && item.stock) {
      onOpenStock({ code: item.stock.code, name: item.stock.name, secid: item.stock.secid || "", assetType: inferAssetType(item.stock.code) }, "返回今日驾驶舱");
    } else if (item.targetView) {
      onNavigate(item.targetView as WorkspaceView);
    }
  };

  const meta = MODE_META[mode];

  return (
    <div className="cockpit-view" data-cockpit-mode={mode}>
      {showOnboarding && (
        <section className="panel cockpit-onboarding" aria-label="3 步快速启用引导">
          <header className="cockpit-onboarding-head">
            <div>
              <span className="cockpit-pill-badge"><Sparkles size={13} />快速上手</span>
              <h3>3 步快速启用引导卡</h3>
              <p>还没有持仓和自选股。按下面三步设置好，盘中就能自动帮你盯盘和复盘。</p>
            </div>
            <button
              type="button"
              className="secondary-btn cockpit-onboarding-dismiss"
              aria-label="关闭快速启用引导"
              onClick={dismissOnboarding}
            >
              <X size={14} />不再提示
            </button>
          </header>
          <div className="cockpit-onboarding-steps">
            <article className="cockpit-onboarding-step">
              <span className="cockpit-onboarding-num">1</span>
              <div>
                <b>导入或添加持仓与自选</b>
                <small>录入持仓成本和股数，或者添加自选，就能开启止损和异动提醒。</small>
                <div className="cockpit-onboarding-actions">
                  <button type="button" className="primary-btn" onClick={() => onNavigate("holdings")}>去添加持仓</button>
                  <button type="button" className="secondary-btn" onClick={() => onNavigate("favorites")}>去添加自选</button>
                </div>
              </div>
            </article>
            <article className="cockpit-onboarding-step">
              <span className="cockpit-onboarding-num">2</span>
              <div>
                <b>1 分钟配置扶摇行情或 AI 助手</b>
                <small>填入同花顺扶摇 API Key 让行情更快；配置 AI 模型后可以用 AI 问股和 AI 复盘。</small>
                <div className="cockpit-onboarding-actions">
                  <button type="button" className="secondary-btn" onClick={() => openSettingsCategory("sources")}>配置扶摇行情</button>
                  <button type="button" className="secondary-btn" onClick={() => openSettingsCategory("ai")}>配置 AI 助手</button>
                </div>
              </div>
            </article>
            <article className="cockpit-onboarding-step">
              <span className="cockpit-onboarding-num">3</span>
              <div>
                <b>开始盘中盯盘或按需运行策略选股</b>
                <small>选出的股票点「+驾驶舱」一键加入，这里会跟踪买点与止损 5 个交易日。</small>
                <div className="cockpit-onboarding-actions">
                  <button type="button" className="primary-btn" onClick={() => onNavigate("signals")}>去运行策略选股</button>
                </div>
              </div>
            </article>
          </div>
        </section>
      )}
      <section className="panel cockpit-hero">
        <div className="cockpit-hero-head">
          <div className="cockpit-hero-title">
            <span className="cockpit-pill-badge"><Radar size={14} />{phase.label} · {meta.badge}</span>
            <h1>今日驾驶舱</h1>
            <p>{meta.focus}</p>
          </div>
          <div className="cockpit-hero-controls">
            <div className="cockpit-mode-switch" role="tablist" aria-label="交易时段模式">
              {(["preopen", "intraday", "afterclose"] as CockpitSessionMode[]).map(item => (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={mode === item}
                  className={mode === item ? "active" : ""}
                  onClick={() => setManualMode(item)}
                >
                  {MODE_META[item].label}
                </button>
              ))}
            </div>
            <label className="cockpit-default-toggle" title="下次打开软件直接进入今日驾驶舱">
              <input
                type="checkbox"
                checked={isDefaultView}
                onChange={event => onToggleDefaultView(event.target.checked)}
              />
              <span>设为默认启动页</span>
            </label>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => { void refreshCockpit(true, true); void loadMarketPulse(true); void loadIndexBoard(true); }}
              disabled={refreshing || pulseLoading}
            >
              <RefreshCw size={14} className={refreshing || pulseLoading ? "spin" : ""} />
              {refreshing || pulseLoading ? "同步中…" : lastRefreshedAt ? `已同步 ${lastRefreshedAt}` : "同步驾驶舱"}
            </button>
          </div>
        </div>

        <div className="cockpit-kpi-strip">
          <div className="cockpit-kpi">
            <span>风控与预警</span>
            <strong className={copilotAlerts.length > 0 || marketPulse?.tone === "defense" || marketPulse?.tone === "warning" ? "tone-warn" : "tone-ok"}>
              {copilotAlerts.length > 0 ? `${copilotAlerts.length} 项待看` : marketPulse?.tone === "defense" ? (marketPulse.stale ? "上个交易日偏弱" : "大盘偏弱") : marketPulse?.tone === "warning" ? (marketPulse.stale ? "上个交易日有分歧" : "大盘有分歧") : "状态平稳"}
            </strong>
            <small>{paperSummary?.portfolioKill ? "组合硬风控已触发" : live ? "正在盯盘" : "实时轮询已暂停"}</small>
          </div>
          <div className="cockpit-kpi">
            <span>驾驶舱观察</span>
            <strong>{activePlans.length} 只待跟踪</strong>
            <small>
              {planReconciliation.filter(r => r.status === "stop-hit").length > 0
                ? `${planReconciliation.filter(r => r.status === "stop-hit").length} 只触发止损`
                : planReconciliation.filter(r => r.status === "in-band").length > 0
                  ? `${planReconciliation.filter(r => r.status === "in-band").length} 只处于买点区`
                  : `${PLAN_COCKPIT_TRADING_DAYS} 个交易日后自动移出`}
            </small>
          </div>
          <div className="cockpit-kpi">
            <span>T+1 与做T队列</span>
            <strong>{tAssistant.store.items.length} 只跟踪</strong>
            <small>
              {todayTradeSummary.count > 0
                ? `今日成交 ${todayTradeSummary.count} 笔 · 净盈亏 ${maskSensitiveText(`${todayTradeSummary.realized >= 0 ? "+" : ""}${todayTradeSummary.realized.toFixed(0)}`, privacyMask)}`
                : tAssistant.store.lastRolloverDay === todayDate
                  ? "今日已自动完成 T+1 仓位结转"
                  : "第二天自动变为可卖"}
            </small>
          </div>
          <div className="cockpit-kpi">
            <span>模拟盘净值 / 浮盈亏</span>
            <strong>{maskSensitiveText(Number(paperSummary?.equity || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 }), privacyMask)}</strong>
            <small className={Number(paperSummary?.openPnl || 0) > 0 ? "tone-up" : Number(paperSummary?.openPnl || 0) < 0 ? "tone-down" : ""}>
              持仓 {openPaperPositions.length} 只 · 浮盈亏 {maskSensitiveText(`${Number(paperSummary?.openPnl || 0) >= 0 ? "+" : ""}${Number(paperSummary?.openPnl || 0).toFixed(0)} 元`, privacyMask)}
            </small>
          </div>
        </div>
      </section>

      <section className="panel index-board" aria-label="主要指数">
        <IndexBoard
          snapshot={indexBoard}
          state={indexBoardState}
          today={todayDate}
          trendByName={indexTrendByName}
          tickAt={live ? indexTickAt : 0}
          onRetry={() => void loadIndexBoard(true)}
          onAskAi={canOpenAgent() ? () => { void openAgentForMarket(); } : undefined}
        />
      </section>

      <section className="panel cockpit-pulse" aria-label="今日大盘">
        <MarketPulseCard
          showIndices={!indexBoard}
          pulse={marketPulse}
          state={pulseState}
          onRetry={() => void loadMarketPulse(true)}
          onOpenReview={() => onNavigate("review")}
          onAskAi={canOpenAgent() ? () => { void openAgentForMarket(); } : undefined}
        />
      </section>

      {morningPriorities.length > 0 && (
        <section className="panel cockpit-priority-strip" aria-label="今日开盘先盯事项">
          <header className="cockpit-priority-head">
            <div>
              <ShieldAlert size={15} />
              <b>今日先盯这 {morningPriorities.length} 件事</b>
              <small>从风险提醒、没设止损的持仓、观察股买点和持仓公告里自动挑出来</small>
            </div>
          </header>
          <div className="cockpit-priority-grid">
            {morningPriorities.map(item => (
              <article key={item.id} className={`cockpit-priority-item tone-${item.tone}`}>
                <div className="cockpit-priority-meta">
                  <span className={`cockpit-chip ${item.tone}`}>{item.tag}</span>
                  {item.actionLabel && (
                    <button type="button" className="table-action" onClick={() => handlePriorityAction(item)}>
                      {item.actionLabel}
                    </button>
                  )}
                </div>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      {mode === "preopen" && (
        <div className="cockpit-grid">
          <section className="panel cockpit-card">
            <header className="cockpit-card-head">
              <div><Bot size={16} /><h3>最近 AI 市场复盘策略</h3></div>
              <button type="button" className="link-btn" onClick={() => onNavigate("review")}>进入专业复盘 <ArrowUpRight size={13} /></button>
            </header>
            {marketReview ? (
              <div className="cockpit-review-box">
                <div className="cockpit-review-top">
                  <strong>{marketReview.headline || "市场复盘结论"}</strong>
                  <span className="cockpit-chip">{marketReview.cycle?.phase || "周期观察"}</span>
                </div>
                <p className="cockpit-muted">数据日 {marketReview.asOfDate}{marketReview.softwareRegime ? ` · 软件状态：${marketReview.softwareRegime}` : ""} · 把握 {marketReview.confidence}</p>
                {marketReview.nextDay?.posture && <p className="cockpit-posture">应对姿态：{marketReview.nextDay.posture}</p>}
                {marketReview.nextDay?.focus?.length > 0 && (
                  <div className="cockpit-list-block">
                    <b>重点关注</b>
                    <ul>{marketReview.nextDay.focus.slice(0, 3).map((item, idx) => <li key={idx}>{item}</li>)}</ul>
                  </div>
                )}
                {marketReview.nextDay?.avoid?.length > 0 && (
                  <div className="cockpit-list-block">
                    <b>优先回避</b>
                    <ul>{marketReview.nextDay.avoid.slice(0, 2).map((item, idx) => <li key={idx}>{item}</li>)}</ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="cockpit-empty">
                <p>暂无今日缓存的 AI 市场复盘{previousDate ? `（可前往专业复盘查看 ${previousDate} 并运行 AI 复盘）` : ""}。</p>
                <button type="button" className="secondary-btn" onClick={() => onNavigate("review")}><BookOpenCheck size={14} />打开专业复盘</button>
              </div>
            )}
          </section>

          <section className="panel cockpit-card">
            <header className="cockpit-card-head">
              <div><ArrowDownUp size={16} /><h3>今天能卖的仓位与随心记待办</h3></div>
              <button type="button" className="link-btn" onClick={() => onNavigate("t-assistant")}>做T助手 <ArrowUpRight size={13} /></button>
            </header>
            {tAssistant.store.items.length === 0 && urgentNotes.length === 0 ? (
              <div className="cockpit-empty">
                <p>做T队列和待提醒随心记均为空。可以在持仓、随心记或个股页一键加入做T跟踪。</p>
              </div>
            ) : (
              <div className="cockpit-split-lists">
                {tAssistant.store.items.length > 0 && (
                  <ul className="cockpit-compact-list">
                    {tAssistant.store.items.map(item => {
                      const runtime = tAssistant.runtimes[item.code];
                      return (
                        <li key={item.code}>
                          <button
                            type="button"
                            className="cockpit-link-row"
                            onClick={() => onOpenStock({ code: item.code, name: item.name, secid: item.secid, assetType: inferAssetType(item.code) }, "返回今日驾驶舱")}
                          >
                            <span><b>{item.name}</b> <small>{item.code}</small></span>
                            <span>
                              可卖 {maskSensitiveText(`${item.config.sellableShares} 股`, privacyMask)} · 成本 {item.config.costPrice > 0 ? item.config.costPrice.toFixed(2) : "未设"}
                              {runtime?.analysis ? ` · 偏离 ${runtime.analysis.deviationPct >= 0 ? "+" : ""}${runtime.analysis.deviationPct.toFixed(2)}%` : ""}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {urgentNotes.length > 0 && (
                  <div className="cockpit-list-block">
                    <b>随心记条件与提醒（{urgentNotes.length}）</b>
                    <ul className="cockpit-compact-list">
                      {urgentNotes.map(note => (
                        <li key={note.id} className="cockpit-note-item cockpit-note-action-row">
                          <div className="cockpit-note-text">
                            <span>{note.text}</span>
                            {note.stock && (
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => onOpenStock({ code: note.stock!.code, name: note.stock!.name, secid: note.stock!.secid || "", assetType: inferAssetType(note.stock!.code) }, "返回今日驾驶舱")}
                              >
                                {note.stock.name} {note.stock.code}
                              </button>
                            )}
                          </div>
                          {typeof notesApi.update === "function" && (
                            <button
                              type="button"
                              className="table-action"
                              title="标记这条随心记已完成"
                              onClick={() => notesApi.update(note.id, { done: true })}
                            >
                              <Check size={12} />完成
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel cockpit-card cockpit-card-wide">
            <header className="cockpit-card-head">
              <div><Activity size={16} /><h3>持仓与计划竞价异动速览</h3></div>
              <small className="cockpit-muted">按涨跌幅绝对值与止损风险排序 · 高开 ≥3.5% 防追高 / 低开 ≤-3% 警惕止损</small>
            </header>
            {preopenRows.length === 0 ? (
              <div className="cockpit-empty"><p>暂无持仓或观察股。在 AI 选股、策略选股、涨停池等页面点「+驾驶舱」后，盘前会在这里汇总竞价与止损状态。</p></div>
            ) : (
              <div className="cockpit-table-wrap">
                <table className="cockpit-table">
                  <thead>
                    <tr>
                      <th>股票 / 身份</th>
                      <th>现价 / 竞价涨跌</th>
                      <th>成本或计划止损</th>
                      <th>盘前状态</th>
                      <th>快捷动作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preopenRows.slice(0, 10).map(row => (
                      <tr key={row.code} className={row.gapTone === "stop-hit" ? "cockpit-row-danger" : undefined}>
                        <td>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => onOpenStock({ code: row.code, name: row.name, secid: row.secid, assetType: inferAssetType(row.code) }, "返回今日驾驶舱")}
                          >
                            <b>{row.name}</b> <small>{row.code}</small>
                          </button>{" "}
                          {row.isHolding && <span className="cockpit-chip muted">持仓</span>}
                          {row.hasPlan && planChip(row.code)}
                        </td>
                        <td className={row.changePct === null ? "" : row.changePct >= 0 ? "tone-up" : "tone-down"}>
                          {row.latestPrice !== null ? row.latestPrice.toFixed(2) : "--"}{" "}
                          <small>{row.changePct !== null ? `${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(2)}%` : ""}</small>
                        </td>
                        <td>
                          {row.planStop ? `止损 ${row.planStop.toFixed(2)}` : row.referencePrice ? `基准 ${row.referencePrice.toFixed(2)}` : "--"}
                        </td>
                        <td>
                          <span className={`cockpit-chip ${row.gapTone === "stop-hit" || row.gapTone === "weak-alert" ? "danger" : row.gapTone === "chase-warn" ? "warn" : row.gapTone === "in-band" ? "good" : "muted"}`}>
                            {row.gapLabel}
                          </span>
                        </td>
                        <td>
                          {!row.hasMonitor && row.isHolding && stockMonitors.save ? (
                            <button
                              type="button"
                              className="table-action"
                              onClick={() => enableQuickStopLoss(row.code, row.name, row.referencePrice)}
                            >
                              加 -5% 止损
                            </button>
                          ) : row.hasMonitor ? (
                            <span className="cockpit-muted">盯盘中</span>
                          ) : (
                            <button
                              type="button"
                              className="link-btn"
                              onClick={() => onOpenStock({ code: row.code, name: row.name, secid: row.secid, assetType: inferAssetType(row.code) }, "返回今日驾驶舱")}
                            >
                              看图
                            </button>
                          )}
                          {planActions(row.code)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel cockpit-card cockpit-card-wide">
            <header className="cockpit-card-head">
              <div><Newspaper size={16} /><h3>持仓 · 自选 · 计划关联公告与关键资讯</h3></div>
              <button type="button" className="link-btn" onClick={() => onNavigate("news")}>全部资讯 <ArrowUpRight size={13} /></button>
            </header>
            {newsItems.length === 0 ? (
              <div className="cockpit-empty"><p>暂未匹配到关联公告或高重要度快讯。</p></div>
            ) : (
              <ul className="cockpit-news-list">
                {newsItems.map((item, idx) => (
                  <li key={item.id || idx}>
                    <div className="cockpit-news-meta">
                      <span className="cockpit-chip">{item.type === "announcement" ? "公告" : item.sourceName || "资讯"}</span>
                      {item.confirmation?.label && <span className="cockpit-chip muted">{item.confirmation.label}</span>}
                      {item.publishedAt && <small>{newsTimeText(item.publishedAt)}</small>}
                    </div>
                    <p>{item.title}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {mode === "intraday" && (
        <div className="cockpit-grid">
          <section className="panel cockpit-card">
            <header className="cockpit-card-head">
              <div><BellRing size={16} /><h3>实时预警与动作优先队列</h3></div>
              <span className="cockpit-muted">{copilotAlerts.length} 条</span>
            </header>
            {copilotAlerts.length === 0 ? (
              <div className="cockpit-empty"><ShieldCheck size={20} /><p>当前没有触发的价格预警、做T信号或风控阻断。</p></div>
            ) : (
              <ul className="cockpit-alert-feed">
                {copilotAlerts.slice(0, 8).map(alert => (
                  <li key={alert.id}>
                    <button
                      type="button"
                      className="cockpit-alert-row"
                      onClick={() => {
                        if (alert.stock && alert.targetView === "dashboard") {
                          onOpenStock({ code: alert.stock.code, name: alert.stock.name, secid: alert.stock.secid || "", assetType: inferAssetType(alert.stock.code) }, "返回今日驾驶舱");
                        } else {
                          onNavigate(alert.targetView);
                        }
                      }}
                    >
                      <span className={`copilot-tag kind-${alert.kind}`}>{alert.tag}</span>
                      <div>
                        <strong>{alert.title}</strong>
                        <small>{alert.detail}</small>
                      </div>
                      <ArrowUpRight size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel cockpit-card">
            <header className="cockpit-card-head">
              <div><ZapIcon /><h3>常用入口</h3></div>
            </header>
            <div className="cockpit-quick-grid">
              <button type="button" className="cockpit-quick-tile" onClick={() => onNavigate("signals")}>
                <TrendingUp size={18} />
                <b>策略选股与趋势雷达</b>
                <small>按条件扫一遍全市场</small>
              </button>
              <button type="button" className="cockpit-quick-tile" onClick={() => onNavigate("ai-picks")}>
                <Sparkles size={18} />
                <b>AI 多模型一起打分</b>
                <small>看几个模型的看法是否一致</small>
              </button>
              <button type="button" className="cockpit-quick-tile" onClick={() => onNavigate("ai-agent")}>
                <Bot size={18} />
                <b>AI 问股（已连账户）</b>
                <small>自动读取持仓 / 做T / 计划 / 复盘</small>
              </button>
              <button type="button" className="cockpit-quick-tile" onClick={() => onNavigate("notes")}>
                <NotebookPen size={18} />
                <b>随心记与盘中盯盘</b>
                <small>到点提醒 · 条件单直转做T</small>
              </button>
            </div>
          </section>

          <section className="panel cockpit-card cockpit-card-wide">
            <header className="cockpit-card-head">
              <div><Activity size={16} /><h3>全账户融合实时哨兵（持仓 · 模拟 · 观察 · 做T · 盯盘）</h3></div>
              <small className="cockpit-muted">按风险/信号优先级自动排序，点击行进入个股工作台</small>
            </header>
            {sentinels.length === 0 ? (
              <div className="cockpit-empty"><p>暂未添加持仓、自选、观察股或做T标的。在各选股页面点「+驾驶舱」即可加入。</p></div>
            ) : (
              <div className="cockpit-table-wrap">
                <table className="cockpit-table">
                  <thead>
                    <tr>
                      <th>标的</th>
                      <th>来源标签</th>
                      <th>现价 / 涨跌</th>
                      <th>盯盘与风控位</th>
                      <th>做T / 模拟仓状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sentinels.slice(0, 18).map(row => (
                      <tr key={row.code} className={planStatusByCode.get(row.code)?.status === "stop-hit" ? "cockpit-row-danger" : undefined}>
                        <td>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => onOpenStock({ code: row.code, name: row.name, secid: row.secid, assetType: inferAssetType(row.code) }, "返回今日驾驶舱")}
                          >
                            <b>{row.name}</b> <small>{row.code}</small>
                          </button>
                        </td>
                        <td>
                          <div className="cockpit-role-tags">
                            {row.roles.map(role => role === "计划" ? planChip(row.code) : <span key={role} className="cockpit-chip muted">{role}</span>)}
                          </div>
                        </td>
                        <td className={row.changePct === null ? "" : row.changePct >= 0 ? "tone-up" : "tone-down"}>
                          {row.latestPrice !== null ? row.latestPrice.toFixed(2) : "--"}{" "}
                          <small>{row.changePct !== null ? `${row.changePct >= 0 ? "+" : ""}${row.changePct.toFixed(2)}%` : ""}</small>
                        </td>
                        <td>
                          {row.monitorSummary ? (
                            <span className={row.monitorTone === "alert" ? "tone-warn" : ""}>
                              <Crosshair size={12} /> {row.monitorSummary}
                            </span>
                          ) : row.planBandLabel ? (
                            <span className="cockpit-plan-band"><Target size={12} /> 计划 {row.planBandLabel} {planStatusChip(row.code)}</span>
                          ) : row.holdingPnlPct !== null ? (
                            <span className={row.holdingPnlPct >= 0 ? "tone-up" : "tone-down"}>
                              持仓浮盈亏 {row.holdingPnlPct >= 0 ? "+" : ""}{row.holdingPnlPct.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="cockpit-muted">未设阈值</span>
                          )}
                        </td>
                        <td>
                          {row.tSummary ? (
                            <span className={row.tTone === "buy" ? "tone-up" : row.tTone === "sell" ? "tone-down" : ""}>
                              {row.tSummary}
                            </span>
                          ) : row.paperSummary ? (
                            <span>{row.paperSummary}</span>
                          ) : (
                            <span className="cockpit-muted">--</span>
                          )}
                        </td>
                        <td>{planActions(row.code)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {mode === "afterclose" && (
        <div className="cockpit-grid">
          <section className="panel cockpit-card cockpit-card-wide">
            <header className="cockpit-card-head">
              <div><Target size={16} /><h3>观察股收盘后对账</h3></div>
              <button type="button" className="link-btn" onClick={() => onNavigate("ai-picks")}>去 AI 选股挑股 <ArrowUpRight size={13} /></button>
            </header>
            {planReconciliation.length === 0 ? (
              <div className="cockpit-empty">
                <p>驾驶舱里还没有观察股。在 AI 选股、策略选股、涨停池、板块等页面点「+驾驶舱」，收盘后会在这里对照买点与止损。</p>
              </div>
            ) : (
              <div className="cockpit-table-wrap">
                <table className="cockpit-table">
                  <thead>
                    <tr>
                      <th>股票</th>
                      <th>计划买入区 / 止损</th>
                      <th>现价 / 涨跌</th>
                      <th>偏离基准</th>
                      <th>结论</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planReconciliation.map(item => {
                      const sec = item.plan.candidate.security;
                      const p = item.plan.candidate.plan;
                      return (
                        <tr key={item.plan.id} className={item.status === "stop-hit" ? "cockpit-row-danger" : undefined}>
                          <td>
                            <button
                              type="button"
                              className="link-btn"
                              onClick={() => onOpenStock({ code: sec.code, name: sec.name, secid: sec.secid, assetType: sec.assetType || inferAssetType(sec.code) }, "返回今日驾驶舱")}
                            >
                              <b>{sec.name}</b> <small>{sec.code}</small>
                            </button>
                          </td>
                          <td>{p ? `${p.minEntry ? `${p.minEntry.toFixed(2)}~` : ""}${p.maxEntry.toFixed(2)} / 损 ${p.stop.toFixed(2)}` : "--"}</td>
                          <td className={item.changePct === null ? "" : item.changePct >= 0 ? "tone-up" : "tone-down"}>
                            {item.latestPrice !== null ? item.latestPrice.toFixed(2) : "--"}{" "}
                            <small>{item.changePct !== null ? `${item.changePct >= 0 ? "+" : ""}${item.changePct.toFixed(2)}%` : ""}</small>
                          </td>
                          <td>{item.diffFromEntryPct !== null ? `${item.diffFromEntryPct >= 0 ? "+" : ""}${item.diffFromEntryPct.toFixed(1)}%` : "--"}</td>
                          <td>
                            <span className={`cockpit-chip ${item.status === "stop-hit" ? "danger" : item.status === "in-band" || item.status === "above-band" ? "good" : "muted"}`}>
                              {item.statusLabel}
                            </span>{" "}
                            <small className="cockpit-muted">{item.detail}</small>
                          </td>
                          <td>{planActions(sec.code)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel cockpit-card">
            <header className="cockpit-card-head">
              <div><Gauge size={16} /><h3>当日做T与模拟交易结算</h3></div>
              <button type="button" className="link-btn" onClick={() => onNavigate("t-assistant")}>做T记录 <ArrowUpRight size={13} /></button>
            </header>
            <div className="cockpit-review-box">
              <p>今日登记做T成交：<b>{todayTradeSummary.count}</b> 笔 · 净差价：
                <b className={todayTradeSummary.realized >= 0 ? "tone-up" : "tone-down"}>
                  {maskSensitiveText(`${todayTradeSummary.realized >= 0 ? "+" : ""}${todayTradeSummary.realized.toFixed(2)} 元`, privacyMask)}
                </b>
              </p>
              <p>模拟组合累计已平仓：<b>{paperSummary?.closedCount ?? 0}</b> 笔 · 胜率：
                <b>{paperSummary?.closedCount > 0 ? `${Math.round((paperSummary.winCount / paperSummary.closedCount) * 100)}%` : "--"}</b> · 累计收益率：
                <b>{Number(paperSummary?.cumulativeReturnPercent || 0).toFixed(2)}%</b>
              </p>
              <div className="cockpit-action-row">
                <button type="button" className="secondary-btn" onClick={() => onNavigate("holdings")}>持仓与模拟单</button>
                <button type="button" className="secondary-btn" onClick={() => onNavigate("backtest")}>回测验证</button>
              </div>
            </div>
          </section>

          <section className="panel cockpit-card">
            <header className="cockpit-card-head">
              <div><BookOpenCheck size={16} /><h3>收盘后 AI 复盘与回看</h3></div>
              <button type="button" className="link-btn" onClick={() => onNavigate("review")}>完整复盘 <ArrowUpRight size={13} /></button>
            </header>
            {lookback ? (
              <div className="cockpit-review-box">
                <div className="cockpit-review-top">
                  <strong>回看 {lookback.previousDate} 准确率</strong>
                  {lookback.hitRatePct !== null && <span className="cockpit-chip good">{lookback.hitRatePct}%</span>}
                </div>
                <p>{lookback.summary || lookback.previousHeadline}</p>
                {lookback.lessons?.length > 0 && (
                  <ul className="cockpit-compact-list">
                    {lookback.lessons.slice(0, 2).map((l, i) => <li key={i}>{l}</li>)}
                  </ul>
                )}
              </div>
            ) : marketReview ? (
              <div className="cockpit-review-box">
                <strong>{marketReview.headline}</strong>
                <p>{marketReview.market || marketReview.cycle?.reason}</p>
              </div>
            ) : (
              <div className="cockpit-empty">
                <p>今天还没跑 AI 盘后复盘或回看。</p>
                <button type="button" className="primary-btn" onClick={() => onNavigate("review")}><Sparkles size={14} />前往生成今日复盘</button>
              </div>
            )}
            {leaderboard && (leaderboard.evaluatedSamples > 0 || leaderboard.lookbackStats.count > 0) && (
              <div className="cockpit-leaderboard-mini">
                <div className="cockpit-review-top">
                  <strong>近 {leaderboard.daysCovered} 日 AI 后验表现</strong>
                  <button type="button" className="link-btn" onClick={() => onNavigate("ai-picks")}>查看榜单 <ArrowUpRight size={12} /></button>
                </div>
                <p className="cockpit-muted">
                  已核对看好样本 {leaderboard.evaluatedSamples} 次
                  {leaderboard.byModel[0]?.t3 ? ` · 榜首 ${leaderboard.byModel[0].label} T+3 胜率 ${leaderboard.byModel[0].t3.winRatePct}%` : ""}
                  {leaderboard.lookbackStats.avgHitRatePct !== null ? ` · 复盘均准 ${leaderboard.lookbackStats.avgHitRatePct}%` : ""}
                </p>
              </div>
            )}
          </section>
        </div>
      )}
      <QuickPlanModal
        target={adjustTarget}
        onClose={() => setAdjustTarget(null)}
        onSaved={res => { if (typeof window !== "undefined") setPlans(readTrendPlans(window.localStorage).plans); onShowToast?.(res.message); }}
        onError={msg => onShowToast?.(msg)}
      />
    </div>
  );
}

function ZapIcon() {
  return <Layers3 size={16} />;
}
