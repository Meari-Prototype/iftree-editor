import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../src/backend/store.mjs';
import { createDatabaseService } from '../src/backend/database-service.mjs';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-3way-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// 搭一个分叉场景：提交 C0 → 从 C0 切分支 → 分支改某节点 → 主干直接改另一节点并提交 C1。
function forkAndDiverge(store, title, { branchEdits, mainEdits }) {
  const doc = store.createDoc({ title, rootText: '根' });
  const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
  const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'b' });
  store.saveHistorySnapshot({ docId: doc.id }); // C0，head=C0

  const branch = store.beginEditBranch(doc.id, 'human'); // fork at C0
  branchEdits(store, branch, { a, b });

  mainEdits(store, { a, b }); // 主干直接写 nodes
  store.saveHistorySnapshot({ docId: doc.id }); // C1，head 前移

  return { doc, a, b };
}

test('主干前移：分支改 a、主干改 b → 三方各取一侧，无冲突', async () => {
  await withStore(async (store) => {
    const { doc, a, b } = forkAndDiverge(store, 'NoConflict', {
      branchEdits: (s, branch, { a }) => s.stageEditBranchNodeUpdate(branch, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { b }) => s.updateNode(b.id, { text: 'b-main' })
    });

    const merge = store.computeThreeWayMerge({ baseDocId: doc.id, owner: 'human' });
    assert.equal(merge.fastForward, false, '主干前移 → 非快进');
    assert.equal(merge.hasConflicts, false);

    const byId = new Map(merge.nodes.map((n) => [n.id, n]));
    assert.equal(byId.get(String(a.id)).resolution, 'theirs', 'a 仅分支改 → 取分支');
    assert.equal(byId.get(String(b.id)).resolution, 'ours', 'b 仅主干改 → 取主干');
  });
});

test('两侧改同一节点同字段 → 冲突，按节点暴露', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'Conflict', {
      branchEdits: (s, branch, { a }) => s.stageEditBranchNodeUpdate(branch, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { a }) => s.updateNode(a.id, { text: 'a-main' })
    });

    const merge = store.computeThreeWayMerge({ baseDocId: doc.id, owner: 'human' });
    assert.equal(merge.hasConflicts, true);

    const byId = new Map(merge.nodes.map((n) => [n.id, n]));
    const ra = byId.get(String(a.id));
    assert.equal(ra.resolution, 'conflict');
    const c = ra.conflicts.find((x) => x.field === 'text');
    assert.equal(c.ours, 'a-main');
    assert.equal(c.theirs, 'a-branch');
    assert.equal(c.base, 'a');
  });
});

test('快进（分支 base == head，主干没动）→ fastForward=true', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'FF', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
    store.saveHistorySnapshot({ docId: doc.id });
    const branch = store.beginEditBranch(doc.id, 'human');
    store.stageEditBranchNodeUpdate(branch, { nodeId: a.id, patch: { text: 'a-branch' } });

    const merge = store.computeThreeWayMerge({ baseDocId: doc.id, owner: 'human' });
    assert.equal(merge.fastForward, true, '主干没前移 → 快进');
  });
});

test('无冲突 apply：自动合并写回主干，两侧改动都在，分支移除', async () => {
  await withStore(async (store) => {
    const { doc, a, b } = forkAndDiverge(store, 'ApplyNoConflict', {
      branchEdits: (s, branch, { a }) => s.stageEditBranchNodeUpdate(branch, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { b }) => s.updateNode(b.id, { text: 'b-main' })
    });

    const applied = store.applyThreeWayMerge({ baseDocId: doc.id, owner: 'human' });
    assert.equal(applied.applied, true);

    const textById = new Map(
      store.db.prepare('SELECT id, text FROM nodes WHERE doc_id = ?').all(doc.id).map((r) => [String(r.id), r.text])
    );
    assert.equal(textById.get(String(a.id)), 'a-branch', '分支对 a 的改动合入');
    assert.equal(textById.get(String(b.id)), 'b-main', '主干对 b 的改动保留');
    assert.ok(!store.findEditBranch({ baseDocId: doc.id, owner: 'human' }), '分支已移除');
  });
});

