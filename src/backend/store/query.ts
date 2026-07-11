// 文档、节点与子树的只读物化查询（L2）。

import type Database from 'better-sqlite3';
import { buildTree } from '../../core/tree.js';
import { sameStableId } from '../db/ids.js';
import { addressSortKey, normalizeNodeIdBatch, normalizePositiveId } from '../db/normalizers.js';
import type { AxiomRow, NodeRow, RefRow, SourceDocumentRow, SourcePdfPageRow, SourceSpanRow } from '../db/schema.js';
import * as axiomRef from './axiom-ref.js';
import * as historyStore from './history.js';

type RowObject = Record<string, unknown>;
type NodeWithChildCountRow = NodeRow & { child_count: number; tree_depth?: number };
export type DocMaterializedRows = { nodes: NodeWithChildCountRow[]; axioms: AxiomRow[]; refs: RefRow[] };
type DocDetailRow = import('../db/schema.js').DocRow & { node_count: number };
type DocDepthPayload = { docId?: unknown; depth?: unknown };
type DocIdPayload = { docId?: unknown };
type NodeBatchPayload = { docId?: unknown; nodeIds?: unknown[] };
type SearchNodesPayload = { docId?: unknown; query?: unknown; limit?: unknown };
type NodeRefPayload = { docId?: unknown; nodeId?: unknown };
type SubtreeTextWindowPayload = NodeRefPayload & { offset?: unknown; limit?: unknown; charLimit?: unknown };
type DocNodesPagePayload = { docId?: unknown; afterId?: unknown; limit?: unknown };
type OrdinalRow = { ordinal: number };
type AddressTreeNode = RowObject & { id?: unknown; address?: unknown; children?: AddressTreeNode[] };

export interface QueryStore extends historyStore.HistoryStore, axiomRef.AxiomRefStore { db: Database | null }

export function getDoc(store: QueryStore, docId: unknown, options: { includeSourceSpans?: boolean; includeSourceDocumentContent?: boolean; maxTreeDepth?: unknown } = {}) {
    return materializeDoc(store, docId, options);
  }

