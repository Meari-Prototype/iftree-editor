import { useMemo } from 'react';
import { findNode, type TreeNodeLike } from '../../core/tree.js';

interface DocumentWithTree {
  tree?: TreeNodeLike;
}

export function useSelectedNode(doc: DocumentWithTree | null | undefined, selectedNodeId: unknown): TreeNodeLike | null {
  return useMemo(() => {
    if (!doc?.tree) return null;
    return findNode(doc.tree, selectedNodeId) || doc.tree;
  }, [doc, selectedNodeId]);
}
