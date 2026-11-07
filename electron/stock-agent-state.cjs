"use strict";

// Persistence owns candidate copies. Failed preference/delete transactions leave
// accepted memory intact; failed answer writes retain the answer for safe retry.
function persistenceFailure(cause) {
  return Object.assign(new Error(`对话或设置保存失败：${String(cause?.message || cause || "写入失败")}。请释放磁盘空间后重试保存。`, { cause }), { code: "AGENT_PERSISTENCE" });
}
function retainState(state, pinned, { maxConversations, maxMessages, maxBytes }) {
  state.conversations.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  for (const thread of state.conversations) thread.messages = thread.messages.slice(-maxMessages);
  const removeOldestInactive = () => {
    for (let index = state.conversations.length - 1; index >= 0; index--) {
      if (!pinned.has(state.conversations[index].id)) { state.conversations.splice(index, 1); return true; }
    }
    return false;
  };
  while (state.conversations.length > maxConversations) {
    if (!removeOldestInactive()) throw new Error("运行中的对话超出数量上限");
  }
  while (Buffer.byteLength(JSON.stringify(state)) > maxBytes) {
    // Never silently drop the only conversation, including a large pinned one.
    if (state.conversations.length <= 1 || !removeOldestInactive()) throw new Error("运行中的对话或单段对话超出保存容量上限");
  }
  return state;
}
function createStockAgentState({ store, normalize, pinned, limits }) {
  let memo = null, error = "";
  function read() {
    if (memo) return memo;
    let value;
    try { value = store?.read?.(); }
    catch (cause) { throw persistenceFailure(cause); }
    memo = normalize(structuredClone(value));
    return memo;
  }
  function save(next, { keepOnFailure = false, pinIds = [] } = {}) {
    // Retention also works on a copy: a rejected disk write cannot evict memory.
    const pending = structuredClone(next);
    const candidate = structuredClone(pending);
    try {
      retainState(candidate, new Set([...pinned(), ...pinIds]), limits);
      store?.write?.(candidate);
      memo = candidate;
      error = "";
      return candidate;
    } catch (cause) {
      const failure = persistenceFailure(cause);
      error = failure.message;
      if (keepOnFailure) memo = pending;
      throw failure;
    }
  }
  return { read, save, get error() { return error; } };
}
module.exports = { createStockAgentState };
