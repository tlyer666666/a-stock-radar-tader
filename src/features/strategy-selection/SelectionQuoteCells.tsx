import { RefreshCw } from 'lucide-react';
import { createNumberFormatters } from '../../domain/formatters';
import { formatShanghaiDateTime } from '../../dateUtils';
import type { SelectionQuoteEntry } from './useSelectionQuotes';
const numeric = (value: unknown) => value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
const { fmt, pct, money, unit } = createNumberFormatters(numeric, { fmtDigits: 2, pctDigits: 2 });
const clockOf = (value: string | null | undefined) => (formatShanghaiDateTime(value || '').match(/\d{2}:\d{2}:\d{2}/) || [''])[0];
/** 现价格：第一行现价 + 涨跌幅，第二行时间与选股收盘；行情状态和来源放在悬停提示里，行高更紧凑。 */
export function SelectionQuotePrice({ entry, selectionClose }: { entry?: SelectionQuoteEntry | undefined; selectionClose?: number | null | undefined }) {
  const quote = entry?.quote;
  const timeText = quote ? (quote.quoteAt ? `行情 ${formatShanghaiDateTime(quote.quoteAt)}` : `获取 ${formatShanghaiDateTime(quote.fetchedAt)}（源未提供行情时间）`) : '';
  const detail = quote ? `${entry?.error ? '上次行情 · 更新失败' : quote.marketStatus || '行情快照'} · ${quote.source} · ${timeText}` : '';
  return <>
    <span className="selection-quote-main"><b>{fmt(quote?.latest, 2)}</b><em className={quote?.changePct === null || quote?.changePct === undefined ? '' : quote.changePct >= 0 ? 'red' : 'green'}>{pct(quote?.changePct)}</em></span>
    <div className="selection-quote-context">{quote ? <small className="strategy-stock-reasons selection-quote-meta" title={detail}>{entry?.error ? '上次行情 · 更新失败 · ' : ''}{quote.quoteAt ? clockOf(quote.quoteAt) : `${clockOf(quote.fetchedAt)} 获取`} · 选股收盘 {fmt(selectionClose, 2)}</small>
      : <small className="strategy-stock-reasons">{entry?.error ? '行情更新失败，可刷新重试' : '行情待更新'} · 选股收盘 {fmt(selectionClose, 2)}</small>}</div>
  </>;
}
export function SelectionQuoteLiquidity({ entry }: { entry?: SelectionQuoteEntry | undefined }) {
  const quote = entry?.quote;
  // 行情已到但缺某一项时就地写「暂缺」，不再另起一行重复说明（行高更紧凑）。
  const missing = (value: number | null | undefined) => Boolean(quote) && value === null;
  return <><span title={missing(quote?.turnover) ? '数据源本次没有提供换手率' : undefined}>换手 {missing(quote?.turnover) ? '暂缺' : unit(quote?.turnover, 2, '%')}</span>
    <small className="strategy-stock-reasons" title={missing(quote?.amount) ? '数据源本次没有提供成交额' : undefined}>成交额 {missing(quote?.amount) ? '暂缺' : money(quote?.amount)}</small></>;
}
export function SelectionQuoteControls({ total, loading, live, seconds, failed, onRefresh }: {
  total: number; loading: boolean; live: boolean; seconds: number; failed: number; onRefresh: () => void;
}) {
  if (!total) return null;
  return <div className="selection-quote-controls" aria-busy={loading}><small>当前页行情 · {live ? `每 ${seconds} 秒自动刷新` : '自动刷新已暂停'}{failed ? ` · ${failed} 只更新失败` : ''} · 不改变选股结果</small>
    <button type="button" className="secondary-btn" disabled={loading} onClick={onRefresh}><RefreshCw size={14} className={loading ? 'spin' : ''} />{loading ? '更新行情中' : '刷新当前页行情'}</button></div>;
}
