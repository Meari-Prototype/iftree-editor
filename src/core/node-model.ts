// node-model.mjs
//
// 统一节点数据模型。整个应用只通过这一层理解"节点是什么"。
// 无 React 依赖，无视图逻辑。
//
//   数据库行（任意格式） → toTreeNode() → TreeNode（唯一形状）
//   TreeNode[]           → buildTreeIndex() → TreeIndex（带索引的树）
//   TreeIndex            → get*/query 函数 → 给视图用
//   TreeNode             → toDbRow() → 写回后端

// ─── 常量 ─────────────────────────────────────

export const NODE_TYPES: string[] = [
  'TEXT',
  'IF',
  'THEN',
  'ELSE',
  'LOOP',
  'FOREACH',
  'BREAK',
  'CONTINUE',
  'ERROR',
  'HUMAN_BLOCK',
  'HUMAN_SUMMARY'
];

export const NODE_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  TEXT: '文本',
  IF: '如果',
  THEN: '那么',
  ELSE: '否则',
  LOOP: '循环',
  FOREACH: '遍历',
  BREAK: '跳出',
  CONTINUE: '继续',
  ERROR: '错误',
  HUMAN_BLOCK: '人工-阻塞',
  HUMAN_SUMMARY: '人工-汇总'
});

const NODE_TYPE_ALIASES: Map<string, string> = new Map([
  ...NODE_TYPES.map((type): [string, string] => [type, type]),
  ...Object.entries(NODE_TYPE_LABELS).map(([type, label]): [string, string] => [label, type])
]);

export interface TreeNode extends BaseIndexNode {
  id: string;
  docId: string | null;
  parentId: string | null;
  address: string;
  depth: number;
  sortOrder: number;
  childCount: number;
  nodeType: string;
  title: string;
  text: string;
  note: string;
  trustLevel: unknown;
  sourcePosition: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

// 最小索引节点 shape：调用方可传 C2DBlock / TreeNode / 任何鸭子类型。
// 只要带 id/parentId/address 即可在 TreeIndex<T> 中查询。
export interface BaseIndexNode {
  id: string;
  parentId: string | null;
  address: string;
  depth?: number;
  childCount?: number;
  [key: string]: unknown;
}

export interface TreeIndex<T extends BaseIndexNode = TreeNode> {
  byId: Map<string, T>;
  byAddress: Map<string, T>;
  childrenOf: Map<string | null, T[]>;
  root: T | null;
  size: number;
}

type NodeRow = Record<string, unknown>;

interface NestedNode extends NodeRow {
  children?: NestedNode[];
}

export function normalizeNodeType(value: unknown, fallback = 'TEXT'): string {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const normalized = NODE_TYPE_ALIASES.get(raw) || NODE_TYPE_ALIASES.get(raw.toUpperCase());
  if (!normalized) throw new Error(`Unsupported node_type: ${raw}`);
  return normalized;
}

export function nodeTypeDisplayLabel(value: unknown): string {
  return NODE_TYPE_LABELS[normalizeNodeType(value)] || NODE_TYPE_LABELS.TEXT;
}

export function normalizeNodeId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim()) return value.trim();
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? String(numeric) : null;
}

function compareNodeId(left: unknown, right: unknown): number {
  return String(left || '').localeCompare(String(right || ''));
}

// ─── TreeNode: 数据库行 → 唯一形状 ───────────

export function toTreeNode(row: NodeRow | null): TreeNode | null {
  if (!row) return null;
  const id = normalizeNodeId(row.id);
  if (id === null) return null;
  const tags = row.tags as Record<string, unknown> | undefined;
  const source = row.source as Record<string, unknown> | undefined;
  return {
    id,
    docId:          normalizeNodeId(row.docId ?? row.doc_id),
    parentId:       normalizeNodeId(row.parentId ?? row.parent_id),
    address:        String(row.address || ''),
    depth:          Math.max(1, Number(row.depth ?? row.tree_depth) || 1),
    sortOrder:      Number(row.sortOrder ?? row.sort_order) || 0,
    childCount:     Math.max(0, Number(row.childCount ?? row.child_count) || 0),
    nodeType:       normalizeNodeType(row.nodeType ?? row.node_type ?? row.type ?? 'TEXT'),
    title:          String(row.title ?? row.node_title ?? row.nodeTitle ?? '').trim(),
    text:           String(row.text ?? row.textPreview ?? '').trim(),
    note:           String(row.note ?? row.node_note ?? row.nodeNote ?? '').trim(),
    trustLevel:     row.trustLevel ?? row.trust_level ?? tags?.trustLevel ?? null,
    sourcePosition: row.sourcePosition ?? row.source_position ?? source?.position ?? null,
    createdAt:      row.createdAt ?? row.created_at ?? null,
    updatedAt:      row.updatedAt ?? row.updated_at ?? null,
  };
}

