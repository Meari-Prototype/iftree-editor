import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../dist/src/backend/store/index.js';
import { writeTree } from '../dist/src/backend/db/object-store.js';

// 保存路径增量写树（writeTreeIncremental + tree_object_hash 列缓存）与全量 writeTree 的
// 等价性锁定：同一快照两条路径的 root_tree_hash 必须逐字节一致——增量只是剪枝，不是新算法。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-editor-inc-tree-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function buildDoc(store) {
  const doc = store.createDoc({ title: 'T', rootText: '根' });
  const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
  const a1 = store.insertNode({ docId: doc.id, parentId: a.id, text: 'a1' });
  const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'b' });
  return { doc, a, a1, b };
}

const headTreeHash = (store, docId) => {
  const head = store.db.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get(docId);
  if (!head) return null;
  return store.db.prepare('SELECT root_tree_hash FROM commits WHERE id = ?').get(head.head_commit_id)?.root_tree_hash || null;
};

test('增量写树 ≡ 全量写树：首存 / 单点改后再存 / 无变化再存', async () => {
  await withStore(async (store) => {
    const { doc, a1 } = buildDoc(store);

    // 首存：列全 NULL，增量路径退化为全量算；产出与全量参考一致。
    store.saveHistorySnapshot({ docId: doc.id, summary: 's1' });
    const snap1 = store.createSnapshot(doc.id);
    const ref1 = writeTree(store.db, snap1.nodes);
    assert.equal(headTreeHash(store, doc.id), ref1.root_tree_hash, '首存 root_tree_hash 与全量参考一致');
    // 首存后所有行的 tree_object_hash 已回写（增量缓存就位）。
    const uncached = store.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE doc_id = ? AND tree_object_hash IS NULL').get(doc.id).n;
    assert.equal(uncached, 0, '首存后全部行应有列缓存');

    // 单点改 a1 正文：触发器把 a1 行 hash 列置 NULL；再存走增量（只重算 a1 ∪ 祖先链）。
    store.updateNode(a1.id, { text: 'a1 改' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 's2' });
    const snap2 = store.createSnapshot(doc.id);
    const ref2 = writeTree(store.db, snap2.nodes);
    assert.equal(headTreeHash(store, doc.id), ref2.root_tree_hash, '单点改后再存与全量参考一致');
    assert.notEqual(ref2.root_tree_hash, ref1.root_tree_hash, '内容变了根 hash 必须变');

    // 无变化再存：全行有缓存 → 全剪枝；根 hash 不变。
    store.saveHistorySnapshot({ docId: doc.id, summary: 's3' });
    assert.equal(headTreeHash(store, doc.id), ref2.root_tree_hash, '无变化再存根 hash 不变');
  });
});

test('结构变化（移动节点）后增量保存仍与全量一致', async () => {
  await withStore(async (store) => {
    const { doc, a, b } = buildDoc(store);
    store.saveHistorySnapshot({ docId: doc.id, summary: 's1' });

    // move 触发器置 NULL 的是新旧父行的子树两列——增量应只重算受影响路径。
    store.moveNodeToParent({ nodeId: b.id, newParentId: a.id });
    store.saveHistorySnapshot({ docId: doc.id, summary: 's2' });
    const snap = store.createSnapshot(doc.id);
    const ref = writeTree(store.db, snap.nodes);
    assert.equal(headTreeHash(store, doc.id), ref.root_tree_hash, '移动后再存与全量参考一致');
  });
});

test('句位归属变化不污染节点树指纹：span 重挂后 root_tree_hash 不变', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDoc(store);
    store.saveSourceDocument({
      docId: doc.id,
      sourcePath: 'x.md',
      sourceType: 'md',
      rawMarkdown: '甲句。乙句。',
      spans: [
        { sentence_index: 1, start_offset: 0, end_offset: 3, text: '甲句。' },
        { sentence_index: 2, start_offset: 3, end_offset: 6, text: '乙句。' }
      ],
      nodeIdsBySentenceIndex: new Map([[1, a.id], [2, a.id]])
    });
    store.saveHistorySnapshot({ docId: doc.id, summary: 's1' });
    const treeHashBefore = headTreeHash(store, doc.id);

    // 只动归属，一个 nodes 行都不碰。归属若并进 tree/blob 指纹，这里 root_tree_hash 就会变——
    // 而 source_spans 的写入不触发 nodes 的 hash 失效触发器，增量写树会剪掉「归属变、内容不变」
    // 的子树、写出与全量不一致的指纹。归属走独立的 spanmap 对象正是为了避开这个。
    store.db.prepare('UPDATE source_spans SET node_id = NULL WHERE doc_id = ? AND sentence_index = 2').run(doc.id);
    store.saveHistorySnapshot({ docId: doc.id, summary: 's2' });

    assert.equal(headTreeHash(store, doc.id), treeHashBefore, '只改句位归属不该改节点树指纹');
    const snap = store.createSnapshot(doc.id);
    assert.equal(writeTree(store.db, snap.nodes).root_tree_hash, treeHashBefore, '增量结果仍与全量参考一致');

    // 但 spanmap 侧要如实记下这次变化：两个时代各一份对象。
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM objects WHERE kind = 'spanmap'").get().n, 2);
  });
});
