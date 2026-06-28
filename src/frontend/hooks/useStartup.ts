import { useCallback, useEffect, useRef, type MutableRefObject, type Dispatch, type SetStateAction } from 'react';

import type { DocListItem } from '../../backend/query-api.js';
import type { DocFolderRow } from '../../backend/db/schema.js';
import type { LibraryEntry } from '../../backend/library-fs.js';
import { normalizeDocId, normalizeNodeLayoutSettingsByView, readPersistedActiveDocId, persistActiveDocId, sameDocId } from '../lib/doc-utils.js';
import { debugLog, setDebugLoggingEnabled } from '../lib/debug-log.js';
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
import { useAppUIContext } from './useAppUI.js';

// Keep these gates aligned with electron/main.mjs analyzeE2ECapture.
const E2E_PROBE_LIMIT = 30;
const E2E_TEXT_MIN_WIDTH = 8;
const E2E_TEXT_MIN_HEIGHT = 6;
const E2E_EDGE_MIN_WIDTH = 12;
const E2E_EDGE_MIN_HEIGHT = 6;

type AnyRecord = Record<string, unknown>;

interface CurrentDoc {
  doc?: { id?: unknown; node_count?: unknown; [extra: string]: unknown } | null;
  tree?: unknown;
  flatTree?: unknown;
  editBranch?: unknown;
  [extra: string]: unknown;
}

interface DocSummary {
  id?: unknown;
  node_count?: unknown;
  nodeCount?: unknown;
  [extra: string]: unknown;
}

interface PendingBranchSummary {
  id?: unknown;
  base_doc_id?: unknown;
  shadow_doc_id?: unknown;
  node_count?: unknown;
  owner?: string;
  [extra: string]: unknown;
}

interface StartupRenderReadyInfo {
  docId?: unknown;
  renderBackend?: string | null;
  nodeCount?: unknown;
  visual?: AnyRecord;
  [extra: string]: unknown;
}

interface StartupOptions {
  startupDocId: string | null;
  renderMode: 'hardware' | 'compatible';
  e2eChm: boolean;
  forceHardwareAcceleration: boolean;
  debugLogging: boolean;
}

interface StartupPendingDoc {
  docId: unknown;
  reportDocId?: unknown;
  nodeCount: unknown;
}

interface RenderUnlockPending {
  docId: string;
  reason: string;
}

interface OpenDocOptions {
  includeEditBranch?: boolean;
  onComplete?: (doc: unknown) => void;
  onFailure?: (error: unknown) => void;
}

export interface UseStartupOptions {
  currentDoc?: CurrentDoc | null;
  lastUiActionRef?: MutableRefObject<unknown> | null;
  startupOpenRequestedRef?: MutableRefObject<boolean> | null;
  // setter 字段直接对齐上游真签名（useDocumentState / useSettings / useAgentChat），让 AppBody 传 Dispatch 进来天然兼容。
  setDocs: Dispatch<SetStateAction<DocListItem[]>>;
  setDocFolders: Dispatch<SetStateAction<DocFolderRow[]>>;
  setLibraryTree: Dispatch<SetStateAction<LibraryEntry | null>>;
  setVectorSettings: Dispatch<SetStateAction<Record<string, unknown>>>;
  setLlmSummarySettings: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  setNodeLayoutSettings: Dispatch<SetStateAction<Record<string, unknown>>>;
  setAgentSettings: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  setAgentDiffs: Dispatch<SetStateAction<Record<string, unknown>[]>>;
  refreshAgentSessions: () => Promise<unknown>;
  openDoc: (docId: unknown, options?: OpenDocOptions) => Promise<unknown>;
  promptStartupEditBranchChoice: (branch: unknown) => Promise<unknown>;
  editBranchBaseDocId: (editBranch?: unknown) => unknown;
}

interface HeartbeatExtra extends AnyRecord {
  docId?: unknown;
  nodeCount?: unknown;
  progress?: unknown;
  renderBackend?: string | null;
  e2e?: AnyRecord;
}

interface StartupReportPayload extends AnyRecord {
  stage?: string;
  docId?: unknown;
  nodeCount?: unknown;
  progress?: unknown;
  renderBackend?: string | null;
  e2e?: AnyRecord;
}

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function waitForPaintAfterUiUpdate(): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(() => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => resolve());
      });
    }, 0);
  });
}

interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function viewportRectPayload(rect: { left?: unknown; top?: unknown; width?: unknown; height?: unknown }): ViewportRect {
  return {
    x: Math.max(0, Number(rect?.left) || 0),
    y: Math.max(0, Number(rect?.top) || 0),
    width: Math.max(0, Number(rect?.width) || 0),
    height: Math.max(0, Number(rect?.height) || 0)
  };
}

