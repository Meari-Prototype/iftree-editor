import { DEFAULT_NODE_LAYOUT, MAX_DEPTH_LIMIT, normalizeNodeLayout } from '../../core/mindmap.mjs';
import { flattenTree, maxTreeDepth } from '../../core/tree.mjs';
import { collapsedForDepthLimit } from '../../core/tree-ui.mjs';
import { boundsFromNodes, fitCameraToBounds } from '../../core/viewport.mjs';
import { NODE_TYPE_LABELS as CORE_NODE_TYPE_LABELS, toTreeNode } from '../../core/node-model.mjs';

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

export function depthOf(address = '1') {
  return address.split('-').length;
}

export function isFactAxiomRef(ref) {
  return ref?.source_type === 'axiom' &&
    ref?.target_type === 'node' &&
    String(ref?.ref_kind || '') === '事实前提';
}

export function clampDepthLimit(value, maxDepth) {
  const max = Math.max(1, Number(maxDepth) || 1);
  return Math.min(max, Math.max(1, Number(value) || 1));
}

export function clampFlowDepthLimit(value, maxDepth) {
  const max = Math.max(1, Number(maxDepth) || 1);
  const min = Math.min(2, max);
  return Math.min(max, Math.max(min, Number(value) || min));
}

function rootMetadataDepthForDoc(doc) {
  const rootDepth = Number(
    doc?.treeDepthStats?.root?.subtreeMaxDepth
  );
  return Number.isFinite(rootDepth) && rootDepth > 0 ? rootDepth : null;
}

export function normalizeNodeLayoutSettingsByView(value) {
  if (value?.tree || value?.flow) {
    return {
      tree: normalizeNodeLayout(value.tree || DEFAULT_NODE_LAYOUT),
      flow: normalizeNodeLayout(value.flow || value.tree || DEFAULT_NODE_LAYOUT)
    };
  }
  const shared = normalizeNodeLayout(value || DEFAULT_NODE_LAYOUT);
  return {
    tree: shared,
    flow: shared
  };
}

export function fullDepthForDoc(doc) {
  // 取元数据、treeDepthStats 和实际 tree 三者的最大值——
  // 本地新增节点后元数据可能还没更新，但 tree 已经包含新深度，
  // 单独信任元数据会让下拉框漏掉新深度选项。
  const rootDepth = rootMetadataDepthForDoc(doc);
  const indexedDepth = Number(doc?.treeDepthStats?.maxDepth);
  const treeDepth = maxTreeDepth(doc?.tree);
  const candidates = [rootDepth, indexedDepth, treeDepth].filter((v) => Number.isFinite(v) && v > 0);
  if (!candidates.length) return 1;
  return Math.min(MAX_DEPTH_LIMIT, Math.max(1, Math.max(...candidates)));
}

export function loadedDepthForDoc(doc) {
  const explicit = Number(doc?.loadedTreeDepth);
  return Math.min(MAX_DEPTH_LIMIT, Math.max(1, Number.isFinite(explicit) && explicit > 0
    ? explicit
    : maxTreeDepth(doc?.tree)));
}

export function depthStatsForTree(tree) {
  const counts = new Map();
  let maxDepth = 1;
  for (const node of flattenTree(tree)) {
    const depth = depthOf(node.address || '1');
    maxDepth = Math.max(maxDepth, depth);
    counts.set(depth, (counts.get(depth) || 0) + 1);
  }
  const depths = [...counts.keys()].sort((a, b) => a - b);
  return { maxDepth: Math.min(MAX_DEPTH_LIMIT, maxDepth), depths, counts };
}

export function treeLoadDepthForView(depth) {
  return Math.min(MAX_TREE_LOAD_DEPTH, Math.max(DEFAULT_TREE_LOAD_DEPTH, Math.floor(Number(depth) || DEFAULT_TREE_LOAD_DEPTH)));
}

export function treeDocRequest(docId, depth = DEFAULT_TREE_LOAD_DEPTH, options = {}) {
  const request = {
    docId,
    maxTreeDepth: treeLoadDepthForView(depth),
    includeNodes: options.includeNodes === true,
    includeSourceSpans: options.includeSourceSpans === true,
    includeSourceDocumentContent: options.includeSourceDocumentContent === true
  };
  if (options.includeEditBranch === false) request.includeEditBranch = false;
  return request;
}

export function sameDocId(left, right) {
  return normalizeDocId(left) === normalizeDocId(right);
}

