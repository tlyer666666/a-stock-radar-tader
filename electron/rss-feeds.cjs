"use strict";

/**
 * 自订资讯源（RSS / Atom），给 AI 问股的 rss_news 工具用。设计参考 daily_stock_analysis 的资讯源（MIT）。
 *
 * - 用户自己添加源（最多 12 个）；只接受 https，拒绝带账号密码的地址、本机和内网地址（防止被诱导去读内网）。
 * - 抓取：每个源响应体上限 1 MB、超时 8 秒；15 分钟缓存；单个源失败不影响其他源，失败的源会列出来。
 * - 解析：不引第三方库，按 <item> / <entry> 取标题、链接、时间、摘要；去掉 HTML 标签和 CDATA；没有时间的条目保留但排在后面。
 * - 标题相同的只留一条；文字只是数据，不是给 AI 的指令（提示词里已有这条规则）。
 */

const { isIP } = require("node:net");
const { isPublicUnicastIp, createPublicLookup } = require("./native-http.cjs");

const MAX_FEEDS = 12;
const MAX_ITEMS_PER_FEED = 40;
const CACHE_MS = 15 * 60_000;
const MAX_BYTES = 1024 * 1024;
const MAX_FIELD_CHARS = 16 * 1024;

const isPlainObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const clip = (value, max) => { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text; };

/** 只接受公网 https 地址。 */
function normalizeFeedUrl(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  // 去掉结尾的点（"localhost." 和 "localhost" 是同一台机器）。
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || (!host.includes(".") && !host.includes(":"))) return null;
  // 内网、回环、链路本地、运营商级 NAT（100.64.0.0/10）、保留段（192.0.0.0/24、198.18.0.0/15）、组播与保留（224.0.0.0/4、240.0.0.0/4）。
  if (/^(?:127\.|10\.|192\.168\.|192\.0\.0\.|198\.1[89]\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|(?:22[4-9]|23\d|24\d|25[0-5])\.)/.test(host)) return null;
  // IPv6 一律不接受（回环、内网、映射到 IPv4 的写法都在里面），资讯源用域名即可。
  if (host.includes(":")) return null;
  // IP 字面量再走统一公网单播判定兜底。
  if (isIP(host) && !isPublicUnicastIp(host)) return null;
  // 纯数字或十六进制主机名（十进制 IP 写法）也不接受。
  if (/^(?:0x[0-9a-f]+|\d+)$/.test(host)) return null;
  return url.href;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function unwrapCdata(text) {
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf("<![CDATA[", pos);
    if (start < 0) { out += text.slice(pos); break; }
    const end = text.indexOf("]]>", start + 9);
    if (end < 0) { out += text.slice(pos); break; }
    out += text.slice(pos, start) + text.slice(start + 9, end);
    pos = end + 3;
  }
  return out;
}

function stripTagBlock(text, name) {
  const lower = text.toLowerCase();
  const prefix = `<${name}`;
  const closeTag = `</${name}>`;
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const start = lower.indexOf(prefix, pos);
    if (start < 0) { out += text.slice(pos); break; }
    const next = lower[start + prefix.length];
    if (next !== ">" && next !== " " && next !== "\t" && next !== "\n" && next !== "\r" && next !== "/") {
      out += text.slice(pos, start + prefix.length);
      pos = start + prefix.length;
      continue;
    }
    const closeIdx = lower.indexOf(closeTag, start + prefix.length);
    if (closeIdx < 0) {
      out += `${text.slice(pos, start)} `;
      break;
    }
    out += `${text.slice(pos, start)} `;
    pos = closeIdx + closeTag.length;
  }
  return out;
}

function stripTags(text) {
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf("<", pos);
    if (start < 0) { out += text.slice(pos); break; }
    const end = text.indexOf(">", start + 1);
    if (end < 0) { out += text.slice(pos); break; }
    out += `${text.slice(pos, start)} `;
    pos = end + 1;
  }
  return out;
}

