"use strict";

// 自定义选股策略的本地存储（userData/custom-strategies.json，带 last-good 备份）。
// 首次读取时把「数据源设置 → 自主策略组合」迁移为一套自定义策略，原设置保持不变。

const crypto = require("node:crypto");
const custom = require("./custom-strategy.cjs");

function createCustomStrategyStore({ read, write, loadLegacySelection = () => [], patternIds = () => new Set(), now = () => new Date(),
  newId = () => `cs_${crypto.randomBytes(6).toString("hex")}` }) {
  const ids = () => (typeof patternIds === "function" ? patternIds() : patternIds);
  function load() {
    const raw = read();
    if (raw !== null && raw !== undefined) {
      const { dropped: _dropped, ...store } = custom.normalizeCustomStrategyStore(raw, { patternIds: ids() });
      return store;
    }
    // First use: migrate the legacy settings combination exactly once.
    let store = { ...custom.emptyStore(), migratedLegacy: true };
    const legacy = custom.legacyStrategyFromSettings(loadLegacySelection(), { now: now() });
    if (legacy) store = { ...custom.saveCustomStrategyInStore(store, legacy, { patternIds: ids(), now: now(), newId }).store, migratedLegacy: true };
    write(store);
    return store;
  }
  const uniqueName = (store, name) => {
    const taken = new Set(store.strategies.map(item => item.name.toLocaleLowerCase("zh-CN")));
    if (!taken.has(name.toLocaleLowerCase("zh-CN"))) return name;
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${name.slice(0, custom.LIMITS.nameMax - 4)}（${index}）`;
      if (!taken.has(candidate.toLocaleLowerCase("zh-CN"))) return candidate;
    }
    return name;
  };
  return {
    list: () => load().strategies,
    save(input) {
      const { store, strategy } = custom.saveCustomStrategyInStore(load(), input, { patternIds: ids(), now: now(), newId });
      write(store);
      return { strategy, strategies: store.strategies };
    },
    remove(id) {
      const store = custom.deleteCustomStrategyFromStore(load(), String(id || ""));
      write(store);
      return { strategies: store.strategies };
    },
    /** Copy the current Settings combination into a new strategy (the settings stay unchanged). */
    importLegacy() {
      const legacy = custom.legacyStrategyFromSettings(loadLegacySelection(), { now: now() });
      if (!legacy) throw new custom.CustomStrategyError("设置中的自主策略组合没有可用条件");
      const current = load();
      const { store, strategy } = custom.saveCustomStrategyInStore(current, { ...legacy, name: uniqueName(current, legacy.name.replace("（由设置迁移）", "（设置导入）")) },
        { patternIds: ids(), now: now(), newId });
      write(store);
      return { strategy, strategies: store.strategies };
    }
  };
}

module.exports = { createCustomStrategyStore };
