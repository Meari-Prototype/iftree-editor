// 读动作 handler（自 query-api.ts 按域拆出，§6-4：照 mutation-api 的 handlers/write 样板）。
// 本文件由分派表 query-api.ts 消费；跨域共享的 helper 一律住 shared.ts。
import { parseJsonObject } from '../../shared.js';
import { normalizeStableId } from '../../db/ids.js';
import type { IftreeStore } from '../../store/index.js';
import type { AxiomRow, CommitRow, DocRow, NodeRow, RefRow, SourceDocumentRow, SourcePdfPageRow, SourceSpanRow } from '../../db/schema.js';
import type { EditBranchRow } from '../../db/rows.js';
import type { HistoryEntry } from '../../store/history.js';

export type RowObject = Record<string, unknown>;
export type Payload = RowObject;
export type QueryContext = RowObject & {
  libraryRelativePath?: (path: string) => string;
  libraryIndex?: (payload: Payload, docs: RowObject[]) => unknown;
  libraryNavigation?: (payload: Payload, docs: RowObject[]) => unknown;
  libraryTree?: (payload: Payload) => unknown;
  vectorSearch?: (payload: RowObject) => Promise<RowObject[]> | RowObject[];
  keywordSearch?: (payload: RowObject) => Promise<RowObject[]> | RowObject[];
  ensureKeywordIndexReady?: (payload?: RowObject) => Promise<unknown> | unknown;
};
export type CountRow = { count: number };
export type ContentNodeRow = NodeRow & {
  child_count?: number;
  subtree_text_chars?: number;
  score?: number;
  doc_title?: string;
  source_type?: string | null;
  original_path?: string | null;
};
export type ContentDocRow = {
  id: string;
  title: string;
  folder_id: number | null;
  updated_at: string;
  node_count: number;
  max_depth: number | null;
  text_chars: number;
  source_type: string | null;
  original_path: string | null;
};
export type KeywordNodeRow = ContentNodeRow & { doc_title?: string; doc_kind?: string };
export type DocFilterRow = { id: string; agent?: string | null; host_anchor?: string | null; kind?: string | null; original_path?: string | null };
export type KeywordWhere = { sql: string; params: unknown[] };
export type KeywordHit = { row: KeywordNodeRow; hits: Set<string> };
export type CrossDocSearchRow = KeywordNodeRow & {
  doc_folder_id?: number | null;
  doc_updated_at?: string | null;
};
export type CrossDocFormattedResult = RowObject & { doc: RowObject; node: RowObject };
export type FormattedContentNode = RowObject & {
  id: string;
  docId: string;
  parentId: string | null;
  address: string;
  depth: number;
  sortOrder: number;
  type: string;
  title: string;
  childCount: number;
  meta: RowObject & { textChars: number; subtreeTextChars: number };
  text?: string;
  textPreview?: string;
  score?: number;
  children?: FormattedContentNode[];
};
export type ContentTreeNode = FormattedContentNode;
export type ContentTreeBuildNode = FormattedContentNode & { children: ContentTreeBuildNode[] };
export type SnapshotLike = RowObject & { nodes?: Array<RowObject & { id?: unknown; address?: unknown }> };
export type CommitSnapshotRow = CommitRow & { snapshot?: string | null; diff?: string | null };

export const STABLE_ID_SCHEMA = Object.freeze({
  anyOf: [{ type: 'string' }, { type: 'number' }]
});

// normalizeQueryAction（action 是否在注册表内）随 ACTIONS 留在分派表 query-api.ts。

