import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Settings
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildNodeSentenceLabelMap } from '../core/source-ranges.mjs';
import { findNode, flattenTree } from '../core/tree.mjs';
import { createGpuEmbeddingService } from '../vector/gpu-embedding-service.js';

import {
  depthOf, isFactAxiomRef, clampDepthLimit, normalizeNodeLayoutSettingsByView, fullDepthForDoc, loadedDepthForDoc, treeDocRequest, sameDocId, mergeDocView,
  hasKnownChildren,
  idSetFromArray, treeViewStateFromDoc,
  normalizeFsPath, isSupportedLibraryImport, docSourcePath,
  docDisplayTitle, defaultCollapsedOutlineIds,
  buildParagraphLabelMap, mergeNodeChildrenIntoTree, isEditableTarget,
  normalizeDocId, persistActiveDocId,
  patchNodeInDoc, remapNodeIdByAddress, remapNodeIdSetByAddress,
  NODE_CHILDREN_PAGE_SIZE,
  SOURCE_WINDOW_BEFORE_CHARS
} from './lib/doc-utils.mjs';
import {
  agentHistoryForRequest
} from './lib/agent-utils.mjs';
import { debugLog, debugPerfBegin, debugPerfEnd } from './lib/debug-log.mjs';
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
import { EditBranchDiffDialog } from './components/EditBranchDiffDialog.jsx';
import { MergeConflictDialog } from './components/MergeConflictDialog.jsx';
import { DocBrowser } from './components/DocBrowser.jsx';
import { useAppUI } from './hooks/useAppUI.js';
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
import { closeWindow, onLibraryChanged, onProgress } from './data/iftree-api.js';
import {
  agentRepository,
  assetRepository,
  axiomRepository,
  documentRepository,
  embeddingBridge,
  historyRepository,
  importService,
  nodeRepository,
  refRepository,
  settingsRepository,
  vectorService
} from './data/repositories.js';