export function materializeDoc(store: QueryStore,
    docId: unknown,
    options: { includeSourceSpans?: boolean; includeSourceDocumentContent?: boolean; maxTreeDepth?: unknown } = {},
    suppliedRows: DocMaterializedRows | null = null
  ) {
    const includeSourceSpans = options.includeSourceSpans !== false;
    const includeSourceDocumentContent = options.includeSourceDocumentContent !== false;
    const maxTreeDepth = Number(options.maxTreeDepth);
    const treeDepthLimit = Number.isInteger(maxTreeDepth) && maxTreeDepth > 0 ? maxTreeDepth : null;
    const doc = store.db!.prepare(`
      SELECT
        docs.*,
        (SELECT COUNT(*) FROM nodes WHERE doc_id = docs.id) AS node_count
      FROM docs
      WHERE id = ?
    `).get<DocDetailRow>(docId);
    if (!doc) return null;

    const depthRows = store.db!.prepare(`
      SELECT depth, COUNT(*) AS count
      FROM nodes
      WHERE doc_id = ?
      GROUP BY depth
      ORDER BY depth
    `).all<Array<{ depth: number; count: number }>[number]>(docId);
    const depths = depthRows
      .map((row) => Math.floor(Number(row.depth) || 0))
      .filter((depth) => depth > 0);
    const effectiveMaxDepth = depths.length ? Math.max(...depths) : 1;
    const effectiveDepths = (depths.length ? depths : [1]).filter((depth) => depth <= effectiveMaxDepth);
    const treeDepthStats = {
      maxDepth: effectiveMaxDepth,
      depths: effectiveDepths.length ? effectiveDepths : [1],
      counts: Object.fromEntries(depthRows.map((row) => [
        Math.floor(Number(row.depth) || 0),
        Number(row.count) || 0
      ]).filter(([depth]) => depth > 0 && depth <= effectiveMaxDepth)),
      root: {
        subtreeMaxDepth: null,
        nextDepthNodeCount: null,
        subtreeTextChars: null
      }
    };

    let nodes = suppliedRows?.nodes ?? (treeDepthLimit
      ? store.db!.prepare(`
        WITH visible_nodes AS (
          SELECT * FROM nodes WHERE doc_id = ? AND depth <= ?
        ), child_counts(parent_id, child_count) AS (
          SELECT child.parent_id, COUNT(*)
          FROM nodes child JOIN visible_nodes ON child.parent_id = visible_nodes.id
          WHERE child.doc_id = ? GROUP BY child.parent_id
        )
        SELECT visible_nodes.*, visible_nodes.depth AS tree_depth,
          COALESCE(child_counts.child_count, 0) AS child_count
        FROM visible_nodes
        LEFT JOIN child_counts ON child_counts.parent_id = visible_nodes.id
        ORDER BY visible_nodes.parent_id IS NOT NULL, visible_nodes.parent_id, visible_nodes.sort_order, visible_nodes.id
      `).all<NodeWithChildCountRow>(docId, treeDepthLimit, docId)
      : store.db!.prepare(`
        WITH child_counts(parent_id, child_count) AS (
          SELECT parent_id, COUNT(*) FROM nodes
          WHERE doc_id = ? AND parent_id IS NOT NULL GROUP BY parent_id
        )
        SELECT nodes.*, COALESCE(child_counts.child_count, 0) AS child_count
        FROM nodes LEFT JOIN child_counts ON child_counts.parent_id = nodes.id
        WHERE nodes.doc_id = ?
        ORDER BY nodes.parent_id IS NOT NULL, nodes.parent_id, nodes.sort_order, nodes.id
      `).all<NodeWithChildCountRow>(docId, docId));
    let axioms = suppliedRows?.axioms ?? axiomRef.listAxioms(store, docId) as unknown as AxiomRow[];
    let refs = suppliedRows?.refs ?? axiomRef.listDocRefs(store, docId) as RefRow[];

    if (suppliedRows && treeDepthLimit) {
      nodes = nodes.filter((node) => (Number(node.depth) || 0) <= treeDepthLimit);
      const childCountByParent = new Map<unknown, number>();
      for (const node of nodes) {
        const key = node.parent_id === null || node.parent_id === undefined ? 'root' : node.parent_id;
        childCountByParent.set(key, (childCountByParent.get(key) || 0) + 1);
      }
      nodes = nodes.map((node) => ({ ...node, child_count: childCountByParent.get(node.id) || 0 }));
    }

    const tree = buildTree(nodes) as AddressTreeNode | null;
    const addressById = new Map();
    const idByAddress = new Map();

    function indexAddresses(node: AddressTreeNode | null | undefined) {
      if (!node) return;
      addressById.set(node.id, node.address);
      idByAddress.set(node.address, node.id);
      for (const child of node.children || []) indexAddresses(child);
    }
    indexAddresses(tree);

    const axiomById = new Map(axioms.map((axiom) => [String(axiom.id), axiom]));
    refs = refs.map((ref) => ({
        ...ref,
        source_address: ref.source_type === 'node'
          ? addressById.get(ref.source_id) || null
          : ref.source_type === 'axiom'
            ? `前提 ${axiomById.get(String(ref.source_id))?.label || ref.source_id}`
            : null,
        target_address: ref.target_type === 'node' ? addressById.get(ref.target_id) || null : null
      }));

    const history = historyStore.listHistory(store, docId as string);
    const sourceDocument = includeSourceDocumentContent
      ? store.db!.prepare('SELECT * FROM source_documents WHERE doc_id = ?').get<SourceDocumentRow>(docId) || null
      : store.db!.prepare(`
        SELECT doc_id, source_type, original_path, '' AS raw_markdown, created_at
        FROM source_documents
        WHERE doc_id = ?
      `).get<SourceDocumentRow>(docId) || null;
    const sourcePdfPages = store.db!.prepare(`
      SELECT page_number, width, height
      FROM source_pdf_pages
      WHERE doc_id = ?
      ORDER BY page_number
    `).all<SourcePdfPageRow>(docId);
    const sourceSpans = includeSourceSpans
      ? store.db!.prepare(`
        SELECT * FROM source_spans
        WHERE doc_id = ?
        ORDER BY sentence_index, id
      `).all<SourceSpanRow>(docId).map((span) => ({
        ...span,
        node_address: span.node_id ? addressById.get(span.node_id) || null : null
      }))
      : [];

    return {
      doc,
      nodes,
      tree,
      axioms,
      refs,
      history,
      sourceDocument,
      sourcePdfPages,
      sourceSpans,
      treeDepthStats,
      idByAddress: Object.fromEntries(idByAddress)
    };
  }

  /** @param {{ docId?: unknown, depth?: number }} [payload] */
