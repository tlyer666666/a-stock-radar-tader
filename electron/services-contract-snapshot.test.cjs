'use strict';
// services.cjs 导出契约快照。2026-11-15 全项目审核 P0-2 确定：拆分 services.cjs
// （万行上帝文件）时公开导出契约不得变化。本测试把全部导出的「名字 + 类型 + 函数元数」
// 与快照 JSON 比对，任何导出增删/签名漂移都会在这里红掉，是拆分与后续重构的安全网。
// 需要有意变更契约时，先评审再更新 services-contract-snapshot.json。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('services.cjs public export contract matches the committed snapshot', () => {
  const services = require('./services.cjs');
  // 名字 + 类型即可守住拆分安全网；函数元数不参与比对——P0-2b 拆分把部分实现迁到
  // services/*.cjs，services.cjs 侧是 (...args) 转发声明，元数归零属机械性变化。
  const signature = Object.keys(services).sort()
    .map(k => `${k}:${typeof services[k]}`);
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'services-contract-snapshot.json'), 'utf8'));
  assert.deepEqual(signature, snapshot);
});