// ─── TreeIndex: 整棵树，O(1) 查询 ────────────

export function buildTreeIndex<T extends BaseIndexNode = TreeNode>(
  source: NodeRow[] | NestedNode | null | undefined
): TreeIndex<T> {
  let raw: NodeRow[];
  if (Array.isArray(source)) {
    raw = source;
  } else if (source && typeof source === 'object' && 'id' in source) {
    raw = flattenNested(source as NestedNode);
  } else {
    raw = [];
  }

  const byId = new Map<string, TreeNode>();
  const byAddress = new Map<string, TreeNode>();
  const childrenOf = new Map<string | null, TreeNode[]>();
  let root: TreeNode | null = null;

  for (const r of raw) {
    const node = toTreeNode(r);
    if (!node) continue;
    byId.set(node.id, node);
    if (node.address) byAddress.set(node.address, node);
  }

  for (const node of byId.values()) {
    const pid = node.parentId;
    if (pid == null || !byId.has(pid)) {
      if (!root || node.depth < root.depth) root = node;
      continue;
    }
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid)!.push(node);
  }

  for (const children of childrenOf.values()) {
    children.sort((a, b) => a.sortOrder - b.sortOrder || compareNodeId(a.id, b.id));
  }

  return { byId, byAddress, childrenOf, root, size: byId.size } as unknown as TreeIndex<T>;
}

