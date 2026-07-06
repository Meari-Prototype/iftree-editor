import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../dist/src/backend/store/index.js';
import { computeSubtreeHashes } from '../dist/src/core/merkle.js';

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-hash-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const dirtyFlag = (store, docId) =>
  store.db.prepare('SELECT nodes_hash_dirty FROM docs WHERE id = ?').get(docId).nodes_hash_dirty;

const nodeRows = (store, docId) => store.db.prepare(
  'SELECT id, parent_id, sort_order, text, node_title, node_note, node_type, trust_level FROM nodes WHERE doc_id = ?'
).all(docId);

function buildDoc(store) {
  const doc = store.createDoc({ title: 'H', rootText: '根' });
  const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
  store.insertNode({ docId: doc.id, parentId: a.id, text: 'a1' });
  const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'b' });
  return { doc, a, b };
}

test('新建即脏；ensureNodeHashes 整树补算并回写列、清脏标记，且与现算一致（verify 不变量）', async () => {
  await withStore(async (store) => {
    const { doc } = buildDoc(store);
    assert.notEqual(dirtyFlag(store, doc.id), 0);

    const hashes = store.ensureNodeHashes(doc.id);
    assert.ok(hashes.size >= 4);
    assert.equal(dirtyFlag(store, doc.id), 0, '补算后清脏');

    const persisted = store.db.prepare('SELECT content_hash, subtree_hash FROM nodes WHERE doc_id = ?').all(doc.id);
    assert.ok(persisted.every((row) => row.content_hash && row.subtree_hash), '列已回写');

    const fresh = computeSubtreeHashes(nodeRows(store, doc.id));
    for (const [id, h] of fresh) {
      assert.equal(hashes.get(id).contentHash, h.contentHash);
      assert.equal(hashes.get(id).subtreeHash, h.subtreeHash);
    }
  });
});

test('clean 时走读列分支，结果仍与现算一致', async () => {
  await withStore(async (store) => {
    const { doc } = buildDoc(store);
    store.ensureNodeHashes(doc.id);
    assert.equal(dirtyFlag(store, doc.id), 0);

    const cached = store.ensureNodeHashes(doc.id);
    const fresh = computeSubtreeHashes(nodeRows(store, doc.id));
    for (const [id, h] of fresh) assert.equal(cached.get(id).subtreeHash, h.subtreeHash);
  });
});

test('updateNode 经触发器标脏；回写哈希不自我标脏；祖先链冒泡', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDoc(store);
    const before = store.ensureNodeHashes(doc.id);
    assert.equal(dirtyFlag(store, doc.id), 0);

    store.updateNode(a.id, { text: 'a-changed' });
    assert.notEqual(dirtyFlag(store, doc.id), 0, 'updateNode 应标脏');

    const after = store.ensureNodeHashes(doc.id);
    assert.equal(dirtyFlag(store, doc.id), 0, '回写不自我标脏');
    assert.notEqual(after.get(String(a.id)).contentHash, before.get(String(a.id)).contentHash);
    assert.notEqual(
      after.get(String(doc.rootNodeId)).subtreeHash,
      before.get(String(doc.rootNodeId)).subtreeHash,
      'root 是 a 的祖先 → subtreeHash 冒泡'
    );
  });
});

test('insert 与 delete 也经触发器标脏', async () => {
  await withStore(async (store) => {
    const { doc, b } = buildDoc(store);
    store.ensureNodeHashes(doc.id);
    assert.equal(dirtyFlag(store, doc.id), 0);

    store.insertNode({ docId: doc.id, parentId: b.id, text: 'b-child' });
    assert.notEqual(dirtyFlag(store, doc.id), 0, 'insert 应标脏');

    store.ensureNodeHashes(doc.id);
    assert.equal(dirtyFlag(store, doc.id), 0);

    store.deleteNodeSubtree(b.id);
    assert.notEqual(dirtyFlag(store, doc.id), 0, 'delete 应标脏');
  });
});

// ─── 节点级增量重算（触发器置 NULL + ensureNodeHashes 增量路径）────────────────

const hashRow = (store, id) =>
  store.db.prepare('SELECT content_hash, subtree_hash FROM nodes WHERE id = ?').get(id);

