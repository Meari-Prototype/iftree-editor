import {
  compareStableIds,
  newStableId,
  sameStableId
} from '../db/ids.js';
import { normalizePositiveId } from '../db/normalizers.js';
import type {
  EditBranchRow,
  EntityBindingStatus,
  EntityLinkKind,
  EntityLinkRow,
  EntityNodeBindingRow,
  EntityRow,
  NodeRow
} from '../db/rows.js';
import {
  ensureEntityNodeSameDoc,
  entityRow,
  formatEntity,
  normalizeEntityKey,
  normalizeEntityLinkKind,
  normalizeEntityLiteral,
  normalizePositiveInteger,
  orderedEntityPair,
  requireDocId,
  requireEntityId,
  type EntityStore,
  type EntityWithDocTitle,
  type FormattedEntity
} from './shared.js';
import {
  entityStateForRead,
  nextTmpEntityId,
  formatProjectedEntity,
  type EntityEntry
} from './projection.js';

export const ENTITY_WRITE_ACTIONS = Object.freeze([
  'entity.create',
  'entity.update',
  'entity.delete',
  'entity.link',
  'entity.unlink',
  'entity.bindNode',
  'entity.ignoreNode',
  'entity.clearNodeBinding'
] as const);

type Payload = Record<string, unknown>;

function requireLiteral(payload: Payload = {}): string {
  const literal = normalizeEntityLiteral(payload.literal ?? payload.term ?? payload.text);
  if (!literal) throw new Error('entity literal is required');
  return literal;
}

function entityIdsFromPayload(payload: Payload = {}): [string, string] {
  const entityIds = Array.isArray(payload.entityIds) ? payload.entityIds : undefined;
  const entityIdsSnake = Array.isArray(payload.entity_ids) ? payload.entity_ids : undefined;
  const source = normalizePositiveInteger(
    payload.sourceEntityId
      ?? payload.source_entity_id
      ?? payload.entityAId
      ?? payload.entity_a_id
      ?? payload.leftEntityId
      ?? payload.left_entity_id
      ?? entityIds?.[0]
      ?? entityIdsSnake?.[0]
  );
  const target = normalizePositiveInteger(
    payload.targetEntityId
      ?? payload.target_entity_id
      ?? payload.entityBId
      ?? payload.entity_b_id
      ?? payload.rightEntityId
      ?? payload.right_entity_id
      ?? entityIds?.[1]
      ?? entityIdsSnake?.[1]
  );
  return orderedEntityPair(source, target);
}

function entityRefsFromPayload(payload: Payload = {}): [unknown, unknown] {
  const refs: unknown[] = Array.isArray(payload.entityIds)
    ? payload.entityIds
    : Array.isArray(payload.entity_ids)
      ? payload.entity_ids
      : [];
  const source = payload.sourceEntityId
    ?? payload.source_entity_id
    ?? payload.entityAId
    ?? payload.entity_a_id
    ?? payload.leftEntityId
    ?? payload.left_entity_id
    ?? refs[0];
  const target = payload.targetEntityId
    ?? payload.target_entity_id
    ?? payload.entityBId
    ?? payload.entity_b_id
    ?? payload.rightEntityId
    ?? payload.right_entity_id
    ?? refs[1];
  if (source === null || source === undefined || source === '') throw new Error('entity link requires sourceEntityId');
  if (target === null || target === undefined || target === '') throw new Error('entity link requires targetEntityId');
  if (String(source) === String(target)) throw new Error('entity link requires two different entities');
  return [source, target];
}

function ensureEntityExists(store: EntityStore, entityId: unknown): EntityWithDocTitle {
  const entity = entityRow(store, entityId);
  if (!entity) throw new Error(`entity not found: ${entityId}`);
  return entity;
}

interface EntityWriteOk {
  ok: true;
  action: string;
  changed: boolean;
}

interface CreateEntityResult extends EntityWriteOk {
  action: 'entity.create';
  entity: FormattedEntity;
}

