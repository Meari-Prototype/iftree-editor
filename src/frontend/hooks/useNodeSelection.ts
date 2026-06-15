import { useCallback, useMemo, useState } from 'react';

import { findNode } from '../../core/tree.mjs';

function selectedNodeForDoc(doc, selectedNodeId) {
  if (!doc?.tree) return null;
  return findNode(doc.tree, selectedNodeId) || doc.tree;
}

export function useNodeSelection(currentDoc) {
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [multiSelectedNodeIds, setMultiSelectedNodeIds] = useState(() => new Set());
  const [locateRequest, setLocateRequest] = useState({ seq: 0, nodeId: null });

  const selectedNode = useMemo(
    () => selectedNodeForDoc(currentDoc, selectedNodeId),
    [currentDoc, selectedNodeId]
  );

  const clearMulti = useCallback(() => {
    setMultiSelectedNodeIds(new Set());
  }, []);

  const locate = useCallback((nodeId) => {
    setLocateRequest((previous) => ({
      seq: previous.seq + 1,
      nodeId
    }));
  }, []);

  const select = useCallback((nodeId) => {
    setSelectedNodeId(nodeId ?? null);
  }, []);

  const selectAndLocate = useCallback((nodeId) => {
    setSelectedNodeId(nodeId ?? null);
    setLocateRequest((previous) => ({
      seq: previous.seq + 1,
      nodeId
    }));
  }, []);

  const reset = useCallback((doc = currentDoc) => {
    setSelectedNodeId(doc?.tree?.id || null);
    setMultiSelectedNodeIds(new Set());
    setLocateRequest({ seq: 0, nodeId: null });
  }, [currentDoc]);

  return useMemo(() => ({
    selectedNodeId,
    selectedNode,
    multiSelectedNodeIds,
    locateRequest,
    setSelectedNodeId,
    setMultiSelectedNodeIds,
    setLocateRequest,
    locate,
    reset,
    select,
    selectAndLocate,
    clearMulti
  }), [
    clearMulti,
    locate,
    locateRequest,
    multiSelectedNodeIds,
    reset,
    select,
    selectAndLocate,
    selectedNode,
    selectedNodeId
  ]);
}
