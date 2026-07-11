import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatThreeWayMergeText } from '../../dist/src/backend/text/merge-text.js';

// formatThreeWayMergeText 是纯函数：把三方合并预览折叠成人读文本——未改节点折叠进计数行、
// 只列有裁决/冲突的节点。覆盖三类：无冲突可落库、有冲突待裁、非预览形状回退裸 JSON。

test('merge 预览：折叠未改、列出改动、无冲突给落库提示', () => {
  const res = {
    fastForward: false,
    hasConflicts: false,
    nodes: [
      { id: 'n1', address: '1-1', resolution: 'unchanged', title: 'A' },
      { id: 'n2', address: '1-2', resolution: 'unchanged', title: 'B' },
      { id: 'n3', address: '1-3', resolution: 'modified', title: '改了的标题' },
      { id: 'n4', address: '1-4', resolution: 'added', title: '新增' }
    ],
    conflicts: []
  };
  const out = formatThreeWayMergeText(res);
  assert.match(out, /\[merge 预览 三方\]/);
  assert.match(out, /改:1/);
  assert.match(out, /增:1/);
  assert.match(out, /未改 2 折叠/);
  // 改动节点列出、未改节点折叠不列
  assert.match(out, /1-3 改/);
  assert.doesNotMatch(out, /1-1/);
  assert.doesNotMatch(out, /1-2/);
  assert.match(out, /无冲突，yes=true 可直接落库/);
});

test('merge 预览：有冲突列出 ours/theirs 待裁', () => {
  const res = {
    fastForward: false,
    hasConflicts: true,
    nodes: [
      { id: 'n1', address: '1-1', resolution: 'unchanged', title: 'A' },
      { id: 'n2', address: '1-2', resolution: 'conflict', title: '冲突节点' }
    ],
    conflicts: [
      { id: 'n2', address: '1-2', field: 'text', ours: '正文这边', theirs: '草稿那边' }
    ]
  };
  const out = formatThreeWayMergeText(res);
  assert.match(out, /·有冲突/);
  assert.match(out, /冲突:1/);
  assert.match(out, /! 1-2 冲突/); // 冲突节点带 ! 标
  assert.match(out, /冲突待裁 1 条/);
  assert.match(out, /\[text\]/);
  assert.match(out, /正文这边/);
  assert.match(out, /草稿那边/);
});

test('merge 预览：非预览形状回退裸 JSON、不抛错', () => {
  assert.doesNotThrow(() => formatThreeWayMergeText(null));
  assert.equal(formatThreeWayMergeText({ ok: true }), JSON.stringify({ ok: true }, null, 2));
});

// 冲突值差异感知截断（clipConflictPair）：长公共前缀 + 差异在尾部时，从头狠截会把两侧
// 截成一模一样、无法凭回执裁决——窗口须跳过公共前缀，让分叉点两侧都可见。
test('merge 预览：冲突值差异在尾部时截断后分叉点仍可见', () => {
  const commonPrefix = '这是一段很长的公共前缀正文内容，'.repeat(10); // 160 字，远超 120 窗口
  const res = {
    fastForward: false,
    hasConflicts: true,
    nodes: [
      { id: 'n1', address: '1-1', resolution: 'conflict', title: '冲突节点' }
    ],
    conflicts: [
      { id: 'n1', address: '1-1', field: 'text', ours: `${commonPrefix}ours-tail-value`, theirs: `${commonPrefix}theirs-tail-value` }
    ]
  };
  const out = formatThreeWayMergeText(res);
  assert.match(out, /ours-tail-value/, 'ours 的差异尾部应落在窗口内');
  assert.match(out, /theirs-tail-value/, 'theirs 的差异尾部应落在窗口内');
  assert.match(out, /ours=…/, '跳过的公共前缀应折叠为省略号');
  // 短冲突值（≤120）不受影响：原样全显、无省略号
  const short = formatThreeWayMergeText({
    fastForward: false,
    hasConflicts: true,
    nodes: [{ id: 'n2', address: '1-2', resolution: 'conflict', title: 'X' }],
    conflicts: [{ id: 'n2', address: '1-2', field: 'text', ours: '正文这边', theirs: '草稿那边' }]
  });
  assert.match(short, /ours=正文这边 \| theirs=草稿那边/);
});
