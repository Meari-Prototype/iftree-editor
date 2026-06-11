import { useMemo, useRef, useState } from 'react';

import {
  fullDepthForDoc,
  normalizeDocId,
  promoteTreeViewDepthIfLayerExpanded,
  treeViewStateFromDoc,
  treeViewStatePayload
} from '../lib/doc-utils.mjs';
import { treeViewRepository } from '../data/repositories.js';

/** @param {{ currentDoc?: any, setCurrentDoc?: any, setNotice?: any }} [options] */
export function useTreeViewState({ currentDoc = null, setCurrentDoc, setNotice } = {}) {
  const [depthLimit, setDepthLimit] = useState(1);
  const [axiomsCollapsed, setAxiomsCollapsed] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());
  const [collapsedOutlineNodeIds, setCollapsedOutlineNodeIds] = useState(() => new Set());
  const outlineCollapseDocRef = useRef(null);

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
}
