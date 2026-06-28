import { DEFAULT_NODE_LAYOUT, MAX_DEPTH_LIMIT, normalizeNodeLayout, type NodeLayout } from '../../core/mindmap.js';
import { flattenTree, maxTreeDepth, type TreeNodeLike } from '../../core/tree.js';
import { collapsedForDepthLimit } from '../../core/tree-ui.js';
import { boundsFromNodes, fitCameraToBounds } from '../../core/viewport.js';
import { NODE_TYPE_LABELS as CORE_NODE_TYPE_LABELS } from '../../core/node-model.js';
import type { DocListItem as BackendDocListItem } from '../../backend/query-api.js';
import type { DocFolderRow } from '../../backend/db/schema.js';
import type { LibraryEntry } from '../../backend/library-fs.js';

export const TRUST_LEVELS = ['', '受控', '不受控'];
export const DEFAULT_SIDEBAR_WIDTH = 280;
export const MIN_LEFT_WIDTH = DEFAULT_SIDEBAR_WIDTH;
export const MIN_RIGHT_WIDTH = DEFAULT_SIDEBAR_WIDTH;
export const MAX_LEFT_WIDTH = 560;
export const MAX_RIGHT_WIDTH = 760;
export const MIN_VERTICAL_SPLIT_PANEL_HEIGHT = 150;
export const MIN_DOC_PANEL_HEIGHT = MIN_VERTICAL_SPLIT_PANEL_HEIGHT;
export const MIN_OUTLINE_PANEL_HEIGHT = MIN_VERTICAL_SPLIT_PANEL_HEIGHT;
export const MIN_AGENT_PANEL_HEIGHT = MIN_VERTICAL_SPLIT_PANEL_HEIGHT;
export const MAX_AGENT_PANEL_HEIGHT = 760;
export const MIN_NODE_INFO_PANEL_HEIGHT = MIN_VERTICAL_SPLIT_PANEL_HEIGHT;
export const PANEL_SPLIT_RAIL_SIZE = 16;
export const DEFAULT_AGENT_PANEL_BASIS = '66%';
export const ACTIVE_DOC_STORAGE_KEY = 'iftree.activeDocId';
export const DEFAULT_DOC_FOLDER_NAME = '新建文件夹';
export const MAX_DOC_FOLDER_NAME_LENGTH = 100;
export const DOC_MENU_WIDTH = 176;
export const SUMMARY_MENU_WIDTH = 150;
export const SUMMARY_MENU_HEIGHT = 132;
export const NODE_RESIZE_HANDLE_SCREEN_SIZE = 12;
export const NODE_GOLDEN_CARD_RATIO = 1.618;
export const NODE_LONG_PRESS_MS = 360;
export const NODE_GESTURE_DRAG_THRESHOLD = 5;
export const RESIZE_RAIL_DRAG_THRESHOLD = 4;
export const MINDMAP_RENDER_OVERSCAN_SCREENS = 1;
export const DEFAULT_TREE_LOAD_DEPTH = 1;
export const DEFAULT_LARGE_TREE_OPEN_DEPTH = 2;
export const MAX_TREE_LOAD_DEPTH = MAX_DEPTH_LIMIT;
export const NODE_CHILDREN_PAGE_SIZE = 300;
export const TREE_FULL_NODE_PAGE_SIZE = 5000;
export const TREE_BUILD_YIELD_EVERY = 8192;
export const TREE_MINDMAP_RENDER_CACHE_KEY_NAMESPACE_VERSION = 6;
export const TREE_MINDMAP_SYNC_NODE_LIMIT = 5000;
export const TREE_LAYOUT_CACHE_APPLY_CHUNK_SIZE = 8192;
export const TREE_LAYOUT_CACHE_WRITE_CHUNK_SIZE = 5000;
export const SOURCE_WINDOW_CHAR_LIMIT = 50000;
export const SOURCE_WINDOW_BEFORE_CHARS = 12000;
export const SOURCE_WINDOW_AUTO_LOAD_GAP = 240;
export const SUPPORTED_LIBRARY_IMPORT_EXTENSIONS = new Set(['.chm', '.txt', '.md', '.pdf', '.docx', '.epub']);
export const CONTEXT_MENU_VIEWPORT_MARGIN = 8;
export const CONTEXT_MENU_PADDING_Y = 6;
export const CONTEXT_MENU_BUTTON_HEIGHT = 30;
export const CONTEXT_MENU_SEPARATOR_HEIGHT = 9;
export const CONTEXT_SUBMENU_PADDING_Y = 12;
export const NODE_TYPE_LABELS = CORE_NODE_TYPE_LABELS;

