"use strict";

const { createHash } = require("node:crypto");
const { normalizeTrendStrategy } = require("./trend-strategy.cjs");
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const iso = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const fail = message => { throw new TypeError(message); };
const STAGES = ["development", "validation", "finalHoldout"];
function definition(study) {
  return { schemaVersion: study.schemaVersion, studyId: study.studyId, hypothesis: study.hypothesis, createdAt: study.createdAt, stages: study.stages, familySize: study.familySize };
}
function assertStudy(study) {
  if (!study || study.definitionHash !== hash(definition(study))) fail("study definition integrity mismatch");
  for (const trial of study.trials) if (trial.configHash !== hash({ strategy: trial.strategy, execution: trial.execution, account: trial.account })) fail("trial integrity mismatch");
  let previous = study.definitionHash;
  for (const run of study.runs) {
    const { recordHash, ...body } = run;
    if (body.previousHash !== previous || hash(body) !== recordHash) fail("run journal integrity mismatch");
    previous = recordHash;
  }
  if (study.seal) {
    const trial = study.trials.find(item => item.trialId === study.seal.trialId);
    if (!trial || study.seal.sealHash !== hash({ definitionHash: study.definitionHash, trialId: trial.trialId, configHash: trial.configHash, sealedAt: study.seal.sealedAt })) fail("holdout seal integrity mismatch");
  }
}
function createStudy(input) {
  if (!input || !input.studyId || !input.hypothesis || !timestamp(input.createdAt)) fail("study requires ID, hypothesis and createdAt timestamp");
  if (!Number.isSafeInteger(input.familySize) || input.familySize < 1) fail("familySize must include all planned comparisons");
  for (let i = 0; i < STAGES.length; i++) {
    const range = input.stages?.[STAGES[i]];
    if (!iso(range?.from) || !iso(range?.to) || range.from > range.to || (i && input.stages[STAGES[i - 1]].to >= range.from)) fail("study stages must be ordered without overlap");
  }
  const study = { schemaVersion: 1, studyId: input.studyId, hypothesis: input.hypothesis, createdAt: input.createdAt,
    stages: structuredClone(input.stages), familySize: input.familySize, trials: [], runs: [], seal: null };
  study.definitionHash = hash(definition(study)); return study;
}
function registerTrial(input, trial) {
  assertStudy(input); if (input.seal) fail("study sealed: new trials require a new study and fresh final holdout");
  if (!trial?.trialId || !trial.rationale || !timestamp(trial.registeredAt)) fail("trial requires trialId, rationale and registeredAt");
  if (input.trials.some(item => item.trialId === trial.trialId)) fail("duplicate trialId");
  const strategy = normalizeTrendStrategy({ strategyId: trial.strategyId || "quality-v2", config: trial.config || {} });
  const execution = require("./trend-strategy-evaluator.cjs").normalizeExecution(trial.execution);
  const account = require("./trend-research-account.cjs").normalizeAccount(trial.account);
  const frozen = { trialId: trial.trialId, rationale: trial.rationale, registeredAt: trial.registeredAt, strategy, execution, account,
    configHash: hash({ strategy, execution, account }) };
  const study = structuredClone(input); study.trials.push(frozen); return study;
}
function sealHoldout(input, { trialId, sealedAt }) {
  assertStudy(input); if (input.seal) fail("holdout already sealed");
  const trial = input.trials.find(item => item.trialId === trialId);
  if (!trial || !timestamp(sealedAt)) fail("seal requires a registered trial and timestamp");
  const study = structuredClone(input);
  study.seal = { trialId, configHash: trial.configHash, sealedAt, sealHash: hash({ definitionHash: study.definitionHash, trialId, configHash: trial.configHash, sealedAt }) };
  return study;
}
function comparisonGuard(study) {
  const familySize = Math.max(study.familySize, study.trials.length);
  return { familySize, method: "Bonferroni family-wise threshold (no p-value inferred)", alpha: .05,
    adjustedAlpha: .05 / familySize, unloggedTrialsInvalidateGuard: true, returnSuperiorityVerified: false };
}
function correlationCoverage(samples) {
  const intervals = samples.map(sample => ({ start: sample.entryDate || sample.signalDate,
    end: sample.exitDate || sample.lastObservedDate || sample.signalDate })).sort((a, b) => a.start.localeCompare(b.start));
  let blocks = 0; let end = "";
  for (const interval of intervals) { if (interval.start > end) blocks++; if (interval.end > end) end = interval.end; }
  const securityClusters = new Set(samples.map(sample => sample.code)).size;
  const signalDates = new Set(samples.map(sample => sample.signalDate)).size;
  return { rawSignals: samples.length, signalDates, securityClusters, nonoverlappingDateBlocks: blocks,
    conservativeEffectiveIndependentUnits: Math.min(signalDates, securityClusters, blocks),
    interpretation: "保守样本相关性诊断代理，非统计自由度；同股、同日及持仓区间重叠不视为独立收益证据。" };
}
function evaluateRange(input, trial, range, stage, dataset, evaluator, extra = {}) {
  const current = normalizeTrendStrategy({ strategyId: trial.strategy.id, config: trial.strategy.config });
  if (current.configHash !== trial.strategy.configHash) fail("registered strategy version integrity mismatch; register a new study");
  let report;
  try {
    report = evaluator({ dataset, from: range.from, to: range.to, splitDate: range.from,
      advancedStrategyId: trial.strategy.id, advancedConfig: trial.strategy.config, execution: trial.execution, account: trial.account });
  } catch (error) {
    report = { error: error.message, provenance: { dataHash: hash(dataset) }, range,
      baseline: { samples: [], metrics: null }, advanced: { samples: [], metrics: null },
      qualification: { status: "EVALUATION_FAILED", returnSuperiorityVerified: false } };
  }
  const study = structuredClone(input);
  const body = { runId: `${study.studyId}:${study.runs.length + 1}`, trialId: trial.trialId, configHash: trial.configHash,
    stage, range, status: report.error ? "failed" : "completed", ...(report.error ? { error: report.error } : {}), ...extra, dataHash: report.provenance.dataHash, resultHash: hash({ baseline: report.baseline, advanced: report.advanced }),
    previousHash: study.runs.at(-1)?.recordHash || study.definitionHash };
  study.runs.push({ ...body, recordHash: hash(body) });
  report.researchProtocol = { studyId: study.studyId, trialId: trial.trialId, stage, definitionHash: study.definitionHash,
    configHash: trial.configHash, seal: study.seal, run: study.runs.at(-1), multipleComparison: comparisonGuard(study),
    correlation: { baseline: correlationCoverage(report.baseline.samples), advanced: correlationCoverage(report.advanced.samples) },
    registrationTiming: Date.parse(study.createdAt) < Date.parse(`${study.stages.finalHoldout.from}T00:00:00+08:00`) ? "declared_before_final_period" : "retrospective_declaration",
    limitations: ["本地哈希与文件锁仅防止本日志内的意外修改和重复使用；删除、复制日志或在外部提前查看无法被本工具证明或阻止。", "预注册时间为调用方提供的元数据，不等同于可信时间戳或独立托管的盲留出证据。"],
    returnSuperiorityVerified: false };
  return { study, report };
}
function evaluateStudyStage(input, { trialId, stage, dataset }, evaluator = require("./trend-strategy-evaluator.cjs").evaluateTrendStrategies) {
  assertStudy(input); if (!STAGES.includes(stage)) fail("unknown study stage");
  const trial = input.trials.find(item => item.trialId === trialId); if (!trial) fail("unknown trialId");
  if (stage === "finalHoldout") {
    if (!input.seal || input.seal.trialId !== trialId) fail("final holdout requires matching seal");
    if (input.runs.some(run => run.stage === "finalHoldout")) fail("final holdout already consumed; reuse is forbidden");
  } else if (input.runs.some(run => run.stage === "finalHoldout")) fail("final holdout consumed: further tuning requires fresh study and holdout");
  return evaluateRange(input, trial, input.stages[stage], stage, dataset, evaluator);
}
function neighboringConfigs(baseConfig) {
  const base = normalizeTrendStrategy({ strategyId: "quality-v2", config: baseConfig }).config;
  const result = [base]; const steps = { maxExtensionAtr: .2, minCloseLocation: .05, maxVolumeRatio: .2 };
  for (const [key, step] of Object.entries(steps)) for (const direction of [-1, 1]) {
    const config = { ...base, [key]: Number((base[key] + direction * step).toFixed(6)) };
    try { normalizeTrendStrategy({ strategyId: "quality-v2", config }); result.push(config); } catch { /* Boundary neighbor is outside the declared strategy domain. */ }
  }
  return result;
}
function runSensitivity(input, { trialPrefix = "sensitivity", baseConfig = {}, stage = "development", dataset, registeredAt = new Date().toISOString() }, evaluator) {
  if (stage === "finalHoldout") fail("sensitivity cannot consume final holdout");
  let study = input; const results = [];
  const configurations = neighboringConfigs(baseConfig);
  for (const [index, config] of configurations.entries()) study = registerTrial(study, { trialId: `${trialPrefix}-${index}`, strategyId: "quality-v2", config, registeredAt, rationale: "One-axis neighboring sensitivity, predeclared step" });
  for (const [index, config] of configurations.entries()) {
    const result = evaluateStudyStage(study, { trialId: `${trialPrefix}-${index}`, stage, dataset }, evaluator); study = result.study;
    results.push({ config, report: result.report });
  }
  return { study, results, multipleComparison: comparisonGuard(study), returnSuperiorityVerified: false };
}
function runWalkForward(input, { trialId, dataset, windows }, evaluator = require("./trend-strategy-evaluator.cjs").evaluateTrendStrategies) {
  assertStudy(input);
  if (input.runs.some(run => run.stage === "finalHoldout")) fail("final holdout consumed; cannot run further research");
  const trial = input.trials.find(item => item.trialId === trialId); if (!trial) fail("unknown trialId");
  if (!Array.isArray(windows) || !windows.length) fail("rolling windows required");
  let previousTestEnd = "";
  for (const window of windows) {
    const dates = [window.trainFrom, window.trainTo, window.testFrom, window.testTo];
    if (dates.some(date => !iso(date)) || window.trainFrom > window.trainTo || window.trainTo >= window.testFrom || window.testFrom > window.testTo ||
      window.testFrom <= previousTestEnd || window.trainFrom < input.stages.development.from || window.testTo > input.stages.validation.to) fail("rolling windows must be ordered, disjoint sample-out tests and exclude final holdout");
    previousTestEnd = window.testTo;
  }
  let study = input; const results = [];
  for (const [index, window] of windows.entries()) {
    const train = evaluateRange(study, trial, { from: window.trainFrom, to: window.trainTo }, "rolling-development", dataset, evaluator, { window: index });
    const test = evaluateRange(train.study, trial, { from: window.testFrom, to: window.testTo }, "rolling-sample-out", dataset, evaluator, { window: index });
    study = test.study; results.push({ window, train: train.report, test: test.report });
  }
  return { study, windows: results, aggregateSampleOutCoverage: {
    baseline: correlationCoverage(results.flatMap(item => item.test.baseline.samples)),
    advanced: correlationCoverage(results.flatMap(item => item.test.advanced.samples)) }, multipleComparison: comparisonGuard(study), returnSuperiorityVerified: false,
    methodology: "冻结配置的滚动区间比较；各窗独立账户，训练与样本外成交均在自身截止日删失，不拼接虚构连续权益。" };
}
function appendForwardRecord(journal, record, now = new Date().toISOString()) {
  if (!Array.isArray(journal) || !timestamp(now) || !record?.id || !timestamp(record.observedAt)) fail("forward journal requires ID and timestamps");
  const current = Date.parse(now); const observed = Date.parse(record.observedAt);
  if (observed > current) fail("future observation forbidden");
  if (journal.some(item => item.id === record.id)) fail("duplicate forward record ID");
  let previousHash = null;
  for (const item of journal) { const { recordHash, ...body } = item; if (body.previousHash !== previousHash || hash(body) !== recordHash) fail("forward journal integrity mismatch"); previousHash = recordHash; }
  const shanghaiDate = value => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  const localDay = shanghaiDate(now);
  let signal;
  if (record.type === "signal") {
    if (!/^\d{6}$/.test(record.code) || !iso(record.signalDate) || record.signalDate > localDay || !record.strategy?.id || !record.strategy.configHash || !record.source || !record.plan) fail("invalid or future signal");
  } else {
    signal = journal.find(item => item.id === record.signalId && item.type === "signal"); if (!signal) fail("forward record requires existing signalId");
    if (record.type === "expected-fill") {
      if (!iso(record.executionDate) || record.executionDate <= signal.signalDate || record.executionDate < localDay || !record.assumptions) fail("expected fill must precede its future execution date");
      if (journal.some(item => item.type === "expected-fill" && item.signalId === record.signalId)) fail("expected fill already frozen");
    } else if (record.type === "actual-fill") {
      if (!timestamp(record.filledAt) || Date.parse(record.filledAt) > current || Date.parse(record.filledAt) > observed) fail("future actual fill forbidden");
      if (!Number.isFinite(record.price) || record.price <= 0 || !Number.isSafeInteger(record.shares) || record.shares <= 0 || !record.evidence || !["paper", "broker"].includes(record.mode)) fail("actual fill requires price/shares, evidence and explicit paper/broker mode");
      if (journal.some(item => item.type === "actual-fill" && item.signalId === record.signalId)) fail("actual fill already recorded");
    } else fail("unknown forward record type");
  }
  const expected = signal && journal.find(item => item.type === "expected-fill" && item.signalId === signal.id);
  const mismatchReasons = [];
  let executionDateMatchesExpectation = null; let executionSessionMatchesExpectation = null;
  if (record.type === "actual-fill") {
    if (!expected) mismatchReasons.push("missing_expected_fill");
    else {
      executionDateMatchesExpectation = shanghaiDate(record.filledAt) === expected.executionDate;
      if (!executionDateMatchesExpectation) mismatchReasons.push("actual_execution_date_differs_from_expected");
      if (Date.parse(record.filledAt) <= Date.parse(expected.recordedAt)) mismatchReasons.push("actual_fill_not_after_expectation_frozen");
      if (expected.assumptions?.session !== undefined) {
        executionSessionMatchesExpectation = record.session === expected.assumptions.session;
        if (!executionSessionMatchesExpectation) mismatchReasons.push("actual_session_differs_from_expected");
      }
    }
    if (Date.parse(record.filledAt) <= Date.parse(signal.recordedAt)) mismatchReasons.push("actual_fill_not_after_signal_frozen");
  }
  const body = { ...structuredClone(record), recordedAt: now, previousHash,
    ...(record.type === "actual-fill" ? { executionDateMatchesExpectation, executionSessionMatchesExpectation, mismatchReasons } : {}),
    prospective: record.type === "signal" ? record.signalDate === localDay : record.type === "expected-fill" ? signal.prospective && record.executionDate > localDay : Boolean(signal.prospective && expected?.prospective && mismatchReasons.length === 0),
    returnSuperiorityVerified: false };
  return [...journal, { ...body, recordHash: hash(body) }];
}
module.exports = { createStudy, registerTrial, sealHoldout, evaluateStudyStage, neighboringConfigs, correlationCoverage, runSensitivity, runWalkForward, appendForwardRecord };
