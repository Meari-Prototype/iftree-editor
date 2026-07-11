// 读动作 handler（自 query-api.ts 按域拆出，§6-4：照 mutation-api 的 handlers/write 样板）。
// 本文件由分派表 query-api.ts 消费；跨域共享的 helper 一律住 shared.ts。
import { nodeWithChildCount, normalizeDocRow, normalizeLimit, plainRow, requireDocId } from './shared.js';
import type { DocGetRefRow, DocGetResult, Payload } from './shared.js';
import { summarizeThreeWayMerge } from '../../diff/diff-view.js';
import type { IftreeStore } from '../../store/index.js';
import { getEditBranchDiffView } from './edit-branch-view.js';
import { getProjectedDoc } from '../../projection/doc-view.js';
import type { DocRow, NodeRow, SourceDocumentRow } from '../../db/schema.js';

export function docInfo(store: IftreeStore, payload: Payload = {}) {
  const docId = requireDocId(payload);
  const doc = store.db!.prepare(`
    SELECT
      d.*,
      (SELECT COUNT(*) FROM nodes n WHERE n.doc_id = d.id) AS node_count,
      (SELECT COUNT(*) FROM axioms a WHERE a.doc_id = d.id) AS axiom_count
    FROM docs d
    WHERE d.id = ?
  `).get<DocRow & { node_count: number; axiom_count: number }>(docId);
  if (!doc) return { doc: null };
  const sourceDocument = store.db!.prepare(`
    SELECT doc_id, source_type, original_path, created_at, LENGTH(raw_markdown) AS raw_length
    FROM source_documents
    WHERE doc_id = ?
  `).get<Pick<SourceDocumentRow, 'doc_id' | 'source_type' | 'original_path' | 'created_at'> & { raw_length: number }>(docId) || null;
  const rootNode = store.db!.prepare(`
    SELECT *
    FROM nodes
    WHERE doc_id = ? AND parent_id IS NULL
    ORDER BY sort_order, id
    LIMIT 1
  `).get<NodeRow>(docId) || null;
  return {
    doc: normalizeDocRow(doc),
    sourceDocument: plainRow(sourceDocument),
    rootNode: rootNode ? nodeWithChildCount(store, docId, rootNode.id) : null
  };
}

export function queryDoc(store: IftreeStore, payload: Payload = {}): DocGetResult | null {
  const docId = requireDocId(payload);
  const includeNodes = payload.includeNodes === true || payload.include_nodes === true;
  const includeSourceSpans = payload.includeSourceSpans === true || payload.include_source_spans === true;
  const data = getProjectedDoc(store, docId, {
    maxTreeDepth: payload.maxTreeDepth ?? payload.max_tree_depth,
    includeSourceSpans,
    includeSourceDocumentContent: payload.includeSourceDocumentContent === true || payload.include_source_document_content === true
  });
  if (!data) return null;
  // explicit lambda 让 TS 给 plainRow 推参时选「非 null 入 → 非 null 出」重载，否则 .map(plainRow) 会选更宽签名得到 (T|null)[]。
  return {
    ...data,
    doc: plainRow(data.doc),
    nodes: includeNodes ? data.nodes.map((row) => plainRow(row)) : [],
    axioms: data.axioms.map((row) => plainRow(row)),
    // store.getDoc 内部 refs.map 已加 source_address/target_address，但 `let refs: RefRow[]` 声明吞了新字段——边界 cast 收紧到真投影。
    refs: data.refs.map((row) => plainRow(row)) as DocGetRefRow[],
    history: data.history.map((row) => plainRow(row)),
    editBranch: payload.includeEditBranch === false || payload.include_edit_branch === false
      ? null
      : plainRow(store.activeEditBranchForDoc(docId, typeof payload.owner === 'string' ? payload.owner : null)),
    sourceDocument: plainRow(data.sourceDocument),
    sourcePdfPages: (data.sourcePdfPages || []).map((row) => plainRow(row)),
    sourceSpans: includeSourceSpans ? (data.sourceSpans || []).map((row) => plainRow(row)) : [],
    idByAddress: { ...(data.idByAddress || {}) }
  };
}

export function queryDocExportMarkdown(_store: IftreeStore, _payload: Payload = {}) {
  // 已停用（未启用，待重新设计）：原实现把 markdown 返回命令行而非导出为文件，渲染有地址当标题/混入
  // node_note 等功能错误，幂等与 import/export 对称设计未定。store.exportDocMarkdown /
  // core.renderDocMarkdown 实现暂留作重做参考，此入口先停。
  throw new Error('doc.exportMarkdown 已停用（未启用，待重新设计）：原实现把 markdown 返回命令行而非导出为文件，且渲染有地址当标题/混入 node_note 等功能错误，幂等与 import/export 对称设计未定。');
}

export function queryPendingEditBranches(store: IftreeStore, payload: Payload = {}) {
  return {
    kind: 'editBranch.listPending',
    branches: store.listActiveEditBranches(typeof payload.owner === 'string' ? payload.owner : null).map(plainRow)
  };
}

export function queryEditBranchDiffView(store: IftreeStore, payload: Payload = {}) {
  return getEditBranchDiffView(store, {
    branchId: payload.branchId ?? payload.branch_id ?? null,
    shadowDocId: payload.shadowDocId ?? payload.shadow_doc_id ?? null,
    baseDocId: payload.baseDocId ?? payload.base_doc_id ?? null,
    owner: payload.owner ?? 'human',
    changedOnly: payload.changedOnly ?? payload.changed_only ?? false,
    includeEntities: payload.includeEntities ?? payload.include_entities ?? false
  });
}

export function queryThreeWayMerge(store: IftreeStore, payload: Payload = {}) {
  const result = store.computeThreeWayMerge({
    branchId: payload.branchId ?? payload.branch_id ?? null,
    shadowDocId: payload.shadowDocId ?? payload.shadow_doc_id ?? null,
    baseDocId: payload.baseDocId ?? payload.base_doc_id ?? null,
    owner: payload.owner ?? 'human'
  });
  const detail = String(payload.detail ?? payload.view ?? payload.format ?? '').trim().toLowerCase();
  const raw = payload.raw === true || detail === 'raw' || detail === 'full';
  if (raw) return result;
  if (detail === 'summary' || payload.changedOnly === true || payload.changed_only === true) {
    return summarizeThreeWayMerge(result as Parameters<typeof summarizeThreeWayMerge>[0], { maxNodes: normalizeLimit(payload.limit ?? payload.nodeLimit ?? payload.node_limit, 200, 10000) });
  }
  return result;
}

