import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../src/backend/store/index.mjs';
import { createDatabaseService } from '../src/backend/database-service.mjs';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-3way-resolve-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// 分叉：C0（root/a/b）→ 从 C0 切分支 → branchEdits（暂存）；mainEdits（直接写主干）→ C1。
function forkAndDiverge(store, title, { branchEdits, mainEdits }) {
  const doc = store.createDoc({ title, rootText: '根' });
  const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
  const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'b' });
  store.saveHistorySnapshot({ docId: doc.id }); // C0

  const branch = store.beginEditBranch(doc.id, 'human'); // fork at C0
  branchEdits(store, branch, { a, b });

  mainEdits(store, { a, b });
  store.saveHistorySnapshot({ docId: doc.id }); // C1，head 前移

  return { doc, a, b };
}

const nodeText = (store, id) => store.db.prepare('SELECT text FROM nodes WHERE id = ?').get(id)?.text;
const nodeExists = (store, id) => Boolean(store.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(id));

// 同一节点同字段两侧改不同 → 人裁取 theirs（分支值胜出）。
test('内容冲突 · 取 theirs：主干写成分支值，分支移除', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'PickTheirs', {
      branchEdits: (s, br, { a }) => s.stageEditBranchNodeUpdate(br, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { a }) => s.updateNode(a.id, { text: 'a-main' })
    });

    const applied = store.applyThreeWayMerge({
      baseDocId: doc.id, owner: 'human',
      resolutions: [{ id: String(a.id), field: 'text', pick: 'theirs' }]
    });
    assert.equal(applied.applied, true);
    assert.equal(nodeText(store, a.id), 'a-branch');
    assert.ok(!store.findEditBranch({ baseDocId: doc.id, owner: 'human' }), '分支已移除');
  });
});

// 取 ours：剥掉分支对该字段的 patch → 主干保留己方值。
test('内容冲突 · 取 ours：主干保留己方值', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'PickOurs', {
      branchEdits: (s, br, { a }) => s.stageEditBranchNodeUpdate(br, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { a }) => s.updateNode(a.id, { text: 'a-main' })
    });

    const applied = store.applyThreeWayMerge({
      baseDocId: doc.id, owner: 'human',
      resolutions: [{ id: String(a.id), field: 'text', pick: 'ours' }]
    });
    assert.equal(applied.applied, true);
    assert.equal(nodeText(store, a.id), 'a-main');
  });
});

// 填值：人填合并值 → 主干写成填入值。
test('内容冲突 · 填值：主干写成填入的合并值', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'PickFill', {
      branchEdits: (s, br, { a }) => s.stageEditBranchNodeUpdate(br, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { a }) => s.updateNode(a.id, { text: 'a-main' })
    });

    const applied = store.applyThreeWayMerge({
      baseDocId: doc.id, owner: 'human',
      resolutions: [{ id: String(a.id), field: 'text', pick: 'fill', value: 'a-merged' }]
    });
    assert.equal(applied.applied, true);
    assert.equal(nodeText(store, a.id), 'a-merged');
  });
});

// 漏裁：有冲突未给出对应 resolution → 拒绝写回，列出 unresolved，主干与分支不动。
test('漏裁：未覆盖全部冲突 → 拒绝写回并标 unresolved', async () => {
  await withStore(async (store) => {
    const { doc, a, b } = forkAndDiverge(store, 'Partial', {
      branchEdits: (s, br, { a, b }) => {
        s.stageEditBranchNodeUpdate(br, { nodeId: a.id, patch: { text: 'a-branch' } });
        s.stageEditBranchNodeUpdate(br, { nodeId: b.id, patch: { text: 'b-branch' } });
      },
      mainEdits: (s, { a, b }) => {
        s.updateNode(a.id, { text: 'a-main' });
        s.updateNode(b.id, { text: 'b-main' });
      }
    });

    const applied = store.applyThreeWayMerge({
      baseDocId: doc.id, owner: 'human',
      resolutions: [{ id: String(a.id), field: 'text', pick: 'theirs' }]
    });
    assert.equal(applied.applied, false);
    assert.ok(applied.resolutionErrors.some((e) => String(e.id) === String(b.id) && e.reason === 'unresolved'));
    assert.equal(nodeText(store, a.id), 'a-main', '主干未被改动');
    assert.equal(nodeText(store, b.id), 'b-main', '主干未被改动');
    assert.ok(store.findEditBranch({ baseDocId: doc.id, owner: 'human' }), '分支仍在');
  });
});

