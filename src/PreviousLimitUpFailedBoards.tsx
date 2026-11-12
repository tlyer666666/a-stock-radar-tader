import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiInterpretPanel } from "./features/ai-review/AiInterpretPanel";
import { Activity, ArrowDown, ArrowUp, CircleAlert, LoaderCircle, RefreshCw, Search, Star } from "lucide-react";
import { whenVisible } from "./visiblePolling";
import { fmtMoney, fmtPercent } from "./domain/formatters";
import { formatShanghaiDateTime, shanghaiDateTag } from "./dateUtils";

type SortKey = "changePct" | "amount" | "turnover";
type ViewMode = "today" | "five-days" | "previous-intersection";
type Props = {
  live: boolean;
  cachedSnapshot: PreviousLimitUpFailedBoardSnapshot | null;
  onSnapshot: (snapshot: PreviousLimitUpFailedBoardSnapshot) => void;
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

const clockMinutes = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  return hour * 60 + minute;
};

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
  const confirmedDate = snapshot.sources.todayFailed?.sourceTradingDate === snapshot.currentDate;
  const sessionHasClosed = Boolean(snapshot.currentDate && snapshot.currentDate < shanghaiDateTag()) || clockMinutes() >= 15 * 60 + 5;
  return sessionHasClosed && confirmedDate ? "收盘未回封" : "盘中暂未回封";
};

const toSecurity = (row: Pick<PreviousLimitUpFailedBoardRow, "code" | "name">): Security => ({
  code: row.code,
  name: row.name,
  secid: `${/^(6|68)/.test(row.code) ? "1" : "0"}.${row.code}`,
  thscode: `${row.code}.${/^(6|68)/.test(row.code) ? "SH" : /^(?:(?:43|83|87|88)\d{4}|920\d{3})$/.test(row.code) ? "BJ" : "SZ"}`,
  marketName: /^(6|68)/.test(row.code) ? "沪A" : /^(?:(?:43|83|87|88)\d{4}|920\d{3})$/.test(row.code) ? "北A" : "深A",
  assetType: "stock"
});

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
  const confirmed = Boolean(day.source?.sourceLatestDate && day.source.sourceLatestDate >= day.date);
  const closed = day.date < shanghaiDateTag() || clockMinutes() >= 15 * 60 + 5;
  return closed && confirmed ? "收盘未回封" : "盘中暂未回封";
};

export function selectFailedBoardDay(days: FailedBoardDaySnapshot[], mode: ViewMode, selectedDate = "") {
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
) {
  return latestResponse?.failedBoardDays?.length ? latestResponse.failedBoardDays : lastGoodDays;
}

export function FailedBoardDayTabs({
  days,
  selectedDate,
  onSelect
}: {
  days: FailedBoardDaySnapshot[];
  selectedDate: string;
  onSelect: (date: string) => void;
}) {
  return <div className="puf-day-tabs" role="tablist" aria-label="选择炸板交易日">
    {days.map((day) => <button key={day.date} type="button" role="tab" aria-selected={selectedDate === day.date} onClick={() => onSelect(day.date)}>
      <span>{day.date}</span><strong>{day.status === "ready" ? `${day.rows.length} 只` : day.status === "unavailable" ? "不可用" : "待确认"}</strong>
    </button>)}
  </div>;
}

const sameSnapshotRows = (
  left: PreviousLimitUpFailedBoardSnapshot | null,
  right: PreviousLimitUpFailedBoardSnapshot
) => Boolean(left && left.previousDate === right.previousDate && left.currentDate === right.currentDate &&
  JSON.stringify(left.rows) === JSON.stringify(right.rows));

