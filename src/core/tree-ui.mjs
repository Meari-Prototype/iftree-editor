import { collectDescendantText, findNode, flattenTree } from './tree.mjs';

export function addressDepth(address = '1') {
  return String(address || '1').split('-').length;
}

export function nodeOwnText(node) {
  return String(node?.text || '').trim();
}

export function nodeSummaryText(node) {
  return collectDescendantText(node).trim() || nodeOwnText(node);
}

function hasLoadedChildren(node) {
  return Array.isArray(node?.children) && node.children.length > 0;
}

export function summaryTargetsForMode({ tree, selectedNodeId = null, selectedNodeIds = [], mode } = {}) {
  if (!tree) return [];

  if (mode === 'article') {
    return flattenTree(tree)
      .filter(hasLoadedChildren)
      .map((node) => ({ node, text: nodeSummaryText(node), summaryMode: 'node' }));
  }

  const explicitSelectedNodes = selectedNodesForSummary(tree, selectedNodeIds);
  const selectedNode = selectedNodeId ? findNode(tree, selectedNodeId) : explicitSelectedNodes[0] || null;

  if (mode === 'depth') {
    const selectedDepth = selectedNode ? addressDepth(selectedNode.address || '1') : 1;
    return flattenTree(tree)
      .filter((node) => addressDepth(node.address || '1') === selectedDepth)
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

function selectedNodesForSummary(tree, selectedNodeIds) {
  const values = selectedNodeIds instanceof Set ? [...selectedNodeIds] : selectedNodeIds;
  const ids = new Set((Array.isArray(values) ? values : [])
    .filter((id) => id !== null && id !== undefined));
  if (ids.size === 0) return [];
  return flattenTree(tree).filter((node) => ids.has(node.id) || ids.has(String(node.id)));
}

export function collapsedForDepthLimit({ tree, collapsed = new Set(), depthLimit } = {}) {
  if (!tree) return new Set();
  const limit = Math.max(1, Number(depthLimit) || 1);
  const collapsedIds = collapsed instanceof Set ? collapsed : new Set(collapsed || []);
  const next = new Set();

  for (const node of flattenTree(tree)) {
    if (!collapsedIds.has(node.id)) continue;
    if (addressDepth(node.address || '1') >= limit) next.add(node.id);
  }

  return next;
}
