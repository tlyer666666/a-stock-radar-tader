const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCatalog, parseQuotePage, parseClassifications, createSectorExplorer } = require('./sector-explorer.cjs');
const catalog = (kind = 'industry') => `<a href="http://q.10jqka.com.cn/${kind === 'industry' ? 'thshy' : 'gn'}/detail/code/${kind === 'industry' ? '881270' : '308832'}/">${kind === 'industry' ? '元件' : 'PCB概念'}</a>`;
const row = (code = '300964', name = '本川智能', price = '--') => `<tr><td>1</td><td>${code}</td><td>${name}</td><td>${price}</td><td>2.3</td><td>1</td><td>0</td><td>4.5</td><td>1</td><td>4</td><td>1.2亿</td><td>1亿</td><td>10亿</td><td>20</td></tr>`;
const page = (n = 1, total = 1, rows = row()) => `<input id="baseUrl" value='gn/detail'><input id="requestQuery" value='code/308832'><div class="board-hq"><dt>板块涨幅</dt><dd>2.34%</dd><dt>成交额(亿)</dt><dd>12.5</dd><dt>涨跌家数</dt><dd><span>12</span><span>9</span></dd></div><table class="m-table m-pager-table"><thead><tr>${['序号', '代码', '名称', '现价', '涨跌幅%', '涨跌', '涨速%', '换手%', '量比', '振幅%', '成交额', '流通股', '流通市值', '市盈率'].map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table><span class="page_info">${n}/${total}</span>`;
const field = `<p class="threecate">三级行业分类：<span>电子 -- 元件 -- 印制电路板 （共<strong>3</strong>家）</span></p><div id="dateSelect"><a>2026-06-30</a></div><table id="hy3_table_1"><thead><th>股票代码</th><th>股票简称</th></thead><tbody><tr><td>300964</td><td>本川智能</td><td>999</td></tr><tr><td>302132</td><td>中航成飞</td><td>999</td></tr><tr><td>000001</td><td>*ST示例</td><td>999</td></tr></tbody></table>`;
const entry = { id: 'ths:concept:308832', code: '308832', name: 'PCB概念', kind: 'concept', level: null, path: [], classification: '公开概念', sourceUrl: 'https://q.10jqka.com.cn/gn/detail/code/308832/' };
const opts = (fetchHtml, extra = {}) => ({ fetchHtml, seeds: [], ...extra });
test('q catalogs deduplicate only verified links and do not invent levels', () => { const rows = parseCatalog(catalog() + catalog() + '<a href="https://evil.cn/thshy/detail/code/111111/">假的</a>', 'industry'); assert.equal(rows.length, 1); assert.equal(rows[0].level, null); assert.equal(rows[0].id, 'ths:industry:881270'); });
test('quote source metrics retain unknown date and null cells, exact securities and ST filtering', () => { const r = parseQuotePage(page(1, 2, row() + row('302132', '中航成飞', '20') + row('000001', '*ST测试', '2') + row('510300', 'ETF', '4')), entry, 1); assert.equal(r.members.length, 2); assert.equal(r.members[0].latest, null); assert.equal(r.members[0].amount, 120000000); assert.equal(r.asOf, null); assert.equal(r.metrics.amount, 1250000000); assert.equal(r.metrics.rising, 12); assert.equal(r.excluded, 2); assert.equal(r.pagesTotal, 2); });
test('wrong page identity and anti-bot content fail closed', () => { assert.throws(() => parseQuotePage(page().replace('308832', '888888'), entry, 1)); assert.throws(() => parseQuotePage('<html>验证码</html>', entry, 1)); assert.throws(() => parseQuotePage(page(2, 2), entry, 1)); });
test('explicit F10 fields preserve all parent paths without inventing parent members or financial prices', () => { const rows = parseClassifications(field, '300964'); assert.deepEqual(rows.map(x => x.entry.level), [1, 2, 3]); const r = rows.find(x => x.entry.level === 3); assert.deepEqual(r.entry.path, ['电子', '元件', '印制电路板']); assert.equal(r.reportDate, '2026-06-30'); assert.equal(r.members[0].latest, null); assert.equal(r.declared, 3); assert.equal(r.excluded, 1); for (const parent of rows.filter(x => x.entry.level < 3)) { assert.equal(parent.members.length, 0); assert.equal(parent.declared, null); assert.equal(parent.pathOnly, true); } });
test('partial pagination retains fetched members with incomplete coverage and explicit failure', async () => { const s = createSectorExplorer(opts(async (url) => { if (url.includes('/page/'))
    throw new Error('HTTP 401'); return url.includes('/detail/') ? page(1, 2) : catalog(url.includes('/gn/') ? 'concept' : 'industry'); })); await s.getSectorCatalog(); const r = await s.getSectorDetail({ id: entry.id }); assert.equal(r.status, 'partial'); assert.equal(r.coverage.pagesLoaded, 1); assert.equal(r.coverage.pagesTotal, 2); assert.equal(r.coverage.complete, false); assert.equal(r.members.length, 1); assert.match(r.warnings.join(), /401/); });
