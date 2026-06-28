import {
  compareStableIds,
  normalizeStableId
} from './db/ids.js';
import { normalizeNodeType } from '../core/node-model.js';
import { mergeNodeNotes } from '../core/node-notes.js';
import type { EntityEntry } from './entities/projection.js';
import type { AxiomRow, NodeRow, NodeSizeMode, NodeType, RefRow, TrustLevel } from './db/schema.js';

type StableRef = string | number | null | undefined;
type RowObject = Record<string, unknown>;

export type { EntityEntry };

// projection 内 entry.xxx 字段类型多是 unknown（stage 端从 payload 灌入），写到 NodeRow/
// AxiomRow/RefRow 精确字段时统一经这几个 helper 收紧，避免每处都 String/Number cast。
function asString(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}
function asStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
function asNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 投影中间态 = DB 真行类型 + 草稿增量字段。草稿 push 新节点时派生字段（content_hash /
// subtree_hash / *_chars）填 null/0；落库走重放路径时 DB 触发器会重算。child_count 是
// projection 末尾 recomputeAddressesAndDepth 必算的派生字段，标必填（而非可选）让下游
// 直接当 NodeWithChildCountRow 消费、无需再 cast。
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

type ProjectionState = ProjectedDoc & {
  nodeIdSeq: number;
  axiomIdSeq: number;
  refIdSeq: number;
};

type ProjectionBase = {
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
//   - entities/projection.ts 精确判别联合 EntityEntry（实体 8 kind）
// 现在统一收回这里：node/axiom/ref 各 variant 在下面定义；entity.* 8 个 variant 直接
// 复用 EntityEntry 并入主联合；所有 variant 都按 _appendEditBranchEntry 的写入约定带上
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

export type EditBranchEntryKind =
  | 'node.update' | 'node.insert' | 'node.delete' | 'node.move'
  | 'node.promote' | 'node.split' | 'node.mergeInto' | 'node.mergePrevious'
  | 'node.reparent' | 'node.moveBefore' | 'node.moveAfter'
  | 'axiom.add' | 'axiom.update' | 'axiom.delete' | 'axiom.move'
  | 'ref.addNodeToNode' | 'ref.addAxiomToNode' | 'ref.delete'
  | EntityEntry['kind'];

// 非 entity 的 18 个 variant（独立导出，给只关心 node/axiom/ref 的位置用）。
export type NonEntityEditBranchEntry =
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

// entity.* 8 个 variant：EntityEntry 已经精确判别联合（自带 kind 与字段），补 meta。
export type EntityEditBranchEntry = EntityEntry & EditBranchEntryMeta;

// 主联合：26 个 variant，由 kind 判别。
export type EditBranchEntry = NonEntityEditBranchEntry | EntityEditBranchEntry;

// 按 kind 取出对应 variant 的工具类型，给 apply*(entry: EntryByKind<'node.update'>) 这种签名用。
export type EntryByKind<K extends EditBranchEntryKind> = Extract<EditBranchEntry, { kind: K }>;

type ConflictRow = RowObject & {
  id?: unknown;
  field?: string;
  ours?: unknown;
  theirs?: unknown;
  base?: unknown;
};

type ConflictResolution = RowObject & {
  id?: unknown;
  field?: string;
  pick?: 'ours' | 'theirs' | 'fill' | string;
  value?: unknown;
};


// Lazy diff projection: take a base doc snapshot (nodes/axioms/refs) plus a list
// of edit branch entries, and return the projected document state the user
// should see while editing — without ever writing to the base tables.
//
// Conventions:
//   - A "ref" in entry payloads is either a positive integer (an existing
//     base id) or a tmp id string of the form `tmp-node-…`, `tmp-axiom-…`,
//     `tmp-ref-…`. Tmp ids are produced by stage* functions when entries
//     create new rows.
//   - The projection only tracks the columns the editor UI cares about. It
//     does not try to replay refreshAddressScopes / structureMetadata side
//     effects exactly. Address and depth are recomputed once at the end so
//     the UI always sees consistent tree paths.

const SUPPORTED_ENTRY_KINDS = new Set<string>([
  'node.update',
  'node.insert',
  'node.delete',
  'node.move',
  'node.promote',
  'node.split',
  'node.mergeInto',
  'node.mergePrevious',
  'node.reparent',
  'node.moveBefore',
  'node.moveAfter',
  'axiom.add',
  'axiom.update',
  'axiom.delete',
  'axiom.move',
  'ref.addNodeToNode',
  'ref.addAxiomToNode',
  'ref.delete',
  'entity.create',
  'entity.update',
  'entity.delete',
  'entity.link',
  'entity.unlink',
  'entity.bindNode',
  'entity.ignoreNode',
  'entity.clearNodeBinding'
]);

export function isSupportedEditBranchEntryKind(kind: unknown) {
  return SUPPORTED_ENTRY_KINDS.has(String(kind || ''));
}

export function isActiveEditBranchEntry(entry: unknown) {
  if (!entry || typeof entry !== 'object') return true;
  return String((entry as { status?: string }).status || 'active') !== 'undone';
}

// JSON 反序列化出来的 entries 按 _appendEditBranchEntry 写入约定就是 EditBranchEntry 联合的元素，
// 这里做一次类型断言把宽 unknown 收紧成判别联合，下游 switch(entry.kind) 即可自动 narrow。
export function activeEditBranchEntries(entries: unknown = []): EditBranchEntry[] {
  return (Array.isArray(entries) ? entries : []).filter(isActiveEditBranchEntry) as EditBranchEntry[];
}

export function undoneEditBranchEntries(entries: unknown = []): EditBranchEntry[] {
  return (Array.isArray(entries) ? entries : []).filter((entry: unknown) => !isActiveEditBranchEntry(entry)) as EditBranchEntry[];
}

// 内容字段冲突可经 node.update patch 微调解决；parent_id 走结构 entry（node.reparent 等），patch 碰不到。
const RESOLVABLE_CONTENT_FIELDS = new Set<string>(['text', 'node_title', 'node_note', 'node_type', 'trust_level']);

function stripNodeEntries(entries: EditBranchEntry[], nodeId: unknown, kinds: string[] | null = null) {
  const id = String(nodeId);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    let match = false;
    if (entry.kind === 'node.delete') match = String(entry.target_ref) === id;
    else if (entry.kind === 'node.update') match = String(entry.node_id) === id;
    if (!match) continue;
    if (kinds && !kinds.includes(entry.kind)) continue;
    entries.splice(i, 1);
  }
}

