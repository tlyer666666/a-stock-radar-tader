import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { fmt, fmtMoney } from "../../domain/formatters";
import { buildTimeShare, TIME_SHARE_SLOTS, type TimeShare, type TimeShareOptions } from "./timeShareModel";

const WIDTH = 760, HEIGHT = 250, VOLUME_HEIGHT = 72, PAD_X = 44, PAD_Y = 14;
const TIME_TICKS: Array<[number, string]> = [[0, "09:30"], [60, "10:30"], [120, "11:30/13:00"], [180, "14:00"], [240, "15:00"]];
const signedPercent = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const slotX = (slot: number) => PAD_X + (slot / (TIME_SHARE_SLOTS - 1)) * (WIDTH - PAD_X * 2);
const priceY = (price: number, scale: TimeShare["scale"]) =>
  PAD_Y + ((scale.max - price) / Math.max(1e-9, scale.max - scale.min)) * (HEIGHT - PAD_Y * 2);
const priceTone = (value: number, preClose: number) => (value > preClose ? "red" : value < preClose ? "green" : "");

const StaticTimeSharePriceLayers = memo(function StaticTimeSharePriceLayers({ share }: { share: TimeShare }) {
  const { points, preClose, scale } = share;
  const levels = [1, 0.5, 0, -0.5, -1].map(ratio => preClose + (scale.max - preClose) * ratio);
  const priceLine = points.map(point => `${slotX(point.slot)},${priceY(point.price, scale)}`).join(" ");
  const averageLine = points.map(point => `${slotX(point.slot)},${priceY(point.average, scale)}`).join(" ");
  const area = `${slotX(points[0]!.slot)},${priceY(preClose, scale)} ${priceLine} ${slotX(points.at(-1)!.slot)},${priceY(preClose, scale)}`;

  return (
    <g className="time-share-static-price-layers">
      {levels.map((level, index) => (
        <g key={index}>
          <line x1={PAD_X} x2={WIDTH - PAD_X} y1={priceY(level, scale)} y2={priceY(level, scale)} className={index === 2 ? "time-share-preclose" : "grid-line"} />
          <text x={PAD_X - 4} y={priceY(level, scale) + 4} textAnchor="end" className={`chart-axis-text ${priceTone(level, preClose)}`}>{fmt(level)}</text>
          <text x={WIDTH - PAD_X + 4} y={priceY(level, scale) + 4} className={`chart-axis-text ${priceTone(level, preClose)}`}>{signedPercent((level / preClose - 1) * 100)}</text>
        </g>
      ))}
      {TIME_TICKS.slice(1, -1).map(([slot]) => (
        <line key={slot} x1={slotX(slot)} x2={slotX(slot)} y1={PAD_Y} y2={HEIGHT - PAD_Y} className="grid-line" />
      ))}
      <polygon points={area} className="time-share-area" />
      <polyline points={priceLine} className="path time-share-price" />
      <polyline points={averageLine} className="path time-share-average" />
    </g>
  );
});

const StaticTimeShareVolumeLayers = memo(function StaticTimeShareVolumeLayers({ share }: { share: TimeShare }) {
  const { points } = share;
  const maxVolume = Math.max(1, ...points.map(point => point.volume));
  const barWidth = Math.max(1, ((WIDTH - PAD_X * 2) / TIME_SHARE_SLOTS) * 0.7);

  return (
    <g className="time-share-static-volume-layers">
      {points.map(point => {
        const height = (point.volume / maxVolume) * (VOLUME_HEIGHT - 6);
        return (
          <rect
            key={point.slot}
            x={slotX(point.slot) - barWidth / 2}
            y={VOLUME_HEIGHT - height}
            width={barWidth}
            height={Math.max(0.5, height)}
            className={point.rising ? "time-share-bar rise" : "time-share-bar fall"}
          />
        );
      })}
    </g>
  );
});

