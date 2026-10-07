import { useEffect, useId, useRef, useState } from 'react';
import { Search, Target, X } from 'lucide-react';
import type { StrategyBacktestRequest } from './StrategySignalsView';
import { buildManualSignalTestRequest, eligibleSignalTestStocks, type SignalTestStrategy } from './signalTestRequest';

export default function SignalStockTester({ strategy, strategies, onStrategy, onBacktest }: {
  strategy: SignalTestStrategy; strategies?: SignalTestStrategy[]; onStrategy?: (id: string) => void;
  onBacktest: (request: StrategyBacktestRequest) => void;
}) {
  const [query, setQuery] = useState('');
  const [stock, setStock] = useState<Security | null>(null);
  const [choices, setChoices] = useState<Security[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const generation = useRef(0);
  const listId = useId();
  useEffect(() => {
    const token = ++generation.current;
    if (!query.trim() || stock || composing) { setBusy(false); return; }
    setBusy(true); setError(''); setSearched(false);
    const timer = window.setTimeout(() => {
      Promise.resolve().then(() => window.stockApi.search(query.trim())).then(rows => {
        if (token !== generation.current) return;
        setChoices(eligibleSignalTestStocks(rows)); setSearched(true);
      }).catch(reason => {
        if (token === generation.current) { setChoices([]); setError(reason instanceof Error ? reason.message : '股票搜索失败'); }
      }).finally(() => { if (token === generation.current) setBusy(false); });
    }, 250);
    return () => { window.clearTimeout(timer); generation.current += 1; };
  }, [query, stock, composing]);
  const select = (s: Security) => {
    generation.current += 1; setStock(s); setQuery(`${s.name} ${s.code}`);
    setChoices([]); setExpanded(false); setBusy(false); setError(''); setCursor(-1);
  };
  const request = buildManualSignalTestRequest(stock, strategy);
  return <section className="signal-stock-tester" aria-label="指定股票测试">
    <div className="signal-test-heading"><Target size={18} /><div><h3>指定股票测试</h3><p>选一只股票，使用「{strategy.name}」回放历史信号。</p></div></div>
    <div className="signal-test-controls">
      {strategies && onStrategy && <label className="signal-test-strategy"><span>测试策略</span><select aria-label="指定股票的测试策略" value={strategy.id} onChange={e => onStrategy(e.target.value)}>{strategies.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <div className="signal-test-search">
        <label htmlFor={listId + '-input'}>股票代码或名称</label>
        <div className="signal-test-input"><Search size={16} /><input id={listId + '-input'} role="combobox" aria-label="测试股票：代码或名称"
          placeholder="例如：000001 或 平安银行" value={query} autoComplete="off"
          aria-autocomplete="list" aria-controls={listId} aria-expanded={expanded && choices.length > 0}
          aria-activedescendant={expanded && cursor >= 0 && choices[cursor] ? `${listId}-${cursor}` : undefined}
          onFocus={() => setExpanded(true)} onBlur={e => { if (!e.currentTarget.parentElement?.parentElement?.contains(e.relatedTarget as Node)) setExpanded(false); }}
          onCompositionStart={() => { generation.current += 1; setComposing(true); setBusy(false); }}
          onCompositionEnd={() => setComposing(false)}
          onChange={e => { generation.current += 1; setQuery(e.target.value); setStock(null); setChoices([]); setError(''); setSearched(false); setExpanded(true); setCursor(-1); }}
          onKeyDown={e => {
            if (composing || e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Escape') { setExpanded(false); setCursor(-1); }
            if (e.key === 'ArrowDown' && choices.length) { e.preventDefault(); setExpanded(true); setCursor(i => (i + 1) % choices.length); }
            if (e.key === 'ArrowUp' && choices.length) { e.preventDefault(); setExpanded(true); setCursor(i => i <= 0 ? choices.length - 1 : i - 1); }
            if (e.key === 'Enter' && expanded && choices.length) { e.preventDefault(); const next = choices[Math.max(0, cursor)]; if (next) select(next); }
          }} />
          {query && <button className="signal-test-clear" aria-label="清除测试股票" onClick={() => { generation.current += 1; setQuery(''); setStock(null); setChoices([]); setError(''); setSearched(false); }}><X size={15} /></button>}
        </div>
        {expanded && choices.length > 0 && <div id={listId} role="listbox" aria-label="测试股票搜索结果" className="signal-test-results">{choices.map((s,i) => <button key={s.secid} id={`${listId}-${i}`} role="option" aria-selected={cursor === i} onMouseDown={e => e.preventDefault()} onClick={() => select(s)}><b>{s.name}</b><span>{s.code}</span><small>{s.marketName || 'A股'}</small></button>)}</div>}
      </div>
      <button className="primary-btn" disabled={!request} onClick={() => { if (request) onBacktest(request); }}><Target size={16} />测试这只股票</button>
    </div>
    <div className="signal-test-status" role="status">{busy ? '搜索中…' : error ? `搜索失败：${error}` : stock ? `已选 ${stock.name}（${stock.code}） · 当前策略 ${strategy.name}` : searched && !choices.length ? '没有可测试的非ST A股，请更换代码或名称。' : '无需当前命中即可测试；单股结果不代表策略整体胜率。'}</div>
  </section>;
}