export interface RefRow {
  id?: unknown;
  source_type?: string;
  source_id?: unknown;
  target_type?: string;
  target_id?: unknown;
  ref_kind?: string;
  source_address?: string;
  target_address?: string;
  [extra: string]: unknown;
}

export interface DocLike {
  doc?: { id?: unknown; tree_view_state?: unknown; folder_id?: unknown; [extra: string]: unknown };
  tree?: TreeNodeLike | null;
  loadedTreeDepth?: number;
  treeDepthStats?: { maxDepth?: number; depths?: number[]; root?: { subtreeMaxDepth?: number } } | null;
  sourceDocument?: Record<string, unknown> | null;
  title?: string;
  meta?: string | Record<string, unknown> | null;
  [extra: string]: unknown;
}

export interface SourceWindow {
  docId?: unknown;
  sourceDocument?: Record<string, unknown> | null;
  [extra: string]: unknown;
}

export interface DepthStats {
  maxDepth: number;
  depths: number[];
  counts?: Map<number, number>;
  root?: { subtreeMaxDepth?: number };
  [extra: string]: unknown;
}

interface TreeViewStateRaw {
  depthLimit?: unknown;
  collapsedNodeIds?: unknown;
  expandedNodeIds?: unknown;
  outlineCollapsedNodeIds?: unknown;
  [extra: string]: unknown;
}

export interface TreeViewState {
  depthLimit: number;
  collapsed: Set<string>;
  expanded: Set<string>;
  outlineCollapsed: Set<string> | null;
}

// doc-utils 沿数据流接 backend 真行类型：DocBrowserFolder = DocFolderRow（数据库行）、DocListItem = backend 投影。
// 内部不再保留宽松 unknown 字段——本文件 DocBrowser-only 函数（buildDocBrowser/filterLibraryTree/...）字段
// 都在真类型范围内，零兼容损失。
type DocBrowserFolder = DocFolderRow;
type DocListItem = BackendDocListItem;

interface DocBrowserItem {
  type: 'folder' | 'doc';
  folder?: DocBrowserFolder;
  doc?: DocListItem;
  depth: number;
  children?: DocBrowserItem[];
}

interface Camera { x: number; y: number; scale: number }
interface Viewport { width?: number; height?: number; w?: number; h?: number }
interface Rect { x: number; y: number; width: number; height: number }
interface MindMapNode {
  id?: unknown;
  address?: string;
  depth?: number;
  kind?: string;
  width?: number;
  height?: number;
  cardHeight?: number;
  x?: number;
  y?: number;
  [extra: string]: unknown;
}

// LibraryItem 收紧成 LibraryEntry（backend 真类型，沿数据流贯通）。原来 unknown indexer 给 isSupportedLibraryImport
// 等宽容形参的能力没人用，去掉无成本。
type LibraryItem = LibraryEntry;

export function depthOf(address: string = '1'): number {
  return address.split('-').length;
}

// 形参用 minimal duck-type，兼容 doc-utils.RefRow（宽松形态）与 schema.RefRow / DocGetRefRow（真行类型）。
export function isFactAxiomRef(ref: { source_type?: string; target_type?: string; ref_kind?: string } | null | undefined): boolean {
  return ref?.source_type === 'axiom' &&
    ref?.target_type === 'node' &&
    String(ref?.ref_kind || '') === '事实前提';
}

