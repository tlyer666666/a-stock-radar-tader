"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStudy, registerTrial, sealHoldout, evaluateStudyStage, neighboringConfigs, correlationCoverage, runSensitivity, runWalkForward, appendForwardRecord } = require("./trend-research-protocol.cjs");
const spec = { studyId: "demo", hypothesis: "Frozen quality vs classic", createdAt: "2026-01-01T00:00:00Z", stages: {
  development: { from: "2025-01-01", to: "2025-03-31" }, validation: { from: "2025-04-01", to: "2025-06-30" }, finalHoldout: { from: "2025-07-01", to: "2025-09-30" } }, familySize: 3 };
const trial = { trialId: "q1", strategyId: "quality-v2", config: {}, rationale: "predeclared", registeredAt: "2026-01-01T00:00:00Z" };
function prepared() { return registerTrial(createStudy(spec), trial); }
function fakeEvaluator(options) { return { provenance: { dataHash: "d" }, range: options, baseline: { samples: [], metrics: {} }, advanced: { samples: [], metrics: {} }, qualification: { returnSuperiorityVerified: false } }; }
test("study validates disjoint stages and hashes frozen trial parameters", () => {
  assert.throws(() => createStudy({ ...spec, stages: { ...spec.stages, validation: { from: "2025-03-31", to: "2025-06-30" } } }), /overlap|ordered/);
  const study = prepared();
  assert.match(study.trials[0].configHash, /^[a-f0-9]{64}$/);
  assert.throws(() => registerTrial(study, trial), /duplicate/);
});
test("holdout requires a seal and reuse is blocked even for a new trial", () => {
  const study = prepared();
  assert.throws(() => evaluateStudyStage(study, { trialId: "q1", stage: "finalHoldout", dataset: {} }, fakeEvaluator), /seal/);
  const sealed = sealHoldout(study, { trialId: "q1", sealedAt: "2026-01-01T00:01:00Z" });
  assert.throws(() => registerTrial(sealed, { ...trial, trialId: "q2" }), /sealed/);
  const result = evaluateStudyStage(sealed, { trialId: "q1", stage: "finalHoldout", dataset: {} }, fakeEvaluator);
  assert.equal(result.study.runs.length, 1);
  assert.equal(result.report.range.to, spec.stages.finalHoldout.to);
  assert.throws(() => evaluateStudyStage(result.study, { trialId: "q1", stage: "finalHoldout", dataset: {} }, fakeEvaluator), /reuse|already/);
  const tampered = structuredClone(sealed); tampered.trials[0].strategy.config.maxVolumeRatio = 2;
  assert.throws(() => evaluateStudyStage(tampered, { trialId: "q1", stage: "finalHoldout", dataset: {} }, fakeEvaluator), /integrity/);
});
test("neighbor sensitivity records each attempt and cannot use final holdout", () => {
  const neighbors = neighboringConfigs({ maxExtensionAtr: 2, minCloseLocation: .7, maxVolumeRatio: 3 });
  assert.equal(neighbors.length, 7);
  assert.equal(new Set(neighbors.map(config => JSON.stringify(config))).size, 7);
  const result = runSensitivity(createStudy(spec), { trialPrefix: "grid", baseConfig: { maxExtensionAtr: 2, minCloseLocation: .7, maxVolumeRatio: 3 }, stage: "development", dataset: {} }, fakeEvaluator);
  assert.equal(result.study.trials.length, 7);
  assert.equal(result.study.runs.length, 7);
  assert.equal(result.multipleComparison.familySize, 7);
  assert.ok(result.results.every(item => item.report.researchProtocol.multipleComparison.familySize === 7));
  assert.throws(() => runSensitivity(createStudy(spec), { stage: "finalHoldout" }), /holdout/);
});
test("correlation guard reduces repeated same-security and overlapping holding windows", () => {
  const coverage = correlationCoverage([
    { code: "a", signalDate: "2025-01-02", entryDate: "2025-01-03", exitDate: "2025-01-07" },
    { code: "a", signalDate: "2025-01-03", entryDate: "2025-01-06", exitDate: "2025-01-08" },
    { code: "b", signalDate: "2025-01-03", entryDate: "2025-01-06", exitDate: "2025-01-08" }
  ]);
  assert.equal(coverage.rawSignals, 3);
  assert.equal(coverage.securityClusters, 2);
  assert.equal(coverage.nonoverlappingDateBlocks, 1);
  assert.equal(coverage.conservativeEffectiveIndependentUnits, 1);
});
test("rolling evaluation keeps every sample-out window after development and before final holdout", () => {
  const result = runWalkForward(prepared(), { trialId: "q1", dataset: {}, windows: [
    { trainFrom: "2025-01-01", trainTo: "2025-03-31", testFrom: "2025-04-01", testTo: "2025-04-30" },
    { trainFrom: "2025-02-01", trainTo: "2025-04-30", testFrom: "2025-05-01", testTo: "2025-05-31" }
  ] }, fakeEvaluator);
  assert.equal(result.windows.length, 2);
  assert.equal(result.study.runs.length, 4);
  assert.equal(result.windows[0].test.range.to, "2025-04-30");
  assert.throws(() => runWalkForward(prepared(), { trialId: "q1", dataset: {}, windows: [{ trainFrom: "2025-01-01", trainTo: "2025-04-02", testFrom: "2025-04-01", testTo: "2025-08-01" }] }, fakeEvaluator), /ordered|holdout/);
});
test("forward journal freezes signals and expected fills and forbids fabricated future actuals", () => {
  const now = "2026-10-21T08:00:00Z";
  let journal = appendForwardRecord([], { type: "signal", id: "s1", code: "600001", signalDate: "2026-10-21", observedAt: now, strategy: { id: "quality-v2", configHash: "h" }, source: "public", plan: { stop: 9, maxEntry: 10 } }, now);
  journal = appendForwardRecord(journal, { type: "expected-fill", id: "e1", signalId: "s1", observedAt: now, executionDate: "2026-10-22", assumptions: { limit: 10 } }, now);
  assert.equal(journal.length, 2);
  assert.throws(() => appendForwardRecord(journal, { type: "actual-fill", id: "a1", signalId: "s1", observedAt: now, filledAt: "2026-10-22T01:30:00Z", price: 10, shares: 100, evidence: "broker" }, now), /future/);
  assert.throws(() => appendForwardRecord(journal, { ...journal[0], plan: { stop: 8 } }, now), /duplicate/);
  const next = "2026-10-22T01:31:00Z";
  journal = appendForwardRecord(journal, { type: "actual-fill", id: "a1", signalId: "s1", observedAt: next, filledAt: "2026-10-22T01:30:00Z", price: 10, shares: 100, evidence: "paper observation", mode: "paper" }, next);
  assert.equal(journal.at(-1).mode, "paper");
  assert.equal(journal.at(-1).returnSuperiorityVerified, false);
});