function stripPatchField(entries: EditBranchEntry[], nodeId: unknown, field: string) {
  const id = String(nodeId);
  for (const entry of entries) {
    if (entry.kind !== 'node.update' || String(entry.node_id) !== id) continue;
    // NodePatchFields 是精确字段集（text/node_title/node_note/node_type/trust_level/source_position），
    // 但「冲突字段名」是动态 string，无 index signature 走不通——用 Record 视图按 key 删除。
    const patch = entry.patch as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      delete patch[field];
      if (Array.isArray(entry.fields)) entry.fields = entry.fields.filter((f) => f.field !== field);
    }
  }
}

// 把人裁结果（每个冲突选 ours/theirs/填值）折进分支 entries，复用既有重放机制写回。
// 无冲突字段不动（重放本就自动合）；冲突字段：取 theirs=保留分支 patch、取 ours=从 patch 剥掉该字段、
// 填值=追加一条 {field:value} 的 node.update。delete-modify 按选择增删 node.delete。
// conflicts 来自保存闸门的逐条前置验证（结构性失配在进面板前已被 blocked 拦下，
// 故这里收到的字段冲突必然源自 node.update patch，「划账」是精确的），形状与
// classifyThreeWayMerge 预览的扁平列表一致：{id, field, ours, theirs, base}。
// 返回 { entries, errors }；errors 非空时调用方应拒绝写回。
// v1 不支持：parent_id 结构冲突、复活己删节点、__parent__（主干删父+分支在其下新增/移入）。
export function resolveConflictEntries({ entries = [], conflicts = [], resolutions = [] }: {
  entries?: unknown;
  conflicts?: ConflictRow[];
  resolutions?: ConflictResolution[];
} = {}) {
  const active: EditBranchEntry[] = activeEditBranchEntries(entries).map((entry) => JSON.parse(JSON.stringify(entry)));
  const appended: EditBranchEntry[] = [];
  const errors: RowObject[] = [];
  const byKey = new Map<string, ConflictResolution>();
  for (const res of resolutions || []) {
    if (res && res.id != null && res.field != null && res.pick != null) {
      byKey.set(`${String(res.id)}::${res.field}`, res);
    }
  }

  for (const conflict of conflicts || []) {
    const id = String(conflict.id);
    const field = String(conflict.field || '');
    const res = byKey.get(`${id}::${field}`);
    if (!res) { errors.push({ id, field, reason: 'unresolved' }); continue; }
    const pick = res.pick;

    if (field === 'parent_id') {
      errors.push({ id, field, reason: 'parent-reparent-conflict-unsupported' });
      continue;
    }

    if (field === '__parent__') {
      // 主干已删父、分支在其下新增/移入：取 theirs 需复活父节点（v1 不支持），取 ours 需剥结构 entry（patch 碰不到）。
      errors.push({ id, field, reason: 'parent-deleted-in-trunk-unsupported' });
      continue;
    }

    if (field === '__node__') {
      if (pick !== 'ours' && pick !== 'theirs') { errors.push({ id, field, reason: 'delete-modify-needs-ours-or-theirs' }); continue; }
      const oursDeleted = conflict.ours === 'deleted';
      const theirsDeleted = conflict.theirs === 'deleted';
      const pickedDeleted = pick === 'ours' ? oursDeleted : theirsDeleted;
      if (pickedDeleted) {
        // 结果=删除：主干已删的清掉分支无效更新；分支删的保留 node.delete 让重放删主干节点。
        if (oursDeleted) stripNodeEntries(active, id, ['node.update']);
      } else if (pick === 'ours') {
        // ours 改、theirs 删，保留 ours 版本 → 去掉分支对该节点的全部 entry。
        stripNodeEntries(active, id);
      } else {
        // theirs 改、ours 删，要复活 theirs → 分支 entry 是 update，缺节点无法重放，v1 不支持。
        errors.push({ id, field, reason: 'resurrect-deleted-node-unsupported' });
      }
      continue;
    }

    if (!RESOLVABLE_CONTENT_FIELDS.has(field)) {
      errors.push({ id, field, reason: 'field-not-resolvable' });
      continue;
    }
    if (pick === 'theirs') {
      continue; // 保留分支 patch，重放即取 theirs
    }
    if (pick === 'ours') {
      stripPatchField(active, id, field); // 重放不触该字段 → 保留 ours
    } else if (pick === 'fill') {
      if (res.value === undefined) { errors.push({ id, field, reason: 'fill-requires-value' }); continue; }
      // field 已被 RESOLVABLE_CONTENT_FIELDS 限制在 NodePatchFields 字段子集内，运行时 type 安全。
      appended.push({ kind: 'node.update', action: 'patch', node_id: id, patch: { [field]: res.value } as NodePatchFields, status: 'active' });
    } else {
      errors.push({ id, field, reason: `unknown-pick:${String(pick)}` });
    }
  }

  return { entries: [...active, ...appended], errors };
}

