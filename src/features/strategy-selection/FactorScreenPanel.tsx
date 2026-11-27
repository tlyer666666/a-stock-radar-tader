import { useCallback, useEffect, useRef, useState } from "react";
import { Filter, Play } from "lucide-react";
import { inferSecid } from "../../domain/securityIdentifiers";
import { userErrorText } from "../../userErrorText";
import { FACTOR_STRATEGY_OPTIONS, funnelText, weightsText, type FactorPick, type FactorScreenResult } from "./factorScreenModel";

const QUALITY_LABEL = { observed: "观测", inferred: "推断", unknown: "缺数据" } as const;

/** 展示用（纯渲染，便于测试）。 */
export function FactorScreenView({ result, onOpen }: { result: FactorScreenResult; onOpen?: ((security: Security) => void) | undefined }) {
  return <div className="factor-screen-body">
    {result.warnings.length > 0 && <ul className="etf-rotation-warnings" role="status">{result.warnings.map((text, index) => <li key={`${text}-${index}`}>{text}</li>)}</ul>}
    <p className="factor-screen-meta">
      <b>{result.strategy.name}</b>：{result.strategy.summary}。权重 {weightsText(result.strategy.weights)}（↑ 越大越好，↓ 越小越好）。<br />
      {funnelText(result.funnel)}。报表期 {result.reportPeriod}。
    </p>
    {result.picks.length === 0 ? <p className="factor-screen-empty">这套策略现在没有选出股票。</p>
      : <div className="bond-table-wrap" role="region" aria-label="多因子选股结果" tabIndex={0}>
        <table className="bond-table factor-screen-table">
          <thead><tr><th scope="col">#</th><th scope="col">股票</th><th scope="col">综合分</th><th scope="col">现价</th><th scope="col">因子</th><th scope="col">为什么选它</th><th scope="col">为什么是现在</th></tr></thead>
          <tbody>{result.picks.map(pick => <PickRow key={pick.code} pick={pick} onOpen={onOpen} />)}</tbody>
        </table>
      </div>}
    <small className="etf-rotation-note">{result.note} 综合分是各因子在可比股票里的百分位按权重加权（0–100）。「观测」是报表、行情或日线里的实际数字。</small>
  </div>;
}

function PickRow({ pick, onOpen }: { pick: FactorPick; onOpen?: ((security: Security) => void) | undefined }) {
  return <tr>
    <td>{pick.rank}</td>
    <td>{onOpen ? <button type="button" className="bond-identity" onClick={() => onOpen({ code: pick.code, name: pick.name, secid: inferSecid(pick.code), assetType: "stock" })}><b>{pick.name}</b><code>{pick.code}</code></button>
      : <span className="bond-identity"><b>{pick.name}</b><code>{pick.code}</code></span>}<small>{pick.industry}{pick.marketCapYi !== null ? ` · ${pick.marketCapYi} 亿` : ""}</small></td>
    <td><b>{pick.score ?? "--"}</b>{pick.coveragePct !== null && pick.coveragePct < 100 && <small title="有因子缺数据，按其余因子计分">因子覆盖 {pick.coveragePct}%</small>}</td>
    <td>{pick.latest ?? "--"}{pick.changePct !== null && <small className={pick.changePct > 0 ? "rise" : pick.changePct < 0 ? "fall" : ""}>{pick.changePct > 0 ? "+" : ""}{pick.changePct}%</small>}</td>
    <td className="factor-screen-factors">{Object.entries(pick.factors).map(([id, factor]) => <span key={id} title={`权重 ${factor.weight}% · 百分位分 ${factor.score ?? "缺"}`}>{factor.label} <b>{factor.value ?? "--"}</b>{factor.value !== null ? factor.unit : ""}</span>)}</td>
    <td className="factor-screen-why">{pick.whySelected.map(item => <span key={item.code}>{item.text}<em className={item.quality}>{QUALITY_LABEL[item.quality]}</em></span>)}</td>
    <td className="factor-screen-why">{pick.whyNow.map(item => <span key={item.code}>{item.text}<em className={item.quality}>{QUALITY_LABEL[item.quality]}</em></span>)}</td>
  </tr>;
}

/** 多因子选股面板：点按钮才计算（要读全市场报表和行情，首次约 10–30 秒）。 */
/** 选股一次要十几秒：结果留在模块里，点开个股再返回、或切走再回来时不用重跑。 */
const factorCache: { strategyId: string; result: FactorScreenResult | null } = { strategyId: "quality_value", result: null };

export default function FactorScreenPanel({ onOpen }: { onOpen?: ((security: Security) => void) | undefined }) {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.screenFactors;
  const [strategyId, setStrategyIdState] = useState<string>(factorCache.strategyId);
  const [result, setResultState] = useState<FactorScreenResult | null>(factorCache.result);
  const setStrategyId = (value: string) => { factorCache.strategyId = value; setStrategyIdState(value); };
  const setResult = (value: FactorScreenResult | null) => { factorCache.result = value; setResultState(value); };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const run = useCallback(() => {
    if (typeof api !== "function") return;
    const seq = ++seqRef.current;
    setBusy(true); setError("");
    void api({ strategyId, top: 20 }).then(next => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setResult(next);
    }).catch(reason => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setError(userErrorText(reason, "多因子选股失败"));
    }).finally(() => {
      if (mountedRef.current && seq === seqRef.current) setBusy(false);
    });
  }, [api, strategyId]);
  if (typeof api !== "function") return null;
  const option = FACTOR_STRATEGY_OPTIONS.find(item => item.id === strategyId);
  return <section className="panel factor-screen" aria-label="多因子选股">
    <header className="etf-rotation-head">
      <b><Filter size={14} /> 多因子选股</b>
      <small>用最新一期业绩报表、估值和近 60 日量价给全市场打分，和「策略选股」里按形态选的策略互补。每只都写明为什么选它、为什么是现在。</small>
      <label>策略<select value={strategyId} disabled={busy} onChange={event => setStrategyId(event.target.value)}>{FACTOR_STRATEGY_OPTIONS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <span className="factor-screen-hint">{option?.summary}</span>
      <button type="button" className="secondary-btn" disabled={busy} onClick={run}><Play size={14} />{busy ? "选股中…（首次约半分钟）" : "开始选股"}</button>
    </header>
    {error && <div className="test-result fail" role="alert"><span />{error}</div>}
    {result && <FactorScreenView result={result} onOpen={onOpen} />}
  </section>;
}
