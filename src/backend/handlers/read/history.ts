// 读动作 handler（自 query-api.ts 按域拆出，§6-4：照 mutation-api 的 handlers/write 样板）。
// 本文件由分派表 query-api.ts 消费；跨域共享的 helper 一律住 shared.ts。
import { normalizePositiveInteger, normalizeQueryId } from './shared.js';
import { subtreeBodyText } from './content.js';
import { keywordHaystack } from './search.js';
import type { CommitSnapshotRow, Payload, RowObject, SnapshotLike } from './shared.js';
import { parseJsonObject } from '../../shared.js';
import { isStableId } from '../../db/ids.js';
import {
  pruneTreeDepth,
  snapshotAddressDepth,
  snapshotChildrenByParent,
  snapshotNodeId,
  snapshotParentId,
  snapshotReadNode,
  snapshotSubtreeRows,
  type SnapshotRow
} from '../../../core/snapshot-tree.js';
import type { IftreeStore } from '../../store/index.js';
import type { CommitRow } from '../../db/schema.js';

export function historySnapshot(store: IftreeStore, row: CommitSnapshotRow) {
  return store.commitSnapshotFromRow(row);
}

// computeDiff 的 field-diff entry 只带 node_id；补 address（库的定位语言）供展示层用。
// 删除的节点在 to 侧已不存在，故 to 优先、from 兜底；这些是实时算出的临时对象，不入库。
export function fillEntryAddresses(entries: RowObject[], toSnapshot: SnapshotLike | null, fromSnapshot: SnapshotLike | null) {
  const addressByNode = new Map();
  for (const node of toSnapshot?.nodes || []) addressByNode.set(node.id, node.address);
  for (const node of fromSnapshot?.nodes || []) if (!addressByNode.has(node.id)) addressByNode.set(node.id, node.address);
  for (const entry of entries) {
    if (entry && entry.node_id != null && entry.address == null) {
      entry.address = addressByNode.get(entry.node_id) ?? null;
    }
  }
}

export function historyEntryRow(store: IftreeStore, ref: unknown, docId: string | null = null): CommitSnapshotRow {
  const id = normalizeQueryId(ref, null);
  if (!id) throw new Error('history.diff requires commit id');
  const row = docId
    ? store.db!.prepare('SELECT * FROM commits WHERE id = ? AND doc_id = ?').get<CommitSnapshotRow>(id, docId)
    : store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitSnapshotRow>(id);
  if (!row) throw new Error(`Commit not found: ${id}`);
  return row;
}

export function historyMetaRow(row: CommitSnapshotRow) {
  const rest: RowObject = { ...(row as unknown as RowObject) };
  delete rest.diff;
  delete rest.snapshot;
  delete rest.meta;
  return rest;
}

