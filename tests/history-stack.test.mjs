import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pushCapped,
  isUndoneEditBranchEntry,
  editBranchUndoEntries,
  editBranchRedoEntries,
  snapshotTokenIds,
  HISTORY_STACK_CAP
} from '../dist/src/frontend/session/history-stack.js';

test('pushCapped：未满不挤出、满后封顶挤掉最旧（evicted 交调用方释放）', () => {
  let stack = [];
  for (let i = 0; i < HISTORY_STACK_CAP; i += 1) {
    const r = pushCapped(stack, `t${i}`);
    stack = r.stack;
    assert.equal(r.evicted.length, 0, '未超 cap 不挤出');
  }
  assert.equal(stack.length, HISTORY_STACK_CAP, '正好填满 cap');

  const r = pushCapped(stack, 'overflow');
  assert.equal(r.stack.length, HISTORY_STACK_CAP, '封顶不超 cap');
  assert.deepEqual(r.evicted, ['t0'], '挤出最旧的一个');
  assert.equal(r.stack[r.stack.length - 1], 'overflow', '新 token 落栈顶');
  assert.equal(r.stack[0], 't1', '次旧的成为新栈底');
});

test('editBranch 双轨过滤：undo=未撤销正序、redo=已撤销按 undoneAt 升序', () => {
  const entries = [
    { id: 'a', createdAt: '1' },
    { id: 'b', createdAt: '2', status: 'undone', undoneAt: '5' },
    { id: 'c', createdAt: '3' },
    { id: 'd', createdAt: '4', status: 'undone', undoneAt: '4' }
  ];
  assert.deepEqual(editBranchUndoEntries(entries).map((e) => e.id), ['a', 'c'], 'undo 留 status!=undone');
  assert.deepEqual(editBranchRedoEntries(entries).map((e) => e.id), ['d', 'b'], 'redo 按 undoneAt 升序');
  assert.equal(isUndoneEditBranchEntry({ status: 'undone' }), true);
  assert.equal(isUndoneEditBranchEntry({ status: 'active' }), false);
  assert.equal(isUndoneEditBranchEntry({}), false, '默认 active');
});

test('snapshotTokenIds：只留 editor- 前缀（editBranch diff entry 靠前缀挡掉）', () => {
  const tokens = [{ id: 'editor-1' }, { id: 'diff-2' }, { id: 'editor-3' }, { id: null }];
  assert.deepEqual(snapshotTokenIds(tokens, (t) => t?.id), ['editor-1', 'editor-3']);
});
