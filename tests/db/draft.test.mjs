import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginBranch,
  editSetText,
  modifyChangedText,
  modifyOriginalText,
  runBashDb,
  stdoutOf,
  parseJsonStdout,
  withImportedFixture
} from './_helpers.mjs';

test('db draft new/list, diff, merge, and discard handle confirmed and dry-run paths', { timeout: 240000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const mergeOwner = 'dbt-draft-merge';
    const initialList = stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', mergeOwner]));
    assert.equal(initialList, '(无草稿)');

    const branch = await beginBranch(dbPath, docId, mergeOwner);
    assert.ok(branch.branchId);
    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText, mergeOwner);

    const listText = stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', mergeOwner]));
    assert.match(listText, new RegExp(`branch:${branch.branchId}\\s+doc:${docId}\\s+owner:${mergeOwner}\\s+改:1\\s+增:0\\s+删:0`));

    // 原 `branch diff` / `changes --detail` 并入 `diff`（草稿↔正文，--json 出结构）。
    const diff = parseJsonStdout(await runBashDb(dbPath, ['diff', '--base', docId, '--owner', mergeOwner, '--json']));
    assert.equal(diff.branch.id, branch.branchId);
    assert.equal(diff.stats.activeEntryCount, 1);
    assert.ok(diff.rows.some((row) => row.status === 'modified'));

    // 原 `branch merge --all` 并入顶层 `merge`（走 applyMerge）。
    const dryMerge = stdoutOf(await runBashDb(dbPath, ['merge', '--base', docId, '--owner', mergeOwner]));
    assert.match(dryMerge, new RegExp(`would merge doc:${docId} owner:${mergeOwner}; rerun with --yes to apply`));

    const appliedMerge = parseJsonStdout(await runBashDb(dbPath, ['merge', '--base', docId, '--owner', mergeOwner, '--yes']));
    assert.equal(appliedMerge.ok, true);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyChangedText);

    // 原 `branch drop` 并入顶层 `discard`。
    const dropOwner = 'dbt-draft-discard';
    await beginBranch(dbPath, docId, dropOwner);
    await editSetText(dbPath, docId, '1-1-3-2-1', 'DBT_DRAFT_DISCARD_SHOULD_NOT_APPLY', dropOwner);

    const dryDiscard = stdoutOf(await runBashDb(dbPath, ['discard', '--base', docId, '--owner', dropOwner]));
    assert.match(dryDiscard, new RegExp(`would discard doc:${docId} owner:${dropOwner}; rerun with --yes to apply`));

    const discarded = parseJsonStdout(await runBashDb(dbPath, ['discard', '--base', docId, '--owner', dropOwner, '--yes']));
    assert.equal(discarded.ok, true);
    assert.equal(discarded.changed, true);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', dropOwner])), '(无草稿)');

    const missingNewDoc = await runBashDb(dbPath, ['draft', 'new'], { expectFailure: true });
    assert.match(missingNewDoc.stderr || missingNewDoc.stdout, /db draft new requires doc_id/);

    const unknownDraftCommand = await runBashDb(dbPath, ['draft', 'rename'], { expectFailure: true });
    assert.match(unknownDraftCommand.stderr || unknownDraftCommand.stdout, /Unknown db draft command: rename/);
  });
});

// 旧 branch.test.mjs（已删）曾断言 merge 缺确认标志被拒。现在 merge 只有 --yes 才落库、
// 否则只预览。这里守住「不带 --yes 是只读预览」：出预览文案、不报错、正文与草稿都不动。
test('db merge without --yes only previews and leaves draft/base untouched', { timeout: 240000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-draft-merge-dryrun';
    const branch = await beginBranch(dbPath, docId, owner);
    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText, owner);

    // 不带 --yes：应是预览文案、且命令本身不报错（stdoutOf 已断言 exitCode===0）。
    const preview = stdoutOf(await runBashDb(dbPath, ['merge', '--base', docId, '--owner', owner]));
    assert.match(preview, new RegExp(`would merge doc:${docId} owner:${owner}; rerun with --yes to apply`));

    // 预览不落库：正文仍是原始值，草稿仍在、diff 仍能查出同地址修改。
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyOriginalText);
    const diff = parseJsonStdout(await runBashDb(dbPath, ['diff', '--base', docId, '--owner', owner, '--json']));
    assert.equal(diff.branch.id, branch.branchId);
    assert.equal(diff.stats.activeEntryCount, 1);
    assert.ok(diff.rows.some((row) => row.status === 'modified'));
  });
});
