// editorCommands：编辑生命周期 + history 两栈 + write pipeline（frontend-refactor.md §4.4 阶段 1）。
// 逻辑自 AppBody 原样搬入（enterEditMode / saveAndLeaveEditMode / merge 冲突三动词 /
// undo/redo / runWrite），三处机制替换：
//   - editModeTransitionRef 整把锁 → editorStore 的 phase 转移守卫（beginTransition 引用相等判定）；
//   - historyOpInFlightRef → editorStore.historyOpInFlight；
//   - undoStackRef/redoStackRef 双镜像 + updateUndoStack/updateRedoStack → editorStore 两栈单一真相；
//   - mergeConflictDialog useState → phase 的 conflict 态（view/ctx/applying/error 同形搬入）。
// 纯 TS、不碰 React；deps 经 getDeps() 惰性读取（AppBody 每 render 更新 ref，命令调用时取最新，
// 消灭「hook 收 AppBody 闭包」的倒灌——AppBody 不再把逻辑注回 hook，只提供数据/视图接口）。
//
// deps.view 的三个视图态函数（拍/恢复视图快照、重放展开 effect）依赖 treeView 域 setter，
// 阶段 2 收拢 treeView 后应移入 sessionStore/treeViewCommands，此处为阶段边界的显式接缝。

import type { EditBranchRow } from '../../backend/db/schema.js';
import {
  loadedDepthForDoc,
  normalizeDocId,
  persistActiveDocId,
  sameDocId
} from '../lib/doc-utils.js';
import { debugLog } from '../lib/debug-log.js';
import {
  pushCapped,
  editBranchUndoEntries as hsEditBranchUndoEntries,
  editBranchRedoEntries as hsEditBranchRedoEntries,
  snapshotTokenIds,
  type EditBranchEntry
} from '../session/history-stack.js';
import {
  attachEditorHistoryViewState,
  normalizeEditorHistoryEffect,
  normalizeEditorHistoryViewState,
  normalizeHistoryToken,
  type EditorHistoryToken
} from '../session/history-token.js';
import { documentRepository, historyRepository } from '../data/repositories.js';
import type { Store } from '../stores/create-store.js';
import {
  beginHistoryOp,
  beginTransition,
  closeConflict,
  endHistoryOp,
  endTransition,
  openConflict,
  rotateStacks,
  setConflictApplying,
  setStacks,
  type EditorState,
  type MergeConflictContext
} from '../stores/editor-store.js';

// 当前文档投影的最小读面（IPC 边界形态，沿现状宽松，阶段 2 随 props 收紧）。
export interface EditorCurrentDocLike {
  doc?: { id?: unknown; [extra: string]: unknown } | null;
  editBranch?: EditBranchRow | null;
  [extra: string]: unknown;
}

interface EditorBeginEditBranchResult {
  baseDocId?: unknown;
  branch?: EditBranchRow | null;
  [extra: string]: unknown;
}

interface EditorApplyMergeResult {
  applied?: unknown;
  baseDocId?: unknown;
  changed?: unknown;
  [extra: string]: unknown;
}

interface EditorPendingBranchesResult {
  branches?: Array<{ base_doc_id?: unknown; shadow_doc_id?: unknown; [extra: string]: unknown }>;
  [extra: string]: unknown;
}

interface EditorWriteResult {
  ok?: unknown;
  refresh?: { kind?: unknown };
  doc?: ({ doc?: unknown } & Record<string, unknown>) | null;
  tree?: unknown;
  node?: ({ parentId?: unknown; parent_id?: unknown } & Record<string, unknown>) | null;
  editBranch?: unknown;
  docs?: unknown;
  skipDocsRefresh?: unknown;
  [extra: string]: unknown;
}

export interface DispatchWriteOptions {
  effects?: Record<string, unknown>;
  historyEffect?: unknown;
  redoEffect?: unknown;
  effect?: unknown;
}

export interface EditorCommandDeps {
  editorStore: Store<EditorState>;
  getCurrentDoc(): EditorCurrentDocLike | null;
  docState: {
    reconcileWrittenNode(node: unknown): void;
    patchDocMeta(patch: Record<string, unknown>): unknown;
    reloadStructuralChange(affected?: unknown[] | null): Promise<unknown>;
    loadComplete(docId: unknown): Promise<unknown>;
  };
  ui: {
    getBusy(): boolean;
    setBusy(value: boolean): void;
    setNotice(message: string): void;
    setDocs(docs: unknown[]): void;
  };
  view: {
    // 拍当前视图态快照（undo capture 用）/ 恢复快照 / 重放展开 effect——treeView 域接缝（见文件头）。
    editorHistoryViewState(docId?: unknown): unknown;
    applyEditorHistoryViewState(viewState: unknown, doc: unknown): void;
    applyEditorHistoryEffect(effect: unknown, doc: unknown, options?: { minDepth?: number | string }): Promise<boolean>;
    setSelectedLibraryEntry(entry: null): void;
  };
  prompts: {
    editExitChoice(): Promise<unknown>;
    agentApprovalEditChoice(): Promise<unknown>;
  };
  loadDocForCurrentView(docId: unknown, sourceDoc?: unknown): Promise<unknown>;
  refreshDocList(): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message || error || '');
}

