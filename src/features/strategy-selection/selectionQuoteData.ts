/** Independent display quotes. Never feed these values back into rule selection. */
export type SelectionQuote = {
  latest: number; changePct: number | null; turnover: number | null; amount: number | null;
  source: string; quoteAt: string; fetchedAt: string; marketStatus: string;
};
type Listener = (quote: SelectionQuote | null, error: string) => void;
const number = (value: unknown): number | null => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const timestamp = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const input = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value) ? `${value.replace(' ', 'T')}+08:00` : value;
  const time = Date.parse(input);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
};
const labels: Record<string, string> = { ths_free: '同花顺免费行情', ths: '同花顺', fuyao: '同花顺扶摇', eastmoney: '东方财富', tencent: '腾讯行情' };
const invalid = (message: string) => Object.assign(new Error(message), { name: 'SelectionQuoteError' });
export function normalizeSelectionQuote(security: Security, response: any): SelectionQuote {
  const quote = response?.quote;
  if (quote?.code && String(quote.code) !== security.code) throw invalid('行情代码不匹配，请重试');
  const missing = Array.isArray(quote?.missingFields) ? quote.missingFields : [];
  const field = (key: string) => missing.includes(key) ? null : number(quote?.[key]);
  const latest = field('latest');
  const preClose = field('preClose');
  const positive = (key: string) => { const value = field(key); return value !== null && value >= 0 ? value : null; };
  const provider = String(response?.actualProvider || quote?.source || '');
  const marketStatus = typeof quote?.marketStatus === 'string' ? quote.marketStatus : '';
  // Fuyao timestamps the provider response, not the individual security's trade.
  // Keep it out of both the display quote time and cross-source rollback checks.
  const hasQuoteTime = quote?.quoteAtIsTradeTime !== false && (provider !== 'fuyao' || quote?.quoteAtIsTradeTime === true);
  const quoteAt = hasQuoteTime ? timestamp(quote?.quoteAt || quote?.updatedAt) : '';
  if ((latest === null || latest <= 0) && preClose !== null && preClose > 0) {
    const isSuspendedOrPending = marketStatus.includes('停牌') || marketStatus.includes('闭市') || marketStatus.includes('盘前') || marketStatus.includes('休市') || positive('volume') === 0;
    if (isSuspendedOrPending) {
      return { latest: preClose, changePct: 0, turnover: null, amount: null,
        source: labels[provider] || '来源未提供', quoteAt,
        fetchedAt: timestamp(response?.updatedAt), marketStatus: marketStatus || '停牌/未开盘' };
    }
  }
  if (latest === null || latest <= 0) throw invalid('行情未提供有效最新价，请重试');
  return { latest, changePct: field('changePct'), turnover: positive('turnover'), amount: positive('amount'),
    source: labels[provider] || '来源未提供', quoteAt,
    fetchedAt: timestamp(response?.updatedAt), marketStatus };
}

/** Shared concurrency stays bounded even when views detach while IPC is still running. */
export function createSelectionQuoteFeed({ fetchQuote, now = Date.now, isVisible = () => typeof document === 'undefined' || !document.hidden }: {
  fetchQuote: (security: Security) => Promise<any>; now?: () => number; isVisible?: () => boolean;
}) {
  const cache = new Map<string, { quote: SelectionQuote; at: number; lastTradeAt: string }>();
  const jobs = new Map<string, { security: Security; listeners: Set<Listener>; running: boolean; outcome?: { quote: SelectionQuote | null; error: string } }>();
  let running = 0;
  const pump = () => {
    if (!isVisible()) return;
    for (const [key, job] of jobs) {
      if (running >= 3) break;
      if (job.running) continue;
      job.running = true; running++;
      void (async () => {
        const complete = (quote: SelectionQuote | null, error: string) => {
          job.outcome = { quote, error };
          for (const listener of job.listeners) listener(quote, error);
          job.listeners.clear();
        };
        // The deadline completes the UI read, but IPC may still be running.
        // Keep this job and its physical slot until the original promise drains.
        const timer = setTimeout(() => complete(null, '行情请求超时，请重试'), 10000);
        try {
          const raw = await fetchQuote(job.security);
          if (job.outcome) return;
          const quote = normalizeSelectionQuote(job.security, raw);
          const lastTradeAt = cache.get(key)?.lastTradeAt || '';
          if (lastTradeAt && quote.quoteAt && quote.quoteAt < lastTradeAt) throw invalid('行情时间倒退，保留上次行情');
          // A source without trade time must not erase the last known timestamp.
          // Keep this watermark inside the bounded cache so eviction releases both.
          cache.delete(key); cache.set(key, { quote, at: now(), lastTradeAt: quote.quoteAt || lastTradeAt });
          while (cache.size > 100) cache.delete(cache.keys().next().value!);
          complete(quote, '');
        } catch (reason) {
          const error = reason instanceof Error && reason.name === 'SelectionQuoteError' ? reason.message : '行情更新失败，请稍后重试';
          if (!job.outcome) complete(null, error);
        } finally {
          clearTimeout(timer);
          if (jobs.get(key) === job) jobs.delete(key);
          running--; pump();
        }
      })();
    }
  };
  return {
    resume: pump,
    subscribe(security: Security, listener: Listener, force = false) {
      const key = `${security.secid}|${security.code}`;
      const cached = cache.get(key);
      if (!force && cached && now() - cached.at < 15_000) { listener(cached.quote, ''); return () => {}; }
      let job = jobs.get(key);
      if (!job) { job = { security, listeners: new Set(), running: false }; jobs.set(key, job); }
      if (job.outcome) { listener(job.outcome.quote, job.outcome.error); return () => {}; }
      job.listeners.add(listener); pump();
      return () => { job.listeners.delete(listener); if (!job.listeners.size && !job.running && jobs.get(key) === job) jobs.delete(key); };
    }
  };
}
export const selectionQuoteFeed = createSelectionQuoteFeed({ fetchQuote: security => window.stockApi.getQuoteSnapshot(security) });
