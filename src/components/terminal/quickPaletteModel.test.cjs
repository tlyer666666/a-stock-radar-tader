"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

const restoreTypeScript = registerTypeScript();
const { buildPaletteEntries } = require("./quickPaletteModel.ts");

test("buildPaletteEntries prioritizes holdings/favorites/watchlist, matches by code and keyword", () => {
  const baseInput = {
    query: "",
    views: [
      { id: "cockpit", label: "今日驾驶舱", group: "工作区" },
      { id: "holdings", label: "持仓股", group: "工作区" },
      { id: "t-assistant", label: "做T助手", group: "工作区" }
    ],
    commands: [
      { id: "toggle-privacy", label: "开启隐私脱敏模式（隐藏金额）", group: "快捷控制", keywords: "privacy mask" }
    ],
    holdings: [
      { code: "600519", name: "贵州茅台", secid: "1.600519", shares: 200, costPrice: 1450, createdAt: "", updatedAt: "" }
    ],
    favorites: [
      { code: "600519", name: "贵州茅台", secid: "1.600519", createdAt: "" },
      { code: "300750", name: "宁德时代", secid: "0.300750", createdAt: "" }
    ],
    watchlist: [
      { code: "000001", name: "平安银行", secid: "0.000001", createdAt: "" }
    ]
  };

  const all = buildPaletteEntries(baseInput);
  assert.equal(all[0].kind, "stock");
  assert.equal(all[0].badge, "持仓");
  assert.equal(all.filter(entry => entry.kind === "stock" && entry.security.code === "600519").length, 1);

  const byCode = buildPaletteEntries({ ...baseInput, query: "300750" });
  assert.equal(byCode[0].kind, "stock");
  assert.equal(byCode[0].security.name, "宁德时代");

  const byCmd = buildPaletteEntries({ ...baseInput, query: "privacy" });
  assert.equal(byCmd[0].kind, "command");
  assert.equal(byCmd[0].commandId, "toggle-privacy");
});

after(() => restoreTypeScript());