export function clampDepthLimit(value: unknown, maxDepth: unknown): number {
  const max = Math.max(1, Number(maxDepth) || 1);
  return Math.min(max, Math.max(1, Number(value) || 1));
}

export function clampFlowDepthLimit(value: unknown, maxDepth: unknown): number {
  const max = Math.max(1, Number(maxDepth) || 1);
  const min = Math.min(2, max);
  return Math.min(max, Math.max(min, Number(value) || min));
}

function rootMetadataDepthForDoc(doc: DocLike | null | undefined): number | null {
  const rootDepth = Number(
    doc?.treeDepthStats?.root?.subtreeMaxDepth
  );
  return Number.isFinite(rootDepth) && rootDepth > 0 ? rootDepth : null;
}

interface NodeLayoutSettingsRaw {
  tree?: unknown;
  flow?: unknown;
  [extra: string]: unknown;
}

export function normalizeNodeLayoutSettingsByView(value: NodeLayoutSettingsRaw | unknown): { tree: NodeLayout; flow: NodeLayout } {
  const settings = (value && typeof value === 'object' ? value as NodeLayoutSettingsRaw : {});
  if (settings.tree || settings.flow) {
    return {
      tree: normalizeNodeLayout(settings.tree || DEFAULT_NODE_LAYOUT),
      flow: normalizeNodeLayout(settings.flow || settings.tree || DEFAULT_NODE_LAYOUT)
    };
  }
  const shared = normalizeNodeLayout(value || DEFAULT_NODE_LAYOUT);
  return {
    tree: shared,
    flow: shared
  };
}

export function fullDepthForDoc(doc: DocLike | null | undefined): number {
  // 取元数据、treeDepthStats 和实际 tree 三者的最大值——
  // 本地新增节点后元数据可能还没更新，但 tree 已经包含新深度，
  // 单独信任元数据会让下拉框漏掉新深度选项。
  const rootDepth = rootMetadataDepthForDoc(doc);
  const indexedDepth = Number(doc?.treeDepthStats?.maxDepth);
  const treeDepth = maxTreeDepth(doc?.tree);
  const candidates = [rootDepth, indexedDepth, treeDepth].filter((v): v is number => Number.isFinite(v) && (v as number) > 0);
  if (!candidates.length) return 1;
  return Math.min(MAX_DEPTH_LIMIT, Math.max(1, Math.max(...candidates)));
}

export function loadedDepthForDoc(doc: DocLike | null | undefined): number {
  const explicit = Number(doc?.loadedTreeDepth);
  return Math.min(MAX_DEPTH_LIMIT, Math.max(1, Number.isFinite(explicit) && explicit > 0
    ? explicit
    : maxTreeDepth(doc?.tree)));
}

export function depthStatsForTree(tree: TreeNodeLike | null | undefined): DepthStats {
  const counts = new Map<number, number>();
  let maxDepth = 1;
  for (const node of flattenTree(tree)) {
    const depth = depthOf(String(node.address || '1'));
    maxDepth = Math.max(maxDepth, depth);
    counts.set(depth, (counts.get(depth) || 0) + 1);
  }
  const depths = [...counts.keys()].sort((a, b) => a - b);
  return { maxDepth: Math.min(MAX_DEPTH_LIMIT, maxDepth), depths, counts };
}

export function treeLoadDepthForView(depth: unknown): number {
  return Math.min(MAX_TREE_LOAD_DEPTH, Math.max(DEFAULT_TREE_LOAD_DEPTH, Math.floor(Number(depth) || DEFAULT_TREE_LOAD_DEPTH)));
}

interface TreeDocRequest {
  docId: unknown;
  maxTreeDepth: number;
  includeNodes: boolean;
  includeSourceSpans: boolean;
  includeSourceDocumentContent: boolean;
  includeEditBranch?: boolean;
  [extra: string]: unknown;
}

interface TreeDocRequestOptions {
  includeNodes?: boolean;
  includeSourceSpans?: boolean;
  includeSourceDocumentContent?: boolean;
  includeEditBranch?: boolean;
}