function createEntity(store: EntityStore, payload: Payload = {}): CreateEntityResult {
  const docId = requireDocId(payload);
  const literal = requireLiteral(payload);
  const key = normalizeEntityKey(literal);
  const existing = store.db!.prepare(`
    SELECT e.*,
      d.title AS doc_title
    FROM entities e
    JOIN docs d ON d.id = e.doc_id
    WHERE e.doc_id = ? AND e.normalized_literal = ?
  `).get<EntityWithDocTitle>(docId, key);
  if (existing) {
    if (existing.literal !== literal) {
      store.db!.prepare('UPDATE entities SET literal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(literal, existing.id);
    }
    return {
      ok: true,
      action: 'entity.create',
      changed: existing.literal !== literal,
      entity: formatEntity(entityRow(store, existing.id) ?? undefined)
    };
  }
  const entityId = newStableId();
  store.db!.prepare(`
    INSERT INTO entities (id, doc_id, literal, normalized_literal)
    VALUES (?, ?, ?, ?)
  `).run(entityId, docId, literal, key);
  return {
    ok: true,
    action: 'entity.create',
    changed: true,
    entity: formatEntity(entityRow(store, entityId) ?? undefined)
  };
}

interface UpdateEntityResult extends EntityWriteOk {
  action: 'entity.update';
  entity: FormattedEntity;
}

function updateEntity(store: EntityStore, payload: Payload = {}): UpdateEntityResult {
  const entityId = requireEntityId(payload);
  ensureEntityExists(store, entityId);
  const literal = requireLiteral(payload);
  const key = normalizeEntityKey(literal);
  const result = store.db!.prepare(`
    UPDATE entities
    SET literal = ?,
      normalized_literal = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(literal, key, entityId);
  return {
    ok: true,
    action: 'entity.update',
    changed: result.changes > 0,
    entity: formatEntity(entityRow(store, entityId) ?? undefined)
  };
}

interface DeleteEntityResult extends EntityWriteOk {
  action: 'entity.delete';
  entityId: string;
}

function deleteEntity(store: EntityStore, payload: Payload = {}): DeleteEntityResult {
  const entityId = requireEntityId(payload);
  const result = store.db!.prepare('DELETE FROM entities WHERE id = ?').run(entityId);
  return {
    ok: true,
    action: 'entity.delete',
    changed: result.changes > 0,
    entityId
  };
}

interface LinkEntityResult extends EntityWriteOk {
  action: 'entity.link';
  link: EntityLinkRow;
}

function linkEntity(store: EntityStore, payload: Payload = {}): LinkEntityResult {
  const kind = normalizeEntityLinkKind(payload.kind ?? payload.linkKind ?? payload.link_kind ?? payload.relation);
  const [leftId, rightId] = entityIdsFromPayload(payload);
  ensureEntityExists(store, leftId);
  ensureEntityExists(store, rightId);
  const existing = store.db!.prepare(`
    SELECT * FROM entity_links
    WHERE entity_a_id = ? AND entity_b_id = ?
  `).get<EntityLinkRow>(leftId, rightId);
  if (existing) {
    if (existing.kind !== kind) {
      store.db!.prepare(`
        UPDATE entity_links
        SET kind = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(kind, existing.id);
    }
  } else {
    store.db!.prepare(`
      INSERT INTO entity_links (kind, entity_a_id, entity_b_id)
      VALUES (?, ?, ?)
    `).run(kind, leftId, rightId);
  }
  const link = store.db!.prepare(`
    SELECT * FROM entity_links
    WHERE entity_a_id = ? AND entity_b_id = ?
  `).get<EntityLinkRow>(leftId, rightId);
  if (!link) throw new Error('entity link upsert failed');
  return {
    ok: true,
    action: 'entity.link',
    changed: !existing || existing.kind !== kind,
    link: { ...link }
  };
}

interface UnlinkEntityResult extends EntityWriteOk {
  action: 'entity.unlink';
  entityIds: [string, string];
  kind: EntityLinkKind | null;
}

function unlinkEntity(store: EntityStore, payload: Payload = {}): UnlinkEntityResult {
  const [leftId, rightId] = entityIdsFromPayload(payload);
  const rawKind = payload.kind ?? payload.linkKind ?? payload.link_kind ?? payload.relation ?? '';
  const kind: EntityLinkKind | '' = rawKind ? normalizeEntityLinkKind(rawKind) : '';
  const result = kind
    ? store.db!.prepare(`
        DELETE FROM entity_links
        WHERE entity_a_id = ? AND entity_b_id = ? AND kind = ?
      `).run(leftId, rightId, kind)
    : store.db!.prepare(`
        DELETE FROM entity_links
        WHERE entity_a_id = ? AND entity_b_id = ?
      `).run(leftId, rightId);
  return {
    ok: true,
    action: 'entity.unlink',
    changed: result.changes > 0,
    entityIds: [leftId, rightId],
    kind: kind || null
  };
}

