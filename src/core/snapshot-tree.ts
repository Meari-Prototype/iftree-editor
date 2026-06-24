interface SnapshotRow {
  id?: unknown;
  nodeId?: unknown;
  node_id?: unknown;
  parent_id?: unknown;
  parentId?: unknown;
  sort_order?: unknown;
  sortOrder?: unknown;
  address?: unknown;
  text?: unknown;
  depth?: unknown;
  doc_id?: unknown;
  docId?: unknown;
  node_type?: unknown;
  nodeType?: unknown;
  node_title?: unknown;
  nodeTitle?: unknown;
  node_note?: unknown;
  nodeNote?: unknown;
  trust_level?: unknown;
  trustLevel?: unknown;
  [key: string]: unknown;
}

interface SnapshotReadNodeResult {
  id: unknown;
  docId: unknown;
  parentId: unknown;
  address: string;
  depth: unknown;
  sortOrder: unknown;
  type: string;
  title: string;
  text: string;
  note: string;
  childCount: number;
  tags: { trustLevel: unknown };
  meta: { textChars: number; subtreeTextChars: number };
  children: SnapshotReadNodeResult[];
}

export function snapshotNodeId(row: SnapshotRow = {}): string {
  return String(row.id ?? row.nodeId ?? row.node_id ?? '');
}

export function snapshotParentId(row: SnapshotRow = {}): string {
  const parent = row.parent_id ?? row.parentId ?? null;
  return parent === null || parent === undefined ? '' : String(parent);
}

export function snapshotChildrenByParent(rows: SnapshotRow[] = []): Map<string, SnapshotRow[]> {
  const byParent = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    const key = snapshotParentId(row);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(row);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => {
      const order = Number(left.sort_order ?? left.sortOrder ?? 0) - Number(right.sort_order ?? right.sortOrder ?? 0);
      return order || String(left.address || '').localeCompare(String(right.address || ''));
    });
  }
  return byParent;
}

export function snapshotTextChars(row: SnapshotRow = {}): number {
  return String(row.text || '').length;
}

export function snapshotSubtreeTextChars(row: SnapshotRow, byParent: Map<string, SnapshotRow[]>): number {
  return snapshotTextChars(row) + (byParent.get(snapshotNodeId(row)) || [])
    .reduce((sum, child) => sum + snapshotSubtreeTextChars(child, byParent), 0);
}

export function snapshotReadNode(row: SnapshotRow, byParent: Map<string, SnapshotRow[]>): SnapshotReadNodeResult {
  const children = byParent.get(snapshotNodeId(row)) || [];
  return {
    id: row.id,
    docId: row.doc_id ?? row.docId,
    parentId: row.parent_id ?? row.parentId ?? null,
    address: String(row.address || ''),
    depth: row.depth ?? null,
    sortOrder: row.sort_order ?? row.sortOrder ?? null,
    type: String(row.node_type ?? row.nodeType ?? 'TEXT'),
    title: String(row.node_title ?? row.nodeTitle ?? ''),
    text: String(row.text || ''),
    note: String(row.node_note ?? row.nodeNote ?? ''),
    childCount: children.length,
    tags: {
      trustLevel: row.trust_level ?? row.trustLevel ?? null
    },
    meta: {
      textChars: snapshotTextChars(row),
      subtreeTextChars: snapshotSubtreeTextChars(row, byParent)
    },
    children: children.map((child) => snapshotReadNode(child, byParent))
  };
}

export function snapshotSubtreeRows(root: SnapshotRow, byParent: Map<string, SnapshotRow[]>): SnapshotRow[] {
  const rows = [root];
  for (const child of byParent.get(snapshotNodeId(root)) || []) rows.push(...snapshotSubtreeRows(child, byParent));
  return rows;
}

export function snapshotAddressDepth(address: unknown = ''): number {
  const value = String(address || '').trim();
  return value ? value.split('-').length : 0;
}

export function pruneTreeDepth<T extends { children?: T[] }>(node: T, maxLevels: number, level: number = 1): T {
  if (level >= maxLevels) return { ...node, children: [] };
  return { ...node, children: (node.children || []).map((child) => pruneTreeDepth(child, maxLevels, level + 1)) };
}