function cloneState(base: ProjectionBase): ProjectionState {
  return {
    docId: base.docId,
    nodes: (base.nodes || []).map((row) => ({ ...row })),
    axioms: (base.axioms || []).map((row) => ({ ...row })),
    refs: (base.refs || []).map((row) => ({ ...row })),
    nodeIdSeq: -1,
    axiomIdSeq: -1,
    refIdSeq: -1
  };
}

function isTmpId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('tmp-');
}

function normalizeId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (isTmpId(value)) return value;
  return normalizeStableId(value);
}

function findNodeIndex(state: ProjectionState, ref: unknown) {
  if (ref === null || ref === undefined) return -1;
  if (isTmpId(ref)) return state.nodes.findIndex((node) => node.id === ref);
  return state.nodes.findIndex((node) => sameRef(node.id, ref));
}

function findAxiomIndex(state: ProjectionState, ref: unknown) {
  if (ref === null || ref === undefined) return -1;
  if (isTmpId(ref)) return state.axioms.findIndex((axiom) => axiom.id === ref);
  return state.axioms.findIndex((axiom) => sameRef(axiom.id, ref));
}

function findRefIndex(state: ProjectionState, ref: unknown) {
  if (ref === null || ref === undefined) return -1;
  if (isTmpId(ref)) return state.refs.findIndex((entry) => entry.id === ref);
  return state.refs.findIndex((entry) => sameRef(entry.id, ref));
}

function descendantNodeIds(state: ProjectionState, rootId: StableRef) {
  const result = new Set<StableRef>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const node of state.nodes) {
      if (result.has(node.id)) continue;
      const parentId = node.parent_id;
      if (parentId !== null && parentId !== undefined && result.has(parentId)) {
        result.add(node.id);
        added = true;
      }
    }
  }
  return result;
}

function resortSiblings(state: ProjectionState, parentRef: unknown) {
  const parentId = parentRef === null || parentRef === undefined ? null : parentRef;
  const siblings = state.nodes.filter((node) => sameRef(node.parent_id, parentId));
  siblings.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
    || compareIdForOrder(a.id, b.id));
  for (let index = 0; index < siblings.length; index += 1) {
    siblings[index].sort_order = index + 1;
  }
}

function compareIdForOrder(left: unknown, right: unknown) {
  return compareStableIds(left, right);
}

