import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Activity, CircleAlert, Database, Flame, Layers3, LayoutDashboard, LoaderCircle, Radar, RefreshCw, Search, Target } from "lucide-react";
import { EmptyInline, Metric, PageHeading, PanelTitle } from "../../components/terminal/TerminalPrimitives";
import { fmt, fmtMoney, nullableNumber, subtractNullable } from "../../domain/formatters";
import { safeNumber } from "../../domain/settings";
import { formatShanghaiDateTime } from "../../dateUtils";
import { whenVisible } from "../../visiblePolling";
import { ariaSortOf, sortButtonLabel, sortGlyph, sortRowsBy, toggleColumnSort, type ColumnSort } from "../../domain/columnSort";
import "./sector-workflow.css";

/** 市场平均收益的基准名：同花顺全A为主，应急时为中证全指；没有就写“全A基准”。 */
const marketReturnLabel = (snapshot: unknown) => {
  const label = (snapshot as { benchmarkLabel?: unknown } | null | undefined)?.benchmarkLabel;
  return typeof label === "string" && label ? label : "全A基准";
};

/* B-04：资金流时间与全站其它时间一样走 dateUtils 的北京时间格式化（输出格式不变，非法值兜底）。 */
const formatFundFlowTime = (value: unknown) =>
  formatShanghaiDateTime(value ? String(value) : undefined, "时间待确认");