// delete-modify（分支删、主干改）取 ours → 保留主干修改版。
test('删改冲突 · 分支删/主干改 · 取 ours：节点保留己方修改', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'DelMod-keepOurs', {
      branchEdits: (s, br, { a }) => s.stageEditBranchNodeDelete(br, { nodeId: a.id }),
      mainEdits: (s, { a }) => s.updateNode(a.id, { text: 'a-main' })
    });

    const applied = store.applyThreeWayMerge({
      baseDocId: doc.id, owner: 'human',
      resolutions: [{ id: String(a.id), field: '__node__', pick: 'ours' }]
    });
    assert.equal(applied.applied, true);
    assert.ok(nodeExists(store, a.id), 'a 仍在');
    assert.equal(nodeText(store, a.id), 'a-main', '保留 ours 修改');
  });
});

// delete-modify 取 theirs → 接受删除。
test('删改冲突 · 分支删/主干改 · 取 theirs：接受删除', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'DelMod-accept', {
      branchEdits: (s, br, { a }) => s.stageEditBranchNodeDelete(br, { nodeId: a.id }),
      mainEdits: (s, { a }) => s.updateNode(a.id, { text: 'a-main' })
    });

    const applied = store.applyThreeWayMerge({
      baseDocId: doc.id, owner: 'human',
      resolutions: [{ id: String(a.id), field: '__node__', pick: 'theirs' }]
    });
    assert.equal(applied.applied, true);
    assert.ok(!nodeExists(store, a.id), 'a 已删');
  });
});

// delete-modify（主干删、分支改）= 复活己删节点 → 结构性失配，前置验证直接 blocked（v1 不可裁）。
test('删改冲突 · 主干删/分支改 → blocked，复活不支持', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'DelMod-resurrect', {
      branchEdits: (s, br, { a }) => s.stageEditBranchNodeUpdate(br, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { a }) => s.deleteNodeSubtree(a.id)
    });

    const applied = store.applyThreeWayMerge({
      baseDocId: doc.id, owner: 'human',
      resolutions: [{ id: String(a.id), field: '__node__', pick: 'theirs' }]
    });
    assert.equal(applied.applied, false);
    assert.equal(applied.blocked, true, '结构性失配 → blocked，人裁不适用');
    assert.equal(applied.message, '主干已被修改，无法保存，请放弃本次编辑');
    assert.ok(applied.blockedConflicts.some((c) => c.kind === 'node-deleted'));
    assert.ok(store.findEditBranch({ baseDocId: doc.id, owner: 'human' }), '分支仍在');
  });
});

// 两侧把同一节点重挂到不同父 → 结构意图相撞，前置验证 blocked（v1 不可裁）。
test('父节点冲突 · 两侧重挂不同父 → blocked', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'ParentConflict', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
    const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'b' });
    const c = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'c' });
    store.saveHistorySnapshot({ docId: doc.id }); // C0

    const branch = store.beginEditBranch(doc.id, 'human');
    store.stageEditBranchNodeReparent(branch, { nodeId: c.id, newParentId: a.id }); // 分支：c 挂到 a

    store.db.prepare('UPDATE nodes SET parent_id = ? WHERE id = ?').run(b.id, c.id); // 主干：c 挂到 b
    store.saveHistorySnapshot({ docId: doc.id }); // C1

    const applied = store.applyThreeWayMerge({
      baseDocId: doc.id, owner: 'human',
      resolutions: [{ id: String(c.id), field: 'parent_id', pick: 'theirs' }]
    });
    assert.equal(applied.applied, false);
    assert.equal(applied.blocked, true);
    assert.ok(applied.blockedConflicts.some((x) => x.kind === 'parent-conflict'));
  });
});

// 经 db 契约：write 带 resolutions 应用人裁结果。
test('经 db 契约：write editBranch.applyMerge 带 resolutions', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'ContractResolve', {
      branchEdits: (s, br, { a }) => s.stageEditBranchNodeUpdate(br, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { a }) => s.updateNode(a.id, { text: 'a-main' })
    });
    const service = createDatabaseService({ store });

    const applied = await service.write({
      action: 'editBranch.applyMerge', baseDocId: doc.id, owner: 'human',
      resolutions: [{ id: String(a.id), field: 'text', pick: 'theirs' }]
    });
    assert.equal(applied.applied, true);
    assert.equal(nodeText(store, a.id), 'a-branch');
  });
});