function sameRef(left: unknown, right: unknown) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return String(left) === String(right);
}

function patchNodeRow(row: ProjectionNode, patch: NodePatchFields): ProjectionNode {
  const next = { ...row };
  if (Object.prototype.hasOwnProperty.call(patch, 'text')) next.text = asString(patch.text);
  if (Object.prototype.hasOwnProperty.call(patch, 'node_title')) next.node_title = asString(patch.node_title);
  if (Object.prototype.hasOwnProperty.call(patch, 'node_note')) next.node_note = asString(patch.node_note);
  if (Object.prototype.hasOwnProperty.call(patch, 'node_type')) next.node_type = normalizeNodeType(patch.node_type ?? row.node_type) as NodeType;
  if (Object.prototype.hasOwnProperty.call(patch, 'trust_level')) next.trust_level = (patch.trust_level ?? null) as TrustLevel | null;
  if (Object.prototype.hasOwnProperty.call(patch, 'source_position')) next.source_position = asNumberOrNull(patch.source_position);
  next.updated_at = new Date().toISOString();
  return next;
}

function applyNodeUpdate(state: ProjectionState, entry: EntryByKind<'node.update'>) {
  const index = findNodeIndex(state, entry.node_id ?? entry.target_ref);
  if (index < 0) return;
  state.nodes[index] = patchNodeRow(state.nodes[index], entry.patch || {});
}

function applyNodeInsert(state: ProjectionState, entry: EntryByKind<'node.insert'>) {
  const parentRef = normalizeId(entry.parent_ref);
  const afterRef = normalizeId(entry.after_ref);
  const fields = entry.fields;
  const siblings = state.nodes.filter((node) => sameRef(node.parent_id, parentRef));
  siblings.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

  let sortOrder = siblings.length + 1;
  if (afterRef !== null) {
    const afterIndex = siblings.findIndex((node) => sameRef(node.id, afterRef));
    if (afterIndex >= 0) sortOrder = (Number(siblings[afterIndex].sort_order) || 0) + 1;
  }
  for (const sibling of siblings) {
    if ((Number(sibling.sort_order) || 0) >= sortOrder) sibling.sort_order = (Number(sibling.sort_order) || 0) + 1;
  }
  const now = new Date().toISOString();
  state.nodes.push({
    id: asString(entry.tmp_id),
    doc_id: state.docId,
    parent_id: parentRef,
    sort_order: sortOrder,
    depth: 0,
    address: '',
    node_type: normalizeNodeType(asString(fields.node_type || fields.nodeType, 'TEXT')) as NodeType,
    text: asString(fields.text),
    node_title: asString(fields.node_title || fields.nodeTitle),
    node_note: asString(fields.node_note || fields.nodeNote),
    source_position: asNumberOrNull(fields.source_position),
    trust_level: (fields.trust_level ?? null) as TrustLevel | null,
    // NodeRow 必填的派生字段（DB 触发器在落库时算）；草稿 push 时填默认占位。
    content_hash: null,
    subtree_hash: null,
    title_chars: 0,
    text_chars: 0,
    note_chars: 0,
    created_at: now,
    updated_at: now,
    child_count: 0,
    pending_insert: true
  });
}

function applyNodeDelete(state: ProjectionState, entry: EntryByKind<'node.delete'>) {
  const targetRef = normalizeId(entry.target_ref ?? entry.node_id);
  const index = findNodeIndex(state, targetRef);
  if (index < 0) return;
  const target = state.nodes[index];
  if (target.parent_id === null || target.parent_id === undefined) return;
  const removeIds = descendantNodeIds(state, target.id);
  state.nodes = state.nodes.filter((node) => !removeIds.has(node.id));
  state.refs = state.refs.filter((ref) => {
    if (ref.source_type === 'node' && removeIds.has(ref.source_id)) return false;
    if (ref.target_type === 'node' && removeIds.has(ref.target_id)) return false;
    return true;
  });
  resortSiblings(state, target.parent_id);
}

function applyNodeMove(state: ProjectionState, entry: EntryByKind<'node.move'>) {
  const index = findNodeIndex(state, entry.target_ref ?? entry.node_id);
  if (index < 0) return;
  const node = state.nodes[index];
  if (node.parent_id === null || node.parent_id === undefined) return;
  const siblings = state.nodes.filter((other) => sameRef(other.parent_id, node.parent_id));
  siblings.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const order = siblings.findIndex((other) => sameRef(other.id, node.id));
  const targetOrder = entry.direction === 'up' ? order - 1 : order + 1;
  if (targetOrder < 0 || targetOrder >= siblings.length) return;
  const sibling = siblings[targetOrder];
  const tmp = node.sort_order;
  node.sort_order = sibling.sort_order;
  sibling.sort_order = tmp;
}

