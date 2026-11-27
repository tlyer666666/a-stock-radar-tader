import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Repeat, RefreshCw } from "lucide-react";
import { userErrorText } from "../../userErrorText";
import { curvePaths, drawdownPct, plainPct, signedPct, sweepVerdict, valueTone, type EtfRotationConfig, type EtfRotationReport } from "./etfRotationModel";

const DEFAULT_POOL_SIZE = 6;
const num = (value: number | null | undefined, digits = 2) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "--";

const formatTargetHeadline = (signal: NonNullable<EtfRotationReport["signal"]>) => {
  if (signal.targets.length > 0) {
    const base = signal.targets.map(item => `${item.name} ${num(item.weightPct, 0)}%`).join(" + ");
    return signal.idleWeightPct ? `${base} + ${signal.idleTo} ${num(signal.idleWeightPct, 0)}%` : base;
  }
  if (typeof signal.idleWeightPct === "number" && Number.isFinite(signal.idleWeightPct) && signal.idleWeightPct > 0) {
    return `全部防守：${signal.idleTo} ${num(signal.idleWeightPct, 0)}%`;
  }
  return "全部空仓";
};

/** 展示用（纯渲染，便于测试）。 */
export function EtfRotationView({ report }: { report: EtfRotationReport }) {
  const signal = report.signal;
  const paths = useMemo(() => (report.curve ? curvePaths(report.curve) : null), [report.curve]);
  const verdict = useMemo(() => sweepVerdict(report.sweep), [report.sweep]);
  return <div className="etf-rotation-body">
    {report.warnings.length > 0 && <ul className="etf-rotation-warnings" role="status">{report.warnings.map((text, index) => <li key={`${text}-${index}`}>{text}</li>)}</ul>}
    {signal && <div className="etf-rotation-signal">
      <div>
        <span>按 {signal.asOf} 收盘算的目标持仓</span>
        <strong>{formatTargetHeadline(signal)}</strong>
        <small>
          规则当前持仓：{signal.holdings.length ? signal.holdings.map(item => item.name).join("、") : "现金"}
          {signal.needRebalance ? "；目标和持仓不一样，" : "；目标和持仓一致，"}
          {signal.isRebalanceDay ? (signal.needRebalance ? "今天是调仓日，下一个交易日收盘换仓。" : "今天是调仓日，不用动。") : `目标只作参考，要等本${report.config.rebalance === "monthly" ? "月" : "周"}最后一个交易日收盘再定。`}
        </small>
      </div>
      <div className="bond-table-wrap">
        <table className="bond-table etf-rot-table etf-rotation-rank" aria-label="动量排名">
          <thead><tr><th scope="col">#</th><th scope="col">ETF</th><th scope="col">{report.config.lookback} 日涨幅</th><th scope="col">状态</th></tr></thead>
          <tbody>{signal.ranking.map((item, index) => <tr key={item.code} className={item.selected ? "selected" : ""}>
            <td>{index + 1}</td><td><b>{item.name}</b> <code>{item.code}</code></td>
            <td className={valueTone(item.momentumPct)}>{signedPct(item.momentumPct)}</td>
            <td>{item.selected ? "入选" : item.positive ? "动量为正，排名不够" : "动量为负，不持有"}</td></tr>)}</tbody>
        </table>
      </div>
    </div>}
    {report.performance && <>
      <div className="etf-rotation-perf">
        <div className="bond-table-wrap">
          <table className="bond-table etf-rot-table etf-rot-perf-table" aria-label="回测表现">
            <thead><tr><th scope="col">{report.performance.from} ~ {report.performance.to}</th><th scope="col">累计</th><th scope="col">年化</th><th scope="col">最大回撤</th><th scope="col">波动</th><th scope="col">夏普</th><th scope="col">Calmar</th></tr></thead>
            <tbody>{([["轮动策略", report.performance.strategy], ["风险池等权持有", report.performance.benchmark]] as const).map(([label, m]) => <tr key={label}>
              <td><b>{label}</b></td><td>{signedPct(m?.totalPct)}</td><td>{signedPct(m?.annualPct)}</td><td>{drawdownPct(m?.maxDrawdownPct, 2)}</td><td>{plainPct(m?.volPct, 2)}</td><td>{num(m?.sharpe)}</td><td>{num(m?.calmar)}</td></tr>)}</tbody>
          </table>
        </div>
        {paths && <svg className="etf-rotation-curve" viewBox="0 0 640 150" preserveAspectRatio="none" role="img" aria-label="策略与等权基准净值曲线">
          <line x1="0" x2="640" y1={paths.baseline} y2={paths.baseline} className="base" /><path d={paths.benchmark} className="bench" /><path d={paths.strategy} className="strategy" /></svg>}
        <small className="etf-rotation-legend"><i className="strategy" />轮动策略 <i className="bench" />等权持有（每日再平衡、不扣成本） · 共调仓 {report.rebalanceCount ?? report.rebalances.length} 次</small>
      </div>
      <div className="etf-rotation-grid">
        <div><b>分年度收益</b>
          <div className="bond-table-wrap">
            <table className="bond-table etf-rot-table etf-rot-yearly-table"><thead><tr><th scope="col">年份</th><th scope="col">策略</th><th scope="col">等权</th></tr></thead>
              <tbody>{report.yearly.map(row => <tr key={row.year}><td>{row.year}{row.partial ? "（不满一年）" : ""}</td><td className={valueTone(row.strategyPct)}>{signedPct(row.strategyPct)}</td><td>{signedPct(row.benchmarkPct)}</td></tr>)}</tbody></table>
          </div></div>
        <div><b>参数平原（只改动量窗口）</b>
          <div className="bond-table-wrap">
            <table className="bond-table etf-rot-table etf-rot-sweep-table"><thead><tr><th scope="col">窗口</th><th scope="col">年化</th><th scope="col">最大回撤</th><th scope="col">夏普</th></tr></thead>
              <tbody>{report.sweep.map(row => <tr key={row.lookback} className={row.current ? "selected" : ""}><td>{row.lookback} 日{row.current ? "（当前）" : ""}</td><td>{signedPct(row.annualPct)}</td><td>{drawdownPct(row.maxDrawdownPct, 1)}</td><td>{num(row.sharpe)}</td></tr>)}</tbody></table>
          </div>
          <small>{verdict}</small></div>
        <div><b>最近调仓</b>
          {report.rebalances.length ? <div className="bond-table-wrap"><table className="bond-table etf-rot-table etf-rot-rebalance-table"><thead><tr><th scope="col">成交日</th><th scope="col">调出</th><th scope="col">调入</th></tr></thead>
            <tbody>{report.rebalances.map(row => <tr key={row.tradeDate}><td>{row.tradeDate}</td><td>{row.out.join("、") || "--"}</td><td>{row.in.join("、") || "--"}</td></tr>)}</tbody></table></div> : <small>还没有调仓记录</small>}</div>
      </div>
    </>}
    <small className="etf-rotation-note">规则：每{report.config.rebalance === "monthly" ? "月" : "周"}最后一个交易日收盘后，按过去 {report.config.lookback} 个交易日涨幅排名，只持有涨幅为正的前 {report.config.topN} 只（各 {report.config.topN > 0 ? num(100 / report.config.topN, 0) : "--"}%），没选满的仓位放{report.config.safeAsset ? "货币 ETF" : "现金"}；下一个交易日收盘成交，单边成本 {report.config.costBps} 个基点。趋势轮动的主要作用是控制回撤，震荡市会反复换仓，跑输等权持有是常见结果。回测不代表未来收益，不构成投资建议。</small>
  </div>;
}

