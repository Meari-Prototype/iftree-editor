import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { fixturePath, fixtureTitle, importFixture, parseJsonStdout, runBashDb, stdoutOf, withTempDb } from './_helpers.mjs';

test('db import, index, and tree expose the imported fixture and reject bad args', { timeout: 180000 }, async () => {
  await withTempDb(async (dbPath) => {
    // —— import 返回结构：ok/action/relativePath/imported[]/docId/title/nodeCount ——
    const imported = await importFixture(dbPath);
    const { docId } = imported;
    assert.equal(imported.ok, true);
    assert.equal(imported.action, 'import.libraryDocument');
    assert.equal(imported.relativePath, fixturePath);
    assert.equal(imported.title, fixtureTitle);
    assert.equal(imported.nodeCount, 50);
    assert.ok(Array.isArray(imported.imported), 'imported 应是数组');
    assert.equal(imported.imported.length, 1);
    assert.equal(imported.imported[0].docId, docId);
    assert.match(docId, /^019[a-f0-9-]+$/, 'docId 应是 UUIDv7 格式（019 前缀）');

    // —— index --folder --uuid：组头带文件名 + #docId + 字数 + semantic 状态 ——
    const indexText = stdoutOf(await runBashDb(dbPath, ['index', '--folder', 'generated', '--uuid']));
    assert.match(indexText, new RegExp(`${fixtureTitle}\\.md #${docId}`));
    assert.match(indexText, /\(2233字\) \[semantic:missing 0\/\d+\]/);

    // —— index 无 folder 值报错 ——
    const indexMissingFolderValue = await runBashDb(dbPath, ['index', '--folder'], { expectFailure: true });
    assert.match(indexMissingFolderValue.stderr || indexMissingFolderValue.stdout, /db --folder requires a library relative path/);

    // —— tree --depth 4：fixture 已知结构（1-1-3/1-1-6/1-1-8 常驻）——
    const treeText = stdoutOf(await runBashDb(dbPath, ['tree', docId, '--depth', '4']));
    assert.match(treeText, /1-1-3 文本 1\. 基础层级与稳定定位/);
    assert.match(treeText, /1-1-6 文本 4\. 编辑分支 diff 靶子/);
    assert.match(treeText, /1-1-8 文本 6\. 结束节点/);
    // tree 行格式：地址 + 类型 + 标题 + (子树字数)，类型用中文标签。根节点 1 在行首，子节点缩进。
    assert.match(treeText, /^1 文本 /m);
    assert.match(treeText, /^  1-1 文本 /m);

    // —— tree 缺 doc_id 报错 ——
    const treeMissingDoc = await runBashDb(dbPath, ['tree'], { expectFailure: true });
    assert.match(treeMissingDoc.stderr || treeMissingDoc.stdout, /db tree requires doc_id/);

    // —— import 缺路径报错 ——
    const importMissingArg = await runBashDb(dbPath, ['import'], { expectFailure: true });
    assert.match(importMissingArg.stderr || importMissingArg.stdout, /db import requires library_relative_path/);

    // —— 重复导入同路径被拒（去重：已对应 docId，需先删再导）——
    const dupImport = await runBashDb(dbPath, ['import', fixturePath, '--mode', 'simple'], { expectFailure: true });
    assert.match(dupImport.stderr || dupImport.stdout, /已对应数据库文档|请先删除旧数据库文档/);

    // —— import 后 SQL 校验：临时库只有这一篇文档，节点总数应=50 ——
    // db sql 经 argv 传裸 SQL，单引号字面量在 shell 层易被吞；用不依赖字面量的 COUNT(*)。
    const sqlResult = parseJsonStdout(await runBashDb(dbPath, ['sql', 'SELECT COUNT(*) AS n FROM nodes']));
    assert.equal(Number(sqlResult.rows[0].n), 50, '导入后节点总数应为 50');
    // 根节点只有一个：用 tree --depth 1 看，而非 SQL 字面量比较。
    const rootTree = stdoutOf(await runBashDb(dbPath, ['tree', docId, '--depth', '1']));
    const rootLines = rootTree.split(/\r?\n/).filter((line) => /^\d+ 文本 /.test(line));
    assert.equal(rootLines.length, 1, 'depth 1 应只有根节点 1');
    assert.match(rootLines[0], /^1 文本 /);
  });
});
