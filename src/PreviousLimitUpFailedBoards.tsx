import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiInterpretPanel } from "./features/ai-review/AiInterpretPanel";
import { Activity, ArrowDown, ArrowUp, CircleAlert, LoaderCircle, RefreshCw, Search, Star } from "lucide-react";
import { whenVisible } from "./visiblePolling";
import { fmtMoney, fmtPercent } from "./domain/formatters";
import { formatShanghaiDate, formatShanghaiDateTime, formatShanghaiTime, shanghaiDateTag } from "./dateUtils";

type SortKey = "changePct" | "amount" | "turnover" | "openBoardCount";
type ViewMode = "today" | "five-days" | "previous-intersection";
type DisplayDay = FailedBoardDaySnapshot & { staleReason?: string };
type RefreshTarget = { mode: ViewMode; date: string };
type RefreshNotice = RefreshTarget & { message: string };
export type FailedBoardViewState = {
  mode: ViewMode;
  selectedDate: string;
  query: string;
  excludeOneWord: boolean;
  sort: { key: SortKey; direction: "asc" | "desc" };
};
export type FailedBoardCache = {
  latestResponse: PreviousLimitUpFailedBoardSnapshot | null;
  lastGoodSnapshot: PreviousLimitUpFailedBoardSnapshot | null;
  lastGoodDailyDays: FailedBoardDaySnapshot[];
  failureMessage: string;
  lastAttemptAt: string | null;
};
const defaultViewState: FailedBoardViewState = {
  mode: "today", selectedDate: "", query: "", excludeOneWord: false,
  sort: { key: "changePct", direction: "asc" }
};
const emptyCache: FailedBoardCache = {
  latestResponse: null, lastGoodSnapshot: null, lastGoodDailyDays: [], failureMessage: "", lastAttemptAt: null
};
type Props = {
  live: boolean;
  cache: FailedBoardCache | null;
  viewState?: FailedBoardViewState | undefined;
  onSnapshot: (snapshot: FailedBoardCache) => void;
  onViewStateChange?: ((state: FailedBoardViewState) => void) | undefined;
  onOpen: (security: Security) => void;
  onAdd: (security: Security) => void;
  isFavorite: (code: string) => boolean;
};

const providerLabel = (providers?: string[]) => {
  const labels: Record<string, string> = {
    ths_public_limit_up: "同花顺公开涨停池",
    ths_public_open_limit: "同花顺公开炸板池",
    eastmoney: "东方财富",
    eastmoney_topic_pool: "东方财富专题池",
    preview: "浏览器模拟数据"
  };
  return providers?.length ? providers.map((provider) => labels[provider] || provider).join(" + ") : "来源待确认";
};

export function failedBoardSessionLabel(date: string, fetchedAt: string | null | undefined, now = new Date()) {
  const fetchedDate = formatShanghaiDate(fetchedAt, "");
  if (!fetchedDate || fetchedDate < date) return "快照时点未知";
  if (fetchedDate > date || formatShanghaiTime(fetchedAt) >= "15:05:00") return "收盘未回封";
  return date < shanghaiDateTag(now) || formatShanghaiTime(now) >= "15:05:00" ? "盘中快照" : "盘中暂未回封";
}

const formatNumber = (value: number | null, digits = 2) =>
  value === null ? "--" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);

const formatPrice = (value: number | null) => value === null ? "--" : value.toFixed(2);

/* B-03 / B-04 / B-08：
 *   · 成交额不再自算「一律亿」（原来 12 345 元显示成“0亿”），改用 domain/formatters.fmtMoney，
 *     与涨停池 / 板块 / 多股同列同一套「≥1 万/≥1 亿 + 两位小数」换算；
 *   · 涨跌幅改用 fmtPercent（两位小数 + 显式正负号），与多股同列历史边界一致；
 *   · 时间戳改用 dateUtils 的北京时间格式化，非法值兜底 “--”（不再依赖系统时区）。 */

const getStatusLabel = (snapshot: PreviousLimitUpFailedBoardSnapshot | null, stale: boolean) => {
  if (snapshot?.isPreview) return "模拟数据";
  if (stale) return "旧快照";
  if (snapshot?.status === "awaiting-confirmation") return "等待来源确认";
  if (snapshot?.status === "unavailable") return "数据源不可用";
  if (snapshot?.status !== "ready") return "等待数据";
  return snapshot.currentDate
    ? failedBoardSessionLabel(snapshot.currentDate, snapshot.sources.todayFailed?.fetchedAt)
    : "快照时点未知";
};

