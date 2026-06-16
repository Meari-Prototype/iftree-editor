import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginBranch,
  commitBranch,
  commitSingleTextChange,
  editDelete,
  editInsert,
  runBashDb,
  stdoutOf,
  withImportedFixture
} from './_helpers.mjs';

// 激进路线：read/tree --at 默认按稳定 node_id 穿透（认人不认位置）；--at-address 退回
// git <commit>:<path> 的按历史地址语义，供查已删节点或纯「那个版本那个位置」。
test('read --at 默认按身份穿透 + --at-address 退回历史地址', { timeout: 240000 }, async () => {
  await withImportedFixture(async ({ dbPath, docId }) => {
    const owner = 'dbt-follow';

    // —— A. 地址漂移：节点换了地址，按它「当前」的地址 --at 仍认得它 ——
    const v1 = await commitSingleTextChange(dbPath, docId, '1-1-6-1-1', 'FOLLOW_TARGET_BODY', owner, 'FV1');
    const v1ref = String(v1.history.commit_id);

    // 在目标处插一个兄弟、提交 V2，可能把目标挤到相邻新地址
    await beginBranch(dbPath, docId, owner);
    await editInsert(dbPath, docId, '1-1-6-1-1', 'sibling', 'FOLLOW_SIBLING_NODE', owner);
    await commitBranch(dbPath, docId, owner, 'FV2');

    // 目标（FOLLOW_TARGET_BODY）现在落在 1-1-6-1-1 还是被挤到 1-1-6-1-2？读当前正文判断
    const at1 = stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-1-1', '--range', 'node']));
    const curAddr = at1.includes('FOLLOW_TARGET_BODY') ? '1-1-6-1-1' : '1-1-6-1-2';

    // 用目标的「当前」地址 --at V1：按身份穿透回它在 V1 的正文（不论 V1 时它在哪个地址）
    assert.match(
      stdoutOf(await runBashDb(dbPath, ['read', docId, curAddr, '--at', v1ref, '--range', 'node'])),
      /FOLLOW_TARGET_BODY/
    );
    // 若确实漂移了，--at-address 拿当前地址会落到 V1 里那个位置——不是目标节点
    if (curAddr !== '1-1-6-1-1') {
      const byAddr = await runBashDb(dbPath, ['read', docId, curAddr, '--at', v1ref, '--at-address', '--range', 'node'], { expectFailure: true });
      assert.match(byAddr.stderr || byAddr.stdout, /not found/);
    }

    // —— B. 已删节点：按身份报错引导、--at-address 从历史按地址找回 ——
    await beginBranch(dbPath, docId, owner);
    await editDelete(dbPath, docId, '1-1-6-3-1', owner); // DBT_DIFF_DELETE_TARGET，FV1 快照里仍在
    await commitBranch(dbPath, docId, owner, 'FV3_DELETE');

    // 默认按身份：当前已无该地址 → 明确报错并引导 --at-address，而非静默命中同址别的节点
    const byId = await runBashDb(dbPath, ['read', docId, '1-1-6-3-1', '--at', v1ref, '--range', 'node'], { expectFailure: true });
    assert.match(byId.stderr || byId.stdout, /当前文档无地址|at-address/);

    // --at-address：在 V1 快照里按历史地址找回已删节点
    assert.match(
      stdoutOf(await runBashDb(dbPath, ['read', docId, '1-1-6-3-1', '--at', v1ref, '--at-address', '--range', 'node'])),
      /DBT_DIFF_DELETE_TARGET/
    );
  });
});
