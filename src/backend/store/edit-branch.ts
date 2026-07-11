// 编辑分支子系统（A5-5 / A5-10 / 15-5-2）：影子文档投影 + 暂存动作（22 个 stage）+ 重放落库 +
// 三方合并与人工裁决 + 乐观并发前置校验 + 撤销/重做/拣选/变基。纯函数模块，门面 IftreeStore
// 实例作首参——store.db 与底座的主 CRUD / 快照提交原语经它访问，模块不反向 import 门面。
// index.mjs 上每个方法保留一行同名转调壳；编辑分支方法之间也经门面句柄互调（store.xxx），
// 与历史/记忆子系统同构（参数化 store、对外门面壳）。

import { normalizeNodeType } from '../../core/node-model.js';
import { classifyThreeWayMerge } from '../../core/merkle-merge.js';
import { computeSubtreeHashes, contentHash, type MerkleNode } from '../../core/merkle.js';
import { parseJsonObject, hasOwnValue, assertNoHumanTagField, assertNoEditTrustField } from '../shared.js';
import { sameStableId } from '../db/ids.js';
import { normalizePositiveId, normalizeSourcePosition, patchValue } from '../db/normalizers.js';
import type {
  EditBranchEntry,
  ProjectedDoc,
  ProjectionNode
} from './edit-branch-contract.js';
import { isBuiltInEditBranchEntry } from './edit-branch-contract.js';
import type Database from 'better-sqlite3';
import type { EditBranchProjectionPort, ExternalEntryPort } from './domain-port.js';
import * as history from './history.js';
import * as axiomRef from './axiom-ref.js';
import { applyEditBranchDiffEntries } from './edit-branch-replay.js';
export { applyEditBranchDiffEntries } from './edit-branch-replay.js';
import type {
  AxiomRow,
  CommitRow,
  EditBranchRow,
  NodeRow,
  RefRow
} from '../db/schema.js';

type RowObject = Record<string, unknown>;
type EditBranchPayload = RowObject;
type BranchLookupPayload = {
  branchId?: unknown;
  shadowDocId?: unknown;
  baseDocId?: unknown;
  owner?: unknown;
};
type EditBranchDiff = RowObject & {
  entries?: EditBranchEntry[];
};
// ProjectedNode/ProjectedDocState 已下沉到 edit-branch-projection.ts，
// 与 ProjectionNode/ProjectedDoc 是同一套类型；此处只为本文件历史名引一下别名，
// 让大量旧 `as ProjectedNode` cast 不需要一次性 sed。新代码请直接用公共名。
type ProjectedNode = ProjectionNode;
type ProjectedDocState = ProjectedDoc;
type EditBranchBranchRow = EditBranchRow & {
  base_title?: string | null;
  shadow_title?: string | null;
  node_count?: number;
};
type BaseSnapshotInput = {
  owner: unknown;
  baseDocId: unknown;
  shadowDocId: unknown;
  baseCommitId?: unknown;
};
type EmptyDiffInput = Pick<BaseSnapshotInput, 'owner' | 'baseDocId' | 'shadowDocId'>;
type CountRow = { count: number };
type IdRow = { id: string };
type DocIdRow = { doc_id: string };
type HeadRow = { head_commit_id: string | null };
type BaseDocInputs = { docId: string; nodes: ProjectedNode[]; axioms: AxiomRow[]; refs: RefRow[] };
type BranchCommitResult = RowObject & {
  changed: boolean;
  baseDocId: string;
  branchId: number;
  owner: string;
  touchedNodeIds: unknown[];
  deletedNodeIds: unknown[];
  vectorStaleNodeIds: unknown[];
};
type CherryPickSource = {
  kind: string;
  id: unknown;
  docId: unknown;
  entries: EditBranchEntry[];
};
type CherryPickPayload = EditBranchPayload & {
  sourceHistoryId?: unknown;
  sourceBranchId?: unknown;
  targetBranchId?: unknown;
  targetBaseDocId?: unknown;
  targetOwner?: unknown;
  entryId?: unknown;
  entryIndex?: unknown;
};
type NodeSignature = { keyword: string; text: string };
type CommitHistoryRow = { id: string; doc_id: string; commit_id: string; saved_at: string; summary: string | null };

export interface EditBranchStore extends history.HistoryStore {
  db: Database | null;
  addAxiom(payload: RowObject): unknown;
  addAxiomRefToNode(payload: RowObject): unknown;
  addNodeRefToNode(payload: RowObject): unknown;
  deleteAxiom(axiomId: unknown): boolean;
  deleteNodeSubtree(nodeId: unknown): boolean;
  deleteRef(refId: unknown): boolean;
  insertNode(payload: RowObject): NodeRow;
  listAxioms(docId: unknown): AxiomRow[];
  mergeNodeIntoPreviousSibling(nodeId: unknown): boolean;
  mergeNodeIntoTarget(payload: RowObject): boolean;
  moveAxiom(payload: RowObject): boolean;
  moveNode(nodeId: unknown, direction: unknown): boolean;
  moveNodeAfterSibling(payload: RowObject): boolean;
  moveNodeBeforeSibling(payload: RowObject): boolean;
  moveNodeToParent(payload: RowObject): boolean;
  promoteNode(nodeId: unknown): boolean;
  requireEditBranchPort(): EditBranchProjectionPort;
  requireExternalEntryPort(): ExternalEntryPort;
  splitNodeIntoChildren(nodeId: unknown): unknown;
  updateAxiom(axiomId: unknown, patch: RowObject): unknown;
  updateNode(nodeId: unknown, patch: RowObject): unknown;
  touchDoc(docId: unknown): void;
  withTransaction<T>(fn: () => T): T;
}

function activeEntries(store: EditBranchStore, entries: unknown): EditBranchEntry[] {
  return store.requireEditBranchPort().activeEditBranchEntries(entries);
}

function undoneEntries(store: EditBranchStore, entries: unknown): EditBranchEntry[] {
  return store.requireEditBranchPort().undoneEditBranchEntries(entries);
}

function createLazyEditBranchBaseSnapshot({ owner, baseDocId, shadowDocId, baseCommitId = null }: BaseSnapshotInput) {
  return {
    kind: 'edit_branch_base',
    storage: 'lazy_diff',
    owner,
    baseDocId,
    shadowDocId,
    baseCommitId,
    createdAt: new Date().toISOString()
  };
}

function createEmptyEditBranchDiff({ owner, baseDocId, shadowDocId }: EmptyDiffInput) {
  return {
    kind: 'edit_branch_diff',
    storage: 'entries_table',
    owner,
    baseDocId,
    shadowDocId,
    entries: []
  };
}

// ─── entries 子表存取（storage: entries_table）──────────────────────────────
// 存储真相在 edit_branch_entries（一行一条，schema 有账）；diff 列退役为元壳。
// 行离开 SQL 的出口统一经 _withBranchEntries 把子表条目装回 diff JSON——内部所有
// JSON.parse(branch.diff) 消费点、handler 返回、前端 undo 栈的契约全部原样工作。
// 收益在写侧：stage=INSERT 一行、undo/redo=翻转单行 status，不再整包重写（原先
// K 步编辑 O(K²) 写放大的根源）。

type BranchEntrySqlRow = { id: number; seq: number; status: string; created_at: string | null; undone_at: string | null; entry: string };

function branchEntrySqlRows(store: EditBranchStore, branchId: unknown): BranchEntrySqlRow[] {
  return store.db!.prepare(`
    SELECT id, seq, status, created_at, undone_at, entry
    FROM edit_branch_entries WHERE branch_id = ? ORDER BY seq
  `).all<BranchEntrySqlRow>(Number(branchId));
}