function applyNodePromote(state: ProjectionState, entry: EntryByKind<'node.promote'>) {
  const index = findNodeIndex(state, entry.target_ref ?? entry.node_id);
  if (index < 0) return;
  const node = state.nodes[index];
  if (node.parent_id === null || node.parent_id === undefined) return;
  const parentIndex = findNodeIndex(state, node.parent_id);
  if (parentIndex < 0) return;
  const parent = state.nodes[parentIndex];
  if (parent.parent_id === null || parent.parent_id === undefined) return;
  const grandSiblings = state.nodes.filter((other) => sameRef(other.parent_id, parent.parent_id));
  grandSiblings.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  const parentOrder = grandSiblings.findIndex((other) => sameRef(other.id, parent.id));
  const insertOrder = parentOrder >= 0 ? parentOrder + 2 : grandSiblings.length + 1;
  for (const other of state.nodes) {
    if (sameRef(other.parent_id, parent.parent_id) && (Number(other.sort_order) || 0) >= insertOrder) {
      other.sort_order = (Number(other.sort_order) || 0) + 1;
    }
  }
  node.parent_id = parent.parent_id;
  node.sort_order = insertOrder;
  resortSiblings(state, parent.id);
}

function applyNodeSplitParagraphMode(state: ProjectionState, entry: EntryByKind<'node.split'>) {
  const splits = Array.isArray(entry.paragraph_splits) ? entry.paragraph_splits : [];
  const now = new Date().toISOString();
  for (const split of splits) {
    const idx = findNodeIndex(state, split.paragraph_node_id);
    if (idx < 0) continue;
    const paragraph = state.nodes[idx];
    paragraph.text = '';
    paragraph.updated_at = now;
    const spans = Array.isArray(split.spans) ? split.spans : [];
    spans.forEach((span: SplitSpan, position: number) => {
      state.nodes.push({
        id: asString(span.tmp_id),
        doc_id: state.docId,
        parent_id: paragraph.id,
        sort_order: position + 1,
        depth: 0,
        address: '',
        node_type: 'TEXT',
        text: asString(span.text),
        node_title: '',
        node_note: '',
        source_position: asNumberOrNull(span.sentence_index),
        trust_level: null,
        content_hash: null,
        subtree_hash: null,
        title_chars: 0,
        text_chars: 0,
        note_chars: 0,
        created_at: now,
        updated_at: now,
        child_count: 0,
        pending_insert: true
      });
    });
    resortSiblings(state, paragraph.id);
  }
}

function applyNodeSplitSentenceMode(state: ProjectionState, entry: EntryByKind<'node.split'>) {
  const index = findNodeIndex(state, entry.target_ref ?? entry.node_id);
  if (index < 0) return;
  const node = state.nodes[index];
  const sentences = Array.isArray(entry.sentences) ? entry.sentences.filter((s: unknown) => s && String(s).trim()) : [];
  const newIds = Array.isArray(entry.new_node_ids) ? entry.new_node_ids : [];
  if (sentences.length < 2 || newIds.length !== sentences.length - 1) return;
  node.text = asString(sentences[0]);
  node.updated_at = new Date().toISOString();
  for (const other of state.nodes) {
    if (sameRef(other.parent_id, node.id) && (Number(other.sort_order) || 0) >= 1) {
      other.sort_order = (Number(other.sort_order) || 0) + sentences.length - 1;
    }
  }
  const now = new Date().toISOString();
  sentences.slice(1).forEach((sentence: unknown, position: number) => {
    state.nodes.push({
      id: asString(newIds[position]),
      doc_id: state.docId,
      parent_id: node.id,
      sort_order: position + 1,
      depth: 0,
      address: '',
      node_type: 'TEXT',
      text: asString(sentence),
      node_title: '',
      node_note: '',
      source_position: null,
      trust_level: null,
      content_hash: null,
      subtree_hash: null,
      title_chars: 0,
      text_chars: 0,
      note_chars: 0,
      created_at: now,
      updated_at: now,
      child_count: 0,
      pending_insert: true
    });
  });
  resortSiblings(state, node.id);
}

function applyNodeSplit(state: ProjectionState, entry: EntryByKind<'node.split'>) {
  if (entry.strategy === 'source_paragraphs') {
    applyNodeSplitParagraphMode(state, entry);
    return;
  }
  applyNodeSplitSentenceMode(state, entry);
}

