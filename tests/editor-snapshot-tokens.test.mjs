import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../dist/src/backend/store/index.js';

// 编辑器 undo token 的对象库化：token 只持 commit 行同形引用（root_tree_hash/source_hash/meta），
// 快照本体进内容寻址对象库——不再全量 JS 快照驻内存。restore 与恢复历史 commit 同路径。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-editor-token-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const contentState = (store, docId) => store.db.prepare(
  'SELECT id, parent_id, sort_order, text, node_type, node_title, node_note, trust_level FROM nodes WHERE doc_id = ? ORDER BY id'
).all(docId);

const objectCount = (store) => store.db.prepare('SELECT COUNT(*) AS n FROM objects').get().n;

function buildDoc(store) {
  const doc = store.createDoc({ title: 'T', rootText: '根' });
  const a = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'a' });
  const a1 = store.insertNode({ docId: doc.id, parentId: a.id, text: 'a1' });
  const b = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'b' });
  return { doc, a, a1, b };
}

test('capture→改（内容+结构）→restore 回到快照时刻；restore 给出可用的反向 token', async () => {
  await withStore(async (store) => {
    const { doc, a, a1, b } = buildDoc(store);
    store.addAxiom({ docId: doc.id, content: '公理一' });
    const before = contentState(store, doc.id);

    const token = store.editorSnapshots.create(doc.id);
    assert.match(token.id, /^editor-/);

    store.updateNode(a.id, { text: 'a-改' });
    store.moveNodeToParent({ nodeId: a1.id, newParentId: b.id });
    store.deleteNodeSubtree(b.id); // 连带删 a1
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: 'c' });
    const after = contentState(store, doc.id);
    assert.notDeepEqual(after, before, '健全性：确实改了');

    const redoToken = store.editorSnapshots.restore({ docId: doc.id, tokenId: token.id });
    assert.deepEqual(contentState(store, doc.id), before, 'undo 回到快照时刻（内容+结构）');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM axioms WHERE doc_id = ?').get(doc.id).n, 1, '公理跟随快照');

    // 反向 token = redo：恢复到 restore 前的状态。
    store.editorSnapshots.restore({ docId: doc.id, tokenId: redoToken.id });
    assert.deepEqual(contentState(store, doc.id), after, 'redo 回到改动后状态');
  });
});

test('token 不驻全量快照：entry 只持对象库引用，无 nodes 数组', async () => {
  await withStore(async (store) => {
    const { doc } = buildDoc(store);
    const token = store.editorSnapshots.create(doc.id);
    const entry = store.editorSnapshots.tokens?.get?.(token.id)
      ?? [...(store.editorSnapshots['tokens'] || new Map()).values()][0];
    assert.ok(entry.row.root_tree_hash, 'entry 持 root_tree_hash 引用');
    assert.equal(entry.snapshot, undefined, '不再驻留全量 snapshot 对象');
    assert.equal(entry.row.nodes, undefined, '行引用里没有 nodes 数组');
  });
});

test('增量剪枝确凿：连续 capture 之间只改一个节点，第二次只新增改动路径的对象', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Inc', rootText: '根' });
    let parent = doc.rootNodeId;
    // 深链 20 层 + 每层一个旁支叶子：改最深叶子只应重写「叶→根」路径，旁支全部剪枝。
    for (let i = 0; i < 20; i += 1) {
      store.insertNode({ docId: doc.id, parentId: parent, text: `side-${i}` });
      parent = store.insertNode({ docId: doc.id, parentId: parent, text: `chain-${i}` }).id;
    }
    store.editorSnapshots.create(doc.id);
    const baseline = objectCount(store);

    store.updateNode(parent, { text: 'chain-19-改' });
    store.editorSnapshots.create(doc.id);
    const grown = objectCount(store) - baseline;
    // 改动路径 = 1 个新 blob + 21 个新 tree（叶到根）；旁支若未剪枝会再写 ~40 个对象。
    assert.ok(grown > 0 && grown <= 25, `第二次 capture 只写改动路径的对象（实测新增 ${grown}）`);
  });
});

test('gc 不删活 token 的对象；gc 后列缓存作废但 token 仍可恢复', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDoc(store);
    const before = contentState(store, doc.id);
    const token = store.editorSnapshots.create(doc.id);

    // 大改 + 落一个 commit（token 的对象不被该 commit 引用 → 只靠 liveRoots 保活）。
    store.updateNode(a.id, { text: 'a-新' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v-新', owner: 'human' });

    store.gcHistoryObjects();
    const cached = store.db.prepare(
      'SELECT COUNT(*) AS n FROM nodes WHERE doc_id = ? AND tree_object_hash IS NOT NULL'
    ).get(doc.id).n;
    assert.equal(cached, 0, 'gc 后 tree_object_hash 列全部作废');

    store.editorSnapshots.restore({ docId: doc.id, tokenId: token.id });
    assert.deepEqual(contentState(store, doc.id), before, 'gc 之后活 token 仍可恢复');
  });
});

