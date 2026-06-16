import { parseJsonObject, compareNodeAddress } from './shared.mjs';
import { listMemoryVolumes, sealDueMemoryVolumes } from './memory-volumes.mjs';
import { handleDebugOverviewQuery, handleDebugSqlQuery } from './handlers/read/debug.mjs';
import { ENTITY_READ_ACTIONS, runEntityRead } from './entities/read.mjs';
import { normalizeStableId } from './db/ids.mjs';

const ACTIONS = Object.freeze([
  'query.actions',
  'debug.sql',
  'debug.overview',
  'content.listDocs',
  'library.index',
  'library.getNavigation',
  'content.getIndex',
  'content.getNode',
  'content.getSubtree',
  'content.getDepth',
  'content.getArticle',
  'content.searchKeyword',
  'content.search',
  'content.searchAll',
  ...ENTITY_READ_ACTIONS,
  'library.getTree',
  'memory.listVolumes',
  'doc.list',
  'docFolder.list',
  'history.diff',
  'diff.refs',
  'history.nodeLog',
  'editBranch.listPending',
  'editBranch.diffView',
  'editBranch.threeWayMerge',
  'doc.get',
  'doc.exportMarkdown',
  'doc.getInfo',
  'doc.hasTreeDepth',
  'node.get',
  'node.listChildren',
  'node.listPage',
  'node.search',
  'node.getTextBatch',
  'node.listStructureRows',
  'subtree.getTextWindow',
  'subtree.getSlotRange',
  'node.getAncestorChain',
  'source.getWindow'
]);

const STABLE_ID_SCHEMA = Object.freeze({
  anyOf: [{ type: 'string' }, { type: 'number' }]
});

function normalizeQueryAction(value) {
  const action = String(value || 'debug.overview').trim();
  return ACTIONS.includes(action) ? action : '';
}

