import { nextTmpId } from '../edit-branch-projection.js';
import { compareStableIds } from '../db/ids.js';
import type {
  EntityBindingStatus,
  EntityLinkKind,
  EntityLinkRow,
  EntityNodeBindingRow,
  EntityRow
} from '../db/rows.js';
import {
  formatEntity,
  normalizeEntityKey,
  normalizePositiveInteger,
  type EntityState,
  type EntityStore,
  type FormattedEntity,
  type ProjectedEntity,
  type ProjectedEntityBinding,
  type ProjectedEntityLink
} from './shared.js';

export const ENTITY_ENTRY_KINDS = Object.freeze([
  'entity.create',
  'entity.update',
  'entity.delete',
  'entity.link',
  'entity.unlink',
  'entity.bindNode',
  'entity.ignoreNode',
  'entity.clearNodeBinding'
] as const);

export type EntityEntryKind = typeof ENTITY_ENTRY_KINDS[number];

// 编辑分支 diff 里 entity.* 条目的形状。每种 kind 携带不同字段（tmp_id 仅 create 用，
// entity_ref 在 update/delete/bind/ignore/clear 用，source_ref/target_ref 在 link/unlink 用）。
export type EntityEntry =
  | {
      kind: 'entity.create';
      tmp_id: string;
      createdAt?: string;
      fields: {
        doc_id: string;
        doc_title?: string;
        literal: string;
        normalized_literal?: string;
      };
    }
  | {
      kind: 'entity.update';
      entity_ref: string;
      literal: string;
      normalized_literal?: string;
      createdAt?: string;
    }
  | {
      kind: 'entity.delete';
      entity_ref: string;
      createdAt?: string;
    }
  | {
      kind: 'entity.link';
      source_ref: string;
      target_ref: string;
      link_kind: EntityLinkKind;
      createdAt?: string;
    }
  | {
      kind: 'entity.unlink';
      source_ref: string;
      target_ref: string;
      link_kind?: EntityLinkKind | null;
      createdAt?: string;
    }
  | {
      kind: 'entity.bindNode' | 'entity.ignoreNode';
      entity_ref: string;
      node_id: string;
      createdAt?: string;
    }
  | {
      kind: 'entity.clearNodeBinding';
      entity_ref: string;
      node_id: string;
      createdAt?: string;
    };

export function isEntityEntryKind(kind: unknown = ''): kind is EntityEntryKind {
  return (ENTITY_ENTRY_KINDS as readonly string[]).includes(String(kind || ''));
}

export function nextTmpEntityId(): string {
  return nextTmpId('entity');
}

function isTmpEntityId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('tmp-entity-');
}

function clone<T>(row: T): T {
  return row ? { ...(row as object) } as T : row;
}

export function baseEntityState(store: EntityStore): EntityState {
  return {
    entities: store.db!.prepare(`
      SELECT e.*,
        d.title AS doc_title
      FROM entities e
      JOIN docs d ON d.id = e.doc_id
      ORDER BY e.doc_id, e.literal, e.id
    `).all<ProjectedEntity>().map(clone),
    links: store.db!
      .prepare('SELECT * FROM entity_links ORDER BY id')
      .all<EntityLinkRow>()
      .map<ProjectedEntityLink>((row) => ({ ...row })),
    bindings: store.db!
      .prepare('SELECT * FROM entity_node_bindings ORDER BY id')
      .all<EntityNodeBindingRow>()
      .map<ProjectedEntityBinding>((row) => ({ ...row }))
  };
}

export function resolveEntityRef(ref: unknown, tmpMap: Map<string, string> = new Map()): string | null {
  if (ref === null || ref === undefined || ref === '') return null;
  if (isTmpEntityId(ref)) return tmpMap.get(ref) || ref;
  const id = normalizePositiveInteger(ref);
  return id || null;
}

function sameRef(left: unknown, right: unknown): boolean {
  if (isTmpEntityId(left) || isTmpEntityId(right)) return String(left) === String(right);
  return String(left) === String(right);
}

function entityIndex(state: EntityState, ref: unknown): number {
  const resolved = resolveEntityRef(ref);
  return state.entities.findIndex((entity) => sameRef(entity.id, resolved));
}

function entityByRef(state: EntityState, ref: unknown): ProjectedEntity | null {
  const index = entityIndex(state, ref);
  return index >= 0 ? state.entities[index] : null;
}

function orderPair(left: unknown, right: unknown): [string, string] | null {
  const leftValue = resolveEntityRef(left);
  const rightValue = resolveEntityRef(right);
  if (leftValue === null || rightValue === null || sameRef(leftValue, rightValue)) return null;
  return compareStableIds(leftValue, rightValue) <= 0 ? [leftValue, rightValue] : [rightValue, leftValue];
}

function linkIndex(state: EntityState, left: unknown, right: unknown): number {
  const pair = orderPair(left, right);
  if (!pair) return -1;
  return state.links.findIndex((link) => (
    sameRef(link.entity_a_id, pair[0]) && sameRef(link.entity_b_id, pair[1])
  ));
}

function bindingIndex(state: EntityState, entityRef: unknown, nodeId: unknown): number {
  const entityId = resolveEntityRef(entityRef);
  const normalizedNodeId = normalizePositiveInteger(nodeId);
  if (entityId === null || !normalizedNodeId) return -1;
  return state.bindings.findIndex((binding) => (
    sameRef(binding.entity_id, entityId) && sameRef(binding.node_id, normalizedNodeId)
  ));
}

