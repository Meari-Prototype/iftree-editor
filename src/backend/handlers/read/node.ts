// 读动作 handler（自 query-api.ts 按域拆出，§6-4：照 mutation-api 的 handlers/write 样板）。
// 本文件由分派表 query-api.ts 消费；跨域共享的 helper 一律住 shared.ts。
import { nodeWithChildCount, normalizeLimit, normalizeNonNegativeInteger, normalizeQueryId, plainRow, requireDocId, resolveAddress } from './shared.js';
import { pdfHighlightRects, pdfSpanHitRects } from '../../source/pdf-highlight-geometry.js';
import { formatAddress, isAncestor, nextInDfs, parentAddress, parseAddress } from '../../../core/tree-cursor.js';
import { getProjectedDoc } from '../../projection/doc-view.js';
import type { ContentNodeRow, NodeAncestorRow, NodeAncestorsResult, Payload } from './shared.js';
import type { IftreeStore } from '../../store/index.js';

export function queryNode(store: IftreeStore, payload: Payload = {}): ContentNodeRow | null {
  const docId = requireDocId(payload);
  const nodeId = normalizeQueryId(payload.nodeId ?? payload.node_id);
  if (nodeId) return nodeWithChildCount(store, docId, nodeId);
  if (payload.address) return resolveAddress(store, docId, payload.address);
  return null;
}

