import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../dist/src/backend/store/index.js';
import { computeSnapshotDiff } from '../dist/src/backend/db/snapshot-history.js';
import { locateNodeInTree, createTreeLocateCaches } from '../dist/src/backend/db/object-store.js';

// nodeHistory O(K) 剪枝（NOW.md「nodeHistory O(K) 剪枝未做」）：对象库 tree 指纹定位
// 替代逐 commit 物化整树。行为锁定两路：
//   1. 参考实现对拍——旧算法（逐 commit 物化 + 全量 diff）在测试内复刻，全场景输出必须
//      与新实现逐字段一致；
//   2. 语义要点单测——目标自身移动（__moved__，子树 hash 覆盖不到、靠位置指纹补）、
//      无关分支变化跳过、scope=node/subtree 口径差异。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-node-history-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 旧算法参考实现（外提前的 nodeHistory 逐字翻译，用作对拍真值）──────────
function subtreeMemberIds(snapshot, rootId) {
  const members = new Set();
  if (!snapshot || !Array.isArray(snapshot.nodes)) return members;
  const childrenByParent = new Map();
  for (const node of snapshot.nodes) {
    const parent = node.parent_id ?? node.parentId ?? null;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(node.id);
  }
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (members.has(id)) continue;
    members.add(id);
    for (const child of childrenByParent.get(id) || []) stack.push(child);
  }
  return members;
}

function referenceNodeHistory(store, docId, address, { scope = 'subtree' } = {}) {
  const target = store.db.prepare('SELECT id FROM nodes WHERE doc_id = ? AND address = ?').get(docId, String(address));
  if (!target) throw new Error(`reference target not found: ${address}`);
  const targetId = target.id;
  // 测试文档不做 reset：祖先链 = 全部 commit（与实现的 commitAncestry 过滤等价）。
  const commits = store.db.prepare('SELECT * FROM commits WHERE doc_id = ? ORDER BY committed_at ASC, id ASC').all(docId);
  const entries = [];
  let prevSnapshot = null;
  for (const commit of commits) {
    const snapshot = store.commitSnapshotFromRow(commit) || { nodes: [] };
    const members = scope === 'node'
      ? new Set([targetId])
      : new Set([...subtreeMemberIds(prevSnapshot, targetId), ...subtreeMemberIds(snapshot, targetId)]);
    let changes = [];
    let changed = false;
    if (!prevSnapshot) {
      changed = (snapshot.nodes || []).some((node) => members.has(node.id));
    } else {
      changes = computeSnapshotDiff(prevSnapshot, snapshot).filter((entry) => members.has(entry.node_id));
      changed = changes.length > 0;
    }
    if (changed) {
      entries.push({
        id: commit.id, commit_id: commit.id,
        committed_at: commit.committed_at, saved_at: commit.committed_at,
        summary: commit.summary, author: commit.author,
        changeCount: changes.length
      });
    }
    prevSnapshot = snapshot;
  }
  entries.reverse();
  return entries;
}

// 构一段多形态历史：内容改、无关分支改、子树内后代改、目标同父换位、reparent、后代删除。
function buildHistory(store) {
  const doc = store.createDoc({ title: '历史', rootText: '根' });
  const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
  const a1 = store.insertNode({ docId: doc.id, parentId: a.id, text: 'a1' });
  const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'b' });
  const c = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'c' });
  store.saveHistorySnapshot({ docId: doc.id, summary: '建树' });                       // S1
  store.updateNode(b.id, { text: 'b 改' });
  store.saveHistorySnapshot({ docId: doc.id, summary: '改无关分支 b' });               // S2
  store.updateNode(a1.id, { text: 'a1 改' });
  store.saveHistorySnapshot({ docId: doc.id, summary: '改子树内 a1' });                // S3
  store.moveNode(a.id, 'down');
  store.saveHistorySnapshot({ docId: doc.id, summary: '目标 a 同父下移' });            // S4
  store.moveNodeToParent({ nodeId: c.id, newParentId: a.id });
  store.saveHistorySnapshot({ docId: doc.id, summary: 'c reparent 进 a 子树' });       // S5
  store.deleteNodeSubtree(a1.id);
  store.saveHistorySnapshot({ docId: doc.id, summary: '删子树内 a1' });                // S6
  return { doc, a, a1, b, c };
}

