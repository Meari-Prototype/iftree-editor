import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../dist/src/backend/store/index.js';
import { stageEntityWrite } from '../dist/src/backend/entities/write.js';

// 回归：编辑分支提交时，diff 里的 entity 条目必须经 applyEntityEntry 真实落库。
//
// 曾经的 bug：store.applyEditBranchDiffEntries 提交循环对 entity 调度时写成
// applyEntityEntry(this, ...)。该纯函数经门面 editBranch.applyEditBranchDiffEntries(this, ...)
// 调用，函数体内 this 是 editBranch 模块命名空间对象（而非传入的 store 形参）——
// store 实例其实已在第一形参 store 上。于是 applyEntityEntry 收到的 store.db 为 undefined，
// 任何 entity.* 条目提交时在 store.db.prepare(...) 抛 TypeError。node/axiom/ref 路径直接用
// store 形参、不受影响，且测试从未覆盖 entity 提交落库，故 bug 一直潜伏。
//
// 本测试经真实 stage 入口（mutation-api 的 entity 写动词同源）构造 entity.create 条目，
// 提交后断言主库 entities 表确有落行，把这条提交重放路径钉死：若 this/store 再被写错，
// saveEditBranch 会在重放时抛 TypeError 而非静默——测试随之失败。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-entity-commit-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('entity.create：编辑分支提交经 applyEntityEntry 落库（回归 this/store 误用）', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'EntityCommit', rootText: '根' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '正文节点' });
    store.saveHistorySnapshot({ docId: doc.id }); // C0，base==head → 保存走快进重放

    const branch = store.beginEditBranch(doc.id, 'human');
    const staged = stageEntityWrite(store, branch, { docId: doc.id, literal: '示例术语' }, 'entity.create');
    assert.equal(staged.ok, true, 'stage entity.create 成功');

    // 提交：触发 applyEditBranchDiffEntries → applyEntityEntry(store, ...) 重放落库。
    // 若调度误传 this，此处会在 store.db.prepare 抛 TypeError。
    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });

    const rows = store.db.prepare('SELECT literal FROM entities WHERE doc_id = ?').all(doc.id);
    assert.equal(rows.length, 1, '提交后主库 entities 表应有 1 行（applyEntityEntry 拿到真 store 落库）');
    assert.equal(rows[0].literal, '示例术语', '落库 literal 与 stage 一致');
  });
});
