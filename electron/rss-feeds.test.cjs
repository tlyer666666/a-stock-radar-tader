"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRssFeeds, parseFeed, normalizeFeedUrl, plainText, isFeedStore, isPublicUnicastIp, createPublicLookup } = require("./rss-feeds.cjs");

const NOW = Date.parse("2026-11-27T04:00:00.000Z");
const RSS = `<?xml version="1.0"?><rss><channel><title>测试</title>
<item><title><![CDATA[央行宣布<b>降准</b> 0.5 个百分点]]></title><link>https://news.example.com/a</link><pubDate>Fri, 27 Nov 2026 02:00:00 GMT</pubDate><description>&lt;p&gt;释放长期资金约 1 万亿元&amp;nbsp;&lt;/p&gt;</description></item>
<item><title>半导体设备订单创新高</title><link>https://news.example.com/b</link><pubDate>Thu, 26 Nov 2026 10:00:00 GMT</pubDate><description>多家公司披露</description></item>
<item><title>很久以前的旧闻</title><link>javascript:alert(1)</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title></title><link>https://news.example.com/empty</link></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>半导体设备订单创新高</title><link href="https://other.example.org/x"/><updated>2026-11-26T11:00:00Z</updated><summary>重复标题</summary></entry>
<entry><title>没有时间的条目</title><link href="https://other.example.org/y"/></entry></feed>`;

test("only public https feed addresses are accepted", () => {
  assert.equal(normalizeFeedUrl("https://news.example.com/rss.xml"), "https://news.example.com/rss.xml");
  for (const bad of ["http://news.example.com/rss", "https://user:pw@example.com/rss", "https://localhost/rss", "https://127.0.0.1/rss", "https://192.168.1.5/rss", "https://10.0.0.8/a", "https://172.20.1.1/a", "https://printer.local/rss", "https://intranet/rss", "https://[::1]/rss", "file:///etc/passwd", "not a url", 5,
    "https://localhost./x", "https://[::ffff:127.0.0.1]/a", "https://100.64.1.2/a", "https://2130706433/a", "https://router.lan/rss",
    "https://198.18.0.1/rss", "https://198.19.255.1/rss", "https://224.0.0.1/rss", "https://240.0.0.1/rss", "https://192.0.0.1/rss"]) {
    assert.equal(normalizeFeedUrl(bad), null, String(bad));
  }
});

test("RSS and Atom are parsed without a library; markup, CDATA and unsafe links are stripped", () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 3, "the empty-title item is dropped");
  assert.deepEqual(items[0], { title: "央行宣布 降准 0.5 个百分点", summary: "释放长期资金约 1 万亿元", link: "https://news.example.com/a", publishedAt: "2026-11-27T02:00:00.000Z" });
  assert.equal(items[2].link, "", "a javascript: link is not kept");
  const atom = parseFeed(ATOM);
  assert.equal(atom[0].link, "https://other.example.org/x");
  assert.equal(atom[1].publishedAt, "");
  assert.deepEqual(parseFeed("<html>not a feed</html>"), []);
});

function hub(responses) {
  let state = null;
  let seq = 0;
  const fetched = [];
  const api = createRssFeeds({
    store: { read: () => state, write: value => { state = structuredClone(value); } }, now: () => NOW, id: () => `feed_${++seq}`,
    fetchBytes: async (url, options, policy) => { fetched.push({ url, options, policy }); const body = responses[url]; if (body === undefined) throw new Error("HTTP 404"); return new TextEncoder().encode(body); }
  });
  return { api, fetched };
}

