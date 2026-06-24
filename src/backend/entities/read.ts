// @ts-nocheck
import { compareNodeAddress } from '../shared.js';
import { keywordIndexRowsForDoc } from '../keyword-index.js';
import {
  formatEntity,
  normalizeEntityKey,
  normalizeLimit,
  normalizePositiveInteger,
  nodeRowsForDoc,
  scanEntityHits
} from './shared.js';
import {
  entityStateForRead,
  formatProjectedEntity
} from './projection.js';

export const ENTITY_READ_ACTIONS = Object.freeze([
  'entity.list',
  'entity.get',
  'entity.listRelated',
  'entity.listBindings'
]);

function sameRef(left, right) {
  if (typeof left === 'string' || typeof right === 'string') return String(left) === String(right);
  return String(left) === String(right);
}

function rawEntityId(payload = {}) {
  return payload.entityId ?? payload.entity_id ?? payload.id ?? null;
}

function normalizeTerms(payload = {}) {
  const source = Array.isArray(payload.terms)
    ? payload.terms
    : String(payload.keyword ?? payload.query ?? payload.q ?? payload.literal ?? '')
      .split(/\s+/);
  const terms = [];
  const seen = new Set();
  for (const item of source) {
    const term = String(item || '').trim();
    const key = normalizeEntityKey(term);
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function docIdsFromPayload(payload = {}, options = {}) {
  if (payload.allDocs === true || payload.all_docs === true || payload.scope === 'all') return null;
  const rawDocIds = Array.isArray(payload.docIds)
    ? payload.docIds
    : Array.isArray(payload.doc_ids)
      ? payload.doc_ids
      : [];
  const docIds = rawDocIds.map((value) => normalizePositiveInteger(value)).filter(Boolean);
  const docId = normalizePositiveInteger(payload.docId ?? payload.doc_id ?? payload.scopeDocId ?? payload.scope_doc_id);
  if (docId) docIds.unshift(docId);
  const unique = [...new Set(docIds)];
  if (unique.length === 0 && options.required !== false) {
    throw new Error('entity query requires docId, docIds, or allDocs');
  }
  return unique;
}

function branchForDoc(store, docId, payload = {}) {
  const owner = payload.owner || payload.editBranchOwner || payload.edit_branch_owner || null;
  return store.activeEditBranchForDoc?.(docId, owner) || null;
}

function stateForPayload(store, payload = {}, docId = null) {
  const docIds = docId ? [docId] : docIdsFromPayload(payload, { required: false });
  const branch = docIds?.length === 1 ? branchForDoc(store, docIds[0], payload) : null;
  return entityStateForRead(store, branch);
}

function entityByRef(state, ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  return state.entities.find((entity) => sameRef(entity.id, ref)) || null;
}

function filterEntities(state, payload = {}) {
  const docIds = docIdsFromPayload(payload);
  const docSet = docIds ? new Set(docIds.map(String)) : null;
  const query = String(payload.query ?? payload.q ?? payload.literal ?? '').trim().toLocaleLowerCase();
  const queryRank = (entity = {}) => {
    if (!query) return 0;
    const key = String(entity.normalized_literal || '').toLocaleLowerCase();
    if (key === query) return 0;
    if (key.includes(query)) return 1;
    return 2;
  };
  return state.entities
    .filter((entity) => !docSet || docSet.has(String(entity.doc_id)))
    .sort((left, right) => queryRank(left) - queryRank(right)
      || String(left.doc_id).localeCompare(String(right.doc_id), undefined, { numeric: true })
      || String(left.literal || '').localeCompare(String(right.literal || ''), 'zh-Hans-CN', { numeric: true })
      || String(left.id).localeCompare(String(right.id), undefined, { numeric: true }));
}

function attachEntityHitCounts(store, rows = []) {
  const byDoc = new Map();
  for (const row of rows) {
    const docId = String(row.doc_id);
    const group = byDoc.get(docId) || [];
    group.push(row);
    byDoc.set(docId, group);
  }
  const counts = new Map();
  for (const [docId, entities] of byDoc.entries()) {
    const scan = scanEntityHits(nodeRowsForDoc(store, docId), entities);
    for (const entity of entities) counts.set(String(entity.id), scan.totals.get(String(entity.id)) || 0);
  }
  return rows.map((row) => ({ ...row, hit_count: counts.get(String(row.id)) || 0 }));
}

function listEntities(store, payload = {}) {
  const state = stateForPayload(store, payload);
  const rows = attachEntityHitCounts(store, filterEntities(state, payload))
    .slice(0, normalizeLimit(payload.limit, 100, 1000));
  return {
    kind: 'entity.list',
    returned: rows.length,
    rows: rows.map((row) => formatProjectedEntity(row))
  };
}

function linkedEntityRows(state, entityRefs = [], kind = 'synonym') {
  const refs = new Set(entityRefs.map(String));
  const rows = [];
  for (const link of state.links) {
    if (link.kind !== kind) continue;
    const leftHit = refs.has(String(link.entity_a_id));
    const rightHit = refs.has(String(link.entity_b_id));
    if (!leftHit && !rightHit) continue;
    const otherRef = leftHit ? link.entity_b_id : link.entity_a_id;
    const other = entityByRef(state, otherRef);
    if (other) rows.push({ ...other, kind, source_entity_id: leftHit ? link.entity_a_id : link.entity_b_id });
  }
  return rows;
}

function synonymGroupRows(state, store, entityRef) {
  const root = entityByRef(state, entityRef);
  if (!root) return [];
  const seen = new Set([String(root.id)]);
  const queue = [root.id];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const row of linkedEntityRows(state, [current], 'synonym')) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(row.id);
    }
  }
  const rows = state.entities
    .filter((row) => seen.has(String(row.id)))
    .sort((left, right) => (sameRef(left.id, root.id) ? -1 : sameRef(right.id, root.id) ? 1 : 0)
      || String(left.doc_id).localeCompare(String(right.doc_id), undefined, { numeric: true })
      || String(left.literal || '').localeCompare(String(right.literal || ''), 'zh-Hans-CN', { numeric: true }));
  return attachEntityHitCounts(store, rows);
}

