import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginBranch,
  editSetText,
  modifyChangedText,
  runBashDb,
  stdoutOf,
  parseJsonStdout,
  withImportedFixture
} from './_helpers.mjs';

test('db branch list, begin, diff, merge, and drop handle confirmed and dry-run paths', { timeout: 240000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const mergeOwner = 'dbt-branch-merge';
    const initialList = stdoutOf(await runBashDb(dbPath, ['branch', 'list', docId, '--owner', mergeOwner]));
    assert.equal(initialList, '');

    const branch = await beginBranch(dbPath, docId, mergeOwner);
    assert.ok(branch.branchId);
    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText, mergeOwner);

    const listText = stdoutOf(await runBashDb(dbPath, ['branch', 'list', docId, '--owner', mergeOwner]));
    assert.match(listText, new RegExp(`branch:${branch.branchId}\\s+doc:${docId}\\s+owner:${mergeOwner}\\s+改:1\\s+增:0\\s+删:0`));

    const diff = parseJsonStdout(await runBashDb(dbPath, ['branch', 'diff', docId, '--owner', mergeOwner]));
    assert.equal(diff.branch.id, branch.branchId);
    assert.equal(diff.stats.activeEntryCount, 1);
    assert.ok(diff.rows.some((row) => row.status === 'modified'));

    const mergeNeedsAll = stdoutOf(await runBashDb(dbPath, ['branch', 'merge', docId, '--owner', mergeOwner]));
    assert.equal(mergeNeedsAll, 'db branch merge requires --all; --entry is not implemented');

    const dryMerge = stdoutOf(await runBashDb(dbPath, ['branch', 'merge', docId, '--owner', mergeOwner, '--all']));
    assert.match(dryMerge, new RegExp(`would merge doc:${docId} owner:${mergeOwner}; rerun with --yes to apply`));

    const appliedMerge = parseJsonStdout(await runBashDb(dbPath, ['branch', 'merge', docId, '--owner', mergeOwner, '--all', '--yes']));
    assert.equal(appliedMerge.ok, true);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyChangedText);

    const dropOwner = 'dbt-branch-drop';
    await beginBranch(dbPath, docId, dropOwner);
    await editSetText(dbPath, docId, '1-1-3-2-1', 'DBT_BRANCH_DROP_SHOULD_NOT_APPLY', dropOwner);

    const dryDrop = stdoutOf(await runBashDb(dbPath, ['branch', 'drop', docId, '--owner', dropOwner]));
    assert.match(dryDrop, new RegExp(`would drop doc:${docId} owner:${dropOwner}; rerun with --yes to apply`));

    const dropped = parseJsonStdout(await runBashDb(dbPath, ['branch', 'drop', docId, '--owner', dropOwner, '--yes']));
    assert.equal(dropped.ok, true);
    assert.equal(dropped.changed, true);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['branch', 'list', docId, '--owner', dropOwner])), '');

    const missingBeginDoc = await runBashDb(dbPath, ['branch', 'begin'], { expectFailure: true });
    assert.match(missingBeginDoc.stderr || missingBeginDoc.stdout, /db branch begin requires doc_id/);

    const unknownBranchCommand = await runBashDb(dbPath, ['branch', 'rename'], { expectFailure: true });
    assert.match(unknownBranchCommand.stderr || unknownBranchCommand.stdout, /Unknown db branch command: rename/);
  });
});