function plainText(value) {
  const strip = text => stripTags(stripTagBlock(stripTagBlock(text, "script"), "style"));
  const decode = text => text
    .replace(/&#(\d{1,7});/g, (_, code) => String.fromCodePoint(Math.min(0x10ffff, Number(code))))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, code) => String.fromCodePoint(Math.min(0x10ffff, parseInt(code, 16))))
    .replace(/&([a-z]{1,12});/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
  // 摘要常把 HTML 转义后再放进 XML：先截断防超长输入，再去标签、解实体，再去一遍解出来的标签。
  const unwrapped = unwrapCdata(String(value ?? "").slice(0, MAX_FIELD_CHARS));
  return strip(decode(strip(decode(strip(unwrapped))))).replace(/\s+/g, " ").trim();
}

/** 按 XML 声明里的编码解码（国内不少源是 GBK / GB2312）；没写或不认识就按 UTF-8。 */
function decodeFeed(bytes) {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 200));
  const label = head.match(/encoding=["']([A-Za-z0-9_-]+)["']/i)?.[1]?.toLowerCase() || "utf-8";
  try { return new TextDecoder(/^gb/.test(label) ? "gb18030" : label).decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}

function findOpenTag(lower, name, from) {
  const prefix = `<${name}`;
  let pos = from;
  while (pos < lower.length) {
    const start = lower.indexOf(prefix, pos);
    if (start < 0) return null;
    const after = lower[start + prefix.length];
    if (after === ">" || after === " " || after === "\t" || after === "\n" || after === "\r" || after === "/") {
      const gt = lower.indexOf(">", start + prefix.length);
      if (gt < 0) return null;
      if (lower[gt - 1] === "/") { pos = gt + 1; continue; }
      return { start, contentStart: gt + 1 };
    }
    pos = start + prefix.length;
  }
  return null;
}

function extractBlocks(text, names, maxCount = MAX_ITEMS_PER_FEED) {
  const lower = text.toLowerCase();
  const blocks = [];
  const closedMissing = new Set();
  let pos = 0;
  while (pos < lower.length && blocks.length < maxCount) {
    let best = null;
    for (const name of names) {
      if (closedMissing.has(name)) continue;
      const found = findOpenTag(lower, name, pos);
      if (found && (!best || found.start < best.start)) best = { ...found, name };
    }
    if (!best) break;
    const closeTag = `</${best.name}>`;
    const closeIdx = lower.indexOf(closeTag, best.contentStart);
    if (closeIdx < 0) {
      closedMissing.add(best.name);
      continue;
    }
    blocks.push(text.slice(best.contentStart, closeIdx));
    pos = closeIdx + closeTag.length;
  }
  return blocks;
}

function tag(block, names) {
  const lower = block.toLowerCase();
  for (const name of names) {
    const open = findOpenTag(lower, name.toLowerCase(), 0);
    if (!open) continue;
    const closeIdx = lower.indexOf(`</${name.toLowerCase()}>`, open.contentStart);
    if (closeIdx >= 0) return block.slice(open.contentStart, Math.min(closeIdx, open.contentStart + MAX_FIELD_CHARS));
  }
  return "";
}

function findLinkHref(block) {
  const lower = block.toLowerCase();
  let pos = 0;
  while (pos < lower.length) {
    const start = lower.indexOf("<link", pos);
    if (start < 0) return "";
    const next = lower[start + 5];
    if (next === " " || next === "\t" || next === "\n" || next === "\r") {
      const end = lower.indexOf(">", start + 5);
      if (end < 0) return "";
      const attrs = block.slice(start + 5, end);
      const match = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      if (match) return match[1] ?? match[2] ?? "";
      pos = end + 1;
    } else {
      pos = start + 5;
    }
  }
  return "";
}

/** RSS 2.0 / Atom 文本 → 条目。 */
function parseFeed(xml) {
  const text = String(xml || "");
  const blocks = extractBlocks(text, ["item", "entry"], MAX_ITEMS_PER_FEED);
  const items = [];
  for (const block of blocks) {
    const title = clip(plainText(tag(block, ["title"])), 120);
    if (!title) continue;
    const linkTag = tag(block, ["link"]);
    const href = findLinkHref(block);
    const link = normalizeFeedUrl(plainText(linkTag) || href) || "";
    const when = plainText(tag(block, ["pubDate", "published", "updated", "dc:date"]));
    const ms = when ? Date.parse(when) : NaN;
    items.push({ title, summary: clip(plainText(tag(block, ["description", "summary", "content:encoded", "content"])), 200), link, publishedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : "" });
  }
  return items;
}

const isFeedStore = value => isPlainObject(value)
  && value.version === 1
  && Array.isArray(value.feeds)
  && value.feeds.length <= MAX_FEEDS
  && value.feeds.every(item => isPlainObject(item) && typeof item.id === "string" && typeof item.url === "string");

function createRssFeeds({ store, fetchBytes, now = () => Date.now(), id = () => `feed_${Math.random().toString(36).slice(2, 10)}` } = {}) {
  if (!store || typeof store.read !== "function" || typeof store.write !== "function" || typeof fetchBytes !== "function") throw new TypeError("store and fetchBytes are required");
  const sanitizeFeed = item => {
    if (!isPlainObject(item)) return null;
    const feedId = typeof item.id === "string" ? item.id.trim().slice(0, 40) : "";
    const url = normalizeFeedUrl(item.url);
    if (!feedId || !url) return null;
    return {
      id: feedId,
      name: clip(item.name, 20) || new URL(url).hostname,
      url,
      enabled: item.enabled !== false,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : ""
    };
  };
  const read = () => {
    const value = store.read();
    if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.feeds)) return { version: 1, feeds: [] };
    const seen = new Set();
    const feeds = [];
    for (const raw of value.feeds) {
      const clean = sanitizeFeed(raw);
      if (!clean || seen.has(clean.url)) continue;
      seen.add(clean.url);
      feeds.push(clean);
      if (feeds.length >= MAX_FEEDS) break;
    }
    return { version: 1, feeds };
  };
  const cache = new Map();

  const list = () => ({ feeds: read().feeds.map(feed => ({ ...feed })), maxFeeds: MAX_FEEDS });

  function save(input = {}) {
    const state = read();
    const url = normalizeFeedUrl(input.url);
    if (!url) throw Object.assign(new Error("资讯源地址要是公网的 https 链接"), { code: "FEED_INVALID" });
    const name = clip(input.name, 20) || new URL(url).hostname;
    const existing = input.id ? state.feeds.find(feed => feed.id === String(input.id)) : null;
    if (!existing && state.feeds.length >= MAX_FEEDS) throw Object.assign(new Error(`最多添加 ${MAX_FEEDS} 个资讯源`), { code: "FEED_INVALID" });
    if (state.feeds.some(feed => feed.url === url && feed !== existing)) throw Object.assign(new Error("这个资讯源已经添加过了"), { code: "FEED_INVALID" });
    const prevUrl = existing?.url;
    if (existing) Object.assign(existing, { name, url, enabled: input.enabled !== false });
    else state.feeds.push({ id: id(), name, url, enabled: input.enabled !== false, createdAt: new Date(now()).toISOString() });
    if (prevUrl) cache.delete(prevUrl);
    cache.delete(url);
    store.write(state);
    return list();
  }

  function remove(feedId) {
    const state = read();
    const targetId = String(feedId || "");
    for (const feed of state.feeds) {
      if (feed.id === targetId) cache.delete(feed.url);
    }
    state.feeds = state.feeds.filter(feed => feed.id !== targetId);
    store.write(state);
    return list();
  }

  async function fetchFeed(feed, signal) {
    // 每次抓取前再校验一遍地址：备份恢复或手改文件带进来的内网地址不会被请求。
    const url = normalizeFeedUrl(feed.url);
    if (!url) throw Object.assign(new Error("资讯源地址不是公网的 https 链接"), { code: "FEED_INVALID" });
    const hit = cache.get(url);
    if (hit && hit.expiresAt > now()) return hit.items;
    // redirect: "error" + publicOnly: true —— 不跟随跳转、强制自定义 DNS 校验公网单播 IP，防止内网探测与 DNS 重绑定。
    const bytes = await fetchBytes(url, { signal, redirect: "error", publicOnly: true, headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } }, { timeoutMs: 8000, retries: 0, maxResponseBytes: MAX_BYTES });
    const items = parseFeed(decodeFeed(bytes));
    cache.set(url, { items, expiresAt: now() + CACHE_MS });
    while (cache.size > 30) cache.delete(cache.keys().next().value);
    return items;
  }

  /** 测试一个地址（不保存）：返回条目数和前 3 条标题。 */
  async function test(urlInput, { signal } = {}) {
    const url = normalizeFeedUrl(urlInput);
    if (!url) throw Object.assign(new Error("资讯源地址要是公网的 https 链接"), { code: "FEED_INVALID" });
    const items = await fetchFeed({ url }, signal);
    if (!items.length) throw Object.assign(new Error("能打开，但没有识别到 RSS / Atom 条目"), { code: "FEED_EMPTY" });
    return { count: items.length, sample: items.slice(0, 3).map(item => item.title) };
  }

  /** 给 AI 用：合并所有启用的源，按关键词和时间窗口过滤，新到旧。 */
  async function news({ query = "", hours = 72, limit = 20, signal } = {}) {
    const feeds = read().feeds.filter(feed => feed.enabled !== false);
    if (!feeds.length) return { items: [], sources: [], failedSources: [], configured: 0 };
    const results = await Promise.allSettled(feeds.map(feed => fetchFeed(feed, signal)));
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const since = now() - Math.max(1, Math.min(24 * 30, Number(hours) || 72)) * 3600_000;
    const words = String(query || "").split(/[\s,，、]+/).map(word => word.trim().toLowerCase()).filter(Boolean).slice(0, 5);
    const seen = new Set();
    const items = [];
    const failed = [];
    results.forEach((result, index) => {
      const feed = feeds[index];
      if (result.status !== "fulfilled") { failed.push(feed.name); return; }
      for (const item of result.value) {
        const ms = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
        if (Number.isFinite(ms) && ms < since) continue;
        const haystack = `${item.title} ${item.summary}`.toLowerCase();
        if (words.length && !words.some(word => haystack.includes(word))) continue;
        const key = item.title.replace(/\s+/g, "").slice(0, 40);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...item, source: feed.name });
      }
    });
    items.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
    return { items: items.slice(0, Math.max(1, Math.min(40, Number(limit) || 20))), sources: feeds.map(feed => feed.name), failedSources: failed, configured: feeds.length };
  }

  return { list, save, remove, test, news };
}

module.exports = { createRssFeeds, parseFeed, normalizeFeedUrl, plainText, isFeedStore, isPublicUnicastIp, createPublicLookup };