export function treeDocRequest(docId: unknown, depth: number = DEFAULT_TREE_LOAD_DEPTH, options: TreeDocRequestOptions = {}): TreeDocRequest {
  const request: TreeDocRequest = {
    docId,
    maxTreeDepth: treeLoadDepthForView(depth),
    includeNodes: options.includeNodes === true,
    includeSourceSpans: options.includeSourceSpans === true,
    includeSourceDocumentContent: options.includeSourceDocumentContent === true
  };
  if (options.includeEditBranch === false) request.includeEditBranch = false;
  return request;
}

export function sameDocId(left: unknown, right: unknown): boolean {
  return normalizeDocId(left) === normalizeDocId(right);
}

export function mergeSourceWindow(current: DocLike | null | undefined, sourceWindow: SourceWindow | null | undefined): DocLike | null | undefined {
  if (!current || !sourceWindow || !sameDocId(current?.doc?.id, sourceWindow.docId)) return current;
  const sourceDocument = sourceWindow.sourceDocument
    ? { ...(current.sourceDocument || {}), ...sourceWindow.sourceDocument }
    : current.sourceDocument;
  return {
    ...current,
    sourceDocument,
    sourceWindow
  };
}

export function docDepthStats(doc: DocLike | null | undefined): DepthStats {
  const stats = doc?.treeDepthStats || depthStatsForTree(doc?.tree);
  // 同 fullDepthForDoc：本地新增节点后元数据滞后，必须用三者最大值。
  const rootDepth = rootMetadataDepthForDoc(doc);
  const indexedDepth = Number(stats?.maxDepth);
  const treeDepth = maxTreeDepth(doc?.tree);
  const candidates = [rootDepth, indexedDepth, treeDepth].filter((v): v is number => Number.isFinite(v) && (v as number) > 0);
  const maxDepth = candidates.length
    ? Math.min(MAX_DEPTH_LIMIT, Math.max(1, Math.max(...candidates)))
    : 1;
  // depths：合并 stats.depths 和实际 tree 计算出的 depths，并补齐到 maxDepth；
  // 否则下拉框选项跟不上新增节点后的深度。
  const fromStats = Array.isArray(stats?.depths) ? stats!.depths : [];
  const fromTree = depthStatsForTree(doc?.tree).depths;
  const merged = new Set<number>();
  for (const d of [...fromStats, ...fromTree]) {
    const n = Math.max(1, Math.floor(Number(d) || 1));
    if (n >= 1 && n <= maxDepth) merged.add(n);
  }
  // 兜底：至少保证 1..maxDepth 都在选项里
  for (let i = 1; i <= maxDepth; i += 1) merged.add(i);
  const depths = [...merged].sort((left, right) => left - right);
  return {
    ...stats,
    maxDepth,
    depths: depths.length ? depths : [1]
  };
}

export function hasKnownChildren(node: TreeNodeLike | null | undefined): boolean {
  return Boolean(node && (((node.children || []).length > 0) || Number((node as { childCount?: unknown }).childCount ?? 0) > 0));
}

export function parseTreeViewState(value: unknown): TreeViewStateRaw {
  try {
    if (!value) return {};
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as TreeViewStateRaw : {};
  } catch {
    return {};
  }
}

export function idSetFromArray(value: unknown): Set<string> {
  const ids = new Set<string>();
  for (const item of Array.isArray(value) ? value : []) {
    const id = normalizeDocId(item);
    if (id) ids.add(id);
  }
  return ids;
}

export function treeViewStateFromDoc(doc: DocLike | null | undefined, maxDepth: number = 1): TreeViewState {
  const raw = parseTreeViewState(doc?.doc?.tree_view_state);
  const actualMaxDepth = Math.max(1, Number(maxDepth) || fullDepthForDoc(doc));
  const fallbackDepth = actualMaxDepth;
  return {
    depthLimit: clampDepthLimit(raw.depthLimit || fallbackDepth, actualMaxDepth),
    collapsed: idSetFromArray(raw.collapsedNodeIds),
    expanded: idSetFromArray(raw.expandedNodeIds),
    outlineCollapsed: Object.prototype.hasOwnProperty.call(raw, 'outlineCollapsedNodeIds')
      ? idSetFromArray(raw.outlineCollapsedNodeIds)
      : null
  };
}