const toSecurity = (row: Pick<PreviousLimitUpFailedBoardRow, "code" | "name">): Security => ({
  code: row.code,
  name: row.name,
  secid: `${/^(6|68)/.test(row.code) ? "1" : "0"}.${row.code}`,
  thscode: `${row.code}.${/^(6|68)/.test(row.code) ? "SH" : /^(?:(?:43|83|87|88)\d{4}|920\d{3})$/.test(row.code) ? "BJ" : "SZ"}`,
  marketName: /^(6|68)/.test(row.code) ? "沪A" : /^(?:(?:43|83|87|88)\d{4}|920\d{3})$/.test(row.code) ? "北A" : "深A",
  assetType: "stock"
});

function matchesSearch(row: { name: string; code: string; industry: string }, query: string) {
  return !query || [row.name, row.code, row.industry].some(value => String(value ?? "").toLocaleLowerCase("zh-CN").includes(query));
}

function compareNullableNumbers(a: number | null, b: number | null, direction: "asc" | "desc") {
  if (a === null && b !== null) return 1;
  if (a !== null && b === null) return -1;
  if (a !== null && b !== null && a !== b) return (a - b) * (direction === "asc" ? 1 : -1);
  return 0;
}

function compareRows(left: PreviousLimitUpFailedBoardRow, right: PreviousLimitUpFailedBoardRow, sortKey: SortKey, direction: "asc" | "desc") {
  const primary = compareNullableNumbers(left.today[sortKey], right.today[sortKey], direction);
  if (primary) return primary;
  if (sortKey === "changePct") {
    const amountOrder = compareNullableNumbers(left.today.amount, right.today.amount, "desc");
    if (amountOrder) return amountOrder;
  }
  return left.code.localeCompare(right.code);
}

function compareDailyRows(left: FailedBoardDayRow, right: FailedBoardDayRow, sortKey: SortKey, direction: "asc" | "desc") {
  const primary = compareNullableNumbers(left[sortKey], right[sortKey], direction);
  if (primary) return primary;
  if (sortKey === "changePct") {
    const amountOrder = compareNullableNumbers(left.amount, right.amount, "desc");
    if (amountOrder) return amountOrder;
  }
  return left.code.localeCompare(right.code);
}

const dayStatusLabel = (day: FailedBoardDaySnapshot | null, isPreview: boolean, stale: boolean) => {
  if (!day) return "等待交易日";
  if (isPreview) return "模拟数据";
  if (stale) return "旧快照";
  if (day.status === "unavailable") return "数据源不可用";
  if (day.status === "awaiting-confirmation") return "等待来源确认";
  return failedBoardSessionLabel(day.date, day.source?.fetchedAt);
};

export function selectFailedBoardDay<T extends FailedBoardDaySnapshot>(days: T[], mode: ViewMode, selectedDate = "") {
  if (mode === "today") return days[0] || null;
  return days.find((day) => day.date === selectedDate) || days[0] || null;
}

export function mergeGoodFailedBoardDays(previous: FailedBoardDaySnapshot[], incoming: FailedBoardDaySnapshot[]) {
  const byDate = new Map<string, FailedBoardDaySnapshot>();
  for (const day of previous) {
    if (day.status === "ready") byDate.set(day.date, day);
  }
  for (const day of incoming) {
    if (day.status === "ready") byDate.set(day.date, day);
  }
  return [...byDate.values()].sort((left, right) => right.date.localeCompare(left.date)).slice(0, 5);
}

export function failedBoardDaysForDisplay(
  latestResponse: Pick<PreviousLimitUpFailedBoardSnapshot, "failedBoardDays"> | null,
  lastGoodDays: FailedBoardDaySnapshot[]
): DisplayDay[] {
  const days = latestResponse?.failedBoardDays;
  if (!days?.length) return latestResponse
    ? lastGoodDays.map(day => ({ ...day, staleReason: "来源未返回交易日数据" }))
    : lastGoodDays;
  const lastGoodByDate = new Map(lastGoodDays.map(day => [day.date, day]));
  return days.map(day => {
    const previous = lastGoodByDate.get(day.date);
    return day.status !== "ready" && previous
      ? { ...previous, staleReason: day.error || "该交易日未取得新快照" }
      : day;
  });
}