function nodeIdFromPayload(payload: Payload = {}): string {
  const rawNodeId = payload.nodeId ?? payload.node_id;
  const nodeId = normalizePositiveInteger(rawNodeId);
  if (!nodeId && rawNodeId !== null && rawNodeId !== undefined && rawNodeId !== '') {
    throw new Error('entity node binding requires an existing nodeId; pending edit-branch node ids are not accepted. Commit the node first or bind an existing base node.');
  }
  if (!nodeId) throw new Error('entity node binding requires nodeId');
  return nodeId;
}

interface StagedExtras {
  entity?: FormattedEntity | null;
  entityId?: string | unknown;
  entityIds?: [string, string];
  kind?: EntityLinkKind | null;
  nodeId?: string;
}

interface StagedResult extends EntityWriteOk {
  docId: EditBranchRow['base_doc_id'];
  editBranch: EditBranchRow;
  entity?: FormattedEntity | null;
  entityId?: string | unknown;
  entityIds?: [string, string];
  kind?: EntityLinkKind | null;
  nodeId?: string;
}

function appendEntry(store: EntityStore, branch: EditBranchRow, entry: EntityEntry): EditBranchRow {
  const next = store._appendEditBranchEntry?.(branch, entry);
  if (!next) throw new Error('edit branch append failed');
  return next as EditBranchRow;
}

function stagedResult(
  store: EntityStore,
  branch: EditBranchRow,
  action: string,
  entry: EntityEntry,
  extras: StagedExtras = {}
): StagedResult {
  const freshBranch = appendEntry(store, branch, entry);
  return {
    ok: true,
    action,
    changed: true,
    docId: freshBranch.base_doc_id,
    editBranch: { ...freshBranch },
    ...extras
  };
}

function projectedEntityForRef(store: EntityStore, branch: EditBranchRow, ref: unknown): FormattedEntity | null {
  const state = entityStateForRead(store, branch);
  const entity = state.entities.find((row) => String(row.id) === String(ref)) || null;
  return entity ? formatProjectedEntity(entity) : null;
}

function assertBranchDoc(branch: EditBranchRow, docId: unknown): void {
  if (!sameStableId(branch.base_doc_id, docId)) {
    throw new Error('entity edit branch action docId must match branch base doc');
  }
}

function assertNodeInBranchDoc(store: EntityStore, branch: EditBranchRow, nodeId: unknown): void {
  const node = store.db!
    .prepare('SELECT id, doc_id FROM nodes WHERE id = ?')
    .get<Pick<NodeRow, 'id' | 'doc_id'>>(nodeId);
  if (!node) throw new Error('node not found');
  assertBranchDoc(branch, node.doc_id);
}

function assertExistingEntityInBranchDoc(store: EntityStore, branch: EditBranchRow, ref: unknown): void {
  const id = normalizePositiveInteger(ref);
  if (!id) return;
  const entity = store.db!
    .prepare('SELECT id, doc_id FROM entities WHERE id = ?')
    .get<Pick<EntityRow, 'id' | 'doc_id'>>(id);
  if (!entity) throw new Error('entity not found');
  assertBranchDoc(branch, entity.doc_id);
}

