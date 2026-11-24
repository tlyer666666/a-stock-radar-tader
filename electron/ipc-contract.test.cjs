"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const {
  MAIN_IPC_CHANNELS,
  REVIEW_IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  ALL_IPC_CHANNELS,
  VALIDATED_CHANNELS,
  VALIDATORS,
  OPTIONAL_OBJECT_CHANNELS,
  NO_ARG_CHANNELS,
  validateIpcPayload
} = require("./ipc/contract.cjs");
const { loadElectronIpcSources } = require("../qa/ipc-source-loader.cjs");

function loadTsContractModule() {
  const tsPath = path.resolve(__dirname, "../src/shared/ipc-contract.ts");
  const raw = fs.readFileSync(tsPath, "utf8");
  const { outputText } = ts.transpileModule(raw, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  });
  const mod = { exports: {} };
  vm.runInNewContext(outputText, { module: mod, exports: mod.exports });
  return mod.exports;
}

function extractRegisteredChannels() {
  const { ipcEntries } = loadElectronIpcSources();
  const registeredMain = [];
  const registeredReview = [];
  for (const entry of ipcEntries) {
    if (!entry.name.endsWith(".ipc.cjs")) continue;
    const ast = ts.createSourceFile(entry.name, entry.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    (function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "handleTrustedIpc") {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isStringLiteral(firstArg)) {
          registeredMain.push(firstArg.text);
        }
      }
      if (
        entry.name.endsWith("news-review.ipc.cjs")
        && ts.isCallExpression(node)
        && node.expression.getText(ast) === "Object.entries"
        && node.arguments[0]
        && ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const prop of node.arguments[0].properties) {
          if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.name)) {
            registeredReview.push(prop.name.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    })(ast);
  }
  return {
    registeredMain: registeredMain.sort(),
    registeredReview: registeredReview.sort()
  };
}

