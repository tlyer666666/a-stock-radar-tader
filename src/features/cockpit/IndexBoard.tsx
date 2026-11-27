import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  formatAmount,
  formatSigned,
  indexBoardHeadline,
  indexBoardStale,
  indexTone,
  normalizeIndexTime,
  sparklinePath,
  tickClock,
  type IndexBoardQuote,
  type IndexBoardSnapshot
} from "./indexBoardModel";

function Sparkline({ quote }: { quote: IndexBoardQuote }) {
  const path = sparklinePath(quote.trend, quote.preClose);
  if (!path) return <div className="index-card-spark empty" aria-hidden="true" />;
  const tone = indexTone(quote.changePct);
  return (
    <svg className={`index-card-spark tone-${tone}`} viewBox="0 0 120 36" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="120" y1={path.baseline} y2={path.baseline} className="base" />
      <path d={path.area} className="area" />
      <path d={path.line} className="line" />
    </svg>
  );
}

function Breadth({ up, down, flat }: { up: number | null; down: number | null; flat: number | null }) {
  if (up === null || down === null) return null;
  const total = up + down + (flat ?? 0);
  if (total <= 0) return null;
  return (
    <span className="index-card-breadth" title={`上涨 ${up} 家 · 下跌 ${down} 家${flat ? ` · 平 ${flat} 家` : ""}`}>
      <i className="bar"><i className="up" style={{ width: `${(up / total) * 100}%` }} /><i className="down" style={{ width: `${(down / total) * 100}%` }} /></i>
      <em className="up">{up}</em><em className="down">{down}</em>
    </span>
  );
}

