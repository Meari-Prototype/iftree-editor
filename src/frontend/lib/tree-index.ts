import { FlatTree, isFlatTree } from '../../core/flat-tree.js';
import { toTreeNode, type TreeNode } from '../../core/node-model.js';

type FlatTreeRow = ReturnType<FlatTree['rowAtSlot']>;

function compareNodeRows(left: TreeNode, right: TreeNode): number {
  if (left.sortOrder !== right.sortOrder) return Number(left.sortOrder) - Number(right.sortOrder);
  return String(left.id).localeCompare(String(right.id));
}

function normalizeIndexNodeId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function addressDepth(address: unknown): number | null {
  const value = String(address || '').trim();
  if (!value) return null;
  return value.split('-').filter(Boolean).length || null;
}

interface DepthStats {
  maxDepth: number;
  depths: readonly number[];
}

function buildFlatTreeDepthStats(flatTree: FlatTree): DepthStats {
  const depthSet = new Set<number>();
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

function allFlatSlots(flatTree: FlatTree): number[] {
  return Array.from({ length: flatTree.length }, (_value, slot) => slot);
}

interface FlatNodeByIdProxy {
  get(id: unknown): FlatTreeRow | null;
  has(id: unknown): boolean;
  keys(): Array<string | null>;
  values(): FlatTreeRow[];
  entries(): Array<[string | null, FlatTreeRow]>;
  [Symbol.iterator](): IterableIterator<[string | null, FlatTreeRow]>;
}

function buildFlatNodeByIdProxy(flatTree: FlatTree): FlatNodeByIdProxy {
  return Object.freeze({
    get(id: unknown) {
      const slot = flatTree.slotOf(id);
      return slot >= 0 ? flatTree.rowAtSlot(slot) : null;
    },
    has(id: unknown) {
      return flatTree.slotOf(id) >= 0;
    },
    keys() {
      return allFlatSlots(flatTree).map((slot) => flatTree.ids[slot]);
    },
    values() {
      return allFlatSlots(flatTree)
        .map((slot) => flatTree.rowAtSlot(slot))
        .filter((row): row is NonNullable<FlatTreeRow> => Boolean(row));
    },
    entries() {
      return allFlatSlots(flatTree)
        .map((slot): [string | null, FlatTreeRow] => [flatTree.ids[slot], flatTree.rowAtSlot(slot)])
        .filter((entry): entry is [string | null, NonNullable<FlatTreeRow>] => Boolean(entry[1]));
    },
    [Symbol.iterator]() {
      return this.entries()[Symbol.iterator]();
    }
  }) as FlatNodeByIdProxy;
}

export interface TreeIndex {
  depthStats: DepthStats;
  idByAddress: Readonly<Record<string, unknown>>;
  addressById: Readonly<Record<string, string>>;
  allIds(): Array<string | null>;
  parentOf(id: unknown): unknown;
  childrenOf(id: unknown): ReadonlyArray<unknown>;
  siblingsAfter(id: unknown): ReadonlyArray<unknown>;
  nodeOf(id: unknown): TreeNode | FlatTreeRow | null;
  hasChildren(id: unknown): boolean;
  descendantsOf(id: unknown): Array<TreeNode | FlatTreeRow>;
  nodeById?: FlatNodeByIdProxy;
}

function buildFlatTreeIndex(flatTree: FlatTree): TreeIndex {
  const nodeById = buildFlatNodeByIdProxy(flatTree);
  const depthStats = buildFlatTreeDepthStats(flatTree);
  const idByAddress: Record<string, unknown> = {};
  const addressById: Record<string, string> = {};
  for (let slot = 0; slot < flatTree.length; slot += 1) {
    const id = flatTree.ids[slot];
    const address = String(flatTree.addresses?.[slot] || '').trim();
    if (!address || id === null) continue;
    idByAddress[address] = id;
    addressById[id] = address;
  }

  function idsForSlots(slots: number[]): ReadonlyArray<string | null> {
    return Object.freeze(slots.map((slot) => flatTree.ids[slot]));
  }

  function descendantsOf(id: unknown): FlatTreeRow[] {
    const startSlot = flatTree.slotOf(id);
    if (startSlot < 0) return [];
    return flatTree.slotsPreOrder(startSlot)
      .map((slot) => flatTree.rowAtSlot(slot))
      .filter((row): row is NonNullable<FlatTreeRow> => Boolean(row));
  }

  return Object.freeze({
    nodeById,
    depthStats,
    idByAddress: Object.freeze({ ...idByAddress }),
    addressById: Object.freeze({ ...addressById }),
    allIds() {
      return allFlatSlots(flatTree).map((slot) => flatTree.ids[slot]);
    },
    parentOf(id: unknown) {
      const slot = flatTree.slotOf(id);
      if (slot < 0) return null;
      const parentId = flatTree.parentIds[slot];
      return parentId === null ? null : parentId;
    },
    childrenOf(id: unknown) {
      const slot = id === null || id === undefined ? -1 : flatTree.slotOf(id);
      if (slot < 0 && id !== null && id !== undefined) return [];
      return idsForSlots(flatTree.childSlots(slot));
    },
    siblingsAfter(id: unknown) {
      const slot = flatTree.slotOf(id);
      if (slot < 0) return [];
      const parentId = flatTree.parentIds[slot];
      const parentSlot = parentId === null ? -1 : flatTree.slotOf(parentId);
      if (parentId !== null && parentSlot < 0) return [];
      const siblings = flatTree.childSlots(parentSlot);
      const index = siblings.indexOf(slot);
      return index < 0 ? [] : idsForSlots(siblings.slice(index + 1));
    },
    nodeOf(id: unknown) {
      return nodeById.get(id) || null;
    },
    hasChildren(id: unknown) {
      const slot = flatTree.slotOf(id);
      return slot >= 0 && Boolean(flatTree.firstChildSlot[slot] !== -1 || flatTree.childCounts[slot] > 0);
    },
    descendantsOf
  });
}

export function buildTreeIndex(nodes: unknown): TreeIndex {
  if (isFlatTree(nodes)) return buildFlatTreeIndex(nodes as FlatTree);

  const nodeById = new Map<string, TreeNode>();
  const parentById = new Map<string, string | null>();
  const childrenById = new Map<string | null, TreeNode[]>();
  const idByAddress: Record<string, string> = {};
  const addressById: Record<string, string> = {};
  const depthSet = new Set<number>();
  let maxDepth = 0;

  for (const raw of Array.isArray(nodes) ? nodes : []) {
    const node = toTreeNode(raw);
    if (!node) continue;
    nodeById.set(node.id, node);
    parentById.set(node.id, node.parentId);
    const childList = childrenById.get(node.parentId) || [];
    childList.push(node);
    childrenById.set(node.parentId, childList);
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

  const childrenIdsById = new Map<string | null, ReadonlyArray<string>>();
  for (const [parentId, children] of childrenById) {
    const ids = children
      .sort(compareNodeRows)
      .map((child) => child.id);
    childrenIdsById.set(parentId, Object.freeze(ids));
  }

  const roots = (childrenIdsById.get(null) || []) as ReadonlyArray<string>;
  const stack: Array<{ id: string; address: string }> = roots.slice().reverse().map((id, index, source) => ({
    id,
    address: String(source.length - index)
  }));
  while (stack.length > 0) {
    const { id, address } = stack.pop()!;
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
  const depthStats: DepthStats = Object.freeze({
    maxDepth,
    depths: Object.freeze([...depthSet].sort((a, b) => a - b))
  });

  function descendantsOf(id: unknown): TreeNode[] {
    const key = normalizeIndexNodeId(id);
    if (key === null || !nodeById.has(key)) return [];
    const root = nodeById.get(key)!;
    const result: TreeNode[] = [root];
    const stackInner = [...(childrenIdsById.get(key) || [])].reverse();
    while (stackInner.length > 0) {
      const currentId = stackInner.pop()!;
      const node = nodeById.get(currentId);
      if (node) result.push(node);
      const children = childrenIdsById.get(currentId) || [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stackInner.push(children[index]);
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
    parentOf(id: unknown) {
      const key = normalizeIndexNodeId(id);
      return key !== null && parentById.has(key) ? parentById.get(key) ?? null : null;
    },
    childrenOf(id: unknown) {
      const key = normalizeIndexNodeId(id);
      return childrenIdsById.get(key) || [];
    },
    siblingsAfter(id: unknown) {
      const key = normalizeIndexNodeId(id);
      if (key === null || !parentById.has(key)) return [];
      const parentKey = parentById.get(key) ?? null;
      const siblings = childrenIdsById.get(parentKey) || [];
      const index = siblings.indexOf(key);
      return index < 0 ? [] : siblings.slice(index + 1);
    },
    nodeOf(id: unknown) {
      const key = normalizeIndexNodeId(id);
      return key !== null ? nodeById.get(key) || null : null;
    },
    hasChildren(id: unknown) {
      const key = normalizeIndexNodeId(id);
      if (key === null) return false;
      const node = nodeById.get(key);
      return Boolean((childrenIdsById.get(key) || []).length || Number(node?.childCount) > 0);
    },
    descendantsOf
  });
}

interface PositionLike {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  cardHeight?: number;
  card_height?: number;
  [extra: string]: unknown;
}

interface Edge {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  fromId: unknown;
  toId: unknown;
}

function readNumber(source: PositionLike | null | undefined, keys: ReadonlyArray<string>, fallback: number = 0): number {
  for (const key of keys) {
    const value = Number(source?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

export function buildEdgesFromPositions(
  positions: Map<unknown, PositionLike> | unknown,
  treeIndex: Pick<TreeIndex, 'childrenOf'> | null | undefined,
  nodeIds: ReadonlyArray<unknown> | Set<unknown> | null = null
): Edge[] {
  if (!(positions instanceof Map) || !treeIndex || typeof treeIndex.childrenOf !== 'function') return [];
  const edges: Edge[] = [];
  const ids: unknown[] = Array.isArray(nodeIds) || nodeIds instanceof Set ? [...nodeIds] : [...positions.keys()];
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
