import type { AxiomRow, NodeRow, RefRow } from '../db/schema.js';

export type ProjectionNode = NodeRow & {
  child_count: number;
  pending_insert?: boolean;
};

export type ProjectionAxiom = AxiomRow & {
  pending_insert?: boolean;
};

export type ProjectionRef = RefRow & {
  pending_insert?: boolean;
};

// 对外：projectEditBranchDoc 的返回形状。内部 ProjectionState 在此基础上加 *IdSeq。
export type ProjectedDoc = {
  docId: string;
  nodes: ProjectionNode[];
  axioms: ProjectionAxiom[];
  refs: ProjectionRef[];
};

export type ProjectionState = ProjectedDoc & {
  nodeIdSeq: number;
  axiomIdSeq: number;
  refIdSeq: number;
};

export type ProjectionBase = {
  docId: string;
  nodes?: ProjectionNode[];
  axioms?: ProjectionAxiom[];
  refs?: ProjectionRef[];
};

// ──────────── EditBranchEntry 判别联合（按 kind 分 variant）────────────
//
// 同一概念之前在三个文件里各定义了一份不兼容的扁平/联合类型：
//   - edit-branch-projection.ts 扁平 + 30 可选 unknown（投影内部）
//   - store/edit-branch.ts 又一份扁平、字段更少（外层 store）
// 现在统一收回这里：node/axiom/ref 各 variant 在下面定义；上层领域可以通过通用 external
// entry 接入；所有 variant 都按 _appendEditBranchEntry 的写入约定带上
// EditBranchEntryMeta（status/createdAt/...）。判别字段是 `kind`，switch / APPLIERS[kind]
// 拿到 entry 后 TS 自动 narrow 到对应 variant。

export type EditBranchEntryStatus = 'active' | 'undone';

// 公共元数据：所有 entry 通过 _appendEditBranchEntry 时被加 status + createdAt；undo/redo 加
// undoneAt；cherry-pick 加 cherryPickedFrom；旧路径还存在 id/entryId/action 字段（被 cherry-pick
// 索引 + node.update 自报）。
export interface EditBranchEntryMeta {
  id?: unknown;
  entryId?: unknown;
  status?: EditBranchEntryStatus;
  createdAt?: string;
  undoneAt?: string;
  action?: string;
  cherryPickedFrom?: {
    kind: string;
    id: unknown;
    entryCreatedAt: string | null;
  };
}

// ── node.* variant 字段 ────────────────────────────────────────────────

export interface NodePatchFields {
  text?: unknown;
  node_title?: unknown;
  node_note?: unknown;
  node_type?: unknown;
  trust_level?: unknown;
  source_position?: unknown;
}

export interface NodeUpdateFieldsDelta {
  field: string;
  old?: unknown;
  new?: unknown;
}

export interface NodeInsertFields {
  text?: unknown;
  node_type?: unknown;
  nodeType?: unknown;
  node_title?: unknown;
  nodeTitle?: unknown;
  node_note?: unknown;
  nodeNote?: unknown;
  source_position?: unknown;
  // assertNoEditTrustField 已保证 stage 不写 trust，但保留容错（其它 owner / 历史 entry 可能带）。
  trust_level?: unknown;
  trustLevel?: unknown;
  trust?: unknown;
}

// 引用字段一律 unknown：stage 端直接灌 payload.xxx（未 normalize），projection 内部用
// normalizeId/sameRef 收紧。StableRef 仍用作 normalize 后的语义类型（projection 内部 row.id）。
export interface NodeUpdateEntry {
  kind: 'node.update';
  node_id?: unknown;
  target_ref?: unknown;
  patch: NodePatchFields;
  address?: string;
  fields?: NodeUpdateFieldsDelta[];
}

export interface NodeInsertEntry {
  kind: 'node.insert';
  tmp_id?: string;
  parent_ref?: unknown;
  after_ref?: unknown;
  fields: NodeInsertFields;
}

export interface NodeDeleteEntry {
  kind: 'node.delete';
  target_ref?: unknown;
  node_id?: unknown;
  address?: string;
  before_subtree_hash?: string | null;
}

