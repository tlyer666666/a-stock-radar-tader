"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { redactRuntimeText } = require("./security-policy.cjs");

const RUNTIME_LOG_MAX_BYTES = 512 * 1024;

function safeText(value) {
  try {
    return redactRuntimeText(value);
  } catch {
    return "[unprintable diagnostic]";
  }
}

function errorString(error, key, fallback) {
  try {
    // Read once: user-defined accessors can throw or change on the next read.
    const value = error[key];
    return typeof value === "string" ? value : fallback;
  } catch {
    return fallback;
  }
}

function describeRuntimeError(error) {
  if (!error || typeof error !== "object") return `non-error ${typeof error}`;
  const stack = errorString(error, "stack", "");
  if (stack) return safeText(stack);
  const name = errorString(error, "name", "Error");
  const message = errorString(error, "message", "no message");
  return safeText(`${name}: ${message}`);
}

function rotateIfNeeded(logPath, nextBytes) {
  try {
    if (nextBytes > RUNTIME_LOG_MAX_BYTES) return false;
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size + nextBytes <= RUNTIME_LOG_MAX_BYTES) return true;
    const rotatedPath = `${logPath}.1`;
    if (fs.existsSync(rotatedPath)) fs.unlinkSync(rotatedPath);
    fs.renameSync(logPath, rotatedPath);
    return true;
  } catch {
    // Keep the budget even when disk permissions or an unknown obstacle prevent rotation.
    return false;
  }
}

function createRuntimeLogger({ isEnabled, getDirectory, debugLog = () => {} }) {
  return function runtimeErrorLog(eventName, error, metadata = "") {
    // This boundary includes serialization and environment access, not only I/O:
    // error reporting must never create a second uncaught failure.
    try {
      const event = safeText(eventName).replace(/[\r\n]+/g, " ").slice(0, 80);
      const detailMetadata = safeText(metadata).replace(/[\r\n]+/g, " ").slice(0, 320);
      try { debugLog(`runtime-error ${event} ${detailMetadata}`); } catch { /* independent sink */ }
      if (!isEnabled()) return;
      const detail = describeRuntimeError(error);
      const entry = `${new Date().toISOString()} ${event}${detailMetadata ? ` ${detailMetadata}` : ""}\n${detail}\n`;
      const logPath = path.join(getDirectory(), "runtime-errors.log");
      if (!rotateIfNeeded(logPath, Buffer.byteLength(entry, "utf8"))) return;
      fs.appendFileSync(logPath, entry, "utf8");
    } catch {
      // Diagnostics cannot depend on a readable profile or writable disk.
    }
  };
}

module.exports = { createRuntimeLogger, RUNTIME_LOG_MAX_BYTES };
