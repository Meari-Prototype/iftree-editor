// editor history token 的规格化纯函数（从 AppBody 下沉，frontend-refactor.md 阶段 1）。
// token/viewState/effect 都是 IPC 边界对象：形参 unknown，narrow 后按字段访问。
// 原实现里对 currentDoc.doc.id 的兜底改为显式 fallbackDocId 参数——纯函数化，可 node --test。

import { idSetFromArray, normalizeDocId } from '../lib/doc-utils.js';

export interface EditorHistoryViewState {
  docId: string;
  activeTab: string | null;
  depthLimit: number;
  collapsedNodeIds: unknown[];
  expandedNodeIds: unknown[];
  selectedNodeId: string | null;
}

export interface EditorHistoryEffect {
  kind: string;
  docId: string;
  nodeId: string;
  minDepth: number;
}

export interface EditorHistoryToken {
  id: string;
  docId: string;
  viewState: EditorHistoryViewState | null;
  effect: EditorHistoryEffect | null;
}

export function normalizeEditorHistoryViewState(value: unknown): EditorHistoryViewState | null {
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

export function normalizeEditorHistoryEffect(value: unknown, fallbackDocId: unknown = null): EditorHistoryEffect | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const kind = String(obj.kind || '');
  if (kind !== 'expandNodeOne') return null;
  const docId = normalizeDocId(obj.docId || obj.doc_id || fallbackDocId);
  const nodeId = normalizeDocId(obj.nodeId || obj.node_id);
  if (!docId || !nodeId) return null;
  return {
    kind,
    docId,
    nodeId,
    minDepth: Math.max(0, Math.floor(Number(obj.minDepth) || 0))
  };
}

export function normalizeHistoryToken(token: unknown, fallbackDocId: unknown = null): EditorHistoryToken | null {
  const obj = (token && typeof token === 'object' ? token : {}) as Record<string, unknown>;
  const id = String(obj.id || obj.tokenId || '');
  const docId = normalizeDocId(obj.docId || obj.doc_id || fallbackDocId);
  if (!id || !docId) return null;
  return {
    id,
    docId,
    viewState: normalizeEditorHistoryViewState(obj.viewState),
    effect: normalizeEditorHistoryEffect(obj.effect || obj.redoEffect, fallbackDocId)
  };
}

export function attachEditorHistoryViewState(
  token: unknown,
  viewState: unknown = null,
  effect: unknown = null,
  fallbackDocId: unknown = null
): EditorHistoryToken | null {
  const normalized = normalizeHistoryToken(token, fallbackDocId);
  if (!normalized) return null;
  const tokenObj = (token && typeof token === 'object' ? token : {}) as Record<string, unknown>;
  const normalizedEffect = normalizeEditorHistoryEffect(
    effect || tokenObj.effect || tokenObj.redoEffect || normalized.effect,
    fallbackDocId
  );
  return {
    ...normalized,
    viewState: normalizeEditorHistoryViewState(viewState || tokenObj.viewState) || normalized.viewState || null,
    effect: normalizedEffect || null
  };
}
