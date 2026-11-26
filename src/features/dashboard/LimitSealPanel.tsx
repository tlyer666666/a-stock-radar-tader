import { Lock } from "lucide-react";
import { fmt } from "../../domain/formatters";
import { useLimitSeals } from "./useLimitSeals";
import {
  formatLots,
  formatSealAmount,
  sealSparkline,
  sealTone,
  sealWarning,
  type BookLevel,
  type LimitSealRecord
} from "./limitSealModel";

const signedAmount = (value: number | null) => value === null ? "--" : `${value > 0 ? "+" : value < 0 ? "-" : ""}${formatSealAmount(Math.abs(value))}`;
const signedPct = (value: number | null) => value === null ? "" : `（${value > 0 ? "+" : ""}${value.toFixed(1)}%）`;

function quoteClock(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 8 * 3600_000).toISOString().slice(11, 19);
}

function BookSide({ label, levels, limitPrice, maxVolume, side }: { label: string; levels: BookLevel[]; limitPrice: number | null; maxVolume: number; side: "ask" | "bid" }) {
  const rows = Array.from({ length: 5 }, (_, index) => levels[index] || null);
  const ordered = side === "ask" ? [...rows].reverse() : rows;
  const max = Math.max(1, maxVolume);
  return (
    <>
      {ordered.map((level, index) => {
        const n = side === "ask" ? 5 - index : index + 1;
        const atLimit = level && limitPrice !== null && Math.abs(level.price - limitPrice) < 0.0005;
        return (
          <tr key={`${side}-${n}`} className={`seal-book-${side}${atLimit ? " at-limit" : ""}`}>
            <th scope="row">{label}{n}</th>
            <td>{level ? fmt(level.price) : "--"}</td>
            <td>
              {level ? <i style={{ width: `${Math.max(2, (level.volumeLots / max) * 100)}%` }} aria-hidden="true" /> : null}
              <span>{level ? Math.round(level.volumeLots).toLocaleString("zh-CN") : "--"}</span>
            </td>
          </tr>
        );
      })}
    </>
  );
}

/** 展示用（纯渲染，便于测试）。 */
export function LimitSealView({ record, lastTickAt }: { record: LimitSealRecord; lastTickAt: number }) {
  const tone = sealTone(record.status);
  const warning = sealWarning(record);
  const spark = sealSparkline(record.history);
  const sealPrice = record.status === "downSealed" ? record.limitDown : record.limitUp;
  const maxBookVolume = Math.max(1, ...record.bids.map(level => level.volumeLots), ...record.asks.map(level => level.volumeLots));
  return (
    <section className={`panel seal-panel tone-${tone}`} aria-label="实时封单">
      <header className="seal-head">
        <div className="seal-title">
          <Lock size={15} aria-hidden="true" />
          <h3>{record.status === "downSealed" ? "实时跌停封单" : "实时涨停封单"}</h3>
          <span className={`seal-chip tone-${tone}`}>{record.statusLabel}</span>
        </div>
        <small title="封单手数以同花顺涨停池为准（同花顺约每 1~10 秒更新一次）；五档盘口用腾讯实时五档（同花顺免费盘口约延迟 1 分钟）">
          {lastTickAt > 0 ? <i className="seal-live" aria-hidden="true" /> : null}
          {record.source ? `${record.source} · ` : ""}行情时间 {quoteClock(record.quoteAt) || "--"}
        </small>
      </header>
      <div className="seal-body">
        <div className="seal-metrics">
          <div className="seal-main">
            <span>封单额</span>
            <strong>{formatSealAmount(record.sealAmount)}</strong>
            <small>{formatLots(record.sealLots)}{sealPrice !== null ? ` @ ${fmt(sealPrice)}` : ""}</small>
          </div>
          <dl>
            <div><dt>封单/流通市值</dt><dd>{record.sealFloatRatio === null ? "--" : `${(record.sealFloatRatio * 100).toFixed(2)}%`}</dd></div>
            <div><dt>1 分钟变化</dt><dd className={record.change1mAmount === null ? "" : record.change1mAmount >= 0 ? "up" : "down"}>{signedAmount(record.change1mAmount)}{signedPct(record.change1mPct)}</dd></div>
            <div><dt>今日峰值</dt><dd>{formatSealAmount(record.peakAmount)}{record.fromPeakPct !== null && record.fromPeakPct < -0.5 ? <em className="down">{` 回落 ${Math.abs(record.fromPeakPct).toFixed(0)}%`}</em> : null}</dd></div>
            <div><dt>现价 / 涨幅</dt><dd>{fmt(record.latest)} <em className={record.changePct === null ? "" : record.changePct >= 0 ? "up" : "down"}>{record.changePct === null ? "" : `${record.changePct > 0 ? "+" : ""}${record.changePct.toFixed(2)}%`}</em></dd></div>
          </dl>
          {spark ? (
            <figure className="seal-spark">
              <svg viewBox="0 0 220 44" preserveAspectRatio="none" role="img" aria-label="封单额走势">
                <path d={spark.area} className="area" />
                <path d={spark.line} className="line" />
              </svg>
              <figcaption>封单额走势（打开后开始记录）</figcaption>
            </figure>
          ) : <p className="seal-spark-empty">封单额走势：变化后开始画线</p>}
          {warning ? <p className="seal-warning" role="status">{warning}</p> : null}
        </div>
        <table className="seal-book" aria-label="五档盘口">
          <tbody>
            <BookSide label="卖" levels={record.asks} limitPrice={record.limitDown} maxVolume={maxBookVolume} side="ask" />
            <tr className="seal-book-mid" aria-hidden="true"><td colSpan={3} /></tr>
            <BookSide label="买" levels={record.bids} limitPrice={record.limitUp} maxVolume={maxBookVolume} side="bid" />
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * 个股页的实时封单面板：订阅这只股票的封单推送；没涨停、也没摸过涨停（未涨停）时不显示，
 * 涨停封死、涨停有抛压、炸板、跌停封死时显示封单、变化、走势和五档盘口。
 */
export default function LimitSealPanel({ code, enabled = true }: { code: string; enabled?: boolean }) {
  const { records, lastTickAt } = useLimitSeals(code ? [code] : [], { owner: "detail", enabled, withHistory: true });
  const record = records[code];
  if (!record || record.status === "open") return null;
  return <LimitSealView record={record} lastTickAt={lastTickAt} />;
}