/** 交给 AI 解读的炸板数据：最近几天每天的炸板只数、最新一天的炸板明细、昨日涨停今日炸板的交集。 */
function failedBoardsForAi(days: FailedBoardDaySnapshot[], snapshot: PreviousLimitUpFailedBoardSnapshot | null) {
  const ready = days.filter(day => day.status === "ready");
  const latest = ready[0];
  return {
    recentDays: ready.slice(0, 5).map(day => ({ date: day.date, failedCount: day.rows.length })),
    latestDate: latest?.date || "",
    latestFailed: (latest?.rows || []).slice(0, 30).map(row => ({ name: row.name, industry: row.industry, boards: row.consecutiveBoards, openBoards: row.openBoardCount,
      changePct: row.changePct, amountYi: row.amount === null ? null : Number((row.amount / 1e8).toFixed(2)), turnover: row.turnover })),
    previousLimitUpThenFailed: snapshot?.status === "ready" ? { previousDate: snapshot.previousDate, currentDate: snapshot.currentDate,
      rows: snapshot.rows.slice(0, 20).map(row => ({ name: row.name, industry: row.industry, previousBoards: row.previous.consecutiveBoards, todayChangePct: row.today.changePct, todayOpenBoards: row.today.openBoardCount })) } : null
  };
}