export interface NodeMoveEntry {
  kind: 'node.move';
  target_ref?: unknown;
  node_id?: unknown;
  direction?: 'up' | 'down';
}

// node_ref 在 NodePromoteEntry 上历史 entry 里可能出现（联合里其他 case fallback 链共用此字段）。
export interface NodePromoteEntry {
  kind: 'node.promote';
  target_ref?: unknown;
  node_ref?: unknown;
  node_id?: unknown;
  before_parent_id?: unknown;
}

export interface SplitSpan {
  tmp_id?: string;
  text?: unknown;
  sentence_index?: unknown;
}

export interface ParagraphSplit {
  paragraph_node_id?: unknown;
  before_content_hash?: string | null;
  spans?: SplitSpan[];
}

export interface NodeSplitEntry {
  kind: 'node.split';
  target_ref?: unknown;
  node_id?: unknown;
  address?: string;
  strategy?: 'source_paragraphs' | 'split_sentences';
  paragraph_splits?: ParagraphSplit[];
  sentences?: unknown[];
  new_node_ids?: string[];
  before_content_hash?: string | null;
}

// merge / moveBefore / moveAfter 共享字段集，但 kind 各不同——拆成独立 variant 才能让
// EntryByKind<'node.mergeInto'> 这种 Extract 在 switch case 里正确 narrow（Extract 对单个
// interface 的字面量联合 kind 字段不 distribute，会得到 never）。
interface NodeMergeFields {
  source_ref?: unknown;
  node_id?: unknown;
  target_ref?: unknown;
  target_node_id?: unknown;
  source_before_content_hash?: string | null;
  target_before_content_hash?: string | null;
}

export interface NodeMergeIntoEntry extends NodeMergeFields {
  kind: 'node.mergeInto';
}

export interface NodeMergePreviousEntry extends NodeMergeFields {
  kind: 'node.mergePrevious';
}

export type NodeMergeEntry = NodeMergeIntoEntry | NodeMergePreviousEntry;

export interface NodeReparentEntry {
  kind: 'node.reparent';
  node_ref?: unknown;
  node_id?: unknown;
  target_ref?: unknown;
  new_parent_ref?: unknown;
  new_parent_id?: unknown;
  before_parent_id?: unknown;
}

interface NodeMoveSiblingFields {
  node_ref?: unknown;
  node_id?: unknown;
  target_ref?: unknown;
  target_node_id?: unknown;
  before_parent_id?: unknown;
}

export interface NodeMoveBeforeEntry extends NodeMoveSiblingFields {
  kind: 'node.moveBefore';
}

export interface NodeMoveAfterEntry extends NodeMoveSiblingFields {
  kind: 'node.moveAfter';
}

export type NodeMoveBeforeAfterEntry = NodeMoveBeforeEntry | NodeMoveAfterEntry;

// ── axiom.* variant 字段 ───────────────────────────────────────────────

export interface AxiomAddFields {
  content?: unknown;
  status?: unknown;
  node_title?: unknown;
  node_note?: unknown;
}

export interface AxiomPatchFields {
  content?: unknown;
  status?: unknown;
  node_title?: unknown;
  node_note?: unknown;
}

export interface AxiomAddEntry {
  kind: 'axiom.add';
  tmp_id?: string;
  fields: AxiomAddFields;
}

export interface AxiomUpdateEntry {
  kind: 'axiom.update';
  axiom_ref?: unknown;
  axiom_id?: unknown;
  patch: AxiomPatchFields;
}

export interface AxiomDeleteEntry {
  kind: 'axiom.delete';
  axiom_ref?: unknown;
  axiom_id?: unknown;
}

export interface AxiomMoveEntry {
  kind: 'axiom.move';
  axiom_ref?: unknown;
  axiom_id?: unknown;
  direction?: 'up' | 'down';
}

// ── ref.* variant 字段 ─────────────────────────────────────────────────

