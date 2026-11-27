import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, ChevronRight, CircleAlert, Layers, RefreshCw, Search, X } from "lucide-react";
import QuickPlanModal, { usePlannedCodes, type QuickPlanTarget } from "../../components/QuickPlanModal";
import StockRowActions from "../../components/StockRowActions";
import { useVirtualWindow } from "../../components/useVirtualWindow";
import { PageHeading, PanelTitle } from "../../components/terminal/TerminalPrimitives";
import { createRefreshGate } from "../../refreshGate";
import { startVisibleInterval } from "../../visiblePolling";
import { userErrorText } from "../../userErrorText";
import { ETF_CATEGORY_FILTERS, countByFilter, etfSecurity, isT0Etf, premiumWarning, selectEtfs, t0ActiveEtfs, toggleEtfSort, type EtfCategoryFilter, type EtfSort, type EtfSortColumn } from "./etfModel";
import type { EtfItem, EtfMarketSnapshot } from "./etfTypes";

const PAGE = 60;
const price = (value: number | null) => value === null ? "--" : value.toFixed(3);
const signed = (value: number | null, digits = 2) => value === null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
const tone = (value: number | null) => value === null || value === 0 ? "" : value > 0 ? "rise" : "fall";
const money = (value: number | null) => value === null ? "--" : value >= 1e8 ? `${(value / 1e8).toFixed(2)} 亿` : `${(value / 1e4).toFixed(0)} 万`;
const timeText = (value: string | undefined) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "--";
};
const percent = (value: number | null | undefined) => value === null || value === undefined ? "--" : `${value.toFixed(2)}%`;
const signature = (snapshot: EtfMarketSnapshot | null) => snapshot ? snapshot.items.map(item => `${item.code}:${item.latest}:${item.amount}`).join("|") : "";

