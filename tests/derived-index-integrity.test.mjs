import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../src/backend/store/index.mjs';
import { createDerivedIndexReconciler } from '../src/backend/derived-index-reconciler.mjs';
import { VectorStore } from '../src/vector/vector-store.mjs';
import { MIN_VECTOR_DIMENSIONS } from '../src/vector/embeddings.mjs';
import { computeSubtreeHashes } from '../src/core/merkle.mjs';

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

async function withReconciler(fn, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-integrity-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  store.init();
  const lanceDbPath = join(dir, 'nodes.lance');
  const reconciler = createDerivedIndexReconciler({
    lanceDbPath,
    getStore: () => store,
    // maxInputTokens/countTokens 默认空 → 守卫关闭（现有测试不受影响）。
    getVectorConfig: () => ({ batchSize: 4, dimensions: MIN_VECTOR_DIMENSIONS, maxInputTokens: opts.maxInputTokens || 0 }),
    isVectorModuleEnabled: () => true,
    embedTexts: opts.embedTexts || fakeEmbedTexts,
    countTokens: opts.countTokens
  });
  try {
    await fn(reconciler, store, lanceDbPath);
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

    const first = await reconciler.reconcile(doc.id, { fillNow: true });
    assert.equal(first.pendingCount, 4, 'root + 3 子节点全部待补');
    assert.equal(first.filled, 4, '全部 embed');
    assert.equal(first.ready, true);
    assert.ok(await reconciler.requireDocVectorIndex(doc.id), '完整 → 就绪');

    // 主数据漂移（模拟编辑保存落主干后、向量未同步的状态）：b 改正文、c 删除。
    store.updateNode(b.id, { text: 'beta-2' });
    store.deleteNodeSubtree(c.id);

    await assert.rejects(
      () => reconciler.requireDocVectorIndex(doc.id),
      /待补 1、残留 1/,
      '陈旧/残留 → 不开放语义检索'
    );

    const second = await reconciler.reconcile(doc.id, { fillNow: true });
    assert.equal(second.filled, 1, 'b 正文变更 → 重嵌');
    assert.equal(second.deleted, 1, 'c 删除 → 孤儿清理');
    assert.equal(second.pendingCount, 1, '仅 b 待补（root/a 剪枝未动）');
    assert.ok(await reconciler.requireDocVectorIndex(doc.id), '补齐后恢复就绪');
  });
});

test('reconcile 幂等：没改动再跑零待补、零删除', async () => {
  await withReconciler(async (reconciler, store) => {
    const doc = store.createDoc({ title: 'Idempotent', rootText: '根' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'alpha' });
    await reconciler.reconcile(doc.id, { fillNow: true });

    const again = await reconciler.reconcile(doc.id, { fillNow: true });
    assert.equal(again.pendingCount, 0);
    assert.equal(again.filled, 0);
    assert.equal(again.deleted, 0);
  });
});

test('reconcile pull 自对账 + subtree 剪枝：改深层节点只 embed 它，未变兄弟子树整棵剪掉不对账', async () => {
  await withReconciler(async (reconciler, store) => {
    const doc = store.createDoc({ title: 'Prune', rootText: '根' });
    const A = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'alpha' });
    const A1 = store.insertNode({ docId: doc.id, parentId: A.id, text: 'alpha-1' });
    const A2 = store.insertNode({ docId: doc.id, parentId: A.id, text: 'alpha-2' });
    const B = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'beta' });
    const B1 = store.insertNode({ docId: doc.id, parentId: B.id, text: 'beta-1' });
    const B2 = store.insertNode({ docId: doc.id, parentId: B.id, text: 'beta-2' });

    // 首次对账：全树 7 个正文节点（root + 6）都待补、都 embed。
    const first = await reconciler.reconcile(doc.id, { fillNow: true });
    assert.equal(first.pendingCount, 7, 'root + 6 子全待补');
    assert.equal(first.filled, 7);
    assert.equal(first.ready, true);

    // 再跑一遍：subtree_hash 全匹配 → 全剪、零待补（幂等）。
    const idempotent = await reconciler.reconcile(doc.id, { fillNow: true });
    assert.equal(idempotent.pendingCount, 0, '没改动 → 零待补');
    assert.equal(idempotent.deleted, 0);

    // 改 B 分支深层一个节点；spy hashesByNodeIds 记录被对账（下行）的节点。
    store.updateNode(B1.id, { text: 'beta-1-改' });
    const queried = [];
    const original = VectorStore.prototype.hashesByNodeIds;
    VectorStore.prototype.hashesByNodeIds = async function spy(ids) {
      for (const nodeId of ids) queried.push(String(nodeId));
      return original.call(this, ids);
    };
    let second;
    try {
      second = await reconciler.reconcile(doc.id, { fillNow: true });
    } finally {
      VectorStore.prototype.hashesByNodeIds = original;
    }

    assert.equal(second.pendingCount, 1, '只 B1 待补');
    assert.equal(second.filled, 1, '只 embed B1，未变节点不重嵌');
    // A 分支 subtree_hash 未变 → 整棵剪掉，A1/A2 从未被对账查询。
    assert.ok(!queried.includes(String(A1.id)), 'A1 被剪枝、未对账');
    assert.ok(!queried.includes(String(A2.id)), 'A2 被剪枝、未对账');
    // 变化路径（root→B→B1）上的节点被下行对账到。
    assert.ok(queried.includes(String(B1.id)), 'B1 在变化路径、被对账');

    // 删 B2：孤儿（lance 有 SQL 无）按差集清理。
    store.deleteNodeSubtree(B2.id);
    const third = await reconciler.reconcile(doc.id, { fillNow: true });
    assert.equal(third.deleted, 1, 'B2 向量作为孤儿删除');
  });
});