test("failed holdout evaluation is journaled as a consumed attempt", () => {
  const sealed = sealHoldout(prepared(), { trialId: "q1", sealedAt: "2026-01-01T00:01:00Z" });
  const result = evaluateStudyStage(sealed, { trialId: "q1", stage: "finalHoldout", dataset: {} }, () => { throw new TypeError("invalid data"); });
  assert.equal(result.study.runs[0].status, "failed");
  assert.equal(result.report.error, "invalid data");
  assert.throws(() => evaluateStudyStage(result.study, { trialId: "q1", stage: "finalHoldout", dataset: {} }, fakeEvaluator), /reuse|already/);
});

test("same-day actual fill before frozen next-day expectation is retained as an execution-date mismatch", () => {
  const signalTime = "2026-10-21T08:00:00Z";
  let journal = appendForwardRecord([], { type: "signal", id: "s-date", code: "600001", signalDate: "2026-10-21", observedAt: signalTime, strategy: { id: "quality-v2", configHash: "h" }, source: "paper observation", plan: { stop: 9 } }, signalTime);
  const expectedTime = "2026-10-21T08:01:00Z";
  journal = appendForwardRecord(journal, { type: "expected-fill", id: "e-date", signalId: "s-date", observedAt: expectedTime, executionDate: "2026-10-22", assumptions: { price: 10 } }, expectedTime);
  journal = appendForwardRecord(journal, { type: "actual-fill", id: "a-date", signalId: "s-date", observedAt: "2026-10-21T08:03:00Z", filledAt: "2026-10-21T08:02:00Z", price: 10, shares: 100, evidence: "paper observation", mode: "paper" }, "2026-10-21T08:03:00Z");
  const actual = journal.at(-1);
  assert.equal(actual.prospective, false);
  assert.equal(actual.executionDateMatchesExpectation, false);
  assert.ok(actual.mismatchReasons.includes("actual_execution_date_differs_from_expected"));
  assert.equal(actual.filledAt, "2026-10-21T08:02:00Z");
});
