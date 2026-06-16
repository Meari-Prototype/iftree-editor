import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonStdout, runBashDb, stdoutOf, withImportedFixture } from './_helpers.mjs';

test('db export and delete read then remove an imported document and reject missing doc ids', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const exported = stdoutOf(await runBashDb(dbPath, ['export', docId]));
    assert.match(exported, /# IFTreeEditor数据库读写测试样例/);
    assert.match(exported, /DBT_END_MARKER/);

    const deleteResult = parseJsonStdout(await runBashDb(dbPath, ['delete', docId]));
    assert.equal(deleteResult.ok, true);
    assert.equal(deleteResult.changed, true);

    const readAfterDelete = await runBashDb(dbPath, ['read', docId, '1'], { expectFailure: true });
    assert.match(readAfterDelete.stderr || readAfterDelete.stdout, /db read target not found/);

    const exportNoDoc = await runBashDb(dbPath, ['export'], { expectFailure: true });
    assert.match(exportNoDoc.stderr || exportNoDoc.stdout, /db export requires doc_id/);

    const deleteNoDoc = await runBashDb(dbPath, ['delete'], { expectFailure: true });
    assert.match(deleteNoDoc.stderr || deleteNoDoc.stdout, /db delete requires doc_id/);
  });
});
