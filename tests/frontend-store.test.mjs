import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStore, shallowEqual } from '../dist/src/frontend/stores/create-store.js';

// domain store 内核（frontend-refactor.md §4.2/§4.8）：持引用 + 通知，转移是纯函数。

test('createStore: getState 返回初值，setState 直接值替换并广播', () => {
  const store = createStore({ count: 0 });
  assert.deepEqual(store.getState(), { count: 0 });

  let notified = 0;
  store.subscribe(() => { notified += 1; });
  store.setState({ count: 1 });
  assert.deepEqual(store.getState(), { count: 1 });
  assert.equal(notified, 1);
});

test('createStore: 函数式转移拿到 prev，返回 next', () => {
  const store = createStore({ items: ['a'] });
  store.setState((prev) => ({ items: [...prev.items, 'b'] }));
  assert.deepEqual(store.getState().items, ['a', 'b']);
});

test('createStore: 返回原引用视为无变化，不广播（防回环惯例）', () => {
  const state = { view: { depth: 2 } };
  const store = createStore(state);
  let notified = 0;
  store.subscribe(() => { notified += 1; });

  store.setState(state);            // 同引用直接值
  store.setState((prev) => prev);   // 同引用函数式
  assert.equal(notified, 0);

  store.setState({ ...state });     // 新引用才广播（内容相同也算变化，判等交给订阅侧 selector）
  assert.equal(notified, 1);
});

test('createStore: 退订后不再收通知，多订阅者各自独立', () => {
  const store = createStore(0);
  let a = 0;
  let b = 0;
  const offA = store.subscribe(() => { a += 1; });
  store.subscribe(() => { b += 1; });

  store.setState(1);
  offA();
  store.setState(2);
  assert.equal(a, 1);
  assert.equal(b, 2);
});

test('createStore: listener 内退订/加订不影响本轮通知', () => {
  const store = createStore(0);
  const seen = [];
  const offSelf = store.subscribe(() => {
    seen.push('self');
    offSelf(); // 本轮内退订自己
    store.subscribe(() => { seen.push('late'); });
  });
  store.subscribe(() => { seen.push('other'); });

  store.setState(1);
  // 本轮快照：self + other 都收到；本轮新增的 late 不收。
  assert.deepEqual(seen, ['self', 'other']);

  store.setState(2);
  // self 已退订；other 与上轮加订的 late 收到。
  assert.deepEqual(seen.slice(2).sort(), ['late', 'other']);
});

test('createStore: setState 在 listener 通知前完成状态替换（listener 读到新值）', () => {
  const store = createStore(0);
  let observed = -1;
  store.subscribe(() => { observed = store.getState(); });
  store.setState(42);
  assert.equal(observed, 42);
});

test('shallowEqual: 一层字段引用判等', () => {
  const node = { id: 'n1' };
  assert.equal(shallowEqual({ a: 1, b: node }, { a: 1, b: node }), true);
  assert.equal(shallowEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.equal(shallowEqual({ a: { deep: 1 } }, { a: { deep: 1 } }), false); // 深层新引用即视为变
  assert.equal(shallowEqual(null, {}), false);
  assert.equal(shallowEqual('x', 'x'), true); // 原始值走 Object.is
  const arr = [1, 2];
  assert.equal(shallowEqual([...arr], [...arr]), true); // 数组按索引键浅比
});
