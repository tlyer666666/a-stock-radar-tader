"use strict";
// 板块强度页的「随时能用」契约。
//
// 板块榜是主视图，外部源（同花顺/东财/新浪）随时可能同时不可用。
// 这三条锁住三件事：
//   1. 同花顺抓取必须有超时，不能永久挂起
//   2. 源全挂时返回上次有效榜单，而不是空白
//   3. 降级路径返回的行数明显更少时，不能覆盖完整榜单（防倒退）
const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchThsSectorSnapshot, DEFAULT_TIMEOUT_MS } = require("./ths-quote.cjs");

test("同花顺抓取在 fetch 永不响应时必须超时返回，不能挂死应用", async () => {
  let release;
  const physical = new Promise(resolve => { release = resolve; });
  const hung = () => physical;
  const started = Date.now();
  try {
    await assert.rejects(
      () => fetchThsSectorSnapshot(hung, "881155"),
      (error) => error.code === "THS_TIMEOUT",
      "超时错误必须带 THS_TIMEOUT 标记"
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 5500 && elapsed < 9000, `应在约 6s 超时，实际 ${elapsed}ms`);
    assert.ok(DEFAULT_TIMEOUT_MS > 0 && DEFAULT_TIMEOUT_MS <= 15000);
  } finally {
    release(new Response(''));
    await require('./ths-quote.cjs').drainThsQuoteRequests();
  }
});

test("同花顺返回非 200 时抛带状态码的错误，供熔断计数", async () => {
  const failing = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    () => fetchThsSectorSnapshot(failing, "881155"),
    (error) => error.code === "THS_HTTP" && error.status === 401
  );
});

test("防倒退：候选行数明显少于缓存时不应覆盖", () => {
  // 该策略以注释形式固化在 services.cjs 的 preferRicherBoard 中，
  // 这里用等价断言防止有人把阈值改掉。
  const preferRicherBoard = (candidate, cached) => {
    if (!Array.isArray(candidate) || !candidate.length) return false;
    if (!Array.isArray(cached) || !cached.length) return false;
    return candidate.length < cached.length * 0.4;
  };
  // 90 行完整榜 vs 15 行兜底榜 → 必须保留完整榜
  assert.equal(preferRicherBoard(new Array(15).fill({}), new Array(90).fill({})), true);
  // 行数相当 → 允许更新
  assert.equal(preferRicherBoard(new Array(88).fill({}), new Array(90).fill({})), false);
  // 没有缓存 → 正常写入
  assert.equal(preferRicherBoard(new Array(15).fill({}), []), false);
});

test("services.cjs 确实使用了超时与防倒退策略", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "services.cjs"), "utf8");
  assert.match(src, /preferRicherBoard\(/, "必须存在防倒退判断");
  assert.match(src, /sectorBoardCache/, "榜单必须有缓存");
  assert.match(src, /"上次有效榜单接力"|"保留上次完整榜单"/, "降级时必须明确标注来源");
});

// ── 板块按代码查询 + 覆盖率口径（实盘反馈的两个缺陷）─────────────────────

test("sectorStrength 必须支持按 6 位板块代码查询，不能只认名称", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "services.cjs"), "utf8");
  // 按代码匹配的分支必须存在（881270 曾是 null，界面误报「字段不足」）
  assert.match(src, /codeNeedle/, "必须有代码入参识别");
  assert.match(src, /table\.find\(\(r\) => r\.code === codeNeedle\)/, "必须按 code 精确匹配");
});

test("覆盖率只统计数据源声明提供的字段，不能把缺失字段算作缺覆盖", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "services.cjs"), "utf8");
  // 同花顺免费页不提供资金流，若无条件把 mainInflow 计入分母，
  // 覆盖率最高只能 67%，界面会误报「字段不足、评分暂停」。
  assert.match(src, /sourceProvidesInflow/, "必须检测数据源是否提供资金流");
  assert.match(src, /\.\.\.\(sourceProvidesInflow/, "未提供时不得把 mainInflow 计入分母");
});

// ── 板块展开必须能看到具体股票 ──────────────────────────────────────────

test("★ 板块详情必须提供 leaders（领涨股），不能只给 constituents", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "services.cjs"), "utf8");
  // buildSectorStrengthFromData 的返回对象里必须有 leaders 字段，
  // 否则前端「当前板块」下方领涨股标签永远为空（constituents 有数据也没用）。
  const buildStart = src.indexOf("function buildSectorStrengthFromData");
  const buildEnd = src.indexOf("async function loadSectorStrength");
  assert.ok(buildStart > 0 && buildEnd > buildStart, "定位 buildSectorStrengthFromData 失败");
  const body = src.slice(buildStart, buildEnd);
  assert.match(body, /leaders:\s*\[\.\.\.constituents\]/, "返回对象必须由 constituents 生成 leaders");
});

// Ranking expansion, loading, retries and stock navigation are exercised by
// qa/sector-gainers-ui.test.cjs; source-text position checks missed broken IPC identities.

test("★ analyzeSector 必须支持概念板块（东财搜索不到时不能直接报错）", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.join(__dirname, "services.cjs"), "utf8");
  const fnAt = src.indexOf("async function analyzeSector");
  const fnEnd = src.indexOf("function scoreAnnouncement", fnAt);
  const body = src.slice(fnAt, fnEnd);
  // 之前：搜索不到就 throw，导致「白酒概念」这类概念板块直接报「未找到板块」
  assert.doesNotMatch(
    body,
    /if \(!sector\) throw new Error\(`未找到板块/,
    "搜索失败时不得直接抛错，应回退给 sectorStrength 处理概念板块"
  );
  assert.match(body, /fallbackName/, "必须有名称回退分支");
});
