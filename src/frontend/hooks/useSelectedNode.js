import { useMemo } from 'react';
import { findNode } from '../../core/tree.mjs';

export function useSelectedNode(doc, selectedNodeId) {
  return useMemo(() => {
    if (!doc?.tree) return null;
    return findNode(doc.tree, selectedNodeId) || doc.tree;
  }, [doc, selectedNodeId]);
}