test("canonical IPC channel contract matches preload, review-preload, main IPC modules, and TypeScript contract", () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const reviewPreloadSource = fs.readFileSync(path.join(__dirname, "review-preload.cjs"), "utf8");

  const preloadChannels = [...new Set([...preloadSource.matchAll(/\binvoke\("([^"]+)"/g)].map(m => m[1]))].sort();
  const reviewPreloadChannels = [...new Set([...reviewPreloadSource.matchAll(/\binvoke\(['"]([^'"]+)['"]/g)].map(m => m[1]))].sort();
  const { registeredMain, registeredReview } = extractRegisteredChannels();
  const tsContract = loadTsContractModule();

  assert.deepEqual(MAIN_IPC_CHANNELS, preloadChannels);
  assert.deepEqual(registeredMain, preloadChannels);
  assert.deepEqual(REVIEW_IPC_CHANNELS, reviewPreloadChannels);
  assert.deepEqual(registeredReview, reviewPreloadChannels);
  assert.equal(ALL_IPC_CHANNELS.length, MAIN_IPC_CHANNELS.length + REVIEW_IPC_CHANNELS.length);

  assert.deepEqual([...tsContract.MAIN_IPC_CHANNELS].sort(), MAIN_IPC_CHANNELS);
  assert.deepEqual([...tsContract.REVIEW_IPC_CHANNELS].sort(), REVIEW_IPC_CHANNELS);
  assert.deepEqual([...tsContract.IPC_EVENT_CHANNELS].sort(), [...IPC_EVENT_CHANNELS].sort());
  assert.deepEqual([...VALIDATED_CHANNELS].sort(), [...ALL_IPC_CHANNELS].sort());
  assert.equal(VALIDATORS.size + OPTIONAL_OBJECT_CHANNELS.size + NO_ARG_CHANNELS.size, ALL_IPC_CHANNELS.length);
});

test("validateIpcPayload enforces structural runtime validation and preserves typed errors", () => {
  assert.throws(() => validateIpcPayload("watchlist:save", ["not-an-array"]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("watchlist:get", [{ unexpected: true }]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("holdings:save", [{}]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("strategy:custom:save", [["array"]]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("strategy:custom:delete", [""]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("service:cancel", ["   "]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("news:analyze-impact", [{ item: "bad" }]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:chart", ["600519", "101", ["bad-options"]]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("backtest:run-portfolio", ["bad-input"]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("backup:run", [["bad"], undefined]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:search", [12345]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("trend-screener:status", [["bad-cursor"]]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:batch-quotes", ["not-an-array"]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:batch-quotes", [[{ code: "600519" }, "bad"]]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:batch-quotes", [[{ code: "12345" }]]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:batch-quotes", [Array.from({ length: 1201 }, (_, i) => ({ code: String(600000 + i) }))]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("strategy:leaderboard", ["bad-options"]), { code: "INVALID_IPC_PAYLOAD" });

  assert.doesNotThrow(() => validateIpcPayload("watchlist:get", []));
  assert.doesNotThrow(() => validateIpcPayload("watchlist:save", [[]]));
  assert.doesNotThrow(() => validateIpcPayload("strategy:leaderboard", []));
  assert.doesNotThrow(() => validateIpcPayload("strategy:leaderboard", [{ statusOnly: true }]));
  assert.doesNotThrow(() => validateIpcPayload("market:chart", [{ code: "600519", name: "贵州茅台" }, 101]));
  assert.doesNotThrow(() => validateIpcPayload("market:chart", ["600519", "101", { limit: 120 }]));
  assert.doesNotThrow(() => validateIpcPayload("backtest:run-portfolio", [undefined]));
  assert.doesNotThrow(() => validateIpcPayload("news:analyze-impact", [{ item: { title: "公告" } }]));
  assert.doesNotThrow(() => validateIpcPayload("trend-screener:status", [{ jobId: "t1", offset: 0 }]));
  assert.doesNotThrow(() => validateIpcPayload("agent:poll", ["run-123"]));
  assert.doesNotThrow(() => validateIpcPayload("market:batch-quotes", [[{ code: "600519" }, { code: "920006", thscode: "920006.BJ" }]]));

  const tsContract = loadTsContractModule();
  assert.equal(tsContract.decodePlainRecord({ ok: true }).ok, true);
  assert.throws(() => tsContract.decodePlainRecord([]), { name: "TypeError" });
  assert.deepEqual(tsContract.decodeArrayPayload([1, 2]), [1, 2]);
  assert.throws(() => tsContract.decodeArrayPayload({}), { name: "TypeError" });
});

test("ai.ipc.cjs forwards serviceRequestRuntime signal to loadAiStockProfiles in ai:rank, ai:review, and ai:custom-rank", async () => {
  const { registerAiIpc } = require("./ipc/ai.ipc.cjs");
  const handlers = new Map();
  const seenSignals = [];
  const controller = new AbortController();
  registerAiIpc({
    handleTrustedIpc: (channel, handler) => handlers.set(channel, handler),
    aiPayload: input => (input && typeof input === "object" ? input : {}),
    aiService: () => ({
      pending: () => ["600519"],
      rank: async () => ({ ranked: [] }),
      review: async () => ({ ok: true }),
      rankCustom: async () => ({ ranked: [] })
    }),
    aiProfiles: () => ({}),
    stockAgent: () => ({}),
    AI_CUSTOM_MAX: 50,
    loadAiStockProfiles: async (targets, options) => {
      seenSignals.push(options?.signal);
      return {
        profiles: targets.map(item => ({ code: String(item.code || "600519"), asOfDate: "2026-01-02" })),
        failed: []
      };
    },
    latestDate: () => "2026-01-02",
    readAiCustomList: () => [{ code: "600519", name: "样本股" }],
    normalizeAiCustomItem: x => x,
    normalizeAiCustomItems: x => x,
    isAiCustomList: () => true,
    readAiFramework: () => ({}),
    normalizeFrameworkState: x => x,
    normalizeCustom: x => x,
    frameworkCatalog: () => ({}),
    isAiFrameworkState: () => true,
    writeJson: () => {},
    settingsForService: () => ({}),
    resolveTestSecret: () => "",
    sameOrigin: () => true,
    getProfessionalReview: async () => ({}),
    recordExternalFactorSnapshot: () => {},
    createReviewSkills: () => ({}),
    getFuyaoReviewData: async () => ({}),
    getSectorStrengthBoard: async () => ({}),
    analyzeSector: async () => ({}),
    situationOf: () => [],
    emitAiStream: () => {},
    setWorkspaceAgentSnapshot: () => {},
    serviceRequestRuntime: () => ({ signal: controller.signal })
  });

  await handlers.get("ai:rank")({}, { picks: [{ code: "600519", name: "样本股" }] });
  await handlers.get("ai:review")({}, { security: { code: "600519", name: "样本股" } });
  await handlers.get("ai:custom-rank")({}, {});
  assert.deepEqual(seenSignals, [controller.signal, controller.signal, controller.signal]);
});