test('剪枝实现与旧算法参考实现全场景对拍（node/subtree × 各目标地址）', async () => {
  await withStore(async (store) => {
    const { doc } = buildHistory(store);
    // 对文档里现存的每个地址、两种 scope 全对拍。
    const addresses = store.db.prepare('SELECT address FROM nodes WHERE doc_id = ? ORDER BY address').all(doc.id)
      .map((row) => row.address);
    assert.ok(addresses.length >= 3);
    for (const address of addresses) {
      for (const scope of ['subtree', 'node']) {
        const actual = store.nodeHistory(doc.id, address, { scope });
        const expected = referenceNodeHistory(store, doc.id, address, { scope });
        assert.deepEqual(actual, expected, `mismatch: ${address} scope=${scope}`);
      }
    }
  });
});

test('语义要点：无关分支改动跳过、目标自身移动被记录（位置指纹补 __moved__ 缺口）', async () => {
  await withStore(async (store) => {
    const { doc } = buildHistory(store);
    const summaries = (entries) => entries.map((entry) => entry.summary);

    // a 的子树历史：不含「改无关分支 b」；含建树、a1 改、a 自身移动、c 挂入、a1 删除。
    const aSubtree = summaries(store.nodeHistory(doc.id, '1-2', { scope: 'subtree' }));
    // S4 之后 a 在地址 1-2（下移一位）。
    assert.ok(!aSubtree.includes('改无关分支 b'));
    assert.ok(aSubtree.includes('改子树内 a1'));
    assert.ok(aSubtree.includes('目标 a 同父下移'), 'moved 目标自身必须被记录（剪枝位置指纹回归）');
    assert.ok(aSubtree.includes('c reparent 进 a 子树'));
    assert.ok(aSubtree.includes('删子树内 a1'));

    // a 的 node 级历史：内容没改过——只有建树 + 自身两次位置变化（下移、c 挂入不改 a 位置）。
    const aNode = summaries(store.nodeHistory(doc.id, '1-2', { scope: 'node' }));
    assert.ok(!aNode.includes('改子树内 a1'), 'node scope 不记录后代内容变化');
    assert.ok(aNode.includes('目标 a 同父下移'));

    // b 的历史（现地址 1-1）：只有建树 + 自身内容改 +（同父兄弟换位的连带/主动判定按旧口径）。
    const bNode = summaries(store.nodeHistory(doc.id, '1-1', { scope: 'node' }));
    assert.ok(bNode.includes('改无关分支 b'));
    assert.ok(!bNode.includes('改子树内 a1'));
  });
});

test('locateNodeInTree：定位指纹与物化快照一致，memo 跨 commit 复用后仍正确', async () => {
  await withStore(async (store) => {
    const { doc } = buildHistory(store);
    const commits = store.db.prepare('SELECT * FROM commits WHERE doc_id = ? ORDER BY committed_at ASC, id ASC').all(doc.id);
    const caches = createTreeLocateCaches();
    for (const commit of commits) {
      const snapshot = store.commitSnapshotFromRow(commit);
      for (const node of snapshot.nodes) {
        const location = locateNodeInTree(store.db, commit.root_tree_hash, commit.root_node_id, node.id, caches);
        assert.ok(location, `commit ${commit.summary} 应能定位节点 ${node.id}`);
        assert.equal(location.parentNodeId, node.parent_id == null ? null : String(node.parent_id));
        assert.equal(location.childIndex, Number(node.sort_order));
      }
      // 不存在的节点定位为 null
      assert.equal(locateNodeInTree(store.db, commit.root_tree_hash, commit.root_node_id, 'no-such-id', caches), null);
    }
  });
});
