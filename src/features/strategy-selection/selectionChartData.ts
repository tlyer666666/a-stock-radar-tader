import { createServiceJobScope } from '../../serviceJobClient';
export type SelectionCandle = { date: string; open: number; high: number; low: number; close: number; volume: number | null; volumeUnit: string };
export type SelectionChart = { rows: SelectionCandle[]; source: string; adjustment: string; updatedAt: string; note: string };
const cache = new Map<string, { data: SelectionChart; at: number; sequence: number }>();
type Job = { security: Security; listeners: Set<(data: SelectionChart | null, error: string) => void>; running: boolean; cacheKey: string; forceRefresh: boolean; sequence: number; cancelling?: boolean; scope: ReturnType<typeof createServiceJobScope> };
const jobs = new Map<string, Job>();
const watchers = new Map<string, Set<(data: SelectionChart | null, error: string) => void>>();
let running = 0;
let sequence = 0;
const keyFor = (security: Security) => `${security.secid}|${security.code}|daily|front`;
const finite = (value: unknown) => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value));
function normalize(response: Awaited<ReturnType<Window['stockApi']['getChart']>>): SelectionChart {
  if (!Array.isArray(response.rows) || !response.rows.length) throw new Error('行情源未返回日K线');
  const rows = response.rows.slice(-3000).map((row): SelectionCandle => {
    const date = String(row.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || !['open', 'high', 'low', 'close'].every(key => finite(row[key]) && Number(row[key]) > 0)) throw new Error('行情数据不完整，请重试');
    const [open, high, low, close] = [Number(row.open), Number(row.high), Number(row.low), Number(row.close)];
    if (high! < Math.max(open!, close!) || low! > Math.min(open!, close!)) throw new Error('行情价格异常，请重试');
    return { date, open: open!, high: high!, low: low!, close: close!, volumeUnit: row.volumeUnit === 'lots' ? '手' : row.volumeUnit === 'shares' ? '股' : '源单位', volume: finite(row.volume) && Number(row.volume) >= 0 ? Number(row.volume) : null };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(rows.map(row => row.date)).size !== rows.length) throw new Error('行情日期重复，请重试');
  return { rows, source: response.source || '来源未提供', adjustment: response.adjustment || '复权口径未提供', updatedAt: response.updatedAt, note: response.note || '' };
}
function pump() {
  if (document.hidden) return;
  for (const [key, job] of jobs) {
    if (running >= 3) break;
    if (job.running) continue;
    job.running = true;
    running++;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      for (const listener of job.listeners) listener(null, 'K线请求超时，请稍后重试');
      void job.scope.cancelAll();
    }, 45_000);
    void job.scope.run(requestId => window.stockApi.getChart(job.security, '101', { limit: 120, adjustment: 'front', forceRefresh: job.forceRefresh, requestId, timeoutMs: 35_000 })).then(normalize).then(data => {
      if (timedOut) return;
      const newer = cache.get(job.cacheKey);
      if (newer && newer.sequence > job.sequence) data = newer.data;
      else {
        cache.delete(job.cacheKey);
        cache.set(job.cacheKey, { data, at: Date.now(), sequence: job.sequence });
      }
      while (cache.size > 100) cache.delete(cache.keys().next().value!);
      for (const listener of watchers.get(job.cacheKey) || []) listener(data, '');
    }).catch((error: unknown) => {
      if (!timedOut) for (const listener of job.listeners) listener(null, error instanceof Error ? error.message : 'K线加载失败');
    }).finally(() => { clearTimeout(timer); if (jobs.get(key) === job) jobs.delete(key); running--; pump(); });
  }
}
// SSR / node 测试里没有 document：只在浏览器环境注册。
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', pump);
export function subscribeSelectionChart(security: Security, listener: (data: SelectionChart | null, error: string) => void, refresh = false) {
  const key = keyFor(security);
  const listeners = watchers.get(key) || new Set();
  listeners.add(listener); watchers.set(key, listeners);
  let subscribed = true;
  const detach = () => { listeners.delete(listener); if (!listeners.size && watchers.get(key) === listeners) watchers.delete(key); };
  const cached = cache.get(key);
  if (!refresh && cached && Date.now() - cached.at < 60_000) {
    listener(cached.data, '');
    return () => { if (!subscribed) return; subscribed = false; detach(); };
  }
  const requestKey = `${key}|${refresh ? 'force' : 'normal'}`;
  let job = jobs.get(requestKey);
  if (!job || job.cancelling) {
    job = { security, listeners: new Set(), running: false, cacheKey: key, forceRefresh: refresh, sequence: ++sequence, scope: createServiceJobScope() };
    jobs.set(requestKey, job);
  }
  job.listeners.add(listener);
  pump();
  return () => {
    if (!subscribed) return;
    subscribed = false;
    detach();
    job.listeners.delete(listener);
    if (!job.listeners.size) {
      if (job.running) queueMicrotask(() => {
        if (!job.listeners.size && jobs.get(requestKey) === job) { job.cancelling = true; void job.scope.cancelAll(); }
      });
      else if (jobs.get(requestKey) === job) jobs.delete(requestKey);
    }
  };
}
