import { useEffect, useMemo, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { loadSafeLocalJson, saveSafeLocalJson } from "../../safeStorage";
import { EQUITY_KEY, buildRiskReport, holdingsKey, recordEquity, sanitizeEquityHistory, type AiRiskSignal, type EquityPoint, type RiskHolding, type RiskQuote, type RiskReport } from "./holdingsRisk";
import { cnParts, cnTime, isTradingDay } from "../notes/notesModel";

/** 展示用（纯渲染，便于测试）。 */
export function RiskBoardView({ report }: { report: RiskReport }) {
  const alerts = report.flags.filter(flag => flag.state === "alert").length;
  const unavailableCount = report.flags.filter(flag => flag.state === "unavailable").length;
  const headline = alerts
    ? `${alerts} 项要留意`
    : unavailableCount === report.flags.length
      ? "数据不全"
      : unavailableCount > 0
        ? "部分数据未就绪"
        : "暂无风险提示";
  return <section className="panel risk-board" aria-label="风险与暴露">
    <header className="risk-board-head"><ShieldAlert size={16} /><h3>风险与暴露</h3>
      <span className={alerts ? "alert" : ""}>{headline}</span></header>
    <div className="risk-flags">
      {report.flags.map(flag => <div key={flag.id} className={`risk-flag ${flag.state}`} title={flag.detail}>
        <span>{flag.label}</span><strong>{flag.value}</strong><small>{flag.detail}</small></div>)}
    </div>
    {(report.positions.length > 0 || report.sectors.length > 0) && <div className="risk-exposure">
      {report.positions.length > 0 && <div><b>个股占比</b><Bars rows={report.positions.slice(0, 6).map(item => ({ id: item.code, name: item.name, weightPct: item.weightPct }))} /></div>}
      {report.sectors.length > 0 && <div><b>行业占比</b><Bars rows={report.sectors.slice(0, 6)} /></div>}
    </div>}
  </section>;
}

function Bars({ rows }: { rows: Array<{ id?: string; name: string; weightPct: number }> }) {
  return <ul>{rows.map((row, index) => <li key={row.id ?? `${row.name}-${index}`}><span>{row.name}</span><i><em style={{ width: `${Math.min(100, row.weightPct)}%` }} /></i><b>{row.weightPct.toFixed(1)}%</b></li>)}</ul>;
}

/** 持仓页的风险与暴露看板：用页面已取到的行情计算，另读 AI 建议里仍生效的防御信号。 */
export default function HoldingsRiskBoard({ holdings, quotes }: { holdings: RiskHolding[]; quotes: Record<string, RiskQuote | undefined> }) {
  const [aiSignals, setAiSignals] = useState<AiRiskSignal[] | null>(null);
  const [history, setHistory] = useState<EquityPoint[]>(() => sanitizeEquityHistory(loadSafeLocalJson<unknown>(EQUITY_KEY, [])));
  const [closeTick, setCloseTick] = useState(0);
  const persistedRef = useRef<string | null>(null);
  useEffect(() => {
    const api = window.stockApi?.ai?.agent?.signals;
    if (typeof api !== "function") return;
    let alive = true;
    void api({ status: "active" }).then(result => {
      if (alive) setAiSignals(result.signals.filter(item => ["reduce", "sell", "avoid"].includes(item.action)).map(item => ({ code: item.code, name: item.name, action: item.action, actionLabel: { reduce: "减仓", sell: "卖出", avoid: "回避" }[item.action as "reduce" | "sell" | "avoid"] })));
    }).catch(() => { if (alive) setAiSignals(null); });
    return () => { alive = false; };
  }, []);
  // 行情源不一定带行业：另按代码查同花顺行业，查到的优先。
  const [industries, setIndustries] = useState<Record<string, string>>({});
  const codeKey = holdings.map(item => item.code).filter(code => /^\d{6}$/.test(code)).sort().join(",");
  useEffect(() => {
    const api = window.stockApi?.getStockIndustries;
    if (typeof api !== "function" || !codeKey) return;
    let alive = true;
    void api(codeKey.split(",")).then(result => { if (alive && result && typeof result === "object") setIndustries(result); }).catch(() => undefined);
    return () => { alive = false; };
  }, [codeKey]);
  // ETF 和可转债没有行业分类：单独归为「ETF」「可转债」，不让它们把整个行业集中度变成不可用。
  const fallbackIndustry = (code: string) => /^(?:5\d{5}|159\d{3})$/.test(code) ? "ETF" : /^(?:11\d{4}|12[3-8]\d{3})$/.test(code) ? "可转债" : "";
  const merged = useMemo(() => Object.fromEntries(Object.entries(quotes).map(([code, quote]) => [code, quote ? { ...quote, industry: industries[code] || quote.industry || fallbackIndustry(code) } : quote])), [quotes, industries]);
  const report = useMemo(() => buildRiskReport(holdings, merged, history, aiSignals), [holdings, merged, history, aiSignals]);
  // 若交易日 15:05 前打开页面并一直停留跨过收盘，在 15:05:05 补触发一次重算，避免 15:00 后行情静止漏记当日收盘净值。
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.setTimeout !== "function") return undefined;
    const now = Date.now();
    const { date, minutes } = cnParts(now);
    if (!isTradingDay(date) || minutes >= 15 * 60 + 5) return undefined;
    const targetMs = cnTime(date, 15 * 60 + 5) + 5_000;
    const timer = window.setTimeout(() => setCloseTick(value => value + 1), Math.max(0, targetMs - now));
    return () => window.clearTimeout(timer);
  }, []);
  // 行情齐全时把今天的「市值 ÷ 成本」记一笔，供回撤使用。只在交易日收盘后（北京时间 15:05 之后）记：
  // 盘中的浮动会让回撤看起来比实际大，休市日用的是上个交易日的旧价，重复记同一个数没有意义。
  useEffect(() => {
    if (report.ratio === null) return;
    const { date: today, minutes } = cnParts(Date.now());
    if (!isTradingDay(today) || minutes < 15 * 60 + 5) return;
    const key = holdingsKey(holdings);
    setHistory(current => {
      const next = recordEquity(current, today, report.ratio, key);
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [report.ratio, holdings, closeTick]);
  useEffect(() => {
    const serialized = JSON.stringify(history);
    if (persistedRef.current === null) {
      persistedRef.current = serialized;
      return;
    }
    if (serialized === persistedRef.current) return;
    persistedRef.current = serialized;
    saveSafeLocalJson(EQUITY_KEY, history);
  }, [history]);
  if (!holdings.some(item => Number.isFinite(item.shares) && item.shares > 0)) return null;
  return <RiskBoardView report={report} />;
}
