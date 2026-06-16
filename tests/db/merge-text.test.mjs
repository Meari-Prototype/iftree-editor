import '../_assert-electron.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { formatThreeWayMergeText } from '../../src/backend/merge-text.mjs';

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
