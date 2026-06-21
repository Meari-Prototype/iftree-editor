import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonStdout, runBashDb, stdoutOf, withImportedFixture } from './_helpers.mjs';

test('db export and delete read then remove an imported document and reject missing doc ids', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    // —— export：markdown 文本，含根标题与结束标记 ——
    const exported = stdoutOf(await runBashDb(dbPath, ['export', docId]));
    assert.match(exported, /# IFTreeEditor数据库读写测试样例/);
    assert.match(exported, /DBT_END_MARKER/);
    assert.ok(exported.length > 100, 'export 应返回完整 markdown，不是空串');

    // —— delete：返回 {ok, action, docId, changed, title, nodeCount} ——
    const deleteResult = parseJsonStdout(await runBashDb(dbPath, ['delete', docId]));
    assert.equal(deleteResult.ok, true);
    assert.equal(deleteResult.action, 'import.deleteDocument');
    assert.equal(deleteResult.changed, true);
    assert.equal(deleteResult.docId, docId);
    assert.equal(deleteResult.title, 'IFTreeEditor数据库读写测试样例');
    assert.ok(deleteResult.nodeCount > 0, 'delete 应返回原节点数');

    // —— delete 后 read 报 not found ——
    const readAfterDelete = await runBashDb(dbPath, ['read', docId, '1'], { expectFailure: true });
    assert.match(readAfterDelete.stderr || readAfterDelete.stdout, /db read target not found/);

    // —— delete 后 index 不再列出该文档 ——
    const indexAfterDelete = stdoutOf(await runBashDb(dbPath, ['index', '--folder', 'generated']));
    assert.doesNotMatch(indexAfterDelete, /IFTreeEditor数据库读写测试样例/);

    // —— 错误路径：缺 doc_id ——
    const exportNoDoc = await runBashDb(dbPath, ['export'], { expectFailure: true });
    assert.match(exportNoDoc.stderr || exportNoDoc.stdout, /db export requires doc_id/);

    const deleteNoDoc = await runBashDb(dbPath, ['delete'], { expectFailure: true });
    assert.match(deleteNoDoc.stderr || deleteNoDoc.stdout, /db delete requires doc_id/);
  });
});