export function applyEntityEntry(state: EntityState, entry: EntityEntry): EntityState {
  if (entry.kind === 'entity.create') {
    const fields = entry.fields;
    const literal = String(fields.literal || '').trim();
    const key = normalizeEntityKey(literal);
    const docId = normalizePositiveInteger(fields.doc_id);
    if (!literal || !key || !docId) return state;
    const existing = state.entities.find((entity) => (
      sameRef(entity.doc_id, docId)
      && entity.normalized_literal === key
    ));
    if (existing) {
      existing.literal = literal;
      existing.updated_at = entry.createdAt || new Date().toISOString();
      return state;
    }
    state.entities.push({
      id: entry.tmp_id,
      doc_id: docId,
      doc_title: fields.doc_title || '',
      literal,
      normalized_literal: key,
      created_at: entry.createdAt || new Date().toISOString(),
      updated_at: entry.createdAt || new Date().toISOString(),
      pending_insert: true
    } as ProjectedEntity);
    return state;
  }

  if (entry.kind === 'entity.update') {
    const entity = entityByRef(state, entry.entity_ref);
    if (!entity) return state;
    const literal = String(entry.literal || '').trim();
    if (!literal) return state;
    entity.literal = literal;
    entity.normalized_literal = normalizeEntityKey(literal);
    entity.updated_at = entry.createdAt || new Date().toISOString();
    return state;
  }

  if (entry.kind === 'entity.delete') {
    const entity = entityByRef(state, entry.entity_ref);
    if (!entity) return state;
    state.entities = state.entities.filter((row) => !sameRef(row.id, entity.id));
    state.links = state.links.filter((link) => !sameRef(link.entity_a_id, entity.id) && !sameRef(link.entity_b_id, entity.id));
    state.bindings = state.bindings.filter((binding) => !sameRef(binding.entity_id, entity.id));
    return state;
  }

  if (entry.kind === 'entity.link') {
    const pair = orderPair(entry.source_ref, entry.target_ref);
    if (!pair) return state;
    const index = linkIndex(state, pair[0], pair[1]);
    if (index >= 0) {
      state.links[index].kind = entry.link_kind;
      state.links[index].updated_at = entry.createdAt || new Date().toISOString();
    } else {
      state.links.push({
        id: `tmp-link-${state.links.length + 1}`,
        kind: entry.link_kind,
        entity_a_id: pair[0],
        entity_b_id: pair[1],
        created_at: entry.createdAt || new Date().toISOString(),
        updated_at: entry.createdAt || new Date().toISOString(),
        pending_insert: true
      });
    }
    return state;
  }

  if (entry.kind === 'entity.unlink') {
    const pair = orderPair(entry.source_ref, entry.target_ref);
    if (!pair) return state;
    state.links = state.links.filter((link) => {
      const samePair = sameRef(link.entity_a_id, pair[0]) && sameRef(link.entity_b_id, pair[1]);
      if (!samePair) return true;
      return !!entry.link_kind && link.kind !== entry.link_kind;
    });
    return state;
  }

  if (entry.kind === 'entity.bindNode' || entry.kind === 'entity.ignoreNode') {
    const entity = entityByRef(state, entry.entity_ref);
    const nodeId = normalizePositiveInteger(entry.node_id);
    if (!entity || !nodeId) return state;
    const status: EntityBindingStatus = entry.kind === 'entity.bindNode' ? 'bound' : 'ignored';
    const index = bindingIndex(state, entity.id, nodeId);
    if (index >= 0) {
      state.bindings[index].status = status;
      state.bindings[index].updated_at = entry.createdAt || new Date().toISOString();
    } else {
      state.bindings.push({
        id: `tmp-binding-${state.bindings.length + 1}`,
        entity_id: entity.id as EntityRow['id'],
        node_id: nodeId,
        status,
        created_at: entry.createdAt || new Date().toISOString(),
        updated_at: entry.createdAt || new Date().toISOString(),
        pending_insert: true
      });
    }
    return state;
  }

  if (entry.kind === 'entity.clearNodeBinding') {
    const entity = entityByRef(state, entry.entity_ref);
    const nodeId = normalizePositiveInteger(entry.node_id);
    if (!entity || !nodeId) return state;
    state.bindings = state.bindings.filter((binding) => (
      !(sameRef(binding.entity_id, entity.id) && sameRef(binding.node_id, nodeId))
    ));
    return state;
  }

  return state;
}

export function projectEntityState(base: EntityState, entries: ReadonlyArray<EntityEntry | { kind?: unknown }> = []): EntityState {
  const state: EntityState = {
    entities: (base.entities || []).map(clone),
    links: (base.links || []).map(clone),
    bindings: (base.bindings || []).map(clone)
  };
  for (const entry of entries) {
    if (!entry || !isEntityEntryKind(entry.kind)) continue;
    applyEntityEntry(state, entry as EntityEntry);
  }
  return state;
}

import type { EditBranchRow } from '../db/rows.js';

export function entityStateForRead(store: EntityStore, branch: EditBranchRow | null = null): EntityState {
  const base = baseEntityState(store);
  if (!branch) return base;
  const diff = JSON.parse(branch.diff || '{}') as { entries?: unknown[] };
  const entries = Array.isArray(diff.entries) ? (diff.entries as Array<EntityEntry | { kind?: unknown }>) : [];
  return projectEntityState(base, entries);
}

export function formatProjectedEntity(
  row: Partial<ProjectedEntity> = {},
  extras: Record<string, unknown> = {}
): FormattedEntity {
  return formatEntity(row, {
    pendingInsert: row.pending_insert === true,
    ...extras
  });
}
