// @ts-nocheck
import { useCallback, useMemo, useState } from 'react';

import { findNode } from '../../core/tree.js';

const EMPTY_SET = new Set();

function selectedNodeForDoc(doc, selectedNodeId) {
  if (!doc?.tree) return null;
  return findNode(doc.tree, selectedNodeId) || doc.tree;
}

// 退化为 session 转发壳：selectedId / multiSelected 的真相在 session.view（经 documentState 投影/动词），
// 本 hook 不再持有它们的 useState。只 locateRequest（命令视图滚动的一次性脉冲，非文档真相）仍本地自持。
export function useNodeSelection(documentState) {
  const currentDoc = documentState?.currentDoc ?? null;
  const view = documentState?.view ?? null;
  const setSelectedNodeId = documentState?.selectNode;
  const setMultiSelectedNodeIds = documentState?.setMultiSelected;
  const selectedNodeId = view?.selectedId ?? null;
  const multiSelectedNodeIds = view?.multiSelected ?? EMPTY_SET;

  const [locateRequest, setLocateRequest] = useState({ seq: 0, nodeId: null });

  const selectedNode = useMemo(
    () => selectedNodeForDoc(currentDoc, selectedNodeId),
    [currentDoc, selectedNodeId]
  );

  const locate = useCallback((nodeId) => {
    setLocateRequest((previous) => ({ seq: previous.seq + 1, nodeId }));
  }, []);

  const select = useCallback((nodeId) => {
    setSelectedNodeId?.(nodeId ?? null);
  }, [setSelectedNodeId]);

  const selectAndLocate = useCallback((nodeId) => {
    setSelectedNodeId?.(nodeId ?? null);
    setLocateRequest((previous) => ({ seq: previous.seq + 1, nodeId }));
  }, [setSelectedNodeId]);

  const clearMulti = useCallback(() => {
    setMultiSelectedNodeIds?.(new Set());
  }, [setMultiSelectedNodeIds]);

  const reset = useCallback((doc = currentDoc) => {
    setSelectedNodeId?.(doc?.tree?.id || null);
    setMultiSelectedNodeIds?.(new Set());
    setLocateRequest({ seq: 0, nodeId: null });
  }, [currentDoc, setSelectedNodeId, setMultiSelectedNodeIds]);

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
    selectedNodeId,
    setSelectedNodeId,
    setMultiSelectedNodeIds
  ]);
}