function ConceptChainPanel({
  data,
  loading,
  onOpen
}: {
  data: any;
  loading: boolean;
  onOpen: (sector: any) => void;
}) {
  if (loading) {
    return (
      <section className="panel concept-chain-panel">
        <PanelTitle title="产业链细分概览" subtitle="正在读取免费行情成分股与交叉概念" icon={Layers3} />
        <div className="concept-chain-loading"><LoaderCircle className="spin" size={18} />加载细分概念...</div>
      </section>
    );
  }
  if (!data) return null;
  return (
    <section className="panel concept-chain-panel">
      <PanelTitle
        title={`${data.name} · 细分概念`}
        subtitle={data.source}
        icon={Layers3}
        badge={data.thsStatus === "已连接" ? "动态已校验" : data.thsStatus}
      />
      <div className="concept-chain-notice">
        <Database size={16} />
        <span>{data.message}</span>
      </div>
      <div className="concept-chain-groups">
        {(data.groups || []).map((group: any) => (
          <div className="concept-chain-group" key={group.name}>
            <h3>{group.name}</h3>
            <div>
              {(group.segments || []).map((segment: any) => (
                <button
                  key={segment.name}
                  onClick={() => onOpen(segment.matchedBoard || segment.name)}
                  title={segment.thsQuery}
                >
                  <span><b>{segment.name}</b><em>{segment.role}</em></span>
                  <small>{segment.description}</small>
                  <i>
                    重合 {segment.stockCount ?? segment.thsStockCount} / {data.stockCount} 只
                    {Number.isFinite(segment.overlapRatio)
                      ? ` · ${(segment.overlapRatio * 100).toFixed(1)}%`
                      : ""}
                  </i>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {!data.groups?.length && (
        <div className="concept-chain-empty">
          <Search size={22} />
          <b>暂未取得可用细分概念</b>
          <span>{data.query}</span>
        </div>
      )}
    </section>
  );
}

const normalizeSectorViewRow = (value: any, index = 0) => {
  const item = value && typeof value === "object" ? value : {};
  const normalizeMember = (value: any, memberIndex = 0) => {
    const member = value && typeof value === "object" ? value : {};
    const code = String(member.code || "").trim();
    return {
      ...member,
      code,
      name: String(member.name || code || `成分股${memberIndex + 1}`),
      secid: String(member.secid || ""),
      latest: nullableNumber(member.latest) ?? nullableNumber(member.price),
      changePct: nullableNumber(member.changePct),
      turnover: nullableNumber(member.turnover),
      amount: nullableNumber(member.amount),
      mainNetInflow: nullableNumber(member.mainNetInflow),
      firstSealTime: String(member.firstSealTime || ""),
      openBoardCount: member.openBoardCount == null ? null : safeNumber(member.openBoardCount),
      consecutiveBoards: member.consecutiveBoards == null ? null : safeNumber(member.consecutiveBoards),
      limitStatusKnown: member.limitStatusKnown ?? typeof member.isLimitUp === "boolean",
      isLimitUp: Boolean(member.isLimitUp)
    };
  };
  const normalizeReturns = (returns: any) => ({
    r1: nullableNumber(returns?.r1),
    r3: nullableNumber(returns?.r3),
    r5: nullableNumber(returns?.r5)
  });
  const rawConstituents = Array.isArray(item.constituents)
    ? item.constituents
    : Array.isArray(item.members)
      ? item.members
      : [];
  const constituents = rawConstituents
    .filter((member: any) => member && typeof member === "object")
    .map(normalizeMember);
  const poolLimitUps = nullableNumber(item.poolLimitUps) ?? nullableNumber(item.limitUps) ?? 0;
  const memberCount = nullableNumber(item.memberCount) ??
    (typeof item.members === "number" ? nullableNumber(item.members) : constituents.length || null);

  return {
    ...item,
    name: String(item.name || "未命名板块"),
    rank: Math.max(1, safeNumber(item.rank, index + 1)),
    state: String(item.state || "数据待补"),
    score: nullableNumber(item.score),
    returns: normalizeReturns(item.returns),
    benchmarkReturns: normalizeReturns(item.benchmarkReturns),
    allMarketReturns: normalizeReturns(item.allMarketReturns),
    constituents,
    leaders: Array.isArray(item.leaders)
      ? item.leaders.filter((member: any) => member && typeof member === "object").map(normalizeMember)
      : constituents.slice(0, 8),
    history: Array.isArray(item.history) ? item.history : [],
    memberCount,
    limitUps: nullableNumber(item.limitUps) ?? poolLimitUps,
    poolLimitUps,
    poolShare: safeNumber(item.poolShare),
    breadth: nullableNumber(item.breadth),
    memberAverageReturn: nullableNumber(item.memberAverageReturn),
    relativeReturn: nullableNumber(item.relativeReturn),
    amountHeat: nullableNumber(item.amountHeat),
    persistence: nullableNumber(item.persistence),
    memberAverageTurnover: nullableNumber(item.memberAverageTurnover),
    leadershipQualityScore: nullableNumber(item.leadershipQualityScore),
    advancingAmountShare: item.advancingAmountShare == null ? null : safeNumber(item.advancingAmountShare),
    positiveInflowRatio: item.positiveInflowRatio == null ? null : safeNumber(item.positiveInflowRatio),
    top5AmountShare: item.top5AmountShare == null ? null : safeNumber(item.top5AmountShare),
    medianMemberReturn: item.medianMemberReturn == null ? null : safeNumber(item.medianMemberReturn),
    returnDispersion: item.returnDispersion == null ? null : safeNumber(item.returnDispersion),
    dataCoveragePercent: nullableNumber(item.dataCoveragePercent),
    breadthDiagnostics: item.breadthDiagnostics && typeof item.breadthDiagnostics === "object"
      ? item.breadthDiagnostics
      : null
  };
};

/* ── B-09 / B-10 / B-12：成分股与板块榜改用原生表格语义 ───────────────────────
 *
 * 修复前两处「表格」都是 button + div 拼的：读屏/键盘用户拿不到「第几列是什么指标」，
 * 整行还是一个巨大的可聚焦按钮；北交所还把上限写成 1000 行，且成员列表在每次渲染时
 * 全量排序 + 过滤。
 *
 * 现在：
 *   · 语义用原生 <table>/<thead>/<th scope="col">/<tbody>/<tr>/<td>，首列是 <th scope="row">；
 *     “打开个股分析”“展开个股”都是真正的按钮，键盘可达（不再整行 button）。
 *   · 排序+过滤统一由 orderSectorMembers 处理并用 useMemo 缓存；默认每页 50 行，
 *     “加载更多”每次追加 50 行（北交所同样从 50 行起步，不再一次挂 1000 行）。
 *   · 成员表默认按涨幅降序；最新价/涨幅/换手/成交额/主力净流入点表头可在从大到小、从小到大之间切换
 *     （aria-sort 跟随当前列）；板块榜的板块涨幅/资金净流入/个股数量同样可点。筛选按钮用 aria-pressed。
 *
 * 布局兼容：行元素保留原有 class（.member-row / .sector-row），这些 class 本身是
 * display: grid，因此表格在视觉上与改造前一致（原生语义 + grid 布局），无需改样式表。
 */
export const MEMBER_PAGE_SIZE = 50;

/** B-10：成员排序（涨幅降序，未知值排尾）+ 过滤。纯函数，便于单测与缓存。 */
export function orderSectorMembers(constituents: any[], filter: string, query: string) {
  const normalizedQuery = query.trim();
  return constituents
    .slice()
    .sort((left: any, right: any) => (right.changePct ?? -Infinity) - (left.changePct ?? -Infinity))
    .filter((item: any) => {
      const name = String(item?.name ?? "");
      const code = String(item?.code ?? "");
      const queryMatched = !normalizedQuery || name.includes(normalizedQuery) || code.includes(normalizedQuery);
      const filterMatched =
        filter === "all" ||
        (filter === "limitUp" && item.isLimitUp) ||
        (filter === "up" && item.changePct > 0) ||
        (filter === "down" && item.changePct < 0);
      return queryMatched && filterMatched;
    });
}

const TABLE_BLOCK: CSSProperties = { display: "block", width: "100%" };
const TABLE_SECTION: CSSProperties = { display: "block" };
const TABLE_CELL: CSSProperties = { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, padding: 0, textAlign: "left", fontWeight: 400, color: "inherit" };
const TABLE_HEAD_CELL: CSSProperties = { ...TABLE_CELL, cursor: "default" };
const MEMBER_CELL: CSSProperties = { ...TABLE_CELL, gap: 2 };
const STACKED: CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };
const ROW_OPEN_BUTTON: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, padding: 0, border: 0, background: "transparent", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" };
const EXPAND_BUTTON: CSSProperties = { padding: 0, border: 0, background: "transparent", font: "inherit", cursor: "pointer" };

/** 可点击排序的表头：第一次点从大到小，再点从小到大。 */
function SortableHead<K extends string>({ label, sortKey, sort, onSort, style }: { label: string; sortKey: K; sort: ColumnSort<K>; onSort: (key: K) => void; style: CSSProperties }) {
  const active = sort.key === sortKey;
  return (
    <th scope="col" style={style} aria-sort={ariaSortOf(sort, sortKey)}>
      <button type="button" className={`column-sort-button${active ? " active" : ""}`}
        aria-label={sortButtonLabel(sort, sortKey, label)} onClick={() => onSort(sortKey)}>
        {label}{sortGlyph(sort, sortKey)}
      </button>
    </th>
  );
}

type MemberSortKey = "latest" | "changePct" | "turnover" | "amount" | "mainNetInflow";
const MEMBER_COLUMNS: Array<{ key: string; label: string; sortKey?: MemberSortKey }> = [
  { key: "stock", label: "股票" },
  { key: "latest", label: "最新价", sortKey: "latest" },
  { key: "changePct", label: "涨幅", sortKey: "changePct" },
  { key: "turnover", label: "换手", sortKey: "turnover" },
  { key: "amount", label: "成交额", sortKey: "amount" },
  { key: "mainNetInflow", label: "主力净流入", sortKey: "mainNetInflow" },
  { key: "status", label: "状态" }
];
const DEFAULT_MEMBER_SORT: ColumnSort<MemberSortKey> = { key: "changePct", direction: "desc" };

/** B-09：成分股明细表（原生 table；首屏 limit 行 + “加载更多”）。 */
export function SectorMemberTable({
  members,
  limit,
  exchangeBoard,
  emptyText,
  onOpenStock,
  onLoadMore
}: {
  members: any[];
  limit: number;
  exchangeBoard: boolean;
  emptyText: string;
  onOpenStock: (stock: any) => void;
  onLoadMore: () => void;
}) {
  const [sort, setSort] = useState<ColumnSort<MemberSortKey>>(DEFAULT_MEMBER_SORT);
  const sorted = useMemo(() => sortRowsBy(members, (item: any) => item?.[sort.key], sort.direction), [members, sort]);
  const visible = sorted.slice(0, limit);
  // 资金源整体不可用（一只都没取到）时不显示整列「暂缺」。
  const showFunds = members.some((item: any) => item?.mainNetInflow != null);
  const columns = showFunds ? MEMBER_COLUMNS : MEMBER_COLUMNS.filter(column => column.key !== "mainNetInflow");
  return (
    <>
      <table style={TABLE_BLOCK}>
        <thead style={TABLE_SECTION}>
          <tr className={`member-row member-head${showFunds ? "" : " no-funds"}`}>
            {columns.map((column) => column.sortKey ? (
              <SortableHead key={column.key} label={column.label} sortKey={column.sortKey} sort={sort} style={TABLE_HEAD_CELL}
                onSort={(key) => setSort((current) => toggleColumnSort(current, key))} />
            ) : (
              <th key={column.key} scope="col" style={TABLE_HEAD_CELL}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody style={TABLE_SECTION}>
          {visible.map((item: any) => (
            <tr className={`member-row${showFunds ? "" : " no-funds"}`} key={item.code}>
              <th scope="row" style={MEMBER_CELL}>
                <button type="button" style={ROW_OPEN_BUTTON} onClick={() => onOpenStock(item)}>
                  <span style={STACKED}><b>{item.name}</b><small>{item.code}</small></span>
                </button>
              </th>
              <td style={MEMBER_CELL}><span>{fmt(item.latest)}</span></td>
              <td style={MEMBER_CELL}>
                <span className={item.changePct == null ? "" : item.changePct > 0 ? "red" : item.changePct < 0 ? "green" : ""}>
                  {item.changePct != null && item.changePct > 0 ? "+" : ""}{fmt(item.changePct)}%
                </span>
              </td>
              <td style={MEMBER_CELL}><span>{fmt(item.turnover)}%</span></td>
              <td style={MEMBER_CELL}><span>{fmtMoney(item.amount)}</span></td>
              {showFunds && <td style={MEMBER_CELL}>
                <span
                  className={item.mainNetInflow == null || item.mainNetInflow === 0 ? "" : item.mainNetInflow > 0 ? "red" : "green"}
                  title={item.mainNetInflow == null ? "资金源暂未返回该股票的有效主力净流入，可刷新重试" : `${item.fundFlowSource || "来源待确认"} · 源数据 ${formatFundFlowTime(item.fundFlowAsOf)} · 本地获取 ${formatFundFlowTime(item.fundFlowCheckedAt)}`}
                >
                  {item.mainNetInflow == null ? "暂缺" : `${item.mainNetInflow > 0 ? "+" : ""}${fmtMoney(item.mainNetInflow)}`}
                </span>
              </td>}
              <td style={MEMBER_CELL}>
                <span>
                  {item.quoteStatus === "unavailable" ? "行情暂缺" : item.quoteStatus === "stale" ? "较早行情" : exchangeBoard && !item.limitStatusKnown ? "--" : item.isLimitUp ? <em className="limit-status">涨停</em> : "正常"}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!members.length && <EmptyInline text={emptyText} />}
      {members.length > limit && (
        <button type="button" className="member-load-more" onClick={onLoadMore}>
          加载更多（还有 {members.length - limit} 只，共 {members.length} 只）
        </button>
      )}
    </>
  );
}

type GainerSortKey = "change" | "limitUps" | "netInflow" | "memberCount";
const gainerValue = (item: any, key: GainerSortKey) => key === "change"
  ? item?.returns?.r1 ?? item?.memberAverageReturn
  : key === "limitUps" ? item?.poolLimitUps ?? item?.limitUps : key === "netInflow" ? item?.netInflow : item?.memberCount;

/** 板块资金净流入：源头精度是 0.01 亿，万元档不再显示「2400.00 万」这类假精度。 */
export function formatSectorFlow(value: unknown) {
  const amount = nullableNumber(value);
  if (amount == null) return "--";
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  if (absolute >= 1e8) return `${sign}${(absolute / 1e8).toFixed(2)} 亿`;
  if (absolute >= 1e4) return `${sign}${Math.round(absolute / 1e4)} 万`;
  return amount === 0 ? "0" : `${sign}${Math.round(absolute)}`;
}

/** 涨停家数（来自当日涨停池 / 同花顺涨停原因）；悬停显示是哪几只。 */
const limitUpCount = (item: any): number | null => nullableNumber(item?.poolLimitUps ?? item?.limitUps);
const limitUpNames = (item: any): string => (Array.isArray(item?.leaders) ? item.leaders : []).map((stock: any) => stock?.name).filter(Boolean).slice(0, 8).join("、");

/** B-09：板块涨幅排行表（原生 table；展开的个股明细作为整行 <td> 附属行）。 */
export function SectorGainersTable({
  rows,
  limit,
  expandedName,
  detailOrigin,
  expandedRowRef,
  onToggle,
  renderDetail
}: {
  rows: any[];
  /** 只显示排序后的前 limit 行（概念榜很长，分批显示）。 */
  limit?: number | undefined;
  expandedName: string;
  detailOrigin: "board" | "search";
  expandedRowRef: { current: HTMLButtonElement | null };
  onToggle: (item: any, expanded: boolean) => void;
  renderDetail: () => ReactNode;
}) {
  // 排名固定为当日涨幅名次；点表头只改变显示顺序。
  const [sort, setSort] = useState<ColumnSort<GainerSortKey>>({ key: "change", direction: "desc" });
  const sorted = useMemo(() => {
    const ordered = sortRowsBy(rows, (item: any) => gainerValue(item, sort.key), sort.direction);
    return limit ? ordered.slice(0, limit) : ordered;
  }, [rows, sort, limit]);
  const onSort = (key: GainerSortKey) => setSort((current) => toggleColumnSort(current, key));
  return (
    <table className="sector-comparison-table" style={TABLE_BLOCK}>
      <thead style={TABLE_SECTION}>
        <tr className="sector-row sector-row-head sector-gainers-row">
          <th scope="col" style={TABLE_HEAD_CELL}>排名 / 板块</th>
          <SortableHead label="板块涨幅" sortKey="change" sort={sort} onSort={onSort} style={TABLE_HEAD_CELL} />
          <SortableHead label="涨停" sortKey="limitUps" sort={sort} onSort={onSort} style={TABLE_HEAD_CELL} />
          <SortableHead label="资金净流入" sortKey="netInflow" sort={sort} onSort={onSort} style={TABLE_HEAD_CELL} />
          <SortableHead label="个股数量" sortKey="memberCount" sort={sort} onSort={onSort} style={TABLE_HEAD_CELL} />
          <th scope="col" style={TABLE_HEAD_CELL}>领涨股</th>
          <th scope="col" style={TABLE_HEAD_CELL}>个股明细</th>
        </tr>
      </thead>
      <tbody style={TABLE_SECTION}>
        {sorted.map((item: any) => {
          const expanded = detailOrigin === "board" && expandedName === item.name;
          const change = item.returns.r1 ?? item.memberAverageReturn;
          const detailId = `sector-gainers-detail-${item.rank}`;
          const limits = limitUpCount(item);
          const names = limitUpNames(item);
          return (
            <Fragment key={`${item.code || ""}:${item.name}`}>
              <tr
                className={`sector-row sector-gainers-row ${expanded ? "active" : ""}`}
                aria-expanded={expanded}
                aria-label={`${item.name}，${expanded ? "收起" : "展开"}个股`}
              >
                <td style={TABLE_CELL}>
                  <b>#{item.rank} {item.name}</b>
                  <small>{item.displayCode || item.code || (item.boardType === "concept" ? "同花顺概念" : "代码待补")}{item.boardType === "exchange" ? ` · ${item.state}` : ""}</small>
                </td>
                <td style={TABLE_CELL}><b className={change == null ? "" : change > 0 ? "red" : change < 0 ? "green" : ""}>{change == null ? "--" : `${change > 0 ? "+" : ""}${fmt(change)}%`}</b></td>
                <td style={TABLE_CELL} className="sector-limit-cell" title={names ? `涨停：${names}` : undefined}>
                  {limits == null ? <span className="muted">--</span> : limits > 0 ? <><b className="red">{limits} 家</b>{names && <small>{names}</small>}</> : <span className="muted">0</span>}
                </td>
                <td style={TABLE_CELL} className={item.netInflow == null ? "" : item.netInflow > 0 ? "red" : item.netInflow < 0 ? "green" : ""}>{formatSectorFlow(item.netInflow)}</td>
                <td style={TABLE_CELL}>{item.memberCoverage && !item.memberCoverage.complete ? `已取 ${item.memberCoverage.loaded} 只` : (item.memberCount == null ? "--" : `${item.memberCount} 只`)}</td>
                <td style={TABLE_CELL}>{item.leaderName || item.leaders[0]?.name || "--"}</td>
                <td style={TABLE_CELL}>
                  <button
                    ref={expanded ? expandedRowRef : null}
                    type="button"
                    className="sector-expand-label"
                    aria-expanded={expanded}
                    aria-label={`${item.name}，${expanded ? "收起" : "展开"}个股`}
                    aria-controls={expanded ? detailId : undefined}
                    style={EXPAND_BUTTON}
                    onClick={() => onToggle(item, expanded)}
                  >
                    {expanded ? "收起个股 ▴" : "展开个股 ▾"}
                  </button>
                </td>
              </tr>
              {expanded && (
                <tr style={TABLE_SECTION}>
                  <td id={detailId} colSpan={7} style={{ display: "block", width: "100%", padding: 0 }}>{renderDetail()}</td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/** 概念榜行 → 与行业榜同形的行（同一张表展示）；代码用 885/886 指数代码，展开时按概念板块读取成分。 */
export function conceptBoardRows(concepts: SectorConceptRow[] | undefined) {
  return (Array.isArray(concepts) ? concepts : []).map((item, index) => normalizeSectorViewRow({
    name: item.name, code: item.indexCode || "", displayCode: item.indexCode || "", conceptCid: item.conceptCid, boardType: "concept",
    returns: { r1: item.changePct }, netInflow: item.netInflow, memberCount: item.memberCount, leaderName: item.leaderName,
    poolLimitUps: item.limitUps, limitUps: item.limitUps, leaders: item.limitUpStocks
  }, index));
}

const CONCEPT_PAGE = 60;

/** 今日涨停主线：同花顺涨停原因按「+」拆开计数；点一下打开同名概念板块。 */
function SectorThemeStrip({ themes, total, onOpen }: { themes: SectorTheme[]; total: number | null; onOpen: (theme: SectorTheme) => void }) {
  if (!themes.length) return null;
  return <section className="panel sector-theme-strip" aria-label="今日涨停主线">
    <div className="sector-theme-head"><Flame size={16} /><b>今日涨停主线</b><small>同花顺涨停原因归类{total != null ? ` · 全市场涨停 ${total} 家` : ""} · 有同名概念板块的可点开看成分股</small></div>
    <div className="sector-theme-list">{themes.slice(0, 12).map(theme => <button key={theme.reason} type="button" onClick={() => onOpen(theme)} disabled={!theme.concept}
      title={`${theme.stocks.map(stock => `${stock.name}${stock.boards && stock.boards > 1 ? `(${stock.boards}板)` : ""}`).join("、")}${theme.concept ? "" : "（同花顺没有同名概念板块）"}`}>
      <span><b>{theme.reason}</b><em>{theme.count} 家</em></span>
      <small>{theme.stocks.slice(0, 3).map(stock => stock.name).join("、")}{theme.stocks.length > 3 ? " 等" : ""}</small>
    </button>)}</div>
  </section>;
}

function SectorView({ rows, extra, loading, loadError, onRefresh, onOpenStock, dedicatedSector, aiPanel }: {
  /** 板块强度页标题下方的「AI 解读」。 */
  aiPanel?: ReactNode;
  /** 概念榜、今日涨停主线（1.6.43 起与行业榜一起取回）。 */
  extra?: { concepts: SectorConceptRow[]; themes: SectorTheme[]; warnings: string[]; conceptLimitUpSource: string; limitUpTotal: number | null } | null | undefined;
  dedicatedSector?: "北交所";
  rows: any[];
  loading: boolean;
  loadError: string;
  onRefresh: () => Promise<boolean | void> | boolean | void;
  onOpenStock: (stock: Security) => void;
}) {
  const [selectedName, setSelectedName] = useState(dedicatedSector || "");
  const [expandedName, setExpandedName] = useState("");
  const expandedRow = useRef<HTMLButtonElement | null>(null);
  const [detailOrigin, setDetailOrigin] = useState<"board" | "search">("board");
  const composing = useRef(false);
  const [sectorQuery, setSectorQuery] = useState("");
  const [sectorSuggestions, setSectorSuggestions] = useState<any[]>([]);
  const [sectorSearchFocused, setSectorSearchFocused] = useState(false);
  const [sectorSearching, setSectorSearching] = useState(false);
  const [sectorAnalyzing, setSectorAnalyzing] = useState(Boolean(dedicatedSector));
  const [customSector, setCustomSector] = useState<any>(null);
  const [sectorError, setSectorError] = useState("");
  useEffect(() => {
    if (!expandedName) return;
    const frame = window.requestAnimationFrame(() => expandedRow.current?.scrollIntoView({ block: "start" }));
    return () => window.cancelAnimationFrame(frame);
  }, [expandedName, sectorAnalyzing, customSector?.name]);

  const [boardKind, setBoardKind] = useState<"industry" | "concept">("industry");
  const [conceptLimit, setConceptLimit] = useState(CONCEPT_PAGE);
  const conceptRows = useMemo(() => conceptBoardRows(extra?.concepts), [extra?.concepts]);
  const [memberFilter, setMemberFilter] = useState("all");
  const [memberQuery, setMemberQuery] = useState("");
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [conceptChain, setConceptChain] = useState<any>(null);
  const [conceptChainLoading, setConceptChainLoading] = useState(false);
  const sectorSearchTimer = useRef<number | undefined>(undefined);
  const sectorSearchRequest = useRef(0);
  const sectorAnalysisRequest = useRef(0);
  const selectedSectorRequest = useRef<Record<string, unknown> | null>(null);
  const conceptChainRequest = useRef(0);
  const normalizedRows = useMemo(
    () => (Array.isArray(rows) ? rows : [])
      .filter((item) => item && item.code !== "THS:BJ" && item.name !== "北交所")
      .map((item, index) => normalizeSectorViewRow(item, index))
      .sort((a, b) => {
        const left = a.returns.r1 ?? a.memberAverageReturn;
        const right = b.returns.r1 ?? b.memberAverageReturn;
        if (left == null) return right == null ? a.name.localeCompare(b.name, "zh-CN") : 1;
        if (right == null) return -1;
        return right - left || a.name.localeCompare(b.name, "zh-CN");
      })
      .map((item, index) => ({ ...item, rank: index + 1 })),
    [rows]
  );

  useEffect(() => () => {
    sectorSearchRequest.current += 1;
    sectorAnalysisRequest.current += 1;
    conceptChainRequest.current += 1;
    window.clearTimeout(sectorSearchTimer.current);
  }, []);

  const changeSectorQuery = useCallback((value: string) => {
    sectorSearchRequest.current += 1;
    window.clearTimeout(sectorSearchTimer.current);
    setSectorQuery(value);
    setSectorSuggestions([]);
    setSectorSearching(false);
  }, []);

  useEffect(() => {
    const requestId = ++sectorSearchRequest.current;
    window.clearTimeout(sectorSearchTimer.current);
    if (!sectorQuery.trim()) {
      setSectorSuggestions([]);
      return;
    }
    sectorSearchTimer.current = window.setTimeout(async () => {
      setSectorSearching(true);
      try {
        const suggestions = await window.stockApi.searchSectors(sectorQuery);
        if (requestId === sectorSearchRequest.current) setSectorSuggestions(suggestions);
      } catch {
        if (requestId === sectorSearchRequest.current) setSectorSuggestions([]);
      } finally {
        if (requestId === sectorSearchRequest.current) setSectorSearching(false);
      }
    }, 220);
    return () => {
      window.clearTimeout(sectorSearchTimer.current);
      if (requestId === sectorSearchRequest.current) sectorSearchRequest.current += 1;
    };
  }, [sectorQuery]);

  const openSector = useCallback(async (item: any, origin: "board" | "search" = "search") => {
    const requestedName = typeof item === "string"
      ? item
      : String(item?.name || item?.query || item?.code || "");
    const request = {
      ...(typeof item === "object" && item ? item : {}),
      ...(dedicatedSector ? { waitForQuotes: false } : {}),
      name: requestedName
    };
    const requestId = ++sectorAnalysisRequest.current;
    selectedSectorRequest.current = request;
    setDetailOrigin(origin);
    setShowAnalysis(false);
    setSelectedName(requestedName);
    setExpandedName(origin === "board" ? requestedName : "");
    setCustomSector(null);
    setMemberFilter("all");
    setMemberQuery("");
    setSectorAnalyzing(true);
    setSectorSearchFocused(false);
    setSectorError("");
    setSectorSuggestions([]);
    try {
      const detail = await window.stockApi.analyzeSector(request);
      if (!detail || typeof detail !== "object") throw new Error("未取得板块成分股，请重试");
      const normalizedDetail = {
        ...detail,
        name: String(detail.name || requestedName)
      };
      if (requestId !== sectorAnalysisRequest.current) return;
      setCustomSector(normalizedDetail);
      if (origin === "search" && !dedicatedSector) changeSectorQuery(normalizedDetail.name);
    } catch (error) {
      if (requestId === sectorAnalysisRequest.current) {
        setSectorError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (requestId === sectorAnalysisRequest.current) setSectorAnalyzing(false);
    }
  }, [dedicatedSector, changeSectorQuery]);

  useEffect(() => {
    if (dedicatedSector) void openSector({ name: dedicatedSector, code: "THS:BJ" });
  }, [dedicatedSector, openSector]);

  useEffect(() => {
    if (!dedicatedSector || !customSector?.quoteCoverage?.pending) return;
    let stopped = false;
    let busy = false;
    const requestId = sectorAnalysisRequest.current;
    const timer = window.setInterval(whenVisible(async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await window.stockApi.analyzeSector({ code: "THS:BJ", name: dedicatedSector, waitForQuotes: false });
        if (!stopped && requestId === sectorAnalysisRequest.current) setCustomSector(normalizeSectorViewRow(result));
      } catch {
        // Preserve the full roster on a transient progress-read failure; retry next visible tick.
      } finally { busy = false; }
    }), 1500);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [dedicatedSector, customSector?.quoteCoverage?.pending]);

  const selectedSector = customSector || normalizedRows.find((item) => item.name === selectedName) || normalizedRows[0];
  // B-10：缓存归一化结果，成员列表的 useMemo 才能保持引用稳定（否则每次渲染都换新数组 → 全量重排）。
  const sector = useMemo(() => (selectedSector ? normalizeSectorViewRow(selectedSector) : null), [selectedSector]);

  const refreshSectorBoard = async () => {
    if (loading) return;
    sectorAnalysisRequest.current += 1;
    setSectorAnalyzing(false);
    const refreshed = await onRefresh();
    if (refreshed === false) return;
    setCustomSector(null);
    setExpandedName("");
    changeSectorQuery("");
    setSectorError("");
    setMemberFilter("all");
    setMemberQuery("");
  };

  useEffect(() => {
    const name = showAnalysis ? customSector?.name || "" : "";
    const requestId = ++conceptChainRequest.current;
    if (!name) {
      setConceptChain(null);
      setConceptChainLoading(false);
      return;
    }
    setConceptChainLoading(true);
    window.stockApi
      .getConceptChain(customSector)
      .then((value) => {
        if (requestId === conceptChainRequest.current) setConceptChain(value);
      })
      .catch(() => {
        if (requestId === conceptChainRequest.current) setConceptChain(null);
      })
      .finally(() => {
        if (requestId === conceptChainRequest.current) setConceptChainLoading(false);
      });
  }, [customSector?.name, showAnalysis]);

  // B-10：北交所（服务端上限 1000 只）不再一次渲染 1000 行，与普通板块一致按 50 行分页，
  // “加载更多”每次追加 50 行；排序+过滤结果按依赖缓存，键盘输入筛选词时不再全量重排。
  const [memberLimit, setMemberLimit] = useState(MEMBER_PAGE_SIZE);
  useEffect(() => { setMemberLimit(MEMBER_PAGE_SIZE); }, [sector?.name, memberQuery, memberFilter]);

  const members = useMemo(
    () => orderSectorMembers(sector?.constituents || [], memberFilter, memberQuery),
    [sector?.constituents, memberFilter, memberQuery]
  );
  const sectorHistory = sector?.history || [];
  const historyAmounts = sectorHistory.map((day: any) => Number(day.amount || 0));
  const maxHistoryAmount = Math.max(1, ...historyAmounts);
  const averageHistoryAmount = historyAmounts.length
    ? historyAmounts.reduce((sum: number, amount: number) => sum + amount, 0) / historyAmounts.length
    : 0;

  const memberLimitStatusKnown = sector?.boardType !== "exchange" || sector?.constituents.some((item: any) => item.limitStatusKnown);

  const memberPanel = sector ? (
<div className="panel sector-members-panel">
              <PanelTitle title={dedicatedSector ? "北交所个股行情" : `${sector.name} 成分股明细`} subtitle={dedicatedSector ? "名单：新浪财经北交所名录 · 行情：同花顺逐股快照 · 可搜索全部股票" : "按个股涨幅排序；点击股票打开分析"} icon={LayoutDashboard} badge={sector.quoteCoverage ? `名单 ${sector.constituents.length}${sector.memberCoverage?.complete ? `/${sector.memberCoverage.total}` : " · 最新总数待核验"} 只 · 同花顺行情 ${sector.quoteCoverage.loaded}/${sector.quoteCoverage.total} 只${sector.quoteCoverage.pending ? " · 读取中" : ""}` : sector.memberCoverage && !sector.memberCoverage.complete
                ? `已加载 ${sector.constituents.length} 只 · 非全量`
                : `已加载 ${sector.constituents.length} 只${sector.memberCount > sector.constituents.length ? ` / 板块 ${sector.memberCount} 只` : ""}`} />
              {sector.boardType === "exchange" && <div className="warning-banner">{sector.warning || `名单总数及全部分页已核验。${sector.quoteBasis}`} {sector.quoteCoverage?.asOf && `行情日期：${sector.quoteCoverage.asOf}。`}</div>}
              {sector.fundFlow?.quotes && <p className="sector-fund-flow-source" role="status">
                {sector.fundFlow.quotes.loaded > 0
                  ? `个股行情：${sector.fundFlow.quotes.source} 实时 · ${sector.fundFlow.quotes.loaded}/${sector.fundFlow.quotes.total} 只 · 行情时间 ${formatFundFlowTime(sector.fundFlow.quotes.asOf)}${sector.fundFlow.quotes.loaded < sector.fundFlow.quotes.total ? "；其余股票显示同花顺成分页数据（开盘前可能是上一交易日）" : ""}`
                  : "个股行情：实时行情本次没取到，显示的是同花顺成分页数据，集合竞价和开盘前可能还是上一交易日的成交额与换手，可点「刷新个股数据」重试。"}
              </p>}
              {sector.fundFlow && (sector.fundFlow.loaded > 0 ? <p className="sector-fund-flow-source" role="status">
                主力净流入：{sector.fundFlow.source} · {sector.fundFlow.loaded}/{sector.fundFlow.total} 只 · 源数据 {formatFundFlowTime(sector.fundFlow.asOf)} · 展开或刷新时读取，缓存 {sector.fundFlow.cacheSeconds || 60} 秒。
                {sector.fundFlow.status === "partial" ? "部分股票的资金数据暂缺。" : ""}
              </p> : <p className="sector-fund-flow-source" role="status">个股主力净流入：{sector.fundFlow.source || "资金源"}本次没有返回数据，已隐藏该列，可点「刷新个股数据」重试。</p>)}
            <div className="member-toolbar">
                <div>
                  {[
                    { id: "all", label: "全部" },
                    { id: "limitUp", label: `涨停 ${memberLimitStatusKnown ? sector.limitUps : "--"}` },
                    { id: "up", label: "上涨" },
                    { id: "down", label: "下跌" }
                  ].map((item) => <button key={item.id} disabled={item.id === "limitUp" && !memberLimitStatusKnown} aria-pressed={memberFilter === item.id} className={memberFilter === item.id ? "active" : ""} onClick={() => setMemberFilter(item.id)}>{item.label}</button>)}
                  <button type="button" onClick={() => void openSector({ code: sector.code, name: sector.name, secid: sector.secid, memberCount: sector.memberCount, forceRefresh: true }, detailOrigin)}>刷新个股数据</button>
                </div>
                <label><Search size={15} /><input value={memberQuery} onChange={(event) => setMemberQuery(event.target.value)} aria-label="筛选当前板块个股" placeholder="筛选股票名称或代码" /></label>
              </div>
              <div className="sector-member-table">
                <SectorMemberTable
                  members={members}
                  limit={memberLimit}
                  exchangeBoard={sector.boardType === "exchange"}
                  emptyText={sector.constituents.length ? "当前筛选条件下没有成分股" : "本次未取得成分股，请重试"}
                  onOpenStock={onOpenStock}
                  onLoadMore={() => setMemberLimit((current) => current + MEMBER_PAGE_SIZE)}
                />
              </div>
            </div>
  ) : null;

  const retrySelectedSector = () => void openSector(
    { ...(selectedSectorRequest.current || {}), name: selectedName,
      ...(selectedName === "北交所" ? { code: "THS:BJ", forceRefresh: true } : {}) }, detailOrigin
  );

  // B-09：整行不再是 button，展开/收起由行内按钮触发；行的 aria-expanded 仅作状态说明。
  const toggleSectorRow = (item: any, expanded: boolean) => {
    if (expanded) {
      sectorAnalysisRequest.current += 1;
      setSectorAnalyzing(false);
      setExpandedName("");
      setSectorError("");
    } else {
      void openSector(item, "board");
    }
  };

  const detailPanel = (
    <section className="sector-inline-detail" role="region" aria-label={`${selectedName} 成分股`} aria-busy={sectorAnalyzing}>
      {sectorAnalyzing ? (
        <div className="sector-members-feedback" role="status"><LoaderCircle className="spin" size={18} />正在加载 {selectedName} 的具体个股…</div>
      ) : sectorError ? (
        <div className="sector-members-error">
          <div className="sector-members-feedback sector-members-error-feedback" role="alert">
            <CircleAlert size={18} />
            <div className="sector-feedback-copy">
              <b>暂未取得 {selectedName} 的板块行情</b>
              <span>可能是网络连接或行情数据暂不完整。请检查或更换板块名称或代码，或稍后重试。</span>
            </div>
            <button onClick={retrySelectedSector}>重试加载个股</button>
          </div>
          <details className="sector-technical-details">
            <summary>技术详情</summary>
            <p>{sectorError}</p>
          </details>
        </div>
      ) : (
        <>
          {memberPanel}
          {!sector?.constituents.length && <div className="sector-members-feedback"><button onClick={retrySelectedSector}>重试加载个股</button></div>}
        </>
      )}
    </section>
  );

  if (dedicatedSector) {
    return (
      <>
        <PageHeading eyebrow="BEIJING STOCKS" title="北交所"
          actions={<button className="primary-btn" onClick={() => void openSector({ name: dedicatedSector, code: "THS:BJ", forceRefresh: true })} disabled={sectorAnalyzing}><RefreshCw size={17} className={sectorAnalyzing ? "spin" : ""} />刷新北交所行情</button>} />
        {detailPanel}
      </>
    );
  }

  return (
    <>
      <PageHeading
        eyebrow="SECTOR GAINERS"
        title="板块强度"
        actions={<button className="primary-btn" onClick={refreshSectorBoard} disabled={loading}><RefreshCw size={17} className={loading ? "spin" : ""} />刷新板块排行</button>}
      />
      {aiPanel}
      {loadError && <div className="sector-board-feedback">
        <div className="warning-banner" role="alert"><CircleAlert size={17} />
          暂未取得最新板块排行，可能是网络连接或行情数据暂不完整。请稍后点击“刷新板块排行”重试。
          {normalizedRows.length ? "当前继续显示上一次有效结果。" : "也可输入板块名称或代码查询。"}
        </div>
        <details className="sector-technical-details">
          <summary>技术详情</summary>
          <p>{loadError}</p>
        </details>
      </div>}
      {!!extra?.themes.length && <SectorThemeStrip themes={extra.themes} total={extra.limitUpTotal} onOpen={theme =>
        void openSector(theme.concept ? { name: theme.concept.name, code: conceptRows.find(row => row.name === theme.concept?.name)?.code || "", boardType: "concept" } : theme.reason, "search")} />}
      <div className="panel sector-search-panel">
        <div className="sector-search-copy">
          <Search size={22} />
          <div><b>搜索任意板块</b><small>输入板块名称或代码查看成分股</small></div>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); if (composing.current) return; if (sectorSuggestions[0]) openSector(sectorSuggestions[0]); else if (sectorQuery.trim()) openSector(sectorQuery.trim()); }}>
          <Search size={18} />
          <input
            value={sectorQuery}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={(event) => { if (event.key === "Enter" && (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}
            onChange={(event) => changeSectorQuery(event.target.value)}
            onFocus={() => setSectorSearchFocused(true)}
            onBlur={() => window.setTimeout(() => setSectorSearchFocused(false), 150)}
            placeholder="输入 PCB、CPO、机器人、算力、低空经济等"
          />
          {sectorSearching && <LoaderCircle size={17} className="spin" />}
          <button type="submit" disabled={sectorAnalyzing}>{sectorAnalyzing ? <LoaderCircle size={17} className="spin" /> : "查询板块"}</button>
          {sectorSearchFocused && sectorSuggestions.length > 0 && (
            <div className="sector-suggestions">
              {sectorSuggestions.map((item) => (
                <button type="button" key={item.secid} onClick={() => openSector(item)}>
                  <span><b>{item.name}</b><small>{item.code}</small></span><em>{item.type}</em>
                </button>
              ))}
            </div>
          )}
        </form>
        <div className="sector-quick-search">
          {["PCB", "CPO", "机器人", "算力", "低空经济"].map((item) => <button key={item} onClick={() => { changeSectorQuery(item); openSector(item); }}>{item}</button>)}
        </div>
      </div>

      {detailOrigin === "search" && selectedName && (
        <div className="sector-search-detail">
          <div className="sector-query-result"><span>板块个股</span><b>{selectedName}</b><button onClick={() => { sectorAnalysisRequest.current += 1; setSectorAnalyzing(false); setCustomSector(null); setSectorError(""); setDetailOrigin("board"); setExpandedName(""); }}>返回板块涨幅排行</button></div>
          {detailPanel}
        </div>
      )}
      {loading && !normalizedRows.length ? <div className="loading-state" role="status" aria-live="polite"><Radar size={42} /><h2>正在加载板块涨幅排行</h2><p>正在读取板块行情与当日涨幅，请稍候。</p></div> : normalizedRows.length ? (
        <div className="panel sector-board-panel sector-gainers-panel">
          <div className="sector-board-head">
            <div className="sector-board-tabs" role="tablist" aria-label="板块类别">
              <button type="button" role="tab" aria-selected={boardKind === "industry"} className={boardKind === "industry" ? "active" : ""} onClick={() => setBoardKind("industry")}>行业<small>{normalizedRows.length}</small></button>
              <button type="button" role="tab" aria-selected={boardKind === "concept"} className={boardKind === "concept" ? "active" : ""} disabled={!conceptRows.length} onClick={() => setBoardKind("concept")}>概念<small>{conceptRows.length || "--"}</small></button>
            </div>
            <small className="sector-board-note">{boardKind === "industry"
              ? "同花顺行业：当日涨幅、主力净流入；涨停家数按同花顺实时涨停池、个股所属同花顺行业统计（交易时段每分钟自动刷新）。点表头可换排序，点板块展开个股。"
              : `同花顺概念：当日涨幅、主力净流入；涨停家数${extra?.conceptLimitUpSource ? `按${extra.conceptLimitUpSource}统计` : "需要同花顺扶摇 Key（数据源设置），暂缺"}。`}</small>
          </div>
          {!!extra?.warnings.length && <p className="sector-board-warning" role="status">{extra.warnings.slice(0, 2).join("；")}</p>}
          <SectorGainersTable
            key={boardKind}
            rows={boardKind === "concept" ? conceptRows : normalizedRows}
            limit={boardKind === "concept" ? conceptLimit : undefined}
            expandedName={expandedName}
            detailOrigin={detailOrigin}
            expandedRowRef={expandedRow}
            onToggle={toggleSectorRow}
            renderDetail={() => detailPanel}
          />
          {boardKind === "concept" && conceptRows.length > conceptLimit && <button type="button" className="member-load-more" onClick={() => setConceptLimit(value => value + CONCEPT_PAGE)}>
            显示更多概念（还有 {conceptRows.length - conceptLimit} 个，共 {conceptRows.length} 个）</button>}
        </div>
      ) : <div className="panel empty-state"><Layers3 size={32} /><h3>暂无板块排行</h3><p>可刷新排行，或输入板块名称查看具体个股。</p></div>}
      {customSector && !sectorAnalyzing && !sectorError && sector && (
        <details className="sector-extra-analysis" open={showAnalysis} onToggle={event => setShowAnalysis(event.currentTarget.open)}>
          <summary>{sector.name} · 更多强度分析</summary>
          <ConceptChainPanel
            data={conceptChain}
            loading={conceptChainLoading}
            onOpen={openSector}
          />

          <div className="market-summary-grid">
            <div className="panel"><span>板块成分股</span><b>{sector.memberCount}</b><small>{sector.name}</small></div>
            <div className="panel"><span>板块涨停股</span><b>{sector.limitUps ?? sector.poolLimitUps}</b><small>当前交易日</small></div>
            <div className="panel"><span>{sector.marketProxy || "全A基准"} 1日</span><b className={sector.allMarketReturns?.r1 == null ? "" : sector.allMarketReturns.r1 > 0 ? "red" : sector.allMarketReturns.r1 < 0 ? "green" : ""}>{sector.allMarketReturns?.r1 == null ? "--" : `${sector.allMarketReturns.r1 > 0 ? "+" : ""}${fmt(sector.allMarketReturns.r1)}%`}</b><small>全市场代理基准</small></div>
            <div className="panel"><span>沪深300 1日</span><b className={sector.benchmarkReturns?.r1 == null ? "" : sector.benchmarkReturns.r1 > 0 ? "red" : sector.benchmarkReturns.r1 < 0 ? "green" : ""}>{sector.benchmarkReturns?.r1 == null ? "--" : `${sector.benchmarkReturns.r1 > 0 ? "+" : ""}${fmt(sector.benchmarkReturns.r1)}%`}</b><small>大盘权重基准</small></div>
          </div>

          {sector.ladder && (
            <div className="panel sector-ladder-panel">
              <PanelTitle
                title="涨停梯队与扩散"
                subtitle="对比今日涨停、昨日晋级与当前炸板，判断板块持续性"
                icon={Target}
                badge={`${sector.ladder.score == null ? "评分暂停" : `${sector.ladder.score}分`} · ${sector.ladder.state}`}
              />
              <div className="ladder-metric-grid">
                <Metric label="板块高度" value={sector.ladder.maxHeight ? `${sector.ladder.maxHeight} 板` : "无连板"} />
                <Metric label="首板家数" value={String(sector.ladder.firstBoards)} tone="red" />
                <Metric label="连板家数" value={String(sector.ladder.continuationBoards)} tone="red" />
                <Metric label="昨日晋级率" value={`${fmt(sector.ladder.promotionRate * 100, 1)}%`} />
                <Metric
                  label="当前炸板数"
                  value={sector.ladder.failedBoards == null ? "--" : String(sector.ladder.failedBoards)}
                  tone={sector.ladder.failedBoards > 0 ? "green" : ""}
                />
                <Metric
                  label="炸板率"
                  value={sector.ladder.breakRate == null ? "--" : `${fmt(sector.ladder.breakRate * 100, 1)}%`}
                  tone={sector.ladder.breakRate != null && sector.ladder.breakRate > 0.35 ? "green" : ""}
                />
              </div>
              <div className="ladder-levels">
                {(sector.ladder.levels || []).map((level: any) => (
                  <div key={level.height}>
                    <b>{level.label}</b>
                    <span>
                      {level.stocks.map((stock: any) => (
                        <button key={stock.code} onClick={() => onOpenStock(stock)}>
                          {stock.name}<small>{stock.firstSealTime || "--"} · 开板{stock.openBoardCount ?? 0}</small>
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
                {!sector.ladder.levels?.length && <EmptyInline text="当前板块暂无涨停梯队" />}
              </div>
              <div className="ladder-explain">
                今日涨停 {sector.ladder.currentLimitUps} 家，昨日该板块涨停 {sector.ladder.previousLimitUps} 家，
                实际晋级 {sector.ladder.promotedCount} 家；
                {sector.ladder.failedPoolAvailable === false
                  ? "炸板源本次不可用，风险分与炸板率暂停计算，避免把缺失数据误判为零。"
                  : "炸板股单独计入风险，不再用“最新价等于最高价”近似判断。"}
              </div>
            </div>
          )}

          <div className="sector-analysis-grid">
            <div className="panel sector-score-summary">
              <span>当前板块</span><h2>{sector.name}</h2><strong>{sector.score ?? "--"}</strong><em>{sector.state}</em>
              <p>
                板块代码 {sector.code || "--"}。
                {sector.score == null
                  ? (sector.dataCoveragePercent == null
                    ? "该板块名称未在同花顺行业榜中匹配到，请确认板块名或用 6 位板块代码（881xxx）查询；也可在上方搜索框按股票反查所属行业。"
                    : `综合评分暂不可用（覆盖 ${fmt(sector.dataCoveragePercent, 0)}%）；涨幅、成交额、成分明细仍可见。`)
                  : `综合强度 ${sector.score} 分，内部质量 ${fmt(sector.leadershipQualityScore, 0)} 分，证据覆盖 ${fmt(sector.dataCoveragePercent, 0)}%。`}
                {" "}数据源：{sector.dataSource || "--"}；评分用于横向比较，不直接等同于买入信号。
              </p>
              <div className="leader-tags">
                {(sector.leaders || []).slice(0, 8).map((item: any) => <span key={item.code}>{item.name} <b className={item.changePct == null ? "" : item.changePct > 0 ? "red" : item.changePct < 0 ? "green" : ""}>{item.changePct == null ? "--" : `${item.changePct != null && item.changePct > 0 ? "+" : ""}${fmt(item.changePct)}%`}</b></span>)}
              </div>
            </div>
            <div className="panel comparison-detail">
              <PanelTitle title="完整收益对比" subtitle={`${sector.name} vs ${sector.marketProxy || "全A基准"} / 沪深300`} icon={Activity} />
              <div className="comparison-periods">
                {[1, 3, 5].map((day) => {
                  const key = `r${day}`;
                  const sectorReturn = nullableNumber(sector.returns[key]);
                  const hs300Excess = subtractNullable(sectorReturn, sector.benchmarkReturns[key]);
                  const marketExcess = subtractNullable(sectorReturn, sector.allMarketReturns?.[key]);
                  return (
                    <div key={day}>
                      <span>{day} 日板块</span>
                      <b className={sectorReturn == null ? "" : sectorReturn > 0 ? "red" : sectorReturn < 0 ? "green" : ""}>{sectorReturn == null ? "--" : `${sectorReturn > 0 ? "+" : ""}${fmt(sectorReturn)}%`}</b>
                      <small>{sector.marketProxy || "全A基准"} {sector.allMarketReturns?.[key] == null ? "--" : `${fmt(sector.allMarketReturns[key])}%`} · 沪深300 {sector.benchmarkReturns[key] == null ? "--" : `${fmt(sector.benchmarkReturns[key])}%`}</small>
                      <em className={marketExcess == null ? "" : marketExcess > 0 ? "red" : marketExcess < 0 ? "green" : ""}>全市场超额 {marketExcess == null ? "--" : `${marketExcess > 0 ? "+" : ""}${fmt(marketExcess)}%`}</em>
                      <em className={hs300Excess == null ? "" : hs300Excess > 0 ? "red" : hs300Excess < 0 ? "green" : ""}>沪深300超额 {hs300Excess == null ? "--" : `${hs300Excess > 0 ? "+" : ""}${fmt(hs300Excess)}%`}</em>
                    </div>
                  );
                })}
              </div>
              <div className="detail-factor-grid">
                <div><span>板块上涨广度</span><b>{sector.breadth == null ? "--" : `${fmt(sector.breadth * 100, 1)}%`}</b><small>{sector.memberCount ?? "--"} 只成分股内部比较</small></div>
                <div><span>成分股平均涨幅</span><b>{sector.memberAverageReturn == null ? "--" : `${sector.memberAverageReturn > 0 ? "+" : ""}${fmt(sector.memberAverageReturn)}%`}</b><small>相对{marketReturnLabel(sector.marketSnapshot)} {sector.relativeReturn == null ? "--" : `${sector.relativeReturn > 0 ? "+" : ""}${fmt(sector.relativeReturn)}%`}</small></div>
                <div><span>涨停扩散</span><b>{sector.limitUps} 家</b><small>占全市场涨停池 {fmt((sector.poolShare || 0) * 100, 1)}%</small></div>
                <div><span>成交热度</span><b>{sector.amountHeat == null ? "--" : `${fmt(sector.amountHeat)}x`}</b><small>板块成交额 / 15日均额</small></div>
                <div><span>五日持续性</span><b>{sector.persistence == null ? "--" : `${fmt(sector.persistence * 100, 0)}%`}</b><small>5日板块指数收涨比率</small></div>
                <div><span>成分平均换手</span><b>{sector.memberAverageTurnover == null ? "--" : `${fmt(sector.memberAverageTurnover)}%`}</b><small>用于识别热度是否过高</small></div>
                <div><span>上涨股成交参与</span><b>{sector.advancingAmountShare == null ? "--" : `${fmt(sector.advancingAmountShare * 100, 1)}%`}</b><small>上涨成分成交额 / 板块总成交额</small></div>
                <div><span>主力净流入广度</span><b>{sector.positiveInflowRatio == null ? "--" : `${fmt(sector.positiveInflowRatio * 100, 1)}%`}</b><small>主力净流入为正的成分占比</small></div>
                <div><span>头部成交集中度</span><b>{sector.top5AmountShare == null ? "--" : `${fmt(sector.top5AmountShare * 100, 1)}%`}</b><small>前5大成交股占比，过高表示少数股独撑</small></div>
                <div><span>成分涨幅中位数</span><b>{sector.medianMemberReturn == null ? "--" : `${sector.medianMemberReturn > 0 ? "+" : ""}${fmt(sector.medianMemberReturn, 2)}%`}</b><small>比平均数更不易被极端龙头扭曲</small></div>
                <div><span>涨跌离散度</span><b>{sector.returnDispersion == null ? "--" : `${fmt(sector.returnDispersion, 2)}%`}</b><small>越低代表板块内部同步性越高</small></div>
                <div><span>内部质量评分</span><b>{fmt(sector.leadershipQualityScore, 0)}</b><small>广度、成交参与、资金、集中度、离散度</small></div>
              </div>
            </div>
            <div className="panel sector-history">
              <PanelTitle title="近5日强弱轨迹" subtitle="上方为每日涨跌，下方为成交量柱" icon={Activity} />
              <div className="bar-chart">
                {sectorHistory.map((day: any) => (
                  <div key={day.date} title={`${day.date} ${day.changePct}%`}>
                    <span className={day.changePct == null ? "" : day.changePct > 0 ? "up" : day.changePct < 0 ? "down" : ""} style={{ height: `${Math.max(6, Math.min(100, Math.abs(day.changePct) * 20))}%` }} />
                  </div>
                ))}
              </div>
              <div className="sector-volume-head">
                <span>成交量能</span>
                <b className={sector.amountHeat == null ? "" : sector.amountHeat >= 1 ? "red" : "green"}>
                  最近 / 5日均量 {sector.amountHeat == null ? "--" : `${fmt(sector.amountHeat)}x`}
                </b>
              </div>
              <div className="sector-volume-chart">
                {sectorHistory.map((day: any) => {
                  const amount = Number(day.amount || 0);
                  const aboveAverage = averageHistoryAmount > 0 && amount >= averageHistoryAmount;
                  return (
                    <div key={day.date} title={`${day.date} · 成交额 ${fmtMoney(amount)}`}>
                      <span
                        className={aboveAverage ? "hot" : "normal"}
                        style={{ height: `${Math.max(5, (amount / maxHistoryAmount) * 100)}%` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="sector-volume-legend">
                <span><i className="hot" />高于15日均量</span>
                <span><i />低于15日均量</span>
              </div>
            </div>
          </div>
        </details>
      )}
    </>
  );
}

export { SectorView };