export function mergeDocView(current, next) {
  if (!current || !next || !sameDocId(current?.doc?.id, next?.doc?.id)) return next;
  return {
    ...next,
    // 同文档合并时保留编辑分支标识：写操作返回的 doc 视图通常不带 editBranch，
    // 若不保留，编辑态会在一次写入后丢失标识。next 显式给出（含 null）时以 next 为准。
    editBranch: next.editBranch !== undefined ? next.editBranch : (current.editBranch ?? null),
    nodes: next.nodes?.length ? next.nodes : (current.nodes || []),
    treeIndex: next.treeIndex || current.treeIndex || null,
    flatTree: next.flatTree || current.flatTree || null,
    loadedTreeDepth: next.loadedTreeDepth || current.loadedTreeDepth || loadedDepthForDoc(next),
    idByAddress: next.idByAddress && Object.keys(next.idByAddress).length ? next.idByAddress : (current.idByAddress || {}),
    treeDepthStats: next.treeDepthStats || current.treeDepthStats,
    sourceDocument: next.sourceDocument?.raw_markdown ? next.sourceDocument : (current.sourceDocument || next.sourceDocument),
    sourceSpans: next.sourceSpans?.length ? next.sourceSpans : (current.sourceSpans || []),
    sourceWindow: current.sourceWindow || next.sourceWindow || null,
    sourcePdfPages: next.sourcePdfPages?.length ? next.sourcePdfPages : (current.sourcePdfPages || [])
  };
}