function EtfTable({ items, sort, onSort, resetKey, threshold, onOpen, favoriteCodes, plannedCodes, onToggleFavorite, onOpenMonitor, onAddPlan }: {
  items: EtfItem[]; sort: EtfSort; onSort: (column: EtfSortColumn) => void; resetKey?: string | undefined; threshold: number; onOpen: (security: Security) => void;
  favoriteCodes?: ReadonlySet<string> | undefined; plannedCodes: ReadonlySet<string>;
  onToggleFavorite?: ((security: Security) => void) | undefined; onOpenMonitor?: ((security: Security) => void) | undefined; onAddPlan: (item: EtfItem) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualWindow({
    itemCount: items.length,
    rowHeight: 44,
    overscan: 8,
    threshold: 80,
    containerRef: scrollRef,
    resetKey: `${resetKey ?? ""}|${sort.column}:${sort.direction}`
  });
  const visible = virtual.enabled ? items.slice(virtual.startIndex, virtual.endIndex) : items;
  const head = (column: EtfSortColumn, label: string) => {
    const state = sort.column === column ? (sort.direction === "desc" ? "descending" : "ascending") : "none";
    return <th scope="col" aria-sort={state}><button type="button" className={`column-sort-button${state === "none" ? "" : " active"}`} onClick={() => onSort(column)}
      aria-label={state === "none" ? `按${label}从大到小排序` : `按${label}排序，当前${state === "descending" ? "从大到小" : "从小到大"}，点击切换`}>{label}{state === "descending" ? " ▾" : state === "ascending" ? " ▴" : ""}</button></th>;
  };
  return <div ref={scrollRef} className="bond-table-wrap" tabIndex={0} role="region" aria-label="ETF 行情表格，可横向滚动"
    onScroll={virtual.enabled ? virtual.onScroll : undefined} style={virtual.enabled ? { maxHeight: 620, overflowY: "auto" } : undefined}>
    <table className="bond-table etf-table">
      <thead><tr><th scope="col">ETF</th><th scope="col">类别</th><th scope="col">现价</th>{head("change", "涨跌幅")}{head("amplitude", "振幅")}{head("amount", "成交额")}{head("turnover", "换手率")}{head("volumeRatio", "量比")}{head("scale", "规模")}{head("premium", "溢价率")}<th scope="col">操作</th></tr></thead>
      <tbody>
        {virtual.enabled && virtual.topSpacerHeight > 0 && <tr aria-hidden="true"><td colSpan={11} style={{ height: virtual.topSpacerHeight, padding: 0, border: 0 }} /></tr>}
        {visible.map(item => {
          const security = etfSecurity(item);
          const warning = premiumWarning(item, threshold);
          return <tr key={item.code}>
            <th scope="row"><button type="button" className="bond-identity" onClick={() => onOpen(security)} aria-label={`查看 ${item.name} ${item.code}`}><b>{item.name}</b><code>{item.code}</code><ChevronRight size={12} /></button></th>
            <td><span className="etf-category">{item.category}</span>{isT0Etf(item) && <span className="etf-t0-tag" title="T+0：当日买入当日可卖，可日内回转">T+0</span>}</td>
            <td>{price(item.latest)}</td>
            <td className={tone(item.changePct)}>{signed(item.changePct)}</td>
            <td>{percent(item.amplitude)}</td>
            <td>{money(item.amount)}</td>
            <td>{item.turnover === null ? "--" : `${item.turnover.toFixed(2)}%`}</td>
            <td>{item.volumeRatio === null ? "--" : item.volumeRatio.toFixed(2)}</td>
            <td>{money(item.scale)}</td>
            <td className={warning ? "etf-premium-alert" : ""} title={warning || (item.iopv === null ? "没有实时净值估算，无法计算溢价" : `实时净值估算 ${item.iopv.toFixed(4)}`)}>
              {warning && <CircleAlert size={12} />}{signed(item.premiumPct)}
            </td>
            <td><StockRowActions security={security} isFavorite={Boolean(favoriteCodes?.has(item.code))} isPlanned={plannedCodes.has(item.code)}
              onToggleFavorite={onToggleFavorite} onOpenMonitor={onOpenMonitor} onAddPlan={() => onAddPlan(item)} compact /></td>
          </tr>;
        })}
        {virtual.enabled && virtual.bottomSpacerHeight > 0 && <tr aria-hidden="true"><td colSpan={11} style={{ height: virtual.bottomSpacerHeight, padding: 0, border: 0 }} /></tr>}
      </tbody>
    </table>
  </div>;
}

export default function EtfView({ onOpenSecurity, favoriteCodes, onToggleFavorite, onOpenMonitor, onShowToast, live = true }: {
  onOpenSecurity: (security: Security) => void;
  favoriteCodes?: ReadonlySet<string> | undefined;
  onToggleFavorite?: ((security: Security) => void) | undefined;
  onOpenMonitor?: ((security: Security) => void) | undefined;
  onShowToast?: ((message: string) => void) | undefined;
  live?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<EtfMarketSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [category, setCategory] = useState<EtfCategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<EtfSort>({ column: "amount", direction: "desc" });
  const [limit, setLimit] = useState(PAGE);
  const [planTarget, setPlanTarget] = useState<QuickPlanTarget | null>(null);
  const [plannedCodes, setPlannedCodes] = usePlannedCodes();
  const snapshotRef = useRef<EtfMarketSnapshot | null>(null);
  const alive = useRef(true);
  const api = typeof window === "undefined" ? null : window.stockApi;

  const gate = useMemo(() => createRefreshGate(async forceRefresh => {
    if (typeof api?.getEtfMarket !== "function") return;
    setLoading(true);
    try {
      const value = await api.getEtfMarket({ forceRefresh });
      if (!alive.current) return;
      if (forceRefresh) setNotice(signature(value) === signature(snapshotRef.current) ? `已刷新 ${timeText(value.fetchedAt)}，行情没有变化` : `已刷新 ${timeText(value.fetchedAt)}，行情已更新`);
      snapshotRef.current = value;
      setSnapshot(value);
      setError("");
    } catch (reason) {
      if (!alive.current) return;
      const message = userErrorText(reason, "ETF 行情读取失败");
      setError(message);
      if (forceRefresh) setNotice(`刷新失败：${message}`);
    } finally {
      if (alive.current) setLoading(false);
    }
  }), [api]);

  const refreshNow = useCallback(() => {
    setManual(true);
    void gate.trigger(true).catch(() => undefined).finally(() => { if (alive.current) setManual(false); });
  }, [gate]);

  useEffect(() => {
    alive.current = true;
    void gate.trigger(false).catch(() => undefined);
    const stop = live ? startVisibleInterval(() => { void gate.trigger(false).catch(() => undefined); }, 60_000) : undefined;
    return () => { alive.current = false; stop?.(); };
  }, [gate, live]);

  const rows = useMemo(() => selectEtfs(snapshot?.items || [], { category, query, sort }), [snapshot, category, query, sort]);
  const summary = snapshot?.summary;
  const threshold = snapshot?.highPremiumPercent ?? 3;
  const t0Count = useMemo(() => countByFilter(snapshot?.items || [], "T+0"), [snapshot]);
  const t0Active = useMemo(() => t0ActiveEtfs(snapshot?.items || []), [snapshot]);
  const highPremium = useMemo(() => (snapshot?.items || []).filter(item => (item.premiumPct ?? 0) > threshold && (item.amount ?? 0) >= 1e7)
    .sort((a, b) => (b.premiumPct ?? 0) - (a.premiumPct ?? 0)).slice(0, 5), [snapshot, threshold]);

  if (typeof api?.getEtfMarket !== "function") {
    return <div className="bond-workspace"><PageHeading eyebrow="ETF" title="ETF" description="当前连接未提供 ETF 行情接口，请使用桌面版。" /></div>;
  }

  return <div className="bond-workspace etf-workspace">
    <PageHeading eyebrow="ETF" title="ETF"
      description="全市场场内 ETF：按宽基、行业主题、跨境、商品、债券、货币分类，并单独列出可当日回转的 T+0 板块。溢价率按“现价 ÷ 实时净值估算 − 1”计算，溢价越高，买入后溢价回落的风险越大。"
      actions={<>
        {notice && <small className="fy-refresh-notice" role="status">{notice}</small>}
        <button className="primary-btn" onClick={refreshNow} disabled={manual}><RefreshCw size={17} className={loading ? "spin" : ""} />{manual ? "刷新中" : "刷新 ETF 行情"}</button>
      </>} />
    {error && <div className="test-result fail" role="alert"><span />{error}</div>}
    <section className="panel bond-summary" aria-label="ETF 市场概况">
      <div><span>在市 ETF</span><b>{summary ? summary.count : "--"}</b><small>{snapshot ? `更新 ${timeText(snapshot.fetchedAt)}` : "读取中"}</small></div>
      <div><span>上涨 / 下跌 / 平</span><b><em className="rise">{summary?.rising ?? "--"}</em> / <em className="fall">{summary?.falling ?? "--"}</em> / {summary?.flat ?? "--"}</b><small>不含货币 ETF</small></div>
      <div><span>合计成交额</span><b>{money(summary?.totalAmount ?? null)}</b><small>全部 ETF 合计</small></div>
      <div><span>高溢价</span><b className={summary?.highPremium ? "etf-premium-alert" : ""}>{summary ? `${summary.highPremium} 只` : "--"}</b><small>溢价超过 {threshold}%</small></div>
    </section>
    {!!snapshot?.topThemes.length && <section className="panel etf-themes" aria-label="今日最强主题 ETF">
      <b>今日最强主题</b>
      {snapshot.topThemes.map(item => <button type="button" key={item.code} className="table-action" onClick={() => onOpenSecurity(etfSecurity(item))}>
        {item.name} <em className={tone(item.changePct)}>{signed(item.changePct)}</em></button>)}
      <small>成交额 1 亿以上的行业主题 ETF</small>
    </section>}
    <section className="panel etf-t0-board" aria-label="T+0 ETF 板块">
      <header>
        <b><ArrowLeftRight size={14} /> T+0 板块</b>
        <span>{snapshot ? `${t0Count} 只` : "--"} · 当日买入当日可卖，可日内回转</span>
        <button type="button" className="table-action" aria-pressed={category === "T+0"}
          onClick={() => { setCategory(current => current === "T+0" ? "all" : "T+0"); setLimit(PAGE); }}>{category === "T+0" ? "显示全部 ETF" : "表格只看 T+0"}</button>
      </header>
      {t0Active.length ? <div className="etf-t0-list" aria-label="T+0 ETF 今日成交活跃">
        {t0Active.map(item => <button type="button" key={item.code} className="etf-t0-card" onClick={() => onOpenSecurity(etfSecurity(item))}
          aria-label={`查看 ${item.name} ${item.code}，涨跌幅 ${signed(item.changePct)}，振幅 ${percent(item.amplitude)}，成交额 ${money(item.amount)}`}>
          <span className="etf-t0-name"><b>{item.name}</b><code>{item.code}</code></span>
          <span className="etf-t0-meta"><em className={tone(item.changePct)}>{signed(item.changePct)}</em><small>振幅 {percent(item.amplitude)}</small></span>
          <span className="etf-t0-meta"><small>{item.category}</small><small>{money(item.amount)}</small></span>
        </button>)}
      </div> : <small className="etf-t0-empty">{snapshot ? "暂无成交活跃的 T+0 ETF（成交额 5000 万以上、不含货币 ETF）。" : "正在读取…"}</small>}
      <small className="etf-t0-note">跨境（含港股通、海外）、商品（黄金、商品期货）、债券、货币 ETF 按交易所规则可 T+0 回转交易；宽基、行业主题等 A 股股票型 ETF 为 T+1。上面按成交额列出最活跃的，振幅可作日内空间参考，不含货币 ETF；实际以券商交易规则为准。</small>
    </section>
    {highPremium.length > 0 && <div className="bond-notes etf-premium-notes" role="note">
      <p><CircleAlert size={13} /> 高溢价提醒：{highPremium.map(item => `${item.name} 溢价 ${signed(item.premiumPct)}`).join("、")}。这些 ETF 的价格明显高于净值，追高买入要承担溢价回落的风险。</p>
    </div>}
    {!!snapshot?.warnings.length && <div className="bond-notes" role="note">{snapshot.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
    <section className="panel bond-panel">
      <PanelTitle title="ETF 行情" subtitle="点击名称查看行情与K线；点表头切换排序" icon={Layers} badge={`${rows.length} 只`} />
      <div className="bond-toolbar">
        <label className="bond-search"><Search size={15} /><input aria-label="搜索 ETF" placeholder="ETF 名称 / 代码" value={query} onChange={event => { setQuery(event.target.value); setLimit(PAGE); }} />{query && <button type="button" aria-label="清空 ETF 搜索" onClick={() => { setQuery(""); setLimit(PAGE); }}><X size={13} /></button>}</label>
        <div className="bond-segments" role="group" aria-label="ETF 类别">{ETF_CATEGORY_FILTERS.map(id => <button type="button" key={id} aria-pressed={category === id} onClick={() => { setCategory(id); setLimit(PAGE); }}>
          {id === "all" ? "全部" : id}{snapshot && id !== "all" ? ` ${countByFilter(snapshot.items, id)}` : ""}</button>)}</div>
      </div>
      {rows.length ? <EtfTable items={rows.slice(0, limit)} sort={sort} onSort={column => { setSort(current => toggleEtfSort(current, column)); setLimit(PAGE); }} resetKey={`${query}|${category}|${sort.column}:${sort.direction}`} threshold={threshold}
        onOpen={onOpenSecurity} favoriteCodes={favoriteCodes} plannedCodes={plannedCodes} onToggleFavorite={onToggleFavorite} onOpenMonitor={onOpenMonitor}
        onAddPlan={item => setPlanTarget({ code: item.code, name: item.name, secid: item.secid, referencePrice: item.latest, source: "ETF", defaultNote: `${item.category} ETF` })} />
        : <div className="bond-empty" role={snapshot ? undefined : "status"}>{snapshot ? "没有符合条件的 ETF。" : "正在读取全市场 ETF 行情…"}</div>}
      {rows.length > limit && <button type="button" className="secondary-btn bond-more" onClick={() => setLimit(value => value + PAGE)}>再显示 {Math.min(PAGE, rows.length - limit)} 只（共 {rows.length} 只）</button>}
    </section>
    <p className="bond-source">数据：东方财富 ETF 行情 · 规模为场内总市值 · 实时净值为交易所盘中估算（IOPV），仅供参考</p>
    <QuickPlanModal target={planTarget} onClose={() => setPlanTarget(null)}
      onSaved={res => { setPlannedCodes(prev => new Set(prev).add(res.code)); onShowToast?.(res.message); }}
      onError={message => onShowToast?.(message)} />
  </div>;
}
