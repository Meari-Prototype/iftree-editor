import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../src/backend/store.mjs';
import { createDerivedIndexReconciler } from '../src/backend/derived-index-reconciler.mjs';
import { KeywordStore } from '../src/vector/keyword-store.mjs';
import { MIN_VECTOR_DIMENSIONS } from '../src/vector/embeddings.mjs';

// 向量完整性检验（projectneed 15-8-1 / 14-2）与 BM25 增量同步（4-6-2）：
// 有效性绑 node id + 节点自有正文——缺失补嵌、正文变更删旧重嵌、删除残留清理；
// 检验不通过时语义检索不开放。

// 假 embed：文本长度打进首维，确定性、无模型依赖。
function fakeEmbedTexts(texts) {
  return Promise.resolve(texts.map((text) => {
    const vector = new Array(MIN_VECTOR_DIMENSIONS).fill(0);
    vector[0] = 1 + (String(text).length % 7);
    return vector;
  }));
}

async function withReconciler(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-integrity-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  store.init();
  const vectorDbPath = join(dir, 'nodes.lance');
  const reconciler = createDerivedIndexReconciler({
    vectorDbPath,
    getStore: () => store,
    getVectorConfig: () => ({ batchSize: 4, dimensions: MIN_VECTOR_DIMENSIONS }),
    isVectorModuleEnabled: () => true,
    embedTexts: fakeEmbedTexts
  });
  try {
    await fn(reconciler, store, vectorDbPath);
  } finally {
    reconciler.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('完整性检验：缺失补嵌、正文变更删旧重嵌、删除残留清理；不通过不开放检索', async () => {
  await withReconciler(async (reconciler, store) => {
    const doc = store.createDoc({ title: 'Integrity', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'alpha' });
    const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'beta' });
    const c = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'gamma' });
    void a;

    // 未建向量 → 未就绪。
    await assert.rejects(() => reconciler.requireDocVectorIndex(doc.id), /未就绪/);

    const first = await reconciler.ensureDocVectors(doc.id);
    assert.equal(first.ok, true);
    assert.equal(first.missingInserted, 4, 'root + 3 子节点全部补嵌');
    assert.equal(first.changedDeleted, 0);
    assert.equal(first.staleDeleted, 0);
    assert.equal(first.vectorCountAfter, 4);
    assert.ok(await reconciler.requireDocVectorIndex(doc.id), '完整 → 就绪');

    // 主数据漂移（模拟编辑保存落主干后、向量未同步的状态）：b 改正文、c 删除。
    store.updateNode(b.id, { text: 'beta-2' });
    store.deleteNodeSubtree(c.id);

    await assert.rejects(
      () => reconciler.requireDocVectorIndex(doc.id),
      /正文已变更 1、残留 1/,
      '陈旧/残留 → 不开放语义检索'
    );

    const second = await reconciler.ensureDocVectors(doc.id);
    assert.equal(second.existingCurrent, 2, 'root 与 a 未动不重算');
    assert.equal(second.changedDeleted, 1, 'b 删旧重嵌');
    assert.equal(second.missingInserted, 0);
    assert.equal(second.staleDeleted, 1, 'c 残留清理');
    assert.equal(second.vectorCountAfter, 3);
    assert.ok(await reconciler.requireDocVectorIndex(doc.id), '检验补齐后恢复就绪');
  });
});

test('完整性检验幂等：再跑一遍全部 existingCurrent，不重复 embed', async () => {
  await withReconciler(async (reconciler, store) => {
    const doc = store.createDoc({ title: 'Idempotent', rootText: '根' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'alpha' });
    await reconciler.ensureDocVectors(doc.id);

    const again = await reconciler.ensureDocVectors(doc.id);
    assert.equal(again.missingInserted, 0);
    assert.equal(again.changedDeleted, 0);
    assert.equal(again.staleDeleted, 0);
    assert.equal(again.existingCurrent, 2);
  });
});

test('编辑落主干的向量陈旧清理：deleteVectorsForNodes 只删指定行，未建向量时 no-op', async () => {
  await withReconciler(async (reconciler, store) => {
    const doc = store.createDoc({ title: 'StaleSweep', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'alpha' });
    const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'beta' });

    // 未建向量：删除是 no-op，不报错。
    const noop = await reconciler.deleteVectorsForNodes(doc.id, [a.id]);
    assert.equal(noop.deleted, 0);

    await reconciler.ensureDocVectors(doc.id);
    const swept = await reconciler.deleteVectorsForNodes(doc.id, [a.id]);
    assert.equal(swept.deleted, 1);

    // 清理后该文档只剩缺失（a），不存在陈旧行 → 检验补回即就绪。
    await assert.rejects(() => reconciler.requireDocVectorIndex(doc.id), /缺失 1、正文已变更 0、残留 0/);
    const repaired = await reconciler.ensureDocVectors(doc.id);
    assert.equal(repaired.missingInserted, 1);
    assert.ok(await reconciler.requireDocVectorIndex(doc.id));
    void b;
  });
});

test('BM25 增量同步：改行替换、删行清理，其余行不动', async () => {
  await withReconciler(async (reconciler, store, vectorDbPath) => {
    const doc = store.createDoc({ title: 'KwInc', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '苹果园' });
    const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '香蕉树' });
    await reconciler.rebuildKeywordIndexForDoc(doc.id);

    // 主数据已变（模拟保存落主干）：a 改正文、b 删除。
    store.updateNode(a.id, { text: '梨子林' });
    store.deleteNodeSubtree(b.id);
    const result = await reconciler.updateKeywordForNodes(doc.id, [a.id], [b.id]);
    assert.equal(result.upserted, 1);
    assert.equal(result.deleted, 1);

    const probe = new KeywordStore(vectorDbPath);
    await probe.init();
    try {
      const rows = await probe.indexedRowsForDoc(doc.id, 10);
      const ids = rows.map((row) => String(row.id)).sort();
      assert.deepEqual(ids, [String(doc.rootNodeId), String(a.id)].sort(), 'b 的行已删、root 与 a 仍在');
    } finally {
      probe.close();
    }
  });
});