/** ETF 页的轮动面板：点开才计算（要读 7 只 ETF 的多年日线）。 */
export default function EtfRotationPanel() {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.getEtfRotation;
  const [report, setReport] = useState<EtfRotationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lookback, setLookback] = useState("60");
  const [topN, setTopN] = useState("2");
  const [rebalance, setRebalance] = useState<EtfRotationConfig["rebalance"]>("weekly");
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const maxTopN = report?.config?.pool?.length || DEFAULT_POOL_SIZE;
  const lookbackNum = lookback.trim() ? Number(lookback) : Number.NaN;
  const topNNum = topN.trim() ? Number(topN) : Number.NaN;
  const paramHint = !Number.isInteger(lookbackNum) || lookbackNum < 5 || lookbackNum > 500
    ? "动量窗口需为 5–500 的整数"
    : !Number.isInteger(topNNum) || topNNum < 1 || topNNum > maxTopN
      ? `持有只数需为 1–${maxTopN} 的整数（不超过风险池数量）`
      : "";
  const run = useCallback(() => {
    if (typeof api !== "function" || paramHint) return;
    const seq = ++seqRef.current;
    setBusy(true); setError("");
    void api({ lookback: lookbackNum, topN: Math.min(maxTopN, topNNum), rebalance }).then(next => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setReport(next);
    }).catch(reason => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setError(userErrorText(reason, "ETF 轮动计算失败"));
    }).finally(() => {
      if (mountedRef.current && seq === seqRef.current) setBusy(false);
    });
  }, [api, lookbackNum, maxTopN, paramHint, rebalance, topNNum]);
  if (typeof api !== "function") return null;
  return <section className="panel etf-rotation" aria-label="ETF 轮动">
    <header className="etf-rotation-head">
      <b><Repeat size={14} /> ETF 轮动（双动量）</b>
      <small>沪深300、中证500、创业板、红利低波、纳指、黄金六只 ETF 里，只持有近期涨得最好且为正的，其余放货币 ETF。纯规则，不用 AI。</small>
      <label>动量窗口<input type="number" min={5} max={500} value={lookback} disabled={busy} onChange={event => setLookback(event.target.value)} />日</label>
      <label>持有<input type="number" min={1} max={maxTopN} value={topN} disabled={busy} onChange={event => setTopN(event.target.value)} />只</label>
      <label>调仓<select value={rebalance} disabled={busy} onChange={event => setRebalance(event.target.value as EtfRotationConfig["rebalance"])}><option value="weekly">每周</option><option value="monthly">每月</option></select></label>
      <button type="button" className="secondary-btn" disabled={busy || Boolean(paramHint)} onClick={run}><RefreshCw size={14} className={busy ? "spin" : ""} />{busy ? "计算中…" : report ? "重新计算" : "计算最新信号与回测"}</button>
      {paramHint && <small className="alert-rules-error" role="alert">{paramHint}</small>}
    </header>
    {error && <div className="test-result fail" role="alert"><span />{error}</div>}
    {report && <EtfRotationView report={report} />}
  </section>;
}
