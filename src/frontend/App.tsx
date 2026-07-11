

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { EditBranchRow } from '../backend/db/schema.js';

import { normalizeNodeLayoutSettingsByView, loadedDepthForDoc, treeDocRequest, isEditableTarget,
  normalizeDocId,
  SOURCE_WINDOW_BEFORE_CHARS
} from './lib/doc-utils.js';


import { debugLog } from './lib/debug-log.js';
import { debugElementTarget, debugShouldLogKey } from './features/debug/ui-debug-actions.js';
import { openSettingsAction, saveAgentSettingsAction } from './features/settings/settings-actions.js';
import { type EditBranchDiffViewModel } from './components/EditBranchDiffDialog.jsx';
import { useAppUI, useAppUIContext, AppUIContext, type AppTab } from './hooks/useAppUI.js';
import { useLayout } from './hooks/useLayout.js';
import { useEntityTrace } from './hooks/useEntityTrace.js';
import { useNodeSelection } from './hooks/useNodeSelection.js';
import { useSettings } from './hooks/useSettings.js';
import { useStartup } from './hooks/useStartup.js';
import { useSummaryRun } from './hooks/useSummaryRun.js';
import { useAgentChat } from './hooks/useAgentChat.js';
import { useDocumentState } from './hooks/useDocumentState.js';
import { usePromptDialog } from './hooks/usePromptDialog.js';
import { useTreeViewState } from './hooks/useTreeViewState.js';
import { closeWindow, onLibraryChanged, onProgress } from './data/iftree-api.js';
import { createStore } from './stores/create-store.js';
import { initialEditorState } from './stores/editor-store.js';
import { createEditorCommands, type EditorCommandDeps, type EditorCurrentDocLike } from './commands/editor-commands.js';
import { createDocumentCommands, type DocumentCommandDeps, type DocumentOpenedDocLike } from './commands/document-commands.js';
import { createAgentCommands, type AgentCommandDeps } from './commands/agent-commands.js';
import { createTreeViewCommands, type TreeViewCommandDeps, type TreeViewDocLike } from './commands/treeview-commands.js';
import { createAxiomCommands, type AxiomCommandDeps, type AxiomRefDialogPayload } from './commands/axiom-commands.js';
import { createImportCommands, type ImportCommandDeps } from './commands/import-commands.js';
import { CommandsContext, type AppCommands } from './commands/commands-context.js';
import { AppStateContext, type AppState } from './app-context.js';
import { SettingsScreen } from './screens/SettingsScreen.jsx';
import { EditorScreen } from './screens/EditorScreen.jsx';
import {
  documentRepository,
  settingsRepository,
  vectorService
} from './data/repositories.js';
import type { VectorContentSearchItem } from './data/operation-services.js';

type DebugContextLog = Record<string, unknown>;
type LastUiAction = { event: string; [extra: string]: unknown } | null;