function entryRowToEntry(row: BranchEntrySqlRow): EditBranchEntry {
  const payload = JSON.parse(row.entry || '{}') as EditBranchEntry;
  const entry = { ...payload, status: row.status } as EditBranchEntry;
  if (row.created_at) entry.createdAt = row.created_at;
  if (row.undone_at) entry.undoneAt = row.undone_at;
  return entry;
}

// status/createdAt/undoneAt 提为列（排序/翻转靠它们），负载 JSON 里不留冗余副本。
function entryToRowFields(entry: EditBranchEntry) {
  const { status, createdAt, undoneAt, ...payload } = entry as unknown as Record<string, unknown>;
  return {
    status: status === 'undone' ? 'undone' : 'active',
    created_at: createdAt ? String(createdAt) : null,
    undone_at: undoneAt ? String(undoneAt) : null,
    payload: JSON.stringify(payload)
  };
}

export function _withBranchEntries<T extends EditBranchRow>(store: EditBranchStore, row: T | null): T | null {
  if (!row) return row;
  let meta: Record<string, unknown> = {};
  try { meta = (JSON.parse(row.diff || '{}') as Record<string, unknown>) || {}; } catch { meta = {}; }
  let entryRows: BranchEntrySqlRow[] = [];
  try {
    entryRows = branchEntrySqlRows(store, row.id);
  } catch {
    return row; // 子表还不存在（readonly 打开未升级旧库）：按旧形态原样返回
  }
  const entries = entryRows.map(entryRowToEntry);
  // 未迁移旧行兜底（readonly 连接打开旧库、写侧迁移还没跑）：diff 里还躺着 entries
  // 且子表为空 → 原样返回，消费方按旧形态工作。
  if (entries.length === 0 && Array.isArray(meta.entries) && meta.entries.length > 0) return row;
  return {
    ...row,
    diff: JSON.stringify({ ...meta, storage: 'entries_table', updatedAt: row.updated_at, entries })
  };
}

function _branchRowById(store: EditBranchStore, branchId: unknown): EditBranchRow {
  const row = store.db!.prepare('SELECT * FROM edit_branches WHERE id = ?').get<EditBranchRow>(Number(branchId));
  return _withBranchEntries(store, row as EditBranchRow) as EditBranchRow;
}

/** @param {EditBranchEntry} entry edit-branch diff entry（kind/patch/fields 形态随动作而异） */
function editBranchEntryTouchesTrust(entry: EditBranchEntry) {
  if (!isBuiltInEditBranchEntry(entry)) return false;
  if (entry.kind === 'node.update') {
    if (hasOwnValue(entry.patch, 'trust_level', 'trustLevel', 'trust')) return true;
    return Array.isArray(entry.fields) && entry.fields.some((field) => (
      ['trust_level', 'trustLevel', 'trust'].includes(String(field.field || ''))
    ));
  }
  if (entry.kind === 'node.insert') {
    const fields = entry.fields;
    if (!hasOwnValue(fields, 'trust_level', 'trustLevel', 'trust')) return false;
    const value = fields.trust_level ?? fields.trustLevel ?? fields.trust;
    return value !== null && value !== undefined && value !== '';
  }
  return false;
}

export function normalizeEditBranchOwner(store: EditBranchStore, owner: unknown = 'human') {
    const value = String(owner || '').trim();
    return value || 'human';
  }

