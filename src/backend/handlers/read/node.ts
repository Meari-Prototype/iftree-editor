// 读动作 handler（自 query-api.ts 按域拆出，§6-4：照 mutation-api 的 handlers/write 样板）。
// 本文件由分派表 query-api.ts 消费；跨域共享的 helper 一律住 shared.ts。
import { nodeWithChildCount, normalizeLimit, normalizeNonNegativeInteger, normalizeQueryId, plainRow, requireDocId, resolveAddress } from './shared.js';
import { pdfHighlightRects, pdfSpanHitRects } from '../../source/pdf-highlight-geometry.js';
import { formatAddress, isAncestor, nextInDfs, parentAddress, parseAddress } from '../../../core/tree-cursor.js';
import type { ContentNodeRow, Payload } from './shared.js';
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

