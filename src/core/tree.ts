import { FlatTree, isFlatTree } from './flat-tree.js';
import { toTreeNode } from './node-model.js';
import { splitSentences as splitSentencesCore } from './sentence-split.js';

export { NODE_TYPES } from './node-model.js';

export interface TreeNodeLike {
  id: unknown;
  address?: unknown;
  children?: TreeNodeLike[];
  text?: unknown;
  nodeType?: unknown;
  sortOrder?: number;
  parentId?: unknown;
  depth?: number;
}

export function splitSentences(text: unknown, options: Record<string, unknown> = {}): string[] {
  return splitSentencesCore(text, { ...options, hardLineBreaks: true });
}

/**
 * @deprecated Use buildFlatTree(rows) for large documents. This nested object
 * tree remains for small documents, inspectors, and compatibility paths.
 */
export function buildTree(rows: unknown[]): TreeNodeLike | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const byId = new Map<string, TreeNodeLike>();
  const childrenByParent = new Map<string | null, TreeNodeLike[]>();

  for (const row of rows) {
    const base = toTreeNode(row as Record<string, unknown>);
    if (!base) continue;
    const node: TreeNodeLike = { ...base, children: [] };
    byId.set(node.id as string, node);

    const parentKey = (node.parentId as string) ?? null;
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    childrenByParent.get(parentKey)!.push(node);
  }

  for (const children of childrenByParent.values()) {
    children.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.id).localeCompare(String(b.id)));
  }

  const roots = childrenByParent.get(null) || [];
  const root = roots[0];
  if (!root) return null;

  function attach(node: TreeNodeLike, address: string): TreeNodeLike {
    node.address = node.address || address;
    node.depth = (node.depth as number) || String(node.address || address).split('-').filter(Boolean).length || 1;
    const children = childrenByParent.get(String(node.id)) || [];
    node.children = children.map((child, index) => attach(child, `${address}-${index + 1}`));
    return node;
  }

  return attach(root, '1');
}

export function buildFlatTree(rows: unknown[]): FlatTree {
  return FlatTree.fromRows(rows as Parameters<typeof FlatTree.fromRows>[0]);
}

export function flattenTree(root: unknown): TreeNodeLike[] {
  if (isFlatTree(root)) {
    return (root as FlatTree).slotsPreOrder().map((slot) => (root as FlatTree).rowAtSlot(slot) as unknown as TreeNodeLike).filter(Boolean);
  }
  if (!root) return [];
  const rows: TreeNodeLike[] = [];
  const stack: TreeNodeLike[] = [root as TreeNodeLike];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    rows.push(node);
    const children = node.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  return rows;
}

export function maxTreeDepth(root: unknown): number {
  if (isFlatTree(root)) {
    let maxDepth = 1;
    const ft = root as FlatTree;
    for (let slot = 0; slot < ft.length; slot += 1) {
      maxDepth = Math.max(maxDepth, ft.depths[slot] || 1);
    }
    return maxDepth;
  }
  if (!root) return 1;
  let maxDepth = 1;
  const stack: TreeNodeLike[] = [root as TreeNodeLike];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    maxDepth = Math.max(maxDepth, String(node.address || '1').split('-').length);
    const children = node.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return maxDepth;
}

export function findNode(root: unknown, nodeId: unknown): TreeNodeLike | null {
  if (isFlatTree(root)) {
    const ft = root as FlatTree;
    const slot = ft.slotOf(nodeId);
    return slot >= 0 ? ft.rowAtSlot(slot) as unknown as TreeNodeLike : null;
  }
  if (!root) return null;
  const stack: TreeNodeLike[] = [root as TreeNodeLike];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.id === nodeId || String(node.id) === String(nodeId)) return node;
    const children = node.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return null;
}

export function collectDescendantText(node: unknown, options: Record<string, unknown> = {}): string {
  if (!node) return '';
  const parts: string[] = [];
  const limit = Math.max(0, Math.floor(Number(options.limit) || 0));
  let total = 0;
  const stack: TreeNodeLike[] = [node as TreeNodeLike];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const text = String(current.text || '').trim();
    if (text) {
      const separatorLength = parts.length > 0 ? 2 : 0;
      if (limit > 0 && total + separatorLength + text.length > limit) {
        const remaining = Math.max(0, limit - total - separatorLength);
        if (remaining > 0) parts.push(text.slice(0, remaining));
        break;
      }
      parts.push(text);
      total += separatorLength + text.length;
    }
    const children = current.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  return parts.join('\n\n');
}

export function resolveDisplayChildren(node: unknown): TreeNodeLike[] {
  if (!node) return [];
  let current = node as TreeNodeLike;
  while (
    current.nodeType === 'TEXT' &&
    current.children?.length === 1 &&
    current.children[0].nodeType === 'TEXT'
  ) {
    current = current.children[0];
  }
  return current.children || [];
}

export function collectChainText(node: unknown): string {
  if (!node) return '';
  let text = String((node as TreeNodeLike).text || '');
  let current = node as TreeNodeLike;
  while (
    current.nodeType === 'TEXT' &&
    current.children?.length === 1 &&
    current.children[0].nodeType === 'TEXT'
  ) {
    current = current.children[0];
    if (current.text) text = text + '\n\n' + current.text;
  }
  return text;
}

export function getChainNodeIds(node: unknown): unknown[] {
  const ids: unknown[] = [(node as TreeNodeLike).id];
  let current = node as TreeNodeLike;
  while (
    current.nodeType === 'TEXT' &&
    current.children?.length === 1 &&
    current.children[0].nodeType === 'TEXT'
  ) {
    current = current.children[0];
    ids.push(current.id);
  }
  return ids;
}