export function stageEntityWrite(
  store: EntityStore,
  branch: EditBranchRow,
  payload: Payload = {},
  action: string = ''
): StagedResult {
  if (action === 'entity.create') {
    // docId 与 axiom/ref 对齐：以已建好的编辑分支为准（顶层 baseDocId 经 beginEditBranch 已进
    // branch.base_doc_id）；payload 若显式给 docId 仍由 assertBranchDoc 校验与分支一致、防跨档误写。
    const docId = normalizePositiveInteger(payload.docId ?? payload.doc_id) ?? branch.base_doc_id;
    assertBranchDoc(branch, docId);
    const literal = requireLiteral(payload);
    const tmpId = nextTmpEntityId();
    const doc = store.db!
      .prepare('SELECT title FROM docs WHERE id = ?')
      .get<{ title: string }>(docId);
    const entry: EntityEntry = {
      kind: 'entity.create',
      tmp_id: tmpId,
      fields: {
        doc_id: docId,
        doc_title: doc?.title || '',
        literal,
        normalized_literal: normalizeEntityKey(literal)
      }
    };
    const freshBranch = appendEntry(store, branch, entry);
    return {
      ok: true,
      action,
      changed: true,
      docId: freshBranch.base_doc_id,
      editBranch: { ...freshBranch },
      entity: projectedEntityForRef(store, freshBranch, tmpId)
    };
  }

  if (action === 'entity.update') {
    const entityId = payload.entityId ?? payload.entity_id ?? payload.id;
    if (entityId === null || entityId === undefined || entityId === '') throw new Error('entity.update requires entityId');
    assertExistingEntityInBranchDoc(store, branch, entityId);
    const literal = requireLiteral(payload);
    return stagedResult(store, branch, action, {
      kind: 'entity.update',
      entity_ref: String(entityId),
      literal,
      normalized_literal: normalizeEntityKey(literal)
    });
  }

  if (action === 'entity.delete') {
    const entityId = payload.entityId ?? payload.entity_id ?? payload.id;
    if (entityId === null || entityId === undefined || entityId === '') throw new Error('entity.delete requires entityId');
    assertExistingEntityInBranchDoc(store, branch, entityId);
    return stagedResult(store, branch, action, {
      kind: 'entity.delete',
      entity_ref: String(entityId)
    }, { entityId });
  }

  if (action === 'entity.link' || action === 'entity.unlink') {
    const [leftId, rightId] = entityRefsFromPayload(payload);
    assertExistingEntityInBranchDoc(store, branch, leftId);
    const rawKind = payload.kind ?? payload.linkKind ?? payload.link_kind ?? payload.relation ?? '';
    const kind: EntityLinkKind | '' = action === 'entity.link' || rawKind ? normalizeEntityLinkKind(rawKind) : '';
    const leftStr = String(leftId);
    const rightStr = String(rightId);
    const entry: EntityEntry = action === 'entity.link'
      ? {
          kind: 'entity.link',
          source_ref: leftStr,
          target_ref: rightStr,
          link_kind: (kind || null) as EntityLinkKind
        }
      : {
          kind: 'entity.unlink',
          source_ref: leftStr,
          target_ref: rightStr,
          link_kind: kind || null
        };
    return stagedResult(store, branch, action, entry, {
      entityIds: [leftStr, rightStr],
      kind: kind || null
    });
  }

  if (action === 'entity.bindNode' || action === 'entity.ignoreNode' || action === 'entity.clearNodeBinding') {
    const entityId = payload.entityId ?? payload.entity_id ?? payload.id;
    if (entityId === null || entityId === undefined || entityId === '') throw new Error(`${action} requires entityId`);
    const nodeId = nodeIdFromPayload(payload);
    assertNodeInBranchDoc(store, branch, nodeId);
    const entry: EntityEntry = action === 'entity.clearNodeBinding'
      ? {
          kind: 'entity.clearNodeBinding',
          entity_ref: String(entityId),
          node_id: nodeId
        }
      : {
          kind: action,
          entity_ref: String(entityId),
          node_id: nodeId
        };
    return stagedResult(store, branch, action, entry, { entityId, nodeId });
  }

  throw new Error(`Unhandled entity edit branch action: ${action}`);
}

interface SetBindingResult extends EntityWriteOk {
  action: 'entity.bindNode' | 'entity.ignoreNode';
  entityId: string;
  nodeId: string;
  status: EntityBindingStatus;
}