function isSuccessfulWriteResult(result: unknown): boolean {
  return result !== undefined && result !== null && result !== false && (result as { ok?: unknown } | null | undefined)?.ok !== false;
}

export function createEditorCommands(getDeps: () => EditorCommandDeps) {
  // ─── editBranch 读取 helpers（branch 数据唯一 owner 是 docMeta，这里只读） ───

  // 形参与原 AppBody 版本同宽（{ editBranch?: unknown }）：openDoc 等调用点传 IPC 边界形态的 doc。
  function activeEditBranch(doc: { editBranch?: unknown } | null | undefined = getDeps().getCurrentDoc()): EditBranchRow | null {
    return (doc?.editBranch || null) as EditBranchRow | null;
  }

  function isTreeEditMode(): boolean {
    return Boolean(getDeps().getCurrentDoc()?.editBranch);
  }

  function editBranchBaseDocId(branch: unknown = activeEditBranch()) {
    return normalizeDocId((branch as EditBranchRow | null | undefined)?.base_doc_id);
  }

  function editBranchShadowDocId(branch: unknown = activeEditBranch()) {
    return normalizeDocId((branch as EditBranchRow | null | undefined)?.shadow_doc_id);
  }

  function editBranchDiffEntries(branch: EditBranchRow | null | undefined = activeEditBranch()): unknown[] {
    if (!branch?.diff) return [];
    try {
      const diff: { entries?: unknown } = typeof branch.diff === 'string'
        ? JSON.parse(branch.diff || '{}')
        : branch.diff;
      return Array.isArray(diff?.entries) ? diff.entries : [];
    } catch {
      return [];
    }
  }

  function editBranchUndoEntries(branch: EditBranchRow | null | undefined = activeEditBranch()) {
    return hsEditBranchUndoEntries(editBranchDiffEntries(branch) as EditBranchEntry[]);
  }

  function editBranchRedoEntries(branch: EditBranchRow | null | undefined = activeEditBranch()) {
    return hsEditBranchRedoEntries(editBranchDiffEntries(branch) as EditBranchEntry[]);
  }

  // ─── history token 底座 ───

  function currentDocId(): unknown {
    return getDeps().getCurrentDoc()?.doc?.id;
  }

  function tokenIds(tokens: unknown[]) {
    // 只有后端 editorSnapshotTokens 的快照 token（id 形如 editor-N）需要释放；
    // 编辑分支 diff entry 会被 normalizeHistoryToken 误判成 token（docId 有兜底），靠前缀挡掉。
    return snapshotTokenIds(tokens, (token: unknown) => normalizeHistoryToken(token, currentDocId())?.id);
  }

  function discardHistoryTokens(tokens: unknown[]) {
    const ids = tokenIds(tokens);
    if (ids.length === 0) return;
    historyRepository.discardEditorHistoryTokens({ tokenIds: ids }).catch((error) => getDeps().ui.setNotice(errorMessage(error)));
  }

  function clearHistoryStacks() {
    const { editorStore } = getDeps();
    const { undoStack, redoStack } = editorStore.getState();
    discardHistoryTokens([...undoStack, ...redoStack]);
    editorStore.setState((state) => setStacks(state, [], []));
  }

  function syncEditBranchHistoryStacks(branch: unknown = activeEditBranch()) {
    // 进入编辑模式时旧栈里是非编辑模式的快照 token，整栈替换前先释放；
    // 编辑模式内的常规刷新旧栈是 diff entry，discard 会被前缀过滤成空操作。
    const branchObj = branch as EditBranchRow | null | undefined;
    const { editorStore } = getDeps();
    const { undoStack, redoStack } = editorStore.getState();
    discardHistoryTokens([...undoStack, ...redoStack]);
    editorStore.setState((state) => setStacks(state, editBranchUndoEntries(branchObj), editBranchRedoEntries(branchObj)));
  }

  async function captureEditorHistoryToken(
    docId: unknown = currentDocId(),
    viewState: unknown = getDeps().view.editorHistoryViewState(docId),
    effect: unknown = null
  ): Promise<EditorHistoryToken | null> {
    const normalizedDocId = normalizeDocId(docId);
    if (!normalizedDocId) return null;
    const result = await historyRepository.captureEditorHistoryToken({ docId: normalizedDocId }) as { token?: unknown } | null;
    return attachEditorHistoryViewState(result?.token || result, viewState, effect, currentDocId());
  }

  // 写成功后落 undo token：清 redo 栈（并释放其中快照）→ token 入 undo 栈（封顶挤出的也释放）。
  // dispatchWrite / agent 直写 / applyDiff 共用这一原子组合。
  function commitUndoToken(token: unknown): number {
    const { editorStore } = getDeps();
    discardHistoryTokens(editorStore.getState().redoStack);
    let evictedTokens: unknown[] = [];
    let undoDepth = 0;
    editorStore.setState((state) => {
      const { stack, evicted } = pushCapped(state.undoStack, token);
      evictedTokens = evicted;
      undoDepth = stack.length;
      return setStacks(state, stack, []);
    });
    if (evictedTokens.length > 0) discardHistoryTokens(evictedTokens);
    return undoDepth;
  }

  function isEditorHistoryToken(entry: unknown) {
    // full agent 直写 base 后的紧邻回退窗口：编辑模式下栈顶若是 base 快照 token
    //（agent 改动后、下一次分支编辑前），undo/redo 优先恢复 base 快照而非分支条目。
    // 窗口由 syncEditBranchHistoryStacks 重建栈时连带 discard 自然关闭。
    return String((entry as { id?: unknown } | null | undefined)?.id || '').startsWith('editor-');
  }

  // ─── undo / redo ───

  async function restoreEditorSnapshot(token: unknown, direction: 'undo' | 'redo' | string) {
    const deps = getDeps();
    const { editorStore, ui, view, docState } = deps;
    const targetToken = normalizeHistoryToken(token, currentDocId());
    if (!targetToken) {
      debugLog('editor.restore.skip', { direction, reason: 'invalid-token' });
      return;
    }
    const targetDocId = normalizeDocId(targetToken.docId || currentDocId());
    if (!targetDocId) {
      debugLog('editor.restore.skip', { direction, reason: 'invalid-doc' });
      return;
    }
    const targetViewState = normalizeEditorHistoryViewState(targetToken.viewState);
    const targetDepthLimit = Math.max(0, Math.floor(Number(targetViewState?.depthLimit) || 0));
    const targetEffect = normalizeEditorHistoryEffect(targetToken.effect, currentDocId());
    const targetEffectMinDepth = Math.floor(Number(targetEffect?.minDepth) || 0);
    const refreshDepth = Math.max(targetDepthLimit, targetEffectMinDepth);
    ui.setBusy(true);
    try {
      debugLog('editor.restore.start', {
        direction,
        docId: targetDocId,
        tokenId: targetToken.id,
        targetDepthLimit,
        effectKind: targetEffect?.kind || null,
        effectMinDepth: targetEffectMinDepth,
        refreshDepth,
        undoDepth: editorStore.getState().undoStack.length,
        redoDepth: editorStore.getState().redoStack.length
      });
      const inverseViewState = view.editorHistoryViewState(targetDocId);
      const result = await historyRepository.restoreEditorHistoryToken({
        docId: targetDocId,
        tokenId: targetToken.id
      }) as { token?: unknown; editBranch?: unknown } | null;
      const inverseToken = attachEditorHistoryViewState(result?.token, inverseViewState, targetEffect, currentDocId());
      if ((direction === 'undo' || direction === 'redo') && inverseToken) {
        let evictedTokens: unknown[] = [];
        editorStore.setState((state) => {
          const { state: next, evicted } = rotateStacks(state, direction, inverseToken);
          evictedTokens = evicted;
          return next;
        });
        if (evictedTokens.length > 0) discardHistoryTokens(evictedTokens);
      }
      // 撤销/重做：后端已回退，重取反映 + 恢复 viewState（折叠/深度/选中走 session 转发壳）。
      docState.patchDocMeta({ editBranch: (result?.editBranch ?? null) as EditBranchRow | null });
      const reloaded = await docState.reloadStructuralChange();
      if (reloaded) {
        view.applyEditorHistoryViewState(targetViewState, reloaded);
        if (direction === 'redo') await view.applyEditorHistoryEffect(targetEffect, reloaded, { minDepth: refreshDepth });
      }
      ui.setDocs(await documentRepository.listDocs() as unknown[]);
      debugLog('editor.restore.end', {
        direction,
        ok: true,
        docId: targetDocId,
        targetDepthLimit,
        effectKind: targetEffect?.kind || null,
        effectMinDepth: targetEffectMinDepth,
        refreshDepth,
        loadedTreeDepth: loadedDepthForDoc(reloaded as Parameters<typeof loadedDepthForDoc>[0]),
        undoDepth: editorStore.getState().undoStack.length,
        redoDepth: editorStore.getState().redoStack.length
      });
      ui.setNotice(direction === 'undo' ? '已撤销上一步编辑' : '已重做编辑');
    } catch (error) {
      debugLog('editor.restore.end', {
        direction,
        ok: false,
        docId: targetDocId,
        error: errorMessage(error).slice(0, 240),
        undoDepth: editorStore.getState().undoStack.length,
        redoDepth: editorStore.getState().redoStack.length
      });
      ui.setNotice(errorMessage(error));
    } finally {
      ui.setBusy(false);
    }
  }

  async function restoreEditBranchStep(direction: 'undo' | 'redo' | string) {
    const deps = getDeps();
    const { editorStore, ui, docState } = deps;
    const branch = activeEditBranch();
    if (!branch) return;
    const stack = direction === 'undo' ? editorStore.getState().undoStack : editorStore.getState().redoStack;
    if (stack.length === 0) return;
    const baseDocId = editBranchBaseDocId(branch);
    const shadowDocId = editBranchShadowDocId(branch);
    if (!baseDocId || !shadowDocId) return;

    ui.setBusy(true);
    try {
      debugLog('editor.editBranch.restore.start', {
        direction,
        baseDocId,
        shadowDocId,
        undoDepth: editorStore.getState().undoStack.length,
        redoDepth: editorStore.getState().redoStack.length
      });
      const branchOwner = String(branch?.owner || 'human');
      const result = (direction === 'undo'
        ? await documentRepository.undoEditBranch({ shadowDocId, owner: branchOwner, includeDoc: false })
        : await documentRepository.redoEditBranch({ shadowDocId, owner: branchOwner, includeDoc: false })) as { branch?: EditBranchRow | null } | null;
      syncEditBranchHistoryStacks(result?.branch || branch);
      const nextDoc = await deps.loadDocForCurrentView(baseDocId, deps.getCurrentDoc()) as EditorCurrentDocLike | null;
      docState.patchDocMeta({ editBranch: nextDoc?.editBranch ?? result?.branch ?? branch ?? null });
      await docState.reloadStructuralChange();
      syncEditBranchHistoryStacks(nextDoc?.editBranch || result?.branch || branch);
      debugLog('editor.editBranch.restore.end', {
        direction,
        ok: true,
        baseDocId,
        undoDepth: editorStore.getState().undoStack.length,
        redoDepth: editorStore.getState().redoStack.length
      });
      ui.setNotice(direction === 'undo' ? '已撤销上一步编辑' : '已重做编辑');
    } catch (error) {
      debugLog('editor.editBranch.restore.end', {
        direction,
        ok: false,
        baseDocId,
        error: errorMessage(error).slice(0, 240),
        undoDepth: editorStore.getState().undoStack.length,
        redoDepth: editorStore.getState().redoStack.length
      });
      ui.setNotice(errorMessage(error));
    } finally {
      ui.setBusy(false);
    }
  }

  async function historyOp(direction: 'undo' | 'redo') {
    const { editorStore, ui } = getDeps();
    const state = editorStore.getState();
    const stack = direction === 'undo' ? state.undoStack : state.redoStack;
    debugLog(`editor.${direction}.request`, {
      docId: currentDocId() || null,
      undoDepth: state.undoStack.length,
      redoDepth: state.redoStack.length,
      editMode: isTreeEditMode()
    });
    if (stack.length === 0) return;
    // 键盘 Ctrl+Z 绕过按钮 disabled，连发会让两次 restore 读到同一栈顶、重复出栈。
    // 同步置位的 in-flight 标志挡住重入；busy 兜住「写入/打开进行中」的交叉。
    const locked = beginHistoryOp(state);
    if (locked === state || ui.getBusy()) return;
    editorStore.setState(locked);
    try {
      if (isTreeEditMode() && !isEditorHistoryToken(stack[stack.length - 1])) {
        await restoreEditBranchStep(direction);
        return;
      }
      await restoreEditorSnapshot(stack[stack.length - 1], direction);
    } finally {
      editorStore.setState(endHistoryOp);
    }
  }

  const undoEdit = () => historyOp('undo');
  const redoEdit = () => historyOp('redo');

  // ─── 编辑生命周期 ───

  function clearEditModeState(noticeText = '已退出编辑模式') {
    const deps = getDeps();
    if (deps.getCurrentDoc()?.editBranch) deps.docState.patchDocMeta({ editBranch: null });
    clearHistoryStacks();
    if (noticeText) deps.ui.setNotice(noticeText);
  }

  // 退出编辑切回主干 doc（base↔shadow node_id 不同）= 重建 session：直接 loadComplete 扩散加载目标 doc，
  // 折叠/深度从该 doc 的 tree_view_state 持久化恢复（loadComplete 内做），不手工 remap（扩散下映射不全）。
  async function switchDocPreservingView(
    nextDocId: unknown,
    _sourceDoc: unknown,
    { persistedDocId, noticeText }: { persistedDocId?: unknown; noticeText?: string } = {}
  ) {
    const deps = getDeps();
    const docId = normalizeDocId(nextDocId);
    if (!docId) return;
    deps.view.setSelectedLibraryEntry(null);
    persistActiveDocId(persistedDocId || docId);
    await deps.docState.loadComplete(docId);
    deps.docState.patchDocMeta({ editBranch: null }); // 退出编辑：清编辑分支标识
    clearHistoryStacks();
    if (noticeText) deps.ui.setNotice(noticeText);
  }

  // 进入编辑模式的唯一入口：开影子分支、切持久化 docId、置编辑态、同步撤销栈。
  // phase 转移守卫 + busy 双重护栏，避免快速双击重复 beginEditBranch（原 editModeTransitionRef）。
  async function enterEditMode(): Promise<boolean> {
    const deps = getDeps();
    const { editorStore, ui, docState } = deps;
    if (isTreeEditMode() && activeEditBranch()) return true;
    const sourceDoc = deps.getCurrentDoc();
    if (!sourceDoc?.doc?.id) {
      ui.setNotice('请先打开文档');
      return false;
    }
    const state = editorStore.getState();
    const entering = beginTransition(state, 'entering');
    if (entering === state) return false; // 过渡/冲突在途：拒绝
    editorStore.setState(entering);
    ui.setBusy(true);
    try {
      const result = await documentRepository.beginEditBranch({ docId: sourceDoc.doc.id, owner: 'human', includeDoc: false }) as EditorBeginEditBranchResult | null;
      const baseDocId = result?.baseDocId || result?.branch?.base_doc_id || sourceDoc.doc.id;
      if (!baseDocId) throw new Error('进入编辑模式失败');
      if (sameDocId(deps.getCurrentDoc()?.doc?.id, sourceDoc?.doc?.id)) {
        docState.patchDocMeta({ editBranch: result?.branch || null });
      }
      persistActiveDocId(baseDocId);
      syncEditBranchHistoryStacks(result?.branch || null);
      ui.setNotice('已进入编辑模式');
      return true;
    } catch (error) {
      ui.setNotice(errorMessage(error));
      return false;
    } finally {
      ui.setBusy(false);
      editorStore.setState(endTransition);
    }
  }

  async function ensureAgentApprovalEditMode(): Promise<boolean> {
    const deps = getDeps();
    if (isTreeEditMode() && activeEditBranch()) return true;
    if (!deps.getCurrentDoc()?.doc?.id) {
      deps.ui.setNotice('请先打开待审变更所属文档');
      return false;
    }
    const choice = await deps.prompts.agentApprovalEditChoice();
    if (choice !== 'enter') return false;
    return enterEditMode();
  }

  async function saveAndLeaveEditMode(targetDocId: unknown = null): Promise<boolean> {
    const deps = getDeps();
    const { editorStore, ui } = deps;
    const branch = activeEditBranch();
    if (!isTreeEditMode()) return true;
    if (!branch) {
      clearEditModeState();
      return true;
    }
    const baseDocId = editBranchBaseDocId(branch);
    const shadowDocId = editBranchShadowDocId(branch);
    // 审核通道统一：保存/丢弃按分支实际 owner 操作（llm 分支同走本流程），不写死 human。
    const branchOwner = String(branch?.owner || 'human');
    if (targetDocId && (sameDocId(targetDocId, baseDocId) || sameDocId(targetDocId, shadowDocId))) return true;
    // 离场转移守卫（与 enterEditMode 同一状态机）：弹窗悬停或保存进行中再次触发离场
    // （锁按钮、切文档、关窗）一律拒绝——防重复弹窗与重复 applyMerge（实际翻过车：
    // busy 中连点三次保存发出三发 applyMerge，第二发起全是 Edit branch not found）。
    const state = editorStore.getState();
    const leaving = beginTransition(state, 'leaving');
    if (leaving === state) return false;
    editorStore.setState(leaving);
    try {
      const choice = await deps.prompts.editExitChoice();
      if (choice !== 'save' && choice !== 'discard') return false;
      ui.setBusy(true);
      // 保存/丢弃成功后的统一离场：重载主干、退出编辑投影、刷新文档列表。
      const leaveWithTrunk = async (docIdToLoad: unknown, sourceDoc: unknown, noticeText: string) => {
        await switchDocPreservingView(docIdToLoad, sourceDoc, {
          persistedDocId: docIdToLoad,
          noticeText
        });
        ui.setDocs(await documentRepository.listDocs() as unknown[]);
      };
      try {
        const sourceDoc = deps.getCurrentDoc();
        if (choice === 'discard') {
          // Tell the backend to skip the post-discard refreshDoc so this stays a
          // pure entries-delete; we re-fetch ourselves with the depth the view
          // actually needs.
          await documentRepository.discardEditBranch({ shadowDocId, owner: branchOwner, includeDoc: false });
          await leaveWithTrunk(baseDocId, sourceDoc, '已丢弃本次编辑并退出');
          return true;
        }
        const result = await documentRepository.applyEditBranchMerge({ shadowDocId, owner: branchOwner, includeDoc: false }) as EditorApplyMergeResult | null;
        if (!result?.applied) {
          // 主干在编辑期间前移：字段级冲突 → 三列面板人裁；结构性失配（blocked）→
          // 「主干已被修改，无法保存」，只能放弃本次编辑或取消保留分支。两种都留在编辑模式，不静默覆盖。
          // leaving → conflict 转移；随后 finally 的 endTransition 对 conflict 无操作，面板态保持。
          const ctx: MergeConflictContext = { shadowDocId, baseDocId, owner: branchOwner, sourceDoc };
          editorStore.setState((current) => openConflict(current, result, ctx));
          return false;
        }
        // 保存成功（applied）一律重载主干离场：changed=false（空 diff 分支被关闭）也要
        // 离开编辑投影，否则视图停在编辑态，用户会以为保存没有生效。
        await leaveWithTrunk(
          result?.baseDocId || baseDocId,
          sourceDoc,
          result?.changed ? '已保存当前编辑状态并退出编辑模式' : '没有有效变更，已退出编辑模式'
        );
        return true;
      } catch (error) {
        // 写库与视图刷新分开归因：分支已不在 = 保存/丢弃其实已提交（响应丢失、重复点击、
        // 或提交成功后刷新那步抛错），必须按成功离场重载主干——不能把刷新失败误报成
        // 「保存失败」让用户白白重试（实际翻过车：31 条已落主干、前端却报错）。
        let branchGone = /Edit branch not found/i.test(errorMessage(error));
        if (!branchGone) {
          try {
            const pending = await documentRepository.getPendingEditBranches() as EditorPendingBranchesResult | null;
            branchGone = !(pending?.branches || []).some((row) => (
              sameDocId(row.base_doc_id, baseDocId) || sameDocId(row.shadow_doc_id, shadowDocId)
            ));
          } catch {
            branchGone = false;
          }
        }
        if (branchGone) {
          try {
            await leaveWithTrunk(
              baseDocId,
              deps.getCurrentDoc(),
              choice === 'save' ? '已保存当前编辑状态并退出编辑模式' : '已丢弃本次编辑并退出'
            );
          } catch (refreshError) {
            clearEditModeState(`已退出编辑模式；视图刷新失败：${errorMessage(refreshError)}`);
          }
          return true;
        }
        ui.setNotice(errorMessage(error));
        return false;
      } finally {
        ui.setBusy(false);
      }
    } finally {
      editorStore.setState(endTransition);
    }
  }

  async function confirmLeaveEditMode(targetDocId: unknown = null): Promise<boolean> {
    return saveAndLeaveEditMode(targetDocId);
  }

  async function toggleTreeEditMode() {
    const deps = getDeps();
    if (!deps.getCurrentDoc()?.doc?.id) return;
    if (!isTreeEditMode()) {
      await enterEditMode();
      return;
    }
    await saveAndLeaveEditMode();
  }

  // ─── merge 冲突面板三动词（conflict 态内） ───

  function conflictCtx(): MergeConflictContext | null {
    const { editorStore } = getDeps();
    const phase = editorStore.getState().phase;
    return phase.kind === 'conflict' ? phase.ctx : null;
  }

  // 后端裁决/丢弃已落库后的收尾：关面板、立即清分支标识（派生回 readonly——堵住重载期间
  // Ctrl+Z / 锁按钮对已合并分支的无锁窗口）、重载主干。重载失败不能静默：closeConflict 后
  // phase 已是 idle，setConflictApplying 会 no-op 把错误吞掉（面板也已关、没人看得到），
  // 走 notice 兜底——与 saveAndLeaveEditMode 的「已退出；视图刷新失败」兜底对称。
  async function finishConflictExit(baseDocId: unknown, sourceDoc: unknown, noticeText: string) {
    const deps = getDeps();
    const { editorStore, ui } = deps;
    editorStore.setState(closeConflict);
    deps.docState.patchDocMeta({ editBranch: null });
    clearHistoryStacks();
    try {
      await switchDocPreservingView(baseDocId, sourceDoc, { persistedDocId: baseDocId, noticeText });
      ui.setDocs(await documentRepository.listDocs() as unknown[]);
    } catch (error) {
      ui.setNotice(`${noticeText}；视图刷新失败：${errorMessage(error)}，可重新打开该文档`);
    }
  }

  async function applyMergeResolutions(resolutions: unknown) {
    const deps = getDeps();
    const { editorStore } = deps;
    const ctx = conflictCtx();
    if (!ctx) return;
    editorStore.setState((state) => setConflictApplying(state, true));
    let result: EditorApplyMergeResult | null;
    try {
      result = await documentRepository.applyEditBranchMerge({
        shadowDocId: ctx.shadowDocId,
        owner: ctx.owner,
        includeDoc: false,
        resolutions
      }) as EditorApplyMergeResult | null;
    } catch (error) {
      // 后端未落库：留面板显示错误，可重试。
      editorStore.setState((state) => setConflictApplying(state, false, errorMessage(error)));
      return;
    }
    if (!result?.applied) {
      // 仍未应用（如结构冲突）→ 留面板，刷新冲突视图与 resolutionErrors。
      editorStore.setState((state) => openConflict(state, result));
      return;
    }
    await finishConflictExit(result?.baseDocId || ctx.baseDocId, ctx.sourceDoc, '已解决冲突并合并，退出编辑模式');
  }

  function closeMergeConflictDialog() {
    // 取消解决：保留分支（不写回），留在编辑模式，稍后可重试或继续编辑。
    getDeps().editorStore.setState(closeConflict);
  }

  // blocked（主干已被修改，结构性失配不可裁）→ 用户确认「放弃本次编辑」：丢弃分支并退出编辑模式。
  async function discardMergeBlockedBranch() {
    const deps = getDeps();
    const { editorStore } = deps;
    const ctx = conflictCtx();
    if (!ctx) return;
    editorStore.setState((state) => setConflictApplying(state, true));
    try {
      await documentRepository.discardEditBranch({ shadowDocId: ctx.shadowDocId, owner: ctx.owner, includeDoc: false });
    } catch (error) {
      // 后端未删分支：留面板显示错误，可重试。
      editorStore.setState((state) => setConflictApplying(state, false, errorMessage(error)));
      return;
    }
    await finishConflictExit(ctx.baseDocId, ctx.sourceDoc, '已放弃本次编辑并退出');
  }

  // ─── write pipeline（原 useWritePipeline，callers 构造 repository thunk，这里统一 reconcile） ───

  async function dispatchWrite(action: () => unknown | Promise<unknown>, options: DispatchWriteOptions = {}) {
    const deps = getDeps();
    const { ui, docState } = deps;
    const currentDoc = deps.getCurrentDoc();
    if (!currentDoc) return;
    const treeEditMode = isTreeEditMode();
    const effects = options.effects || {};
    const undoMode = effects.undo === undefined ? (treeEditMode ? 'editBranch' : 'capture') : effects.undo;
    const docsMode = effects.docsRefresh === undefined ? 'list' : effects.docsRefresh;
    const busyMode = effects.busy === undefined ? true : effects.busy;
    const historyEffect = normalizeEditorHistoryEffect(options.historyEffect || options.redoEffect || options.effect, currentDoc.doc?.id);
    let undoToken: EditorHistoryToken | null = null;
    if (busyMode) ui.setBusy(true);
    try {
      if (undoMode === 'capture' && !treeEditMode) {
        undoToken = await captureEditorHistoryToken(currentDoc.doc?.id, deps.view.editorHistoryViewState(currentDoc.doc?.id), historyEffect) || null;
      }
      const rawNext = await action();
      const writeOk = isSuccessfulWriteResult(rawNext);
      let discardedRedo: unknown[] = [];
      if (writeOk && undoToken) {
        // 写已成功：redo 时间线作废，先通知后端释放 redo 栈快照（栈本体在下方 push 时一并清空；
        // 与原 useWritePipeline 同序——即使返回值不是对象也先释放）。记快照供 push 时对账。
        discardedRedo = getDeps().editorStore.getState().redoStack;
        discardHistoryTokens(discardedRedo);
      }
      const next = rawNext as EditorWriteResult | null | undefined;
      if (next) {
        const refreshKind = next.refresh?.kind;
        const seedDoc = next.doc?.doc ? next.doc : (next.doc && next.tree ? next : null);
        if (refreshKind === 'node' && next.node) {
          docState.reconcileWrittenNode(next.node);
          if (next.editBranch) docState.patchDocMeta({ editBranch: next.editBranch });
        } else if (refreshKind === 'doc') {
          const affected = normalizeDocId(next.node?.parentId ?? next.node?.parent_id);
          await docState.reloadStructuralChange(affected ? [affected] : null);
        } else if (refreshKind === 'doc_state') {
          if ((next.doc as { doc?: unknown } | undefined)?.doc) docState.patchDocMeta({ doc: (next.doc as { doc: unknown }).doc });
        } else if (seedDoc) {
          await docState.reloadStructuralChange();
        }
        if (refreshKind === 'docs' || Array.isArray(next.docs)) {
          if (docsMode !== 'none') {
            if (Array.isArray(next.docs)) ui.setDocs(next.docs as unknown[]);
            else if (docsMode === 'list') ui.setDocs(await documentRepository.listDocs() as unknown[]);
          }
        } else if (docsMode === 'list' && !next.skipDocsRefresh) {
          ui.setDocs(await documentRepository.listDocs() as unknown[]);
        }
        if (undoMode === 'editBranch') {
          const branch = next.editBranch || activeEditBranch();
          syncEditBranchHistoryStacks(branch);
        }
        if (writeOk && undoToken) {
          const { editorStore } = getDeps();
          let evictedTokens: unknown[] = [];
          let lateRedoTokens: unknown[] = [];
          let undoDepth = 0;
          const discardedSet = new Set(discardedRedo);
          editorStore.setState((state) => {
            // 早段 discard 的是 action() 完成时的 redoStack 快照；此处 await（reload/listDocs）
            // 期间若发生过 undo，新入栈的 inverse token 会被下面的 setStacks(…, []) 抹掉——
            // 对账出快照之外的新 token 一并释放，不留后端快照泄漏。
            lateRedoTokens = state.redoStack.filter((token) => !discardedSet.has(token));
            const { stack, evicted } = pushCapped(state.undoStack, undoToken);
            evictedTokens = evicted;
            undoDepth = stack.length;
            return setStacks(state, stack, []);
          });
          if (lateRedoTokens.length > 0) discardHistoryTokens(lateRedoTokens);
          if (evictedTokens.length > 0) discardHistoryTokens(evictedTokens);
          debugLog('editor.history.pushUndo', {
            docId: undoToken.docId,
            tokenId: undoToken.id,
            undoDepth,
            redoDepth: 0
          });
          undoToken = null;
        }
      }
      if (undoToken) {
        discardHistoryTokens([undoToken]);
        undoToken = null;
      }
      return rawNext;
    } catch (error) {
      if (undoToken) discardHistoryTokens([undoToken]);
      ui.setNotice(errorMessage(error));
      return null;
    } finally {
      if (busyMode) ui.setBusy(false);
    }
  }

  // 生命周期是否在过渡/冲突态（非 idle）。openDoc 等外围编排用它拒绝并发切换：
  // entering 在途时 isTreeEditMode() 仍 false、confirmLeaveEditMode 会直接放行，
  // 但 beginEditBranch 完成后的 persistActiveDocId / syncEditBranchHistoryStacks 会把
  // 持久化 docId 打回旧文档、新文档的撤销栈被旧文档分支污染。
  function isLifecycleTransitioning(): boolean {
    return getDeps().editorStore.getState().phase.kind !== 'idle';
  }

  return {
    // editBranch 读取
    activeEditBranch,
    isTreeEditMode,
    isLifecycleTransitioning,
    editBranchBaseDocId,
    editBranchShadowDocId,
    editBranchUndoEntries,
    editBranchRedoEntries,
    // history
    captureEditorHistoryToken,
    discardHistoryTokens,
    commitUndoToken,
    clearHistoryStacks,
    syncEditBranchHistoryStacks,
    undoEdit,
    redoEdit,
    // 生命周期
    enterEditMode,
    ensureAgentApprovalEditMode,
    saveAndLeaveEditMode,
    confirmLeaveEditMode,
    toggleTreeEditMode,
    clearEditModeState,
    switchDocPreservingView,
    // merge 冲突
    applyMergeResolutions,
    closeMergeConflictDialog,
    discardMergeBlockedBranch,
    // write
    dispatchWrite
  };
}

export type EditorCommands = ReturnType<typeof createEditorCommands>;
