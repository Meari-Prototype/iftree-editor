import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginBranch,
  editSetText,
  modifyChangedText,
  parseJsonStdout,
  runBashDb,
  stdoutOf,
  withImportedFixture
} from './_helpers.mjs';

test('db changes, undo, redo, discard, and switch expose edit-branch state and errors', { timeout: 240000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-state';
    await beginBranch(dbPath, docId, owner);
    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText, owner);

    const changes = stdoutOf(await runBashDb(dbPath, ['changes', docId, '--owner', owner]));
    assert.match(changes, new RegExp(`doc:${docId}\\s+owner:${owner}\\s+改:1\\s+增:0\\s+删:0`));

    const detail = parseJsonStdout(await runBashDb(dbPath, ['changes', docId, '--owner', owner, '--detail']));
    assert.equal(detail.stats.activeEntryCount, 1);
    assert.ok(detail.rows.some((row) => row.status === 'modified'));

    const undoResult = parseJsonStdout(await runBashDb(dbPath, ['undo', '--base', docId, '--owner', owner]));
    assert.equal(undoResult.changed, true);
    assert.match(stdoutOf(await runBashDb(dbPath, ['changes', docId, '--owner', owner])), /改:0\s+增:0\s+删:0\s+撤销:1/);

    const redoResult = parseJsonStdout(await runBashDb(dbPath, ['redo', '--base', docId, '--owner', owner]));
    assert.equal(redoResult.changed, true);
    assert.match(stdoutOf(await runBashDb(dbPath, ['changes', docId, '--owner', owner])), /改:1\s+增:0\s+删:0/);

    const dryDiscard = stdoutOf(await runBashDb(dbPath, ['discard', '--base', docId, '--owner', owner]));
    assert.match(dryDiscard, new RegExp(`would discard doc:${docId} owner:${owner}; rerun with --yes to apply`));

    const discarded = parseJsonStdout(await runBashDb(dbPath, ['discard', '--base', docId, '--owner', owner, '--yes']));
    assert.equal(discarded.ok, true);
    assert.equal(discarded.changed, true);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['changes', docId, '--owner', owner])), '');

    const noSelection = stdoutOf(await runBashDb(dbPath, ['switch']));
    assert.equal(noSelection, '(未选择分支)');

    const selectedBase = parseJsonStdout(await runBashDb(dbPath, ['switch', '--base', docId, '--owner', 'dbt-selected']));
    assert.equal(selectedBase.baseDocId, docId);
    assert.equal(selectedBase.owner, 'dbt-selected');

    const changesDetailNoTarget = await runBashDb(dbPath, ['changes', '--detail'], { expectFailure: true });
    assert.match(changesDetailNoTarget.stderr || changesDetailNoTarget.stdout, /db changes --detail requires --branch or --base/);

    const discardNoTarget = await runBashDb(dbPath, ['discard'], { expectFailure: true });
    assert.match(discardNoTarget.stderr || discardNoTarget.stdout, /db discard requires --branch or --base/);

    const undoNoTarget = await runBashDb(dbPath, ['undo'], { expectFailure: true });
    assert.match(undoNoTarget.stderr || undoNoTarget.stdout, /db undo requires --branch or --base/);
  });
});