function setNodeBinding(store: EntityStore, payload: Payload = {}, status: EntityBindingStatus = 'bound'): SetBindingResult {
  const entityId = requireEntityId(payload);
  const nodeId = nodeIdFromPayload(payload);
  ensureEntityNodeSameDoc(store, entityId, nodeId);
  const existing = store.db!.prepare(`
    SELECT * FROM entity_node_bindings
    WHERE entity_id = ? AND node_id = ?
  `).get<EntityNodeBindingRow>(entityId, nodeId);
  store.db!.prepare(`
    INSERT INTO entity_node_bindings (entity_id, node_id, status)
    VALUES (?, ?, ?)
    ON CONFLICT(entity_id, node_id) DO UPDATE SET
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `).run(entityId, nodeId, status);
  return {
    ok: true,
    action: status === 'bound' ? 'entity.bindNode' : 'entity.ignoreNode',
    changed: !existing || existing.status !== status,
    entityId,
    nodeId,
    status
  };
}

interface ClearBindingResult extends EntityWriteOk {
  action: 'entity.clearNodeBinding';
  entityId: string;
  nodeId: string;
}

function clearNodeBinding(store: EntityStore, payload: Payload = {}): ClearBindingResult {
  const entityId = requireEntityId(payload);
  const nodeId = nodeIdFromPayload(payload);
  const result = store.db!.prepare(`
    DELETE FROM entity_node_bindings
    WHERE entity_id = ? AND node_id = ?
  `).run(entityId, nodeId);
  return {
    ok: true,
    action: 'entity.clearNodeBinding',
    changed: result.changes > 0,
    entityId,
    nodeId
  };
}

export type EntityWriteResult =
  | CreateEntityResult
  | UpdateEntityResult
  | DeleteEntityResult
  | LinkEntityResult
  | UnlinkEntityResult
  | SetBindingResult
  | ClearBindingResult;

export function runEntityWrite(store: EntityStore, payload: Payload = {}, action: string = ''): EntityWriteResult {
  if (action === 'entity.create') return createEntity(store, payload);
  if (action === 'entity.update') return updateEntity(store, payload);
  if (action === 'entity.delete') return deleteEntity(store, payload);
  if (action === 'entity.link') return linkEntity(store, payload);
  if (action === 'entity.unlink') return unlinkEntity(store, payload);
  if (action === 'entity.bindNode') return setNodeBinding(store, payload, 'bound');
  if (action === 'entity.ignoreNode') return setNodeBinding(store, payload, 'ignored');
  if (action === 'entity.clearNodeBinding') return clearNodeBinding(store, payload);
  throw new Error(`Unhandled entity write action: ${action}`);
}

// 提交时把编辑分支 diff 里的 entity 条目实化到主库——从 store.applyEditBranchDiffEntries 下沉
// （解耦第 4 步：entity 落库 SQL 单点收口到本模块，store 提交循环只调度、不再重写 SQL）。
// ctx 提供 store 提交循环的横切解析设施：resolveEntityId/resolveNodeId（tmp-id → 真实 id）、
// entityIdByTmp（新建 entity 的 tmp→真实 映射，回填供后续条目引用）、baseDocId。
// 反映现实：store 这边 resolve 函数当 ref 是 null/undefined 时直接返回 null（非 throw 的容错），
// baseDocId 也允许 null（branch.base_doc_id 走 normalizePositiveId 出来理论上不会 null，
// 但 store 没强制断言；entities 内部 normalizePositiveId(fields.doc_id || baseDocId) 能处理）。
// applyEntityEntry 内每个 case 自己 narrow（如 link/unlink 的 !leftId 检查）。
export interface ApplyEntityEntryCtx {
  resolveEntityId: (ref: unknown) => string | null;
  resolveNodeId: (ref: unknown) => string | null;
  entityIdByTmp: Map<string, string>;
  baseDocId: string | null;
}