test('catalog cache, force refresh, independent IDs and unknown URL rejection', async () => { let calls = 0; const s = createSectorExplorer(opts(async (url) => { calls++; return url.includes('/detail/') ? page() : catalog(url.includes('/gn/') ? 'concept' : 'industry'); })); await s.getSectorCatalog(); await s.getSectorCatalog(); assert.equal(calls, 2); await s.getSectorCatalog({ forceRefresh: true }); assert.equal(calls, 4); await s.getSectorDetail({ id: entry.id }); await s.getSectorDetail({ id: entry.id }); assert.equal(calls, 5); await s.getSectorDetail({ id: entry.id, forceRefresh: true }); assert.equal(calls, 6); await assert.rejects(s.getSectorDetail({ id: 'https://evil.test' })); });
test('conflicting duplicate membership removed instead of arbitrarily keeping quote', async () => { const s = createSectorExplorer(opts(async (url) => url.includes('/detail/') ? page(1, 1, row('300964', '本川智能', '10') + row('300964', '本川智能', '11')) : catalog(url.includes('/gn/') ? 'concept' : 'industry'))); await s.getSectorCatalog(); const r = await s.getSectorDetail({ id: entry.id }); assert.equal(r.members.length, 0); assert.ok(r.coverage.invalid >= 1); assert.equal(r.coverage.complete, false); });
test('stale fallback preserves original fetchedAt, unavailable not cached', async () => { let t = 100000, fail = false; const s = createSectorExplorer(opts(async (url) => { if (fail)
    throw new Error('offline'); return url.includes('/detail/') ? page() : catalog(url.includes('/gn/') ? 'concept' : 'industry'); }, { now: () => t })); await s.getSectorCatalog(); const a = await s.getSectorDetail({ id: entry.id }); t += 100000; fail = true; const b = await s.getSectorDetail({ id: entry.id }); assert.equal(b.status, 'stale'); assert.equal(b.fetchedAt, a.fetchedAt); t += 1800001; const c = await s.getSectorDetail({ id: entry.id }); assert.equal(c.status, 'unavailable'); assert.equal(c.metrics, null); });
test('cancellation keeps physical concurrency at two even transport settles later', async () => { let active = 0, max = 0; const releases = []; const s = createSectorExplorer(opts((url, { signal }) => new Promise(resolve => { active++; max = Math.max(max, active); releases.push(() => { active--; resolve(catalog(url.includes('/gn/') ? 'concept' : 'industry')); }); }))); const first = s.getSectorCatalog({ requestId: 'old' }); await new Promise(setImmediate); assert.equal((await s.cancelSectorRequest('old')).cancelled, true); const second = s.getSectorCatalog({ requestId: 'new' }); await new Promise(setImmediate); assert.equal(max, 2); releases.splice(0).forEach(f => f()); await assert.rejects(first, /取消|abort/i); await new Promise(setImmediate); releases.splice(0).forEach(f => f()); await second; assert.equal(max, 2); });
test('default catalog uses only official public directories with no seed or artificial research requests', async () => { const urls = []; const s = createSectorExplorer({ fetchHtml: async url => { urls.push(url); return catalog(url.includes('/gn/') ? 'concept' : 'industry'); } }); const c = await s.getSectorCatalog(); assert.deepEqual(urls.sort(), ['https://q.10jqka.com.cn/gn/', 'https://q.10jqka.com.cn/thshy/']); assert.deepEqual(c.entries.map(x => x.kind).sort(), ['concept', 'industry']); assert.equal(c.coverage.loaded, 2); assert.equal(c.coverage.total, 2); assert.equal(c.coverage.failed, 0); assert.equal(c.coverage.complete, false, 'a flat public directory is not a full hierarchy'); await assert.rejects(s.getSectorDetail({ id: 'research:electronic-cloth' }), /未知板块/); await s.dispose(); });
test('B shares and unrelated Beijing-like prefixes cannot become A-stock members', () => { const r = parseQuotePage(page(1, 1, row('900901', '上海B股', '1') + row('800001', '无效代码', '1') + row('920001', '北京样本', '20')), entry); assert.deepEqual(r.members.map(x => x.code), ['920001']); assert.equal(r.members[0].secid, '0.920001'); });
test('source board amount handles explicit units without double scaling', () => { for (const [raw, expected] of [['12.5', 1250000000], ['12.5亿', 1250000000], ['1200万', 12000000], ['--', null]]) {
    const r = parseQuotePage(page().replace('<dd>12.5</dd>', `<dd>${raw}</dd>`), entry);
    assert.equal(r.metrics.amount, expected);
} });
test('dynamic stock lookup discovers official F10 paths and enables drilldown, with cache and invalid-code rejection', async () => { let calls = 0; const s = createSectorExplorer(opts(async () => { calls++; return field; })); const c = await s.getSectorClassifications({ code: '300964' }); assert.equal(c.entries.length, 3); assert.equal(c.coverage.complete, false); const d = await s.getSectorDetail({ id: c.entries.find(x => x.level === 3).id }); assert.equal(d.entry.level, 3); assert.equal(d.members.length, 2); const parent = await s.getSectorDetail({ id: c.entries.find(x => x.level === 1).id }); assert.equal(parent.members.length, 0); assert.equal(parent.coverage.declared, null); assert.equal(parent.coverage.complete, false); assert.equal(calls, 1); await s.getSectorClassifications({ code: '300964' }); assert.equal(calls, 1); await s.getSectorClassifications({ code: '300964', forceRefresh: true }); assert.equal(calls, 2); await assert.rejects(s.getSectorClassifications({ code: '900901' })); await assert.rejects(s.getSectorClassifications({ code: '../../secret' })); });
test('empty component response cannot be reported complete zero members', () => assert.throws(() => parseQuotePage(page(1, 1, ''), entry), /成分/));
test("changed source column order fails closed rather than relabeling values", () => { assert.throws(() => parseQuotePage(page().replace("<th>成交额</th>", "<th>流通市值</th>"), entry), /列/); });

