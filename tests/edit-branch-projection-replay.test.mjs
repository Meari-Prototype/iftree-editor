import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../src/backend/store.mjs';

// 投影 vs 重放一致性：编辑期 projectEditBranchDoc 给用户看的结果，必须与
// 保存时 applyEditBranchDiffEntries 真实写入主干的结果一致（所见即所得）。
// 场景统一为：建文档 → 提交 C0 → 开分支 → stage entry → 取投影 → 保存（快进重放）→ 比对 DB。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-proj-replay-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function projectedChildTexts(store, branch, parentId) {
  const projected = store._projectedDocForBranch(branch);
  return projected.nodes
    .filter((node) => String(node.parent_id) === String(parentId))
    .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0))
    .map((node) => node.text);
}

function savedChildTexts(store, parentId) {
  return store.db.prepare('SELECT text FROM nodes WHERE parent_id = ? ORDER BY sort_order, id')
    .all(parentId)
    .map((row) => row.text);
}

function setupBranch(store, title, childTexts) {
  const doc = store.createDoc({ title, rootText: '根' });
  const children = {};
  for (const text of childTexts) {
    children[text] = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text });
  }
  store.saveHistorySnapshot({ docId: doc.id }); // C0，分支 base == head → 保存走快进重放
  const branch = store.beginEditBranch(doc.id, 'human');
  return { doc, children, branch };
}

test('node.moveBefore：投影插在 target 之前，与重放一致（同父前移）', async () => {
  await withStore(async (store) => {
    const { doc, children, branch } = setupBranch(store, 'MoveBeforeForward', ['a', 'b', 'c']);
    const fresh = store._appendEditBranchEntry(branch, {
      kind: 'node.moveBefore',
      node_ref: children.c.id,
      target_ref: children.a.id
    });

    const projected = projectedChildTexts(store, fresh, doc.rootNodeId);
    assert.deepEqual(projected, ['c', 'a', 'b'], '投影：c 移到 a 之前');

    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    assert.deepEqual(savedChildTexts(store, doc.rootNodeId), projected, '保存所得 == 编辑所见');
  });
});

test('node.moveBefore：同父向后移（node 原在 target 前）不错位', async () => {
  await withStore(async (store) => {
    const { doc, children, branch } = setupBranch(store, 'MoveBeforeBackward', ['a', 'b', 'c']);
    const fresh = store._appendEditBranchEntry(branch, {
      kind: 'node.moveBefore',
      node_ref: children.a.id,
      target_ref: children.c.id
    });

    const projected = projectedChildTexts(store, fresh, doc.rootNodeId);
    assert.deepEqual(projected, ['b', 'a', 'c'], '投影：a 移到 c 之前');

    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    assert.deepEqual(savedChildTexts(store, doc.rootNodeId), projected, '保存所得 == 编辑所见');
  });
});

test('node.moveBefore：跨父移动挂到 target 父级并插在 target 之前', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'MoveBeforeReparent', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
    const a1 = store.insertNode({ docId: doc.id, parentId: a.id, text: 'a1' });
    const a2 = store.insertNode({ docId: doc.id, parentId: a.id, text: 'a2' });
    const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'b' });
    void a1;
    store.saveHistorySnapshot({ docId: doc.id });
    const branch = store.beginEditBranch(doc.id, 'human');

    const fresh = store._appendEditBranchEntry(branch, {
      kind: 'node.moveBefore',
      node_ref: b.id,
      target_ref: a2.id
    });

    assert.deepEqual(projectedChildTexts(store, fresh, a.id), ['a1', 'b', 'a2'], '投影：b 挂入 a、插在 a2 之前');
    assert.deepEqual(projectedChildTexts(store, fresh, doc.rootNodeId), ['a'], '投影：root 下只剩 a');

    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    assert.deepEqual(savedChildTexts(store, a.id), ['a1', 'b', 'a2'], '重放与投影一致');
    assert.deepEqual(savedChildTexts(store, doc.rootNodeId), ['a']);
  });
});

test('node.moveAfter：同父向后移与重放一致（回归下标系/排序值系混用错位）', async () => {
  await withStore(async (store) => {
    const { doc, children, branch } = setupBranch(store, 'MoveAfterBackward', ['a', 'b', 'c']);
    const fresh = store._appendEditBranchEntry(branch, {
      kind: 'node.moveAfter',
      node_ref: children.a.id,
      target_ref: children.b.id
    });

    const projected = projectedChildTexts(store, fresh, doc.rootNodeId);
    assert.deepEqual(projected, ['b', 'a', 'c'], '投影：a 移到 b 之后');

    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    assert.deepEqual(savedChildTexts(store, doc.rootNodeId), projected, '保存所得 == 编辑所见');
  });
});

