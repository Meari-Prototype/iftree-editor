import { useCallback, useMemo } from 'react';

import {
  clampDepthLimit,
  docDepthStats,
  fullDepthForDoc,
  parseTreeViewState,
  promoteTreeViewDepthIfLayerExpanded,
  type DocLike
} from '../lib/doc-utils.js';

const EMPTY_SET = new Set<string>();

type IdSet = Set<unknown>;
type SetOrUpdater<T> = T | ((previous: T) => T);

// currentDoc 子集 alias 到 DocLike 真类型（沿数据流：useDocumentState 真返回 ProjectedDoc extends DocLike），
// 调用 docDepthStats/fullDepthForDoc/promoteTreeViewDepthIfLayerExpanded 时直接兼容、无需 cast。
type TreeViewDocument = DocLike;

// view 字段对齐 SessionView 真型 Set<string>（γ 阶段 5：不再 union Set<unknown>）；
// 输出侧（collapsed/expanded/collapsedOutlineNodeIds）随之是 Set<string>，消费方免 cast。
// setter 形参保持宽（IdSet=Set<unknown>）——输入宽、输出严是函数子类型的正确方向。
interface TreeViewDocumentState {
  currentDoc?: TreeViewDocument | null;
  view?: {
    depthLimit?: number;
    collapsed?: Set<string>;
    expanded?: Set<string>;
    outlineCollapsed?: Set<string>;
    c2dExpanded?: Set<string>;
  } | null;
  setViewSnapshot?: (patch: Record<string, unknown>, options?: Record<string, unknown>) => void;
  patchDocMeta?: (patch: Record<string, unknown>) => void;
  // 与 useDocumentState 真签名对齐：applyDocViewState 接 AnyRecord | null | undefined（不接 unknown，
  // 因 unknown 不是 AnyRecord 子类，逆变不兼容）。本 hook 内部只传 parseTreeViewState 返回值（同形态）。
  applyDocViewState?: (state: Record<string, unknown> | null | undefined) => void;
  setVisibleDepth?: (depth: number) => Promise<unknown>;
}

function idArray(value: unknown): unknown[] {
  return [...((value instanceof Set ? value : (value || [])) as Iterable<unknown>)];
}

