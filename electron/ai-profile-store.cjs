"use strict";

/**
 * AI 模型配置（可存多套，随时切换）：每套 {名称, 接口地址, 模型名, API Key}。
 * - 单独存在 userData/ai-profiles.json；API Key 用本机密钥加密后保存，对外只返回“已填写”标记。
 * - 首次使用时把 1.6.33 设置页里的单套配置迁移成「默认」。
 */
const { randomUUID } = require("node:crypto");
const { chatCompletionsUrl } = require("./ai-client.cjs");

const MAX_PROFILES = 8;
const MASK = /^•+$/;

/** 两个接口地址是否同一来源（协议 + 主机 + 端口）。 */
function sameOrigin(a, b) {
  try { return new URL(String(a)).origin === new URL(String(b)).origin; } catch { return false; }
}

function isAiProfileStore(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.profiles);
}

function profileError(message, field = "") {
  return Object.assign(new TypeError(message), { code: "INVALID_AI_PROFILE", field });
}

function createAiProfileStore({ read, write, encrypt, decrypt, legacy = () => null }) {
  let migrated = false;

  function load() {
    const value = read();
    const store = isAiProfileStore(value) ? {
      activeId: typeof value.activeId === "string" ? value.activeId : "",
      rankIds: Array.isArray(value.rankIds) ? value.rankIds.filter(id => typeof id === "string") : [],
      profiles: value.profiles.filter(item => item && typeof item.id === "string" && typeof item.name === "string").slice(0, MAX_PROFILES)
    } : { activeId: "", rankIds: [], profiles: [] };
    // 只在还没有配置文件时迁移一次；用户删光配置后不会把旧设置里的 Key 又“复活”出来。
    if (!isAiProfileStore(value) && !migrated) {
      const old = legacy?.() || null;
      if (old && (old.baseUrl || old.model || old.apiKey)) {
        const profile = { id: randomUUID(), name: "默认", baseUrl: String(old.baseUrl || ""), model: String(old.model || ""), apiKey: old.apiKey ? encrypt(String(old.apiKey)) : "" };
        const next = { activeId: profile.id, rankIds: [profile.id], profiles: [profile] };
        write(next);
        migrated = true;
        return next;
      }
      migrated = true;
    }
    if (!store.profiles.some(item => item.id === store.activeId)) store.activeId = store.profiles[0]?.id || "";
    // 参与打分的模型：只保留仍存在的配置；一个都没有时用当前使用的那套。
    store.rankIds = [...new Set(store.rankIds)].filter(id => store.profiles.some(item => item.id === id));
    if (!store.rankIds.length && store.activeId) store.rankIds = [store.activeId];
    return store;
  }

  const publicProfile = item => ({ id: item.id, name: item.name, baseUrl: item.baseUrl, model: item.model, hasKey: Boolean(item.apiKey && decrypt(item.apiKey)) });

  function list() {
    const store = load();
    return { activeId: store.activeId, rankIds: store.rankIds, profiles: store.profiles.map(publicProfile), max: MAX_PROFILES };
  }

  function save(input = {}) {
    const store = load();
    const name = String(input.name || "").trim();
    const baseUrl = String(input.baseUrl || "").trim();
    const model = String(input.model || "").trim();
    if (!name || [...name].length > 20) throw profileError("配置名称须为 1–20 个字", "name");
    if (!chatCompletionsUrl(baseUrl)) throw profileError("接口地址须为 https 开头的有效网址（本机 localhost 可用 http）", "baseUrl");
    if (!model || model.length > 100) throw profileError("请填写模型名称（不超过 100 个字符）", "model");
    const existing = typeof input.id === "string" ? store.profiles.find(item => item.id === input.id) : null;
    if (!existing && store.profiles.length >= MAX_PROFILES) throw profileError(`最多保存 ${MAX_PROFILES} 套模型配置`);
    if (store.profiles.some(item => item.name === name && item.id !== existing?.id)) throw profileError("已有同名配置", "name");
    const rawKey = typeof input.apiKey === "string" ? input.apiKey.trim() : undefined;
    // 未修改（掩码或未传）保留原 Key；空字符串表示清除。
    const keepSavedKey = rawKey === undefined || MASK.test(rawKey);
    // 换了接口地址的域名却沿用旧 Key，会把旧平台的 Key 发给新地址：此时必须重新填写。
    if (keepSavedKey && existing?.apiKey && !sameOrigin(existing.baseUrl, baseUrl)) throw profileError("更换了接口地址的域名，请重新填写这个平台的 API Key", "apiKey");
    const apiKey = keepSavedKey ? existing?.apiKey || "" : rawKey ? encrypt(rawKey) : "";
    const profile = { id: existing?.id || randomUUID(), name, baseUrl, model, apiKey };
    const profiles = existing ? store.profiles.map(item => item.id === existing.id ? profile : item) : [...store.profiles, profile];
    const activeId = input.activate === true || !store.activeId ? profile.id : store.activeId;
    write({ activeId, rankIds: store.rankIds.length ? store.rankIds : [activeId], profiles });
    return { ...list(), saved: publicProfile(profile) };
  }

  function remove(id) {
    const store = load();
    if (!store.profiles.some(item => item.id === id)) throw profileError("配置不存在");
    const profiles = store.profiles.filter(item => item.id !== id);
    write({ activeId: store.activeId === id ? profiles[0]?.id || "" : store.activeId, rankIds: store.rankIds.filter(item => item !== id), profiles });
    return list();
  }

  function activate(id) {
    const store = load();
    if (!store.profiles.some(item => item.id === id)) throw profileError("配置不存在");
    write({ activeId: id, rankIds: store.rankIds, profiles: store.profiles });
    return list();
  }

  /** 选择一起打分的模型（至少一套，最多 4 套）。 */
  function setRankIds(ids) {
    const store = load();
    const chosen = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(id => store.profiles.some(item => item.id === id));
    if (!chosen.length) throw profileError("至少选择一套模型参与打分");
    if (chosen.length > 4) throw profileError("最多同时用 4 套模型打分");
    write({ activeId: store.activeId, rankIds: chosen, profiles: store.profiles });
    return list();
  }

  /** 解密后的配置：默认取当前使用的一套。 */
  function resolve(id) {
    const store = load();
    const profile = store.profiles.find(item => item.id === (id || store.activeId));
    return profile ? { id: profile.id, name: profile.name, baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey ? decrypt(profile.apiKey) : "" } : null;
  }

  return { list, save, remove, activate, setRankIds, resolve, active: () => resolve(""), rankProfiles: () => load().rankIds.map(id => resolve(id)).filter(Boolean) };
}

module.exports = { sameOrigin, createAiProfileStore, isAiProfileStore, MAX_PROFILES };