test('node.mergeInto：正文 \\n\\n 连接、title/note 合并、孩子归并次序与重放一致', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'MergeInto', rootText: '根' });
    const target = store.insertNode({
      docId: doc.id, parentId: doc.rootNodeId, text: 'T 正文', nodeTitle: 'T 标题', nodeNote: 'T 备注'
    });
    const t1 = store.insertNode({ docId: doc.id, parentId: target.id, text: 't1' });
    const source = store.insertNode({
      docId: doc.id, parentId: doc.rootNodeId, text: 'S 正文', nodeTitle: 'S 标题', nodeNote: 'S 备注'
    });
    const s1 = store.insertNode({ docId: doc.id, parentId: source.id, text: 's1' });
    const s2 = store.insertNode({ docId: doc.id, parentId: source.id, text: 's2' });
    void t1; void s1; void s2;
    store.saveHistorySnapshot({ docId: doc.id });
    const branch = store.beginEditBranch(doc.id, 'human');

    const staged = store.stageEditBranchNodeMergeInto(branch, { nodeId: source.id, targetNodeId: target.id });

    const projected = store._projectedDocForBranch(staged.branch);
    const projectedTarget = projected.nodes.find((node) => String(node.id) === String(target.id));
    assert.equal(projectedTarget.text, 'T 正文\n\nS 正文', '投影正文按 \\n\\n 连接');
    assert.equal(projectedTarget.node_title, 'T 标题\n\nS 标题', '投影合并 node_title');
    assert.equal(projectedTarget.node_note, 'T 备注\n\nS 备注', '投影合并 node_note');
    assert.ok(!projected.nodes.some((node) => String(node.id) === String(source.id)), '投影中 source 已消失');
    assert.deepEqual(projectedChildTexts(store, staged.branch, target.id), ['t1', 's1', 's2'], '投影孩子归并到尾部');

    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    const savedTarget = store.db.prepare('SELECT text, node_title, node_note FROM nodes WHERE id = ?').get(target.id);
    assert.equal(savedTarget.text, projectedTarget.text, '保存正文 == 投影正文');
    assert.equal(savedTarget.node_title, projectedTarget.node_title, '保存 title == 投影 title');
    assert.equal(savedTarget.node_note, projectedTarget.node_note, '保存 note == 投影 note');
    assert.ok(!store.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(source.id), 'source 已从主干删除');
    assert.deepEqual(savedChildTexts(store, target.id), ['t1', 's1', 's2'], '重放孩子次序与投影一致');
  });
});

test('node.mergeInto：指向被合并节点的引用蒸发，目标与孩子的引用保留（投影与重放一致）', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'MergeRefs', rootText: '根' });
    const target = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 't' });
    const source = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 's' });
    const s1 = store.insertNode({ docId: doc.id, parentId: source.id, text: 's1' });
    const witness = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'w' });
    const intoSource = store.addNodeRefToNode({ docId: doc.id, sourceNodeId: witness.id, targetNodeId: source.id, refKind: '相关' });
    const fromSource = store.addNodeRefToNode({ docId: doc.id, sourceNodeId: source.id, targetNodeId: witness.id, refKind: '相关' });
    const intoTarget = store.addNodeRefToNode({ docId: doc.id, sourceNodeId: witness.id, targetNodeId: target.id, refKind: '相关' });
    const intoChild = store.addNodeRefToNode({ docId: doc.id, sourceNodeId: witness.id, targetNodeId: s1.id, refKind: '相关' });
    store.saveHistorySnapshot({ docId: doc.id });
    const branch = store.beginEditBranch(doc.id, 'human');

    const staged = store.stageEditBranchNodeMergeInto(branch, { nodeId: source.id, targetNodeId: target.id });

    const projectedIds = new Set(store._projectedDocForBranch(staged.branch).refs.map((ref) => String(ref.id)));
    assert.ok(!projectedIds.has(String(intoSource.id)), '投影：指向被合并节点的引用蒸发');
    assert.ok(!projectedIds.has(String(fromSource.id)), '投影：被合并节点发出的引用蒸发');
    assert.ok(projectedIds.has(String(intoTarget.id)), '投影：指向目标的引用保留');
    assert.ok(projectedIds.has(String(intoChild.id)), '投影：指向搬家孩子的引用保留');

    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    const savedIds = new Set(store.db.prepare('SELECT id FROM refs').all().map((row) => String(row.id)));
    assert.deepEqual(savedIds, projectedIds, '保存后的引用集合 == 投影的引用集合');
  });
});

