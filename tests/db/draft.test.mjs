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

// draft new 幂等 + draft list 计数 + diff --json 结构（kind/branch/baseDoc/mergeBase/projectedDoc/stats/entries/rows）。
test('db draft new 幂等 + list 计数 + diff --json 结构', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-draft-new';
    const initialList = stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', owner]));
    assert.equal(initialList, '(无草稿)');

    const branch = await beginBranch(dbPath, docId, owner);
    assert.ok(branch.branchId);
    assert.equal(typeof branch.branchId, 'number', 'branch.id 是 INTEGER 主键');

    // 重复 draft new 同 owner 返回已存在的分支（幂等）
    const branchResult = parseJsonStdout(await runBashDb(dbPath, ['draft', 'new', docId, '--owner', owner]));
    assert.equal(branchResult.ok, true);
    assert.equal(branchResult.action, 'editBranch.begin');
    assert.equal(branchResult.baseDocId, docId);
    assert.equal(branchResult.shadowDocId, docId, 'lazy 模式 shadow==base');
    assert.equal(branchResult.branch.id, branch.branchId);
    assert.equal(String(branchResult.branch.owner).split('#')[0], owner);
    assert.equal(branchResult.branch.status, 'active');

    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText, owner);

    // draft list：branch:doc:owner + 改/增/删 计数
    const listText = stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', owner]));
    assert.match(listText, new RegExp(`branch:${branch.branchId}\\s+doc:${docId}\\s+owner:${owner}(?:#[\\d:T-]+)?\\s+改:1\\s+增:0\\s+删:0`));

    // diff --json：草稿↔正文，stats/rows/entries/branch/mergeBase/projectedDoc 齐全
    const diff = parseJsonStdout(await runBashDb(dbPath, ['diff', '--base', docId, '--owner', owner, '--json']));
    assert.equal(diff.kind, 'editBranch.diffView');
    assert.equal(diff.branch.id, branch.branchId);
    assert.equal(diff.baseDoc.id, docId);
    assert.equal(diff.projectedDoc.id, docId, 'lazy 模式 projectedDoc.id==baseDocId');
    assert.equal(diff.projectedDoc.baseDocId, docId);
    assert.equal(diff.stats.activeEntryCount, 1);
    assert.equal(diff.stats.undoneEntryCount, 0);
    assert.equal(diff.stats.undoDepth, 1);
    assert.equal(diff.stats.redoDepth, 0);
    assert.ok(diff.rows.some((row) => row.status === 'modified'));
    assert.ok(Array.isArray(diff.entries), 'diff 应含 entries（field-diff）');
    assert.equal(diff.entries.length, 1);
    // computeDiff 的 field-diff 形态：{node_id, field, old, new, address?}，无 kind 字段。
    assert.equal(diff.entries[0].field, 'text', '改正文 → field=text');
    assert.equal(diff.entries[0].old, modifyOriginalText);
    assert.equal(diff.entries[0].new, modifyChangedText);
    assert.equal(diff.entries[0].address, '1-1-6-1-1', 'entries 应补当前地址');
    assert.equal(diff.mergeBase.isFastForward, true);

    // 错误路径
    const missingNewDoc = await runBashDb(dbPath, ['draft', 'new'], { expectFailure: true });
    assert.match(missingNewDoc.stderr || missingNewDoc.stdout, /db draft new requires doc_id/);

    const unknownDraftCommand = await runBashDb(dbPath, ['draft', 'rename'], { expectFailure: true });
    assert.match(unknownDraftCommand.stderr || unknownDraftCommand.stdout, /Unknown db draft command: rename/);
  });
});

// merge：不带 --yes 只预览（正文/草稿都不动），--yes 落库（正文变 + 草稿删）。
test('db merge：dry-run 不落库，--yes 落库后正文变 + 草稿删', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-draft-merge';
    const branch = await beginBranch(dbPath, docId, owner);
    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText, owner);

    // dry-run：预览文案，不报错，正文/草稿都不动
    const dryMerge = stdoutOf(await runBashDb(dbPath, ['merge', '--base', docId, '--owner', owner]));
    assert.match(dryMerge, new RegExp(`would merge doc:${docId} owner:${owner}(?:#[\\d:T-]+)?; rerun with --yes to apply`));
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyOriginalText, '预览不落库：正文不变');
    assert.match(stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', owner])), /改:1/, '预览不落库：草稿仍在');
    const diffAfterDry = parseJsonStdout(await runBashDb(dbPath, ['diff', '--base', docId, '--owner', owner, '--json']));
    assert.equal(diffAfterDry.branch.id, branch.branchId);
    assert.equal(diffAfterDry.stats.activeEntryCount, 1, '预览后 diff 仍有 1 条 entry');

    // --yes：落库，正文变更，草稿删
    const appliedMerge = parseJsonStdout(await runBashDb(dbPath, ['merge', '--base', docId, '--owner', owner, '--yes']));
    assert.equal(appliedMerge.ok, true);
    assert.equal(appliedMerge.applied, true);
    assert.equal(appliedMerge.changed, true);
    assert.equal(appliedMerge.baseDocId, docId);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyChangedText, '落库后正文已变');
    assert.equal(stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', owner])), '(无草稿)', '合并后草稿已删');
  });
});

// discard：dry-run 预览（草稿仍在），--yes 删草稿且不落正文。
test('db discard：dry-run 草稿仍在，--yes 删草稿且改动不落正文', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-draft-discard';
    await beginBranch(dbPath, docId, owner);
    await editSetText(dbPath, docId, '1-1-3-2-1', 'DBT_DRAFT_DISCARD_SHOULD_NOT_APPLY', owner);

    // dry-run：预览文案，草稿仍在
    const dryDiscard = stdoutOf(await runBashDb(dbPath, ['discard', '--base', docId, '--owner', owner]));
    assert.match(dryDiscard, new RegExp(`would discard doc:${docId} owner:${owner}(?:#[\\d:T-]+)?; rerun with --yes to apply`));
    assert.match(stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', owner])), /改:1/, '预览不落库：草稿仍在');

    // --yes：删草稿，改动不落正文
    const discarded = parseJsonStdout(await runBashDb(dbPath, ['discard', '--base', docId, '--owner', owner, '--yes']));
    assert.equal(discarded.ok, true);
    assert.equal(discarded.changed, true);
    assert.equal(discarded.action, 'editBranch.discard');
    assert.equal(discarded.baseDocId, docId);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', owner])), '(无草稿)', 'discard 后草稿已删');
    assert.doesNotMatch(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1'])), /DBT_DRAFT_DISCARD_SHOULD_NOT_APPLY/, 'discard 不落正文');
  });
});