test("feeds are saved with limits, merged for the AI with keyword and time filters, deduped, and a dead feed is reported not fatal", async () => {
  const { api, fetched } = hub({ "https://news.example.com/rss.xml": RSS, "https://other.example.org/atom": ATOM });
  api.save({ name: "测试源", url: "https://news.example.com/rss.xml" });
  api.save({ url: "https://other.example.org/atom" });
  api.save({ name: "坏源", url: "https://dead.example.net/rss" });
  assert.throws(() => api.save({ url: "https://news.example.com/rss.xml" }), /已经添加过/);
  assert.throws(() => api.save({ url: "http://insecure.example.com/rss" }), /公网的 https/);
  assert.equal(api.list().feeds[1].name, "other.example.org");
  const all = await api.news({ hours: 72 });
  assert.deepEqual(all.items.map(item => item.title), ["央行宣布 降准 0.5 个百分点", "半导体设备订单创新高", "没有时间的条目"], "old news is outside the window, the duplicate headline is kept once, undated items go last");
  assert.equal(all.items[1].source, "测试源");
  assert.deepEqual(all.failedSources, ["坏源"]);
  assert.equal(all.configured, 3);
  assert.equal(fetched[0].policy.maxResponseBytes, 1024 * 1024);
  assert.equal(fetched[0].options.redirect, "error", "redirects are not followed");
  assert.equal(fetched[0].options.publicOnly, true, "DNS lookup must enforce public unicast IPs");
  const chips = await api.news({ query: "半导体 光刻", hours: 72 });
  assert.deepEqual(chips.items.map(item => item.title), ["半导体设备订单创新高"]);
  const before = fetched.length;
  await api.news({});
  assert.equal(fetched.length - before, 1, "good feeds are cached for 15 minutes; only the dead one is retried");
  const sample = await api.test("https://news.example.com/rss.xml");
  assert.equal(sample.count, 3);
  await assert.rejects(api.test("https://localhost/rss"), /公网的 https/);
  api.remove(api.list().feeds[2].id);
  assert.equal(api.list().feeds.length, 2);
  const none = hub({});
  assert.deepEqual(await none.api.news({}), { items: [], sources: [], failedSources: [], configured: 0 });
});

test("the rss_news tool tells the AI when no feed is configured and returns clipped items otherwise; the new stores are part of backups", async () => {
  const { createStockAgentTools } = require("./stock-agent-tools.cjs");
  const { BACKUP_STORES } = require("./data-backup.cjs");
  const empty = createStockAgentTools({ rssNews: async () => ({ items: [], sources: [], failedSources: [], configured: 0 }) });
  const none = await empty.runTool("rss_news", {});
  assert.equal(none.ok, false);
  assert.match(none.summary, /还没有添加自订资讯源/);
  const { api } = hub({ "https://news.example.com/rss.xml": RSS });
  api.save({ name: "测试源", url: "https://news.example.com/rss.xml" });
  const tools = createStockAgentTools({ rssNews: args => api.news(args) });
  const result = await tools.runTool("rss_news", { query: "降准", hours: 72 });
  assert.equal(result.ok, true);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].source, "测试源");
  assert.match(result.summary, /含「降准」/);
  for (const name of ["decision-signals", "alert-rules", "rss-feeds"]) assert.ok(BACKUP_STORES.includes(name), name);
});

test("a feed address smuggled in through a restored backup is sanitized on read, and GBK feeds are decoded", async () => {
  let state = { version: 1, feeds: [null, { id: "x", name: "内网", url: "https://192.168.1.1/rss", enabled: true }, { id: "y", name: "国标", url: "https://gbk.example.com/rss", enabled: true }] };
  const fetched = [];
  const gbk = Buffer.concat([Buffer.from('<?xml version="1.0" encoding="GBK"?><rss><item><title>'), Buffer.from([0xd1, 0xeb, 0xd0, 0xd0, 0xbd, 0xb5, 0xd7, 0xbc]), Buffer.from("</title></item></rss>")]);
  const api = createRssFeeds({ store: { read: () => state, write: value => { state = value; } }, now: () => NOW, fetchBytes: async url => { fetched.push(url); return gbk; } });
  assert.equal(api.list().feeds.length, 1, "null and private entries are sanitized away");
  const result = await api.news({});
  assert.deepEqual(fetched, ["https://gbk.example.com/rss"], "the private address is never requested");
  assert.deepEqual(result.failedSources, []);
  assert.equal(result.items[0].title, "央行降准");
});

