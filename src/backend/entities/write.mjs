import {
  newStableId,
  sameStableId
} from '../db/ids.mjs';
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
  requireEntityId
} from './shared.mjs';
import {
  entityStateForRead,
  nextTmpEntityId,
  formatProjectedEntity
} from './projection.mjs';

export const ENTITY_WRITE_ACTIONS = Object.freeze([
  'entity.create',
  'entity.update',
  'entity.delete',
  'entity.link',
  'entity.unlink',
  'entity.bindNode',
  'entity.ignoreNode',
  'entity.clearNodeBinding'
]);

function requireLiteral(payload = {}) {
  const literal = normalizeEntityLiteral(payload.literal ?? payload.term ?? payload.text);
  if (!literal) throw new Error('entity literal is required');
  return literal;
}

function entityIdsFromPayload(payload = {}) {
  const source = normalizePositiveInteger(
    payload.sourceEntityId
      ?? payload.source_entity_id
      ?? payload.entityAId
      ?? payload.entity_a_id
      ?? payload.leftEntityId
      ?? payload.left_entity_id
      ?? (Array.isArray(payload.entityIds) ? payload.entityIds[0] : null)
      ?? (Array.isArray(payload.entity_ids) ? payload.entity_ids[0] : null)
  );
  const target = normalizePositiveInteger(
    payload.targetEntityId
      ?? payload.target_entity_id
      ?? payload.entityBId
      ?? payload.entity_b_id
      ?? payload.rightEntityId
      ?? payload.right_entity_id
      ?? (Array.isArray(payload.entityIds) ? payload.entityIds[1] : null)
      ?? (Array.isArray(payload.entity_ids) ? payload.entity_ids[1] : null)
  );
  return orderedEntityPair(source, target);
}

