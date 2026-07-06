// treeViewCommands：树视图态动词（frontend-refactor.md §4.4 阶段 2c）。
// toggle / expand / focus / locate / jumpToAddress / outline 折叠 + editor history 的
// 视图态快照三函数（拍/恢复/重放 effect）自 AppBody 原样搬入——收拢「AppBody 算集合 →
// useTreeViewState 转发壳 → useDocumentState session 动词」三层撕裂的 AppBody 层；
// toggleCollapsed/expandNodeOneLevel 从此单一 owner（不再与 docState 同名函数并存于组件）。
// useTreeViewState / useNodeSelection 保留为状态桶，经 deps 读写；状态迁 store 是后续刀。

import { findNode, flattenTree } from '../../core/tree.js';
import {
  clampDepthLimit,
  depthOf,
  fullDepthForDoc,
  hasKnownChildren,
  idSetFromArray,
  loadedDepthForDoc,
  normalizeDocId,
  sameDocId,
  treeViewStateFromDoc
} from '../lib/doc-utils.js';
import { debugLog } from '../lib/debug-log.js';
import {
  normalizeEditorHistoryEffect,
  normalizeEditorHistoryViewState
} from '../session/history-token.js';
import { documentRepository } from '../data/repositories.js';

// 当前文档投影的树视图读面（IPC 边界宽形态）。
export interface TreeViewDocLike {
  doc?: { id?: unknown; [extra: string]: unknown } | null;
  tree?: unknown;
  idByAddress?: Record<string, unknown>;
  treeIndex?: { nodeOf?: (id: unknown) => { id?: unknown } | null | undefined; hasChildren?: (id: unknown) => boolean } | null;
  axioms?: unknown[];
  [extra: string]: unknown;
}

type TreeActionNode = {
  id?: unknown;
  address?: string;
  children?: unknown[];
  childCount?: unknown;
  [extra: string]: unknown;
};

export type ToggleOptions = {
  nodeAddress?: string;
  hasChildren?: boolean;
  singlePath?: boolean;
  promoteDepth?: boolean;
  maxDepth?: number;
  minDepth?: number;
  [extra: string]: unknown;
};

export interface TreeViewCommandDeps {
  getCurrentDoc(): TreeViewDocLike | null;
  docState: {
    ensureNodeChildren(nodeId: unknown): Promise<void>;
  };
  tree: {
    getDepthLimit(): number;
    getCollapsed(): Set<string>;
    getExpanded(): Set<string>;
    getActualMaxDepth(): number;
    setPersistedTreeView(depthLimit: number, collapsed: Set<string>, expanded: Set<string>, docId?: unknown): void;
    setPersistedTreeViewAfterExpansion(depthLimit: number, collapsed: Set<string>, expanded: Set<string>): void;
    // 整套视图态按 doc 应用（applyState 转发壳），恢复快照 docId 不匹配时的兜底。
    applyTreeViewState(doc: unknown): void;
    setCollapsedOutlineNodeIds(updater: (previous: Set<unknown>) => Set<unknown>): void;
    persistOutlineViewState(next: Set<unknown>): void;
  };
  selection: {
    getSelectedNode(): { id?: unknown; address?: unknown } | null;
    getSelectedNodeId(): unknown;
    setSelectedNodeId(id: unknown): void;
    setLocateRequest(updater: (previous: { seq?: number } | null | undefined) => Record<string, unknown>): void;
  };
  ui: {
    setNotice(message: string): void;
    getActiveTab(): string;
    setActiveTab(tab: string): void;
  };
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown } | null | undefined)?.message || error || '');
}