test('有冲突 apply：拒绝写回，返回冲突，主干与分支不变', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'ApplyConflict', {
      branchEdits: (s, branch, { a }) => s.stageEditBranchNodeUpdate(branch, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { a }) => s.updateNode(a.id, { text: 'a-main' })
    });

    const applied = store.applyThreeWayMerge({ baseDocId: doc.id, owner: 'human' });
    assert.equal(applied.applied, false);
    assert.ok(applied.conflicts.length > 0);

    assert.equal(store.db.prepare('SELECT text FROM nodes WHERE id = ?').get(a.id).text, 'a-main', '主干未被覆盖');
    assert.ok(store.findEditBranch({ baseDocId: doc.id, owner: 'human' }), '分支仍在');
  });
});

test('applyMerge 成功写回后只做 BM25 增量同步：向量不随保存生成/重算（4-6-1/8-3-2-2）', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'MergeEffects', {
      branchEdits: (s, branch, { a }) => s.stageEditBranchNodeUpdate(branch, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { b }) => s.updateNode(b.id, { text: 'b-main' })
    });
    const calls = [];
    const service = createDatabaseService({
      store,
      writeContext: {
        deleteDocVectors: (docId) => calls.push(['vector.delete_doc', String(docId)]),
        ensureDocVectors: (docId) => calls.push(['vector.ensure_doc', String(docId)]),
        rebuildKeywordIndexForDoc: (docId) => calls.push(['keyword.rebuild_doc', String(docId)]),
        updateKeywordForNodes: (docId, upsertIds, deleteIds) => calls.push([
          'keyword.update_nodes',
          String(docId),
          (upsertIds || []).map(String),
          (deleteIds || []).map(String)
        ]),
        deleteVectorsForNodes: (docId, nodeIds) => calls.push([
          'vector.delete_nodes',
          String(docId),
          (nodeIds || []).map(String)
        ])
      }
    });

    const applied = await service.write({ action: 'editBranch.applyMerge', baseDocId: doc.id, owner: 'human', includeDoc: false });
    assert.equal(applied.applied, true);
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['keyword.update_nodes', 'vector.delete_nodes'],
      'BM25 增量同步 + 向量只清陈旧行，不整篇重建不生成'
    );
    const [, docIdArg, upsertIds, deleteIds] = calls[0];
    assert.equal(docIdArg, String(doc.id));
    assert.deepEqual(upsertIds, [String(a.id)], '增量集合 = 本次实际受影响节点（分支改的 a）');
    assert.deepEqual(deleteIds, [], '本次无删除');
    assert.deepEqual(calls[1][2], [String(a.id)], 'a 正文变更 → 旧向量行清理');
    assert.ok(
      !('touchedNodeIds' in applied) && !('deletedNodeIds' in applied) && !('vectorStaleNodeIds' in applied),
      '受影响节点集不进响应'
    );
  });
});

test('保存增量集合：级联删除带整个子树，删除导致兄弟地址左移也算受影响', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'TouchedSet', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
    const a1 = store.insertNode({ docId: doc.id, parentId: a.id, text: 'a1' });
    const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'b' });
    store.saveHistorySnapshot({ docId: doc.id });
    const branch = store.beginEditBranch(doc.id, 'human');
    store.stageEditBranchNodeDelete(branch, { nodeId: a.id });

    const result = store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    assert.equal(result.applied, true);
    assert.deepEqual(
      result.deletedNodeIds.map(String).sort(),
      [String(a.id), String(a1.id)].sort(),
      '删除集合含整个子树'
    );
    // b 的地址从 1-2 左移到 1-1：keyword 行含地址（4-6-2），行得换 → 进受影响集合。
    assert.ok(result.touchedNodeIds.map(String).includes(String(b.id)), '地址左移的兄弟在受影响集合里');
    // 但向量只绑正文（15-8-1 地址变化不重算）：b 正文没变，不进向量清理集合。
    assert.deepEqual(result.vectorStaleNodeIds, [], '仅地址变化不算向量陈旧');
  });
});