function entityRefsFromPayload(payload = {}) {
  const refs = Array.isArray(payload.entityIds)
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

function ensureEntityExists(store, entityId) {
  const entity = entityRow(store, entityId);
  if (!entity) throw new Error(`entity not found: ${entityId}`);
  return entity;
}

function createEntity(store, payload = {}) {
  const docId = requireDocId(payload);
  const literal = requireLiteral(payload);
  const key = normalizeEntityKey(literal);
  const existing = store.db.prepare(`
    SELECT e.*,
      d.title AS doc_title
    FROM entities e
    JOIN docs d ON d.id = e.doc_id
    WHERE e.doc_id = ? AND e.normalized_literal = ?
  `).get(docId, key);
  if (existing) {
    if (existing.literal !== literal) {
      store.db.prepare('UPDATE entities SET literal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(literal, existing.id);
    }
    return {
      ok: true,
      action: 'entity.create',
      changed: existing.literal !== literal,
      entity: formatEntity(entityRow(store, existing.id))
    };
  }
  const entityId = newStableId();
  store.db.prepare(`
    INSERT INTO entities (id, doc_id, literal, normalized_literal)
    VALUES (?, ?, ?, ?)
  `).run(entityId, docId, literal, key);
  return {
    ok: true,
    action: 'entity.create',
    changed: true,
    entity: formatEntity(entityRow(store, entityId))
  };
}

function updateEntity(store, payload = {}) {
  const entityId = requireEntityId(payload);
  ensureEntityExists(store, entityId);
  const literal = requireLiteral(payload);
  const key = normalizeEntityKey(literal);
  const result = store.db.prepare(`
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
    entity: formatEntity(entityRow(store, entityId))
  };
}

function deleteEntity(store, payload = {}) {
  const entityId = requireEntityId(payload);
  const result = store.db.prepare('DELETE FROM entities WHERE id = ?').run(entityId);
  return {
    ok: true,
    action: 'entity.delete',
    changed: result.changes > 0,
    entityId
  };
}

function linkEntity(store, payload = {}) {
  const kind = normalizeEntityLinkKind(payload.kind ?? payload.linkKind ?? payload.link_kind ?? payload.relation);
  const [leftId, rightId] = entityIdsFromPayload(payload);
  ensureEntityExists(store, leftId);
  ensureEntityExists(store, rightId);
  const existing = store.db.prepare(`
    SELECT * FROM entity_links
    WHERE entity_a_id = ? AND entity_b_id = ?
  `).get(leftId, rightId);
  if (existing) {
    if (existing.kind !== kind) {
      store.db.prepare(`
        UPDATE entity_links
        SET kind = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(kind, existing.id);
    }
  } else {
    store.db.prepare(`
      INSERT INTO entity_links (kind, entity_a_id, entity_b_id)
      VALUES (?, ?, ?)
    `).run(kind, leftId, rightId);
  }
  const link = store.db.prepare(`
    SELECT * FROM entity_links
    WHERE entity_a_id = ? AND entity_b_id = ?
  `).get(leftId, rightId);
  return {
    ok: true,
    action: 'entity.link',
    changed: !existing || existing.kind !== kind,
    link: { ...link }
  };
}

function unlinkEntity(store, payload = {}) {
  const [leftId, rightId] = entityIdsFromPayload(payload);
  const rawKind = payload.kind ?? payload.linkKind ?? payload.link_kind ?? payload.relation ?? '';
  const kind = rawKind ? normalizeEntityLinkKind(rawKind) : '';
  const result = kind
    ? store.db.prepare(`
        DELETE FROM entity_links
        WHERE entity_a_id = ? AND entity_b_id = ? AND kind = ?
      `).run(leftId, rightId, kind)
    : store.db.prepare(`
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

function nodeIdFromPayload(payload = {}) {
  const nodeId = normalizePositiveInteger(payload.nodeId ?? payload.node_id);
  if (!nodeId) throw new Error('entity node binding requires nodeId');
  return nodeId;
}

function stagedResult(store, branch, action, entry, extras = {}) {
  const freshBranch = store._appendEditBranchEntry(branch, entry);
  return {
    ok: true,
    action,
    changed: true,
    docId: freshBranch.base_doc_id,
    editBranch: { ...freshBranch },
    ...extras
  };
}

function projectedEntityForRef(store, branch, ref) {
  const state = entityStateForRead(store, branch);
  const entity = state.entities.find((row) => String(row.id) === String(ref)) || null;
  return entity ? formatProjectedEntity(entity) : null;
}

function assertBranchDoc(branch, docId) {
  if (!sameStableId(branch.base_doc_id, docId)) {
    throw new Error('entity edit branch action docId must match branch base doc');
  }
}

function assertNodeInBranchDoc(store, branch, nodeId) {
  const node = store.db.prepare('SELECT id, doc_id FROM nodes WHERE id = ?').get(nodeId);
  if (!node) throw new Error('node not found');
  assertBranchDoc(branch, node.doc_id);
}

function assertExistingEntityInBranchDoc(store, branch, ref) {
  const id = normalizePositiveInteger(ref);
  if (!id) return;
  const entity = store.db.prepare('SELECT id, doc_id FROM entities WHERE id = ?').get(id);
  if (!entity) throw new Error('entity not found');
  assertBranchDoc(branch, entity.doc_id);
}

export function stageEntityWrite(store, branch, payload = {}, action = '') {
  if (action === 'entity.create') {
    const docId = requireDocId(payload);
    assertBranchDoc(branch, docId);
    const literal = requireLiteral(payload);
    const tmpId = nextTmpEntityId();
    const doc = store.db.prepare('SELECT title FROM docs WHERE id = ?').get(docId);
    const entry = {
      kind: 'entity.create',
      tmp_id: tmpId,
      fields: {
        doc_id: docId,
        doc_title: doc?.title || '',
        literal,
        normalized_literal: normalizeEntityKey(literal)
      }
    };
    const freshBranch = store._appendEditBranchEntry(branch, entry);
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
      entity_ref: entityId,
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
      entity_ref: entityId
    }, { entityId });
  }

  if (action === 'entity.link' || action === 'entity.unlink') {
    const [leftId, rightId] = entityRefsFromPayload(payload);
    assertExistingEntityInBranchDoc(store, branch, leftId);
    const rawKind = payload.kind ?? payload.linkKind ?? payload.link_kind ?? payload.relation ?? '';
    const kind = action === 'entity.link' || rawKind ? normalizeEntityLinkKind(rawKind) : '';
    return stagedResult(store, branch, action, {
      kind: action,
      link_kind: kind || null,
      source_ref: leftId,
      target_ref: rightId
    }, { entityIds: [leftId, rightId], kind: kind || null });
  }

  if (action === 'entity.bindNode' || action === 'entity.ignoreNode' || action === 'entity.clearNodeBinding') {
    const entityId = payload.entityId ?? payload.entity_id ?? payload.id;
    if (entityId === null || entityId === undefined || entityId === '') throw new Error(`${action} requires entityId`);
    const nodeId = nodeIdFromPayload(payload);
    assertNodeInBranchDoc(store, branch, nodeId);
    return stagedResult(store, branch, action, {
      kind: action,
      entity_ref: entityId,
      node_id: nodeId
    }, { entityId, nodeId });
  }

  throw new Error(`Unhandled entity edit branch action: ${action}`);
}

function setNodeBinding(store, payload = {}, status = 'bound') {
  const entityId = requireEntityId(payload);
  const nodeId = nodeIdFromPayload(payload);
  ensureEntityNodeSameDoc(store, entityId, nodeId);
  const existing = store.db.prepare(`
    SELECT * FROM entity_node_bindings
    WHERE entity_id = ? AND node_id = ?
  `).get(entityId, nodeId);
  store.db.prepare(`
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

function clearNodeBinding(store, payload = {}) {
  const entityId = requireEntityId(payload);
  const nodeId = nodeIdFromPayload(payload);
  const result = store.db.prepare(`
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

export function runEntityWrite(store, payload = {}, action = '') {
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
