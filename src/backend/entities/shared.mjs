import {
  compareStableIds,
  normalizeStableId,
  sameStableId
} from '../db/ids.mjs';
import { buildAhoCorasickMatcher } from '../../core/aho-corasick.mjs';

export function normalizePositiveInteger(value, fallback = null) {
  return normalizeStableId(value, fallback);
}

export function normalizeLimit(value, fallback = 100, max = 1000) {
  const number = Math.floor(Number(value));
  if (!Number.isInteger(number) || number <= 0) return fallback;
  return Math.min(max, number);
}

export function normalizeEntityLiteral(value = '') {
  return String(value || '').trim();
}

export function normalizeEntityKey(value = '') {
  return normalizeEntityLiteral(value).toLocaleLowerCase();
}

export function normalizeEntityLinkKind(value = '') {
  const kind = String(value || '').trim().toLowerCase();
  if (kind === 'synonym' || kind === 'related') return kind;
  throw new Error('entity link kind must be synonym or related');
}

export function orderedEntityPair(leftId, rightId) {
  const left = normalizePositiveInteger(leftId);
  const right = normalizePositiveInteger(rightId);
  if (!left || !right) throw new Error('entity link requires two entity ids');
  if (sameStableId(left, right)) throw new Error('entity link requires two different entities');
  return compareStableIds(left, right) <= 0 ? [left, right] : [right, left];
}

export function requireEntityId(payload = {}, key = 'entityId') {
  const value = normalizePositiveInteger(payload[key] ?? payload[snakeKey(key)]);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function requireDocId(payload = {}) {
  const docId = normalizePositiveInteger(payload.docId ?? payload.doc_id);
  if (!docId) throw new Error('entity action requires docId');
  return docId;
}

function snakeKey(value = '') {
  return String(value).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function entityRow(store, entityId) {
  const id = normalizePositiveInteger(entityId);
  if (!id) return null;
  return store.db.prepare(`
    SELECT e.*,
      d.title AS doc_title
    FROM entities e
    JOIN docs d ON d.id = e.doc_id
    WHERE e.id = ?
  `).get(id) || null;
}

export function formatEntity(row = {}, extras = {}) {
  return {
    id: row.id,
    docId: row.doc_id,
    docTitle: row.doc_title || '',
    literal: row.literal || '',
    key: row.normalized_literal || normalizeEntityKey(row.literal),
    hitCount: Number(row.hit_count ?? extras.hitCount) || 0,
    ...extras
  };
}

export function nodeHaystack(row = {}) {
  return [
    row.address,
    row.node_title,
    row.text,
    row.node_note
  ].map((value) => String(value || '').toLocaleLowerCase()).join('\n');
}

export function countLiteralOccurrences(haystack = '', needle = '') {
  const target = String(needle || '');
  if (!target) return 0;
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const next = haystack.indexOf(target, index);
    if (next === -1) break;
    count += 1;
    index = next + target.length;
  }
  return count;
}

export function scanEntityHits(rows = [], entities = []) {
  const totals = new Map();
  const byNode = new Map();
  const matcher = buildAhoCorasickMatcher(entities.map((entity) => ({
    id: entity.id,
    key: normalizeEntityKey(entity.literal)
  })));

  for (const row of rows) {
    matcher.scan(nodeHaystack(row), (entity) => {
      const entityId = String(entity.id || '');
      if (!entityId) return;
      totals.set(entityId, (totals.get(entityId) || 0) + 1);
      let nodeHits = byNode.get(entityId);
      if (!nodeHits) {
        nodeHits = new Map();
        byNode.set(entityId, nodeHits);
      }
      const nodeKey = String(row.id);
      nodeHits.set(nodeKey, (nodeHits.get(nodeKey) || 0) + 1);
    });
  }

  return { totals, byNode };
}

export function nodeRowsForDoc(store, docId) {
  const normalizedDocId = normalizePositiveInteger(docId);
  if (!normalizedDocId) return [];
  return store.db.prepare(`
    SELECT id, doc_id, address, depth, node_title, text, node_note
    FROM nodes
    WHERE doc_id = ?
    ORDER BY depth, address, id
  `).all(normalizedDocId);
}

export function countEntityHitsInDoc(store, entity, docId = null) {
  const targetDocId = normalizePositiveInteger(docId ?? entity?.doc_id);
  if (!normalizeEntityKey(entity?.literal) || !targetDocId) return 0;
  return scanEntityHits(nodeRowsForDoc(store, targetDocId), [entity]).totals.get(String(entity.id)) || 0;
}

export function ensureEntityNodeSameDoc(store, entityId, nodeId) {
  const entity = entityRow(store, entityId);
  if (!entity) throw new Error('entity not found');
  const node = store.db.prepare('SELECT id, doc_id FROM nodes WHERE id = ?').get(nodeId);
  if (!node) throw new Error('node not found');
  if (!sameStableId(node.doc_id, entity.doc_id)) {
    throw new Error('entity node binding requires entity and node from the same doc');
  }
  return { entity, node };
}
