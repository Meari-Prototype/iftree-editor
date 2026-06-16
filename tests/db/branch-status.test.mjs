import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseBranchEntryCounts, formatBranchLine } from '../../src/backend/branch-status.mjs';

// 纯函数（不碰 DB）；但本项目统一用 electron 跑测试、禁用 node（见 ../_assert-electron.mjs）。问题 3：changes/branch list 此前只数笼统 active/undone，
// 现按 op-log kind 分类（改/增/删/移/其他），并标当前 switch 分支。

const branchWith = (entries, extra = {}) => ({
  id: 7,
  base_doc_id: 'doc-x',
  owner: 'llm',
  diff: JSON.stringify({ entries }),
  updated_at: '2026-06-15',
  ...extra
});

test('parseBranchEntryCounts：按 kind 分类，撤销单列、不计入 active', () => {
  const counts = parseBranchEntryCounts(branchWith([
    { kind: 'node.update' }, { kind: 'node.update' },
    { kind: 'node.insert' },
    { kind: 'node.move' },
    { kind: 'node.reparent' },
    { kind: 'axiom.add' },
    { kind: 'node.delete', status: 'undone' }
  ]));
  assert.equal(counts.update, 2);
  assert.equal(counts.insert, 1);
  assert.equal(counts.delete, 0);
  assert.equal(counts.move, 2); // node.move + node.reparent
  assert.equal(counts.other, 1); // axiom.add
  assert.equal(counts.undone, 1);
  assert.equal(counts.active, 6); // 全部非 undone
});

test('formatBranchLine：改/增/删常驻，移/其他/撤销有才显示', () => {
  const line = formatBranchLine(branchWith([{ kind: 'node.update' }, { kind: 'node.insert' }]));
  assert.match(line, /branch:7/);
  assert.match(line, /owner:llm/);
  assert.match(line, /改:1/);
  assert.match(line, /增:1/);
  assert.match(line, /删:0/);
  assert.doesNotMatch(line, /移:/);
  assert.doesNotMatch(line, /撤销:/);

  const withMove = formatBranchLine(branchWith([{ kind: 'node.move' }, { kind: 'node.delete', status: 'undone' }]));
  assert.match(withMove, /移:1/);
  assert.match(withMove, /撤销:1/);
});

test('formatBranchLine：current 标记当前 switch 分支', () => {
  const b = branchWith([{ kind: 'node.update' }]);
  assert.match(formatBranchLine(b, { current: 7 }), /^\* branch:7/);
  assert.doesNotMatch(formatBranchLine(b, { current: 9 }), /^\*/);
  assert.doesNotMatch(formatBranchLine(b), /^\*/);
});

test('空 / 坏 diff 不抛错', () => {
  assert.equal(parseBranchEntryCounts({}).active, 0);
  assert.equal(parseBranchEntryCounts({ diff: 'not json' }).active, 0);
  assert.match(formatBranchLine({ id: 1, base_doc_id: 'd', owner: 'human' }), /改:0\t增:0\t删:0/);
});
