// documentCommands：文档生命周期编排（frontend-refactor.md §4.4 阶段 2）。
// open / refresh / create / delete / import / openLibraryNavigation 自 AppBody 原样搬入。
// 依赖方向：document → editor（离场确认、分支识别、栈清理）为单向命令间调用；
// importFiles(smart) → agent.runAgentRequest 经 deps 注入（agent 组阶段 2b 落位后仍为注入，
// 避免 document/agent 双向 import）。deps 经 getDeps() 惰性读取（同 editor-commands 约定）。

import {
  isSupportedLibraryImport,
  normalizeDocId,
  persistActiveDocId,
  sameDocId
} from '../lib/doc-utils.js';
import { documentRepository, importService } from '../data/repositories.js';
import type { EditorCommands } from './editor-commands.js';

// 打开/导入返回的文档投影最小读面（IPC 边界宽形态）。
export interface DocumentOpenedDocLike {
  doc?: { id?: unknown; node_count?: unknown; [extra: string]: unknown } | null;
  tree?: { id?: unknown; [extra: string]: unknown } | null;
  editBranch?: unknown;
  [extra: string]: unknown;
}

// 库文件条目最小读面（无 index signature，backend 的 LibraryEntry 可结构赋值）。
interface LibraryEntryLike {
  type?: unknown;
  relativePath?: string;
  extension?: unknown;
}

export interface OpenDocOptions {
  includeEditBranch?: boolean;
  onComplete?: (doc: unknown) => void;
  onFailure?: (error: unknown) => void;
}

export interface DocumentCommandDeps {
  getCurrentDoc(): DocumentOpenedDocLike | null;
  docState: {
    loadComplete(docId: unknown, label?: string, options?: { includeEditBranch?: boolean; keepLockAfterLoad?: boolean }): Promise<DocumentOpenedDocLike | null>;
    setCurrentDoc(next: unknown): void;
    refreshList(): Promise<Array<{ id?: unknown; [extra: string]: unknown }>>;
    refreshLibrary(): Promise<unknown>;
  };
  editor: Pick<EditorCommands,
    'activeEditBranch' | 'editBranchBaseDocId' | 'editBranchShadowDocId'
    | 'syncEditBranchHistoryStacks' | 'clearHistoryStacks' | 'confirmLeaveEditMode'
    | 'isLifecycleTransitioning'>;
  ui: {
    setBusy(value: boolean): void;
    setNotice(message: string): void;
    setProgress(value: unknown): void;
    setOperationLock(value: unknown): void;
    setDocs(docs: unknown[]): void;
  };
  view: {
    getActiveTab(): string;
    getSelectedNodeId(): unknown;
    setSelectedNodeId(id: unknown): void;
    setMultiSelectedNodeIds(ids: Set<string>): void;
    // 清空折叠/展开集合（deleteDoc 清场 / 切库文件视图用）。
    resetCollapseSets(): void;
    setSearchResults(results: unknown[]): void;
    bumpLocateRequest(nodeId: unknown): void;
    resetLocateRequest(): void;
    setSelectedLibraryEntry(entry: unknown): void;
    getSelectedLibraryEntry(): LibraryEntryLike | null;
    // 首帧渲染解锁探针（useStartup E2E 薄层），返回是否已挂钩。
    armRenderUnlock(docId: unknown, reason?: string): boolean;
  };
  agent: {
    runAgentRequest(request: { mode: string; prompt: unknown }): Promise<unknown>;
  };
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message || error || '');
}