function getEntity(store, payload = {}) {
  const ref = rawEntityId(payload);
  if (ref === null || ref === undefined || ref === '') throw new Error('entity.get requires entityId');
  const baseEntity = normalizePositiveInteger(ref) ? store.db.prepare('SELECT doc_id FROM entities WHERE id = ?').get(ref) : null;
  const docId = normalizePositiveInteger(payload.docId ?? payload.doc_id ?? baseEntity?.doc_id);
  const state = stateForPayload(store, payload, docId);
  const group = synonymGroupRows(state, store, ref);
  if (group.length === 0) return { kind: 'entity.get', entity: null };
  const groupIds = new Set(group.map((row) => String(row.id)));
  const related = attachEntityHitCounts(
    store,
    linkedEntityRows(state, [...groupIds], 'related')
      .filter((row) => !groupIds.has(String(row.id)))
  );
  const primary = group.find((row) => sameRef(row.id, ref)) || group[0];
  return {
    kind: 'entity.get',
    entity: formatProjectedEntity(primary, {
      mergedHitCount: group.reduce((sum, row) => sum + (Number(row.hit_count) || 0), 0)
    }),
    synonyms: group.filter((row) => !sameRef(row.id, primary.id)).map((row) => formatProjectedEntity(row)),
    related: related.map((row) => formatProjectedEntity(row))
  };
}

function seedEntityRows(state, payload = {}) {
  const terms = normalizeTerms(payload);
  const keys = new Set(terms.map(normalizeEntityKey).filter(Boolean));
  if (keys.size === 0) return { terms, rows: [] };
  const docIds = docIdsFromPayload(payload);
  const docSet = docIds ? new Set(docIds.map(String)) : null;
  return {
    terms,
    rows: state.entities
      .filter((entity) => !docSet || docSet.has(String(entity.doc_id)))
      .filter((entity) => keys.has(entity.normalized_literal))
      .sort((left, right) => String(left.doc_id).localeCompare(String(right.doc_id), undefined, { numeric: true })
        || String(left.literal || '').localeCompare(String(right.literal || ''), 'zh-Hans-CN', { numeric: true }))
  };
}

