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

test('db diff 详略轴（summary/full）与 refA↔refB（--from/--to）', { timeout: 240000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-diff2';
    const branch = await beginBranch(dbPath, docId, owner);
    await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText, owner);

    // 详略 summary：草稿↔正文出改增删移计数行、不出 old→new 正文。
    const summary = stdoutOf(await runBashDb(dbPath, ['diff', '--base', docId, '--owner', owner, '--detail', 'summary']));
    assert.match(summary, /改:1 增:0 删:0/);
    assert.doesNotMatch(summary, /new-diff-text/);

    // 详略 full（默认）：出逐行 old→new 正文。
    const full = stdoutOf(await runBashDb(dbPath, ['diff', '--base', docId, '--owner', owner]));
    assert.match(full, /new-diff-text/);

    // refA↔refB：head(正文) ↔ draft(该草稿)，走 diff.refs，见同一处 text 改动（new 含改后正文）。
    const refDiff = parseJsonStdout(await runBashDb(dbPath, ['diff', docId, '--from', 'head', '--to', `draft:${branch.branchId}`, '--json']));
    assert.equal(refDiff.kind, 'diff.refs');
    assert.ok(refDiff.entries.some((e) => e.field === 'text' && String(e.new || '').includes('new-diff-text')));

    // 方向对调：draft ↔ head，old/new 互换。
    const refRev = parseJsonStdout(await runBashDb(dbPath, ['diff', docId, '--from', `draft:${branch.branchId}`, '--to', 'head', '--json']));
    assert.ok(refRev.entries.some((e) => e.field === 'text' && String(e.old || '').includes('new-diff-text')));
  });
});
