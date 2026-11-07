import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Bell,
  Bookmark,
  BookmarkCheck,
  ChevronRight,
  LineChart,
  LoaderCircle,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Star,
  WalletCards,
  X
} from "lucide-react";
import { PageHeading, PanelTitle, Fact } from "../../components/terminal/TerminalPrimitives";
import StockMonitorEditor from "../../StockMonitorEditor";
import useStockMonitors from "../../useStockMonitors";
import { whenVisible } from "../../visiblePolling";
import { fmt, fmtMoney, nullableNumber } from "../../domain/formatters";
import { formatShanghaiTime, formatShanghaiDateTime } from "../../dateUtils";
import { summarizeStockMonitor } from "../../stockMonitorRules";

export function FavoritesView({
  items,
  monitors,
  live,
  onOpen,
  onRemove
}: {
  items: WatchItem[];
  monitors: ReturnType<typeof useStockMonitors>;
  live: boolean;
  onOpen: (item: WatchItem) => void;
  onRemove: (item: WatchItem) => void;
}) {
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const configuredCount = items.filter(item => monitors.configs[item.code]).length;
  const enabledCount = items.filter(item => monitors.configs[item.code]?.enabled).length;
  const statusLabels: Record<string, string> = { waiting: "等待行情", stale: "报价待更新", unavailable: "行情待恢复", baseline: "监控中", watching: "监控中", matched: "条件满足", triggered: "已提醒", cooldown: "冷却中", disabled: "已暂停" };
  return (
    <div className="personal-workspace">
      <PageHeading eyebrow="PERSONAL MONITOR BOARD" title="自选板块" description="为每只自选股设置独立条件，应用开启且实时刷新时持续监测。" />
      <section className="panel personal-monitor-panel">
        <header className="personal-monitor-heading"><div><Star size={18} /><h3>我的监控</h3><span>{items.length} 只自选</span></div><div><span>{configuredCount} 只已配置</span><b>{live ? `${enabledCount} 只监控中` : "实时监控已暂停"}</b>{monitors.refreshing && <LoaderCircle size={15} className="spin" />}</div></header>
        {monitors.storageError && <p className="monitor-storage-error" role="alert">{monitors.storageError}</p>}
        {items.length ? <div className="personal-monitor-list"><div className="personal-monitor-columns" aria-hidden="true"><span>股票</span><span>最新行情 / 状态</span><span>监控条件</span><span>最近状态</span><span>操作</span></div><div className="personal-monitor-grid">{items.map(item => {
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
        })}</div></div> : <div className="favorites-empty"><Star size={32} /><b>自选板块还是空的</b><span>到涨停池点击“监控”，或在个股分析中点击“加入自选”。</span></div>}
      </section>
      {monitors.alerts.length > 0 && <section className="panel monitor-alert-panel"><header><Bell size={17} /><h3>最近提醒</h3><span>保留最近 20 条</span></header><div>{monitors.alerts.map(alert => <article key={alert.id}><div><b>{alert.name}</b><span>{alert.code}</span><time>{formatShanghaiDateTime(alert.triggeredAt)}</time></div><p>{alert.detail}</p></article>)}</div></section>}
    </div>
  );
}

