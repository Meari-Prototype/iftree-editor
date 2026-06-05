import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginBranch,
  editDelete,
  editInsert,
  editSetText,
  modifyChangedText,
  runBashDb,
  stdoutOf,
  withImportedFixture
} from './_helpers.mjs';

test('db edit records set, insert, and delete entries on a real edit branch and rejects bad edits', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-edit';
    await beginBranch(dbPath, docId, owner);

    const setResult = await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText, owner);
    assert.equal(setResult.changed, true);

    const childResult = await editInsert(dbPath, docId, '1-1-6-2', 'child', 'DBT_EDIT_INSERT_CHILD', owner);
    assert.equal(childResult.changed, true);

    const siblingResult = await editInsert(dbPath, docId, '1-1-6-2', 'sibling', 'DBT_EDIT_INSERT_SIBLING', owner);
    assert.equal(siblingResult.changed, true);

    const deleteResult = await editDelete(dbPath, docId, '1-1-6-3-1', owner);
    assert.equal(deleteResult.changed, true);

    const changes = stdoutOf(await runBashDb(dbPath, ['changes', docId, '--owner', owner]));
    assert.match(changes, new RegExp(`doc:${docId}\\s+owner:${owner}\\s+active:4\\s+undone:0`));

    const badField = await runBashDb(dbPath, [
      'edit',
      docId,
      '1-1-6-1-1',
      '--set',
      'unknown_field',
      'value',
      '--base',
      docId,
      '--owner',
      owner
    ], { expectFailure: true });
    assert.match(badField.stderr || badField.stdout, /db edit --set unsupported field: unknown_field/);

    const badInsertMode = await runBashDb(dbPath, [
      'edit',
      docId,
      '1-1-6-2',
      '--insert',
      'sideways',
      'bad',
      '--base',
      docId,
      '--owner',
      owner
    ], { expectFailure: true });
    assert.match(badInsertMode.stderr || badInsertMode.stdout, /db edit --insert requires child or sibling/);

    const missingValue = await runBashDb(dbPath, [
      'edit',
      docId,
      '1-1-6-1-1',
      '--set',
      'text',
      '--base',
      docId,
      '--owner',
      owner
    ], { expectFailure: true });
    assert.match(missingValue.stderr || missingValue.stdout, /db edit --set requires value/);
  });
});