function rectIntersectsViewport(rect: RectLike | null | undefined, minWidth: number = 1, minHeight: number = 1): boolean {
  if (!rect || rect.width < minWidth || rect.height < minHeight) return false;
  return rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
}

function visibleElements(selector: string, minWidth: number = 1, minHeight: number = 1): Element[] {
  return Array.from(document.querySelectorAll(selector)).filter((element) => {
    const rect = element.getBoundingClientRect();
    return rectIntersectsViewport(rect, minWidth, minHeight);
  });
}

interface EdgeElement extends Element {
  dataset?: DOMStringMap;
}

function edgeProbeRect(edge: EdgeElement, svgRect: RectLike): RectLike {
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

interface StartupVisualProbe {
  visual: {
    visibleNodeCount: number;
    visibleEdgeCount: number;
    gpuCardCount: number;
    gpuEdgeCount: number;
    hasText: boolean;
    hasEdges: boolean;
    overlayClear: boolean;
  };
  textProbeRects: ViewportRect[];
  edgeProbeRects: ViewportRect[];
}

function collectStartupVisualProbe(): StartupVisualProbe {
  const cards = visibleElements('.c2d-node-card', E2E_TEXT_MIN_WIDTH, E2E_TEXT_MIN_WIDTH);
  const textProbeRects = cards
    .map((card) => card.querySelector('.c2d-node-title, .c2d-node-body, .c2d-node-note, .c2d-node-meta'))
    .filter((element): element is Element => Boolean(element))
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rectIntersectsViewport(rect, E2E_TEXT_MIN_WIDTH, E2E_TEXT_MIN_HEIGHT))
    .slice(0, E2E_PROBE_LIMIT)
    .map(viewportRectPayload);

  const svg = document.querySelector('.c2d-connector-layer');
  const svgRect = svg?.getBoundingClientRect?.();
  const edgeProbeRects = svg && svgRect
    ? Array.from(svg.querySelectorAll('.c2d-connector-line'))
        .map((line) => edgeProbeRect(line as EdgeElement, svgRect))
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

async function moveStartupCameraProbe(): Promise<number> {
  const surface = document.querySelector('.c2d-map-surface') as HTMLElement | null;
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
// UI 横切态（activeTab/progress/lockedProgress/setNotice/setProgress/setOperationLock）从 useAppUIContext 读。
export function useStartup({
  currentDoc = null,
  lastUiActionRef = null,
  startupOpenRequestedRef = null,
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
}: UseStartupOptions): {
  armRenderUnlock: (docId: unknown, reason?: string) => boolean;
  handleMindMapRenderReady: (info?: StartupRenderReadyInfo) => void;
} {
  const { activeTab, lockedProgress, progress, setNotice, setProgress, setOperationLock } = useAppUIContext();
  const startupSuccessReportedRef = useRef<boolean>(false);
  const startupPendingDocRef = useRef<StartupPendingDoc | null>(null);
  const startupOptionsRef = useRef<StartupOptions>({ startupDocId: null, renderMode: 'hardware', e2eChm: false, forceHardwareAcceleration: false, debugLogging: false });
  const renderReadyLogSignatureRef = useRef<string>('');
  const renderUnlockPendingRef = useRef<RenderUnlockPending | null>(null);
  const e2eDragRequestedRef = useRef<boolean>(false);

  const sendStartupHeartbeat = useCallback((stage: string, extra: HeartbeatExtra = {}) => {
    startupHeartbeat({
      ...extra,
      stage,
      docId: extra.docId ?? currentDoc?.doc?.id ?? null,
      nodeCount: extra.nodeCount ?? currentDoc?.doc?.node_count ?? null,
      progress: extra.progress || null
    });
  }, [currentDoc?.doc?.id, currentDoc?.doc?.node_count]);
  const completeStartup = useCallback((payload: StartupReportPayload = {}) => {
    if (startupSuccessReportedRef.current) return;
    startupSuccessReportedRef.current = true;
    startupPendingDocRef.current = null;
    renderUnlockPendingRef.current = null;
    debugLog('frontend.startup.complete', payload);
    reportStartupSuccess(payload).catch(() => {});
  }, []);
  const failStartup = useCallback((error: unknown, payload: StartupReportPayload = {}) => {
    if (startupSuccessReportedRef.current) return;
    startupSuccessReportedRef.current = true;
    startupPendingDocRef.current = null;
    renderUnlockPendingRef.current = null;
    debugLog('frontend.startup.failure', {
      ...payload,
      error: (error as { message?: string } | null | undefined)?.message || String(error || 'startup-failure')
    });
    reportStartupFailure({
      message: (error as { message?: string } | null | undefined)?.message || String(error || '启动失败'),
      stage: payload.stage || 'startup-failure',
      docId: payload.docId ?? null,
      nodeCount: payload.nodeCount ?? null,
      progress: payload.progress || null
    }).catch(() => {});
  }, []);
  const armRenderUnlock = useCallback((docId: unknown, reason: string = 'open-doc'): boolean => {
    const normalizedDocId = normalizeDocId(docId);
    if (!normalizedDocId || activeTab !== 'tree') return false;
    renderUnlockPendingRef.current = { docId: normalizedDocId, reason };
    return true;
  }, [activeTab]);
  const releaseRenderUnlock = useCallback((docId: unknown): boolean => {
    const pending = renderUnlockPendingRef.current;
    if (!pending || !sameDocId(docId, pending.docId)) return false;
    renderUnlockPendingRef.current = null;
    setProgress(null);
    setOperationLock(null);
    return true;
  }, [setOperationLock, setProgress]);
  const runStartupE2ECheck = useCallback(async (info: StartupRenderReadyInfo = {}, pending: StartupPendingDoc): Promise<void> => {
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
    const screenshot = await captureE2EWindow({ textProbeRects, edgeProbeRects }) as { ok?: boolean } | null | undefined;
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
  const handleMindMapRenderReady = useCallback((info: StartupRenderReadyInfo = {}): void => {
    const pending = startupPendingDocRef.current;
    const visual = (info.visual || {}) as { visibleNodeCount?: unknown; visibleEdgeCount?: unknown };
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
    })().catch((error: unknown) => {
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
    const rendererErrorPayload = (error: unknown, extra: AnyRecord = {}): AnyRecord => ({
      message: String((error as { message?: string } | null | undefined)?.message || error || '').slice(0, 240),
      stack: String((error as { stack?: string } | null | undefined)?.stack || '').slice(0, 800),
      lastUiAction: lastUiActionRef?.current ?? null,
      ...extra
    });
    const reportWindowError = (event: ErrorEvent): void => {
      const error = event?.error || event?.message || 'renderer-error';
      debugLog('renderer.window.error', rendererErrorPayload(error, {
        sourceId: String(event?.filename || '').slice(0, 200),
        lineNumber: event?.lineno ?? null,
        columnNumber: event?.colno ?? null
      }));
      failStartup(error, { stage: 'renderer-error' });
    };
    const reportUnhandledRejection = (event: PromiseRejectionEvent): void => {
      const reason = event?.reason || 'renderer-unhandled-rejection';
      debugLog('renderer.window.unhandledrejection', rendererErrorPayload(reason));
      failStartup(reason, { stage: 'renderer-unhandled-rejection' });
    };
    window.addEventListener('error', reportWindowError);
    window.addEventListener('unhandledrejection', reportUnhandledRejection);
    startupHeartbeat({ stage: 'startup-list-db-docs' });
    documentRepository.listDocFolders()
      .then((folders) => { if (alive) setDocFolders((Array.isArray(folders) ? folders : []) as DocFolderRow[]); })
      .catch((error) => { if (alive) setNotice((error as { message?: string }).message || ''); });
    documentRepository.readLibraryTree()
      .then((tree) => { if (alive && tree) setLibraryTree(tree as LibraryEntry); })
      .catch((error) => { if (alive) setNotice((error as { message?: string }).message || ''); });
    Promise.all([
      documentRepository.listDocs(),
      getStartupOptions().catch(() => ({ startupDocId: null, renderMode: 'hardware', e2eChm: false, debugLogging: false })),
      // 审核通道统一：不限 owner——llm 待审分支同样在启动时被发现、提示恢复审阅。
      documentRepository.getPendingEditBranches({}).catch(() => ({ branches: [] }))
    ]).then(async ([list = [], startupOptions = {}, pendingEdit = {}]) => {
      // listDocs IPC 返回 unknown，本 hook 把它当 DocListItem[]（真行类型，DocSummary 是历史 minimal 子集）。
      const docsList = (Array.isArray(list) ? list : []) as DocListItem[];
      setDocs(docsList);
      const options = startupOptions as Partial<StartupOptions>;
      startupOptionsRef.current = {
        startupDocId: options.startupDocId || null,
        renderMode: options.renderMode === 'compatible' ? 'compatible' : 'hardware',
        e2eChm: options.e2eChm === true,
        forceHardwareAcceleration: options.forceHardwareAcceleration === true,
        debugLogging: options.debugLogging === true
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
      const pendingBranches: PendingBranchSummary[] = Array.isArray((pendingEdit as { branches?: unknown }).branches)
        ? (pendingEdit as { branches: PendingBranchSummary[] }).branches
        : [];
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
        ? (docsList.find((doc) => sameDocId(doc.id, pendingBranch.base_doc_id)) || ({
            id: pendingBranch.base_doc_id,
            node_count: pendingBranch.node_count
          } as DocSummary))
        : null;
      if (pendingBranch && pendingBranchChoice === 'discard') {
        try {
          await documentRepository.discardEditBranch({
            branchId: pendingBranch.id,
            owner: pendingBranch.owner || 'human',
            includeDoc: false
          });
        } catch (error) {
          setNotice((error as { message?: string }).message || '');
          failStartup(error, { stage: 'startup-discard-edit-branch-failed' });
          return;
        }
      }
      const openTargetDocId = pendingBranchChoice === 'restore'
        ? pendingBranch?.shadow_doc_id
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
      if (!alive || (startupOpenRequestedRef && startupOpenRequestedRef.current)) return;
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
      if (startupOpenRequestedRef) startupOpenRequestedRef.current = true;
      window.setTimeout(() => {
        if (!alive) return;
        const openStartupDoc = (targetDocId: unknown, baseDoc: DocSummary | null | undefined, choice: string | null): void => {
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
            onComplete(rawDoc) {
              const doc = rawDoc as CurrentDoc | null | undefined;
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
              persistActiveDocId(docId as string);
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
          }).catch((error: unknown) => {
            if (!alive) return;
            if (choice === 'restore' && pendingBranch?.base_doc_id && !sameDocId(targetDocId, pendingBranch.base_doc_id)) {
              setNotice(`恢复编辑状态失败，已暂存：${(error as { message?: string }).message}`);
              debugLog('frontend.startup.restore.fallback-stash', {
                shadowDocId: targetDocId,
                baseDocId: pendingBranch.base_doc_id,
                error: (error as { message?: string } | null | undefined)?.message || String(error || 'open-doc-failed')
              });
              openStartupDoc(pendingBranch.base_doc_id, pendingBaseDoc, 'stash');
              return;
            }
            setNotice((error as { message?: string }).message || '');
            debugLog('frontend.startup.open.failure', {
              docId: targetDocId,
              nodeCount: baseDoc?.node_count ?? baseDoc?.nodeCount ?? null,
              error: (error as { message?: string } | null | undefined)?.message || String(error || 'open-doc-failed')
            });
            failStartup(error, {
              stage: 'startup-open-active-doc-failed',
              docId: targetDocId,
              nodeCount: baseDoc?.node_count ?? baseDoc?.nodeCount ?? null
            });
          });
        };
        openStartupDoc(openTargetDocId, openBaseDoc, (pendingBranchChoice as string) || 'open');
      }, 0);
    }).catch((error: unknown) => {
      if (alive) {
        setNotice((error as { message?: string }).message || '');
        failStartup(error, { stage: 'startup-list-docs-failed' });
      }
    });
    settingsRepository.readVectorSettings()
      .then((settings) => setVectorSettings((settings || { enabled: true, disabledReason: '' }) as Record<string, unknown>))
      .catch((error) => {
        if (alive) setNotice((error as { message?: string }).message || '');
      });
    settingsRepository.readLlmSummarySettings()
      .then((settings) => setLlmSummarySettings((settings || null) as Record<string, unknown> | null))
      .catch((error) => setNotice((error as { message?: string }).message || ''));
    settingsRepository.readAgentSettings()
      .then((settings) => setAgentSettings((settings || null) as Record<string, unknown> | null))
      .catch((error) => setNotice((error as { message?: string }).message || ''));
    const agentTimer = window.setTimeout(() => {
      agentRepository.listDiffs()
        .then((diffs) => setAgentDiffs((Array.isArray(diffs) ? diffs : []) as Record<string, unknown>[]))
        .catch((error) => setNotice((error as { message?: string }).message || ''));
      refreshAgentSessions().catch((error) => setNotice((error as { message?: string }).message || ''));
    }, 300);
    settingsRepository.readNodeLayoutSettings()
      .then((settings) => setNodeLayoutSettings(normalizeNodeLayoutSettingsByView(settings) as Record<string, unknown>))
      .catch((error) => setNotice((error as { message?: string }).message || ''));
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
    sendStartupHeartbeat(String((data as { label?: unknown }).label || 'startup-progress'), { progress: data });
  }, [lockedProgress, progress, sendStartupHeartbeat]);

  return {
    armRenderUnlock,
    handleMindMapRenderReady
  };
}
