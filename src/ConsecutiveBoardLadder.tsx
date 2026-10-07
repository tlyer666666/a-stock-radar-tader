import { useMemo, useState } from 'react';
import { boardMetric, buildConsecutiveBoardGroups, type BoardStock, type BoardSort } from './consecutiveBoardGroups';
import './watch-ladder.css';
export default function ConsecutiveBoardLadder({ rows, onOpen }: { rows: BoardStock[]; onOpen: (stock: BoardStock) => void }) {
  const [sort, setSort] = useState<BoardSort>({ key: 'firstSeal', direction: 'asc' });
  const ladder = useMemo(() => buildConsecutiveBoardGroups(rows, sort), [rows, sort]);
  const changeSort = (key: BoardSort['key']) => setSort(current => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }));
  const metric = (value: unknown, unit: string) => { const parsed = boardMetric(value); return parsed === null ? '待补' : `${unit === '%' ? parsed.toFixed(2) : parsed}${unit}`; };
  return <section className="panel consecutive-board-panel board-ladder" aria-label="连板梯队">
    <header className="board-ladder-heading"><div><h3>连板梯队</h3><span>{ladder.asOf || '日期待核验'} · {ladder.total} 只</span></div><div className="board-ladder-sorts" role="group" aria-label="层内排序"><span>层内排序</span>{([{ key: 'firstSeal', label: '首次封板' }, { key: 'openBoard', label: '开板次数' }, { key: 'turnover', label: '换手率' }] as const).map(item => <button key={item.key} onClick={() => changeSort(item.key)} aria-pressed={sort.key === item.key}>{item.label} {sort.key === item.key ? sort.direction === 'asc' ? '↑' : '↓' : '↕'}</button>)}</div></header>
    {ladder.groups.length ? <div className="board-ladder-groups">{ladder.groups.map(group => <section className="board-ladder-level" key={group.height} data-board-height={group.height} aria-label={`${group.height}连板 ${group.stocks.length}只`}>
      <div className="board-ladder-height"><strong>{group.height}<small>板</small></strong><span>{group.stocks.length} 只</span></div>
      <div className="board-ladder-stocks">{group.stocks.map(stock => <button key={stock.code} className="board-ladder-stock" data-code={stock.code} onClick={() => onOpen(stock)}><div><strong>{stock.name}</strong><code>{stock.code}</code><span className="board-stock-industry" title={stock.industry || '板块待补'}>{stock.industry || '板块待补'}</span></div><dl><div><dt>首次封板</dt><dd>{stock.firstSealTime || '待补'}</dd></div><div><dt>开板</dt><dd>{metric(stock.openBoardCount, '次')}</dd></div><div><dt>换手</dt><dd>{metric(stock.turnover, '%')}</dd></div></dl></button>)}</div>
    </section>)}</div> : <p className="board-ladder-empty">{rows.length ? '这批涨停数据中没有可确认的二连板及以上股票' : '尚未取得当日涨停池，暂不能显示连板梯队'}</p>}
    {ladder.conflicts > 0 && <p className="board-ladder-empty">{ladder.conflicts} 只股票的连板记录存在冲突，暂不归入梯队。</p>}
  </section>;
}
