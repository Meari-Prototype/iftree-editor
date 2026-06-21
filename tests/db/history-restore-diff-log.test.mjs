import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  modifyChangedText,
  modifyOriginalText,
  commitSingleTextChange,
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
    const commitRef = String(commit.history.commit_id);
    // commit 返回结构：history 含 commit_id（=id）/saved_at/summary/doc_id；快进、applied
    assert.equal(commit.applied, true);
    assert.equal(commit.fastForward, true);
    assert.equal(commit.history.id, commitRef);
    assert.equal(commit.history.doc_id, docId);
    assert.ok(commit.history.saved_at, 'history 应有 saved_at');
    assert.match(commitRef, /^019[a-f0-9-]+$/, 'commit id 应是 UUIDv7');

    // —— log：文档级，commit 行格式 commit:ID time @author summary ——
    const logText = stdoutOf(await runBashDb(dbPath, ['log', docId, '--limit', '5']));
    assert.match(logText, new RegExp(`commit:${commitRef}.*@dbt-history.*DBT_HISTORY_APPLY`));
    assert.ok(logText.split(/\r?\n/).length >= 1, 'log 至少一行');

    // —— diff（跨 commit）：文本形态，含改/old 正文 ——
    const diffText = stdoutOf(await runBashDb(dbPath, ['diff', docId, commitRef]));
    assert.match(diffText, /改/);
    assert.match(diffText, /old-diff-text/);

    // —— read --at commitRef：读历史快照正文（不写回当前库）——
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1', '--at', commitRef])), modifyChangedText);

    // —— 再提交一次回退正文，制造两个 commit ——
    const resetCommit = await commitSingleTextChange(
      dbPath,
      docId,
      '1-1-6-1-1',
      modifyOriginalText,
      'dbt-history-reset',
      'DBT_HISTORY_RESET'
    );
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyOriginalText);
    // 当前 HEAD 是 reset commit，log 应列出两条、且 reset 在前（按 committed_at DESC）
    const log2 = stdoutOf(await runBashDb(dbPath, ['log', docId]));
    assert.match(log2, new RegExp(`commit:${resetCommit.history.commit_id}.*DBT_HISTORY_RESET`));
    assert.match(log2, new RegExp(`commit:${commitRef}.*DBT_HISTORY_APPLY`));

    // —— restore：回滚到第一个 commit，正文恢复成改动版（git reset 语义）——
    // restore 走 formatWriteResult：输出 restore 头 + doc:ID + 历史 N 条；不含 commit: 前缀行。
    const restored = stdoutOf(await runBashDb(dbPath, ['restore', commitRef]));
    assert.match(restored, /^restore\b/);
    assert.match(restored, new RegExp(`doc:${docId}`));
    // restore 落库验证：read 回查正文已回到第一个 commit 的改动版
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyChangedText);
    // HEAD 已指向被 restore 的 commit：log 第一条应是它
    const logAfterRestore = stdoutOf(await runBashDb(dbPath, ['log', docId, '--limit', '1']));
    assert.match(logAfterRestore, new RegExp(`commit:${commitRef}.*DBT_HISTORY_APPLY`));

    // —— 错误路径 ——
    const missingLogDoc = await runBashDb(dbPath, ['log'], { expectFailure: true });
    assert.match(missingLogDoc.stderr || missingLogDoc.stdout, /db log requires doc_id/);

    const missingDiffHistory = await runBashDb(dbPath, ['diff', docId], { expectFailure: true });
    assert.match(missingDiffHistory.stderr || missingDiffHistory.stdout, /db diff requires history id/);

    const missingRestoreRef = await runBashDb(dbPath, ['restore'], { expectFailure: true });
    assert.match(missingRestoreRef.stderr || missingRestoreRef.stdout, /history ref requires history id, saved_at, or tag/);
  });
});