function listRelated(store, payload = {}) {
  const state = stateForPayload(store, payload);
  const { terms, rows: seeds } = seedEntityRows(state, payload);
  const resultRows = [];
  const seen = new Set();
  for (const seed of seeds) {
    const group = synonymGroupRows(state, store, seed.id);
    const groupIds = new Set(group.map((row) => String(row.id)));
    for (const row of group) {
      if (sameRef(row.id, seed.id)) continue;
      const key = `synonym:${seed.id}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resultRows.push({ relation: 'synonym', seed: formatEntity(seed), entity: formatProjectedEntity(row) });
    }
    for (const related of attachEntityHitCounts(store, linkedEntityRows(state, [...groupIds], 'related'))) {
      if (groupIds.has(String(related.id))) continue;
      const key = `related:${seed.id}:${related.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resultRows.push({ relation: 'related', seed: formatEntity(seed), entity: formatProjectedEntity(related) });
    }
  }
  return {
    kind: 'entity.listRelated',
    terms,
    returned: resultRows.length,
    rows: resultRows.slice(0, normalizeLimit(payload.limit, 100, 1000))
  };
}

function formatBindingNode(row = {}) {
  return {
    id: row.id,
    docId: row.doc_id,
    address: row.address,
    depth: row.depth,
    title: row.node_title || '',
    textPreview: String(row.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    notePreview: String(row.node_note || '').replace(/\s+/g, ' ').trim().slice(0, 240)
  };
}

function normalizeBindingSort(payload = {}) {
  const rawSort = String(payload.sort ?? payload.sortBy ?? payload.sort_by ?? payload.orderBy ?? payload.order_by ?? 'node')
    .trim()
    .toLowerCase();
  const parts = rawSort.split(':');
  const rawBy = parts[0] || 'node';
  const rawDirection = String(payload.sortDirection ?? payload.sort_direction ?? payload.direction ?? payload.dir ?? parts[1] ?? '')
    .trim()
    .toLowerCase();
  const by = ['bm25', 'relevance', 'score'].includes(rawBy)
    ? 'bm25'
    : ['node', 'address', 'body'].includes(rawBy)
      ? 'node'
      : 'node';
  const direction = rawDirection === 'desc' || rawDirection === 'asc'
    ? rawDirection
    : by === 'bm25'
      ? 'desc'
      : 'asc';
  return { by, direction };
}

async function bm25RankByNodeId(store, entity, payload = {}, ctx = {}) {
  if (typeof ctx.ensureKeywordIndexRows !== 'function' || typeof ctx.keywordSearch !== 'function') return new Map();
  const terms = normalizeTerms({
    terms: payload.terms,
    query: payload.query ?? payload.q ?? payload.keyword ?? entity.literal
  });
  if (terms.length === 0) return new Map();
  await ctx.ensureKeywordIndexRows(keywordIndexRowsForDoc(store, entity.doc_id));
  const candidates = await ctx.keywordSearch({ terms, docId: entity.doc_id });
  const ranks = new Map();
  candidates.forEach((candidate, index) => {
    const nodeId = String(candidate.node_id || '');
    if (nodeId && !ranks.has(nodeId)) ranks.set(nodeId, index + 1);
  });
  return ranks;
}

function bindingSource(override, hitCount) {
  if (override?.status === 'ignored') return 'ignored';
  return hitCount > 0 ? 'literal' : 'manual';
}

function includeIgnoredBindings(payload = {}) {
  return payload.includeIgnored !== false && payload.include_ignored !== false;
}

function sortBindingRows(rows = [], sort = {}, ranks = new Map()) {
  return [...rows].sort((left, right) => {
    if (sort.by === 'bm25') {
      const leftRank = ranks.get(String(left.node.id)) ?? Number.POSITIVE_INFINITY;
      const rightRank = ranks.get(String(right.node.id)) ?? Number.POSITIVE_INFINITY;
      const leftMissing = !Number.isFinite(leftRank);
      const rightMissing = !Number.isFinite(rightRank);
      if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) return compareNodeAddress(left.node, right.node);
        return leftMissing ? 1 : -1;
      }
      if (leftRank !== rightRank) return sort.direction === 'asc' ? rightRank - leftRank : leftRank - rightRank;
    }
    const nodeOrder = compareNodeAddress(left.node, right.node);
    return sort.direction === 'desc' ? -nodeOrder : nodeOrder;
  });
}

