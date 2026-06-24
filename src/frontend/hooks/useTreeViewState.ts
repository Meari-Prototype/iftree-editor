// @ts-nocheck
import { useCallback, useMemo, useRef, useState } from 'react';

import {
  clampDepthLimit,
  docDepthStats,
  fullDepthForDoc,
  parseTreeViewState,
  promoteTreeViewDepthIfLayerExpanded
} from '../lib/doc-utils.js';

const EMPTY_SET = new Set();

function idArray(value) {
  return [...(value instanceof Set ? value : (value || []))];
}

// 退化为 session 转发壳：折叠/展开/深度/outline 的真相在 session.view（经 documentState 投影/动词）。
// 本 hook 不再持有它们的 useState，只保留两类本地态：
//   - axiomsCollapsed 从 doc.axioms_collapsed 派生（真相在 doc，写走 patchDocMeta / 写管道）；
//   - c2dDepthControlSeq/Action 是 C2D 地图视图的命令脉冲（非文档真相），本地自持。
// setVisibleDepth/persist/promote 等编排转发到 documentState.setViewSnapshot/setVisibleDepth。
export function useTreeViewState(documentState) {
  const currentDoc = documentState?.currentDoc ?? null;
  const view = documentState?.view ?? null;

  const depthLimit = view?.depthLimit ?? 1;
  const collapsed = view?.collapsed ?? EMPTY_SET;
  const expanded = view?.expanded ?? EMPTY_SET;
  const collapsedOutlineNodeIds = view?.outlineCollapsed ?? EMPTY_SET;
  const axiomsCollapsed = Boolean(currentDoc?.doc?.axioms_collapsed);

  const outlineCollapseDocRef = useRef(null);
  const [c2dDepthControlSeq, setC2dDepthControlSeq] = useState(0);
  const [c2dDepthControlAction, setC2dDepthControlAction] = useState('setDepth');

  const treeDepthStats = useMemo(
    () => docDepthStats(currentDoc),
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

  const setCollapsed = useCallback((next) => {
    const resolved = typeof next === 'function' ? next(view?.collapsed ?? EMPTY_SET) : next;
    documentState?.setViewSnapshot?.({ collapsedNodeIds: idArray(resolved) });
  }, [documentState, view]);

  const setExpanded = useCallback((next) => {
    const resolved = typeof next === 'function' ? next(view?.expanded ?? EMPTY_SET) : next;
    documentState?.setViewSnapshot?.({ expandedNodeIds: idArray(resolved) });
  }, [documentState, view]);

  const setDepthLimit = useCallback((next) => {
    const resolved = typeof next === 'function' ? next(view?.depthLimit ?? 1) : next;
    documentState?.setViewSnapshot?.({ depthLimit: resolved });
  }, [documentState, view]);

  const setCollapsedOutlineNodeIds = useCallback((next) => {
    const resolved = typeof next === 'function' ? next(view?.outlineCollapsed ?? EMPTY_SET) : next;
    documentState?.setViewSnapshot?.({ outlineCollapsedNodeIds: idArray(resolved) });
  }, [documentState, view]);

  const setAxiomsCollapsed = useCallback((value) => {
    const doc = documentState?.currentDoc?.doc;
    if (doc) documentState?.patchDocMeta?.({ doc: { ...doc, axioms_collapsed: Boolean(value) } });
  }, [documentState]);

  // 从 doc.tree_view_state 恢复（loadComplete 打开时已做；这里供编排显式恢复）。
  const applyState = useCallback((doc) => {
    documentState?.applyDocViewState?.(parseTreeViewState(doc?.doc?.tree_view_state));
  }, [documentState]);

  const persist = useCallback((nextDepthLimit, nextCollapsed, nextExpanded, _docId = undefined, nextOutline = undefined) => {
    documentState?.setViewSnapshot?.({
      depthLimit: nextDepthLimit,
      collapsedNodeIds: idArray(nextCollapsed),
      expandedNodeIds: idArray(nextExpanded),
      ...(nextOutline !== undefined ? { outlineCollapsedNodeIds: idArray(nextOutline) } : {})
    }, { persist: true });
  }, [documentState]);

  const setPersisted = persist;

  const setPersistedAfterExpansion = useCallback((nextDepthLimit, nextCollapsed, nextExpanded) => {
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

  const persistOutline = useCallback((outline) => {
    documentState?.setViewSnapshot?.({ outlineCollapsedNodeIds: idArray(outline) }, { persist: true });
  }, [documentState]);

  const setVisibleDepth = useCallback(async (nextValue, { clearAll = false, action = 'setDepth' }: any = {}) => {
    const nextDepth = clampDepthLimit(Number(nextValue) || 1, actualMaxDepth);
    if (clearAll) {
      documentState?.setViewSnapshot?.({ depthLimit: nextDepth, collapsedNodeIds: [], expandedNodeIds: [] }, { persist: true });
    } else {
      await documentState?.setVisibleDepth?.(nextDepth);
    }
    setC2dDepthControlAction(action || 'setDepth');
    setC2dDepthControlSeq((seq) => seq + 1);
  }, [documentState, actualMaxDepth]);

  const collapseVisibleDepthOne = useCallback(() => {
    setVisibleDepth(depthLimit - 1, { clearAll: true, action: 'collapseOne' });
  }, [setVisibleDepth, depthLimit]);

  const syncC2dVisibleDepth = useCallback((nextDepth) => {
    const resolved = clampDepthLimit(nextDepth, actualMaxDepth);
    documentState?.setViewSnapshot?.({ depthLimit: resolved });
  }, [documentState, actualMaxDepth]);

  return useMemo(() => ({
    depthLimit,
    axiomsCollapsed,
    collapsed,
    expanded,
    collapsedOutlineNodeIds,
    setDepthLimit,
    setAxiomsCollapsed,
    setCollapsed,
    setExpanded,
    setCollapsedOutlineNodeIds,
    outlineCollapseDocRef,
    actualMaxDepth,
    depthOptions,
    treeDepthStats,
    c2dDepthControlSeq,
    c2dDepthControlAction,
    setVisibleDepth,
    collapseVisibleDepthOne,
    syncC2dVisibleDepth,
    applyState,
    persist,
    persistOutline,
    setPersisted,
    setPersistedAfterExpansion
  }), [
    depthLimit, axiomsCollapsed, collapsed, expanded, collapsedOutlineNodeIds,
    setDepthLimit, setAxiomsCollapsed, setCollapsed, setExpanded, setCollapsedOutlineNodeIds,
    actualMaxDepth, depthOptions, treeDepthStats,
    c2dDepthControlSeq, c2dDepthControlAction,
    setVisibleDepth, collapseVisibleDepthOne, syncC2dVisibleDepth,
    applyState, persist, persistOutline, setPersistedAfterExpansion
  ]);
}