interface TreeViewStatePayload {
  depthLimit: number;
  collapsedNodeIds: string[];
  expandedNodeIds: string[];
  outlineCollapsedNodeIds: string[];
}

export function treeViewStatePayload(depthLimit: unknown, collapsed: Set<unknown> | null | undefined, expanded: Set<unknown> | null | undefined, outlineCollapsed: Set<unknown> | null = null): TreeViewStatePayload {
  const idList = (value: Set<unknown> | null | undefined): string[] => [...(value || new Set<unknown>())]
    .map(normalizeDocId)
    .filter((value): value is string => Boolean(value));
  return {
    depthLimit: Math.max(1, Number(depthLimit) || 1),
    collapsedNodeIds: idList(collapsed),
    expandedNodeIds: idList(expanded),
    outlineCollapsedNodeIds: idList(outlineCollapsed)
  };
}

interface PromoteTreeViewResult {
  depthLimit: number;
  collapsed: Set<unknown>;
  expanded: Set<unknown>;
}

export function promoteTreeViewDepthIfLayerExpanded(
  tree: TreeNodeLike | null | undefined,
  depthLimit: unknown,
  collapsed: Set<unknown> | unknown[] | null | undefined,
  expanded: Set<unknown> | unknown[] | null | undefined,
  maxDepth: number = MAX_DEPTH_LIMIT
): PromoteTreeViewResult | null {
  if (!tree) return null;
  const currentDepth = Math.max(1, Number(depthLimit) || 1);
  const capDepth = Math.min(MAX_DEPTH_LIMIT, Math.max(1, Number(maxDepth) || MAX_DEPTH_LIMIT));
  if (currentDepth >= capDepth) return null;
  const collapsedIds = collapsed instanceof Set ? collapsed : new Set(collapsed || []);
  const expandedIds = expanded instanceof Set ? expanded : new Set(expanded || []);
  const nodes = flattenTree(tree);
  const expandableLayerNodes = nodes.filter((node) => (
    depthOf(String(node.address || '1')) === currentDepth && hasKnownChildren(node)
  ));
  if (expandableLayerNodes.length === 0) return null;
  const allExpanded = expandableLayerNodes.every((node) => (
    !collapsedIds.has(node.id) && expandedIds.has(node.id)
  ));
  if (!allExpanded) return null;

  const nextDepthLimit = Math.min(capDepth, currentDepth + 1);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const nextExpanded = new Set<unknown>();
  for (const id of expandedIds) {
    const node = nodesById.get(id);
    if (!node || depthOf(String(node.address || '1')) >= nextDepthLimit) nextExpanded.add(id);
  }
  return {
    depthLimit: nextDepthLimit,
    collapsed: collapsedForDepthLimit({ tree, collapsed: collapsedIds, depthLimit: nextDepthLimit }),
    expanded: nextExpanded
  };
}

export function hasVisibleNodesBeyondDepth(
  tree: TreeNodeLike | null | undefined,
  depthLimit: unknown,
  collapsed: Set<unknown> | unknown[] | null | undefined,
  expanded: Set<unknown> | unknown[] | null | undefined
): boolean {
  if (!tree) return false;
  const limit = Math.max(1, Number(depthLimit) || 1);
  const collapsedIds = collapsed instanceof Set ? collapsed : new Set(collapsed || []);
  const expandedIds = expanded instanceof Set ? expanded : new Set(expanded || []);
  let found = false;

  function walk(node: TreeNodeLike | null | undefined, depth: number, forcedVisible: boolean = false): void {
    if (!node || found) return;
    if (depth > limit && !forcedVisible) return;
    if (depth > limit) {
      found = true;
      return;
    }
    if (collapsedIds.has(node.id)) return;
    const showChildren = depth < limit || expandedIds.has(node.id);
    if (!showChildren) return;
    for (const child of node.children || []) walk(child, depth + 1, showChildren);
  }

  walk(tree, 1);
  return found;
}

