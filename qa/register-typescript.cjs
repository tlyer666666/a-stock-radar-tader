"use strict";

const fs = require("node:fs");
const typescript = require("typescript");

function registerTypeScript() {
  const previousTs = require.extensions[".ts"];
  const previousTsx = require.extensions[".tsx"];
  const compile = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = typescript.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        esModuleInterop: true,
        jsx: typescript.JsxEmit.ReactJSX,
        module: typescript.ModuleKind.CommonJS,
        target: typescript.ScriptTarget.ES2022
      }
    }).outputText;
    module._compile(output, filename);
  };
  require.extensions[".ts"] = compile;
  require.extensions[".tsx"] = compile;
  return () => {
    if (previousTs) require.extensions[".ts"] = previousTs;
    else delete require.extensions[".ts"];
    if (previousTsx) require.extensions[".tsx"] = previousTsx;
    else delete require.extensions[".tsx"];
  };
}

module.exports = { registerTypeScript };
