// @ts-nocheck
import { isFlatTree } from '../../core/flat-tree.js';
import { toTreeNode } from '../../core/node-model.js';

function compareNodeRows(left, right) {
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  if (typeof left.id === 'number' && typeof right.id === 'number') return left.id - right.id;
  return String(left.id).localeCompare(String(right.id));
}

function normalizeIndexNodeId(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function addressDepth(address) {
  const value = String(address || '').trim();
  if (!value) return null;
  return value.split('-').filter(Boolean).length || null;
}

function buildFlatTreeDepthStats(flatTree) {
  const depthSet = new Set();
  let maxDepth = 0;
  for (let slot = 0; slot < flatTree.length; slot += 1) {
    const depth = Math.max(1, Number(flatTree.depths[slot]) || 1);
    depthSet.add(depth);
    maxDepth = Math.max(maxDepth, depth);
  }
  return Object.freeze({
    maxDepth,
    depths: Object.freeze([...depthSet].sort((a, b) => a - b))
  });
}

function allFlatSlots(flatTree) {
  return Array.from({ length: flatTree.length }, (_value, slot) => slot);
}

function buildFlatNodeByIdProxy(flatTree) {
  return Object.freeze({
    get(id) {
      const slot = flatTree.slotOf(id);
      return slot >= 0 ? flatTree.rowAtSlot(slot) : null;
    },
    has(id) {
      return flatTree.slotOf(id) >= 0;
    },
    keys() {
      return allFlatSlots(flatTree).map((slot) => flatTree.ids[slot]);
    },
    values() {
      return allFlatSlots(flatTree).map((slot) => flatTree.rowAtSlot(slot)).filter(Boolean);
    },
    entries() {
      return allFlatSlots(flatTree)
        .map((slot) => [flatTree.ids[slot], flatTree.rowAtSlot(slot)])
        .filter((entry) => Boolean(entry[1]));
    },
    [Symbol.iterator]() {
      return this.entries()[Symbol.iterator]();
    }
  });
}

function buildFlatTreeIndex(flatTree) {
  const nodeById = buildFlatNodeByIdProxy(flatTree);
  const depthStats = buildFlatTreeDepthStats(flatTree);
  const idByAddress = {};
  const addressById = {};
  for (let slot = 0; slot < flatTree.length; slot += 1) {
    const id = flatTree.ids[slot];
    const address = String(flatTree.addresses?.[slot] || '').trim();
    if (!address) continue;
    idByAddress[address] = id;
    addressById[id] = address;
  }

  function idsForSlots(slots) {
    return Object.freeze(slots.map((slot) => flatTree.ids[slot]));
  }

  function descendantsOf(id) {
    const startSlot = flatTree.slotOf(id);
    if (startSlot < 0) return [];
    return flatTree.slotsPreOrder(startSlot).map((slot) => flatTree.rowAtSlot(slot)).filter(Boolean);
  }

  return Object.freeze({
    nodeById,
    depthStats,
    idByAddress: Object.freeze({ ...idByAddress }),
    addressById: Object.freeze({ ...addressById }),
    allIds() {
      return allFlatSlots(flatTree).map((slot) => flatTree.ids[slot]);
    },
    parentOf(id) {
      const slot = flatTree.slotOf(id);
      if (slot < 0) return null;
      const parentId = flatTree.parentIds[slot];
      return parentId === null ? null : parentId;
    },
    childrenOf(id) {
      const slot = id === null || id === undefined ? -1 : flatTree.slotOf(id);
      if (slot < 0 && id !== null && id !== undefined) return [];
      return idsForSlots(flatTree.childSlots(slot));
    },
    siblingsAfter(id) {
      const slot = flatTree.slotOf(id);
      if (slot < 0) return [];
      const parentId = flatTree.parentIds[slot];
      const parentSlot = parentId === null ? -1 : flatTree.slotOf(parentId);
      if (parentId !== null && parentSlot < 0) return [];
      const siblings = flatTree.childSlots(parentSlot);
      const index = siblings.indexOf(slot);
      return index < 0 ? [] : idsForSlots(siblings.slice(index + 1));
    },
    nodeOf(id) {
      return nodeById.get(id) || null;
    },
    hasChildren(id) {
      const slot = flatTree.slotOf(id);
      return slot >= 0 && Boolean(flatTree.firstChildSlot[slot] !== -1 || flatTree.childCounts[slot] > 0);
    },
    descendantsOf
  });
}

export function buildTreeIndex(nodes) {
  if (isFlatTree(nodes)) return buildFlatTreeIndex(nodes);

  const nodeById = new Map();
  const parentById = new Map();
  const childrenById = new Map();
  const idByAddress = {};
  const addressById = {};
  const depthSet = new Set();
  let maxDepth = 0;

  for (const raw of Array.isArray(nodes) ? nodes : []) {
    const node = toTreeNode(raw);
    if (!node) continue;
    nodeById.set(node.id, node);
    parentById.set(node.id, node.parentId);
    if (!childrenById.has(node.parentId)) childrenById.set(node.parentId, []);
    childrenById.get(node.parentId).push(node);
    if (node.address) {
      idByAddress[node.address] = node.id;
      addressById[node.id] = node.address;
      const depth = addressDepth(node.address);
      if (depth !== null) {
        depthSet.add(depth);
        maxDepth = Math.max(maxDepth, depth);
      }
    }
  }

  const childrenIdsById = new Map();
  for (const [parentId, children] of childrenById) {
    const ids = children
      .sort(compareNodeRows)
      .map((child) => child.id);
    childrenIdsById.set(parentId, Object.freeze(ids));
  }

  const roots = childrenIdsById.get(null) || [];
  const stack = roots.slice().reverse().map((id, index, source) => ({
    id,
    address: String(source.length - index)
  }));
  while (stack.length > 0) {
    const { id, address } = stack.pop();
    const node = nodeById.get(id);
    if (!node) continue;
    node.address = node.address || address;
    idByAddress[node.address] = node.id;
    addressById[node.id] = node.address;
    const depth = addressDepth(node.address);
    if (depth !== null) {
      depthSet.add(depth);
      maxDepth = Math.max(maxDepth, depth);
    }
    const children = childrenIdsById.get(id) || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ id: children[index], address: `${node.address}-${index + 1}` });
    }
  }

  const orderedIds = Object.freeze([...nodeById.values()]
    .sort(compareNodeRows)
    .map((node) => node.id));
  const depthStats = Object.freeze({
    maxDepth,
    depths: Object.freeze([...depthSet].sort((a, b) => a - b))
  });

  function descendantsOf(id) {
    const key = normalizeIndexNodeId(id);
    if (!nodeById.has(key)) return [];
    const result = [nodeById.get(key)];
    const stack = [...(childrenIdsById.get(key) || [])].reverse();
    while (stack.length > 0) {
      const currentId = stack.pop();
      const node = nodeById.get(currentId);
      if (node) result.push(node);
      const children = childrenIdsById.get(currentId) || [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]);
      }
    }
    return result;
  }

  return Object.freeze({
    depthStats,
    idByAddress: Object.freeze({ ...idByAddress }),
    addressById: Object.freeze({ ...addressById }),
    allIds() {
      return [...orderedIds];
    },
    parentOf(id) {
      const key = normalizeIndexNodeId(id);
      return parentById.has(key) ? parentById.get(key) : null;
    },
    childrenOf(id) {
      return childrenIdsById.get(normalizeIndexNodeId(id)) || [];
    },
    siblingsAfter(id) {
      const key = normalizeIndexNodeId(id);
      if (!parentById.has(key)) return [];
      const siblings = childrenIdsById.get(parentById.get(key)) || [];
      const index = siblings.indexOf(key);
      return index < 0 ? [] : siblings.slice(index + 1);
    },
    nodeOf(id) {
      return nodeById.get(normalizeIndexNodeId(id)) || null;
    },
    hasChildren(id) {
      const key = normalizeIndexNodeId(id);
      const node = nodeById.get(key);
      return Boolean((childrenIdsById.get(key) || []).length || Number(node?.childCount) > 0);
    },
    descendantsOf
  });
}

function readNumber(source, keys, fallback = 0) {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

export function buildEdgesFromPositions(positions, treeIndex, nodeIds = null) {
  if (!(positions instanceof Map) || !treeIndex || typeof treeIndex.childrenOf !== 'function') return [];
  const edges = [];
  const ids = Array.isArray(nodeIds) || nodeIds instanceof Set ? [...nodeIds] : [...positions.keys()];
  for (const nodeId of ids) {
    const pos = positions.get(nodeId);
    if (!pos) continue;
    for (const childId of treeIndex.childrenOf(nodeId)) {
      const childPos = positions.get(childId);
      if (!childPos) continue;
      const cardHeight = readNumber(pos, ['cardHeight', 'card_height', 'height'], 0);
      const childCardHeight = readNumber(childPos, ['cardHeight', 'card_height', 'height'], 0);
      edges.push({
        fromX: readNumber(pos, ['x'], 0) + readNumber(pos, ['width'], 0),
        fromY: readNumber(pos, ['y'], 0) + cardHeight / 2,
        toX: readNumber(childPos, ['x'], 0),
        toY: readNumber(childPos, ['y'], 0) + childCardHeight / 2,
        fromId: nodeId,
        toId: childId
      });
    }
  }
  return edges;
}