test('reconcile 非 fillNow：正文变更删旧向量（陈旧清成缺失，不留旧 embedding）', async () => {
  await withReconciler(async (reconciler, store) => {
    const doc = store.createDoc({ title: 'StaleDrop', rootText: '根' });
    const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'alpha' });
    await reconciler.reconcile(doc.id, { fillNow: true });
    assert.ok(await reconciler.requireDocVectorIndex(doc.id), '建好 → 就绪');

    // a 改正文后只发 fillNow:false（保存路径口径）：旧向量删、不重嵌。
    store.updateNode(a.id, { text: 'alpha-改' });
    const defer = await reconciler.reconcile(doc.id, { fillNow: false });
    assert.equal(defer.filled, 0, 'fillNow:false 不重嵌');
    assert.equal(defer.deleted, 1, 'a 的陈旧旧向量被删');
    assert.equal(defer.pendingCount, 1, 'a 记为待补');
    assert.equal(defer.ready, false, '有待补 → 未就绪');

    // 陈旧已清成「缺失」：completeness 闸报「待补 1、残留 0」（不是残留的陈旧行）。
    await assert.rejects(() => reconciler.requireDocVectorIndex(doc.id), /待补 1、残留 0/);

    // fillNow 补回即就绪。
    const filled = await reconciler.reconcile(doc.id, { fillNow: true });
    assert.equal(filled.filled, 1, 'a 重嵌');
    assert.ok(await reconciler.requireDocVectorIndex(doc.id), '补回 → 就绪');
  });
});

test('嵌入对象 = 标题+正文+备注（第 2 步）', async () => {
  const captured = [];
  const capturingEmbed = (texts) => { captured.push(...texts); return fakeEmbedTexts(texts); };
  await withReconciler(async (reconciler, store) => {
    const doc = store.createDoc({ title: 'EmbedInput', rootText: '根' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '正文X', nodeTitle: '标题Y', nodeNote: '备注Z' });
    await reconciler.reconcile(doc.id, { fillNow: true });
    const embedded = captured.find((t) => t.includes('正文X'));
    assert.ok(embedded, '该节点被嵌入');
    assert.ok(
      embedded.includes('标题Y') && embedded.includes('正文X') && embedded.includes('备注Z'),
      `嵌入串应含标题+正文+备注，实得：${JSON.stringify(embedded)}`
    );
  }, { embedTexts: capturingEmbed });
});

test('超长守卫：超模型窗口的节点跳过 + 回执列出，整批其余照嵌（第 2 步）', async () => {
  // 字数当 token 数 stub + 窗口 5：短节点嵌、长节点跳。
  const countTokens = async (text) => String(text).length;
  await withReconciler(async (reconciler, store) => {
    const doc = store.createDoc({ title: 'Guard', rootText: '根' }); // '根' 1<=5 嵌
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'abc' }); // 3<=5 嵌
    const longN = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '这是一个明显超过窗口的长正文' }); // >5 跳

    const res = await reconciler.reconcile(doc.id, { fillNow: true });
    assert.equal(res.skippedCount, 1, '一个超长节点被跳过');
    assert.equal(String(res.skippedNodes[0].id), String(longN.id), '跳过的是长节点');
    assert.ok(res.skippedNodes[0].tokens > 5, '记录其 token 数');
    assert.equal(res.filled, 2, '根 + 短节点照嵌（整批未被超长中断）');
    assert.equal(res.ready, true, '超长 skipped 不计入应嵌 → 其余嵌齐即就绪（报告引导拆分、非硬阻断）');
  }, { maxInputTokens: 5, countTokens });
});

