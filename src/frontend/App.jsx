import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Settings
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { appendGeneratedNote, hasGeneratedNote, plainNodeNote } from '../core/node-notes.mjs';
import { buildNodeSentenceLabelMap } from '../core/source-ranges.mjs';
import { findNode, flattenTree } from '../core/tree.mjs';
import { summaryTargetsForMode as buildSummaryTargetsForMode } from '../core/tree-ui.mjs';
import { createGpuEmbeddingService } from '../vector/gpu-embedding-service.js';

import {
  depthOf, isFactAxiomRef, clampDepthLimit, normalizeNodeLayoutSettingsByView, fullDepthForDoc, loadedDepthForDoc, treeDocRequest, sameDocId, mergeDocView, docDepthStats,
  hasKnownChildren,
  idSetFromArray, treeViewStateFromDoc,
  normalizeFsPath, isSupportedLibraryImport, docSourcePath,
  docDisplayTitle, defaultCollapsedOutlineIds, visibleOutlineRows,
  outlineParentTrailRows, buildParagraphLabelMap, mergeNodeChildrenIntoTree, isEditableTarget,
  normalizeDocId, readPersistedActiveDocId, persistActiveDocId,
  readPersistedSummaryNotesVisible, persistSummaryNotesVisible,
  OUTLINE_ROW_HEIGHT, OUTLINE_VIRTUAL_OVERSCAN, NODE_CHILDREN_PAGE_SIZE,
  SOURCE_WINDOW_BEFORE_CHARS
} from './lib/doc-utils.mjs';
import {
  agentDiffTraceTarget, agentHistoryForRequest
} from './lib/agent-utils.mjs';
import { normalizeSummaryStrategy,
  normalizeSummaryConcurrency, normalizeSummaryStrategySettings, summaryStrategyForMode, applySummarySkipStrategy, summarySkipBelowCount
} from './lib/summary-utils.mjs';
import { buildFixedVirtualRange } from './lib/ui-utils.mjs';
import { debugLog, debugPerfBegin, debugPerfEnd, setDebugLoggingEnabled } from './lib/debug-log.mjs';
import { debugElementTarget, debugShouldLogKey } from './features/debug/ui-debug-actions.js';
import { createLibraryActions } from './features/library/library-actions.js';
import { openSettingsAction, saveAgentSettingsAction } from './features/settings/settings-actions.js';
import {
  appendEntityTerm,
  entityDragPayload,
  entityFromDragEvent,
  fetchEntityDetail,
  fetchEntityList,
  fetchEntityNodeSearch,
  openEntityMaintenanceAction
} from './features/entity/entity-actions.js';
import { ChoiceDialog, ViewAlignedEmptyState, WindowTitlebar } from './components/common.jsx';
import { C2DMapView } from './components/MindMapView.jsx';
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
import { DocBrowser } from './components/DocBrowser.jsx';
import { useScrollViewport } from './hooks/useScrollViewport.js';
import { useAppUI } from './hooks/useAppUI.js';
import { useEditorOps } from './hooks/useEditorOps.js';
import { useLayout } from './hooks/useLayout.js';
import { useNodeSelection } from './hooks/useNodeSelection.js';
import { useSettings } from './hooks/useSettings.js';
import { useAgentChat } from './hooks/useAgentChat.js';
import { useDocumentState } from './hooks/useDocumentState.js';
import { usePromptDialog } from './hooks/usePromptDialog.js';
import { useTreeViewState } from './hooks/useTreeViewState.js';
import { captureE2EWindow, closeWindow, getStartupOptions, onLibraryChanged, onProgress, reportStartupFailure, reportStartupSuccess, startupHeartbeat } from './data/iftree-api.js';
import { openEntityMaintenanceWindow } from './data/window-service.js';
import { readDatabase } from './data/database-client.js';
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
  summaryService,
  vectorService
} from './data/repositories.js';

// Keep these gates aligned with electron/main.mjs analyzeE2ECapture.
const E2E_PROBE_LIMIT = 30;
const E2E_TEXT_MIN_WIDTH = 8;
const E2E_TEXT_MIN_HEIGHT = 6;
const E2E_EDGE_MIN_WIDTH = 12;
const E2E_EDGE_MIN_HEIGHT = 6;
const ENTITY_NODE_SEARCH_PAGE_LIMIT = 100;
const EMPTY_ENTITY_NODE_PAGE = Object.freeze({
  total: 0,
  returned: 0,
  offset: 0,
  limit: ENTITY_NODE_SEARCH_PAGE_LIMIT,
  hasMore: false,
  truncated: false
});

function waitForPaintAfterUiUpdate() {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(resolve);
      });
    }, 0);
  });
}

function viewportRectPayload(rect) {
  return {
    x: Math.max(0, Number(rect?.left) || 0),
    y: Math.max(0, Number(rect?.top) || 0),
    width: Math.max(0, Number(rect?.width) || 0),
    height: Math.max(0, Number(rect?.height) || 0)
  };
}

function rectIntersectsViewport(rect, minWidth = 1, minHeight = 1) {
  if (!rect || rect.width < minWidth || rect.height < minHeight) return false;
  return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
}

function visibleElements(selector, minWidth = 1, minHeight = 1) {
  return Array.from(document.querySelectorAll(selector)).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rectIntersectsViewport(rect, minWidth, minHeight);
  });
}

function edgeProbeRect(edge, svgRect) {
  const pad = Math.ceil(E2E_EDGE_MIN_HEIGHT / 2);
  const dataLeft = Number(edge.dataset?.edgeLeft);
  const dataTop = Number(edge.dataset?.edgeTop);
  const dataWidth = Number(edge.dataset?.edgeWidth);
  const dataHeight = Number(edge.dataset?.edgeHeight);
  if ([dataLeft, dataTop, dataWidth, dataHeight].every(Number.isFinite)) {
    return {
      left: svgRect.left + dataLeft - pad,
      top: svgRect.top + dataTop - pad,
      right: svgRect.left + dataLeft + dataWidth + pad,
      bottom: svgRect.top + dataTop + dataHeight + pad,
      width: dataWidth + pad * 2,
      height: dataHeight + pad * 2
    };
  }
  const x1 = Number(edge.getAttribute('x1')) || 0;
  const y1 = Number(edge.getAttribute('y1')) || 0;
  const x2 = Number(edge.getAttribute('x2')) || 0;
  const y2 = Number(edge.getAttribute('y2')) || 0;
  return {
    left: svgRect.left + Math.min(x1, x2) - pad,
    top: svgRect.top + Math.min(y1, y2) - pad,
    right: svgRect.left + Math.max(x1, x2) + pad,
    bottom: svgRect.top + Math.max(y1, y2) + pad,
    width: Math.abs(x2 - x1) + pad * 2,
    height: Math.abs(y2 - y1) + pad * 2
  };
}

