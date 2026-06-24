// @ts-nocheck
import { nextTmpId } from '../edit-branch-projection.js';
import { compareStableIds } from '../db/ids.js';
import {
  formatEntity,
  normalizeEntityKey,
  normalizePositiveInteger
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
]);

export function isEntityEntryKind(kind = '') {
  return ENTITY_ENTRY_KINDS.includes(String(kind || ''));
}

export function nextTmpEntityId() {
  return nextTmpId('entity');
}

function isTmpEntityId(value) {
  return typeof value === 'string' && value.startsWith('tmp-entity-');
}

function clone(row) {
  return row ? { ...row } : row;
}

export function baseEntityState(store) {
  return {
    entities: store.db.prepare(`
      SELECT e.*,
        d.title AS doc_title
      FROM entities e
      JOIN docs d ON d.id = e.doc_id
      ORDER BY e.doc_id, e.literal, e.id
    `).all().map(clone),
    links: store.db.prepare('SELECT * FROM entity_links ORDER BY id').all().map(clone),
    bindings: store.db.prepare('SELECT * FROM entity_node_bindings ORDER BY id').all().map(clone)
  };
}

export function resolveEntityRef(ref, tmpMap = new Map()) {
  if (ref === null || ref === undefined || ref === '') return null;
  if (isTmpEntityId(ref)) return tmpMap.get(ref) || ref;
  const id = normalizePositiveInteger(ref);
  return id || null;
}

function sameRef(left, right) {
  if (isTmpEntityId(left) || isTmpEntityId(right)) return String(left) === String(right);
  return String(left) === String(right);
}

function entityIndex(state, ref) {
  const resolved = resolveEntityRef(ref);
  return state.entities.findIndex((entity) => sameRef(entity.id, resolved));
}

function entityByRef(state, ref) {
  const index = entityIndex(state, ref);
  return index >= 0 ? state.entities[index] : null;
}

function orderPair(left, right) {
  const leftValue = resolveEntityRef(left);
  const rightValue = resolveEntityRef(right);
  if (leftValue === null || rightValue === null || sameRef(leftValue, rightValue)) return null;
  return compareStableIds(leftValue, rightValue) <= 0 ? [leftValue, rightValue] : [rightValue, leftValue];
}

function linkIndex(state, left, right) {
  const pair = orderPair(left, right);
  if (!pair) return -1;
  return state.links.findIndex((link) => (
    sameRef(link.entity_a_id, pair[0]) && sameRef(link.entity_b_id, pair[1])
  ));
}

function bindingIndex(state, entityRef, nodeId) {
  const entityId = resolveEntityRef(entityRef);
  const normalizedNodeId = normalizePositiveInteger(nodeId);
  if (entityId === null || !normalizedNodeId) return -1;
  return state.bindings.findIndex((binding) => (
    sameRef(binding.entity_id, entityId) && sameRef(binding.node_id, normalizedNodeId)
  ));
}

export function applyEntityEntry(state, entry = {}) {
  if (entry.kind === 'entity.create') {
    const fields = entry.fields || {};
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
    });
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
      return entry.link_kind && link.kind !== entry.link_kind;
    });
    return state;
  }

  if (entry.kind === 'entity.bindNode' || entry.kind === 'entity.ignoreNode') {
    const entity = entityByRef(state, entry.entity_ref);
    const nodeId = normalizePositiveInteger(entry.node_id);
    if (!entity || !nodeId) return state;
    const status = entry.kind === 'entity.bindNode' ? 'bound' : 'ignored';
    const index = bindingIndex(state, entity.id, nodeId);
    if (index >= 0) {
      state.bindings[index].status = status;
      state.bindings[index].updated_at = entry.createdAt || new Date().toISOString();
    } else {
      state.bindings.push({
        id: `tmp-binding-${state.bindings.length + 1}`,
        entity_id: entity.id,
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

export function projectEntityState(base, entries = []) {
  const state = {
    entities: (base.entities || []).map(clone),
    links: (base.links || []).map(clone),
    bindings: (base.bindings || []).map(clone)
  };
  for (const entry of entries) {
    if (!isEntityEntryKind(entry?.kind)) continue;
    applyEntityEntry(state, entry);
  }
  return state;
}

export function entityStateForRead(store, branch = null) {
  const base = baseEntityState(store);
  if (!branch) return base;
  const diff = JSON.parse(branch.diff || '{}');
  const entries = Array.isArray(diff.entries) ? diff.entries : [];
  return projectEntityState(base, entries);
}

export function formatProjectedEntity(row = {}, extras = {}) {
  return formatEntity(row, {
    pendingInsert: row.pending_insert === true,
    ...extras
  });
}
