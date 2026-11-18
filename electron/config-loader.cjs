"use strict";
// config/*.json 统一加载器（2026-11-15 审核 P1-4）。
// 此前 7 份策略/行情配置由各消费模块直接 require JSON：没有任何校验，手工改错
// 字段名/类型时有的静默兜底、有的运行期才炸，问题延迟到扫描结果异常才暴露。
// 现在统一经此模块加载：解析失败/形状不符都在启动期报出「哪份配置、哪个字段、
// 期望什么」，加载结果冻结防运行期篡改，并按文件名缓存。
const fs = require("node:fs");
const path = require("node:path");

const CONFIG_DIR = path.join(__dirname, "..", "config");
const cache = new Map();

function fail(file, message) {
  throw new Error(`配置 ${file} 无效：${message}`);
}

function validate(value, schema, file, at = "$") {
  if (schema.type === "array") {
    if (!Array.isArray(value)) fail(file, `${at} 期望数组，实际 ${typeof value}`);
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(file, `${at} 至少需要 ${schema.minItems} 项`);
    if (schema.items) value.forEach((item, i) => validate(item, schema.items, file, `${at}[${i}]`));
    return;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(file, `${at} 期望对象，实际 ${Array.isArray(value) ? "array" : typeof value}`);
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] === undefined) {
        if (sub.required) fail(file, `${at}.${key} 缺失（期望 ${sub.type}）`);
        continue;
      }
      validate(value[key], sub, file, `${at}.${key}`);
    }
    return;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(file, `${at} 期望有限数字，实际 ${JSON.stringify(value)}`);
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string" || (schema.nonEmpty && !value.trim())) fail(file, `${at} 期望${schema.nonEmpty ? "非空" : ""}字符串`);
    return;
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail(file, `${at} 期望布尔值`);
    return;
  }
  if (schema.type === "any") return;
  fail(file, `${at} 未知 schema 类型 ${schema.type}`);
}

function readAndValidateFile(file, schema, label = path.basename(file)) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`配置 ${label} 读取/解析失败：${error.message}`, { cause: error });
  }
  if (schema) validate(parsed, schema, label);
  return deepFreeze(parsed);
}

/**
 * 加载并校验 config/<name>.json。
 * @param {string} name 文件名（不含扩展名）
 * @param {object} schema 轻量形状声明（type/properties/items/required/minItems/nonEmpty）
 * @returns {object|Array} 冻结后的配置
 */
function loadConfig(name, schema) {
  if (cache.has(name)) return cache.get(name);
  const frozen = readAndValidateFile(path.join(CONFIG_DIR, `${name}.json`), schema, `${name}.json`);
  cache.set(name, frozen);
  return frozen;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

// ── 各配置的形状声明：只约束消费方依赖的关键字段，不追求穷举 ─────────────
const requiredText = { type: "string", required: true, nonEmpty: true };
const anyObject = { type: "object", properties: {} };
const catalogEntry = {
  type: "object",
  properties: {
    id: requiredText,
    name: requiredText
  }
};

const SCHEMAS = {
  "a-share-market-calendar": {
    type: "object",
    properties: {
      version: { type: "any", required: true },
      coveredFrom: requiredText,
      coveredTo: requiredText,
      timezone: requiredText,
      closedRanges: {
        type: "array",
        required: true,
        minItems: 1,
        items: { type: "array", minItems: 2, items: { type: "string", nonEmpty: true } }
      }
    }
  },
  "strategy-custom-conditions": {
    type: "object",
    properties: {
      schemaVersion: { type: "number", required: true },
      groups: { type: "array", required: true, minItems: 1 },
      factors: { type: "array", required: true, minItems: 1, items: { type: "object", properties: { id: requiredText } } },
      filters: { type: "array", required: true, minItems: 1, items: { type: "object", properties: { key: requiredText } } },
      boards: { type: "array", required: true, minItems: 1 },
      universes: { type: "array", required: true, minItems: 1 },
      limits: { ...anyObject, required: true },
      defaults: { ...anyObject, required: true }
    }
  },
  "strategy-signal-catalog": { type: "array", required: true, minItems: 1, items: catalogEntry },
  "strategy-signal-combinations": {
    type: "array",
    required: true,
    minItems: 1,
    items: {
      type: "object",
      properties: {
        id: requiredText,
        name: requiredText,
        parameters: { type: "object", required: true, properties: { marketCalendarLookback: { type: "number" } } }
      }
    }
  },
  "trend-strategy-library": { type: "array", required: true, minItems: 1, items: catalogEntry },
  "trend-quality-balanced": qualitySchema(),
  "trend-quality-robust": qualitySchema()
};

function qualitySchema() {
  return {
    type: "object",
    properties: {
      maxExtensionAtr: { type: "number", required: true },
      minCloseLocation: { type: "number", required: true },
      maxVolumeRatio: { type: "number", required: true }
    }
  };
}

/** 按登记形状加载命名配置（唯一推荐入口） */
function loadNamedConfig(name, options = {}) {
  const schema = SCHEMAS[name];
  if (!schema) throw new Error(`未登记的配置：${name}（config-loader 只加载有形状声明的配置）`);
  if (options.dir) return readAndValidateFile(path.join(options.dir, `${name}.json`), schema, `${name}.json`);
  return loadConfig(name, schema);
}

/** 测试用：清空缓存并重新从磁盘校验全部已登记配置 */
function validateAllConfigs(dir) {
  if (!dir) cache.clear();
  for (const name of Object.keys(SCHEMAS)) loadNamedConfig(name, dir ? { dir } : undefined);
}

module.exports = { loadConfig, loadNamedConfig, validateAllConfigs, SCHEMAS };