test('node.delete：指向被删子树内节点的引用蒸发（投影与重放一致）', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'DeleteRefs', rootText: '根' });
    const x = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'x' });
    const x1 = store.insertNode({ docId: doc.id, parentId: x.id, text: 'x1' });
    const witness = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'w' });
    const other = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'y' });
    const intoDeep = store.addNodeRefToNode({ docId: doc.id, sourceNodeId: witness.id, targetNodeId: x1.id, refKind: '相关' });
    const fromDeep = store.addNodeRefToNode({ docId: doc.id, sourceNodeId: x1.id, targetNodeId: witness.id, refKind: '相关' });
    const unrelated = store.addNodeRefToNode({ docId: doc.id, sourceNodeId: witness.id, targetNodeId: other.id, refKind: '相关' });
    store.saveHistorySnapshot({ docId: doc.id });
    const branch = store.beginEditBranch(doc.id, 'human');

    const fresh = store._appendEditBranchEntry(branch, { kind: 'node.delete', target_ref: x.id });

    const projectedIds = new Set(store._projectedDocForBranch(fresh).refs.map((ref) => String(ref.id)));
    assert.ok(!projectedIds.has(String(intoDeep.id)), '投影：指向子树内节点的引用蒸发');
    assert.ok(!projectedIds.has(String(fromDeep.id)), '投影：子树内节点发出的引用蒸发');
    assert.ok(projectedIds.has(String(unrelated.id)), '投影：无关引用保留');

    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    const savedIds = new Set(store.db.prepare('SELECT id FROM refs').all().map((row) => String(row.id)));
    assert.deepEqual(savedIds, projectedIds, '保存后的引用集合 == 投影的引用集合');
  });
});

test('node.mergePrevious：source_ref 并入 target_ref（前一兄弟），投影与重放一致', async () => {
  await withStore(async (store) => {
    const { doc, children, branch } = setupBranch(store, 'MergePrevious', ['前段', '后段']);
    const fresh = store._appendEditBranchEntry(branch, {
      kind: 'node.mergePrevious',
      source_ref: children['后段'].id,
      target_ref: children['前段'].id
    });

    const projected = store._projectedDocForBranch(fresh);
    const projectedPrev = projected.nodes.find((node) => String(node.id) === String(children['前段'].id));
    assert.equal(projectedPrev.text, '前段\n\n后段', '投影：后段并入前一兄弟');
    assert.ok(!projected.nodes.some((node) => String(node.id) === String(children['后段'].id)));

    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    assert.equal(
      store.db.prepare('SELECT text FROM nodes WHERE id = ?').get(children['前段'].id).text,
      projectedPrev.text,
      '保存所得 == 编辑所见'
    );
    assert.ok(!store.db.prepare('SELECT 1 FROM nodes WHERE id = ?').get(children['后段'].id));
  });
});

test('node.insert：分支声明的 trust_level 在保存重放后保留（不得静默归 null）', async () => {
  await withStore(async (store) => {
    const { doc } = setupBranch(store, 'InsertTrustLevel', ['a']);
    const branch = store.activeEditBranchForBaseDoc(doc.id, 'human');
    const staged = store.stageEditBranchNodeInsert(branch, {
      parentId: doc.rootNodeId,
      text: '记忆条目正文',
      nodeTitle: '[反馈] 示例',
      nodeNote: '源 example.md',
      trust_level: '受控'
    });
    assert.equal(staged.node?.trust_level, '受控', '投影节点带 trust_level');

    store.saveEditBranch({ baseDocId: doc.id, owner: 'human' });
    const saved = store.db.prepare(
      'SELECT text, node_title, node_note, trust_level FROM nodes WHERE doc_id = ? AND node_title = ?'
    ).get(doc.id, '[反馈] 示例');
    assert.ok(saved, '插入节点已落主干');
    assert.equal(saved.trust_level, '受控', '重放保留 trust_level（曾翻车：31 条受控全丢成 null）');
    assert.equal(saved.node_note, '源 example.md');
  });
});