function hasEditBranchesTable(store: EditBranchStore) {
  try {
    return Boolean(store.db!.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edit_branches'").get());
  } catch {
    return false;
  }
}

// owner 编码（A5-5 多分支 / 18-3 身份）：存储形态 role:user#ts —— role∈{llm,human} 保信任语义、
// user 是写入身份（MCP 读 IFTREE_OWNER 注入、db shell 经 --owner 传），role:user 合为身份前缀；
// #ts 是新建时间戳后缀让每草稿 owner 唯一。ts 用 # 隔开，身份前缀内部可含 :（role:user），互不歧义。
// 配置/传入层用 role:user 身份前缀（不带 #ts）；定位草稿按身份前缀匹配，新建时补 #ts。
export function ownerRole(owner: unknown) {
  const identity = String(owner || '').trim().split('#', 1)[0];
  const role = identity.split(':', 1)[0];
  return role === 'human' ? 'human' : 'llm';
}

export function ownerIdentity(owner: unknown) {
  const value = String(owner || '').trim();
  if (!value) return 'human';
  return value.split('#', 1)[0];
}

// 草稿创建时间戳后缀：本地时区、标准年月日时分秒（YYYY-MM-DDTHH:mm:ss），可读且让每草稿 owner 唯一。
// 用 T 连接避免空格（owner 含空格会破坏 db list 字段解析）；时间部分的 : 在 # 之后，不影响身份前缀解析。
function ownerStamp() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function activeEditBranchForBaseDoc(store: EditBranchStore, docId: unknown, owner: unknown = 'human') {
    if (!hasEditBranchesTable(store)) return null;
    const identity = normalizeEditBranchOwner(store, owner);
    // 按身份前缀匹配：owner=identity 兼容旧的无 ts 值，owner LIKE 'identity#%' 命中带 ts 的新草稿；取最新一条。
    return _withBranchEntries(store, store.db!.prepare(`
      SELECT * FROM edit_branches
      WHERE base_doc_id = ? AND status = 'active'
        AND (owner = ? OR owner LIKE ?)
      ORDER BY id DESC
      LIMIT 1
    `).get<EditBranchRow>(normalizePositiveId(docId), identity, identity + '#%') || null);
  }

export function activeEditBranchForShadowDoc(store: EditBranchStore, docId: unknown) {
    if (!hasEditBranchesTable(store)) return null;
    return _withBranchEntries(store, store.db!.prepare(`
      SELECT * FROM edit_branches
      WHERE shadow_doc_id = ? AND status = 'active'
      ORDER BY id DESC
      LIMIT 1
    `).get<EditBranchRow>(normalizePositiveId(docId)) || null);
  }

export function activeEditBranchForDoc(store: EditBranchStore, docId: unknown, owner: unknown = null) {
    const shadow = activeEditBranchForShadowDoc(store, docId) as EditBranchRow | null;
    if (shadow) {
      if (!owner || ownerIdentity(shadow.owner) === ownerIdentity(normalizeEditBranchOwner(store, owner))) return shadow;
      return activeEditBranchForBaseDoc(store, shadow.base_doc_id, owner);
    }
    if (!owner) return null;
    return activeEditBranchForBaseDoc(store, docId, owner);
  }

export function listActiveEditBranches(store: EditBranchStore, owner: unknown = null) {
    if (!hasEditBranchesTable(store)) return [];
    const normalizedOwner = owner ? normalizeEditBranchOwner(store, owner) : null;
    const where = normalizedOwner ? 'WHERE eb.status = \'active\' AND (eb.owner = ? OR eb.owner LIKE ?)' : 'WHERE eb.status = \'active\'';
    const params: unknown[] = normalizedOwner ? [normalizedOwner, normalizedOwner + '#%'] : [];
    return store.db!.prepare(`
      SELECT eb.*,
        base.title AS base_title,
        shadow.title AS shadow_title,
        (SELECT COUNT(*) FROM nodes n WHERE n.doc_id = eb.base_doc_id) AS node_count
      FROM edit_branches eb
      LEFT JOIN docs base ON base.id = eb.base_doc_id
      LEFT JOIN docs shadow ON shadow.id = eb.shadow_doc_id
      ${where}
      ORDER BY eb.updated_at DESC, eb.id DESC
    `).all<EditBranchBranchRow>(...params).map((row) => _withBranchEntries(store, row) as EditBranchBranchRow);
  }

export function docIdForMutationPayload(store: EditBranchStore, payload: EditBranchPayload = {}) {
    const direct = normalizePositiveId(payload.docId ?? payload.doc_id ?? payload.baseDocId ?? payload.base_doc_id);
    if (direct !== null) return direct;
    const nodeId = normalizePositiveId(
      payload.nodeId
        ?? payload.node_id
        ?? payload.parentId
        ?? payload.parent_id
        ?? payload.sourceNodeId
        ?? payload.source_node_id
        ?? payload.targetNodeId
        ?? payload.target_node_id
    );
    if (nodeId !== null) {
      const node = store.db!.prepare('SELECT doc_id FROM nodes WHERE id = ?').get<DocIdRow>(nodeId);
      if (node) return node.doc_id;
    }
    const axiomId = normalizePositiveId(payload.axiomId ?? payload.axiom_id);
    if (axiomId !== null) {
      const axiom = store.db!.prepare('SELECT doc_id FROM axioms WHERE id = ?').get<DocIdRow>(axiomId);
      if (axiom) return axiom.doc_id;
    }
    const externalDocId = normalizePositiveId(store.requireExternalEntryPort().resolveExternalEntryDocId(store, payload));
    if (externalDocId) return externalDocId;
    const refId = normalizePositiveId(payload.refId ?? payload.ref_id);
    if (refId !== null) {
      const ref = store.db!.prepare('SELECT * FROM refs WHERE id = ?').get<RefRow>(refId);
      if (ref?.source_type === 'node') {
        const node = store.db!.prepare('SELECT doc_id FROM nodes WHERE id = ?').get<DocIdRow>(ref.source_id);
        if (node) return node.doc_id;
      }
      if (ref?.target_type === 'node') {
        const node = store.db!.prepare('SELECT doc_id FROM nodes WHERE id = ?').get<DocIdRow>(ref.target_id);
        if (node) return node.doc_id;
      }
      if (ref?.source_type === 'axiom') {
        const axiom = store.db!.prepare('SELECT doc_id FROM axioms WHERE id = ?').get<DocIdRow>(ref.source_id);
        if (axiom) return axiom.doc_id;
      }
      if (ref?.target_type === 'axiom') {
        const axiom = store.db!.prepare('SELECT doc_id FROM axioms WHERE id = ?').get<DocIdRow>(ref.target_id);
        if (axiom) return axiom.doc_id;
      }
    }
    return null;
  }

export function nodePatchForEditBranch(store: EditBranchStore, current: NodeRow | RowObject, patch: EditBranchPayload = {}) {
    assertNoHumanTagField(patch, 'node.update patch');
    assertNoEditTrustField(patch, 'node.update patch');
    const next: RowObject = {};
    if (hasOwnValue(patch, 'text')) next.text = patch.text ?? '';
    if (hasOwnValue(patch, 'node_title', 'nodeTitle')) next.node_title = patch.node_title ?? patch.nodeTitle ?? '';
    if (hasOwnValue(patch, 'node_note', 'nodeNote')) next.node_note = patch.node_note ?? patch.nodeNote ?? '';
    if (hasOwnValue(patch, 'source_position', 'sourcePosition')) {
      next.source_position = normalizeSourcePosition(
        patchValue(patch, 'source_position', 'sourcePosition', current.source_position)
      );
    }
    if (hasOwnValue(patch, 'node_type', 'nodeType')) {
      next.node_type = normalizeNodeType(patchValue(patch, 'node_type', 'nodeType', current.node_type));
    }
    return next;
  }

export function _appendEditBranchEntry(store: EditBranchStore, branch: EditBranchRow, entry: EditBranchEntry): EditBranchRow {
    if (!store.requireEditBranchPort().isSupportedEditBranchEntryKind(entry?.kind)) {
      throw new Error(`Unsupported edit branch entry kind: ${entry?.kind || ''}`);
    }
    // append 即销毁 redo 分支（与旧行为一致：原实现按 activeEntries 过滤后重建）。
    store.db!.prepare("DELETE FROM edit_branch_entries WHERE branch_id = ? AND status = 'undone'").run(branch.id);
    const fields = entryToRowFields({ ...entry, status: 'active', createdAt: entry.createdAt || new Date().toISOString() } as EditBranchEntry);
    store.db!.prepare(`
      INSERT INTO edit_branch_entries (branch_id, seq, status, created_at, undone_at, entry)
      VALUES (?, COALESCE((SELECT MAX(seq) FROM edit_branch_entries WHERE branch_id = ?), 0) + 1, ?, ?, ?, ?)
    `).run(branch.id, branch.id, fields.status, fields.created_at, fields.undone_at, fields.payload);
    store.db!.prepare('UPDATE edit_branches SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(branch.id);
    return _branchRowById(store, branch.id);
  }

export function editBranchHistoryState(store: EditBranchStore, branch: EditBranchRow) {
    const counts = store.db!.prepare(`
      SELECT status, COUNT(*) AS n FROM edit_branch_entries WHERE branch_id = ? GROUP BY status
    `).all<{ status: string; n: number }>(branch?.id);
    let active = 0;
    let undone = 0;
    for (const row of counts) {
      if (row.status === 'undone') undone += Number(row.n) || 0;
      else active += Number(row.n) || 0;
    }
    if (active + undone === 0) {
      // 未迁移旧行兜底：子表空但 diff 列还躺着 entries（readonly 打开旧库）→ 按旧 JSON 计。
      const diff = JSON.parse(branch?.diff || '{}') as EditBranchDiff;
      const entries = Array.isArray(diff.entries) ? diff.entries : [];
      active = activeEntries(store, entries).length;
      undone = undoneEntries(store, entries).length;
    }
    return {
      undoDepth: active,
      redoDepth: undone,
      hasUndo: active > 0,
      hasRedo: undone > 0
    };
  }

export function computeThreeWayMerge(store: EditBranchStore, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' }: EditBranchPayload = {}) {
    const branch = findEditBranch(store, { branchId, shadowDocId, baseDocId, owner } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) throw new Error('Edit branch not found');
    const docId = branch.base_doc_id;
    const baseSnapshot = parseJsonObject(branch.base_snapshot) || {};
    const baseCommitId = baseSnapshot.baseCommitId || null;
    const head = store.db!.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get<HeadRow>(docId);
    const headCommitId = head?.head_commit_id || null;
    const fastForward = (baseCommitId || null) === (headCommitId || null);

    // ours = 当前主干 = live nodes
    const oursNodes = store.db!.prepare(`
      SELECT * FROM nodes WHERE doc_id = ?
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
    `).all<NodeRow>(docId);

    // merge-base = 分支 fork 点 commit 的 snapshot；缺 fork commit 时退化为 ours（等价快进）
    let mergeBaseNodes: ProjectedNode[] = oursNodes as ProjectedNode[];
    let mergeBaseAxioms = store.listAxioms(docId) as AxiomRow[];
    let mergeBaseRefs = _fetchBaseRefsForDoc(store, docId) as RefRow[];
    if (baseCommitId) {
      const snap = history.commitSnapshot(store, baseCommitId);
      if (snap && Array.isArray(snap.nodes)) {
            mergeBaseNodes = snap.nodes as ProjectedNode[];
            mergeBaseAxioms = Array.isArray(snap.axioms) ? snap.axioms as AxiomRow[] : [];
            mergeBaseRefs = Array.isArray(snap.refs) ? snap.refs as RefRow[] : [];
      }
    }

    // theirs = 本分支：entries 投影到 merge-base（不是投影到 live，避免与主干变更混淆）
    const diff = parseJsonObject(branch.diff) || {};
    const entries = activeEntries(store, diff.entries);
    const theirs = store.requireEditBranchPort().projectEditBranchDoc({
      docId,
      nodes: mergeBaseNodes,
      axioms: mergeBaseAxioms,
      refs: mergeBaseRefs
    }, entries);

    // classifyThreeWayMerge 期待 MerkleNode（含 [key: string]: unknown 弱接口，便于按字段名动态读）；
    // ProjectionNode 是精确 NodeRow & 草稿增量，运行时满足但 TS 看不出来——这里是子系统边界 cast。
    const merge = classifyThreeWayMerge(
      mergeBaseNodes as unknown as MerkleNode[],
      oursNodes as unknown as MerkleNode[],
      theirs.nodes as unknown as MerkleNode[]
    );
    // 给逐节点结果附上 address/title 供冲突解决 UI 标识节点（ours=live 优先，其次 theirs，再 base）。
    const displayById = new Map<string, { address: string; title: string }>();
    for (const list of [mergeBaseNodes, theirs.nodes, oursNodes]) {
      for (const node of list) {
        displayById.set(String(node.id), {
          address: node.address || '',
          title: node.node_title || ''
        });
      }
    }
    const nodes = merge.nodes.map((node) => ({
      ...node,
      address: displayById.get(String(node.id))?.address || '',
      title: displayById.get(String(node.id))?.title || ''
    }));
    return {
      kind: 'editBranch.threeWayMerge',
      branch: { ...branch },
      fastForward,
      baseCommitId,
      headCommitId,
      nodeCounts: { base: mergeBaseNodes.length, ours: oursNodes.length, theirs: theirs.nodes.length },
      ...merge,
      nodes
    };
  }

  // ─── 非快进保存的逐条前置验证（乐观并发，A5-10）──────────────
  // 账目在 stage 时记了「对什么状态做」：update 的 {field, old, new}、delete 的子树指纹、
  // split/merge 的正文指纹、移动类的 before_parent_id。保存时按 UUID 主键点查主干现值逐条比：
  //   现值==原值 → 前置成立；现值==新值 → 两侧收敛；否则冲突。
  // 成本 O(分支改动数) 次点查，不扫库、不解析快照（仅旧账目缺 before 时退化用 fork 快照补原值）。
  // 输出两类：conflicts（字段级/删改级，可经三列面板人裁）与 blocked（结构性失配，
  // v1 不可裁——主干已被修改，只能放弃本次编辑；清理敏感信息等历史重写后属常态）。

export function _trunkNodeRow(store: EditBranchStore, docId: unknown, ref: unknown) {
    if (ref === null || ref === undefined || store.requireEditBranchPort().isTmpId(ref)) return null;
    return store.db!.prepare('SELECT * FROM nodes WHERE id = ? AND doc_id = ?').get<NodeRow>(ref, docId) || null;
  }

export function _trunkSubtreeHash(store: EditBranchStore, docId: unknown, ref: unknown) {
    if (!_trunkNodeRow(store, docId, ref)) return null;
    const rows = store.db!.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM nodes WHERE id = ?
        UNION ALL
        SELECT n.id FROM nodes n JOIN subtree s ON n.parent_id = s.id
      )
      SELECT n.id, n.parent_id, n.sort_order, n.text, n.node_title, n.node_note, n.node_type, n.trust_level
      FROM nodes n JOIN subtree s ON n.id = s.id
    `).all<NodeRow>(ref);
    // 子树根的父在集合外：置空让它成为遍历根（subtree_hash 本就 parent-independent）。
    const detached = rows.map((row) => (sameStableId(row.id, ref) ? { ...row, parent_id: null } : row));
    return computeSubtreeHashes(detached as unknown as MerkleNode[]).get(String(ref))?.subtreeHash || null;
  }

export function _validateEditBranchEntriesAgainstTrunk(store: EditBranchStore, branch: EditBranchRow, entries: EditBranchEntry[]) {
    const docId = branch.base_doc_id;
    const norm = (value: unknown) => (value === null || value === undefined ? null : String(value));

    // 分支自建的 tmp 节点：重放时一并创建，引用它们无需主干前置。
    const tmpCreated = new Set<unknown>();
    for (const entry of entries) {
      if (entry.kind === 'node.insert' && entry.tmp_id) tmpCreated.add(entry.tmp_id);
      if (entry.kind === 'node.split') {
        for (const tmpId of (entry.new_node_ids as unknown[] | undefined) || []) tmpCreated.add(tmpId);
        for (const split of (entry.paragraph_splits as RowObject[] | undefined) || []) {
          for (const span of (split.spans as RowObject[] | undefined) || []) if (span.tmp_id) tmpCreated.add(span.tmp_id);
        }
      }
    }
    const refExists = (ref: unknown) => {
      if (ref === null || ref === undefined) return false;
      if (store.requireEditBranchPort().isTmpId(ref)) return tmpCreated.has(ref);
      return Boolean(_trunkNodeRow(store, docId, ref));
    };

    // 旧账目缺 before 数据时退化用 fork 快照补原值（懒解析一次；快照缺失则视为无前置=旧盲存行为）。
    let forkNodes: Map<string, ProjectedNode> | null | undefined;
    const forkNode = (ref: unknown) => {
      if (forkNodes === undefined) {
        forkNodes = null;
        const baseCommitId = (parseJsonObject(branch.base_snapshot) || {}).baseCommitId || null;
        if (baseCommitId) {
          const snap = history.commitSnapshot(store, baseCommitId);
          if (snap && Array.isArray(snap.nodes)) {
            forkNodes = new Map((snap.nodes as ProjectedNode[]).map((node) => [String(node.id), node]));
          }
        }
      }
      return forkNodes ? forkNodes.get(String(ref)) || null : null;
    };
    const forkSubtreeHash = (ref: unknown) => {
      if (!forkNode(ref)) return null;
      const activeForkNodes = forkNodes;
      if (!activeForkNodes) return null;
      const detached = [...activeForkNodes.values()].map((node) => (
        sameStableId(node.id, ref) ? { ...node, parent_id: null } : node
      ));
      // computeSubtreeHashes 用 MerkleNode 弱接口（同上 classifyThreeWayMerge 注释）。
      return computeSubtreeHashes(detached as unknown as MerkleNode[]).get(String(ref))?.subtreeHash || null;
    };

    const blocked: RowObject[] = [];
    const conflicts: RowObject[] = [];
    const fieldAgg = new Map<string, { id: string | null; field: string; old: unknown; next: unknown }>();
    const block = (id: unknown, kind: string, reason: string, address = '') => blocked.push({ id: norm(id), kind, reason, address });
    // 拆分/并入的内容前置：节点须仍在主干且正文未漂移（拼接/截句都基于入账时所见内容）。
    const checkContentIntact = (ref: unknown, beforeHash: unknown, address = '') => {
      if (ref === null || ref === undefined || store.requireEditBranchPort().isTmpId(ref)) return;
      const row = _trunkNodeRow(store, docId, ref);
      if (!row) {
        block(ref, 'node-deleted', '主干已删除该节点，分支的拆分/并入无法应用', address);
        return;
      }
      const fork = forkNode(ref);
      const before = beforeHash || (fork ? contentHash(fork as unknown as MerkleNode) : null);
      if (before && contentHash(row as unknown as MerkleNode) !== before) {
        block(ref, 'content-drift', '主干已修改该节点的内容，分支基于旧内容的拆分/并入无法应用', row.address || address);
      }
    };

    for (const entry of entries) {
      switch (entry.kind) {
        case 'node.update': {
          const ref = entry.node_id ?? entry.target_ref;
          if (store.requireEditBranchPort().isTmpId(ref)) break; // 改自己新建的节点，无主干前置
          const row = _trunkNodeRow(store, docId, ref);
          if (!row) {
            block(ref, 'node-deleted', '主干已删除该节点，分支对它的修改无法应用（复活不支持）', String(entry.address || ''));
            break;
          }
          const fieldList = Array.isArray(entry.fields) && entry.fields.length > 0
            ? entry.fields
            : Object.entries(entry.patch || {}).map(([field, value]) => ({ field, new: value ?? null }));
          for (const item of fieldList) {
            const fieldEntry = item as RowObject & { field?: string; new?: unknown; old?: unknown };
            if (!fieldEntry || !fieldEntry.field) continue;
            const key = `${norm(ref)}::${fieldEntry.field}`;
            if (!fieldAgg.has(key)) {
              // 链式多次改同字段：取最早一条的 old（=入账时所见原值），最后一条的 new（=分支终值）。
              const fork = forkNode(ref);
              const old = Object.prototype.hasOwnProperty.call(fieldEntry, 'old')
                ? fieldEntry.old
                : (fork ? (fork as unknown as Record<string, unknown>)[fieldEntry.field] : undefined);
              fieldAgg.set(key, { id: norm(ref), field: fieldEntry.field, old, next: fieldEntry.new });
            } else {
              fieldAgg.get(key)!.next = fieldEntry.new;
            }
          }
          break;
        }
        case 'node.insert': {
          if (!refExists(entry.parent_ref)) {
            block(entry.parent_ref, 'parent-deleted', '主干已删除目标父节点，分支在其下的新增无法挂载');
          }
          break; // after_ref 只定位置，缺了重放容错为追加，不算冲突
        }
        case 'node.delete': {
          const ref = entry.target_ref ?? entry.node_id;
          if (store.requireEditBranchPort().isTmpId(ref)) break;
          if (!_trunkNodeRow(store, docId, ref)) break; // 主干也删了 → 收敛
          const before = entry.before_subtree_hash || forkSubtreeHash(ref) || null;
          if (before && _trunkSubtreeHash(store, docId, ref) !== before) {
            // 分支删 / 主干改 → 删改冲突，可人裁：取主干=撤回删除，取本分支=照删。
            conflicts.push({ id: norm(ref), field: '__node__', base: 'present', ours: 'modified', theirs: 'deleted' });
          }
          break;
        }
        case 'node.move':
          break; // 同父排序，位置不进冲突；节点已删由重放容错跳过
        case 'node.promote':
        case 'node.reparent':
        case 'node.moveBefore':
        case 'node.moveAfter': {
          const ref = entry.node_ref ?? entry.target_ref ?? entry.node_id;
          if (store.requireEditBranchPort().isTmpId(ref)) break;
          const row = _trunkNodeRow(store, docId, ref);
          if (!row) {
            // 显式重挂/提升的对象已被主干删除 → 复活不支持；纯排序（moveBefore/After）位置意图失效，跳过即可。
            if (entry.kind === 'node.reparent' || entry.kind === 'node.promote') {
              block(ref, 'node-deleted', '主干已删除该节点，分支对它的移动无法应用');
            }
            break;
          }
          const fork = forkNode(ref);
          const beforeParent = Object.prototype.hasOwnProperty.call(entry, 'before_parent_id')
            ? entry.before_parent_id
            : (fork ? fork.parent_id : undefined);
          if (beforeParent !== undefined) {
            const currentParent = norm(row.parent_id);
            const intended = entry.kind === 'node.reparent' ? norm(entry.new_parent_ref) : undefined;
            if (currentParent !== norm(beforeParent) && currentParent !== intended) {
              block(ref, 'parent-conflict', '主干已移动该节点，与分支的移动冲突', row.address || '');
              break;
            }
          }
          if (entry.kind === 'node.reparent' && !refExists(entry.new_parent_ref)) {
            block(entry.new_parent_ref, 'parent-deleted', '主干已删除目标父节点，分支的移动无法挂载');
          }
          break; // moveBefore/After 的锚点缺失只影响位置，重放容错跳过
        }
        case 'node.split': {
          if (entry.strategy === 'source_paragraphs' && Array.isArray(entry.paragraph_splits)) {
            for (const split of entry.paragraph_splits) {
              checkContentIntact(split.paragraph_node_id, split.before_content_hash || null);
            }
          } else {
            checkContentIntact(entry.target_ref ?? entry.node_id, entry.before_content_hash || null, String(entry.address || ''));
          }
          break;
        }
        case 'node.mergeInto':
        case 'node.mergePrevious': {
          checkContentIntact(entry.source_ref ?? entry.node_id, entry.source_before_content_hash || null);
          if (entry.target_ref !== null && entry.target_ref !== undefined) {
            checkContentIntact(entry.target_ref, entry.target_before_content_hash || null);
          }
          break;
        }
        default:
          break; // axiom/ref/entity：v1 不做主干前置（与既有行为一致），照常重放
      }
    }

    // 字段三态：现值==分支终值 → 收敛；现值==原值 → 主干没动；否则冲突（原值不可知时保守按冲突，base 置空）。
    for (const item of fieldAgg.values()) {
      const row = _trunkNodeRow(store, docId, item.id);
      if (!row) continue; // 已在 update 处 block
      const current = norm((row as unknown as RowObject)[item.field]);
      const next = norm(item.next);
      if (current === next) continue;
      if (item.old !== undefined && current === norm(item.old)) continue;
      conflicts.push({
        id: item.id,
        field: item.field,
        base: item.old === undefined ? null : norm(item.old),
        ours: current,
        theirs: next
      });
    }

    // 面板数据：按节点聚合冲突，附 address/title 标识。
    const nodes: RowObject[] = [];
    const byNode = new Map<unknown, RowObject & { conflicts: RowObject[] }>();
    for (const conflict of conflicts) {
      if (!byNode.has(conflict.id)) {
        const row = _trunkNodeRow(store, docId, conflict.id);
        const node = {
          id: conflict.id,
          resolution: 'conflict',
          address: row?.address || '',
          title: row?.node_title || '',
          conflicts: []
        };
        byNode.set(conflict.id, node);
        nodes.push(node);
      }
      byNode.get(conflict.id)!.conflicts.push(conflict);
    }
    return { conflicts, nodes, blocked };
  }

  // 保存闸门（A5-10）：快进直接重放（lazy diff 本职，前置必然成立）；非快进走逐条前置验证：
  //   - blocked（结构性失配）→ 拒绝写回：「主干已被修改，无法保存，请放弃本次编辑」；
  //     前端取消可保留分支（自行留存 diff 后再放弃），确认则丢弃分支退出。
  //   - conflicts（字段级/删改级）→ 无人裁拒绝并返回冲突；带 resolutions 折进账目后提交。
  //   - 干净/收敛 → 直接重放写回。
export function applyThreeWayMerge(store: EditBranchStore, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human', summary = '三方合并', resolutions = null, strategy = null }: EditBranchPayload = {}) {
    const branch = findEditBranch(store, { branchId, shadowDocId, baseDocId, owner } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) throw new Error('Edit branch not found');
    const docId = branch.base_doc_id;
    const baseCommitId = (parseJsonObject(branch.base_snapshot) || {}).baseCommitId || null;
    const head = store.db!.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get<HeadRow>(docId);
    const headCommitId = head?.head_commit_id || null;
    const fastForward = (baseCommitId || null) === (headCommitId || null);
    const rawPayload = (parseJsonObject(branch.diff) || {}) as EditBranchDiff;
    const entries = activeEntries(store, rawPayload.entries);
    const meta = {
      kind: 'editBranch.threeWayMerge.apply',
      baseDocId: docId,
      fastForward,
      baseCommitId,
      headCommitId
    };

    if (fastForward || entries.length === 0) {
      return { ...meta, applied: true, ..._commitEditBranchPayload(store, branch, rawPayload, String(summary)) };
    }

    const validation = _validateEditBranchEntriesAgainstTrunk(store, branch, entries) as { blocked: RowObject[]; conflicts: RowObject[]; nodes: RowObject[] };
    if (validation.blocked.length > 0) {
      return {
        ...meta,
        applied: false,
        blocked: true,
        message: '主干已被修改，无法保存，请放弃本次编辑',
        blockedConflicts: validation.blocked,
        conflicts: validation.conflicts,
        nodes: validation.nodes
      };
    }
    if (validation.conflicts.length > 0) {
      // 整批策略（strategy=ours/theirs，对应 git -X）是逐条裁决的语法糖：把冲突清单映射成统一 pick，
      // 一处合成、MCP/CLI 都不必各做一遍 dry-run；结构性冲突（parent_id/__parent__）仍由 resolveConflictEntries 拒绝。
      const picks = Array.isArray(resolutions) && resolutions.length > 0
        ? resolutions
        : (strategy === 'ours' || strategy === 'theirs')
          ? validation.conflicts.map((c: RowObject) => ({ id: c.id, field: c.field, pick: strategy }))
          : [];
      if (picks.length === 0) {
        return { ...meta, applied: false, conflicts: validation.conflicts, nodes: validation.nodes };
      }
      const { entries: folded, errors } = store.requireEditBranchPort().resolveConflictEntries({
        entries: rawPayload.entries,
        conflicts: validation.conflicts,
        resolutions: picks
      });
      if (errors.length > 0) {
        return { ...meta, applied: false, resolutionErrors: errors, conflicts: validation.conflicts, nodes: validation.nodes };
      }
      return { ...meta, applied: true, resolved: true, ..._commitEditBranchPayload(store, branch, { ...rawPayload, entries: folded as EditBranchEntry[] }, String(summary)) };
    }
    return { ...meta, applied: true, ..._commitEditBranchPayload(store, branch, rawPayload, String(summary)) };
  }

export function _replaceEditBranchDiff(store: EditBranchStore, branch: EditBranchRow, diff: EditBranchDiff): EditBranchRow {
    // 整替（冲突解决折叠 / 显式重排用，低频 O(K)）：清子表重灌，diff 列只写元壳。
    const { entries: rawEntries, ...metaRest } = (diff || {}) as EditBranchDiff & Record<string, unknown>;
    const entries = Array.isArray(rawEntries) ? rawEntries : [];
    const metaShell = {
      ...metaRest,
      kind: 'edit_branch_diff',
      storage: 'entries_table',
      owner: branch.owner,
      baseDocId: branch.base_doc_id,
      shadowDocId: branch.shadow_doc_id,
      updatedAt: new Date().toISOString()
    };
    store.db!.prepare('DELETE FROM edit_branch_entries WHERE branch_id = ?').run(branch.id);
    const insert = store.db!.prepare(`
      INSERT INTO edit_branch_entries (branch_id, seq, status, created_at, undone_at, entry)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    entries.forEach((entry, index) => {
      const fields = entryToRowFields(entry as EditBranchEntry);
      insert.run(branch.id, index + 1, fields.status, fields.created_at, fields.undone_at, fields.payload);
    });
    store.db!.prepare(`
      UPDATE edit_branches
      SET diff = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(metaShell), branch.id);
    return _branchRowById(store, branch.id);
  }

export function undoEditBranchEntry(store: EditBranchStore, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' }: EditBranchPayload = {}) {
    const branch = findEditBranch(store, { branchId, shadowDocId, baseDocId, owner } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) throw new Error('Edit branch not found');
    // 最后一条 active → undone，单行翻转 O(1)（原实现整包重写 O(K)）。
    const target = store.db!.prepare(`
      SELECT id FROM edit_branch_entries
      WHERE branch_id = ? AND status = 'active'
      ORDER BY seq DESC LIMIT 1
    `).get<{ id: number }>(branch.id);
    if (!target) {
      return { changed: false, branch, ...editBranchHistoryState(store, branch) };
    }
    store.db!.prepare("UPDATE edit_branch_entries SET status = 'undone', undone_at = ? WHERE id = ?")
      .run(new Date().toISOString(), target.id);
    store.db!.prepare('UPDATE edit_branches SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(branch.id);
    const freshBranch = _branchRowById(store, branch.id);
    return { changed: true, branch: freshBranch, ...editBranchHistoryState(store, freshBranch) };
  }

export function redoEditBranchEntry(store: EditBranchStore, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' }: EditBranchPayload = {}) {
    const branch = findEditBranch(store, { branchId, shadowDocId, baseDocId, owner } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) throw new Error('Edit branch not found');
    // 复活「最近被 undo」的条目（undoneAt 最新、同刻取 seq 最大），与原 marker 扫描语义一致。
    const target = store.db!.prepare(`
      SELECT id FROM edit_branch_entries
      WHERE branch_id = ? AND status = 'undone'
      ORDER BY COALESCE(undone_at, created_at, '') DESC, seq DESC LIMIT 1
    `).get<{ id: number }>(branch.id);
    if (!target) {
      return { changed: false, branch, ...editBranchHistoryState(store, branch) };
    }
    store.db!.prepare("UPDATE edit_branch_entries SET status = 'active', undone_at = NULL WHERE id = ?").run(target.id);
    store.db!.prepare('UPDATE edit_branches SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(branch.id);
    const freshBranch = _branchRowById(store, branch.id);
    return { changed: true, branch: freshBranch, ...editBranchHistoryState(store, freshBranch) };
  }

  // Fetch the doc-scoped refs (both endpoints in either nodes or axioms of the
  // doc). Shared between getDoc and _projectedDocForBranch so the lazy diff
  // projection always sees the same set of ref rows that the read path does.
export function _fetchBaseRefsForDoc(store: EditBranchStore, docId: unknown) {
    return axiomRef.listDocRefs(store, docId);
  }

  // 某文档当前正文（base）的投影输入：节点（父→排序→id 稳定序）、公理、引用。diffView / 投影 / liveDocSnapshot
  // 共用这一份取数，省得三处各写一遍、nodes 排序或 base 取法要改时追三处。
export function editBranchBaseInputs(store: EditBranchStore, docId: unknown): BaseDocInputs {
    const id = normalizePositiveId(docId);
    if (!id) throw new Error(`Invalid edit branch document id: ${docId}`);
    const nodes = store.db!.prepare(`
      SELECT * FROM nodes WHERE doc_id = ?
      ORDER BY parent_id IS NOT NULL, parent_id, sort_order, id
    `).all<ProjectedNode>(id);
    return { docId: id, nodes, axioms: store.listAxioms(id) as AxiomRow[], refs: _fetchBaseRefsForDoc(store, id) as RefRow[] };
  }

  // Read the doc with all entries from `branch` already projected on top of the
  // base tables. Returns the projection state (nodes/axioms/refs maps) — the
  // caller can use it to derive `node`, `axiom`, or `ref` views to hand back
  // to the front-end after a stage operation.
export function _projectedDocForBranch(store: EditBranchStore, branch: EditBranchRow): ProjectedDocState {
    const diff = JSON.parse(branch.diff || '{}') as EditBranchDiff;
    const entries = Array.isArray(diff.entries) ? diff.entries : [];
    return store.requireEditBranchPort().projectEditBranchDoc(editBranchBaseInputs(store, branch.base_doc_id), entries);
  }

  // 把某文档当前正文（HEAD）投影成快照 {nodes(含 address),axioms,refs}，供 diff.refs 与历史/草稿快照同形比对。
  // 空 entries 投影 = 正文本身，但复用投影器算地址，地址口径与草稿/历史快照一致（computeDiff 按稳定 id 配对）。
export function liveDocSnapshot(store: EditBranchStore, docId: unknown): ProjectedDocState {
    return store.requireEditBranchPort().projectEditBranchDoc(editBranchBaseInputs(store, docId), []);
  }

export function _findProjectedNode(store: EditBranchStore, state: ProjectedDocState, ref: unknown) {
    if (ref === null || ref === undefined) return null;
    if (store.requireEditBranchPort().isTmpId(ref)) return state.nodes.find((node) => node.id === ref) || null;
    return state.nodes.find((node) => sameStableId(node.id, ref)) || null;
  }

export function _findProjectedAxiom(store: EditBranchStore, state: ProjectedDocState, ref: unknown) {
    if (ref === null || ref === undefined) return null;
    if (store.requireEditBranchPort().isTmpId(ref)) return state.axioms.find((axiom) => axiom.id === ref) || null;
    return state.axioms.find((axiom) => sameStableId(axiom.id, ref)) || null;
  }

export function beginEditBranch(store: EditBranchStore, docId: unknown, owner: unknown = 'human', { fresh = false }: { fresh?: boolean } = {}) {
    const normalizedDocId = normalizePositiveId(docId);
    const identity = normalizeEditBranchOwner(store, owner);
    if (!normalizedDocId) throw new Error('beginEditBranch requires docId');

    // 默认复用该身份（role:user 前缀）下最新 active 草稿；fresh=true 才另起一行。
    // 平时没人开两个草稿切来切去，所以默认黏最新、免得每次都传 branchId（A5-5、15-5-2）。
    if (!fresh) {
      const shadowExisting = activeEditBranchForShadowDoc(store, normalizedDocId);
      if (shadowExisting && ownerIdentity(shadowExisting.owner) === identity) return shadowExisting;
      const existing = activeEditBranchForBaseDoc(store, normalizedDocId, identity);
      if (existing) return existing;
    }

    // 新建：owner = 身份#时间戳（秒精度）。同一文档 + 同一身份在同一秒内连开两个草稿，会撞
    // (base_doc_id, owner) 的 partial 唯一索引（schema：WHERE status='active'）。撞了就给 owner 追加
    // 自增尾缀重试——平时 owner 仍是干净的 role:user#ts，只有真撞才退化成 role:user#ts-2…，绝不抛错。
    // （owner 的时间戳段日后若改用 branchId 自增主键，天然唯一，这层兜底可去掉。）
    const head = store.db!.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get<HeadRow>(normalizedDocId);
    const stamp = ownerStamp();
    const insertBranch = store.db!.prepare(`
      INSERT INTO edit_branches (base_doc_id, shadow_doc_id, owner, base_snapshot, diff)
      VALUES (?, ?, ?, ?, ?)
    `);
    // suffix=0 先试裸 ts；撞唯一索引就 +1 换尾缀重试，靠插入成功 return 或抛错跳出（无显式循环条件、1000 上限兜底）。
    for (let suffix = 0; ; suffix += 1) {
      const fullOwner = suffix === 0 ? `${identity}#${stamp}` : `${identity}#${stamp}-${suffix}`;
      const baseSnapshot = createLazyEditBranchBaseSnapshot({
        owner: fullOwner,
        baseDocId: normalizedDocId,
        shadowDocId: normalizedDocId,
        baseCommitId: head?.head_commit_id || null
      });
      const diff = createEmptyEditBranchDiff({
        owner: fullOwner,
        baseDocId: normalizedDocId,
        shadowDocId: normalizedDocId
      });
      try {
        const result = insertBranch.run(normalizedDocId, normalizedDocId, fullOwner, JSON.stringify(baseSnapshot), JSON.stringify(diff));
        return _branchRowById(store, Number(result.lastInsertRowid));
      } catch (error) {
        const isUniqueClash = (error as { code?: string } | null | undefined)?.code === 'SQLITE_CONSTRAINT_UNIQUE'
          || /UNIQUE constraint failed/i.test(String((error as { message?: string } | null | undefined)?.message || ''));
        if (isUniqueClash && suffix < 1000) continue; // 同秒撞了，换个尾缀再试
        throw error; // 其它错误（外键、磁盘等）或重试上限：原样抛出
      }
    }
  }

export function findEditBranch(store: EditBranchStore, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' }: BranchLookupPayload = {}) {
    const normalizedOwner = owner == null ? null : normalizeEditBranchOwner(store, owner);
    const acceptOwner = (branch: EditBranchRow | null) => (
      branch && (!normalizedOwner || ownerIdentity(branch.owner) === ownerIdentity(normalizedOwner)) ? branch : null
    );
    if (branchId) {
      // branchId 是主键、全局唯一，唯一锁定一条草稿；owner 是写入身份/消歧维度、不是定位键。
      // 给了唯一句柄就不再按 owner 过滤——否则不传/传错 owner 会找不到本已锁定的草稿（见 A5-5、15-5-2）。
      return _withBranchEntries(store, store.db!.prepare("SELECT * FROM edit_branches WHERE id = ? AND status = 'active'").get<EditBranchRow>(Number(branchId)) || null);
    }
    if (shadowDocId) return acceptOwner(activeEditBranchForShadowDoc(store, shadowDocId));
    if (baseDocId) return activeEditBranchForBaseDoc(store, baseDocId, normalizedOwner || 'human');
    return null;
  }

export function rebaseEditBranch(store: EditBranchStore, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' }: EditBranchPayload = {}) {
    const branch = findEditBranch(store, { branchId, shadowDocId, baseDocId, owner } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) throw new Error('Edit branch not found');
    const head = store.db!.prepare('SELECT head_commit_id FROM doc_heads WHERE doc_id = ?').get<HeadRow>(branch.base_doc_id);
    const previousBaseSnapshot = JSON.parse(branch.base_snapshot || '{}') as RowObject;
    const now = new Date().toISOString();
    const baseSnapshot = {
      ...createLazyEditBranchBaseSnapshot({
        owner: branch.owner,
        baseDocId: branch.base_doc_id,
        shadowDocId: branch.shadow_doc_id,
        baseCommitId: head?.head_commit_id || null
      }),
      rebasedAt: now,
      previousBaseCommitId: previousBaseSnapshot.baseCommitId || null
    };
    store.db!.prepare(`
      UPDATE edit_branches
      SET base_snapshot = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(JSON.stringify(baseSnapshot), branch.id);
    const freshBranch = _branchRowById(store, branch.id);
    return {
      changed: true,
      branch: freshBranch,
      baseCommitId: baseSnapshot.baseCommitId,
      previousBaseCommitId: baseSnapshot.previousBaseCommitId ?? null,
      ...editBranchHistoryState(store, freshBranch)
    };
  }

export function cherryPickEditBranchEntries(store: EditBranchStore, {
    sourceHistoryId = null,
    sourceBranchId = null,
    targetBranchId = null,
    targetBaseDocId = null,
    targetOwner = 'human',
    entryId = null,
    entryIndex = null
  }: CherryPickPayload = {}) {
    const source = _cherryPickSource(store, { sourceHistoryId, sourceBranchId }) as CherryPickSource;
    const selectedEntries = _selectCherryPickEntries(store, source.entries, { entryId, entryIndex }) as EditBranchEntry[];
    if (selectedEntries.length === 0) throw new Error('cherry-pick found no entries');
    const targetBranch = targetBranchId
      ? findEditBranch(store, { branchId: targetBranchId, owner: null } as BranchLookupPayload) as EditBranchRow | null
      : beginEditBranch(store, targetBaseDocId || source.docId, targetOwner) as EditBranchRow | null;
    if (!targetBranch) throw new Error('Target edit branch not found');
    if (!sameStableId(targetBranch.base_doc_id, source.docId)) {
      throw new Error('cherry-pick source and target must belong to the same document');
    }
    let branch = targetBranch;
    const picked: EditBranchEntry[] = [];
    for (const entry of selectedEntries) {
      const copy = _copyCherryPickEntry(store, entry, source);
      branch = _appendEditBranchEntry(store, branch, copy);
      picked.push(copy);
    }
    return {
      changed: picked.length > 0,
      baseDocId: branch.base_doc_id,
      branchId: branch.id,
      owner: branch.owner,
      pickedCount: picked.length,
      branch,
      picked
    };
  }

export function _cherryPickSource(store: EditBranchStore, { sourceHistoryId = null, sourceBranchId = null }: Pick<CherryPickPayload, 'sourceHistoryId' | 'sourceBranchId'> = {}): CherryPickSource {
    if (sourceBranchId) {
      const branch = findEditBranch(store, { branchId: sourceBranchId, owner: null } as BranchLookupPayload) as EditBranchRow | null;
      if (!branch) throw new Error(`Source edit branch not found: ${sourceBranchId}`);
      const diff = JSON.parse(branch.diff || '{}') as EditBranchDiff;
      return {
        kind: 'branch',
        id: branch.id,
        docId: branch.base_doc_id,
        entries: activeEntries(store, diff.entries)
      };
    }
    if (sourceHistoryId) {
      const commit = store.db!.prepare('SELECT id, doc_id, meta FROM commits WHERE id = ?').get<Pick<CommitRow, 'id' | 'doc_id' | 'meta'>>(sourceHistoryId);
      if (!commit) throw new Error(`Commit not found: ${sourceHistoryId}`);
      // 操作级条目内联在 meta.entries。
      const meta = (parseJsonObject(commit.meta) || {}) as EditBranchDiff;
      const rawEntries = Array.isArray(meta.entries) ? meta.entries : null;
      const entries = activeEntries(store, rawEntries);
      if (entries.length === 0 && Array.isArray(rawEntries) && rawEntries.length > 0) {
        throw new Error('cherry-pick commit does not contain edit-branch entries');
      }
      return {
        kind: 'history',
        id: commit.id,
        docId: commit.doc_id,
        entries
      };
    }
    throw new Error('cherry-pick requires sourceHistoryId or sourceBranchId');
  }

export function _selectCherryPickEntries(store: EditBranchStore, entries: EditBranchEntry[] = [], { entryId = null, entryIndex = null }: Pick<CherryPickPayload, 'entryId' | 'entryIndex'> = {}) {
    if (entryId !== null && entryId !== undefined && entryId !== '') {
      const text = String(entryId);
      return entries.filter((entry) => (
        String(entry.id ?? entry.entryId ?? entry.createdAt ?? '') === text
      ));
    }
    if (entryIndex !== null && entryIndex !== undefined && entryIndex !== '') {
      const index = Number(entryIndex);
      if (!Number.isInteger(index) || index < 0) throw new Error('cherry-pick entryIndex must be a zero-based integer');
      return entries[index] ? [entries[index]] : [];
    }
    return entries;
  }

export function _copyCherryPickEntry(store: EditBranchStore, entry: EditBranchEntry, source: CherryPickSource): EditBranchEntry {
    const { status: _status, undoneAt: _undoneAt, ...rest } = entry;
    // spread + 新 createdAt + cherryPickedFrom，原 variant 形状不变；TS 看不出 spread 结果属于哪个
    // variant，cast 回 EditBranchEntry 安全。
    return {
      ...rest,
      createdAt: new Date().toISOString(),
      cherryPickedFrom: {
        kind: source.kind,
        id: source.id,
        entryCreatedAt: entry.createdAt || null
      }
    } as EditBranchEntry;
  }

export function saveEditBranch(store: EditBranchStore, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human', summary = '保存编辑分支' }: EditBranchPayload = {}) {
    // 与 applyMerge 同一道闸门：非快进时逐条前置验证，受阻/冲突拒绝写回（MCP commit 不再盲存）。
    return applyThreeWayMerge(store, { branchId, shadowDocId, baseDocId, owner, summary });
  }

  // 重放前后的节点签名快照，比对找出本次实际受影响节点。签名分两维，对应两套派生索引
  // 各自的身份语义：keyword 行绑（地址+全部内容字段，4-6-2），向量只绑正文（15-8-1，
  // 地址/标题/备注变化不重算）。contentHash 现算（merkle 同款）——content_hash 列是
  // 惰性回写（触发器只标 doc 脏），事务内不可用。逐 entry 收集容易漏（split/merge/
  // 级联删除），两次 O(n) 快照比对不会。iterate 逐行算完即弃，不持全文。
export function _docNodeSignatures(store: EditBranchStore, docId: unknown) {
    const map = new Map<string, NodeSignature>();
    const rows = store.db!.prepare(`
      SELECT id, address, text, node_title, node_note, node_type, trust_level
      FROM nodes WHERE doc_id = ?
    `).all<Pick<NodeRow, 'id' | 'address' | 'text' | 'node_title' | 'node_note' | 'node_type' | 'trust_level'>>(docId);
    for (const row of rows) {
      map.set(String(row.id), {
        keyword: `${row.address || ''}|${contentHash(row as unknown as MerkleNode)}`,
        text: contentHash({ id: null, text: row.text })
      });
    }
    return map;
  }

  // 把一份 diff payload（生效 entries）应用到主干、提交、写历史、删分支。
  // saveEditBranch 用分支存储的 entries 调用；三方合并人裁后用折进 resolution 的 entries 调用。
  // 返回 touchedNodeIds/deletedNodeIds 供派生索引按受影响节点增量同步（4-6-2）。
export function _commitEditBranchPayload(store: EditBranchStore, branch: EditBranchRow, rawPayload: EditBranchDiff = {}, summary = '保存编辑分支'): BranchCommitResult {
    const entries = activeEntries(store, rawPayload.entries);
    if (entries.some(editBranchEntryTouchesTrust)) {
      throw new Error('edit branch diff no longer supports trust_level; use human certify to set trust_level');
    }
    const payload = { ...rawPayload, entries };
    const hasEffectiveDiff = entries.length > 0;

    return store.withTransaction(() => {
      const touchedNodeIds: unknown[] = [];
      const deletedNodeIds: unknown[] = [];
      const vectorStaleNodeIds: unknown[] = [];
      if (hasEffectiveDiff) {
        const before = _docNodeSignatures(store, branch.base_doc_id);
        applyEditBranchDiffEntries(store, branch, payload);
        const after = _docNodeSignatures(store, branch.base_doc_id);
        for (const [id, signature] of after) {
          const previous = before.get(id);
          if (!previous || previous.keyword !== signature.keyword) touchedNodeIds.push(id);
          // 向量陈旧 = 既有节点正文变了；新增节点无旧向量行，地址/标题/备注变化不算。
          if (previous && previous.text !== signature.text) vectorStaleNodeIds.push(id);
        }
        for (const id of before.keys()) {
          if (!after.has(id)) deletedNodeIds.push(id);
        }
        const currentSnapshot = history.createSnapshot(store, branch.base_doc_id);
        history.createCommit(store, {
          docId: branch.base_doc_id,
          summary,
          snapshot: currentSnapshot,
          entries, // 操作级条目（cherry-pick 重放 / 单 ref diff 展示要它）
          author: branch.owner || null
        });
      }

      store.db!.prepare('DELETE FROM edit_branches WHERE id = ?').run(branch.id);
      if (hasEffectiveDiff) store.touchDoc(branch.base_doc_id);

      return {
        changed: hasEffectiveDiff,
        baseDocId: branch.base_doc_id,
        branchId: branch.id,
        owner: branch.owner,
        touchedNodeIds,
        deletedNodeIds,
        vectorStaleNodeIds,
        history: hasEffectiveDiff
          ? store.db!.prepare(`
            SELECT id, doc_id, id AS commit_id, committed_at AS saved_at, summary
            FROM commits
            WHERE doc_id = ?
            ORDER BY committed_at DESC, id DESC
            LIMIT 1
          `).get<CommitHistoryRow>(branch.base_doc_id)
          : null
      };
    });
  }

export function discardEditBranch(store: EditBranchStore, { branchId = null, shadowDocId = null, baseDocId = null, owner = 'human' }: EditBranchPayload = {}) {
    const branch = findEditBranch(store, { branchId, shadowDocId, baseDocId, owner } as BranchLookupPayload) as EditBranchRow | null;
    if (!branch) return false;
    // Lazy mode: base tables are never modified during the edit session, so
    // discarding the branch simply drops the staged entries.
    store.db!.prepare('DELETE FROM edit_branches WHERE id = ?').run(branch.id);
    return true;
  }
