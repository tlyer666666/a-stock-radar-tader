'use strict';

// Publish fixed categories, never provider bodies, URLs, credentials or raw errors.
const REASONS = {
  capacity: ['本机请求队列繁忙', '减少同时运行的扫描，待队列空闲后重试。'],
  access: ['来源拒绝访问', '核对数据源授权、服务状态及网络访问条件后重试。'],
  rate: ['来源限制请求频率', '稍后重试，避免连续强制刷新。'],
  timeout: ['请求超时', '检查网络或代理及来源状态，恢复后重试。'],
  network: ['网络连接失败', '检查网络、DNS或代理是否能访问行情来源。'],
  data: ['数据为空或未通过完整性核对', '核对数据日期与来源字段完整度；保留原有核验口径后重试。'],
  unavailable: ['来源暂不可用，原因未明确', '本轮不能确定上游原因；检查来源状态后重新选股。']
};
function classifySelectionFailure(error) {
  const codes = [error?.code, error?.cause?.code, error?.cause?.cause?.code].join(' ');
  const status = Number(error?.status || error?.cause?.status);
  const message = String(typeof error === 'string' ? error : error?.message || '').slice(0, 4000);
  let category = 'unavailable';
  if (/QUEUE_FULL|QUEUE_TIMEOUT/.test(codes)) category = 'capacity';
  else if ([401, 403].includes(status) || /\b(?:401|403)\b|拒绝访问|未授权|无权限/.test(message)) category = 'access';
  else if (status === 429 || /\b429\b|限流|限制请求频率|too many requests/i.test(message)) category = 'rate';
  else if (/TIMEOUT|TIMEDOUT/.test(codes) || /timeout|timed out|超时/i.test(message)) category = 'timeout';
  else if (/ECONN|ENOTFOUND|EAI_AGAIN|EHOST|ENET|CERT|UND_ERR_CONNECT/.test(codes) || /fetch failed|network|socket|DNS|连接失败|连接重置|证书/i.test(message)) category = 'network';
  else if (/TREND_DATA_UNAVAILABLE/.test(codes) || /字段|空行情|无有效|缺少|缺失|日期不符|核验|原价|成交额|数据源返回\s*rc/i.test(message)) category = 'data';
  return { category, label: REASONS[category][0], hint: REASONS[category][1] };
}
const SOURCE_LABELS = { eastmoney: '东方财富', 'sohu+tencent-raw': '搜狐原价与腾讯交叉核验', 'tencent-qfq': '腾讯前复权', 'tencent-csi-000985': '腾讯中证全指', 'sina-all-a': '新浪名单' };
function buildSelectionDiagnostics({ pools = [], universe = [], histories = [], benchmark, watchHistories = [], sources = [] } = {}) {
  const counts = new Map();
  const add = (rows, stage) => {
    for (const result of rows) {
      if (result?.ok && Array.isArray(result.value) && result.value.length) continue;
      // A valid empty limit-up pool is a completed read, unlike empty daily history.
      if (stage === 'limit-pool' && result?.ok) continue;
      const reason = result?.failure || classifySelectionFailure(result?.ok ? '空行情或缺少必要字段' : result?.error);
      const key = `${stage}:${reason.category}`;
      const previous = counts.get(key);
      counts.set(key, { stage, ...reason, count: (previous?.count || 0) + 1 });
    }
  };
  add(pools, 'limit-pool'); add(universe, 'universe'); add(histories, 'history'); add(watchHistories, 'watchlist-history');
  if (benchmark) add([benchmark], 'benchmark');
  const safeSources = (Array.isArray(sources) ? sources : []).filter(item => SOURCE_LABELS[item?.source]).slice(0, 16).map(item => ({
    source: SOURCE_LABELS[item.source], stage: item.stage === 'benchmark' ? 'benchmark' : 'history',
    successes: Math.max(0, Math.trunc(Number(item.successes) || 0)), failures: Math.max(0, Math.trunc(Number(item.failures) || 0)),
    ...(item.status === 'error' ? { reason: classifySelectionFailure(item.detail).label } : {})
  }));
  return { failures: [...counts.values()].slice(0, 32), sources: safeSources };
}
module.exports = { classifySelectionFailure, buildSelectionDiagnostics };