export function hasDocTreeDepth(store: QueryStore, { docId, depth }: DocDepthPayload = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const targetDepth = Math.max(1, Math.floor(Number(depth) || 1));
    if (!normalizedDocId) {
      return { docId: null, depth: targetDepth, exists: false };
    }
    const row = store.db!.prepare(`
      SELECT 1 AS exists_depth
      FROM nodes
      WHERE doc_id = ? AND depth = ?
      LIMIT 1
    `).get<{ exists_depth: number }>(normalizedDocId, targetDepth);
    return {
      docId: normalizedDocId,
      depth: targetDepth,
      exists: Boolean(row)
    };
  }

  /** @param {{ docId?: unknown }} [payload] */
export function getDocStructureRows(store: QueryStore, { docId }: DocIdPayload = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    if (normalizedDocId === null) return [];
    return store.db!.prepare(`
      WITH child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IS NOT NULL
        GROUP BY parent_id
      )
      SELECT nodes.id,
        nodes.doc_id,
        nodes.parent_id,
        nodes.sort_order,
        nodes.depth,
        nodes.address,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM nodes
      LEFT JOIN child_counts ON child_counts.parent_id = nodes.id
      WHERE nodes.doc_id = ?
      ORDER BY nodes.parent_id IS NOT NULL, nodes.parent_id, nodes.sort_order, nodes.id
    `).all<Pick<NodeRow, 'id' | 'doc_id' | 'parent_id' | 'sort_order' | 'depth' | 'address'> & { child_count: number }>(normalizedDocId, normalizedDocId);
  }

  /** @param {{ docId?: unknown, nodeIds?: unknown[] }} [payload] */