// 与 store.mergeNodeIntoTarget 重放语义对齐：'\n\n' 连接正文、mergeNodeNotes 合并
// 标题与备注、孩子按 sort_order 序追加到 target 尾部、target 在 source 子树内则拒绝。
function applyNodeMergeInto(state: ProjectionState, entry: (NodeMergeEntry) & EditBranchEntryMeta) {
  const sourceIndex = findNodeIndex(state, entry.source_ref ?? entry.node_id);
  const targetIndex = findNodeIndex(state, entry.target_ref ?? entry.target_node_id);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const source = state.nodes[sourceIndex];
  const target = state.nodes[targetIndex];
  if (source.parent_id === null || target.parent_id === null) return;
  if (sameRef(source.id, target.id)) return;
  const descendants = descendantNodeIds(state, source.id);
  if (descendants.has(target.id)) return;
  target.text = [target.text, source.text]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
  target.node_title = mergeNodeNotes(target.node_title, source.node_title);
  target.node_note = mergeNodeNotes(target.node_note, source.node_note);
  target.updated_at = new Date().toISOString();
  const targetChildCount = state.nodes.filter((other) => sameRef(other.parent_id, target.id)).length;
  const movingChildren = state.nodes.filter((child) => sameRef(child.parent_id, source.id));
  movingChildren.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
    || compareIdForOrder(a.id, b.id));
  movingChildren.forEach((child, index) => {
    child.parent_id = target.id;
    child.sort_order = targetChildCount + index + 1;
  });
  // 被合并节点被摧毁 → 指向它的引用连带蒸发（与重放一致；孩子已搬走、其引用不动）。
  state.refs = state.refs.filter((ref) => {
    if (ref.source_type === 'node' && sameRef(ref.source_id, source.id)) return false;
    if (ref.target_type === 'node' && sameRef(ref.target_id, source.id)) return false;
    return true;
  });
  const sourceParent = source.parent_id;
  state.nodes = state.nodes.filter((node) => !sameRef(node.id, source.id));
  resortSiblings(state, sourceParent);
  resortSiblings(state, target.id);
}

function applyNodeReparent(state: ProjectionState, entry: EntryByKind<'node.reparent'>) {
  const index = findNodeIndex(state, entry.node_ref ?? entry.node_id);
  if (index < 0) return;
  const node = state.nodes[index];
  if (node.parent_id === null || node.parent_id === undefined) return;
  const newParentRef = normalizeId(entry.new_parent_ref ?? entry.new_parent_id);
  if (newParentRef === null) return;
  if (sameRef(node.id, newParentRef)) return;
  const newParentIndex = findNodeIndex(state, newParentRef);
  if (newParentIndex < 0) return;
  // Disallow moving under own descendant
  const descendants = descendantNodeIds(state, node.id);
  if (descendants.has(state.nodes[newParentIndex].id)) return;
  const oldParent = node.parent_id;
  const newSiblings = state.nodes.filter((other) => sameRef(other.parent_id, newParentRef));
  node.parent_id = newParentRef;
  node.sort_order = newSiblings.length + 1;
  resortSiblings(state, oldParent);
  resortSiblings(state, newParentRef);
}

// 与 store.moveNode{After,Before}Sibling 重放语义对齐：在 target 父级的兄弟序列
// （剔除 node 自身，按 sort_order, id 排序）里 splice 定位后统一重编号。不能把
// 「剔除 node 的下标」当 sort_order 推后阈值用——同父向后移会错一位。
function applyNodeMoveRelative(state: ProjectionState, entry: (NodeMoveBeforeAfterEntry) & EditBranchEntryMeta, placeBefore: boolean) {
  const nodeIndex = findNodeIndex(state, entry.node_ref ?? entry.node_id);
  const targetIndex = findNodeIndex(state, entry.target_ref ?? entry.target_node_id);
  if (nodeIndex < 0 || targetIndex < 0) return;
  const node = state.nodes[nodeIndex];
  const target = state.nodes[targetIndex];
  if (node.parent_id === null || target.parent_id === null) return;
  if (sameRef(node.id, target.id)) return;
  const descendants = descendantNodeIds(state, node.id);
  if (descendants.has(target.id)) return;
  const oldParent = node.parent_id;
  const newParent = target.parent_id;
  const siblings = state.nodes.filter((other) => sameRef(other.parent_id, newParent) && !sameRef(other.id, node.id));
  siblings.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
    || compareIdForOrder(a.id, b.id));
  const targetPos = siblings.findIndex((other) => sameRef(other.id, target.id));
  if (targetPos < 0) return;
  siblings.splice(placeBefore ? targetPos : targetPos + 1, 0, node);
  node.parent_id = newParent;
  for (let index = 0; index < siblings.length; index += 1) {
    siblings[index].sort_order = index + 1;
  }
  resortSiblings(state, oldParent);
}

