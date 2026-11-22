import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildCopilotAlerts, resolveMarketSessionPhase, type CopilotAlertItem } from "../../copilotBriefing";
import { summarizeTStoreForAgent } from "../t-assistant/tStore";
import { useTAssistant } from "../t-assistant/useTAssistant";
import { useNotes } from "../notes/useNotes";
import type { NoteCondition } from "../notes/notesModel";
import useStockMonitors from "../../useStockMonitors";
import { MAX_MONITOR_CONDITIONS } from "../../stockMonitorRules";
import { readTrendPlans } from "../../trendWorkspace";
import { startVisibleInterval } from "../../visiblePolling";
import { describeSourceHealth } from "../market/marketSourceHealth";
import type { AnalysisPayload } from "../market/analysisTypes";
import type { WorkspaceView as View } from "../../workspaceView";
import type { usePaperTrading } from "../paper-simulation/usePaperTrading";

type UseWorkspaceCopilotParams = {
  view: View;
  live: boolean;
  payload: AnalysisPayload | null;
  holdings: HoldingItem[];
  favoriteItems: WatchItem[];
  favoriteCodes: Set<string>;
  paperSummary: ReturnType<typeof usePaperTrading>["paperSummary"];
  settings: Settings;
  settingsRef: MutableRefObject<Settings>;
  settingsLoadState: "loading" | "ready" | "failed";
  persistSettings: (patch: Partial<Settings>) => Promise<Settings>;
  sourceHealth: MarketSourceHealth | null;
  addFavoriteSecurity: (security: Security) => Promise<void>;
  showToast: (message: string) => void;
  onOpenStock: (security: Security, originView?: View, label?: string) => void;
  onNavigateView: (next: View) => void;
};

export function buildNoteToTConfig(
  matchedHolding: Pick<HoldingItem, "shares" | "costPrice" | "sellableShares"> | undefined,
  existingT: { config: { sellableShares: number } } | undefined
) {
  if (!matchedHolding) return undefined;
  const defaultSellable =
    typeof matchedHolding.sellableShares === "number" && Number.isFinite(matchedHolding.sellableShares)
      ? Math.max(0, Math.min(matchedHolding.shares || 0, Math.floor(matchedHolding.sellableShares)))
      : 0;
  return {
    ...(matchedHolding.costPrice ? { costPrice: matchedHolding.costPrice } : {}),
    ...(matchedHolding.shares
      ? {
          baseShares: matchedHolding.shares,
          sellableShares: existingT?.config.sellableShares ?? defaultSellable
        }
      : {})
  };
}