export function getNodeTextBatch(store: QueryStore, { docId, nodeIds = [] }: NodeBatchPayload = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const ids = normalizeNodeIdBatch(nodeIds, 500);
    if (normalizedDocId === null || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return store.db!.prepare(`
      WITH requested_nodes AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ? AND id IN (${placeholders})
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM requested_nodes)
        GROUP BY parent_id
      )
      SELECT requested_nodes.id,
        requested_nodes.doc_id,
        requested_nodes.parent_id,
        requested_nodes.sort_order,
        requested_nodes.depth,
        requested_nodes.address,
        requested_nodes.node_type,
        requested_nodes.text,
        requested_nodes.node_title,
        requested_nodes.node_note,
        requested_nodes.trust_level,
        requested_nodes.source_position,
        COALESCE(child_counts.child_count, 0) AS child_count,
        requested_nodes.created_at,
        requested_nodes.updated_at
      FROM requested_nodes
      LEFT JOIN child_counts ON child_counts.parent_id = requested_nodes.id
      ORDER BY requested_nodes.id
    `).all<NodeWithChildCountRow>(normalizedDocId, ...ids, normalizedDocId);
  }

  /** @param {{ docId?: unknown, query?: string, limit?: number }} [payload] */
export function searchNodes(store: QueryStore, { docId, query, limit = 20 }: SearchNodesPayload = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const text = String(query || '').trim();
    if (normalizedDocId === null || !text) return [];
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
    const escaped = text.replace(/[\\%_]/g, (match) => `\\${match}`);
    const like = `%${escaped}%`;
    return store.db!.prepare(`
      WITH matched AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ?
          AND (
            address LIKE ? ESCAPE '\\'
            OR node_title LIKE ? ESCAPE '\\'
            OR text LIKE ? ESCAPE '\\'
            OR node_note LIKE ? ESCAPE '\\'
          )
        ORDER BY
          CASE
            WHEN address = ? THEN 0
            WHEN node_title LIKE ? ESCAPE '\\' THEN 1
            WHEN text LIKE ? ESCAPE '\\' THEN 2
            ELSE 3
          END,
          depth,
          address,
          id
        LIMIT ?
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM matched)
        GROUP BY parent_id
      )
      SELECT matched.*,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM matched
      LEFT JOIN child_counts ON child_counts.parent_id = matched.id
      ORDER BY
        CASE
          WHEN matched.address = ? THEN 0
          WHEN matched.node_title LIKE ? ESCAPE '\\' THEN 1
          WHEN matched.text LIKE ? ESCAPE '\\' THEN 2
          ELSE 3
        END,
        matched.depth,
        matched.address,
        matched.id
    `).all(
      normalizedDocId,
      like,
      like,
      like,
      like,
      text,
      like,
      like,
      safeLimit,
      normalizedDocId,
      text,
      like,
      like
    );
  }

export function getNodeAddress(store: QueryStore, docId: unknown, nodeId: unknown) {
    const stored = store.db!.prepare(`
      SELECT address
      FROM nodes
      WHERE doc_id = ? AND id = ?
    `).get<Pick<NodeRow, 'address'>>(docId, nodeId);
    if (String(stored?.address || '').trim()) return String(stored?.address);

    const getNode = store.db!.prepare(`
      SELECT id, parent_id, sort_order
      FROM nodes
      WHERE doc_id = ? AND id = ?
    `);
    const getOrdinal = store.db!.prepare(`
      SELECT COUNT(*) AS ordinal
      FROM nodes
      WHERE doc_id = ?
        AND parent_id IS ?
        AND (
          sort_order < ?
          OR (sort_order = ? AND id <= ?)
        )
    `);
    const parts = [];
    let currentId = nodeId;
    while (currentId !== null && currentId !== undefined) {
      const node = getNode.get<Pick<NodeRow, 'id' | 'parent_id' | 'sort_order'>>(docId, currentId);
      if (!node) return null;
      const ordinal = Number(getOrdinal.get<OrdinalRow>(
        docId,
        node.parent_id ?? null,
        node.sort_order,
        node.sort_order,
        node.id
      )?.ordinal || 0);
      if (ordinal <= 0) return null;
      parts.push(ordinal);
      currentId = node.parent_id ?? null;
    }
    return parts.reverse().join('-');
  }

  /** @param {{ docId?: unknown, nodeId?: unknown }} [payload] */
export function getSubtreeSlotRange(store: QueryStore, { docId, nodeId }: NodeRefPayload = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedNodeId = normalizePositiveId(nodeId);
    if (normalizedDocId === null || normalizedNodeId === null) return [];
    const address = getNodeAddress(store, normalizedDocId, normalizedNodeId);
    if (!address) return [];
    const pathKey = addressSortKey(address);
    return store.db!.prepare(`
      WITH RECURSIVE subtree(id, doc_id, parent_id, sort_order, depth, address, path_key) AS (
        SELECT id, doc_id, parent_id, sort_order, depth, address, ? AS path_key
        FROM nodes
        WHERE doc_id = ? AND id = ?
        UNION ALL
        SELECT child.id,
          child.doc_id,
          child.parent_id,
          child.sort_order,
          child.depth,
          child.address,
          subtree.path_key || '-' || printf('%010d', (
            SELECT COUNT(*)
            FROM nodes sibling
            WHERE sibling.doc_id = child.doc_id
              AND sibling.parent_id IS child.parent_id
              AND (
                sibling.sort_order < child.sort_order
                OR (sibling.sort_order = child.sort_order AND sibling.id <= child.id)
              )
          ))
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
      SELECT subtree.id,
        subtree.doc_id,
        subtree.parent_id,
        subtree.sort_order,
        subtree.depth,
        subtree.address,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM subtree
      JOIN nodes ON nodes.id = subtree.id AND nodes.doc_id = subtree.doc_id
      LEFT JOIN child_counts ON child_counts.parent_id = subtree.id
      ORDER BY subtree.path_key
    `).all<Pick<NodeRow, 'id' | 'doc_id' | 'parent_id' | 'sort_order' | 'depth' | 'address'> & { child_count: number }>(pathKey, normalizedDocId, normalizedNodeId, normalizedDocId, normalizedDocId);
  }

  /** @param {{ docId?: unknown, nodeId?: unknown, offset?: number, limit?: number, charLimit?: number }} [payload] */
export function getSubtreeTextWindow(store: QueryStore, { docId, nodeId, offset = 0, limit = 1000, charLimit = 0 }: SubtreeTextWindowPayload = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedNodeId = normalizePositiveId(nodeId);
    if (normalizedDocId === null || normalizedNodeId === null) {
      return { rows: [], offset: 0, nextOffset: 0, limit: 0, charLimit: 0, textChars: 0, hasMore: false };
    }
    const root = store.db!.prepare(`
      SELECT id, address, source_position
      FROM nodes
      WHERE doc_id = ? AND id = ?
    `).get<Pick<NodeRow, 'id' | 'address' | 'source_position'>>(normalizedDocId, normalizedNodeId);
    const rootAddress = String(root?.address || '').trim();
    if (!root || !rootAddress) {
      return { rows: [], offset: 0, nextOffset: 0, limit: 0, charLimit: 0, textChars: 0, hasMore: false };
    }
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 1000)));
    // 0 表示不启用字符预算
    const safeCharLimit = Math.max(0, Math.floor(Number(charLimit) || 0));
    const prefix = `${rootAddress}-%`;
    // 子树排序口径：有原文出处的按 source_position 升序在前、无出处（NULL）的垫后再按 id。
    // 这是有意利用本系统的数据特性——节点 source_position 只有两态：导入文档=字符偏移(数字)、
    // 容器/标题/手工节点=NULL；而 root 行（上面 SELECT 恒含该列、且 root 必存在）只会是 number|null、
    // 绝不会是 undefined。故「取到了这列（数字或 NULL）就按出处排序、NULL 经 `source_position IS NULL` 垫后」
    // 恒成立；只有连列都拿不到（undefined，理论上不发生）才退化为纯 id 序。
    // 旧写法 `Number.isFinite(Number(root.source_position))` 表达同一判定（依赖 Number(NULL)===0 仍有限→true），
    // 这里改用 `!== undefined` 直陈「列是否存在」之意，不再借道 Number(null)===0。容器根子树仍按出处排序，
    // 由 store.test.mjs 的 orderBySource 用例锁定。
    const orderBySource = root.source_position !== undefined;
    const rows = store.db!.prepare(`
      WITH selected_nodes AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ?
          AND (address = ? OR address LIKE ?)
        ORDER BY ${orderBySource
          ? '(id = ?) DESC, source_position IS NULL, source_position, id'
          : '(id = ?) DESC, id'}
        LIMIT ? OFFSET ?
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM selected_nodes)
        GROUP BY parent_id
      )
      SELECT selected_nodes.id,
        selected_nodes.doc_id,
        selected_nodes.parent_id,
        selected_nodes.sort_order,
        selected_nodes.depth,
        selected_nodes.address,
        selected_nodes.node_type,
        selected_nodes.text,
        selected_nodes.node_title,
        selected_nodes.node_note,
        selected_nodes.trust_level,
        selected_nodes.source_position,
        COALESCE(child_counts.child_count, 0) AS child_count,
        selected_nodes.created_at,
        selected_nodes.updated_at
      FROM selected_nodes
      LEFT JOIN child_counts ON child_counts.parent_id = selected_nodes.id
      ORDER BY ${orderBySource
        ? '(selected_nodes.id = ?) DESC, selected_nodes.source_position IS NULL, selected_nodes.source_position, selected_nodes.id'
        : '(selected_nodes.id = ?) DESC, selected_nodes.id'}
    `).all<NodeWithChildCountRow>(normalizedDocId, rootAddress, prefix, normalizedNodeId, safeLimit + 1, safeOffset, normalizedDocId, normalizedNodeId);
    const rowTextChars = (row: NodeWithChildCountRow) => String(row.node_title || '').length + String(row.text || '').length + String(row.node_note || '').length;
    const fetched = rows.slice(0, safeLimit);
    let pageRows = fetched;
    let textChars = 0;
    if (safeCharLimit > 0) {
      // 字符预算：至少返回一行；累计达到预算后截断本页，保证 nextOffset 始终前进
      pageRows = [];
      for (const row of fetched) {
        pageRows.push(row);
        textChars += rowTextChars(row);
        if (textChars >= safeCharLimit) break;
      }
    } else {
      textChars = fetched.reduce((sum, row) => sum + rowTextChars(row), 0);
    }
    return {
      rows: pageRows,
      offset: safeOffset,
      nextOffset: safeOffset + pageRows.length,
      limit: safeLimit,
      charLimit: safeCharLimit,
      textChars,
      hasMore: rows.length > pageRows.length
    };
  }

  /** @param {{ docId?: unknown, nodeId?: unknown }} [payload] */