export function AppBody() {
  const ui = useAppUIContext();
  // 装配根只解构自身装配/薄层 effect 需要的字段；渲染消费一律走 screens/* 的 context。
  const {
    busy, activeTab, activeScreen,
    setBusy, setNotice, setProgress, setOperationLock, setActiveTab, setActiveScreen
  } = ui;
  const docState = useDocumentState();
  const {
    selectedLibraryEntry, currentDoc,
    setDocs, setSelectedLibraryEntry, setCurrentDoc, startupOpenRequestedRef,
    loadComplete: loadCompleteDoc,
    loadSourceWindow,
    refreshLibrary: refreshLibraryTree,
    refreshList: refreshDocList
  } = docState;
  const treeView = useTreeViewState(docState);
  const {
    depthLimit, axiomsCollapsed, collapsed, expanded,
    setAxiomsCollapsed, setCollapsed, setExpanded, setCollapsedOutlineNodeIds,
    actualMaxDepth,
    applyState: applyTreeViewState,
    setPersisted: setPersistedTreeView,
    setPersistedAfterExpansion: setPersistedTreeViewAfterExpansion,
    persistOutline: persistOutlineViewState
  } = treeView;
  const selection = useNodeSelection(docState);
  const {
    selectedNodeId, selectedNode, multiSelectedNodeIds,
    setSelectedNodeId, setMultiSelectedNodeIds, setLocateRequest
  } = selection;
  // 实体面板状态住装配根（设置屏往返 EditorScreen 整棵卸载，WorkspacePane 里放不住）。
  const entityTrace = useEntityTrace({ docId: currentDoc?.doc?.id });
  // 编辑模式 = 当前文档是否持有编辑分支标识（需求 8-3-2）；不另设独立开关，二者不可能不一致。
  const treeEditMode = Boolean(currentDoc?.editBranch);

  const debugContextRef = useRef<DebugContextLog>({});
  const lastUiActionRef = useRef<LastUiAction>(null);
  const previousActiveTabRef = useRef<typeof activeTab>(activeTab);
  const layout = useLayout();
  const { toggleLeft: toggleLeftSidebar, toggleRight: toggleRightSidebar } = layout;
  const settingsState = useSettings();
  const {
    vectorSettings, llmSummarySettings,
    setVectorSettings, setLlmSummarySettings, setNodeLayoutSettings
  } = settingsState;
  const agentChat = useAgentChat();
  const {
    settings: agentSettings,
    messages: agentMessages,
    diffs: agentDiffs,
    activeSessionId: activeAgentSessionId,
    contextUsage: agentContextUsage,
    setSettings: setAgentSettings,
    setMessages: setAgentMessages,
    setDiffs: setAgentDiffs,
    setActiveSessionId: setActiveAgentSessionId,
    setBusy: setAgentBusy,
    setContextUsage: setAgentContextUsage,
    saveSettings: saveAgentSettingsCore,
    refreshSessions: refreshAgentSessions
  } = agentChat;
  // 语义检索 state 留装配根：documentDeps.view.setSearchResults 在 openDoc/清场时清空它。
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<VectorContentSearchItem[]>([]);
  // ─── editor 命令层装配（frontend-refactor.md 阶段 1）───
  // 生命周期状态机 + 两栈住 editorStore；逻辑住 commands/editor-commands.ts。
  // deps 每 render 整体刷新，命令经 getDeps() 惰性读取最新值（原 handler 闭包语义的 γ 桥接；
  // 阶段 3 AppBody 退化薄装配根后，装配上移 App 并经 CommandsContext 下发）。
  // view 三函数 / prompts / loadDocForCurrentView 是 hoisted function 声明，闭包引用合法。
  const editExitDialog = usePromptDialog();
  const startupEditBranchDialog = usePromptDialog();
  const agentApprovalEditDialog = usePromptDialog();
  const editorStore = useMemo(() => createStore(initialEditorState()), []);
  const editorDepsRef = useRef<EditorCommandDeps | null>(null);
  const editorCommands = useMemo(() => createEditorCommands(() => editorDepsRef.current!), []);
  // ─── treeView 命令层装配（阶段 2c）：树视图态动词 + editor history 视图态接口进
  // commands/treeview-commands.ts（editorDeps.view 指向它，收掉阶段 1 预留的接缝）。───
  const treeViewDepsRef = useRef<TreeViewCommandDeps | null>(null);
  const treeViewCommands = useMemo(() => createTreeViewCommands(() => treeViewDepsRef.current!), []);
  treeViewDepsRef.current = {
    getCurrentDoc: () => (currentDoc || null) as TreeViewDocLike | null,
    docState: {
      ensureNodeChildren: (nodeId) => docState.ensureNodeChildren(nodeId)
    },
    tree: {
      getDepthLimit: () => depthLimit,
      getCollapsed: () => collapsed,
      getExpanded: () => expanded,
      getActualMaxDepth: () => actualMaxDepth,
      setPersistedTreeView: (nextDepth, nextCollapsed, nextExpanded, docId) => setPersistedTreeView(nextDepth, nextCollapsed, nextExpanded, docId),
      setPersistedTreeViewAfterExpansion: (nextDepth, nextCollapsed, nextExpanded) => setPersistedTreeViewAfterExpansion(nextDepth, nextCollapsed, nextExpanded),
      applyTreeViewState: (doc) => applyTreeViewState(doc as Parameters<typeof applyTreeViewState>[0]),
      setCollapsedOutlineNodeIds: (updater) => setCollapsedOutlineNodeIds(updater as Parameters<typeof setCollapsedOutlineNodeIds>[0]),
      persistOutlineViewState: (next) => persistOutlineViewState(next as Parameters<typeof persistOutlineViewState>[0])
    },
    selection: {
      getSelectedNode: () => (selectedNode || null) as ReturnType<TreeViewCommandDeps['selection']['getSelectedNode']>,
      getSelectedNodeId: () => selectedNodeId,
      setSelectedNodeId: (id) => setSelectedNodeId?.(normalizeDocId(id)),
      setLocateRequest: (updater) => setLocateRequest(updater as unknown as Parameters<typeof setLocateRequest>[0])
    },
    ui: {
      setNotice,
      getActiveTab: () => activeTab,
      setActiveTab: (tab) => {
        if (tab === 'tree' || tab === 'ide' || tab === 'rich' || tab === 'entity' || tab === 'search') setActiveTab(tab);
      }
    }
  };
  editorDepsRef.current = {
    editorStore,
    getCurrentDoc: () => (currentDoc || null) as EditorCurrentDocLike | null,
    docState: {
      reconcileWrittenNode: (node) => docState.reconcileWrittenNode(node as Parameters<typeof docState.reconcileWrittenNode>[0]),
      patchDocMeta: (patch) => docState.patchDocMeta(patch as Parameters<typeof docState.patchDocMeta>[0]),
      reloadStructuralChange: (affected) => docState.reloadStructuralChange(affected),
      loadComplete: (docId) => loadCompleteDoc(docId)
    },
    ui: {
      getBusy: () => busy,
      setBusy,
      setNotice,
      setDocs: (nextDocs) => setDocs(nextDocs as Parameters<typeof setDocs>[0])
    },
    view: {
      editorHistoryViewState: treeViewCommands.editorHistoryViewState,
      applyEditorHistoryViewState: treeViewCommands.applyEditorHistoryViewState,
      applyEditorHistoryEffect: treeViewCommands.applyEditorHistoryEffect,
      setSelectedLibraryEntry: (entry) => setSelectedLibraryEntry(entry)
    },
    prompts: {
      editExitChoice: () => promptEditExitChoice(),
      agentApprovalEditChoice: () => promptAgentApprovalEditChoice()
    },
    loadDocForCurrentView: (docId, sourceDoc) => loadDocForCurrentView(docId, sourceDoc),
    refreshDocList: () => refreshDocList()
  };
  const {
    activeEditBranch,
    editBranchBaseDocId,
    editBranchShadowDocId,
    editBranchUndoEntries,
    undoEdit,
    redoEdit,
    saveAndLeaveEditMode,
    dispatchWrite: runWrite
  } = editorCommands;
  const summaryRun = useSummaryRun({
    currentDoc,
    treeEditMode,
    selectedNode,
    selectedNodeId,
    multiSelectedNodeIds,
    llmSummarySettings,
    setDocs,
    dispatch: runWrite
  });
  // 引用选择框 UI state（业务校验/写入在 axiomCommands，这里只持表单值）。
  // 原 axiomDialog（新增前提弹窗）已删：openAxiomDialog 改直建后无任何开启点，弹窗恒不可达。
  const [axiomRefDialog, setAxiomRefDialog] = useState<AxiomRefDialogPayload | null>(null);
  // ─── axiom 命令层装配（阶段 2c）：事实前提动词进 commands/axiom-commands.ts ───
  const axiomDepsRef = useRef<AxiomCommandDeps | null>(null);
  const axiomCommands = useMemo(() => createAxiomCommands(() => axiomDepsRef.current!), []);
  axiomDepsRef.current = {
    getCurrentDoc: () => (currentDoc || null) as ReturnType<AxiomCommandDeps['getCurrentDoc']>,
    editor: editorCommands,
    docState: {
      patchDocMeta: (patch) => docState.patchDocMeta(patch as Parameters<typeof docState.patchDocMeta>[0])
    },
    ui: {
      setBusy,
      setNotice,
      setDocs: (nextDocs) => setDocs(nextDocs as Parameters<typeof setDocs>[0])
    },
    tree: {
      getAxiomsCollapsed: () => axiomsCollapsed,
      setAxiomsCollapsed: (value) => setAxiomsCollapsed(value)
    },
    view: {
      setLocateRequest: (updater) => setLocateRequest(updater as unknown as Parameters<typeof setLocateRequest>[0])
    },
    dialogs: {
      openAxiomRef: (payload) => setAxiomRefDialog(payload)
    }
  };
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
  // ─── agent 命令层装配（阶段 2b）：会话运行/取消/diff 审批进 commands/agent-commands.ts。
  // 声明在 document 装配之前（documentDeps.agent 引用它），deps 赋值在 documentDeps 之后。───
  const agentDepsRef = useRef<AgentCommandDeps | null>(null);
  const agentCommands = useMemo(() => createAgentCommands(() => agentDepsRef.current!), []);
  // ─── document 命令层装配（阶段 2a）：文档生命周期编排进 commands/document-commands.ts ───
  const documentDepsRef = useRef<DocumentCommandDeps | null>(null);
  const documentCommands = useMemo(() => createDocumentCommands(() => documentDepsRef.current!), []);
  const importDepsRef = useRef<ImportCommandDeps | null>(null);
  const importCommands = useMemo(() => createImportCommands(() => importDepsRef.current!), []);
  const closeAfterEditModeSaveRef = useRef(false);
  const { armRenderUnlock, handleMindMapRenderReady } = useStartup({
    currentDoc,
    lastUiActionRef,
    startupOpenRequestedRef,
    setDocs,
    setDocFolders: docState.setDocFolders,
    setLibraryTree: docState.setLibraryTree,
    setVectorSettings,
    setLlmSummarySettings,
    setNodeLayoutSettings,
    setAgentSettings,
    setAgentDiffs,
    refreshAgentSessions,
    openDoc: documentCommands.openDoc,
    promptStartupEditBranchChoice,
    editBranchBaseDocId
  });
  documentDepsRef.current = {
    getCurrentDoc: () => (currentDoc || null) as DocumentOpenedDocLike | null,
    docState: {
      loadComplete: (docId, label, options) => loadCompleteDoc(docId, label, options) as Promise<DocumentOpenedDocLike | null>,
      setCurrentDoc: (next) => setCurrentDoc(next as Parameters<typeof setCurrentDoc>[0]),
      refreshList: () => refreshDocList(),
      refreshLibrary: () => refreshLibraryTree()
    },
    editor: editorCommands,
    ui: {
      setBusy,
      setNotice,
      setProgress: (value) => setProgress(value as Parameters<typeof setProgress>[0]),
      setOperationLock: (value) => setOperationLock(value as Parameters<typeof setOperationLock>[0]),
      setDocs: (nextDocs) => setDocs(nextDocs as Parameters<typeof setDocs>[0])
    },
    view: {
      getActiveTab: () => activeTab,
      getSelectedNodeId: () => selectedNodeId,
      setSelectedNodeId: (id) => setSelectedNodeId?.(normalizeDocId(id)),
      setMultiSelectedNodeIds: (ids) => setMultiSelectedNodeIds?.(ids),
      resetCollapseSets: () => {
        setCollapsed(new Set());
        setExpanded(new Set());
      },
      setSearchResults: (results) => setSearchResults(results),
      bumpLocateRequest: (nodeId) => setLocateRequest((prev) => ({ seq: prev.seq + 1, nodeId: normalizeDocId(nodeId) })),
      resetLocateRequest: () => setLocateRequest({ seq: 0, nodeId: null }),
      setSelectedLibraryEntry: (entry) => setSelectedLibraryEntry(entry as Parameters<typeof setSelectedLibraryEntry>[0]),
      getSelectedLibraryEntry: () => selectedLibraryEntry,
      armRenderUnlock: (docId, reason) => armRenderUnlock(docId, reason)
    }
  };
  agentDepsRef.current = {
    getCurrentDoc: () => (currentDoc || null) as ReturnType<AgentCommandDeps['getCurrentDoc']>,
    chat: {
      getMessages: () => agentMessages as ReturnType<AgentCommandDeps['chat']['getMessages']>,
      setMessages: (updater) => setAgentMessages(updater as Parameters<typeof setAgentMessages>[0]),
      getDiffs: () => agentDiffs as ReturnType<AgentCommandDeps['chat']['getDiffs']>,
      setDiffs: (diffs) => setAgentDiffs(diffs as Parameters<typeof setAgentDiffs>[0]),
      setActiveSessionId: (id) => setActiveAgentSessionId(id as Parameters<typeof setActiveAgentSessionId>[0]),
      getActiveSessionId: () => activeAgentSessionId,
      setAgentBusy,
      getContextUsage: () => agentContextUsage,
      setContextUsage: (usage) => setAgentContextUsage(usage as Parameters<typeof setAgentContextUsage>[0]),
      refreshSessions: () => refreshAgentSessions()
    },
    editor: editorCommands,
    document: documentCommands,
    docState: {
      patchDocMeta: (patch) => docState.patchDocMeta(patch as Parameters<typeof docState.patchDocMeta>[0]),
      reloadStructuralChange: () => docState.reloadStructuralChange(),
      refreshList: () => refreshDocList()
    },
    ui: { setNotice },
    view: {
      getActiveTab: () => activeTab,
      getDepthLimit: () => depthLimit,
      getSelectedNodeId: () => selectedNode?.id ?? null
    },
    loadDocForCurrentView: (docId, sourceDoc) => loadDocForCurrentView(docId, sourceDoc)
  };
  importDepsRef.current = {
    docState: {
      loadComplete: (docId, label) => loadCompleteDoc(docId, label) as Promise<DocumentOpenedDocLike | null>,
      refreshList: () => refreshDocList(),
      refreshLibrary: () => refreshLibraryTree()
    },
    document: documentCommands,
    editor: editorCommands,
    agent: agentCommands,
    ui: {
      setBusy,
      setNotice,
      setProgress: (value) => setProgress(value as Parameters<typeof setProgress>[0]),
      setOperationLock: (value) => setOperationLock(value as Parameters<typeof setOperationLock>[0])
    },
    view: {
      getSelectedLibraryEntry: () => selectedLibraryEntry,
      setSelectedLibraryEntry: (entry) => setSelectedLibraryEntry(entry as Parameters<typeof setSelectedLibraryEntry>[0])
    }
  };
  async function loadDocForCurrentView(docId: unknown, sourceDoc: unknown = currentDoc) {
    const depth = Math.max(loadedDepthForDoc(sourceDoc as Parameters<typeof loadedDepthForDoc>[0]), depthLimit, 1);
    return documentRepository.getDoc(treeDocRequest(docId, depth));
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

  const currentVisualDocId = editBranchBaseDocId() || normalizeDocId(currentDoc?.doc?.id);
  debugContextRef.current = {
    screen: activeScreen,
    view: activeTab,
    docId: currentVisualDocId,
    rawDocId: normalizeDocId(currentDoc?.doc?.id),
    selectedNodeId: normalizeDocId(selectedNode?.id),
    editMode: treeEditMode ? 'editing' : 'readonly',
    busy,
    depth: depthLimit,
    maxDepth: actualMaxDepth
  };

  const changeActiveTab = useCallback((targetTab: AppTab) => {
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
  }, [activeTab, activeScreen, currentVisualDocId, treeEditMode, busy, depthLimit, actualMaxDepth]);

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

  // 原「打开文档时算 outline 默认折叠集」effect 已下沉 session：ingestChildren 对新并入的
  // 深度≥2 有子节点增量维护 view.outlineCollapsed（一次性默认集盖不住后台预取的深层节点），
  // 持久化恢复由 loadComplete 的 applyViewState 承担。
  // 原「setAxiomsCollapsed(doc.axioms_collapsed)」effect 是旧本地 useState 世界的搬运残留：
  // useTreeViewState.axiomsCollapsed 现已直接从 doc 派生，该 effect 只剩「读 doc → 原样写回
  // doc」的自环（每次开文档多两轮投影 + 字段在 number/boolean 间漂移），一并删除。

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


  // 表单薄层：读选择框 state、关框，业务写入在 axiomCommands.confirmAxiomRef。
  async function confirmAxiomRefDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!axiomRefDialog) return;
    const { docId, nodeId, axiomId } = axiomRefDialog;
    setAxiomRefDialog(null);
    await axiomCommands.confirmAxiomRef({ docId, nodeId, axiomId });
  }

  function cancelAxiomRefDialog() {
    setAxiomRefDialog(null);
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

  async function runVectorSearch() {
    const docId = normalizeDocId(currentDoc?.doc?.id);
    if (!docId || !searchQuery.trim()) return;
    if (vectorModuleDisabled) {
      setSearchResults([]);
      setNotice(String(vectorDisabledMessage ?? ''));
      return;
    }
    setBusy(true);
    try {
      const results = await vectorService.searchContentByVector({
        docId,
        query: searchQuery.trim(),
        limit: 20
      });
      setSearchResults(results);
    } catch (error) {
      setNotice((error as { message?: string }).message ?? '');
    } finally {
      setBusy(false);
    }
  }

  // undoEdit/redoEdit 是命令层稳定引用（editorCommands useMemo 单例），键盘 effect 直接闭包，
  // 不再需要原 undoEditRef/redoEditRef 的每 render 刷新桥。
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
        void undoEdit();
      } else if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'y' || (event.shiftKey && event.key.toLowerCase() === 'z'))) {
        event.preventDefault();
        void redoEdit();
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

  // ─── context 组装（阶段 3）：命令与数据分两条 context 下发给 screens/*。
  // appCommands 是 useMemo 单例；appState 每 render 新对象（其字段本就随 render 变化，
  // 与原单组件全量重渲等价），阶段 4/5 store 化后逐域瘦身。───
  const publicDocumentCommands = useMemo(() => ({ ...documentCommands, ...importCommands }), [documentCommands, importCommands]);
  const appCommands: AppCommands = useMemo(() => ({
    editor: editorCommands,
    document: publicDocumentCommands,
    agent: agentCommands,
    treeView: treeViewCommands,
    axiom: axiomCommands
  }), [editorCommands, publicDocumentCommands, agentCommands, treeViewCommands, axiomCommands]);
  const appState: AppState = {
    docState,
    treeView,
    entityTrace,
    selection,
    layout,
    settingsState,
    agentChat,
    editorStore,
    summary: summaryRun,
    search: {
      query: searchQuery,
      setQuery: setSearchQuery,
      results: searchResults,
      runVectorSearch,
      vectorModuleDisabled,
      vectorDisabledMessage: String(vectorDisabledMessage ?? '')
    },
    startup: {
      armRenderUnlock,
      handleMindMapRenderReady: (info: unknown) => handleMindMapRenderReady(info as Parameters<typeof handleMindMapRenderReady>[0])
    },
    dialogs: {
      editExitDialog,
      startupEditBranchDialog,
      agentApprovalEditDialog,
      axiomRefDialog,
      setAxiomRefDialog,
      confirmAxiomRefDialog,
      cancelAxiomRefDialog,
      editBranchDiffDialog,
      openEditBranchDiff,
      closeEditBranchDiff
    },
    misc: {
      treeEditMode,
      currentVisualDocId,
      handleCloseWindow,
      openSettings,
      saveAgentSettings,
      chooseLocalModelRoot,
      downloadVectorModel,
      changeActiveTab
    }
  };

  return (
    <CommandsContext.Provider value={appCommands}>
      <AppStateContext.Provider value={appState}>
        {activeScreen === 'settings' ? <SettingsScreen /> : <EditorScreen />}
      </AppStateContext.Provider>
    </CommandsContext.Provider>
  );
}

// 顶层装配根（frontend-refactor.md §6 阶段 0：原 App.tsx 空壳与 AppBody.tsx 合并回
// 唯一顶层文件 App.tsx）。职责：组装横切 context 下发给主体——现在是 AppUIContext，
// 阶段 1+ 在此挂 CommandsContext.Provider（组装各组 createXxxCommands + domain stores，
// 见 commands/commands-context.ts）。Provider 与消费者（AppBody 内 useAppUIContext）
// 必须分属两个组件，故装配根与主体同文件、不同函数。
export function App() {
  const ui = useAppUI();
  return (
    <AppUIContext.Provider value={ui}>
      <AppBody />
    </AppUIContext.Provider>
  );
}