export function queryChildren(store: IftreeStore, payload: Payload = {}) {
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

export function queryNodesPage(store: IftreeStore, payload: Payload = {}) {
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

export function querySearchNodes(store: IftreeStore, payload: Payload = {}) {
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

export function queryStructureRows(store: IftreeStore, payload: Payload = {}) {
  const rows = store.getDocStructureRows({ docId: requireDocId(payload) }).map(plainRow);
  const limit = payload.limit === 0 ? 0 : normalizeLimit(payload.limit, 10000, 100000);
  return {
    total: rows.length,
    truncated: Boolean(limit && rows.length > limit),
    rows: limit ? rows.slice(0, limit) : rows
  };
}

export function querySourceWindow(store: IftreeStore, payload: Payload = {}) {
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

// 子树扁平正文（自 db-shell collectFlatSubtreeText 下沉，§6-2）：按 core 的 DFS 先序
//（tree-cursor.nextInDfs）拼接子树各节点正文、按【字符数】截断——区别于 content.getSubtree
// 的分层早停（大章一层就上万字时只剩标题层），这里到 charLimit 字即停、大章也能拿到前段真实正文。
// 整棵子树一次取回（address+text），childCountOf 由地址集现算，DFS 在内存里推。
export function querySubtreeFlatText(store: IftreeStore, payload: Payload = {}) {
  const docId = requireDocId(payload);
  const rootAddress = String(payload.address ?? '').trim();
  if (!rootAddress) throw new Error('subtree.getFlatText requires address');
  const budget = Number(payload.charLimit ?? payload.char_limit) || 0;
  if (!(budget > 0)) throw new Error('subtree.getFlatText requires positive charLimit');
  const root = formatAddress(parseAddress(rootAddress));
  const rows = store.db!
    .prepare('SELECT address, text FROM nodes WHERE doc_id = ? AND (address = ? OR address GLOB ?)')
    .all<{ address: string; text: string | null }>(docId, root, `${root}-*`);
  const byAddress = new Map<string, string>();
  const childCount = new Map<string, number>();
  for (const row of rows) {
    const addr = String(row.address || '');
    if (!addr) continue;
    byAddress.set(addr, String(row.text || ''));
    const parent = parentAddress(addr);
    if (parent) childCount.set(parent, (childCount.get(parent) || 0) + 1);
  }
  const childCountOf = (addr: string) => childCount.get(addr) || 0;
  const parts: string[] = [];
  let used = 0;
  let totalChars = 0;
  let truncated = false;
  // DFS 先序遍历子树（root 自身 + 后代），到 root 子树之外即停。
  for (let cur: string | null = root; cur && (cur === root || isAncestor(root, cur)); cur = nextInDfs(cur, childCountOf)) {
    const text = byAddress.get(cur) || '';
    if (!text) continue;
    totalChars += text.length;
    if (used >= budget) { truncated = true; continue; }
    const remain = budget - used;
    if (text.length <= remain) { parts.push(text); used += text.length; } else { parts.push(text.slice(0, remain)); used = budget; truncated = true; }
  }
  return { kind: 'subtree.getFlatText', docId, address: root, text: parts.join('\n'), truncated, totalChars, used };
}

// PDF 高亮几何（source 域，§6-1 自 store 门面收敛至此）：实现在 pdf-highlight-geometry，
// 这里只是 action 面。GUI 管道动词 source.readPdfHighlights/readPdfSpanRects 也转发到这两个 action。
export function querySourcePdfHighlightRects(store: IftreeStore, payload: Payload = {}) {
  const docId = requireDocId(payload);
  const ranges = Array.isArray(payload.ranges)
    ? payload.ranges
    : [{ start: payload.startOffset ?? payload.start_offset, end: payload.endOffset ?? payload.end_offset }];
  return { kind: 'source.pdfHighlightRects', docId, rects: pdfHighlightRects(store.db!, docId, ranges) };
}

export function querySourcePdfHitRects(store: IftreeStore, payload: Payload = {}) {
  const docId = requireDocId(payload);
  return { kind: 'source.pdfHitRects', docId, rects: pdfSpanHitRects(store.db!, docId) };
}

export function payloadNodeIds(payload: Payload = {}) {
  return Array.isArray(payload.nodeIds)
    ? payload.nodeIds
    : Array.isArray(payload.node_ids)
      ? payload.node_ids
      : [];
}

export function queryNodeTextBatch(store: IftreeStore, payload: Payload = {}) {
  return store.getNodeTextBatch({
    docId: requireDocId(payload),
    nodeIds: payloadNodeIds(payload)
  }).map(plainRow);
}

export function querySubtreeTextWindow(store: IftreeStore, payload: Payload = {}) {
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

export function querySubtreeSlotRange(store: IftreeStore, payload: Payload = {}) {
  return store.getSubtreeSlotRange({
    docId: requireDocId(payload),
    nodeId: payload.nodeId ?? payload.node_id
  }).map(plainRow);
}

export function queryAncestorChain(store: IftreeStore, payload: Payload = {}) {
  return store.getAncestorChain({
    docId: requireDocId(payload),
    nodeId: payload.nodeId ?? payload.node_id
  }).map(plainRow);
}

// 兄弟序比较：与 node.listChildren 的分页序（SQL `ORDER BY sort_order, id`，id 是 TEXT 列按
// BINARY 比）同口径——child_offset 只有与分页序一致才指得准「第几页」。
function compareSiblingOrder(left: ContentNodeRow, right: ContentNodeRow): number {
  const bySort = (Number(left.sort_order) || 0) - (Number(right.sort_order) || 0);
  if (bySort !== 0) return bySort;
  const a = String(left.id);
  const b = String(right.id);
  return a < b ? -1 : (a > b ? 1 : 0);
}

// 投影口径下的祖先链：有活跃 human 编辑分支时链必须从投影行上走。分支里 reparent / insert /
// delete 过的节点在主干上要么根本不存在（tmp id）、要么还挂在旧父下，直接读主干会给前端一条
// 与它正在看的文档对不上的链。
function projectedAncestorRows(store: IftreeStore, docId: string, payload: Payload): NodeAncestorRow[] {
  const data = getProjectedDoc(store, docId, {
    includeSourceSpans: false,
    includeSourceDocumentContent: false
  });
  const nodes: ContentNodeRow[] = data?.nodes ?? [];
  if (nodes.length === 0) return [];
  const byId = new Map<string, ContentNodeRow>();
  const childrenByParent = new Map<string, ContentNodeRow[]>();
  for (const row of nodes) {
    byId.set(String(row.id), row);
    const key = row.parent_id === null || row.parent_id === undefined ? '' : String(row.parent_id);
    const list = childrenByParent.get(key);
    if (list) list.push(row); else childrenByParent.set(key, [row]);
  }

  const nodeId = normalizeQueryId(payload.nodeId ?? payload.node_id);
  const address = String(payload.address ?? '').trim();
  let cursor = nodeId ? byId.get(String(nodeId)) ?? null : null;
  if (!cursor && address) cursor = nodes.find((row) => String(row.address || '') === address) ?? null;
  if (!cursor) return [];

  // 自底向上收链再反转（seen 兜环：投影行理论上无环，但链遍历不该因脏数据变成死循环）。
  const chain: ContentNodeRow[] = [];
  const seen = new Set<string>();
  while (cursor && !seen.has(String(cursor.id))) {
    seen.add(String(cursor.id));
    chain.push(cursor);
    cursor = cursor.parent_id === null || cursor.parent_id === undefined
      ? null
      : byId.get(String(cursor.parent_id)) ?? null;
  }
  chain.reverse();

  const sorted = new Set<string>();
  return chain.map((row) => {
    const key = row.parent_id === null || row.parent_id === undefined ? '' : String(row.parent_id);
    const siblings = childrenByParent.get(key) ?? [];
    if (!sorted.has(key)) { siblings.sort(compareSiblingOrder); sorted.add(key); }
    const at = siblings.findIndex((sibling) => String(sibling.id) === String(row.id));
    return { ...row, child_offset: Math.max(0, at) } as NodeAncestorRow;
  });
}

// 主干口径的祖先链：递归 CTE 一次拿全链的整行 + child_count + child_offset。无分支时不走
// getProjectedDoc——那会为一条链把整篇文档物化一遍。
function trunkAncestorRows(store: IftreeStore, docId: string, payload: Payload): NodeAncestorRow[] {
  const nodeId = normalizeQueryId(payload.nodeId ?? payload.node_id)
    ?? (payload.address ? resolveAddress(store, docId, payload.address)?.id ?? null : null);
  if (!nodeId) return [];
  return store.db!.prepare(`
    WITH RECURSIVE chain(id, parent_id) AS (
      SELECT id, parent_id FROM nodes WHERE doc_id = ? AND id = ?
      UNION ALL
      SELECT parent.id, parent.parent_id
      FROM nodes parent
      JOIN chain ON parent.id = chain.parent_id
      WHERE parent.doc_id = ?
    )
    SELECT nodes.*,
      (SELECT COUNT(*) FROM nodes child
        WHERE child.doc_id = ? AND child.parent_id = nodes.id) AS child_count,
      (SELECT COUNT(*) FROM nodes sibling
        WHERE sibling.doc_id = ? AND sibling.parent_id IS nodes.parent_id
          AND (sibling.sort_order < nodes.sort_order
            OR (sibling.sort_order = nodes.sort_order AND sibling.id < nodes.id))) AS child_offset
    FROM nodes
    JOIN chain ON chain.id = nodes.id
    ORDER BY nodes.depth
  `).all<NodeAncestorRow>(docId, nodeId, docId, docId, docId).map((row) => plainRow(row));
}

// 「根 → 目标节点」的整条链（含目标自身）。前端 session 在目标不在镜像时用它把路径整条拉回来
// ——搜索/实体视图点深层结果、驱逐后重进的子树、后台预取还没走到的区域，都是「父行不在镜像」
// 的场景，只取子会被 session 的孤儿闸整批丢弃。行格式与 node.listChildren 一致（nodes.* +
// child_count），额外带 child_offset 让前端知道每一环落在父的第几页。
export function queryNodeAncestors(store: IftreeStore, payload: Payload = {}): NodeAncestorsResult {
  const docId = requireDocId(payload);
  const branch = store.activeEditBranchForBaseDoc(docId, 'human');
  const rows = branch ? projectedAncestorRows(store, docId, payload) : trunkAncestorRows(store, docId, payload);
  return {
    kind: 'node.ancestors',
    docId,
    nodeId: rows.length > 0 ? String(rows[rows.length - 1]!.id) : null,
    rows
  };
}

