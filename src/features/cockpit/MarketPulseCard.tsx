import { RefreshCw } from "lucide-react";
import type { MarketPulse } from "./cockpitModel";

function pulseUpdatedAt(generatedAt: string): string {
  const ms = Date.parse(generatedAt);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
}

export default function MarketPulseCard({
  pulse,
  state,
  onRetry,
  onOpenReview,
  onAskAi,
  showIndices = true
}: {
  showIndices?: boolean;
  pulse: MarketPulse | null;
  state: "loading" | "ready" | "error";
  onRetry: () => void;
  onOpenReview: () => void;
  onAskAi?: (() => void) | undefined;
}) {
  if (!pulse) {
    if (state === "loading") {
      return <div className="cockpit-pulse-empty">正在读取今天的大盘数据…</div>;
    }
    if (state === "error") {
      return (
        <div className="cockpit-pulse-empty">
          <span>大盘数据暂时没取到</span>
          <button type="button" className="table-action" onClick={onRetry}><RefreshCw size={12} />重试</button>
        </div>
      );
    }
    return null;
  }

  const updatedAt = pulseUpdatedAt(pulse.generatedAt);
  const metaParts = pulse.stale
    ? `上个交易日 ${pulse.date} 收盘数据`
    : ["数据", pulse.date, pulse.session].filter(Boolean).join(" ");
  const total = pulse.breadth ? pulse.breadth.up + pulse.breadth.down + pulse.breadth.flat : 0;

  return (
    <div className="cockpit-pulse-inner">
      <header className="cockpit-pulse-head">
        <div className="cockpit-pulse-title">
          <h3>今日大盘</h3>
          <span className={`cockpit-pulse-chip tone-${pulse.tone}`}>{pulse.regimeName || "大盘"}</span>
        </div>
        <small>
          {metaParts}{updatedAt ? ` · ${updatedAt} 更新` : ""}
          {pulse.stale ? " · 开盘后自动换成今天的" : pulse.provisional ? " · 15:00 收盘后给出正式结论" : ""}
        </small>
      </header>

      <div className={`cockpit-pulse-grid${showIndices ? "" : " no-indices"}`}>
        <div className="cockpit-pulse-lead">
          <strong className="cockpit-pulse-headline">{pulse.headline || "—"}</strong>
          {pulse.posture ? <span className="cockpit-pulse-posture">建议：{pulse.posture}</span> : null}
        </div>

        <div className="cockpit-pulse-market">
          {pulse.breadth ? (
            <div className="cockpit-pulse-breadth">
              <span>
                <b className="up">上涨 {pulse.breadth.up} 家</b>
                <b className="down">下跌 {pulse.breadth.down} 家</b>
                {pulse.breadth.flat > 0 ? <em>平 {pulse.breadth.flat} 家</em> : null}
              </span>
              <div className="cockpit-pulse-breadth-bar" role="img" aria-label={`上涨 ${pulse.breadth.up} 家，下跌 ${pulse.breadth.down} 家`}>
                <i className="up" style={{ width: `${total > 0 ? (pulse.breadth.up / total) * 100 : 0}%` }} />
                <i className="down" style={{ width: `${total > 0 ? (pulse.breadth.down / total) * 100 : 0}%` }} />
              </div>
              {pulse.averageReturn !== null ? (
                <small>平均涨跌 {pulse.averageReturn >= 0 ? "+" : ""}{pulse.averageReturn.toFixed(2)}%</small>
              ) : null}
            </div>
          ) : <span className="cockpit-pulse-na">暂未取到</span>}
          {pulse.limit ? (
            <span className="cockpit-pulse-limit">
              涨停 {pulse.limit.up} · 跌停 {pulse.limit.down}
              {pulse.limit.failedRate !== null ? ` · 炸板率 ${(pulse.limit.failedRate * 100).toFixed(0)}%` : ""}
              {pulse.limit.maxHeight !== null ? ` · 最高 ${pulse.limit.maxHeight} 板` : ""}
            </span>
          ) : <span className="cockpit-pulse-na">暂未取到</span>}
        </div>

        {/* 驾驶舱上方已有实时指数条时，这里不再重复列指数（均线位置以小标签挂到指数卡片上）。 */}
        {showIndices ? <ul className="cockpit-pulse-indices">
          {pulse.indices.length ? pulse.indices.map((index) => (
            <li key={index.name}>
              <span>{index.name}</span>
              <b>{index.close.toFixed(2)}</b>
              {index.changePct !== null ? (
                <em className={index.changePct >= 0 ? "up" : "down"}>{index.changePct >= 0 ? "+" : ""}{index.changePct.toFixed(2)}%</em>
              ) : null}
              {index.trend ? <small>{index.trend}</small> : null}
            </li>
          )) : <li className="cockpit-pulse-na">暂未取到</li>}
        </ul> : null}

        <footer className="cockpit-pulse-foot">
        {pulse.risks.length ? <span className="cockpit-pulse-risks">要留意：{pulse.risks.slice(0, 2).join("；")}</span> : null}
        {pulse.sectors.length ? (
          <span className="cockpit-pulse-sectors">
            较强方向：{pulse.sectors.map((sector) => `${sector.name}${sector.leaderName ? `（${sector.leaderName}）` : ""}`).join("、")}
          </span>
        ) : null}
        <span className="cockpit-pulse-actions">
          <button type="button" className="table-action" onClick={onOpenReview}>看完整复盘</button>
          {onAskAi ? <button type="button" className="table-action" onClick={onAskAi}>问 AI 怎么看大盘</button> : null}
        </span>
        </footer>
      </div>
    </div>
  );
}