/** 同花顺式分时：价格线 + 均价线，昨收为中轴，左价右幅，下方逐分钟成交量。 */
function TimeShareChart({ rows, preClose: sourcePreClose = null, assetType, unitsPerLot, volumeUnit }: { rows: Array<Record<string, unknown>> } & TimeShareOptions) {
  const share = useMemo(() => buildTimeShare(rows, { preClose: sourcePreClose, assetType, unitsPerLot, volumeUnit }), [rows, sourcePreClose, assetType, unitsPerLot, volumeUnit]);
  const [hover, setHover] = useState<number | null>(null);
  const priceSvgRef = useRef<SVGSVGElement>(null);
  const volumeSvgRef = useRef<SVGSVGElement>(null);
  const cachedRectRef = useRef<{ left: number; width: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingSlotRef = useRef<number | null>(null);

  useEffect(() => {
    const invalidateRect = () => {
      cachedRectRef.current = null;
    };
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        const node = priceSvgRef.current ?? volumeSvgRef.current;
        if (!node) {
          cachedRectRef.current = null;
          return;
        }
        const r = node.getBoundingClientRect();
        cachedRectRef.current = r.width > 0 ? { left: r.left, width: r.width } : null;
      });
      if (priceSvgRef.current) observer.observe(priceSvgRef.current);
      if (volumeSvgRef.current) observer.observe(volumeSvgRef.current);
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("resize", invalidateRect);
      window.addEventListener("scroll", invalidateRect, true);
    }
    return () => {
      observer?.disconnect();
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("resize", invalidateRect);
        window.removeEventListener("scroll", invalidateRect, true);
      }
      if (rafRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, [share]);

  if (!share) return <div className="empty-inline">暂无分时数据</div>;
  const { points, preClose, scale } = share;
  const selected = hover === null ? points.at(-1)! : points.reduce((best, point) => Math.abs(point.slot - hover) < Math.abs(best.slot - hover) ? point : best, points[0]!);

  const captureRect = (event: MouseEvent<SVGSVGElement>) => {
    const r = event.currentTarget.getBoundingClientRect();
    cachedRectRef.current = { left: r.left, width: r.width };
  };
  const move = (event: MouseEvent<SVGSVGElement>) => {
    const rect = cachedRectRef.current || event.currentTarget.getBoundingClientRect();
    if (!cachedRectRef.current) cachedRectRef.current = { left: rect.left, width: rect.width };
    if (rect.width <= 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const slot = Math.max(0, Math.min(TIME_SHARE_SLOTS - 1, Math.round(((ratio * WIDTH - PAD_X) / (WIDTH - PAD_X * 2)) * (TIME_SHARE_SLOTS - 1))));
    pendingSlotRef.current = slot;
    if (typeof window?.requestAnimationFrame !== "function") {
      setHover(slot);
      return;
    }
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      setHover(pendingSlotRef.current);
    });
  };
  const leave = () => {
    pendingSlotRef.current = null;
    if (rafRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setHover(null);
  };
  const tone = (value: number) => priceTone(value, preClose);
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
      <svg ref={priceSvgRef} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="分时走势" onMouseEnter={captureRect} onMouseMove={move} onMouseLeave={leave}>
        <StaticTimeSharePriceLayers share={share} />
        <g className="chart-crosshair-layer">
          {hover !== null && <>
            <line x1={slotX(selected.slot)} x2={slotX(selected.slot)} y1={PAD_Y} y2={HEIGHT - PAD_Y} className="chart-crosshair" />
            <line x1={PAD_X} x2={WIDTH - PAD_X} y1={priceY(selected.price, scale)} y2={priceY(selected.price, scale)} className="chart-crosshair" />
            <circle cx={slotX(selected.slot)} cy={priceY(selected.price, scale)} r="3" className="chart-crosshair-dot" />
          </>}
        </g>
      </svg>
      <svg ref={volumeSvgRef} viewBox={`0 0 ${WIDTH} ${VOLUME_HEIGHT}`} preserveAspectRatio="none" className="time-share-volume" role="img" aria-label="分时成交量" onMouseEnter={captureRect} onMouseMove={move} onMouseLeave={leave}>
        <StaticTimeShareVolumeLayers share={share} />
        <g className="chart-crosshair-layer">
          {hover !== null && <line x1={slotX(selected.slot)} x2={slotX(selected.slot)} y1={0} y2={VOLUME_HEIGHT} className="chart-crosshair" />}
        </g>
      </svg>
      <div className="time-share-labels">{TIME_TICKS.map(([slot, label]) => <span key={slot} style={{ left: `${(slotX(slot) / WIDTH) * 100}%` }}>{label}</span>)}</div>
    </div>
  );
}

export default memo(TimeShareChart);
