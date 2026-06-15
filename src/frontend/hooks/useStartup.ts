import { useCallback, useEffect, useRef } from 'react';

import { normalizeDocId, normalizeNodeLayoutSettingsByView, readPersistedActiveDocId, persistActiveDocId, sameDocId } from '../lib/doc-utils.mjs';
import { debugLog, setDebugLoggingEnabled } from '../lib/debug-log.mjs';
import {
  captureE2EWindow,
  getStartupOptions,
  reportStartupFailure,
  reportStartupSuccess,
  startupHeartbeat
} from '../data/iftree-api.js';
import {
  agentRepository,
  documentRepository,
  settingsRepository
} from '../data/repositories.js';

// Keep these gates aligned with electron/main.mjs analyzeE2ECapture.
const E2E_PROBE_LIMIT = 30;
const E2E_TEXT_MIN_WIDTH = 8;
const E2E_TEXT_MIN_HEIGHT = 6;
const E2E_EDGE_MIN_WIDTH = 12;
const E2E_EDGE_MIN_HEIGHT = 6;

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

// 启动编排：心跳上报、启动文档打开（含待恢复编辑分支三选）、首帧渲染解锁、
// E2E 像素探针（e2eChm 模式）。App 只消费 handleMindMapRenderReady / armRenderUnlock。
/** @param {{
 *   currentDoc?: any, activeTab?: string, lockedProgress?: any, progress?: any,
 *   lastUiActionRef?: any, startupOpenRequestedRef?: any,
 *   setNotice?: any, setProgress?: any, setOperationLock?: any,
 *   setDocs?: any, setDocFolders?: any, setLibraryTree?: any,
 *   setVectorSettings?: any, setLlmSummarySettings?: any, setNodeLayoutSettings?: any,
 *   setAgentSettings?: any, setAgentDiffs?: any, refreshAgentSessions?: any,
 *   openDoc?: any, promptStartupEditBranchChoice?: any, editBranchBaseDocId?: any
 * }} [options] */
export function useStartup({
  currentDoc = null,
  activeTab = '',
  lockedProgress = null,
  progress = null,
  lastUiActionRef = null,
  startupOpenRequestedRef = null,
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
}: any = {}) {
  const startupSuccessReportedRef = useRef(false);
  const startupPendingDocRef = useRef(null);
  const startupOptionsRef = useRef({ startupDocId: null, renderMode: 'hardware', e2eChm: false, forceHardwareAcceleration: false, debugLogging: false });
  const renderReadyLogSignatureRef = useRef('');
  const renderUnlockPendingRef = useRef(null);
  const e2eDragRequestedRef = useRef(false);

  const sendStartupHeartbeat = useCallback((stage, extra: any = {}) => {
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
  const failStartup = useCallback((error, payload: any = {}) => {
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
  const runStartupE2ECheck = useCallback(async (info: any = {}, pending: any = {}) => {
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
  const handleMindMapRenderReady = useCallback((info: any = {}) => {
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

  useEffect(() => {
    let alive = true;
    startupHeartbeat({ stage: 'renderer-mounted' });
    const heartbeatTimer = window.setInterval(() => {
      startupHeartbeat({ stage: 'renderer-alive' });
    }, 1000);
    const rendererErrorPayload = (error, extra = {}) => ({
      message: String(error?.message || error || '').slice(0, 240),
      stack: String(error?.stack || '').slice(0, 800),
      lastUiAction: lastUiActionRef?.current ?? null,
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
      // 审核通道统一：不限 owner——llm 待审分支同样在启动时被发现、提示恢复审阅。
      documentRepository.getPendingEditBranches({}).catch(() => ({ branches: [] }))
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
    const data = lockedProgress || progress;
    if (!data) return;
    sendStartupHeartbeat(String(data.label || 'startup-progress'), { progress: data });
  }, [lockedProgress, progress, sendStartupHeartbeat]);

  return {
    armRenderUnlock,
    handleMindMapRenderReady
  };
}
