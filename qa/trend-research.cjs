"use strict";

const fs = require("node:fs");
const path = require("node:path");
const protocol = require("../electron/trend-research-protocol.cjs");
const HELP = `Usage: node qa/trend-research.cjs <init|register|seal|evaluate|sensitivity|walk-forward|forward> --input request.json --output result.json [--study study.json] [--journal forward.json]
init: input is {studyId,hypothesis,createdAt,familySize,stages:{development,validation,finalHoldout}}, each range {from,to}.
register: input is {trialId,strategyId,config,execution,account,rationale,registeredAt}.
seal: input is {trialId,sealedAt}; configuration and study ranges freeze before finalHoldout.
evaluate: input is {datasetFile,trialId,stage}; stage is development|validation|finalHoldout.
sensitivity: input is {datasetFile,trialPrefix,baseConfig,stage,registeredAt}; neighboring quality parameters, no final holdout.
walk-forward: input is {datasetFile,trialId,windows:[{trainFrom,trainTo,testFrom,testTo}]}; tests disjoint, before final holdout.
forward: input is one signal|expected-fill|actual-fill record; actual requires evidence and mode paper|broker.
State files are locked during updates. Preserve and back up the complete study and journal; copying/deleting a ledger can defeat reuse detection. All results remain diagnostic.`;
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(`${HELP}\n`); return; }
  const [command, ...pairs] = args; const options = {};
  if (!["init", "register", "seal", "evaluate", "sensitivity", "walk-forward", "forward"].includes(command)) throw new TypeError(HELP);
  for (let i = 0; i < pairs.length; i += 2) {
    const key = pairs[i].replace(/^--/, "");
    if (!pairs[i].startsWith("--") || !["input", "output", "study", "journal"].includes(key) || options[key] || !pairs[i + 1] || pairs[i + 1].startsWith("--")) throw new TypeError(`Invalid argument ${pairs[i]}\n${HELP}`);
    options[key] = path.resolve(pairs[i + 1]);
  }
  if (!options.input || !options.output || !(command === "forward" ? options.journal : options.study)) throw new TypeError(HELP);
  const stateFile = command === "forward" ? options.journal : options.study;
  if (new Set([options.input, options.output, stateFile]).size !== 3) throw new TypeError("Input, state and output must be different files");
  const request = readJson(options.input);
  if (request.datasetFile && [options.output, stateFile].includes(path.resolve(request.datasetFile))) throw new TypeError("Dataset cannot be overwritten by research state/output");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const lock = `${stateFile}.lock`;
  // A failed exclusive open never removes somebody else's lock.
  const handle = fs.openSync(lock, "wx");
  try {
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let result; let state;
    if (command === "init") {
      if (fs.existsSync(stateFile)) throw new TypeError("Study already exists; refusing to overwrite its history");
      state = protocol.createStudy(request); result = { study: state, returnSuperiorityVerified: false };
    } else if (command === "forward") {
      state = protocol.appendForwardRecord(fs.existsSync(stateFile) ? readJson(stateFile) : [], request);
      result = { records: state.length, last: state.at(-1), returnSuperiorityVerified: false };
    } else {
      const study = readJson(stateFile);
      if (command === "register") { state = protocol.registerTrial(study, request); result = { study: state, returnSuperiorityVerified: false }; }
      else if (command === "seal") { state = protocol.sealHoldout(study, request); result = { study: state, returnSuperiorityVerified: false }; }
      else {
        if (!request.datasetFile) throw new TypeError("datasetFile required");
        const evaluation = { ...request, dataset: readJson(path.resolve(request.datasetFile)) };
        const evaluated = command === "evaluate" ? protocol.evaluateStudyStage(study, evaluation) : command === "sensitivity" ? protocol.runSensitivity(study, evaluation) : protocol.runWalkForward(study, evaluation);
        state = evaluated.study;
        result = command === "evaluate" ? evaluated.report : evaluated;
      }
    }
    // Commit consumption first: failed report writes must not make a viewed holdout reusable.
    atomicJson(stateFile, state); atomicJson(options.output, result);
    if (result.error || result.results?.some(item => item.report.error) || result.windows?.some(item => item.train.error || item.test.error)) process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({ command, state: stateFile, output: options.output, returnSuperiorityVerified: false })}\n`);
  } finally { fs.closeSync(handle); fs.unlinkSync(lock); }
}
if (require.main === module) { try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; } }
module.exports = { main };
