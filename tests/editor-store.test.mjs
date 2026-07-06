import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  initialEditorState,
  beginTransition,
  endTransition,
  openConflict,
  setConflictApplying,
  closeConflict,
  lifecycleOf,
  beginHistoryOp,
  endHistoryOp,
  setStacks,
  pushUndoToken,
  rotateStacks
} from '../dist/src/frontend/stores/editor-store.js';
import { HISTORY_STACK_CAP } from '../dist/src/frontend/session/history-stack.js';

// 编辑生命周期状态机（frontend-refactor.md §4.5，按代码实况修正的模型）。
// 约定：非法转移返回原引用（store 层不广播），调用方以引用相等判断是否获准。

const ctx = { shadowDocId: 's1', baseDocId: 'b1', owner: 'human', sourceDoc: null };

test('lifecycle: idle 下 readonly/editing 由 hasBranch 派生（需求 8-3-2 单一真相）', () => {
  const state = initialEditorState();
  assert.equal(lifecycleOf(state, false), 'readonly');
  assert.equal(lifecycleOf(state, true), 'editing');
});

test('lifecycle: beginTransition 仅 idle 可进，过渡中重复触发被拒（双击 race 守卫）', () => {
  const s0 = initialEditorState();
  const entering = beginTransition(s0, 'entering');
  assert.equal(entering.phase.kind, 'entering');
  assert.equal(lifecycleOf(entering, false), 'entering');

  // 双击第二发：entering 中再 begin（entering 或 leaving）都返回原引用。
  assert.equal(beginTransition(entering, 'entering'), entering);
  assert.equal(beginTransition(entering, 'leaving'), entering);

  const back = endTransition(entering);
  assert.equal(back.phase.kind, 'idle');
  assert.equal(endTransition(back), back); // idle 下 endTransition 无操作
});

test('lifecycle: leaving → conflict → (人裁刷新)conflict → close 回 idle', () => {
  const leaving = beginTransition(initialEditorState(), 'leaving');
  assert.equal(lifecycleOf(leaving, true), 'leaving');

  // ⑧/⑨：save & !applied 开冲突面板（携带 view/ctx）。
  const view1 = { conflicts: [1] };
  const conflict = openConflict(leaving, view1, ctx);
  assert.equal(conflict.phase.kind, 'conflict');
  assert.equal(conflict.phase.view, view1);
  assert.equal(conflict.phase.ctx, ctx);
  assert.equal(conflict.phase.applying, false);

  // leaving 未带 ctx 开冲突：拒绝（防丢上下文）。
  assert.equal(openConflict(leaving, view1), leaving);

  // 面板内在途标志（连点守卫）。
  const applying = setConflictApplying(conflict, true);
  assert.equal(applying.phase.applying, true);

  // ⑩：人裁仍 !applied → 刷新 view、复位 applying，ctx 沿用。
  const view2 = { conflicts: [2] };
  const refreshed = openConflict(applying, view2);
  assert.equal(refreshed.phase.kind, 'conflict');
  assert.equal(refreshed.phase.view, view2);
  assert.equal(refreshed.phase.ctx, ctx);
  assert.equal(refreshed.phase.applying, false);

  // ⑪⑫⑬⑭：关面板回 idle；readonly 还是 editing 由 hasBranch 派生。
  const closed = closeConflict(refreshed);
  assert.equal(closed.phase.kind, 'idle');
  assert.equal(lifecycleOf(closed, true), 'editing');   // 取消保留分支
  assert.equal(lifecycleOf(closed, false), 'readonly'); // 裁决/放弃成功后分支已清
});

test('lifecycle: conflict 观察投影按 isBlockedView 区分 mergeConflict/blocked', () => {
  const conflict = openConflict(beginTransition(initialEditorState(), 'leaving'), { blocked: true }, ctx);
  assert.equal(lifecycleOf(conflict, true, (view) => Boolean(view?.blocked)), 'blocked');
  assert.equal(lifecycleOf(conflict, true, (view) => !view?.blocked), 'mergeConflict');
  assert.equal(lifecycleOf(conflict, true), 'mergeConflict'); // 未注入判别时按可裁冲突
});

test('lifecycle: conflict 中 beginTransition 被拒（冲突面板悬停时不得再离场/进场）', () => {
  const conflict = openConflict(beginTransition(initialEditorState(), 'leaving'), {}, ctx);
  assert.equal(beginTransition(conflict, 'leaving'), conflict);
  assert.equal(beginTransition(conflict, 'entering'), conflict);
  // idle 下 openConflict / setConflictApplying / closeConflict 均无操作。
  const idle = initialEditorState();
  assert.equal(openConflict(idle, {}, ctx), idle);
  assert.equal(setConflictApplying(idle, true), idle);
  assert.equal(closeConflict(idle), idle);
});

test('history: in-flight 重入锁（Ctrl+Z 连发守卫）', () => {
  const s0 = initialEditorState();
  const locked = beginHistoryOp(s0);
  assert.equal(locked.historyOpInFlight, true);
  assert.equal(beginHistoryOp(locked), locked); // 重入被拒：原引用
  const released = endHistoryOp(locked);
  assert.equal(released.historyOpInFlight, false);
  assert.equal(endHistoryOp(released), released);
});

test('history: pushUndoToken 封顶挤出最旧条目并上报 evicted', () => {
  let state = initialEditorState();
  state = setStacks(state, Array.from({ length: HISTORY_STACK_CAP }, (_, i) => `t${i}`), []);
  const { state: next, evicted } = pushUndoToken(state, 'fresh');
  assert.equal(next.undoStack.length, HISTORY_STACK_CAP);
  assert.deepEqual(evicted, ['t0']);
  assert.equal(next.undoStack[next.undoStack.length - 1], 'fresh');
});

test('history: rotateStacks 撤销出栈顶、逆 token 入对面栈；重做对称', () => {
  let state = setStacks(initialEditorState(), ['u1', 'u2'], ['r1']);

  const undone = rotateStacks(state, 'undo', 'inv-u2');
  assert.deepEqual(undone.state.undoStack, ['u1']);
  assert.deepEqual(undone.state.redoStack, ['r1', 'inv-u2']);
  assert.deepEqual(undone.evicted, []);

  const redone = rotateStacks(undone.state, 'redo', 'inv-r');
  assert.deepEqual(redone.state.redoStack, ['r1']);
  assert.deepEqual(redone.state.undoStack, ['u1', 'inv-r']);
});
