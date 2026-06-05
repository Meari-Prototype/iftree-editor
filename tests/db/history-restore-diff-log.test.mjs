import assert from 'node:assert/strict';
import test from 'node:test';

import {
  modifyChangedText,
  modifyOriginalText,
  commitSingleTextChange,
  parseJsonStdout,
  runBashDb,
  stdoutOf,
  withImportedFixture
} from './_helpers.mjs';

test('db log, diff, read --at, and restore address committed history', { timeout: 240000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const commit = await commitSingleTextChange(
      dbPath,
      docId,
      '1-1-6-1-1',
      modifyChangedText,
      'dbt-history',
      'DBT_HISTORY_APPLY'
    );
    const historyId = String(commit.history.id);

    const logText = stdoutOf(await runBashDb(dbPath, ['log', docId, '--limit', '5']));
    assert.match(logText, new RegExp(`history:${historyId} commit:.* DBT_HISTORY_APPLY`));

    const diffText = stdoutOf(await runBashDb(dbPath, ['diff', docId, historyId]));
    assert.match(diffText, /node.update/);
    assert.match(diffText, /"old":"DBT_DIFF_MODIFY 的原始正文是 old-diff-text/);

    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1', '--at', historyId])), modifyChangedText);

    await commitSingleTextChange(
      dbPath,
      docId,
      '1-1-6-1-1',
      modifyOriginalText,
      'dbt-history-reset',
      'DBT_HISTORY_RESET'
    );
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyOriginalText);

    const restored = parseJsonStdout(await runBashDb(dbPath, ['restore', historyId]));
    assert.equal(restored.ok, true);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyChangedText);

    const missingLogDoc = await runBashDb(dbPath, ['log'], { expectFailure: true });
    assert.match(missingLogDoc.stderr || missingLogDoc.stdout, /db log requires doc_id/);

    const missingDiffHistory = await runBashDb(dbPath, ['diff', docId], { expectFailure: true });
    assert.match(missingDiffHistory.stderr || missingDiffHistory.stdout, /db diff requires history id/);

    const readAtWithSource = await runBashDb(dbPath, ['read', docId, '1-1-6-1-1', '--at', historyId, '--source'], { expectFailure: true });
    assert.match(readAtWithSource.stderr || readAtWithSource.stdout, /db read --at does not support --source\/--blame/);

    const missingRestoreRef = await runBashDb(dbPath, ['restore'], { expectFailure: true });
    assert.match(missingRestoreRef.stderr || missingRestoreRef.stdout, /history ref requires history id, saved_at, or tag/);
  });
});
