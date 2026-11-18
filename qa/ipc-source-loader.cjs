"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

function loadElectronIpcSources(root = REPO_ROOT) {
  const mainPath = path.join(root, "electron/main.cjs");
  const mainSource = fs.readFileSync(mainPath, "utf8");
  const ipcDir = path.join(root, "electron/ipc");
  const ipcEntries = fs.existsSync(ipcDir)
    ? fs.readdirSync(ipcDir)
      .filter((name) => name.endsWith(".cjs"))
      .sort()
      .map((name) => {
        const filePath = path.join(ipcDir, name);
        return {
          name: `electron/ipc/${name}`,
          path: filePath,
          source: fs.readFileSync(filePath, "utf8")
        };
      })
    : [];
  const files = [{ name: "electron/main.cjs", path: mainPath, source: mainSource }, ...ipcEntries];
  return {
    mainSource,
    ipcEntries,
    ipcSources: ipcEntries.map((entry) => entry.source).join("\n"),
    combinedSource: files.map((entry) => entry.source).join("\n"),
    files
  };
}

module.exports = {
  loadElectronIpcSources
};