function applyNodeMoveAfter(state: ProjectionState, entry: EntryByKind<'node.moveAfter'>) {
  applyNodeMoveRelative(state, entry, false);
}

function applyNodeMoveBefore(state: ProjectionState, entry: EntryByKind<'node.moveBefore'>) {
  applyNodeMoveRelative(state, entry, true);
}

function applyAxiomAdd(state: ProjectionState, entry: EntryByKind<'axiom.add'>) {
  const fields = entry.fields;
  const nextLabelNum = state.axioms
    .map((axiom: ProjectionAxiom) => {
      const match = String(axiom.label || '').match(/^A(\d+)$/);
      return match ? Number(match[1]) : 0;
    })
    .reduce((max: number, value: number) => Math.max(max, value), 0) + 1;
  const label = `A${nextLabelNum}`;
  state.axioms.push({
    id: asString(entry.tmp_id),
    doc_id: state.docId,
    label,
    content: asString(fields.content),
    status: asString(fields.status, 'pending'),
    node_title: asString(fields.node_title) || `事实前提 ${label}`,
    node_note: asString(fields.node_note),
    node_width: null,
    node_height: null,
    node_size_mode: 'auto' as NodeSizeMode,
    pending_insert: true
  });
}

function applyAxiomUpdate(state: ProjectionState, entry: EntryByKind<'axiom.update'>) {
  const index = findAxiomIndex(state, entry.axiom_ref ?? entry.axiom_id);
  if (index < 0) return;
  const axiom = state.axioms[index];
  const patch = entry.patch;
  if (Object.prototype.hasOwnProperty.call(patch, 'content')) axiom.content = asString(patch.content);
  if (Object.prototype.hasOwnProperty.call(patch, 'status')) axiom.status = asString(patch.status, 'pending');
  if (Object.prototype.hasOwnProperty.call(patch, 'node_title')) axiom.node_title = asString(patch.node_title);
  if (Object.prototype.hasOwnProperty.call(patch, 'node_note')) axiom.node_note = asString(patch.node_note);
}

function applyAxiomDelete(state: ProjectionState, entry: EntryByKind<'axiom.delete'>) {
  const index = findAxiomIndex(state, entry.axiom_ref ?? entry.axiom_id);
  if (index < 0) return;
  const axiom = state.axioms[index];
  state.axioms.splice(index, 1);
  state.refs = state.refs.filter((ref) => {
    if (ref.source_type === 'axiom' && sameRef(ref.source_id, axiom.id)) return false;
    if (ref.target_type === 'axiom' && sameRef(ref.target_id, axiom.id)) return false;
    return true;
  });
  // Relabel
  state.axioms.sort((a, b) => {
    const left = Number(String(a.label || '').replace(/^A/, '')) || 0;
    const right = Number(String(b.label || '').replace(/^A/, '')) || 0;
    return left - right;
  });
  for (let i = 0; i < state.axioms.length; i += 1) {
    state.axioms[i].label = `A${i + 1}`;
  }
}

function applyAxiomMove(state: ProjectionState, entry: EntryByKind<'axiom.move'>) {
  const index = findAxiomIndex(state, entry.axiom_ref ?? entry.axiom_id);
  if (index < 0) return;
  const targetIndex = entry.direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= state.axioms.length) return;
  const current = state.axioms[index];
  const target = state.axioms[targetIndex];
  const tmp = current.label;
  current.label = target.label;
  target.label = tmp;
  state.axioms.sort((a, b) => {
    const left = Number(String(a.label || '').replace(/^A/, '')) || 0;
    const right = Number(String(b.label || '').replace(/^A/, '')) || 0;
    return left - right;
  });
}

function applyRefAddAxiomToNode(state: ProjectionState, entry: EntryByKind<'ref.addAxiomToNode'>) {
  const nodeRef = normalizeId(entry.node_ref ?? entry.node_id);
  const axiomRef = normalizeId(entry.axiom_ref ?? entry.axiom_id);
  if (nodeRef === null || axiomRef === null) return;
  state.refs.push({
    id: asString(entry.tmp_id),
    source_type: 'axiom',
    source_id: axiomRef,
    target_type: 'node',
    target_id: nodeRef,
    ref_kind: 'axiom',
    note: asStringOrNull(entry.note),
    pending_insert: true
  });
}

