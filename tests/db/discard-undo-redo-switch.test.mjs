import '../_assert-electron.mjs';
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

// undo/redo：undo 撤销最后一条 entry（undoDepth 归 0、redoDepth=1、diff 无 modified），
// redo 恢复（undoDepth=1、redoDepth 归 0），收尾 discard 清草稿。
test('db undo/redo：undo 撤销 entry、redo 恢复，undoDepth/redoDepth 互补', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-undo-redo';
    const branch = await beginBranch(dbPath, docId, owner);
    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText, owner);

    // 前置：1 条 modified
    const detail = parseJsonStdout(await runBashDb(dbPath, ['diff', '--base', docId, '--owner', owner, '--json']));
    assert.equal(detail.stats.activeEntryCount, 1);
    assert.equal(detail.stats.undoDepth, 1);
    assert.equal(detail.stats.redoDepth, 0);
    assert.ok(detail.rows.some((row) => row.status === 'modified'));

    // undo：撤销最后一条 entry
    const undoResult = parseJsonStdout(await runBashDb(dbPath, ['undo', '--base', docId, '--owner', owner]));
    assert.equal(undoResult.ok, true);
    assert.equal(undoResult.action, 'editBranch.undo');
    assert.equal(undoResult.changed, true);
    assert.equal(undoResult.branchId, branch.branchId);
    assert.equal(undoResult.baseDocId, docId);
    assert.equal(undoResult.undoDepth, 0, 'undo 后无生效 entry');
    assert.equal(undoResult.redoDepth, 1, 'undo 后有 1 条可 redo');
    assert.match(stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', owner])), /改:0\s+增:0\s+删:0\s+撤销:1/);
    // undo 后草稿投影回原值：diff 不再有 modified
    const afterUndo = parseJsonStdout(await runBashDb(dbPath, ['diff', '--base', docId, '--owner', owner, '--json']));
    assert.equal(afterUndo.stats.activeEntryCount, 0, 'undo 后 activeEntryCount 应为 0');

    // redo：恢复撤销的 entry
    const redoResult = parseJsonStdout(await runBashDb(dbPath, ['redo', '--base', docId, '--owner', owner]));
    assert.equal(redoResult.ok, true);
    assert.equal(redoResult.action, 'editBranch.redo');
    assert.equal(redoResult.changed, true);
    assert.equal(redoResult.undoDepth, 1);
    assert.equal(redoResult.redoDepth, 0);
    assert.match(stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', owner])), /改:1\s+增:0\s+删:0/);

    // 收尾 discard 清草稿（discard 行为本身在 draft.test.mjs 有专门 test）
    const discarded = parseJsonStdout(await runBashDb(dbPath, ['discard', '--base', docId, '--owner', owner, '--yes']));
    assert.equal(discarded.ok, true);
    assert.equal(discarded.changed, true);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', owner])), '(无草稿)');

    // 错误路径
    const undoNoTarget = await runBashDb(dbPath, ['undo'], { expectFailure: true });
    assert.match(undoNoTarget.stderr || undoNoTarget.stdout, /db undo requires --branch or --base/);

    const redoNoTarget = await runBashDb(dbPath, ['redo'], { expectFailure: true });
    assert.match(redoNoTarget.stderr || redoNoTarget.stdout, /db redo requires --branch or --base/);
  });
});

// switch：无参看当前选择（未选择/已选择），--base 设选择，错误路径。
test('db switch：无参看选择、--base 设选择、diff 缺目标报错', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    // 无参：未选择任何草稿
    const noSelection = stdoutOf(await runBashDb(dbPath, ['switch']));
    assert.equal(noSelection, '(未选择草稿)');

    // --base 设选择（草稿不存在时 branchId=null）
    const selectedBase = parseJsonStdout(await runBashDb(dbPath, ['switch', '--base', docId, '--owner', 'dbt-selected']));
    assert.equal(selectedBase.baseDocId, docId);
    assert.equal(String(selectedBase.owner).split('#')[0], 'dbt-selected');
    assert.ok(selectedBase.branchId === null, 'switch 到不存在的草稿时 branchId 为 null');

    // 错误路径：diff 缺目标
    const diffNoTarget = await runBashDb(dbPath, ['diff'], { expectFailure: true });
    assert.match(diffNoTarget.stderr || diffNoTarget.stdout, /db diff 需要 doc_id/);

    // 错误路径：discard 缺目标
    const discardNoTarget = await runBashDb(dbPath, ['discard'], { expectFailure: true });
    assert.match(discardNoTarget.stderr || discardNoTarget.stdout, /db discard requires --branch or --base/);
  });
});