function collectStartupVisualProbe() {
  const cards = visibleElements('.c2d-node-card', E2E_TEXT_MIN_WIDTH, E2E_TEXT_MIN_WIDTH);
  const textProbeRects = cards
    .map((card) => card.querySelector('.c2d-node-title, .c2d-node-body, .c2d-node-note, .c2d-node-meta'))
    .filter(Boolean)
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rectIntersectsViewport(rect, E2E_TEXT_MIN_WIDTH, E2E_TEXT_MIN_HEIGHT))
    .slice(0, E2E_PROBE_LIMIT)
    .map(viewportRectPayload);

  const svg = document.querySelector('.c2d-connector-layer');
  const svgRect = svg?.getBoundingClientRect?.();
  const edgeProbeRects = svg && svgRect
    ? Array.from(svg.querySelectorAll('.c2d-connector-line'))
        .map((line) => edgeProbeRect(line, svgRect))
        .filter((rect) => rectIntersectsViewport(rect, E2E_EDGE_MIN_WIDTH, E2E_EDGE_MIN_HEIGHT))
        .slice(0, E2E_PROBE_LIMIT)
        .map(viewportRectPayload)
    : [];
  const hasText = cards.some((card) => String(card.textContent || '').trim().length > 0);
  const overlayClear = !document.querySelector('.operation-lock-overlay, .progress-overlay');
  return {
    visual: {
      visibleNodeCount: cards.length,
      visibleEdgeCount: edgeProbeRects.length,
      gpuCardCount: cards.length,
      gpuEdgeCount: edgeProbeRects.length,
      hasText,
      hasEdges: edgeProbeRects.length > 0,
      overlayClear
    },
    textProbeRects,
    edgeProbeRects
  };
}

async function moveStartupCameraProbe() {
  const surface = document.querySelector('.c2d-map-surface');
  if (!surface) return 0;
  const before = Number(surface.scrollLeft) || 0;
  const maxScroll = Math.max(0, Number(surface.scrollWidth) - Number(surface.clientWidth));
  if (maxScroll <= 0) return 0;
  surface.scrollLeft = before < maxScroll ? maxScroll : 0;
  surface.dispatchEvent(new Event('scroll', { bubbles: true }));
  await waitForPaintAfterUiUpdate();
  return Math.abs((Number(surface.scrollLeft) || 0) - before);
}