// 退化为 session 转发壳：折叠/展开/深度/outline 的真相在 session.view（经 documentState 投影/动词）。
// 本 hook 不再持有它们的 useState，只保留 axiomsCollapsed 从 doc.axioms_collapsed 派生
// （真相在 doc，写走 patchDocMeta / 写管道）。
// setVisibleDepth/persist/promote 等编排转发到 documentState.setViewSnapshot/setVisibleDepth；
// C2D 地图的深度命令由 WorkspacePane 经 C2DMapHandle.applyDepthControl ref 调用下发
// （原 c2dDepthControlSeq/Action「seq 计数器当命令总线」已废除），本函数返回 resolved
// 目标深度供调用方转发给 handle。
export function useTreeViewState(documentState: TreeViewDocumentState | null | undefined) {
  const currentDoc = documentState?.currentDoc ?? null;
  const view = documentState?.view ?? null;

  const depthLimit = view?.depthLimit ?? 1;
  const collapsed = view?.collapsed ?? EMPTY_SET;
  const expanded = view?.expanded ?? EMPTY_SET;
  const collapsedOutlineNodeIds = view?.outlineCollapsed ?? EMPTY_SET;
  const c2dExpanded = view?.c2dExpanded ?? EMPTY_SET;
  const axiomsCollapsed = Boolean(currentDoc?.doc?.axioms_collapsed);

  const treeDepthStats = useMemo(
    () => docDepthStats(currentDoc) as { maxDepth: number; depths: unknown[] },
    [currentDoc?.doc?.id, currentDoc?.tree, currentDoc?.treeDepthStats]
  );
  const actualMaxDepth = treeDepthStats.maxDepth;
  const depthOptions = useMemo(() => (
    [...new Set((treeDepthStats.depths.length > 0
      ? treeDepthStats.depths
      : Array.from({ length: actualMaxDepth }, (_, index) => index + 1))
      .map((depth) => Math.floor(Number(depth) || 0))
      .filter((depth) => depth > 0 && depth <= actualMaxDepth))]
      .sort((left, right) => Number(left) - Number(right))
  ), [actualMaxDepth, treeDepthStats]);

  const setCollapsed = useCallback((next: SetOrUpdater<IdSet>) => {
    const resolved = typeof next === 'function' ? next((view?.collapsed ?? EMPTY_SET) as IdSet) : next;
    documentState?.setViewSnapshot?.({ collapsedNodeIds: idArray(resolved) });
  }, [documentState, view]);

  const setExpanded = useCallback((next: SetOrUpdater<IdSet>) => {
    const resolved = typeof next === 'function' ? next((view?.expanded ?? EMPTY_SET) as IdSet) : next;
    documentState?.setViewSnapshot?.({ expandedNodeIds: idArray(resolved) });
  }, [documentState, view]);

  const setDepthLimit = useCallback((next: number | ((previous: number) => number)) => {
    const resolved = typeof next === 'function' ? next(view?.depthLimit ?? 1) : next;
    documentState?.setViewSnapshot?.({ depthLimit: resolved });
  }, [documentState, view]);

  const setCollapsedOutlineNodeIds = useCallback((next: SetOrUpdater<IdSet>) => {
    const resolved = typeof next === 'function' ? next((view?.outlineCollapsed ?? EMPTY_SET) as IdSet) : next;
    documentState?.setViewSnapshot?.({ outlineCollapsedNodeIds: idArray(resolved) });
  }, [documentState, view]);

  // C2D 展开列（address 键）受控写点：真相在 session view，不随后端持久化（组件 localStorage
  // hotspot 播种）。C2DMapView 上抛整集，无函数式更新需求。
  const setC2dExpanded = useCallback((next: Set<string>) => {
    documentState?.setViewSnapshot?.({ c2dExpandedAddresses: [...next] });
  }, [documentState]);

  const setAxiomsCollapsed = useCallback((value: unknown) => {
    const doc = documentState?.currentDoc?.doc;
    if (doc) documentState?.patchDocMeta?.({ doc: { ...doc, axioms_collapsed: Boolean(value) } });
  }, [documentState]);

  // 从 doc.tree_view_state 恢复（loadComplete 打开时已做；这里供编排显式恢复）。
  // 形参接 unknown 兼容 AppBody 的 IPC 边界形态，内部 narrow 后访问 doc.tree_view_state。
  const applyState = useCallback((doc: unknown) => {
    const docObj = (doc && typeof doc === 'object' ? doc : null) as TreeViewDocument | null;
    documentState?.applyDocViewState?.(parseTreeViewState(docObj?.doc?.tree_view_state));
  }, [documentState]);

  const persist = useCallback((nextDepthLimit: unknown, nextCollapsed: unknown, nextExpanded: unknown, _docId: unknown = undefined, nextOutline: unknown = undefined) => {
    documentState?.setViewSnapshot?.({
      depthLimit: nextDepthLimit,
      collapsedNodeIds: idArray(nextCollapsed),
      expandedNodeIds: idArray(nextExpanded),
      ...(nextOutline !== undefined ? { outlineCollapsedNodeIds: idArray(nextOutline) } : {})
    }, { persist: true });
  }, [documentState]);

  const setPersisted = persist;

  const setPersistedAfterExpansion = useCallback((
    nextDepthLimit: number,
    nextCollapsed: Set<unknown> | unknown[] | null | undefined,
    nextExpanded: Set<unknown> | unknown[] | null | undefined
  ) => {
    // 保留 promote（展开整层自动提深度），与旧行为一致；用已投影 tree 判断。
    const promoted = promoteTreeViewDepthIfLayerExpanded(
      currentDoc?.tree, nextDepthLimit, nextCollapsed, nextExpanded, fullDepthForDoc(currentDoc)
    );
    const target = promoted || { depthLimit: nextDepthLimit, collapsed: nextCollapsed, expanded: nextExpanded };
    documentState?.setViewSnapshot?.({
      depthLimit: target.depthLimit,
      collapsedNodeIds: idArray(target.collapsed),
      expandedNodeIds: idArray(target.expanded)
    }, { persist: true });
  }, [documentState, currentDoc]);

  const persistOutline = useCallback((outline: unknown) => {
    documentState?.setViewSnapshot?.({ outlineCollapsedNodeIds: idArray(outline) }, { persist: true });
  }, [documentState]);

  const setVisibleDepth = useCallback(async (nextValue: unknown, { clearAll = false }: { clearAll?: boolean; action?: string } = {}) => {
    const nextDepth = clampDepthLimit(Number(nextValue) || 1, actualMaxDepth);
    if (clearAll) {
      documentState?.setViewSnapshot?.({ depthLimit: nextDepth, collapsedNodeIds: [], expandedNodeIds: [] }, { persist: true });
    } else {
      await documentState?.setVisibleDepth?.(nextDepth);
    }
    return nextDepth;
  }, [documentState, actualMaxDepth]);

  const collapseVisibleDepthOne = useCallback(() => {
    return setVisibleDepth(depthLimit - 1, { clearAll: true });
  }, [setVisibleDepth, depthLimit]);

  const syncC2dVisibleDepth = useCallback((nextDepth: number) => {
    const resolved = clampDepthLimit(nextDepth, actualMaxDepth);
    documentState?.setViewSnapshot?.({ depthLimit: resolved });
  }, [documentState, actualMaxDepth]);

  return useMemo(() => ({
    depthLimit,
    axiomsCollapsed,
    collapsed,
    expanded,
    collapsedOutlineNodeIds,
    c2dExpanded,
    setDepthLimit,
    setAxiomsCollapsed,
    setCollapsed,
    setExpanded,
    setCollapsedOutlineNodeIds,
    setC2dExpanded,
    actualMaxDepth,
    depthOptions,
    treeDepthStats,
    setVisibleDepth,
    collapseVisibleDepthOne,
    syncC2dVisibleDepth,
    applyState,
    persist,
    persistOutline,
    setPersisted,
    setPersistedAfterExpansion
  }), [
    depthLimit, axiomsCollapsed, collapsed, expanded, collapsedOutlineNodeIds, c2dExpanded,
    setDepthLimit, setAxiomsCollapsed, setCollapsed, setExpanded, setCollapsedOutlineNodeIds, setC2dExpanded,
    actualMaxDepth, depthOptions, treeDepthStats,
    setVisibleDepth, collapseVisibleDepthOne, syncC2dVisibleDepth,
    applyState, persist, persistOutline, setPersistedAfterExpansion
  ]);
}