function flattenNested(root: NestedNode): NodeRow[] {
  const result: NodeRow[] = [];
  const stack: NestedNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    const children = Array.isArray(node.children) ? node.children : [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return result;
}

// ─── 查询 ─────────────────────────────────────

export function getNode<T extends BaseIndexNode>(index: TreeIndex<T>, id: unknown): T | null {
  const key = normalizeNodeId(id);
  if (key === null) return null;
  return index.byId.get(key) ?? null;
}

export function getNodeByAddress<T extends BaseIndexNode>(index: TreeIndex<T>, address: unknown): T | null {
  return index.byAddress.get(String(address)) ?? null;
}

export function getChildren<T extends BaseIndexNode>(index: TreeIndex<T>, parentId: unknown): T[] {
  const key = normalizeNodeId(parentId);
  if (key === null) return [];
  return index.childrenOf.get(key) ?? [];
}

export function getParent<T extends BaseIndexNode>(index: TreeIndex<T>, nodeId: unknown): T | null {
  const node = getNode(index, nodeId);
  return node?.parentId ? getNode(index, node.parentId) : null;
}

export function getSiblings<T extends BaseIndexNode>(index: TreeIndex<T>, nodeId: unknown): T[] {
  const parent = getParent(index, nodeId);
  if (!parent) return [];
  return getChildren(index, parent.id);
}

export function getAncestors<T extends BaseIndexNode>(index: TreeIndex<T>, nodeId: unknown): T[] {
  const result: T[] = [];
  let cur = getNode(index, nodeId);
  while (cur?.parentId) {
    cur = getNode(index, cur.parentId);
    if (cur) result.unshift(cur);
  }
  return result;
}

export function getDescendants<T extends BaseIndexNode>(index: TreeIndex<T>, nodeId: unknown): T[] {
  const result: T[] = [];
  const stack = getChildren(index, nodeId).slice().reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    const children = getChildren(index, node.id);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return result;
}

export function getSubtreeText<T extends BaseIndexNode>(index: TreeIndex<T>, nodeId: unknown, separator = '\n'): string {
  const node = getNode(index, nodeId);
  if (!node) return '';
  const parts: string[] = [];
  const stack: T[] = [node];
  while (stack.length > 0) {
    const n = stack.pop()!;
    const title = String(n.title ?? '');
    const text = String(n.text ?? '');
    if (title) parts.push(title);
    if (text && text !== title) parts.push(text);
    const children = getChildren(index, n.id);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return parts.filter(Boolean).join(separator);
}

// ─── 地址工具 ─────────────────────────────────

export function parentAddress(addr: unknown): string | null {
  const s = String(addr || '');
  const i = s.lastIndexOf('-');
  return i > 0 ? s.slice(0, i) : null;
}

export function depthFromAddress(addr: unknown): number {
  const s = String(addr || '');
  return s ? s.split('-').length : 0;
}

export function isAncestorAddress(ancestor: unknown, descendant: unknown): boolean {
  return String(descendant || '').startsWith(String(ancestor || '') + '-');
}

// ─── 索引更新（乐观更新 / 局部刷新）──────────

export function patchNode<T extends BaseIndexNode>(index: TreeIndex<T>, updatedRow: NodeRow): TreeIndex<T> {
  const node = toTreeNode(updatedRow);
  if (!node) return index;

  const prev = index.byId.get(node.id);
  index.byId.set(node.id, node as unknown as T);

  if (prev && prev.address && prev.address !== node.address) {
    index.byAddress.delete(prev.address);
  }
  if (node.address) index.byAddress.set(node.address, node as unknown as T);

  if (prev && prev.parentId !== node.parentId) {
    const oldSiblings = index.childrenOf.get(prev.parentId);
    if (oldSiblings) {
      const idx = oldSiblings.findIndex(n => n.id === node.id);
      if (idx >= 0) oldSiblings.splice(idx, 1);
    }
    if (node.parentId != null) {
      if (!index.childrenOf.has(node.parentId)) index.childrenOf.set(node.parentId, []);
      const siblings = index.childrenOf.get(node.parentId)!;
      siblings.push(node as unknown as T);
      siblings.sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder) || compareNodeId(a.id, b.id));
    }
  } else if (prev) {
    const siblings = index.childrenOf.get(node.parentId);
    if (siblings) {
      const idx = siblings.findIndex(n => n.id === node.id);
      if (idx >= 0) siblings[idx] = node as unknown as T;
    }
  }

  if (node.id === index.root?.id) index.root = node as unknown as T;
  index.size = index.byId.size;
  return { ...index };
}

export function removeNode<T extends BaseIndexNode>(index: TreeIndex<T>, nodeId: unknown): TreeIndex<T> {
  const id = normalizeNodeId(nodeId);
  if (id === null) return index;
  const node = index.byId.get(id);
  if (!node) return index;

  const toRemove = [node, ...getDescendants(index, id)];
  for (const n of toRemove) {
    index.byId.delete(n.id);
    if (n.address) index.byAddress.delete(n.address);
    index.childrenOf.delete(n.id);
  }

  if (node.parentId != null) {
    const siblings = index.childrenOf.get(node.parentId);
    if (siblings) {
      const idx = siblings.findIndex(n => n.id === id);
      if (idx >= 0) siblings.splice(idx, 1);
    }
  }

  if (index.root?.id === id) index.root = null;
  index.size = index.byId.size;
  return { ...index };
}

// ─── 写回后端 ─────────────────────────────────

export interface TreeNodeDbRow {
  id: string;
  doc_id: string | null;
  parent_id: string | null;
  address: string;
  depth: number;
  sort_order: number;
  node_type: string;
  text: string;
  node_title: string;
  node_note: string;
  source_position: unknown;
  trust_level: unknown;
}

export function toDbRow(node: TreeNode | null): TreeNodeDbRow | null {
  if (!node) return null;
  return {
    id:              node.id,
    doc_id:          node.docId,
    parent_id:       node.parentId,
    address:         node.address,
    depth:           node.depth,
    sort_order:      node.sortOrder,
    node_type:       normalizeNodeType(node.nodeType),
    text:            node.text,
    node_title:      node.title,
    node_note:       node.note,
    source_position: node.sourcePosition,
    trust_level:     node.trustLevel,
  };
}