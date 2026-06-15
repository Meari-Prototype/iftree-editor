import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  clampDepthLimit,
  docDepthStats,
  fullDepthForDoc,
  loadedDepthForDoc,
  normalizeDocId,
  promoteTreeViewDepthIfLayerExpanded,
  sameDocId,
  treeViewStateFromDoc,
  treeViewStatePayload
} from '../lib/doc-utils.mjs';
import { treeViewRepository } from '../data/repositories.js';

/** @param {{ currentDoc?: any, setCurrentDoc?: any, setNotice?: any, setProgress?: any, setOperationLock?: any, loadTreeDepth?: any }} [options] */
export function useTreeViewState({ currentDoc = null, setCurrentDoc, setNotice, setProgress, setOperationLock, loadTreeDepth } = {}) {
  const [depthLimit, setDepthLimit] = useState(1);
  const [axiomsCollapsed, setAxiomsCollapsed] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());
  const [collapsedOutlineNodeIds, setCollapsedOutlineNodeIds] = useState(() => new Set());
  const outlineCollapseDocRef = useRef(null);
  // C2D 深度控制脉冲：seq 自增触发地图视图执行一次 action（setDepth/collapseOne）。
  const [c2dDepthControlSeq, setC2dDepthControlSeq] = useState(0);
  const [c2dDepthControlAction, setC2dDepthControlAction] = useState('setDepth');

  const treeDepthStats = useMemo(() => docDepthStats(currentDoc), [currentDoc?.doc?.id, currentDoc?.tree, currentDoc?.treeDepthStats]);
  const actualMaxDepth = treeDepthStats.maxDepth;
  const depthOptions = useMemo(() => (
    [...new Set((treeDepthStats.depths.length > 0
      ? treeDepthStats.depths
      : Array.from({ length: actualMaxDepth }, (_, index) => index + 1))
      .map((depth) => Math.floor(Number(depth) || 0))
      .filter((depth) => depth > 0 && depth <= actualMaxDepth))]
      .sort((left, right) => left - right)
  ), [actualMaxDepth, treeDepthStats]);

  useEffect(() => {
    setDepthLimit((value) => clampDepthLimit(value, actualMaxDepth));
  }, [actualMaxDepth, currentDoc?.tree]);

  function applyState(doc) {
    const maxDepth = fullDepthForDoc(doc);
    const state = treeViewStateFromDoc(doc, maxDepth);
    setDepthLimit(state.depthLimit);
    setCollapsed(state.collapsed);
    setExpanded(state.expanded);
    setCollapsedOutlineNodeIds(state.outlineCollapsed || new Set());
  }

  function persist(nextDepthLimit, nextCollapsed, nextExpanded, targetDocId = currentDoc?.doc?.id, nextOutlineCollapsed = collapsedOutlineNodeIds) {
    const docId = normalizeDocId(targetDocId);
    if (!docId || !treeViewRepository.canSaveTreeViewState()) return;
    const state = treeViewStatePayload(nextDepthLimit, nextCollapsed, nextExpanded, nextOutlineCollapsed);
    treeViewRepository.saveTreeViewState({
      docId,
      state
    }).then((updated) => {
      if (!updated?.doc) return;
      setCurrentDoc?.((current) => (
        normalizeDocId(current?.doc?.id) === normalizeDocId(docId)
          ? { ...current, doc: { ...current.doc, tree_view_state: updated.doc.tree_view_state } }
          : current
      ));
    }).catch((error) => setNotice?.(error.message));
  }

  function persistOutline(outlineCollapsed) {
    persist(depthLimit, collapsed, expanded, currentDoc?.doc?.id, outlineCollapsed);
  }

  function setPersisted(nextDepthLimit, nextCollapsed, nextExpanded, targetDocId = currentDoc?.doc?.id) {
    setDepthLimit(nextDepthLimit);
    setCollapsed(new Set(nextCollapsed));
    setExpanded(new Set(nextExpanded));
    persist(nextDepthLimit, nextCollapsed, nextExpanded, targetDocId);
  }

  function setPersistedAfterExpansion(nextDepthLimit, nextCollapsed, nextExpanded) {
    const promoted = promoteTreeViewDepthIfLayerExpanded(
      currentDoc?.tree,
      nextDepthLimit,
      nextCollapsed,
      nextExpanded,
      fullDepthForDoc(currentDoc)
    );
    if (promoted) {
      setPersisted(promoted.depthLimit, promoted.collapsed, promoted.expanded);
      return;
    }
    setPersisted(nextDepthLimit, nextCollapsed, nextExpanded);
  }

  async function resolveVisibleDepth(nextValue) {
    const requestedDepth = Math.max(1, Math.floor(Number(nextValue) || 1));
    return clampDepthLimit(requestedDepth, actualMaxDepth);
  }

  async function setVisibleDepth(nextValue, { clearAll = false, restoreLocalFirst = false, action = 'setDepth' } = {}) {
    try {
      const hasLocalTreeState = !clearAll && (collapsed.size > 0 || expanded.size > 0);
      if (restoreLocalFirst && hasLocalTreeState) {
        setPersisted(depthLimit, new Set(), new Set());
        return;
      }
      const nextDepth = await resolveVisibleDepth(nextValue);
      if (!nextDepth) {
        if (hasLocalTreeState) setPersisted(depthLimit, new Set(), new Set());
        return;
      }
      const nextExpanded = new Set();
      const nextCollapsed = new Set();
      applyVisibleTreeDepth(nextDepth, nextCollapsed, nextExpanded, action).catch((error) => {
        setNotice?.(error.message);
        setProgress?.(null);
        setOperationLock?.(null);
      });
    } catch (error) {
      setNotice?.(error.message);
      setProgress?.(null);
      setOperationLock?.(null);
    }
  }

  async function applyVisibleTreeDepth(nextDepth, nextCollapsed, nextExpanded, action = 'setDepth') {
    const unlockOnDone = () => {
      setProgress?.(null);
      setOperationLock?.(null);
    };
    try {
      const doc = await loadTreeDepth(nextDepth);
      const resolvedDoc = sameDocId(doc?.doc?.id, currentDoc?.doc?.id)
        ? {
            ...currentDoc,
            ...doc,
            tree: loadedDepthForDoc(doc) >= loadedDepthForDoc(currentDoc) ? doc?.tree : currentDoc?.tree,
            nodes: doc?.nodes?.length ? doc.nodes : currentDoc?.nodes
          }
        : (doc || currentDoc);
      if (resolvedDoc) setCurrentDoc?.(resolvedDoc);
      setPersisted(nextDepth, nextCollapsed, nextExpanded);
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

  const base = useMemo(() => ({
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
    applyState,
    persist,
    persistOutline,
    setPersisted,
    setPersistedAfterExpansion
  }), [
    axiomsCollapsed,
    collapsed,
    collapsedOutlineNodeIds,
    depthLimit,
    expanded,
    currentDoc
  ]);

  // 深度控制函数每渲染重建（闭包始终取最新 currentDoc/loadTreeDepth），不进 memo。
  return {
    ...base,
    treeDepthStats,
    actualMaxDepth,
    depthOptions,
    c2dDepthControlSeq,
    c2dDepthControlAction,
    setVisibleDepth,
    collapseVisibleDepthOne,
    syncC2dVisibleDepth
  };
}