export default function PreviousLimitUpFailedBoards({
  live,
  cachedSnapshot,
  onSnapshot,
  onOpen,
  onAdd,
  isFavorite
}: Props) {
  const [lastGoodSnapshot, setLastGoodSnapshot] = useState<PreviousLimitUpFailedBoardSnapshot | null>(cachedSnapshot);
  const [latestResponse, setLatestResponse] = useState<PreviousLimitUpFailedBoardSnapshot | null>(cachedSnapshot);
  const [lastGoodDailyDays, setLastGoodDailyDays] = useState<FailedBoardDaySnapshot[]>(() =>
    mergeGoodFailedBoardDays([], cachedSnapshot?.failedBoardDays || [])
  );
  const [failureMessage, setFailureMessage] = useState("");
  const [loading, setLoading] = useState(!cachedSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ViewMode>("today");
  const [selectedDate, setSelectedDate] = useState("");
  const [excludeOneWord, setExcludeOneWord] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "changePct", direction: "asc" });
  const [refreshNotice, setRefreshNotice] = useState("");
  const [lastAttemptAt, setLastAttemptAt] = useState<string | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const onSnapshotRef = useRef(onSnapshot);
  const lastGoodSnapshotRef = useRef(cachedSnapshot);
  const lastGoodDailyDaysRef = useRef(lastGoodDailyDays);

  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  }, [onSnapshot]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (cachedSnapshot?.status !== "ready") return;
    lastGoodSnapshotRef.current = cachedSnapshot;
    setLastGoodSnapshot(cachedSnapshot);
    setLatestResponse(cachedSnapshot);
  }, [cachedSnapshot]);

  useEffect(() => {
    if (!cachedSnapshot?.failedBoardDays?.length) return;
    const days = mergeGoodFailedBoardDays(lastGoodDailyDaysRef.current, cachedSnapshot.failedBoardDays);
    lastGoodDailyDaysRef.current = days;
    setLastGoodDailyDays(days);
  }, [cachedSnapshot]);

  const refresh = useCallback(async (forceRefresh = false) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setRefreshing(true);
    if (forceRefresh) setRefreshNotice("");
    try {
      const result = await window.stockApi.getPreviousLimitUpFailedBoardSnapshot({ forceRefresh });
      if (!mountedRef.current) return;
      setLatestResponse(result);
      const goodDays = mergeGoodFailedBoardDays(
        lastGoodDailyDaysRef.current,
        result.failedBoardDays || []
      );
      lastGoodDailyDaysRef.current = goodDays;
      setLastGoodDailyDays(goodDays);
      if (result.status === "ready") {
        const changed = !sameSnapshotRows(lastGoodSnapshotRef.current, result);
        lastGoodSnapshotRef.current = result;
        setLastGoodSnapshot(result);
        setFailureMessage("");
        setRefreshNotice(forceRefresh ? (changed ? "刷新完成，数据已更新。" : "刷新完成，来源快照无变化。") : "");
        onSnapshotRef.current(result);
      } else {
        const message =
          result.errors.todayFailed || result.errors.previousLimitUp ||
          (result.status === "awaiting-confirmation" ? "交易日期或来源快照尚未确认" : "来源暂不可用");
        setFailureMessage(message);
        if (forceRefresh) {
          setRefreshNotice(result.status === "awaiting-confirmation" ? "刷新完成，等待来源确认。" : "刷新失败，来源暂不可用。");
        }
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setLatestResponse(null);
      setFailureMessage(error instanceof Error ? error.message : "炸板数据刷新失败");
      if (forceRefresh) setRefreshNotice("刷新失败，请检查数据源后重试。");
    } finally {
      busyRef.current = false;
      if (mountedRef.current) {
        setLastAttemptAt(new Date().toISOString());
        setRefreshing(false);
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(whenVisible(() => { void refresh(false); }), 15_000);
    return () => window.clearInterval(timer);
  }, [live, refresh]);

  const displayedSnapshot = lastGoodSnapshot || latestResponse;
  const stale = Boolean(lastGoodSnapshot && (failureMessage || latestResponse?.status !== "ready"));
  const statusLabel = getStatusLabel(latestResponse || displayedSnapshot, stale);
  const daySnapshots = failedBoardDaysForDisplay(latestResponse, lastGoodDailyDays);
  const selectedDay = selectFailedBoardDay(daySnapshots, mode, selectedDate);
  const sourceRows = lastGoodSnapshot?.rows || [];
  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return sourceRows
      .filter((row) => !excludeOneWord || row.previous.isOneWordBoard !== true)
      .filter((row) => !normalizedQuery || [row.name, row.code, row.industry].some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(normalizedQuery)))
      .sort((left, right) => compareRows(left, right, sort.key, sort.direction));
  }, [excludeOneWord, query, sort, sourceRows]);
  const dailyRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return (selectedDay?.rows || [])
      .filter((row) => !normalizedQuery || [row.name, row.code, row.industry].some((value) => String(value ?? "").toLocaleLowerCase("zh-CN").includes(normalizedQuery)))
      .sort((left, right) => compareDailyRows(left, right, sort.key, sort.direction));
  }, [query, selectedDay, sort]);

  const setSortKey = (key: SortKey) => {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "changePct" ? "asc" : "desc" });
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
  const dailyStale = Boolean(failureMessage && !latestResponse && lastGoodDailyDays.length);
  const selectedDayStatus = dayStatusLabel(selectedDay, isPreview, dailyStale);
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
              ? "按交易日分别查看东方财富炸板池；每次只显示所选日期的独立列表。"
              : "展示最新确认交易日的完整炸板池，不要求股票昨日也涨停。"}</p>
        </div>
        <button className="secondary-btn puf-refresh-button" type="button" onClick={() => void refresh(true)} disabled={refreshing}>
          {refreshing ? <LoaderCircle size={15} className="trend-spin" /> : <RefreshCw size={15} />}
          {refreshing ? "刷新中" : "刷新"}
        </button>
      </header>

      <div className="puf-view-tabs" role="tablist" aria-label="炸板数据视图">
        <button type="button" role="tab" aria-selected={mode === "today"} onClick={() => setMode("today")}>当日炸板</button>
        <button type="button" role="tab" aria-selected={mode === "five-days"} onClick={() => setMode("five-days")}>近五日炸板</button>
        <button type="button" role="tab" aria-selected={isPreviousMode} onClick={() => setMode("previous-intersection")}>昨日涨停今炸板</button>
      </div>

      {refreshNotice && <div className="puf-refresh-notice" role="status">{refreshNotice}</div>}
      <AiInterpretPanel kind="failed-boards" asOfDate={lastGoodDailyDays[0]?.date || lastGoodSnapshot?.currentDate || undefined} getData={() => failedBoardsForAi(lastGoodDailyDays, lastGoodSnapshot)} />
      {isPreview && <div className="puf-preview-banner" role="status">{displayedSnapshot?.previewLabel || "浏览器预览 · 模拟行情"}，不代表实时行情。</div>}
      {isPreviousMode && failureMessage && <div className={`puf-source-banner ${stale ? "is-stale" : "is-error"}`} role={stale ? "status" : "alert"}>
        <CircleAlert size={15} /><span>{stale ? `来源未确认：${failureMessage}。当前保留的是旧快照。` : failureMessage}</span>
      </div>}
      {!isPreviousMode && dailyStale && failureMessage && <div className="puf-source-banner is-stale" role="status">
        <CircleAlert size={15} /><span>来源请求失败：{failureMessage}。当前显示上次成功的日快照。</span>
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
              <p>候选为 T-1 涨停专题池与 T 日东方财富“封板未遂/炸板池”的代码交集。涨停按来源专题分类；不使用固定涨幅阈值。名称含 ST 或“退”的证券排除，昨日一字板默认纳入。</p>
              <p>东方财富：<code>getTopicZBPool</code>；T-1 涨停池按数据源设置使用东方财富或同花顺，并遵循已启用的回退/多源核对设置。</p>
              <p>默认按 T 日涨跌幅升序、成交额降序、代码升序；点击涨跌幅、成交额或换手率列可切换排序方向。搜索匹配名称、代码和行业。</p>
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
            <label className="puf-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、代码或行业" aria-label="搜索名称、代码或行业" /></label>
            <label className="puf-one-word-toggle"><input type="checkbox" checked={excludeOneWord} onChange={(event) => setExcludeOneWord(event.target.checked)} />排除已识别一字板</label>
            <span className="puf-visible-count">显示 {filteredRows.length} / {sourceRows.length}</span>
          </div>
          {loading && !displayedSnapshot && <div className="puf-state-card"><LoaderCircle size={18} className="trend-spin" />正在读取来源数据…</div>}
          {!loading && !displayedSnapshot && <div className="puf-state-card is-error"><CircleAlert size={18} />{failureMessage || "暂时没有可用数据"}</div>}
          {hasConfirmedEmpty && <div className="puf-state-card"><Activity size={18} />{stale ? "旧快照：该交易日组合当时无符合记录。" : "该交易日组合无符合记录。"}</div>}
          {lastGoodSnapshot && sourceRows.length > 0 && filteredRows.length === 0 && <div className="puf-state-card">当前搜索或筛选条件没有符合记录。</div>}
          {filteredRows.length > 0 && <div className="puf-table-scroll" role="region" tabIndex={0} aria-label="炸板股票数据，可横向滚动">
            <table className="puf-table"><thead><tr>
              <th scope="col">股票 / 行业</th><th scope="col">T-1 连板</th><th scope="col">T-1 首封 / 末封</th><th scope="col">T-1 开板</th><th scope="col">一字板</th><th scope="col">T 日状态</th><th scope="col">T 首封 / 末封</th><th scope="col">T 开板</th><th scope="col">最新价</th><th scope="col" aria-sort={ariaSort("changePct")}>{sortHeader("changePct", "涨跌幅")}</th><th scope="col" aria-sort={ariaSort("amount")}>{sortHeader("amount", "成交额")}</th><th scope="col" aria-sort={ariaSort("turnover")}>{sortHeader("turnover", "换手率")}</th><th scope="col">操作</th>
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
            <div><span>展示日期</span><strong>{activeDate}</strong><small>{mode === "five-days" ? "所选历史交易日" : activeDate === shanghaiDateTag() ? "来源确认的当日交易数据" : "最新已确认交易日"}</small></div>
            <div><span>炸板数量</span><strong>{selectedDay?.status === "ready" ? selectedDay.rows.length : "--"}</strong><small>仅当前所选日期</small></div>
            <div><span>数据状态</span><strong className={selectedDay?.status === "ready" && !dailyStale ? "" : "puf-muted-value"}>{selectedDayStatus}</strong><small>{selectedDay?.status === "ready" ? "来源快照分类" : selectedDay?.error || "等待交易日与来源确认"}</small></div>
            <div><span>来源抓取</span><strong>{formatShanghaiDateTime(dailySource?.fetchedAt)}</strong><small>本地抓取时间</small></div>
          </section>
          <details className="puf-method-disclosure">
            <summary>筛选口径、数据来源与刷新规则</summary>
            <div>
              <p>炸板定义采用东方财富“封板未遂/炸板池”来源分类（getTopicZBPool）；不以收盘涨跌幅阈值、盘中最高价或近似分时数据自行推断。当前源池全量展示，不与昨日涨停池求交。</p>
              <p>涨停判定属于来源专题分类；炸板池按 <code>date=YYYYMMDD</code> 回查，交易日期取项目沪深300日线交易日历并优先使用已确认的当日交易日。历史响应的 qdate 是来源最新数据日期，可能晚于所查日期；列表按请求日期独立保存，要求来源日期不早于请求日期。名称含 ST 或“退”的证券排除，一字板不剔除。</p>
              <p>表格展示代码、名称、行业、连板数、首末封时间、开板次数、最新价、涨跌幅、成交额和换手率；来源没有的字段显示“--”。默认涨跌幅升序、成交额降序、代码升序，可点列名切换；搜索只作用于当前日期。</p>
              <p>开启实时刷新时，每 15 秒在页面可见且模块活动时刷新；手动刷新强制请求最新日期。历史日按来源缓存；抓取时间与源最新日期分开标注。该公开网页专题池不等同交易所逐笔数据或授权实时行情。</p>
            </div>
          </details>
          <div className="puf-source-strip" aria-label="单日炸板来源">
            <span>数据源：{providerLabel(dailySource?.providers)}</span><span>请求日期：{dailySource?.requestedDate || activeDate}</span><span>来源最新日期：{dailySource?.sourceLatestDate || "待确认"}</span><span>本地抓取：{formatShanghaiDateTime(dailySource?.fetchedAt)}</span>
          </div>
          {mode === "five-days" && <FailedBoardDayTabs days={daySnapshots} selectedDate={selectedDay?.date || ""} onSelect={setSelectedDate} />}
          <div className="puf-toolbar">
            <label className="puf-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、代码或行业" aria-label="搜索名称、代码或行业" /></label>
            <span className="puf-visible-count">显示 {dailyRows.length} / {selectedDay?.status === "ready" ? selectedDay.rows.length : 0}</span>
          </div>
          {loading && !displayedSnapshot && <div className="puf-state-card"><LoaderCircle size={18} className="trend-spin" />正在读取来源数据…</div>}
          {!loading && !selectedDay && <div className="puf-state-card is-error"><CircleAlert size={18} />{failureMessage || "没有已确认的交易日数据"}</div>}
          {selectedDay?.status === "unavailable" && <div className="puf-state-card is-error"><CircleAlert size={18} />{selectedDay.error || "该交易日数据源不可用；其他日期仍可单独查看。"}</div>}
          {selectedDay?.status === "awaiting-confirmation" && <div className="puf-state-card"><Activity size={18} />{selectedDay.error || "该交易日尚未获得来源确认。"}</div>}
          {dailyEmpty && <div className="puf-state-card"><Activity size={18} />该交易日炸板池为空；这是已确认的空数据，不代表抓取失败。</div>}
          {selectedDay?.status === "ready" && selectedDay.rows.length > 0 && dailyRows.length === 0 && <div className="puf-state-card">当前搜索条件没有符合记录。</div>}
          {dailyRows.length > 0 && <div className="puf-table-scroll" role="region" tabIndex={0} aria-label="炸板股票数据，可横向滚动">
            <table className="puf-table puf-daily-table"><thead><tr>
              <th scope="col">股票 / 行业</th><th scope="col">连板</th><th scope="col">首封</th><th scope="col">末封</th><th scope="col">开板次数</th><th scope="col">数据状态</th><th scope="col">最新价</th><th scope="col" aria-sort={ariaSort("changePct")}>{sortHeader("changePct", "涨跌幅")}</th><th scope="col" aria-sort={ariaSort("amount")}>{sortHeader("amount", "成交额")}</th><th scope="col" aria-sort={ariaSort("turnover")}>{sortHeader("turnover", "换手率")}</th><th scope="col">操作</th>
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
