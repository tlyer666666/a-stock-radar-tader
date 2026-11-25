"use strict";

/**
 * AI 助手：兼容 OpenAI Chat Completions 接口的大模型客户端（DeepSeek、通义千问、Kimi、智谱、
 * OpenAI、本机 Ollama 等）。接口地址、模型名、API Key 都在设置页填写；Key 只加密保存在本机。
 *
 * - 只走 https（本机 localhost / 127.0.0.1 允许 http，方便接本地模型）。
 * - 复用 http-client 的超时、并发和响应体字节上限。
 * - 要求模型输出 JSON；先带 response_format，接口不支持（HTTP 400）时去掉再试一次。
 */
const { fetchWithPolicy, fetchJsonWithPolicy } = require("./http-client.cjs");

const AI_TIMEOUT_MS = 120_000;
const AI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const AI_STREAM_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const AI_MAX_ACCUMULATED_CHARS = 512 * 1024;

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

/** 按字符串状态与引号转义扫描平衡 JSON 片段，避免注释里的散落括号干扰截取。 */
function extractBalancedJsonCandidates(text) {
  const results = [];
  for (let i = 0; i < text.length; i += 1) {
    const startCh = text[i];
    if (startCh !== "{" && startCh !== "[") continue;
    const stack = [startCh === "{" ? "}" : "]"];
    let inString = false;
    let escaped = false;
    for (let j = i + 1; j < text.length; j += 1) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") { inString = true; continue; }
      if (ch === "{") stack.push("}");
      else if (ch === "[") stack.push("]");
      else if (ch === "}" || ch === "]") {
        if (stack[stack.length - 1] !== ch) break;
        stack.pop();
        if (stack.length === 0) {
          results.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return results;
}

/** 从模型回复里取出 JSON：容忍 ```json 代码块和前后多余文字。 */
function parseModelJson(text) {
  const source = String(text || "").trim();
  const fencedMatches = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1]);
  const candidates = [...fencedMatches, source];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch { /* 再试平衡括号提取 */ }
    for (const slice of extractBalancedJsonCandidates(candidate)) {
      try { return JSON.parse(slice); } catch { /* 继续尝试下一个候选 */ }
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

  async function consumeSseResponse(response, signal, onToken) {
    if (response && response.ok === false) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const contentType = String(response?.headers?.get?.("content-type") || "").toLowerCase();
    if (!contentType.includes("text/event-stream") || !response?.body?.getReader) {
      return response.json();
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    const handleLine = line => {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let parsed;
      try { parsed = JSON.parse(data); } catch { return; }
      const delta = parsed?.choices?.[0]?.delta;
      if (!delta || typeof delta !== "object") return;
      const textDelta = typeof delta.content === "string" ? delta.content : "";
      const reasonDelta = typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
      if (!textDelta && !reasonDelta) return;
      content += textDelta;
      reasoning += reasonDelta;
      if (content.length + reasoning.length > AI_MAX_ACCUMULATED_CHARS) {
        throw aiError("AI 流式返回内容过长，已中止读取", "AI_RESPONSE_TOO_LARGE");
      }
      try { onToken(textDelta, content, { reasoningDelta: reasonDelta, reasoning }); } catch { /* ignore UI progress errors */ }
    };
    try {
      while (true) {
        signal?.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          handleLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer) {
        for (const line of buffer.split(/\r?\n/)) handleLine(line);
      }
    } catch (error) {
      try { await reader.cancel(error); } catch { /* preserve stream error */ }
      throw error;
    } finally {
      try { reader.releaseLock(); } catch { /* already released */ }
    }
    return { choices: [{ message: { content, ...(reasoning ? { reasoning_content: reasoning } : {}) } }] };
  }

  async function post(url, apiKey, body, signal, onToken) {
    signal?.throwIfAborted();
    if (body?.stream && typeof onToken === "function") {
      if (fetchImpl) {
        const response = await track(() => fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream, application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal
        }));
        signal?.throwIfAborted();
        return track(() => consumeSseResponse(response, signal, onToken));
      }
      const response = await track(() => fetchWithPolicy(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream, application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        streamResponse: true,
        signal
      }, { timeoutMs: requestTimeoutMs, retries: 0, maxResponseBytes: AI_STREAM_MAX_RESPONSE_BYTES }));
      signal?.throwIfAborted();
      return track(() => consumeSseResponse(response, signal, onToken));
    }
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
   * @param {{ system: string, user?: string, messages?: Array<{role: string, content: string}>, json?: boolean, temperature?: number, maxTokens?: number, signal?: AbortSignal, onToken?: Function }} options
   */
  async function chat({ system, user, messages, json = true, temperature = 0.3, maxTokens = 3000, signal, onToken } = {}) {
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
    const useStream = typeof onToken === "function";
    const base = { model, temperature, max_tokens: maxTokens, stream: useStream,
      messages: [{ role: "system", content: String(system || "") }, ...turns] };
    // 依次尝试：带 JSON 输出格式 → 去掉输出格式 → 降级非流式最小请求（部分模型拒绝 stream / temperature / response_format）。
    // 只有 HTTP 400（参数不被接受）才换下一种写法，其他错误直接报出。
    const attempts = [
      ...(json ? [{ ...base, response_format: { type: "json_object" } }] : []),
      base,
      { model, stream: false, messages: base.messages }
    ];
    let payload;
    for (let index = 0; index < attempts.length; index += 1) {
      signal?.throwIfAborted();
      try { payload = await post(url, apiKey, attempts[index], signal, attempts[index].stream ? onToken : undefined); break; }
      catch (error) {
        signal?.throwIfAborted();
        const status = Number(error?.status);
        if (status === 400 && index < attempts.length - 1) continue;
        throw aiError(status ? statusMessage(status) : `AI 接口连接失败：${error?.message || error}`, "AI_HTTP");
      }
    }
    signal?.throwIfAborted();
    const message = payload?.choices?.[0]?.message;
    const content = message?.content;
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim()
      : typeof message?.reasoning === "string" ? message.reasoning.trim() : "";
    if (typeof content !== "string" || !content.trim()) {
      if (reasoning) throw aiError("AI 思考过程超出输出上限，未生成最终回答，请重试或切换非推理模型", "AI_EMPTY");
      throw aiError("AI 没有返回内容，请重试", "AI_EMPTY");
    }
    return json ? parseModelJson(content) : content.trim();
  }

  return { configured, chat, model: () => config().model };
}

module.exports = { createAiClient, chatCompletionsUrl, parseModelJson, AI_TIMEOUT_MS };