export function HoldingsView({
  items,
  settings,
  live,
  onSave,
  onOpen
}: {
  items: HoldingItem[];
  settings: Settings;
  live: boolean;
  onSave: (update: (items: HoldingItem[]) => HoldingItem[]) => Promise<boolean>;
  onOpen: (item: HoldingItem) => void;
}) {
  const [code, setCode] = useState("");
  const [shares, setShares] = useState("");
  const [costPrice, setCostPrice] = useState("");
  const [note, setNote] = useState("");
  const [quotes, setQuotes] = useState<Record<string, { quote: any; updatedAt: string; failed: boolean }>>({});
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
    const results: Array<readonly [string, { quote: any; updatedAt: string } | null]> = [];
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
    const timer = live && items.length ? window.setInterval(
      whenVisible(() => void refreshQuotes()),
      Math.max(5, Number(settings.quoteRefreshSeconds) || 5) * 1000
    ) : undefined;
    return () => {
      window.clearInterval(timer);
      quoteRefreshRequestId.current += 1;
      quoteRefreshPending.current = null;
    };
  }, [items.length, live, settings.quoteRefreshSeconds, refreshQuotes]);

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
      const nextItem: HoldingItem = {
        ...security,
        shares: normalizedShares,
        costPrice: normalizedCost,
        note: note.trim().slice(0, 160),
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp
      };
      if (!await onSave(current => {
        const currentItem = current.find(item => item.code === normalizedCode);
        if (existing && !currentItem) return current;
        return [...current.filter(item => item.code !== normalizedCode), {
          ...nextItem, createdAt: currentItem?.createdAt || nextItem.createdAt
        }].sort((left, right) => left.code.localeCompare(right.code));
      })) return;
      if (holdingEditRevision.current !== submittedRevision) return;
      setCode("");
      setShares("");
      setCostPrice("");
      setNote("");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "持仓保存失败");
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
        description="持仓数据仅保存在本机；行情沿用同花顺主源和三线校验，不连接券商、不会发出交易指令。"
        actions={<button className="secondary-btn" onClick={() => void refreshQuotes()} disabled={refreshing}>{refreshing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}刷新行情</button>}
      />
      <section className="panel holdings-summary-panel">
        <PanelTitle title="持仓总览" subtitle={`本轮有效报价 ${summary.pricedCount}/${items.length} 条；汇总仅覆盖本轮有效报价的持仓`} icon={WalletCards} badge={`${items.length} 只`} />
        {summary.referenceCount > 0 && <p className="warning-banner" role="status">{summary.referenceCount} 只持仓刷新失败，上次报价仅供参考，不计入汇总。</p>}
        <div className="fact-grid holdings-summary-grid">
          <Fact label="持仓市值" value={summary.pricedCount ? fmtMoney(summary.marketValue) : "--"} />
          <Fact label="持仓成本" value={summary.pricedCount ? fmtMoney(summary.costValue) : "--"} />
          <Fact label="浮动盈亏" value={summary.pricedCount ? `${signedMoney(summary.profit)}（${signedPercent(summary.profitPercent)}）` : "--"} tone={summary.pricedCount && summary.profit !== 0 ? summary.profit > 0 ? 'up' : 'down' : ''} />
          <Fact label="按昨收估算今日盈亏" value={summary.dayPricedCount ? signedMoney(summary.dayProfit) : "--"} tone={summary.dayPricedCount && summary.dayProfit !== 0 ? summary.dayProfit > 0 ? 'up' : 'down' : ''} />
        </div>
      </section>
      <div className="holdings-workspace-grid">
      <section className="panel holdings-entry-panel">
        <PanelTitle title="录入或更新持仓" subtitle="同一代码再次保存会更新数量、成本价和备注。" icon={BookmarkCheck} />
        <form className="holdings-entry-form" onSubmit={saveHolding}>
          <input aria-label="证券代码" value={code} onChange={(event) => { holdingEditRevision.current += 1; setCode(event.target.value.replace(/\D/g, "").slice(0, 6)); }} placeholder="证券代码，如 600519" inputMode="numeric" />
          <input aria-label="持仓数量" value={shares} onChange={(event) => { holdingEditRevision.current += 1; setShares(event.target.value); }} placeholder="持仓数量（股）" inputMode="numeric" />
          <input aria-label="成本价" value={costPrice} onChange={(event) => { holdingEditRevision.current += 1; setCostPrice(event.target.value); }} placeholder="成本价" inputMode="decimal" />
          <input aria-label="持仓备注" value={note} onChange={(event) => { holdingEditRevision.current += 1; setNote(event.target.value); }} placeholder="备注（可选）" maxLength={160} />
          <button className="primary-btn" type="submit" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={16} /> : <BookmarkCheck size={16} />}保存持仓</button>
        </form>
        {formError && <div className="holdings-form-error" role="alert">{formError}</div>}
      </section>
      <section className="panel holdings-table-panel">
        <PanelTitle title="持仓明细" subtitle="报价暂不可用时保留持仓，不使用成本价伪造实时盈亏。" icon={LineChart} />
        {removedHolding && <div className="warning-banner" role="status">已移除 {removedHolding.name}（{removedHolding.code}）<button type="button" className="table-action" aria-label="撤销移除" disabled={restoring || Boolean(removingCode)} onClick={() => void undoRemoval()}>{restoring ? "正在恢复" : "撤销"}</button></div>}
        {removalError && <p className="holdings-form-error" role="alert">{removalError}</p>}
        {rows.length ? (
          <div className="table holdings-table" role="table" aria-label="持仓明细">
            <div className="th tr" role="row"><span role="columnheader">股票 / 备注</span><span role="columnheader">持仓 / 成本</span><span role="columnheader">行情 / 更新时间</span><span role="columnheader">市值</span><span role="columnheader">浮动盈亏</span><span role="columnheader">操作</span></div>
            {rows.map((row) => (
              <div className="tr" key={row.item.code} role="row">
                <span role="rowheader" className="stock-cell" title={row.item.note || row.item.name}><b>{row.item.name}</b><small>{row.item.code}</small></span>
                <span role="cell">{row.item.shares.toLocaleString("zh-CN")} 股 <small>成本 {fmt(row.item.costPrice)} 元</small></span>
                <span role="cell">{row.quoteAvailable ? <><b>{fmt(row.latest)} 元</b><small className={Number.isFinite(row.changePct) ? row.changePct >= 0 ? "holding-pnl up" : "holding-pnl down" : ""}>{Number.isFinite(row.changePct) ? signedPercent(row.changePct) : "--"}</small><small>{row.quoteFailed ? "上次报价" : "报价更新"} {formatShanghaiDateTime(row.quoteUpdatedAt)}{row.quoteFailed ? " · 刷新失败" : ""}</small></> : <small>{row.quoteFailed ? "刷新失败，报价待恢复" : "等待报价"}</small>}</span>
                <span role="cell">{row.quoteAvailable ? <>{fmtMoney(row.marketValue)}{row.quoteFailed && <small>参考市值</small>}</> : "--"}</span>
                <span role="cell" className={row.profit >= 0 ? "holding-pnl up" : "holding-pnl down"}>{row.quoteAvailable ? <><b>{signedMoney(row.profit)}</b><small>{signedPercent(row.profitPercent)}{row.quoteFailed ? " · 参考盈亏" : ""}</small></> : "--"}</span>
                <span role="cell" className="holdings-row-actions"><button className="table-action" onClick={() => onOpen(row.item)}>分析</button><button className="table-action" onClick={() => editHolding(row.item)}>编辑</button><button className="table-action danger" disabled={Boolean(removingCode) || restoring} onClick={() => void removeHolding(row.item)}>{removingCode === row.item.code ? "正在移除" : "移除"}</button></span>
              </div>
            ))}
          </div>
        ) : (
          <div className="favorites-empty holdings-empty"><WalletCards size={32} /><b>还没有录入持仓</b><span>输入证券代码、数量和成本价后保存；数据只留在本机。</span></div>
        )}
      </section>
      </div>
    </div>
  );
}