export interface RefAddNodeToNodeEntry {
  kind: 'ref.addNodeToNode';
  tmp_id?: string;
  source_ref?: unknown;
  source_node_id?: unknown;
  target_ref?: unknown;
  target_node_id?: unknown;
  ref_kind?: unknown;
  note?: unknown;
}

export interface RefAddAxiomToNodeEntry {
  kind: 'ref.addAxiomToNode';
  tmp_id?: string;
  node_ref?: unknown;
  node_id?: unknown;
  axiom_ref?: unknown;
  axiom_id?: unknown;
  note?: unknown;
}

export interface RefDeleteEntry {
  kind: 'ref.delete';
  ref_ref?: unknown;
  ref_id?: unknown;
}

// ── 主联合 + 工具类型 ─────────────────────────────────────────────────

export type BuiltInEditBranchEntryKind =
  | 'node.update' | 'node.insert' | 'node.delete' | 'node.move'
  | 'node.promote' | 'node.split' | 'node.mergeInto' | 'node.mergePrevious'
  | 'node.reparent' | 'node.moveBefore' | 'node.moveAfter'
  | 'axiom.add' | 'axiom.update' | 'axiom.delete' | 'axiom.move'
  | 'ref.addNodeToNode' | 'ref.addAxiomToNode' | 'ref.delete';

export type EditBranchEntryKind = BuiltInEditBranchEntryKind | (string & {});

// L2 内建的 18 个 variant（独立导出，给只关心 node/axiom/ref 的位置用）。
export type BuiltInEditBranchEntry =
  | (NodeUpdateEntry & EditBranchEntryMeta)
  | (NodeInsertEntry & EditBranchEntryMeta)
  | (NodeDeleteEntry & EditBranchEntryMeta)
  | (NodeMoveEntry & EditBranchEntryMeta)
  | (NodePromoteEntry & EditBranchEntryMeta)
  | (NodeSplitEntry & EditBranchEntryMeta)
  | (NodeMergeIntoEntry & EditBranchEntryMeta)
  | (NodeMergePreviousEntry & EditBranchEntryMeta)
  | (NodeReparentEntry & EditBranchEntryMeta)
  | (NodeMoveBeforeEntry & EditBranchEntryMeta)
  | (NodeMoveAfterEntry & EditBranchEntryMeta)
  | (AxiomAddEntry & EditBranchEntryMeta)
  | (AxiomUpdateEntry & EditBranchEntryMeta)
  | (AxiomDeleteEntry & EditBranchEntryMeta)
  | (AxiomMoveEntry & EditBranchEntryMeta)
  | (RefAddNodeToNodeEntry & EditBranchEntryMeta)
  | (RefAddAxiomToNodeEntry & EditBranchEntryMeta)
  | (RefDeleteEntry & EditBranchEntryMeta);

// 上层领域 entry：L2 只要求字符串 kind 与公共元数据，不认识领域命名空间。
export type ExternalEditBranchEntry = EditBranchEntryMeta & Record<string, unknown> & { kind: string };

export type EditBranchEntry = BuiltInEditBranchEntry | ExternalEditBranchEntry;

// 按 kind 取出对应 variant 的工具类型，给 apply*(entry: EntryByKind<'node.update'>) 这种签名用。
export type EntryByKind<K extends BuiltInEditBranchEntryKind> = Extract<BuiltInEditBranchEntry, { kind: K }>;

const BUILT_IN_EDIT_BRANCH_ENTRY_KINDS = new Set<string>([
  'node.update', 'node.insert', 'node.delete', 'node.move',
  'node.promote', 'node.split', 'node.mergeInto', 'node.mergePrevious',
  'node.reparent', 'node.moveBefore', 'node.moveAfter',
  'axiom.add', 'axiom.update', 'axiom.delete', 'axiom.move',
  'ref.addNodeToNode', 'ref.addAxiomToNode', 'ref.delete'
]);

export function isBuiltInEditBranchEntry(entry: EditBranchEntry): entry is BuiltInEditBranchEntry {
  return BUILT_IN_EDIT_BRANCH_ENTRY_KINDS.has(entry.kind);
}