test('discard 后 token 独占对象成孤儿、可被 gc 回收', async () => {
  await withStore(async (store) => {
    const { doc, a } = buildDoc(store);
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v1', owner: 'human' });
    store.updateNode(a.id, { text: 'a-临时' });
    const token = store.editorSnapshots.create(doc.id); // 引用 v1 后的临时态，不被任何 commit 引用
    store.updateNode(a.id, { text: 'a-终' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v2', owner: 'human' });

    const keptAlive = store.gcHistoryObjects();
    assert.equal(keptAlive.deleted, 0, '活 token 引用的临时态对象不被回收');

    store.editorSnapshots.discard([token.id]);
    const swept = store.gcHistoryObjects();
    assert.ok(swept.deleted > 0, 'discard 后临时态独占对象被回收');
  });
});

test('空文档拒绝 capture（与旧行为一致）', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'E', rootText: '根' });
    store.db.prepare('DELETE FROM nodes WHERE doc_id = ?').run(doc.id);
    assert.throws(
      () => store.editorSnapshots.create(doc.id),
      /incomplete document snapshot/
    );
  });
});

test('undo token 跨拆句边界保真：restore 回 token 时刻的句位归属', async () => {
  await withStore(async (store) => {
    // 一篇「导入后未拆句」的文档：三句 span 全挂段落容器 P（source_position 带 .5 半步偏移）。
    const doc = store.createDoc({ title: '原文', rootText: '根' });
    const paragraph = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '甲句。乙句。丙句。' });
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
    const ownership = () => store.db.prepare(
      'SELECT sentence_index, node_id FROM source_spans WHERE doc_id = ? ORDER BY sentence_index'
    ).all(doc.id).map((row) => [Number(row.sentence_index), row.node_id ?? null]);

    const beforeSplit = ownership();
    const token = store.editorSnapshots.create(doc.id);
    assert.equal(store.splitNodeIntoChildren(paragraph.id), true);
    const afterSplit = ownership();
    assert.notDeepEqual(afterSplit, beforeSplit);

    // undo：回到 token 时刻，span 应挂回段落 P（旧实现这里会全变 NULL）。
    const redoToken = store.editorSnapshots.restore({ docId: doc.id, tokenId: token.id });
    assert.deepEqual(ownership(), beforeSplit, 'undo 后归属应回到拆句前');

    // redo：回到拆句后，span 应精确回到三个句子节点。
    store.editorSnapshots.restore({ docId: doc.id, tokenId: redoToken.id });
    assert.deepEqual(ownership(), afterSplit, 'redo 后归属应回到拆句后');
  });
});

test('活 token 的 spanmap 对象不被 gc 回收', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'S', rootText: '根' });
    const paragraph = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '甲句。乙句。' });
    store.saveSourceDocument({
      docId: doc.id,
      sourcePath: 'y.md',
      sourceType: 'md',
      rawMarkdown: '甲句。乙句。',
      spans: [
        { sentence_index: 1, start_offset: 0, end_offset: 3, text: '甲句。' },
        { sentence_index: 2, start_offset: 3, end_offset: 6, text: '乙句。' }
      ],
      nodeIdsBySentenceIndex: new Map([[1, paragraph.id], [2, paragraph.id]])
    });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v1', owner: 'human' });

    // token 抓在「归属已变、还没提交」的临时态：它的 spanmap 不被任何 commit 引用，
    // 只能靠 liveRoots().spanMapHashes 保活。漏了的话 token 一 restore 就静默丢归属。
    store.db.prepare('UPDATE source_spans SET node_id = NULL WHERE doc_id = ? AND sentence_index = 2').run(doc.id);
    const token = store.editorSnapshots.create(doc.id);

    store.db.prepare('UPDATE source_spans SET node_id = ? WHERE doc_id = ? AND sentence_index = 2').run(paragraph.id, doc.id);
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v2', owner: 'human' });

    const spanMapsBefore = store.db.prepare("SELECT COUNT(*) AS n FROM objects WHERE kind = 'spanmap'").get().n;
    store.gcHistoryObjects();
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM objects WHERE kind = 'spanmap'").get().n,
      spanMapsBefore,
      '活 token 的 spanmap 不该被 sweep'
    );
    store.editorSnapshots.restore({ docId: doc.id, tokenId: token.id });
    assert.equal(
      store.db.prepare('SELECT node_id FROM source_spans WHERE doc_id = ? AND sentence_index = 2').get(doc.id).node_id,
      null,
      'token restore 后应回到「第 2 句是孤儿」的那一刻'
    );
  });
});