export function mergeSourceWindow(current, sourceWindow) {
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

export function docDepthStats(doc) {
  const stats = doc?.treeDepthStats || depthStatsForTree(doc?.tree);
  // 同 fullDepthForDoc：本地新增节点后元数据滞后，必须用三者最大值。
  const rootDepth = rootMetadataDepthForDoc(doc);
  const indexedDepth = Number(stats?.maxDepth);
  const treeDepth = maxTreeDepth(doc?.tree);
  const candidates = [rootDepth, indexedDepth, treeDepth].filter((v) => Number.isFinite(v) && v > 0);
  const maxDepth = candidates.length
    ? Math.min(MAX_DEPTH_LIMIT, Math.max(1, Math.max(...candidates)))
    : 1;
  // depths：合并 stats.depths 和实际 tree 计算出的 depths，并补齐到 maxDepth；
  // 否则下拉框选项跟不上新增节点后的深度。
  const fromStats = Array.isArray(stats?.depths) ? stats.depths : [];
  const fromTree = depthStatsForTree(doc?.tree).depths;
  const merged = new Set();
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

export function hasKnownChildren(node) {
  return Boolean(node && (((node.children || []).length > 0) || Number(node.childCount ?? 0) > 0));
}

export function parseTreeViewState(value) {
  try {
    if (!value) return {};
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function idSetFromArray(value) {
  const ids = new Set();
  for (const item of Array.isArray(value) ? value : []) {
    const id = normalizeDocId(item);
    if (id) ids.add(id);
  }
  return ids;
}

export function treeViewStateFromDoc(doc, maxDepth = 1) {
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

export function treeViewStatePayload(depthLimit, collapsed, expanded, outlineCollapsed = null) {
  const idList = (value) => [...(value || new Set())]
    .map(normalizeDocId)
    .filter(Boolean);
  return {
    depthLimit: Math.max(1, Number(depthLimit) || 1),
    collapsedNodeIds: idList(collapsed),
    expandedNodeIds: idList(expanded),
    outlineCollapsedNodeIds: idList(outlineCollapsed)
  };
}

export function promoteTreeViewDepthIfLayerExpanded(tree, depthLimit, collapsed, expanded, maxDepth = MAX_DEPTH_LIMIT) {
  if (!tree) return null;
  const currentDepth = Math.max(1, Number(depthLimit) || 1);
  const capDepth = Math.min(MAX_DEPTH_LIMIT, Math.max(1, Number(maxDepth) || MAX_DEPTH_LIMIT));
  if (currentDepth >= capDepth) return null;
  const collapsedIds = collapsed instanceof Set ? collapsed : new Set(collapsed || []);
  const expandedIds = expanded instanceof Set ? expanded : new Set(expanded || []);
  const nodes = flattenTree(tree);
  const expandableLayerNodes = nodes.filter((node) => (
    depthOf(node.address || '1') === currentDepth && hasKnownChildren(node)
  ));
  if (expandableLayerNodes.length === 0) return null;
  const allExpanded = expandableLayerNodes.every((node) => (
    !collapsedIds.has(node.id) && expandedIds.has(node.id)
  ));
  if (!allExpanded) return null;

  const nextDepthLimit = Math.min(capDepth, currentDepth + 1);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const nextExpanded = new Set();
  for (const id of expandedIds) {
    const node = nodesById.get(id);
    if (!node || depthOf(node.address || '1') >= nextDepthLimit) nextExpanded.add(id);
  }
  return {
    depthLimit: nextDepthLimit,
    collapsed: collapsedForDepthLimit({ tree, collapsed: collapsedIds, depthLimit: nextDepthLimit }),
    expanded: nextExpanded
  };
}

export function hasVisibleNodesBeyondDepth(tree, depthLimit, collapsed, expanded) {
  if (!tree) return false;
  const limit = Math.max(1, Number(depthLimit) || 1);
  const collapsedIds = collapsed instanceof Set ? collapsed : new Set(collapsed || []);
  const expandedIds = expanded instanceof Set ? expanded : new Set(expanded || []);
  let found = false;

  function walk(node, depth, forcedVisible = false) {
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

export function hasKnownNodesBeyondLoadedDepth(tree, loadedDepth) {
  const depth = Math.max(1, Number(loadedDepth) || 1);
  return flattenTree(tree).some((node) => depthOf(node.address || '1') >= depth && hasKnownChildren(node));
}

export function compareAddress(left = '', right = '') {
  const a = String(left).split('-').map(Number);
  const b = String(right).split('-').map(Number);
  const size = Math.max(a.length, b.length);
  for (let index = 0; index < size; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function nodeTypeLabel(type) {
  return NODE_TYPE_LABELS[type] || type || '文本';
}

export function docParentKey(folderId) {
  return folderId === null || folderId === undefined || folderId === '' ? 'root' : String(folderId);
}

export function limitDocFolderName(value) {
  return Array.from(String(value ?? '')).slice(0, MAX_DOC_FOLDER_NAME_LENGTH).join('');
}

export function normalizeDocFolderName(value) {
  const trimmed = String(value ?? '').trim();
  return limitDocFolderName(trimmed || DEFAULT_DOC_FOLDER_NAME);
}

export function compareDocListItems(left, right) {
  const leftOrder = Number(left.doc_sort_order || 0);
  const rightOrder = Number(right.doc_sort_order || 0);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return String(right.updated_at || '').localeCompare(String(left.updated_at || ''))
    || String(right.id || '').localeCompare(String(left.id || ''));
}

export function buildDocBrowser(folders = [], docs = []) {
  const foldersByParent = new Map();
  const docsByFolder = new Map();

  for (const folder of folders) {
    const key = docParentKey(folder.parent_id);
    if (!foldersByParent.has(key)) foldersByParent.set(key, []);
    foldersByParent.get(key).push(folder);
  }
  for (const doc of docs) {
    const key = docParentKey(doc.folder_id);
    if (!docsByFolder.has(key)) docsByFolder.set(key, []);
    docsByFolder.get(key).push(doc);
  }

  for (const group of foldersByParent.values()) {
    group.sort((left, right) => {
      const orderDiff = Number(left.sort_order || 0) - Number(right.sort_order || 0);
      if (orderDiff !== 0) return orderDiff;
      return String(left.name || '').localeCompare(String(right.name || '')) || Number(left.id) - Number(right.id);
    });
  }
  for (const group of docsByFolder.values()) group.sort(compareDocListItems);

  const flatFolders = [];
  const buildItems = (parentId, depth) => {
    const key = docParentKey(parentId);
    const items = [];
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

export function normalizeFsPath(value = '') {
  return String(value || '').replace(/\\/g, '/').toLocaleLowerCase();
}

export function isSupportedLibraryImport(item) {
  if (!item || item.type !== 'file') return true;
  return SUPPORTED_LIBRARY_IMPORT_EXTENSIONS.has(String(item.extension || '').toLocaleLowerCase());
}

export function docSourcePath(doc) {
  const meta = doc?.meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) return meta.sourcePath || '';
  try {
    return JSON.parse(meta || '{}')?.sourcePath || '';
  } catch {
    return '';
  }
}

export function fileNameFromPath(value = '') {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

export function fileExtensionFromPath(value = '') {
  const name = fileNameFromPath(value);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

export function docDisplayTitle(doc) {
  const title = String(doc?.title || '').trim();
  const extension = fileExtensionFromPath(docSourcePath(doc));
  if (!title) return fileNameFromPath(docSourcePath(doc)) || '';
  if (extension && !title.toLocaleLowerCase().endsWith(extension.toLocaleLowerCase())) {
    return `${title}${extension}`;
  }
  return title;
}

export function libraryCollapseKey(relativePath = '') {
  return `library:${relativePath || 'root'}`;
}

export function filterLibraryTree(item, query) {
  if (!item) return null;
  const trimmed = String(query || '').trim().toLocaleLowerCase();
  if (!trimmed) return item;
  const ownMatch = String(item.name || '').toLocaleLowerCase().includes(trimmed);
  if (item.type !== 'folder') return ownMatch ? item : null;
  const children = (item.children || [])
    .map((child) => filterLibraryTree(child, trimmed))
    .filter(Boolean);
  return ownMatch || children.length > 0 || item.relativePath === ''
    ? { ...item, children }
    : null;
}

export function libraryFolderCollapseKeys(item, keys = []) {
  for (const child of item?.children || []) {
    if (child.type !== 'folder') continue;
    keys.push(libraryCollapseKey(child.relativePath));
    libraryFolderCollapseKeys(child, keys);
  }
  return keys;
}

export function defaultCollapsedOutlineIds(tree) {
  const ids = new Set();
  const visit = (node) => {
    if (!node) return;
    if (depthOf(node.address || '1') >= 2 && hasKnownChildren(node)) {
      ids.add(node.id);
    }
    for (const child of node.children || []) visit(child);
  };
  visit(tree);
  return ids;
}

export function buildParagraphLabelMap(tree) {
  const nodes = flattenTree(tree)
    .map((node) => ({
      id: String(node.id || ''),
      position: Number(node.sourcePosition ?? node.source_position)
    }))
    .filter((item) => item.id && Number.isFinite(item.position) && !Number.isInteger(item.position))
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  return new Map(nodes.map((item, index) => [item.id, String(index + 1)]));
}

export function treeNodeFromRow(row, address, children = []) {
  const base = toTreeNode(row);
  if (!base) return { id: row.id, address, children };
  return { ...base, address: address || base.address, children };
}

export function mergeNodeChildrenIntoTree(tree, nodeId, result) {
  const rows = Array.isArray(result?.rows) ? result.rows : (Array.isArray(result) ? result : []);
  if (!tree || rows.length === 0) return tree;
  const offset = Math.max(0, Math.floor(Number(result?.offset) || 0));
  const total = Number.isFinite(Number(result?.total)) ? Number(result.total) : null;
  const hasMore = result?.hasMore === true;
  function clone(node) {
    if (String(node.id) === String(nodeId)) {
      const currentChildren = node.children || [];
      const existingById = new Map(currentChildren.map((child) => [String(child.id), child]));
      const nextChildren = offset > 0 ? [...currentChildren] : [];
      for (const [index, row] of rows.entries()) {
        const childIndex = offset + index;
        const existing = existingById.get(String(row.id));
        nextChildren[childIndex] = {
          ...treeNodeFromRow(row, `${node.address}-${childIndex + 1}`, existing?.children || []),
          children_page: existing?.children_page || null
        };
      }
      const compactChildren = nextChildren.filter(Boolean);
      const resolvedTotal = Math.max(
        total ?? 0,
        compactChildren.length,
        Number(node.childCount ?? 0) || 0
      );
      return {
        ...node,
        children: compactChildren,
        childCount: resolvedTotal,
        children_page: {
          loaded: compactChildren.length,
          total: resolvedTotal,
          hasMore
        }
      };
    }
    return { ...node, children: (node.children || []).map(clone) };
  }
  return clone(tree);
}

export function isEditableTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeDocId(docId) {
  if (docId === null || docId === undefined) return null;
  const text = String(docId).trim();
  if (/^\d+$/.test(text) && Number(text) <= 0) return null;
  if (text) return text;
  return null;
}

export function readPersistedActiveDocId() {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeDocId(window.localStorage?.getItem(ACTIVE_DOC_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function persistActiveDocId(docId) {
  if (typeof window === 'undefined') return;
  try {
    const value = normalizeDocId(docId);
    if (value) window.localStorage?.setItem(ACTIVE_DOC_STORAGE_KEY, String(value));
    else window.localStorage?.removeItem(ACTIVE_DOC_STORAGE_KEY);
  } catch {
    // Ignore storage failures; opening documents should still work.
  }
}

export function summaryNotesVisibleStorageKey(docId) {
  const value = normalizeDocId(docId);
  return value ? `iftree.summaryNotesVisible:${value}` : null;
}

export function readPersistedSummaryNotesVisible(docId) {
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

export function persistSummaryNotesVisible(docId, visible) {
  if (typeof window === 'undefined') return;
  const key = summaryNotesVisibleStorageKey(docId);
  if (!key) return;
  try {
    window.localStorage?.setItem(key, visible ? '1' : '0');
  } catch {
    // Ignore storage failures; the visible state can still work in memory.
  }
}

export function focusCameraOnRect(rect, viewport, camera, options = {}) {
  if (!rect || !viewport?.width || !viewport?.height) return camera;
  const currentScale = Number.isFinite(camera?.scale) ? camera.scale : 1;
  const scale = Math.max(currentScale, options.minScale ?? currentScale);
  const tall = Number(rect.height) > viewport.height / scale * 1.5;
  const wide = Number(rect.width) > viewport.width / scale * 1.5;
  return {
    ...camera,
    scale,
    x: wide ? rect.x - 32 / scale : rect.x + rect.width / 2 - viewport.width / (2 * scale),
    y: tall ? rect.y - 48 / scale : rect.y + rect.height / 2 - viewport.height / (2 * scale)
  };
}

export function initialMindMapCamera(nodes, bounds, viewport, selectedNodeId) {
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
    const axiomFit = fitCameraToBounds(boundsFromNodes([target, ...axiomNodes], 48), viewport, { maxScale: 1 });
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

export function expandedMindMapRenderRect(camera, viewport) {
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

// ── 跨文档身份重映射（base ↔ shadow 切换时保持视图状态）────────────
// 节点 id 在 base 与 shadow 文档间不同，但树地址相同；axiom 靠 label 对齐。

function nodesForIdMapping(doc) {
  return Array.isArray(doc?.flatTree) && doc.flatTree.length > 0
    ? doc.flatTree
    : flattenTree(doc?.tree);
}

function nodeAddressByIdMap(doc) {
  const map = new Map();
  for (const node of nodesForIdMapping(doc)) {
    const id = normalizeDocId(node?.id);
    if (id && node?.address) map.set(String(id), String(node.address));
  }
  return map;
}

function nodeIdByAddressMap(doc) {
  const map = new Map();
  if (doc?.idByAddress && typeof doc.idByAddress === 'object') {
    for (const [address, id] of Object.entries(doc.idByAddress)) {
      const normalizedId = normalizeDocId(id);
      if (address && normalizedId) map.set(String(address), normalizedId);
    }
  }
  for (const node of nodesForIdMapping(doc)) {
    const id = normalizeDocId(node?.id);
    if (id && node?.address) map.set(String(node.address), id);
  }
  return map;
}

function axiomLabelByIdMap(doc) {
  return new Map((doc?.axioms || [])
    .map((axiom) => [String(normalizeDocId(axiom?.id)), String(axiom?.label || '')])
    .filter(([, label]) => label));
}

function axiomIdByLabelMap(doc) {
  return new Map((doc?.axioms || [])
    .map((axiom) => [String(axiom?.label || ''), normalizeDocId(axiom?.id)])
    .filter(([label, id]) => label && id));
}

export function remapNodeIdByAddress(sourceDoc, targetDoc, value) {
  if (!value) return value;
  const raw = String(value);
  if (raw.startsWith('axiom:')) {
    const label = axiomLabelByIdMap(sourceDoc).get(raw.slice('axiom:'.length));
    const mappedAxiomId = label ? axiomIdByLabelMap(targetDoc).get(label) : null;
    return mappedAxiomId ? `axiom:${mappedAxiomId}` : value;
  }
  const sourceAddress = nodeAddressByIdMap(sourceDoc).get(String(normalizeDocId(value)));
  if (!sourceAddress) return value;
  return nodeIdByAddressMap(targetDoc).get(sourceAddress) || value;
}

export function remapNodeIdSetByAddress(sourceDoc, targetDoc, ids) {
  const next = new Set();
  for (const id of ids || []) {
    const mapped = remapNodeIdByAddress(sourceDoc, targetDoc, id);
    const normalized = normalizeDocId(mapped);
    if (normalized) next.add(normalized);
  }
  return next;
}

export function patchNodeInTree(root, row) {
  if (!root || !row?.id) return root;
  // Use string comparison so tmp ids ("tmp-node-…") in lazy edit branches
  // patch correctly alongside numeric base ids.
  if (String(root.id) === String(row.id)) {
    return { ...root, ...row, children: root.children || row.children || [] };
  }
  if (!Array.isArray(root.children) || root.children.length === 0) return root;
  let changed = false;
  const children = root.children.map((child) => {
    const next = patchNodeInTree(child, row);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function patchNodeInDoc(doc, row) {
  if (!doc || !row?.id) return doc;
  return {
    ...doc,
    tree: patchNodeInTree(doc.tree, row),
    nodes: Array.isArray(doc.nodes)
      ? doc.nodes.map((node) => (String(node.id) === String(row.id) ? { ...node, ...row } : node))
      : doc.nodes
  };
}
