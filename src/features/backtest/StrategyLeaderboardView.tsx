import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, RefreshCw, Trophy } from "lucide-react";
import { PageHeading, PanelTitle } from "../../components/terminal/TerminalPrimitives";
import { userErrorText } from "../../userErrorText";
import { startVisibleInterval } from "../../visiblePolling";
import type { StrategyLeaderboardReport } from "../../shared/ipc-contract";
import { leaderboardHeadline, leaderboardScopeText, rowEdge, rowWinRate, sortLeaderboardRows, verdictLabel, type LeaderboardSort, type LeaderboardSortColumn } from "./leaderboardModel";

const signed = (value: number | null, digits = 1) => value === null || !Number.isFinite(value) ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
const pct = (value: number | null) => value === null || !Number.isFinite(value) ? "--" : `${value.toFixed(1)}%`;
const edgeTone = (value: number | null) => value === null || Math.abs(value) < 0.3 ? "" : value > 0 ? "tone-up" : "tone-down";

export default function StrategyLeaderboardView({ onBack, backLabel }: { onBack: () => void; backLabel: string }) {
  const [report, setReport] = useState<StrategyLeaderboardReport | null>(null);
  const [progress, setProgress] = useState<{ active?: boolean; processed?: number; total?: number; etaSeconds?: number | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<LeaderboardSort>({ column: "edge", direction: "desc" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const alive = useRef(true);
  const reportRef = useRef<StrategyLeaderboardReport | null>(null);
  reportRef.current = report;
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const refreshPendingRef = useRef(false);
  const loadSeqRef = useRef(0);
  const api = typeof window === "undefined" ? null : window.stockApi;

  const load = useCallback(async (forceRefresh: boolean) => {
    if (typeof api?.getStrategyLeaderboard !== "function") return;
    const seq = ++loadSeqRef.current;
    if (forceRefresh) refreshPendingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const value = await api.getStrategyLeaderboard({ refresh: forceRefresh });
      if (!alive.current || seq !== loadSeqRef.current) return;
      if (value?.statusOnly) { setProgress(value.progress ?? null); return; }
      refreshPendingRef.current = false;
      setProgress(null);
      setReport(value ?? null);
      setError("");
    } catch (reason) {
      if (!alive.current || seq !== loadSeqRef.current) return;
      if (forceRefresh) refreshPendingRef.current = false;
      setError(userErrorText(reason, "策略实测读取失败"));
    } finally {
      if (alive.current && seq === loadSeqRef.current) setLoading(false);
    }
  }, [api]);

  // 进入页面先读一次；进行中时轮询进度，结束后自动展示结果。
  useEffect(() => {
    alive.current = true;
    void load(false);
    const stop = startVisibleInterval(() => {
      if (typeof api?.getStrategyLeaderboard !== "function") return;
      if (reportRef.current !== null && !refreshPendingRef.current && !progressRef.current?.active) return;
      void api.getStrategyLeaderboard({ statusOnly: true }).then(value => {
        if (!alive.current) return;
        const active = value?.progress?.active === true;
        setProgress(active ? value.progress ?? null : null);
        if (!active && (reportRef.current === null || refreshPendingRef.current)) void load(false);
      }).catch(() => undefined);
    }, 5000);
    return () => { alive.current = false; stop(); };
  }, [api, load]);

  const rows = useMemo(() => sortLeaderboardRows(report?.strategies || [], sort), [report, sort]);
  const headline = useMemo(() => leaderboardHeadline(report), [report]);
  const scopeText = useMemo(() => leaderboardScopeText(report), [report]);

  if (typeof api?.getStrategyLeaderboard !== "function") {
    return <div className="bond-workspace"><PageHeading eyebrow="STRATEGY VALIDATION" title="策略实测榜" description="当前连接未提供策略实测接口，请使用桌面版。" /></div>;
  }

  const running = loading || progress?.active === true;
  const head = (column: LeaderboardSortColumn, label: string) => {
    const state = sort.column === column ? (sort.direction === "desc" ? "descending" : "ascending") : "none";
    return <th scope="col" aria-sort={state}>
      <button type="button" className={`column-sort-button${state === "none" ? "" : " active"}`} onClick={() => setSort(current => current.column === column ? { column, direction: current.direction === "desc" ? "asc" : "desc" } : { column, direction: "desc" })}
        aria-label={`按${label}排序`}>{label}{state === "descending" ? " ▾" : state === "ascending" ? " ▴" : ""}</button>
    </th>;
  };

  return <div className="bond-workspace lb-workspace">
    <PageHeading eyebrow="STRATEGY VALIDATION" title="策略实测榜"
      description="用本机日线库里的全市场股票回放每条策略：近一年按同一买卖规则，统计胜率和与「同期涨停股基线」的优劣。它回答的是「这条策略历史上灵不灵」，和单股、组合回测互为补充。"
      actions={<>
        <button className="secondary-btn" onClick={onBack}><ChevronLeft size={16} />{backLabel}</button>
        <button className="primary-btn" onClick={() => void load(true)} disabled={running}><RefreshCw size={16} className={running ? "spin" : ""} />{running ? "回放中…" : "重新实测"}</button>
      </>} />
    {error && <div className="test-result fail" role="alert"><span />{error}</div>}
    {(running || (!report && !error)) && <div className="panel lb-progress" role="status">
      <b>{running ? "正在回放全市场策略信号…" : "正在读取策略实测结果…"}</b>
      <small>{progress?.total ? `已处理 ${progress.processed ?? 0} / ${progress.total} 只股票${typeof progress?.etaSeconds === "number" && progress.etaSeconds > 0 ? `，预计还要 ${Math.ceil((progress.etaSeconds ?? 0) / 60)} 分钟` : ""}` : "只读本机日线库，不下载行情；可切换其他页面，回来再看结果。"}</small>
      {progress?.total ? <div className="lb-progress-bar" aria-hidden="true"><em style={{ width: `${Math.min(100, Math.round(((progress.processed ?? 0) / progress.total) * 100))}%` }} /></div> : null}
    </div>}
    {report && <>
      <section className="panel lb-verdict" aria-label="策略实测结论">
        <b>{headline || "暂无策略结果"}</b>
        <small>{scopeText}</small>
        <details className="lb-method">
          <summary>回测口径与口径局限</summary>
          <p>{report.method}</p>
          <p>{report.baselineDefinition}</p>
          <p>{report.edgeDefinition}</p>
          <p>{report.caveat}</p>
        </details>
      </section>
      <section className="panel lb-table-panel">
        <PanelTitle title="全部在用策略" subtitle="按信号日等权的优势排序；点策略展开各持有期与前后两段" icon={Trophy} badge={`${rows.length} 套`} />
        <div className="bond-table-wrap lb-table-wrap" role="region" aria-label="策略实测排行" tabIndex={0}>
          <table className="bond-table lb-table">
            <thead><tr><th scope="col">#</th><th scope="col">策略</th>{head("edge", "5日 优势")}<th scope="col">5日胜率</th><th scope="col">10日 优势</th><th scope="col">20日 优势</th><th scope="col">结论</th></tr></thead>
            <tbody>
              {rows.map(row => {
                const verdict = verdictLabel(row.verdict?.level || "");
                const open = expanded === row.id;
                const primary = row.horizons?.[String(report.primaryHorizon ?? 5)];
                const edge5 = rowEdge(row, "5");
                const openRow = () => setExpanded(current => current === row.id ? null : row.id);
                return <tr key={row.id} className={open ? "lb-open" : undefined} onClick={openRow}>
                  <td className="lb-rank">{row.featured ? <span className="lb-star" title="精选策略">★</span> : ""}{row.rank ?? "--"}</td>
                  <td><button type="button" className="bond-identity lb-name" aria-expanded={open} aria-label={`${row.name} 展开明细`} onClick={event => { event.stopPropagation(); openRow(); }}>
                    <b>{row.name}</b><code>{row.id}</code>{row.featured ? <span className="lb-featured">精选</span> : ""}
                  </button></td>
                  <td className={edgeTone(edge5)}><b>{signed(edge5)}</b>{primary?.sampleCount ? <small>{primary.sampleCount} 笔</small> : null}</td>
                  <td>{pct(rowWinRate(row, "5"))}{primary?.winRateInterval95 ? <small>{primary.winRateInterval95[0]}–{primary.winRateInterval95[1]}%</small> : null}</td>
                  {(["10", "20"] as const).map(key => {
                    const stats = row.horizons?.[key];
                    const edge = stats?.dayWeightedEdge ?? stats?.edgeVsBaseline ?? null;
                    return <td key={key} className={edgeTone(edge)} title={stats?.sampleCount ? `${stats.sampleCount} 笔交易 · 胜率 ${pct(stats.winRate)} · ${stats.independentSignalDays ?? "--"} 个信号日` : undefined}>
                      {signed(edge)}{stats?.sampleCount ? <small>{stats.sampleCount} 笔</small> : <small>--</small>}
                    </td>;
                  })}
                  <td><span className={`cockpit-chip ${verdict.tone === "good" ? "good" : verdict.tone === "bad" || verdict.tone === "warn" ? "danger" : "muted"}`} title={row.verdict?.text}>{verdict.text}</span></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
        {expanded && (() => {
          const row = rows.find(item => item.id === expanded);
          if (!row) return null;
          const verdict = verdictLabel(row.verdict?.level || "");
          return <div className="lb-detail" role="region" aria-label={`${row.name} 明细`}>
            <p>{verdict.text}。{row.detail}</p>
            <table className="bond-table lb-detail-table">
              <thead><tr><th scope="col">持有期</th><th scope="col">交易</th><th scope="col">胜率</th><th scope="col">平均净收益</th><th scope="col">中位净收益</th><th scope="col">优势 / 信号日等权</th><th scope="col">买不到 / 竞价跳过</th></tr></thead>
              <tbody>{["5", "10", "20"].map(key => {
                const s = row.horizons?.[key];
                return <tr key={key}><td>{key} 日</td><td>{s?.sampleCount ?? 0} 笔 / {s?.independentSignalDays ?? "--"} 个信号日</td>
                  <td>{pct(s?.winRate ?? null)}{s?.winRateInterval95 ? <small>{s.winRateInterval95[0]}–{s.winRateInterval95[1]}%</small> : null}</td>
                  <td className={edgeTone(s?.averageReturn ?? null)}>{signed(s?.averageReturn ?? null)}</td>
                  <td className={edgeTone(s?.medianReturn ?? null)}>{signed(s?.medianReturn ?? null)}</td>
                  <td className={edgeTone(s?.dayWeightedEdge ?? s?.edgeVsBaseline ?? null)}>{signed(s?.dayWeightedEdge ?? s?.edgeVsBaseline ?? null)} / {s?.comparedSignalDays ?? 0} 天</td>
                  <td>{pct(s?.nextDayUnbuyableRate ?? null)} / {pct(s?.entryGapSkippedRate ?? null)}</td></tr>;
              })}
              {(row.halves || []).map(half => <tr key={half.label} className="lb-half">
                <td>{half.label}<small>{half.from}~{half.to}</small></td><td>{half.sampleCount} 笔</td>
                <td>{pct(half.winRate ?? null)}</td><td className={edgeTone(half.averageReturn ?? null)}>{signed(half.averageReturn ?? null)}</td>
                <td>--</td><td className={edgeTone(half.dayWeightedEdge)}>{signed(half.dayWeightedEdge)} / {half.comparedSignalDays ?? 0} 天</td><td>--</td></tr>)}
              </tbody>
            </table>
            <small>「买不到」是信号次日一字涨停不能成交；「竞价跳过」是次日竞价高开超 4% 或低开超 5% 不买（与策略库同一口径）。</small>
          </div>;
        })()}
        {report.baseline?.["5"] && <p className="lb-baseline">
          基线：同期任意近 15 日涨停股，按同一规则 {report.baseline["5"].sampleCount ?? 0} 笔，胜率 {pct(report.baseline["5"].winRate ?? null)}，平均 {signed(report.baseline["5"].averageReturn ?? null)}。
          生成于 {report.generatedAt ? new Date(report.generatedAt).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "--"}{typeof report.elapsedSeconds === "number" ? ` · 回放 ${report.elapsedSeconds} 秒` : ""}。
        </p>}
      </section>
    </>}
  </div>;
}
