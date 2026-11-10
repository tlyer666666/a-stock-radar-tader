import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Coins, RefreshCw, Search, X } from "lucide-react";
import { PageHeading, PanelTitle } from "../../components/terminal/TerminalPrimitives";
import { whenVisible } from "../../visiblePolling";
import { bondSortState, selectBonds, toggleBondSort, type BondMarketFilter, type BondPriceFilter, type BondSort, type BondSortColumn, type ConvertibleBond, type ConvertibleBondSnapshot } from "./bondTypes";

const PAGE = 50;
const sortOptions: { id: BondSort; label: string }[] = [
  { id: "change-desc", label: "涨幅从高到低" }, { id: "change-asc", label: "涨幅从低到高" }, { id: "amount-desc", label: "成交额从大到小" },
  { id: "amount-asc", label: "成交额从小到大" }, { id: "turnover-desc", label: "换手率从高到低" }, { id: "turnover-asc", label: "换手率从低到高" },
  { id: "price-desc", label: "价格从高到低" }, { id: "price-asc", label: "价格从低到高" },
  { id: "years-asc", label: "剩余年限从短到长" }, { id: "years-desc", label: "剩余年限从长到短" }
];
const priceOptions: { id: BondPriceFilter; label: string }[] = [
  { id: "all", label: "全部价格" }, { id: "low", label: "低于 110 元" }, { id: "mid", label: "110–130 元" }, { id: "high", label: "高于 130 元" }
];

const fixed = (value: number | null | undefined, digits = 3) => value === null || value === undefined || !Number.isFinite(value) ? "--" : value.toFixed(digits);
const signed = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const tone = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) || value === 0 ? "" : value > 0 ? "rise" : "fall";
const amountText = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? "--" : value >= 1e8 ? `${(value / 1e8).toFixed(2)} 亿` : `${(value / 1e4).toFixed(0)} 万`;
const timeText = (value: string | null | undefined) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "--";
};

function bondSecurity(bond: ConvertibleBond): Security {
  return { code: bond.code, name: bond.name, secid: bond.secid, thscode: bond.thscode, assetType: "convertibleBond", marketName: "可转债" };
}

function stockSecurity(bond: ConvertibleBond): Security {
  const sh = /^6/.test(bond.stockCode);
  return { code: bond.stockCode, name: bond.stockName || bond.stockCode, secid: `${sh ? 1 : 0}.${bond.stockCode}`, thscode: `${bond.stockCode}.${sh ? "SH" : "SZ"}`, assetType: "stock" };
}

