import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../src/backend/store/index.mjs';
import { runDatabaseWrite } from '../src/backend/mutation-api.mjs';

// 第 4 步内容寻址历史的 A 层回归：commit 把快照拆进对象库（blob/tree/source）+ 内联 meta，
// restore/重建从对象库展开回来。核心断言是「拆进去再展开 == 原样」（内容 + 结构），外加去重与字段处置。

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-objstore-'));
  const store = new IftreeStore(join(dir, 'store.sqlite'));
  try {
    store.init();
    await fn(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// 内容 + 结构投影（按稳定 id 配对）：不含 address/depth/source_position 这些重建时被覆盖的派生量。
function contentStructure(store, docId) {
  const rows = store.db.prepare(`
    SELECT id, parent_id, sort_order, text, node_type, node_title, node_note, trust_level
    FROM nodes WHERE doc_id = ? ORDER BY id
  `).all(docId);
  return new Map(rows.map((r) => [String(r.id), {
    parent_id: r.parent_id == null ? null : String(r.parent_id),
    sort_order: Number(r.sort_order),
    text: r.text,
    node_type: r.node_type,
    node_title: r.node_title,
    node_note: r.node_note,
    trust_level: r.trust_level ?? null
  }]));
}

function objectCounts(store) {
  const rows = store.db.prepare('SELECT kind, COUNT(*) AS n FROM objects GROUP BY kind').all();
  const out = { blob: 0, tree: 0, source: 0 };
  for (const r of rows) out[r.kind] = r.n;
  return out;
}

test('commit→restore round-trips tree content+structure through the object store', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Demo', rootText: '总目标' });
    const ifNode = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '条件A', nodeType: 'IF', nodeTitle: '甲', trustLevel: '受控' });
    store.insertNode({ docId: doc.id, parentId: ifNode.id, text: '子条件', nodeType: 'TEXT', nodeNote: '备注X' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '动作B', nodeType: 'THEN' });
    store.addAxiom({ docId: doc.id, content: '公理一', nodeTitle: 'A1' });
    store.db.prepare(
      "INSERT INTO source_documents (doc_id, source_type, original_path, raw_markdown) VALUES (?, 'md', '/x.md', ?)"
    ).run(doc.id, '# 总目标\n原文若干句。');

    const c1 = store.saveHistorySnapshot({ docId: doc.id, summary: 'v1', owner: 'human' });
    const stateC1 = contentStructure(store, doc.id);

    // 变更：改正文 + 删一棵子树 + 加新节点，再提交 v2。
    store.updateNode(ifNode.id, { text: '条件A改' });
    store.deleteNodeSubtree(ifNode.id); // 连带删 ifNode + 子条件
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '动作C', nodeType: 'THEN' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v2', owner: 'human' });
    const stateC2 = contentStructure(store, doc.id);
    assert.notDeepEqual([...stateC2.keys()].sort(), [...stateC1.keys()].sort(), '变更后节点集应不同（健全性检查）');

    // 回滚到 v1：内容 + 结构应逐字段等于 v1。
    store.restoreCommit(c1.id);
    const restored = contentStructure(store, doc.id);
    assert.deepEqual(
      [...restored.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      [...stateC1.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      'restore 后内容+结构应与 v1 完全一致'
    );

    // raw_markdown 经 source 对象往返回来。
    const src = store.db.prepare('SELECT raw_markdown FROM source_documents WHERE doc_id = ?').get(doc.id);
    assert.equal(src.raw_markdown, '# 总目标\n原文若干句。', 'raw_markdown 应原样恢复');

    // axiom 经内联 meta 往返回来。
    const axioms = store.listAxioms(doc.id);
    assert.equal(axioms.length, 1);
    assert.equal(axioms[0].content, '公理一');

    // trust_level（content_hash 字段）经 blob 往返回来。
    const restoredIf = [...restored.values()].find((n) => n.text === '条件A');
    assert.equal(restoredIf.trust_level, '受控', 'trust_level 应经 blob 恢复');
  });
});

test('object store dedups: re-committing an unchanged doc adds no objects', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Dedup', rootText: '根' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '叶一', nodeType: 'TEXT' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '叶二', nodeType: 'TEXT' });
    store.db.prepare(
      "INSERT INTO source_documents (doc_id, source_type, raw_markdown) VALUES (?, 'md', ?)"
    ).run(doc.id, '原文');

    store.saveHistorySnapshot({ docId: doc.id, summary: 'v1', owner: 'human' });
    const after1 = objectCounts(store);
    // 3 个节点（根 + 2 叶）内容各异 → 3 blob；source 1。tree 为 4：createDoc 存的初始 commit 有一棵
    // 「根无子」tree，v1 再存「根有 2 叶」+ 叶一 + 叶二 三棵，根的两版 hash 不同（5bf9fc7 建档存初始 commit）。
    assert.equal(after1.blob, 3, '不同内容节点各一 blob');
    assert.equal(after1.tree, 4, '初始 commit 的根 tree + v1 三节点 tree');
    assert.equal(after1.source, 1, 'raw_markdown 一个 source 对象');

    // 文档未变，再提交一次：对象按 hash 去重，objects 不增长。
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v2(无变更)', owner: 'human' });
    assert.deepEqual(objectCounts(store), after1, '内容未变，重提交不应新增任何对象');
  });
});