export function FailedBoardDayTabs({
  days,
  selectedDate,
  onSelect
}: {
  days: DisplayDay[];
  selectedDate: string;
  onSelect: (date: string) => void;
}) {
  return <div className="puf-day-tabs" role="tablist" aria-label="选择炸板交易日">
    {days.map((day) => <button key={day.date} type="button" role="tab" aria-selected={selectedDate === day.date} onClick={() => onSelect(day.date)}>
      <span>{day.date}</span><strong>{day.status === "ready" ? `${day.rows.length} 只${day.staleReason ? " · 旧快照" : ""}` : day.status === "unavailable" ? "不可用" : "待确认"}</strong>
    </button>)}
  </div>;
}

function refreshResultMessage(
  result: PreviousLimitUpFailedBoardSnapshot,
  target: RefreshTarget,
  lastGoodSnapshot: PreviousLimitUpFailedBoardSnapshot | null,
  lastGoodDays: FailedBoardDaySnapshot[]
) {
  const isIntersection = target.mode === "previous-intersection";
  const day = selectFailedBoardDay(result.failedBoardDays || [], target.mode, target.date);
  const matchesRequestedDate = target.mode !== "five-days" || !target.date || target.date === day?.date;
  if (!matchesRequestedDate) return "所选交易日已不在近五日范围内。";
  const date = isIntersection ? result.currentDate : day?.date;
  const status = isIntersection ? result.status : day?.status;
  const label = date ? `${date}：` : "";
  if (status !== "ready") return `${label}${status === "awaiting-confirmation" ? "等待来源确认。" : "刷新未取得可用数据。"}`;
  const previousRows = isIntersection
    ? lastGoodSnapshot?.currentDate === result.currentDate && lastGoodSnapshot?.previousDate === result.previousDate
      ? lastGoodSnapshot?.rows : undefined
    : lastGoodDays.find(item => item.date === date)?.rows;
  const rows = isIntersection ? result.rows : day?.rows || [];
  if (!rows.length) return `${label}刷新完成，无符合记录。`;
  return `${label}刷新完成，${rows.length} 只${JSON.stringify(previousRows) === JSON.stringify(rows) ? "，列表无变化" : ""}。`;
}

/** 交给 AI 解读的炸板数据：最近几天每天的炸板只数、最新一天的炸板明细、昨日涨停今日炸板的交集。 */
function failedBoardsForAi(days: FailedBoardDaySnapshot[], snapshot: PreviousLimitUpFailedBoardSnapshot | null) {
  const latest = days[0]?.status === "ready" ? days[0] : null;
  return {
    recentDays: days.slice(0, 5).map(day => ({ date: day.date, status: day.status, failedCount: day.status === "ready" ? day.rows.length : null })),
    latestDate: latest?.date || "",
    latestFailed: (latest?.rows || []).slice(0, 30).map(row => ({ name: row.name, industry: row.industry, boards: row.consecutiveBoards, openBoards: row.openBoardCount,
      changePct: row.changePct, amountYi: row.amount === null ? null : Number((row.amount / 1e8).toFixed(2)), turnover: row.turnover })),
    previousLimitUpThenFailed: snapshot?.status === "ready" ? { previousDate: snapshot.previousDate, currentDate: snapshot.currentDate,
      rows: snapshot.rows.slice(0, 20).map(row => ({ name: row.name, industry: row.industry, previousBoards: row.previous.consecutiveBoards, todayChangePct: row.today.changePct, todayOpenBoards: row.today.openBoardCount })) } : null
  };
}

