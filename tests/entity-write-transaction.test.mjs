import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { runEntityWrite } from '../dist/src/backend/entities/write.js';

// 实体直写路径套事务（NOW.md「实体直写路径没套事务」）：runEntityWrite 的分发
// 在 store.withTransaction 内执行——多写语句动作（delete 级联、link 双向）中途
// 失败不留半成品。窄 store（测试/工具场景）不带 withTransaction 时直跑不炸。

test('带 withTransaction 的 store：分发在事务包裹内执行、错误照常穿透上抛', () => {
  let wrapped = 0;
  const store = {
    db: null,
    withTransaction(fn) {
      wrapped += 1;
      return fn();
    }
  };
  // 用未知 action 让 dispatch 在事务内抛错：既验证包裹发生（wrapped=1），
  // 又验证错误经 withTransaction 穿透上抛（模拟中途失败会触发真实现的 ROLLBACK 路径）。
  assert.throws(
    () => runEntityWrite(store, {}, 'entity.bogus'),
    /Unhandled entity write action: entity\.bogus/
  );
  assert.equal(wrapped, 1);
});

test('窄 store 不带 withTransaction：直跑分发、不因缺方法而炸', () => {
  const store = { db: null };
  assert.throws(
    () => runEntityWrite(store, {}, 'entity.bogus'),
    /Unhandled entity write action: entity\.bogus/
  );
});
