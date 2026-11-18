"use strict";
// 共享 services.cjs 测试夹具（2026-11-15 审核 P0-2b 拆分配套）。
// services.cjs 拆分后，原先一个文件里的内部函数迁到了 electron/services/*.cjs。
// 旧夹具用 vm 重新执行 services.cjs 并用 require 拦截替换 http-client/fuyao-client
// 等边界；拆出的子模块走自己的 require，拦截会失效。本夹具把 './services/*.cjs'
// 递归地用同一套覆盖表加载，让拦截对拆出去的代码同样生效，并保持每个被加载
// 文件只实例化一次（与 Node 模块缓存语义一致）。
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const ELECTRON_DIR = path.join(__dirname, "..", "electron");
const SERVICES_DIR = path.join(ELECTRON_DIR, "services");

function loadServiceModule(filename, requires = {}, globals = {}, append = "", cache = new Map(), nestedAppends = new Map()) {
  if (cache.has(filename)) return cache.get(filename);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  cache.set(filename, module.exports); // 先占位防循环，再回填
  const customRequire = id => {
    const normalized = id.replace(/^\.\.\//, "./");
    if (Object.prototype.hasOwnProperty.call(requires, id)) return requires[id];
    if (Object.prototype.hasOwnProperty.call(requires, normalized)) return requires[normalized];
    if (id.startsWith("./") || id.startsWith("../")) {
      const resolved = path.resolve(path.dirname(filename), id);
      if (resolved.startsWith(SERVICES_DIR + path.sep)) {
        return loadServiceModule(resolved, requires, globals, "", cache, nestedAppends);
      }
    }
    return realRequire(id);
  };
  const sandbox = {
    module, exports: module.exports, require: customRequire,
    __dirname: path.dirname(filename), __filename: filename,
    process, console, URL, URLSearchParams, DOMException, AbortController, AbortSignal, TextDecoder,
    Headers, setTimeout, clearTimeout, setImmediate, queueMicrotask, Buffer,
    fetch: async () => { throw new Error("Unexpected network"); },
    ...(typeof Response !== "undefined" ? { Response } : {}),
    ...(typeof ReadableStream !== "undefined" ? { ReadableStream } : {}),
    ...globals
  };
  // 拆出去的子模块内部函数（如 runtime.cjs 的 fetchJson）与顶层不再是同一作用域；
  // 旧单体夹具靠同名重绑定打桩。这里给每个被加载模块统一注入 __rebind 测试缝：
  // 对函数声明/可变绑定重赋值并同步刷新该模块 exports，配合各模块间的转发函数
  // 声明，重绑定会沿「声明处 -> exports -> 转发调用」传播到所有消费方。
  const REBIND_SEAM = `\n;module.exports.__rebind = (name, fn) => { try { eval(name + " = fn"); module.exports[name] = fn; return true; } catch (e) { return false; } };`;
  const nestedAppend = nestedAppends.get(filename) || "";
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + "\n" + append + nestedAppend + REBIND_SEAM, sandbox, { filename });
  cache.set(filename, module.exports);
  Object.defineProperty(module.exports, "__modules", { value: cache, enumerable: false, configurable: true });
  return module.exports;
}

/** 在声明所在模块重绑定一个内部名字（对夹具隐藏拆分后的模块边界） */
function rebindAll(rootExports, name, fn) {
  let rebound = false;
  for (const m of rootExports.__modules.values()) {
    if (typeof m.__rebind === "function" && m.__rebind(name, fn)) rebound = true;
  }
  return rebound;
}

/** 在隔离 vm 中加载 services.cjs（含其拆出的 services/*.cjs 子模块） */
function loadServices(append = "", globals = {}, requires = {}, { nestedAppends = new Map() } = {}) {
  const cache = new Map();
  return loadServiceModule(path.join(ELECTRON_DIR, "services.cjs"), requires, globals, append, cache, nestedAppends);
}

module.exports = { loadServices, loadServiceModule, rebindAll, ELECTRON_DIR };