export default function PreviousLimitUpFailedBoards({
  live,
  cache,
  viewState,
  onSnapshot,
  onViewStateChange,
  onOpen,
  onAdd,
  isFavorite
}: Props) {
  const [snapshotCache, setSnapshotCache] = useState(cache || emptyCache);
  const { lastGoodSnapshot, latestResponse, lastGoodDailyDays, failureMessage, lastAttemptAt } = snapshotCache;
  const [loading, setLoading] = useState(!cache);
  const [refreshing, setRefreshing] = useState(false);
  const [localView, setLocalView] = useState(viewState || defaultViewState);
  const { mode, query, selectedDate, excludeOneWord, sort } = localView;
  const [refreshNotice, setRefreshNotice] = useState<RefreshNotice | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const onSnapshotRef = useRef(onSnapshot);
  const snapshotCacheRef = useRef(snapshotCache);

  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  }, [onSnapshot]);

  useEffect(() => {
    onViewStateChange?.(localView);
  }, [localView, onViewStateChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const updateCache = useCallback((next: FailedBoardCache) => {
    snapshotCacheRef.current = next;
    setSnapshotCache(next);
    onSnapshotRef.current(next);
  }, []);

  const refresh = useCallback(async (target?: RefreshTarget) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRefreshing(true);
    setRefreshNotice(null);
    try {
      const result = await window.stockApi.getPreviousLimitUpFailedBoardSnapshot({
        forceRefresh: Boolean(target),
        ...(target?.mode === "five-days" && target.date ? { refreshDate: target.date } : {})
      });
      if (!mountedRef.current) return;
      const previous = snapshotCacheRef.current;
      if (target) setRefreshNotice({
        ...target,
        message: refreshResultMessage(result, target, previous.lastGoodSnapshot, previous.lastGoodDailyDays)
      });
      updateCache({
        latestResponse: result,
        lastGoodDailyDays: mergeGoodFailedBoardDays(previous.lastGoodDailyDays, result.failedBoardDays || []),
        lastGoodSnapshot: result.status === "ready" ? result : previous.lastGoodSnapshot,
        failureMessage: result.status === "ready" ? "" :
          result.errors.todayFailed || result.errors.previousLimitUp ||
          (result.status === "awaiting-confirmation" ? "交易日期或来源快照尚未确认" : "来源暂不可用"),
        lastAttemptAt: new Date().toISOString()
      });
    } catch (error) {
      if (!mountedRef.current) return;
      updateCache({
        ...snapshotCacheRef.current,
        latestResponse: null,
        failureMessage: error instanceof Error ? error.message : "炸板数据刷新失败",
        lastAttemptAt: new Date().toISOString()
      });
      if (target) setRefreshNotice({ ...target, message: "刷新失败，请重试。" });
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, [updateCache]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(whenVisible(() => { void refresh(); }), 15_000);
    return () => window.clearInterval(timer);
  }, [live, refresh]);

  const displayedSnapshot = lastGoodSnapshot || latestResponse;
  const stale = Boolean(lastGoodSnapshot && (failureMessage || latestResponse?.status !== "ready"));
  const statusLabel = getStatusLabel(latestResponse || displayedSnapshot, stale);
  const daySnapshots = useMemo(() => failedBoardDaysForDisplay(latestResponse, lastGoodDailyDays), [latestResponse, lastGoodDailyDays]);
  const selectedDay = selectFailedBoardDay(daySnapshots, mode, selectedDate);
  const sourceRows = lastGoodSnapshot?.rows || [];
  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return sourceRows
      .filter((row) => !excludeOneWord || row.previous.isOneWordBoard !== true)
      .filter(row => matchesSearch(row, normalizedQuery))
      .sort((left, right) => compareRows(left, right, sort.key, sort.direction));
  }, [excludeOneWord, query, sort, sourceRows]);
  const dailyRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return (selectedDay?.rows || [])
      .filter(row => matchesSearch(row, normalizedQuery))
      .sort((left, right) => compareDailyRows(left, right, sort.key, sort.direction));
  }, [query, selectedDay, sort]);

  const setSortKey = (key: SortKey) => {
    setLocalView(current => ({
      ...current,
      sort: current.sort.key === key
        ? { key, direction: current.sort.direction === "asc" ? "desc" : "asc" }
        : { key, direction: key === "changePct" ? "asc" : "desc" }
    }));
  };

  const sortHeader = (key: SortKey, label: string) => (
    <button className="puf-sort-button" type="button" onClick={() => setSortKey(key)}>
      {label}
      {sort.key === key ? (sort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />) : <span className="puf-sort-placeholder">↕</span>}
    </button>
  );

  // B-12：可排序表头补 aria-sort（与 LimitUpPool 的 role=grid 写法一致），
  // 读屏用户能听出「当前按哪一列、升序还是降序」。
  const ariaSort = (key: SortKey): "ascending" | "descending" | "none" =>
    sort.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none";

  const statusSnapshot = latestResponse || displayedSnapshot;
  const sourceSnapshot = displayedSnapshot || statusSnapshot;
  const isPreview = Boolean(displayedSnapshot?.isPreview || statusSnapshot?.isPreview);
  const hasConfirmedEmpty = lastGoodSnapshot?.status === "ready" && sourceRows.length === 0;

  const isPreviousMode = mode === "previous-intersection";
  const dailyStaleReason = selectedDay?.staleReason || (selectedDay && !latestResponse ? failureMessage : "");
  const selectedDayStatus = dayStatusLabel(selectedDay, isPreview, Boolean(dailyStaleReason));
  const activeDate = selectedDay?.date || "--";
  const dailyEmpty = selectedDay?.status === "ready" && selectedDay.rows.length === 0;
  const dailySource = selectedDay?.source;

  return (
    <section className="previous-limit-up-failed-page" aria-label="炸板观察">
      <header className="puf-page-header">
        <div>
          <div className="puf-title-row"><Activity size={19} /><h1>{isPreviousMode ? "昨日涨停 · 今日炸板" : mode === "five-days" ? "近五日炸板" : "当日涨停后炸板"}</h1></div>
          <p>{isPreviousMode
            ? "筛选前一交易日涨停、后一交易日来源快照显示封板未遂的股票。"
            : mode === "five-days"
              ? "近五个交易日独立展示，点击日期切换。"
              : "查看最新交易日的炸板池，不要求股票昨日也涨停。"}</p>
        </div>
        <button className="secondary-btn puf-refresh-button" type="button" onClick={() => void refresh({ mode, date: mode === "five-days" ? selectedDay?.date || "" : "" })} disabled={refreshing}>
          {refreshing ? <LoaderCircle size={15} className="trend-spin" /> : <RefreshCw size={15} />}
          {refreshing ? "刷新中" : "刷新"}
        </button>
      </header>

      <div className="puf-view-tabs" role="tablist" aria-label="炸板数据视图">
        <button type="button" role="tab" aria-selected={mode === "today"} onClick={() => setLocalView(current => ({ ...current, mode: "today" }))}>当日炸板</button>
        <button type="button" role="tab" aria-selected={mode === "five-days"} onClick={() => setLocalView(current => ({ ...current, mode: "five-days" }))}>近五日炸板</button>
        <button type="button" role="tab" aria-selected={isPreviousMode} onClick={() => setLocalView(current => ({ ...current, mode: "previous-intersection" }))}>昨日涨停今炸板</button>
      </div>

      {refreshNotice?.mode === mode && (!refreshNotice.date || refreshNotice.date === selectedDay?.date) &&
        <div className="puf-refresh-notice" role="status">{refreshNotice.message}</div>}
      <AiInterpretPanel
        kind="failed-boards"
        asOfDate={latestResponse?.failedBoardDays?.[0]?.date || latestResponse?.currentDate || undefined}
        disabled={!latestResponse?.failedBoardDays?.some(day => day.status === "ready") && latestResponse?.status !== "ready"}
        getData={() => failedBoardsForAi(latestResponse?.failedBoardDays || [], latestResponse)}
      />
      {isPreview && <div className="puf-preview-banner" role="status">{displayedSnapshot?.previewLabel || "浏览器预览 · 模拟行情"}，不代表实时行情。</div>}
      {isPreviousMode && failureMessage && <div className={`puf-source-banner ${stale ? "is-stale" : "is-error"}`} role={stale ? "status" : "alert"}>
        <CircleAlert size={15} /><span>{stale ? `来源未确认：${failureMessage}。当前保留的是旧快照。` : failureMessage}</span>
      </div>}
      {!isPreviousMode && dailyStaleReason && <div className="puf-source-banner is-stale" role="status">
        <CircleAlert size={15} /><span>{activeDate} 未取得新快照，保留该日上次成功的数据。{dailyStaleReason}</span>
      </div>}

      {isPreviousMode ? (
        <>
          <section className="puf-summary-grid" aria-label="交集数据摘要">
            <div><span>交易日</span><strong>{displayedSnapshot?.previousDate || "--"} → {displayedSnapshot?.currentDate || "--"}</strong><small>T-1 涨停 / T 炸板</small></div>
            <div><span>命中股票</span><strong>{lastGoodSnapshot ? lastGoodSnapshot.rows.length : "--"}</strong><small>搜索前总数</small></div>
            <div><span>筛选状态</span><strong className={stale ? "puf-muted-value" : ""}>{statusLabel}</strong><small>{latestResponse?.status === "awaiting-confirmation" ? "等待交易日确认" : "按来源当前快照"}</small></div>
            <div><span>最近检查</span><strong>{formatShanghaiDateTime(lastAttemptAt || statusSnapshot?.checkedAt)}</strong><small>{live ? "实时刷新开启" : "实时刷新已暂停"}</small></div>
          </section>
          <details className="puf-method-disclosure">
            <summary>筛选口径与数据来源</summary>
            <div>
              <p>候选为 T-1 涨停专题池与 T 日“封板未遂/炸板池”的代码交集。涨停按来源专题分类；不使用固定涨幅阈值。名称含 ST 或“退”的证券排除，昨日一字板默认纳入。</p>
              <p>按数据源设置使用同花顺或东方财富（<code>getTopicZBPool</code>）。开板次数可由扶摇同日炸板池补充。</p>
              <p>默认按 T 日涨跌幅升序、成交额降序、代码升序；可按涨跌幅、成交额、换手率和 T 日开板次数排序，缺失值排在最后。搜索匹配名称、代码和行业。</p>
              <p>应用每 15 秒请求一次（仅页面可见、模块打开且实时刷新开启时）；这不代表数据提供方每次请求都生成了新行情。</p>
            </div>
          </details>
          <div className="puf-source-strip" aria-label="交集数据源状态">
            <span>T-1 涨停：{providerLabel(sourceSnapshot?.sources.previousLimitUp?.providers)}</span>
            <span>T 日炸板：{providerLabel(sourceSnapshot?.sources.todayFailed?.providers)}</span>
            <span>来源日期：{sourceSnapshot?.sources.todayFailed?.sourceTradingDate || "待确认"}</span>
            <span>检查时间为本地抓取时间</span>
          </div>
          <div className="puf-toolbar">
            <label className="puf-search"><Search size={15} /><input value={query} onChange={(event) => setLocalView(current => ({ ...current, query: event.target.value }))} placeholder="搜索名称、代码或行业" aria-label="搜索名称、代码或行业" /></label>
            <label className="puf-one-word-toggle"><input type="checkbox" checked={excludeOneWord} onChange={(event) => setLocalView(current => ({ ...current, excludeOneWord: event.target.checked }))} />排除已识别一字板</label>
            <span className="puf-visible-count">{lastGoodSnapshot ? `显示 ${filteredRows.length} / ${sourceRows.length}` : "交集未确认"}</span>
          </div>
          {loading && !displayedSnapshot && <div className="puf-state-card"><LoaderCircle size={18} className="trend-spin" />正在读取来源数据…</div>}
          {!loading && !displayedSnapshot && <div className="puf-state-card is-error"><CircleAlert size={18} />{failureMessage || "暂时没有可用数据"}</div>}
          {hasConfirmedEmpty && <div className="puf-state-card"><Activity size={18} />{stale ? "旧快照：该交易日组合当时无符合记录。" : "该交易日组合无符合记录。"}</div>}
          {lastGoodSnapshot && sourceRows.length > 0 && filteredRows.length === 0 && <div className="puf-state-card">当前搜索或筛选条件没有符合记录。</div>}
          {filteredRows.length > 0 && <div className="puf-table-scroll" role="region" tabIndex={0} aria-label="炸板股票数据，可横向滚动">
            <table className="puf-table"><thead><tr>
              <th scope="col">股票 / 行业</th><th scope="col">T-1 连板</th><th scope="col">T-1 首封 / 末封</th><th scope="col">T-1 开板</th><th scope="col">一字板</th><th scope="col">T 日状态</th><th scope="col">T 首封 / 末封</th><th scope="col" aria-sort={ariaSort("openBoardCount")}>{sortHeader("openBoardCount", "T 开板")}</th><th scope="col">最新价</th><th scope="col" aria-sort={ariaSort("changePct")}>{sortHeader("changePct", "涨跌幅")}</th><th scope="col" aria-sort={ariaSort("amount")}>{sortHeader("amount", "成交额")}</th><th scope="col" aria-sort={ariaSort("turnover")}>{sortHeader("turnover", "换手率")}</th><th scope="col">操作</th>
            </tr></thead><tbody>{filteredRows.map((row) => {
              const favorite = isFavorite(row.code);
              const security = toSecurity(row);
              const changeClass = row.today.changePct === null ? "" : row.today.changePct > 0 ? "is-up" : row.today.changePct < 0 ? "is-down" : "";
              const rowStatus = isPreview ? "盘中未回封（模拟）" : stale ? "旧快照" : statusLabel;
              return <tr key={row.code}>
                <td className="puf-stock-cell"><strong>{row.name}</strong><code>{row.code}</code><small>{row.industry || "未分类"}</small></td>
                <td>{row.previous.consecutiveBoards === null ? "--" : `${row.previous.consecutiveBoards}板`}</td><td className="puf-seal-times"><span>{row.previous.firstSealTime || "--"}</span><small>{row.previous.lastSealTime || "--"}</small></td><td>{row.previous.openBoardCount === null ? "--" : `${row.previous.openBoardCount}次`}</td><td>{row.previous.isOneWordBoard === null ? "未识别" : row.previous.isOneWordBoard ? "是" : "否"}</td>
                <td><span className={`puf-status-pill ${rowStatus === "收盘未回封" ? "is-close" : ""}`}>{rowStatus}</span></td><td className="puf-seal-times"><span>{row.today.firstSealTime || "--"}</span><small>{row.today.lastSealTime || "--"}</small></td><td>{row.today.openBoardCount === null ? "--" : `${row.today.openBoardCount}次`}</td><td>{formatPrice(row.today.latest)}</td><td className={changeClass}>{fmtPercent(row.today.changePct)}</td><td>{fmtMoney(row.today.amount)}</td><td>{row.today.turnover === null ? "--" : `${formatNumber(row.today.turnover)}%`}</td>
                <td><div className="puf-row-actions"><button type="button" className="puf-action-button" onClick={() => onOpen(security)}>分析</button><button type="button" className="puf-action-button" onClick={() => onAdd(security)} disabled={favorite} aria-label={favorite ? `${row.name}已加入自选` : `将${row.name}加入自选`}><Star size={13} />{favorite ? "已自选" : "加入自选"}</button></div></td>
              </tr>;
            })}</tbody></table>
          </div>}
          <footer className="puf-page-footer"><span>本地检查时间：{formatShanghaiDateTime(lastAttemptAt || statusSnapshot?.checkedAt)}</span><span>数据源抓取：{formatShanghaiDateTime(sourceSnapshot?.sources.todayFailed?.fetchedAt)}</span><span>{refreshing ? "正在刷新" : "来源快照以页面标注日期为准"}</span></footer>
        </>
      ) : (
        <>
          <section className="puf-summary-grid" aria-label="单日炸板摘要">
            <div><span>展示日期</span><strong>{activeDate}</strong><small>{mode === "five-days" ? "所选交易日" : activeDate === shanghaiDateTag() ? "北京时间今日" : "最新交易日"}</small></div>
            <div><span>炸板数量</span><strong>{selectedDay?.status === "ready" ? selectedDay.rows.length : "--"}</strong><small>仅当前所选日期</small></div>
            <div><span>数据状态</span><strong className={selectedDay?.status === "ready" && !dailyStaleReason ? "" : "puf-muted-value"}>{selectedDayStatus}</strong><small>{selectedDay?.status === "ready" ? "来源快照分类" : selectedDay?.error || "等待交易日与来源确认"}</small></div>
            <div><span>来源抓取</span><strong>{formatShanghaiDateTime(dailySource?.fetchedAt)}</strong><small>本地抓取时间</small></div>
          </section>
          <details className="puf-method-disclosure">
            <summary>筛选口径、数据来源与刷新规则</summary>
            <div>
              <p>炸板采用同花顺公开炸板池或东方财富专题池（getTopicZBPool）的分类，不用涨幅或最高价推断。当前源池全量展示，不与昨日涨停池求交。</p>
              <p>涨停判定属于来源专题分类；炸板池按 <code>date=YYYYMMDD</code> 回查，交易日历取同花顺全 A 日线，东方财富沪深 300 日线备用，优先展示已确认的当日交易日。历史响应的 qdate 是来源最新数据日期，可能晚于所查日期；列表按请求日期独立保存，要求来源日期不早于请求日期。名称含 ST 或“退”的证券排除，一字板不剔除。</p>
              <p>表格展示代码、名称、行业、连板数、首末封时间、开板次数、最新价、涨跌幅、成交额和换手率；来源没有的字段显示“--”，不会按 0 排序。默认涨跌幅升序、成交额降序、代码升序；可点击开板次数等列名排序。</p>
              <p>开启实时刷新时，每 15 秒在页面可见且模块活动时刷新；手动刷新强制请求正在看的交易日。开板次数可由扶摇补充；抓取时间与源最新日期分开标注。</p>
            </div>
          </details>
          <div className="puf-source-strip" aria-label="单日炸板来源">
            <span>数据源：{providerLabel(dailySource?.providers)}</span><span>请求日期：{dailySource?.requestedDate || activeDate}</span><span>来源最新日期：{dailySource?.sourceLatestDate || "待确认"}</span><span>本地抓取：{formatShanghaiDateTime(dailySource?.fetchedAt)}</span>
          </div>
          {mode === "five-days" && <FailedBoardDayTabs days={daySnapshots} selectedDate={selectedDay?.date || ""} onSelect={date => setLocalView(current => ({ ...current, selectedDate: date }))} />}
          <div className="puf-toolbar">
            <label className="puf-search"><Search size={15} /><input value={query} onChange={(event) => setLocalView(current => ({ ...current, query: event.target.value }))} placeholder="搜索名称、代码或行业" aria-label="搜索名称、代码或行业" /></label>
            <span className="puf-visible-count">{selectedDay?.status === "ready" ? `显示 ${dailyRows.length} / ${selectedDay.rows.length}` : "数量未确认"}</span>
          </div>
          {loading && !selectedDay && <div className="puf-state-card"><LoaderCircle size={18} className="trend-spin" />正在读取来源数据…</div>}
          {!loading && !selectedDay && <div className="puf-state-card is-error"><CircleAlert size={18} />{failureMessage || "没有已确认的交易日数据"}</div>}
          {selectedDay?.status === "unavailable" && <div className="puf-state-card is-error"><CircleAlert size={18} />{selectedDay.error || "该交易日数据源不可用；其他日期仍可单独查看。"}</div>}
          {selectedDay?.status === "awaiting-confirmation" && <div className="puf-state-card"><Activity size={18} />{selectedDay.error || "该交易日尚未获得来源确认。"}</div>}
          {dailyEmpty && <div className="puf-state-card"><Activity size={18} />{dailyStaleReason ? "该日上次成功的快照无炸板记录。" : "该交易日炸板池无记录。"}</div>}
          {selectedDay?.status === "ready" && selectedDay.rows.length > 0 && dailyRows.length === 0 && <div className="puf-state-card">当前搜索条件没有符合记录。</div>}
          {dailyRows.length > 0 && <div className="puf-table-scroll" role="region" tabIndex={0} aria-label="炸板股票数据，可横向滚动">
            <table className="puf-table puf-daily-table"><thead><tr>
              <th scope="col">股票 / 行业</th><th scope="col">连板</th><th scope="col">首封</th><th scope="col">末封</th><th scope="col" aria-sort={ariaSort("openBoardCount")}>{sortHeader("openBoardCount", "开板次数")}</th><th scope="col">数据状态</th><th scope="col">最新价</th><th scope="col" aria-sort={ariaSort("changePct")}>{sortHeader("changePct", "涨跌幅")}</th><th scope="col" aria-sort={ariaSort("amount")}>{sortHeader("amount", "成交额")}</th><th scope="col" aria-sort={ariaSort("turnover")}>{sortHeader("turnover", "换手率")}</th><th scope="col">操作</th>
            </tr></thead><tbody>{dailyRows.map((row) => {
              const favorite = isFavorite(row.code);
              const security = toSecurity(row);
              const changeClass = row.changePct === null ? "" : row.changePct > 0 ? "is-up" : row.changePct < 0 ? "is-down" : "";
              return <tr key={row.code}>
                <td className="puf-stock-cell"><strong>{row.name}</strong><code>{row.code}</code><small>{row.industry || "未分类"}</small></td><td>{row.consecutiveBoards === null ? "--" : `${row.consecutiveBoards}板`}</td><td>{row.firstSealTime || "--"}</td><td>{row.lastSealTime || "--"}</td><td>{row.openBoardCount === null ? "--" : `${row.openBoardCount}次`}</td><td><span className={`puf-status-pill ${selectedDayStatus === "收盘未回封" ? "is-close" : ""}`}>{selectedDayStatus}</span></td><td>{formatPrice(row.latest)}</td><td className={changeClass}>{fmtPercent(row.changePct)}</td><td>{fmtMoney(row.amount)}</td><td>{row.turnover === null ? "--" : `${formatNumber(row.turnover)}%`}</td>
                <td><div className="puf-row-actions"><button type="button" className="puf-action-button" onClick={() => onOpen(security)}>分析</button><button type="button" className="puf-action-button" onClick={() => onAdd(security)} disabled={favorite} aria-label={favorite ? `${row.name}已加入自选` : `将${row.name}加入自选`}><Star size={13} />{favorite ? "已自选" : "加入自选"}</button></div></td>
              </tr>;
            })}</tbody></table>
          </div>}
          <footer className="puf-page-footer"><span>交易日期：{activeDate}</span><span>源最新日期：{dailySource?.sourceLatestDate || "--"}</span><span>最近本地检查：{formatShanghaiDateTime(lastAttemptAt || statusSnapshot?.checkedAt)}</span><span>{refreshing ? "正在刷新" : live ? "可见时每 15 秒刷新" : "实时刷新已暂停"}</span></footer>
        </>
      )}
    </section>
  );
}
