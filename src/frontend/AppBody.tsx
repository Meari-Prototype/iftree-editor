import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Settings
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { DocRow, EditBranchRow } from '../backend/db/schema.js';
import { buildNodeSentenceLabelMap } from '../core/source-ranges.js';
import { findNode, flattenTree } from '../core/tree.js';

import {
  depthOf, isFactAxiomRef, clampDepthLimit, normalizeNodeLayoutSettingsByView, fullDepthForDoc, loadedDepthForDoc, treeDocRequest, sameDocId,
  hasKnownChildren,
  idSetFromArray, treeViewStateFromDoc,
  normalizeFsPath, isSupportedLibraryImport, docSourcePath,
  docDisplayTitle, defaultCollapsedOutlineIds,
  buildParagraphLabelMap, isEditableTarget,
  normalizeDocId, persistActiveDocId,
  SOURCE_WINDOW_BEFORE_CHARS
} from './lib/doc-utils.js';
import {
  agentHistoryForRequest
} from './lib/agent-utils.js';
import {
  pushCapped,
  editBranchUndoEntries as hsEditBranchUndoEntries,
  editBranchRedoEntries as hsEditBranchRedoEntries,
  snapshotTokenIds,
  type EditBranchEntry
} from './session/history-stack.js';
import { debugLog, debugPerfBegin, debugPerfEnd } from './lib/debug-log.js';
import { debugElementTarget, debugShouldLogKey } from './features/debug/ui-debug-actions.js';
import { createLibraryActions } from './features/library/library-actions.js';
import { openSettingsAction, saveAgentSettingsAction } from './features/settings/settings-actions.js';
import { ChoiceDialog, ViewAlignedEmptyState, WindowTitlebar } from './components/common.jsx';
import { C2DMapView } from './components/MindMapView';
import { IdeView } from './components/IdeView.jsx';
import { RichTextView } from './components/RichTextView.jsx';
import { SearchView } from './components/SearchView.jsx';
import { EntityTraceView } from './components/EntityTraceView.jsx';
import { Inspector } from './components/Inspector.jsx';
import { SettingsView } from './components/SettingsView.jsx';
import { ProgressOverlay } from './components/ProgressOverlay.jsx';
import { OutlinePanel } from './components/OutlinePanel.jsx';
import { WorkspaceHeader } from './components/WorkspaceHeader.jsx';
import { EditBranchDiffDialog, type EditBranchDiffViewModel } from './components/EditBranchDiffDialog.jsx';
import { MergeConflictDialog } from './components/MergeConflictDialog.jsx';
import { DocBrowser } from './components/DocBrowser.jsx';
import { useAppUIContext } from './hooks/useAppUI.js';
import { useEditorOps } from './hooks/useEditorOps.js';
import { useEntityTrace } from './hooks/useEntityTrace.js';
import { useLayout } from './hooks/useLayout.js';
import { useNodeSelection } from './hooks/useNodeSelection.js';
import { useSettings } from './hooks/useSettings.js';
import { useStartup } from './hooks/useStartup.js';
import { useSummaryRun } from './hooks/useSummaryRun.js';
import { useAgentChat } from './hooks/useAgentChat.js';
import { useDocumentState } from './hooks/useDocumentState.js';
import { usePromptDialog } from './hooks/usePromptDialog.js';
import { useTreeViewState } from './hooks/useTreeViewState.js';
import { useWritePipeline } from './hooks/useWritePipeline.js';
import { closeWindow, onLibraryChanged, onProgress } from './data/iftree-api.js';
import {
  agentRepository,
  assetRepository,
  axiomRepository,
  documentRepository,
  historyRepository,
  importService,
  nodeRepository,
  refRepository,
  settingsRepository,
  vectorService
} from './data/repositories.js';

// AppBody 内的 A 类（自身 utility / handler / state / useRef）类型收紧专用本地接口。
// 沿数据流上游（hook 子集接口对齐 docState 真返回）在第 18 刀。
type AppBodyAxiomPatchIn = Record<string, unknown>;
type AppBodyAxiomPatchOut = Record<string, unknown>;
type UnknownStack = unknown[];
type UnknownStackUpdater = UnknownStack | ((prev: UnknownStack) => UnknownStack);
type DebugContextLog = Record<string, unknown>;
type LastUiAction = { event: string; [extra: string]: unknown } | null;

// D 类（IPC 边界返回值字段散落访问 `{}` 报 TS2339）：在顶部定一组 IPC 投影 interface，使用点单点 cast。
// 这些接口字段全 optional——IPC 边界形态、上游真签名（documentRepository / agentRepository）这一刀不动。
interface AppBodyBeginEditBranchResult {
  baseDocId?: unknown;
  branch?: EditBranchRow | null;
  [extra: string]: unknown;
}

interface AppBodyApplyMergeResult {
  applied?: unknown;
  baseDocId?: unknown;
  changed?: unknown;
  [extra: string]: unknown;
}

interface AppBodyPendingBranchRow {
  base_doc_id?: unknown;
  shadow_doc_id?: unknown;
  [extra: string]: unknown;
}

interface AppBodyPendingBranchesResult {
  branches?: AppBodyPendingBranchRow[];
  [extra: string]: unknown;
}

interface AppBodyOpenedDoc {
  doc?: { id?: unknown; node_count?: unknown; [extra: string]: unknown } | null;
  tree?: { id?: unknown; [extra: string]: unknown } | null;
  editBranch?: EditBranchRow | null;
  sourceWindow?: { anchorNodeId?: unknown; [extra: string]: unknown } | null;
  [extra: string]: unknown;
}

interface AppBodyAddAxiomResult {
  axiom?: { id?: unknown; [extra: string]: unknown } | null;
  [extra: string]: unknown;
}

interface AppBodyCaptureToken {
  token?: { id?: unknown; docId?: unknown; [extra: string]: unknown } | null;
  [extra: string]: unknown;
}

interface AppBodyAgentRequestResult {
  usage?: unknown;
  answer?: string;
  diffs?: unknown[];
  toolEvents?: unknown[];
  segments?: unknown[];
  canceled?: boolean;
  changedDocIds?: unknown[];
  sessionId?: unknown;
  [extra: string]: unknown;
}

interface AppBodyApplyDiffResult {
  ok?: unknown;
  diffs?: unknown[];
  docId?: unknown;
  editBranch?: unknown;
  [extra: string]: unknown;
}

interface AppBodyRejectDiffResult {
  diffs?: unknown[];
  [extra: string]: unknown;
}

function c2dAxiomPatch(patch: AppBodyAxiomPatchIn = {}): AppBodyAxiomPatchOut {
  const nextPatch: AppBodyAxiomPatchOut = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'text')) nextPatch.content = patch.text;
  if (Object.prototype.hasOwnProperty.call(patch, 'node_title')) nextPatch.node_title = patch.node_title;
  if (Object.prototype.hasOwnProperty.call(patch, 'node_note')) nextPatch.node_note = patch.node_note;
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) nextPatch.status = patch.status;
  return nextPatch;
}

