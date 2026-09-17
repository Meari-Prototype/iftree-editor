import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../../dist/src/backend/store/index.js';
import { TABLES_SQL, SCHEMA_VERSION } from '../../dist/src/backend/db/schema.js';
import { exportDatabase } from '../../dist/src/backend/db/db-export.js';
import { importDatabase } from '../../dist/src/backend/db/db-import.js';

// 导入式迁移的全链路 oracle：导出 → 导入新空库 → 语义保持 + 引用自洽 + 历史可逐版本重建。
// 不比逐表哈希（id 可能个别重生），比语义（正文/类型/树形/历史版本数）。
test('库导出 → 导入往复：结构语义保持、引用自洽、历史可重建', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-mig-'));
  try {
    // --- 源库：一棵树 + 两个历史版本 ---
    const srcPath = join(dir, 'src.sqlite');
    const src = new IftreeStore(srcPath);
    src.init();
    const doc = src.createDoc({ title: '迁移测试', rootText: '根' });
    const a = src.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '甲', nodeType: 'IF' });
    const b = src.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '乙', nodeType: 'ELSE' });
    src.insertNode({ docId: doc.id, parentId: a.id, text: '甲子' });
    src.saveHistorySnapshot({ docId: doc.id, summary: 'v1' });
    src.updateNode(b.id, { text: '乙改' });
    src.saveHistorySnapshot({ docId: doc.id, summary: 'v2' });

    const srcTree = src.getDoc(doc.id).tree;
    const srcNodeCount = src.db.prepare('SELECT COUNT(*) n FROM nodes').get().n;
    const srcCommitCount = src.db.prepare('SELECT COUNT(*) n FROM commits').get().n;
    const dump = exportDatabase(src.db, { schemaVersion: SCHEMA_VERSION, exportedAt: 'test' });
    src.close();

    // --- 导入新空库 ---
    const dstPath = join(dir, 'dst.sqlite');
    const empty = new Database(dstPath);
    empty.exec(TABLES_SQL);
    empty.pragma(`user_version = ${SCHEMA_VERSION}`);
    const result = importDatabase(empty, dump);
    assert.equal(result.violations.length, 0, `外键应无悬挂：${JSON.stringify(result.violations)}`);
    empty.close();

    // --- 打开导入库，断言语义保持 ---
    const dst = new IftreeStore(dstPath);
    dst.init();
    const dstTree = dst.getDoc(doc.id).tree;
    assert.equal(dstTree.text, srcTree.text, '根正文保持');
    assert.equal(dstTree.children.length, srcTree.children.length, '子节点数保持');
    assert.equal(dstTree.children[0].text, srcTree.children[0].text, '子节点正文保持');
    assert.equal(dstTree.children[0].nodeType, srcTree.children[0].nodeType, '节点类型保持');
    assert.equal(dstTree.children[0].children[0].text, srcTree.children[0].children[0].text, '孙节点正文保持');
    assert.equal(dst.db.prepare('SELECT COUNT(*) n FROM nodes').get().n, srcNodeCount, '节点总数保持');
    assert.equal(dst.db.prepare('SELECT COUNT(*) n FROM commits').get().n, srcCommitCount, '历史版本数保持');

    // 历史可逐版本重建
    const commits = dst.db.prepare('SELECT id FROM commits ORDER BY committed_at').all();
    for (const commit of commits) {
      const snap = dst.commitSnapshot(commit.id);
      assert.ok(snap && Array.isArray(snap.nodes) && snap.nodes.length > 0, `commit ${commit.id} 可重建`);
    }
    dst.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 句位归属（span→node + nodes.source_position）的往返：归属随 commit 进内容寻址对象库后，
// export/import 必须把 commits.span_map_hash 与 spanmap 对象原样搬过去——否则导入后的库能恢复
// 结构却恢复不出句位，等于「往返丢原文回链」。docs 的 span_map_hash/span_map_dirty 是派生列，
// 刻意不搬（DERIVED_COLUMNS），导入后按建表默认置脏、首次写快照重扫即归位。
test('库导出 → 导入往复：句位归属随 commit 保真，restore 后逐行一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iftree-mig-span-'));
  try {
    const srcPath = join(dir, 'src.sqlite');
    const src = new IftreeStore(srcPath);
    src.init();
    const doc = src.createDoc({ title: '原文', rootText: '根' });
    const paragraph = src.insertNode({ docId: doc.id, parentId: doc.rootNodeId, text: '甲句。乙句。丙句。' });
    src.db.prepare('UPDATE nodes SET source_position = ? WHERE id = ?').run(1.5, paragraph.id);
    src.saveSourceDocument({
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
    const ownership = (store) => store.db.prepare(
      'SELECT sentence_index, node_id FROM source_spans WHERE doc_id = ? ORDER BY sentence_index'
    ).all(doc.id).map((row) => [Number(row.sentence_index), row.node_id ?? null]);

    const beforeSplit = ownership(src);
    const commitA = src.saveHistorySnapshot({ docId: doc.id, summary: 'A 导入' });
    src.splitNodeIntoChildren(paragraph.id);
    const afterSplit = ownership(src);
    src.saveHistorySnapshot({ docId: doc.id, summary: 'B 拆句' });
    const srcSpanMaps = src.db.prepare("SELECT COUNT(*) n FROM objects WHERE kind = 'spanmap'").get().n;
    assert.equal(srcSpanMaps, 2, '源库应有 A/B 两个时代的 spanmap');
    const dump = exportDatabase(src.db, { schemaVersion: SCHEMA_VERSION, exportedAt: 'test' });
    src.close();

    const dstPath = join(dir, 'dst.sqlite');
    const empty = new Database(dstPath);
    empty.exec(TABLES_SQL);
    empty.pragma(`user_version = ${SCHEMA_VERSION}`);
    const result = importDatabase(empty, dump);
    assert.equal(result.violations.length, 0, `外键应无悬挂：${JSON.stringify(result.violations)}`);
    empty.close();

    const dst = new IftreeStore(dstPath);
    dst.init();
    assert.equal(
      dst.db.prepare("SELECT COUNT(*) n FROM objects WHERE kind = 'spanmap'").get().n,
      srcSpanMaps,
      'spanmap 对象整表搬过来'
    );
    assert.deepEqual(ownership(dst), afterSplit, '导入后 live 归属保持拆句后的状态');
    assert.equal(
      dst.db.prepare('SELECT span_map_dirty FROM docs WHERE id = ?').get(doc.id).span_map_dirty,
      1,
      'docs 的列缓存是派生量，导入后置脏待重扫'
    );

    dst.restoreCommit(commitA.commit_id);
    assert.deepEqual(ownership(dst), beforeSplit, '导入库里 restore 回 A 仍精确还原拆句前的归属');
    assert.equal(
      dst.db.prepare('SELECT source_position FROM nodes WHERE id = ?').get(paragraph.id).source_position,
      1.5,
      'source_position 一并往返'
    );
    dst.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
