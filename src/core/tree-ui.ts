import { collectDescendantText, findNode, flattenTree } from './tree.js';

export function addressDepth(address: unknown = '1'): number {
  return String(address || '1').split('-').length;
}

interface TreeNodeLike {
  id?: unknown;
  address?: unknown;
  text?: unknown;
  children?: TreeNodeLike[];
}

interface SummaryTarget {
  node: TreeNodeLike;
  text: string;
  summaryMode: string;
}

export function nodeOwnText(node: TreeNodeLike | null | undefined): string {
  return String(node?.text || '').trim();
}

export function nodeSummaryText(node: TreeNodeLike): string {
  return collectDescendantText(node).trim() || nodeOwnText(node);
}

function hasLoadedChildren(node: TreeNodeLike): boolean {
  return Array.isArray(node?.children) && node.children.length > 0;
}

interface SummaryTargetsOptions {
  tree?: TreeNodeLike | null;
  selectedNodeId?: unknown;
  selectedNodeIds?: unknown[];
  mode?: string;
}

export function summaryTargetsForMode({ tree, selectedNodeId, selectedNodeIds, mode }: SummaryTargetsOptions = {}): SummaryTarget[] {
  if (!tree) return [];

  if (mode === 'article') {
    return flattenTree(tree)
      .filter(hasLoadedChildren)
      .map((node) => ({ node, text: nodeSummaryText(node), summaryMode: 'node' }));
  }

  const explicitSelectedNodes = selectedNodesForSummary(tree, selectedNodeIds);
  const selectedNode = selectedNodeId != null ? findNode(tree, String(selectedNodeId)) : explicitSelectedNodes[0] || null;

  if (mode === 'depth') {
    const selectedDepth = selectedNode ? addressDepth(selectedNode.address ?? '1') : 1;
    return flattenTree(tree)
      .filter((node) => addressDepth(node.address ?? '1') === selectedDepth)
      .map((node) => ({ node, text: nodeSummaryText(node), summaryMode: 'node' }));
  }

  if (!selectedNode) return [];

  if (mode === 'selected') {
    const nodes = explicitSelectedNodes.length ? explicitSelectedNodes : [selectedNode];
    return nodes.map((node) => ({ node, text: nodeOwnText(node), summaryMode: 'node' }));
  }

  if (mode === 'subtree') {
    const nodes = explicitSelectedNodes.length ? explicitSelectedNodes : [selectedNode];
    return nodes.map((node) => ({ node, text: nodeSummaryText(node), summaryMode: 'node' }));
  }

  return [];
}

function selectedNodesForSummary(tree: TreeNodeLike, selectedNodeIds: unknown): TreeNodeLike[] {
  const values = selectedNodeIds instanceof Set ? [...selectedNodeIds] : selectedNodeIds;
  const ids = new Set((Array.isArray(values) ? values : [])
    .filter((id) => id !== null && id !== undefined)
    .map(String));
  if (ids.size === 0) return [];
  return flattenTree(tree).filter((node) => ids.has(String(node.id)) || ids.has(String(node.id ?? '')));
}

interface CollapsedOptions {
  tree?: TreeNodeLike | null;
  collapsed?: Set<unknown> | unknown[];
  depthLimit?: number;
}

export function collapsedForDepthLimit({ tree, collapsed = new Set(), depthLimit }: CollapsedOptions = {}): Set<unknown> {
  if (!tree) return new Set();
  const limit = Math.max(1, Number(depthLimit) || 1);
  const collapsedIds: Set<unknown> = collapsed instanceof Set ? collapsed : new Set(collapsed || []);
  const next = new Set<unknown>();

  for (const node of flattenTree(tree)) {
    if (!collapsedIds.has(node.id)) continue;
    if (addressDepth(node.address ?? '1') >= limit) next.add(node.id);
  }

  return next;
}