function normalizePositiveInteger(value, fallback = null) {
  const number = Math.floor(Number(value));
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeQueryId(value, fallback = null) {
  return normalizeStableId(value, fallback);
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const number = Math.floor(Number(value));
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizeLimit(value, fallback = 100, max = 1000) {
  const number = Math.floor(Number(value));
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(max, number);
}

function pageRows(rows = [], offset = 0, limit = 100) {
  const safeOffset = normalizeNonNegativeInteger(offset, 0);
  const safeLimit = normalizeLimit(limit, 100, 100);
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

function plainRow(row) {
  return row ? { ...row } : null;
}

function summarizeTreeViewState(value) {
  const state = parseJsonObject(value, {});
  return {
    depthLimit: Number(state.depthLimit) || null,
    collapsedNodeCount: Array.isArray(state.collapsedNodeIds) ? state.collapsedNodeIds.length : 0,
    expandedNodeCount: Array.isArray(state.expandedNodeIds) ? state.expandedNodeIds.length : 0,
    outlineCollapsedNodeCount: Array.isArray(state.outlineCollapsedNodeIds) ? state.outlineCollapsedNodeIds.length : 0
  };
}

function normalizeDocRow(row) {
  if (!row) return null;
  const { meta, tree_view_state: treeViewStateRaw, ...rest } = row;
  return {
    ...rest,
    meta: parseJsonObject(meta, {}),
    treeViewState: summarizeTreeViewState(treeViewStateRaw)
  };
}

function clipText(value, max = 240) {
  const text = String(value || '');
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}

function contentIncludeSet(payload = {}) {
  const raw = Array.isArray(payload.include)
    ? payload.include
    : String(payload.include || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return new Set(raw);
}

function contentDetail(payload = {}) {
  const detail = String(payload.detail || payload.mode || '').trim();
  return detail === 'summary' ? 'summary' : 'full';
}

function contentLimit(value, fallback = 1000, max = 10000) {
  if (Number(value) === 0) return 0;
  return normalizeLimit(value, fallback, max);
}

function nodeTextChars(row) {
  return String(row?.node_title || '').length + String(row?.text || '').length + String(row?.node_note || '').length;
}

function attachVisibleSubtreeTextChars(rows = []) {
  const cloned = rows.map((row) => ({ ...row }));
  const byId = new Map(cloned.map((row) => [String(row.id), row]));
  const childrenByParent = new Map();
  for (const row of cloned) {
    const parentId = String(row.parent_id || '');
    if (!byId.has(parentId)) continue;
    const children = childrenByParent.get(parentId) || [];
    children.push(row);
    childrenByParent.set(parentId, children);
  }
  const totals = new Map();
  function subtreeTotal(row) {
    const id = String(row.id);
    if (totals.has(id)) return totals.get(id);
    const total = nodeTextChars(row)
      + (childrenByParent.get(id) || []).reduce((sum, child) => sum + subtreeTotal(child), 0);
    totals.set(id, total);
    return total;
  }
  for (const row of cloned) row.subtree_text_chars = subtreeTotal(row);
  return cloned;
}

function fullSubtreeTextCharsByNodeId(store, docId, nodeIds = []) {
  const ids = [...new Set(nodeIds.map((value) => normalizeQueryId(value)).filter(Boolean))];
  if (ids.length === 0) return new Map();
  // 子树字数本质是一次后序聚合：取该文档全部节点的「自身字数」（只取长度、不取正文），
  // 按 depth 降序（自底向上）单遍 DP，每个节点把「自身 + 已累计子和」上交给父亲。
  // O(N) 一趟，避免旧实现「对每个种子各自递归展开整棵子树」——那会让深层节点被多个
  // 祖先种子重复累加，descendants 膨胀到 N×祖先深度，大库退化到分钟级。
  const rows = store.db.prepare(`
    SELECT id, parent_id,
      LENGTH(COALESCE(node_title, ''))
      + LENGTH(COALESCE(text, ''))
      + LENGTH(COALESCE(node_note, '')) AS own
    FROM nodes
    WHERE doc_id = ?
    ORDER BY depth DESC
  `).all(docId);
  const childSum = new Map();
  const total = new Map();
  for (const row of rows) {
    const id = String(row.id);
    const subtree = (Number(row.own) || 0) + (childSum.get(id) || 0);
    total.set(id, subtree);
    if (row.parent_id != null) {
      const parentId = String(row.parent_id);
      childSum.set(parentId, (childSum.get(parentId) || 0) + subtree);
    }
  }
  const result = new Map();
  for (const id of ids) result.set(id, total.get(id) ?? 0);
  return result;
}

function attachFullSubtreeTextChars(store, docId, rows = []) {
  const totals = fullSubtreeTextCharsByNodeId(store, docId, rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    subtree_text_chars: totals.get(String(row.id)) ?? nodeTextChars(row)
  }));
}

function groupMeta(rows = []) {
  const depths = rows.map((row) => Number(row.depth)).filter(Number.isFinite);
  const maxDepth = depths.length ? Math.max(...depths) : null;
  const minDepth = depths.length ? Math.min(...depths) : null;
  return {
    nodeCount: rows.length,
    minDepth,
    maxDepth,
    subtreeDepth: minDepth === null || maxDepth === null ? 0 : maxDepth - minDepth + 1,
    maxBranchWidth: rows.reduce((max, row) => Math.max(max, Number(row.child_count) || 0), 0),
    textChars: rows.reduce((sum, row) => sum + nodeTextChars(row), 0)
  };
}

function formatContentNode(row, options = {}) {
  const include = options.include || new Set();
  const detail = options.detail || 'full';
  const node = {
    id: row.id,
    docId: row.doc_id,
    parentId: row.parent_id,
    address: row.address,
    depth: row.depth,
    sortOrder: row.sort_order,
    type: row.node_type,
    title: row.node_title || '',
    childCount: Number(row.child_count) || 0,
    meta: {
      textChars: nodeTextChars(row),
      subtreeTextChars: Number.isFinite(Number(row.subtree_text_chars))
        ? Number(row.subtree_text_chars)
        : nodeTextChars(row)
    }
  };
  const semantic = row.parent_id ? null : options.semanticStatusByDocId?.[row.doc_id];
  if (semantic) node.meta.semantic = semantic;
  if (detail === 'summary') node.textPreview = clipText(row.text || '', options.previewChars || 240);
  else node.text = row.text || '';
  if (include.has('note') && row.node_note) node.note = row.node_note;
  if (include.has('tags')) {
    node.tags = {
      trustLevel: row.trust_level || null
    };
  }
  if (include.has('source')) node.source = { position: row.source_position ?? null };
  if (include.has('timestamps')) {
    node.createdAt = row.created_at || null;
    node.updatedAt = row.updated_at || null;
  }
  if (row.score !== undefined) node.score = row.score;
  return node;
}

function contentFormat(payload = {}) {
  const format = String(payload.format || payload.output || payload.view || '').trim();
  if (format === 'text' || format === 'plain_text' || format === 'body_text') return 'text';
  if (format === 'ascii_tree' || format === 'ascii' || format === 'tree_text' || format === 'text_tree') return 'ascii_tree';
  return 'json';
}

function subtreeBodyText(rows = []) {
  // 整棵子树正文 = 容器节点自身 + 子树（projectneed 4-16）：流式写入「一条消息一个节点」，
  // 消息正文可能落在之后挂了子节点的容器节点上，旧逻辑只取叶子会漏读。
  // 排除文档根（其 text 是文件名、非正文，parent_id 为 NULL）。
  return rows
    .filter((row) => row.parent_id !== null && row.parent_id !== undefined)
    .map((row) => String(row.text || ''))
    .filter((text) => text.trim())
    .join('\n');
}

function libraryIndexFormat(payload = {}) {
  const format = String(payload.format || payload.output || payload.view || '').trim();
  return format === 'json' ? 'json' : 'ascii_tree';
}

function cleanTreeLabel(value, limit = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return clipText(text, limit);
}

function normalizeKeywordTerms(payload = {}) {
  const source = Array.isArray(payload.terms)
    ? payload.terms
    : String(payload.keyword ?? payload.query ?? payload.q ?? '')
      .split(/\s+/);
  const terms = [];
  const seen = new Set();
  for (const item of source) {
    const term = String(item || '').trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function escapeLike(value = '') {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function asciiTreeLabel(node, options = {}) {
  const address = cleanTreeLabel(node.address, 40);
  const title = cleanTreeLabel(node.title || node.textPreview || node.text, options.previewChars || 80);
  const childCount = Number(node.childCount ?? (Array.isArray(node.children) ? node.children.length : 0)) || 0;
  const suffix = childCount > 0 ? ` [children=${childCount}]` : '';
  return `${address}${title ? ` ${title}` : ''}${suffix}`.trim();
}

function contentNodesToAsciiTree(nodes = [], options = {}) {
  const byId = new Map();
  const roots = [];
  for (const node of nodes) {
    byId.set(String(node.id), { ...node, children: [] });
  }
  for (const node of byId.values()) {
    const parent = byId.get(String(node.parentId || ''));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots.map((root) => contentTreeToAsciiTree(root, options)).filter(Boolean).join('\n');
}

function contentTreeToAsciiTree(root, options = {}) {
  if (!root) return '';
  const lines = [];
  function walk(node, prefix, childPrefix) {
    lines.push(`${prefix}${asciiTreeLabel(node, options)}`);
    const children = Array.isArray(node.children) ? node.children : [];
    for (let index = 0; index < children.length; index += 1) {
      const isLast = index === children.length - 1;
      walk(children[index], `${childPrefix}${isLast ? '`-- ' : '|-- '}`, `${childPrefix}${isLast ? '    ' : '|   '}`);
    }
  }
  walk(root, '', '');
  return lines.join('\n');
}

function rowsToContentTree(rows, options = {}) {
  const byId = new Map();
  let root = null;
  for (const row of rows) {
    byId.set(String(row.id), { ...formatContentNode(row, options), children: [] });
  }
  for (const row of rows) {
    const node = byId.get(String(row.id));
    const parent = byId.get(String(row.parent_id || ''));
    if (parent) parent.children.push(node);
    else if (!root) root = node;
  }
  for (const node of byId.values()) {
    if (node.children.length === 0) delete node.children;
  }
  return root;
}

function contentDocRows(store, payload = {}, ctx = {}) {
  const include = contentIncludeSet(payload);
  const includeSource = include.has('source') || contentFormat(payload) === 'ascii_tree';
  let rows = store.db.prepare(`
    SELECT d.id,
      d.title,
      d.folder_id,
      d.updated_at,
      COUNT(n.id) AS node_count,
      MAX(n.depth) AS max_depth,
      COALESCE(SUM(LENGTH(n.node_title) + LENGTH(n.text) + LENGTH(n.node_note)), 0) AS text_chars,
      sd.source_type,
      sd.original_path
    FROM docs d
    LEFT JOIN nodes n ON n.doc_id = d.id
    LEFT JOIN source_documents sd ON sd.doc_id = d.id
    GROUP BY d.id
    ORDER BY d.folder_id IS NOT NULL, d.folder_id, d.doc_sort_order, d.updated_at DESC, d.id DESC
  `).all();
  const query = String(payload.query ?? payload.q ?? '').trim().toLowerCase();
  let matchSource = '';
  if (query) {
    const titlePathMatches = rows.filter((row) => {
      const sourcePath = typeof ctx.libraryRelativePath === 'function'
        ? (ctx.libraryRelativePath(row.original_path || '') || row.original_path || '')
        : (row.original_path || '');
      return String(row.title || '').toLowerCase().includes(query)
        || String(sourcePath || '').toLowerCase().includes(query);
    });
    if (titlePathMatches.length > 0) {
      rows = titlePathMatches;
      matchSource = 'title';
    } else {
      const escaped = query.replace(/[\\%_]/g, (match) => `\\${match}`);
      const like = `%${escaped}%`;
      const contentDocIds = new Set(
        store.db.prepare(`
          SELECT DISTINCT doc_id FROM nodes
          WHERE node_title LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\'
          LIMIT 50
        `).all(like, like).map((row) => row.doc_id)
      );
      rows = rows.filter((row) => contentDocIds.has(row.id));
      matchSource = 'content';
    }
  }
  return rows.map((row) => ({
    docId: row.id,
    title: row.title || '',
    meta: {
      folderId: row.folder_id ?? null,
      nodeCount: Number(row.node_count) || 0,
      maxDepth: row.max_depth ?? null,
      textChars: Number(row.text_chars) || 0
    },
    ...(matchSource ? { matchSource } : {}),
    ...(includeSource ? {
      source: {
        type: row.source_type || '',
        path: typeof ctx.libraryRelativePath === 'function'
          ? (ctx.libraryRelativePath(row.original_path || '') || '')
          : ''
      }
    } : {}),
    ...(include.has('timestamps') ? { updatedAt: row.updated_at || null } : {})
  }));
}

function libraryRelativeSourcePath(row = {}, ctx = {}) {
  if (typeof ctx.libraryRelativePath !== 'function') return '';
  return ctx.libraryRelativePath(row.original_path || '') || '';
}

function contentNodeBaseRows(store, docId, whereSql, params = [], orderSql = 'nodes.depth, nodes.address, nodes.id') {
  return store.db.prepare(`
    WITH selected_nodes AS (
      SELECT *
      FROM nodes
      WHERE doc_id = ? AND ${whereSql}
    ),
    child_counts(parent_id, child_count) AS (
      SELECT parent_id, COUNT(*)
      FROM nodes
      WHERE doc_id = ? AND parent_id IN (SELECT id FROM selected_nodes)
      GROUP BY parent_id
    )
    SELECT selected_nodes.*,
      COALESCE(child_counts.child_count, 0) AS child_count
    FROM selected_nodes
    LEFT JOIN child_counts ON child_counts.parent_id = selected_nodes.id
    ORDER BY ${orderSql}
  `).all(docId, ...params, docId);
}

function contentNodeRowsByIds(store, docId, nodeIds = []) {
  const ids = [...new Set(nodeIds.map((value) => normalizeQueryId(value)).filter(Boolean))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = contentNodeBaseRows(store, docId, `id IN (${placeholders})`, ids, 'selected_nodes.id');
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function crossDocNodeRowsByIds(store, nodeIds = []) {
  const ids = [...new Set(nodeIds.map((value) => normalizeQueryId(value)).filter(Boolean))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = store.db.prepare(`
    WITH child_counts(parent_id, child_count) AS (
      SELECT parent_id, COUNT(*)
      FROM nodes
      WHERE parent_id IN (${placeholders})
      GROUP BY parent_id
    )
    SELECT nodes.*,
      docs.title AS doc_title,
      source_documents.source_type,
      source_documents.original_path,
      COALESCE(child_counts.child_count, 0) AS child_count
    FROM nodes
    JOIN docs ON docs.id = nodes.doc_id
    LEFT JOIN source_documents ON source_documents.doc_id = nodes.doc_id
    LEFT JOIN child_counts ON child_counts.parent_id = nodes.id
    WHERE nodes.id IN (${placeholders})
  `).all(...ids, ...ids);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function contentNodeRow(store, payload = {}) {
  const node = queryNode(store, payload);
  if (!node) return null;
  return contentNodeRowsByIds(store, node.doc_id, [node.id])[0] || node;
}

function queryContentDocs(store, payload = {}, ctx = {}) {
  const docs = contentDocRows(store, payload, ctx);
  if (contentFormat(payload) === 'ascii_tree') {
    return {
      kind: 'content.listDocs',
      format: 'ascii_tree',
      text: docs.map((doc) => {
        const title = cleanTreeLabel(doc.title || `Doc ${doc.docId}`, 90);
        const nodes = Number(doc.meta?.nodeCount) || 0;
        const depth = Number(doc.meta?.maxDepth) || 0;
        const sourcePath = doc.source?.path ? ` path=${cleanTreeLabel(doc.source.path, 120)}` : '';
        return `doc#${doc.docId} ${title} [nodes=${nodes}, depth=${depth}]${sourcePath}`;
      }).join('\n')
    };
  }
  return {
    kind: 'content.listDocs',
    docs
  };
}

function queryLibraryIndex(store, payload = {}, ctx = {}) {
  if (typeof ctx.libraryIndex !== 'function') throw new Error('library.index is not available');
  return withLibrarySemanticMeta(librarySourceDocs(store, ctx), ctx)
    .then((docs) => ctx.libraryIndex({ ...payload, format: libraryIndexFormat(payload) }, docs));
}

function memoryAnchorByDocId(store, docIds = []) {
  const ids = [...new Set(docIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = store.db
    .prepare(`SELECT id, json_extract(meta,'$.memoryVolume.hostAnchor') AS hostAnchor FROM docs WHERE id IN (${placeholders})`)
    .all(...ids);
  return Object.fromEntries(rows.filter((row) => row.hostAnchor).map((row) => [row.id, row.hostAnchor]));
}

function librarySourceDocs(store, ctx = {}) {
  const docs = contentDocRows(store, { include: ['source'] }, ctx)
    .filter((doc) => doc.source?.path)
    .map((doc) => ({
      docId: doc.docId,
      title: doc.title,
      sourcePath: doc.source.path,
      sourceType: doc.source.type,
      meta: doc.meta
    }));
  const anchorById = memoryAnchorByDocId(store, docs.map((doc) => doc.docId));
  return docs.map((doc) => ({ ...doc, hostAnchor: anchorById[doc.docId] || null }));
}

function normalizeSemanticStatus(status = {}) {
  const vectorCount = Math.max(0, Number(status.vectorCount ?? status.vector_count) || 0);
  const nodeCount = Math.max(0, Number(status.nodeCount ?? status.node_count) || 0);
  const enabled = status.enabled !== false;
  if (!enabled) return { status: 'disabled', available: false, vectorCount, nodeCount, reason: status.reason || 'vector_disabled' };
  if (status.available === true || (nodeCount > 0 ? vectorCount >= nodeCount : vectorCount > 0)) {
    return { status: 'ready', available: true, vectorCount, nodeCount };
  }
  return {
    status: 'missing',
    available: false,
    vectorCount,
    nodeCount,
    reason: vectorCount > 0 ? 'vector_partial' : (status.reason || 'vector_missing')
  };
}

async function semanticStatusByDocId(docIds = [], ctx = {}) {
  const ids = [...new Set(docIds.map((value) => normalizeQueryId(value)).filter(Boolean))];
  if (ids.length === 0) return {};
  let statuses = {};
  if (typeof ctx.docVectorStatus === 'function') {
    statuses = await ctx.docVectorStatus(ids);
  }
  return Object.fromEntries(ids.map((id) => [id, normalizeSemanticStatus(statuses?.[id] || {})]));
}

async function withLibrarySemanticMeta(docs = [], ctx = {}) {
  if (docs.length === 0) return docs;
  const statusByDocId = await semanticStatusByDocId(docs.map((doc) => doc.docId), ctx);
  return docs.map((doc) => {
    return {
      ...doc,
      meta: {
        ...(doc.meta || {}),
        semantic: statusByDocId[doc.docId] || normalizeSemanticStatus()
      }
    };
  });
}

function queryLibraryNavigation(store, payload = {}, ctx = {}) {
  if (typeof ctx.libraryNavigation !== 'function') throw new Error('library.getNavigation is not available');
  return withLibrarySemanticMeta(librarySourceDocs(store, ctx), ctx)
    .then((docs) => ctx.libraryNavigation(payload, docs))
    .then((result) => {
      const docId = result?.doc?.id;
      const row = docId
        ? store.db.prepare('SELECT tree_view_state FROM docs WHERE id = ?').get(docId)
        : null;
      return row
        ? { ...result, doc: { ...result.doc, tree_view_state: row.tree_view_state } }
        : result;
    });
}

async function queryContentNode(store, payload = {}, ctx = {}) {
  if (payload.subtree === true || payload.includeSubtree === true || payload.include_subtree === true) {
    return queryContentSubtree(store, payload, ctx);
  }
  const row = contentNodeRow(store, payload);
  const semanticStatus = row ? await semanticStatusByDocId([row.doc_id], ctx) : {};
  return row ? {
    kind: 'content.getNode',
    docId: row.doc_id,
    node: formatContentNode(row, {
      detail: contentDetail(payload),
      include: contentIncludeSet(payload),
      semanticStatusByDocId: semanticStatus,
      previewChars: payload.previewChars ?? payload.preview_chars
    })
  } : { kind: 'content.getNode', node: null };
}

function subtreeRows(store, docId, rootId) {
  return store.db.prepare(`
    WITH RECURSIVE subtree(id, path) AS (
      SELECT id, printf('%010d', sort_order)
      FROM nodes
      WHERE doc_id = ? AND id = ?
      UNION ALL
      SELECT child.id, subtree.path || '-' || printf('%010d', child.sort_order)
      FROM nodes child
      JOIN subtree ON child.parent_id = subtree.id
      WHERE child.doc_id = ?
    ),
    child_counts(parent_id, child_count) AS (
      SELECT parent_id, COUNT(*)
      FROM nodes
      WHERE doc_id = ? AND parent_id IN (SELECT id FROM subtree)
      GROUP BY parent_id
    )
    SELECT nodes.*,
      subtree.path,
      COALESCE(child_counts.child_count, 0) AS child_count
    FROM subtree
    JOIN nodes ON nodes.id = subtree.id AND nodes.doc_id = ?
    LEFT JOIN child_counts ON child_counts.parent_id = nodes.id
    ORDER BY subtree.path
  `).all(docId, rootId, docId, docId, docId);
}

function subtreeAddressPredicate(root = {}) {
  const address = String(root.address || '');
  return {
    where: "(address = ? OR address LIKE ? ESCAPE '\\')",
    params: [address, `${escapeLike(address)}-%`]
  };
}

function subtreeTextScope(root = {}, relativeDepth = null) {
  const predicate = subtreeAddressPredicate(root);
  const params = /** @type {any[]} */ ([...predicate.params]);
  const clauses = [predicate.where];
  if (relativeDepth) {
    clauses.push('depth - ? < ?');
    params.push(Number(root.depth) || 0, relativeDepth);
  }
  return { where: clauses.join(' AND '), params };
}

function subtreeBodyTextRows(store, root = {}, relativeDepth = null) {
  const scope = subtreeTextScope(root, relativeDepth);
  return store.db.prepare(`
    SELECT nodes.*,
      (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = nodes.id) AS child_count
    FROM nodes
    WHERE doc_id = ? AND ${scope.where}
  `).all(root.doc_id, ...scope.params).sort(compareNodeAddress);
}

// 各相对深度的 body 字数与节点数（read 口径），按 depth 升序。供 read 分层早停：从根逐层累加、取放得进 limit
// 的最深一层；各层求和即整子树总字数/总节点数，故 text 路径只发这一次扫，不再单独 SUM 一遍整子树。
function subtreeBodyTextLayers(store, root = {}, relativeDepth = null) {
  const scope = subtreeTextScope(root, relativeDepth);
  return store.db.prepare(`
    SELECT depth,
      COUNT(*) AS node_count,
      COALESCE(SUM(CASE WHEN nodes.parent_id IS NOT NULL THEN text_chars ELSE 0 END), 0) AS chars
    FROM nodes
    WHERE doc_id = ? AND ${scope.where}
    GROUP BY depth
    ORDER BY depth
  `).all(root.doc_id, ...scope.params);
}

async function queryContentSubtree(store, payload = {}, ctx = {}) {
  const root = contentNodeRow(store, payload);
  if (!root) return { kind: 'content.getSubtree', root: null };
  const detail = contentDetail(payload);
  const include = contentIncludeSet(payload);
  const relativeDepth = normalizePositiveInteger(payload.depthLimit ?? payload.depth_limit ?? payload.levels, null);
  const limit = contentLimit(payload.limit, 1000, 10000);
  if (contentFormat(payload) === 'text') {
    const textLimit = normalizePositiveInteger(payload.textLimit ?? payload.text_limit, null);
    // 分层 body 字数（按 depth 升序）：一次扫同时拿到逐层明细与整子树总字数/总节点数（各层之和），
    // 既供下面的分层早停，也省掉原先再 SUM 一遍整子树的那次重复全扫（两者扫的是同一批行）。
    const layers = subtreeBodyTextLayers(store, root, relativeDepth);
    let bodyTextChars = 0;
    let total = 0;
    for (const layer of layers) {
      bodyTextChars += Math.max(0, Number(layer.chars) || 0);
      total += Math.max(0, Number(layer.node_count) || 0);
    }
    const meta = { nodeCount: total, bodyTextChars };
    if (textLimit && bodyTextChars > textLimit) {
      // 分层早停：从根逐层累加 body 字数，取累计不超过 limit 的最深一层，返回该深度内的正文，
      // 而不是一刀拒绝——让 read 撞上大子树时仍拿到前几层（看章节小节常用，子树合计答不了"前 N 层多大"）。
      const rootDepth = Number(root.depth) || 0;
      let cumChars = 0;
      let keepRelativeDepth = 0;
      for (const layer of layers) {
        const layerChars = Math.max(0, Number(layer.chars) || 0);
        const layerRelativeDepth = Number(layer.depth) - rootDepth + 1;
        // 至少保留到第一个有正文的层（cumChars===0 时不因超限退出——文档根那层 body=0，否则会返回空）；之后放不下即停。
        if (cumChars > 0 && cumChars + layerChars > textLimit) break;
        cumChars += layerChars;
        keepRelativeDepth = layerRelativeDepth;
      }
      const rows = subtreeBodyTextRows(store, root, keepRelativeDepth);
      return {
        kind: 'content.getSubtree',
        format: 'text',
        docId: root.doc_id,
        rootAddress: root.address,
        returned: rows.length,
        total,
        truncated: true,
        // returnedChars 是返回到第 keepRelativeDepth 层、这些层的 body 字数（SQL LENGTH 口径，与 textLimit/bodyTextChars
        // 同口径，刻意不改用 JS 串长）；渲染时 subtreeBodyText 不显示纯空白节点，肉眼字数可能略少——此处计的是“层预算”。
        meta: { ...meta, returnedDepth: keepRelativeDepth, returnedChars: cumChars },
        text: [
          subtreeBodyText(rows),
          `— 整棵子树 ${bodyTextChars} 字，超过 ${textLimit} 字门禁，已返回前 ${keepRelativeDepth} 层（${cumChars} 字）。要继续：下钻到具体子地址分段读，或显式把 limit 加大到所需字数、二次突破门禁（确认你真要一次拉这么多）。`
        ].filter(Boolean).join('\n\n')
      };
    }
    const rows = subtreeBodyTextRows(store, root, relativeDepth);
    return {
      kind: 'content.getSubtree',
      format: 'text',
      docId: root.doc_id,
      rootAddress: root.address,
      returned: rows.length,
      total,
      truncated: false,
      meta,
      text: subtreeBodyText(rows)
    };
  }
  let rows = attachVisibleSubtreeTextChars(subtreeRows(store, root.doc_id, root.id));
  if (relativeDepth) rows = rows.filter((row) => Number(row.depth) - Number(root.depth) < relativeDepth);
  const total = rows.length;
  const returnedRows = limit ? rows.slice(0, limit) : rows;
  const semanticStatus = await semanticStatusByDocId([root.doc_id], ctx);
  const tree = rowsToContentTree(returnedRows, {
    detail,
    include,
    semanticStatusByDocId: semanticStatus,
    previewChars: payload.previewChars ?? payload.preview_chars
  });
  if (contentFormat(payload) === 'ascii_tree') {
    return {
      kind: 'content.getSubtree',
      format: 'ascii_tree',
      docId: root.doc_id,
      rootAddress: root.address,
      returned: returnedRows.length,
      total,
      truncated: Boolean(limit && total > limit),
      text: contentTreeToAsciiTree(tree, {
        previewChars: payload.previewChars ?? payload.preview_chars
      })
    };
  }
  return {
    kind: 'content.getSubtree',
    docId: root.doc_id,
    rootAddress: root.address,
    meta: groupMeta(rows),
    returned: returnedRows.length,
    total,
    truncated: Boolean(limit && total > limit),
    tree
  };
}

async function queryContentDepth(store, payload = {}, ctx = {}) {
  const docId = requireDocId(payload);
  const minDepth = normalizePositiveInteger(payload.minDepth ?? payload.min_depth ?? payload.from ?? payload.depthFrom ?? payload.depth_from, 1);
  const maxDepth = normalizePositiveInteger(payload.maxDepth ?? payload.max_depth ?? payload.to ?? payload.depthTo ?? payload.depth_to, minDepth);
  const low = Math.min(minDepth, maxDepth);
  const high = Math.max(minDepth, maxDepth);
  const limit = contentLimit(payload.limit, 1000, 10000);
  const rows = attachFullSubtreeTextChars(store, docId, contentNodeBaseRows(
    store,
    docId,
    'depth BETWEEN ? AND ?',
    [low, high],
    'selected_nodes.depth, selected_nodes.address, selected_nodes.id'
  ).sort(compareNodeAddress));
  const returnedRows = limit ? rows.slice(0, limit) : rows;
  const semanticStatus = await semanticStatusByDocId([docId], ctx);
  const nodes = returnedRows.map((row) => formatContentNode(row, {
    detail: contentDetail(payload),
    include: contentIncludeSet(payload),
    semanticStatusByDocId: semanticStatus,
    previewChars: payload.previewChars ?? payload.preview_chars
  }));
  if (contentFormat(payload) === 'ascii_tree') {
    return {
      kind: 'content.getDepth',
      format: 'ascii_tree',
      docId,
      depthRange: { from: low, to: high },
      returned: returnedRows.length,
      total: rows.length,
      truncated: Boolean(limit && rows.length > limit),
      text: contentNodesToAsciiTree(nodes, {
        previewChars: payload.previewChars ?? payload.preview_chars
      })
    };
  }
  return {
    kind: 'content.getDepth',
    docId,
    depthRange: { from: low, to: high },
    meta: groupMeta(rows),
    returned: returnedRows.length,
    total: rows.length,
    truncated: Boolean(limit && rows.length > limit),
    nodes
  };
}

async function queryContentIndex(store, payload = {}, ctx = {}) {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  if (!docId) return queryContentDocs(store, payload);
  const depthLimit = normalizePositiveInteger(payload.depthLimit ?? payload.depth_limit ?? payload.depth, 2);
  const result = await queryContentDepth(store, {
    ...payload,
    docId,
    minDepth: 1,
    maxDepth: depthLimit,
    detail: 'summary'
  }, ctx);
  // 文档实际最大层数（供调用方判断默认 index 是否截断了更深的层、需不需要下钻）。
  const maxDepthRow = store.db.prepare('SELECT MAX(depth) AS d FROM nodes WHERE doc_id = ?').get(docId);
  const docDepth = Math.max(Number(maxDepthRow?.d) || 0, depthLimit);
  return { ...result, kind: 'content.getIndex', indexDepth: depthLimit, docDepth };
}

function queryContentArticle(store, payload = {}) {
  // 窗口上限 50000（与 store.getSourceWindow 的夹值一致）：调用方显式传超限的 limit/before 直接报错、
  // 要求传合规参数，而不是静默夹小——避免「要 8 万却只拿到 5 万」却不自知。
  // 前端走 source.getWindow 不经此处，其超额由 store 层静默夹兜底，不受此报错影响。
  const MAX_ARTICLE_WINDOW = 50000;
  const reqLimit = payload.limit;
  if (reqLimit !== null && reqLimit !== undefined && Number(reqLimit) > MAX_ARTICLE_WINDOW) {
    throw new Error(`article limit 最大 ${MAX_ARTICLE_WINDOW}（单次原文窗口上限），收到 ${reqLimit}；请传 ≤${MAX_ARTICLE_WINDOW}，要读更多请按 startOffset 分多次读取。`);
  }
  const reqBefore = payload.before;
  if (reqBefore !== null && reqBefore !== undefined && Number(reqBefore) > MAX_ARTICLE_WINDOW) {
    throw new Error(`article before 最大 ${MAX_ARTICLE_WINDOW}（往前字数上限），收到 ${reqBefore}；请传 ≤${MAX_ARTICLE_WINDOW}。`);
  }
  const include = contentIncludeSet(payload);
  const wantSpans = include.has('spans');
  // spansLimit 是 article（agent 面向）的专属语义：默认只回 ARTICLE_SPANS_DEFAULT 条，避免 includeSpans 把整窗
  // 每句 span 全吐出来撑爆输出；显式 spansLimit 则按它截。注意不把这个小上限下传给 store——store 的 span 默认
  // 上限(8000) 同时服务前端源文本面板的全量高亮（前端走 source.getWindow 直达 store、不经此处），故这里只在
  // article 出口截、并按整窗实际 span 数报 spansTotal（窗口共 N），让截断可见；两条路互不影响。
  const ARTICLE_SPANS_DEFAULT = 30;
  const spansCap = Number.isFinite(Number(payload.spansLimit)) && Number(payload.spansLimit) > 0
    ? Math.floor(Number(payload.spansLimit))
    : ARTICLE_SPANS_DEFAULT;
  const result = querySourceWindow(store, wantSpans ? { ...payload, spansLimit: undefined } : payload);
  if (!result) return { kind: 'content.getArticle', article: null };
  // 窗口触及原文两端时，在展示文本首/尾补可见标记，避免把「读到原文边界」误判成被截断。
  // 标记只加在 text 上；sourceSpans 的偏移仍相对未加标记的原始窗口。
  let text = result.raw_markdown;
  if (!result.hasBefore) text = `[原文开始]\n\n${text}`;
  if (!result.hasAfter) text = `${text}\n\n[原文结束]`;
  const response = {
    kind: 'content.getArticle',
    docId: result.docId,
    window: {
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      totalLength: result.totalLength,
      hasBefore: result.hasBefore,
      hasAfter: result.hasAfter
    },
    text
  };
  if (wantSpans) {
    const allSpans = Array.isArray(result.sourceSpans) ? result.sourceSpans : [];
    response.spansTotal = allSpans.length;
    // 每条 span 原本带与顶层 docId 相同的 doc_id，逐条重复纯属冗余——出口剥掉、节点级 node_id 保留；再按 spansCap 截。
    response.sourceSpans = allSpans.slice(0, spansCap).map((span) => { const copy = { ...span }; delete copy.doc_id; return copy; });
  }
  return response;
}

function keywordWhereSql(payload = {}, terms = []) {
  const clauses = [];
  const params = [];
  const docId = normalizeQueryId(payload.scopeDocId ?? payload.scope_doc_id ?? payload.docId ?? payload.doc_id, null);
  const allDocs = payload.allDocs === true || payload.all_docs === true || payload.scope === 'all';
  if (!allDocs) {
    if (!docId) throw new Error('content.searchKeyword requires docId unless allDocs is true');
    clauses.push('n.doc_id = ?');
    params.push(docId);
  }
  const scopeAddress = String(payload.scopeAddress ?? payload.scope_address ?? payload.address ?? '').trim();
  if (scopeAddress) {
    clauses.push('(n.address = ? OR n.address LIKE ? ESCAPE \'\\\')');
    params.push(scopeAddress, `${escapeLike(scopeAddress)}-%`);
  }
  for (const term of terms) {
    const like = `%${escapeLike(term)}%`;
    clauses.push(`(
      n.address LIKE ? ESCAPE '\\'
      OR n.node_title LIKE ? ESCAPE '\\'
      OR n.text LIKE ? ESCAPE '\\'
      OR n.node_note LIKE ? ESCAPE '\\'
    )`);
    params.push(like, like, like, like);
  }
  return {
    sql: clauses.length ? clauses.join('\n      AND ') : '1 = 1',
    params
  };
}

function normalizeKeywordMatchMode(payload = {}) {
  const mode = String(payload.matchMode ?? payload.match_mode ?? payload.operator ?? payload.op ?? '').trim().toLowerCase();
  if (mode === 'or') return 'or';
  // 节点级 AND（旧行为，要求所有词在同一节点共现，精确但长文档易漏）：显式 node/strict 才走。
  if (mode === 'node' || mode === 'nodeand' || mode === 'strict') return 'node';
  // 默认文档级 AND（高命中）：词可分散在同一文档的不同节点。
  return 'doc';
}

function keywordHaystack(row = {}) {
  return [
    row.address,
    row.node_title,
    row.text,
    row.node_note
  ].map((value) => String(value || '').toLocaleLowerCase()).join('\n');
}

function countLiteralOccurrences(haystack = '', needle = '') {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const next = haystack.indexOf(needle, index);
    if (next === -1) break;
    count += 1;
    index = next + needle.length;
  }
  return count;
}

function keywordHitCount(row = {}, terms = []) {
  const haystack = keywordHaystack(row);
  return terms.reduce((sum, term) => sum + countLiteralOccurrences(haystack, String(term || '').toLocaleLowerCase()), 0);
}

function keywordRowMatches(row = {}, terms = [], mode = 'and') {
  const haystack = keywordHaystack(row);
  const needles = terms.map((term) => String(term || '').toLocaleLowerCase()).filter(Boolean);
  if (needles.length === 0) return false;
  if (mode === 'or') return needles.some((term) => haystack.includes(term));
  return needles.every((term) => haystack.includes(term));
}

function parseListFilter(value) {
  if (value === null || value === undefined) return null;
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return list.length > 0 ? new Set(list) : null;
}

// 文件夹范围归一化：统一 / 分隔、去首尾斜杠；空 → null。
function normalizeFolderFilter(value) {
  const text = String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return text || null;
}

function parseFolderFilterList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const item of list) {
    const folder = normalizeFolderFilter(item);
    if (folder) out.push(folder);
  }
  return out;
}

// 文档源文件相对路径 rel 是否落在文件夹 folder 子树内（含 folder 本身）。
function isUnderFolder(rel, folder) {
  if (!rel || !folder) return false;
  const path = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
  return path === folder || path.startsWith(`${folder}/`);
}

function memoryWorkspaceFromAnchor(anchor = '') {
  const matched = String(anchor || '').match(/[\\/]\.claude[\\/]projects[\\/]([^\\/#]+)/);
  return matched ? matched[1] : '';
}

// 文档级过滤：综合「元数据过滤（工作区/agent/类型）」与「文件夹范围（folder/excludeFolder）」，
// 返回预算允许的 docId 集合；两者都无 → null（不限制）；都有 → 取交集。
function resolveKeywordDocFilter(store, payload = {}, ctx = {}) {
  const metaSet = resolveMetaDocFilter(store, payload);
  const folderSet = resolveFolderDocFilter(store, payload, ctx);
  if (!metaSet) return folderSet;
  if (!folderSet) return metaSet;
  const allowed = new Set();
  for (const id of metaSet) if (folderSet.has(id)) allowed.add(id);
  return allowed;
}

// 元数据过滤（工作区 / agent / 文档类型）：无此类过滤时返回 null（不限制）。
// 类型 kind：event=事件卷、memory=含受控节点的核心记忆、knowledge=其余知识文档。
function resolveMetaDocFilter(store, payload = {}) {
  const workspace = parseListFilter(payload.workspace ?? payload.workspaces);
  const agent = parseListFilter(payload.agent ?? payload.agents);
  const kind = parseListFilter(payload.kind ?? payload.kinds ?? payload.docKind);
  if (!workspace && !agent && !kind) return null;
  const rows = store.db.prepare(`
    SELECT d.id AS id,
      json_extract(d.meta,'$.memoryVolume.agent') AS agent,
      json_extract(d.meta,'$.memoryVolume.hostAnchor') AS host_anchor,
      CASE
        WHEN json_extract(d.meta,'$.memoryVolume') IS NOT NULL THEN 'event'
        WHEN EXISTS (SELECT 1 FROM nodes n WHERE n.doc_id = d.id AND n.trust_level = '受控') THEN 'memory'
        ELSE 'knowledge'
      END AS kind
    FROM docs d
  `).all();
  const allowed = new Set();
  for (const row of rows) {
    if (workspace && !workspace.has(memoryWorkspaceFromAnchor(row.host_anchor))) continue;
    if (agent && !agent.has(String(row.agent || ''))) continue;
    if (kind && !kind.has(String(row.kind || ''))) continue;
    allowed.add(String(row.id));
  }
  return allowed;
}

// 文件夹范围过滤（folder=只在某 library 文件夹子树内；excludeFolder=排除某些子树）：
// 「在某文件夹下开 allDocs」即检索该文件夹这篇大型虚拟文档。无 folder/excludeFolder 时返回 null。
// 文档归属按其源文件的 library 相对路径前缀判定（ctx.libraryRelativePath 把绝对 sourcePath 还原成相对路径）。
// 无源文件的虚拟/流式文档相对路径为空：folder 限定时被排除、纯 excludeFolder 时保留。
function resolveFolderDocFilter(store, payload = {}, ctx = {}) {
  const folder = normalizeFolderFilter(payload.folder ?? payload.inFolder ?? payload.in_folder);
  const excludeFolders = parseFolderFilterList(payload.excludeFolder ?? payload.excludeFolders ?? payload.exclude_folder);
  if (!folder && excludeFolders.length === 0) return null;
  const relativePathFor = typeof ctx.libraryRelativePath === 'function' ? ctx.libraryRelativePath : null;
  const rows = store.db.prepare(`
    SELECT d.id AS id, sd.original_path AS original_path
    FROM docs d
    LEFT JOIN source_documents sd ON sd.doc_id = d.id
  `).all();
  const allowed = new Set();
  for (const row of rows) {
    const rel = (row.original_path && relativePathFor) ? relativePathFor(row.original_path) : '';
    if (folder && !isUnderFolder(rel, folder)) continue;
    if (excludeFolders.some((ex) => isUnderFolder(rel, ex))) continue;
    allowed.add(String(row.id));
  }
  return allowed;
}

function keywordRowInScope(row = {}, payload = {}, docFilter = null) {
  const allDocs = payload.allDocs === true || payload.all_docs === true || payload.scope === 'all';
  const docId = normalizeQueryId(payload.scopeDocId ?? payload.scope_doc_id ?? payload.docId ?? payload.doc_id, null);
  if (!allDocs && docId && String(row.doc_id) !== String(docId)) return false;
  const scopeAddress = String(payload.scopeAddress ?? payload.scope_address ?? payload.address ?? '').trim();
  if (scopeAddress) {
    const address = String(row.address || '');
    if (address !== scopeAddress && !address.startsWith(`${scopeAddress}-`)) return false;
  }
  if (docFilter && !docFilter.has(String(row.doc_id))) return false;
  const trust = parseListFilter(payload.trust ?? payload.trustLevel ?? payload.trust_level);
  if (trust && !trust.has(String(row.trust_level || ''))) return false;
  const since = String(payload.since ?? payload.after ?? '').trim();
  const until = String(payload.until ?? payload.before ?? '').trim();
  const updated = String(row.updated_at || '');
  if (since && updated && updated < since) return false;
  if (until && updated && updated > until) return false;
  return true;
}

function keywordRowsByIds(store, ids = []) {
  const orderedIds = [...new Set(ids.map((id) => normalizeQueryId(id)).filter(Boolean))];
  if (orderedIds.length === 0) return [];
  const placeholders = orderedIds.map(() => '?').join(', ');
  const rows = store.db.prepare(`
    WITH matched AS (
      SELECT n.*,
        d.title AS doc_title,
        CASE
          WHEN json_extract(d.meta,'$.memoryVolume') IS NOT NULL THEN 'event'
          WHEN EXISTS (SELECT 1 FROM nodes nn WHERE nn.doc_id = d.id AND nn.trust_level = '受控') THEN 'memory'
          ELSE 'knowledge'
        END AS doc_kind
      FROM nodes n
      JOIN docs d ON d.id = n.doc_id
      WHERE n.id IN (${placeholders})
    ),
    child_counts(parent_id, child_count) AS (
      SELECT parent_id, COUNT(*)
      FROM nodes
      WHERE parent_id IN (SELECT id FROM matched)
      GROUP BY parent_id
    )
    SELECT matched.*,
      COALESCE(child_counts.child_count, 0) AS child_count
    FROM matched
    LEFT JOIN child_counts ON child_counts.parent_id = matched.id
  `).all(...orderedIds);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return orderedIds.map((id) => byId.get(id)).filter(Boolean);
}

// 召回结果必须附带时间元数据（projectneed 15-12-6）：检索命中一律带 createdAt/updatedAt，
// agent 采信前先看时间；树索引等导航输出不在此列。
function includeWithTimestamps(include = new Set()) {
  const next = new Set(include);
  next.add('timestamps');
  return next;
}

function formatKeywordResultRows(rows = [], terms = [], payload = {}, include = new Set()) {
  // includeLabels（find --labels，opt-in）：命中行附 doc 层级(event/memory/knowledge)与节点 trust，
  // 供调用方一眼分层/分信任；不开则不带这些字段，保持输出精简。
  const labels = payload?.includeLabels === true;
  return rows.map((row) => {
    const node = formatContentNode({ ...row, score: keywordHitCount(row, terms) }, {
      detail: 'summary',
      include: includeWithTimestamps(include),
      previewChars: payload.previewChars ?? payload.preview_chars
    });
    if (labels) node.trustLevel = row.trust_level || null;
    return {
      doc: {
        docId: row.doc_id,
        title: row.doc_title || '',
        ...(labels ? { kind: row.doc_kind || null } : {})
      },
      node
    };
  });
}

function queryContentKeywordSql(store, payload = {}, terms = null) {
  const normalizedTerms = terms || normalizeKeywordTerms(payload);
  if (normalizedTerms.length === 0) return { kind: 'content.searchKeyword', terms: normalizedTerms, rows: [] };
  const limit = normalizeLimit(payload.limit, 100, 100);
  const offset = normalizeNonNegativeInteger(payload.offset ?? payload.start ?? payload.startOffset ?? payload.start_offset, 0);
  const include = contentIncludeSet(payload);
  const { sql, params } = keywordWhereSql(payload, normalizedTerms);
  const total = Number(store.db.prepare(`
    SELECT COUNT(*) AS count
    FROM nodes n
    JOIN docs d ON d.id = n.doc_id
    WHERE ${sql}
  `).get(...params)?.count) || 0;
  const rows = store.db.prepare(`
    WITH matched AS (
      SELECT n.*,
        d.title AS doc_title,
        CASE
          WHEN json_extract(d.meta,'$.memoryVolume') IS NOT NULL THEN 'event'
          WHEN EXISTS (SELECT 1 FROM nodes nn WHERE nn.doc_id = d.id AND nn.trust_level = '受控') THEN 'memory'
          ELSE 'knowledge'
        END AS doc_kind
      FROM nodes n
      JOIN docs d ON d.id = n.doc_id
      WHERE ${sql}
      ORDER BY d.title, n.depth, n.address, n.id
      LIMIT ? OFFSET ?
    ),
    child_counts(parent_id, child_count) AS (
      SELECT parent_id, COUNT(*)
      FROM nodes
      WHERE parent_id IN (SELECT id FROM matched)
      GROUP BY parent_id
    )
    SELECT matched.*,
      COALESCE(child_counts.child_count, 0) AS child_count
    FROM matched
    LEFT JOIN child_counts ON child_counts.parent_id = matched.id
    ORDER BY matched.doc_title, matched.depth, matched.address, matched.id
  `).all(...params, limit, offset);
  return {
    kind: 'content.searchKeyword',
    terms: normalizedTerms,
    matchMode: 'and',
    returned: rows.length,
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total,
    truncated: offset + rows.length < total,
    rows: formatKeywordResultRows(rows, normalizedTerms, payload, include)
  };
}

async function queryContentKeyword(store, payload = {}, ctx = {}) {
  const terms = normalizeKeywordTerms(payload);
  if (terms.length === 0) return { kind: 'content.searchKeyword', terms, rows: [] };
  const limit = normalizeLimit(payload.limit, 100, 100);
  const offset = normalizeNonNegativeInteger(payload.offset ?? payload.start ?? payload.startOffset ?? payload.start_offset, 0);
  const include = contentIncludeSet(payload);
  const matchMode = normalizeKeywordMatchMode(payload);
  const docFilter = resolveKeywordDocFilter(store, payload, ctx);
  if (typeof ctx.ensureKeywordIndexReady !== 'function' || typeof ctx.keywordSearch !== 'function') {
    return queryContentKeywordSql(store, payload, terms);
  }

  // 入库时已增量维护 FTS（流式 push add / 普通导入 rebuild）。查询不再全量重建：
  // 只在该 doc 于 keyword store 缺失时分批补建（projectneed 4-16）。
  await ctx.ensureKeywordIndexReady(payload);
  const docId = payload.allDocs === true || payload.all_docs === true || payload.scope === 'all'
    ? null
    : normalizeQueryId(payload.scopeDocId ?? payload.scope_doc_id ?? payload.docId ?? payload.doc_id, null);
  // 统计用：当前范围可检索的文档数（doc 级过滤后允许集 / 单篇=1 / 全库总数）。
  // 让 find 返回统计行能把"0 命中"区分成"范围本身就空"还是"范围内没命中"。
  const scopeDocs = docFilter
    ? docFilter.size
    : (docId ? 1 : (Number(store.db.prepare('SELECT COUNT(*) AS c FROM docs').get()?.c) || 0));

  if (matchMode === 'or') {
    const groups = [];
    const seen = new Set();
    const flat = [];
    for (const term of terms) {
      const candidates = await ctx.keywordSearch({ terms: [term], docId });
      const rows = keywordRowsByIds(store, candidates.map((candidate) => candidate.node_id))
        .filter((row) => keywordRowInScope(row, payload, docFilter) && keywordRowMatches(row, [term], 'and'));
      const page = pageRows(rows, offset, limit);
      const formatted = formatKeywordResultRows(page.rows, [term], payload, include);
      groups.push({
        term,
        returned: formatted.length,
        total: page.total,
        offset: page.offset,
        limit: page.limit,
        hasMore: page.hasMore,
        truncated: page.truncated,
        rows: formatted
      });
      for (const item of formatted) {
        const id = String(item.node?.id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        flat.push(item);
      }
    }
    return {
      kind: 'content.searchKeyword',
      terms,
      matchMode,
      scopeDocs,
      returned: flat.length,
      total: groups.reduce((sum, group) => sum + (Number(group.total) || 0), 0),
      offset,
      limit,
      hasMore: groups.some((group) => group.hasMore),
      truncated: groups.some((group) => group.truncated),
      groups,
      rows: flat
    };
  }

  if (matchMode === 'doc') {
    // 文档级 AND：逐词召回后按 doc 聚合，保留命中「所有词」的文档（词可落在不同节点），
    // 返回这些文档里命中任一词的节点；同节点共现多词的排前（兼顾高命中与相关性）。
    const perDocTerms = new Map();
    const perDocNodes = new Map();
    for (const term of terms) {
      const termCandidates = await ctx.keywordSearch({ terms: [term], docId });
      const termRows = keywordRowsByIds(store, termCandidates.map((candidate) => candidate.node_id))
        .filter((row) => keywordRowInScope(row, payload, docFilter) && keywordRowMatches(row, [term], 'and'));
      for (const row of termRows) {
        const rowDocId = String(row.doc_id);
        if (!perDocTerms.has(rowDocId)) perDocTerms.set(rowDocId, new Set());
        perDocTerms.get(rowDocId).add(term);
        if (!perDocNodes.has(rowDocId)) perDocNodes.set(rowDocId, new Map());
        const nodeMap = perDocNodes.get(rowDocId);
        const rowNodeId = String(row.id);
        if (!nodeMap.has(rowNodeId)) nodeMap.set(rowNodeId, { row, matched: new Set() });
        nodeMap.get(rowNodeId).matched.add(term);
      }
    }
    const ranked = [];
    for (const [rowDocId, termSet] of perDocTerms) {
      if (termSet.size < terms.length) continue;
      for (const entry of perDocNodes.get(rowDocId).values()) {
        ranked.push(entry);
      }
    }
    ranked.sort((left, right) => right.matched.size - left.matched.size);
    const page = pageRows(ranked.map((entry) => entry.row), offset, limit);
    const formatted = formatKeywordResultRows(page.rows, terms, payload, include);
    return {
      kind: 'content.searchKeyword',
      terms,
      matchMode,
      scopeDocs,
      returned: formatted.length,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      hasMore: page.hasMore,
      truncated: page.truncated,
      rows: formatted
    };
  }

  const candidates = await ctx.keywordSearch({ terms, docId });
  const rows = keywordRowsByIds(store, candidates.map((candidate) => candidate.node_id))
    .filter((row) => keywordRowInScope(row, payload, docFilter) && keywordRowMatches(row, terms, 'and'));
  const page = pageRows(rows, offset, limit);
  const formatted = formatKeywordResultRows(page.rows, terms, payload, include);
  return {
    kind: 'content.searchKeyword',
    terms,
    matchMode,
    scopeDocs,
    returned: formatted.length,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    truncated: page.truncated,
    rows: formatted
  };
}

async function queryContentSearch(store, payload = {}, ctx = {}) {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  if (!docId || payload.allDocs === true || payload.all_docs === true || payload.scope === 'all') {
    return queryContentSearchAll(store, payload, ctx);
  }
  const query = String(payload.query ?? payload.q ?? '').trim();
  if (!query) return { kind: 'content.search', docId, query, rows: [] };
  const limit = normalizeLimit(payload.limit, 20, 100);
  const mode = String(payload.searchMode ?? payload.search_mode ?? payload.mode ?? 'keyword').trim();
  const include = contentIncludeSet(payload);
  if (mode === 'vector') {
    if (typeof ctx.vectorSearch !== 'function') {
      return { kind: 'content.search', mode, docId, query, rows: [], error: '向量检索入口未接入' };
    }
    const results = await ctx.vectorSearch({ docId, query, limit });
    const rows = contentNodeRowsByIds(store, docId, results.map((result) => result.node_id));
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    return {
      kind: 'content.search',
      mode,
      docId,
      query,
      rows: results.map((result) => {
        const row = byId.get(String(result.node_id));
        return row ? formatContentNode({ ...row, score: result.score }, { detail: 'summary', include: includeWithTimestamps(include) }) : null;
      }).filter(Boolean)
    };
  }
  const rows = store.searchNodes({ docId, query, limit });
  return {
    kind: 'content.search',
    mode: 'keyword',
    docId,
    query,
    rows: rows.map((row) => formatContentNode(row, { detail: 'summary', include: includeWithTimestamps(include) }))
  };
}

function crossDocSearchRows(store, payload = {}) {
  const query = String(payload.query ?? payload.q ?? '').trim();
  if (!query) return { query, rows: [], truncated: false };
  const limit = normalizeLimit(payload.limit, 20, 100);
  const escaped = query.replace(/[\\%_]/g, (match) => `\\${match}`);
  const like = `%${escaped}%`;
  const rows = store.db.prepare(`
    WITH matched AS (
      SELECT n.*,
        d.title AS doc_title,
        d.folder_id AS doc_folder_id,
        d.updated_at AS doc_updated_at,
        sd.source_type,
        sd.original_path,
        (
          SELECT COUNT(*)
          FROM nodes child
          WHERE child.doc_id = n.doc_id AND child.parent_id = n.id
        ) AS child_count
      FROM nodes n
      JOIN docs d ON d.id = n.doc_id
      LEFT JOIN source_documents sd ON sd.doc_id = d.id
      WHERE (
        n.address LIKE ? ESCAPE '\\'
        OR n.node_title LIKE ? ESCAPE '\\'
        OR n.text LIKE ? ESCAPE '\\'
        OR n.node_note LIKE ? ESCAPE '\\'
      )
      ORDER by
        CASE
          WHEN n.address = ? THEN 0
          WHEN n.node_title LIKE ? ESCAPE '\\' THEN 1
          WHEN n.text LIKE ? ESCAPE '\\' THEN 2
          ELSE 3
        END,
        d.title,
        n.depth,
        n.address,
        n.id
      LIMIT ?
    )
    SELECT *
    FROM matched
    ORDER BY
      doc_title,
      doc_id,
      depth,
      address,
      id
  `).all(
    like,
    like,
    like,
    like,
    query,
    like,
    like,
    limit + 1
  );
  return {
    query,
    rows: rows.slice(0, limit),
    truncated: rows.length > limit
  };
}

function formatCrossDocSearchRow(row, payload = {}, ctx = {}) {
  const previewChars = payload.previewChars ?? payload.preview_chars ?? 240;
  const text = row.text || '';
  const node = {
    docId: row.doc_id,
    address: row.address,
    depth: row.depth,
    type: row.node_type,
    title: row.node_title || '',
    childCount: Number(row.child_count) || 0,
    textPreview: clipText(text, previewChars),
    meta: {
      textChars: nodeTextChars(row)
    }
  };
  // 召回结果必须附带时间元数据（projectneed 15-12-6）。
  node.createdAt = row.created_at || null;
  node.updatedAt = row.updated_at || null;
  const include = contentIncludeSet(payload);
  if (include.has('note') && row.node_note) node.notePreview = clipText(row.node_note, previewChars);
  if (include.has('tags')) {
    node.tags = {
      trustLevel: row.trust_level || null
    };
  }
  if (row.score !== undefined) node.score = row.score;
  return {
    doc: {
      docId: row.doc_id,
      title: row.doc_title || '',
      ...(payload.includeSource === true || payload.include_source === true || contentIncludeSet(payload).has('source')
        ? { source: { type: row.source_type || '', path: libraryRelativeSourcePath(row, ctx) } }
        : {})
    },
    node
  };
}

function crossDocSearchToAsciiTree(results = [], options = {}) {
  const byDoc = new Map();
  for (const result of results) {
    const docId = String(result.doc?.docId || '');
    if (!byDoc.has(docId)) {
      byDoc.set(docId, {
        doc: result.doc,
        rows: []
      });
    }
    byDoc.get(docId).rows.push(result);
  }
  const lines = [];
  for (const group of byDoc.values()) {
    const sourcePath = group.doc?.source?.path ? ` path=${cleanTreeLabel(group.doc.source.path, 120)}` : '';
    lines.push(`doc#${group.doc.docId} ${cleanTreeLabel(group.doc.title || `Doc ${group.doc.docId}`, 90)}${sourcePath}`);
    for (let index = 0; index < group.rows.length; index += 1) {
      const result = group.rows[index];
      const isLast = index === group.rows.length - 1;
      lines.push(`${isLast ? '`-- ' : '|-- '}${asciiTreeLabel(result.node, options)}`);
    }
  }
  return lines.join('\n');
}

async function queryContentSearchAll(store, payload = {}, ctx = {}) {
  const query = String(payload.query ?? payload.q ?? '').trim();
  const mode = String(payload.searchMode ?? payload.search_mode ?? payload.mode ?? 'keyword').trim();
  if (!query) {
    return contentFormat(payload) === 'ascii_tree'
      ? { kind: 'content.searchAll', format: 'ascii_tree', query, text: '' }
      : { kind: 'content.searchAll', mode: 'keyword', query, rows: [] };
  }
  if (mode === 'vector') {
    if (typeof ctx.vectorSearch !== 'function') {
      return { kind: 'content.searchAll', mode, query, rows: [], error: '向量检索入口未接入' };
    }
    const limit = normalizeLimit(payload.limit, 20, 100);
    const results = await ctx.vectorSearch({ query, limit });
    const rows = crossDocNodeRowsByIds(store, results.map((result) => result.node_id));
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const formatted = results.map((result) => {
      const row = byId.get(String(result.node_id));
      return row ? formatCrossDocSearchRow({ ...row, score: result.score }, {
        ...payload,
        includeSource: true
      }, ctx) : null;
    }).filter(Boolean);
    if (contentFormat(payload) === 'ascii_tree') {
      return {
        kind: 'content.searchAll',
        format: 'ascii_tree',
        mode,
        query,
        returned: formatted.length,
        text: crossDocSearchToAsciiTree(formatted, {
          previewChars: payload.previewChars ?? payload.preview_chars
        })
      };
    }
    return {
      kind: 'content.searchAll',
      mode,
      query,
      returned: formatted.length,
      rows: formatted
    };
  }
  const { rows, truncated } = crossDocSearchRows(store, payload);
  const results = rows.map((row) => formatCrossDocSearchRow(row, {
    ...payload,
    includeSource: true
  }, ctx));
  if (contentFormat(payload) === 'ascii_tree') {
    return {
      kind: 'content.searchAll',
      format: 'ascii_tree',
      mode: 'keyword',
      query,
      returned: results.length,
      truncated,
      text: crossDocSearchToAsciiTree(results, {
        previewChars: payload.previewChars ?? payload.preview_chars
      })
    };
  }
  return {
    kind: 'content.searchAll',
    mode: 'keyword',
    query,
    returned: results.length,
    truncated,
    rows: results
  };
}

function nodeWithChildCount(store, docId, nodeId) {
  const normalizedDocId = normalizeQueryId(docId);
  const normalizedNodeId = normalizeQueryId(nodeId);
  if (!normalizedDocId || !normalizedNodeId) return null;
  const node = store.db.prepare('SELECT * FROM nodes WHERE doc_id = ? AND id = ?')
    .get(normalizedDocId, normalizedNodeId);
  if (!node) return null;
  const childCount = Number(store.db.prepare(`
    SELECT COUNT(*) AS count
    FROM nodes
    WHERE doc_id = ? AND parent_id = ?
  `).get(normalizedDocId, normalizedNodeId)?.count || 0);
  return { ...node, child_count: childCount };
}

function resolveAddress(store, docId, address) {
  const normalizedDocId = normalizeQueryId(docId);
  const normalizedAddress = String(address || '').trim();
  const parts = normalizedAddress
    .split('-')
    .filter(Boolean)
    .map((part) => Math.floor(Number(part)));
  if (!normalizedDocId || parts.length === 0 || parts.some((part) => !Number.isInteger(part) || part <= 0)) {
    return null;
  }
  const stored = store.db.prepare('SELECT id FROM nodes WHERE doc_id = ? AND address = ?')
    .get(normalizedDocId, normalizedAddress);
  if (stored) return nodeWithChildCount(store, normalizedDocId, stored.id);

  let parentId = null;
  let current = null;
  for (const ordinal of parts) {
    current = store.db.prepare(`
      SELECT *
      FROM nodes
      WHERE doc_id = ? AND parent_id IS ?
      ORDER BY sort_order, id
      LIMIT 1 OFFSET ?
    `).get(normalizedDocId, parentId, ordinal - 1);
    if (!current) return null;
    parentId = current.id;
  }
  return nodeWithChildCount(store, normalizedDocId, current.id);
}

function requireDocId(payload = {}) {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id);
  if (!docId) throw new Error('read query requires docId for this action');
  return docId;
}

function historySnapshot(row = {}) {
  const snapshot = parseJsonObject(row.snapshot, null);
  if (snapshot?.nodes) return snapshot;
  const diff = parseJsonObject(row.diff, {});
  return diff.snapshot || (diff.kind === 'snapshot' ? diff : null);
}

function historyEntryRow(store, ref, docId = null) {
  const id = normalizeQueryId(ref, null);
  if (!id) throw new Error('history.diff requires commit id');
  const row = docId
    ? store.db.prepare('SELECT * FROM commits WHERE id = ? AND doc_id = ?').get(id, docId)
    : store.db.prepare('SELECT * FROM commits WHERE id = ?').get(id);
  if (!row) throw new Error(`Commit not found: ${id}`);
  return row;
}

function historyMetaRow(row = {}) {
  const rest = /** @type {Record<string, any>} */ ({ ...(row || {}) });
  delete rest.diff;
  delete rest.snapshot;
  return rest;
}

function queryHistoryDiff(store, payload = {}) {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  const fromRef = payload.fromHistoryId ?? payload.from_history_id ?? payload.from;
  const toRef = payload.toHistoryId ?? payload.to_history_id ?? payload.to ?? payload.historyId ?? payload.history_id;
  if (!toRef) throw new Error('history.diff requires toHistoryId');
  const toRow = historyEntryRow(store, toRef, docId);
  const toDiff = parseJsonObject(toRow.diff, {});
  if (!fromRef) {
    return {
      kind: 'history.diff',
      docId: toRow.doc_id,
      to: historyMetaRow(toRow),
      entries: Array.isArray(toDiff.entries) ? toDiff.entries : [],
      snapshotAvailable: Boolean(historySnapshot(toRow))
    };
  }
  const fromRow = historyEntryRow(store, fromRef, docId ?? toRow.doc_id);
  if (!sameDocHistory(fromRow, toRow)) {
    throw new Error('history.diff entries must belong to the same document');
  }
  const fromSnapshot = historySnapshot(fromRow);
  const toSnapshot = historySnapshot(toRow);
  if (!fromSnapshot?.nodes || !toSnapshot?.nodes) {
    throw new Error('history.diff requires restorable snapshots on both history entries');
  }
  const entries = store.computeDiff(fromSnapshot, toSnapshot);
  // computeDiff 的 field-diff entry 只带 node_id；补 address（库的定位语言）供展示层用。
  // 删除的节点在 to 侧已不存在，故 to 优先、from 兜底；这些是实时算出的临时对象，不入库。
  const addressByNode = new Map();
  for (const node of toSnapshot.nodes) addressByNode.set(node.id, node.address);
  for (const node of fromSnapshot.nodes) if (!addressByNode.has(node.id)) addressByNode.set(node.id, node.address);
  for (const entry of entries) {
    if (entry && entry.node_id != null && entry.address == null) {
      entry.address = addressByNode.get(entry.node_id) ?? null;
    }
  }
  return {
    kind: 'history.diff',
    docId: toRow.doc_id,
    from: historyMetaRow(fromRow),
    to: historyMetaRow(toRow),
    entries
  };
}

// diff.refs（15-5-2 refA↔refB）：把任意两 ref（head 正文 / 历史 commit / 草稿）各解析成快照，按稳定 node id 配对比对。
// head/草稿走 projectEditBranchDoc（统一地址口径），history 走存档快照；computeDiff 与 history.diff 同形（field/old/new）。
function resolveRefSnapshot(store, ref = {}, fallbackDocId = null) {
  if (ref.head) {
    const docId = ref.docId ?? fallbackDocId;
    if (!docId) throw new Error('diff ref=head 需要 docId');
    return store.liveDocSnapshot(docId);
  }
  if (ref.historyId != null) {
    const row = historyEntryRow(store, ref.historyId, ref.docId ?? fallbackDocId);
    const snap = historySnapshot(row);
    if (!snap?.nodes) throw new Error('diff ref 历史快照不可用（该 commit 无可恢复快照）');
    return snap;
  }
  const branch = store.findEditBranch({
    branchId: ref.branchId ?? null,
    baseDocId: ref.baseDocId ?? null,
    owner: ref.owner ?? 'human'
  });
  if (!branch) throw new Error('diff ref 草稿未找到（给 branchId 或 baseDocId+owner）');
  return store._projectedDocForBranch(branch);
}

function queryRefDiff(store, payload = {}) {
  const fallbackDocId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  const fromSnap = resolveRefSnapshot(store, payload.from ?? {}, fallbackDocId);
  const toSnap = resolveRefSnapshot(store, payload.to ?? {}, fallbackDocId);
  const entries = store.computeDiff(fromSnap, toSnap);
  // 补 address（to 侧优先、from 兜底），与 history.diff 展示口径一致。
  const addressByNode = new Map();
  for (const node of toSnap.nodes || []) addressByNode.set(node.id, node.address);
  for (const node of fromSnap.nodes || []) if (!addressByNode.has(node.id)) addressByNode.set(node.id, node.address);
  for (const entry of entries) {
    if (entry && entry.node_id != null && entry.address == null) {
      entry.address = addressByNode.get(entry.node_id) ?? null;
    }
  }
  return { kind: 'diff.refs', entries };
}

function queryNodeHistory(store, payload = {}) {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  const address = payload.address;
  if (!docId || address == null || address === '') {
    throw new Error('history.nodeLog requires docId and address');
  }
  const scope = payload.scope === 'node' ? 'node' : 'subtree';
  return {
    kind: 'history.nodeLog',
    docId,
    address: String(address),
    scope,
    history: store.nodeHistory(docId, String(address), { scope })
  };
}

function sameDocHistory(left = {}, right = {}) {
  return String(left.doc_id) === String(right.doc_id);
}

function docInfo(store, payload = {}) {
  const docId = requireDocId(payload);
  const doc = store.db.prepare(`
    SELECT
      d.*,
      (SELECT COUNT(*) FROM nodes n WHERE n.doc_id = d.id) AS node_count,
      (SELECT COUNT(*) FROM axioms a WHERE a.doc_id = d.id) AS axiom_count
    FROM docs d
    WHERE d.id = ?
  `).get(docId);
  if (!doc) return { doc: null };
  const sourceDocument = store.db.prepare(`
    SELECT doc_id, source_type, original_path, created_at, LENGTH(raw_markdown) AS raw_length
    FROM source_documents
    WHERE doc_id = ?
  `).get(docId) || null;
  const rootNode = store.db.prepare(`
    SELECT *
    FROM nodes
    WHERE doc_id = ? AND parent_id IS NULL
    ORDER BY sort_order, id
    LIMIT 1
  `).get(docId) || null;
  return {
    doc: normalizeDocRow(doc),
    sourceDocument: plainRow(sourceDocument),
    rootNode: rootNode ? nodeWithChildCount(store, docId, rootNode.id) : null
  };
}

function queryDoc(store, payload = {}) {
  const docId = requireDocId(payload);
  const includeNodes = payload.includeNodes === true || payload.include_nodes === true;
  const includeSourceSpans = payload.includeSourceSpans === true || payload.include_source_spans === true;
  const data = store.getDoc(docId, {
    maxTreeDepth: payload.maxTreeDepth ?? payload.max_tree_depth,
    includeSourceSpans,
    includeSourceDocumentContent: payload.includeSourceDocumentContent ?? payload.include_source_document_content
  });
  if (!data) return null;
  return {
    ...data,
    doc: plainRow(data.doc),
    nodes: includeNodes ? data.nodes.map(plainRow) : [],
    axioms: data.axioms.map(plainRow),
    refs: data.refs.map(plainRow),
    history: data.history.map(plainRow),
    editBranch: payload.includeEditBranch === false || payload.include_edit_branch === false
      ? null
      : plainRow(store.activeEditBranchForDoc(docId, payload.owner ?? null)),
    sourceDocument: plainRow(data.sourceDocument),
    sourcePdfPages: (data.sourcePdfPages || []).map(plainRow),
    sourceSpans: includeSourceSpans ? (data.sourceSpans || []).map(plainRow) : [],
    idByAddress: { ...(data.idByAddress || {}) }
  };
}

function queryDocExportMarkdown(store, payload = {}) {
  const docId = requireDocId(payload);
  if (typeof store.exportDocMarkdown !== 'function') {
    throw new Error('doc.exportMarkdown is not available');
  }
  return {
    kind: 'doc.exportMarkdown',
    docId,
    format: 'markdown',
    text: store.exportDocMarkdown(docId)
  };
}

function queryPendingEditBranches(store, payload = {}) {
  return {
    kind: 'editBranch.listPending',
    branches: store.listActiveEditBranches(payload.owner ?? null).map(plainRow)
  };
}

function queryEditBranchDiffView(store, payload = {}) {
  return store.getEditBranchDiffView({
    branchId: payload.branchId ?? payload.branch_id ?? null,
    shadowDocId: payload.shadowDocId ?? payload.shadow_doc_id ?? null,
    baseDocId: payload.baseDocId ?? payload.base_doc_id ?? null,
    owner: payload.owner ?? 'human',
    changedOnly: payload.changedOnly ?? payload.changed_only ?? false
  });
}

function queryThreeWayMerge(store, payload = {}) {
  return store.computeThreeWayMerge({
    branchId: payload.branchId ?? payload.branch_id ?? null,
    shadowDocId: payload.shadowDocId ?? payload.shadow_doc_id ?? null,
    baseDocId: payload.baseDocId ?? payload.base_doc_id ?? null,
    owner: payload.owner ?? 'human'
  });
}

function queryNode(store, payload = {}) {
  const docId = requireDocId(payload);
  const nodeId = normalizeQueryId(payload.nodeId ?? payload.node_id);
  if (nodeId) return nodeWithChildCount(store, docId, nodeId);
  if (payload.address) return resolveAddress(store, docId, payload.address);
  return null;
}

function queryChildren(store, payload = {}) {
  const docId = requireDocId(payload);
  let parentId = payload.parentId ?? payload.parent_id ?? null;
  if ((parentId === null || parentId === undefined || parentId === '') && payload.address) {
    const parent = resolveAddress(store, docId, payload.address);
    parentId = parent?.id ?? null;
  }
  const result = store.getNodeChildren({
    docId,
    parentId,
    offset: normalizeNonNegativeInteger(payload.offset, 0),
    limit: normalizeLimit(payload.limit, 300, 1000),
    anchorId: normalizeQueryId(payload.anchorId ?? payload.anchor_id, null),
    before: normalizeNonNegativeInteger(payload.before, 0),
    after: normalizeNonNegativeInteger(payload.after, 0)
  });
  return {
    ...result,
    rows: result.rows.map(plainRow)
  };
}

function queryNodesPage(store, payload = {}) {
  const result = store.getDocNodesPage({
    docId: requireDocId(payload),
    afterId: normalizeQueryId(payload.afterId ?? payload.after_id, null),
    limit: normalizeLimit(payload.limit, 5000, 10000)
  });
  return {
    ...result,
    rows: result.rows.map(plainRow)
  };
}

function querySearchNodes(store, payload = {}) {
  const rows = store.searchNodes({
    docId: requireDocId(payload),
    query: payload.query ?? payload.q,
    limit: payload.limit
  }).map(plainRow);
  return {
    total: rows.length,
    rows
  };
}

function queryStructureRows(store, payload = {}) {
  const rows = store.getDocStructureRows({ docId: requireDocId(payload) }).map(plainRow);
  const limit = payload.limit === 0 ? 0 : normalizeLimit(payload.limit, 10000, 100000);
  return {
    total: rows.length,
    truncated: Boolean(limit && rows.length > limit),
    rows: limit ? rows.slice(0, limit) : rows
  };
}

function querySourceWindow(store, payload = {}) {
  const result = store.getSourceWindow({
    docId: requireDocId(payload),
    nodeId: payload.nodeId ?? payload.node_id ?? null,
    startOffset: payload.startOffset ?? payload.start_offset,
    limit: payload.limit,
    before: payload.before,
    spansLimit: payload.spansLimit ?? payload.spans_limit
  });
  return result ? {
    ...result,
    sourceSpans: result.sourceSpans.map(plainRow)
  } : null;
}

function payloadNodeIds(payload = {}) {
  return Array.isArray(payload.nodeIds)
    ? payload.nodeIds
    : Array.isArray(payload.node_ids)
      ? payload.node_ids
      : [];
}

function queryNodeTextBatch(store, payload = {}) {
  return store.getNodeTextBatch({
    docId: requireDocId(payload),
    nodeIds: payloadNodeIds(payload)
  }).map(plainRow);
}

function querySubtreeTextWindow(store, payload = {}) {
  const result = store.getSubtreeTextWindow({
    docId: requireDocId(payload),
    nodeId: payload.nodeId ?? payload.node_id,
    offset: payload.offset,
    limit: normalizeLimit(payload.limit, 1000, 1000),
    charLimit: normalizeLimit(payload.charLimit ?? payload.char_limit, 0, 200000)
  });
  return {
    ...result,
    rows: result.rows.map(plainRow)
  };
}

function querySubtreeSlotRange(store, payload = {}) {
  return store.getSubtreeSlotRange({
    docId: requireDocId(payload),
    nodeId: payload.nodeId ?? payload.node_id
  }).map(plainRow);
}

function queryAncestorChain(store, payload = {}) {
  return store.getAncestorChain({
    docId: requireDocId(payload),
    nodeId: payload.nodeId ?? payload.node_id
  }).map(plainRow);
}

export function databaseReadActions() {
  return [...ACTIONS];
}

export function databaseReadToolSchema() {
  return {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: databaseReadActions(),
        description: 'Read-only query action. Use library.index to find imported documents by library folder position, content.getIndex for whole-document index, content.getSubtree for a local address/subtree, content.searchKeyword with terms for multi-keyword lookup, content.search for exact substring or vector query, content.searchAll for cross-document content search, and debug.sql only for debugging facts. For tree/index results, meta.textChars is the node own text length; meta.subtreeTextChars and ASCII (xxx) are subtree totals, not node own text.'
      },
      sql: { type: 'string' },
      params: {
        oneOf: [
          { type: 'array' },
          { type: 'object' }
        ]
      },
      docId: STABLE_ID_SCHEMA,
      nodeId: STABLE_ID_SCHEMA,
      historyId: STABLE_ID_SCHEMA,
      fromHistoryId: STABLE_ID_SCHEMA,
      toHistoryId: STABLE_ID_SCHEMA,
      address: { type: 'string' },
      query: { type: 'string', description: 'Query text for content.search/content.searchAll. In keyword mode this is a substring, not multi-term AND.' },
      q: { type: 'string', description: 'Alias for query. In keyword mode this is a substring, not multi-term AND.' },
      keyword: { type: 'string', description: 'Single keyword for content.searchKeyword.' },
      terms: { type: 'array', items: { type: 'string' }, description: 'Multiple terms for content.searchKeyword; all terms must match inside the selected scope.' },
      matchMode: { type: 'string', enum: ['and', 'or'], description: 'content.searchKeyword only: and returns nodes matching every term; or returns per-term groups.' },
      entityId: STABLE_ID_SCHEMA,
      entityIds: { type: 'array', items: STABLE_ID_SCHEMA },
      docIds: { type: 'array', items: STABLE_ID_SCHEMA },
      literal: { type: 'string' },
      parentId: { ...STABLE_ID_SCHEMA, description: '省略时表示文档根层；和 address 同时传入时优先使用 parentId。' },
      anchorId: STABLE_ID_SCHEMA,
      afterId: STABLE_ID_SCHEMA,
      offset: { type: 'number' },
      limit: { type: 'number' },
      depth: { type: 'number', description: 'Tree/index depth limit. In ASCII tree output, (xxx) is each node subtree total, not node own text length.' },
      minDepth: { type: 'number' },
      maxDepth: { type: 'number' },
      from: { oneOf: [{ type: 'number' }, { type: 'object' }], description: 'diff.refs 的左端 ref 对象 {head:true}|{historyId}|{branchId}；其它 action（深度/历史范围）作数字。' },
      to: { oneOf: [{ type: 'number' }, { type: 'object' }], description: 'diff.refs 的右端 ref 对象；其它 action 作数字。' },
      depthLimit: { type: 'number', description: 'Subtree depth limit. Character counts in tree/index output remain subtree totals.' },
      levels: { type: 'number', description: 'Alias for subtree depth limit. Character counts in tree/index output remain subtree totals.' },
      detail: { type: 'string', enum: ['summary', 'full'] },
      format: { type: 'string', enum: ['json', 'ascii_tree', 'ascii', 'tree_text', 'text_tree', 'text', 'plain_text', 'body_text'], description: 'json keeps meta.textChars and meta.subtreeTextChars separate; ASCII tree shows only subtree totals as (xxx); text returns concatenated body text.' },
      output: { type: 'string', enum: ['json', 'ascii_tree', 'ascii', 'tree_text', 'text_tree', 'text', 'plain_text', 'body_text'], description: 'Alias for format. json keeps own text and subtree totals separate; ASCII tree shows only subtree totals as (xxx); text returns concatenated body text.' },
      include: { type: 'array', items: { type: 'string', enum: ['note', 'tags', 'source', 'timestamps', 'spans', 'summary'] } },
      searchMode: { type: 'string', enum: ['keyword', 'vector'] },
      allDocs: { type: 'boolean' },
      scopeDocId: STABLE_ID_SCHEMA,
      scopeAddress: { type: 'string' },
      path: { type: 'string' },
      subtree: { type: 'boolean' },
      includeSubtree: { type: 'boolean' },
      previewChars: { type: 'number' },
      charLimit: { type: 'number', description: 'subtree.getTextWindow 的本页字符预算：累计达到预算即截断本页（至少返回一行）；省略或 0 表示不限。' },
      maxTreeDepth: { type: 'number' },
      includeNodes: { type: 'boolean' },
      includeSourceSpans: { type: 'boolean' },
      includeSourceDocumentContent: { type: 'boolean' },
      owner: { type: 'string' },
      depthKey: { type: 'string' },
      viewport: { type: 'object' },
      nodeIds: { type: 'array', items: STABLE_ID_SCHEMA },
      collapsedIds: { type: 'array', items: STABLE_ID_SCHEMA },
      expandedIds: { type: 'array', items: STABLE_ID_SCHEMA },
      startOffset: { type: 'number' },
      before: { type: 'number' },
      after: { type: 'number' },
      spansLimit: { type: 'number' }
    },
    required: ['action']
  };
}

export async function runDatabaseRead(store, payload = {}, ctx = {}) {
  const action = normalizeQueryAction(payload.action || payload.type);
  if (!action) throw new Error(`Unknown read query action: ${payload.action || payload.type || ''}`);

  if (action === 'query.actions') return { actions: databaseReadActions() };
  if (action === 'library.getTree') {
    if (typeof ctx.libraryTree !== 'function') throw new Error('library.getTree is not available');
    return ctx.libraryTree(payload);
  }
  if (!store?.db) throw new Error('read query store is not available');
  if (action === 'debug.sql') return handleDebugSqlQuery(store, payload);
  if (action === 'library.index') return queryLibraryIndex(store, payload, ctx);
  if (action === 'library.getNavigation') return queryLibraryNavigation(store, payload, ctx);
  if (action === 'content.listDocs') return queryContentDocs(store, payload, ctx);
  if (action === 'content.getIndex') return queryContentIndex(store, payload, ctx);
  if (action === 'content.getNode') return queryContentNode(store, payload, ctx);
  if (action === 'content.getSubtree') return queryContentSubtree(store, payload, ctx);
  if (action === 'content.getDepth') return queryContentDepth(store, payload, ctx);
  if (action === 'content.getArticle') return queryContentArticle(store, payload);
  if (action === 'content.searchKeyword') return queryContentKeyword(store, payload, ctx);
  if (action === 'content.search') return queryContentSearch(store, payload, ctx);
  if (action === 'content.searchAll') return queryContentSearchAll(store, payload, ctx);
  if (ENTITY_READ_ACTIONS.includes(action)) return runEntityRead(store, payload, action, ctx);
  if (action === 'memory.listVolumes') {
    // 封卷自动化（15-10-1/15-11-5）：列卷时顺手物理封到期卷（末次活动+24h），不再设 seal 动词。
    // 纯时间戳判断、零 LLM；只在可写连接上做（query-db 的只读路径跳过）。
    if (!store.readonly) sealDueMemoryVolumes(store);
    return listMemoryVolumes(store, {
      state: payload.state ?? null,
      agent: payload.agent ?? null,
      sessionId: payload.sessionId ?? payload.session_id ?? null,
      limit: payload.limit
    });
  }
  if (action === 'debug.overview') return handleDebugOverviewQuery(store);
  if (action === 'doc.list') return store.listDocs().map(normalizeDocRow);
  if (action === 'docFolder.list') return store.listDocFolders().map(plainRow);
  if (action === 'history.diff') return queryHistoryDiff(store, payload);
  if (action === 'diff.refs') return queryRefDiff(store, payload);
  if (action === 'history.nodeLog') return queryNodeHistory(store, payload);
  if (action === 'editBranch.listPending') return queryPendingEditBranches(store, payload);
  if (action === 'editBranch.diffView') return queryEditBranchDiffView(store, payload);
  if (action === 'editBranch.threeWayMerge') return queryThreeWayMerge(store, payload);
  if (action === 'doc.get') return queryDoc(store, payload);
  if (action === 'doc.exportMarkdown') return queryDocExportMarkdown(store, payload);
  if (action === 'doc.getInfo') return docInfo(store, payload);
  if (action === 'doc.hasTreeDepth') return store.hasDocTreeDepth({
    docId: requireDocId(payload),
    depth: payload.depth
  });
  if (action === 'node.get') return queryNode(store, payload);
  if (action === 'node.listChildren') return queryChildren(store, payload);
  if (action === 'node.listPage') return queryNodesPage(store, payload);
  if (action === 'node.search') return querySearchNodes(store, payload);
  if (action === 'node.getTextBatch') return queryNodeTextBatch(store, payload);
  if (action === 'node.listStructureRows') return queryStructureRows(store, payload);
  if (action === 'subtree.getTextWindow') return querySubtreeTextWindow(store, payload);
  if (action === 'subtree.getSlotRange') return querySubtreeSlotRange(store, payload);
  if (action === 'node.getAncestorChain') return queryAncestorChain(store, payload);
  if (action === 'source.getWindow') return querySourceWindow(store, payload);

  throw new Error(`Unhandled read query action: ${action}`);
}
