import '../_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

// 用带领域端口的 store：编辑分支 stage/merge 要经 store-domain-adapter 接上投影与 diff 端口，
// 裸 IftreeStore 一进 stage 就抛「edit-branch port is not configured」。
import { createConfiguredIftreeStore } from '../../dist/src/backend/store-domain-adapter.js';

// 句位归属（span→node + nodes.source_position）进 commit 对象库后的往返保真回归。
//
// 修的是什么：restoreSnapshot 早先只复原「恢复前 live 的链接里、节点仍在快照中的那部分」——
// 导入（span 挂段落 P）→ commit A → 拆句（span 重挂到新建子节点 c）→ commit B → restore 回 A，
// 因为 c 不在 A 的快照里，span 的 node_id 就永久变 NULL；redo 回 B 同样丢，因为「B 时代的 s→c」
// 从来没被存下来过。现在每个 commit 带自己的 span_map_hash，restore/undo/redo 到任意带该指针的
// commit 都精确还原那个时代的归属。
//
// 旧 commit（span_map_hash 为 NULL）刻意不做兼容重挂：保持现行行为，见最后两个用例。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-spanmap-'));
  const store = createConfiguredIftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// 当前归属快照：sentence_index → node_id（NULL 保留成 null，才能区分「挂着」和「孤儿」）。
const ownership = (store, docId) => store.db.prepare(
  'SELECT sentence_index, node_id FROM source_spans WHERE doc_id = ? ORDER BY sentence_index'
).all(docId).map((row) => [Number(row.sentence_index), row.node_id ?? null]);

const positions = (store, docId) => store.db.prepare(
  'SELECT id, source_position FROM nodes WHERE doc_id = ? ORDER BY id'
).all(docId).map((row) => [String(row.id), row.source_position == null ? null : Number(row.source_position)]);

const objectCount = (store, kind) => store.db.prepare(
  'SELECT COUNT(*) AS n FROM objects WHERE kind = ?'
).get(kind).n;

const headCommitId = (store, docId) => store.db.prepare(
  'SELECT head_commit_id FROM doc_heads WHERE doc_id = ?'
).get(docId).head_commit_id;

// 一篇「导入后未拆句」的文档：章节节点 + 一个段落容器 P（source_position 带 .5 半步偏移），
// 三句 span 全挂 P。这正是 splitSourceParagraphsIntoSentenceChildren 的输入形态。
function buildImportedDoc(store) {
  const doc = store.createDoc({ title: '原文', rootText: '根' });
  const chapter = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '第一章' });
  const paragraph = store.insertNode({ docId: doc.id, parentId: chapter.id, text: '甲句。乙句。丙句。' });
  store.db.prepare('UPDATE nodes SET source_position = ? WHERE id = ?').run(1, chapter.id);
  store.db.prepare('UPDATE nodes SET source_position = ? WHERE id = ?').run(1.5, paragraph.id);
  store.saveSourceDocument({
    docId: doc.id,
    sourcePath: 'x.md',
    sourceType: 'md',
    rawMarkdown: '甲句。乙句。丙句。',
    spans: [
      { sentence_index: 1, start_offset: 0, end_offset: 3, text: '甲句。' },
      { sentence_index: 2, start_offset: 3, end_offset: 6, text: '乙句。' },
      { sentence_index: 3, start_offset: 6, end_offset: 9, text: '丙句。' }
    ],
    nodeIdsBySentenceIndex: new Map([[1, paragraph.id], [2, paragraph.id], [3, paragraph.id]])
  });
  return { doc, chapter, paragraph };
}

test('restore 回拆句前：span 挂回段落节点，不再变孤儿', async () => {
  await withStore(async (store) => {
    const { doc, paragraph } = buildImportedDoc(store);
    const beforeSplit = ownership(store, doc.id);
    assert.deepEqual(beforeSplit, [[1, paragraph.id], [2, paragraph.id], [3, paragraph.id]]);
    const commitA = store.saveHistorySnapshot({ docId: doc.id, summary: 'A 导入' });

    // 拆句：span 从段落 P 重挂到新建的三个句子子节点。
    assert.equal(store.splitNodeIntoChildren(paragraph.id), true);
    const afterSplit = ownership(store, doc.id);
    assert.equal(new Set(afterSplit.map(([, nodeId]) => nodeId)).size, 3, '拆句后三句应各挂各的子节点');
    assert.ok(afterSplit.every(([, nodeId]) => nodeId !== null && nodeId !== paragraph.id));
    store.saveHistorySnapshot({ docId: doc.id, summary: 'B 拆句' });

    store.restoreCommit(commitA.commit_id);
    assert.deepEqual(ownership(store, doc.id), beforeSplit, 'restore 回 A 后归属应精确回到段落节点');
  });
});

