"use strict";
// 同花顺 hexin-v 反爬令牌 + 数据中心资金流的契约测试。
const test = require("node:test");
const assert = require("node:assert/strict");
const { getHexinToken, getHexinDiagnostics } = require("./ths-hexin-v.cjs");
const { parseThsFundFlowTable } = require("./ths-quote.cjs");

test("hexin-v token 可生成且长度合理", () => {
  const token = getHexinToken();
  assert.ok(typeof token === "string");
  assert.ok(token.length >= 20, `token 长度应 >= 20，实际 ${token.length}`);
});

test("hexin-v token 在同一 TTL 内复用（不重复执行混淆 JS）", () => {
  const a = getHexinToken();
  const b = getHexinToken();
  assert.equal(a, b, "未过期时应复用缓存");
  const forced = getHexinToken(true);
  assert.ok(typeof forced === "string");
});

test("诊断信息结构完整", () => {
  getHexinToken();
  const diag = getHexinDiagnostics();
  assert.equal(typeof diag.available, "boolean");
  assert.ok("ageMs" in diag);
  assert.ok("lastError" in diag);
});

test("资金流表解析：取净额/流入/流出/领涨股", () => {
  const html = `<table><tr>
    <th>序号</th><th>行业</th><th>行业指数</th><th>涨跌幅</th>
    <th>流入资金(亿)</th><th>流出资金(亿)</th><th>净额(亿)</th><th>公司家数</th>
    <th>领涨股</th><th>涨跌幅</th><th>当前价(元)</th>
  </tr>
  <tr><td>1</td><td>厨卫电器</td><td>5999.13</td><td>2.80%</td><td>4.40</td><td>3.65</td><td>0.74</td><td>9</td><td>亿田智能</td><td>18.34%</td><td>33.23</td></tr>
  <tr><td>2</td><td>银行</td><td>1412.01</td><td>1.55%</td><td>131.00</td><td>82.26</td><td>48.74</td><td>84</td><td>苏州银行</td><td>3.89%</td><td>9.35</td></tr>
  </table>`;
  const rows = parseThsFundFlowTable(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "厨卫电器");
  assert.equal(rows[0].inflow, 4.4);
  assert.equal(rows[0].outflow, 3.65);
  assert.equal(rows[0].netInflow, 0.74);
  assert.equal(rows[0].leaderName, "亿田智能");
  assert.equal(rows[0].leaderChangePct, 18.34);
  assert.equal(rows[1].name, "银行");
  assert.equal(rows[1].netInflow, 48.74);
  // 流入 - 流出 应约等于净额（校验字段没串位）
  assert.ok(Math.abs((rows[1].inflow - rows[1].outflow) - rows[1].netInflow) < 0.01);
});

test("资金流表解析：表头行与非法行被跳过", () => {
  const html = `<table>
    <tr><td>序号</td><td>行业</td><td>指数</td><td>涨跌幅</td><td>a</td><td>b</td><td>c</td><td>d</td></tr>
    <tr><td>1</td><td>X</td><td>1</td><td>1%</td><td>1</td><td>1</td><td>0</td><td>1</td><td>Y</td><td>1%</td><td>1</td></tr>
  </table>`;
  const rows = parseThsFundFlowTable(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "X");
});

// ── 板块覆盖率与评分：不得再写死 ────────────────────────────────────────

test("资金流解析必须带上板块代码（否则无法取成分与指数行情）", () => {
  const { parseThsFundFlowTable } = require("./ths-quote.cjs");
  // 真实页面的板块名是 <a href=".../thshy/detail/code/881270/">元件</a>
  const html = `<table><tr><td>序号</td><td>行业</td></tr>
    <tr><td>1</td>
      <td class="tl"><a href="http://q.10jqka.com.cn/thshy/detail/code/881270/" target="_blank">元件</a></td>
      <td>24484.6</td><td>0.51%</td><td>276.23</td><td>263.77</td><td>12.46</td><td>63</td>
      <td>四会富仕</td><td>19.99%</td><td>76.94</td></tr>
  </table>`;
  const [row] = parseThsFundFlowTable(html);
  assert.equal(row.code, "881270", "必须从 <a> 链接里抽出 6 位板块代码");
  assert.equal(row.name, "元件");
  assert.equal(row.changePct, 0.51);
  assert.equal(row.netInflow, 12.46);
});

/** 去掉注释行，避免把说明文字当成代码来断言 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

test("★ 榜单覆盖率不得写死为 33：必须按实际字段计算", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = stripComments(fs.readFileSync(path.join(__dirname, "services.cjs"), "utf8"));
  // 曾经这里写 `dataCoveragePercent: 33`，导致界面永远显示「只覆盖三分之一」
  assert.doesNotMatch(src, /dataCoveragePercent:\s*33\b/, "不得再有写死的 33%");
  assert.match(src, /boardRowCoverage\(/, "必须用真实字段覆盖函数");
});

test("★ 榜单评分不得写死为 null：必须用真实公式算", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = stripComments(fs.readFileSync(path.join(__dirname, "services.cjs"), "utf8"));
  assert.match(src, /scoreBoardRow\(/, "必须有榜单评分函数");
  // 只看「主榜单路径」那一段：从 publicTable?.length 到兜底路径之前。
  // 兜底行（多源均不可用）保留 score: null 是正确的 —— 那时确实没有数据可评分。
  const start = src.indexOf("if (publicTable?.length)");
  const end = src.indexOf("for (const [industry, stocks] of", start);
  const boardBlock = src.slice(start, end > 0 ? end : start + 6000);
  assert.doesNotMatch(boardBlock, /score:\s*null/, "主榜单行不得写死 score: null");
});