test('结构盲区：主干删父、分支在其下新增 → blocked 拒绝写回，而非重放撞缺父报错', async () => {
  await withStore(async (store) => {
    const { doc } = forkAndDiverge(store, 'OrphanInsert', {
      branchEdits: (s, branch, { b }) => s.stageEditBranchNodeInsert(branch, { parentId: b.id, text: '孤儿' }),
      mainEdits: (s, { b }) => s.deleteNodeSubtree(b.id)
    });

    // 预览（三方分类）仍能看见 __parent__ 结构冲突。
    const merge = store.computeThreeWayMerge({ baseDocId: doc.id, owner: 'human' });
    assert.equal(merge.hasConflicts, true);
    assert.ok(merge.conflicts.some((c) => c.field === '__parent__'), '预览报 __parent__ 结构冲突');

    // 写回闸门：逐条前置验证 → blocked，主干与分支不动。
    const applied = store.applyThreeWayMerge({ baseDocId: doc.id, owner: 'human' });
    assert.equal(applied.applied, false);
    assert.equal(applied.blocked, true);
    assert.equal(applied.message, '主干已被修改，无法保存，请放弃本次编辑');
    assert.ok(applied.blockedConflicts.some((c) => c.kind === 'parent-deleted'));
    assert.ok(store.findEditBranch({ baseDocId: doc.id, owner: 'human' }), '分支仍在');

    // 结构性失配不接受人裁：带 resolutions 也照样 blocked。
    const resolved = store.applyThreeWayMerge({
      baseDocId: doc.id,
      owner: 'human',
      resolutions: [{ id: 'x', field: '__parent__', pick: 'ours' }]
    });
    assert.equal(resolved.applied, false);
    assert.equal(resolved.blocked, true);
  });
});

test('结构盲区：主干删父、分支把已有节点移入其下 → blocked（目标父已删）', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'OrphanReparent', {
      branchEdits: (s, branch, { a, b }) => s.stageEditBranchNodeReparent(branch, { nodeId: a.id, newParentId: b.id }),
      mainEdits: (s, { b }) => s.deleteNodeSubtree(b.id)
    });

    const merge = store.computeThreeWayMerge({ baseDocId: doc.id, owner: 'human' });
    assert.equal(merge.hasConflicts, true);
    const ra = merge.nodes.find((node) => node.id === String(a.id));
    assert.equal(ra.resolution, 'conflict');
    assert.ok(ra.conflicts.some((c) => c.field === '__parent__'));

    const applied = store.applyThreeWayMerge({ baseDocId: doc.id, owner: 'human' });
    assert.equal(applied.applied, false);
    assert.equal(applied.blocked, true);
    assert.ok(applied.blockedConflicts.some((c) => c.kind === 'parent-deleted'));
  });
});

