import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { runBashDb, withTempDb } from './_helpers.mjs';

// `--at` 是 parseFlags 的通用 flag，任何动词都能带上；但只有 tree / read / find 真去读历史快照
// （restore/revert 另有「按提交时间找 commit」的 ref 语义）。其余动词收下却不用 = 静默返回当前版本，
// 用户以为在看历史其实在看现值。这里钉死：不支持的动词必须当场报错。
//
// 拒绝发生在解析 flags 之后、取 doc 之前，所以用不存在的 doc id 也能验——不需要导入 fixture。
const REJECTING_VERBS = [
  ['inspect', ['inspect', 'doc-not-real', '1', '--at', '2026-01-01']],
  ['article', ['article', 'doc-not-real', '--at', '2026-01-01']],
  ['log', ['log', 'doc-not-real', '--at', '2026-01-01']],
  ['index', ['index', '--at', '2026-01-01']],
  ['diff', ['diff', 'doc-not-real', '--at', '2026-01-01']],
  ['revert', ['revert', 'commit-not-real', '--at', '2026-01-01']]
];

test('不支持 --at 的动词当场拒绝，不静默返回当前版本', { timeout: 120000 }, async () => {
  await withTempDb(async (dbPath) => {
    for (const [verb, args] of REJECTING_VERBS) {
      const result = await runBashDb(dbPath, args, { expectFailure: true });
      const output = `${result.stdout}\n${result.stderr}`;
      assert.match(output, /不支持 --at/, `db ${verb} 应当拒绝 --at，实际输出：${output}`);
    }
  });
});
