"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { evaluateTrendStrategies } = require("../electron/trend-strategy-evaluator.cjs");

const HELP = "Usage: node qa/evaluate-trend-strategies.cjs --input dataset.json --from YYYY-MM-DD --to YYYY-MM-DD --split-date YYYY-MM-DD --output report.json [--advanced-strategy strategy-id] [--advanced-config config.json] [--execution-config execution.json]";

function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(`${HELP}\n`); return; }
  const allowed = new Set(["input", "from", "to", "split-date", "output", "advanced-strategy", "advanced-config", "execution-config"]);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !allowed.has(key) || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith("--")) throw new TypeError(`Invalid/duplicate argument ${args[i]}\n${HELP}`);
    options[key] = args[i + 1];
  }
  for (const key of ["input", "from", "to", "split-date", "output"]) if (!options[key]) throw new TypeError(`Missing --${key}\n${HELP}`);
  const input = path.resolve(options.input); const output = path.resolve(options.output);
  if (input === output) throw new TypeError("Input and output must be different files");
  const readJson = file => JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  const report = evaluateTrendStrategies({ dataset: readJson(input), from: options.from, to: options.to, splitDate: options["split-date"],
    ...(options["advanced-strategy"] ? { advancedStrategyId: options["advanced-strategy"] } : {}),
    ...(options["advanced-config"] ? { advancedConfig: readJson(options["advanced-config"]) } : {}),
    ...(options["execution-config"] ? { execution: readJson(options["execution-config"]) } : {}) });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, qualification: report.qualification.status,
    returnSuperiorityVerified: false, baseline: report.baseline.metrics, advanced: report.advanced.metrics }, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { main };