test('redo 回拆句后：span 精确回到各自的句子节点', async () => {
  await withStore(async (store) => {
    const { doc, paragraph } = buildImportedDoc(store);
    const commitA = store.saveHistorySnapshot({ docId: doc.id, summary: 'A 导入' });
    store.splitNodeIntoChildren(paragraph.id);
    const afterSplit = ownership(store, doc.id);
    const commitB = store.saveHistorySnapshot({ docId: doc.id, summary: 'B 拆句' });

    store.restoreCommit(commitA.commit_id);
    store.restoreCommit(commitB.commit_id);
    assert.deepEqual(ownership(store, doc.id), afterSplit, 'redo 回 B 后归属应精确回到三个句子节点');
  });
});

test('nodes.source_position 随 spanmap 一并往返（半步偏移不再丢）', async () => {
  await withStore(async (store) => {
    const { doc, paragraph } = buildImportedDoc(store);
    const before = positions(store, doc.id);
    assert.ok(before.some(([id, position]) => id === paragraph.id && position === 1.5), '段落容器应带 .5 半步偏移');
    const commitA = store.saveHistorySnapshot({ docId: doc.id, summary: 'A' });

    store.updateNode(paragraph.id, { text: '改过的段落' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'B' });

    store.restoreCommit(commitA.commit_id);
    assert.deepEqual(positions(store, doc.id), before, 'restore 后 source_position 应逐节点还原，而不是全 NULL');
  });
});

test('多轮 A→B→A→B 往返幂等；归属不变的 commit 复用同一个 spanmap 对象', async () => {
  await withStore(async (store) => {
    const { doc, paragraph } = buildImportedDoc(store);
    const commitA = store.saveHistorySnapshot({ docId: doc.id, summary: 'A' });
    const stateA = ownership(store, doc.id);
    store.splitNodeIntoChildren(paragraph.id);
    const commitB = store.saveHistorySnapshot({ docId: doc.id, summary: 'B' });
    const stateB = ownership(store, doc.id);

    for (let round = 0; round < 2; round += 1) {
      store.restoreCommit(commitA.commit_id);
      assert.deepEqual(ownership(store, doc.id), stateA, `第 ${round + 1} 轮回 A`);
      store.restoreCommit(commitB.commit_id);
      assert.deepEqual(ownership(store, doc.id), stateB, `第 ${round + 1} 轮回 B`);
    }

    // 归属只变过一次（拆句），故 spanmap 对象只该有两份——A 时代一份、B 时代一份。
    // 这条守的是内容寻址去重：若每次 commit 都新写一份，几十万 span 的文档会把对象库撑爆。
    assert.equal(objectCount(store, 'spanmap'), 2, 'spanmap 应按内容去重，只存 A/B 两个时代各一份');

    // 归属没动的保存不产生新 spanmap 对象（docs.span_map_dirty 脏位命中缓存、零重算）。
    store.updateNode(paragraph.id, { nodeTitle: '只改标题' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'C 只改标题' });
    assert.equal(objectCount(store, 'spanmap'), 2, '只改正文/标题不该新增 spanmap 对象');
  });
});

test('该版本删掉的节点：其 span 置 NULL，不因外键炸掉 restore', async () => {
  await withStore(async (store) => {
    const { doc, chapter, paragraph } = buildImportedDoc(store);
    store.splitNodeIntoChildren(paragraph.id);
    const commitB = store.saveHistorySnapshot({ docId: doc.id, summary: 'B 拆句' });

    // 整章删掉（连带段落与三个句子节点），再存一版。
    store.deleteNodeSubtree(chapter.id);
    const commitC = store.saveHistorySnapshot({ docId: doc.id, summary: 'C 删章' });
    assert.deepEqual(ownership(store, doc.id), [[1, null], [2, null], [3, null]], '节点没了，span 应为孤儿');

    // 回到 B：节点回来了，归属也该回来。（restore 是 reset 语义，head 随之移回 B——
    // C 的 commit id 必须在这之前就拿好，事后读 doc_heads 只会拿到 B。）
    store.restoreCommit(commitB.commit_id);
    assert.equal(ownership(store, doc.id).filter(([, nodeId]) => nodeId !== null).length, 3);

    // 再回到 C：归属重新全 NULL，且不抛外键错。
    store.restoreCommit(commitC.commit_id);
    assert.deepEqual(ownership(store, doc.id), [[1, null], [2, null], [3, null]]);
  });
});

test('sentence_index 有空洞时走 sparse 布局，往返一致', async () => {
  await withStore(async (store) => {
    const { doc, paragraph } = buildImportedDoc(store);
    // 制造空洞：删掉中间那句 span（密集 1..N 退化）。
    store.db.prepare('DELETE FROM source_spans WHERE doc_id = ? AND sentence_index = ?').run(doc.id, 2);
    const sparseState = ownership(store, doc.id);
    assert.deepEqual(sparseState.map(([index]) => index), [1, 3]);
    const commitA = store.saveHistorySnapshot({ docId: doc.id, summary: 'A 稀疏' });

    const row = store.db.prepare('SELECT span_map_hash FROM commits WHERE id = ?').get(commitA.commit_id);
    const object = JSON.parse(store.db.prepare('SELECT data FROM objects WHERE hash = ?').get(row.span_map_hash).data);
    assert.equal(object.layout, 'sparse', '不连续的 sentence_index 应落成 sparse 布局');

    store.splitNodeIntoChildren(paragraph.id);
    store.saveHistorySnapshot({ docId: doc.id, summary: 'B' });
    store.restoreCommit(commitA.commit_id);
    assert.deepEqual(ownership(store, doc.id), sparseState);
  });
});

