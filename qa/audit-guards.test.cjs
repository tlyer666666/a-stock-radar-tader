"use strict";
// 2026-10-24 全链路审计第一批守卫（DEP-3 / TEST-8 / SEC-1 / DEP-4）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { builtinModules } = require("node:module");
const root = path.resolve(__dirname, "..");

test("DEP-3: the strategy catalog in config/ matches the engine definitions (rerun qa/update-strategy-catalog.cjs after changing a strategy)", () => {
  const { ALL_STRATEGY_DEFINITIONS } = require("../electron/strategy-signal-engine.cjs");
  const generated = ALL_STRATEGY_DEFINITIONS.map(({ matches: _m, reasons: _r, componentEvidence: _e, ...metadata }) => metadata);
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, "config/strategy-signal-catalog.json"), "utf8"));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(generated)));
});

// 交易日历既要有余量，也必须是"结构有效"的：手工补录一旦写出越界/重叠/乱序区间，
// 运行期 createTradingCalendar 会直接抛 TypeError（应用启动失败），所以在这里先挡住。
const CALENDAR_DOC = "docs/operations/market-calendar-update.md";
const isPlainDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

test("TEST-8: the bundled exchange calendar is structurally valid and has not expired (warns 60 days ahead)", t => {
  const calendar = JSON.parse(fs.readFileSync(path.join(root, "config/a-share-market-calendar.json"), "utf8"));
  assert.match(String(calendar.version), /^SSE-closures-\d{4}-\d{4}-v\d+$/, "版本号应形如 SSE-closures-2025-2026-v1");
  assert.ok(isPlainDate(calendar.coveredFrom), "coveredFrom 必须是 YYYY-MM-DD");
  assert.ok(isPlainDate(calendar.coveredTo), "coveredTo 必须是 YYYY-MM-DD");
  assert.ok(calendar.coveredFrom <= calendar.coveredTo, "coveredFrom 不能晚于 coveredTo");
  assert.ok(Array.isArray(calendar.sources) && calendar.sources.length > 0, "必须记录官方来源 URL");
  for (const url of calendar.sources) assert.match(String(url), /^https:\/\//, `来源必须是 https URL: ${url}`);
  assert.ok(Array.isArray(calendar.closedRanges), "closedRanges 必须是数组");
  let previousTo = null;
  for (const range of calendar.closedRanges) {
    assert.ok(Array.isArray(range) && range.length === 2 && range.every(isPlainDate), `休市区间格式无效: ${JSON.stringify(range)}`);
    const [from, to] = range;
    assert.ok(from <= to, `休市区间起止颠倒: ${from} > ${to}`);
    assert.ok(from >= calendar.coveredFrom && to <= calendar.coveredTo, `休市区间越出覆盖范围: ${from}..${to}`);
    if (previousTo !== null) assert.ok(from > previousTo, `休市区间重叠或未按时间排序: ${JSON.stringify(range)}`);
    previousTo = to;
  }
  // 覆盖到 coveredTo 当天收盘为止（北京时间当天 24:00）。
  const daysLeft = (Date.parse(`${calendar.coveredTo}T24:00:00+08:00`) - Date.now()) / 86400000;
  // 次年休市安排一般 11–12 月才公布：到期前 60 天起只提示，真正过期才让测试失败
  // （过期后软件按中证全指实际交易日推断，不会停摆，但应尽快补上官方日历）。
  if (daysLeft < 60) t.diagnostic(`交易日历只覆盖到 ${calendar.coveredTo}（剩 ${Math.floor(daysLeft)} 天）：交易所公布次年休市安排后按 ${CALENDAR_DOC} 补充`);
  assert.ok(daysLeft >= 0, `交易日历已过期（只覆盖到 ${calendar.coveredTo}）：请按 ${CALENDAR_DOC} 补充次年休市安排`);
});

test("SEC-1: the embedded hexin-v script is byte-for-byte the audited copy (any change needs a manual review and a new fingerprint)", () => {
  const source = fs.readFileSync(path.join(root, "electron/ths-hexin-v.cjs"), "utf8");
  const literal = source.match(/const HEXIN_V_SOURCE = (".*?");\r?\n/s);
  assert.ok(literal, "HEXIN_V_SOURCE string constant not found");
  const digest = crypto.createHash("sha256").update(JSON.parse(literal[1])).digest("hex");
  assert.equal(digest, "0163e41dfdcbd889755142f4179a83a8d9f575f5343a56413546cc7fc0262376");
});

test("DEP-4: the main process requires only electron, Node built-ins and its own files (zero runtime npm dependencies)", () => {
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  const offenders = [];
  for (const file of fs.readdirSync(path.join(root, "electron")).filter((name) => name.endsWith(".cjs") && !name.endsWith(".test.cjs"))) {
    const source = fs.readFileSync(path.join(root, "electron", file), "utf8");
    for (const match of source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
      const id = match[1];
      if (id === "electron" || builtins.has(id)) continue;
      if (id.startsWith(".")) {
        // 相对路径只能指向 electron/ 或 config/ 里的文件（随安装包一起打包）。
        const target = path.resolve(root, "electron", id);
        const inside = ["electron", "config"].some((dir) => target.startsWith(path.join(root, dir) + path.sep));
        if (inside) continue;
      }
      offenders.push(`${file}: ${id}`);
    }
    // 动态加载无法静态核对依赖：非字面量 require、import()、createRequire 一律拒绝。
    for (const match of source.matchAll(/\brequire\(\s*(?!["'])([^)]{0,40})/g)) offenders.push(`${file}: require(${match[1]})`);
    for (const match of source.matchAll(/\bimport\(\s*([^)]{0,40})/g)) offenders.push(`${file}: import(${match[1]})`);
    if (/\bcreateRequire\b/.test(source)) offenders.push(`${file}: createRequire`);
  }
  // 构建/打包脚本只在开发机运行，不进安装包。
  const buildOnly = /^(build-unpacked|build-platform|deploy-formal|after-pack-fuses|deploy-single-app|build-runtime-fuses)\.cjs:/;
  assert.deepEqual(offenders.filter((item) => !buildOnly.test(item)), []);
});

test('unit-test isolation blocks public fetch and native HTTPS before network access', () => {
  const { spawnSync } = require('node:child_process');
  const script = `Promise.resolve().then(async()=>{const codes=[];try{await fetch('https://example.invalid/')}catch(error){codes.push(error.code)}try{require('node:https').request('https://example.invalid/')}catch(error){codes.push(error.code)}console.log(JSON.stringify(codes))});`;
  const result = spawnSync(process.execPath, ['--require', path.join(root, 'qa/test-env.cjs'), '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), ['TEST_NETWORK_BLOCKED','TEST_NETWORK_BLOCKED']);
});

test("CASE-1: no two source modules differ only by letter case (macOS builds resolve './AgentMarkdown' to agentMarkdown.ts)", () => {
  // 1.6.53 装机时出过：Linux 上构建通过，macOS 大小写不敏感，导入解析到同名不同大小写的另一个文件，打包失败。
  const seen = new Map(), clashes = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(relative); continue; }
      const key = relative.replace(/\.(tsx?|jsx?|cjs|mjs|css|json)$/i, "").toLowerCase();
      const other = seen.get(key);
      if (other && other !== relative) clashes.push(`${other} ↔ ${relative}`);
      else seen.set(key, relative);
    }
  };
  for (const dir of ["src", "electron", "qa", "config"]) walk(dir);
  assert.deepEqual(clashes, []);
});