export function WatchlistView({
  items,
  activeNode,
  onNodeChange,
  onOpen,
  onRemove
}: {
  items: WatchItem[];
  activeNode: string;
  onNodeChange: (node: string) => void;
  onOpen: (item: any) => void;
  onRemove: (item: WatchItem) => void;
}) {
  const [filter, setFilter] = useState("");
  const tableScroll = useRef<HTMLDivElement>(null);
  const tabs = [{ id: "all", label: "全部十日" }, ...Array.from({ length: 10 }, (_, index) => ({ id: `T+${index + 1}`, label: `T+${index + 1}` }))];
  const nodeFor = (item: WatchItem) => item.observationNode || (
    Number(item.tradingDaysSince) >= 1 && Number(item.tradingDaysSince) <= 10
      ? `T+${item.tradingDaysSince}` : "手动"
  );
  const counts = Object.fromEntries(tabs.map(tab => [tab.id, tab.id === "all" ? items.length : items.filter(item => nodeFor(item) === tab.id).length]));
  const visibleItems = items.filter(item => (activeNode === "all" || nodeFor(item) === activeNode) &&
    (!filter.trim() || `${item.name} ${item.code}`.toLowerCase().includes(filter.trim().toLowerCase())));
  useEffect(() => { tableScroll.current?.scrollTo({ top: 0, left: 0 }); }, [activeNode, filter]);
  return (
    <div className="ten-day-workspace">
      <header className="watch-toolbar">
        <div><h1>十日观察池</h1><span>{items.length} 只</span></div>
        <label className="watch-filter"><Search size={15} /><input aria-label="筛选观察池股票名称或代码" placeholder="名称 / 代码" value={filter} onChange={event => setFilter(event.target.value)} />{filter && <button aria-label="清空观察池筛选" onClick={() => setFilter("")}><X size={14} /></button>}</label>
      </header>
      <p className="watch-table-guide" id="watch-observation-guide">当前显示 {visibleItems.length} / {items.length} 只 · T+1 为涨停后的第 1 个交易日，依次观察至 T+10；连板为涨停日记录。</p>
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
            <div className="watch-table-scroll" ref={tableScroll}>
              <table className="watch-stock-table" aria-describedby="watch-observation-guide">
                <colgroup><col className="watch-col-index" /><col className="watch-col-name" /><col className="watch-col-code" /><col className="watch-col-node" /><col className="watch-col-date" /><col className="watch-col-boards" /><col className="watch-col-actions" /></colgroup>
                <thead><tr><th scope="col">序号</th><th scope="col">股票</th><th scope="col">代码</th><th scope="col">观察日</th><th scope="col">涨停日期</th><th scope="col">连板</th><th scope="col">操作</th></tr></thead>
                <tbody>{visibleItems.map((item, index) => <tr key={item.code}>
                  <td className="watch-row-number">{index + 1}</td>
                  <td><button className="watch-stock-open" aria-label={`${item.name} ${item.code}`} onClick={() => onOpen(item)}><strong>{item.name}</strong></button></td>
                  <td className="watch-security-code">{item.code}<small>{item.thscode?.split(".")[1] || "A"}</small></td>
                  <td><span className="watch-day-badge">{nodeFor(item)}</span></td>
                  <td>{item.limitDate || (item.createdAt ? new Date(item.createdAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—")}</td>
                  <td>{Number(item.consecutiveBoards) > 1 ? <b className="watch-board-count">{item.consecutiveBoards} 板</b> : "—"}</td>
                  <td><div className="watch-row-actions"><button onClick={() => onOpen(item)} aria-label={`分析${item.name}`}>分析</button><button onClick={() => onRemove(item)} title="移出观察池" aria-label={`移出观察池${item.name}`}><X size={14} /></button></div></td>
                </tr>)}</tbody>
              </table>
            </div>
          </> : <div className="empty-state"><Bookmark size={32} /><h3>{filter.trim() ? "没有匹配的股票" : "该观察节点暂无股票"}</h3><p>{filter.trim() ? "修改名称或代码，或清空筛选。" : "切换 T+1 至 T+10 查看其他交易日节点。"}</p></div>}
        </section>
      </div>
    </div>
  );
}

