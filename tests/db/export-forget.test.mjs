import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJsonStdout, runBashDb, stdoutOf, withImportedFixture } from './_helpers.mjs';

test('db export and forget read then remove an imported document and reject missing doc ids', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const exported = stdoutOf(await runBashDb(dbPath, ['export', docId]));
    assert.match(exported, /# IFTreeEditor数据库读写测试样例/);
    assert.match(exported, /DBT_END_MARKER/);

    const forgetResult = parseJsonStdout(await runBashDb(dbPath, ['forget', docId]));
    assert.equal(forgetResult.ok, true);
    assert.equal(forgetResult.changed, true);

    const readAfterForget = await runBashDb(dbPath, ['read', docId, '1'], { expectFailure: true });
    assert.match(readAfterForget.stderr || readAfterForget.stdout, /db read target not found/);

    const exportNoDoc = await runBashDb(dbPath, ['export'], { expectFailure: true });
    assert.match(exportNoDoc.stderr || exportNoDoc.stdout, /db export requires doc_id/);

    const forgetNoDoc = await runBashDb(dbPath, ['forget'], { expectFailure: true });
    assert.match(forgetNoDoc.stderr || forgetNoDoc.stdout, /db forget requires doc_id/);
  });
});
