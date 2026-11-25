import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  ArrowLeftRight,
  Bell,
  Bookmark,
  BookmarkCheck,
  Check,
  ChevronRight,
  ClipboardPaste,
  History,
  LineChart,
  LoaderCircle,
  PlusCircle,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  Star,
  Trash2,
  Upload,
  WalletCards,
  X
} from "lucide-react";
import { PageHeading, PanelTitle, Fact } from "../../components/terminal/TerminalPrimitives";
import { ConfirmDialog, type ConfirmDialogRequest } from "../../components/terminal/ConfirmDialog";
import StockMonitorEditor from "../../components/StockMonitorEditor";
import { emitAppToast } from "../cockpit/cockpitAdd";
import QuickPlanModal, { usePlannedCodes, type QuickPlanTarget } from "../../components/QuickPlanModal";
import StockRowActions from "../../components/StockRowActions";
import { useVirtualWindow } from "../../components/useVirtualWindow";
import useStockMonitors from "../../useStockMonitors";
import { startVisibleInterval } from "../../visiblePolling";
import { fmt, fmtMoney, nullableNumber } from "../../domain/formatters";
import { inferSecid } from "../../domain/securityIdentifiers";
import type { BatchQuoteRequest, BatchQuoteResult } from "../../domain/batchQuoteTypes";
import { nextWatchSort, sortWatchItems, toWatchQuotes, watchQuoteStats, type WatchQuote, type WatchSort } from "./watchlistModel";
import type { PaperPosition } from "../../domain/paperSimulationTypes";
import { formatShanghaiTime, formatShanghaiDateTime } from "../../dateUtils";
import { summarizeStockMonitor } from "../../stockMonitorRules";
import type { WorkspaceView } from "../../workspaceView";
import {
  HOLDING_TRADES_STORAGE_KEY,
  appendHoldingTradeRecord,
  applyHoldingTrade,
  buildStopLossMonitorConfig,
  clearHoldingTrades,
  computeMonitorStopPrice,
  loadHoldingTradeLedger,
  loadHoldingTrades,
  maskSensitiveText,
  mergeImportedHoldings,
  parseHoldingsPaste,
  summarizeHoldingTrades,
  type HoldingItemWithSellable,
  type HoldingTradeRecord,
  type HoldingTradeSide
} from "./holdingsLedger";
import { userErrorText } from "../../userErrorText";

function MonitorSubTabs({
  active,
  onNavigate
}: {
  active: "favorites" | "watchlist";
  onNavigate?: ((view: WorkspaceView) => void) | undefined;
}) {
  if (!onNavigate) return null;
  return (
    <div className="holdings-mode-tabs monitor-sub-tabs" role="tablist" aria-label="监控与观察子视图" style={{ marginBottom: 12 }}>
      <button type="button" role="tab" aria-selected={active === "favorites"} className={active === "favorites" ? "active" : ""} onClick={() => onNavigate("favorites")}>
        自选监控
      </button>
      <button type="button" role="tab" aria-selected={active === "watchlist"} className={active === "watchlist" ? "active" : ""} onClick={() => onNavigate("watchlist")}>
        十日涨停跟踪
      </button>
      <button type="button" role="tab" aria-selected={false} onClick={() => onNavigate("cockpit")}>
        次日观察计划
      </button>
    </div>
  );
}

