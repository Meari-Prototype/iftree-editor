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