export function useWorkspaceCopilot({
  view,
  live,
  payload,
  holdings,
  favoriteItems,
  favoriteCodes,
  paperSummary,
  settings,
  settingsRef,
  settingsLoadState,
  persistSettings,
  sourceHealth,
  addFavoriteSecurity,
  showToast,
  onOpenStock,
  onNavigateView
}: UseWorkspaceCopilotParams) {
  const voiceSeenIds = useRef<Set<string>>(new Set());
  const voiceFeedSeeded = useRef(false);
  const [launchStripDismissed, setLaunchStripDismissed] = useState(false);
  const [launchArchive, setLaunchArchive] = useState<ExternalFactorArchiveSummary | null>(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const copilotRef = useRef<HTMLDivElement>(null);

  const monitorItems = useMemo(() => {
    const byCode = new Map<string, Security>();
    const append = (item: { code?: unknown; name?: unknown; secid?: unknown; assetType?: unknown }) => {
      const code = String(item?.code || "");
      if (!/^\d{6}$/.test(code) || byCode.has(code)) return;
      byCode.set(code, {
        code,
        name: String(item?.name || code),
        secid: String(item?.secid || ""),
        assetType: item?.assetType === "convertibleBond" ? "convertibleBond" : item?.assetType === "etf" ? "etf" : "stock"
      });
    };
    favoriteItems.forEach(append);
    holdings.forEach(append);
    paperSummary.normalized.openPositions.forEach(append);
    return [...byCode.values()];
  }, [favoriteItems, holdings, paperSummary.normalized.openPositions]);

  const stockMonitors = useStockMonitors({
    items: monitorItems,
    live,
    refreshSeconds: Number(settings.quoteRefreshSeconds) || 5,
    onAlert: alert => {
      const msg = `${alert.name}（${alert.code}）：${alert.detail}`;
      showToast(msg);
      const isBackground =
        typeof document !== "undefined" &&
        (document.hidden || (typeof document.hasFocus === "function" && !document.hasFocus()));
      if (isBackground && typeof window !== "undefined" && typeof window.stockApi?.notify === "function") {
        void window.stockApi.notify({
          title: `盯盘预警 · ${alert.name}（${alert.code}）`,
          body: alert.detail,
          code: alert.code,
          name: alert.name,
          secid: monitorItems.find(item => item.code === alert.code)?.secid || "",
          targetView: "dashboard"
        }).catch(() => undefined);
      }
    }
  });
  const tAssistant = useTAssistant({ live, holdings, onAlert: message => showToast(message) });
  const notes = useNotes();

  const toggleNewsVoice = useCallback(async () => {
    const enabled = settingsRef.current.newsVoiceEnabled === false;
    if (!enabled) window.speechSynthesis?.cancel();
    try {
      await persistSettings({ newsVoiceEnabled: enabled });
      showToast(enabled ? "重大资讯自动播报已开启" : "重大资讯自动播报已关闭");
    } catch {
      showToast("语音播报设置保存失败");
    }
  }, [persistSettings, settingsRef, showToast]);

  useEffect(() => {
    const synthesis = window.speechSynthesis;
    if (!live || settings.newsVoiceEnabled === false || !synthesis) {
      synthesis?.cancel();
      return;
    }
    let active = true;
    let busy = false;
    const pollMajorNews = async () => {
      if (busy) return;
      busy = true;
      try {
        const feed = await window.stockApi.getNewsFeed({
          scope: "all",
          direction: "all",
          limit: 120
        });
        if (!active) return;
        const items = Array.isArray(feed?.items) ? (feed.items as Array<Record<string, unknown>>) : [];
        if (!voiceFeedSeeded.current) {
          items.forEach((item) => voiceSeenIds.current.add(String(item.id)));
          voiceFeedSeeded.current = true;
          return;
        }
        const freshMajor = items.filter((item) => {
          const id = String(item.id || "");
          return id &&
            !voiceSeenIds.current.has(id) &&
            Number(item.ageMinutes || 0) <= 15 &&
            item.autoBroadcast === true;
        });
        if (voiceSeenIds.current.size > 2000) voiceSeenIds.current = new Set(items.map((item) => String(item.id)));
        else items.forEach((item) => voiceSeenIds.current.add(String(item.id)));
        if (!freshMajor.length) return;
        const text = freshMajor.slice(0, 3).reverse().map((item, index) => {
          const direction =
            item.direction === "negative" ? "风险事项" :
              item.direction === "positive" ? "正向事项" : "重要事项";
          const sectors = Array.isArray(item.relatedSectors)
            ? item.relatedSectors.slice(0, 3).map(String).join("、")
            : "";
          return `${index ? "下一条，" : ""}${direction}，${String(item.title || "")}${sectors ? `，涉及${sectors}` : ""}`;
        }).join("。");
        const utterance = new SpeechSynthesisUtterance(`重大资讯播报。${text}`);
        utterance.lang = "zh-CN";
        utterance.rate = 0.95;
        synthesis.speak(utterance);
      } catch {
        // A failed news source should not interrupt the rest of the monitor.
      } finally {
        busy = false;
      }
    };
    const stop = startVisibleInterval(
      () => { void pollMajorNews(); },
      Math.max(5, Number(settings.newsRefreshSeconds) || 6) * 1000,
      { immediate: true }
    );
    return () => {
      active = false;
      stop();
    };
  }, [live, settings.newsRefreshSeconds, settings.newsVoiceEnabled]);

  const [planSyncTick, setPlanSyncTick] = useState(0);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
    const onPlansUpdated = () => setPlanSyncTick(t => t + 1);
    window.addEventListener("a-stock-radar:trend-plans-updated", onPlansUpdated);
    window.addEventListener("storage", onPlansUpdated);
    return () => {
      if (typeof window.removeEventListener === "function") {
        window.removeEventListener("a-stock-radar:trend-plans-updated", onPlansUpdated);
        window.removeEventListener("storage", onPlansUpdated);
      }
    };
  }, []);

  useEffect(() => {
    if (settingsLoadState !== "ready") return;
    const syncWorkspace = window.stockApi?.ai?.agent?.syncWorkspace;
    if (typeof syncWorkspace !== "function") return;
    const timer = window.setTimeout(() => {
      const tItems = summarizeTStoreForAgent(tAssistant.store, tAssistant.runtimes);
      const savedPlans = typeof window !== "undefined" ? readTrendPlans(window.localStorage).plans : [];
      const plans = savedPlans.filter(p => !p.archivedAt).slice(0, 20).map(p => ({
        code: p.candidate.security.code,
        name: p.candidate.security.name,
        strategyName: p.candidate.setup?.label || p.candidate.strategy?.id || "classic-v1",
        entryType: p.candidate.plan?.entryType || "",
        stopPrice: p.candidate.plan?.stop ?? null,
        targetPrice: p.candidate.plan?.maxEntry ?? null,
        savedAt: String(p.savedAt || "").slice(0, 10),
        status: Object.values(p.reviewDraft?.checks || {}).some(Boolean) ? "checked" : "pending"
      }));
      const paperPositions = paperSummary.normalized.openPositions.slice(0, 16).map(pos => ({
        code: pos.code,
        name: pos.name,
        entryPrice: pos.entryPrice,
        stopPrice: pos.stopPrice,
        takePrice: pos.takePrice,
        holdingBars: pos.holdingBars
      }));
      const noteSummaries = notes.store.notes.filter(n => !n.done).slice(0, 20).map(n => ({
        code: n.stock?.code || "",
        text: n.text,
        when: n.remindAt || "",
        condition: n.condition ? `${n.condition.field === "latest" ? "现价" : "涨跌幅"} ${n.condition.op === "gte" ? "≥" : "≤"} ${n.condition.value}` : "",
        status: n.conditionHit ? "triggered" : n.remindAt || n.condition ? "watching" : "active"
      }));
      void syncWorkspace({ tItems, plans, paperPositions, notes: noteSummaries }).catch(() => {
        // Optional background sync with AI agent workbench; missing agent service is non-fatal.
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [settingsLoadState, tAssistant.store, tAssistant.runtimes, notes.store.notes, paperSummary.normalized.openPositions, planSyncTick]);

  useEffect(() => {
    if (!copilotOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (copilotRef.current && !copilotRef.current.contains(event.target as Node)) setCopilotOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCopilotOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [copilotOpen]);

  useEffect(() => {
    const readArchive = typeof window !== "undefined" ? window.stockApi?.getExternalFactorArchive : undefined;
    if (typeof readArchive !== "function") return;
    let active = true;
    void readArchive()
      .then(summary => {
        if (active && summary) setLaunchArchive(summary);
      })
      .catch(() => {
        // Optional external factor summary banner; stay silent if unavailable.
      });
    return () => { active = false; };
  }, [view]);

  const addNoteToT = useCallback((security: Security) => {
    const matchedHolding = holdings.find(h => h.code === security.code);
    const existingT = tAssistant.store.items.find(item => item.code === security.code);
    const problem = tAssistant.addStock(
      { code: security.code, name: matchedHolding?.name || security.name, secid: security.secid },
      buildNoteToTConfig(matchedHolding, existingT)
    );
    if (problem) {
      showToast(problem);
      return;
    }
    showToast(`已将 ${matchedHolding?.name || security.name} 加入做T助手`);
  }, [holdings, showToast, tAssistant]);

  const addNoteToMonitor = useCallback(async (security: Security, condition?: NoteCondition | null) => {
    if (!security?.code) return;
    if (condition) {
      const existing = stockMonitors.configs[security.code];
      const nextCondition = {
        id: `note-${security.code}-${condition.field}-${condition.op}-${condition.value}`,
        field: condition.field,
        operator: condition.op,
        value: condition.value
      };
      const prevConditions = existing?.conditions || [];
      const merged = prevConditions.some(
        c => c.field === nextCondition.field && c.operator === nextCondition.operator && c.value === nextCondition.value
      )
        ? prevConditions
        : [...prevConditions, nextCondition];
      if (merged.length > MAX_MONITOR_CONDITIONS) {
        showToast(`单只股票最多可设置 ${MAX_MONITOR_CONDITIONS} 条盯盘条件`);
        return;
      }
      const savedOk = stockMonitors.save(security.code, {
        enabled: true,
        mode: existing?.mode || "any",
        cooldownMinutes: existing?.cooldownMinutes || 5,
        conditions: merged
      });
      if (!savedOk) {
        showToast("同步盯盘条件失败，请检查数值与本地存储空间");
        return;
      }
      if (!favoriteCodes.has(security.code) && !holdings.some(h => h.code === security.code)) {
        await addFavoriteSecurity(security);
      }
      showToast(`已同步 ${security.name} 价格条件到实时盯盘`);
      return;
    }
    onOpenStock(security, "notes", "返回随心记");
  }, [addFavoriteSecurity, favoriteCodes, holdings, onOpenStock, showToast, stockMonitors]);

  const [sessionClock, setSessionClock] = useState(Date.now);
  useEffect(() => {
    return startVisibleInterval(() => setSessionClock(Date.now()), 30_000, { resumeOnVisible: true });
  }, []);
  const sourceNotice = settingsLoadState === "ready" ? describeSourceHealth(sourceHealth) : null;
  const copilotPhase = useMemo(() => resolveMarketSessionPhase(sessionClock), [sessionClock]);
  const [ackedAlertIds, setAckedAlertIds] = useState<Set<string>>(() => new Set());
  const rawCopilotAlerts = useMemo(
    () => buildCopilotAlerts({
      notes: notes.store.notes,
      monitorAlerts: stockMonitors.alerts,
      tItems: tAssistant.store.items,
      tRuntimes: tAssistant.runtimes,
      paperSummary,
      sourceNotice
    }),
    [notes.store.notes, stockMonitors.alerts, tAssistant.store.items, tAssistant.runtimes, paperSummary, sourceNotice]
  );
  const copilotAlerts = useMemo(
    () => rawCopilotAlerts.filter(item => !ackedAlertIds.has(item.id)),
    [rawCopilotAlerts, ackedAlertIds]
  );

  const newsLiveQuotes = useMemo(() => {
    const map: Record<string, { code: string; name?: string | undefined; changePct: number; price?: number | undefined }> = {};
    for (const [code, snap] of Object.entries(stockMonitors.latestQuotes || {})) {
      const q = (snap as { quote?: Record<string, unknown> })?.quote ?? (snap as Record<string, unknown>);
      const changePct = Number(q?.changePct);
      if (!/^\d{6}$/.test(code) || !Number.isFinite(changePct)) continue;
      map[code] = {
        code,
        name: typeof q?.name === "string" ? q.name : undefined,
        changePct,
        price: Number.isFinite(Number(q?.latest ?? q?.price)) ? Number(q?.latest ?? q?.price) : undefined
      };
    }
    const currentCode = payload?.security?.code;
    const currentChange = Number(payload?.quote?.changePct);
    if (currentCode && Number.isFinite(currentChange)) {
      map[currentCode] = {
        code: currentCode,
        name: payload.security.name,
        changePct: currentChange,
        price: Number.isFinite(Number(payload.quote?.latest)) ? Number(payload.quote?.latest) : undefined
      };
    }
    return map;
  }, [payload?.quote?.changePct, payload?.quote?.latest, payload?.security?.code, payload?.security?.name, stockMonitors.latestQuotes]);

  const handleCopilotSelect = (item: CopilotAlertItem) => {
    setCopilotOpen(false);
    if (item.id.startsWith("monitor:")) {
      stockMonitors.ackAlert(item.id.slice("monitor:".length));
    } else {
      setAckedAlertIds(current => {
        if (current.has(item.id)) return current;
        const next = new Set(current);
        next.add(item.id);
        return next;
      });
    }
    if (item.stock && item.targetView === "dashboard") {
      onOpenStock({ code: item.stock.code, name: item.stock.name, secid: item.stock.secid || "" }, view);
      return;
    }
    onNavigateView(item.targetView);
  };

  const clearAllCopilotAlerts = useCallback(() => {
    stockMonitors.clearAlerts();
    setAckedAlertIds(new Set(rawCopilotAlerts.map(item => item.id)));
  }, [rawCopilotAlerts, stockMonitors]);

  return {
    stockMonitors,
    tAssistant,
    notes,
    toggleNewsVoice,
    launchStripDismissed,
    setLaunchStripDismissed,
    launchArchive,
    sourceNotice,
    copilotOpen,
    setCopilotOpen,
    copilotRef,
    copilotPhase,
    copilotAlerts,
    clearAllCopilotAlerts,
    newsLiveQuotes,
    addNoteToT,
    addNoteToMonitor,
    handleCopilotSelect
  };
}
