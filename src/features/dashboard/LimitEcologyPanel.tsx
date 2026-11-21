import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import FuyaoReviewSection, { type FuyaoReview } from "../review/FuyaoReviewSection";
import { startVisibleInterval } from "../../visiblePolling";
import { AiInterpretPanel } from "../ai-review/AiInterpretPanel";
import { createRefreshGate } from "../../refreshGate";
import { LIMIT_POOL_REFRESH_EVENT } from "./limitUpPoolModel";
import { userErrorText } from "../../userErrorText";

type LimitEcologyState = FuyaoReview & {
  hotLists?: { day?: { hot?: unknown[] | null } | null; hour?: unknown } | null;
  skyrocket?: unknown[] | null;
};

/** 交给 AI 解读的涨停生态：结构、题材、连板龙头、热股、龙虎榜和异动（去掉逐股原始明细）。 */
function ecologyForAi(data: LimitEcologyState | null) {
  if (!data?.available) return null;
  return {
    sealRate: data.sealRate, limitUp: { count: data.limitUp?.count, maxBoards: data.limitUp?.maxBoards, boardCounts: data.limitUp?.boardCounts,
      reasons: data.limitUp?.reasons, leaders: data.limitUp?.leaders },
    limitDown: { count: data.limitDown?.count }, limitBreak: { count: data.limitBreak?.count },
    ladder: Array.isArray(data.ladder?.days) ? data.ladder.days.slice(-5) : [],
    hot: data.hotLists?.day?.hot || data.hot || [], skyrocket: data.skyrocket || [],
    dragonTiger: data.dragonTiger ? { date: data.dragonTiger.date, count: data.dragonTiger.count, topNet: data.dragonTiger.topNet, desks: data.dragonTiger.desks } : null,
    anomalies: data.anomalies || []
  };
}
const shanghaiDate = (value: unknown) => { const time = Date.parse(String(value || "")); return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : undefined; };

/**
 * 涨停监控页顶部的「涨停生态」：各块名称一字排开、点开看详情。内容是同花顺扶摇的涨停结构、连板天梯、涨停原因、
 * 热股榜、龙虎榜和异动解读。每分钟刷新一次（页面隐藏时不请求）。
 */
export function ecologyRefreshNotice(next: LimitEcologyState | null, previous: LimitEcologyState | null, at = new Date()): string {
  const clock = at.toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
  if (!next?.available) return `${clock} 已刷新：${next?.reason || "涨停生态暂不可用"}`;
  const stale = (next.warnings || []).filter(text => text.includes("沿用"));
  const comparable = (value: LimitEcologyState) => JSON.stringify({ ...value, fetchedAt: "", hotLists: value.hotLists ? { ...value.hotLists, quotedAt: null } : null });
  const changed = !previous || comparable(previous) !== comparable(next);
  return `${clock} 已刷新${changed ? "，数据有更新" : "，数据源暂无新数据"}${stale.length ? `；${stale.length} 个分块本次没取到，沿用之前的数据` : ""}`;
}

/**
 * 涨停监控页顶部的「涨停生态」：各块名称一字排开、点开看详情。内容是同花顺扶摇的涨停结构、连板天梯、涨停原因、
 * 热股榜、龙虎榜和异动解读。每分钟刷新一次（页面隐藏时不请求）。
 */
export default function LimitEcologyPanel({ onOpen, live = true }: { onOpen: (security: Security) => void; live?: boolean }) {
  const [data, setData] = useState<LimitEcologyState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [manual, setManual] = useState(false);
  const [notice, setNotice] = useState("");
  const dataRef = useRef<LimitEcologyState | null>(null);
  const alive = useRef(true);
  const api = typeof window === "undefined" ? null : window.stockApi;

  const gate = useMemo(() => createRefreshGate(async (forceRefresh) => {
    if (typeof api?.getLimitEcology !== "function") return;
    setLoading(true);
    try {
      const value = (await api.getLimitEcology({ forceRefresh })) as unknown as LimitEcologyState;
      if (!alive.current) return;
      if (forceRefresh) setNotice(ecologyRefreshNotice(value, dataRef.current));
      dataRef.current = value;
      setData(value);
      setError("");
    } catch (reason) {
      if (!alive.current) return;
      const message = userErrorText(reason);
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
    // 关闭「实时刷新」后只保留进入时的这一次读取，不再定时刷新。
    const stop = live ? startVisibleInterval(() => { void gate.trigger(false).catch(() => undefined); }, 60_000) : undefined;
    window.addEventListener(LIMIT_POOL_REFRESH_EVENT, refreshNow);
    return () => { alive.current = false; stop?.(); window.removeEventListener(LIMIT_POOL_REFRESH_EVENT, refreshNow); };
  }, [gate, live, refreshNow]);

  if (typeof api?.getLimitEcology !== "function") return null;
  const refresh = <>
    {notice && <small className="fy-refresh-notice" role="status">{notice}</small>}
    <button type="button" className="secondary-btn" onClick={refreshNow} disabled={manual} title="强制重新读取涨停生态（龙虎榜、连板天梯、涨停原因、热榜、异动）">
      <RefreshCw size={15} className={loading ? "spin" : ""} />{manual ? "刷新中" : "刷新"}
    </button>
  </>;
  return <section className="limit-ecology-panel" aria-label="涨停生态">
    {error && <p className="fy-warning" role="alert">涨停生态暂不可用：{error}</p>}
    {data?.available ? <FuyaoReviewSection layout="tabs" data={data} onOpenStock={onOpen} actions={refresh}
      extra={<AiInterpretPanel kind="ecology" asOfDate={shanghaiDate(data.fetchedAt)} getData={() => ecologyForAi(data)} />} />
      : <div className="limit-ecology-actions"><b>涨停生态 · 题材 · 资金</b>{data ? <FuyaoReviewSection data={data} onOpenStock={onOpen} /> : !error && <span className="fy-unavailable">正在读取同花顺涨停生态…</span>}{refresh}</div>}
  </section>;
}
