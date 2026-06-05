import { FlatTree, isFlatTree } from './flat-tree.mjs';
import { toTreeNode } from './node-model.mjs';

const SENTENCE_PATTERN = /([^。？！.!?\r\n]+[。？！.!?]?)/g;

export { NODE_TYPES } from './node-model.mjs';

export function splitSentences(text) {
  if (!text || !text.trim()) return [];

  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const sentences = [];

  for (const line of normalized.split('\n')) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;

    const matches = [...trimmedLine.matchAll(SENTENCE_PATTERN)].map((match) => match[1].trim());
    if (matches.length === 0) {
      sentences.push(trimmedLine);
      continue;
    }

    for (const sentence of matches) {
      if (sentence.length > 1) sentences.push(sentence);
    }
  }

  return sentences;
}

/**
 * @deprecated Use buildFlatTree(rows) for large documents. This nested object
 * tree remains for small documents, inspectors, and compatibility paths.
 */
export function buildTree(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const byId = new Map();
  const childrenByParent = new Map();

  for (const row of rows) {
    const base = toTreeNode(row);
    if (!base) continue;
    const node = { ...base, children: [] };
    byId.set(node.id, node);

    const parentKey = node.parentId ?? null;
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    childrenByParent.get(parentKey).push(node);
  }

  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.sortOrder - b.sortOrder || String(a.id).localeCompare(String(b.id)));
  }

  const roots = childrenByParent.get(null) || [];
  const root = roots[0];
  if (!root) return null;

  function attach(node, address) {
    node.address = node.address || address;
    node.depth = node.depth || String(node.address || address).split('-').filter(Boolean).length || 1;
    const children = childrenByParent.get(node.id) || [];
    node.children = children.map((child, index) => attach(child, `${address}-${index + 1}`));
    return node;
  }

  return attach(root, '1');
}

export function buildFlatTree(rows) {
  return FlatTree.fromRows(rows);
}

export function flattenTree(root) {
  if (isFlatTree(root)) {
    return root.slotsPreOrder().map((slot) => root.rowAtSlot(slot)).filter(Boolean);
  }
  if (!root) return [];
  const rows = [];
  const stack = [root];

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

export function maxTreeDepth(root) {
  if (isFlatTree(root)) {
    let maxDepth = 1;
    for (let slot = 0; slot < root.length; slot += 1) {
      maxDepth = Math.max(maxDepth, root.depths[slot] || 1);
    }
    return maxDepth;
  }
  if (!root) return 1;
  let maxDepth = 1;
  const stack = [root];
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

export function findNode(root, nodeId) {
  if (isFlatTree(root)) {
    const slot = root.slotOf(nodeId);
    return slot >= 0 ? root.rowAtSlot(slot) : null;
  }
  if (!root) return null;
  const stack = [root];
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

export function collectDescendantText(node, options = {}) {
  if (!node) return '';
  const parts = [];
  const limit = Math.max(0, Math.floor(Number(options.limit) || 0));
  let total = 0;
  const stack = [node];

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

export function resolveDisplayChildren(node) {
  if (!node) return [];
  let current = node;
  while (
    current.nodeType === 'TEXT' &&
    current.children?.length === 1 &&
    current.children[0].nodeType === 'TEXT'
  ) {
    current = current.children[0];
  }
  return current.children || [];
}

export function collectChainText(node) {
  if (!node) return '';
  let text = node.text || '';
  let current = node;
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

export function getChainNodeIds(node) {
  const ids = [node.id];
  let current = node;
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