export function getAncestorChain(store: QueryStore, { docId, nodeId }: NodeRefPayload = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedNodeId = normalizePositiveId(nodeId);
    if (normalizedDocId === null || normalizedNodeId === null) return [];
    return store.db!.prepare(`
      WITH RECURSIVE ancestors(id, doc_id, parent_id, sort_order, depth, address) AS (
        SELECT id, doc_id, parent_id, sort_order, depth, address
        FROM nodes
        WHERE doc_id = ? AND id = ?
        UNION ALL
        SELECT parent.id, parent.doc_id, parent.parent_id, parent.sort_order, parent.depth, parent.address
        FROM nodes parent
        JOIN ancestors child ON child.parent_id = parent.id
        WHERE parent.doc_id = ?
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM ancestors)
        GROUP BY parent_id
      )
      SELECT ancestors.id,
        ancestors.doc_id,
        ancestors.parent_id,
        ancestors.sort_order,
        ancestors.depth,
        ancestors.address,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM ancestors
      LEFT JOIN child_counts ON child_counts.parent_id = ancestors.id
      ORDER BY ancestors.depth DESC
    `).all(normalizedDocId, normalizedNodeId, normalizedDocId, normalizedDocId);
  }

export function getSubtreeAggregates(store: QueryStore) {
    return {};
  }

