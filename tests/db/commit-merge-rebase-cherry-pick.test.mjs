import '../_assert-electron.mjs';
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

// rebase：刷新分支 lazy base 到当前 HEAD。fixture 导入已建初始 commit，故首次 rebase 的 baseCommitId 为该 HEAD commit（非 null）。
test('db rebase 刷新分支 base 到 HEAD，返回 changed/baseCommitId/undoDepth', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-rebase';
    const branch = await beginBranch(dbPath, docId, owner);
    await editSetText(dbPath, docId, '1-1-3-2-1', alphaChangedText, owner);

    const rebaseResult = parseJsonStdout(await runBashDb(dbPath, ['rebase', '--base', docId, '--owner', owner]));
    assert.equal(rebaseResult.ok, true);
    assert.equal(rebaseResult.changed, true);
    assert.equal(rebaseResult.action, 'editBranch.rebase');
    assert.equal(rebaseResult.baseDocId, docId);
    assert.equal(rebaseResult.branchId, branch.branchId);
    assert.equal(String(rebaseResult.owner).split('#')[0], owner);
    assert.match(String(rebaseResult.baseCommitId), /^019[a-f0-9-]+$/, '首次 rebase：fixture 导入已建初始 commit，baseCommitId 应为该 HEAD commit（UUIDv7）');
    assert.equal(rebaseResult.undoDepth, 1, 'rebase 后草稿有 1 条生效 entry');
    assert.equal(rebaseResult.redoDepth, 0);
    assert.ok(rebaseResult.branch?.id);

    // 错误路径：缺目标
    const rebaseNoTarget = await runBashDb(dbPath, ['rebase'], { expectFailure: true });
    assert.match(rebaseNoTarget.stderr || rebaseNoTarget.stdout, /db rebase requires --branch or --base/);
  });
});

// commit：快进（base==HEAD）落库生成 history，read 回查正文已变。
test('db commit 快进落库：applied/fastForward/history.commit_id(UUIDv7) + read 回查', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-commit';
    await beginBranch(dbPath, docId, owner);
    await editSetText(dbPath, docId, '1-1-3-2-1', alphaChangedText, owner);

    const commit = await commitBranch(dbPath, docId, owner, 'DBT_COMMIT_TEST');
    const commitId = String(commit.history.id);
    // commitBranch helper 已断言 ok/history.summary；补钉 commit 链路特有字段：
    assert.equal(commit.applied, true, '快进 commit 应 applied=true');
    assert.equal(commit.changed, true);
    assert.equal(commit.fastForward, true, 'base==HEAD 时应 fastForward=true');
    assert.equal(commit.baseDocId, docId);
    assert.equal(commit.history.doc_id, docId);
    assert.equal(commit.history.commit_id, commitId, 'commit_id 应与 history.id 同值');
    assert.ok(commit.history.saved_at, 'history 应有 saved_at（committed_at 别名）');
    assert.match(commitId, /^019[a-f0-9-]+$/, 'commit id 应是 UUIDv7');
    // 落库后 read 回查：正文已是改动版
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1'])), alphaChangedText);
  });
});

// cherry-pick + merge 链：先 commit 一个源、回退主干，再 cherry-pick 源 entry 到新分支、merge 落库。
// 这两个动词有依赖（cherry-pick 产物是 merge 的输入），放一起。
test('db cherry-pick 摘取 commit entry 入新分支，merge --yes 落库；dry-run 不落库', { timeout: 240000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    // 制造源 commit：改 alpha → changed 并提交
    const sourceOwner = 'dbt-pick-source';
    await beginBranch(dbPath, docId, sourceOwner);
    await editSetText(dbPath, docId, '1-1-3-2-1', alphaChangedText, sourceOwner);
    const sourceCommit = await commitBranch(dbPath, docId, sourceOwner, 'DBT_PICK_SOURCE');
    const sourceHistoryId = String(sourceCommit.history.id);

    // 回退主干：改回 original 并提交，让 cherry-pick 有用武之地
    await beginBranch(dbPath, docId, 'dbt-reset-before-pick');
    await editSetText(dbPath, docId, '1-1-3-2-1', alphaOriginalText, 'dbt-reset-before-pick');
    await commitBranch(dbPath, docId, 'dbt-reset-before-pick', 'DBT_RESET_BEFORE_PICK');
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1'])), alphaOriginalText);

    // cherry-pick 前：确保无残留 active 草稿（前两次 commit 已删草稿）
    assert.equal(stdoutOf(await runBashDb(dbPath, ['draft', 'list'])), '(无草稿)',
      'cherry-pick 前应无残留草稿，避免复用错草稿');

    // cherry-pick：从 source commit 摘取 entry[0] 写入新分支
    const picked = parseJsonStdout(await runBashDb(dbPath, [
      'cherry-pick', '--history', sourceHistoryId, '--target-base', docId,
      '--owner', 'dbt-picked-history', '--entry-index', '0'
    ]));
    assert.equal(picked.ok, true);
    assert.equal(picked.changed, true);
    assert.equal(picked.action, 'editBranch.cherryPick');
    assert.equal(picked.pickedCount, 1);
    assert.equal(picked.baseDocId, docId);
    assert.ok(picked.branchId, 'cherry-pick 应返回目标分支 id');
    assert.equal(typeof picked.branchId, 'number', 'branchId 是 INTEGER 主键');
    assert.equal(String(picked.owner).split('#')[0], 'dbt-picked-history');
    assert.equal(Array.isArray(picked.picked), true);
    assert.equal(picked.picked.length, 1);
    assert.ok(picked.picked[0].cherryPickedFrom, 'picked entry 应记录溯源信息');
    assert.equal(picked.picked[0].cherryPickedFrom.id, sourceHistoryId, '溯源应指向 source commit id');

    // merge dry-run：不带 --yes 只预览
    const mergeDryRun = stdoutOf(await runBashDb(dbPath, ['merge', '--base', docId, '--owner', 'dbt-picked-history']));
    assert.match(mergeDryRun, new RegExp(`would merge doc:${docId} owner:dbt-picked-history(?:#[\\d:T-]+)?; rerun with --yes to apply`));
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1'])), alphaOriginalText, '预览不落库');

    // merge --yes：落库
    const merged = parseJsonStdout(await runBashDb(dbPath, ['merge', '--base', docId, '--owner', 'dbt-picked-history', '--yes']));
    assert.equal(merged.ok, true);
    assert.equal(merged.applied, true);
    assert.equal(merged.changed, true);
    assert.equal(merged.baseDocId, docId);
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-3-2-1'])), alphaChangedText, '落库后正文已变');

    // 错误路径
    const mergeNoTarget = await runBashDb(dbPath, ['merge'], { expectFailure: true });
    assert.match(mergeNoTarget.stderr || mergeNoTarget.stdout, /db merge requires --branch or --base/);

    const cherryPickNoSource = await runBashDb(dbPath, ['cherry-pick', '--target-base', docId], { expectFailure: true });
    assert.match(cherryPickNoSource.stderr || cherryPickNoSource.stdout, /db cherry-pick requires --history or --source-branch/);
  });
});
