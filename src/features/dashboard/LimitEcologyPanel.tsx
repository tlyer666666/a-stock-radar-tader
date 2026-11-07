import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import FuyaoReviewSection from "../review/FuyaoReviewSection";
import { whenVisible } from "../../visiblePolling";
import { AiInterpretPanel } from "../ai-review/AiInterpretPanel";

/** 交给 AI 解读的涨停生态：结构、题材、连板龙头、热股、龙虎榜和异动（去掉逐股原始明细）。 */
function ecologyForAi(data: any) {
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
export default function LimitEcologyPanel({ onOpen, live = true }: { onOpen: (security: Security) => void; live?: boolean }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const api = typeof window === "undefined" ? null : window.stockApi;

  const load = useCallback(async (forceRefresh = false) => {
    if (busy.current || typeof api?.getLimitEcology !== "function") return;
    busy.current = true;
    setLoading(true);
    try {
      const value = await api.getLimitEcology({ forceRefresh });
      if (alive.current) { setData(value); setError(""); }
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.current = false;
      if (alive.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    alive.current = true;
    void load();
    // 关闭「实时刷新」后只保留进入时的这一次读取，不再定时刷新。
    const timer = live ? window.setInterval(whenVisible(() => load(false)), 60000) : 0;
    return () => { alive.current = false; if (timer) window.clearInterval(timer); };
  }, [load, live]);

  if (typeof api?.getLimitEcology !== "function") return null;
  const refresh = <button type="button" className="secondary-btn" onClick={() => void load(true)} disabled={loading} title="刷新涨停生态">
    <RefreshCw size={15} className={loading ? "spin" : ""} />刷新
  </button>;
  return <section className="limit-ecology-panel" aria-label="涨停生态">
    {error && <p className="fy-warning" role="alert">涨停生态暂不可用：{error}</p>}
    {data?.available ? <FuyaoReviewSection layout="tabs" data={data} onOpenStock={onOpen} actions={refresh}
      extra={<AiInterpretPanel kind="ecology" asOfDate={shanghaiDate(data.fetchedAt)} getData={() => ecologyForAi(data)} />} />
      : <div className="limit-ecology-actions"><b>涨停生态 · 题材 · 资金</b>{data ? <FuyaoReviewSection data={data} onOpenStock={onOpen} /> : !error && <span className="fy-unavailable">正在读取同花顺涨停生态…</span>}{refresh}</div>}
  </section>;
}
