import { memo, useMemo, useState } from "react";
import { fmt, fmtMoney } from "../../domain/formatters";
import { buildTimeShare, TIME_SHARE_SLOTS, type TimeShareOptions } from "./timeShareModel";

const WIDTH = 760, HEIGHT = 250, VOLUME_HEIGHT = 72, PAD_X = 44, PAD_Y = 14;
const TIME_TICKS: Array<[number, string]> = [[0, "09:30"], [60, "10:30"], [120, "11:30/13:00"], [180, "14:00"], [240, "15:00"]];
const signedPercent = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

/** 同花顺式分时：价格线 + 均价线，昨收为中轴，左价右幅，下方逐分钟成交量。 */
function TimeShareChart({ rows, preClose: sourcePreClose = null, assetType, unitsPerLot, volumeUnit }: { rows: any[] } & TimeShareOptions) {
  const share = useMemo(() => buildTimeShare(rows, { preClose: sourcePreClose, assetType, unitsPerLot, volumeUnit }), [rows, sourcePreClose, assetType, unitsPerLot, volumeUnit]);
  const [hover, setHover] = useState<number | null>(null);
  if (!share) return <div className="empty-inline">暂无分时数据</div>;
  const { points, preClose, scale } = share;
  const x = (slot: number) => PAD_X + (slot / (TIME_SHARE_SLOTS - 1)) * (WIDTH - PAD_X * 2);
  const y = (price: number) => PAD_Y + ((scale.max - price) / Math.max(1e-9, scale.max - scale.min)) * (HEIGHT - PAD_Y * 2);
  const maxVolume = Math.max(1, ...points.map(point => point.volume));
  const barWidth = Math.max(1, (WIDTH - PAD_X * 2) / TIME_SHARE_SLOTS * 0.7);
  const priceLine = points.map(point => `${x(point.slot)},${y(point.price)}`).join(" ");
  const averageLine = points.map(point => `${x(point.slot)},${y(point.average)}`).join(" ");
  const area = `${x(points[0]!.slot)},${y(preClose)} ${priceLine} ${x(points.at(-1)!.slot)},${y(preClose)}`;
  const selected = hover === null ? points.at(-1)! : points.reduce((best, point) => Math.abs(point.slot - hover) < Math.abs(best.slot - hover) ? point : best, points[0]!);
  const levels = [1, 0.5, 0, -0.5, -1].map(ratio => preClose + (scale.max - preClose) * ratio);
  const move = (event: any) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const slot = Math.round(((ratio * WIDTH - PAD_X) / (WIDTH - PAD_X * 2)) * (TIME_SHARE_SLOTS - 1));
    setHover(Math.max(0, Math.min(TIME_SHARE_SLOTS - 1, slot)));
  };
  const tone = (value: number) => value > preClose ? "red" : value < preClose ? "green" : "";
  return (
    <div className="chart-wrap time-share-chart">
      <div className="chart-ohlc-strip">
        <b>{share.date} {selected.time}</b>
        <span>价格 <em className={tone(selected.price)}>{fmt(selected.price)}</em></span>
        <span>涨跌 <em className={tone(selected.price)}>{signedPercent(selected.changePercent)}</em></span>
        <span>均价 <em className="time-share-average-text">{fmt(selected.average)}</em></span>
        <span>量 <em>{fmtMoney(selected.volume)}手</em></span>
        <span>昨收 <em>{fmt(preClose)}</em></span>
        <span>最高 <em className={tone(share.high)}>{fmt(share.high)}</em></span>
        <span>最低 <em className={tone(share.low)}>{fmt(share.low)}</em></span>
        {share.totalAmount !== null && <span>总额 <em>{fmtMoney(share.totalAmount)}</em></span>}
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="分时走势" onMouseMove={move} onMouseLeave={() => setHover(null)}>
        {levels.map((level, index) => (
          <g key={index}>
            <line x1={PAD_X} x2={WIDTH - PAD_X} y1={y(level)} y2={y(level)} className={index === 2 ? "time-share-preclose" : "grid-line"} />
            <text x={PAD_X - 4} y={y(level) + 4} textAnchor="end" className={`chart-axis-text ${tone(level)}`}>{fmt(level)}</text>
            <text x={WIDTH - PAD_X + 4} y={y(level) + 4} className={`chart-axis-text ${tone(level)}`}>{signedPercent((level / preClose - 1) * 100)}</text>
          </g>
        ))}
        {TIME_TICKS.slice(1, -1).map(([slot]) => <line key={slot} x1={x(slot)} x2={x(slot)} y1={PAD_Y} y2={HEIGHT - PAD_Y} className="grid-line" />)}
        <polygon points={area} className="time-share-area" />
        <polyline points={priceLine} className="path time-share-price" />
        <polyline points={averageLine} className="path time-share-average" />
        {hover !== null && <>
          <line x1={x(selected.slot)} x2={x(selected.slot)} y1={PAD_Y} y2={HEIGHT - PAD_Y} className="chart-crosshair" />
          <line x1={PAD_X} x2={WIDTH - PAD_X} y1={y(selected.price)} y2={y(selected.price)} className="chart-crosshair" />
          <circle cx={x(selected.slot)} cy={y(selected.price)} r="3" className="chart-crosshair-dot" />
        </>}
      </svg>
      <svg viewBox={`0 0 ${WIDTH} ${VOLUME_HEIGHT}`} preserveAspectRatio="none" className="time-share-volume" role="img" aria-label="分时成交量" onMouseMove={move} onMouseLeave={() => setHover(null)}>
        {points.map(point => {
          const height = (point.volume / maxVolume) * (VOLUME_HEIGHT - 6);
          return <rect key={point.slot} x={x(point.slot) - barWidth / 2} y={VOLUME_HEIGHT - height} width={barWidth} height={Math.max(0.5, height)} className={point.rising ? "time-share-bar rise" : "time-share-bar fall"} />;
        })}
        {hover !== null && <line x1={x(selected.slot)} x2={x(selected.slot)} y1={0} y2={VOLUME_HEIGHT} className="chart-crosshair" />}
      </svg>
      <div className="time-share-labels">{TIME_TICKS.map(([slot, label]) => <span key={slot} style={{ left: `${(x(slot) / WIDTH) * 100}%` }}>{label}</span>)}</div>
    </div>
  );
}

export default memo(TimeShareChart);