test('source_position is dropped on restore (truth lives in source_spans), node survives', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Pos', rootText: '根' });
    const n = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '带句位', nodeType: 'TEXT', sourcePosition: 5 });
    assert.equal(store.db.prepare('SELECT source_position FROM nodes WHERE id = ?').get(n.id).source_position, 5);

    const c1 = store.saveHistorySnapshot({ docId: doc.id, summary: 'v1', owner: 'human' });
    store.updateNode(n.id, { text: '带句位改' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v2', owner: 'human' });

    store.restoreCommit(c1.id);
    const row = store.db.prepare('SELECT text, source_position FROM nodes WHERE id = ?').get(n.id);
    assert.equal(row.text, '带句位', '节点正文应恢复');
    assert.equal(row.source_position, null, 'source_position 不进对象库，restore 后为 NULL（路径丙）');
  });
});

test('gc reclaims orphan objects after a commit row is deleted; surviving commits stay restorable', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'GC', rootText: '根' });
    const n = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '叶', nodeType: 'TEXT' });
    const c1 = store.saveHistorySnapshot({ docId: doc.id, summary: 'v1', owner: 'human' });
    // v2 引入只属于 v2 的新内容（独占 blob/tree），删 c2 行后应可回收。
    store.updateNode(n.id, { text: '叶改-仅v2独有的正文' });
    const c2 = store.saveHistorySnapshot({ docId: doc.id, summary: 'v2', owner: 'human' });

    // 两个 commit 都在 → 无孤儿。
    assert.equal(store.gcHistoryObjects().deleted, 0, '两 commit 都引用其对象，GC 不应删任何东西');

    // reset 到 c1：c2 仍在 commits 表（reflog）→ 其对象仍可达，GC 仍不删。
    store.restoreCommit(c1.id);
    assert.equal(store.gcHistoryObjects().deleted, 0, 'reset 后 c2 仍在表中，对象不应被收（可后悔窗口）');
    assert.ok(store.commitSnapshot(c2.id)?.nodes, 'c2 reset 后仍可重建');

    // 真删 c2 行 → 它独占的对象成孤儿，可收；c1 的对象不动。
    store.db.prepare('UPDATE doc_heads SET head_commit_id = ? WHERE doc_id = ?').run(c1.id, doc.id);
    store.db.prepare('DELETE FROM commits WHERE id = ?').run(c2.id);
    const gc = store.gcHistoryObjects();
    assert.ok(gc.deleted > 0, '删掉 c2 行后应回收其独占对象');
    assert.ok(store.commitSnapshot(c1.id)?.nodes, 'c1 在 GC 后仍可重建');
    assert.equal(store.commitSnapshot(c1.id).nodes.find((x) => x.id === n.id).text, '叶', 'c1 正文未被 GC 误删');
  });
});

test('objects.gc verb routes through database_write allowlist to the store method', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'GCVerb', rootText: '根' });
    store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '叶', nodeType: 'TEXT' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v1', owner: 'human' });
    const res = await runDatabaseWrite(store, { action: 'objects.gc' });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'objects.gc');
    assert.equal(typeof res.scanned, 'number');
    assert.equal(typeof res.reachable, 'number');
    assert.equal(res.deleted, 0, '所有对象都被 v1 引用，GC 不删');
  });
});

test('insertSnapshotNodes 拓扑插入：深链 restore 正确（Kahn O(N) 替换原 O(N²)）', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'DeepChain', rootText: 'root' });
    // SQL 快速建 600 层深链（每节点父=上一个）；depth/address 由 refreshDocAddresses 算。
    const N = 600;
    const insert = store.db.prepare(
      'INSERT INTO nodes (id, doc_id, parent_id, sort_order, node_type, text, trust_level) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    let parent = doc.rootNodeId;
    store.db.transaction(() => {
      for (let i = 0; i < N; i += 1) {
        const id = `deep-${i}`;
        insert.run(id, doc.id, parent, 1, 'TEXT', `n${i}`, null);
        parent = id;
      }
    })();
    store.refreshDocAddresses(doc.id);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE doc_id = ?').get(doc.id).c, N + 1);

    const c1 = store.saveHistorySnapshot({ docId: doc.id, summary: 'deep v1', owner: 'human' });
    store.updateNode('deep-0', { text: 'n0-改' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'deep v2', owner: 'human' });

    // 回滚到 v1：materializeTree → insertSnapshotNodes(Kahn) 重建深链。
    store.restoreCommit(c1.id);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM nodes WHERE doc_id = ?').get(doc.id).c, N + 1, '深链 N+1 节点全恢复');
    const deepest = store.db.prepare('SELECT text, address FROM nodes WHERE id = ?').get(`deep-${N - 1}`);
    assert.equal(deepest.text, `n${N - 1}`, '最深节点正文恢复');
    assert.equal(deepest.address.split('-').length, N + 1, '最深节点地址段数=深度（父链完整、拓扑序正确）');
    assert.equal(store.db.prepare('SELECT text FROM nodes WHERE id = ?').get('deep-0').text, 'n0', 'deep-0 恢复成 v1 版（非 v2 的改）');
  });
});

test('nodeHistory tracks a node across commits via the object store', async () => {
  await withStore(async (store) => {
    const doc = store.createDoc({ title: 'Hist', rootText: '根' });
    const n = store.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '初版', nodeType: 'TEXT' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v1', owner: 'human' });
    store.updateNode(n.id, { text: '改版' });
    store.saveHistorySnapshot({ docId: doc.id, summary: 'v2', owner: 'human' });

    const addr = store.db.prepare('SELECT address FROM nodes WHERE id = ?').get(n.id).address;
    const history = store.nodeHistory(doc.id, addr, { scope: 'node' });
    assert.ok(history.length >= 1, 'nodeHistory 应至少记到一次改动');
    assert.ok(history.some((e) => e.summary === 'v2'), '应包含改正文的 v2 提交');
  });
});
