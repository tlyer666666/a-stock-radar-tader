'use strict';
const React = require('react');
const assert = require('node:assert/strict');

const walk = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(walk)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : React.Children.toArray(node?.props?.children).map(text).join('');
const find = (tree, predicate) => { const node = walk(tree).find(predicate); assert.ok(node, 'expected rendered control'); return node; };
const button = (tree, label) => find(tree, node => node.type === 'button' && text(node) === label);
const input = (tree, label) => find(tree, node => node.props?.['aria-label'] === label);

// Execute the real component's handlers without a DOM. Browser APIs belong to
// each test fixture. Child components remain elements and are not invoked.
function createHookHarness(Component, { props = {}, bindRefs = () => {}, runEffects = true } = {}) {
  const slots = [], cleanups = [];
  let cursor = 0, pending = [], tree;
  const memo = (factory, dependencies) => {
    const i = cursor++, previous = slots[i];
    if (!previous || !dependencies || dependencies.some((value, index) => value !== previous.dependencies[index])) slots[i] = { value: factory(), dependencies };
    return slots[i].value;
  };
  function render() {
    cursor = 0; pending = [];
    const original = Object.fromEntries(['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'useId'].map(key => [key, React[key]]));
    React.useState = initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; };
    React.useRef = value => { const i = cursor++; return slots[i] ||= { current: value }; };
    React.useMemo = memo;
    React.useCallback = (fn, dependencies) => memo(() => fn, dependencies);
    React.useId = () => `test-hook-${cursor++}`;
    React.useEffect = (effect, dependencies) => {
      const i = cursor++, previous = slots[i];
      if (!previous || !dependencies || dependencies.some((value, index) => value !== previous[index])) { slots[i] = dependencies; pending.push(() => { cleanups[i]?.(); cleanups[i] = effect(); }); }
    };
    try { tree = Component(props); }
    finally { Object.assign(React, original); }
    bindRefs(tree);
    if (runEffects) pending.forEach(effect => effect());
    return tree;
  }
  return { render, get tree() { return tree; }, async flush() { await new Promise(resolve => setImmediate(resolve)); return render(); }, dispose() { cleanups.forEach(cleanup => cleanup?.()); } };
}

module.exports = { createHookHarness, walk, text, find, button, input };