function applyRefAddNodeToNode(state: ProjectionState, entry: EntryByKind<'ref.addNodeToNode'>) {
  const sourceRef = normalizeId(entry.source_ref ?? entry.source_node_id);
  const targetRef = normalizeId(entry.target_ref ?? entry.target_node_id);
  const refKind = String(entry.ref_kind ?? entry.kind ?? '').trim();
  if (sourceRef === null || targetRef === null || !refKind) return;
  state.refs.push({
    id: asString(entry.tmp_id),
    source_type: 'node',
    source_id: sourceRef,
    target_type: 'node',
    target_id: targetRef,
    ref_kind: refKind,
    note: asStringOrNull(entry.note),
    pending_insert: true
  });
}

function applyRefDelete(state: ProjectionState, entry: EntryByKind<'ref.delete'>) {
  const index = findRefIndex(state, entry.ref_ref ?? entry.ref_id);
  if (index < 0) return;
  state.refs.splice(index, 1);
}

// 派发：switch(kind) 让 TS 把 entry 自动 narrow 到对应 variant，传给窄签名 apply* 时无 cast。
// entity.* 走 store 重放路径上的 applyEntityEntry（带 ctx），不在投影里跑——投影只关心结构、
// 不动 entity 表，故 entity 几个 case 直接跳过。
function applyEntryToProjection(state: ProjectionState, entry: EditBranchEntry) {
  switch (entry.kind) {
    case 'node.update': return applyNodeUpdate(state, entry);
    case 'node.insert': return applyNodeInsert(state, entry);
    case 'node.delete': return applyNodeDelete(state, entry);
    case 'node.move': return applyNodeMove(state, entry);
    case 'node.promote': return applyNodePromote(state, entry);
    case 'node.split': return applyNodeSplit(state, entry);
    case 'node.mergeInto':
    case 'node.mergePrevious': return applyNodeMergeInto(state, entry);
    case 'node.reparent': return applyNodeReparent(state, entry);
    case 'node.moveBefore': return applyNodeMoveBefore(state, entry);
    case 'node.moveAfter': return applyNodeMoveAfter(state, entry);
    case 'axiom.add': return applyAxiomAdd(state, entry);
    case 'axiom.update': return applyAxiomUpdate(state, entry);
    case 'axiom.delete': return applyAxiomDelete(state, entry);
    case 'axiom.move': return applyAxiomMove(state, entry);
    case 'ref.addNodeToNode': return applyRefAddNodeToNode(state, entry);
    case 'ref.addAxiomToNode': return applyRefAddAxiomToNode(state, entry);
    case 'ref.delete': return applyRefDelete(state, entry);
    default:
      // entity.* 在投影路径里跳过；其余未知 kind 也跳过（与原 APPLIERS 表 ?? 不变）。
      return;
  }
}

function recomputeAddressesAndDepth(state: ProjectionState) {
  const childrenByParent = new Map<StableRef | 'root', ProjectionNode[]>();
  for (const node of state.nodes) {
    const parentKey = node.parent_id === null || node.parent_id === undefined ? 'root' : node.parent_id;
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    childrenByParent.get(parentKey)!.push(node);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0)
      || compareIdForOrder(a.id, b.id));
    for (let index = 0; index < list.length; index += 1) {
      list[index].sort_order = index + 1;
    }
  }
  const roots = childrenByParent.get('root') || [];
  const visit = (node: ProjectionNode, address: string, depth: number) => {
    node.address = address;
    node.depth = depth;
    const key = node.id;
    const children = childrenByParent.get(key) || [];
    node.child_count = children.length;
    for (let index = 0; index < children.length; index += 1) {
      visit(children[index], `${address}-${index + 1}`, depth + 1);
    }
  };
  for (let index = 0; index < roots.length; index += 1) {
    visit(roots[index], String(index + 1), 1);
  }
}

export function projectEditBranchDoc(base: ProjectionBase, entries: unknown = []): ProjectedDoc {
  const state = cloneState(base);
  for (const entry of activeEditBranchEntries(entries)) {
    if (!isActiveEditBranchEntry(entry)) continue;
    if (!SUPPORTED_ENTRY_KINDS.has(String(entry.kind || ''))) continue;
    try {
      applyEntryToProjection(state, entry);
    } catch {
      // entries may reference ids that were since invalidated by an earlier
      // delete; skip such entries rather than crashing the whole projection.
    }
  }
  recomputeAddressesAndDepth(state);
  return state;
}

let tmpIdCounter = 0;
export function nextTmpId(kind: unknown = 'node') {
  tmpIdCounter += 1;
  return `tmp-${kind}-${Date.now().toString(36)}-${tmpIdCounter.toString(36)}`;
}

export { isTmpId, sameRef };