test('旧 commit（span_map_hash 为 NULL）退回现行行为，不做兼容重挂', async () => {
  await withStore(async (store) => {
    const { doc, paragraph } = buildImportedDoc(store);
    const commitA = store.saveHistorySnapshot({ docId: doc.id, summary: 'A' });
    // 模拟本机制之前写下的 commit 行：抹掉归属指针。
    store.db.prepare('UPDATE commits SET span_map_hash = NULL WHERE id = ?').run(commitA.commit_id);

    store.splitNodeIntoChildren(paragraph.id);
    store.saveHistorySnapshot({ docId: doc.id, summary: 'B 拆句' });

    store.restoreCommit(commitA.commit_id);
    // 旧库不兼容、不修复：句子节点不在 A 的快照里，其 span 就留 NULL（不沿父链重挂回 P）。
    assert.deepEqual(ownership(store, doc.id), [[1, null], [2, null], [3, null]]);
  });
});

test('revert 不回滚句位归属：走「字段缺失」分支，归属留在当前状态', async () => {
  await withStore(async (store) => {
    const { doc, chapter } = buildImportedDoc(store);
    store.saveHistorySnapshot({ docId: doc.id, summary: 'A' });
    const extra = store.insertNode({ docId: doc.id, parentId: chapter.id, text: '后加的一句' });
    const commitB = store.saveHistorySnapshot({ docId: doc.id, summary: 'B 加节点' });
    const before = ownership(store, doc.id);

    const result = store.revertCommit({ commitId: commitB.commit_id, owner: 'human' });
    assert.equal(result.blocked ?? false, false, 'revert 不该被冲突挡下');
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE id = ?').get(extra.id).n,
      0,
      'revert 应撤掉那次新增'
    );
    assert.deepEqual(ownership(store, doc.id), before, 'revert 只撤节点，句位归属原地不动');
  });
});

test('句位归属不进 diff：只改归属的 commit 报零条目', async () => {
  await withStore(async (store) => {
    const { doc, paragraph } = buildImportedDoc(store);
    const commitA = store.saveHistorySnapshot({ docId: doc.id, summary: 'A' });
    const snapshotA = store.commitSnapshot(commitA.commit_id);

    // 只动归属，一个 nodes 行都不碰。
    store.db.prepare('UPDATE source_spans SET node_id = NULL WHERE doc_id = ? AND sentence_index = 2').run(doc.id);
    const commitB = store.saveHistorySnapshot({ docId: doc.id, summary: 'B' });
    const snapshotB = store.commitSnapshot(commitB.commit_id);

    // 归属与 source_position 都是原文回链/派生量，不是节点生命周期字段——与 computeSnapshotDiff
    // 早就把 source_position 排除在外是同一口径。进 diff 的话一次拆句会在历史里刷出 N 条噪声。
    assert.deepEqual(store.computeDiff(snapshotA, snapshotB), [], '只改句位归属不该产生 diff 条目');
    // 但两个 commit 的归属指针确实不同（改动如实记在 spanmap 侧）。
    const hashOf = (commitId) => store.db.prepare('SELECT span_map_hash FROM commits WHERE id = ?').get(commitId).span_map_hash;
    assert.notEqual(hashOf(commitA.commit_id), hashOf(commitB.commit_id));
    assert.ok(paragraph.id);
  });
});

test('编辑分支里的段落拆句：合并回主干后归属正确，新 commit 带 span_map_hash', async () => {
  await withStore(async (store) => {
    const { doc, paragraph } = buildImportedDoc(store);
    store.saveHistorySnapshot({ docId: doc.id, summary: 'A 导入' });

    const branch = store.beginEditBranch(doc.id, 'human');
    const staged = store.stageEditBranchNodeSplit(branch, { nodeId: paragraph.id });
    assert.equal(staged.changed, true, 'stage 应记下一次段落拆句');
    assert.equal(staged.splitParagraphCount, 1, '应走 source_paragraphs 段落模式');
    const saved = store.saveEditBranch({ branchId: branch.id, owner: 'human' });
    assert.equal(saved.changed, true);

    const links = ownership(store, doc.id);
    assert.equal(new Set(links.map(([, nodeId]) => nodeId)).size, 3, '合并后三句应各挂各的子节点');
    assert.ok(links.every(([, nodeId]) => nodeId !== null && nodeId !== paragraph.id));

    const head = headCommitId(store, doc.id);
    assert.ok(
      store.db.prepare('SELECT span_map_hash FROM commits WHERE id = ?').get(head).span_map_hash,
      '分支提交产生的 commit 也要带归属指针'
    );
  });
});