test("C1: isPublicUnicastIp and createPublicLookup reject private/reserved/rebound IPs", async () => {
  for (const pub of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isPublicUnicastIp(pub), true, pub);
  }
  for (const priv of ["0.0.0.1", "10.0.0.1", "100.64.0.1", "100.127.255.254", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.254", "192.0.0.1", "192.168.1.1", "198.18.0.1", "198.19.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:0:127.0.0.1", "64:ff9b:1::127.0.0.1", "100::1", "2001::1", "2001:2::1", "2001:10::1", "2001:20::1", "2001:db8::1", "2002:7f00:1::1", "3fff::1", "not-an-ip"]) {
    assert.equal(isPublicUnicastIp(priv), false, priv);
  }
  const runLookup = (mock, opts = {}) => new Promise((resolve, reject) => {
    createPublicLookup(mock)("news.example.com", opts, (err, addr, fam) => (err ? reject(err) : resolve({ addr, fam })));
  });
  const okSingle = await runLookup((_h, _o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]));
  assert.deepEqual(okSingle, { addr: "93.184.216.34", fam: 4 });
  const okAll = await runLookup((_h, _o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]), { all: true });
  assert.deepEqual(okAll.addr, [{ address: "93.184.216.34", family: 4 }]);
  await assert.rejects(runLookup((_h, _o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }])), { code: "PUBLIC_IP_REQUIRED" });
  await assert.rejects(runLookup((_h, _o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }])), { code: "PUBLIC_IP_REQUIRED" });
  await assert.rejects(runLookup((_h, _o, cb) => cb(null, [])), { code: "PUBLIC_IP_REQUIRED" });
});

test("H1: pathological unclosed tags do not trigger quadratic ReDoS", () => {
  const t0 = performance.now();
  assert.deepEqual(parseFeed("<item>".repeat(20000)), []);
  assert.equal(plainText("<script>".repeat(8000)), "");
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 50, `expected < 50ms, got ${elapsed.toFixed(2)}ms`);
});

test("H8 & L2: isFeedStore enforces bounds and object items; read caps feeds; edit and remove clear stale cache", async () => {
  assert.equal(isFeedStore({ version: 1, feeds: [null] }), false);
  assert.equal(isFeedStore({ version: 1, feeds: Array.from({ length: 13 }, (_, i) => ({ id: `f${i}`, url: `https://a${i}.example.com/rss` })) }), false);
  assert.equal(isFeedStore({ version: 1, feeds: [{ id: "f1", url: "https://a.example.com/rss" }] }), true);
  let state = { version: 1, feeds: Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, name: `源${i}`, url: `https://s${i}.example.com/rss`, enabled: true })) };
  const calls = [];
  const api = createRssFeeds({
    store: { read: () => state, write: value => { state = structuredClone(value); } },
    now: () => NOW,
    fetchBytes: async url => { calls.push(url); return new TextEncoder().encode(RSS); }
  });
  assert.equal(api.list().feeds.length, 12, "read caps oversized stores at MAX_FEEDS");
  // Cache cleanup on edit and remove
  const { api: api2, fetched } = hub({ "https://a.example.com/rss": RSS, "https://b.example.com/rss": RSS });
  api2.save({ name: "A", url: "https://a.example.com/rss" });
  const idA = api2.list().feeds[0].id;
  await api2.news({});
  assert.equal(fetched.length, 1);
  // Edit feed URL from a -> b; old a cache entry must be purged
  api2.save({ id: idA, name: "B", url: "https://b.example.com/rss" });
  await api2.test("https://a.example.com/rss");
  assert.equal(fetched.length, 2, "old URL cache was cleared on edit");
  // Remove feed B; b cache entry must be purged
  await api2.news({});
  assert.equal(fetched.length, 3);
  api2.remove(idA);
  await api2.test("https://b.example.com/rss");
  assert.equal(fetched.length, 4, "removed feed URL cache was cleared");
});