export function getNodeChildren(store: QueryStore, { docId, parentId = null, offset = 0, limit = 300, anchorId = null, before = 0, after = 0 }: RowObject = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const normalizedParentId = parentId === null || parentId === undefined ? null : normalizePositiveId(parentId);
    const normalizedAnchorId = anchorId === null || anchorId === undefined ? null : normalizePositiveId(anchorId);
    if (!normalizedDocId) {
      return { rows: [], offset: 0, limit: 0, total: 0, hasMore: false, anchorOffset: null };
    }
    if (parentId !== null && parentId !== undefined && normalizedParentId === null) {
      return { rows: [], offset: 0, limit: 0, total: 0, hasMore: false, anchorOffset: null };
    }
    if (anchorId !== null && anchorId !== undefined && normalizedAnchorId === null) {
      return { rows: [], offset: 0, limit: 0, total: 0, hasMore: false, anchorOffset: null };
    }
    const requestedLimit = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 300)));
    let safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    let safeLimit = requestedLimit;
    let anchorOffset = null;
    const total = Number(store.db!.prepare(`
      SELECT COUNT(*) AS count
      FROM nodes
      WHERE doc_id = ? AND parent_id IS ?
    `).get(normalizedDocId, normalizedParentId)?.count || 0);
    if (normalizedAnchorId !== null) {
      const anchor = store.db!.prepare(`
        SELECT id, parent_id, sort_order
        FROM nodes
        WHERE doc_id = ? AND id = ?
      `).get(normalizedDocId, normalizedAnchorId);
      const anchorParentId = anchor?.parent_id === null || anchor?.parent_id === undefined ? null : normalizePositiveId(anchor.parent_id);
      if (anchor && sameStableId(anchorParentId, normalizedParentId)) {
        anchorOffset = Number(store.db!.prepare(`
          SELECT COUNT(*) AS count
          FROM nodes
          WHERE doc_id = ? AND parent_id IS ?
            AND (sort_order < ? OR (sort_order = ? AND id < ?))
        `).get(
          normalizedDocId,
          normalizedParentId,
          Number(anchor.sort_order) || 0,
          Number(anchor.sort_order) || 0,
          normalizedAnchorId
        )?.count || 0);
        const safeBefore = Math.max(0, Math.floor(Number(before) || 0));
        const safeAfter = Math.max(0, Math.floor(Number(after) || 0));
        safeOffset = Math.max(0, anchorOffset - safeBefore);
        safeLimit = Math.min(1000, Math.max(1, safeBefore + 1 + safeAfter, requestedLimit));
      }
    }
    const rows = store.db!.prepare(`
      WITH selected_children AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ? AND parent_id IS ?
        ORDER BY sort_order, id
        LIMIT ? OFFSET ?
      ),
      child_counts(parent_id, child_count) AS (
        SELECT parent_id, COUNT(*)
        FROM nodes
        WHERE doc_id = ? AND parent_id IN (SELECT id FROM selected_children)
        GROUP BY parent_id
      )
      SELECT selected_children.*,
        COALESCE(child_counts.child_count, 0) AS child_count
      FROM selected_children
      LEFT JOIN child_counts ON child_counts.parent_id = selected_children.id
      ORDER BY selected_children.sort_order, selected_children.id
    `).all(normalizedDocId, normalizedParentId, safeLimit, safeOffset, normalizedDocId);
    return {
      rows,
      offset: safeOffset,
      limit: safeLimit,
      anchorId: normalizedAnchorId,
      anchorOffset,
      total,
      hasMore: safeOffset + rows.length < total
    };
  }

  /** @param {{ docId?: unknown, afterId?: number, limit?: number }} [payload] */
