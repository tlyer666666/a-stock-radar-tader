"use strict";

/**
 * AI 助手：兼容 OpenAI Chat Completions 接口的大模型客户端（DeepSeek、通义千问、Kimi、智谱、
 * OpenAI、本机 Ollama 等）。接口地址、模型名、API Key 都在设置页填写；Key 只加密保存在本机。
 *
 * - 只走 https（本机 localhost / 127.0.0.1 允许 http，方便接本地模型）。
 * - 复用 http-client 的超时、并发和响应体字节上限。
 * - 要求模型输出 JSON；先带 response_format，接口不支持（HTTP 400）时去掉再试一次。
 */
const { fetchJsonWithPolicy } = require("./http-client.cjs");

const AI_TIMEOUT_MS = 120_000;
const AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function aiError(message, code) {
  return Object.assign(new Error(message), { code });
}

/** 设置里填的接口地址 → chat/completions 完整地址；不合法返回 null。 */
function chatCompletionsUrl(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null;
  if (url.username || url.password) return null;
  url.search = ""; url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/chat\/completions$/.test(path) ? path : `${path}/chat/completions`;
  return url.href;
}

/** 从模型回复里取出 JSON：容忍 ```json 代码块和前后多余文字。 */
function parseModelJson(text) {
  const source = String(text || "").trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], source];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* 再试截取 */ }
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* 继续 */ }
    }
  }
  throw aiError("AI 返回的内容不是有效的 JSON，请重试或换一个模型", "AI_BAD_JSON");
}

function statusMessage(status) {
  if (status === 401 || status === 403) return "AI 接口拒绝访问：API Key 无效或没有该模型的权限";
  if (status === 404) return "AI 接口地址或模型名不正确（HTTP 404）";
  if (status === 402) return "AI 账户余额不足（HTTP 402）";
  if (status === 429) return "AI 接口限流或额度已用完，请稍后再试（HTTP 429）";
  if (status >= 500) return `AI 服务暂时不可用（HTTP ${status}）`;
  return `AI 接口返回错误（HTTP ${status}）`;
}

/** @param {{ getConfig?: Function, fetchImpl?: Function, getSignal?: Function, track?: Function, timeoutMs?: number }} [options] timeoutMs：单次请求超时（默认 120 秒；AI 问股给推理模型放宽）。 */
function createAiClient({ getConfig, fetchImpl, getSignal = () => undefined, track = factory => factory(), timeoutMs = AI_TIMEOUT_MS } = {}) {
  const requestTimeoutMs = Math.max(10_000, Math.min(600_000, Number(timeoutMs) || AI_TIMEOUT_MS));
  function config() {
    const raw = typeof getConfig === "function" ? getConfig() || {} : {};
    return { baseUrl: String(raw.baseUrl || "").trim(), model: String(raw.model || "").trim(), apiKey: String(raw.apiKey || "").trim() };
  }

  function configured() {
    const { baseUrl, model, apiKey } = config();
    return Boolean(chatCompletionsUrl(baseUrl) && model && apiKey);
  }

  async function post(url, apiKey, body, signal) {
    signal?.throwIfAborted();
    const response = await track(() => (fetchImpl || fetchJsonWithPolicy)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      // 不跟随重定向：带着 API Key 的请求不能被转到别的地址。
      redirect: "error",
      signal
    }, { timeoutMs: requestTimeoutMs, retries: 0, maxResponseBytes: AI_MAX_RESPONSE_BYTES, headers: { Accept: "application/json" } }));
    signal?.throwIfAborted();
    // The default JSON transport owns the source body through cancellation.
    // An injected transport retains the Response contract used by callers.
    return fetchImpl ? track(() => response.json()) : response;
  }

  /**
   * 发一轮对话，返回模型文本（json=true 时返回解析后的对象）。
   * 多轮对话时传 messages（[{ role: "user" | "assistant", content }]），代替 user。
   * @param {{ system: string, user?: string, messages?: Array<{role: string, content: string}>, json?: boolean, temperature?: number, maxTokens?: number, signal?: AbortSignal }} options
   */
  async function chat({ system, user, messages, json = true, temperature = 0.3, maxTokens = 3000, signal } = {}) {
    const signals = [...new Set([getSignal(), signal].filter(Boolean))];
    signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    signal?.throwIfAborted();
    const { baseUrl, model, apiKey } = config();
    const url = chatCompletionsUrl(baseUrl);
    if (!url) throw aiError("请先在「设置 → AI 助手」填写 https 开头的接口地址", "AI_NOT_CONFIGURED");
    if (!model) throw aiError("请先在「设置 → AI 助手」填写模型名称", "AI_NOT_CONFIGURED");
    if (!apiKey) throw aiError("请先在「设置 → AI 助手」填写 API Key", "AI_NOT_CONFIGURED");
    const turns = Array.isArray(messages) && messages.length
      ? messages.filter(item => item && (item.role === "user" || item.role === "assistant")).map(item => ({ role: item.role, content: String(item.content || "") }))
      : [{ role: "user", content: String(user || "") }];
    const base = { model, temperature, max_tokens: maxTokens, stream: false,
      messages: [{ role: "system", content: String(system || "") }, ...turns] };
    // 依次尝试：带 JSON 输出格式 → 去掉输出格式 → 只留模型和消息（部分推理模型不接受 temperature / max_tokens）。
    // 只有 HTTP 400（参数不被接受）才换下一种写法，其他错误直接报出。
    const attempts = [
      ...(json ? [{ ...base, response_format: { type: "json_object" } }] : []),
      base,
      { model, stream: false, messages: base.messages }
    ];
    let payload;
    for (let index = 0; index < attempts.length; index += 1) {
      signal?.throwIfAborted();
      try { payload = await post(url, apiKey, attempts[index], signal); break; }
      catch (error) {
        signal?.throwIfAborted();
        const status = Number(error?.status);
        if (status === 400 && index < attempts.length - 1) continue;
        throw aiError(status ? statusMessage(status) : `AI 接口连接失败：${error?.message || error}`, "AI_HTTP");
      }
    }
    signal?.throwIfAborted();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw aiError("AI 没有返回内容，请重试", "AI_EMPTY");
    return json ? parseModelJson(content) : content.trim();
  }

  return { configured, chat, model: () => config().model };
}

module.exports = { createAiClient, chatCompletionsUrl, parseModelJson, AI_TIMEOUT_MS };
