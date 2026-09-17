// 统一动作面 · 读分派表（§3.5 / A2-1）：action 名 -> handlers/read/* 的唯一实现。
// 本文件只做分派与工具 schema，不写查询实现；新增读能力先落 handlers/read 再来此注册。
import { runMemoryRead, MEMORY_READ_ACTIONS } from './memory/index.js';
import { ENTITY_READ_ACTIONS, runEntityRead } from './entities/read.js';
import { handleDebugOverviewQuery, handleDebugSqlQuery } from './handlers/read/debug.js';
import {
  STABLE_ID_SCHEMA,
  normalizeDocRow,
  plainRow,
  requireDocId
} from './handlers/read/shared.js';
import {
  queryContentDocs,
  queryContentIndex,
  queryContentNode,
  queryContentSubtree,
  queryContentDepth,
  queryContentArticle,
  queryLibraryIndex,
  queryLibraryNavigation
} from './handlers/read/content.js';
import {
  queryContentKeyword,
  queryContentSearch,
  queryContentSearchAll,
  queryContentSearchEntityExpand
} from './handlers/read/search.js';
import {
  queryHistoryDiff,
  queryHistorySnapshot,
  queryHistoryFind,
  queryHistoryRead,
  queryRefDiff,
  queryNodeHistory
} from './handlers/read/history.js';
import {
  docInfo,
  queryDoc,
  queryDocExportMarkdown,
  queryPendingEditBranches,
  queryEditBranchDiffView,
  queryThreeWayMerge
} from './handlers/read/doc.js';
import {
  queryNode,
  queryChildren,
  queryNodesPage,
  querySearchNodes,
  queryNodeTextBatch,
  queryStructureRows,
  querySubtreeTextWindow,
  querySubtreeFlatText,
  querySubtreeSlotRange,
  queryAncestorChain,
  queryNodeAncestors,
  querySourceWindow,
  querySourcePdfHighlightRects,
  querySourcePdfHitRects
} from './handlers/read/node.js';
import type { IftreeStore } from './store/index.js';
import type { Payload, QueryContext } from './handlers/read/shared.js';

// 对外类型沿用原 query-api 出口，实际定义随实现迁至 handlers/read。
export type {
  TreeViewStateSummary,
  DocListItem,
  DocGetNodeRow,
  DocGetRefRow,
  DocGetSourceSpanRow,
  DocGetResult,
  NodeAncestorRow,
  NodeAncestorsResult
} from './handlers/read/shared.js';
export type { ContentSearchResult } from './handlers/read/search.js';
export type NodeChildrenResult = ReturnType<typeof queryChildren>;
export type SourceWindowResult = ReturnType<typeof querySourceWindow>;
export type TypedDatabaseReadRequest =
  | ({ action: 'content.search'; searchMode: 'vector'; docId: string } & Record<string, unknown>)
  | ({ action: 'doc.list' } & Record<string, unknown>)
  | ({ action: 'docFolder.list' } & Record<string, unknown>)
  | ({ action: 'doc.get' } & Record<string, unknown>)
  | ({ action: 'node.listChildren' } & Record<string, unknown>)
  | ({ action: 'source.getWindow' } & Record<string, unknown>);
export type TypedDatabaseReadResult<Request extends TypedDatabaseReadRequest> =
  Request extends { action: 'content.search'; searchMode: 'vector' } ? import('./handlers/read/search.js').ContentSearchResult
    : Request extends { action: 'doc.list' } ? import('./handlers/read/shared.js').DocListItem[]
      : Request extends { action: 'docFolder.list' } ? ReturnType<IftreeStore['listDocFolders']>
        : Request extends { action: 'doc.get' } ? import('./handlers/read/shared.js').DocGetResult | null
          : Request extends { action: 'node.listChildren' } ? NodeChildrenResult
            : Request extends { action: 'source.getWindow' } ? SourceWindowResult
              : never;
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
  'content.searchEntityExpand',
  ...ENTITY_READ_ACTIONS,
  'library.getTree',
  'memory.listVolumes',
  'doc.list',
  'docFolder.list',
  'history.diff',
  'history.snapshot',
  'history.find',
  'history.read',
  'diff.refs',
  'history.nodeLog',
  'editBranch.listPending',
  'editBranch.diffView',
  'editBranch.threeWayMerge',
  'doc.get',
  // 'doc.exportMarkdown' 已停用（未启用，待重新设计）——不再对外通告；分派入口保留并抛清晰停用错误。
  'doc.getInfo',
  'doc.hasTreeDepth',
  'node.get',
  'node.listChildren',
  'node.listPage',
  'node.search',
  'node.getTextBatch',
  'node.listStructureRows',
  'subtree.getTextWindow',
  'subtree.getFlatText',
  'subtree.getSlotRange',
  'node.getAncestorChain',
  'node.ancestors',
  'source.getWindow',
  'source.pdfHighlightRects',
  'source.pdfHitRects'
]);