export function App() {
  const ui = useAppUI();
  const {
    busy, notice, progress, operationLock, lockedProgress, activeTab, activeScreen,
    setBusy, setNotice, setProgress, setOperationLock, setActiveTab, setActiveScreen
  } = ui;
  const docState = useDocumentState({ setNotice, setProgress, lock: ui.lock, unlock: ui.unlock });
  const {
    docs, docFolders, libraryTree, selectedLibraryEntry, libraryCutPath, currentDoc, sourceWindowLoading,
    setDocs, setDocFolders, setLibraryTree, setSelectedLibraryEntry, setLibraryCutPath, setCurrentDoc, startupOpenRequestedRef,
    loadComplete: loadCompleteDoc,
    loadTreeDepth: loadDocTreeDepth,
    loadSourceWindow,
    refreshLibrary: refreshLibraryTree,
    refreshList: refreshDocList
  } = docState;
  const treeView = useTreeViewState({
    currentDoc, setCurrentDoc, setNotice,
    setProgress, setOperationLock,
    loadTreeDepth: loadDocTreeDepth
  });
  const {
    depthLimit, axiomsCollapsed, collapsed, expanded, collapsedOutlineNodeIds,
    setDepthLimit, setAxiomsCollapsed, setCollapsed, setExpanded, setCollapsedOutlineNodeIds, outlineCollapseDocRef,
    actualMaxDepth, depthOptions,
    c2dDepthControlSeq, c2dDepthControlAction,
    setVisibleDepth, collapseVisibleDepthOne, syncC2dVisibleDepth,
    applyState: applyTreeViewState,
    persist: persistTreeViewState,
    setPersisted: setPersistedTreeView,
    setPersistedAfterExpansion: setPersistedTreeViewAfterExpansion,
    persistOutline: persistOutlineViewState
  } = treeView;
  const selection = useNodeSelection(currentDoc);
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
  const withBusy = useCallback(async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  }, [setBusy]);
  const undoStackRef = useRef(undoStack);
  const redoStackRef = useRef(redoStack);
  const debugContextRef = useRef({});
  const lastUiActionRef = useRef(null);
  const previousActiveTabRef = useRef(activeTab);

  const updateUndoStack = useCallback((update) => {
    const next = typeof update === 'function' ? update(undoStackRef.current) : update;
    undoStackRef.current = Array.isArray(next) ? next : [];
    setUndoStackState(undoStackRef.current);
    return undoStackRef.current;
  }, [setUndoStackState]);

  const updateRedoStack = useCallback((update) => {
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
  const settingsState = useSettings({ setNotice });
  const {
    vectorSettings, memorySettings, llmSummarySettings, nodeLayoutSettings,
    setVectorSettings, setLlmSummarySettings, setNodeLayoutSettings, saveVectorSettings, saveMemorySettings, saveLlmSummarySettings, saveNodeLayoutSettings
  } = settingsState;
  const agentChat = useAgentChat({ setNotice });
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
  const activeAgentRequestIdRef = useRef(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const {
    entityQuery, setEntityQuery, entityRows, selectedEntity, entityDetail,
    entityNodeQuery, entityNodeMatchMode, entityNodeResults, entityNodeGroups, entityNodePage,
    changeEntityNodeMatchMode, changeEntityNodeQuery,
    runEntitySearch, runEntityNodeSearch, selectEntityTraceEntity, useEntityTraceKeyword,
    pageEntityNodeSearch, dragEntityTraceEntity, dropEntityIntoNodeSearch, openEntityMaintenance
  } = useEntityTrace({
    docId: currentDoc?.doc?.id,
    activeTab,
    setBusy,
    setNotice
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
    setBusy,
    setNotice,
    setProgress,
    setDocs,
    setCurrentDoc,
    resolveWriteDoc,
    syncEditBranchHistoryStacks,
    activeEditBranch
  });
  const [axiomDialog, setAxiomDialog] = useState(null);
  const [axiomRefDialog, setAxiomRefDialog] = useState(null);
  const editExitDialog = usePromptDialog();
  const startupEditBranchDialog = usePromptDialog();
  const agentApprovalEditDialog = usePromptDialog();
  // 进入编辑模式的转移锁：防止快速双击锁按钮重复 beginEditBranch。
  const editModeTransitionRef = useRef(false);
  // 撤销/重做在途锁：键盘连发 Ctrl+Z 会绕过按钮 disabled，必须同步挡住重入。
  const historyOpInFlightRef = useRef(false);
  const [editBranchDiffDialog, setEditBranchDiffDialog] = useState({
    open: false,
    loading: false,
    view: null,
    error: ''
  });
  const [mergeConflictDialog, setMergeConflictDialog] = useState({
    open: false,
    applying: false,
    view: null,
    error: '',
    ctx: null
  });

  useEffect(() => {
    const onClick = (event) => {
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
    const onKeyDown = (event) => {
      if (!debugShouldLogKey(event)) return;
      const editable = isEditableTarget(event.target);
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
    ? Number(currentDoc.doc.node_count)
    : Number(currentDoc?.nodes?.length || 0);
  const visibleDepthLimit = depthLimit;
  const visibleDepthOptions = depthOptions;
  const closeAfterEditModeSaveRef = useRef(false);
  const { armRenderUnlock, handleMindMapRenderReady } = useStartup({
    currentDoc,
    activeTab,
    lockedProgress,
    progress,
    lastUiActionRef,
    startupOpenRequestedRef,
    setNotice,
    setProgress,
    setOperationLock,
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
    if (!(activeSourceSpans?.length > 0)) return new Map();
    // debug 模式下测全树 sentence label 聚合耗时——这个会在 sourceSpans 变化（如翻窗口）时重跑
    const perfToken = debugPerfBegin('buildNodeSentenceLabelMap');
    const map = buildNodeSentenceLabelMap(currentDoc?.tree, activeSourceSpans);
    debugPerfEnd('buildNodeSentenceLabelMap', perfToken, { spans: activeSourceSpans.length, nodes: map.size });
    return map;
  }, [currentDoc?.tree, currentDoc?.sourceSpans, currentDoc?.sourceWindow?.sourceSpans]);
  const paragraphLabelByNodeId = useMemo(() => {
    // debug 模式下测段落 label 聚合耗时
    const perfToken = debugPerfBegin('buildParagraphLabelMap');
    const map = buildParagraphLabelMap(currentDoc?.tree);
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

  function activeEditBranch(doc = currentDoc) {
    return doc?.editBranch || null;
  }

  function editBranchBaseDocId(branch = activeEditBranch()) {
    return normalizeDocId(branch?.base_doc_id ?? branch?.baseDocId);
  }

  function editBranchShadowDocId(branch = activeEditBranch()) {
    return normalizeDocId(branch?.shadow_doc_id ?? branch?.shadowDocId);
  }

  function editBranchDiffEntries(branch = activeEditBranch()) {
    if (!branch?.diff) return [];
    try {
      const diff = typeof branch.diff === 'string' ? JSON.parse(branch.diff || '{}') : branch.diff;
      return Array.isArray(diff.entries) ? diff.entries : [];
    } catch {
      return [];
    }
  }

  function isUndoneEditBranchEntry(entry) {
    return String(entry?.status || 'active') === 'undone';
  }

  function editBranchUndoEntries(branch = activeEditBranch()) {
    return editBranchDiffEntries(branch).filter((entry) => !isUndoneEditBranchEntry(entry));
  }

  function editBranchRedoEntries(branch = activeEditBranch()) {
    return editBranchDiffEntries(branch)
      .filter(isUndoneEditBranchEntry)
      .sort((left, right) => String(left.undoneAt || left.createdAt || '').localeCompare(String(right.undoneAt || right.createdAt || '')));
  }

  function syncEditBranchHistoryStacks(branch = activeEditBranch()) {
    // 进入编辑模式时旧栈里是非编辑模式的快照 token，整栈替换前先释放；
    // 编辑模式内的常规刷新旧栈是 diff entry，discard 会被前缀过滤成空操作。
    discardHistoryTokens([...undoStackRef.current, ...redoStackRef.current]);
    updateUndoStack(editBranchUndoEntries(branch));
    updateRedoStack(editBranchRedoEntries(branch));
  }

  const diffBranchOptions = useMemo(() => {
    const branch = activeEditBranch(currentDoc);
    if (!branch) return [];
    const activeEntryCount = editBranchUndoEntries(branch).length;
    const owner = String(branch.owner || 'human');
    return [{
      id: branch.id,
      owner,
      label: owner === 'llm' ? 'LLM 分支' : 'human 分支',
      activeEntryCount,
      disabled: activeEntryCount <= 0,
      branch
    }];
  }, [currentDoc?.editBranch]);

  async function loadDocForCurrentView(docId, sourceDoc = currentDoc) {
    const depth = Math.max(loadedDepthForDoc(sourceDoc), depthLimit, 1);
    return documentRepository.getDoc(treeDocRequest(docId, depth));
  }

  function switchDocPreservingView(nextDoc, sourceDoc, { editMode, persistedDocId, noticeText }: any = {}) {
    if (!nextDoc?.doc?.id) return;
    const nextMaxDepth = fullDepthForDoc(nextDoc);
    const nextDepthLimit = clampDepthLimit(depthLimit, nextMaxDepth);
    const nextCollapsed = remapNodeIdSetByAddress(sourceDoc, nextDoc, collapsed);
    const nextExpanded = remapNodeIdSetByAddress(sourceDoc, nextDoc, expanded);
    const nextOutlineCollapsed = remapNodeIdSetByAddress(sourceDoc, nextDoc, collapsedOutlineNodeIds);
    const nextSelectedNodeId = remapNodeIdByAddress(sourceDoc, nextDoc, selectedNodeId) || nextDoc?.tree?.id || null;
    const nextMultiSelectedNodeIds = remapNodeIdSetByAddress(sourceDoc, nextDoc, multiSelectedNodeIds);

    // 退出编辑（editMode=false）时显式清除编辑分支标识，使派生的编辑态切回只读；
    // base doc 视图本就不带标识，这里再兜一道，确保保存/丢弃后不会残留编辑态。
    setCurrentDoc(editMode ? nextDoc : { ...nextDoc, editBranch: null });
    setSelectedLibraryEntry(null);
    persistActiveDocId(persistedDocId || nextDoc.doc.id);
    setSelectedNodeId(nextSelectedNodeId);
    setMultiSelectedNodeIds(nextMultiSelectedNodeIds);
    setDepthLimit(nextDepthLimit);
    setCollapsed(nextCollapsed);
    setExpanded(nextExpanded);
    setCollapsedOutlineNodeIds(nextOutlineCollapsed);
    persistTreeViewState(nextDepthLimit, nextCollapsed, nextExpanded, nextDoc.doc.id, nextOutlineCollapsed);
    if (editMode) syncEditBranchHistoryStacks(nextDoc.editBranch);
    else clearHistoryStacks();
    if (noticeText) setNotice(noticeText);
  }

  // 弹窗超时/被顶替时的兜底返回值与各自的 backdrop 默认值保持一致（见各 ChoiceDialog）。
  function promptEditExitChoice() {
    return editExitDialog.prompt({}, 'cancel');
  }

  function promptStartupEditBranchChoice(branch) {
    return startupEditBranchDialog.prompt(branch || {}, 'stash');
  }

  function promptAgentApprovalEditChoice() {
    return agentApprovalEditDialog.prompt({}, 'cancel');
  }

  function clearEditModeState(noticeText = '已退出编辑模式') {
    setCurrentDoc((current) => (
      current?.editBranch ? { ...current, editBranch: null } : current
    ));
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
      const result = await documentRepository.beginEditBranch({ docId: sourceDoc.doc.id, owner: 'human', includeDoc: false });
      const baseDocId = result?.baseDocId || result?.branch?.base_doc_id || sourceDoc.doc.id;
      if (!baseDocId) throw new Error('进入编辑模式失败');
      setCurrentDoc((current) => (
        current?.doc?.id === sourceDoc?.doc?.id ? { ...current, editBranch: result?.branch || null } : current
      ));
      persistActiveDocId(baseDocId);
      syncEditBranchHistoryStacks(result?.branch || null);
      setNotice('已进入编辑模式');
      return true;
    } catch (error) {
      setNotice(error.message);
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

  async function saveAndLeaveEditMode(targetDocId = null) {
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
      const leaveWithTrunk = async (docIdToLoad, sourceDoc, noticeText) => {
        const nextDoc = await loadDocForCurrentView(docIdToLoad, sourceDoc);
        switchDocPreservingView(nextDoc, sourceDoc, {
          editMode: false,
          persistedDocId: docIdToLoad,
          noticeText
        });
        setDocs(await documentRepository.listDocs());
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
        const result = await documentRepository.applyEditBranchMerge({ shadowDocId, owner: branchOwner, includeDoc: false });
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
        let branchGone = /Edit branch not found/i.test(String(error?.message || error));
        if (!branchGone) {
          try {
            const pending = await documentRepository.getPendingEditBranches();
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
            clearEditModeState(`已退出编辑模式；视图刷新失败：${refreshError.message}`);
          }
          return true;
        }
        setNotice(error.message);
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

  const changeActiveTab = useCallback((nextTab) => {
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

  async function confirmLeaveEditMode(targetDocId = null) {
    return saveAndLeaveEditMode(targetDocId);
  }

  async function handleCloseWindow() {
    if (closeAfterEditModeSaveRef.current) {
      closeWindow().catch((error) => setNotice(error.message));
      return;
    }
    const saved = await saveAndLeaveEditMode();
    if (!saved) return;
    closeAfterEditModeSaveRef.current = true;
    closeWindow().catch((error) => {
      closeAfterEditModeSaveRef.current = false;
      setNotice(error.message);
    });
  }

  async function refreshDocs(nextDocId = currentVisualDocId, options: any = {}) {
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
      try {
        const doc = await loadCompleteDoc(targetDoc.id, undefined, { keepLockAfterLoad: waitForRender });
        const isDifferentDoc = normalizeDocId(currentDoc?.doc?.id) !== normalizeDocId(doc?.doc?.id);
        const renderUnlockArmed = waitForRender && isDifferentDoc && doc?.tree
          ? armRenderUnlock(doc?.doc?.id || targetDoc.id, 'refresh-doc')
          : false;
        setCurrentDoc((current) => mergeDocView(current, doc));
        setSelectedLibraryEntry(null);
        persistActiveDocId(doc?.doc?.id || targetDoc.id);
        // 同文档刷新保留选中；切到别的文档时旧选中是幽灵 id，清空而不是默认选 root
        setSelectedNodeId((existing) => (isDifferentDoc ? null : existing));
        if (isDifferentDoc) applyTreeViewState(doc);
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

  async function openDoc(docId, options: any = {}) {
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
      setCurrentDoc(doc);
      persistActiveDocId(openedBaseDocId || doc?.doc?.id || docId);
      setSelectedLibraryEntry(null);
      setSelectedNodeId(null);
      setMultiSelectedNodeIds(new Set());
      applyTreeViewState(doc);
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
      const doc = await documentRepository.getLibraryNavigation();
      setCurrentDoc(doc);
      setSelectedLibraryEntry(null);
      persistActiveDocId(null);
      setSelectedNodeId(null);
      setMultiSelectedNodeIds(new Set());
      applyTreeViewState(doc);
      clearHistoryStacks();
      setSearchResults([]);
      setLocateRequest((prev) => ({ seq: (prev?.seq || 0) + 1, nodeId: doc?.tree?.id || null }));
      return doc;
    } catch (error) {
      setNotice(error.message);
      return null;
    } finally {
      setBusy(false);
      setProgress(null);
      setOperationLock(null);
    }
  }

  useEffect(() => {
    return onProgress((data) => {
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

  useEffect(() => {
    if (vectorSettings?.enabled !== true) return undefined;
    if (!embeddingBridge.canHandleBatchRequests()) return undefined;
    const embeddingService = createGpuEmbeddingService();
    const unsubscribe = embeddingBridge.subscribeBatchRequests(async (payload) => {
      try {
        const vectors = await embeddingService.embed(payload?.texts || [], payload?.config || {}, (progressEvent) => {
          embeddingBridge.sendBatchProgress({
            requestId: payload?.requestId,
            ...progressEvent
          });
        });
        embeddingBridge.sendBatchResult({
          requestId: payload?.requestId,
          vectors
        });
      } catch (error) {
        embeddingBridge.sendBatchResult({
          requestId: payload?.requestId,
          error: {
            message: error?.message || String(error)
          }
        });
      }
    });
    return () => {
      unsubscribe?.();
      embeddingService.dispose();
    };
  }, [vectorSettings?.enabled]);

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

  function normalizeEditorHistoryViewState(value) {
    if (!value || typeof value !== 'object') return null;
    const docId = normalizeDocId(value.docId || value.doc_id);
    if (!docId) return null;
    return {
      docId,
      activeTab: ['tree', 'ide', 'rich', 'entity', 'search'].includes(value.activeTab) ? value.activeTab : null,
      depthLimit: Math.max(1, Math.floor(Number(value.depthLimit) || 1)),
      collapsedNodeIds: [...idSetFromArray(value.collapsedNodeIds)],
      expandedNodeIds: [...idSetFromArray(value.expandedNodeIds)],
      selectedNodeId: normalizeDocId(value.selectedNodeId || value.selected_node_id)
    };
  }

  function normalizeEditorHistoryEffect(value) {
    if (!value || typeof value !== 'object') return null;
    const kind = String(value.kind || '');
    if (kind !== 'expandNodeOne') return null;
    const docId = normalizeDocId(value.docId || value.doc_id || currentDoc?.doc?.id);
    const nodeId = normalizeDocId(value.nodeId || value.node_id);
    if (!docId || !nodeId) return null;
    return {
      kind,
      docId,
      nodeId,
      minDepth: Math.max(0, Math.floor(Number(value.minDepth) || 0))
    };
  }

  function attachEditorHistoryViewState(token, viewState = null, effect = null) {
    const normalized = normalizeHistoryToken(token);
    if (!normalized) return null;
    const normalizedEffect = normalizeEditorHistoryEffect(effect || token?.effect || token?.redoEffect || normalized.effect);
    return {
      ...normalized,
      viewState: normalizeEditorHistoryViewState(viewState || token?.viewState) || normalized.viewState || null,
      effect: normalizedEffect || null
    };
  }

  function applyEditorHistoryViewState(viewState, doc) {
    const state = normalizeEditorHistoryViewState(viewState);
    const docId = normalizeDocId(doc?.doc?.id || currentDoc?.doc?.id);
    if (!state || !sameDocId(state.docId, docId)) {
      if (doc) applyTreeViewState(doc);
      return;
    }
    const nextDepthLimit = clampDepthLimit(state.depthLimit, fullDepthForDoc(doc || currentDoc));
    if (state.activeTab) setActiveTab(state.activeTab);
    setPersistedTreeView(
      nextDepthLimit,
      idSetFromArray(state.collapsedNodeIds),
      idSetFromArray(state.expandedNodeIds),
      state.docId
    );
    if (state.selectedNodeId) {
      const node = findNode(doc?.tree, state.selectedNodeId) || doc?.treeIndex?.nodeOf?.(state.selectedNodeId);
      setSelectedNodeId(node?.id || state.selectedNodeId);
    }
  }

  async function resolveWriteDoc(result, options: any = {}) {
    if (!result) return null;
    const refreshDocId = normalizeDocId(result.refresh?.docId || result.docId);
    if (refreshDocId && ['doc', 'doc_state'].includes(result.refresh?.kind)) {
      const minDepth = Math.max(0, Math.floor(Number(options.minDepth) || 0));
      // 新插入节点可能比当前 loaded/depthLimit 深一级；refetch 必须覆盖它，
      // 否则父节点 childCount 已经 +1 但新子节点没载入，画面上看不到。
      const insertedDepth = Number(result.node?.depth);
      const insertedMin = Number.isFinite(insertedDepth) && insertedDepth > 0 ? insertedDepth : 0;
      const currentDepth = sameDocId(refreshDocId, currentDoc?.doc?.id)
        ? Math.max(loadedDepthForDoc(currentDoc), depthLimit, loadedDepthForDoc(result.doc), minDepth, insertedMin)
        : Math.max(loadedDepthForDoc(result.doc), minDepth, insertedMin);
      return documentRepository.getDoc(treeDocRequest(refreshDocId, currentDepth || depthLimit || minDepth));
    }
    if (result.doc?.doc) return result.doc;
    if (result.doc && result.tree) return result;
    if (result.refresh?.kind === 'node' && result.node) {
      const patched = patchNodeInDoc(currentDoc, result.node);
      return result.editBranch ? { ...patched, editBranch: result.editBranch } : patched;
    }
    return null;
  }

  function normalizeHistoryToken(token) {
    const id = String(token?.id || token?.tokenId || '');
    const docId = normalizeDocId(token?.docId || token?.doc_id || currentDoc?.doc?.id);
    if (!id || !docId) return null;
    return {
      id,
      docId,
      viewState: normalizeEditorHistoryViewState(token?.viewState),
      effect: normalizeEditorHistoryEffect(token?.effect || token?.redoEffect)
    };
  }

  async function captureEditorHistoryToken(docId = currentDoc?.doc?.id, viewState = editorHistoryViewState(docId), effect = null) {
    const normalizedDocId = normalizeDocId(docId);
    if (!normalizedDocId) return null;
    const result = await historyRepository.captureEditorHistoryToken({ docId: normalizedDocId });
    return attachEditorHistoryViewState(result?.token || result, viewState, effect);
  }

  // 只有后端 editorSnapshotTokens 里的快照 token（id 形如 editor-N）需要释放；
  // 编辑分支栈里的 diff entry 会被 normalizeHistoryToken 误判成 token（docId 有兜底），靠前缀挡掉。
  function tokenIds(tokens) {
    return (Array.isArray(tokens) ? tokens : [])
      .map((token) => normalizeHistoryToken(token)?.id)
      .filter((id) => id && id.startsWith('editor-'));
  }

  function discardHistoryTokens(tokens) {
    const ids = tokenIds(tokens);
    if (ids.length === 0) return;
    historyRepository.discardEditorHistoryTokens({ tokenIds: ids }).catch((error) => setNotice(error.message));
  }

  // 栈封顶 80：被挤出的旧 token 必须通知后端释放对应全量快照，否则滞留到进程退出。
  function pushHistoryToken(stack, token) {
    const evicted = stack.slice(0, -79);
    if (evicted.length > 0) discardHistoryTokens(evicted);
    return [...stack.slice(-79), token];
  }

  function clearHistoryStacks() {
    discardHistoryTokens([...undoStackRef.current, ...redoStackRef.current]);
    updateUndoStack([]);
    updateRedoStack([]);
  }

  function isSuccessfulWriteResult(result) {
    return result !== undefined && result !== null && result !== false && result?.ok !== false;
  }

  async function runWrite(action, options: any = {}) {
    if (!currentDoc) return;
    let undoToken = null;
    const historyEffect = normalizeEditorHistoryEffect(options.historyEffect || options.redoEffect || options.effect);
    setBusy(true);
    try {
      if (!treeEditMode) {
        undoToken = await captureEditorHistoryToken(currentDoc?.doc?.id, editorHistoryViewState(currentDoc?.doc?.id), historyEffect);
      }
      const next = await action();
      const writeOk = isSuccessfulWriteResult(next);
      if (writeOk && undoToken) {
        discardHistoryTokens(redoStackRef.current);
      }
      if (next) {
        const nextDoc = await resolveWriteDoc(next);
        if (nextDoc) {
          setCurrentDoc((current) => mergeDocView(current, nextDoc));
        }
        if (treeEditMode) syncEditBranchHistoryStacks(nextDoc?.editBranch || next.editBranch || activeEditBranch());
        if (writeOk && undoToken) {
          const nextUndoStack = updateUndoStack((stack) => pushHistoryToken(stack, undoToken));
          updateRedoStack([]);
          debugLog('editor.history.pushUndo', {
            docId: undoToken.docId,
            tokenId: undoToken.id,
            undoDepth: nextUndoStack.length,
            redoDepth: 0
          });
          undoToken = null;
        }
        if (Array.isArray(next.docs)) setDocs(next.docs);
        else if (!next.skipDocsRefresh) setDocs(await documentRepository.listDocs());
      }
      if (undoToken) {
        discardHistoryTokens([undoToken]);
        undoToken = null;
      }
      return next;
    } catch (error) {
      if (undoToken) discardHistoryTokens([undoToken]);
      setNotice(error.message);
      return null;
    } finally {
      setBusy(false);
    }
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
      const next = await documentRepository.updateDocAxiomsCollapsed({ docId, collapsed: nextValue, includeDoc: false });
      if (next) {
        setCurrentDoc((current) => (
          sameDocId(current?.doc?.id, docId)
            ? {
                ...current,
                doc: {
                  ...current.doc,
                  axioms_collapsed: next.doc?.axioms_collapsed ?? (nextValue ? 1 : 0),
                  updated_at: next.doc?.updated_at ?? current.doc?.updated_at
                }
              }
            : current
        ));
        setDocs(await documentRepository.listDocs());
      }
    } catch (error) {
      setAxiomsCollapsed(!nextValue);
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function openAxiomDialog(targetNodeId = null) {
    const docId = currentDoc?.doc?.id;
    if (!docId) return null;
    if (!treeEditMode) {
      setNotice('请先解锁编辑，再新增事实前提。');
      return null;
    }
    const target = targetNodeId ? findNode(currentDoc?.tree, targetNodeId) : null;
    if (axiomsCollapsed) setAxiomsCollapsed(false);
    const result = await runWrite(async () => {
      const result = await axiomRepository.addAxiom({ docId, content: '', status: 'pending' });
      const axiomId = result?.axiom?.id;
      if (target?.id && depthOf(target.address || '1') > 1 && axiomId) {
        await refRepository.addAxiomRefToNode({ docId, nodeId: target.id, axiomId });
      }
      if (axiomsCollapsed) {
        await documentRepository.updateDocAxiomsCollapsed({ docId, collapsed: false, includeDoc: false });
      }
      return result;
    });
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

  async function openAxiomRefDialog(targetNodeId, preferredAxiomId = null) {
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
    if (depthOf(target.address || '1') <= 1) {
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

  async function applyEditorHistoryEffect(effect, doc, options: any = {}) {
    const normalized = normalizeEditorHistoryEffect(effect);
    if (!normalized || !sameDocId(normalized.docId, doc?.doc?.id || currentDoc?.doc?.id)) return false;
    if (normalized.kind === 'expandNodeOne') {
      const requestedMinDepth = Math.max(
        Math.floor(Number(normalized.minDepth) || 0),
        Math.floor(Number(options.minDepth) || 0)
      );
      const maxDepth = fullDepthForDoc(doc || currentDoc);
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

  async function restoreEditorSnapshot(token, direction) {
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
      });
      const inverseToken = attachEditorHistoryViewState(result?.token, inverseViewState, targetEffect);
      if (direction === 'undo' && inverseToken) {
        updateUndoStack((stack) => stack.slice(0, -1));
        updateRedoStack((stack) => pushHistoryToken(stack, inverseToken));
      } else if (direction === 'redo' && inverseToken) {
        updateRedoStack((stack) => stack.slice(0, -1));
        updateUndoStack((stack) => pushHistoryToken(stack, inverseToken));
      }
      const nextDoc = await resolveWriteDoc(result, { minDepth: refreshDepth });
      if (nextDoc) {
        setCurrentDoc((current) => {
          const merged = mergeDocView(current, nextDoc);
          if (!merged || merged === nextDoc) return nextDoc;
          return { ...merged, flatTree: nextDoc.flatTree || null, treeIndex: nextDoc.treeIndex || null };
        });
        applyEditorHistoryViewState(targetViewState, nextDoc);
        if (direction === 'redo') await applyEditorHistoryEffect(targetEffect, nextDoc, { minDepth: refreshDepth });
      }
      setDocs(await documentRepository.listDocs());
      debugLog('editor.restore.end', {
        direction,
        ok: true,
        docId: targetDocId,
        targetDepthLimit,
        effectKind: targetEffect?.kind || null,
        effectMinDepth: targetEffectMinDepth,
        refreshDepth,
        loadedTreeDepth: loadedDepthForDoc(nextDoc),
        undoDepth: undoStackRef.current.length,
        redoDepth: redoStackRef.current.length
      });
      setNotice(direction === 'undo' ? '已撤销上一步编辑' : '已重做编辑');
    } catch (error) {
      debugLog('editor.restore.end', {
        direction,
        ok: false,
        docId: targetDocId,
        error: String(error?.message || error || '').slice(0, 240),
        undoDepth: undoStackRef.current.length,
        redoDepth: redoStackRef.current.length
      });
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function restoreEditBranchStep(direction) {
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
      const result = direction === 'undo'
        ? await documentRepository.undoEditBranch({ shadowDocId, owner: branchOwner, includeDoc: false })
        : await documentRepository.redoEditBranch({ shadowDocId, owner: branchOwner, includeDoc: false });
      syncEditBranchHistoryStacks(result?.branch || branch);
      const nextDoc = await loadDocForCurrentView(baseDocId, currentDoc);
      setCurrentDoc((current) => mergeDocView(current, nextDoc));
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
        error: String(error?.message || error || '').slice(0, 240),
        undoDepth: undoStackRef.current.length,
        redoDepth: redoStackRef.current.length
      });
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  // full agent 直写 base 后的紧邻回退窗口：编辑模式下栈顶若是 base 快照 token
  //（agent 改动后、下一次分支编辑前），undo/redo 优先恢复 base 快照而非分支条目。
  // 窗口由 syncEditBranchHistoryStacks 重建栈时连带 discard 自然关闭。
  function isEditorHistoryToken(entry) {
    return String(entry?.id || '').startsWith('editor-');
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

  async function createDoc(titleOverride = null, folderId = null) {
    const canLeave = await confirmLeaveEditMode();
    if (!canLeave) return;
    const title = typeof titleOverride === 'string' && titleOverride.trim()
      ? titleOverride.trim()
      : '未命名条件树文档';
    await withBusy(async () => {
      try {
        const doc = await documentRepository.createDoc({ title, rootText: title, folderId });
        setCurrentDoc(doc);
        persistActiveDocId(doc?.doc?.id);
        setSelectedNodeId(doc.tree.id);
        applyTreeViewState(doc);
        await refreshDocs(doc.doc.id);
      } catch (error) {
        setNotice(error.message);
      }
    });
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
    persistActiveDocId,
    setBusy,
    setNotice,
    setDocFolders,
    setDocs,
    setLibraryTree,
    setLibraryCutPath,
    setSelectedLibraryEntry,
    setCurrentDoc,
    setSelectedNodeId,
    setMultiSelectedNodeIds,
    setCollapsed,
    setExpanded,
    clearHistoryStacks,
    setSearchResults,
    setLocateRequest
  });

  function toggleOutlineNode(nodeId) {
    setCollapsedOutlineNodeIds((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      persistOutlineViewState(next);
      return next;
    });
  }

  async function confirmAxiomDialog(event) {
    event.preventDefault();
    if (!axiomDialog) return;
    const content = String(axiomDialog.content || '').trim();
    if (!content) {
      setNotice('事实前提内容不能为空。');
      return;
    }
    const docId = axiomDialog.docId;
    setAxiomDialog(null);
    await runWrite(() => axiomRepository.addAxiom({ docId, content, status: 'pending' }));
  }

  function cancelAxiomDialog() {
    setAxiomDialog(null);
  }

  async function confirmAxiomRefDialog(event) {
    event.preventDefault();
    if (!axiomRefDialog) return;
    const { docId, nodeId, axiomId } = axiomRefDialog;
    setAxiomRefDialog(null);
    await runWrite(() => refRepository.addAxiomRefToNode({ docId, nodeId, axiomId }));
  }

  function cancelAxiomRefDialog() {
    setAxiomRefDialog(null);
  }

  async function deleteDoc(doc) {
    const ok = window.confirm(`删除文档“${doc.title}”及其全部节点？`);
    if (!ok) return;
    setBusy(true);
    try {
      const nextDocs = await documentRepository.deleteDoc({ docId: doc.id });
      setDocs(nextDocs);
      if (currentDoc?.doc?.id === doc.id) {
        const nextDoc = nextDocs[0];
        if (nextDoc) {
          await openDoc(nextDoc.id);
        } else {
          setCurrentDoc(null);
          persistActiveDocId(null);
          setSelectedNodeId(null);
          setCollapsed(new Set());
          setExpanded(new Set());
        }
      }
      setNotice('已删除文档');
    } catch (error) {
      setNotice(error.message);
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

  async function openEditBranchDiff(option = null) {
    const branch = option?.branch || activeEditBranch();
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
      const view = await documentRepository.getEditBranchDiffView(payload);
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
        error: error.message || String(error)
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

  async function applyMergeResolutions(resolutions) {
    const ctx = mergeConflictDialog.ctx;
    if (!ctx) return;
    setMergeConflictDialog((current) => ({ ...current, applying: true, error: '' }));
    try {
      const result = await documentRepository.applyEditBranchMerge({
        shadowDocId: ctx.shadowDocId,
        owner: ctx.owner,
        includeDoc: false,
        resolutions
      });
      if (!result?.applied) {
        // 仍未应用（如结构冲突）→ 留面板，刷新冲突视图与 resolutionErrors。
        setMergeConflictDialog((current) => ({ ...current, applying: false, view: result, error: '' }));
        return;
      }
      setMergeConflictDialog({ open: false, applying: false, view: null, error: '', ctx: null });
      const nextDoc = await loadDocForCurrentView(result?.baseDocId || ctx.baseDocId, ctx.sourceDoc);
      switchDocPreservingView(nextDoc, ctx.sourceDoc, {
        editMode: false,
        persistedDocId: result?.baseDocId || ctx.baseDocId,
        noticeText: '已解决冲突并合并，退出编辑模式'
      });
      setDocs(await documentRepository.listDocs());
    } catch (error) {
      setMergeConflictDialog((current) => ({ ...current, applying: false, error: error.message || String(error) }));
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
      const nextDoc = await loadDocForCurrentView(ctx.baseDocId, ctx.sourceDoc);
      switchDocPreservingView(nextDoc, ctx.sourceDoc, {
        editMode: false,
        persistedDocId: ctx.baseDocId,
        noticeText: '已放弃本次编辑并退出'
      });
      setDocs(await documentRepository.listDocs());
    } catch (error) {
      setMergeConflictDialog((current) => ({ ...current, applying: false, error: error.message || String(error) }));
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

  async function saveAgentSettings(next) {
    await saveAgentSettingsAction({
      next,
      agentSettings,
      llmSummarySettings,
      setLlmSummarySettings,
      saveAgentSettingsCore
    });
  }

  async function runAgentRequest({ mode, prompt, modelOption, reasoningEffort }) {
    const text = String(prompt || '').trim();
    if (!text) return;
    const requestId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const startedAt = Date.now();
    let beforeFullAccessToken = null;
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
      });
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
              status: result?.canceled ? '已取消' : '完成',
              streaming: false
            }
          : message
      )));
      setAgentDiffs(Array.isArray(result?.diffs) ? result.diffs : []);
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
          const nextDoc = await loadDocForCurrentView(currentDoc.doc.id, currentDoc);
          setCurrentDoc((current) => mergeDocView(current, nextDoc));
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
              answer: error.message || 'Agent 调用失败',
              elapsedMs: Date.now() - startedAt,
              toolEvents: message.toolEvents || [],
              status: '失败',
              streaming: false,
              error: true
            }
          : message
      )));
      setNotice(error.message);
    } finally {
      if (activeAgentRequestIdRef.current === requestId) activeAgentRequestIdRef.current = null;
      setAgentBusy(false);
      refreshAgentSessions().catch((error) => setNotice(error.message));
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
      setNotice(error.message);
    }
  }

  async function applyAgentDiff(diffId, options: any = {}) {
    const pendingDiff = agentDiffs.find((diff) => Number(diff.id) === Number(diffId));
    if (!pendingDiff) return false;
    if (!options.skipEditModeCheck) {
      const ready = await ensureAgentApprovalEditMode();
      if (!ready) return false;
    }
    const target = { docId: pendingDiff.base_doc_id };
    let undoToken = null;
    try {
      if (target.docId && !treeEditMode) {
        undoToken = await captureEditorHistoryToken(target.docId);
      }
      const result = await agentRepository.applyDiff({ diffId });
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
      setAgentDiffs(Array.isArray(result?.diffs) ? result.diffs : []);
      const resultDocId = result?.docId || currentDoc?.doc?.id;
      if (treeEditMode && resultDocId) {
        const nextDoc = await loadDocForCurrentView(resultDocId, currentDoc);
        setCurrentDoc((current) => mergeDocView(current, nextDoc));
        syncEditBranchHistoryStacks(nextDoc?.editBranch || activeEditBranch());
      } else if (resultDocId) {
        await refreshDocs(resultDocId);
      }
      await refreshAgentSessions();
      return true;
    } catch (error) {
      if (undoToken) discardHistoryTokens([undoToken]);
      setNotice(error.message);
      return false;
    }
  }

  async function rejectAgentDiff(diffId) {
    try {
      const result = await agentRepository.rejectDiff({ diffId });
      setAgentDiffs(Array.isArray(result?.diffs) ? result.diffs : []);
      await refreshAgentSessions();
    } catch (error) {
      setNotice(error.message);
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
      setVectorSettings(await vectorService.chooseLocalModelRoot());
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function downloadVectorModel() {
    setBusy(true);
    try {
      const settings = await vectorService.downloadVectorModel();
      setVectorSettings(settings);
      setNotice(`已下载模型：${settings.downloadedModelPath || settings.localModelRoot}`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function importFiles(mode = 'simple') {
    const rawMode = String(mode || 'simple').trim();
    const importMode = ['simple', 'complete', 'direct', 'smart', 'vector'].includes(rawMode) ? rawMode : 'simple';
    if (importMode === 'smart') {
      setNotice('智能导入入口未接入');
      return;
    }
    if (importMode === 'vector') {
      setNotice('向量导入入口未接入');
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
      const imported = selectedLibraryEntry?.type === 'file' && importService.canImportLibraryDocument()
        ? await importService.importLibraryDocument({ relativePath: selectedLibraryEntry.relativePath, ...payload })
        : await importService.chooseImportFile(payload);
      if (imported?.length) {
        const last = imported[imported.length - 1];
        setOperationLock({ label: '正在打开文档……', step: 0, total: 0 });
        const opened = await loadCompleteDoc(last.doc.id, '正在打开文档……');
        setCurrentDoc(opened);
        setSelectedLibraryEntry(null);
        persistActiveDocId(opened?.doc?.id || last?.doc?.id);
        setSelectedNodeId(null);
        applyTreeViewState(opened);
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
      setNotice(error.message);
      setBusy(false);
      setProgress(null);
      setOperationLock(null);
    }
  }

  async function runVectorSearch() {
    if (!currentDoc || !searchQuery.trim()) return;
    if (vectorModuleDisabled) {
      setSearchResults([]);
      setNotice(vectorDisabledMessage);
      return;
    }
    setBusy(true);
    try {
      const results = await vectorService.searchContentByVector({
        docId: currentDoc.doc.id,
        query: searchQuery.trim(),
        limit: 20
      });
      setSearchResults(results);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function focusNodeInDoc(doc, node) {
    if (!doc?.tree || !node?.id) return false;
    const nodeAddress = String(node.address || '1');
    setSelectedNodeId(node.id);
    // 节点视图（树/IDE/富文本）内就地定位；仅从实体/搜索等非节点视图才切到树视图。
    if (activeTab !== 'tree' && activeTab !== 'ide' && activeTab !== 'rich') setActiveTab('tree');
    const baseState = normalizeDocId(doc?.doc?.id) === normalizeDocId(currentDoc?.doc?.id)
      ? { depthLimit, collapsed, expanded }
      : treeViewStateFromDoc(doc, fullDepthForDoc(doc));
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

  async function selectNodeAndOpenTree(nodeId, result: any = {}) {
    if (!nodeId) return;
    const address = String(result?.address || '').trim();
    // 先确保目标深度的数据已加载，再走统一就地定位（从搜索/实体这类非节点视图会切到树视图）。
    if (address) {
      const targetDepth = depthOf(address);
      if (loadedDepthForDoc(currentDoc) < targetDepth && currentDoc?.doc?.id) {
        try {
          await loadDocTreeDepth(targetDepth, currentDoc.doc.id);
        } catch (error) {
          setNotice(error.message);
        }
      }
    }
    const node = findNode(currentDoc?.tree, nodeId) || { id: nodeId, address: address || '1' };
    focusNodeInDoc(currentDoc, node);
  }

  function locateSelectedNode() {
    // 16-3：统一走就地定位，由当前视图自己滚动到目标，不强制切视图。
    focusNodeInDoc(currentDoc, selectedNode);
  }

  async function jumpToCurrentDocAddress(rawAddress) {
    const address = String(rawAddress || '').trim();
    if (!address) return { ok: false, message: '请输入节点地址。' };
    const docId = normalizeDocId(currentDoc?.doc?.id);
    if (!docId || !currentDoc?.tree) return { ok: false, message: '当前没有打开文档。' };
    let nodeId = currentDoc.idByAddress?.[address];
    let node = nodeId ? findNode(currentDoc.tree, nodeId) : null;
    if (!node && documentRepository.canRead()) {
      try { node = await documentRepository.getNode({ docId, address }); } catch {}
    }
    if (!node?.id) return { ok: false, message: `当前文档没有节点 ${address}。` };
    focusNodeInDoc(currentDoc, node);
    return { ok: true };
  }

  async function traceAgentDiff(branch) {
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
      setNotice(error.message);
    }
  }

  async function loadNodeChildren(nodeId, options: any = {}) {
    const docId = normalizeDocId(currentDoc?.doc?.id);
    const target = findNode(currentDoc?.tree, nodeId);
    if (!docId || !target) return null;
    const reset = options.reset === true;
    const offset = reset ? 0 : (target.children || []).length;
    const limit = options.limit || NODE_CHILDREN_PAGE_SIZE;
    const result = await documentRepository.getNodeChildren({ docId, parentId: nodeId, offset, limit });
    setCurrentDoc((current) => {
      if (!sameDocId(current?.doc?.id, docId)) return current;
      return {
        ...current,
        tree: mergeNodeChildrenIntoTree(current.tree, nodeId, result)
      };
    });
    return result;
  }

  async function ensureNodeChildren(nodeId, options = {}) {
    const node = findNode(currentDoc?.tree, nodeId);
    if (!node) return null;
    const knownChildCount = Number(node.childCount ?? 0) || 0;
    if ((node.children || []).length > 0 || knownChildCount <= 0) return node;
    await loadNodeChildren(nodeId, options);
    return findNode(currentDoc?.tree, nodeId) || node;
  }

  function treeActionNode(nodeId) {
    return findNode(currentDoc?.tree, nodeId) || currentDoc?.treeIndex?.nodeOf?.(nodeId) || null;
  }

  function treeActionHasChildren(node) {
    if (!node) return false;
    return hasKnownChildren(node) || Boolean(currentDoc?.treeIndex?.hasChildren?.(node.id));
  }

  function treeActionDescendants(node) {
    if (!node) return [];
    if (Array.isArray(node.children)) return flattenTree(node);
    return [node];
  }

  async function toggleCollapsed(nodeId, options: any = {}) {
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
      await loadNodeChildren(nodeId, { reset: true });
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

  async function expandNodeOneLevel(nodeId, options: any = {}) {
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
    await ensureNodeChildren(nodeId, { reset: true });
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
    const handleKeyDown = (event) => {
      if (isEditableTarget(event.target)) return;
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
    const blockWindowClose = (event) => {
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
    updateNode: (payload) => nodeRepository.updateNode(payload),
    createImageAsset: (payload) => assetRepository.createImageAsset(payload),
    deleteRef: (payload) => refRepository.deleteRef(payload),
    updateAxiom: (payload) => axiomRepository.updateAxiom(payload),
    restoreHistory: (payload) => historyRepository.restoreDocumentSnapshot(payload)
  }), []);
  const c2dNodeActions = useMemo(() => ({
    insertNode: (payload) => nodeRepository.insertNode(payload),
    updateNode: (payload) => nodeRepository.updateNode(payload),
    deleteNode: (payload) => nodeRepository.deleteNode(payload),
    moveNode: (payload) => nodeRepository.moveNode(payload),
    promoteNode: (payload) => nodeRepository.promoteNode(payload),
    splitNode: (payload) => nodeRepository.splitNode(payload),
    mergeNodeIntoTarget: (payload) => nodeRepository.mergeNodeIntoTarget(payload),
    moveNodeToParent: (payload) => nodeRepository.moveNodeToParent(payload),
    moveNodeAfterSibling: (payload) => nodeRepository.moveNodeAfterSibling(payload),
    updateAxiom: (payload) => axiomRepository.updateAxiom(payload),
    deleteAxiom: (payload) => axiomRepository.deleteAxiom(payload),
    moveAxiom: (payload) => axiomRepository.moveAxiom(payload)
  }), []);

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
        onPointerDown={(event) => startSidebarResize('left', event)}
      >
        {leftCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
      </button>
      <button
        type="button"
        className={`sidebar-rail sidebar-rail-right${rightCollapsed ? ' is-collapsed' : ''}${rightRailAnimate ? ' rail-animating' : ''}`}
        style={{ right: rightCollapsed ? 0 : rightWidth - 6 }}
        title={rightSidebarRailHint}
        aria-label={rightSidebarRailHint}
        onPointerDown={(event) => startSidebarResize('right', event)}
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
          onCreateFolder={createDocFolder}
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
          onPointerDown={startDocOutlineResize}
        />

        <OutlinePanel
          tree={currentDoc?.tree}
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
          activeTab={activeTab}
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
          onGenerateSummary={generateSummary}
          onRunSummaryGeneration={runSummaryGeneration}
          diffBranches={diffBranchOptions}
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
                  docId={currentDoc.doc.id}
                  rootNode={currentDoc.tree}
                  selectedNodeId={selectedNodeId}
                  setSelectedNodeId={setSelectedNodeId}
                  setMultiSelectedIds={setMultiSelectedNodeIds}
                  onRenderReady={handleMindMapRenderReady}
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
                  runWrite={runWrite}
                  nodeActions={c2dNodeActions}
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
                  axioms={currentDoc.axioms}
                  showTitles={viewShowTitles}
                  showNotes={viewShowNotes}
                  showAxioms={viewShowAxioms}
                  locateRequest={locateRequest}
                />
              </div>
              <div style={{ display: activeTab === 'rich' ? 'contents' : 'none' }}>
                <RichTextView
                  currentDoc={currentDoc}
                  docId={currentDoc.doc.id}
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
                  loadSourceWindow={loadSourceWindow}
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
                  results={searchResults}
                  onSearch={runVectorSearch}
                  selectNode={selectNodeAndOpenTree}
                  placeholder={vectorModuleDisabled ? '向量模块已由用户禁用' : '输入要检索的语义内容'}
                  disabled={vectorModuleDisabled}
                  disabledMessage={vectorDisabledMessage}
                />
              </div>
            </>
          ) : (
            <ViewAlignedEmptyState
              activeTab={activeTab}
              selectedLibraryEntry={selectedLibraryEntry}
              onImport={importFiles}
            />
          )}
        </div>
            </>
          )}
        </WorkspaceHeader>
      </section>

      <Inspector
        currentDoc={currentDoc}
        selectedNode={selectedNode}
        runWrite={runWrite}
        selectNode={selectNodeAndOpenTree}
        canEdit={treeEditMode}
        viewMode={activeTab}
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
        inspectorActions={inspectorActions}
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
          view={mergeConflictDialog.view}
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
                value={axiomRefDialog.axiomId}
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
                {axiomRefDialog.options.map((axiom) => (
                  <option key={axiom.id} value={axiom.id}>
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

      <ProgressOverlay progress={progress} lockedProgress={lockedProgress} locked={Boolean(operationLock)} onCancel={cancelSummaryGeneration} />
      </main>
    </>
  );
}
