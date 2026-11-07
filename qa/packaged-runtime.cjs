"use strict";

const path = require("node:path");
const { launchPackaged, appExecutable } = require("./packaged-session.cjs");

async function readRuntime(appPath = process.argv[2]) {
  if (!appPath) throw new Error("Usage: node qa/packaged-runtime.cjs <app-or-executable>");
  const session = await launchPackaged(appExecutable(path.resolve(appPath)));
  try {
    await session.page.locator("[data-professional-review-nav]").waitFor({ timeout: 30_000 });
    const [version, info] = await session.page.evaluate(async () => Promise.all([
      window.stockApi.getVersion(),
      Promise.resolve(window.stockApi.getRuntimeInfo())
    ]));
    return { ...info, version };
  } finally {
    await session.close();
  }
}

if (require.main === module) {
  readRuntime().then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { readRuntime };
