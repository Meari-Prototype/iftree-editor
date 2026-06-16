import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  alphaChangedText,
  modifyChangedText,
  modifyOriginalText,
  commitSingleTextChange,
  runBashDb,
  stdoutOf,
  withImportedFixture
} from './_helpers.mjs';

// 问题 1：节点级 log（git log <path>）。在不同地址各自提交，验证 log <docId> <address>
// 只列改动该地址子树的 commit、带 @author，并与文档级 log 对照；commit 现在带身份（owner）。
test('节点级 log：按子树/节点列改动该地址的 commit + author，文档级对照', { timeout: 240000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const c1 = await commitSingleTextChange(dbPath, docId, '1-1-6-1-1', modifyChangedText, 'llm', 'NH_A');
    const c2 = await commitSingleTextChange(dbPath, docId, '1-1-6-1-1', modifyOriginalText, 'llm', 'NH_B');
    // 另一个不相关地址改一次（owner=human），不应落进 1-1-6-1-1 的节点级 log。
    await commitSingleTextChange(dbPath, docId, '1-1-3-2-1', alphaChangedText, 'human', 'NH_OTHER');

    // 节点级 log（默认整棵子树）
    const nodeLog = stdoutOf(await runBashDb(dbPath, ['log', docId, '1-1-6-1-1']));
    assert.match(nodeLog, /整棵子树/);
    assert.match(nodeLog, new RegExp(`commit:${c1.history.commit_id}`));
    assert.match(nodeLog, new RegExp(`commit:${c2.history.commit_id}`));
    assert.match(nodeLog, /@llm/);
    assert.doesNotMatch(nodeLog, /NH_OTHER/);

    // 文档级 log：所有 commit + 两种身份都在
    const docLog = stdoutOf(await runBashDb(dbPath, ['log', docId]));
    assert.match(docLog, /NH_OTHER/);
    assert.match(docLog, /@human/);
    assert.match(docLog, /@llm/);

    // --node 只看本节点自身
    const nodeOnly = stdoutOf(await runBashDb(dbPath, ['log', docId, '1-1-6-1-1', '--node']));
    assert.match(nodeOnly, /本节点/);
    assert.match(nodeOnly, new RegExp(`commit:${c1.history.commit_id}`));

    // 不存在的地址应明确报错
    const missing = await runBashDb(dbPath, ['log', docId, '9-9-9'], { expectFailure: true });
    assert.match(missing.stderr || missing.stdout, /nodeHistory target not found/);
  });
});
