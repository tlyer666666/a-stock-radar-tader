"use strict";
// 身份规矩（2026-11-24）：源码里不出现真实用户主目录路径；作者与 appId 统一为 tlyer666666。
// 本测试刻意不写入任何真实姓名或用户名：只校验「/Users/<名字>/」形式的硬编码路径是否落在允许的示例名单里。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCAN_DIRS = ["src", "electron", "qa", "config", "assets", ".github", "docs"];
const SCAN_FILES = [
  "package.json",
  "vite.config.ts",
  "review.vite.config.ts",
  "index.html",
  "review.html",
  "README.md",
  "README_EN.md",
  "PROFESSIONAL_REVIEW.md",
  "AGENTS.md"
];
const TEXT_EXT = /\.(?:c?js|mjs|ts|tsx|json|ya?ml|html|css|md|sh|command|cmd|ps1|py)$/i;
// 测试与夹具里允许出现的示例主目录名。
const ALLOWED_HOME_NAMES = new Set(["demo", "me", "u", "user", "test", "runner", "example", "shared"]);

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".") && entry.name !== ".github") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (TEXT_EXT.test(entry.name)) yield full;
  }
}

test("源码里没有硬编码的真实用户主目录（/Users/<名字>/ 只允许示例名）", () => {
  const offenders = [];
  const files = [...SCAN_DIRS.flatMap(dir => [...walk(path.join(ROOT, dir))]), ...SCAN_FILES.map(name => path.join(ROOT, name)).filter(fs.existsSync)];
  const patterns = [
    { re: /\/Users\/([A-Za-z0-9._-]+)/g, prefix: "/Users/" },
    { re: /C:\\Users\\([A-Za-z0-9._-]+)/g, prefix: "C:\\Users\\" },
    { re: /\/home\/([A-Za-z0-9._-]+)/g, prefix: "/home/" }
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const { re, prefix } of patterns) {
      for (const match of text.matchAll(re)) {
        if (!ALLOWED_HOME_NAMES.has(match[1].toLowerCase())) {
          offenders.push(`${path.relative(ROOT, file)}: ${prefix}${match[1]}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `发现硬编码的用户主目录，请改用 $HOME / os.homedir() 或示例名：\n${offenders.join("\n")}`);
});

test("作者、appId 与版权方统一为 tlyer666666", () => {
  const pkgRaw = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  const pkg = JSON.parse(pkgRaw);
  assert.equal(pkg.author, "tlyer666666");
  assert.match(pkg.build.appId, /^com\.tlyer666666\./);
  assert.doesNotMatch(pkgRaw, /com\.codex\./);
  const main = fs.readFileSync(path.join(ROOT, "electron/main.cjs"), "utf8");
  assert.match(main, /com\.tlyer666666\.astockmonitor/);
  const deploySingleApp = fs.readFileSync(path.join(ROOT, "electron/deploy-single-app.cjs"), "utf8");
  assert.doesNotMatch(deploySingleApp, /com\.codex\./);
});