export function createTreeViewCommands(getDeps: () => TreeViewCommandDeps) {
  function treeActionNode(nodeId: unknown): TreeActionNode | null {
    const currentDoc = getDeps().getCurrentDoc();
    return (findNode(currentDoc?.tree, nodeId) || currentDoc?.treeIndex?.nodeOf?.(nodeId) || null) as TreeActionNode | null;
  }

  function treeActionHasChildren(node: TreeActionNode | null | undefined) {
    if (!node) return false;
    const currentDoc = getDeps().getCurrentDoc();
    return hasKnownChildren(node as Parameters<typeof hasKnownChildren>[0]) || Boolean(currentDoc?.treeIndex?.hasChildren?.(node.id));
  }

  function treeActionDescendants(node: TreeActionNode | null | undefined): TreeActionNode[] {
    if (!node) return [];
    if (Array.isArray(node.children)) return flattenTree(node) as TreeActionNode[];
    return [node];
  }

  async function toggleCollapsed(nodeId: unknown, options: ToggleOptions = {}) {
    const deps = getDeps();
    const { tree, docState } = deps;
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
    const depthLimit = tree.getDepthLimit();
    const nextCollapsed = new Set(tree.getCollapsed());
    const nextExpanded = new Set(tree.getExpanded());
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
    if (nextCollapsed.has(nodeId as string)) {
      nextCollapsed.delete(nodeId as string);
      if (nodeDepth >= depthLimit) nextExpanded.add(nodeId as string);
      expandedNode = true;
    } else if (nextExpanded.has(nodeId as string) || nodeDepth < depthLimit) {
      nextCollapsed.add(nodeId as string);
      for (const item of treeActionDescendants(node)) nextExpanded.delete(item.id as string);
    } else {
      nextExpanded.add(nodeId as string);
      expandedNode = true;
    }
    if (expandedNode && options.promoteDepth !== false) {
      tree.setPersistedTreeViewAfterExpansion(depthLimit, nextCollapsed, nextExpanded);
    } else {
      tree.setPersistedTreeView(depthLimit, nextCollapsed, nextExpanded);
    }
  }

  async function expandNodeOneLevel(nodeId: unknown, options: ToggleOptions = {}) {
    const deps = getDeps();
    const { tree, docState } = deps;
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
    const depthLimit = tree.getDepthLimit();
    const nextCollapsed = new Set(tree.getCollapsed());
    const nextExpanded = new Set(tree.getExpanded());
    const maxDepth = Math.max(1, Math.floor(Number(options.maxDepth || tree.getActualMaxDepth() || fullDepthForDoc(deps.getCurrentDoc() as Parameters<typeof fullDepthForDoc>[0])) || 1));
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
    nextCollapsed.delete(node.id as string);
    nextExpanded.add(node.id as string);
    tree.setPersistedTreeViewAfterExpansion(nextDepthLimit, nextCollapsed, nextExpanded);
  }

  async function focusNodeInDoc(
    doc: TreeViewDocLike | null | undefined,
    node: { id?: unknown; address?: unknown; [extra: string]: unknown } | null | undefined
  ) {
    const deps = getDeps();
    const { tree, selection, ui } = deps;
    if (!doc?.tree || !node?.id) return false;
    const nodeAddress = String(node.address || '1');
    selection.setSelectedNodeId(node.id);
    // 节点视图（树/IDE/富文本）内就地定位；仅从实体/搜索等非节点视图才切到树视图。
    const activeTab = ui.getActiveTab();
    if (activeTab !== 'tree' && activeTab !== 'ide' && activeTab !== 'rich') ui.setActiveTab('tree');
    const baseState = normalizeDocId(doc?.doc?.id) === normalizeDocId(deps.getCurrentDoc()?.doc?.id)
      ? { depthLimit: tree.getDepthLimit(), collapsed: tree.getCollapsed(), expanded: tree.getExpanded() }
      : treeViewStateFromDoc(doc as Parameters<typeof treeViewStateFromDoc>[0], fullDepthForDoc(doc as Parameters<typeof fullDepthForDoc>[0]));
    const nextDepthLimit = baseState.depthLimit;
    const nextCollapsed = new Set(baseState.collapsed);
    const nextExpanded = new Set(baseState.expanded);
    const ancestorIds = [];
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
      nextCollapsed.delete(ancestorId as string);
      if (index + 1 >= nextDepthLimit) nextExpanded.add(ancestorId as string);
    }
    tree.setPersistedTreeView(nextDepthLimit, nextCollapsed as Set<string>, nextExpanded as Set<string>, doc?.doc?.id);
    selection.setLocateRequest((previous) => ({
      seq: (previous?.seq || 0) + 1,
      nodeId: node.id,
      address: nodeAddress
    }));
    return true;
  }

  async function selectNodeAndOpenTree(nodeId: unknown, result: { address?: unknown; [extra: string]: unknown } = {}) {
    const deps = getDeps();
    if (!nodeId) return;
    const address = String(result?.address || '').trim();
    // 先确保目标深度的数据已加载，再走统一就地定位（从搜索/实体这类非节点视图会切到树视图）。
    if (address) {
      const targetDepth = depthOf(address);
      const currentDoc = deps.getCurrentDoc();
      if (loadedDepthForDoc(currentDoc as Parameters<typeof loadedDepthForDoc>[0]) < targetDepth && currentDoc?.doc?.id) {
        try {
          // 扩散加载下「定位」= 聚焦目标并沿 DFS 取祖先链/邻窗（不再按深度整层预拉）。
          await deps.docState.ensureNodeChildren(nodeId);
        } catch (error) {
          deps.ui.setNotice(errorMessage(error));
        }
      }
    }
    // 取加载后的最新投影（deps 是发起时快照，须经 getDeps() 重取）；findNode 落空时用
    // { id, address } 兜底，focusNodeInDoc 按 address 展开祖先链仍能完成定位。
    const currentDoc = getDeps().getCurrentDoc();
    const node = findNode(currentDoc?.tree, nodeId) || { id: nodeId, address: address || '1' };
    await focusNodeInDoc(currentDoc, node as Parameters<typeof focusNodeInDoc>[1]);
  }

  function locateSelectedNode() {
    const deps = getDeps();
    // 16-3：统一走就地定位，由当前视图自己滚动到目标，不强制切视图。
    void focusNodeInDoc(deps.getCurrentDoc(), deps.selection.getSelectedNode());
  }

  async function jumpToCurrentDocAddress(rawAddress: unknown) {
    const deps = getDeps();
    const address = String(rawAddress || '').trim();
    if (!address) return { ok: false, message: '请输入节点地址。' };
    const currentDoc = deps.getCurrentDoc();
    const docId = normalizeDocId(currentDoc?.doc?.id);
    if (!docId || !currentDoc?.tree) return { ok: false, message: '当前没有打开文档。' };
    const nodeId = currentDoc.idByAddress?.[address];
    let node = nodeId ? findNode(currentDoc.tree, nodeId) : null;
    if (!node && documentRepository.canRead()) {
      try { node = await documentRepository.getNode({ docId, address }) as typeof node; } catch { /* 后端查不到走下方统一提示 */ }
    }
    if (!node?.id) return { ok: false, message: `当前文档没有节点 ${address}。` };
    await focusNodeInDoc(currentDoc, node as Parameters<typeof focusNodeInDoc>[1]);
    return { ok: true };
  }

  function toggleOutlineNode(nodeId: unknown) {
    const { tree } = getDeps();
    tree.setCollapsedOutlineNodeIds((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      tree.persistOutlineViewState(next);
      return next;
    });
  }

  // ─── editor history 的视图态接口（editor-commands deps.view 的实现，阶段 1 预留的接缝） ───

  function editorHistoryViewState(targetDocId: unknown = getDeps().getCurrentDoc()?.doc?.id) {
    const deps = getDeps();
    const docId = normalizeDocId(targetDocId);
    if (!docId) return null;
    return {
      docId,
      activeTab: deps.ui.getActiveTab(),
      depthLimit: deps.tree.getDepthLimit(),
      collapsedNodeIds: [...deps.tree.getCollapsed()].map(normalizeDocId).filter(Boolean),
      expandedNodeIds: [...deps.tree.getExpanded()].map(normalizeDocId).filter(Boolean),
      selectedNodeId: normalizeDocId(deps.selection.getSelectedNode()?.id || deps.selection.getSelectedNodeId())
    };
  }

  function applyEditorHistoryViewState(viewState: unknown, doc: unknown) {
    const deps = getDeps();
    const state = normalizeEditorHistoryViewState(viewState);
    const docObj = (doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
    const docDoc = docObj.doc as { id?: unknown } | null | undefined;
    const docId = normalizeDocId(docDoc?.id || deps.getCurrentDoc()?.doc?.id);
    if (!state || !sameDocId(state.docId, docId)) {
      if (doc) deps.tree.applyTreeViewState(doc);
      return;
    }
    const nextDepthLimit = clampDepthLimit(state.depthLimit, fullDepthForDoc((doc || deps.getCurrentDoc()) as Parameters<typeof fullDepthForDoc>[0]));
    if (state.activeTab) deps.ui.setActiveTab(state.activeTab);
    deps.tree.setPersistedTreeView(
      nextDepthLimit,
      idSetFromArray(state.collapsedNodeIds),
      idSetFromArray(state.expandedNodeIds),
      state.docId
    );
    if (state.selectedNodeId) {
      const treeIndex = docObj.treeIndex as { nodeOf?: (id: unknown) => { id?: unknown } | null | undefined } | undefined;
      const node = findNode(docObj.tree, state.selectedNodeId) || treeIndex?.nodeOf?.(state.selectedNodeId);
      deps.selection.setSelectedNodeId(node?.id || state.selectedNodeId);
    }
  }

  async function applyEditorHistoryEffect(
    effect: unknown,
    doc: unknown,
    options: { minDepth?: number | string } = {}
  ) {
    const deps = getDeps();
    const normalized = normalizeEditorHistoryEffect(effect, deps.getCurrentDoc()?.doc?.id);
    const docObj = (doc && typeof doc === 'object' ? doc : {}) as { doc?: { id?: unknown } };
    if (!normalized || !sameDocId(normalized.docId, docObj.doc?.id || deps.getCurrentDoc()?.doc?.id)) return false;
    if (normalized.kind === 'expandNodeOne') {
      const requestedMinDepth = Math.max(
        Math.floor(Number(normalized.minDepth) || 0),
        Math.floor(Number(options.minDepth) || 0)
      );
      const maxDepth = fullDepthForDoc((doc || deps.getCurrentDoc()) as Parameters<typeof fullDepthForDoc>[0]);
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

  return {
    toggleCollapsed,
    expandNodeOneLevel,
    focusNodeInDoc,
    selectNodeAndOpenTree,
    locateSelectedNode,
    jumpToCurrentDocAddress,
    toggleOutlineNode,
    editorHistoryViewState,
    applyEditorHistoryViewState,
    applyEditorHistoryEffect
  };
}

export type TreeViewCommands = ReturnType<typeof createTreeViewCommands>;