export function getDocNodesPage(store: QueryStore, { docId, afterId = 0, limit = 5000 }: DocNodesPagePayload = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    if (!normalizedDocId) {
      return { rows: [], afterId: '', nextAfterId: '', limit: 0, hasMore: false };
    }
    const safeAfterId = normalizePositiveId(afterId) || '';
    const safeLimit = Math.min(10000, Math.max(100, Math.floor(Number(limit) || 5000)));
    const rows = store.db!.prepare(`
      WITH selected_nodes AS (
        SELECT *
        FROM nodes
        WHERE doc_id = ? AND (? = '' OR id > ?)
        ORDER BY id
        LIMIT ?
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
      ORDER BY selected_nodes.id
    `).all<NodeWithChildCountRow>(normalizedDocId, safeAfterId, safeAfterId, safeLimit + 1, normalizedDocId);
    const pageRows = rows.slice(0, safeLimit);
    const nextAfterId = pageRows.length > 0 ? pageRows[pageRows.length - 1].id : safeAfterId;
    return {
      rows: pageRows,
      afterId: safeAfterId,
      nextAfterId,
      limit: safeLimit,
      hasMore: rows.length > safeLimit
    };
  }

  /** @param {{ docId?: unknown, nodeId?: unknown, startOffset?: number | null, limit?: number, before?: number, spansLimit?: number }} [payload] */
