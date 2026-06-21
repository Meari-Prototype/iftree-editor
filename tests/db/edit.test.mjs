import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginBranch,
  editDelete,
  editInsert,
  editSetText,
  modifyChangedText,
  modifyOriginalText,
  parseJsonStdout,
  runBashDb,
  stdoutOf,
  withImportedFixture
} from './_helpers.mjs';

test('db edit records set, insert, and delete entries on a real edit branch and rejects bad edits', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-edit';
    const branch = await beginBranch(dbPath, docId, owner);
    assert.ok(branch.branchId, 'draft new 应返回 branch.id');

    // —— node.update：草稿路径返回 {ok,changed,docId,node,editBranch,refresh:{kind:'node'}} ——
    const setResult = await editSetText(dbPath, docId, '1-1-6-1-1', modifyChangedText, owner);
    assert.equal(setResult.ok, true);
    assert.equal(setResult.changed, true);
    assert.equal(setResult.action, 'node.update');
    assert.equal(setResult.docId, docId);
    assert.equal(setResult.refresh.kind, 'node');
    assert.ok(setResult.node?.id, 'node.update 应返回被改节点 id');
    assert.match(setResult.node.id, /^019[a-f0-9-]+$/, 'node.update 的 node.id 应是真实节点 UUIDv7（非 tmp）');
    assert.equal(setResult.node.address, '1-1-6-1-1', 'node.update 应返回被改节点当前地址');
    assert.equal(setResult.editBranch.id, branch.branchId);
    assert.equal(setResult.editBranch.base_doc_id, docId);
    assert.equal(setResult.editBranch.owner, owner);
    assert.equal(setResult.editBranch.status, 'active');
    assert.equal(setResult.skipDocsRefresh, true);

    // —— node.insert child：返回 insertedNodeId + node + editBranch ——
    const childResult = await editInsert(dbPath, docId, '1-1-6-2', 'child', 'DBT_EDIT_INSERT_CHILD', owner);
    assert.equal(childResult.ok, true);
    assert.equal(childResult.changed, true);
    assert.equal(childResult.action, 'node.insert');
    assert.equal(childResult.refresh.kind, 'doc');
    assert.ok(childResult.insertedNodeId, 'node.insert 应返回 insertedNodeId');
    assert.equal(childResult.node.id, childResult.insertedNodeId);
    assert.equal(childResult.node.text, 'DBT_EDIT_INSERT_CHILD');
    assert.equal(childResult.editBranch.id, branch.branchId);

    // —— node.insert sibling：插在目标节点后，新节点 parentId == 目标 parentId ——
    const siblingResult = await editInsert(dbPath, docId, '1-1-6-2', 'sibling', 'DBT_EDIT_INSERT_SIBLING', owner);
    assert.equal(siblingResult.ok, true);
    assert.equal(siblingResult.changed, true);
    assert.ok(siblingResult.insertedNodeId);
    assert.equal(siblingResult.node.text, 'DBT_EDIT_INSERT_SIBLING');
    assert.notEqual(siblingResult.insertedNodeId, childResult.insertedNodeId, '两次 insert 应生成不同节点 id');

    // —— node.delete：返回 changed + editBranch ——
    const deleteResult = await editDelete(dbPath, docId, '1-1-6-3-1', owner);
    assert.equal(deleteResult.ok, true);
    assert.equal(deleteResult.changed, true);
    assert.equal(deleteResult.action, 'node.delete');
    assert.equal(deleteResult.editBranch.id, branch.branchId);

    // —— 草稿计数：改1 增2 删1（owner 过滤、未提交时仍在）——
    const changes = stdoutOf(await runBashDb(dbPath, ['draft', 'list', docId, '--owner', owner]));
    assert.match(changes, new RegExp(`branch:${branch.branchId}\\s+doc:${docId}\\s+owner:${owner}\\s+改:1\\s+增:2\\s+删:1`));

    // —— diff --json：4 条 entries，1 modified / 2 added / 1 deleted，branch/mergeBase/stats 齐全 ——
    const diff = parseJsonStdout(await runBashDb(dbPath, ['diff', '--base', docId, '--owner', owner, '--json']));
    assert.equal(diff.branch.id, branch.branchId);
    assert.equal(diff.stats.activeEntryCount, 4);
    assert.equal(diff.stats.undoneEntryCount, 0);
    assert.equal(diff.stats.undoDepth, 4);
    assert.equal(diff.stats.redoDepth, 0);
    assert.equal(diff.mergeBase.isFastForward, true);
    assert.equal(diff.mergeBase.baseCommitId, diff.mergeBase.currentHeadCommitId);
    const statuses = diff.rows.map((row) => row.status).sort();
    assert.deepEqual(statuses, ['added', 'added', 'deleted', 'modified']);
    // entries：4 条 field-diff，每条含 node_id/field/old/new，至少 1 条 field=text（update）、2 条 field='*'（insert）、1 条 field='*'（delete）
    assert.equal(diff.entries.length, 4);
    const fields = diff.entries.map((e) => e.field).sort();
    assert.deepEqual(fields, ['*', '*', '*', 'text'], '4 条 entries: 1 改(text) + 2 增(*) + 1 删(*)');
    assert.ok(diff.entries.every((e) => e.node_id, '每条 entry 应含 node_id'));

    // —— 未提交：正文仍是原值（草稿不落主库）——
    assert.equal(stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1'])), modifyOriginalText);

    // —— 错误路径：不支持的字段 ——
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

    // —— 错误路径：insert mode 非 child/sibling ——
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

    // —— 错误路径：--set text 缺 value ——
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

    // —— 错误路径：insert 缺 text ——
    const missingInsertText = await runBashDb(dbPath, [
      'edit',
      docId,
      '1-1-6-2',
      '--insert',
      'child',
      '--base',
      docId,
      '--owner',
      owner
    ], { expectFailure: true });
    assert.match(missingInsertText.stderr || missingInsertText.stdout, /db edit --insert requires text/);
  });
});

// node_type 通过 --set 落库：中文标签归一化为内部码（文本/如果/那么/.../人工-阻塞/人工-汇总）。
// trust_level 不再是 edit 可设字段——走 human 档 certify；这里钉死 edit 拒收 trust_level。
test('db edit --set node_type 归一化中文标签，--set trust_level 被拒', { timeout: 180000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-edit-type';
    await beginBranch(dbPath, docId, owner);

    const typeResult = parseJsonStdout(await runBashDb(dbPath, [
      'edit', docId, '1-1-6-1-1', '--set', 'node_type', '如果', '--base', docId, '--owner', owner
    ]));
    assert.equal(typeResult.ok, true);
    assert.equal(typeResult.changed, true);
    assert.equal(typeResult.node.node_type, 'IF', '中文标签「如果」归一化为内部码 IF');

    const blockedTrust = await runBashDb(dbPath, [
      'edit', docId, '1-1-6-1-1', '--set', 'trust_level', '受控', '--base', docId, '--owner', owner
    ], { expectFailure: true });
    // trust_level 字段名被 db-shell 认识（在 --set 白名单），但落到 store 的 patch 校验时被拒：
    // 标受控走 human 档 certify，不进 edit branch（projectneed 18-3）。
    assert.match(blockedTrust.stderr || blockedTrust.stdout, /no longer supports trust_level|use human certify/);
  });
});