export function AppBody() {
  const ui = useAppUIContext();
  const {
    busy, notice, progress, operationLock, lockedProgress, activeTab, activeScreen,
    setBusy, setNotice, setProgress, setOperationLock, setActiveTab, setActiveScreen
  } = ui;
  const docState = useDocumentState();
  const {
    docs, docFolders, libraryTree, selectedLibraryEntry, libraryCutPath, currentDoc, sourceWindowLoading,
    setDocs, setDocFolders, setLibraryTree, setSelectedLibraryEntry, setLibraryCutPath, setCurrentDoc, startupOpenRequestedRef,
    loadComplete: loadCompleteDoc,
    loadSourceWindow,
    refreshLibrary: refreshLibraryTree,
    refreshList: refreshDocList
  } = docState;
  const treeView = useTreeViewState(docState);
  const {
    depthLimit, axiomsCollapsed, collapsed, expanded, collapsedOutlineNodeIds,
    setAxiomsCollapsed, setCollapsed, setExpanded, setCollapsedOutlineNodeIds, outlineCollapseDocRef,
    actualMaxDepth, depthOptions,
    c2dDepthControlSeq, c2dDepthControlAction,
    setVisibleDepth, collapseVisibleDepthOne, syncC2dVisibleDepth,
    applyState: applyTreeViewState,
    setPersisted: setPersistedTreeView,
    setPersistedAfterExpansion: setPersistedTreeViewAfterExpansion,
    persistOutline: persistOutlineViewState
  } = treeView;
  const selection = useNodeSelection(docState);
  const {
    selectedNodeId, selectedNode, multiSelectedNodeIds, locateRequest,
    setSelectedNodeId, setMultiSelectedNodeIds, setLocateRequest
  } = selection;
  const editor = useEditorOps();
  const {
    undoStack, redoStack, setUndoStack: setUndoStackState, setRedoStack: setRedoStackState
  } = editor;
  // 编辑模式 = 当前文档是否持有编辑分支标识（需求 8-3-2）；不另设独立开关，二者不可能不一致。
  const treeEditMode = Boolean(currentDoc?.editBranch);

  // 统一忙碌锁：包住一次异步操作，开始置忙、结束复位，免去每处手写 setBusy + try/finally。
  const withBusy = useCallback(async (fn: () => Promise<unknown> | unknown): Promise<unknown> => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  }, [setBusy]);
  // useEditorOps 的 undo/redoStack 现 narrow 成 never[]（第 18 刀会对齐 hook 真返回）；
  // 这里 useRef 给显式 UnknownStack 泛型，setter 调用处用 Parameters 边界 cast 适配。
  const undoStackRef = useRef<UnknownStack>(undoStack);
  const redoStackRef = useRef<UnknownStack>(redoStack);
  const debugContextRef = useRef<DebugContextLog>({});
  const lastUiActionRef = useRef<LastUiAction>(null);
  const previousActiveTabRef = useRef<typeof activeTab>(activeTab);

  const updateUndoStack = useCallback((update: UnknownStackUpdater) => {
    const next = typeof update === 'function' ? update(undoStackRef.current) : update;
    undoStackRef.current = Array.isArray(next) ? next : [];
    setUndoStackState(undoStackRef.current);
    return undoStackRef.current;
  }, [setUndoStackState]);

  const updateRedoStack = useCallback((update: UnknownStackUpdater) => {
    const next = typeof update === 'function' ? update(redoStackRef.current) : update;
    redoStackRef.current = Array.isArray(next) ? next : [];
    setRedoStackState(redoStackRef.current);
    return redoStackRef.current;
  }, [setRedoStackState]);

  useEffect(() => {
    undoStackRef.current = undoStack;
  }, [undoStack]);

  useEffect(() => {
    redoStackRef.current = redoStack;
  }, [redoStack]);
  const layout = useLayout();
  const {
    leftWidth, rightWidth, leftCollapsed, rightCollapsed, leftRailAnimate, rightRailAnimate,
    docPanelHeight, outlineCollapsedDown, leftSidebarRef, docPanelRef,
    startSidebarResize, startDocOutlineResize,
    toggleLeft: toggleLeftSidebar, toggleRight: toggleRightSidebar
  } = layout;
  const settingsState = useSettings();
  const {
    vectorSettings, memorySettings, llmSummarySettings, nodeLayoutSettings,
    setVectorSettings, setLlmSummarySettings, setNodeLayoutSettings, saveVectorSettings, saveMemorySettings, saveLlmSummarySettings, saveNodeLayoutSettings
  } = settingsState;
  const agentChat = useAgentChat();
  const {
    settings: agentSettings,
    messages: agentMessages,
    diffs: agentDiffs,
    sessions: agentSessions,
    activeSessionId: activeAgentSessionId,
    busy: agentBusy,
    contextUsage: agentContextUsage,
    setSettings: setAgentSettings,
    setMessages: setAgentMessages,
    setDiffs: setAgentDiffs,
    setActiveSessionId: setActiveAgentSessionId,
    setBusy: setAgentBusy,
    setContextUsage: setAgentContextUsage,
    saveSettings: saveAgentSettingsCore,
    refreshSessions: refreshAgentSessions,
    newSession: newAgentSession,
    loadSession: loadAgentSession,
    deleteSession: deleteAgentSession
  } = agentChat;
  const activeAgentRequestIdRef = useRef<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<unknown[]>([]);
  const {
    entityQuery, setEntityQuery, entityRows, selectedEntity, entityDetail,
    entityNodeQuery, entityNodeMatchMode, entityNodeResults, entityNodeGroups, entityNodePage,
    changeEntityNodeMatchMode, changeEntityNodeQuery,
    runEntitySearch, runEntityNodeSearch, selectEntityTraceEntity, useEntityTraceKeyword,
    pageEntityNodeSearch, dragEntityTraceEntity, dropEntityIntoNodeSearch, openEntityMaintenance
  } = useEntityTrace({
    docId: currentDoc?.doc?.id
  });
  const runWrite = useWritePipeline({
    currentDoc,
    treeEditMode,
    docState,
    setBusy,
    setNotice,
    setDocs,
    redoStackRef,
    updateUndoStack,
    updateRedoStack,
    captureEditorHistoryToken,
    editorHistoryViewState,
    normalizeEditorHistoryEffect,
    discardHistoryTokens,
    pushHistoryToken,
    activeEditBranch,
    syncEditBranchHistoryStacks
  });
  const {
    summaryNotesVisible, toggleSummaryNotesVisible,
    generateSummary, runSummaryGeneration, cancelSummaryGeneration
  } = useSummaryRun({
    currentDoc,
    treeEditMode,
    selectedNode,
    selectedNodeId,
    multiSelectedNodeIds,
    llmSummarySettings,
    setDocs,
    dispatch: runWrite
  });
  const [axiomDialog, setAxiomDialog] = useState<{ docId?: unknown; content?: string } | null>(null);
  const [axiomRefDialog, setAxiomRefDialog] = useState<{ docId?: unknown; nodeId?: unknown; axiomId?: unknown; options?: Array<{ id?: unknown; label?: string; content?: string }> } | null>(null);
  const editExitDialog = usePromptDialog();
  const startupEditBranchDialog = usePromptDialog();
  const agentApprovalEditDialog = usePromptDialog();
  // 进入编辑模式的转移锁：防止快速双击锁按钮重复 beginEditBranch。
  const editModeTransitionRef = useRef(false);
  // 撤销/重做在途锁：键盘连发 Ctrl+Z 会绕过按钮 disabled，必须同步挡住重入。
  const historyOpInFlightRef = useRef(false);
  const [editBranchDiffDialog, setEditBranchDiffDialog] = useState<{
    open: boolean;
    loading: boolean;
    view: EditBranchDiffViewModel | null;
    error: string;
  }>({
    open: false,
    loading: false,
    view: null,
    error: ''
  });
  const [mergeConflictDialog, setMergeConflictDialog] = useState<{
    open: boolean;
    applying: boolean;
    view: unknown;
    error: string;
    ctx: { shadowDocId: string | null; baseDocId: string | null; owner: string; sourceDoc: unknown } | null;
  }>({
    open: false,
    applying: false,
    view: null,
    error: '',
    ctx: null
  });

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = debugElementTarget(event.target);
      if (!target) return;
      const payload = {
        button: event.button,
        target,
        ...debugContextRef.current
      };
      lastUiActionRef.current = {
        event: 'ui.click',
        button: event.button,
        target,
        ...debugContextRef.current
      };
      debugLog('ui.click', payload);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!debugShouldLogKey(event)) return;
      const editable = isEditableTarget(event.target as Element | null);
      if (editable && !(event.ctrlKey || event.metaKey || event.altKey || event.key === 'Escape')) return;
      const payload = {
        key: event.key,
        code: event.code,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        meta: event.metaKey,
        target: debugElementTarget(event.target),
        ...debugContextRef.current
      };
      lastUiActionRef.current = {
        event: 'ui.keydown',
        key: event.key,
        code: event.code,
        ...debugContextRef.current
      };
      debugLog('ui.keydown', payload);
    };
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  const vectorModuleDisabled = vectorSettings?.enabled === false;
  const vectorDisabledMessage = vectorSettings?.disabledReason || '向量模块已由用户禁用';
  const docBySourcePath = useMemo(() => {
    const byPath = new Map();
    for (const doc of docs) {
      const sourcePath = docSourcePath(doc);
      if (sourcePath) byPath.set(normalizeFsPath(sourcePath), doc);
    }
    return byPath;
  }, [docs]);
  const visibleNodeCount = Number(currentDoc?.doc?.node_count) > 0
    ? Number(currentDoc!.doc!.node_count)
    : Number(currentDoc?.nodes?.length || 0);
  const visibleDepthLimit = depthLimit;
  const visibleDepthOptions = depthOptions;
  const closeAfterEditModeSaveRef = useRef(false);
  const { armRenderUnlock, handleMindMapRenderReady } = useStartup({
    currentDoc,
    lastUiActionRef,
    startupOpenRequestedRef,
    setDocs,
    setDocFolders,
    setLibraryTree,
    setVectorSettings,
    setLlmSummarySettings,
    setNodeLayoutSettings,
    setAgentSettings,
    setAgentDiffs,
    refreshAgentSessions,
    openDoc,
    promptStartupEditBranchChoice,
    editBranchBaseDocId
  });
  const activeSourceSpans = currentDoc?.sourceWindow?.sourceSpans || currentDoc?.sourceSpans || null;
  const sentenceLabelByNodeId = useMemo(() => {
    if (!((activeSourceSpans?.length ?? 0) > 0)) return new Map();
    // debug 模式下测全树 sentence label 聚合耗时——这个会在 sourceSpans 变化（如翻窗口）时重跑
    const perfToken = debugPerfBegin('buildNodeSentenceLabelMap');
    const map = buildNodeSentenceLabelMap(currentDoc?.tree ?? null, activeSourceSpans as Parameters<typeof buildNodeSentenceLabelMap>[1]) as Map<string, string>;
    debugPerfEnd('buildNodeSentenceLabelMap', perfToken, { spans: activeSourceSpans!.length, nodes: map.size });
    return map;
  }, [currentDoc?.tree, currentDoc?.sourceSpans, currentDoc?.sourceWindow?.sourceSpans]);
  const paragraphLabelByNodeId = useMemo(() => {
    // debug 模式下测段落 label 聚合耗时
    const perfToken = debugPerfBegin('buildParagraphLabelMap');
    const map = buildParagraphLabelMap(currentDoc?.tree) as Map<string, string>;
    debugPerfEnd('buildParagraphLabelMap', perfToken, { nodes: map?.size ?? 0 });
    return map;
  }, [currentDoc?.tree]);
  function addAxiomFromReadableView() {
    if (!treeEditMode) {
      setNotice('请先进入编辑模式');
      return null;
    }
    return openAxiomDialog(currentDoc?.tree?.id || null);
  }

  function activeEditBranch(doc: { editBranch?: unknown } | null | undefined = currentDoc): EditBranchRow | null {
    return (doc?.editBranch || null) as EditBranchRow | null;
  }

  function editBranchBaseDocId(branch: unknown = activeEditBranch()) {
    const obj = branch as EditBranchRow | null | undefined;
    return normalizeDocId(obj?.base_doc_id);
  }

  function editBranchShadowDocId(branch: unknown = activeEditBranch()) {
    const obj = branch as EditBranchRow | null | undefined;
    return normalizeDocId(obj?.shadow_doc_id);
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

  function syncEditBranchHistoryStacks(branch: unknown = activeEditBranch()) {
    // 进入编辑模式时旧栈里是非编辑模式的快照 token，整栈替换前先释放；
    // 编辑模式内的常规刷新旧栈是 diff entry，discard 会被前缀过滤成空操作。
    // 形参 unknown：useWritePipeline/useSummaryRun 等下游 hook 字段也是 unknown，函数变体兼容。
    const branchObj = branch as EditBranchRow | null | undefined;
    discardHistoryTokens([...undoStackRef.current, ...redoStackRef.current]);
    updateUndoStack(editBranchUndoEntries(branchObj));
    updateRedoStack(editBranchRedoEntries(branchObj));
  }

  const diffBranchOptions = useMemo(() => {
    const branch = activeEditBranch(currentDoc);
    if (!branch) return [];
    const activeEntryCount = editBranchUndoEntries(branch).length;
    const owner = String(branch.owner || 'human');
    return [{
      id: branch.id,
      owner,
      label: owner.split('#')[0].split(':')[0] === 'llm' ? 'LLM 分支' : 'human 分支',
      activeEntryCount,
      disabled: activeEntryCount <= 0,
      branch
    }];
  }, [currentDoc?.editBranch]);

  async function loadDocForCurrentView(docId: unknown, sourceDoc: unknown = currentDoc) {
    const depth = Math.max(loadedDepthForDoc(sourceDoc as Parameters<typeof loadedDepthForDoc>[0]), depthLimit, 1);
    return documentRepository.getDoc(treeDocRequest(docId, depth));
  }

  // 退出编辑切回主干 doc（base↔shadow node_id 不同）= 重建 session：直接 loadComplete 扩散加载目标 doc，
  // 折叠/深度从该 doc 的 tree_view_state 持久化恢复（loadComplete 内做），不手工 remap（扩散下映射不全）。
  async function switchDocPreservingView(
    nextDocId: unknown,
    _sourceDoc: unknown,
    { persistedDocId, noticeText }: { persistedDocId?: unknown; noticeText?: string } = {}
  ) {
    const docId = normalizeDocId(nextDocId);
    if (!docId) return;
    setSelectedLibraryEntry(null);
    persistActiveDocId(persistedDocId || docId);
    await loadCompleteDoc(docId);
    docState.patchDocMeta({ editBranch: null }); // 退出编辑：清编辑分支标识
    clearHistoryStacks();
    if (noticeText) setNotice(noticeText);
  }

  // 弹窗超时/被顶替时的兜底返回值与各自的 backdrop 默认值保持一致（见各 ChoiceDialog）。
  function promptEditExitChoice() {
    return editExitDialog.prompt({}, 'cancel');
  }

  function promptStartupEditBranchChoice(branch: unknown) {
    return startupEditBranchDialog.prompt((branch || {}) as Record<string, unknown>, 'stash');
  }

  function promptAgentApprovalEditChoice() {
    return agentApprovalEditDialog.prompt({}, 'cancel');
  }

  function clearEditModeState(noticeText = '已退出编辑模式') {
    if (currentDoc?.editBranch) docState.patchDocMeta({ editBranch: null });
    clearHistoryStacks();
    if (noticeText) setNotice(noticeText);
  }

  // 进入编辑模式的唯一入口：开影子分支、切持久化 docId、置编辑态、同步撤销栈。
  // 用 editModeTransitionRef + busy 双重护栏，避免快速双击重复 beginEditBranch。
  async function enterEditMode() {
    if (treeEditMode && activeEditBranch()) return true;
    const sourceDoc = currentDoc;
    if (!sourceDoc?.doc?.id) {
      setNotice('请先打开文档');
      return false;
    }
    if (editModeTransitionRef.current) return false;
    editModeTransitionRef.current = true;
    setBusy(true);
    try {
      const result = await documentRepository.beginEditBranch({ docId: sourceDoc.doc.id, owner: 'human', includeDoc: false }) as AppBodyBeginEditBranchResult | null;
      const baseDocId = result?.baseDocId || result?.branch?.base_doc_id || sourceDoc.doc.id;
      if (!baseDocId) throw new Error('进入编辑模式失败');
      if (sameDocId(currentDoc?.doc?.id, sourceDoc?.doc?.id)) {
        docState.patchDocMeta({ editBranch: result?.branch || null });
      }
      persistActiveDocId(baseDocId);
      syncEditBranchHistoryStacks(result?.branch || null);
      setNotice('已进入编辑模式');
      return true;
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
      return false;
    } finally {
      setBusy(false);
      editModeTransitionRef.current = false;
    }
  }

  async function ensureAgentApprovalEditMode() {
    if (treeEditMode && activeEditBranch()) return true;
    if (!currentDoc?.doc?.id) {
      setNotice('请先打开待审变更所属文档');
      return false;
    }
    const choice = await promptAgentApprovalEditChoice();
    if (choice !== 'enter') return false;
    return enterEditMode();
  }

  async function saveAndLeaveEditMode(targetDocId: unknown = null) {
    const branch = activeEditBranch();
    if (!treeEditMode) return true;
    if (!branch) {
      clearEditModeState();
      return true;
    }
    const baseDocId = editBranchBaseDocId(branch);
    const shadowDocId = editBranchShadowDocId(branch);
    // 审核通道统一：保存/丢弃按分支实际 owner 操作（llm 分支同走本流程），不写死 human。
    const branchOwner = String(branch?.owner || 'human');
    if (targetDocId && (sameDocId(targetDocId, baseDocId) || sameDocId(targetDocId, shadowDocId))) return true;
    // 离场转移锁（与 enterEditMode 同一把 ref）：弹窗悬停或保存进行中再次触发离场
    // （锁按钮、切文档、关窗）一律拒绝——防重复弹窗与重复 applyMerge（实际翻过车：
    // busy 中连点三次保存发出三发 applyMerge，第二发起全是 Edit branch not found）。
    if (editModeTransitionRef.current) return false;
    editModeTransitionRef.current = true;
    try {
      const choice = await promptEditExitChoice();
      if (choice !== 'save' && choice !== 'discard') return false;
      setBusy(true);
      // 保存/丢弃成功后的统一离场：重载主干、退出编辑投影、刷新文档列表。
      const leaveWithTrunk = async (docIdToLoad: unknown, sourceDoc: unknown, noticeText: string) => {
        await switchDocPreservingView(docIdToLoad, sourceDoc, {
          persistedDocId: docIdToLoad,
          noticeText
        });
        setDocs(await documentRepository.listDocs() as Parameters<typeof setDocs>[0]);
      };
      try {
        const sourceDoc = currentDoc;
        if (choice === 'discard') {
          // Tell the backend to skip the post-discard refreshDoc so this stays a
          // pure entries-delete; we re-fetch ourselves with the depth the view
          // actually needs.
          await documentRepository.discardEditBranch({ shadowDocId, owner: branchOwner, includeDoc: false });
          await leaveWithTrunk(baseDocId, sourceDoc, '已丢弃本次编辑并退出');
          return true;
        }
        const result = await documentRepository.applyEditBranchMerge({ shadowDocId, owner: branchOwner, includeDoc: false }) as AppBodyApplyMergeResult | null;
        if (!result?.applied) {
          // 主干在编辑期间前移：字段级冲突 → 三列面板人裁；结构性失配（blocked）→
          // 「主干已被修改，无法保存」，只能放弃本次编辑或取消保留分支。两种都留在编辑模式，不静默覆盖。
          setMergeConflictDialog({
            open: true,
            applying: false,
            view: result,
            error: '',
            ctx: { shadowDocId, baseDocId, owner: branchOwner, sourceDoc }
          });
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
        let branchGone = /Edit branch not found/i.test(String((error as { message?: string } | null | undefined)?.message || error));
        if (!branchGone) {
          try {
            const pending = await documentRepository.getPendingEditBranches() as AppBodyPendingBranchesResult | null;
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
              currentDoc,
              choice === 'save' ? '已保存当前编辑状态并退出编辑模式' : '已丢弃本次编辑并退出'
            );
          } catch (refreshError) {
            clearEditModeState(`已退出编辑模式；视图刷新失败：${(refreshError as { message?: string } | null | undefined)?.message ?? String(refreshError)}`);
          }
          return true;
        }
        setNotice((error as { message?: string }).message ?? '');
        return false;
      } finally {
        setBusy(false);
      }
    } finally {
      editModeTransitionRef.current = false;
    }
  }

  const currentVisualDocId = editBranchBaseDocId() || normalizeDocId(currentDoc?.doc?.id);
  debugContextRef.current = {
    screen: activeScreen,
    view: activeTab,
    docId: currentVisualDocId,
    rawDocId: normalizeDocId(currentDoc?.doc?.id),
    selectedNodeId: normalizeDocId(selectedNode?.id),
    editMode: treeEditMode ? 'editing' : 'readonly',
    busy,
    depth: visibleDepthLimit,
    maxDepth: actualMaxDepth
  };

  const changeActiveTab = useCallback((nextTab: unknown) => {
    const targetTab = String(nextTab || '');
    const payload = {
      from: activeTab,
      to: targetTab,
      ...debugContextRef.current
    };
    lastUiActionRef.current = {
      event: 'ui.view.change.request',
      ...payload
    };
    debugLog('ui.view.change.request', payload);
    setActiveTab(targetTab);
  }, [activeTab, setActiveTab]);

  useEffect(() => {
    const previous = previousActiveTabRef.current;
    if (previous !== activeTab) {
      debugLog('ui.view.changed', {
        from: previous,
        to: activeTab,
        ...debugContextRef.current
      });
      previousActiveTabRef.current = activeTab;
    }
  }, [activeTab, activeScreen, currentVisualDocId, treeEditMode, busy, visibleDepthLimit, actualMaxDepth]);

  async function confirmLeaveEditMode(targetDocId: unknown = null) {
    return saveAndLeaveEditMode(targetDocId);
  }

  async function handleCloseWindow() {
    if (closeAfterEditModeSaveRef.current) {
      closeWindow().catch((error) => setNotice((error as { message?: string }).message ?? ''));
      return;
    }
    const saved = await saveAndLeaveEditMode();
    if (!saved) return;
    closeAfterEditModeSaveRef.current = true;
    closeWindow().catch((error) => {
      closeAfterEditModeSaveRef.current = false;
      setNotice((error as { message?: string }).message ?? '');
    });
  }

  async function refreshDocs(
    nextDocId: unknown = currentVisualDocId,
    options: { autoOpen?: boolean } = {}
  ) {
    const list = await refreshDocList();
    const branch = activeEditBranch();
    if (branch && (sameDocId(nextDocId, editBranchBaseDocId(branch)) || sameDocId(nextDocId, editBranchShadowDocId(branch)))) {
      return list;
    }
    const targetDoc = normalizeDocId(nextDocId)
      ? list.find((item) => normalizeDocId(item.id) === normalizeDocId(nextDocId))
      : null;
    if (targetDoc) {
      setBusy(true);
      setOperationLock({ label: '正在打开文档……', step: 0, total: 0 });
      const waitForRender = activeTab === 'tree';
      const prevSelectedId = selectedNodeId;
      try {
        const doc = await loadCompleteDoc(targetDoc.id, undefined, { keepLockAfterLoad: waitForRender });
        const isDifferentDoc = normalizeDocId(currentDoc?.doc?.id) !== normalizeDocId(doc?.doc?.id);
        const renderUnlockArmed = waitForRender && isDifferentDoc && doc?.tree
          ? armRenderUnlock(doc?.doc?.id || targetDoc.id, 'refresh-doc')
          : false;
        // loadComplete 已建 session + 投影 + 从 tree_view_state 恢复折叠；这里只补非视图编排。
        setSelectedLibraryEntry(null);
        persistActiveDocId(doc?.doc?.id || targetDoc.id);
        // 同文档刷新保留选中（loadComplete 重置为 null，显式恢复）；切文档保持 null。
        if (!isDifferentDoc && prevSelectedId) setSelectedNodeId?.(prevSelectedId);
        setBusy(false);
        if (!renderUnlockArmed) {
          setProgress(null);
          setOperationLock(null);
        }
      } catch (error) {
        setBusy(false);
        setProgress(null);
        setOperationLock(null);
        throw error;
      }
    } else if (options.autoOpen && list.length > 0) {
      await openDoc(list[0].id);
    } else if (nextDocId) {
      persistActiveDocId(null);
    }
    return list;
  }

  async function openDoc(
    docId: unknown,
    options: {
      includeEditBranch?: boolean;
      onComplete?: (doc: unknown) => void;
      onFailure?: (error: unknown) => void;
    } = {}
  ) {
    const branch = activeEditBranch();
    if (branch && (sameDocId(docId, editBranchBaseDocId(branch)) || sameDocId(docId, editBranchShadowDocId(branch)))) {
      return currentDoc;
    }
    const canLeave = await confirmLeaveEditMode(docId);
    if (!canLeave) return null;
    setBusy(true);
    setOperationLock({ label: '正在打开文档……', step: 0, total: 0 });
    const waitForRender = activeTab === 'tree';
    try {
      const doc = await loadCompleteDoc(docId, undefined, {
        keepLockAfterLoad: waitForRender,
        includeEditBranch: options.includeEditBranch
      });
      const openedBranch = activeEditBranch(doc);
      const openedBaseDocId = editBranchBaseDocId(openedBranch);
      const isDifferentDoc = normalizeDocId(currentDoc?.doc?.id) !== normalizeDocId(doc?.doc?.id);
      const renderUnlockArmed = waitForRender && isDifferentDoc && doc?.tree
        ? armRenderUnlock(doc?.doc?.id || docId, 'open-doc')
        : false;
      // loadComplete 已建 session + 投影 + 恢复折叠/深度，selected 默认 null；这里只管非视图编排。
      persistActiveDocId(openedBaseDocId || doc?.doc?.id || docId);
      setSelectedLibraryEntry(null);
      if (openedBranch) syncEditBranchHistoryStacks(openedBranch);
      else clearHistoryStacks();
      setSearchResults([]);
      setLocateRequest((prev) => ({ seq: (prev?.seq || 0) + 1, nodeId: doc?.tree?.id || null }));
      setBusy(false);
      if (!renderUnlockArmed) {
        setProgress(null);
        setOperationLock(null);
      }
      options.onComplete?.(doc);
      return doc;
    } catch (error) {
      setBusy(false);
      setProgress(null);
      setOperationLock(null);
      options.onFailure?.(error);
      throw error;
    }
  }

  async function openLibraryNavigation() {
    const canLeave = await confirmLeaveEditMode();
    if (!canLeave) return null;
    setBusy(true);
    try {
      const doc = await documentRepository.getLibraryNavigation() as AppBodyOpenedDoc | null;
      // 库导航是虚拟 doc（不建 session）：先清旧 session + 停预取，避免旧预取 project 覆盖虚拟视图。
      setCurrentDoc(null);
      setCurrentDoc(doc as Parameters<typeof setCurrentDoc>[0]);
      setSelectedLibraryEntry(null);
      persistActiveDocId(null);
      clearHistoryStacks();
      setSearchResults([]);
      setLocateRequest((prev) => ({ seq: (prev?.seq || 0) + 1, nodeId: doc?.tree?.id || null }));
      return doc;
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
      return null;
    } finally {
      setBusy(false);
      setProgress(null);
      setOperationLock(null);
    }
  }

  useEffect(() => {
    return onProgress((rawData: unknown) => {
      const data = (rawData || {}) as { done?: boolean; [extra: string]: unknown };
      setProgress(data.done ? null : data);
    });
  }, []);

  useEffect(() => {
    return onLibraryChanged(() => {
      refreshLibraryTree();
    });
  }, []);

  useEffect(() => {
    const docId = currentVisualDocId || null;
    if (!docId) {
      outlineCollapseDocRef.current = null;
      setCollapsedOutlineNodeIds(new Set());
      return;
    }
    if (outlineCollapseDocRef.current === docId) return;
    outlineCollapseDocRef.current = docId;
    const state = treeViewStateFromDoc(currentDoc, fullDepthForDoc(currentDoc));
    setCollapsedOutlineNodeIds(state.outlineCollapsed || defaultCollapsedOutlineIds(currentDoc?.tree));
  }, [currentVisualDocId, currentDoc?.tree]);

  useEffect(() => {
    setAxiomsCollapsed(Boolean(currentDoc?.doc?.axioms_collapsed));
  }, [currentDoc?.doc?.id, currentDoc?.doc?.axioms_collapsed]);

  useEffect(() => {
    const docId = normalizeDocId(currentDoc?.doc?.id);
    if (!docId || activeTab !== 'rich') return undefined;
    if (!currentDoc?.sourceDocument) return undefined;

    const anchorNodeId = normalizeDocId(selectedNodeId);
    const loadedWindow = currentDoc?.sourceWindow;
    const loadedAnchor = normalizeDocId(loadedWindow?.anchorNodeId);
    if (loadedWindow?.docId === docId && loadedAnchor === anchorNodeId) return undefined;

    loadSourceWindow({
      docId,
      nodeId: anchorNodeId,
      before: SOURCE_WINDOW_BEFORE_CHARS
    });
    return undefined;
  }, [activeTab, currentDoc?.doc?.id, currentDoc?.sourceDocument?.doc_id, currentDoc?.sourceWindow?.anchorNodeId, selectedNodeId]);

  function editorHistoryViewState(targetDocId = currentDoc?.doc?.id) {
    const docId = normalizeDocId(targetDocId);
    if (!docId) return null;
    return {
      docId,
      activeTab,
      depthLimit,
      collapsedNodeIds: [...collapsed].map(normalizeDocId).filter(Boolean),
      expandedNodeIds: [...expanded].map(normalizeDocId).filter(Boolean),
      selectedNodeId: normalizeDocId(selectedNode?.id || selectedNodeId)
    };
  }

  // history token/viewState/effect 都是 IPC 边界对象；形参一律 unknown，函数内 narrow 后用 Record<string, unknown> 访问字段。
  function normalizeEditorHistoryViewState(value: unknown) {
    if (!value || typeof value !== 'object') return null;
    const obj = value as Record<string, unknown>;
    const docId = normalizeDocId(obj.docId || obj.doc_id);
    if (!docId) return null;
    const activeTabRaw = typeof obj.activeTab === 'string' ? obj.activeTab : '';
    const allowedTabs = ['tree', 'ide', 'rich', 'entity', 'search'];
    return {
      docId,
      activeTab: allowedTabs.includes(activeTabRaw) ? activeTabRaw : null,
      depthLimit: Math.max(1, Math.floor(Number(obj.depthLimit) || 1)),
      collapsedNodeIds: [...idSetFromArray(obj.collapsedNodeIds)],
      expandedNodeIds: [...idSetFromArray(obj.expandedNodeIds)],
      selectedNodeId: normalizeDocId(obj.selectedNodeId || obj.selected_node_id)
    };
  }

  function normalizeEditorHistoryEffect(value: unknown) {
    if (!value || typeof value !== 'object') return null;
    const obj = value as Record<string, unknown>;
    const kind = String(obj.kind || '');
    if (kind !== 'expandNodeOne') return null;
    const docId = normalizeDocId(obj.docId || obj.doc_id || currentDoc?.doc?.id);
    const nodeId = normalizeDocId(obj.nodeId || obj.node_id);
    if (!docId || !nodeId) return null;
    return {
      kind,
      docId,
      nodeId,
      minDepth: Math.max(0, Math.floor(Number(obj.minDepth) || 0))
    };
  }

  function attachEditorHistoryViewState(token: unknown, viewState: unknown = null, effect: unknown = null) {
    const normalized = normalizeHistoryToken(token);
    if (!normalized) return null;
    const tokenObj = (token && typeof token === 'object' ? token : {}) as Record<string, unknown>;
    const normalizedEffect = normalizeEditorHistoryEffect(
      effect || tokenObj.effect || tokenObj.redoEffect || normalized.effect
    );
    return {
      ...normalized,
      viewState: normalizeEditorHistoryViewState(viewState || tokenObj.viewState) || normalized.viewState || null,
      effect: normalizedEffect || null
    };
  }

  function applyEditorHistoryViewState(viewState: unknown, doc: unknown) {
    const state = normalizeEditorHistoryViewState(viewState);
    const docObj = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
    const docDoc = docObj.doc as { id?: unknown } | null | undefined;
    const docId = normalizeDocId(docDoc?.id || currentDoc?.doc?.id);
    if (!state || !sameDocId(state.docId, docId)) {
      if (doc) applyTreeViewState(doc);
      return;
    }
    const nextDepthLimit = clampDepthLimit(state.depthLimit, fullDepthForDoc((doc || currentDoc) as Parameters<typeof fullDepthForDoc>[0]));
    if (state.activeTab) setActiveTab(state.activeTab);
    setPersistedTreeView(
      nextDepthLimit,
      idSetFromArray(state.collapsedNodeIds),
      idSetFromArray(state.expandedNodeIds),
      state.docId
    );
    if (state.selectedNodeId) {
      const treeIndex = docObj.treeIndex as { nodeOf?: (id: unknown) => { id?: unknown } | null | undefined } | undefined;
      const node = findNode(docObj.tree, state.selectedNodeId) || treeIndex?.nodeOf?.(state.selectedNodeId);
      setSelectedNodeId?.(node?.id || state.selectedNodeId);
    }
  }

  function normalizeHistoryToken(token: unknown) {
    const obj = (token && typeof token === 'object' ? token : {}) as Record<string, unknown>;
    const id = String(obj.id || obj.tokenId || '');
    const docId = normalizeDocId(obj.docId || obj.doc_id || currentDoc?.doc?.id);
    if (!id || !docId) return null;
    return {
      id,
      docId,
      viewState: normalizeEditorHistoryViewState(obj.viewState),
      effect: normalizeEditorHistoryEffect(obj.effect || obj.redoEffect)
    };
  }

  async function captureEditorHistoryToken(
    docId: unknown = currentDoc?.doc?.id,
    viewState: unknown = editorHistoryViewState(docId),
    effect: unknown = null
  ) {
    const normalizedDocId = normalizeDocId(docId);
    if (!normalizedDocId) return null;
    const result = await historyRepository.captureEditorHistoryToken({ docId: normalizedDocId }) as AppBodyCaptureToken | null;
    return attachEditorHistoryViewState(result?.token || result, viewState, effect);
  }

  // 只有后端 editorSnapshotTokens 里的快照 token（id 形如 editor-N）需要释放；
  // 编辑分支栈里的 diff entry 会被 normalizeHistoryToken 误判成 token（docId 有兜底），靠前缀挡掉。
  function tokenIds(tokens: unknown[]) {
    return snapshotTokenIds(tokens, (token: unknown) => normalizeHistoryToken(token)?.id);
  }

  function discardHistoryTokens(tokens: unknown[]) {
    const ids = tokenIds(tokens);
    if (ids.length === 0) return;
    historyRepository.discardEditorHistoryTokens({ tokenIds: ids }).catch((error) => setNotice((error as { message?: string }).message ?? ''));
  }

  // 栈封顶 80：被挤出的旧 token 必须通知后端释放对应全量快照，否则滞留到进程退出。
  function pushHistoryToken(stack: unknown[], token: unknown) {
    const { stack: next, evicted } = pushCapped(stack, token);
    if (evicted.length > 0) discardHistoryTokens(evicted);
    return next;
  }

  function clearHistoryStacks() {
    discardHistoryTokens([...undoStackRef.current, ...redoStackRef.current]);
    updateUndoStack([]);
    updateRedoStack([]);
  }

  async function toggleAxiomsCollapsed() {
    const docId = currentDoc?.doc?.id;
    const nextValue = !axiomsCollapsed;
    if (!docId) {
      setAxiomsCollapsed(nextValue);
      return;
    }
    setAxiomsCollapsed(nextValue);
    setBusy(true);
    try {
      const next = await documentRepository.updateDocAxiomsCollapsed({ docId, collapsed: nextValue, includeDoc: false }) as { doc?: { axioms_collapsed?: unknown; updated_at?: unknown; [k: string]: unknown } } | null;
      if (next) {
        if (sameDocId(currentDoc?.doc?.id, docId)) {
          docState.patchDocMeta({
            doc: {
              ...currentDoc!.doc!,
              axioms_collapsed: Number(next.doc?.axioms_collapsed ?? (nextValue ? 1 : 0)) || 0,
              updated_at: String(next.doc?.updated_at ?? currentDoc!.doc?.updated_at ?? '')
            } as DocRow
          });
        }
        setDocs(await documentRepository.listDocs() as Parameters<typeof setDocs>[0]);
      }
    } catch (error) {
      setAxiomsCollapsed(!nextValue);
      setNotice((error as { message?: string }).message ?? '');
    } finally {
      setBusy(false);
    }
  }

  async function openAxiomDialog(targetNodeId: unknown = null) {
    const docId = currentDoc?.doc?.id;
    if (!docId) return null;
    if (!treeEditMode) {
      setNotice('请先解锁编辑，再新增事实前提。');
      return null;
    }
    const target = targetNodeId ? findNode(currentDoc?.tree, targetNodeId) : null;
    if (axiomsCollapsed) setAxiomsCollapsed(false);
    const result = await runWrite(async () => {
      const result = await axiomRepository.addAxiom({ docId, content: '', status: 'pending' } as Parameters<typeof axiomRepository.addAxiom>[0]) as AppBodyAddAxiomResult | null;
      const axiomId = result?.axiom?.id;
      if (target?.id && depthOf(String(target.address ?? '1')) > 1 && axiomId) {
        await refRepository.addAxiomRefToNode({ docId, nodeId: target.id, axiomId } as Parameters<typeof refRepository.addAxiomRefToNode>[0]);
      }
      if (axiomsCollapsed) {
        await documentRepository.updateDocAxiomsCollapsed({ docId, collapsed: false, includeDoc: false } as Parameters<typeof documentRepository.updateDocAxiomsCollapsed>[0]);
      }
      return result;
    }) as AppBodyAddAxiomResult | null | undefined;
    const axiomId = result?.axiom?.id;
    if (axiomId) {
      setLocateRequest((previous) => ({
        seq: previous.seq + 1,
        nodeId: `axiom:${axiomId}`,
        includeRootAxiomGroup: true
      }));
    }
    return null;
  }

  async function openAxiomRefDialog(targetNodeId: unknown, preferredAxiomId: unknown = null) {
    const docId = currentDoc?.doc?.id;
    const nodeId = normalizeDocId(targetNodeId);
    if (!docId) return null;
    if (!nodeId) {
      setNotice('请先选择要引用事实前提的节点。');
      return null;
    }
    if (!treeEditMode) {
      setNotice('请先解锁编辑，再添加事实前提引用。');
      return null;
    }
    const target = findNode(currentDoc?.tree, nodeId);
    if (!target) return null;
    if (depthOf(String(target.address ?? '1')) <= 1) {
      setNotice('根节点天然引用全部事实前提，无需添加引用。');
      return null;
    }
    const axioms = Array.isArray(currentDoc?.axioms) ? currentDoc.axioms : [];
    if (axioms.length === 0) {
      setNotice('当前文档还没有事实前提。');
      return null;
    }
    const used = new Set((currentDoc?.refs || [])
      .filter((ref) => isFactAxiomRef(ref) && String(ref.target_id) === String(nodeId))
      .map((ref) => String(ref.source_id)));
    const available = axioms.filter((axiom) => !used.has(String(axiom.id)));
    if (available.length === 0) {
      setNotice('当前节点已引用全部事实前提。');
      return null;
    }
    const preferred = available.find((axiom) => String(axiom.id) === String(preferredAxiomId));
    setAxiomRefDialog({
      docId,
      nodeId,
      axiomId: (preferred || available[0]).id,
      options: available
    });
    return null;
  }

  async function applyEditorHistoryEffect(
    effect: unknown,
    doc: unknown,
    options: { minDepth?: number | string } = {}
  ) {
    const normalized = normalizeEditorHistoryEffect(effect);
    const docObj = (doc && typeof doc === 'object' ? doc : {}) as { doc?: { id?: unknown } };
    if (!normalized || !sameDocId(normalized.docId, docObj.doc?.id || currentDoc?.doc?.id)) return false;
    if (normalized.kind === 'expandNodeOne') {
      const requestedMinDepth = Math.max(
        Math.floor(Number(normalized.minDepth) || 0),
        Math.floor(Number(options.minDepth) || 0)
      );
      const maxDepth = fullDepthForDoc((doc || currentDoc) as Parameters<typeof fullDepthForDoc>[0]);
      const minDepth = requestedMinDepth > 0 ? clampDepthLimit(requestedMinDepth, maxDepth) : 0;
      debugLog('editor.history.effect', {
        kind: normalized.kind,
        docId: normalized.docId,
        nodeId: normalized.nodeId,
        minDepth,
        maxDepth
      });
      await expandNodeOneLevel(normalized.nodeId, { minDepth, maxDepth });
      return true;
    }
    return false;
  }

  async function restoreEditorSnapshot(token: unknown, direction: 'undo' | 'redo' | string) {
    const targetToken = normalizeHistoryToken(token);
    if (!targetToken) {
      debugLog('editor.restore.skip', { direction, reason: 'invalid-token' });
      return;
    }
    const targetDocId = normalizeDocId(targetToken.docId || currentDoc?.doc?.id);
    if (!targetDocId) {
      debugLog('editor.restore.skip', { direction, reason: 'invalid-doc' });
      return;
    }
    const targetViewState = normalizeEditorHistoryViewState(targetToken.viewState);
    const targetDepthLimit = Math.max(0, Math.floor(Number(targetViewState?.depthLimit) || 0));
    const targetEffect = normalizeEditorHistoryEffect(targetToken.effect);
    const targetEffectMinDepth = Math.floor(Number(targetEffect?.minDepth) || 0);
    const refreshDepth = Math.max(targetDepthLimit, targetEffectMinDepth);
    setBusy(true);
    try {
      debugLog('editor.restore.start', {
        direction,
        docId: targetDocId,
        tokenId: targetToken.id,
        targetDepthLimit,
        effectKind: targetEffect?.kind || null,
        effectMinDepth: targetEffectMinDepth,
        refreshDepth,
        undoDepth: undoStackRef.current.length,
        redoDepth: redoStackRef.current.length
      });
      const inverseViewState = editorHistoryViewState(targetDocId);
      const result = await historyRepository.restoreEditorHistoryToken({
        docId: targetDocId,
        tokenId: targetToken.id
      }) as { token?: unknown; editBranch?: unknown } | null;
      const inverseToken = attachEditorHistoryViewState(result?.token, inverseViewState, targetEffect);
      if (direction === 'undo' && inverseToken) {
        updateUndoStack((stack) => stack.slice(0, -1));
        updateRedoStack((stack) => pushHistoryToken(stack, inverseToken));
      } else if (direction === 'redo' && inverseToken) {
        updateRedoStack((stack) => stack.slice(0, -1));
        updateUndoStack((stack) => pushHistoryToken(stack, inverseToken));
      }
      // 撤销/重做：后端已回退，重取反映 + 恢复 viewState（折叠/深度/选中走 session 转发壳）。
      docState.patchDocMeta({ editBranch: (result?.editBranch ?? null) as EditBranchRow | null });
      const reloaded = await docState.reloadStructuralChange();
      if (reloaded) {
        applyEditorHistoryViewState(targetViewState, reloaded);
        if (direction === 'redo') await applyEditorHistoryEffect(targetEffect, reloaded, { minDepth: refreshDepth });
      }
      setDocs(await documentRepository.listDocs() as Parameters<typeof setDocs>[0]);
      debugLog('editor.restore.end', {
        direction,
        ok: true,
        docId: targetDocId,
        targetDepthLimit,
        effectKind: targetEffect?.kind || null,
        effectMinDepth: targetEffectMinDepth,
        refreshDepth,
        loadedTreeDepth: loadedDepthForDoc(reloaded),
        undoDepth: undoStackRef.current.length,
        redoDepth: redoStackRef.current.length
      });
      setNotice(direction === 'undo' ? '已撤销上一步编辑' : '已重做编辑');
    } catch (error) {
      debugLog('editor.restore.end', {
        direction,
        ok: false,
        docId: targetDocId,
        error: String((error as { message?: string } | null | undefined)?.message || error || '').slice(0, 240),
        undoDepth: undoStackRef.current.length,
        redoDepth: redoStackRef.current.length
      });
      setNotice((error as { message?: string }).message ?? '');
    } finally {
      setBusy(false);
    }
  }

  async function restoreEditBranchStep(direction: 'undo' | 'redo' | string) {
    const branch = activeEditBranch();
    if (!branch) return;
    const stack = direction === 'undo' ? undoStackRef.current : redoStackRef.current;
    if (stack.length === 0) return;
    const baseDocId = editBranchBaseDocId(branch);
    const shadowDocId = editBranchShadowDocId(branch);
    if (!baseDocId || !shadowDocId) return;

    setBusy(true);
    try {
      debugLog('editor.editBranch.restore.start', {
        direction,
        baseDocId,
        shadowDocId,
        undoDepth: undoStackRef.current.length,
        redoDepth: redoStackRef.current.length
      });
      const branchOwner = String(branch?.owner || 'human');
      const result = (direction === 'undo'
        ? await documentRepository.undoEditBranch({ shadowDocId, owner: branchOwner, includeDoc: false })
        : await documentRepository.redoEditBranch({ shadowDocId, owner: branchOwner, includeDoc: false })) as { branch?: EditBranchRow | null } | null;
      syncEditBranchHistoryStacks(result?.branch || branch);
      const nextDoc = await loadDocForCurrentView(baseDocId, currentDoc) as AppBodyOpenedDoc | null;
      docState.patchDocMeta({ editBranch: nextDoc?.editBranch ?? result?.branch ?? branch ?? null });
      await docState.reloadStructuralChange();
      syncEditBranchHistoryStacks(nextDoc?.editBranch || result?.branch || branch);
      debugLog('editor.editBranch.restore.end', {
        direction,
        ok: true,
        baseDocId,
        undoDepth: undoStackRef.current.length,
        redoDepth: redoStackRef.current.length
      });
      setNotice(direction === 'undo' ? '已撤销上一步编辑' : '已重做编辑');
    } catch (error) {
      debugLog('editor.editBranch.restore.end', {
        direction,
        ok: false,
        baseDocId,
        error: String((error as { message?: string } | null | undefined)?.message || error || '').slice(0, 240),
        undoDepth: undoStackRef.current.length,
        redoDepth: redoStackRef.current.length
      });
      setNotice((error as { message?: string }).message ?? '');
    } finally {
      setBusy(false);
    }
  }

  // full agent 直写 base 后的紧邻回退窗口：编辑模式下栈顶若是 base 快照 token
  //（agent 改动后、下一次分支编辑前），undo/redo 优先恢复 base 快照而非分支条目。
  // 窗口由 syncEditBranchHistoryStacks 重建栈时连带 discard 自然关闭。
  function isEditorHistoryToken(entry: unknown) {
    return String((entry as { id?: unknown } | null | undefined)?.id || '').startsWith('editor-');
  }

  async function undoEdit() {
    const stack = undoStackRef.current;
    debugLog('editor.undo.request', {
      docId: currentDoc?.doc?.id || null,
      undoDepth: stack.length,
      redoDepth: redoStackRef.current.length,
      editMode: treeEditMode
    });
    if (stack.length === 0) return;
    // 键盘 Ctrl+Z 绕过按钮 disabled，连发会让两次 restore 读到同一栈顶、重复出栈。
    // 同步置位的 in-flight ref 挡住重入；busy 兜住「写入/打开进行中」的交叉。
    if (historyOpInFlightRef.current || busy) return;
    historyOpInFlightRef.current = true;
    try {
      if (treeEditMode && !isEditorHistoryToken(stack[stack.length - 1])) {
        await restoreEditBranchStep('undo');
        return;
      }
      await restoreEditorSnapshot(stack[stack.length - 1], 'undo');
    } finally {
      historyOpInFlightRef.current = false;
    }
  }

  async function redoEdit() {
    const stack = redoStackRef.current;
    debugLog('editor.redo.request', {
      docId: currentDoc?.doc?.id || null,
      undoDepth: undoStackRef.current.length,
      redoDepth: stack.length,
      editMode: treeEditMode
    });
    if (stack.length === 0) return;
    if (historyOpInFlightRef.current || busy) return;
    historyOpInFlightRef.current = true;
    try {
      if (treeEditMode && !isEditorHistoryToken(stack[stack.length - 1])) {
        await restoreEditBranchStep('redo');
        return;
      }
      await restoreEditorSnapshot(stack[stack.length - 1], 'redo');
    } finally {
      historyOpInFlightRef.current = false;
    }
  }

  async function createDoc(titleOverride: unknown = null, folderId: unknown = null) {
    const canLeave = await confirmLeaveEditMode();
    if (!canLeave) return;
    const title = typeof titleOverride === 'string' && titleOverride.trim()
      ? titleOverride.trim()
      : '未命名条件树文档';
    await withBusy(async () => {
      try {
        const doc = await documentRepository.createDoc({ title, rootText: title, folderId }) as AppBodyOpenedDoc | null;
        persistActiveDocId(doc?.doc?.id);
        await refreshDocs(doc?.doc?.id);
      } catch (error) {
        setNotice((error as { message?: string }).message ?? '');
      }
    });
  }

  function clearActiveDocumentForLibraryFile() {
    setCurrentDoc(null);
    persistActiveDocId(null);
    setSelectedNodeId?.(null);
    setMultiSelectedNodeIds?.(new Set());
    setCollapsed(new Set());
    setExpanded(new Set());
    clearHistoryStacks();
    setSearchResults([]);
    setLocateRequest({ seq: 0, nodeId: null });
  }

  function showLibraryFileOnly(item: unknown, noticeText = '未导入原始文件，请先手动导入') {
    setSelectedLibraryEntry(item as Parameters<typeof setSelectedLibraryEntry>[0]);
    clearActiveDocumentForLibraryFile();
    setNotice(noticeText);
  }

  const {
    createDocFolder,
    renameDocFolder,
    deleteDocFolder,
    moveDocToFolder,
    moveLibraryItem,
    cutLibraryItem,
    pasteLibraryItem,
    deleteLibraryImport,
    selectLibraryFile
  } = createLibraryActions({
    busy,
    currentDoc,
    docBySourcePath,
    libraryCutPath,
    documentRepository,
    refreshDocs,
    openDoc,
    confirmLeaveEditMode,
    showLibraryFileOnly,
    setBusy,
    setNotice,
    setDocFolders,
    setDocs,
    setLibraryTree,
    setLibraryCutPath,
    setSelectedLibraryEntry
  });

  function toggleOutlineNode(nodeId: unknown) {
    setCollapsedOutlineNodeIds((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      persistOutlineViewState(next);
      return next;
    });
  }

  async function confirmAxiomDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!axiomDialog) return;
    const content = String(axiomDialog.content || '').trim();
    if (!content) {
      setNotice('事实前提内容不能为空。');
      return;
    }
    const docId = axiomDialog.docId;
    setAxiomDialog(null);
    await runWrite((() => axiomRepository.addAxiom({ docId, content, status: 'pending' } as Parameters<typeof axiomRepository.addAxiom>[0])) as Parameters<typeof runWrite>[0]);
  }

  function cancelAxiomDialog() {
    setAxiomDialog(null);
  }

  async function confirmAxiomRefDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!axiomRefDialog) return;
    const { docId, nodeId, axiomId } = axiomRefDialog;
    setAxiomRefDialog(null);
    await runWrite((() => refRepository.addAxiomRefToNode({ docId, nodeId, axiomId } as Parameters<typeof refRepository.addAxiomRefToNode>[0])) as Parameters<typeof runWrite>[0]);
  }

  function cancelAxiomRefDialog() {
    setAxiomRefDialog(null);
  }

  async function deleteDoc(doc: { id?: unknown; title?: string }) {
    const ok = window.confirm(`删除文档“${doc.title}”及其全部节点？`);
    if (!ok) return;
    setBusy(true);
    try {
      const nextDocs: unknown = await documentRepository.deleteDoc({ docId: doc.id });
      setDocs(nextDocs as Parameters<typeof setDocs>[0]);
      if (currentDoc?.doc?.id === doc.id) {
        const nextDoc = (Array.isArray(nextDocs) ? nextDocs[0] : null) as { id?: unknown } | null;
        if (nextDoc) {
          await openDoc(nextDoc.id);
        } else {
          setCurrentDoc(null);
          persistActiveDocId(null);
          setSelectedNodeId?.(null);
          setCollapsed(new Set());
          setExpanded(new Set());
        }
      }
      setNotice('已删除文档');
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
    } finally {
      setBusy(false);
    }
  }

  async function toggleTreeEditMode() {
    if (!currentDoc?.doc?.id) return;
    if (!treeEditMode) {
      await enterEditMode();
      return;
    }
    await saveAndLeaveEditMode();
  }

  async function openEditBranchDiff(option: { branch?: EditBranchRow | null; activeEntryCount?: number; owner?: string } | null = null) {
    const branch: EditBranchRow | null = option?.branch || activeEditBranch();
    const activeEntryCount = Number(option?.activeEntryCount ?? editBranchUndoEntries(branch).length);
    if (!branch || activeEntryCount <= 0) {
      setNotice('没有可对比的 active diff');
      return;
    }
    setEditBranchDiffDialog({
      open: true,
      loading: true,
      view: null,
      error: ''
    });
    try {
      const payload = branch.id
        ? { branchId: branch.id, owner: branch.owner || option?.owner || 'human' }
        : { shadowDocId: editBranchShadowDocId(branch), owner: branch.owner || option?.owner || 'human' };
      const view = await documentRepository.getEditBranchDiffView(payload) as EditBranchDiffViewModel;
      setEditBranchDiffDialog({
        open: true,
        loading: false,
        view,
        error: ''
      });
    } catch (error) {
      setEditBranchDiffDialog({
        open: true,
        loading: false,
        view: null,
        error: (error as { message?: string }).message || String(error)
      });
    }
  }

  function closeEditBranchDiff() {
    setEditBranchDiffDialog({
      open: false,
      loading: false,
      view: null,
      error: ''
    });
  }

  async function applyMergeResolutions(resolutions: unknown) {
    const ctx = mergeConflictDialog.ctx;
    if (!ctx) return;
    setMergeConflictDialog((current) => ({ ...current, applying: true, error: '' }));
    try {
      const result = await documentRepository.applyEditBranchMerge({
        shadowDocId: ctx.shadowDocId,
        owner: ctx.owner,
        includeDoc: false,
        resolutions
      }) as AppBodyApplyMergeResult | null;
      if (!result?.applied) {
        // 仍未应用（如结构冲突）→ 留面板，刷新冲突视图与 resolutionErrors。
        setMergeConflictDialog((current) => ({ ...current, applying: false, view: result, error: '' }));
        return;
      }
      setMergeConflictDialog({ open: false, applying: false, view: null, error: '', ctx: null });
      await switchDocPreservingView(result?.baseDocId || ctx.baseDocId, ctx.sourceDoc, {
        persistedDocId: result?.baseDocId || ctx.baseDocId,
        noticeText: '已解决冲突并合并，退出编辑模式'
      });
      setDocs(await documentRepository.listDocs() as Parameters<typeof setDocs>[0]);
    } catch (error) {
      setMergeConflictDialog((current) => ({ ...current, applying: false, error: (error as { message?: string }).message || String(error) }));
    }
  }

  function closeMergeConflictDialog() {
    // 取消解决：保留分支（不写回），留在编辑模式，稍后可重试或继续编辑。
    setMergeConflictDialog({ open: false, applying: false, view: null, error: '', ctx: null });
  }

  // blocked（主干已被修改，结构性失配不可裁）→ 用户确认「放弃本次编辑」：丢弃分支并退出编辑模式。
  async function discardMergeBlockedBranch() {
    const ctx = mergeConflictDialog.ctx;
    if (!ctx) return;
    setMergeConflictDialog((current) => ({ ...current, applying: true, error: '' }));
    try {
      await documentRepository.discardEditBranch({ shadowDocId: ctx.shadowDocId, owner: ctx.owner, includeDoc: false });
      setMergeConflictDialog({ open: false, applying: false, view: null, error: '', ctx: null });
      await switchDocPreservingView(ctx.baseDocId, ctx.sourceDoc, {
        persistedDocId: ctx.baseDocId,
        noticeText: '已放弃本次编辑并退出'
      });
      setDocs(await documentRepository.listDocs() as Parameters<typeof setDocs>[0]);
    } catch (error) {
      setMergeConflictDialog((current) => ({ ...current, applying: false, error: (error as { message?: string }).message || String(error) }));
    }
  }

  async function openSettings() {
    await openSettingsAction({
      settingsRepository,
      normalizeNodeLayoutSettingsByView,
      setActiveScreen,
      setVectorSettings,
      setLlmSummarySettings,
      setAgentSettings,
      setNodeLayoutSettings,
      setNotice
    });
  }

  async function saveAgentSettings(next: unknown) {
    await saveAgentSettingsAction({
      next: (next || {}) as Record<string, unknown>,
      agentSettings,
      llmSummarySettings,
      setLlmSummarySettings,
      saveAgentSettingsCore
    });
  }

  async function runAgentRequest({
    mode,
    prompt,
    modelOption = null,
    reasoningEffort = 'auto'
  }: {
    mode: string;
    prompt: unknown;
    modelOption?: { providerId?: string; apiId?: string; model?: string } | null;
    reasoningEffort?: string;
  }) {
    const text = String(prompt || '').trim();
    if (!text) return;
    const requestId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = Date.now();
    let beforeFullAccessToken: Awaited<ReturnType<typeof captureEditorHistoryToken>> = null;
    activeAgentRequestIdRef.current = requestId;
    setAgentBusy(true);
    setAgentMessages((previous) => [
      ...previous,
      {
        id: `${requestId}-user`,
        requestId,
        role: 'user',
        mode,
        content: text,
        createdAt: startedAt
      },
      {
        id: `${requestId}-assistant`,
        requestId,
        role: 'assistant',
        mode,
        answer: '',
        status: '正在连接...',
        streaming: true,
        diffCount: 0,
        toolEvents: [],
        segments: [],
        createdAt: startedAt
      }
    ]);
    try {
      beforeFullAccessToken = mode === 'full' ? await captureEditorHistoryToken() : null;
      const result = await agentRepository.runAgentRequest({
        requestId,
        sessionId: activeAgentSessionId,
        mode,
        prompt: text,
        agentProviderId: modelOption?.providerId || '',
        agentApiId: modelOption?.apiId || '',
        agentModel: modelOption?.model || '',
        reasoningEffort,
        history: agentHistoryForRequest(agentMessages),
        contextUsage: agentContextUsage,
        docId: currentDoc?.doc?.id || null,
        selectedNodeId: selectedNode?.id || null,
        viewMode: activeTab,
        depthLimit: visibleDepthLimit
      }) as AppBodyAgentRequestResult | null;
      if (result?.usage) setAgentContextUsage(result.usage);
      setAgentMessages((previous) => previous.map((message) => (
        message.requestId === requestId && message.role === 'assistant'
          ? {
              ...message,
              answer: result?.answer || message.answer || '',
              diffCount: Array.isArray(result?.diffs) ? result.diffs.length : message.diffCount,
              elapsedMs: Date.now() - startedAt,
              usage: result?.usage || message.usage,
              toolEvents: Array.isArray(result?.toolEvents) ? result.toolEvents : (message.toolEvents || []),
              segments: Array.isArray(result?.segments) ? result.segments : (message.segments || []),
              status: result?.canceled ? '已取消' : '完成',
              streaming: false
            }
          : message
      )));
      setAgentDiffs((Array.isArray(result?.diffs) ? result.diffs : []) as Parameters<typeof setAgentDiffs>[0]);
      const changedDocIds = Array.isArray(result?.changedDocIds) ? result.changedDocIds.map(normalizeDocId).filter(Boolean) : [];
      if (changedDocIds.length > 0) {
        if (beforeFullAccessToken && changedDocIds.includes(normalizeDocId(beforeFullAccessToken.docId))) {
          discardHistoryTokens(redoStackRef.current);
          updateUndoStack((stack) => pushHistoryToken(stack, beforeFullAccessToken));
          updateRedoStack([]);
          beforeFullAccessToken = null;
        }
        if (treeEditMode && changedDocIds.includes(normalizeDocId(currentDoc?.doc?.id))) {
          // full agent 直写 base：refreshDocs 的编辑分支保护会早退、视图不动，
          // 这里显式重取投影让 agent 改动立即可见；不调 syncEditBranchHistoryStacks，
          // 保住栈顶 base 快照 token 的紧邻回退窗口（Ctrl+Z 一键回退 agent 改动）。
          const nextDoc = await loadDocForCurrentView(currentDoc!.doc!.id, currentDoc) as AppBodyOpenedDoc | null;
          docState.patchDocMeta({ editBranch: nextDoc?.editBranch ?? null });
          await docState.reloadStructuralChange();
          await refreshDocList();
        } else {
          await refreshDocs(changedDocIds[0] || currentDoc?.doc?.id);
        }
      }
      if (beforeFullAccessToken) {
        discardHistoryTokens([beforeFullAccessToken]);
        beforeFullAccessToken = null;
      }
      if (result?.sessionId) setActiveAgentSessionId(result.sessionId);
      await refreshAgentSessions();
    } catch (error) {
      if (beforeFullAccessToken) discardHistoryTokens([beforeFullAccessToken]);
      setAgentMessages((previous) => previous.map((message) => (
        message.requestId === requestId && message.role === 'assistant'
          ? {
              ...message,
              answer: (error as { message?: string }).message || 'Agent 调用失败',
              elapsedMs: Date.now() - startedAt,
              toolEvents: message.toolEvents || [],
              status: '失败',
              streaming: false,
              error: true
            }
          : message
      )));
      setNotice((error as { message?: string }).message ?? '');
    } finally {
      if (activeAgentRequestIdRef.current === requestId) activeAgentRequestIdRef.current = null;
      setAgentBusy(false);
      refreshAgentSessions().catch((error) => setNotice((error as { message?: string }).message ?? ''));
    }
  }

  async function cancelAgentRequest() {
    const requestId = activeAgentRequestIdRef.current;
    if (!requestId || !agentRepository.canCancelAgentRequest?.()) return;
    try {
      await agentRepository.cancelAgentRequest({ requestId });
      setAgentMessages((previous) => previous.map((message) => (
        message.requestId === requestId && message.role === 'assistant'
          ? { ...message, status: '正在取消...', streaming: true }
          : message
      )));
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
    }
  }

  async function applyAgentDiff(diffId: unknown, options: { skipEditModeCheck?: boolean } = {}) {
    const pendingDiff = agentDiffs.find((diff: { id?: unknown; [k: string]: unknown }) => Number(diff.id) === Number(diffId));
    if (!pendingDiff) return false;
    if (!options.skipEditModeCheck) {
      const ready = await ensureAgentApprovalEditMode();
      if (!ready) return false;
    }
    const target = { docId: (pendingDiff as { base_doc_id?: unknown }).base_doc_id };
    let undoToken: Awaited<ReturnType<typeof captureEditorHistoryToken>> = null;
    try {
      if (target.docId && !treeEditMode) {
        undoToken = await captureEditorHistoryToken(target.docId);
      }
      const result = await agentRepository.applyDiff({ diffId } as Parameters<typeof agentRepository.applyDiff>[0]) as AppBodyApplyDiffResult | null;
      if (result?.ok !== false && undoToken) {
        discardHistoryTokens(redoStackRef.current);
        updateUndoStack((stack) => pushHistoryToken(stack, undoToken));
        updateRedoStack([]);
        undoToken = null;
      }
      if (undoToken) {
        discardHistoryTokens([undoToken]);
        undoToken = null;
      }
      setAgentDiffs((Array.isArray(result?.diffs) ? result.diffs : []) as Parameters<typeof setAgentDiffs>[0]);
      const resultDocId = result?.docId || currentDoc?.doc?.id;
      if (treeEditMode && resultDocId) {
        const nextDoc = await loadDocForCurrentView(resultDocId, currentDoc) as AppBodyOpenedDoc | null;
        docState.patchDocMeta({ editBranch: nextDoc?.editBranch ?? null });
        await docState.reloadStructuralChange();
        syncEditBranchHistoryStacks(nextDoc?.editBranch || activeEditBranch());
      } else if (resultDocId) {
        await refreshDocs(resultDocId);
      }
      await refreshAgentSessions();
      return true;
    } catch (error) {
      if (undoToken) discardHistoryTokens([undoToken]);
      setNotice((error as { message?: string }).message ?? '');
      return false;
    }
  }

  async function rejectAgentDiff(diffId: unknown) {
    try {
      const result = await agentRepository.rejectDiff({ diffId } as Parameters<typeof agentRepository.rejectDiff>[0]) as AppBodyRejectDiffResult | null;
      setAgentDiffs((Array.isArray(result?.diffs) ? result.diffs : []) as Parameters<typeof setAgentDiffs>[0]);
      await refreshAgentSessions();
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
    }
  }

  async function applyAllAgentDiffs() {
    const pendingDiffs = [...agentDiffs];
    if (pendingDiffs.length === 0) return;
    const ready = await ensureAgentApprovalEditMode();
    if (!ready) return;
    for (const diff of pendingDiffs) {
      // 需求 15-4-1：逐条转移，遇到第一条失败即停止，保留已成功转移的，
      // 失败那条已在 applyAgentDiff 内弹出错误说明。
      const ok = await applyAgentDiff(diff.id, { skipEditModeCheck: true });
      if (!ok) break;
    }
  }

  async function rejectAllAgentDiffs() {
    for (const diff of agentDiffs) {
      await rejectAgentDiff(diff.id);
    }
  }

  async function chooseLocalModelRoot() {
    try {
      setVectorSettings(await vectorService.chooseLocalModelRoot() as Parameters<typeof setVectorSettings>[0]);
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
    }
  }

  async function downloadVectorModel() {
    setBusy(true);
    try {
      const settings = await vectorService.downloadVectorModel() as { downloadedModelPath?: string; localModelRoot?: string; [k: string]: unknown };
      setVectorSettings(settings);
      setNotice(`已下载模型：${settings.downloadedModelPath || settings.localModelRoot}`);
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function importFiles(mode = 'simple') {
    const rawMode = String(mode || 'simple').trim();
    const importMode = ['simple', 'complete', 'direct', 'smart', 'vector'].includes(rawMode) ? rawMode : 'simple';
    if (importMode === 'smart') {
      if (selectedLibraryEntry?.type !== 'file') {
        setNotice('智能导入请先在库里选中要导入的文件');
        return;
      }
      try {
        // 智能导入不在前端/后端落库：后端构造任务 prompt，前端以 full 档发起一次 agent 会话，
        // agent 自主跑 smart-import skill（观察源文 → 写脚本 → 校验 → 入库），过程在 AgentPanel 可见。
        const task = await importService.smartImportTask({ relativePath: selectedLibraryEntry.relativePath }) as { mode?: string; prompt?: string } | null;
        await runAgentRequest({ mode: task?.mode || 'full', prompt: task?.prompt || '' });
        // agent 跑 db import-json 直接入库、不一定进 runAgent 的 changedDocIds，显式刷新库与文档列表。
        await refreshLibraryTree();
        await refreshDocList();
      } catch (error) {
        setNotice((error as { message?: string } | null | undefined)?.message || '智能导入发起失败');
      }
      return;
    }
    if (selectedLibraryEntry?.type === 'file' && !isSupportedLibraryImport(selectedLibraryEntry)) {
      setNotice(`不支持导入格式：${selectedLibraryEntry.extension || '未知格式'}`);
      return;
    }
    const canLeave = await confirmLeaveEditMode();
    if (!canLeave) return;
    setBusy(true);
    setOperationLock({ label: '正在处理导入……', step: 0, total: 0 });
    try {
      const payload = { mode: importMode };
      const importedRaw = selectedLibraryEntry?.type === 'file' && importService.canImportLibraryDocument()
        ? await importService.importLibraryDocument({ relativePath: selectedLibraryEntry.relativePath, ...payload })
        : await importService.chooseImportFile(payload);
      const imported = (Array.isArray(importedRaw) ? importedRaw : []) as Array<{ doc?: { id?: unknown }; [k: string]: unknown }>;
      if (imported.length) {
        const last = imported[imported.length - 1];
        setOperationLock({ label: '正在打开文档……', step: 0, total: 0 });
        const opened = await loadCompleteDoc(last.doc?.id, '正在打开文档……');
        setSelectedLibraryEntry(null);
        persistActiveDocId(opened?.doc?.id || last?.doc?.id);
        const importUnlock = () => {
          setBusy(false);
          setProgress(null);
          setOperationLock(null);
          setNotice(`已导入 ${imported.length} 份文档`);
          refreshDocs(null).catch(() => {});
        };
        importUnlock();
      } else {
        setBusy(false);
        setProgress(null);
        setOperationLock(null);
      }
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
      setBusy(false);
      setProgress(null);
      setOperationLock(null);
    }
  }

  async function runVectorSearch() {
    if (!currentDoc || !searchQuery.trim()) return;
    if (vectorModuleDisabled) {
      setSearchResults([]);
      setNotice(String(vectorDisabledMessage ?? ''));
      return;
    }
    setBusy(true);
    try {
      const results = await vectorService.searchContentByVector({
        docId: currentDoc.doc?.id,
        query: searchQuery.trim(),
        limit: 20
      });
      setSearchResults(results as unknown[]);
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
    } finally {
      setBusy(false);
    }
  }

  async function focusNodeInDoc(
    doc: {
      doc?: { id?: unknown };
      tree?: unknown;
      idByAddress?: Record<string, unknown>;
      [k: string]: unknown;
    } | null | undefined,
    node: { id?: unknown; address?: unknown; [k: string]: unknown } | null | undefined
  ) {
    if (!doc?.tree || !node?.id) return false;
    const nodeAddress = String(node.address || '1');
    setSelectedNodeId?.(node.id);
    // 节点视图（树/IDE/富文本）内就地定位；仅从实体/搜索等非节点视图才切到树视图。
    if (activeTab !== 'tree' && activeTab !== 'ide' && activeTab !== 'rich') setActiveTab('tree');
    const baseState = normalizeDocId(doc?.doc?.id) === normalizeDocId(currentDoc?.doc?.id)
      ? { depthLimit, collapsed, expanded }
      : treeViewStateFromDoc(doc as Parameters<typeof treeViewStateFromDoc>[0], fullDepthForDoc(doc as Parameters<typeof fullDepthForDoc>[0]));
    const nextDepthLimit = baseState.depthLimit;
    const nextCollapsed = new Set(baseState.collapsed);
    const nextExpanded = new Set(baseState.expanded);
    let ancestorIds = [];
    {
      const parts = nodeAddress.split('-');
      for (let length = 1; length < parts.length; length += 1) {
        const ancestorAddress = parts.slice(0, length).join('-');
        const ancestorId = doc.idByAddress?.[ancestorAddress];
        if (ancestorId) ancestorIds.push(ancestorId);
      }
    }
    for (let index = 0; index < ancestorIds.length; index += 1) {
      const ancestorId = ancestorIds[index];
      nextCollapsed.delete(ancestorId);
      if (index + 1 >= nextDepthLimit) nextExpanded.add(ancestorId);
    }
    setPersistedTreeView(nextDepthLimit, nextCollapsed, nextExpanded, doc?.doc?.id);
    setLocateRequest((previous) => ({
      seq: (previous?.seq || 0) + 1,
      nodeId: node.id,
      address: nodeAddress
    }));
    return true;
  }

  async function selectNodeAndOpenTree(nodeId: unknown, result: { address?: unknown; [k: string]: unknown } = {}) {
    if (!nodeId) return;
    const address = String(result?.address || '').trim();
    // 先确保目标深度的数据已加载，再走统一就地定位（从搜索/实体这类非节点视图会切到树视图）。
    if (address) {
      const targetDepth = depthOf(address);
      if (loadedDepthForDoc(currentDoc) < targetDepth && currentDoc?.doc?.id) {
        try {
          // 扩散加载下「定位」= 聚焦目标并沿 DFS 取祖先链/邻窗（不再按深度整层预拉）。
          await docState.ensureNodeChildren(nodeId);
        } catch (error) {
          setNotice((error as { message?: string }).message ?? '');
        }
      }
    }
    const node = findNode(currentDoc?.tree, nodeId) || { id: nodeId, address: address || '1' };
    focusNodeInDoc(currentDoc, node as Parameters<typeof focusNodeInDoc>[1]);
  }

  function locateSelectedNode() {
    // 16-3：统一走就地定位，由当前视图自己滚动到目标，不强制切视图。
    focusNodeInDoc(currentDoc, selectedNode as Parameters<typeof focusNodeInDoc>[1]);
  }

  async function jumpToCurrentDocAddress(rawAddress: unknown) {
    const address = String(rawAddress || '').trim();
    if (!address) return { ok: false, message: '请输入节点地址。' };
    const docId = normalizeDocId(currentDoc?.doc?.id);
    if (!docId || !currentDoc?.tree) return { ok: false, message: '当前没有打开文档。' };
    let nodeId = (currentDoc.idByAddress as Record<string, unknown> | undefined)?.[address];
    let node = nodeId ? findNode(currentDoc.tree, nodeId) : null;
    if (!node && documentRepository.canRead()) {
      try { node = await documentRepository.getNode({ docId, address }) as typeof node; } catch {}
    }
    if (!node?.id) return { ok: false, message: `当前文档没有节点 ${address}。` };
    focusNodeInDoc(currentDoc, node as Parameters<typeof focusNodeInDoc>[1]);
    return { ok: true };
  }

  async function traceAgentDiff(branch: { base_doc_id?: unknown; [k: string]: unknown } | null | undefined) {
    // 整批：打开该 owner=llm:<会话> 分支的基底文档；明细对照走 changes / 分支 diff 视图。
    const docId = branch?.base_doc_id;
    if (!docId) {
      setNotice('这个待审分支没有可定位的文档。');
      return;
    }
    try {
      if (normalizeDocId(currentDoc?.doc?.id) !== normalizeDocId(docId)) await openDoc(docId);
      setNotice('已打开文档；在 changes / 分支 diff 视图查看该会话的待审改动。');
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
    }
  }

  // 取子已收编到 session：toggle/展开直接调 docState.ensureNodeChildren（聚焦目标 + 扩散取子
  // reconcile 进状态机），不再本地 mergeNodeChildrenIntoTree 直改投影树（那会被下一次 project 覆盖）。

  // 节点形参在 tree action 链路里用 minimal 接口：本组件内只读 id/address/children/childCount。
  type AppBodyTreeActionNode = {
    id?: unknown;
    address?: string;
    children?: unknown[];
    childCount?: unknown;
    [k: string]: unknown;
  };
  type AppBodyToggleOptions = {
    nodeAddress?: string;
    hasChildren?: boolean;
    singlePath?: boolean;
    promoteDepth?: boolean;
    maxDepth?: number;
    minDepth?: number;
    [k: string]: unknown;
  };

  function treeActionNode(nodeId: unknown): AppBodyTreeActionNode | null {
    return (findNode(currentDoc?.tree, nodeId) || currentDoc?.treeIndex?.nodeOf?.(nodeId) || null) as AppBodyTreeActionNode | null;
  }

  function treeActionHasChildren(node: AppBodyTreeActionNode | null | undefined) {
    if (!node) return false;
    return hasKnownChildren(node as Parameters<typeof hasKnownChildren>[0]) || Boolean(currentDoc?.treeIndex?.hasChildren?.(node.id));
  }

  function treeActionDescendants(node: AppBodyTreeActionNode | null | undefined): AppBodyTreeActionNode[] {
    if (!node) return [];
    if (Array.isArray(node.children)) return flattenTree(node) as AppBodyTreeActionNode[];
    return [node];
  }

  async function toggleCollapsed(nodeId: unknown, options: AppBodyToggleOptions = {}) {
    const node = treeActionNode(nodeId) || (
      options.nodeAddress
        ? {
            id: nodeId,
            address: options.nodeAddress,
            children: [],
            childCount: options.hasChildren ? 1 : 0
          }
        : null
    );
    const hasChildren = treeActionHasChildren(node) || options.hasChildren === true;
    if (!node || !hasChildren) return;
    if ((node.children || []).length === 0 && Number(node.childCount ?? 0) > 0) {
      await docState.ensureNodeChildren(nodeId);
    }
    const nextCollapsed = new Set(collapsed);
    const nextExpanded = new Set(expanded);
    const nodeDepth = depthOf(node.address || options.nodeAddress || '1');
    if (options.singlePath === true) {
      for (const id of [...nextExpanded]) {
        const item = treeActionNode(id);
        if (item && depthOf(item.address || '1') > nodeDepth) nextExpanded.delete(id);
      }
      for (const id of [...nextCollapsed]) {
        const item = treeActionNode(id);
        if (item && depthOf(item.address || '1') > nodeDepth) nextCollapsed.delete(id);
      }
    }
    let expandedNode = false;
    if (nextCollapsed.has(nodeId)) {
      nextCollapsed.delete(nodeId);
      if (nodeDepth >= depthLimit) nextExpanded.add(nodeId);
      expandedNode = true;
    } else if (nextExpanded.has(nodeId) || nodeDepth < depthLimit) {
      nextCollapsed.add(nodeId);
      for (const item of treeActionDescendants(node)) nextExpanded.delete(item.id);
    } else {
      nextExpanded.add(nodeId);
      expandedNode = true;
    }
    if (expandedNode && options.promoteDepth !== false) {
      setPersistedTreeViewAfterExpansion(depthLimit, nextCollapsed, nextExpanded);
    } else {
      setPersistedTreeView(depthLimit, nextCollapsed, nextExpanded);
    }
  }

  async function expandNodeOneLevel(nodeId: unknown, options: AppBodyToggleOptions = {}) {
    const node = treeActionNode(nodeId) || (
      options.nodeAddress
        ? {
            id: nodeId,
            address: options.nodeAddress,
            children: [],
            childCount: options.hasChildren ? 1 : 0
          }
        : null
    );
    if (!node) return;
    await docState.ensureNodeChildren(nodeId);
    const nextCollapsed = new Set(collapsed);
    const nextExpanded = new Set(expanded);
    const maxDepth = Math.max(1, Math.floor(Number(options.maxDepth || actualMaxDepth || fullDepthForDoc(currentDoc)) || 1));
    const nextDepthLimit = clampDepthLimit(
      Math.max(depthLimit, Math.floor(Number(options.minDepth) || 0)),
      maxDepth
    );
    if (options.singlePath === true) {
      const nodeDepth = depthOf(node.address || options.nodeAddress || '1');
      for (const id of [...nextExpanded]) {
        const item = treeActionNode(id);
        if (item && depthOf(item.address || '1') >= nodeDepth) nextExpanded.delete(id);
      }
      for (const id of [...nextCollapsed]) {
        const item = treeActionNode(id);
        if (item && depthOf(item.address || '1') >= nodeDepth) nextCollapsed.delete(id);
      }
    }
    nextCollapsed.delete(node.id);
    nextExpanded.add(node.id);
    setPersistedTreeViewAfterExpansion(nextDepthLimit, nextCollapsed, nextExpanded);
  }

  const undoEditRef = useRef(undoEdit);
  const redoEditRef = useRef(redoEdit);
  useEffect(() => { undoEditRef.current = undoEdit; });
  useEffect(() => { redoEditRef.current = redoEdit; });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target as Element | null)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        if (event.shiftKey) toggleRightSidebar();
        else toggleLeftSidebar();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault();
        undoEditRef.current();
      } else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z'))) {
        event.preventDefault();
        redoEditRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleLeftSidebar, toggleRightSidebar]);

  useEffect(() => {
    const blockWindowClose = (event: BeforeUnloadEvent) => {
      if (!treeEditMode) return;
      if (closeAfterEditModeSaveRef.current) return;
      event.preventDefault();
      event.returnValue = false;
      handleCloseWindow();
    };
    window.addEventListener('beforeunload', blockWindowClose);
    return () => window.removeEventListener('beforeunload', blockWindowClose);
  }, [treeEditMode]);

  const workspaceTitle = currentDoc ? docDisplayTitle(currentDoc.doc) : (selectedLibraryEntry?.name || '未打开文档');
  const workspaceSubtitle = currentDoc
    ? `${visibleNodeCount} 个节点`
    : selectedLibraryEntry
      ? '未导入原始文件，请先手动导入'
      : '选择 library 中的文件开始';
  const outlineSplitHint = outlineCollapsedDown
    ? '点按展开目录，拖动调整文件和目录占比'
    : '拖动调整文件和目录占比，点按向下收起目录';
  const inspectorActions = useMemo(() => ({
    updateNode: (payload: Parameters<typeof nodeRepository.updateNode>[0]) => nodeRepository.updateNode(payload),
    createImageAsset: (payload: Parameters<typeof assetRepository.createImageAsset>[0]) => assetRepository.createImageAsset(payload),
    deleteRef: (payload: Parameters<typeof refRepository.deleteRef>[0]) => refRepository.deleteRef(payload),
    updateAxiom: (payload: Parameters<typeof axiomRepository.updateAxiom>[0]) => axiomRepository.updateAxiom(payload),
    restoreHistory: (payload: Parameters<typeof historyRepository.restoreDocumentSnapshot>[0]) => historyRepository.restoreDocumentSnapshot(payload)
  }), []);
  const runC2DNodeCommand = useCallback((command: {
    type?: string;
    target?: { kind?: string; nodeId?: unknown; axiomId?: unknown; [k: string]: unknown };
    parentNodeId?: unknown;
    afterNodeId?: unknown;
    nodeId?: unknown;
    direction?: unknown;
    patch?: AppBodyAxiomPatchIn;
    [k: string]: unknown;
  } = {}) => {
    const docId = currentDoc?.doc?.id;
    if (!docId) return null;
    const target = command?.target || {};
    return runWrite(() => {
      switch (command?.type) {
        case 'addChild':
          return nodeRepository.insertNode({
            docId,
            parentId: command.parentNodeId,
            text: '',
            nodeType: 'TEXT'
          });
        case 'addSibling':
          return nodeRepository.insertNode({
            docId,
            parentId: command.parentNodeId,
            afterNodeId: command.afterNodeId,
            text: '',
            nodeType: 'TEXT'
          });
        case 'updateBlock':
          if (target.kind === 'axiom') {
            return axiomRepository.updateAxiom({
              docId,
              axiomId: target.axiomId,
              patch: c2dAxiomPatch(command.patch)
            });
          }
          return nodeRepository.updateNode({
            docId,
            nodeId: target.nodeId,
            patch: command.patch || {}
          });
        case 'reorderNode':
          return nodeRepository.moveNode({ docId, nodeId: command.nodeId, direction: command.direction });
        case 'promoteToParentSibling':
          return nodeRepository.promoteNode({ docId, nodeId: command.nodeId });
        case 'splitNode':
          return nodeRepository.splitNode({ docId, nodeId: command.nodeId });
        case 'deleteBlock':
          if (target.kind === 'axiom') return axiomRepository.deleteAxiom({ docId, axiomId: target.axiomId });
          return nodeRepository.deleteNode({ docId, nodeId: target.nodeId });
        case 'mergeIntoTarget':
          return nodeRepository.mergeNodeIntoTarget({ docId, nodeId: command.nodeId, targetNodeId: command.targetNodeId });
        case 'moveAfterSibling':
          return nodeRepository.moveNodeAfterSibling({ docId, nodeId: command.nodeId, targetNodeId: command.targetNodeId });
        case 'moveToParent':
          return nodeRepository.moveNodeToParent({ docId, nodeId: command.nodeId, newParentId: command.newParentId });
        default:
          setNotice('当前动作尚未接入。');
          return null;
      }
    });
  }, [currentDoc?.doc?.id, runWrite, setNotice]);

  if (activeScreen === 'settings') {
    return (
      <>
        <WindowTitlebar onClose={handleCloseWindow} />
        <SettingsView
          vectorSettings={vectorSettings}
          memorySettings={memorySettings}
          llmSummarySettings={llmSummarySettings}
          agentSettings={agentSettings}
          nodeLayoutSettings={nodeLayoutSettings}
          notice={notice}
          clearNotice={() => setNotice('')}
          onBack={() => setActiveScreen('editor')}
          onChange={saveVectorSettings}
          onMemoryChange={saveMemorySettings}
          onLlmSummaryChange={saveLlmSummarySettings}
          onAgentChange={saveAgentSettings}
          onNodeLayoutChange={saveNodeLayoutSettings}
          canEditNodeLayout={treeEditMode}
          treeEditMode={treeEditMode}
          onToggleTreeEditMode={toggleTreeEditMode}
          onChooseLocalModelRoot={chooseLocalModelRoot}
          onDownloadVectorModel={downloadVectorModel}
          progress={progress}
          busy={busy}
        />
      </>
    );
  }

  const leftSidebarRailHint = leftCollapsed ? '点按展开左侧栏' : '拖动调整左侧栏宽度，点按收起';
  const rightSidebarRailHint = rightCollapsed ? '点按展开右侧栏' : '拖动调整右侧栏宽度，点按收起';

  return (
    <>
      <WindowTitlebar onClose={handleCloseWindow} />
      <main className="app-shell">
        <button
        type="button"
        className={`sidebar-rail sidebar-rail-left${leftCollapsed ? ' is-collapsed' : ''}${leftRailAnimate ? ' rail-animating' : ''}`}
        style={{ left: leftCollapsed ? 0 : leftWidth - 6 }}
        title={leftSidebarRailHint}
        aria-label={leftSidebarRailHint}
        onPointerDown={(event) => startSidebarResize('left', event.nativeEvent)}
      >
        {leftCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
      </button>
      <button
        type="button"
        className={`sidebar-rail sidebar-rail-right${rightCollapsed ? ' is-collapsed' : ''}${rightRailAnimate ? ' rail-animating' : ''}`}
        style={{ right: rightCollapsed ? 0 : rightWidth - 6 }}
        title={rightSidebarRailHint}
        aria-label={rightSidebarRailHint}
        onPointerDown={(event) => startSidebarResize('right', event.nativeEvent)}
      >
        {rightCollapsed ? <PanelRightOpen size={12} /> : <PanelRightClose size={12} />}
      </button>

      <aside
        ref={leftSidebarRef}
        className={`sidebar sidebar-left ${leftCollapsed ? 'collapsed' : ''}`}
        style={{ width: leftWidth }}
      >
        <div className="brand">
          <button type="button" className="brand-mark brand-mark-button" title="打开设置" onClick={openSettings}>
            <Settings size={20} />
          </button>
          <div>
            <h1>条件树编辑器</h1>
            <p>折叠即文档，展开即结构</p>
          </div>
        </div>

        <DocBrowser
          busy={busy}
          docs={docs}
          docFolders={docFolders}
          libraryTree={libraryTree}
          docBySourcePath={docBySourcePath}
          currentDocId={currentVisualDocId}
          libraryCutPath={libraryCutPath}
          docPanelRef={docPanelRef}
          docPanelHeight={docPanelHeight}
          onRefreshLibrary={refreshLibraryTree}
          onOpenDoc={openDoc}
          onCreateDoc={createDoc}
          onCreateFolder={createDocFolder as (parentId?: number | null) => unknown}
          onRenameFolder={renameDocFolder}
          onDeleteFolder={deleteDocFolder}
          onDeleteDoc={deleteDoc}
          onMoveDoc={moveDocToFolder}
          libraryNavigationOpen={currentDoc?.virtualType === 'libraryNavigation'}
          onOpenLibraryNavigation={openLibraryNavigation}
          onSelectLibraryFile={selectLibraryFile}
          onMoveLibraryItem={moveLibraryItem}
          onCutLibraryItem={cutLibraryItem}
          onPasteLibraryItem={pasteLibraryItem}
          onDeleteLibraryImport={deleteLibraryImport}
        />

        <button
          type="button"
          className={`left-panel-resizer${outlineCollapsedDown ? ' is-collapsed' : ''}`}
          title={outlineSplitHint}
          aria-label={outlineSplitHint}
          onPointerDown={(event) => startDocOutlineResize(event.nativeEvent)}
        />

        <OutlinePanel
          tree={currentDoc?.tree as Parameters<typeof OutlinePanel>[0]['tree']}
          selectedNodeId={selectedNodeId}
          collapsedOutlineNodeIds={collapsedOutlineNodeIds}
          onToggle={toggleOutlineNode}
          onSelect={setSelectedNodeId}
        />
      </aside>

      <section
        className="workspace"
        style={{
          left: leftCollapsed ? 0 : leftWidth,
          right: rightCollapsed ? 0 : rightWidth
        }}
      >
        <WorkspaceHeader
          title={workspaceTitle}
          subtitle={workspaceSubtitle}
          activeTab={activeTab as Parameters<typeof WorkspaceHeader>[0]['activeTab']}
          setActiveTab={changeActiveTab}
          undoEdit={undoEdit}
          redoEdit={redoEdit}
          undoDisabled={undoStack.length === 0 || busy}
          redoDisabled={redoStack.length === 0 || busy}
          treeEditMode={treeEditMode}
          toggleTreeEditMode={toggleTreeEditMode}
          hasTree={Boolean(currentDoc?.tree && !currentDoc?.virtual)}
          busy={busy}
          recomputeCurrentTreeView={() => setVisibleDepth(depthLimit, { clearAll: false })}
          setVisibleDepth={setVisibleDepth}
          collapseVisibleDepthOne={collapseVisibleDepthOne}
          visibleDepthLimit={visibleDepthLimit}
          visibleDepthOptions={visibleDepthOptions}
          actualMaxDepth={actualMaxDepth}
          summaryNotesVisible={summaryNotesVisible}
          onToggleSummaryNotes={toggleSummaryNotesVisible}
          onGenerateSummary={generateSummary as Parameters<typeof WorkspaceHeader>[0]['onGenerateSummary']}
          onRunSummaryGeneration={(req, strat) => { void runSummaryGeneration(req as Parameters<typeof runSummaryGeneration>[0], strat as Parameters<typeof runSummaryGeneration>[1]); }}
          diffBranches={diffBranchOptions as Parameters<typeof WorkspaceHeader>[0]['diffBranches']}
          onOpenDiff={openEditBranchDiff}
          onOpenEntityMaintenance={openEntityMaintenance}
        >
          {({ viewShowLeftInfo, viewShowTitles, viewShowNotes, viewShowAxioms }) => (
            <>

        {notice && (
          <div className="notice" onClick={() => setNotice('')}>
            {notice}
          </div>
        )}

        <div className="tree-surface" aria-busy={busy}>
          {currentDoc?.tree ? (
            <>
              <div style={{ display: activeTab === 'tree' ? 'contents' : 'none' }}>
                <C2DMapView
                  docId={currentDoc.doc?.id as Parameters<typeof C2DMapView>[0]['docId']}
                  rootNode={currentDoc.tree as Parameters<typeof C2DMapView>[0]['rootNode']}
                  selectedNodeId={selectedNodeId as Parameters<typeof C2DMapView>[0]['selectedNodeId']}
                  setSelectedNodeId={setSelectedNodeId}
                  setMultiSelectedIds={setMultiSelectedNodeIds}
                  onRenderReady={(info: unknown) => handleMindMapRenderReady(info as Parameters<typeof handleMindMapRenderReady>[0])}
                  onNotice={setNotice}
                  locateRequest={locateRequest}
                  axioms={currentDoc.axioms}
                  axiomsCollapsed={axiomsCollapsed}
                  onToggleAxiomsCollapsed={toggleAxiomsCollapsed}
                  showNotes={viewShowNotes}
                  paragraphLabelByNodeId={paragraphLabelByNodeId}
                  visibleDepthLimit={visibleDepthLimit}
                  depthControlSeq={c2dDepthControlSeq}
                  depthControlAction={c2dDepthControlAction}
                  maxVisibleDepth={actualMaxDepth}
                  onVisibleDepthChange={syncC2dVisibleDepth}
                  treeEditMode={treeEditMode}
                  onNodeCommand={runC2DNodeCommand}
                  onAddAxiom={openAxiomDialog}
                  onAddAxiomRef={openAxiomRefDialog}
                />
              </div>
              <div style={{ display: activeTab === 'ide' ? 'contents' : 'none' }}>
                <IdeView
                  tree={currentDoc.tree}
                  selectedNodeId={selectedNodeId}
                  setSelectedNodeId={setSelectedNodeId}
                  collapsed={collapsed}
                  expanded={expanded}
                  toggleCollapsed={toggleCollapsed}
                  depthLimit={depthLimit}
                  sentenceLabelByNodeId={sentenceLabelByNodeId}
                  axioms={currentDoc.axioms as Parameters<typeof IdeView>[0]['axioms']}
                  showTitles={viewShowTitles}
                  showNotes={viewShowNotes}
                  showAxioms={viewShowAxioms}
                  locateRequest={locateRequest}
                />
              </div>
              <div style={{ display: activeTab === 'rich' ? 'contents' : 'none' }}>
                <RichTextView
                  currentDoc={currentDoc as Parameters<typeof RichTextView>[0]['currentDoc']}
                  docId={currentDoc.doc?.id}
                  selectedNodeId={selectedNodeId}
                  setSelectedNodeId={setSelectedNodeId}
                  depthLimit={depthLimit}
                  collapsed={collapsed}
                  expanded={expanded}
                  toggleCollapsed={toggleCollapsed}
                  showLeftInfo={viewShowLeftInfo}
                  showTitles={viewShowTitles}
                  showNotes={viewShowNotes}
                  showAxioms={viewShowAxioms}
                  onAddAxiom={addAxiomFromReadableView}
                  loadSourceWindow={loadSourceWindow as Parameters<typeof RichTextView>[0]['loadSourceWindow']}
                  sourceWindowLoading={sourceWindowLoading}
                  locateRequest={locateRequest}
                />
              </div>
              <div style={{ display: activeTab === 'entity' ? 'contents' : 'none' }}>
                <EntityTraceView
                  entityQuery={entityQuery}
                  setEntityQuery={setEntityQuery}
                  entityRows={entityRows}
                  entityDetail={entityDetail}
                  selectedEntity={selectedEntity}
                  onSearchEntities={runEntitySearch}
                  onSelectEntity={selectEntityTraceEntity}
                  onUseEntityKeyword={useEntityTraceKeyword}
                  onEntityDragStart={dragEntityTraceEntity}
                  nodeQuery={entityNodeQuery}
                  setNodeQuery={changeEntityNodeQuery}
                  nodeMatchMode={entityNodeMatchMode}
                  setNodeMatchMode={changeEntityNodeMatchMode}
                  nodeRows={entityNodeResults}
                  nodeGroups={entityNodeGroups}
                  nodePage={entityNodePage}
                  onSearchNodes={() => runEntityNodeSearch(entityNodeQuery, entityNodeMatchMode, { offset: 0 })}
                  onPageNodes={pageEntityNodeSearch}
                  onDropEntityTerm={dropEntityIntoNodeSearch}
                  onSelectNode={selectNodeAndOpenTree}
                  disabled={busy}
                />
              </div>
              <div style={{ display: activeTab === 'search' ? 'contents' : 'none' }}>
                <SearchView
                  query={searchQuery}
                  setQuery={setSearchQuery}
                  results={searchResults as Parameters<typeof SearchView>[0]['results']}
                  onSearch={runVectorSearch}
                  selectNode={selectNodeAndOpenTree}
                  placeholder={vectorModuleDisabled ? '向量模块已由用户禁用' : '输入要检索的语义内容'}
                  disabled={vectorModuleDisabled}
                  disabledMessage={String(vectorDisabledMessage ?? '')}
                />
              </div>
            </>
          ) : (
            <ViewAlignedEmptyState
              activeTab={activeTab}
              selectedLibraryEntry={selectedLibraryEntry as Parameters<typeof ViewAlignedEmptyState>[0]['selectedLibraryEntry']}
              onImport={importFiles}
            />
          )}
        </div>
            </>
          )}
        </WorkspaceHeader>
      </section>

      <Inspector
        currentDoc={currentDoc as Parameters<typeof Inspector>[0]['currentDoc']}
        selectedNode={selectedNode as Parameters<typeof Inspector>[0]['selectedNode']}
        runWrite={runWrite as Parameters<typeof Inspector>[0]['runWrite']}
        selectNode={selectNodeAndOpenTree}
        canEdit={treeEditMode}
        viewMode={activeTab as Parameters<typeof Inspector>[0]['viewMode']}
        collapsed={rightCollapsed}
        sidebarWidth={rightWidth}
        onLocateNode={locateSelectedNode}
        onJumpToAddress={jumpToCurrentDocAddress}
        agentSettings={agentSettings}
        agentMessages={agentMessages}
        agentDiffs={agentDiffs}
        agentDocs={docs}
        agentSessions={agentSessions}
        activeAgentSessionId={activeAgentSessionId}
        agentBusy={agentBusy}
        agentContextUsage={agentContextUsage}
        onRunAgent={runAgentRequest}
        onCancelAgent={cancelAgentRequest}
        onApplyAgentDiff={applyAgentDiff}
        onRejectAgentDiff={rejectAgentDiff}
        onApplyAllAgentDiffs={applyAllAgentDiffs}
        onRejectAllAgentDiffs={rejectAllAgentDiffs}
        onLoadAgentSession={loadAgentSession}
        onDeleteAgentSession={deleteAgentSession}
        onNewAgentSession={newAgentSession}
        onTraceAgentDiff={traceAgentDiff}
        onAddAxiomRef={openAxiomRefDialog}
        inspectorActions={inspectorActions as Parameters<typeof Inspector>[0]['inspectorActions']}
      />

      {editBranchDiffDialog.open && (
        <EditBranchDiffDialog
          view={editBranchDiffDialog.view}
          loading={editBranchDiffDialog.loading}
          error={editBranchDiffDialog.error}
          onClose={closeEditBranchDiff}
        />
      )}

      {mergeConflictDialog.open && (
        <MergeConflictDialog
          view={mergeConflictDialog.view as Parameters<typeof MergeConflictDialog>[0]['view']}
          applying={mergeConflictDialog.applying}
          error={mergeConflictDialog.error}
          onApply={applyMergeResolutions}
          onDiscard={discardMergeBlockedBranch}
          onClose={closeMergeConflictDialog}
        />
      )}

      {axiomDialog && (
        <div className="dialog-overlay" onClick={cancelAxiomDialog}>
          <form
            className="dialog-box node-dialog"
            onClick={(event) => event.stopPropagation()}
            onSubmit={confirmAxiomDialog}
          >
            <header className="dialog-header">新增事实前提</header>
            <label className="dialog-field">
              <span>事实前提内容</span>
              <textarea
                className="dialog-input"
                value={axiomDialog.content}
                onChange={(event) => setAxiomDialog((current) => current ? { ...current, content: event.target.value } : current)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') cancelAxiomDialog();
                  event.stopPropagation();
                }}
                autoFocus
              />
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={cancelAxiomDialog}>取消</button>
              <button type="submit">确定</button>
            </div>
          </form>
        </div>
      )}

      <ChoiceDialog
        open={editExitDialog.open}
        title="退出编辑模式"
        message={'当前文档处于编辑模式，影子分支里可能有未保存的临时 diff。选择"保存"把它们按顺序合并进文档历史；选择"丢弃"丢掉本次全部编辑，主文档保持不变。'}
        backdropValue="cancel"
        onChoose={editExitDialog.resolve}
        actions={[
          { value: 'cancel', label: '取消' },
          { value: 'discard', label: '丢弃' },
          { value: 'save', label: '保存' }
        ]}
      />

      <ChoiceDialog
        open={startupEditBranchDialog.open}
        title="恢复编辑状态"
        message={`检测到「${startupEditBranchDialog.payload?.base_title || startupEditBranchDialog.payload?.shadow_title || '当前文档'}」存在未保存编辑状态。`}
        backdropValue="stash"
        onChoose={startupEditBranchDialog.resolve}
        actions={[
          { value: 'discard', label: '丢弃' },
          { value: 'stash', label: '暂存' },
          { value: 'restore', label: '恢复', autoFocus: true }
        ]}
      />

      <ChoiceDialog
        open={agentApprovalEditDialog.open}
        title="接受 LLM 变更"
        message="接受 LLM 变更需要进入编辑模式。是否进入？"
        backdropValue="cancel"
        onChoose={agentApprovalEditDialog.resolve}
        actions={[
          { value: 'cancel', label: '取消' },
          { value: 'enter', label: '进入编辑模式', autoFocus: true }
        ]}
      />

      {axiomRefDialog && (
        <div className="dialog-overlay" onClick={cancelAxiomRefDialog}>
          <form
            className="dialog-box node-dialog"
            onClick={(event) => event.stopPropagation()}
            onSubmit={confirmAxiomRefDialog}
          >
            <header className="dialog-header">添加事实前提引用</header>
            <label className="dialog-field">
              <span>事实前提</span>
              <select
                className="dialog-input"
                value={String(axiomRefDialog.axiomId ?? '')}
                onChange={(event) => setAxiomRefDialog((current) => current ? {
                  ...current,
                  axiomId: event.target.value
                } : current)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') cancelAxiomRefDialog();
                  event.stopPropagation();
                }}
                autoFocus
              >
                {(axiomRefDialog.options ?? []).map((axiom: { id?: unknown; label?: string; content?: string; [k: string]: unknown }) => (
                  <option key={String(axiom.id ?? '')} value={String(axiom.id ?? '')}>
                    {axiom.label} {axiom.content}
                  </option>
                ))}
              </select>
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={cancelAxiomRefDialog}>取消</button>
              <button type="submit">确定</button>
            </div>
          </form>
        </div>
      )}

      <ProgressOverlay progress={progress as Parameters<typeof ProgressOverlay>[0]['progress']} lockedProgress={lockedProgress as Parameters<typeof ProgressOverlay>[0]['lockedProgress']} locked={Boolean(operationLock)} onCancel={cancelSummaryGeneration} />
      </main>
    </>
  );
}