function IndexCard({ quote, trendText, selected, onSelect }: {
  quote: IndexBoardQuote;
  trendText?: string | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone = indexTone(quote.changePct);
  // 价格跳动时闪一下（涨红跌绿），和行情软件一样一眼看出哪个指数在动。
  const previous = useRef(quote.latest);
  const [flash, setFlash] = useState<"" | "flash-up" | "flash-down">("");
  useEffect(() => {
    const before = previous.current;
    previous.current = quote.latest;
    if (before === null || quote.latest === null || before === quote.latest) return undefined;
    setFlash(quote.latest > before ? "flash-up" : "flash-down");
    const timer = window.setTimeout(() => setFlash(""), 650);
    return () => window.clearTimeout(timer);
  }, [quote.latest]);
  const tooltip = [
    `${quote.name} ${quote.code}`,
    `今开 ${quote.open?.toFixed(2) ?? "--"} · 最高 ${quote.high?.toFixed(2) ?? "--"} · 最低 ${quote.low?.toFixed(2) ?? "--"} · 昨收 ${quote.preClose?.toFixed(2) ?? "--"}`,
    `成交额 ${formatAmount(quote.amount)}${quote.time ? ` · ${quote.time.slice(0, 5)}` : ""}`
  ].join("\n");
  return (
    <button type="button" className={`index-card tone-${tone}${quote.major ? " major" : ""}${selected ? " selected" : ""}${flash ? ` ${flash}` : ""}`}
      onClick={onSelect} title={tooltip} aria-pressed={selected}
      aria-label={`${quote.name} ${quote.latest?.toFixed(2) ?? "未取到"}，${formatSigned(quote.changePct, 2, "%")}`}>
      <span className="index-card-head">
        <b>{quote.name}</b>
        {trendText ? <small className="index-card-trend">{trendText}</small> : null}
      </span>
      <strong className="index-card-price">{quote.latest !== null ? quote.latest.toFixed(2) : "--"}</strong>
      <span className="index-card-change">
        <em>{formatSigned(quote.change)}</em>
        <em>{formatSigned(quote.changePct, 2, "%")}</em>
      </span>
      <Sparkline quote={quote} />
      <span className="index-card-foot">
        <small>{formatAmount(quote.amount)}</small>
        <Breadth up={quote.up} down={quote.down} flat={quote.flat} />
      </span>
    </button>
  );
}

function updatedText(fetchedAt: string): string {
  const ms = Date.parse(fetchedAt);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
}

/**
 * 驾驶舱指数条：对照同花顺手机版首页的指数区，一屏看全上证、深证、创业板、科创50、北证50 等主要指数。
 * 红涨绿跌；迷你分时以昨收为中线；上证、深证卡片上的涨跌家数是沪市、深市全市场口径。
 */
export default function IndexBoard({ snapshot, state, today, trendByName, tickAt = 0, onRetry, onAskAi }: {
  snapshot: IndexBoardSnapshot | null;
  /** 最近一次收到实时推送的时间（毫秒）；0 表示没有推送（休市或推送不可用）。 */
  tickAt?: number;
  state: "loading" | "ready" | "error";
  today: string;
  trendByName?: Record<string, string> | undefined;
  onRetry: () => void;
  onAskAi?: (() => void) | undefined;
}) {
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  // 收到推送后只排一次 60 秒到期定时器，让「实时推送」的圆点在推送静默满 60 秒时自动熄灭，之后不再空转。
  const [, setLiveExpired] = useState(0);
  useEffect(() => {
    if (!tickAt || typeof window === "undefined") return undefined;
    const remaining = 60_000 - (Date.now() - tickAt);
    if (remaining <= 0) return undefined;
    const timer = window.setTimeout(() => setLiveExpired(value => value + 1), Math.max(0, remaining) + 50);
    return () => window.clearTimeout(timer);
  }, [tickAt]);
  const liveTick = tickAt > 0 && Date.now() - tickAt < 60_000;

  if (!snapshot) {
    return (
      <div className="index-board-empty">
        {state === "error"
          ? <><span>指数行情暂时没取到</span><button type="button" className="table-action" onClick={onRetry}><RefreshCw size={12} />重试</button></>
          : <span>正在读取指数行情…</span>}
      </div>
    );
  }

  const stale = indexBoardStale(snapshot, today);
  const totals = snapshot.totals;
  const headline = indexBoardHeadline(snapshot);
  const selected = snapshot.indices.find(item => item.code === selectedCode) || null;
  const breadthTotal = totals && totals.up !== null && totals.down !== null ? totals.up + totals.down + (totals.flat ?? 0) : 0;
  const lastTime = snapshot.indices
    .map(item => item.time)
    .filter(Boolean)
    .sort((a, b) => normalizeIndexTime(a).localeCompare(normalizeIndexTime(b)))
    .at(-1) || "";

  return (
    <div className="index-board-inner">
      <header className="index-board-head">
        <div className="index-board-title">
          <h3>指数</h3>
          {liveTick && !stale
            ? <span className="index-board-live" title="主进程订阅了东方财富实时推送，行情一变就推到这里；交易所快照本身约每 3 秒更新一次">
                <i aria-hidden="true" />实时推送 · 最后跳动 {tickClock(tickAt)}
              </span>
            : null}
          <small>
            {stale ? `上个交易日 ${snapshot.tradingDate} 收盘` : `${snapshot.tradingDate} ${lastTime.slice(0, 5)}`.trim()}
            {liveTick && !stale ? "" : ` · ${updatedText(snapshot.fetchedAt)} 刷新`}
            {state === "error" ? " · 刷新失败，显示上次数据" : ""}
          </small>
        </div>
        {totals ? (
          <div className="index-board-totals" aria-label="沪深两市成交与涨跌家数">
            <span title={totals.scope}>两市成交 <b>{formatAmount(totals.amount)}</b></span>
            {breadthTotal > 0 ? (
              <span className="index-board-breadth">
                <b className="up">涨 {totals.up}</b>
                <i className="bar" role="img" aria-label={`上涨 ${totals.up} 家，下跌 ${totals.down} 家`}>
                  <i className="up" style={{ width: `${((totals.up ?? 0) / breadthTotal) * 100}%` }} />
                  <i className="down" style={{ width: `${((totals.down ?? 0) / breadthTotal) * 100}%` }} />
                </i>
                <b className="down">跌 {totals.down}</b>
              </span>
            ) : null}
          </div>
        ) : null}
      </header>
      {headline ? <p className="index-board-headline">{headline}</p> : null}
      <div className="index-board-grid" role="list" aria-label="主要指数">
        {snapshot.indices.map(quote => (
          <div role="listitem" key={quote.code}>
            <IndexCard quote={quote} trendText={trendByName?.[quote.name]} selected={quote.code === selectedCode}
              onSelect={() => setSelectedCode(current => current === quote.code ? null : quote.code)} />
          </div>
        ))}
      </div>
      {selected ? (
        <div className="index-board-detail" role="region" aria-label={`${selected.name} 明细`}>
          <b>{selected.name}</b>
          <span>今开 {selected.open?.toFixed(2) ?? "--"}</span>
          <span>最高 <em className="up">{selected.high?.toFixed(2) ?? "--"}</em></span>
          <span>最低 <em className="down">{selected.low?.toFixed(2) ?? "--"}</em></span>
          <span>昨收 {selected.preClose?.toFixed(2) ?? "--"}</span>
          <span>振幅 {selected.high !== null && selected.low !== null && selected.preClose ? `${(((selected.high - selected.low) / selected.preClose) * 100).toFixed(2)}%` : "--"}</span>
          <span>成交额 {formatAmount(selected.amount)}</span>
          {selected.up !== null && selected.down !== null ? <span>成分 {selected.up} 涨 / {selected.down} 跌</span> : null}
          {onAskAi ? <button type="button" className="table-action" onClick={onAskAi}>问 AI 怎么看大盘</button> : null}
        </div>
      ) : null}
      {snapshot.missing?.length ? <small className="index-board-missing">未取到：{snapshot.missing.join("、")}</small> : null}
    </div>
  );
}