function keywordRowToSearchResult(row) {
  const node = row?.node || row || {};
  return {
    node_id: node.id,
    doc_id: node.docId ?? row?.doc?.docId ?? null,
    address: node.address || null,
    text: node.textPreview || node.text || node.title || '',
    score: Number(node.score) || 0
  };
}

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
  const treeView = useTreeViewState({ currentDoc, setCurrentDoc, setNotice });
  const {
    depthLimit, axiomsCollapsed, collapsed, expanded, collapsedOutlineNodeIds,
    setDepthLimit, setAxiomsCollapsed, setCollapsed, setExpanded, setCollapsedOutlineNodeIds, outlineCollapseDocRef,
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
  const [c2dDepthControlSeq, setC2dDepthControlSeq] = useState(0);
  const [c2dDepthControlAction, setC2dDepthControlAction] = useState('setDepth');
  const [summaryNotesVisible, setSummaryNotesVisible] = useState(true);
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
    vectorSettings, llmSummarySettings, nodeLayoutSettings,
    setVectorSettings, setLlmSummarySettings, setNodeLayoutSettings, saveVectorSettings, saveLlmSummarySettings, saveNodeLayoutSettings
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
  const [entityQuery, setEntityQuery] = useState('');
  const [entityRows, setEntityRows] = useState([]);
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [entityDetail, setEntityDetail] = useState(null);
  const [entityNodeQuery, setEntityNodeQuery] = useState('');
  const [entityNodeMatchMode, setEntityNodeMatchMode] = useState('and');
  const [entityNodeResults, setEntityNodeResults] = useState([]);
  const [entityNodeGroups, setEntityNodeGroups] = useState([]);
  const [entityNodePage, setEntityNodePage] = useState(EMPTY_ENTITY_NODE_PAGE);
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

  useEffect(() => {
    setEntityQuery('');
    setEntityRows([]);
    setSelectedEntity(null);
    setEntityDetail(null);
    setEntityNodeQuery('');
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }, [currentDoc?.doc?.id]);

  useEffect(() => {
    const docId = currentDoc?.doc?.id;
    if (activeTab !== 'entity' || !docId) return undefined;
    let alive = true;
    fetchEntityList({ readDatabase, docId, query: '', limit: 100 })
      .then((result) => {
        if (alive) setEntityRows(result?.rows || []);
      })
      .catch((error) => {
        if (alive) setNotice(error.message);
      });
    return () => {
      alive = false;
    };
  }, [activeTab, currentDoc?.doc?.id, setNotice]);

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
  const visibleOutline = useMemo(
    () => visibleOutlineRows(currentDoc?.tree, collapsedOutlineNodeIds),
    [currentDoc?.tree, collapsedOutlineNodeIds]
  );
  const visibleOutlineById = useMemo(() => (
    new Map(visibleOutline.map((node) => [node.id, node]))
  ), [visibleOutline]);
  const visibleOutlineIndexById = useMemo(() => (
    new Map(visibleOutline.map((node, index) => [node.id, index]))
  ), [visibleOutline]);
  const {
    scrollRef: outlineScrollRef,
    viewport: outlineViewport,
    onScroll: handleOutlineScroll
  } = useScrollViewport();
  const outlineVirtual = useMemo(() => (
    buildFixedVirtualRange(
      visibleOutline.length,
      OUTLINE_ROW_HEIGHT,
      outlineViewport.scrollTop,
      outlineViewport.height,
      OUTLINE_VIRTUAL_OVERSCAN
    )
  ), [visibleOutline.length, outlineViewport.scrollTop, outlineViewport.height]);
  const renderedOutline = visibleOutline.slice(outlineVirtual.start, outlineVirtual.end);
  const outlineAnchorIndex = Math.max(0, Math.floor((Number(outlineViewport.scrollTop) || 0) / OUTLINE_ROW_HEIGHT));
  const outlineParentTrail = useMemo(
    () => outlineParentTrailRows(visibleOutline, outlineAnchorIndex, visibleOutlineById),
    [visibleOutline, outlineAnchorIndex, visibleOutlineById]
  );
  const outlineStickyRows = useMemo(() => (
    outlineParentTrail.filter((node) => (visibleOutlineIndexById.get(node.id) ?? Infinity) < outlineAnchorIndex)
  ), [outlineParentTrail, visibleOutlineIndexById, outlineAnchorIndex]);
  const outlineTopSpacer = Math.max(0, outlineVirtual.top - outlineStickyRows.length * OUTLINE_ROW_HEIGHT);
  const treeDepthStats = useMemo(() => docDepthStats(currentDoc), [currentDoc?.doc?.id, currentDoc?.tree, currentDoc?.treeDepthStats]);
  const actualMaxDepth = treeDepthStats.maxDepth;
  const visibleNodeCount = Number(currentDoc?.doc?.node_count) > 0
    ? Number(currentDoc.doc.node_count)
    : Number(currentDoc?.nodes?.length || 0);
  const depthOptions = useMemo(() => (
    [...new Set((treeDepthStats.depths.length > 0
      ? treeDepthStats.depths
      : Array.from({ length: actualMaxDepth }, (_, index) => index + 1))
      .map((depth) => Math.floor(Number(depth) || 0))
      .filter((depth) => depth > 0 && depth <= actualMaxDepth))]
      .sort((left, right) => left - right)
  ), [actualMaxDepth, treeDepthStats]);
  const visibleDepthLimit = depthLimit;
  const visibleDepthOptions = depthOptions;
  const startupSuccessReportedRef = useRef(false);
  const startupPendingDocRef = useRef(null);
  const startupOptionsRef = useRef({ startupDocId: null, renderMode: 'hardware', e2eChm: false, forceHardwareAcceleration: false, debugLogging: false });
  const renderReadyLogSignatureRef = useRef('');
  const renderUnlockPendingRef = useRef(null);
  const e2eDragRequestedRef = useRef(false);
  const closeAfterEditModeSaveRef = useRef(false);
  const summaryRunRef = useRef(null);
  const sendStartupHeartbeat = useCallback((stage, extra = {}) => {
    startupHeartbeat({
      ...extra,
      stage,
      docId: extra.docId ?? currentDoc?.doc?.id ?? null,
      nodeCount: extra.nodeCount ?? currentDoc?.doc?.node_count ?? null,
      progress: extra.progress || null
    });
  }, [currentDoc?.doc?.id, currentDoc?.doc?.node_count]);
  const completeStartup = useCallback((payload = {}) => {
    if (startupSuccessReportedRef.current) return;
    startupSuccessReportedRef.current = true;
    startupPendingDocRef.current = null;
    renderUnlockPendingRef.current = null;
    debugLog('frontend.startup.complete', payload);
    reportStartupSuccess(payload).catch(() => {});
  }, []);
  const failStartup = useCallback((error, payload = {}) => {
    if (startupSuccessReportedRef.current) return;
    startupSuccessReportedRef.current = true;
    startupPendingDocRef.current = null;
    renderUnlockPendingRef.current = null;
    debugLog('frontend.startup.failure', {
      ...payload,
      error: error?.message || String(error || 'startup-failure')
    });
    reportStartupFailure({
      message: error?.message || String(error || '启动失败'),
      stage: payload.stage || 'startup-failure',
      docId: payload.docId ?? null,
      nodeCount: payload.nodeCount ?? null,
      progress: payload.progress || null
    }).catch(() => {});
  }, []);
  const armRenderUnlock = useCallback((docId, reason = 'open-doc') => {
    const normalizedDocId = normalizeDocId(docId);
    if (!normalizedDocId || activeTab !== 'tree') return false;
    renderUnlockPendingRef.current = { docId: normalizedDocId, reason };
    return true;
  }, [activeTab]);
  const releaseRenderUnlock = useCallback((docId) => {
    const pending = renderUnlockPendingRef.current;
    if (!pending || !sameDocId(docId, pending.docId)) return false;
    renderUnlockPendingRef.current = null;
    setProgress(null);
    setOperationLock(null);
    return true;
  }, [setOperationLock, setProgress]);
  const runStartupE2ECheck = useCallback(async (info = {}, pending = {}) => {
    if (e2eDragRequestedRef.current) return;
    e2eDragRequestedRef.current = true;
    const reportDocId = pending.reportDocId || pending.docId;
    sendStartupHeartbeat('e2e-render-complete-start-drag', {
      docId: reportDocId,
      nodeCount: pending.nodeCount,
      renderBackend: info.renderBackend || null,
      e2e: { phase: 'drag-probe-start' }
    });
    const cameraDeltaX = await moveStartupCameraProbe();
    const { visual, textProbeRects, edgeProbeRects } = collectStartupVisualProbe();
    const screenshot = await captureE2EWindow({ textProbeRects, edgeProbeRects });
    const ok = Boolean(
      visual.visibleNodeCount > 1 &&
      visual.gpuCardCount > 1 &&
      visual.gpuEdgeCount > 0 &&
      visual.hasText &&
      visual.hasEdges &&
      visual.overlayClear &&
      screenshot?.ok === true &&
      cameraDeltaX > 0
    );
    completeStartup({
      stage: 'e2e-drag-fps-complete',
      docId: reportDocId,
      nodeCount: pending.nodeCount,
      renderBackend: info.renderBackend || null,
      e2e: {
        ok,
        avgFps: null,
        minFps: null,
        cameraDeltaX,
        visual,
        screenshot
      }
    });
  }, [completeStartup, sendStartupHeartbeat]);
  const handleMindMapRenderReady = useCallback((info = {}) => {
    const pending = startupPendingDocRef.current;
    const visual = info.visual || {};
    const signature = [
      info.docId ?? '',
      info.renderBackend || '',
      Number(info.nodeCount) || 0,
      Number(visual.visibleNodeCount) || 0,
      Number(visual.visibleEdgeCount) || 0
    ].join('|');
    if (renderReadyLogSignatureRef.current !== signature) {
      renderReadyLogSignatureRef.current = signature;
      debugLog('frontend.render.ready', {
        ...info,
        pendingDocId: pending?.docId ?? null,
        pendingNodeCount: pending?.nodeCount ?? null
      });
    }
    releaseRenderUnlock(info.docId);
    if (!pending || !sameDocId(info.docId, pending.docId)) return;
    (async () => {
      await waitForPaintAfterUiUpdate();
      const reportDocId = pending.reportDocId || pending.docId;
      if (startupOptionsRef.current.e2eChm) {
        await runStartupE2ECheck(info, pending);
        return;
      }
      completeStartup({
        stage: 'active-doc-rendered',
        docId: reportDocId,
        nodeCount: pending.nodeCount,
        renderBackend: info.renderBackend || null
      });
    })().catch((error) => {
      failStartup(error, {
        stage: 'startup-render-ready-failed',
        docId: pending.reportDocId || pending.docId,
        nodeCount: pending.nodeCount
      });
    });
  }, [completeStartup, failStartup, releaseRenderUnlock, runStartupE2ECheck]);
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
  const currentDocHasSummaryNotes = useMemo(() => (
    flattenTree(currentDoc?.tree).some((node) => plainNodeNote(node?.note || '').trim())
  ), [currentDoc?.tree]);

  useEffect(() => {
    setSummaryNotesVisible(readPersistedSummaryNotesVisible(currentDoc?.doc?.id));
  }, [currentDoc?.doc?.id]);

  function toggleSummaryNotesVisible() {
    if (!currentDocHasSummaryNotes) {
      setNotice('请先生成摘要');
      return;
    }
    const next = !summaryNotesVisible;
    setSummaryNotesVisible(next);
    persistSummaryNotesVisible(currentDoc?.doc?.id, next);
  }

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

  function nodesForIdMapping(doc) {
    return Array.isArray(doc?.flatTree) && doc.flatTree.length > 0
      ? doc.flatTree
      : flattenTree(doc?.tree);
  }

  function nodeAddressByIdMap(doc) {
    const map = new Map();
    for (const node of nodesForIdMapping(doc)) {
      const id = normalizeDocId(node?.id);
      if (id && node?.address) map.set(String(id), String(node.address));
    }
    return map;
  }

  function nodeIdByAddressMap(doc) {
    const map = new Map();
    if (doc?.idByAddress && typeof doc.idByAddress === 'object') {
      for (const [address, id] of Object.entries(doc.idByAddress)) {
        const normalizedId = normalizeDocId(id);
        if (address && normalizedId) map.set(String(address), normalizedId);
      }
    }
    for (const node of nodesForIdMapping(doc)) {
      const id = normalizeDocId(node?.id);
      if (id && node?.address) map.set(String(node.address), id);
    }
    return map;
  }

  function axiomLabelByIdMap(doc) {
    return new Map((doc?.axioms || [])
      .map((axiom) => [String(normalizeDocId(axiom?.id)), String(axiom?.label || '')])
      .filter(([, label]) => label));
  }

  function axiomIdByLabelMap(doc) {
    return new Map((doc?.axioms || [])
      .map((axiom) => [String(axiom?.label || ''), normalizeDocId(axiom?.id)])
      .filter(([label, id]) => label && id));
  }

  function remapNodeIdByAddress(sourceDoc, targetDoc, value) {
    if (!value) return value;
    const raw = String(value);
    if (raw.startsWith('axiom:')) {
      const label = axiomLabelByIdMap(sourceDoc).get(raw.slice('axiom:'.length));
      const mappedAxiomId = label ? axiomIdByLabelMap(targetDoc).get(label) : null;
      return mappedAxiomId ? `axiom:${mappedAxiomId}` : value;
    }
    const sourceAddress = nodeAddressByIdMap(sourceDoc).get(String(normalizeDocId(value)));
    if (!sourceAddress) return value;
    return nodeIdByAddressMap(targetDoc).get(sourceAddress) || value;
  }

  function remapNodeIdSetByAddress(sourceDoc, targetDoc, ids) {
    const next = new Set();
    for (const id of ids || []) {
      const mapped = remapNodeIdByAddress(sourceDoc, targetDoc, id);
      const normalized = normalizeDocId(mapped);
      if (normalized) next.add(normalized);
    }
    return next;
  }

  async function loadDocForCurrentView(docId, sourceDoc = currentDoc) {
    const depth = Math.max(loadedDepthForDoc(sourceDoc), depthLimit, 1);
    return documentRepository.getDoc(treeDocRequest(docId, depth));
  }

  function switchDocPreservingView(nextDoc, sourceDoc, { editMode, persistedDocId, noticeText } = {}) {
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
    else {
      updateUndoStack([]);
      updateRedoStack([]);
    }
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
    updateUndoStack([]);
    updateRedoStack([]);
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
    if (targetDocId && (sameDocId(targetDocId, baseDocId) || sameDocId(targetDocId, shadowDocId))) return true;
    const choice = await promptEditExitChoice();
    if (choice !== 'save' && choice !== 'discard') return false;
    setBusy(true);
    try {
      const sourceDoc = currentDoc;
      if (choice === 'discard') {
        // Tell the backend to skip the post-discard refreshDoc so this stays a
        // pure entries-delete; we re-fetch ourselves with the depth the view
        // actually needs.
        await documentRepository.discardEditBranch({ shadowDocId, owner: 'human', includeDoc: false });
        const nextDoc = await loadDocForCurrentView(baseDocId, sourceDoc);
        switchDocPreservingView(nextDoc, sourceDoc, {
          editMode: false,
          persistedDocId: baseDocId,
          noticeText: '已丢弃本次编辑并退出'
        });
        setDocs(await documentRepository.listDocs());
        return true;
      }
      const result = await documentRepository.saveEditBranch({ shadowDocId, owner: 'human', includeDoc: false });
      if (result?.changed) {
        const nextDoc = await loadDocForCurrentView(result?.baseDocId || baseDocId, sourceDoc);
        switchDocPreservingView(nextDoc, sourceDoc, {
          editMode: false,
          persistedDocId: result?.baseDocId || baseDocId,
          noticeText: '已保存当前编辑状态并退出编辑模式'
        });
        setDocs(await documentRepository.listDocs());
      } else {
        setCurrentDoc((current) => (
          current?.doc?.id === sourceDoc?.doc?.id ? { ...current, editBranch: null } : current
        ));
        updateUndoStack([]);
        updateRedoStack([]);
        setNotice('已退出编辑模式');
      }
      return true;
    } catch (error) {
      if (/Edit branch not found/i.test(String(error?.message || error))) {
        try {
          const nextDoc = await loadDocForCurrentView(baseDocId, currentDoc);
          switchDocPreservingView(nextDoc, currentDoc, {
            editMode: false,
            persistedDocId: baseDocId,
            noticeText: '编辑状态已不存在，已退出编辑模式'
          });
          setDocs(await documentRepository.listDocs());
        } catch (refreshError) {
          clearEditModeState(`编辑状态已不存在，已退出编辑模式；刷新失败：${refreshError.message}`);
        }
        return true;
      }
      setNotice(error.message);
      return false;
    } finally {
      setBusy(false);
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

  async function refreshDocs(nextDocId = currentVisualDocId, options = {}) {
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
        setSelectedNodeId((existing) => existing || doc?.tree?.id || null);
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

  async function openDoc(docId, options = {}) {
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
      setSelectedNodeId(doc?.tree?.id || null);
      setMultiSelectedNodeIds(new Set());
      applyTreeViewState(doc);
      if (openedBranch) syncEditBranchHistoryStacks(openedBranch);
      else {
        updateUndoStack([]);
        updateRedoStack([]);
      }
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
      setSelectedNodeId(doc?.tree?.id || null);
      setMultiSelectedNodeIds(new Set());
      applyTreeViewState(doc);
      updateUndoStack([]);
      updateRedoStack([]);
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
    let alive = true;
    startupHeartbeat({ stage: 'renderer-mounted' });
    const heartbeatTimer = window.setInterval(() => {
      startupHeartbeat({ stage: 'renderer-alive' });
    }, 1000);
    const rendererErrorPayload = (error, extra = {}) => ({
      message: String(error?.message || error || '').slice(0, 240),
      stack: String(error?.stack || '').slice(0, 800),
      lastUiAction: lastUiActionRef.current,
      ...extra
    });
    const reportWindowError = (event) => {
      const error = event?.error || event?.message || 'renderer-error';
      debugLog('renderer.window.error', rendererErrorPayload(error, {
        sourceId: String(event?.filename || '').slice(0, 200),
        lineNumber: event?.lineno ?? null,
        columnNumber: event?.colno ?? null
      }));
      failStartup(error, { stage: 'renderer-error' });
    };
    const reportUnhandledRejection = (event) => {
      const reason = event?.reason || 'renderer-unhandled-rejection';
      debugLog('renderer.window.unhandledrejection', rendererErrorPayload(reason));
      failStartup(reason, { stage: 'renderer-unhandled-rejection' });
    };
    window.addEventListener('error', reportWindowError);
    window.addEventListener('unhandledrejection', reportUnhandledRejection);
    startupHeartbeat({ stage: 'startup-list-db-docs' });
    documentRepository.listDocFolders()
      .then((folders) => { if (alive) setDocFolders(Array.isArray(folders) ? folders : []); })
      .catch((error) => { if (alive) setNotice(error.message); });
    documentRepository.readLibraryTree()
      .then((tree) => { if (alive && tree) setLibraryTree(tree); })
      .catch((error) => { if (alive) setNotice(error.message); });
    Promise.all([
      documentRepository.listDocs(),
      getStartupOptions().catch(() => ({ startupDocId: null, renderMode: 'hardware', e2eChm: false, debugLogging: false })),
      documentRepository.getPendingEditBranches({ owner: 'human' }).catch(() => ({ branches: [] }))
    ]).then(async ([list = [], startupOptions = {}, pendingEdit = {}]) => {
      const docsList = Array.isArray(list) ? list : [];
      setDocs(docsList);
      startupOptionsRef.current = {
        startupDocId: startupOptions.startupDocId || null,
        renderMode: startupOptions.renderMode === 'compatible' ? 'compatible' : 'hardware',
        e2eChm: startupOptions.e2eChm === true,
        forceHardwareAcceleration: startupOptions.forceHardwareAcceleration === true,
        debugLogging: startupOptions.debugLogging === true
      };
      setDebugLoggingEnabled(startupOptionsRef.current.debugLogging);
      const requestedDocId = startupOptionsRef.current.startupDocId || readPersistedActiveDocId();
      startupHeartbeat({
        stage: 'startup-db-docs-ready',
        docId: requestedDocId || null,
        progress: {
          label: '数据库文档列表读取完成',
          step: docsList.length,
          total: docsList.length
        }
      });
      const persistedDoc = requestedDocId
        ? docsList.find((doc) => normalizeDocId(doc.id) === normalizeDocId(requestedDocId))
        : null;
      const pendingBranches = Array.isArray(pendingEdit?.branches) ? pendingEdit.branches : [];
      debugLog('frontend.startup.options', {
        ...startupOptionsRef.current,
        requestedDocId,
        docCount: docsList.length,
        pendingBranchCount: pendingBranches.length
      });
      const pendingBranch = pendingBranches.find((branch) => (
        !requestedDocId ||
        sameDocId(branch.base_doc_id, requestedDocId) ||
        sameDocId(branch.shadow_doc_id, requestedDocId)
      )) || null;
      const pendingBranchChoice = pendingBranch
        ? await promptStartupEditBranchChoice(pendingBranch)
        : null;
      if (!alive) return;
      const pendingBaseDoc = pendingBranch
        ? (docsList.find((doc) => sameDocId(doc.id, pendingBranch.base_doc_id)) || {
            id: pendingBranch.base_doc_id,
            node_count: pendingBranch.node_count
          })
        : null;
      if (pendingBranch && pendingBranchChoice === 'discard') {
        try {
          await documentRepository.discardEditBranch({
            branchId: pendingBranch.id,
            owner: pendingBranch.owner || 'human',
            includeDoc: false
          });
        } catch (error) {
          setNotice(error.message);
          failStartup(error, { stage: 'startup-discard-edit-branch-failed' });
          return;
        }
      }
      const openTargetDocId = pendingBranchChoice === 'restore'
        ? pendingBranch.shadow_doc_id
        : (pendingBranch ? pendingBranch.base_doc_id : persistedDoc?.id);
      const openBaseDoc = pendingBranchChoice === 'restore'
        ? pendingBaseDoc
        : (pendingBranch ? pendingBaseDoc : persistedDoc);
      if (!openTargetDocId && requestedDocId && pendingBranchChoice !== 'restore') {
        if (startupOptionsRef.current.startupDocId) {
          failStartup(new Error(`启动指定文档不存在：${requestedDocId}`), {
            stage: 'startup-doc-not-found',
            docId: requestedDocId
          });
          return;
        }
        persistActiveDocId(null);
      }
      if (!alive || startupOpenRequestedRef.current) return;
      if (!openTargetDocId) {
        debugLog('frontend.startup.open.skip', {
          reason: 'no-open-target',
          requestedDocId,
          docCount: docsList.length
        });
        completeStartup({ stage: 'empty-main-ui' });
        return;
      }
      e2eDragRequestedRef.current = false;
      startupOpenRequestedRef.current = true;
      window.setTimeout(() => {
        if (!alive) return;
        const openStartupDoc = (targetDocId, baseDoc, choice) => {
          const pendingNodeCount = baseDoc?.node_count ?? baseDoc?.nodeCount ?? pendingBranch?.node_count ?? 0;
          startupPendingDocRef.current = {
            docId: targetDocId,
            nodeCount: pendingNodeCount
          };
          debugLog('frontend.startup.open.start', {
            docId: targetDocId,
            nodeCount: pendingNodeCount,
            pendingBranchChoice: choice
          });
          startupHeartbeat({
            stage: 'startup-open-active-doc',
            docId: targetDocId,
            nodeCount: pendingNodeCount
          });
          openDoc(targetDocId, {
            includeEditBranch: pendingBranch ? choice === 'restore' : undefined,
            onComplete(doc) {
              const renderDocId = doc?.doc?.id || targetDocId;
              const docId = editBranchBaseDocId(doc?.editBranch) || renderDocId;
              const nodeCount = doc?.doc?.node_count ?? baseDoc?.node_count ?? baseDoc?.nodeCount ?? 0;
              debugLog('frontend.startup.open.complete', {
                docId,
                renderDocId,
                nodeCount,
                hasTree: Boolean(doc?.tree),
                flatTree: Boolean(doc?.flatTree)
              });
              persistActiveDocId(docId);
              if (!startupSuccessReportedRef.current) {
                startupPendingDocRef.current = { docId: renderDocId, reportDocId: docId, nodeCount };
                if (!e2eDragRequestedRef.current) {
                  startupHeartbeat({
                    stage: 'startup-waiting-first-render',
                    docId,
                    nodeCount
                  });
                }
              }
            }
          }).catch((error) => {
            if (!alive) return;
            if (choice === 'restore' && pendingBranch?.base_doc_id && !sameDocId(targetDocId, pendingBranch.base_doc_id)) {
              setNotice(`恢复编辑状态失败，已暂存：${error.message}`);
              debugLog('frontend.startup.restore.fallback-stash', {
                shadowDocId: targetDocId,
                baseDocId: pendingBranch.base_doc_id,
                error: error?.message || String(error || 'open-doc-failed')
              });
              openStartupDoc(pendingBranch.base_doc_id, pendingBaseDoc, 'stash');
              return;
            }
            setNotice(error.message);
            debugLog('frontend.startup.open.failure', {
              docId: targetDocId,
              nodeCount: baseDoc?.node_count ?? baseDoc?.nodeCount ?? null,
              error: error?.message || String(error || 'open-doc-failed')
            });
            failStartup(error, {
              stage: 'startup-open-active-doc-failed',
              docId: targetDocId,
              nodeCount: baseDoc?.node_count ?? baseDoc?.nodeCount ?? null
            });
          });
        };
        openStartupDoc(openTargetDocId, openBaseDoc, pendingBranchChoice || 'open');
      }, 0);
    }).catch((error) => {
      if (alive) {
        setNotice(error.message);
        failStartup(error, { stage: 'startup-list-docs-failed' });
      }
    });
    settingsRepository.readVectorSettings()
      .then((settings) => setVectorSettings(settings || { enabled: true, disabledReason: '' }))
      .catch((error) => {
        if (alive) setNotice(error.message);
      });
    settingsRepository.readLlmSummarySettings()
      .then((settings) => setLlmSummarySettings(settings || null))
      .catch((error) => setNotice(error.message));
    settingsRepository.readAgentSettings()
      .then((settings) => setAgentSettings(settings || null))
      .catch((error) => setNotice(error.message));
    const agentTimer = window.setTimeout(() => {
      agentRepository.listDiffs()
        .then((diffs) => setAgentDiffs(Array.isArray(diffs) ? diffs : []))
        .catch((error) => setNotice(error.message));
      refreshAgentSessions().catch((error) => setNotice(error.message));
    }, 300);
    settingsRepository.readNodeLayoutSettings()
      .then((settings) => setNodeLayoutSettings(normalizeNodeLayoutSettingsByView(settings)))
      .catch((error) => setNotice(error.message));
    return () => {
      alive = false;
      window.clearInterval(heartbeatTimer);
      window.clearTimeout(agentTimer);
      window.removeEventListener('error', reportWindowError);
      window.removeEventListener('unhandledrejection', reportUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    return onProgress((data) => {
      setProgress(data.done ? null : data);
    });
  }, []);

  useEffect(() => {
    const data = lockedProgress || progress;
    if (!data) return;
    sendStartupHeartbeat(String(data.label || 'startup-progress'), { progress: data });
  }, [lockedProgress, progress, sendStartupHeartbeat]);

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
    setDepthLimit((value) => clampDepthLimit(value, actualMaxDepth));
  }, [actualMaxDepth, currentDoc?.tree]);

  async function resolveVisibleDepth(nextValue) {
    const requestedDepth = Math.max(1, Math.floor(Number(nextValue) || 1));
    return clampDepthLimit(requestedDepth, actualMaxDepth);
  }

  async function setVisibleDepth(nextValue, { clearAll = false, restoreLocalFirst = false, action = 'setDepth' } = {}) {
    try {
      const hasLocalTreeState = !clearAll && (collapsed.size > 0 || expanded.size > 0);
      if (restoreLocalFirst && hasLocalTreeState) {
        setPersistedTreeView(depthLimit, new Set(), new Set());
        return;
      }
      const nextDepth = await resolveVisibleDepth(nextValue);
      if (!nextDepth) {
        if (hasLocalTreeState) setPersistedTreeView(depthLimit, new Set(), new Set());
        return;
      }
      const nextExpanded = new Set();
      const nextCollapsed = new Set();
      applyVisibleTreeDepth(nextDepth, nextCollapsed, nextExpanded, action).catch((error) => {
        setNotice(error.message);
        setProgress(null);
        setOperationLock(null);
      });
    } catch (error) {
      setNotice(error.message);
      setProgress(null);
      setOperationLock(null);
    }
  }

  async function applyVisibleTreeDepth(nextDepth, nextCollapsed, nextExpanded, action = 'setDepth') {
    const unlockOnDone = () => {
      setProgress(null);
      setOperationLock(null);
    };
    try {
      const doc = await loadDocTreeDepth(nextDepth);
      const resolvedDoc = sameDocId(doc?.doc?.id, currentDoc?.doc?.id)
        ? {
            ...currentDoc,
            ...doc,
            tree: loadedDepthForDoc(doc) >= loadedDepthForDoc(currentDoc) ? doc?.tree : currentDoc?.tree,
            nodes: doc?.nodes?.length ? doc.nodes : currentDoc?.nodes
          }
        : (doc || currentDoc);
      if (resolvedDoc) setCurrentDoc(resolvedDoc);
      setPersistedTreeView(nextDepth, nextCollapsed, nextExpanded);
      setC2dDepthControlAction(action || 'setDepth');
      setC2dDepthControlSeq((seq) => seq + 1);
      unlockOnDone();
    } catch (error) {
      unlockOnDone();
      throw error;
    }
  }

  function collapseVisibleDepthOne() {
    setVisibleDepth(depthLimit - 1, { clearAll: true, action: 'collapseOne' });
  }

  const syncC2dVisibleDepth = useCallback((nextDepth) => {
    const resolvedDepth = clampDepthLimit(nextDepth, actualMaxDepth);
    setDepthLimit((current) => (current === resolvedDepth ? current : resolvedDepth));
  }, [actualMaxDepth, setDepthLimit]);

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

  function patchNodeInTree(root, row) {
    if (!root || !row?.id) return root;
    // Use string comparison so tmp ids ("tmp-node-…") in lazy edit branches
    // patch correctly alongside numeric base ids.
    if (String(root.id) === String(row.id)) {
      return { ...root, ...row, children: root.children || row.children || [] };
    }
    if (!Array.isArray(root.children) || root.children.length === 0) return root;
    let changed = false;
    const children = root.children.map((child) => {
      const next = patchNodeInTree(child, row);
      if (next !== child) changed = true;
      return next;
    });
    return changed ? { ...root, children } : root;
  }

  function patchNodeInDoc(doc, row) {
    if (!doc || !row?.id) return doc;
    return {
      ...doc,
      tree: patchNodeInTree(doc.tree, row),
      nodes: Array.isArray(doc.nodes)
        ? doc.nodes.map((node) => (String(node.id) === String(row.id) ? { ...node, ...row } : node))
        : doc.nodes
    };
  }

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

  async function resolveWriteDoc(result, options = {}) {
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

  function tokenIds(tokens) {
    return (Array.isArray(tokens) ? tokens : [])
      .map((token) => normalizeHistoryToken(token)?.id)
      .filter(Boolean);
  }

  function discardHistoryTokens(tokens) {
    const ids = tokenIds(tokens);
    if (ids.length === 0) return;
    historyRepository.discardEditorHistoryTokens({ tokenIds: ids }).catch((error) => setNotice(error.message));
  }

  function isSuccessfulWriteResult(result) {
    return result !== undefined && result !== null && result !== false && result?.ok !== false;
  }

  async function runWrite(action, options = {}) {
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
          const nextUndoStack = updateUndoStack((stack) => [...stack.slice(-79), undoToken]);
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

  async function applyEditorHistoryEffect(effect, doc, options = {}) {
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
        updateRedoStack((stack) => [...stack.slice(-79), inverseToken]);
      } else if (direction === 'redo' && inverseToken) {
        updateRedoStack((stack) => stack.slice(0, -1));
        updateUndoStack((stack) => [...stack.slice(-79), inverseToken]);
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
      const result = direction === 'undo'
        ? await documentRepository.undoEditBranch({ shadowDocId, owner: 'human', includeDoc: false })
        : await documentRepository.redoEditBranch({ shadowDocId, owner: 'human', includeDoc: false });
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
      if (treeEditMode) {
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
      if (treeEditMode) {
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
    updateUndoStack,
    updateRedoStack,
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
          updateUndoStack((stack) => [...stack.slice(-79), beforeFullAccessToken]);
          updateRedoStack([]);
          beforeFullAccessToken = null;
        }
        await refreshDocs(changedDocIds[0] || currentDoc?.doc?.id);
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

  async function applyAgentDiff(diffId, options = {}) {
    const pendingDiff = agentDiffs.find((diff) => Number(diff.id) === Number(diffId));
    if (!pendingDiff) return false;
    if (!options.skipEditModeCheck) {
      const ready = await ensureAgentApprovalEditMode();
      if (!ready) return false;
    }
    const target = agentDiffTraceTarget(pendingDiff);
    let undoToken = null;
    try {
      if (target.docId && !treeEditMode) {
        undoToken = await captureEditorHistoryToken(target.docId);
      }
      const result = await agentRepository.applyDiff({ diffId });
      if (result?.ok !== false && undoToken) {
        discardHistoryTokens(redoStackRef.current);
        updateUndoStack((stack) => [...stack.slice(-79), undoToken]);
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
        setSelectedNodeId(opened?.tree?.id || last?.tree?.id || null);
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

  function changeEntityNodeMatchMode(mode) {
    const nextMode = mode === 'or' ? 'or' : 'and';
    setEntityNodeMatchMode(nextMode);
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }

  function changeEntityNodeQuery(value) {
    setEntityNodeQuery(value);
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }

  async function runEntitySearch() {
    const docId = currentDoc?.doc?.id;
    if (!docId) {
      setEntityRows([]);
      setSelectedEntity(null);
      setEntityDetail(null);
      return;
    }
    setBusy(true);
    try {
      const result = await fetchEntityList({
        readDatabase,
        docId,
        query: entityQuery,
        limit: 100
      });
      setEntityRows(result?.rows || []);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function runEntityNodeSearch(queryOverride = entityNodeQuery, modeOverride = entityNodeMatchMode, options = {}) {
    const docId = currentDoc?.doc?.id;
    const manageBusy = options.manageBusy !== false;
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    if (!docId || !String(queryOverride || '').trim()) {
      setEntityNodeResults([]);
      setEntityNodeGroups([]);
      setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
      return;
    }
    if (manageBusy) setBusy(true);
    try {
      const result = await fetchEntityNodeSearch({
        readDatabase,
        docId,
        query: queryOverride,
        matchMode: modeOverride,
        limit: ENTITY_NODE_SEARCH_PAGE_LIMIT,
        offset,
        mapRow: keywordRowToSearchResult
      });
      setEntityNodeResults(result.rows);
      setEntityNodeGroups(result.groups);
      setEntityNodePage({
        total: Number(result.total) || 0,
        returned: Number(result.returned) || 0,
        offset: Number(result.offset) || 0,
        limit: Number(result.limit) || ENTITY_NODE_SEARCH_PAGE_LIMIT,
        hasMore: Boolean(result.hasMore),
        truncated: Boolean(result.truncated)
      });
    } catch (error) {
      setNotice(error.message);
    } finally {
      if (manageBusy) setBusy(false);
    }
  }

  async function selectEntityTraceEntity(entity) {
    const docId = currentDoc?.doc?.id;
    if (!docId || !entity?.id) return;
    setSelectedEntity(entity);
    setBusy(true);
    try {
      const detail = await fetchEntityDetail({
        readDatabase,
        docId,
        entityId: entity.id
      });
      setEntityDetail(detail || null);
      const literal = String(detail?.entity?.literal || entity.literal || '').trim();
      if (literal) {
        setEntityNodeQuery(literal);
        await runEntityNodeSearch(literal, entityNodeMatchMode, { manageBusy: false, offset: 0 });
      }
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function useEntityTraceKeyword(entity) {
    const literal = String(entity?.literal || '').trim();
    if (!literal) return;
    setEntityNodeQuery(literal);
    await runEntityNodeSearch(literal, entityNodeMatchMode, { offset: 0 });
  }

  function pageEntityNodeSearch(direction) {
    const limit = Number(entityNodePage.limit) || ENTITY_NODE_SEARCH_PAGE_LIMIT;
    const currentOffset = Number(entityNodePage.offset) || 0;
    const nextOffset = direction === 'prev'
      ? Math.max(0, currentOffset - limit)
      : currentOffset + limit;
    runEntityNodeSearch(entityNodeQuery, entityNodeMatchMode, { offset: nextOffset }).catch((error) => setNotice(error.message));
  }

  function dragEntityTraceEntity(event, entity) {
    if (!entity?.literal) return;
    event.dataTransfer.setData('application/x-iftree-entity', entityDragPayload(entity));
    event.dataTransfer.setData('text/plain', entity.literal);
    event.dataTransfer.effectAllowed = 'copy';
  }

  function dropEntityIntoNodeSearch(event) {
    event.preventDefault();
    const entity = entityFromDragEvent(event);
    if (!entity?.literal) return;
    setEntityNodeQuery((current) => appendEntityTerm(current, entity.literal));
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }

  async function openEntityMaintenance() {
    try {
      await openEntityMaintenanceAction({
        docId: currentDoc?.doc?.id || null,
        openWindow: openEntityMaintenanceWindow,
        setNotice
      });
    } catch (error) {
      setNotice(error.message);
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

  async function selectNodeAndOpenTree(nodeId, result = {}) {
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

  async function traceAgentDiff(diff) {
    const target = agentDiffTraceTarget(diff);
    if (!target.docId || !target.address) {
      setNotice('这个待审变更没有可追踪的文档节点。');
      return;
    }
    try {
      const targetDoc = normalizeDocId(currentDoc?.doc?.id) === normalizeDocId(target.docId)
        ? currentDoc
        : await openDoc(target.docId);
      const nodeId = target.nodeId || targetDoc?.idByAddress?.[target.address];
      const node = nodeId ? findNode(targetDoc?.tree, nodeId) : null;
      if (!node) {
        setNotice(`文档 #${target.docId} 中没有节点 ${target.address}。`);
        return;
      }
      focusNodeInDoc(targetDoc, node);
    } catch (error) {
      setNotice(error.message);
    }
  }

  async function loadNodeChildren(nodeId, options = {}) {
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

  async function toggleCollapsed(nodeId, options = {}) {
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

  async function expandNodeOneLevel(nodeId, options = {}) {
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

  function summaryNodeLabel(node) {
    if (!node) return '未选中节点';
    const title = String(node.title || node.text || '').replace(/\s+/g, ' ').trim();
    return `${node.address}${title ? ` ${title.slice(0, 32)}` : ''}`;
  }

  function summaryTargetsForMode(mode) {
    const selectedNodeIds = (mode === 'selected' || mode === 'subtree') && multiSelectedNodeIds.size > 0
      ? [...multiSelectedNodeIds]
      : selectedNodeId
        ? [selectedNodeId]
        : [];
    return buildSummaryTargetsForMode({
      tree: currentDoc?.tree,
      selectedNodeId,
      selectedNodeIds,
      mode
    });
  }

  function summaryStrategyModeForScope(mode) {
    return mode === 'article' ? 'node' : mode;
  }

  async function generateSummary(mode) {
    if (!treeEditMode) {
      setNotice('请先进入编辑模式');
      return;
    }
    if (!summaryService.canGenerateNodeSummary()) {
      setNotice('当前版本缺少摘要生成接口，请重启应用后再试。');
      return;
    }
    if (!currentDoc?.tree) {
      setNotice('没有打开文档。');
      return;
    }
    const selectedSummaryCount = multiSelectedNodeIds.size || (selectedNodeId ? 1 : 0);
    if ((mode === 'selected' || mode === 'subtree') && selectedSummaryCount === 0) {
      setNotice('没有选中任何节点，不能生成节点摘要。');
      return;
    }

    const targets = summaryTargetsForMode(mode);
    if (targets.length === 0) {
      const selectedDepth = selectedNode ? depthOf(selectedNode.address || '1') : 1;
      setNotice(mode === 'depth' ? `当前第 ${selectedDepth} 层没有节点。` : '没有可生成摘要的目标节点。');
      return;
    }

    const strategySettings = normalizeSummaryStrategySettings(llmSummarySettings || {});
    const strategyMode = summaryStrategyModeForScope(mode);
    const strategyIndex = strategyMode === 'article' ? 0 : 1;
    const strategy = summaryStrategyForMode(llmSummarySettings, strategyMode);
    const summaryItems = [];
    let skippedGenerated = 0;
    for (const target of targets) {
      const text = String(target.text || '').trim();
      if (hasGeneratedNote(target.node.note || '')) {
        skippedGenerated += 1;
        summaryItems.push({ target, text, skip: 'generated' });
        continue;
      }
      summaryItems.push({ target, text, skip: null });
    }
    const writableItems = summaryItems.filter((item) => item.skip !== 'generated');

    if (writableItems.length === 0) {
      setNotice(`没有需要生成摘要的节点：已有 AI 摘要跳过 ${skippedGenerated} 个。`);
      return;
    }

    const scopeLabel = {
      selected: '当前选中节点',
      subtree: '当前选中节点及其子树',
      depth: `当前第 ${selectedNode ? depthOf(selectedNode.address || '1') : 1} 层节点`,
      article: '全文'
    }[mode] || '节点';
    const targetLabel = writableItems.length === 1
      ? summaryNodeLabel(writableItems[0].target.node)
      : `${writableItems.length} 个节点`;
    return {
      mode,
      scopeLabel,
      selectedLabel: selectedNode ? summaryNodeLabel(selectedNode) : '无',
      targetLabel,
      summaryItems,
      skippedShort: summarySkipBelowCount(summaryItems, strategy, strategyIndex),
      skippedGenerated,
      strategy,
      strategyIndex,
      strategyOptions: strategySettings.summaryStrategies
    };
  }

  function isSummaryAbortError(error) {
    return error?.name === 'AbortError' || /aborted|abort|cancel|取消/i.test(String(error?.message || error || ''));
  }

  async function cancelSummaryRunRequests(run) {
    const requestIds = [...(run?.requestIds || [])];
    await Promise.allSettled(requestIds.map((requestId) => summaryService.cancelNodeSummary?.({ requestId })));
  }

  async function cancelSummaryGeneration() {
    const run = summaryRunRef.current;
    if (!run || run.canceled) return;
    run.canceled = true;
    setProgress((current) => current ? { ...current, label: '正在取消摘要生成...', cancelable: false } : current);
    await cancelSummaryRunRequests(run);
  }

  async function runSummaryGeneration(request, summaryStrategy) {
    const strategyIndex = Number.isInteger(request?.strategyIndex)
      ? request.strategyIndex
      : (summaryStrategyModeForScope(request?.mode) === 'article' ? 0 : 1);
    const normalizedStrategy = normalizeSummaryStrategy(summaryStrategy, strategyIndex);
    const summaryItems = applySummarySkipStrategy(request?.summaryItems || [], normalizedStrategy, strategyIndex);
    const skippedShort = summaryItems.filter((item) => item.skip === 'short').length;
    const skippedGenerated = summaryItems.filter((item) => item.skip === 'generated').length;
    const eligible = summaryItems.filter((item) => !item.skip);
    if (eligible.length === 0) {
      setNotice(`没有需要生成摘要的节点：短文本跳过 ${skippedShort} 个，已有 AI 摘要跳过 ${skippedGenerated} 个。`);
      return;
    }
    const concurrency = normalizeSummaryConcurrency(llmSummarySettings?.summaryConcurrency);
    const run = {
      id: `summary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      canceled: false,
      requestIds: new Set()
    };
    summaryRunRef.current = run;
    let undoToken = null;
    setBusy(true);
    let generated = 0;
    let processed = 0;
    let firstError = null;
    try {
      undoToken = treeEditMode ? null : await captureEditorHistoryToken();
      const total = summaryItems.length;
      const progressFor = (label) => ({
        label,
        step: processed,
        total,
        countLabel: `${processed} / ${total}`,
        cancelable: true
      });
      const markProcessed = (label) => {
        processed += 1;
        setProgress(progressFor(label));
      };
      const workItems = [];
      for (const [index, item] of summaryItems.entries()) {
        const nodeLabel = summaryNodeLabel(item.target.node);
        if (item.skip) {
          markProcessed(item.skip === 'short' ? `跳过短文本：${nodeLabel}` : `跳过已有摘要：${nodeLabel}`);
          continue;
        }
        workItems.push({ item, index, nodeLabel });
      }

      let cursor = 0;
      let writeChain = Promise.resolve();
      const writeTasks = [];
      const enqueueSummaryWrite = (work, summary) => {
        const writeTask = writeChain.then(async () => {
          if (run.canceled || firstError) return;
          const nextNote = appendGeneratedNote(work.item.target.node.note || '', summary);
          const next = await nodeRepository.updateNode({
            docId: currentDoc.doc.id,
            nodeId: work.item.target.node.id,
            patch: { node_note: nextNote },
            includeDoc: false
          });
          if (next?.refresh?.kind === 'node' && next.node) {
            setCurrentDoc((current) => {
              const patched = patchNodeInDoc(current, next.node);
              return next.editBranch ? { ...patched, editBranch: next.editBranch } : patched;
            });
            if (treeEditMode) syncEditBranchHistoryStacks(next.editBranch || activeEditBranch());
          } else {
            const nextDoc = await resolveWriteDoc(next);
            if (nextDoc) {
              setCurrentDoc((current) => mergeDocView(current, nextDoc));
              if (treeEditMode) syncEditBranchHistoryStacks(nextDoc.editBranch || next.editBranch || activeEditBranch());
            }
          }
          generated += 1;
        }).catch(async (error) => {
          if (!firstError) firstError = { error, index: work.index };
          run.canceled = true;
          await cancelSummaryRunRequests(run);
          throw error;
        });
        writeTasks.push(writeTask);
        writeChain = writeTask.catch(() => {});
      };

      const worker = async () => {
        for (;;) {
          if (run.canceled || firstError) return;
          const work = workItems[cursor];
          cursor += 1;
          if (!work) return;
          const requestId = `${run.id}-${work.index}`;
          run.requestIds.add(requestId);
          setProgress(progressFor(`生成摘要：${work.nodeLabel}`));
          try {
            const result = await summaryService.generateNodeSummary({
              requestId,
              mode: work.item.target.summaryMode,
              title: currentDoc.doc.title,
              address: work.item.target.node.address,
              nodeTitle: work.item.target.node.title || '',
              text: work.item.text,
              summaryStrategy: normalizedStrategy
            });
            if (run.canceled || firstError) return;
            const summary = String(result?.summary || '').trim();
            if (summary) enqueueSummaryWrite(work, summary);
            markProcessed(`完成摘要：${work.nodeLabel}`);
          } catch (error) {
            if (isSummaryAbortError(error) || run.canceled) {
              run.canceled = true;
              return;
            }
            if (!firstError) firstError = { error, index: work.index };
            run.canceled = true;
            await cancelSummaryRunRequests(run);
            return;
          } finally {
            run.requestIds.delete(requestId);
          }
        }
      };

      const workerCount = Math.min(concurrency, workItems.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      await Promise.all(writeTasks);
      if (firstError) throw firstError.error;
      if (generated > 0) setDocs(await documentRepository.listDocs());
      if (run.canceled) {
        setNotice(`摘要生成已取消，已保存 ${generated} 个；再次选择同一范围会跳过已有摘要继续生成。`);
      } else {
        setNotice(`已生成摘要 ${generated} 个；短文本跳过 ${skippedShort} 个，已有 AI 摘要跳过 ${skippedGenerated} 个。`);
      }
    } catch (error) {
      const failedAt = Math.min((firstError?.index ?? processed) + 1, summaryItems.length);
      setNotice(`摘要生成失败（${failedAt} / ${summaryItems.length}）：${error.message}`);
    } finally {
      if (generated > 0 && undoToken) {
        discardHistoryTokens(redoStackRef.current);
        updateUndoStack((stack) => [...stack.slice(-79), undoToken]);
        updateRedoStack([]);
        undoToken = null;
      }
      if (undoToken) {
        discardHistoryTokens([undoToken]);
      }
      setBusy(false);
      setProgress(null);
      if (summaryRunRef.current?.id === run.id) summaryRunRef.current = null;
    }
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
          llmSummarySettings={llmSummarySettings}
          agentSettings={agentSettings}
          nodeLayoutSettings={nodeLayoutSettings}
          notice={notice}
          clearNotice={() => setNotice('')}
          onBack={() => setActiveScreen('editor')}
          onChange={saveVectorSettings}
          onLlmSummaryChange={saveLlmSummarySettings}
          onAgentChange={saveAgentSettings}
          onNodeLayoutChange={saveNodeLayoutSettings}
          canEditNodeLayout={treeEditMode}
          treeEditMode={treeEditMode}
          onToggleTreeEditMode={() => toggleTreeEditMode({ stayOnScreen: true })}
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
          scrollRef={outlineScrollRef}
          onScroll={handleOutlineScroll}
          stickyRows={outlineStickyRows}
          topSpacer={outlineTopSpacer}
          renderedRows={renderedOutline}
          bottomSpacer={outlineVirtual.bottom}
          selectedNodeId={selectedNode?.id}
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
                  selectedNodeId={selectedNodeId || selectedNode?.id}
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
                  selectedNodeId={selectedNode?.id}
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
                  selectedNodeId={selectedNode?.id}
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
                  axiomId: Number(event.target.value)
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
