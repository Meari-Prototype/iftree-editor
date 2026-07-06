// editorStore：编辑生命周期状态机 + undo/redo 两栈（frontend-refactor.md §4.3/§4.5/§4.6）。
// 纯 TS 转移函数（state → state），可 node --test；非法转移返回原引用（store 不广播）。
//
// 与 §4.5 状态图的对应（实现时按代码实况修正的模型，修正点见 §7 核对记录）：
// - readonly/editing 两个稳定态**派生**自「当前文档是否持有编辑分支」（需求 8-3-2：编辑模式
//   = 持有编辑分支标识，不另设独立开关）——状态机不复制这份真相，branch 数据仍归 docMeta。
// - entering/leaving/conflict 三个非稳定态**显式**存这里，取代原 editModeTransitionRef 整把锁：
//   「处于过渡态即拒绝新的 enter/leave」这一条守卫从结构上消灭双击重复 beginEditBranch、
//   连点连发 applyMerge 两个 race。
// - mergeConflict 与 blocked 在实现层是同一个冲突面板（字段级/结构级之分在后端返回的 view
//   内容里），建模为单一 conflict 态携带 view/ctx；6 态视图经 lifecycleOf 投影给调用方。
// - undo/redo 与生命周期正交（readonly 下也有 editor snapshot 栈），重入锁是独立的
//   historyOpInFlight（取代 historyOpInFlightRef），不进 phase。
//
// 两栈条目（命令栈条目，§4.6）：editor snapshot token（id 形如 'editor-N'，后端持全量快照，
// 弹出/挤出须通知后端释放）或 edit branch diff entry（后端 diff 的投影，无需释放）。
// 条目形态由 history-stack.ts 与命令层管，这里只持栈本身。

import { pushCapped } from '../session/history-stack.js';

export interface MergeConflictContext {
  shadowDocId: string | null;
  baseDocId: string | null;
  owner: string;
  // 进入冲突时的源文档投影。现状 switchDocPreservingView 的 _sourceDoc 形参未使用，
  // 但 ctx 结构与原 mergeConflictDialog.ctx 保持同形，避免行为漂移。
  sourceDoc: unknown;
}

export type EditorPhase =
  | { kind: 'idle' }
  | { kind: 'entering' }
  | { kind: 'leaving' }
  | { kind: 'conflict'; view: unknown; ctx: MergeConflictContext; applying: boolean; error: string };

export interface EditorState {
  phase: EditorPhase;
  undoStack: unknown[];
  redoStack: unknown[];
  historyOpInFlight: boolean;
}

export function initialEditorState(): EditorState {
  return {
    phase: { kind: 'idle' },
    undoStack: [],
    redoStack: [],
    historyOpInFlight: false
  };
}

// ─── 生命周期转移（非法转移返回原引用 = 拒绝，调用方以引用相等判断是否获准） ───

// idle → entering/leaving。过渡态或冲突态中再次触发一律拒绝（原 editModeTransitionRef 的守卫）。
export function beginTransition(state: EditorState, kind: 'entering' | 'leaving'): EditorState {
  if (state.phase.kind !== 'idle') return state;
  return { ...state, phase: { kind } };
}

// entering/leaving → idle（成功或失败都回 idle；readonly 还是 editing 由 editBranch 派生）。
export function endTransition(state: EditorState): EditorState {
  if (state.phase.kind !== 'entering' && state.phase.kind !== 'leaving') return state;
  return { ...state, phase: { kind: 'idle' } };
}

// leaving → conflict（save & !applied，转移 ⑧/⑨）；conflict → conflict（人裁仍 !applied，
// 转移 ⑩：applyMergeResolutions 刷新冲突视图，ctx 不变则沿用）。
export function openConflict(state: EditorState, view: unknown, ctx?: MergeConflictContext): EditorState {
  if (state.phase.kind === 'leaving') {
    if (!ctx) return state;
    return { ...state, phase: { kind: 'conflict', view, ctx, applying: false, error: '' } };
  }
  if (state.phase.kind === 'conflict') {
    return { ...state, phase: { ...state.phase, view, applying: false, error: '' } };
  }
  return state;
}

// conflict 面板内的在途标志（人裁应用 / 放弃分支进行中，禁重复提交）。
export function setConflictApplying(state: EditorState, applying: boolean, error = ''): EditorState {
  if (state.phase.kind !== 'conflict') return state;
  return { ...state, phase: { ...state.phase, applying, error } };
}

// conflict → idle：⑪⑬（裁决/放弃成功，随后由 editBranch 清空派生回 readonly）
// 或 ⑫⑭（取消保留分支，editBranch 仍在 → 派生回 editing）。
export function closeConflict(state: EditorState): EditorState {
  if (state.phase.kind !== 'conflict') return state;
  return { ...state, phase: { kind: 'idle' } };
}

// ─── 6 态观察投影（§4.5 状态图的视图；hasBranch = Boolean(currentDoc?.editBranch)） ───

export type EditorLifecycle = 'readonly' | 'entering' | 'editing' | 'leaving' | 'mergeConflict' | 'blocked';

export function lifecycleOf(state: EditorState, hasBranch: boolean, isBlockedView?: (view: unknown) => boolean): EditorLifecycle {
  switch (state.phase.kind) {
    case 'entering': return 'entering';
    case 'leaving': return 'leaving';
    case 'conflict': return isBlockedView?.(state.phase.view) ? 'blocked' : 'mergeConflict';
    default: return hasBranch ? 'editing' : 'readonly';
  }
}

// ─── undo/redo 栈与重入锁 ───

export function beginHistoryOp(state: EditorState): EditorState {
  if (state.historyOpInFlight) return state;
  return { ...state, historyOpInFlight: true };
}

export function endHistoryOp(state: EditorState): EditorState {
  if (!state.historyOpInFlight) return state;
  return { ...state, historyOpInFlight: false };
}

// 整栈替换（syncEditBranchHistoryStacks / clear 用）。
export function setStacks(state: EditorState, undoStack: unknown[], redoStack: unknown[]): EditorState {
  return { ...state, undoStack, redoStack };
}

// 封顶入栈。evicted 是被挤出的最旧条目，调用方负责通知后端释放快照（history-stack.ts 契约）。
export function pushUndoToken(state: EditorState, token: unknown): { state: EditorState; evicted: unknown[] } {
  const { stack, evicted } = pushCapped(state.undoStack, token);
  return { state: { ...state, undoStack: stack }, evicted };
}

export function pushRedoToken(state: EditorState, token: unknown): { state: EditorState; evicted: unknown[] } {
  const { stack, evicted } = pushCapped(state.redoStack, token);
  return { state: { ...state, redoStack: stack }, evicted };
}

// 撤销/重做各自的出栈 + 入对面栈（restoreEditorSnapshot 成功后的栈轮转）。
export function rotateStacks(state: EditorState, direction: 'undo' | 'redo', inverseToken: unknown): { state: EditorState; evicted: unknown[] } {
  if (direction === 'undo') {
    const { stack, evicted } = pushCapped(state.redoStack, inverseToken);
    return { state: { ...state, undoStack: state.undoStack.slice(0, -1), redoStack: stack }, evicted };
  }
  const { stack, evicted } = pushCapped(state.undoStack, inverseToken);
  return { state: { ...state, redoStack: state.redoStack.slice(0, -1), undoStack: stack }, evicted };
}