test('超长守卫关闭（无 countTokens）则一律嵌、无 skipped（第 2 步）', async () => {
  await withReconciler(async (reconciler, store) => {
    const doc = store.createDoc({ title: 'NoGuard', rootText: '根' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '这是一个明显超过窗口的长正文' });
    const res = await reconciler.reconcile(doc.id, { fillNow: true });
    assert.equal(res.skippedCount, 0, '守卫关闭：不跳任何节点');
    assert.equal(res.filled, 2, '根 + 长节点都嵌');
  }); // 不传 maxInputTokens/countTokens → 守卫关闭
});

test('哈希同口径：整篇 reconcile 写进 lance 的 contentHash/subtreeHash == 整篇 SQL 现算（非空，防「只取批内节点算空哈希」回归）', async () => {
  await withReconciler(async (reconciler, store) => {
    // 多层嵌套 root → A → A1 → A2：覆盖非 root 的中间节点与深层叶（review 报告里被算空哈希的正是这些非 root 节点）。
    const doc = store.createDoc({ title: 'HashParity', rootText: '根' });
    const A = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'alpha' });
    const A1 = store.insertNode({ docId: doc.id, parentId: A.id, text: 'alpha-1' });
    const A2 = store.insertNode({ docId: doc.id, parentId: A1.id, text: 'alpha-1-1' });

    // 捕获 reconcile 实际写进 lance 的哈希。
    const written = new Map();
    const originalUpsert = VectorStore.prototype.upsertNodeVectors;
    VectorStore.prototype.upsertNodeVectors = async function spy(rows) {
      for (const row of rows) written.set(String(row.nodeId), { contentHash: row.contentHash, subtreeHash: row.subtreeHash });
      return originalUpsert.call(this, rows);
    };
    try {
      const res = await reconciler.reconcile(doc.id, { fillNow: true });
      assert.equal(res.filled, 4, 'root + 3 子节点全嵌');
    } finally {
      VectorStore.prototype.upsertNodeVectors = originalUpsert;
    }

    // 期望口径：整篇 doc 全节点（含 parent_id=null 的 root）现算 Merkle 指纹——刻意用「整篇」，不跟 reconcile 的实现走。
    // 若哪天 reconcile 退回「只取批内节点（无 root）」算哈希，computeSubtreeHashes 会得空 Map、写进 lance 的哈希变空串，
    // 下面「非空」与「逐位相等」的断言即失败，把这次 review 暴露的根因钉死。
    const rows = store.db.prepare(
      'SELECT id, parent_id, sort_order, text, node_title, node_note, node_type, trust_level FROM nodes WHERE doc_id = ?'
    ).all(doc.id);
    const expected = computeSubtreeHashes(rows);

    assert.equal(written.size, 4, 'root + 3 子节点都写了向量行');
    for (const [nodeId, lance] of written) {
      const want = expected.get(nodeId);
      assert.ok(want, `整篇现算应含节点 ${nodeId}`);
      assert.ok(lance.contentHash && lance.contentHash.length > 0, `节点 ${nodeId} 写进 lance 的 contentHash 不应为空`);
      assert.ok(lance.subtreeHash && lance.subtreeHash.length > 0, `节点 ${nodeId} 写进 lance 的 subtreeHash 不应为空`);
      assert.equal(lance.contentHash, want.contentHash, `节点 ${nodeId} contentHash 应等于整篇 SQL 现算`);
      assert.equal(lance.subtreeHash, want.subtreeHash, `节点 ${nodeId} subtreeHash 应等于整篇 SQL 现算`);
    }
    // 非 root 的中间/深层节点（review 报告里恰是被算空哈希的）也确在写入集里。
    assert.ok(written.has(String(A1.id)) && written.has(String(A2.id)), '非 root 的中间/深层节点都在写入集里');
  });
});
