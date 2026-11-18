"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
const restore = registerTypeScript();
const { resolveMarketSessionPhase, buildCopilotAlerts } = require("./copilotBriefing.ts");

test("resolveMarketSessionPhase maps Shanghai weekday sessions and weekends accurately", () => {
  // 2026-11-16 is Monday
  assert.equal(resolveMarketSessionPhase(Date.parse("2026-11-16T09:15:00+08:00")).id, "preopen");
  assert.equal(resolveMarketSessionPhase(Date.parse("2026-11-16T10:30:00+08:00")).id, "intraday");
  assert.equal(resolveMarketSessionPhase(Date.parse("2026-11-16T12:00:00+08:00")).id, "midday");
  assert.equal(resolveMarketSessionPhase(Date.parse("2026-11-16T14:30:00+08:00")).id, "intraday");
  assert.equal(resolveMarketSessionPhase(Date.parse("2026-11-16T15:20:00+08:00")).id, "afterclose");
  // 2026-11-14 is Saturday
  assert.equal(resolveMarketSessionPhase(Date.parse("2026-11-14T10:30:00+08:00")).id, "closed");
});

test("buildCopilotAlerts prioritizes source/risk/note/t-signal/monitor alerts without duplicates", () => {
  const alerts = buildCopilotAlerts({
    sourceNotice: { key: "ths-down", tone: "down", message: "备用数据源切换中" },
    paperSummary: { dailyStopped: true, portfolioKillWarning: true },
    notes: [
      { id: "n1", text: "到目标价减仓", done: false, remindAt: "2026-11-16T01:30:00Z", firedFor: "2026-11-16T01:30:00Z", stock: { code: "600519", name: "贵州茅台" } },
      { id: "n2", text: "已完成笔记", done: true, remindAt: "2026-11-16T01:30:00Z", firedFor: "2026-11-16T01:30:00Z" }
    ],
    tItems: [{ code: "000001", name: "平安银行" }],
    tRuntimes: {
      "000001": {
        analysis: {
          signal: { action: "buy", strength: "strong", title: "低吸（正T）", price: 10.2, shares: 200, reasons: ["回踩下轨企稳"] }
        }
      }
    },
    monitorAlerts: [{ id: "m1", code: "300750", name: "宁德时代", triggeredAt: "2026-11-16T02:00:00Z", detail: "突破设定高点" }]
  });
  assert.deepEqual(alerts.map((item) => item.kind), ["source", "risk", "note", "t-signal", "monitor"]);
  assert.equal(alerts[2].stock.code, "600519");
  assert.match(alerts[3].title, /低吸（正T）/);
});

test.after(() => restore?.());