export function hasKnownNodesBeyondLoadedDepth(tree: TreeNodeLike | null | undefined, loadedDepth: unknown): boolean {
  const depth = Math.max(1, Number(loadedDepth) || 1);
  return flattenTree(tree).some((node) => depthOf(String(node.address || '1')) >= depth && hasKnownChildren(node));
}

export function compareAddress(left: string = '', right: string = ''): number {
  const a = String(left).split('-').map(Number);
  const b = String(right).split('-').map(Number);
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function nodeTypeLabel(type: unknown): string {
  const labels = NODE_TYPE_LABELS as Record<string, string>;
  const key = String(type || '');
  return labels[key] || key || '文本';
}

export function docParentKey(folderId: unknown): string {
  return folderId === null || folderId === undefined || folderId === '' ? 'root' : String(folderId);
}

export function limitDocFolderName(value: unknown): string {
  return Array.from(String(value ?? '')).slice(0, MAX_DOC_FOLDER_NAME_LENGTH).join('');
}

export function normalizeDocFolderName(value: unknown): string {
  const trimmed = String(value ?? '').trim();
  return limitDocFolderName(trimmed || DEFAULT_DOC_FOLDER_NAME);
}

export function compareDocListItems(left: DocListItem, right: DocListItem): number {
  const leftOrder = Number(left.doc_sort_order || 0);
  const rightOrder = Number(right.doc_sort_order || 0);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(right.updated_at || '').localeCompare(String(left.updated_at || ''))
    || String(right.id || '').localeCompare(String(left.id || ''));
}

interface DocBrowserResult {
  items: DocBrowserItem[];
  flatFolders: Array<DocBrowserFolder & { depth: number }>;
}

export function buildDocBrowser(folders: DocBrowserFolder[] = [], docs: DocListItem[] = []): DocBrowserResult {
  const foldersByParent = new Map<string, DocBrowserFolder[]>();
  const docsByFolder = new Map<string, DocListItem[]>();

  for (const folder of folders) {
    const key = docParentKey(folder.parent_id);
    const list = foldersByParent.get(key) || [];
    list.push(folder);
    foldersByParent.set(key, list);
  }
  for (const doc of docs) {
    const key = docParentKey(doc.folder_id);
    const list = docsByFolder.get(key) || [];
    list.push(doc);
    docsByFolder.set(key, list);
  }

  for (const group of foldersByParent.values()) {
    group.sort((left, right) => {
      const orderDiff = Number(left.sort_order || 0) - Number(right.sort_order || 0);
      if (orderDiff !== 0) return orderDiff;
      return String(left.name || '').localeCompare(String(right.name || '')) || Number(left.id) - Number(right.id);
    });
  }
  for (const group of docsByFolder.values()) group.sort(compareDocListItems);

  const flatFolders: Array<DocBrowserFolder & { depth: number }> = [];
  const buildItems = (parentId: unknown, depth: number): DocBrowserItem[] => {
    const key = docParentKey(parentId);
    const items: DocBrowserItem[] = [];
    for (const folder of foldersByParent.get(key) || []) {
      flatFolders.push({ ...folder, depth });
      items.push({
        type: 'folder',
        folder,
        depth,
        children: buildItems(folder.id, depth + 1)
      });
    }
    for (const doc of docsByFolder.get(key) || []) {
      items.push({ type: 'doc', doc, depth });
    }
    return items;
  };

  return { items: buildItems(null, 0), flatFolders };
}

export function normalizeFsPath(value: unknown = ''): string {
  return String(value || '').replace(/\\/g, '/').toLocaleLowerCase();
}

export function isSupportedLibraryImport(item: LibraryItem | null | undefined): boolean {
  if (!item || item.type !== 'file') return true;
  return SUPPORTED_LIBRARY_IMPORT_EXTENSIONS.has(String(item.extension || '').toLocaleLowerCase());
}

export function docSourcePath(doc: DocLike | null | undefined): string {
  const meta = doc?.meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) return String((meta as { sourcePath?: unknown }).sourcePath || '');
  try {
    return JSON.parse(String(meta || '{}'))?.sourcePath || '';
  } catch {
    return '';
  }
}

