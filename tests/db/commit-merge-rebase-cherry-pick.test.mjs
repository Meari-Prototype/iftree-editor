import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alphaChangedText,
  alphaOriginalText,
  beginBranch,
  commitBranch,
  editSetText,
  parseJsonStdout,
  runBashDb,
  stdoutOf,
  withImportedFixture
} from './_helpers.mjs';

test('db commit, merge, rebase, and cherry-pick apply real writes and reject incomplete targets', { timeout: 300000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const sourceOwner = 'dbt-pick-source';
    await beginBranch(dbPath, docId, sourceOwner);
    await editSetText(dbPath, docId, '1-1-3-2-1', alphaChangedText, sourceOwner);

    const rebaseResult = parseJsonStdout(await runBashDb(dbPath, ['rebase', '--base', docId, '--owner', sourceOwner]));
    assert.equal(rebaseResult.changed, true);

    const sourceCommit = await commitBranch(dbPath, docId, sourceOwner, 'DBT_PICK_SOURCE');
    const sourceHistoryId = String(sourceCommit.history.id);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1'])), alphaChangedText);

    await beginBranch(dbPath, docId, 'dbt-reset-before-pick');
    await editSetText(dbPath, docId, '1-1-3-2-1', alphaOriginalText, 'dbt-reset-before-pick');
    await commitBranch(dbPath, docId, 'dbt-reset-before-pick', 'DBT_RESET_BEFORE_PICK');
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1'])), alphaOriginalText);

    const picked = parseJsonStdout(await runBashDb(dbPath, [
      'cherry-pick',
      '--history',
      sourceHistoryId,
      '--target-base',
      docId,
      '--owner',
      'dbt-picked-history',
      '--entry-index',
      '0'
    ]));
    assert.equal(picked.changed, true);
    assert.equal(picked.pickedCount, 1);

    const mergeDryRun = stdoutOf(await runBashDb(dbPath, ['merge', '--base', docId, '--owner', 'dbt-picked-history']));
    assert.match(mergeDryRun, new RegExp(`would merge doc:${docId} owner:dbt-picked-history; rerun with --yes to apply`));

    const merged = parseJsonStdout(await runBashDb(dbPath, ['merge', '--base', docId, '--owner', 'dbt-picked-history', '--yes']));
    assert.equal(merged.ok, true);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1'])), alphaChangedText);

    const mergeNoTarget = await runBashDb(dbPath, ['merge'], { expectFailure: true });
    assert.match(mergeNoTarget.stderr || mergeNoTarget.stdout, /db merge requires --branch or --base/);

    const rebaseNoTarget = await runBashDb(dbPath, ['rebase'], { expectFailure: true });
    assert.match(rebaseNoTarget.stderr || rebaseNoTarget.stdout, /db rebase requires --branch or --base/);

    const cherryPickNoSource = await runBashDb(dbPath, ['cherry-pick', '--target-base', docId], { expectFailure: true });
    assert.match(cherryPickNoSource.stderr || cherryPickNoSource.stdout, /db cherry-pick requires --history or --source-branch/);
  });
});
