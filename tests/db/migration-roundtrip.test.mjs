import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { IftreeStore } from '../../src/backend/store/index.mjs';
import { TABLES_SQL, SCHEMA_VERSION } from '../../src/backend/db/schema.mjs';
import { exportDatabase } from '../../src/backend/db/db-export.mjs';
import { importDatabase } from '../../src/backend/db/db-import.mjs';

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