function normalizeQueryAction(value: unknown) {
  const action = String(value || 'debug.overview').trim();
  return ACTIONS.includes(action) ? action : '';
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
      ref: { type: 'string', description: 'History ref for history.snapshot/find/read: commit id, committed_at, or summary tag; must resolve uniquely (ambiguity is an error).' },
      refKind: { type: 'string', enum: ['id', 'committed_at', 'summary', 'committed_at_or_summary'], description: 'Optional explicit kind for ref; defaults to id when ref looks like a stable id, else committed_at_or_summary.' },
      atAddress: { type: 'boolean', description: 'history.snapshot/read: locate address by its historical position (git <commit>:<path> semantics) instead of stable-identity follow.' },
      range: { type: 'string', enum: ['node', 'subtree', 'siblings'], description: 'history.read body range; defaults to subtree.' },
      address: { type: 'string' },
      query: { type: 'string', description: 'Query text for content.search/content.searchAll. In keyword mode this is a substring, not multi-term AND.' },
      q: { type: 'string', description: 'Alias for query. In keyword mode this is a substring, not multi-term AND.' },
      keyword: { type: 'string', description: 'Single keyword for content.searchKeyword.' },
      terms: { type: 'array', items: { type: 'string' }, description: 'Multiple terms for content.searchKeyword; all terms must match according to matchMode.' },
      matchMode: { type: 'string', enum: ['doc', 'node', 'or'], description: 'content.searchKeyword only: doc returns documents where every term appears somewhere in the doc, node returns nodes matching every term, or returns per-term groups.' },
      minScore: { type: 'number', description: 'Score floor filter: vector similarity for content.search/searchAll (vector mode), literal hit-count for content.searchKeyword doc/node match modes. Filtered-out count is reported as weakFilteredOut for vector mode.' },
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
      include: { type: 'array', items: { type: 'string', enum: ['note', 'tags', 'source', 'timestamps', 'spans', 'summary', 'hash'] } },
      searchMode: { type: 'string', enum: ['keyword', 'vector'] },
      allDocs: { type: 'boolean' },
      scopeDocId: STABLE_ID_SCHEMA,
      scopeAddress: { type: 'string' },
      path: { type: 'string' },
      subtree: { type: 'boolean' },
      includeSubtree: { type: 'boolean' },
      previewChars: { type: 'number' },
      charLimit: { type: 'number', description: 'subtree.getTextWindow 的本页字符预算（累计达到即截断本页，省略或 0 不限）；subtree.getFlatText 的 DFS 拼正文预算（必填正数，到预算即停）。' },
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
      endOffset: { type: 'number', description: 'source.pdfHighlightRects：与 startOffset 组成单一原文偏移区间（不传 ranges 时用）。' },
      ranges: { type: 'array', description: 'source.pdfHighlightRects：原文偏移区间数组 [{start,end}...]。' },
      before: { type: 'number' },
      after: { type: 'number' },
      spansLimit: { type: 'number' }
    },
    required: ['action']
  };
}

// store 容 null：query.actions / library.getTree 不落库（database-service 传 null），其余 action 由
// !store?.db 守卫拦下——这是真签名，不再靠调用侧 as unknown 洗宽（§6-10）。
export async function runDatabaseRead(store: IftreeStore | null, payload: Payload = {}, ctx: QueryContext = {}) {
  const action = normalizeQueryAction(payload.action || payload.type);
  if (!action) throw new Error(`Unknown read query action: ${payload.action || payload.type || ''}`);

  if (action === 'query.actions') return { actions: databaseReadActions() };
  if (action === 'library.getTree') {
    if (typeof ctx.libraryTree !== 'function') throw new Error('library.getTree is not available');
    return ctx.libraryTree(payload);
  }
  if (!store?.db) throw new Error('read query store is not available');
  if (action === 'debug.sql') return handleDebugSqlQuery(store as unknown as Parameters<typeof handleDebugSqlQuery>[0], payload);
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
  if (action === 'content.searchEntityExpand') return queryContentSearchEntityExpand(store, payload, ctx);
  if (ENTITY_READ_ACTIONS.includes(action)) return runEntityRead(store, payload, action, ctx);
  if (MEMORY_READ_ACTIONS.includes(action)) return runMemoryRead(store, payload, action);
  if (action === 'debug.overview') return handleDebugOverviewQuery(store as unknown as Parameters<typeof handleDebugOverviewQuery>[0]);
  if (action === 'doc.list') return store.listDocs().map(normalizeDocRow);
  if (action === 'docFolder.list') return store.listDocFolders().map(plainRow);
  if (action === 'history.diff') return queryHistoryDiff(store, payload);
  if (action === 'history.snapshot') return queryHistorySnapshot(store, payload);
  if (action === 'history.find') return queryHistoryFind(store, payload);
  if (action === 'history.read') return queryHistoryRead(store, payload);
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
  if (action === 'subtree.getFlatText') return querySubtreeFlatText(store, payload);
  if (action === 'subtree.getSlotRange') return querySubtreeSlotRange(store, payload);
  if (action === 'node.getAncestorChain') return queryAncestorChain(store, payload);
  if (action === 'node.ancestors') return queryNodeAncestors(store, payload);
  if (action === 'source.getWindow') return querySourceWindow(store, payload);
  if (action === 'source.pdfHighlightRects') return querySourcePdfHighlightRects(store, payload);
  if (action === 'source.pdfHitRects') return querySourcePdfHitRects(store, payload);

  throw new Error(`Unhandled read query action: ${action}`);
}