export function normalizePositiveInteger<T extends number | null = null>(value: unknown, fallback: T = null as T): number | T {
  const number = Math.floor(Number(value));
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function normalizeQueryId(value: unknown, fallback: string | null = null) {
  return normalizeStableId(value, fallback);
}

export function normalizeNonNegativeInteger(value: unknown, fallback = 0) {
  const number = Math.floor(Number(value));
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

export function normalizeLimit(value: unknown, fallback = 100, max = 1000) {
  const number = Math.floor(Number(value));
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(max, number);
}

export function pageRows<T>(rows: T[] = [], offset = 0, limit = 100, maxLimit = 100) {
  const safeOffset = normalizeNonNegativeInteger(offset, 0);
  const safeLimit = normalizeLimit(limit, Math.min(100, maxLimit), maxLimit);
  const total = rows.length;
  const page = rows.slice(safeOffset, safeOffset + safeLimit);
  return {
    rows: page,
    total,
    offset: safeOffset,
    limit: safeLimit,
    hasMore: safeOffset + page.length < total,
    truncated: safeOffset + page.length < total
  };
}

// 泛型保留行类型：调用方传 NodeRow 拿 NodeRow（含 null 行兜底）。
// 沿数据流总根：让 queryDoc 等下游能把真行类型一路透给前端。
// 重载：非 null 入参 → 非 null 出参，让 `arr.map(plainRow)` 拿到非空数组而不是 `(T | null)[]`。
export function plainRow<T extends object>(row: T): T;
export function plainRow<T extends object>(row: T | null | undefined): T | null;
export function plainRow<T extends object>(row: T | null | undefined): T | null {
  return row ? ({ ...row } as T) : null;
}

// doc.list 的前端投影：DocRow 去掉 meta(JSON 字符串) 与 tree_view_state(JSON 字符串)，换成解析/汇总后的形态。
// 前端 useDocumentState 与 DocBrowser 直接接此类型——沿数据流贯通真行类型，IPC 边界由此处显式声明收口。
export interface TreeViewStateSummary {
  depthLimit: number | null;
  collapsedNodeCount: number;
  expandedNodeCount: number;
  outlineCollapsedNodeCount: number;
}

export type DocListItem = Omit<DocRow, 'meta' | 'tree_view_state'> & {
  meta: Record<string, unknown>;
  treeViewState: TreeViewStateSummary;
  // store.listDocs() 子查询附带的整篇节点数（DocBrowser 列表显示「N 个节点」用）。
  node_count: number;
};

// store.getDoc 内部投影：nodes 带 child_count（NodeWithChildCountRow）、refs 带地址辅助字段（store 层 map 加）、sourceSpans 带 node_address。
// 沿数据流总根：queryDoc → IPC → useDocumentState 的 ProjectedDoc 接此真行类型，撑起整个前端投影类型化。
export type DocGetNodeRow = NodeRow & { child_count: number; tree_depth?: number };
export type DocGetRefRow = RefRow & { source_address: string | null; target_address: string | null };
export type DocGetSourceSpanRow = SourceSpanRow & { node_address: string | null };

export interface DocGetResult {
  doc: DocRow | null;
  nodes: DocGetNodeRow[];
  axioms: AxiomRow[];
  refs: DocGetRefRow[];
  history: HistoryEntry[];
  editBranch: EditBranchRow | null;
  sourceDocument: SourceDocumentRow | null;
  sourcePdfPages: SourcePdfPageRow[];
  sourceSpans: DocGetSourceSpanRow[];
  tree: ReturnType<IftreeStore['getDoc']> extends { tree: infer T } | null ? T : null;
  treeDepthStats: ReturnType<IftreeStore['getDoc']> extends { treeDepthStats: infer T } | null ? T : never;
  idByAddress: Record<string, string>;
}

export function summarizeTreeViewState(value: unknown): TreeViewStateSummary {
  const state = parseJsonObject(value, {});
  return {
    depthLimit: Number(state.depthLimit) || null,
    collapsedNodeCount: Array.isArray(state.collapsedNodeIds) ? state.collapsedNodeIds.length : 0,
    expandedNodeCount: Array.isArray(state.expandedNodeIds) ? state.expandedNodeIds.length : 0,
    outlineCollapsedNodeCount: Array.isArray(state.outlineCollapsedNodeIds) ? state.outlineCollapsedNodeIds.length : 0
  };
}

export function normalizeDocRow(row: unknown): DocListItem | null {
  if (!row) return null;
  const { meta, tree_view_state: treeViewStateRaw, ...rest } = row as Partial<DocRow> & { node_count?: number } & RowObject;
  return {
    ...(rest as Omit<DocRow, 'meta' | 'tree_view_state'> & { node_count: number }),
    meta: parseJsonObject(meta, {}),
    treeViewState: summarizeTreeViewState(treeViewStateRaw)
  };
}

export function clipText(value: unknown, max = 240) {
  const text = String(value || '');
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}


export function nodeWithChildCount(store: IftreeStore, docId: unknown, nodeId: unknown): ContentNodeRow | null {
  const normalizedDocId = normalizeQueryId(docId);
  const normalizedNodeId = normalizeQueryId(nodeId);
  if (!normalizedDocId || !normalizedNodeId) return null;
  const node = store.db!.prepare('SELECT * FROM nodes WHERE doc_id = ? AND id = ?')
    .get<NodeRow>(normalizedDocId, normalizedNodeId);
  if (!node) return null;
  const childCount = Number(store.db!.prepare(`
    SELECT COUNT(*) AS count
    FROM nodes
    WHERE doc_id = ? AND parent_id = ?
  `).get<CountRow>(normalizedDocId, normalizedNodeId)?.count || 0);
  return { ...node, child_count: childCount };
}

export function resolveAddress(store: IftreeStore, docId: unknown, address: unknown): ContentNodeRow | null {
  const normalizedDocId = normalizeQueryId(docId);
  const normalizedAddress = String(address || '').trim();
  const parts = normalizedAddress
    .split('-')
    .filter(Boolean)
    .map((part) => Math.floor(Number(part)));
  if (!normalizedDocId || parts.length === 0 || parts.some((part) => !Number.isInteger(part) || part <= 0)) {
    return null;
  }
  const stored = store.db!.prepare('SELECT id FROM nodes WHERE doc_id = ? AND address = ?')
    .get<Pick<NodeRow, 'id'>>(normalizedDocId, normalizedAddress);
  if (stored) return nodeWithChildCount(store, normalizedDocId, stored.id);

  let parentId: string | null = null;
  let current: NodeRow | null = null;
  for (const ordinal of parts) {
    current = store.db!.prepare(`
      SELECT *
      FROM nodes
      WHERE doc_id = ? AND parent_id IS ?
      ORDER BY sort_order, id
      LIMIT 1 OFFSET ?
    `).get<NodeRow>(normalizedDocId, parentId, ordinal - 1) ?? null;
    if (!current) return null;
    parentId = current.id;
  }
  return current ? nodeWithChildCount(store, normalizedDocId, current.id) : null;
}

export function requireDocId(payload: Payload = {}) {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id);
  if (!docId) throw new Error('read query requires docId for this action');
  return docId;
}