export function ConvertibleBondTable({ bonds, onOpenBond, onOpenStock, sort, onSort }: { bonds: ConvertibleBond[]; onOpenBond: (security: Security) => void; onOpenStock: (security: Security) => void; sort?: BondSort; onSort?: (column: BondSortColumn) => void }) {
  const head = (column: BondSortColumn, label: string) => {
    if (!sort || !onSort) return <th scope="col">{label}</th>;
    const state = bondSortState(sort, column);
    return <th scope="col" aria-sort={state}><button type="button" className={`column-sort-button${state === "none" ? "" : " active"}`} onClick={() => onSort(column)}
      aria-label={state === "none" ? `按${label}从大到小排序` : `按${label}排序，当前${state === "descending" ? "从大到小" : "从小到大"}，点击切换`}>{label}{state === "descending" ? " ▾" : state === "ascending" ? " ▴" : ""}</button></th>;
  };
  return <div className="bond-table-wrap" tabIndex={0} role="region" aria-label="可转债行情表格，可横向滚动">
    <table className="bond-table">
      <thead><tr><th scope="col">转债</th>{head("price", "现价")}{head("change", "涨跌幅")}{head("amount", "成交额")}{head("turnover", "换手率")}<th scope="col">正股</th>{head("years", "剩余年限")}</tr></thead>
      <tbody>{bonds.map((bond) => <tr key={bond.code}>
        <th scope="row"><button type="button" className="bond-identity" onClick={() => onOpenBond(bondSecurity(bond))} aria-label={`查看 ${bond.name} ${bond.code}`}><b>{bond.name}</b><code>{bond.code}</code><ChevronRight size={12} /></button></th>
        <td>{fixed(bond.latest)}</td>
        <td className={tone(bond.changePct)}>{signed(bond.changePct)}</td>
        <td>{amountText(bond.amount)}</td>
        <td>{bond.turnover === null ? "--" : `${bond.turnover.toFixed(2)}%`}</td>
        <td>{bond.stockCode ? <button type="button" className="bond-stock-link" onClick={() => onOpenStock(stockSecurity(bond))}>{bond.stockName || bond.stockCode} <code>{bond.stockCode}</code></button> : <span className="bond-muted">--</span>}</td>
        <td>{bond.remainingYears === null ? "--" : `${bond.remainingYears.toFixed(2)} 年`}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

export default function ConvertibleBondView({ onOpenSecurity, live = true }: { onOpenSecurity: (security: Security) => void; live?: boolean }) {
  const [snapshot, setSnapshot] = useState<ConvertibleBondSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<BondSort>("change-desc");
  const [market, setMarket] = useState<BondMarketFilter>("all");
  const [price, setPrice] = useState<BondPriceFilter>("all");
  const [limit, setLimit] = useState(PAGE);
  const alive = useRef(true);
  const busy = useRef(false);
  const api = typeof window === "undefined" ? null : window.stockApi;

  const load = useCallback(async (forceRefresh = false) => {
    if (busy.current || typeof api?.getConvertibleBonds !== "function") {
      if (typeof api?.getConvertibleBonds !== "function") setError("当前连接未提供可转债接口。");
      return;
    }
    busy.current = true;
    setLoading(true);
    if (forceRefresh) setError("");
    try {
      const value = await api.getConvertibleBonds({ forceRefresh, waitForQuotes: false });
      if (alive.current && value) { setSnapshot(value); setError(""); }
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.current = false;
      if (alive.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
  const pending = Boolean(snapshot?.quoteCoverage.pending);
  useEffect(() => {
    // 读取中每 3 秒取一次进度；读完后每分钟刷新一次行情（页面隐藏时不请求）。
    // 关闭「实时刷新」后不再定时刷新行情（读取进度仍要跟到读完）。
    if (!live && !pending) return;
    const timer = window.setInterval(whenVisible(() => load(false)), pending ? 3000 : 60000);
    return () => window.clearInterval(timer);
  }, [load, pending, live]);

  const rows = useMemo(() => selectBonds(snapshot?.members || [], { query, market, price, sort }), [snapshot, query, market, price, sort]);
  const coverage = snapshot?.quoteCoverage;
  // 一只行情都还没取到时，涨跌家数和成交额是「未知」而不是 0。
  const quoted = !coverage || coverage.loaded > 0;
  const summary = snapshot?.summary ? (quoted ? snapshot.summary : { ...snapshot.summary, rising: null, falling: null, flat: null, amount: null }) : undefined;
  const discovering = snapshot?.roster.discovering;
  return <div className="bond-workspace">
    <PageHeading eyebrow="CONVERTIBLE BONDS" title="可转债"
      description="名单与行情全部来自同花顺：新券名单含正股信息；在市老券按交易所代码段逐个核对同花顺行情（每 7 天一次，结果存在本机）；行情逐只读取。"
      actions={<button className="primary-btn" onClick={() => void load(true)} disabled={loading && !pending}><RefreshCw size={17} className={loading || pending ? "spin" : ""} />刷新可转债行情</button>} />
    {error && <div className="test-result fail" role="alert"><span />{error}</div>}
    <section className="panel bond-summary" aria-label="可转债市场概况">
      <div><span>在市可转债</span><b>{summary ? summary.count : "--"}</b><small>{coverage ? `同花顺行情 ${coverage.loaded}/${coverage.total}${coverage.pending ? " · 读取中" : ""}` : "读取中"}</small></div>
      <div><span>上涨 / 下跌 / 平</span><b><em className="rise">{summary?.rising ?? "--"}</em> / <em className="fall">{summary?.falling ?? "--"}</em> / {summary?.flat ?? "--"}</b><small>按已取到行情的转债统计</small></div>
      <div><span>涨跌幅中位数</span><b className={tone(summary?.medianChangePct)}>{signed(summary?.medianChangePct)}</b><small>等权中位数，非指数</small></div>
      <div><span>合计成交额</span><b>{amountText(summary?.amount)}</b><small>行情日期 {snapshot?.asOf || "--"}</small></div>
    </section>
    {discovering && <div className="bond-progress" role="status">正在用同花顺核对在市可转债代码：{discovering.checked}/{discovering.total || "…"}，已发现 {discovering.found} 只<progress max={discovering.total || 1} value={discovering.checked} /></div>}
    {!!snapshot?.warnings.length && <div className="bond-notes" role="note">{snapshot.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
    <section className="panel bond-panel">
      <PanelTitle title="可转债行情" subtitle="点击转债查看行情与K线，点击正股打开个股分析；点表头切换从大到小 / 从小到大" icon={Coins} badge={`${rows.length} 只`} />
      <div className="bond-toolbar">
        <label className="bond-search"><Search size={15} /><input aria-label="搜索可转债" placeholder="转债或正股 名称 / 代码" value={query} onChange={(event) => { setQuery(event.target.value); setLimit(PAGE); }} />{query && <button type="button" aria-label="清空可转债搜索" onClick={() => setQuery("")}><X size={13} /></button>}</label>
        <div className="bond-segments" role="group" aria-label="交易所">{(["all", "sh", "sz"] as const).map((id) => <button type="button" key={id} aria-pressed={market === id} onClick={() => { setMarket(id); setLimit(PAGE); }}>{id === "all" ? "全部" : id === "sh" ? "沪市" : "深市"}</button>)}</div>
        <select aria-label="价格区间" value={price} onChange={(event) => { setPrice(event.target.value as BondPriceFilter); setLimit(PAGE); }}>{priceOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
        <select aria-label="可转债排序" value={sort} onChange={(event) => { setSort(event.target.value as BondSort); setLimit(PAGE); }}>{sortOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
      </div>
      {rows.length ? <ConvertibleBondTable bonds={rows.slice(0, limit)} onOpenBond={onOpenSecurity} onOpenStock={onOpenSecurity} sort={sort} onSort={(column) => { setSort((current) => toggleBondSort(current, column)); setLimit(PAGE); }} />
        : <div className="bond-empty">{snapshot ? "没有符合条件的可转债。" : "正在读取同花顺可转债名单…"}</div>}
      {rows.length > limit && <button type="button" className="secondary-btn bond-more" onClick={() => setLimit((value) => value + PAGE)}>再显示 {Math.min(PAGE, rows.length - limit)} 只（共 {rows.length} 只）</button>}
    </section>
    {!!snapshot?.upcoming.length && <details className="panel bond-upcoming">
      <summary>待上市新券 {snapshot.upcoming.length} 只</summary>
      <ul>{snapshot.upcoming.map((bond) => <li key={bond.code}><b>{bond.name}</b> <code>{bond.code}</code><span>正股 {bond.stockName || "--"} {bond.stockCode}</span><span>{bond.listingDate ? `上市 ${bond.listingDate}` : "上市日期待定"}</span></li>)}</ul>
    </details>}
    <p className="bond-source">数据：{snapshot?.source || "同花顺"} · 更新 {timeText(snapshot?.fetchedAt)}{snapshot?.roster.discoveredAt ? ` · 在市名单核对于 ${timeText(snapshot.roster.discoveredAt)}` : ""}</p>
  </div>;
}
