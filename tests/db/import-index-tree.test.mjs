import assert from 'node:assert/strict';
import test from 'node:test';

import { fixtureTitle, importFixture, runBashDb, stdoutOf, withTempDb } from './_helpers.mjs';

test('db import, index, and tree expose the imported fixture and reject bad args', { timeout: 180000 }, async () => {
  await withTempDb(async (dbPath) => {
    const imported = await importFixture(dbPath);
    const { docId } = imported;

    const indexText = stdoutOf(await runBashDb(dbPath, ['index', '--folder', 'generated', '--uuid']));
    assert.match(indexText, new RegExp(`${fixtureTitle}\\.md #${docId}`));
    assert.match(indexText, /\(2227字\) \[semantic:missing\]/);

    const indexMissingFolderValue = await runBashDb(dbPath, ['index', '--folder'], { expectFailure: true });
    assert.match(indexMissingFolderValue.stderr || indexMissingFolderValue.stdout, /db --folder requires a library relative path/);

    const treeText = stdoutOf(await runBashDb(dbPath, ['tree', docId, '--depth', '4']));
    assert.match(treeText, /1-1-3 文本 1\. 基础层级与稳定定位/);
    assert.match(treeText, /1-1-6 文本 4\. 编辑分支 diff 靶子/);
    assert.match(treeText, /1-1-8 文本 6\. 结束节点/);

    const treeMissingDoc = await runBashDb(dbPath, ['tree'], { expectFailure: true });
    assert.match(treeMissingDoc.stderr || treeMissingDoc.stdout, /db tree requires doc_id/);

    const importMissingArg = await runBashDb(dbPath, ['import'], { expectFailure: true });
    assert.match(importMissingArg.stderr || importMissingArg.stdout, /db import requires library_relative_path/);
  });
});