// 发现 2 的根除回归：拆分账目带原文指纹，主干正文漂移 → 前置失败 blocked，
// 不再对主干新文本重新执行拆分（旧行为会把「取主干」静默改写）。
test('内容漂移：分支拆分节点、主干同期改其正文 → blocked，绝不对新文本重演拆分', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'SplitDrift', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '春天来了。花开了。' });
    store.saveHistorySnapshot({ docId: doc.id }); // C0

    const branch = store.beginEditBranch(doc.id, 'human');
    store.stageEditBranchNodeSplit(branch, { nodeId: a.id }); // 分支：按句拆分（入账时记原文指纹）

    store.updateNode(a.id, { text: '冬天来了。雪很大。' }); // 主干：同期改正文
    store.saveHistorySnapshot({ docId: doc.id }); // C1，head 前移

    const applied = store.applyThreeWayMerge({ baseDocId: doc.id, owner: 'human' });
    assert.equal(applied.applied, false);
    assert.equal(applied.blocked, true);
    assert.equal(applied.message, '主干已被修改，无法保存，请放弃本次编辑');
    assert.ok(applied.blockedConflicts.some((c) => c.kind === 'content-drift'));
    assert.equal(
      store.db.prepare('SELECT text FROM nodes WHERE id = ?').get(a.id).text,
      '冬天来了。雪很大。',
      '主干未被改动'
    );
    assert.ok(store.findEditBranch({ baseDocId: doc.id, owner: 'human' }), '分支仍在');
  });
});

test('diffView 包含公理（事实前提）差异：新增/修改/删除入行入统计，未修改不显示', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'AxiomDiff', rootText: '根' });
    const kept = store.addAxiom({ docId: doc.id, content: '保持不变' });
    const edited = store.addAxiom({ docId: doc.id, content: '原始内容' });
    const removed = store.addAxiom({ docId: doc.id, content: '将被删除' });
    store.saveHistorySnapshot({ docId: doc.id });

    let branch = store.beginEditBranch(doc.id, 'human');
    branch = store.stageEditBranchAxiomAdd(branch, { content: '新前提' }).branch;
    branch = store.stageEditBranchAxiomUpdate(branch, { axiomId: edited.id, patch: { content: '改后内容', status: 'confirmed' } }).branch;
    store.stageEditBranchAxiomDelete(branch, { axiomId: removed.id });

    const view = store.getEditBranchDiffView({ baseDocId: doc.id, owner: 'human' });
    const axiomRows = view.rows.filter((row) => row.kind === 'axiom');
    assert.equal(axiomRows.length, 3, '新增/修改/删除各一行，未修改公理不显示');

    const added = axiomRows.find((row) => row.status === 'added');
    assert.equal(added.left, null);
    assert.equal(added.right.text, '新前提');

    const modified = axiomRows.find((row) => row.status === 'modified');
    assert.equal(modified.left.text, '原始内容');
    assert.equal(modified.right.text, '改后内容');
    assert.deepEqual([...modified.changedFields].sort(), ['content', 'status']);
    assert.equal(modified.right.status, 'confirmed');

    const deleted = axiomRows.find((row) => row.status === 'deleted');
    assert.equal(deleted.left.text, '将被删除');
    assert.equal(deleted.right, null);

    assert.ok(!axiomRows.some((row) => String(row.left?.id) === String(kept.id)), '未修改公理不在差异行里');
    assert.equal(view.stats.added, 1);
    assert.equal(view.stats.modified, 1);
    assert.equal(view.stats.deleted, 1);
  });
});

test('经 db 契约：read 三方视图 + write 应用合并', async () => {
  await withStore(async (store) => {
    const { doc, a } = forkAndDiverge(store, 'Contract', {
      branchEdits: (s, branch, { a }) => s.stageEditBranchNodeUpdate(branch, { nodeId: a.id, patch: { text: 'a-branch' } }),
      mainEdits: (s, { b }) => s.updateNode(b.id, { text: 'b-main' })
    });
    const service = createDatabaseService({ store });

    const view = await service.read({ action: 'editBranch.threeWayMerge', baseDocId: doc.id, owner: 'human' });
    assert.equal(view.kind, 'editBranch.threeWayMerge');
    assert.equal(view.hasConflicts, false);

    const applied = await service.write({ action: 'editBranch.applyMerge', baseDocId: doc.id, owner: 'human' });
    assert.equal(applied.applied, true);
    assert.equal(store.db.prepare('SELECT text FROM nodes WHERE id = ?').get(a.id).text, 'a-branch');
  });
});