test('a failed official directory reports unknown total and an explicit failed source', async () => {
  const s = createSectorExplorer(opts(async url => { if (url.includes('/gn/')) throw new Error('HTTP 401'); return catalog(); }));
  const result = await s.getSectorCatalog();
  assert.equal(result.status, 'partial'); assert.equal(result.coverage.loaded, 1);
  assert.equal(result.coverage.total, null); assert.equal(result.coverage.failed, 1);
  assert.equal(result.coverage.complete, false); await s.dispose();
});

test('request deadline aborts transport and queued work but retains physical ownership until settlement', async () => {
  let release, calls = 0;
  const physical = new Promise(resolve => { release = resolve; });
  const signals = [];
  const s = createSectorExplorer(opts(async (_, { signal }) => { calls++; signals.push(signal); await physical; return catalog(); }));
  const request = s.getSectorCatalog({ requestId: 'deadline', timeoutMs: 10 });
  const rejected = assert.rejects(request, { name: 'TimeoutError', code: 'JOB_TIMEOUT' });
  await new Promise(resolve => setTimeout(resolve, 20));
  try {
    assert.equal(signals.every(signal => signal.aborted), true);
    assert.equal(s.getDiagnostics().active, 2); assert.equal(calls, 2);
  } finally { release(); await rejected; await s.dispose(); }
  assert.equal(s.getDiagnostics().active, 0); assert.equal(s.getDiagnostics().requests, 0);
});

test('logical request admission and completed-result byte budget are bounded', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let wait = true;
  const s = createSectorExplorer(opts(async () => { if (wait) await gate; return field; }, { maxRequests: 1, maxCacheEntries: 2, maxCacheBytes: 4096 }));
  const first = s.getSectorClassifications({ code: '300964' });
  const admission = s.getSectorCatalog().then(() => 'admitted', error => error.code);
  try { assert.equal(await Promise.race([admission, new Promise(resolve => setTimeout(() => resolve('still queued'), 30))]), 'SERVICE_BUSY'); }
  finally { wait = false; release(); await first; await admission; }
  for (const code of ['300308', '603256', '300429']) await s.getSectorClassifications({ code });
  const stats = s.getDiagnostics();
  assert.ok(stats.cache.completedEntries <= 2); assert.ok(stats.cache.accountedBytes <= 4096);
  assert.equal(stats.generations, 0); assert.equal(stats.requests, 0);
  await s.dispose();
});

test('late classification refresh cannot replace a newer path or register obsolete entries', async () => {
  const releases = [];
  const s = createSectorExplorer(opts(() => new Promise(resolve => { releases.push(resolve); })));
  const old = s.getSectorClassifications({ code: '300964', forceRefresh: true });
  const current = s.getSectorClassifications({ code: '300964', forceRefresh: true });
  await new Promise(setImmediate);
  releases[1](field.replaceAll('印制电路板', '官方新名称'));
  const latest = await current;
  releases[0](field);
  const obsolete = await old;
  const cached = await s.getSectorClassifications({ code: '300964' });
  assert.deepEqual(cached.entries, latest.entries);
  const oldLeaf = obsolete.entries.find(x => x.level === 3);
  await assert.rejects(s.getSectorDetail({ id: oldLeaf.id }), /未知板块/);
  assert.equal(s.getDiagnostics().generations, 0);
  await s.dispose();
});

test('oversized catalog is delivered without exceeding completed-result cache budget', async () => {
  let calls = 0;
  const s = createSectorExplorer(opts(async url => { calls++; return catalog(url.includes('/gn/') ? 'concept' : 'industry'); }, { maxCacheBytes: 128 }));
  assert.equal((await s.getSectorCatalog()).entries.length, 2);
  assert.equal((await s.getSectorCatalog()).entries.length, 2);
  assert.equal(calls, 4, 'oversized result must not be retained');
  assert.equal(s.getDiagnostics().cache.completedEntries, 0);
  assert.equal(s.getDiagnostics().cache.accountedBytes, 0);
  await s.dispose();
});
