import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonStdout, runBashDb, stdoutOf, withImportedFixture } from './_helpers.mjs';

test('db export 已停用（未启用，待重新设计）；delete 正常读删并对缺参报错', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    // —— export：已停用——原实现把 markdown 返回命令行（应导出为文件）且渲染有功能错误，重新设计前一律拒绝。——
    const exported = await runBashDb(dbPath, ['export', docId], { expectFailure: true });
    assert.match(exported.stderr || exported.stdout, /已停用（未启用，待重新设计）/);

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

    // —— export 停用后即便缺 doc_id 也一律先报停用（重新设计前不再走 doc_id 校验）——
    const exportNoDoc = await runBashDb(dbPath, ['export'], { expectFailure: true });
    assert.match(exportNoDoc.stderr || exportNoDoc.stdout, /已停用（未启用，待重新设计）/);

    const deleteNoDoc = await runBashDb(dbPath, ['delete'], { expectFailure: true });
    assert.match(deleteNoDoc.stderr || deleteNoDoc.stdout, /db delete requires doc_id/);
  });
});
