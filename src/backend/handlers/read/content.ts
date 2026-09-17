// 读动作 handler（自 query-api.ts 按域拆出，§6-4：照 mutation-api 的 handlers/write 样板）。
// 本文件由分派表 query-api.ts 消费；跨域共享的 helper 一律住 shared.ts。
import { queryNode, querySourceWindow } from './node.js';
import { clipText, normalizeLimit, normalizePositiveInteger, normalizeQueryId, requireDocId } from './shared.js';
import type { ContentDocRow, ContentNodeRow, ContentTreeBuildNode, ContentTreeNode, FormattedContentNode, Payload, QueryContext, RowObject } from './shared.js';
import { compareNodeAddress } from '../../shared.js';
import { bodyCharCount } from '../../../core/char-count.js';
import { contentHash } from '../../../core/merkle.js';
import { normalizeSemanticStatus } from '../../derived-index/semantic-status.js';
import type { IftreeStore } from '../../store/index.js';
import type { DocRow, NodeRow, SourceDocumentRow } from '../../db/schema.js';

export function contentIncludeSet(payload: Payload = {}) {
  const raw = Array.isArray(payload.include)
    ? payload.include
    : String(payload.include || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  return new Set(raw);
}

export function contentDetail(payload: Payload = {}) {
  const detail = String(payload.detail || payload.mode || '').trim();
  return detail === 'summary' ? 'summary' : 'full';
}

export function contentLimit(value: unknown, fallback = 1000, max = 10000) {
  if (Number(value) === 0) return 0;
  return normalizeLimit(value, fallback, max);
}

export function nodeTextChars(row: Partial<NodeRow> | null | undefined) {
  // 忽略空白口径（见 core/char-count）：切分粒度不影响字数。与 SQL 侧 body_char_count UDF 同源。
  return bodyCharCount(row?.node_title) + bodyCharCount(row?.text) + bodyCharCount(row?.node_note);
}

export function attachVisibleSubtreeTextChars<T extends ContentNodeRow>(rows: T[] = []) {
  const cloned = rows.map((row) => ({ ...row }));
  const byId = new Map(cloned.map((row) => [String(row.id), row]));
  const childrenByParent = new Map<string, Array<T & { subtree_text_chars?: number }>>();
  for (const row of cloned) {
    const parentId = String(row.parent_id || '');
    if (!byId.has(parentId)) continue;
    const children = childrenByParent.get(parentId) || [];
    children.push(row);
    childrenByParent.set(parentId, children);
  }
  const totals = new Map<string, number>();
  function subtreeTotal(row: T & { subtree_text_chars?: number }): number {
    const id = String(row.id);
    if (totals.has(id)) return totals.get(id)!;
    const total = nodeTextChars(row)
      + (childrenByParent.get(id) || []).reduce((sum, child) => sum + subtreeTotal(child), 0);
    totals.set(id, total);
    return total;
  }
  for (const row of cloned) row.subtree_text_chars = subtreeTotal(row);
  return cloned;
}

export function fullSubtreeTextCharsByNodeId(store: IftreeStore, docId: unknown, nodeIds: unknown[] = []) {
  const ids = [...new Set(nodeIds.map((value) => normalizeQueryId(value)).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  // 子树字数本质是一次后序聚合：取该文档全部节点的「自身字数」（只取长度、不取正文），
  // 按 depth 降序（自底向上）单遍 DP，每个节点把「自身 + 已累计子和」上交给父亲。
  // O(N) 一趟，避免旧实现「对每个种子各自递归展开整棵子树」——那会让深层节点被多个
  // 祖先种子重复累加，descendants 膨胀到 N×祖先深度，大库退化到分钟级。
  const rows = store.db!.prepare(`
    SELECT id, parent_id,
      body_char_count(node_title)
      + body_char_count(text)
      + body_char_count(node_note) AS own
    FROM nodes
    WHERE doc_id = ?
    ORDER BY depth DESC
  `).all<{ id: string; parent_id: string | null; own: number }>(docId);
  const childSum = new Map<string, number>();
  const total = new Map<string, number>();
  for (const row of rows) {
    const id = String(row.id);
    const subtree = (Number(row.own) || 0) + (childSum.get(id) || 0);
    total.set(id, subtree);
    if (row.parent_id != null) {
      const parentId = String(row.parent_id);
      childSum.set(parentId, (childSum.get(parentId) || 0) + subtree);
    }
  }
  const result = new Map<string, number>();
  for (const id of ids) result.set(id, total.get(id) ?? 0);
  return result;
}

export function attachFullSubtreeTextChars<T extends ContentNodeRow>(store: IftreeStore, docId: unknown, rows: T[] = []) {
  const totals = fullSubtreeTextCharsByNodeId(store, docId, rows.map((row) => row.id));
  return rows.map((row) => ({
    ...row,
    subtree_text_chars: totals.get(String(row.id)) ?? nodeTextChars(row)
  }));
}

export function groupMeta(rows: ContentNodeRow[] = []) {
  // 单遍累计而非 Math.max(...depths)：rows 是未截断的全量行，十几万元素的展开会让 V8 撑爆调用栈参数上限（RangeError）。
  let minDepth: number | null = null;
  let maxDepth: number | null = null;
  for (const row of rows) {
    const depth = Number(row.depth);
    if (!Number.isFinite(depth)) continue;
    if (minDepth === null || depth < minDepth) minDepth = depth;
    if (maxDepth === null || depth > maxDepth) maxDepth = depth;
  }
  return {
    nodeCount: rows.length,
    minDepth,
    maxDepth,
    subtreeDepth: minDepth === null || maxDepth === null ? 0 : maxDepth - minDepth + 1,
    maxBranchWidth: rows.reduce((max, row) => Math.max(max, Number(row.child_count) || 0), 0),
    textChars: rows.reduce((sum, row) => sum + nodeTextChars(row), 0)
  };
}

export function formatContentNode(row: ContentNodeRow, options: {
  include?: Set<string>;
  detail?: string;
  semanticStatusByDocId?: Record<string, unknown>;
  previewChars?: unknown;
} = {}): FormattedContentNode {
  const include = options.include || new Set();
  const detail = options.detail || 'full';
  const node: FormattedContentNode = {
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
  if (detail === 'summary') node.textPreview = clipText(row.text || '', Number(options.previewChars) || 240);
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
  // include=hash：内容寻址 hash（inspect meta 镜头用；原 db-shell 借 debug.sql 自查的口径，§6-2 并入）。
  // 列值缺失（行不带 content_hash 或来源无 text）时按 merkle 的五内容字段现算；text 未取回则明示 'null'。
  if (include.has('hash')) {
    node.contentHash = row.content_hash || (row.text === undefined ? 'null' : contentHash({
      id: row.id,
      text: row.text,
      node_title: row.node_title,
      node_note: row.node_note,
      node_type: row.node_type,
      trust_level: row.trust_level
    }));
  }
  if (row.score !== undefined) node.score = row.score;
  return node;
}

export function contentFormat(payload: Payload = {}) {
  const format = String(payload.format || payload.output || payload.view || '').trim();
  if (format === 'text' || format === 'plain_text' || format === 'body_text') return 'text';
  if (format === 'ascii_tree' || format === 'ascii' || format === 'tree_text' || format === 'text_tree') return 'ascii_tree';
  return 'json';
}

// 子树正文行的最小形状：HEAD 侧是 nodes 行（snake_case），历史快照行 snake/camel 混排，两个键都认。
export interface BodyTextRow {
  parent_id?: unknown;
  parentId?: unknown;
  text?: unknown;
}

export function subtreeBodyText(rows: BodyTextRow[] = []) {
  // 整棵子树正文 = 容器节点自身 + 子树（projectneed 4-16）：流式写入「一条消息一个节点」，
  // 消息正文可能落在之后挂了子节点的容器节点上，旧逻辑只取叶子会漏读。
  // 排除文档根（其 text 是文件名、非正文，parent_id 为 NULL）。
  // 唯一口径：HEAD 侧（read）与历史快照侧（read --at，handlers/read/history.ts）共用本函数，
  // 免得两侧各写一遍过滤、口径再度分叉。
  return rows
    .filter((row) => (row.parent_id ?? row.parentId) !== null && (row.parent_id ?? row.parentId) !== undefined)
    .map((row) => String(row.text || ''))
    .filter((text) => text.trim())
    .join('\n');
}

export function libraryIndexFormat(payload: Payload = {}) {
  const format = String(payload.format || payload.output || payload.view || '').trim();
  return format === 'json' ? 'json' : 'ascii_tree';
}

export function cleanTreeLabel(value: unknown, limit = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return clipText(text, limit);
}

export function normalizeKeywordTerms(payload: Payload = {}) {
  const source = Array.isArray(payload.terms)
    ? payload.terms
    : String(payload.keyword ?? payload.query ?? payload.q ?? '')
      .split(/\s+/);
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const term = String(item || '').trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

export function escapeLike(value: unknown = '') {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function asciiTreeLabel(node: Partial<FormattedContentNode>, options: Payload = {}) {
  const address = cleanTreeLabel(node.address, 40);
  const title = cleanTreeLabel(node.title || node.textPreview || node.text, Number(options.previewChars) || 80);
  const childCount = Number(node.childCount ?? (Array.isArray(node.children) ? node.children.length : 0)) || 0;
  const suffix = childCount > 0 ? ` [children=${childCount}]` : '';
  return `${address}${title ? ` ${title}` : ''}${suffix}`.trim();
}

export function contentNodesToAsciiTree(nodes: FormattedContentNode[] = [], options: Payload = {}) {
  const byId = new Map<string, ContentTreeBuildNode>();
  const roots: ContentTreeBuildNode[] = [];
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

export function contentTreeToAsciiTree(root: ContentTreeNode | null, options: Payload = {}) {
  if (!root) return '';
  const lines: string[] = [];
  function walk(node: ContentTreeNode, prefix: string, childPrefix: string) {
    lines.push(`${prefix}${asciiTreeLabel(node, options)}`);
    const children = Array.isArray(node.children) ? node.children : [];
    for (let index = 0; index < children.length; index += 1) {
      const isLast = index === children.length - 1;
      const child = children[index];
      if (child) walk(child, `${childPrefix}${isLast ? '`-- ' : '|-- '}`, `${childPrefix}${isLast ? '    ' : '|   '}`);
    }
  }
  walk(root, '', '');
  return lines.join('\n');
}

export function rowsToContentTree(rows: ContentNodeRow[], options: Parameters<typeof formatContentNode>[1] = {}) {
  const byId = new Map<string, ContentTreeBuildNode>();
  let root: ContentTreeNode | null = null;
  for (const row of rows) {
    byId.set(String(row.id), { ...formatContentNode(row, options), children: [] });
  }
  for (const row of rows) {
    const node = byId.get(String(row.id));
    const parent = byId.get(String(row.parent_id || ''));
    if (parent && node) parent.children.push(node);
    else if (!root && node) root = node;
  }
  for (const node of byId.values()) {
    if (node.children.length === 0) delete (node as FormattedContentNode).children;
  }
  return root;
}

export function contentDocRows(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
  const include = contentIncludeSet(payload);
  const includeSource = include.has('source') || contentFormat(payload) === 'ascii_tree';
  let rows = store.db!.prepare(`
    SELECT d.id,
      d.title,
      d.folder_id,
      d.updated_at,
      COUNT(n.id) AS node_count,
      MAX(n.depth) AS max_depth,
      COALESCE(SUM(body_char_count(n.node_title) + body_char_count(n.text) + body_char_count(n.node_note)), 0) AS text_chars,
      sd.source_type,
      sd.original_path
    FROM docs d
    LEFT JOIN nodes n ON n.doc_id = d.id
    LEFT JOIN source_documents sd ON sd.doc_id = d.id
    GROUP BY d.id
    ORDER BY d.folder_id IS NOT NULL, d.folder_id, d.doc_sort_order, d.updated_at DESC, d.id DESC
  `).all<ContentDocRow>();
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
        store.db!.prepare(`
          SELECT DISTINCT doc_id FROM nodes
          WHERE node_title LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\'
          LIMIT 50
        `).all<Pick<NodeRow, 'doc_id'>>(like, like).map((row) => row.doc_id)
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

export function libraryRelativeSourcePath(row: Partial<SourceDocumentRow> = {}, ctx: QueryContext = {}) {
  if (typeof ctx.libraryRelativePath !== 'function') return '';
  return ctx.libraryRelativePath(row.original_path || '') || '';
}

export function contentNodeBaseRows(store: IftreeStore, docId: unknown, whereSql: string, params: unknown[] = [], orderSql = 'nodes.depth, nodes.address, nodes.id') {
  return store.db!.prepare(`
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
  `).all<ContentNodeRow>(docId, ...params, docId);
}

export function contentNodeRowsByIds(store: IftreeStore, docId: unknown, nodeIds: unknown[] = []): ContentNodeRow[] {
  const ids = [...new Set(nodeIds.map((value) => normalizeQueryId(value)).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = contentNodeBaseRows(store, docId, `id IN (${placeholders})`, ids, 'selected_nodes.id');
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids.map((id) => byId.get(id)).filter((row): row is ContentNodeRow => Boolean(row));
}

export function crossDocNodeRowsByIds(store: IftreeStore, nodeIds: unknown[] = []): ContentNodeRow[] {
  const ids = [...new Set(nodeIds.map((value) => normalizeQueryId(value)).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = store.db!.prepare(`
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
  `).all<ContentNodeRow>(...ids, ...ids);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids.map((id) => byId.get(id)).filter((row): row is ContentNodeRow => Boolean(row));
}

export function contentNodeRow(store: IftreeStore, payload: Payload = {}): ContentNodeRow | null {
  const node = queryNode(store, payload);
  if (!node) return null;
  return contentNodeRowsByIds(store, node.doc_id, [node.id])[0] || node;
}

export function queryContentDocs(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
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

export function queryLibraryIndex(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
  const libraryIndex = ctx.libraryIndex;
  if (typeof libraryIndex !== 'function') throw new Error('library.index is not available');
  return withLibrarySemanticMeta(store, librarySourceDocs(store, ctx))
    .then((docs) => libraryIndex({ ...payload, format: libraryIndexFormat(payload) }, docs));
}

export function memoryAnchorByDocId(store: IftreeStore, docIds: unknown[] = []) {
  const ids = [...new Set(docIds.map((id) => normalizeQueryId(id)).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = store.db!
    .prepare(`SELECT id, json_extract(meta,'$.memoryVolume.hostAnchor') AS hostAnchor FROM docs WHERE id IN (${placeholders})`)
    .all<{ id: string; hostAnchor: string | null }>(...ids);
  return Object.fromEntries(rows.filter((row) => row.hostAnchor).map((row) => [row.id, row.hostAnchor]));
}

export function librarySourceDocs(store: IftreeStore, ctx: QueryContext = {}) {
  const docs = contentDocRows(store, { include: ['source'] }, ctx)
    .filter((doc) => doc.source?.path)
    .map((doc) => ({
      docId: doc.docId,
      title: doc.title,
      sourcePath: String(doc.source?.path || ''),
      sourceType: String(doc.source?.type || ''),
      meta: doc.meta
    }));
  const anchorById = memoryAnchorByDocId(store, docs.map((doc) => doc.docId));
  return docs.map((doc) => ({ ...doc, hostAnchor: anchorById[doc.docId] || null }));
}

export async function semanticStatusByDocId(store: IftreeStore, docIds: unknown[] = []) {
  const ids = [...new Set(docIds.map((value) => normalizeQueryId(value)).filter(Boolean))];
  if (ids.length === 0) return {};
  // 读 docs.meta.semantic 持久化列（写入侧 refreshDocSemanticMeta 维护），免每次查 lance 的计算税。
  const placeholders = ids.map(() => '?').join(',');
  const rows = store.db!.prepare(`SELECT id, json_extract(meta, '$.semantic') AS semantic FROM docs WHERE id IN (${placeholders})`).all<{ id: string; semantic: string | null }>(...ids);
  const byId = new Map(rows.map((row) => [String(row.id), row.semantic]));
  return Object.fromEntries(ids.map((id) => {
    let parsed = {};
    const raw = byId.get(String(id));
    if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = {}; } }
    return [id, normalizeSemanticStatus(parsed)];
  }));
}

export async function withLibrarySemanticMeta(store: IftreeStore, docs: RowObject[] = []) {
  if (docs.length === 0) return docs;
  const statusByDocId = await semanticStatusByDocId(store, docs.map((doc) => doc.docId));
  return docs.map((doc) => {
    return {
      ...doc,
      meta: {
        ...(doc.meta || {}),
        semantic: statusByDocId[String(doc.docId)] || normalizeSemanticStatus()
      }
    };
  });
}

export function queryLibraryNavigation(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
  const libraryNavigation = ctx.libraryNavigation;
  if (typeof libraryNavigation !== 'function') throw new Error('library.getNavigation is not available');
  return withLibrarySemanticMeta(store, librarySourceDocs(store, ctx))
    .then((docs) => libraryNavigation(payload, docs))
    .then((result: unknown) => {
      const resultObject = (result && typeof result === 'object' ? result : {}) as RowObject & { doc?: RowObject };
      const docId = resultObject.doc?.id;
      const row = docId
        ? store.db!.prepare('SELECT tree_view_state FROM docs WHERE id = ?').get<Pick<DocRow, 'tree_view_state'>>(docId)
        : null;
      return row
        ? { ...resultObject, doc: { ...resultObject.doc, tree_view_state: row.tree_view_state } }
        : result;
    });
}

export async function queryContentNode(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
  if (payload.subtree === true || payload.includeSubtree === true || payload.include_subtree === true) {
    return queryContentSubtree(store, payload, ctx);
  }
  const row = contentNodeRow(store, payload);
  const semanticStatus = row ? await semanticStatusByDocId(store, [row.doc_id]) : {};
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

export function subtreeRows(store: IftreeStore, docId: unknown, rootId: unknown) {
  return store.db!.prepare(`
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
  `).all<ContentNodeRow>(docId, rootId, docId, docId, docId);
}

export function subtreeAddressPredicate(root: Partial<NodeRow> = {}) {
  const address = String(root.address || '');
  return {
    where: "(address = ? OR address LIKE ? ESCAPE '\\')",
    params: [address, `${escapeLike(address)}-%`]
  };
}

export function subtreeTextScope(root: Partial<NodeRow>, relativeDepth: number | null = null) {
  const predicate = subtreeAddressPredicate(root);
  const params: unknown[] = [...predicate.params];
  const clauses = [predicate.where];
  if (relativeDepth) {
    clauses.push('depth - ? < ?');
    params.push(Number(root.depth) || 0, relativeDepth);
  }
  return { where: clauses.join(' AND '), params };
}

export function subtreeBodyTextRows(store: IftreeStore, root: ContentNodeRow, relativeDepth: number | null = null) {
  const scope = subtreeTextScope(root, relativeDepth);
  return store.db!.prepare(`
    SELECT nodes.*,
      (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = nodes.id) AS child_count
    FROM nodes
    WHERE doc_id = ? AND ${scope.where}
  `).all<ContentNodeRow>(root.doc_id, ...scope.params).sort(compareNodeAddress);
}

// 各相对深度的 body 字数与节点数（read 口径），按 depth 升序。供 read 分层早停：从根逐层累加、取放得进 limit
// 的最深一层；各层求和即整子树总字数/总节点数，故 text 路径只发这一次扫，不再单独 SUM 一遍整子树。
export function subtreeBodyTextLayers(store: IftreeStore, root: ContentNodeRow, relativeDepth: number | null = null) {
  const scope = subtreeTextScope(root, relativeDepth);
  return store.db!.prepare(`
    SELECT depth,
      COUNT(*) AS node_count,
      COALESCE(SUM(CASE WHEN nodes.parent_id IS NOT NULL THEN body_char_count(nodes.text) ELSE 0 END), 0) AS chars
    FROM nodes
    WHERE doc_id = ? AND ${scope.where}
    GROUP BY depth
    ORDER BY depth
  `).all<{ depth: number; node_count: number; chars: number }>(root.doc_id, ...scope.params);
}

export async function queryContentSubtree(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
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
  const semanticStatus = await semanticStatusByDocId(store, [root.doc_id]);
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

export async function queryContentDepth(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
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
  const semanticStatus = await semanticStatusByDocId(store, [docId]);
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

export async function queryContentIndex(store: IftreeStore, payload: Payload = {}, ctx: QueryContext = {}) {
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
  const maxDepthRow = store.db!.prepare('SELECT MAX(depth) AS d FROM nodes WHERE doc_id = ?').get<{ d: number | null }>(docId);
  const docDepth = Math.max(Number(maxDepthRow?.d) || 0, depthLimit);
  return { ...result, kind: 'content.getIndex', indexDepth: depthLimit, docDepth };
}

export function queryContentArticle(store: IftreeStore, payload: Payload = {}) {
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
  // 锚点节点无原文出处（容器/标题节点）时不再静默退回 offset 0：store 已下钻子树首个有出处的后代，
  // 仍无果才标 anchorResolved=false——此处显式提示，避免「拿第一回当锚点却悄悄返回版权页」。
  if (result.anchorResolved === false) {
    text = `[注意] 锚点节点无原文出处（可能是容器/标题节点且整棵子树都无 source span），已从文档开头返回原文窗口。\n\n${text}`;
  }
  if (!result.hasBefore) text = `[原文开始]\n\n${text}`;
  if (!result.hasAfter) text = `${text}\n\n[原文结束]`;
  const response: RowObject = {
    kind: 'content.getArticle',
    docId: result.docId,
    window: {
      startOffset: result.startOffset,
      endOffset: result.endOffset,
      totalLength: result.totalLength,
      hasBefore: result.hasBefore,
      hasAfter: result.hasAfter,
      anchorResolved: result.anchorResolved !== false
    },
    text
  };
  if (wantSpans) {
    const allSpans = Array.isArray(result.sourceSpans) ? result.sourceSpans : [];
    response.spansTotal = allSpans.length;
    // store 层投影出口已剥掉 doc_id（每条 span 与顶层 docId 重复纯属冗余）；这里只截再透传。
    response.sourceSpans = allSpans
      .filter((span): span is NonNullable<typeof span> => Boolean(span))
      .slice(0, spansCap);
  }
  return response;
}

