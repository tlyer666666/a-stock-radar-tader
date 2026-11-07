"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createStudy, registerTrial, sealHoldout } = require("../electron/trend-research-protocol.cjs");

test("research CLI persists consumed holdout and rejects reuse without replacing report", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "trend-research-cli-"));
  const launch = args => spawnSync(process.execPath, ["qa/trend-research.cjs", ...args], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  try {
    const input = path.join(directory, "request.json"); const studyFile = path.join(directory, "study.json"); const output = path.join(directory, "report.json"); const datasetFile = path.join(directory, "dataset.json");
    const generated = spawnSync(process.execPath, ["qa/create-trend-evaluation-fixture.cjs", "--output", datasetFile], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const dataset = JSON.parse(fs.readFileSync(datasetFile)); const dates = dataset.calendar;
    let study = createStudy({ studyId: "cli", hypothesis: "mechanics", createdAt: "2026-01-01T00:00:00Z", familySize: 1,
      stages: { development: { from: dates[250], to: dates[254] }, validation: { from: dates[255], to: dates[268] }, finalHoldout: { from: dates[269], to: dates.at(-1) } } });
    study = registerTrial(study, { trialId: "q", rationale: "frozen", strategyId: "quality-v2", registeredAt: "2026-01-01T00:00:00Z" });
    study = sealHoldout(study, { trialId: "q", sealedAt: "2026-01-01T00:01:00Z" });
    fs.writeFileSync(studyFile, JSON.stringify(study));
    fs.writeFileSync(input, JSON.stringify({ trialId: "q", stage: "finalHoldout", datasetFile }));
    const args = ["evaluate", "--input", input, "--study", studyFile, "--output", output];
    const first = launch(args); assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(fs.readFileSync(output));
    assert.ok(report.baseline.sharedAccount);
    assert.equal(JSON.parse(fs.readFileSync(studyFile)).runs.length, 1);
    assert.equal(report.researchProtocol.returnSuperiorityVerified, false);
    const bytes = fs.readFileSync(output, "utf8");
    const second = launch(args); assert.equal(second.status, 1); assert.match(second.stderr, /reuse|already/);
    assert.equal(fs.readFileSync(output, "utf8"), bytes);
    fs.writeFileSync(`${studyFile}.lock`, "other process");
    assert.equal(launch(args).status, 1);
    assert.equal(fs.readFileSync(`${studyFile}.lock`, "utf8"), "other process");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("research CLI initializes a study, registers a trial and appends forward journal without future actual fills", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "trend-research-init-"));
  try {
    const input = path.join(directory, "request.json"); const study = path.join(directory, "study.json"); const output = path.join(directory, "result.json"); const journal = path.join(directory, "forward.json");
    const launch = command => spawnSync(process.execPath, ["qa/trend-research.cjs", command, "--input", input, "--study", study, "--output", output, "--journal", journal], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
    fs.writeFileSync(input, JSON.stringify({ studyId: "init", hypothesis: "mechanics", createdAt: "2026-01-01T00:00:00Z", familySize: 1, stages: { development: { from: "2025-01-01", to: "2025-03-31" }, validation: { from: "2025-04-01", to: "2025-06-30" }, finalHoldout: { from: "2025-07-01", to: "2025-09-30" } } }));
    assert.equal(launch("init").status, 0);
    assert.equal(launch("init").status, 1);
    fs.writeFileSync(input, JSON.stringify({ trialId: "q", rationale: "predeclared", registeredAt: "2026-01-01T00:00:00Z" }));
    assert.equal(launch("register").status, 0);
    fs.writeFileSync(input, JSON.stringify({ type: "signal", id: "s", code: "600001", signalDate: "2025-01-01", observedAt: "2025-01-01T07:00:00Z", strategy: { id: "quality-v2", configHash: "h" }, source: "test fictional retrospective", plan: { stop: 9 } }));
    const forward = launch("forward"); assert.equal(forward.status, 0, forward.stderr);
    assert.equal(JSON.parse(fs.readFileSync(journal))[0].prospective, false);
    fs.writeFileSync(input, JSON.stringify({ type: "actual-fill", id: "a", signalId: "s", observedAt: "2025-01-01T07:00:00Z", filledAt: "2099-01-01T01:30:00Z", price: 10, shares: 100, evidence: "fabricated", mode: "paper" }));
    assert.equal(launch("forward").status, 1);
    assert.equal(JSON.parse(fs.readFileSync(journal)).length, 1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