export function FavoritesView({
  items,
  monitors,
  live,
  onOpen,
  onRemove,
  onNavigate
}: {
  items: WatchItem[];
  monitors: ReturnType<typeof useStockMonitors>;
  live: boolean;
  onOpen: (item: WatchItem) => void;
  onRemove: (item: WatchItem) => void;
  onNavigate?: ((view: WorkspaceView) => void) | undefined;
}) {
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualWindow({
    itemCount: items.length,
    rowHeight: 164,
    overscan: 6,
    threshold: 80,
    containerRef: listScrollRef
  });
  const visibleItems = virtual.enabled ? items.slice(virtual.startIndex, virtual.endIndex) : items;
  const configuredCount = items.filter(item => monitors.configs[item.code]).length;
  const enabledCount = items.filter(item => monitors.configs[item.code]?.enabled).length;
  const statusLabels: Record<string, string> = { waiting: "等待行情", stale: "报价待更新", unavailable: "行情待恢复", baseline: "监控中", watching: "监控中", matched: "条件满足", triggered: "已提醒", cooldown: "冷却中", disabled: "已暂停" };
  const openAlertStock = (alert: { code: string; name: string }) => {
    const matched = items.find(entry => entry.code === alert.code);
    onOpen(matched || {
      code: alert.code,
      name: alert.name,
      secid: inferSecid(alert.code),
      assetType: "stock",
      createdAt: ""
    });
  };
  return (
    <div className="personal-workspace">
      <PageHeading eyebrow="PERSONAL MONITOR BOARD" title="自选监控" description="为每只自选股设置独立条件，应用开启且实时刷新时持续监测。" />
      <MonitorSubTabs active="favorites" onNavigate={onNavigate} />
      <section className="panel personal-monitor-panel">
        <header className="personal-monitor-heading"><div><Star size={18} /><h3>我的监控</h3><span>{items.length} 只自选</span></div><div><span>{configuredCount} 只已配置</span><b>{live ? `${enabledCount} 只监控中` : "实时监控已暂停"}</b>{monitors.refreshing && <LoaderCircle size={15} className="spin" />}</div></header>
        {monitors.storageError && <p className="monitor-storage-error" role="alert">{monitors.storageError}</p>}
        {items.length ? (
          <div
            className="personal-monitor-list"
            ref={listScrollRef}
            onScroll={virtual.enabled ? virtual.onScroll : undefined}
            style={virtual.enabled ? { maxHeight: 680, overflowY: "auto" } : undefined}
          >
            <div className="personal-monitor-columns" aria-hidden="true"><span>股票</span><span>最新行情 / 状态</span><span>监控条件</span><span>最近状态</span><span>操作</span></div>
            {virtual.enabled && virtual.topSpacerHeight > 0 && <div aria-hidden="true" style={{ height: virtual.topSpacerHeight }} />}
            <div className="personal-monitor-grid">{visibleItems.map(item => {
              const config = monitors.configs[item.code];
              const evaluation = monitors.runtimes[item.code];
              const snapshot = monitors.latestQuotes[item.code];
              const latest = snapshot?.quote?.latest;
              const change = snapshot?.quote?.changePct;
              const missingFields = Array.isArray(snapshot?.quote?.missingFields) ? snapshot.quote.missingFields : [];
              const status = !config ? "未配置" : !config.enabled || !live ? "已暂停" : statusLabels[evaluation?.status || "waiting"];
              const statusDetail = !config ? "添加价格、涨跌幅、换手率或成交额条件" : !config.enabled || !live ? "恢复后从新行情开始监控" : evaluation?.detail || "等待获取有效行情";
              return <article key={item.code} className={`personal-monitor-card ${editingCode === item.code ? "is-editing" : ""}`}>
                <header><button className="monitor-stock-name" onClick={() => onOpen(item)}><strong>{item.name}</strong><span>{item.code} · {item.thscode?.split(".")[1] || "A"}</span></button><button className="monitor-remove-stock" title="移出自选" aria-label={`移出自选${item.name}`} onClick={() => onRemove(item)}><X size={16} /></button></header>
                <div className="monitor-card-quote"><strong>{typeof latest === "number" && Number.isFinite(latest) && latest > 0 ? fmt(latest) : "—"}</strong>{!missingFields.includes("changePct") && typeof change === "number" && Number.isFinite(change) && <span className={change >= 0 ? "up" : "down"}>{change >= 0 ? "+" : ""}{fmt(change)}%</span>}<span className={`monitor-status ${config?.enabled && live ? "is-on" : ""}`}>{status}</span></div>
                <p className="monitor-rule-summary">{config ? summarizeStockMonitor(config) : "尚未设置监控条件"}</p>
                <div className="monitor-card-detail"><span>{statusDetail}</span>{snapshot?.updatedAt && <time>最近获取 {formatShanghaiTime(snapshot.updatedAt)}</time>}</div>
                <footer><button className="monitor-configure" onClick={() => setEditingCode(editingCode === item.code ? null : item.code)}><SlidersHorizontal size={14} />{config ? "编辑条件" : "设置条件"}</button>{config && <button onClick={() => { if (monitors.save(item.code, { ...config, enabled: !config.enabled })) setEditingCode(null); }}>{config.enabled ? "暂停监控" : "启用监控"}</button>}<button onClick={() => onOpen(item)}>个股分析<ChevronRight size={14} /></button></footer>
                {editingCode === item.code && <StockMonitorEditor stock={item} config={config} onCancel={() => setEditingCode(null)} onSave={next => { const ok = monitors.save(item.code, next); if (ok) setEditingCode(null); return ok; }} />}
              </article>;
            })}</div>
            {virtual.enabled && virtual.bottomSpacerHeight > 0 && <div aria-hidden="true" style={{ height: virtual.bottomSpacerHeight }} />}
          </div>
        ) : <div className="favorites-empty"><Star size={32} /><b>自选监控还是空的</b><span>到涨停池点击“监控”，或在个股分析中点击“加入自选”。</span></div>}
      </section>
      {monitors.alerts.length > 0 && (
        <section className="panel monitor-alert-panel">
          <header>
            <Bell size={17} />
            <h3>最近提醒</h3>
            <span>保留最近 20 条</span>
            {monitors.clearAlerts && (
              <button type="button" className="secondary-btn" onClick={() => monitors.clearAlerts()}>
                清空提醒
              </button>
            )}
          </header>
          <div>
            {monitors.alerts.map(alert => (
              <article
                key={alert.id}
                className="monitor-alert-clickable"
                style={{ cursor: "pointer" }}
                onClick={() => openAlertStock(alert)}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                  <button
                    type="button"
                    className="link-btn"
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: 0, textAlign: "left" }}
                    onClick={event => {
                      event.stopPropagation();
                      openAlertStock(alert);
                    }}
                  >
                    <b>{alert.name}</b>
                    <span>{alert.code}</span>
                    <time>{formatShanghaiDateTime(alert.triggeredAt)}</time>
                  </button>
                  {monitors.ackAlert && (
                    <button
                      type="button"
                      className="table-action"
                      aria-label={`确认提醒 ${alert.name} ${alert.code}`}
                      onClick={event => {
                        event.stopPropagation();
                        monitors.ackAlert(alert.id);
                      }}
                    >
                      <Check size={12} />已读
                    </button>
                  )}
                </div>
                <p>{alert.detail}</p>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function HoldingsView({
  items,
  settings,
  live,
  monitors,
  privacyMask = false,
  onTransferToT,
  paperPositions,
  paperMetrics,
  onClosePaperPosition,
  onConfirmPaperSettlement,
  onRefreshPaperPositions,
  onOpenPaperStock,
  initialLedgerTab = "real",
  onSave,
  onOpen
}: {
  items: HoldingItem[];
  settings: Settings;
  live: boolean;
  monitors?: ReturnType<typeof useStockMonitors> | undefined;
  privacyMask?: boolean;
  onTransferToT?: ((item: HoldingItem) => void) | undefined;
  paperPositions?: PaperPosition[] | undefined;
  paperMetrics?: {
    equity?: number | undefined;
    cash?: number | undefined;
    openValue?: number | undefined;
    openPnl?: number | undefined;
    openPnlPercent?: number | undefined;
    cumulativeRealizedPnl?: number | undefined;
    closedCount?: number | undefined;
    winCount?: number | undefined;
  } | undefined;
  onClosePaperPosition?: ((code: string) => void) | undefined;
  onConfirmPaperSettlement?: ((code: string) => void) | undefined;
  onRefreshPaperPositions?: (() => Promise<void> | void) | undefined;
  onOpenPaperStock?: ((security: Security) => void) | undefined;
  initialLedgerTab?: "real" | "paper" | undefined;
  onSave: (update: (items: HoldingItem[]) => HoldingItem[]) => Promise<boolean>;
  onOpen: (item: HoldingItem) => void;
}) {
  const hasPaperSwitch = paperPositions !== undefined || paperMetrics !== undefined;
  const [ledgerTab, setLedgerTab] = useState<"real" | "paper">(initialLedgerTab);
  const [entryMode, setEntryMode] = useState<"single" | "trade" | "paste">("single");
  const [code, setCode] = useState("");
  const [shares, setShares] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [note, setNote] = useState("");
  const [tradeSide, setTradeSide] = useState<HoldingTradeSide>("buy");
  const [tradeCode, setTradeCode] = useState("");
  const [tradeShares, setTradeShares] = useState("100");
  const [tradePrice, setTradePrice] = useState("");
  const [tradeDiluteCost, setTradeDiluteCost] = useState(false);
  const [tradeNote, setTradeNote] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [batchMessage, setBatchMessage] = useState("");
  const [editingMonitorCode, setEditingMonitorCode] = useState<string | null>(null);
  const [holdingSort, setHoldingSort] = useState<{ key: "marketValue" | "profit" | "profitPercent"; dir: "desc" | "asc" } | null>(null);
  const [tradeRecords, setTradeRecords] = useState<HoldingTradeRecord[]>(() => loadHoldingTrades());
  const [clearTradesConfirm, setClearTradesConfirm] = useState<ConfirmDialogRequest | null>(null);
  const [quotes, setQuotes] = useState<Record<string, { quote: Record<string, unknown> | null; updatedAt: string; failed: boolean }>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [removedHolding, setRemovedHolding] = useState<HoldingItem | null>(null);
  const [removingCode, setRemovingCode] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [removalError, setRemovalError] = useState("");
  const holdingEditRevision = useRef(0);
  const quoteRefreshRequestId = useRef(0);
  const quoteRefreshPending = useRef<number | null>(null);

  const refreshQuotes = useCallback(async () => {
    if (quoteRefreshPending.current !== null) return;
    const requestId = ++quoteRefreshRequestId.current;
    if (!items.length) {
      if (requestId === quoteRefreshRequestId.current) {
        setQuotes({});
        setRefreshing(false);
      }
      return;
    }
    quoteRefreshPending.current = requestId;
    setRefreshing(true);
    const pending = [...items];
    const results: Array<readonly [string, { quote: Record<string, unknown>; updatedAt: string } | null]> = [];
    const workerCount = Math.min(4, pending.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (pending.length && requestId === quoteRefreshRequestId.current) {
        const item = pending.shift();
        if (!item) return;
        try {
          const snapshot = await window.stockApi.getQuoteSnapshot(item);
          const latest = Number(snapshot?.quote?.latest);
          results.push([item.code, Number.isFinite(latest) && latest > 0
            ? { quote: snapshot.quote, updatedAt: snapshot.updatedAt || new Date().toISOString() }
            : null] as const);
        } catch {
          results.push([item.code, null] as const);
        }
      }
    }));
    if (quoteRefreshPending.current === requestId) quoteRefreshPending.current = null;
    if (requestId !== quoteRefreshRequestId.current) return;
    setQuotes((current) => {
      const next: typeof current = {};
      for (const [itemCode, snapshot] of results) {
        next[itemCode] = snapshot
          ? { ...snapshot, failed: false }
          : { quote: current[itemCode]?.quote || null, updatedAt: current[itemCode]?.updatedAt || "", failed: true };
      }
      return next;
    });
    if (requestId === quoteRefreshRequestId.current) setRefreshing(false);
  }, [items]);

  useEffect(() => {
    void refreshQuotes();
    const stop = live && items.length ? startVisibleInterval(
      () => void refreshQuotes(),
      Math.max(5, Number(settings.quoteRefreshSeconds) || 5) * 1000
    ) : undefined;
    return () => {
      stop?.();
      quoteRefreshRequestId.current += 1;
      quoteRefreshPending.current = null;
    };
  }, [items.length, live, settings.quoteRefreshSeconds, refreshQuotes]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
    const syncTrades = (event?: Event) => {
      if (event && "key" in event) {
        const storageEvent = event as StorageEvent;
        if (storageEvent.key !== null && storageEvent.key !== HOLDING_TRADES_STORAGE_KEY) return;
      }
      setTradeRecords(loadHoldingTrades());
    };
    window.addEventListener("storage", syncTrades);
    window.addEventListener("a-stock-radar:holding-trades-updated", syncTrades);
    return () => {
      if (typeof window.removeEventListener === "function") {
        window.removeEventListener("storage", syncTrades);
        window.removeEventListener("a-stock-radar:holding-trades-updated", syncTrades);
      }
    };
  }, []);

  const rows = useMemo(() => items.map((item) => {
    const snapshot = quotes[item.code];
    const quote = snapshot?.quote || null;
    const latest = Number(quote?.latest);
    const preClose = Number(quote?.preClose);
    const missingFields = Array.isArray(quote?.missingFields) ? quote.missingFields : [];
    const changePct = missingFields.includes("changePct") ? Number.NaN : nullableNumber(quote?.changePct) ?? Number.NaN;
    const quoteAvailable = Number.isFinite(latest) && latest > 0;
    const marketValue = quoteAvailable ? latest * item.shares : Number.NaN;
    const costValue = item.costPrice * item.shares;
    const profit = quoteAvailable ? marketValue - costValue : Number.NaN;
    const profitPercent = quoteAvailable && costValue > 0 ? profit / costValue * 100 : Number.NaN;
    const dayProfit = quoteAvailable && Number.isFinite(preClose) && preClose > 0
      ? (latest - preClose) * item.shares
      : Number.NaN;
    return { item, quote, latest, changePct, quoteAvailable, quoteFailed: snapshot?.failed || false, quoteUpdatedAt: snapshot?.updatedAt || "", marketValue, costValue, profit, profitPercent, dayProfit };
  }), [items, quotes]);
  const summary = useMemo(() => {
    const priced = rows.filter((row) => row.quoteAvailable && !row.quoteFailed);
    const marketValue = priced.reduce((sum, row) => sum + row.marketValue, 0);
    const costValue = priced.reduce((sum, row) => sum + row.costValue, 0);
    const profit = marketValue - costValue;
    const dayPriced = priced.filter((row) => Number.isFinite(row.dayProfit));
    const dayProfit = dayPriced.reduce((sum, row) => sum + row.dayProfit, 0);
    return {
      pricedCount: priced.length,
      referenceCount: rows.filter((row) => row.quoteAvailable && row.quoteFailed).length,
      dayPricedCount: dayPriced.length,
      marketValue,
      costValue,
      profit,
      profitPercent: costValue > 0 ? profit / costValue * 100 : Number.NaN,
      dayProfit
    };
  }, [rows]);

  const signedMoney = (value: number) => `${value >= 0 ? "+" : ""}${fmtMoney(value)}`;
  const signedPercent = (value: number) => `${value >= 0 ? "+" : ""}${fmt(value)}%`;
  const editHolding = (item: HoldingItem) => {
    holdingEditRevision.current += 1;
    setCode(item.code);
    setShares(String(item.shares));
    setCostPrice(String(item.costPrice));
    setNote(item.note || "");
    setFormError("");
  };
  const saveHolding = async (event: FormEvent) => {
    event.preventDefault();
    const normalizedCode = code.trim();
    const normalizedShares = Number(shares);
    const normalizedCost = Number(costPrice);
    if (!/^\d{6}$/.test(normalizedCode)) {
      setFormError("请输入 6 位证券代码");
      return;
    }
    if (!/^\d+$/.test(shares.trim()) || !Number.isSafeInteger(normalizedShares) || normalizedShares <= 0) {
      setFormError("持仓数量必须是大于 0 的安全整数，请检查原始输入");
      return;
    }
    if (!Number.isFinite(normalizedCost) || normalizedCost <= 0) {
      setFormError("成本价必须大于 0");
      return;
    }
    if (submitting) return;
    const submittedRevision = holdingEditRevision.current;
    const existing = items.find(item => item.code === normalizedCode);
    setSubmitting(true);
    setFormError("");
    try {
      const choices = await window.stockApi.search(normalizedCode);
      const security = choices.find((item) => item.code === normalizedCode);
      if (!security) throw new Error("未找到该证券，请确认代码后重试");
      const timestamp = new Date().toISOString();
      const existingSellable =
        typeof existing?.sellableShares === "number" && Number.isFinite(existing.sellableShares)
          ? Math.max(0, Math.min(Math.floor(existing.sellableShares), normalizedShares))
          : undefined;
      const nextItem: HoldingItem = {
        ...security,
        shares: normalizedShares,
        ...(existingSellable !== undefined ? { sellableShares: existingSellable } : {}),
        costPrice: normalizedCost,
        note: note.trim().slice(0, 160),
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp
      };
      if (!await onSave(current => {
        const currentItem = current.find(item => item.code === normalizedCode);
        if (existing && !currentItem) return current;
        const preservedSellable =
          typeof currentItem?.sellableShares === "number" && Number.isFinite(currentItem.sellableShares)
            ? Math.max(0, Math.min(Math.floor(currentItem.sellableShares), normalizedShares))
            : undefined;
        const mergedItem: HoldingItem = {
          ...nextItem,
          createdAt: currentItem?.createdAt || nextItem.createdAt
        };
        if (preservedSellable !== undefined) mergedItem.sellableShares = preservedSellable;
        else delete mergedItem.sellableShares;
        return [...current.filter(item => item.code !== normalizedCode), mergedItem]
          .sort((left, right) => left.code.localeCompare(right.code));
      })) return;
      if (holdingEditRevision.current !== submittedRevision) return;
      setCode("");
      setShares("");
      setCostPrice("");
      setNote("");
    } catch (error) {
      setFormError(userErrorText(error, "持仓保存失败"));
    } finally {
      setSubmitting(false);
    }
  };
  const removeHolding = async (item: HoldingItem) => {
    if (removingCode || restoring) return;
    setRemovingCode(item.code);
    setRemovalError("");
    let removed: HoldingItem | undefined;
    try {
      const saved = await onSave(current => {
        removed = current.find(entry => entry.code === item.code);
        return current.filter(entry => entry.code !== item.code);
      });
      if (saved && removed) setRemovedHolding(removed);
      else if (!saved) setRemovalError("持仓移除失败，原有持仓已保留，请重试。");
    } catch {
      setRemovalError("持仓移除失败，原有持仓已保留，请重试。");
    } finally {
      setRemovingCode(null);
    }
  };
  const pasteParsed = useMemo(() => parseHoldingsPaste(pasteText), [pasteText]);
  const tradePreview = useMemo(() => {
    const cleanCode = tradeCode.trim();
    if (!/^\d{6}$/.test(cleanCode)) return null;
    const res = applyHoldingTrade({
      items,
      code: cleanCode,
      side: tradeSide,
      shares: Number(tradeShares),
      price: Number(tradePrice),
      diluteCost: tradeSide === "sell" ? tradeDiluteCost : false,
      note: tradeNote
    });
    return res;
  }, [items, tradeCode, tradeSide, tradeShares, tradePrice, tradeDiluteCost, tradeNote]);

  const sortedRows = useMemo(() => {
    if (!holdingSort) return rows;
    const { key, dir } = holdingSort;
    return rows.slice().sort((left, right) => {
      const lv = left[key];
      const rv = right[key];
      const lValid = Number.isFinite(lv);
      const rValid = Number.isFinite(rv);
      if (!lValid && !rValid) return left.item.code.localeCompare(right.item.code);
      if (!lValid) return 1;
      if (!rValid) return -1;
      return (dir === "desc" ? rv - lv : lv - rv) || left.item.code.localeCompare(right.item.code);
    });
  }, [rows, holdingSort]);

  const toggleHoldingSort = (key: "marketValue" | "profit" | "profitPercent") => {
    setHoldingSort(prev => (prev && prev.key === key ? { key, dir: prev.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));
  };

  const holdingCodeSet = useMemo(() => new Set(items.map(i => i.code)), [items]);
  const holdingAlerts = useMemo(
    () => (monitors?.alerts || []).filter(alert => holdingCodeSet.has(alert.code)),
    [monitors?.alerts, holdingCodeSet]
  );
  const tradeSummary = useMemo(() => summarizeHoldingTrades(tradeRecords, loadHoldingTradeLedger().archived), [tradeRecords]);

  const unmonitoredRows = useMemo(
    () => (monitors ? rows.filter(row => !monitors.configs[row.item.code]?.enabled) : []),
    [monitors, rows]
  );

  const submitTradeLedger = async (event: FormEvent) => {
    event.preventDefault();
    const cleanCode = tradeCode.trim();
    if (!/^\d{6}$/.test(cleanCode)) { setFormError("请输入 6 位证券代码"); return; }
    if (submitting) return;
    setSubmitting(true);
    setFormError("");
    setBatchMessage("");
    try {
      let resolved: Security | undefined;
      if (tradeSide === "buy" && !items.some(item => item.code === cleanCode) && typeof window !== "undefined" && typeof window.stockApi?.search === "function") {
        const choices = await window.stockApi.search(cleanCode);
        resolved = Array.isArray(choices) ? choices.find(entry => entry.code === cleanCode) : undefined;
        if (!resolved) throw new Error("未找到该证券，请确认代码后重试");
      }
      let summaryText = "";
      let settledPnl: number | null = null;
      let settledDilutedPnl: number | undefined;
      let settledName = resolved?.name || cleanCode;
      const numericShares = Number(tradeShares);
      const numericPrice = Number(tradePrice);
      const saved = await onSave(current => {
        const prevItem = current.find(item => item.code === cleanCode);
        const outcome = applyHoldingTrade({
          items: current,
          code: cleanCode,
          name: resolved?.name,
          secid: resolved?.secid,
          thscode: resolved?.thscode,
          marketName: resolved?.marketName,
          side: tradeSide,
          shares: numericShares,
          price: numericPrice,
          diluteCost: tradeSide === "sell" ? tradeDiluteCost : false,
          note: tradeNote
        });
        if (!outcome.ok) throw new Error(outcome.error);
        summaryText = outcome.summary;
        settledPnl = outcome.realizedPnl;
        settledDilutedPnl = outcome.dilutedPnl;
        settledName = resolved?.name || prevItem?.name || outcome.nextItems.find(item => item.code === cleanCode)?.name || cleanCode;
        return outcome.nextItems;
      });
      if (saved) {
        // 持仓已落盘：流水写失败只提示，不能走外层 catch，否则表单保留会诱导用户重复提交、重复记账。
        let ledgerWarning = "";
        try {
          setTradeRecords(appendHoldingTradeRecord({
            code: cleanCode,
            name: settledName,
            side: tradeSide,
            shares: numericShares,
            price: numericPrice,
            realizedPnl: settledPnl,
            dilutedPnl: settledDilutedPnl,
            note: tradeNote
          }));
        } catch (ledgerError) {
          ledgerWarning = userErrorText(ledgerError, "持仓已更新，但这笔成交流水未能保存，请勿重复提交本笔交易");
        }
        setBatchMessage(ledgerWarning ? `${summaryText}；${ledgerWarning}` : summaryText);
        setTradeCode("");
        setTradeShares("100");
        setTradePrice("");
        setTradeNote("");
      }
    } catch (error) {
      setFormError(userErrorText(error, "加减仓记账失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const submitPasteImport = async (event: FormEvent) => {
    event.preventDefault();
    if (!pasteParsed.entries.length) {
      setFormError("请至少粘贴 1 行有效的持仓记录（例如：600519 贵州茅台 200 1480.5）");
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    setFormError("");
    setBatchMessage("");
    try {
      const resolvedNames: Record<string, Security> = {};
      if (typeof window !== "undefined" && typeof window.stockApi?.search === "function") {
        const existingByCode = new Map(items.map(item => [item.code, item]));
        const needLookup = pasteParsed.entries.filter(row => {
          if (row.name !== row.code) return false;
          const cached = existingByCode.get(row.code);
          return !cached || !cached.name || cached.name === row.code;
        });
        const chunkSize = 8;
        for (let i = 0; i < needLookup.length; i += chunkSize) {
          const chunk = needLookup.slice(i, i + chunkSize);
          await Promise.allSettled(
            chunk.map(async row => {
              const choices = await window.stockApi.search(row.code);
              const hit = Array.isArray(choices) ? choices.find(entry => entry.code === row.code) : undefined;
              if (hit) resolvedNames[row.code] = hit;
            })
          );
        }
      }
      const saved = await onSave(current => mergeImportedHoldings(current, pasteParsed.entries, resolvedNames));
      if (saved) {
        setBatchMessage(`已导入或更新 ${pasteParsed.entries.length} 只持仓${pasteParsed.errors.length ? `（跳过 ${pasteParsed.errors.length} 行格式异常）` : ""}`);
        setPasteText("");
        setEntryMode("single");
      }
    } catch (error) {
      setFormError(userErrorText(error, "批量导入失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const handlePasteFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      let decoded = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      if (decoded.includes("\uFFFD")) {
        try {
          decoded = new TextDecoder("gbk").decode(buffer);
        } catch {
          // Keep UTF-8 decoded fallback when GBK decoder is unavailable.
        }
      }
      setPasteText(decoded.replace(/^\uFEFF/, ""));
      setFormError("");
      setBatchMessage(`已读取文件「${file.name}」，请核对下方导入预览后点击确认导入`);
    } catch {
      setFormError("持仓文件读取失败，请确认为 .csv / .tsv / .txt 文本格式");
    }
  };

  const applyBatchStopLoss = () => {
    if (!monitors?.save || !unmonitoredRows.length) return;
    let enabledCount = 0;
    for (const row of unmonitoredRows) {
      const refPrice = row.quoteAvailable && row.latest > 0 ? row.latest : row.item.costPrice;
      const cfg = buildStopLossMonitorConfig(refPrice, -5, monitors.configs[row.item.code]);
      if (cfg && monitors.save(row.item.code, cfg)) enabledCount += 1;
    }
    setBatchMessage(`已为 ${enabledCount} 只未设预警持仓统一启用 -5% 止损盯盘`);
  };

  const undoRemoval = async () => {
    if (!removedHolding || restoring || removingCode) return;
    const removed = removedHolding;
    setRestoring(true);
    setRemovalError("");
    try {
      const saved = await onSave(current => current.some(entry => entry.code === removed.code)
        ? current
        : [...current, removed].sort((left, right) => left.code.localeCompare(right.code)));
      if (saved) setRemovedHolding(current => current === removed ? null : current);
      else setRemovalError("撤销移除失败，恢复记录已保留，请重试。");
    } catch {
      setRemovalError("撤销移除失败，恢复记录已保留，请重试。");
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="holdings-workspace">
      <PageHeading
        eyebrow="PERSONAL HOLDINGS BOARD"
        title="持仓股"
        description="持仓数据仅保存在本机；支持单只录入、买卖加减仓自动摊薄成本、多行粘贴导入及一键止损盯盘。"
        actions={<button className="secondary-btn" onClick={() => { void refreshQuotes(); if (ledgerTab === "paper") void onRefreshPaperPositions?.(); }} disabled={refreshing}>{refreshing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}刷新行情</button>}
      />
      {hasPaperSwitch && (
        <div className="holdings-mode-tabs holdings-account-tabs" role="tablist" aria-label="实盘与模拟盘持仓切换">
          <button type="button" role="tab" aria-selected={ledgerTab === "real"} className={ledgerTab === "real" ? "active" : ""} onClick={() => setLedgerTab("real")}>
            实盘持仓 ({items.length})
          </button>
          <button type="button" role="tab" aria-selected={ledgerTab === "paper"} className={ledgerTab === "paper" ? "active" : ""} onClick={() => { setLedgerTab("paper"); void onRefreshPaperPositions?.(); }}>
            模拟盘持仓 ({paperPositions?.length ?? 0})
          </button>
        </div>
      )}
      {hasPaperSwitch && ledgerTab === "paper" ? (
        <>
          <section className="panel holdings-summary-panel">
            <PanelTitle title="模拟盘总览" subtitle="与驾驶舱及个股分析纸面交易实时同步" icon={WalletCards} badge={`${paperPositions?.length ?? 0} 只`} />
            <div className="fact-grid holdings-summary-grid">
              <Fact label="模拟账户总权益" value={typeof paperMetrics?.equity === "number" ? maskSensitiveText(fmtMoney(paperMetrics.equity), privacyMask) : "--"} />
              <Fact label="模拟持仓市值" value={typeof paperMetrics?.openValue === "number" ? maskSensitiveText(fmtMoney(paperMetrics.openValue), privacyMask) : "--"} />
              <Fact
                label="模拟浮动盈亏"
                value={typeof paperMetrics?.openPnl === "number" ? `${maskSensitiveText(signedMoney(paperMetrics.openPnl), privacyMask)}${typeof paperMetrics?.openPnlPercent === "number" ? `（${signedPercent(paperMetrics.openPnlPercent)}）` : ""}` : "--"}
                tone={typeof paperMetrics?.openPnl === "number" && paperMetrics.openPnl !== 0 ? (paperMetrics.openPnl > 0 ? "up" : "down") : ""}
              />
              <Fact
                label="模拟累计已实现盈亏"
                value={typeof paperMetrics?.cumulativeRealizedPnl === "number" ? maskSensitiveText(signedMoney(paperMetrics.cumulativeRealizedPnl), privacyMask) : "--"}
                tone={typeof paperMetrics?.cumulativeRealizedPnl === "number" && paperMetrics.cumulativeRealizedPnl !== 0 ? (paperMetrics.cumulativeRealizedPnl > 0 ? "up" : "down") : ""}
              />
            </div>
          </section>
          <section className="panel holdings-table-panel">
            <PanelTitle title="模拟盘持仓明细" subtitle="支持一键跳转个股深度分析或手动平仓" icon={LineChart} />
            {paperPositions && paperPositions.length > 0 ? (
              <div className="table holdings-table" role="table" aria-label="模拟盘持仓明细">
                <div className="th tr" role="row">
                  <span role="columnheader">股票</span>
                  <span role="columnheader">股数 / 入场均价</span>
                  <span role="columnheader">现价 / 止损止盈</span>
                  <span role="columnheader">市值</span>
                  <span role="columnheader">浮动盈亏</span>
                  <span role="columnheader">操作</span>
                </div>
                {paperPositions.map(pos => {
                  const mktVal = pos.latestPrice * pos.shares;
                  const pnl = (pos.latestPrice - pos.entryPrice) * pos.shares - pos.entryFee;
                  const costBase = pos.entryPrice * pos.shares + pos.entryFee;
                  const pnlPct = costBase > 0 ? (pnl / costBase) * 100 : 0;
                  const assetType: Security["assetType"] =
                    pos.code.startsWith("11") || pos.code.startsWith("12")
                      ? "convertibleBond"
                      : pos.code.startsWith("5") || pos.code.startsWith("159")
                        ? "etf"
                        : "stock";
                  const sec: Security = { code: pos.code, name: pos.name, secid: inferSecid(pos.code), assetType };
                  return (
                    <div className="tr" key={pos.id || pos.code} role="row">
                      <span role="rowheader" className="stock-cell"><b>{pos.name}</b><small>{pos.code}</small></span>
                      <span role="cell">{maskSensitiveText(pos.shares.toLocaleString("zh-CN"), privacyMask)} 股 <small>成本 {fmt(pos.entryPrice)} 元</small></span>
                      <span role="cell"><b>{fmt(pos.latestPrice)} 元</b><small>止损 {fmt(pos.stopPrice)} · 止盈 {fmt(pos.takePrice)}</small></span>
                      <span role="cell">{maskSensitiveText(fmtMoney(mktVal), privacyMask)}</span>
                      <span role="cell" className={Number.isFinite(pnl) ? (pnl >= 0 ? "holding-pnl up" : "holding-pnl down") : ""}><b>{maskSensitiveText(signedMoney(pnl), privacyMask)}</b><small>{signedPercent(pnlPct)}</small></span>
                      <span role="cell" className="holdings-row-actions">
                        {onOpenPaperStock && <button type="button" className="table-action" onClick={() => onOpenPaperStock(sec)}>分析</button>}
                        {Boolean(pos.settlementBlockedReason) && onConfirmPaperSettlement && (
                          <button type="button" className="table-action" title={pos.settlementBlockedReason} onClick={() => onConfirmPaperSettlement(pos.code)}>确认除权基准</button>
                        )}
                        {onClosePaperPosition && <button type="button" className="table-action danger" onClick={() => onClosePaperPosition(pos.code)}>平仓</button>}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="favorites-empty holdings-empty"><WalletCards size={32} /><b>当前没有模拟盘持仓</b><span>可在个股深度分析页根据信号执行纸面建仓演练。</span></div>
            )}
          </section>
        </>
      ) : (
      <>
      <section className="panel holdings-summary-panel">
        <PanelTitle title="持仓总览" subtitle={`本轮有效报价 ${summary.pricedCount}/${items.length} 条；汇总仅覆盖本轮有效报价的持仓`} icon={WalletCards} badge={`${items.length} 只`} />
        {summary.referenceCount > 0 && <p className="warning-banner" role="status">{summary.referenceCount} 只持仓刷新失败，上次报价仅供参考，不计入汇总。</p>}
        <div className="fact-grid holdings-summary-grid">
          <Fact label="持仓市值" value={summary.pricedCount ? maskSensitiveText(fmtMoney(summary.marketValue), privacyMask) : "--"} />
          <Fact label="持仓成本" value={summary.pricedCount ? maskSensitiveText(fmtMoney(summary.costValue), privacyMask) : "--"} />
          <Fact
            label="浮动盈亏"
            value={summary.pricedCount ? `${maskSensitiveText(signedMoney(summary.profit), privacyMask)}（${signedPercent(summary.profitPercent)}）` : "--"}
            tone={summary.pricedCount && summary.profit !== 0 ? summary.profit > 0 ? 'up' : 'down' : ''}
          />
          <Fact
            label="按昨收估算今日盈亏"
            value={summary.dayPricedCount ? maskSensitiveText(signedMoney(summary.dayProfit), privacyMask) : "--"}
            tone={summary.dayPricedCount && summary.dayProfit !== 0 ? summary.dayProfit > 0 ? 'up' : 'down' : ''}
          />
        </div>
      </section>
      <div className="holdings-workspace-grid">
      <section className="panel holdings-entry-panel">
        <PanelTitle title="录入或更新持仓" subtitle="支持单笔覆盖保存、按买卖成交自动重算摊薄成本，或直接从券商/表格粘贴批量导入。" icon={BookmarkCheck} />
        <div className="holdings-mode-tabs" role="tablist" aria-label="持仓录入方式">
          <button type="button" role="tab" aria-selected={entryMode === "single"} className={entryMode === "single" ? "active" : ""} onClick={() => { setEntryMode("single"); setFormError(""); }}>
            <BookmarkCheck size={14} />录入/更新
          </button>
          <button type="button" role="tab" aria-selected={entryMode === "trade"} className={entryMode === "trade" ? "active" : ""} onClick={() => { setEntryMode("trade"); setFormError(""); }}>
            <PlusCircle size={14} />加减仓记账
          </button>
          <button type="button" role="tab" aria-selected={entryMode === "paste"} className={entryMode === "paste" ? "active" : ""} onClick={() => { setEntryMode("paste"); setFormError(""); }}>
            <ClipboardPaste size={14} />粘贴批量导入
          </button>
        </div>

        {entryMode === "single" && (
          <form className="holdings-entry-form" onSubmit={saveHolding}>
            <input aria-label="证券代码" value={code} onChange={(event) => { holdingEditRevision.current += 1; setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); }} placeholder="证券代码，如 600519" inputMode="numeric" />
            <input aria-label="持仓数量" value={shares} onChange={(event) => { holdingEditRevision.current += 1; setShares(event.target.value); }} placeholder="持仓数量（股）" inputMode="numeric" />
            <input aria-label="成本价" value={costPrice} onChange={(event) => { holdingEditRevision.current += 1; setCostPrice(event.target.value); }} placeholder="成本价" inputMode="decimal" />
            <input aria-label="持仓备注" value={note} onChange={(event) => { holdingEditRevision.current += 1; setNote(event.target.value); }} placeholder="备注（可选）" maxLength={160} />
            <button className="primary-btn" type="submit" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} /> : <BookmarkCheck size={16} />}保存持仓</button>
          </form>
        )}

        {entryMode === "trade" && (
          <form className="holdings-entry-form holdings-trade-form" onSubmit={e => void submitTradeLedger(e)}>
            <div className="holdings-trade-side-tabs" role="group" aria-label="交易方向">
              <button type="button" className={tradeSide === "buy" ? "active buy" : ""} onClick={() => setTradeSide("buy")}>+ 买入/加仓</button>
              <button type="button" className={tradeSide === "sell" ? "active sell" : ""} onClick={() => setTradeSide("sell")}>- 卖出/减仓</button>
            </div>
            {items.length > 0 && (
              <select
                aria-label="快捷选择已有持仓"
                value={items.some(i => i.code === tradeCode) ? tradeCode : ""}
                onChange={e => {
                  const selected = items.find(i => i.code === e.target.value);
                  if (!selected) return;
                  setTradeCode(selected.code);
                  const livePrice = Number(quotes[selected.code]?.quote?.latest);
                  setTradePrice(Number.isFinite(livePrice) && livePrice > 0 ? livePrice.toFixed(2) : String(selected.costPrice));
                }}
              >
                <option value="">选择已有持仓（或直接输代码）</option>
                {items.map(item => <option key={item.code} value={item.code}>{item.name} ({item.code}) · {item.shares}股 @ {fmt(item.costPrice)}</option>)}
              </select>
            )}
            <input aria-label="交易证券代码" value={tradeCode} onChange={e => setTradeCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="6 位股票代码" inputMode="numeric" />
            <input aria-label="交易股数" value={tradeShares} onChange={e => setTradeShares(e.target.value)} placeholder="成交股数，如 100" inputMode="numeric" />
            <input aria-label="成交均价" value={tradePrice} onChange={e => setTradePrice(e.target.value)} placeholder="成交均价" inputMode="decimal" />
            <input aria-label="交易备注" value={tradeNote} onChange={e => setTradeNote(e.target.value)} placeholder="交易原因/计划备注（可选）" maxLength={160} />
            {tradeSide === "sell" && (
              <label className="holdings-dilute-check">
                <input type="checkbox" checked={tradeDiluteCost} onChange={e => setTradeDiluteCost(e.target.checked)} />
                <span>按卖出盈亏摊薄剩余持仓成本</span>
              </label>
            )}
            {tradePreview && (
              <div className={`holdings-trade-preview ${tradePreview.ok ? "ok" : "warn"}`} role="status">
                {tradePreview.ok ? tradePreview.summary : tradePreview.error}
              </div>
            )}
            <button className="primary-btn" type="submit" disabled={submitting}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <PlusCircle size={16} />}
              {tradeSide === "buy" ? "确认加仓并重算成本" : "确认减仓并结算"}
            </button>
          </form>
        )}

        {entryMode === "paste" && (
          <form className="holdings-paste-form" onSubmit={e => void submitPasteImport(e)}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
              <label className="secondary-btn" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <Upload size={14} />
                导入 .csv / .tsv / .txt 文件
                <input
                  type="file"
                  accept=".csv,.tsv,.txt"
                  aria-label="选择持仓文件导入"
                  style={{ display: "none" }}
                  onChange={e => void handlePasteFileChange(e)}
                />
              </label>
              <small style={{ opacity: 0.72 }}>支持券商导出的 CSV/TSV/TXT 持仓表或直接粘贴</small>
            </div>
            <textarea
              rows={5}
              aria-label="粘贴持仓明细"
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder={"直接从券商持仓页或表格复制粘贴，每行一只：\n600519 贵州茅台 200 1480.5 底仓\n000001 平安银行 1000 1000 14.85 15.20\n300059,500,21.8"}
            />
            {(pasteParsed.entries.length > 0 || pasteParsed.errors.length > 0) && (
              <div className="holdings-paste-preview">
                <small>
                  识别有效记录 <b>{pasteParsed.entries.length}</b> 条
                  {pasteParsed.entries.some(row => row.availableShares !== undefined) ? "（已自动识别券商多列持仓/可用/成本）" : ""}
                  {pasteParsed.errors.length > 0 ? ` · 待修正 ${pasteParsed.errors.length} 行` : ""}
                </small>
                {pasteParsed.entries.length > 0 && (
                  <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 8 }}>
                    <table className="watch-stock-table" aria-label="持仓导入预览确认表">
                      <thead>
                        <tr>
                          <th scope="col">代码</th>
                          <th scope="col">名称</th>
                          <th scope="col">持仓股数</th>
                          <th scope="col">可用股数</th>
                          <th scope="col">成本价</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pasteParsed.entries.map(row => (
                          <tr key={row.code}>
                            <td>{row.code}</td>
                            <td>{row.name}</td>
                            <td>{row.shares.toLocaleString("zh-CN")}</td>
                            <td>{row.availableShares !== undefined ? row.availableShares.toLocaleString("zh-CN") : "—"}</td>
                            <td>{fmt(row.costPrice)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {pasteParsed.errors.slice(0, 3).map((err, i) => <p key={i} className="holdings-form-error">{err}</p>)}
              </div>
            )}
            <button className="primary-btn" type="submit" disabled={submitting || !pasteParsed.entries.length}>
              {submitting ? <LoaderCircle className="spin" size={16} /> : <ClipboardPaste size={16} />}
              确认导入或更新 ({pasteParsed.entries.length} 只)
            </button>
          </form>
        )}

        {formError && <div className="holdings-form-error" role="alert">{formError}</div>}
        {batchMessage && <div className="holdings-batch-notice" role="status">{batchMessage}</div>}
      </section>
      <section className="panel holdings-table-panel">
        <PanelTitle
          title="持仓明细"
          subtitle="报价暂不可用时保留持仓，不使用成本价伪造实时盈亏。"
          icon={LineChart}
          badge={rows.length && monitors ? (unmonitoredRows.length ? `${unmonitoredRows.length} 只未设止损` : "已全设盯盘") : undefined}
        />
        {rows.length > 0 && monitors && unmonitoredRows.length > 0 && (
          <div className="holdings-quick-bar">
            <span>还有 <b>{unmonitoredRows.length}</b> 只持仓未启用条件盯盘，建议至少设定 -5% 止损防守线。</span>
            <button type="button" className="secondary-btn" onClick={applyBatchStopLoss}>
              <ShieldAlert size={14} />为未设盯盘持仓一键加 -5% 止损
            </button>
          </div>
        )}
        {removedHolding && <div className="warning-banner" role="status">已移除 {removedHolding.name}（{removedHolding.code}）<button type="button" className="table-action" aria-label="撤销移除" disabled={restoring || Boolean(removingCode)} onClick={() => void undoRemoval()}>{restoring ? "正在恢复" : "撤销"}</button></div>}
        {removalError && <p className="holdings-form-error" role="alert">{removalError}</p>}
        {rows.length ? (
          <>
          <div className="table holdings-table" role="table" aria-label="持仓明细">
            <div className="th tr" role="row">
              <span role="columnheader">股票 / 备注</span>
              <span role="columnheader">持仓 / 成本 / 止损</span>
              <span role="columnheader">行情 / 更新时间</span>
              <span role="columnheader" aria-sort={holdingSort?.key === "marketValue" ? (holdingSort.dir === "desc" ? "descending" : "ascending") : "none"}>
                <button type="button" className={`column-sort-button${holdingSort?.key === "marketValue" ? " active" : ""}`} onClick={() => toggleHoldingSort("marketValue")}>
                  市值{holdingSort?.key === "marketValue" ? (holdingSort.dir === "desc" ? " ▾" : " ▴") : ""}
                </button>
              </span>
              <span role="columnheader" aria-sort={holdingSort?.key === "profit" || holdingSort?.key === "profitPercent" ? (holdingSort.dir === "desc" ? "descending" : "ascending") : "none"}>
                <button type="button" className={`column-sort-button${holdingSort?.key === "profit" ? " active" : ""}`} onClick={() => toggleHoldingSort("profit")}>
                  浮盈额{holdingSort?.key === "profit" ? (holdingSort.dir === "desc" ? " ▾" : " ▴") : ""}
                </button>
                {" / "}
                <button type="button" className={`column-sort-button${holdingSort?.key === "profitPercent" ? " active" : ""}`} onClick={() => toggleHoldingSort("profitPercent")}>
                  浮盈率{holdingSort?.key === "profitPercent" ? (holdingSort.dir === "desc" ? " ▾" : " ▴") : ""}
                </button>
              </span>
              <span role="columnheader">操作</span>
            </div>
            {sortedRows.map((row) => {
              const holdingWithSellable = row.item as HoldingItemWithSellable;
              const sellableShares =
                typeof holdingWithSellable.sellableShares === "number" && Number.isFinite(holdingWithSellable.sellableShares)
                  ? holdingWithSellable.sellableShares
                  : undefined;
              const cfg = monitors?.configs?.[row.item.code];
              const stopPrice = computeMonitorStopPrice(cfg);
              const stopGapPct = stopPrice && row.quoteAvailable && row.latest > 0
                ? ((row.latest - stopPrice) / row.latest) * 100
                : null;
              return (
              <div className="tr" key={row.item.code} role="row">
                <span role="rowheader" className="stock-cell" title={row.item.note || row.item.name}>
                  <b>{row.item.name}</b>
                  <small>
                    {row.item.code}
                    {onTransferToT && (
                      <> · <button type="button" className="link-btn holdings-inline-link" onClick={() => onTransferToT(holdingWithSellable)}><ArrowLeftRight size={11} />转做T</button></>
                    )}
                  </small>
                </span>
                <span role="cell">
                  {maskSensitiveText(row.item.shares.toLocaleString("zh-CN"), privacyMask)} 股
                  {sellableShares !== undefined && (
                    <small> · 可用 {maskSensitiveText(sellableShares.toLocaleString("zh-CN"), privacyMask)} 股</small>
                  )}{" "}
                  <small>成本 {fmt(row.item.costPrice)} 元</small>
                  <small className={stopPrice ? "tone-ok" : cfg?.enabled ? "tone-ok" : "tone-warn"}>
                    {stopPrice
                      ? `止损 ≤ ${stopPrice.toFixed(2)}${stopGapPct !== null ? ` (距 ${stopGapPct.toFixed(1)}%)` : ""}`
                      : cfg?.enabled
                        ? "已设条件盯盘"
                        : "未设止损预警"}
                  </small>
                </span>
                <span role="cell">{row.quoteAvailable ? <><b>{fmt(row.latest)} 元</b><small className={Number.isFinite(row.changePct) ? row.changePct >= 0 ? "holding-pnl up" : "holding-pnl down" : ""}>{Number.isFinite(row.changePct) ? signedPercent(row.changePct) : "--"}</small><small>{row.quoteFailed ? "上次报价" : "报价更新"} {formatShanghaiDateTime(row.quoteUpdatedAt)}{row.quoteFailed ? " · 刷新失败" : ""}</small></> : <small>{row.quoteFailed ? "刷新失败，报价待恢复" : "等待报价"}</small>}</span>
                <span role="cell">{row.quoteAvailable ? <>{maskSensitiveText(fmtMoney(row.marketValue), privacyMask)}{row.quoteFailed && <small>参考市值</small>}</> : "--"}</span>
                <span role="cell" className={row.quoteAvailable && Number.isFinite(row.profit) ? (row.profit >= 0 ? "holding-pnl up" : "holding-pnl down") : ""}>{row.quoteAvailable ? <><b>{maskSensitiveText(signedMoney(row.profit), privacyMask)}</b><small>{signedPercent(row.profitPercent)}{row.quoteFailed ? " · 参考盈亏" : ""}</small></> : "--"}</span>
                <span role="cell" className="holdings-row-actions">
                  <button className="table-action" onClick={() => onOpen(row.item)}>分析</button>
                  <button className="table-action" onClick={() => { setEntryMode("single"); editHolding(row.item); }}>编辑</button>
                  {monitors && <button className="table-action" onClick={() => setEditingMonitorCode(editingMonitorCode === row.item.code ? null : row.item.code)}>{monitors.configs[row.item.code]?.enabled ? "盯盘中" : "盯盘"}</button>}
                  <button className="table-action danger" disabled={Boolean(removingCode) || restoring} onClick={() => void removeHolding(row.item)}>{removingCode === row.item.code ? "正在移除" : "移除"}</button>
                </span>
              </div>
              );
            })}
          </div>
          {monitors && editingMonitorCode && (() => {
            const target = items.find(entry => entry.code === editingMonitorCode);
            if (!target) return null;
            return <StockMonitorEditor key={target.code} stock={target} config={monitors.configs[target.code]} onCancel={() => setEditingMonitorCode(null)} onSave={next => {
              const ok = monitors.save(target.code, next);
              if (ok) setEditingMonitorCode(null);
              return ok;
            }} />;
          })()}
          </>
        ) : (
          <div className="favorites-empty holdings-empty"><WalletCards size={32} /><b>还没有录入持仓</b><span>输入证券代码、数量和成本价后保存；数据只留在本机。</span></div>
        )}
      </section>
      </div>
      {holdingAlerts.length > 0 && (
        <section className="panel monitor-alert-panel holdings-alert-panel">
          <header>
            <Bell size={17} />
            <h3>持仓盯盘预警记录</h3>
            <span>共 {holdingAlerts.length} 条</span>
            {(monitors?.ackAlert || monitors?.clearAlerts) && (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  if (monitors?.clearAlerts) {
                    monitors.clearAlerts([...holdingCodeSet]);
                  } else {
                    holdingAlerts.forEach(alert => monitors?.ackAlert?.(alert.id));
                  }
                }}
              >
                清空持仓预警
              </button>
            )}
          </header>
          <div>
            {holdingAlerts.map(alert => {
              const matchedHolding = items.find(entry => entry.code === alert.code);
              const openAlertHolding = () => {
                onOpen(matchedHolding || {
                  code: alert.code,
                  name: alert.name,
                  secid: inferSecid(alert.code),
                  assetType: "stock",
                  shares: 0,
                  costPrice: 0,
                  createdAt: "",
                  updatedAt: ""
                });
              };
              return (
                <article
                  key={alert.id}
                  className="monitor-alert-clickable"
                  style={{ cursor: "pointer" }}
                  onClick={openAlertHolding}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                    <button
                      type="button"
                      className="link-btn"
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: 0, textAlign: "left" }}
                      onClick={event => {
                        event.stopPropagation();
                        openAlertHolding();
                      }}
                    >
                      <b>{alert.name}</b>
                      <span>{alert.code}</span>
                      <time>{formatShanghaiDateTime(alert.triggeredAt)}</time>
                    </button>
                    {monitors?.ackAlert && (
                      <button
                        type="button"
                        className="table-action"
                        aria-label={`确认持仓预警 ${alert.name} ${alert.code}`}
                        onClick={event => {
                          event.stopPropagation();
                          monitors.ackAlert(alert.id);
                        }}
                      >
                        <Check size={12} />已读
                      </button>
                    )}
                  </div>
                  <p>{alert.detail}</p>
                </article>
              );
            })}
          </div>
        </section>
      )}
      <details className="panel holdings-trades-ledger-panel">
        <summary>
          <History size={16} />
          <b>实盘成交流水与累计已实现盈亏</b>
          <span>
            共 {tradeSummary.totalCount} 笔成交
            {tradeSummary.sellCount > 0 ? ` · 卖出结算 ${tradeSummary.sellCount} 笔（胜 ${tradeSummary.winCount}）· 累计已实现盈亏 ${maskSensitiveText(signedMoney(tradeSummary.cumulativeRealizedPnl), privacyMask)}${tradeSummary.cumulativeDilutedPnl ? `（另有 ${maskSensitiveText(signedMoney(tradeSummary.cumulativeDilutedPnl), privacyMask)} 已摊薄进持仓成本）` : ""}` : ""}
          </span>
        </summary>
        {tradeRecords.length > 0 ? (
          <div className="holdings-trades-ledger-body">
            <div className="holdings-trades-ledger-actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  setClearTradesConfirm({
                    title: "清空实盘成交流水",
                    message: "将永久删除本机保存的全部实盘成交流水与累计已实现盈亏统计，且无法撤销。",
                    details: ["当前持仓数量和成本不会受影响，仅清空历史成交归档记录。"],
                    confirmLabel: "清空记录",
                    tone: "danger"
                  });
                }}
              >
                <Trash2 size={14} />清空成交流水
              </button>
            </div>
            <table className="watch-stock-table">
              <thead>
                <tr>
                  <th scope="col">时间</th>
                  <th scope="col">股票</th>
                  <th scope="col">方向</th>
                  <th scope="col">股数</th>
                  <th scope="col">成交均价</th>
                  <th scope="col">实现盈亏</th>
                </tr>
              </thead>
              <tbody>
                {tradeRecords.slice(0, 50).map(rec => (
                  <tr key={rec.id}>
                    <td>{formatShanghaiDateTime(rec.tradedAt)}</td>
                    <td><b>{rec.name}</b> <small>{rec.code}</small></td>
                    <td className={rec.side === "buy" ? "up" : "down"}>{rec.side === "buy" ? "买入/加仓" : "卖出/减仓"}</td>
                    <td>{maskSensitiveText(rec.shares.toLocaleString("zh-CN"), privacyMask)} 股</td>
                    <td>{fmt(rec.price)} 元</td>
                    <td className={rec.realizedPnl === null ? "" : rec.realizedPnl >= 0 ? "up" : "down"}>
                      {rec.realizedPnl === null ? "—" : maskSensitiveText(signedMoney(rec.realizedPnl), privacyMask)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-inline">尚无实盘成交流水；在「加减仓记账」或个股分析页快捷加减仓后会自动归档。</p>
        )}
      </details>
      </>
      )}
      <ConfirmDialog
        request={clearTradesConfirm}
        onResolve={(confirmed) => {
          setClearTradesConfirm(null);
          if (!confirmed) return;
          if (!clearHoldingTrades()) {
            emitAppToast("清空成交流水失败，本机存储写入受限，已保留原有记录");
            return;
          }
          setTradeRecords([]);
          emitAppToast("已清空实盘成交流水");
        }}
      />
    </div>
  );
}

type WatchQuoteValue = WatchQuote;
type OptionalQuoteApi = {
  getQuote?: ((security: Security) => Promise<{
    quote?: { latest?: number | null; price?: number | null; changePct?: number | null };
    latest?: number | null;
    price?: number | null;
    changePct?: number | null;
  }>) | undefined;
  getQuoteSnapshot?: ((security: Security) => Promise<{
    quote?: { latest?: number | null; price?: number | null; changePct?: number | null };
  }>) | undefined;
  getBatchQuotes?: ((securities: BatchQuoteRequest[]) => Promise<BatchQuoteResult>) | undefined;
};

export function WatchlistView({
  items,
  activeNode,
  quotes,
  favoriteCodes,
  live = true,
  onAddFavorite,
  onToggleFavorite,
  onOpenMonitor,
  onNavigate,
  onShowToast,
  onNodeChange,
  onOpen,
  onRemove
}: {
  items: WatchItem[];
  activeNode: string;
  quotes?: Record<string, WatchQuoteValue> | undefined;
  favoriteCodes?: ReadonlySet<string> | undefined;
  live?: boolean | undefined;
  onAddFavorite?: ((item: WatchItem) => void) | undefined;
  onToggleFavorite?: ((security: Security) => void) | undefined;
  onOpenMonitor?: ((security: Security) => void) | undefined;
  onNavigate?: ((view: WorkspaceView) => void) | undefined;
  onShowToast?: ((message: string) => void) | undefined;
  onNodeChange: (node: string) => void;
  onOpen: (item: WatchItem) => void;
  onRemove: (item: WatchItem) => void;
}) {
  const [filter, setFilter] = useState("");
  const [fetchedQuotes, setFetchedQuotes] = useState<Record<string, WatchQuoteValue>>({});
  const [sort, setSort] = useState<WatchSort>(null);
  const [batchFailed, setBatchFailed] = useState(false);
  const [quoteMeta, setQuoteMeta] = useState<{ source: string; at: number } | null>(null);
  const [planTarget, setPlanTarget] = useState<QuickPlanTarget | null>(null);
  const [plannedCodes] = usePlannedCodes();
  const tableScroll = useRef<HTMLDivElement>(null);
  const fetchSeqRef = useRef(0);
  const batchSeqRef = useRef(0);
  const tabs = [{ id: "all", label: "全部十日" }, ...Array.from({ length: 10 }, (_, index) => ({ id: `T+${index + 1}`, label: `T+${index + 1}` }))];
  const nodeFor = (item: WatchItem) => item.observationNode || (
    Number(item.tradingDaysSince) >= 1 && Number(item.tradingDaysSince) <= 10
      ? `T+${item.tradingDaysSince}` : "手动"
  );
  const counts = Object.fromEntries(tabs.map(tab => [tab.id, tab.id === "all" ? items.length : items.filter(item => nodeFor(item) === tab.id).length]));
  const visibleItems = useMemo(
    () => items.filter(item => (activeNode === "all" || nodeFor(item) === activeNode) &&
      (!filter.trim() || `${item.name} ${item.code}`.toLowerCase().includes(filter.trim().toLowerCase()))),
    [items, activeNode, filter]
  );
  const mergedQuotes = useMemo(() => ({ ...(quotes || {}), ...fetchedQuotes }), [quotes, fetchedQuotes]);
  const displayedItems = useMemo(() => sortWatchItems(visibleItems, mergedQuotes, sort), [visibleItems, mergedQuotes, sort]);
  const virtual = useVirtualWindow({
    itemCount: displayedItems.length,
    rowHeight: 29,
    overscan: 10,
    threshold: 80,
    containerRef: tableScroll
  });
  const windowedItems = virtual.enabled
    ? displayedItems.slice(virtual.startIndex, virtual.endIndex)
    : displayedItems;
  const windowedKey = useMemo(
    () => windowedItems.slice(0, 60).map(item => item.code).join(","),
    [windowedItems]
  );
  const windowedRef = useRef(windowedItems);
  windowedRef.current = windowedItems;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const allCodesKey = useMemo(() => [...new Set(items.map(item => item.code))].sort().join(","), [items]);

  useEffect(() => { tableScroll.current?.scrollTo({ top: 0, left: 0 }); }, [activeNode, filter, sort]);

  useEffect(() => {
    const api = typeof window !== "undefined" ? (window.stockApi as unknown as OptionalQuoteApi | undefined) : undefined;
    const getBatchQuotes = api?.getBatchQuotes;
    if (typeof getBatchQuotes !== "function" || !allCodesKey) return undefined;
    let active = true;
    const runBatch = async () => {
      const seq = ++batchSeqRef.current;
      const seen = new Set<string>();
      const securities: BatchQuoteRequest[] = [];
      for (const item of itemsRef.current) {
        if (seen.has(item.code) || securities.length >= 1200) continue;
        seen.add(item.code);
        securities.push({
          code: item.code,
          secid: item.secid || inferSecid(item.code),
          ...(item.thscode ? { thscode: item.thscode } : {}),
          assetType: item.assetType || "stock"
        });
      }
      try {
        const result = await getBatchQuotes(securities);
        if (!active || batchSeqRef.current !== seq) return;
        setFetchedQuotes(prev => ({ ...prev, ...toWatchQuotes(result) }));
        setQuoteMeta({ source: result?.source || "腾讯行情", at: Date.now() });
        setBatchFailed(false);
      } catch {
        if (active && batchSeqRef.current === seq) setBatchFailed(true);
      }
    };
    void runBatch();
    if (!live) return () => { active = false; batchSeqRef.current += 1; };
    const stop = startVisibleInterval(() => { void runBatch(); }, 15_000);
    return () => {
      active = false;
      batchSeqRef.current += 1;
      stop();
    };
  }, [allCodesKey, live]);

  const batchApiMissing = typeof window !== "undefined" &&
    typeof (window.stockApi as unknown as OptionalQuoteApi | undefined)?.getBatchQuotes !== "function";
  const fallbackActive = batchApiMissing || batchFailed;

  useEffect(() => {
    const api = typeof window !== "undefined" ? (window.stockApi as unknown as OptionalQuoteApi | undefined) : undefined;
    const fetchOne = api?.getQuote ?? api?.getQuoteSnapshot;
    if (!fallbackActive || typeof fetchOne !== "function" || !windowedKey) return undefined;
    let active = true;
    const runFetch = async () => {
      const seq = ++fetchSeqRef.current;
      const queue = windowedRef.current.slice(0, 60);
      if (!queue.length) return;
      const updates: Array<readonly [string, WatchQuoteValue]> = [];
      const workerCount = Math.min(3, queue.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (queue.length && active && fetchSeqRef.current === seq) {
          const item = queue.shift();
          if (!item) return;
          try {
            const res = await fetchOne({
              code: item.code,
              name: item.name,
              secid: item.secid || inferSecid(item.code),
              assetType: item.assetType || "stock"
            });
            const q = res && "quote" in res && res.quote ? res.quote : (res as { latest?: number | null; price?: number | null; changePct?: number | null } | undefined);
            const rawLatest = Number(q?.latest ?? q?.price);
            const rawChange = q?.changePct === null || q?.changePct === undefined ? Number.NaN : Number(q.changePct);
            if (Number.isFinite(rawLatest) && rawLatest > 0) {
              updates.push([item.code, {
                latest: rawLatest,
                changePct: Number.isFinite(rawChange) ? rawChange : null
              }] as const);
            }
          } catch {
            // Keep prior quote on transient failure
          }
        }
      }));
      if (!active || fetchSeqRef.current !== seq || !updates.length) return;
      setFetchedQuotes(prev => {
        const next = { ...prev };
        for (const [itemCode, value] of updates) {
          next[itemCode] = value;
        }
        return next;
      });
      setQuoteMeta({ source: "同花顺", at: Date.now() });
    };
    void runFetch();
    if (!live) return () => { active = false; fetchSeqRef.current += 1; };
    const stop = startVisibleInterval(() => { void runFetch(); }, 15_000);
    return () => {
      active = false;
      fetchSeqRef.current += 1;
      stop();
    };
  }, [windowedKey, live, fallbackActive]);

  const quoteStats = useMemo(() => watchQuoteStats(visibleItems, mergedQuotes), [visibleItems, mergedQuotes]);
  const quoteStatusText = batchFailed
    ? "批量行情暂时没取到，正在逐只读取前 60 只"
    : !quoteMeta && quoteStats.quoted === 0
      ? "正在读取行情…"
      : `行情 ${quoteStats.quoted}/${visibleItems.length} 只${quoteMeta ? `（${quoteMeta.source} ${formatShanghaiTime(quoteMeta.at)}）` : ""} · 上涨 ${quoteStats.up} · 下跌 ${quoteStats.down} · 平 ${quoteStats.flat} · 涨停 ${quoteStats.limitUp}`;

  return (
    <div className="ten-day-workspace">
      <header className="watch-toolbar">
        <div><h1>十日观察池</h1><span>{items.length} 只</span></div>
        <label className="watch-filter"><Search size={15} /><input aria-label="筛选观察池股票名称或代码" placeholder="名称 / 代码" value={filter} onChange={event => setFilter(event.target.value)} />{filter && <button aria-label="清空观察池筛选" onClick={() => setFilter("")}><X size={14} /></button>}</label>
      </header>
      <MonitorSubTabs active="watchlist" onNavigate={onNavigate} />
      <p className="watch-table-guide" id="watch-observation-guide">当前显示 {visibleItems.length} / {items.length} 只 · T+1 为涨停后的第 1 个交易日，依次观察至 T+10；连板为涨停日记录。</p>
      <p className="watch-quote-status" role="status">{quoteStatusText}</p>
      <div className="watch-node-tabs" role="group" aria-label="观察交易日">
        {tabs.map(tab => (
          <button key={tab.id} className={activeNode === tab.id ? "active" : ""} aria-pressed={activeNode === tab.id} onClick={() => onNodeChange(tab.id)}>
            <span>{tab.label}</span><b>{counts[tab.id]}</b>
          </button>
        ))}
      </div>
      <div className="watch-workspace-columns">
        <section className="panel watch-stock-panel" aria-label="十日观察股票">
          {visibleItems.length ? <>
            <div
              className="watch-table-scroll"
              ref={tableScroll}
              onScroll={virtual.enabled ? virtual.onScroll : undefined}
              style={virtual.enabled ? { maxHeight: 620, overflowY: "auto" } : undefined}
            >
              <table className="watch-stock-table" aria-describedby="watch-observation-guide">
                <colgroup><col className="watch-col-index" /><col className="watch-col-name" /><col className="watch-col-code" /><col className="watch-col-price" /><col className="watch-col-change" /><col className="watch-col-node" /><col className="watch-col-date" /><col className="watch-col-boards" /><col className="watch-col-actions" /></colgroup>
                <thead><tr><th scope="col">序号</th><th scope="col">股票</th><th scope="col">代码</th><th scope="col" aria-sort={sort?.key === "latest" ? (sort.dir === "desc" ? "descending" : "ascending") : "none"}><button type="button" className="watch-sort-btn" onClick={() => setSort(nextWatchSort(sort, "latest"))}>现价{sort?.key === "latest" ? <span className="watch-sort-arrow">{sort.dir === "desc" ? "▼" : "▲"}</span> : null}</button></th><th scope="col" aria-sort={sort?.key === "changePct" ? (sort.dir === "desc" ? "descending" : "ascending") : "none"}><button type="button" className="watch-sort-btn" onClick={() => setSort(nextWatchSort(sort, "changePct"))}>涨跌幅{sort?.key === "changePct" ? <span className="watch-sort-arrow">{sort.dir === "desc" ? "▼" : "▲"}</span> : null}</button></th><th scope="col">观察日</th><th scope="col">涨停日期</th><th scope="col">连板</th><th scope="col">操作</th></tr></thead>
                <tbody>
                  {virtual.enabled && virtual.topSpacerHeight > 0 && (
                    <tr aria-hidden="true"><td colSpan={9} style={{ height: virtual.topSpacerHeight, padding: 0, border: 0 }} /></tr>
                  )}
                  {windowedItems.map((item, offset) => {
                    const rowIndex = (virtual.enabled ? virtual.startIndex : 0) + offset;
                    const q = mergedQuotes[item.code];
                    const suspended = q?.tradeStatus === "suspended";
                    const latest = !suspended && typeof q?.latest === "number" && Number.isFinite(q.latest) && q.latest > 0 ? q.latest : null;
                    const chg = !suspended && typeof q?.changePct === "number" && Number.isFinite(q.changePct) ? q.changePct : null;
                    const isFav = Boolean(favoriteCodes?.has(item.code));
                    const sec: Security = {
                      code: item.code,
                      name: item.name,
                      secid: item.secid || inferSecid(item.code),
                      ...(item.thscode ? { thscode: item.thscode } : {}),
                      assetType: item.assetType || "stock"
                    };
                    const handleFav = onToggleFavorite
                      ? onToggleFavorite
                      : onAddFavorite
                        ? () => { if (!isFav) onAddFavorite(item); }
                        : undefined;
                    return <tr key={item.code}>
                    <td className="watch-row-number">{rowIndex + 1}</td>
                    <td>
                      <button className="watch-stock-open" aria-label={`${item.name} ${item.code}`} onClick={() => onOpen(item)}><strong>{item.name}</strong></button>
                    </td>
                    <td className="watch-security-code">{item.code}<small>{item.thscode?.split(".")[1] || "A"}</small></td>
                    <td>{suspended ? <span className="bond-status-tag">停牌</span> : latest !== null ? fmt(latest) : "—"}</td>
                    <td className={chg === null ? "" : chg >= 0 ? "up" : "down"}>{chg !== null ? `${chg >= 0 ? "+" : ""}${fmt(chg)}%` : "—"}</td>
                    <td><span className="watch-day-badge">{nodeFor(item)}</span></td>
                    <td>{item.limitDate || (item.createdAt ? new Date(item.createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—")}</td>
                    <td>{Number(item.consecutiveBoards) > 1 ? <b className="watch-board-count">{item.consecutiveBoards} 板</b> : Number(item.consecutiveBoards) === 1 ? "首板" : "—"}</td>
                    <td>
                      <div className="watch-row-actions">
                        <StockRowActions
                          security={sec}
                          isFavorite={isFav}
                          isPlanned={plannedCodes.has(item.code)}
                          onToggleFavorite={handleFav}
                          onOpenMonitor={onOpenMonitor}
                          onAddPlan={() => setPlanTarget({
                            code: item.code,
                            name: item.name,
                            secid: sec.secid,
                            referencePrice: latest,
                            source: "观察池",
                            defaultNote: `十日观察 ${nodeFor(item)}${item.limitDate ? ` · 涨停日 ${item.limitDate}` : ""}`
                          })}
                          compact
                        />
                        <button onClick={() => onOpen(item)} aria-label={`分析${item.name}`}>分析</button>
                        <button onClick={() => onRemove(item)} title="移出观察池" aria-label={`移出观察池${item.name}`}><X size={14} /></button>
                      </div>
                    </td>
                  </tr>;
                  })}
                  {virtual.enabled && virtual.bottomSpacerHeight > 0 && (
                    <tr aria-hidden="true"><td colSpan={9} style={{ height: virtual.bottomSpacerHeight, padding: 0, border: 0 }} /></tr>
                  )}
                </tbody>
              </table>
            </div>
          </> : <div className="empty-state"><Bookmark size={32} /><h3>{filter.trim() ? "没有匹配的股票" : "该观察节点暂无股票"}</h3><p>{filter.trim() ? "修改名称或代码，或清空筛选。" : "切换 T+1 至 T+10 查看其他交易日节点。"}</p></div>}
        </section>
      </div>
      <QuickPlanModal
        target={planTarget}
        onClose={() => setPlanTarget(null)}
        onSaved={res => onShowToast?.(res.message)}
        onError={msg => onShowToast?.(msg)}
      />
    </div>
  );
}

