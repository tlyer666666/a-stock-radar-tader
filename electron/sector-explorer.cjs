'use strict';
const { createHash } = require('node:crypto');
const { fetchArrayBufferWithPolicy } = require('./http-client.cjs');
const { BoundedCache } = require('./bounded-cache.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const clean = value => String(value ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff))).trim();
const validCode = code => /^(?:00[0-3]\d{3}|30[012]\d{3}|60[0135]\d{3}|68[89]\d{3}|(?:43|83|87|88)\d{4}|920\d{3})$/.test(code);
const riskName = name => /ST|退市|退$/i.test(name.replace(/\s/g, ''));
const security = (code, name) => ({
    code, name, secid: `${/^6/.test(code) ? '1' : '0'}.${code}`, latest: null, changePercent: null, amount: null, turnover: null
});
const numeric = value => {
    const s = clean(value).replace(/[,，\s%]/g, '');
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:亿|万)?$/.test(s))
        return null;
    const n = Number(s.replace(/[亿万]/g, '')) * (s.endsWith('亿') ? 1e8 : s.endsWith('万') ? 1e4 : 1);
    return Number.isFinite(n) ? n : null;
};
const cells = row => [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => clean(m[1]));
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
function uniqueMembers(members) {
    const map = new Map(), conflicts = new Set();
    let duplicates = 0;
    for (const row of members) {
        if (conflicts.has(row.code)) {
            duplicates++;
            continue;
        }
        if (map.has(row.code)) {
            duplicates++;
            if (JSON.stringify(map.get(row.code)) !== JSON.stringify(row)) {
                map.delete(row.code);
                conflicts.add(row.code);
            }
        }
        else
            map.set(row.code, row);
    }
    return {
        members: [...map.values()], conflicts: conflicts.size, duplicates
    };
}
function parseCatalog(html, kind) {
    const stem = kind === 'industry' ? 'thshy' : 'gn', found = new Map(), conflicts = new Set();
    for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        let url;
        try {
            url = new URL(m[1], `https://q.10jqka.com.cn/${stem}/`);
        }
        catch {
            continue;
        }
        const match = url.pathname.match(new RegExp(`^/${stem}/detail/code/(\\d{6})/?$`));
        const name = clean(m[2]);
        if (url.hostname !== 'q.10jqka.com.cn' || !match || !name || name.length > 60)
            continue;
        const id = `ths:${kind}:${match[1]}`;
        const entry = {
            id, code: match[1], name, kind, level: null, path: [], classification: kind === 'industry' ? '同花顺公开行业（目录未标层级）' : '同花顺公开概念', sourceUrl: `https://q.10jqka.com.cn/${stem}/detail/code/${match[1]}/`
        };
        if (found.has(id) && found.get(id).name !== name)
            conflicts.add(id);
        else
            found.set(id, entry);
    }
    return [...found.values()].filter(e => !conflicts.has(e.id));
}
function parseQuotePage(html, entry, expectedPage = 1) {
    const attr = id => { const tag = [...html.matchAll(/<input\b[^>]*>/gi)].find(m => new RegExp(`\\bid=["']${id}["']`).test(m[0])); return tag?.[0].match(/\bvalue=["']([^"']*)["']/)?.[1]; };
    const stem = entry.kind === 'industry' ? 'thshy' : 'gn';
    if (attr('baseUrl') !== `${stem}/detail` || attr('requestQuery') !== `code/${entry.code}`)
        throw new Error('来源页面板块身份不匹配');
    const table = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].find(m => /m-pager-table/.test(m[0]));
    if (!table || !/代码/.test(table[1]) || !/现价/.test(table[1]) || !/涨跌幅/.test(table[1]))
        throw new Error('来源未提供可识别成分表');
    const expectedHeaders = ['序号', '代码', '名称', '现价', '涨跌幅', '涨跌', '涨速', '换手', '量比', '振幅', '成交额', '流通股', '流通市值', '市盈率'];
    const headers = [...table[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => clean(m[1]).replace(/[()%（）\s]/g, ''));
    if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders))
        throw new Error('来源成分表列顺序已变化');
    const page = html.match(/class=["']page_info["'][^>]*>\s*(\d+)\s*\/\s*(\d+)/i);
    if (!page || Number(page[1]) !== expectedPage || Number(page[2]) < expectedPage)
        throw new Error('来源分页标记缺失或不一致');
    let excluded = 0, invalid = 0;
    const members = [];
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const c = cells(row[1]);
        if (!c.length)
            continue;
        if (c.length !== 14) {
            invalid++;
            continue;
        }
        if (!validCode(c[1]) || riskName(c[2])) {
            excluded++;
            continue;
        }
        if (!c[2]) {
            invalid++;
            continue;
        }
        const m = {
            ...security(c[1], c[2]), latest: numeric(c[3]), changePercent: numeric(c[4]), amount: numeric(c[10]), turnover: numeric(c[7])
        };
        if (m.latest !== null && m.latest <= 0)
            m.latest = null;
        if (m.amount !== null && m.amount < 0)
            m.amount = null;
        members.push(m);
    }
    const dt = label => [...html.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)].find(m => clean(m[1]).includes(label))?.[2];
    const breadth = [...(dt('涨跌家数') || '').matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map(m => numeric(m[1]));
    const amountCell = dt('成交额');
    const amount = numeric(amountCell);
    const amountMultiplier = /[亿万]/.test(clean(amountCell)) ? 1 : 1e8;
    if (!members.length && !excluded && !invalid)
        throw new Error('来源成分表为空，无法确认覆盖');
    return {
        members, excluded, invalid, pagesTotal: Number(page[2]), asOf: null, metrics: {
            changePercent: numeric(dt('板块涨幅')), amount: amount === null ? null : amount * amountMultiplier, rising: breadth[0] ?? null, falling: breadth[1] ?? null
        }
    };
}
function parseClassifications(html, seed) {
    const out = [];
    for (const m of html.matchAll(/<p\b[^>]*class=["'][^"']*threecate[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi)) {
        const text = clean(m[1]), match = text.match(/([二三])级行业分类\s*[：:]\s*(.*?)\s*[（(]共\s*(\d+)\s*家[）)]/);
        if (!match)
            continue;
        const level = match[1] === '二' ? 2 : 3, path = match[2].split(/\s*--\s*/).map(s => s.trim());
        if (path.length !== level || path.some(s => !s))
            continue;
        const table = [...html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].find(t => new RegExp(`id=["']hy${level}_table_1["']`).test(t[0]));
        if (!table || !/股票代码/.test(table[1]) || !/股票简称/.test(table[1]))
            continue;
        const pre = html.slice(m.index, table.index), dates = [...pre.matchAll(/>\s*(\d{4}-\d{2}-\d{2})\s*</g)].map(x => x[1]).filter(validDate);
        let excluded = 0, invalid = 0;
        const members = [];
        for (const tr of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
            const c = cells(tr[1]);
            if (!c.length)
                continue;
            if (!validCode(c[0]) || riskName(c[1] || '')) {
                excluded++;
                continue;
            }
            if (!c[1]) {
                invalid++;
                continue;
            }
            members.push(security(c[0], c[1]));
        }
        const unique = uniqueMembers(members);
        invalid += unique.conflicts;
        const id = `ths:f10:${level}:${createHash('sha256').update(path.join(' > ')).digest('hex').slice(0, 16)}`;
        out.push({
            entry: {
                id, code: seed, name: path.at(-1), kind: 'classification', level, path, classification: `同花顺 F10 ${level === 2 ? '二' : '三'}级行业字段`, sourceUrl: `https://basic.10jqka.com.cn/${seed}/field.html`
            }, members: unique.members, declared: Number(match[3]), excluded, invalid, reportDate: dates[0] || null
        });
    }
    // A stated three-level path also identifies its parents, but does not
    // supply their full member lists. Keep those entries explicitly path-only.
    const all = new Map(out.map(row => [row.entry.id, row]));
    for (const row of out) {
        for (let level = 1; level < row.entry.level; level++) {
            const path = row.entry.path.slice(0, level);
            const id = `ths:f10:${level}:${createHash('sha256').update(path.join(' > ')).digest('hex').slice(0, 16)}`;
            if (!all.has(id)) all.set(id, {
                entry: { ...row.entry, id, name: path.at(-1), level, path,
                    classification: `同花顺 F10 ${level === 1 ? '一' : '二'}级行业路径` },
                members: [], declared: null, excluded: 0, invalid: 0, reportDate: null, pathOnly: true
            });
        }
    }
    return [...all.values()].sort((a, b) => a.entry.level - b.entry.level || a.entry.id.localeCompare(b.entry.id));
}
function emptyCoverage(scope) { return {
    loaded: 0, total: null, failed: 0, declared: null, excluded: 0, invalid: 0, pagesLoaded: 0, pagesTotal: null, complete: false, scope
}; }
function abortError() { const e = new Error('板块请求已取消'); e.name = 'AbortError'; return e; }
function check(signal) {
    if (signal?.aborted)
        throw signal.reason || abortError();
}
async function defaultFetchHtml(url, { signal }) {
    const buffer = await fetchArrayBufferWithPolicy(url, {
        signal
    }, {
        timeoutMs: 12000, retries: 0, minimumGapMs: 200, headers: {
            'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html'
        }
    });
    if (buffer.byteLength > 5e6)
        throw new Error('来源页面过大');
    return new TextDecoder('gb18030').decode(buffer);
}
function createSectorExplorer({ fetchHtml = defaultFetchHtml, now = Date.now, maxPages = 30,
    maxRequests = 32, maxCacheEntries = 128, maxCacheBytes = 8 * 1024 * 1024, timeoutMs = 180000 } = {}) {
    const bounded = (value, fallback, max) => Number.isFinite(Number(value)) && Number(value) > 0 ? Math.min(max, Math.floor(Number(value))) : fallback;
    maxRequests = bounded(maxRequests, 32, 32);
    maxPages = bounded(maxPages, 30, 30);
    timeoutMs = bounded(timeoutMs, 180000, 180000);
    const cache = new BoundedCache({ maxEntries: bounded(maxCacheEntries, 128, 128), maxBytes: bounded(maxCacheBytes, 8 * 1024 * 1024, 8 * 1024 * 1024), now });
    const entries = new BoundedCache({ maxEntries: 4096, maxBytes: 2 * 1024 * 1024, now });
    const requests = new Map(), generations = new Map();
    const controllers = new Set(), pending = new Set();
    let disposed = false, disposal;
    let active = 0;
    const queue = [];
    async function physical(url, signal) {
        check(signal);
        await new Promise((resolve, reject) => {
            const abort = () => {
                const index = queue.indexOf(task);
                if (index >= 0) {
                    queue.splice(index, 1);
                    reject(abortError());
                }
            };
            const task = {
                signal, resolve: () => { signal.removeEventListener('abort', abort); resolve(); }, reject: err => { signal.removeEventListener('abort', abort); reject(err); }
            };
            signal.addEventListener('abort', abort, {
                once: true
            });
            queue.push(task);
            pump();
        });
        try {
            check(signal);
            const value = await fetchHtml(url, {
                signal
            });
            check(signal);
            return value;
        }
        finally {
            active--;
            pump();
        }
    }
    function pump() {
        while (active < 2 && queue.length) {
            const task = queue.shift();
            if (task.signal.aborted) {
                task.reject(abortError());
                continue;
            }
            active++;
            task.resolve();
        }
    }
    async function request(options, fn) {
        if (disposed)
            throw abortError();
        if (!options || typeof options !== 'object' || Array.isArray(options))
            throw new Error('板块请求参数无效');
        if (options.forceRefresh !== undefined && typeof options.forceRefresh !== 'boolean')
            throw new Error('forceRefresh 必须为布尔值');
        const id = options.requestId;
        if (id !== undefined && (typeof id !== 'string' || !id || id.length > 120))
            throw new Error('requestId 无效');
        if (id && requests.has(id))
            throw new Error('requestId 已在使用');
        if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > timeoutMs))
            throw new Error(`timeoutMs 必须在 1 至 ${timeoutMs} 毫秒范围内`);
        if (controllers.size >= maxRequests)
            throw Object.assign(new Error('板块请求已满，请稍后重试'), { code: 'SERVICE_BUSY' });
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(Object.assign(new Error('板块请求已达到总时限'), { name: 'TimeoutError', code: 'JOB_TIMEOUT' })), options.timeoutMs ?? timeoutMs);
        let finish;
        const done = new Promise(resolve => { finish = resolve; });
        pending.add(done);
        if (id)
            requests.set(id, controller);
        try {
            return await fn(controller.signal);
        }
        finally {
            clearTimeout(timer);
            if (id && requests.get(id) === controller)
                requests.delete(id);
            controllers.delete(controller);
            pending.delete(done);
            for (const [key, current] of generations) if (current.signal === controller.signal) generations.delete(key);
            finish();
        }
    }
    function generation(key, signal) { const g = { signal }; generations.set(key, g); return g; }
    function hit(key, force) { const c = cache.get(key); return !force && c && now() - c.at < (c.value.status === 'partial' ? 45000 : key === 'catalog' ? 900000 : 90000) ? clone(c.value) : null; }
    function put(key, value, g) {
        if (generations.get(key) === g && value.status !== 'unavailable' && value.status !== 'stale')
            cache.set(key, {
                at: now(), expiresAt: now() + 1800000, value: clone(value)
            });
    }
    function stale(key, message) { const old = cache.get(key); return old && now() - old.at < 1800000 ? {
        ...clone(old.value), status: 'stale', warnings: [...old.value.warnings, `刷新失败，显示旧抓取资料：${message}`]
    } : null; }
    async function catalog(options = {}) {
        return request(options, async (signal) => {
            const cached = hit('catalog', options.forceRefresh);
            if (cached)
                return cached;
            const g = generation('catalog', signal), fetchedAt = new Date(now()).toISOString(), sources = [], warnings = [], found = [];
            const jobs = [{
                    kind: 'industry', url: 'https://q.10jqka.com.cn/thshy/'
                }, {
                    kind: 'concept', url: 'https://q.10jqka.com.cn/gn/'
                }];
            await Promise.all(jobs.map(async (job) => {
                try {
                    const html = await physical(job.url, signal);
                    const list = parseCatalog(html, job.kind);
                    if (!list.length)
                        throw new Error('未识别到目录字段');
                    found.push(...list);
                    sources.push({
                        name: `同花顺 ${job.kind === 'industry' ? '行业' : '概念'}目录`, url: job.url, status: 'ready', message: `载入 ${list.length} 个官方目录入口`
                    });
                }
                catch (e) {
                    check(signal);
                    sources.push({
                        name: `同花顺 ${job.kind === 'industry' ? '行业' : '概念'}目录`, url: job.url, status: 'unavailable', message: e.message
                    });
                    warnings.push(`${job.url}：${e.message}`);
                }
            }));
            check(signal);
            if (!found.length) {
                const old = stale('catalog', warnings.join('；'));
                if (old)
                    return old;
            }
            // Deterministic directory order independent of response timing.
            found.sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
            const unique = new Map();
            for (const e of found)
                if (!unique.has(e.id))
                    unique.set(e.id, e);
            const result = {
                status: found.length ? (warnings.length ? 'partial' : 'ready') : 'unavailable', entries: [...unique.values()], fetchedAt, asOf: null, sources: sources.sort((a, b) => a.url.localeCompare(b.url)), warnings: [...warnings, '已读取官方公开目录入口；行业目录未标层级，不代表同花顺完整一/二/三级行业树。'], coverage: {
                    ...emptyCoverage('本次官方公开目录链接；不代表完整行业树或成分覆盖'), loaded: unique.size, total: warnings.length ? null : unique.size, failed: sources.filter(s => s.status === 'unavailable').length, pagesLoaded: sources.filter(s => s.status === 'ready').length, pagesTotal: jobs.length
                }
            };
            if (generations.get('catalog') === g) {
                for (const e of result.entries)
                    entries.set(e.id, e);
            }
            put('catalog', result, g);
            return clone(result);
        });
    }
    function base(entry) { return {
        status: 'unavailable', entry, fetchedAt: new Date(now()).toISOString(), asOf: null, reportDate: null, members: [], coverage: emptyCoverage('源页股票；已剔除 ST 和非普通 A 股'), metrics: null, sources: [], warnings: [], evidence: [], relatedTerms: []
    }; }
    function classificationResult(parsed, entry, fetchedAt) {
        const result = base(entry), future = parsed.reportDate && parsed.reportDate > fetchedAt.slice(0, 10);
        Object.assign(result, {
            fetchedAt, status: 'partial', members: parsed.members, reportDate: future ? null : parsed.reportDate, coverage: {
                ...emptyCoverage(parsed.pathOnly ? '官方路径上级；源页未提供本级完整成分' : '报告期同行财务对比名单；非实时完整指数成分'), loaded: parsed.members.length, total: parsed.declared, declared: parsed.declared, excluded: parsed.excluded, invalid: parsed.invalid, pagesLoaded: 1, pagesTotal: 1
            }, warnings: [parsed.pathOnly ? '分类名称来自源页明示的行业路径；本页未提供该上级行业完整成分。' : '同行对比表属于报告期资料，不用于计算当前板块强度；未确认完整实时成分。', ...(future ? ['源页报告期晚于抓取日期，日期不可用。'] : [])], sources: [{
                    name: '同花顺 F10 行业地位', url: entry.sourceUrl, status: 'partial', message: '报告期同行对比表'
                }]
        });
        return result;
    }
    async function classifications(options) {
        return request(options, async (signal) => {
            if (typeof options.code !== 'string' || !validCode(options.code))
                throw new Error('请输入普通 A 股六位证券代码');
            const code = options.code, key = `classification-stock:${code}`, cached = hit(key, options.forceRefresh);
            if (cached)
                return cached;
            const g = generation(key, signal), fetchedAt = new Date(now()).toISOString(), url = `https://basic.10jqka.com.cn/${code}/field.html`;
            try {
                const parsed = parseClassifications(await physical(url, signal), code);
                check(signal);
                if (!parsed.length)
                    throw new Error('源页未提供可识别的二/三级行业字段');
                const value = {
                    status: 'partial', entries: parsed.map(x => x.entry), fetchedAt, asOf: null, sources: [{
                            name: `同花顺 F10 ${code}`, url, status: 'ready', message: `发现 ${parsed.length} 个行业字段`
                        }], warnings: ['仅为本次证券页面所列分类；不是完整行业树，不代表实时指数成分。'], coverage: {
                        ...emptyCoverage('单一证券 F10 官方行业路径；非全市场分类'), loaded: parsed.length, total: parsed.length, levelCounts: { 1: parsed.filter(x => x.entry.level === 1).length, 2: parsed.filter(x => x.entry.level === 2).length, 3: parsed.filter(x => x.entry.level === 3).length }, pagesLoaded: 1, pagesTotal: 1
                    }
                };
                if (generations.get(key) === g) {
                    for (const row of parsed) {
                        entries.set(row.entry.id, row.entry);
                        const detail = classificationResult(row, row.entry, fetchedAt);
                        const dg = generation(row.entry.id, signal);
                        put(row.entry.id, detail, dg);
                    }
                }
                put(key, value, g);
                return clone(value);
            }
            catch (e) {
                check(signal);
                const old = stale(key, e.message);
                if (old)
                    return old;
                return {
                    status: 'unavailable', entries: [], fetchedAt, asOf: null, sources: [{
                            name: `同花顺 F10 ${code}`, url, status: 'unavailable', message: e.message
                        }], warnings: [`来源不可用：${e.message}`], coverage: { ...emptyCoverage('本次证券行业字段未获取'), failed: 1 }
                };
            }
        });
    }
    async function detail(options) {
        return request(options, async (signal) => {
            const entry = entries.get(options.id);
            if (!entry)
                throw new Error('未知板块，请先获取目录后选择');
            const key = entry.id, cached = hit(key, options.forceRefresh);
            if (cached)
                return cached;
            const g = generation(key, signal), result = base(entry);
            try {
                const html = await physical(entry.sourceUrl, signal);
                if (entry.kind === 'classification') {
                    const parsed = parseClassifications(html, entry.code).find(x => x.entry.id === entry.id);
                    if (!parsed)
                        throw new Error('F10 分类字段已变化或不可用');
                    Object.assign(result, classificationResult(parsed, entry, result.fetchedAt));
                }
                else {
                    const first = parseQuotePage(html, entry, 1), all = [...first.members];
                    let excluded = first.excluded, invalid = first.invalid, pagesLoaded = 1, failed = false;
                    result.metrics = first.metrics;
                    for (let p = 2; p <= Math.min(first.pagesTotal, maxPages); p++) {
                        check(signal);
                        const stem = entry.kind === 'industry' ? 'thshy' : 'gn', url = `https://q.10jqka.com.cn/${stem}/detail/field/199112/order/desc/page/${p}/ajax/1/code/${entry.code}/`;
                        try {
                            const next = parseQuotePage(await physical(url, signal), entry, p);
                            if (next.pagesTotal !== first.pagesTotal)
                                throw new Error('分页总数在请求期间变化');
                            all.push(...next.members);
                            excluded += next.excluded;
                            invalid += next.invalid;
                            pagesLoaded++;
                        }
                        catch (e) {
                            check(signal);
                            failed = true;
                            result.warnings.push(`第 ${p} 页不可用：${e.message}`);
                            break;
                        }
                    }
                    const unique = uniqueMembers(all);
                    invalid += unique.conflicts;
                    const complete = !failed && pagesLoaded === first.pagesTotal && invalid === 0 && unique.duplicates === 0;
                    Object.assign(result, {
                        status: complete ? 'ready' : 'partial', members: unique.members, coverage: {
                            loaded: unique.members.length, total: complete ? unique.members.length + excluded : null, failed: first.pagesTotal - pagesLoaded, declared: null, excluded, invalid, pagesLoaded, pagesTotal: first.pagesTotal, complete, scope: '源页成分分页；ST/非 A 股剔除后覆盖'
                        }, warnings: [...result.warnings, '源页未给出行情日期，抓取时间不代表行情时间；不从分页样本推算整体强度。', ...(unique.duplicates ? ['分页存在重复或冲突，不能确认完整覆盖。'] : []), ...(pagesLoaded < first.pagesTotal && !failed ? [`最多读取 ${maxPages} 页，仍有未获取页面。`] : [])]
                    });
                }
                result.sources = [{
                        name: entry.kind === 'classification' ? '同花顺 F10 行业地位' : '同花顺公开板块页面', url: entry.sourceUrl, status: result.status, message: result.coverage.scope
                    }];
            }
            catch (e) {
                check(signal);
                const old = stale(key, e.message);
                if (old)
                    return old;
                result.warnings = [`来源不可用：${e.message}`];
                result.sources = [{
                        name: '同花顺公开页面', url: entry.sourceUrl, status: 'unavailable', message: e.message
                    }];
            }
            check(signal);
            put(key, result, g);
            return clone(result);
        });
    }
    return {
        dispose() {
            if (disposal)
                return disposal;
            disposed = true;
            for (const controller of controllers)
                controller.abort(abortError());
            pump();
            disposal = Promise.all([...pending]).then(() => undefined);
            return disposal;
        },
        getDiagnostics() { return { active, queued: queue.length, requests: controllers.size, generations: generations.size, cache: cache.getDiagnostics(), entries: entries.getDiagnostics(), disposed }; },
        getSectorCatalog: catalog, getSectorDetail: detail, getSectorClassifications: classifications, async cancelSectorRequest(id) {
            const c = requests.get(id);
            if (c)
                c.abort();
            pump();
            return {
                cancelled: Boolean(c)
            };
        }
    };
}
module.exports = {
    createSectorExplorer, parseCatalog, parseQuotePage, parseClassifications
};