export function applyEntityEntry(store: EntityStore, entry: EntityEntry, ctx: ApplyEntityEntryCtx): void {
  const { resolveEntityId, resolveNodeId, entityIdByTmp, baseDocId } = ctx;
  const normalizeKey = (value: unknown = ''): string => String(value || '').trim().toLocaleLowerCase();
  const orderedPair = (left: unknown, right: unknown): [string, string] => {
    const leftId = resolveEntityId(left);
    const rightId = resolveEntityId(right);
    if (!leftId || !rightId || sameStableId(leftId, rightId)) throw new Error('apply: entity link requires two different entity ids');
    return compareStableIds(leftId, rightId) <= 0 ? [leftId, rightId] : [rightId, leftId];
  };
  switch (entry.kind) {
    case 'entity.create': {
      const fields = entry.fields;
      const docId = normalizePositiveId(fields.doc_id || baseDocId);
      const literal = String(fields.literal || '').trim();
      const key = normalizeKey(fields.normalized_literal || literal);
      if (!literal || !key || !docId) throw new Error('apply: invalid entity.create entry');
      let row = store.db!
        .prepare('SELECT id FROM entities WHERE doc_id = ? AND normalized_literal = ?')
        .get<Pick<EntityRow, 'id'>>(docId, key);
      if (row) {
        store.db!.prepare('UPDATE entities SET literal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(literal, row.id);
      } else {
        store.db!.prepare(`
          INSERT INTO entities (id, doc_id, literal, normalized_literal)
          VALUES (?, ?, ?, ?)
        `).run(newStableId(), docId, literal, key);
        row = store.db!
          .prepare('SELECT id FROM entities WHERE doc_id = ? AND normalized_literal = ?')
          .get<Pick<EntityRow, 'id'>>(docId, key);
      }
      if (entry.tmp_id && row) entityIdByTmp.set(entry.tmp_id, row.id);
      break;
    }
    case 'entity.update': {
      const entityId = resolveEntityId(entry.entity_ref);
      const literal = String(entry.literal || '').trim();
      const key = normalizeKey(entry.normalized_literal || literal);
      if (!literal || !key) throw new Error('apply: invalid entity.update entry');
      store.db!.prepare(`
        UPDATE entities
        SET literal = ?,
          normalized_literal = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(literal, key, entityId);
      break;
    }
    case 'entity.delete': {
      store.db!.prepare('DELETE FROM entities WHERE id = ?').run(resolveEntityId(entry.entity_ref));
      break;
    }
    case 'entity.link': {
      const [leftId, rightId] = orderedPair(entry.source_ref, entry.target_ref);
      const kind: EntityLinkKind | '' = entry.link_kind === 'synonym' ? 'synonym' : entry.link_kind === 'related' ? 'related' : '';
      if (!kind) throw new Error('apply: invalid entity.link kind');
      const existing = store.db!
        .prepare('SELECT id FROM entity_links WHERE entity_a_id = ? AND entity_b_id = ?')
        .get<Pick<EntityLinkRow, 'id'>>(leftId, rightId);
      if (existing) {
        store.db!.prepare(`
          UPDATE entity_links
          SET kind = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(kind, existing.id);
      } else {
        store.db!.prepare(`
          INSERT INTO entity_links (kind, entity_a_id, entity_b_id)
          VALUES (?, ?, ?)
        `).run(kind, leftId, rightId);
      }
      break;
    }
    case 'entity.unlink': {
      const [leftId, rightId] = orderedPair(entry.source_ref, entry.target_ref);
      if (entry.link_kind) {
        store.db!.prepare(`
          DELETE FROM entity_links
          WHERE entity_a_id = ? AND entity_b_id = ? AND kind = ?
        `).run(leftId, rightId, entry.link_kind);
      } else {
        store.db!.prepare(`
          DELETE FROM entity_links
          WHERE entity_a_id = ? AND entity_b_id = ?
        `).run(leftId, rightId);
      }
      break;
    }
    case 'entity.bindNode':
    case 'entity.ignoreNode': {
      const entityId = resolveEntityId(entry.entity_ref);
      const nodeId = resolveNodeId(entry.node_id);
      const status: EntityBindingStatus = entry.kind === 'entity.bindNode' ? 'bound' : 'ignored';
      store.db!.prepare(`
        INSERT INTO entity_node_bindings (entity_id, node_id, status)
        VALUES (?, ?, ?)
        ON CONFLICT(entity_id, node_id) DO UPDATE SET
          status = excluded.status,
          updated_at = CURRENT_TIMESTAMP
      `).run(entityId, nodeId, status);
      break;
    }
    case 'entity.clearNodeBinding': {
      store.db!.prepare(`
        DELETE FROM entity_node_bindings
        WHERE entity_id = ? AND node_id = ?
      `).run(resolveEntityId(entry.entity_ref), resolveNodeId(entry.node_id));
      break;
    }
    default: {
      const exhaustive: never = entry;
      throw new Error(`Unhandled entity edit branch entry kind: ${(exhaustive as { kind?: string }).kind ?? ''}`);
    }
  }
}
