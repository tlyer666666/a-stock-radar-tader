"use strict";

// A user-requested copy-preservation contract, independent of component layout.
// Collect conservatively: runtime strings include labels, errors and aria copy.
// This is not proof of visibility or behaviour; browser QA remains necessary.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ts = require("typescript");

const repository = path.resolve(__dirname, "..");
const hasChinese = /\p{Script=Han}/u;
const visibleAttributes = new Set(["title", "alt", "placeholder", "aria-label", "aria-description",
  "aria-valuetext", "aria-roledescription", "label", "value"]);

function visibleJsxLiteral(node) {
  if (ts.isJsxText(node)) return true;
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) return visibleAttributes.has(parent.name.getText());
    if (ts.isJsxExpression(parent)) {
      return !ts.isJsxAttribute(parent.parent) || visibleAttributes.has(parent.parent.name.getText());
    }
    if (ts.isStatement(parent) || ts.isSourceFile(parent)) return false;
  }
  return false;
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filename);
    return /\.tsx?$/.test(entry.name) && !/\.(?:d|test|spec)\.tsx?$/.test(entry.name) ? [filename] : [];
  }).sort();
}

function jsxText(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function collect(sourceRoot) {
  const entries = [];
  const files = [];
  for (const filename of sourceFiles(sourceRoot)) {
    const content = fs.readFileSync(filename, "utf8");
    const file = path.relative(sourceRoot, filename).split(path.sep).join("/");
    const ast = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true,
      filename.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    if (ast.parseDiagnostics.length) throw new Error(`Cannot collect invalid TypeScript: ${file}`);
    files.push({ file, sha256: crypto.createHash("sha256").update(content).digest("hex") });
    function visit(node) {
      // Type declarations cannot render. Comments are not AST child nodes.
      if (ts.isTypeNode(node)) return;
      let text;
      if (ts.isJsxText(node)) text = jsxText(node.text);
      else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ||
        node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle ||
        node.kind === ts.SyntaxKind.TemplateTail) text = node.text;
      if (text && (hasChinese.test(text) || visibleJsxLiteral(node))) {
        const location = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        entries.push({ text, file, line: location.line + 1, kind: ts.SyntaxKind[node.kind] });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return { files, entries };
}

function compare(baselineEntries, currentEntries) {
  function group(entries) {
    const result = new Map();
    for (const entry of entries) {
      const values = result.get(entry.text) || [];
      values.push(entry);
      result.set(entry.text, values);
    }
    return result;
  }
  const before = group(baselineEntries), after = group(currentEntries);
  const missing = [], added = [];
  for (const text of new Set([...before.keys(), ...after.keys()])) {
    const expected = before.get(text) || [], actual = after.get(text) || [];
    const difference = actual.length - expected.length;
    if (!difference) continue;
    const record = { text, expectedCount: expected.length, actualCount: actual.length,
      difference: Math.abs(difference), baselineLocations: expected, currentLocations: actual };
    (difference < 0 ? missing : added).push(record);
  }
  return { passed: missing.length === 0 && added.length === 0, missing, added };
}

function run(args = process.argv.slice(2)) {
  const allowed = new Set(["--record", "--source-root", "--baseline", "--report"]);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!allowed.has(key)) throw new Error(`Unknown option: ${key}`);
    if (key === "--record") options.record = true;
    else {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value: ${key}`);
      options[key.slice(2)] = args[++index];
    }
  }
  const sourceRoot = path.resolve(options["source-root"] || path.join(repository, "src"));
  const baselinePath = path.resolve(options.baseline || path.join(__dirname, "terminal-ui-baseline.json"));
  const current = collect(sourceRoot);
  if (options.record) {
    const baseline = { schemaVersion: 2, createdAt: new Date().toISOString(),
      sourceRoot: path.relative(repository, sourceRoot),
      scope: "Runtime Chinese strings/template fragments plus all-language JSXText, JSX expression literals and visible JSX attributes (title, alt, placeholder, aria-label/description/valuetext/roledescription, label, value) in src/**/*.tsx and src/**/*.ts. Excludes type-only nodes, declarations, tests and comments. Duplicates retained; JSX whitespace normalized; dynamic expressions and runtime visibility require separate QA.",
      totalOccurrences: current.entries.length, uniqueTexts: new Set(current.entries.map(entry => entry.text)).size,
      ...current };
    fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n", { flag: "wx" });
    console.log(`Recorded ${baseline.totalOccurrences} occurrences (${baseline.uniqueTexts} unique) in ${current.files.length} files: ${baselinePath}`);
    return 0;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  if (baseline.schemaVersion !== 2 || !Array.isArray(baseline.entries)) throw new Error("Invalid copy baseline");
  const result = compare(baseline.entries, current.entries);
  const report = { checkedAt: new Date().toISOString(), sourceRoot, baselinePath,
    baselineOccurrences: baseline.entries.length, currentOccurrences: current.entries.length, ...result };
  const reportPath = path.resolve(options.report || path.join(__dirname, "terminal-ui-copy-report.json"));
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`${result.passed ? "PASS" : "FAIL"}: ${baseline.entries.length} baseline / ${current.entries.length} current occurrences; ${result.missing.length} missing or reduced, ${result.added.length} new or increased texts. Report: ${reportPath}`);
  for (const item of [...result.missing, ...result.added].slice(0, 20)) {
    console.log(`${item.expectedCount} → ${item.actualCount}: ${JSON.stringify(item.text)}`);
  }
  return result.passed ? 0 : 1;
}

if (require.main === module) {
  try { process.exitCode = run(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
module.exports = { collect, compare, run };