async function listBindings(store, payload = {}, ctx = {}) {
  const ref = rawEntityId(payload);
  if (ref === null || ref === undefined || ref === '') throw new Error('entity.listBindings requires entityId');
  const baseEntity = normalizePositiveInteger(ref) ? store.db.prepare('SELECT doc_id FROM entities WHERE id = ?').get(ref) : null;
  const docId = normalizePositiveInteger(payload.docId ?? payload.doc_id ?? baseEntity?.doc_id);
  const state = stateForPayload(store, payload, docId);
  const entity = entityByRef(state, ref);
  if (!entity) return { kind: 'entity.listBindings', entity: null, rows: [] };
  const sort = normalizeBindingSort(payload);
  const nodes = nodeRowsForDoc(store, entity.doc_id);
  const scanResult = scanEntityHits(nodes, [entity]);
  const scan = scanResult.byNode.get(String(entity.id)) || new Map();
  const includeIgnored = includeIgnoredBindings(payload);
  const overrides = new Map(state.bindings
    .filter((binding) => sameRef(binding.entity_id, entity.id))
    .map((binding) => [String(binding.node_id), binding]));
  const rowsByNode = new Map();

  for (const node of nodes) {
    const nodeId = String(node.id);
    const hitCount = scan.get(nodeId) || 0;
    const override = overrides.get(nodeId);
    if (override?.status === 'ignored' && !includeIgnored) continue;
    if (override?.status === 'bound' || hitCount > 0 || override?.status === 'ignored') {
      rowsByNode.set(nodeId, {
        status: override?.status === 'ignored' ? 'ignored' : 'bound',
        source: bindingSource(override, hitCount),
        hitCount,
        node: formatBindingNode(node)
      });
    }
  }

  for (const [nodeId, override] of overrides.entries()) {
    if (rowsByNode.has(nodeId)) continue;
    if (override.status === 'ignored' && !includeIgnored) continue;
    const node = store.db.prepare(`
      SELECT id, doc_id, address, depth, node_title, text, node_note
      FROM nodes
      WHERE id = ?
    `).get(nodeId);
    if (!node) continue;
    rowsByNode.set(nodeId, {
      status: override.status,
      source: bindingSource(override, 0),
      hitCount: 0,
      node: formatBindingNode(node)
    });
  }

  const ranks = sort.by === 'bm25' ? await bm25RankByNodeId(store, entity, payload, ctx) : new Map();
  const rows = sortBindingRows([...rowsByNode.values()], sort, ranks);
  return {
    kind: 'entity.listBindings',
    entity: formatProjectedEntity({ ...entity, hit_count: scanResult.totals.get(String(entity.id)) || 0 }),
    sort,
    returned: rows.length,
    rows
  };
}

export function runEntityRead(store, payload = {}, action = '', ctx = {}) {
  if (action === 'entity.list') return listEntities(store, payload);
  if (action === 'entity.get') return getEntity(store, payload);
  if (action === 'entity.listRelated') return listRelated(store, payload);
  if (action === 'entity.listBindings') return listBindings(store, payload, ctx);
  throw new Error(`Unhandled entity read action: ${action}`);
}