const assertMatchesFullRecompute = (store, docId, ensured) => {
  const fresh = computeSubtreeHashes(nodeRows(store, docId));
  assert.equal(ensured.size, fresh.size, '返回 Map 覆盖全表');
  for (const [id, h] of fresh) {
    assert.equal(ensured.get(id).contentHash, h.contentHash, `content ${id}`);
    assert.equal(ensured.get(id).subtreeHash, h.subtreeHash, `subtree ${id}`);
  }
  const persisted = store.db.prepare('SELECT id, content_hash, subtree_hash FROM nodes WHERE doc_id = ?').all(docId);
  for (const row of persisted) {
    assert.equal(row.content_hash, fresh.get(String(row.id)).contentHash, `列回写 content ${row.id}`);
    assert.equal(row.subtree_hash, fresh.get(String(row.id)).subtreeHash, `列回写 subtree ${row.id}`);
  }
};

test('内容改动只失效本行；增量 ensure 与全量重算逐节点一致', async () => {
  await withStore(async (store) => {
    const { doc, a, b } = buildDoc(store);
    store.ensureNodeHashes(doc.id);

    store.updateNode(a.id, { text: 'a-改' });
    const dirty = store.db.prepare(
      'SELECT id FROM nodes WHERE doc_id = ? AND (content_hash IS NULL OR subtree_hash IS NULL)'
    ).all(doc.id).map((r) => String(r.id));
    assert.deepEqual(dirty, [String(a.id)], '触发器只清被改行，不动兄弟与祖先');
    assert.ok(hashRow(store, b.id).subtree_hash, 'b 行存量保留');

    assertMatchesFullRecompute(store, doc.id, store.ensureNodeHashes(doc.id));
    assert.equal(dirtyFlag(store, doc.id), 0);
  });
});

test('移动/插入/删除失效受影响父行；增量 ensure 与全量一致', async () => {
  await withStore(async (store) => {
    const { doc, a, b } = buildDoc(store);
    const a1 = store.db.prepare('SELECT id FROM nodes WHERE parent_id = ?').get(a.id);
    store.ensureNodeHashes(doc.id);

    // 移动 a1 → b 下：新旧父 subtree 失效，a1 自身 content_hash 保留（位置无关）。
    store.moveNodeToParent({ nodeId: a1.id, newParentId: b.id });
    assert.equal(hashRow(store, a.id).subtree_hash, null, '旧父 subtree 失效');
    assert.equal(hashRow(store, b.id).subtree_hash, null, '新父 subtree 失效');
    assert.ok(hashRow(store, a1.id).content_hash, '被移节点 content 保留');
    assertMatchesFullRecompute(store, doc.id, store.ensureNodeHashes(doc.id));

    // 插入：父行 subtree 失效，新行天然 NULL。
    const c = store.insertNode({ docId: doc.id, parentId: b.id, text: 'c' });
    assert.equal(hashRow(store, b.id).subtree_hash, null, '插入使父 subtree 失效');
    assert.equal(hashRow(store, c.id).content_hash, null, '新行 hash 为空');
    assertMatchesFullRecompute(store, doc.id, store.ensureNodeHashes(doc.id));

    // 删除子树：父行 subtree 失效。
    store.deleteNodeSubtree(b.id);
    assert.equal(hashRow(store, doc.rootNodeId).subtree_hash, null, '删除使父 subtree 失效');
    assertMatchesFullRecompute(store, doc.id, store.ensureNodeHashes(doc.id));
  });
});

test('旧库陈旧态安全网：位=1 但行 hash 非 NULL → 退全量、纠正陈旧值', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDoc(store);
    store.ensureNodeHashes(doc.id);
    const stale = hashRow(store, a.id);

    // 模拟旧触发器时代：内容变了但行 hash 被塞回旧值、只有粗位=1
    //（改 hash 列不在任何触发器监听列内，正好用来构造陈旧态）。
    store.updateNode(a.id, { text: 'a-新内容' });
    store.db.prepare('UPDATE nodes SET content_hash = ?, subtree_hash = ? WHERE id = ?')
      .run(stale.content_hash, stale.subtree_hash, a.id);
    store.db.prepare('UPDATE docs SET nodes_hash_dirty = 1 WHERE id = ?').run(doc.id);

    const ensured = store.ensureNodeHashes(doc.id);
    assert.notEqual(ensured.get(String(a.id)).contentHash, stale.content_hash, '陈旧值被全量纠正');
    assertMatchesFullRecompute(store, doc.id, ensured);
  });
});