export function fileNameFromPath(value: unknown = ''): string {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

export function fileExtensionFromPath(value: unknown = ''): string {
  const name = fileNameFromPath(value);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

export function docDisplayTitle(doc: DocLike | null | undefined): string {
  const title = String(doc?.title || '').trim();
  const extension = fileExtensionFromPath(docSourcePath(doc));
  if (!title) return fileNameFromPath(docSourcePath(doc)) || '';
  if (extension && !title.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase())) {
    return `${title}${extension}`;
  }
  return title;
}

export function libraryCollapseKey(relativePath: string = ''): string {
  return `library:${relativePath || 'root'}`;
}

export function filterLibraryTree(item: LibraryItem | null | undefined, query: unknown): LibraryItem | null {
  if (!item) return null;
  const trimmed = String(query || '').trim().toLocaleLowerCase();
  if (!trimmed) return item;
  const ownMatch = String(item.name || '').toLocaleLowerCase().includes(trimmed);
  if (item.type !== 'folder') return ownMatch ? item : null;
  const children = (item.children || [])
    .map((child) => filterLibraryTree(child, trimmed))
    .filter((child): child is LibraryItem => Boolean(child));
  return ownMatch || children.length > 0 || item.relativePath === ''
    ? { ...item, children }
    : null;
}

export function libraryFolderCollapseKeys(item: LibraryItem | null | undefined, keys: string[] = []): string[] {
  for (const child of item?.children || []) {
    if (child.type !== 'folder') continue;
    keys.push(libraryCollapseKey(child.relativePath));
    libraryFolderCollapseKeys(child, keys);
  }
  return keys;
}

export function defaultCollapsedOutlineIds(tree: TreeNodeLike | null | undefined): Set<unknown> {
  const ids = new Set<unknown>();
  const visit = (node: TreeNodeLike | null | undefined): void => {
    if (!node) return;
    if (depthOf(String(node.address || '1')) >= 2 && hasKnownChildren(node)) {
      ids.add(node.id);
    }
    for (const child of node.children || []) visit(child);
  };
  visit(tree);
  return ids;
}

export function buildParagraphLabelMap(tree: TreeNodeLike | null | undefined): Map<string, string> {
  const nodes = flattenTree(tree)
    .map((node) => ({
      id: String(node.id || ''),
      position: Number((node as { sourcePosition?: unknown; source_position?: unknown }).sourcePosition
        ?? (node as { source_position?: unknown }).source_position)
    }))
    .filter((item) => item.id && Number.isFinite(item.position) && !Number.isInteger(item.position))
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  return new Map(nodes.map((item, index) => [item.id, String(index + 1)]));
}

export function isEditableTarget(target: { closest?: (selector: string) => Element | null } | null | undefined): boolean {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalizeDocId(docId: unknown): string | null {
  if (docId === null || docId === undefined) return null;
  const text = String(docId).trim();
  if (/^\d+$/.test(text) && Number(text) <= 0) return null;
  if (text) return text;
  return null;
}

export function readPersistedActiveDocId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeDocId(window.localStorage?.getItem(ACTIVE_DOC_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function persistActiveDocId(docId: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    const value = normalizeDocId(docId);
    if (value) window.localStorage?.setItem(ACTIVE_DOC_STORAGE_KEY, String(value));
    else window.localStorage?.removeItem(ACTIVE_DOC_STORAGE_KEY);
  } catch {
    // Ignore storage failures; opening documents should still work.
  }
}

export function summaryNotesVisibleStorageKey(docId: unknown): string | null {
  const value = normalizeDocId(docId);
  return value ? `iftree.summaryNotesVisible:${value}` : null;
}

export function readPersistedSummaryNotesVisible(docId: unknown): boolean {
  if (typeof window === 'undefined') return true;
  const key = summaryNotesVisibleStorageKey(docId);
  if (!key) return true;
  try {
    const value = window.localStorage?.getItem(key);
    return value === null ? true : value !== '0';
  } catch {
    return true;
  }
}

export function persistSummaryNotesVisible(docId: unknown, visible: boolean): void {
  if (typeof window === 'undefined') return;
  const key = summaryNotesVisibleStorageKey(docId);
  if (!key) return;
  try {
    window.localStorage?.setItem(key, visible ? '1' : '0');
  } catch {
    // Ignore storage failures; the visible state can still work in memory.
  }
}

export function focusCameraOnRect(rect: Rect | null | undefined, viewport: Viewport | null | undefined, camera: Camera | null | undefined, options: { minScale?: number } = {}): Camera {
  const baseCamera: Camera = camera || { x: 0, y: 0, scale: 1 };
  if (!rect || !viewport?.width || !viewport?.height) return baseCamera;
  const currentScale = Number.isFinite(baseCamera.scale) ? baseCamera.scale : 1;
  const scale = Math.max(currentScale, options.minScale ?? currentScale);
  const tall = Number(rect.height) > viewport.height / scale * 1.5;
  const wide = Number(rect.width) > viewport.width / scale * 1.5;
  return {
    ...baseCamera,
    scale,
    x: wide ? rect.x - 32 / scale : rect.x + rect.width / 2 - viewport.width / (2 * scale),
    y: tall ? rect.y - 48 / scale : rect.y + rect.height / 2 - viewport.height / (2 * scale)
  };
}

export function initialMindMapCamera(nodes: MindMapNode[], bounds: Rect | null | undefined, viewport: Viewport | null | undefined, selectedNodeId: unknown): Camera {
  if (!bounds || !viewport?.width || !viewport?.height) return { x: 0, y: 0, scale: 1 };
  const fit = fitCameraToBounds(bounds, viewport);
  if (fit.scale >= 0.24) return fit;
  const target = nodes.find((node) => node.id === selectedNodeId) || nodes[0];
  if (!target) return fit;
  const targetIsRoot = String(target.address || '') === '1' || Number(target.depth) === 1;
  const axiomNodes = targetIsRoot
    ? nodes.filter((node) => node?.kind === 'axiom' || node?.kind === 'axiom-group')
    : [];
  if (axiomNodes.length > 0) {
    const axiomFit = fitCameraToBounds(boundsFromNodes([target, ...axiomNodes] as never, 48), viewport, { maxScale: 1 });
    if (axiomFit.scale >= 0.24) return axiomFit;
  }
  const scale = Math.min(1, Math.max(0.24, viewport.width * 0.72 / Math.max(1, Number(target.width) || 1)));
  const centerX = (Number(target.x) || 0) + (Number(target.width) || 1) / 2;
  const centerY = (Number(target.y) || 0) + (Number(target.cardHeight || target.height) || 1) / 2;
  return {
    x: centerX - viewport.width / (2 * scale),
    y: centerY - viewport.height / (2 * scale),
    scale
  };
}

export function expandedMindMapRenderRect(camera: Partial<Camera> | null | undefined, viewport: Viewport | null | undefined): Rect & { scale: number } {
  const scale = Math.max(0.000001, Number(camera?.scale) || 1);
  const width = Math.max(1, Number(viewport?.width) || 1) / scale;
  const height = Math.max(1, Number(viewport?.height) || 1) / scale;
  return {
    x: (Number(camera?.x) || 0) - width * MINDMAP_RENDER_OVERSCAN_SCREENS,
    y: (Number(camera?.y) || 0) - height * MINDMAP_RENDER_OVERSCAN_SCREENS,
    width: width * (1 + MINDMAP_RENDER_OVERSCAN_SCREENS * 2),
    height: height * (1 + MINDMAP_RENDER_OVERSCAN_SCREENS * 2),
    scale
  };
}