export function createDocumentCommands(getDeps: () => DocumentCommandDeps) {
  function currentVisualDocId(): unknown {
    const deps = getDeps();
    return deps.editor.editBranchBaseDocId() || normalizeDocId(deps.getCurrentDoc()?.doc?.id);
  }

  async function refreshDocs(
    nextDocId: unknown = currentVisualDocId(),
    options: { autoOpen?: boolean } = {}
  ) {
    const deps = getDeps();
    const { ui, view, docState, editor } = deps;
    const list = await docState.refreshList();
    const branch = editor.activeEditBranch();
    if (branch && (sameDocId(nextDocId, editor.editBranchBaseDocId(branch)) || sameDocId(nextDocId, editor.editBranchShadowDocId(branch)))) {
      return list;
    }
    const targetDoc = normalizeDocId(nextDocId)
      ? list.find((item) => normalizeDocId(item.id) === normalizeDocId(nextDocId))
      : null;
    if (targetDoc) {
      ui.setBusy(true);
      ui.setOperationLock({ label: '正在打开文档……', step: 0, total: 0 });
      const waitForRender = view.getActiveTab() === 'tree';
      const prevSelectedId = view.getSelectedNodeId();
      try {
        const doc = await docState.loadComplete(targetDoc.id, undefined, { keepLockAfterLoad: waitForRender });
        const isDifferentDoc = normalizeDocId(deps.getCurrentDoc()?.doc?.id) !== normalizeDocId(doc?.doc?.id);
        const renderUnlockArmed = waitForRender && isDifferentDoc && doc?.tree
          ? view.armRenderUnlock(doc?.doc?.id || targetDoc.id, 'refresh-doc')
          : false;
        // loadComplete 已建 session + 投影 + 从 tree_view_state 恢复折叠；这里只补非视图编排。
        view.setSelectedLibraryEntry(null);
        persistActiveDocId(doc?.doc?.id || targetDoc.id);
        // 同文档刷新保留选中（loadComplete 重置为 null，显式恢复）；切文档保持 null。
        if (!isDifferentDoc && prevSelectedId) view.setSelectedNodeId(prevSelectedId);
        ui.setBusy(false);
        if (!renderUnlockArmed) {
          ui.setProgress(null);
          ui.setOperationLock(null);
        }
      } catch (error) {
        ui.setBusy(false);
        ui.setProgress(null);
        ui.setOperationLock(null);
        throw error;
      }
    } else if (options.autoOpen && list.length > 0) {
      await openDoc(list[0].id);
    } else if (nextDocId) {
      persistActiveDocId(null);
    }
    return list;
  }

  async function openDoc(docId: unknown, options: OpenDocOptions = {}) {
    const deps = getDeps();
    const { ui, view, docState, editor } = deps;
    const branch = editor.activeEditBranch();
    if (branch && (sameDocId(docId, editor.editBranchBaseDocId(branch)) || sameDocId(docId, editor.editBranchShadowDocId(branch)))) {
      return deps.getCurrentDoc();
    }
    // entering/leaving/conflict 在途一律拒绝切文档：entering 时 isTreeEditMode() 仍 false、
    // confirmLeaveEditMode 会直接放行，beginEditBranch 完成后的收尾（persistActiveDocId /
    // syncEditBranchHistoryStacks）会把持久化 docId 打回旧文档、污染新文档的撤销栈；
    // conflict 期间切走则让面板的裁决上下文悬空。
    if (editor.isLifecycleTransitioning()) {
      ui.setNotice('编辑模式切换中，请稍候再切换文档');
      return null;
    }
    const canLeave = await editor.confirmLeaveEditMode(docId);
    if (!canLeave) return null;
    ui.setBusy(true);
    ui.setOperationLock({ label: '正在打开文档……', step: 0, total: 0 });
    const waitForRender = view.getActiveTab() === 'tree';
    try {
      const doc = await docState.loadComplete(docId, undefined, {
        keepLockAfterLoad: waitForRender,
        includeEditBranch: options.includeEditBranch
      });
      const openedBranch = editor.activeEditBranch(doc);
      const openedBaseDocId = editor.editBranchBaseDocId(openedBranch);
      const isDifferentDoc = normalizeDocId(deps.getCurrentDoc()?.doc?.id) !== normalizeDocId(doc?.doc?.id);
      const renderUnlockArmed = waitForRender && isDifferentDoc && doc?.tree
        ? view.armRenderUnlock(doc?.doc?.id || docId, 'open-doc')
        : false;
      // loadComplete 已建 session + 投影 + 恢复折叠/深度，selected 默认 null；这里只管非视图编排。
      persistActiveDocId(openedBaseDocId || doc?.doc?.id || docId);
      view.setSelectedLibraryEntry(null);
      if (openedBranch) editor.syncEditBranchHistoryStacks(openedBranch);
      else editor.clearHistoryStacks();
      view.setSearchResults([]);
      view.bumpLocateRequest(doc?.tree?.id || null);
      ui.setBusy(false);
      if (!renderUnlockArmed) {
        ui.setProgress(null);
        ui.setOperationLock(null);
      }
      options.onComplete?.(doc);
      return doc;
    } catch (error) {
      ui.setBusy(false);
      ui.setProgress(null);
      ui.setOperationLock(null);
      options.onFailure?.(error);
      throw error;
    }
  }

  async function openLibraryNavigation() {
    const deps = getDeps();
    const { ui, view, docState, editor } = deps;
    const canLeave = await editor.confirmLeaveEditMode();
    if (!canLeave) return null;
    ui.setBusy(true);
    try {
      const doc = await documentRepository.getLibraryNavigation() as DocumentOpenedDocLike | null;
      // 库导航是虚拟 doc（不建 session）：先清旧 session + 停预取，避免旧预取 project 覆盖虚拟视图。
      docState.setCurrentDoc(null);
      docState.setCurrentDoc(doc);
      view.setSelectedLibraryEntry(null);
      persistActiveDocId(null);
      editor.clearHistoryStacks();
      view.setSearchResults([]);
      view.bumpLocateRequest(doc?.tree?.id || null);
      return doc;
    } catch (error) {
      ui.setNotice(errorMessage(error));
      return null;
    } finally {
      ui.setBusy(false);
      ui.setProgress(null);
      ui.setOperationLock(null);
    }
  }

  async function createDoc(titleOverride: unknown = null, folderId: unknown = null) {
    const deps = getDeps();
    const { ui, editor } = deps;
    const canLeave = await editor.confirmLeaveEditMode();
    if (!canLeave) return;
    const title = typeof titleOverride === 'string' && titleOverride.trim()
      ? titleOverride.trim()
      : '未命名条件树文档';
    ui.setBusy(true);
    try {
      const doc = await documentRepository.createDoc({ title, rootText: title, folderId }) as DocumentOpenedDocLike | null;
      persistActiveDocId(doc?.doc?.id);
      await refreshDocs(doc?.doc?.id);
    } catch (error) {
      ui.setNotice(errorMessage(error));
    } finally {
      ui.setBusy(false);
    }
  }

  function clearActiveDocumentForLibraryFile() {
    const deps = getDeps();
    const { view, docState, editor } = deps;
    docState.setCurrentDoc(null);
    persistActiveDocId(null);
    view.setSelectedNodeId(null);
    view.setMultiSelectedNodeIds(new Set());
    view.resetCollapseSets();
    editor.clearHistoryStacks();
    view.setSearchResults([]);
    view.resetLocateRequest();
  }

  function showLibraryFileOnly(item: unknown, noticeText = '未导入原始文件，请先手动导入') {
    const deps = getDeps();
    deps.view.setSelectedLibraryEntry(item);
    clearActiveDocumentForLibraryFile();
    deps.ui.setNotice(noticeText);
  }

  async function deleteDoc(doc: { id?: unknown; title?: string }) {
    const deps = getDeps();
    const { ui, view, docState } = deps;
    const ok = window.confirm(`删除文档“${doc.title}”及其全部节点？`);
    if (!ok) return;
    ui.setBusy(true);
    try {
      const nextDocs: unknown = await documentRepository.deleteDoc({ docId: doc.id });
      ui.setDocs(nextDocs as unknown[]);
      if (deps.getCurrentDoc()?.doc?.id === doc.id) {
        const nextDoc = (Array.isArray(nextDocs) ? nextDocs[0] : null) as { id?: unknown } | null;
        if (nextDoc) {
          await openDoc(nextDoc.id);
        } else {
          docState.setCurrentDoc(null);
          persistActiveDocId(null);
          view.setSelectedNodeId(null);
          view.resetCollapseSets();
        }
      }
      ui.setNotice('已删除文档');
    } catch (error) {
      ui.setNotice(errorMessage(error));
    } finally {
      ui.setBusy(false);
    }
  }

  async function importFiles(mode = 'simple') {
    const deps = getDeps();
    const { ui, view, docState, editor } = deps;
    const rawMode = String(mode || 'simple').trim();
    const importMode = ['simple', 'complete', 'direct', 'smart', 'vector'].includes(rawMode) ? rawMode : 'simple';
    const selectedLibraryEntry = view.getSelectedLibraryEntry();
    if (importMode === 'smart') {
      if (selectedLibraryEntry?.type !== 'file') {
        ui.setNotice('智能导入请先在库里选中要导入的文件');
        return;
      }
      try {
        // 智能导入不在前端/后端落库：后端构造任务 prompt，前端以 full 档发起一次 agent 会话，
        // agent 自主跑 smart-import skill（观察源文 → 写脚本 → 校验 → 入库），过程在 AgentPanel 可见。
        const task = await importService.smartImportTask({ relativePath: selectedLibraryEntry.relativePath }) as { mode?: string; prompt?: string } | null;
        await deps.agent.runAgentRequest({ mode: task?.mode || 'full', prompt: task?.prompt || '' });
        // agent 跑 db import-json 直接入库、不一定进 runAgent 的 changedDocIds，显式刷新库与文档列表。
        await docState.refreshLibrary();
        await docState.refreshList();
      } catch (error) {
        ui.setNotice(errorMessage(error) || '智能导入发起失败');
      }
      return;
    }
    if (selectedLibraryEntry?.type === 'file' && !isSupportedLibraryImport(selectedLibraryEntry as unknown as Parameters<typeof isSupportedLibraryImport>[0])) {
      ui.setNotice(`不支持导入格式：${selectedLibraryEntry.extension || '未知格式'}`);
      return;
    }
    const canLeave = await editor.confirmLeaveEditMode();
    if (!canLeave) return;
    ui.setBusy(true);
    ui.setOperationLock({ label: '正在处理导入……', step: 0, total: 0 });
    try {
      const payload = { mode: importMode };
      const importedRaw = selectedLibraryEntry?.type === 'file' && importService.canImportLibraryDocument()
        ? await importService.importLibraryDocument({ relativePath: selectedLibraryEntry.relativePath, ...payload })
        : await importService.chooseImportFile(payload);
      const imported = (Array.isArray(importedRaw) ? importedRaw : []) as Array<{ doc?: { id?: unknown }; [extra: string]: unknown }>;
      if (imported.length) {
        const last = imported[imported.length - 1];
        ui.setOperationLock({ label: '正在打开文档……', step: 0, total: 0 });
        const opened = await docState.loadComplete(last.doc?.id, '正在打开文档……');
        view.setSelectedLibraryEntry(null);
        persistActiveDocId(opened?.doc?.id || last?.doc?.id);
        ui.setBusy(false);
        ui.setProgress(null);
        ui.setOperationLock(null);
        ui.setNotice(`已导入 ${imported.length} 份文档`);
        refreshDocs(null).catch(() => {});
      } else {
        ui.setBusy(false);
        ui.setProgress(null);
        ui.setOperationLock(null);
      }
    } catch (error) {
      ui.setNotice(errorMessage(error));
      ui.setBusy(false);
      ui.setProgress(null);
      ui.setOperationLock(null);
    }
  }

  return {
    currentVisualDocId,
    refreshDocs,
    openDoc,
    openLibraryNavigation,
    createDoc,
    deleteDoc,
    clearActiveDocumentForLibraryFile,
    showLibraryFileOnly,
    importFiles
  };
}

export type DocumentCommands = ReturnType<typeof createDocumentCommands>;
