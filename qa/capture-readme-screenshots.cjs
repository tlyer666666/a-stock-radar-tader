"use strict";

// README 截图：先 `pnpm build:web && npx vite preview --port 4173`，再运行 `pnpm docs:screenshots`。
// 页面使用内置演示数据（?preview=1）；AI 问股接入演示接口，回答是演示文字，不调用模型。
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

const BASE_URL = process.env.README_PREVIEW_URL || "http://127.0.0.1:4173/?preview=1";

function resolveBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.QA_CHROMIUM_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean);
  const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) {
    throw new Error("Chrome or Edge was not found. Set CHROME_PATH to a Chromium-compatible browser.");
  }
  return executablePath;
}

const DEMO_ANSWER = [
  "**结论（演示）：缩量回调中，接近底部反转打法的观察条件，但风险收益比一般，等放量确认再考虑。**", "",
  "### 打法：底部反转", "- 距 60 日线仍有一段距离，属于深跌后的修复阶段", "- 近 5 日成交量逐步萎缩，尚未出现放量阳线确认", "",
  "### 打法：风险收益比", "| 类型 | 价位 | 依据 |", "|---|---:|---|", "| 止损 | 84.80 | 近 10 日低点 |", "| 目标 | 91.50 | 20 日线 |", "",
  "> 演示数据：浏览器预览不调用模型，以上内容仅展示界面样式。", "",
  "### 操作思路", "1. 已持有：跌破止损位减仓。", "2. 未持有：等放量站上 20 日线再考虑。"
].join("\n");

/** 预览接口没有 AI 问股；截图时注入一段固定的演示对话。 */
function agentDemoScript() {
  const skills = require("../electron/stock-agent-skills.cjs");
  const tools = require("../electron/stock-agent-tools.cjs").STOCK_AGENT_TOOLS.map((tool) => ({ id: tool.id, name: tool.name }));
  const catalog = skills.skillCatalog([], (id) => tools.find((tool) => tool.id === id)?.name || id);
  return `(() => {
    const catalog = ${JSON.stringify(catalog)}; const tools = ${JSON.stringify(tools)};
    const now = new Date().toISOString();
    const focus = { code: "600519", name: "贵州茅台" };
    const tags = [{ id: "bottom_reversal", name: "底部反转" }, { id: "risk_reward", name: "风险收益比" }];
    const call = (tool, name, args) => ({ tool, name, args, status: "ok", summary: "演示数据" });
    const steps = [
      { kind: "prefetch", thought: "先读取行情、日线体检、近期K线和所属板块", calls: [call("quote", "实时行情", "code=600519"), call("profile", "日线体检", "code=600519"), call("kline", "近期K线", "code=600519 days=40"), call("sector", "所属板块", "code=600519")] },
      { kind: "tools", thought: "再看市场情绪和相关资讯", calls: [call("market", "市场情绪", ""), call("news", "相关资讯", "code=600519")] }];
    const conversation = { id: "c1", title: "贵州茅台 · 全面分析", focus, createdAt: now, updatedAt: now, messages: [
      { id: "m1", role: "user", content: "全面分析贵州茅台：走势、量能、消息、板块和明天的操作思路", at: now, focus, skills: tags },
      { id: "m2", role: "assistant", content: ${JSON.stringify(DEMO_ANSWER)}, stance: "中性", confidence: "中", followUps: ["明天怎么操作？", "支撑在哪？", "和五粮液比呢？"],
        steps, model: "deepseek-chat", at: now, durationMs: 96000, focus, skills: tags,
        skillVerdicts: [{ id: "bottom_reversal", skill: "底部反转", verdict: "接近", reason: "缩量回调，尚未放量确认" }, { id: "risk_reward", skill: "风险收益比", verdict: "不符合", reason: "目标空间只有止损的 1.3 倍" }] }] };
    const market = { id: "c2", title: "今日市场 · 情绪怎么样", focus: null, createdAt: now, updatedAt: now, messages: [] };
    const state = () => ({ configured: true, model: "deepseek-chat", profileName: "DeepSeek", profileId: "", activeProfileId: "p1",
      profiles: [{ id: "p1", name: "DeepSeek", model: "deepseek-chat" }], memory: "",
      conversations: [conversation, market].map(c => ({ id: c.id, title: c.title, focus: c.focus, createdAt: c.createdAt, updatedAt: c.updatedAt, turns: 1, stance: c === conversation ? "中性" : undefined, running: false })),
      tools, skills: catalog, skillIds: tags.map(tag => tag.id) });
    const agent = { state: async () => state(), conversation: async id => structuredClone(id === "c1" ? conversation : market),
      start: async () => { throw new Error("演示接口"); }, poll: async () => null, cancel: async () => null, remove: async () => state(),
      settings: async () => state(), saveSkill: async () => state(), removeSkill: async () => state() };
    let api;
    Object.defineProperty(window, "stockApi", { configurable: true, get() { return api; }, set(value) { api = value; if (value) { value.ai = value.ai || {}; value.ai.agent = agent; } } });
  })();`;
}

async function capture(browser, outputRoot, file, { nav, theme, prepare } = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  try {
    await page.addInitScript(agentDemoScript());
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.locator("[data-window-controls]").waitFor({ timeout: 20_000 });
    if (theme) { await page.getByRole("button", { name: theme }).first().click(); await page.waitForTimeout(300); }
    if (nav) { await page.getByRole("button", { name: nav, exact: true }).first().click(); await page.waitForTimeout(2500); }
    if (prepare) await prepare(page);
    await page.screenshot({ path: path.join(outputRoot, file), fullPage: false });
  } finally {
    await page.close();
  }
}

async function run() {
  const outputRoot = path.resolve("docs", "images");
  fs.mkdirSync(outputRoot, { recursive: true });

  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
    args: ["--disable-gpu"]
  });

  try {
    await capture(browser, outputRoot, "dashboard.png", { nav: "涨停监控", theme: "黑夜", async prepare(page) {
      await page.locator("button", { hasText: "连板天梯" }).first().click();
      await page.waitForTimeout(800);
    } });
    await capture(browser, outputRoot, "strategy-selection.png", { nav: "策略选股", theme: "白天" });
    await capture(browser, outputRoot, "ai-agent.png", { nav: "AI 问股", theme: "白天", async prepare(page) {
      await page.locator(".ai-agent-thread-open").first().click();
      await page.waitForTimeout(1500);
    } });
    await capture(browser, outputRoot, "sector-strength.png", { nav: "板块强度", theme: "白天" });
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { resolveBrowserExecutable, run };