export function queryHistoryDiff(store: IftreeStore, payload: Payload = {}) {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  const fromRef = payload.fromHistoryId ?? payload.from_history_id ?? payload.from;
  const toRef = payload.toHistoryId ?? payload.to_history_id ?? payload.to ?? payload.historyId ?? payload.history_id;
  if (!toRef) throw new Error('history.diff requires toHistoryId');
  const toRow = historyEntryRow(store, toRef, docId);
  const toSnapshot = historySnapshot(store, toRow);
  if (!fromRef) {
    // 单 ref：edit-branch 提交用存档的操作级条目（meta.entries；旧行回退 diff.entries）——它精确表达
    // 「本 commit 做了什么」、且首提交（无父）也有。无操作条目的 save/revert 提交现算「父→本」field-diff。
    const stored = parseJsonObject(toRow.meta, {}).entries ?? parseJsonObject(toRow.diff, {}).entries;
    let entries: RowObject[] = Array.isArray(stored) ? stored as RowObject[] : [];
    if (entries.length === 0 && toRow.parent_commit_id) {
      const parentRow = store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitSnapshotRow>(toRow.parent_commit_id);
      const parentSnapshot = parentRow ? historySnapshot(store, parentRow) : null;
      if (parentSnapshot?.nodes && toSnapshot?.nodes) {
        entries = store.computeDiff(parentSnapshot, toSnapshot);
        fillEntryAddresses(entries, toSnapshot, parentSnapshot);
      }
    }
    return {
      kind: 'history.diff',
      docId: toRow.doc_id,
      to: historyMetaRow(toRow),
      entries,
      snapshotAvailable: Boolean(toSnapshot)
    };
  }
  const fromRow = historyEntryRow(store, fromRef, docId ?? toRow.doc_id);
  if (!sameDocHistory(fromRow, toRow)) {
    throw new Error('history.diff entries must belong to the same document');
  }
  const fromSnapshot = historySnapshot(store, fromRow);
  if (!fromSnapshot?.nodes || !toSnapshot?.nodes) {
    throw new Error('history.diff requires restorable snapshots on both history entries');
  }
  const entries = store.computeDiff(fromSnapshot, toSnapshot);
  fillEntryAddresses(entries, toSnapshot, fromSnapshot);
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
export function resolveRefSnapshot(store: IftreeStore, ref: Payload = {}, fallbackDocId: string | null = null) {
  if (ref.head) {
    const docId = ref.docId ?? fallbackDocId;
    if (!docId) throw new Error('diff ref=head 需要 docId');
    return store.liveDocSnapshot(docId);
  }
  if (ref.historyId != null) {
    const row = historyEntryRow(store, ref.historyId, normalizeQueryId(ref.docId ?? fallbackDocId, null));
    const snap = historySnapshot(store, row);
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

export function queryRefDiff(store: IftreeStore, payload: Payload = {}) {
  const fallbackDocId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  const fromSnap = resolveRefSnapshot(store, (payload.from ?? {}) as Payload, fallbackDocId);
  const toSnap = resolveRefSnapshot(store, (payload.to ?? {}) as Payload, fallbackDocId);
  const entries = store.computeDiff(fromSnap, toSnap);
  fillEntryAddresses(entries, toSnap, fromSnap);
  return { kind: 'diff.refs', entries };
}

// —— 历史 ref 解析（自 db-shell resolveHistoryRef 下沉，--at/restore 共用）——
// commitId/historyId 精确优先；否则 ref + refKind（id / committed_at / summary /
// committed_at_or_summary，缺省按 isStableId 自动判）。唯一命中才返回；0 命中与歧义都报错，绝不静默选新。
export function resolveHistoryCommitRow(store: IftreeStore, payload: Payload = {}): CommitSnapshotRow {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  const commitId = normalizeQueryId(
    payload.commitId ?? payload.commit_id ?? payload.historyId ?? payload.history_id ?? payload.id,
    null
  );
  if (commitId) {
    const row = docId
      ? store.db!.prepare('SELECT * FROM commits WHERE id = ? AND doc_id = ?').get<CommitSnapshotRow>(commitId, docId)
      : store.db!.prepare('SELECT * FROM commits WHERE id = ?').get<CommitSnapshotRow>(commitId);
    if (!row) throw new Error(`Commit not found${docId ? ` in doc ${docId}` : ''}: ${commitId}`);
    return row;
  }
  const value = String(payload.ref ?? '').trim();
  if (!value) throw new Error('history ref requires history id, saved_at, or tag');
  const kind = String(payload.refKind ?? '').trim() || (isStableId(value) ? 'id' : 'committed_at_or_summary');
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (kind === 'id') { clauses.push('id = ?'); params.push(value); }
  else if (kind === 'committed_at') { clauses.push('committed_at = ?'); params.push(value); }
  else if (kind === 'summary') { clauses.push('summary = ?'); params.push(value); }
  else if (kind === 'committed_at_or_summary') { clauses.push('(committed_at = ? OR summary = ?)'); params.push(value, value); }
  else throw new Error(`unsupported history ref kind: ${kind}`);
  if (docId) { clauses.push('doc_id = ?'); params.push(docId); }
  const rows = store.db!
    .prepare(`SELECT * FROM commits WHERE ${clauses.join(' AND ')} ORDER BY committed_at DESC, id DESC LIMIT 2`)
    .all<CommitSnapshotRow>(...params);
  if (rows.length === 0) throw new Error(`history ref not found${docId ? ` in doc ${docId}` : ''}: ${value}`);
  if (rows.length > 1) throw new Error(`history ref is ambiguous: ${value}; pass doc_id or history id`);
  return rows[0];
}

function restorableSnapshot(store: IftreeStore, row: CommitSnapshotRow) {
  const snapshot = store.commitSnapshotFromRow(row);
  if (!snapshot?.nodes) throw new Error(`Commit is not restorable: ${row.id}`);
  return snapshot;
}

// 历史快照里定位目标节点（自 db-shell resolveHistoryTarget 下沉）。默认按稳定身份穿透：
// 当前 address → node_id → 快照里按 id 找，节点历史上换过地址也认得（git log --follow 的
// 「认人不认位置」），节点不在该版本则明确报错、绝不静默命中同址的别的节点。atAddress 退回
// git <commit>:<path> 语义按历史地址定位，供查已删节点或纯「那个版本那个位置」的查询。
function resolveSnapshotTarget(
  store: IftreeStore,
  commitRow: CommitSnapshotRow,
  rows: SnapshotRow[],
  { docId, address, atAddress }: { docId: string; address: string; atAddress: boolean }
): SnapshotRow {
  if (atAddress) {
    const target = rows.find((row) => String(row.address || '') === address) || null;
    if (!target) throw new Error(`--at-address target not found: doc ${docId} ${address} @${commitRow.id}`);
    return target;
  }
  const current = store.db!.prepare('SELECT id FROM nodes WHERE doc_id = ? AND address = ?').get<{ id: string }>(docId, address);
  if (!current) {
    throw new Error(`--at: 当前文档无地址 ${address}；查已删节点或某版本某位置请加 --at-address`);
  }
  const currentId = String(current.id);
  const target = rows.find((row) => snapshotNodeId(row) === currentId) || null;
  if (!target) {
    throw new Error(`--at: 节点 ${currentId}（当前 ${address}）在版本 ${commitRow.id} 尚未存在`);
  }
  return target;
}

// 按 commit id / ref 重建历史快照（db-shell 的 --at 等只读消费者用；走对象库展开，不再读 diff/snapshot 列）。
// 不带 address/depth 时保持原全量形状；带上则在 L4 内定位+修剪，返回树形态（tree --at 的数据面）。
export function queryHistorySnapshot(store: IftreeStore, payload: Payload = {}) {
  const row = resolveHistoryCommitRow(store, payload);
  const snapshot = restorableSnapshot(store, row);
  const address = String(payload.address ?? '').trim();
  const depth = normalizePositiveInteger(payload.depth ?? payload.levels, null);
  if (!address && depth == null) {
    return { kind: 'history.snapshot', commitId: row.id, doc_id: row.doc_id, snapshot };
  }
  const rows = (Array.isArray(snapshot.nodes) ? snapshot.nodes : []) as SnapshotRow[];
  const byParent = snapshotChildrenByParent(rows);
  const rootRows = address
    ? [resolveSnapshotTarget(store, row, rows, {
        docId: String(row.doc_id),
        address,
        atAddress: payload.atAddress === true
      })]
    : (byParent.get('') || []);
  const maxLevels = depth ?? 2;
  const subtreeRows = rootRows.flatMap((root) => snapshotSubtreeRows(root, byParent));
  const rootDepth = address ? snapshotAddressDepth(address) : 1;
  const docDepth = subtreeRows.reduce((max, r) => Math.max(max, snapshotAddressDepth(r.address)), rootDepth) - rootDepth + 1;
  const roots = rootRows.map((root) => pruneTreeDepth(snapshotReadNode(root, byParent), maxLevels));
  return {
    kind: 'history.snapshot',
    commitId: row.id,
    doc_id: row.doc_id,
    doc: (snapshot as SnapshotLike).doc ?? null,
    roots,
    docDepth,
    prunedDepth: maxLevels
  };
}

// 历史快照内字面 node-AND 检索（find --at 的数据面）；语义/跨文档不支持（向量只建在 HEAD）。
export function queryHistoryFind(store: IftreeStore, payload: Payload = {}) {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  if (!docId) throw new Error('history.find requires docId（历史快照不支持跨文档检索）');
  const terms = (Array.isArray(payload.terms) ? payload.terms : []).map((t) => String(t)).filter((t) => t.trim());
  if (terms.length === 0) throw new Error('history.find requires at least one term');
  const row = resolveHistoryCommitRow(store, payload);
  const snapshot = restorableSnapshot(store, row);
  const rows = (Array.isArray(snapshot.nodes) ? snapshot.nodes : []) as SnapshotRow[];
  const scopeAddress = String(payload.scopeAddress ?? '').trim();
  const docTitle = ((snapshot as SnapshotLike).doc as RowObject | undefined)?.title ?? null;
  // 与 HEAD 侧同口径（search.keywordHaystack）：address+title+text+note 整体小写后按词 AND。
  // 原先只搜 text、且区分大小写——同一个词在 find 命中、find --at 落空，两侧口径不该分叉。
  const lowerTerms = terms.map((term) => term.toLowerCase());
  const matched = rows.filter((r) => {
    const addr = String(r.address || '');
    if (scopeAddress && !(addr === scopeAddress || addr.startsWith(`${scopeAddress}-`))) return false;
    // 快照行 snake/camel 混排（照 snapshotNodeId 的兜底口径）：两个键都认后再交给 keywordHaystack。
    const haystack = keywordHaystack({
      address: addr,
      node_title: String(r.node_title ?? r.nodeTitle ?? ''),
      text: String(r.text ?? ''),
      node_note: String(r.node_note ?? r.nodeNote ?? '')
    });
    return lowerTerms.every((term) => haystack.includes(term));
  });
  const limit = normalizePositiveInteger(payload.limit, null);
  const limited = limit != null ? matched.slice(0, limit) : matched;
  return {
    kind: 'history.find',
    commitId: row.id,
    doc_id: row.doc_id,
    rows: limited.map((r) => ({
      node: {
        id: r.id,
        address: String(r.address || ''),
        node_type: String(r.node_type ?? r.nodeType ?? 'TEXT'),
        node_title: String(r.node_title ?? r.nodeTitle ?? ''),
        text: String(r.text || ''),
        updatedAt: (r.updated_at ?? r.updatedAt ?? null) as string | null
      },
      doc: { docId: row.doc_id, title: docTitle }
    })),
    total: matched.length,
    returned: limited.length
  };
}

// 历史快照正文读取（read --at 的数据面）：node 本节点 / subtree 叶子拼接 / siblings 同父前中后。
// 文本预算截断是 L5 渲染的事，这里返回全量结构化结果。
export function queryHistoryRead(store: IftreeStore, payload: Payload = {}) {
  const docId = normalizeQueryId(payload.docId ?? payload.doc_id, null);
  const address = String(payload.address ?? '').trim();
  if (!docId || !address) throw new Error('history.read requires docId and address');
  const range = ['node', 'subtree', 'siblings'].includes(String(payload.range)) ? String(payload.range) : 'subtree';
  const row = resolveHistoryCommitRow(store, payload);
  const snapshot = restorableSnapshot(store, row);
  const rows = (Array.isArray(snapshot.nodes) ? snapshot.nodes : []) as SnapshotRow[];
  const target = resolveSnapshotTarget(store, row, rows, {
    docId,
    address,
    atAddress: payload.atAddress === true
  });
  const byParent = snapshotChildrenByParent(rows);
  if (range === 'siblings') {
    const siblings = byParent.get(snapshotParentId(target)) || [];
    const index = siblings.findIndex((r) => snapshotNodeId(r) === snapshotNodeId(target));
    const pick = (r: SnapshotRow | null | undefined) => (r ? { address: String(r.address || ''), text: String(r.text || '') } : null);
    return {
      kind: 'history.read',
      commitId: row.id,
      range,
      previous: index > 0 ? pick(siblings[index - 1]) : null,
      target: pick(target),
      next: index >= 0 && index < siblings.length - 1 ? pick(siblings[index + 1]) : null
    };
  }
  if (range === 'node') {
    return { kind: 'history.read', commitId: row.id, range, text: String(target.text || '') };
  }
  // 与 HEAD 侧同口径（content.subtreeBodyText）：排文档根、保留有正文的容器节点。
  // 原先只留叶子，同一棵树在 read 与 read --at 读出的正文不一样（容器节点正文在历史侧被吞）。
  const text = subtreeBodyText(snapshotSubtreeRows(target, byParent));
  return { kind: 'history.read', commitId: row.id, range, text };
}

export function queryNodeHistory(store: IftreeStore, payload: Payload = {}) {
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

export function sameDocHistory(left: Pick<CommitRow, 'doc_id'>, right: Pick<CommitRow, 'doc_id'>) {
  return String(left.doc_id) === String(right.doc_id);
}

