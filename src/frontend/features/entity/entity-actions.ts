// @ts-nocheck
function normalizedTerms(query = '') {
  return String(query || '').trim().split(/\s+/).filter(Boolean);
}

export function appendEntityTerm(query = '', literal = '') {
  const term = String(literal || '').trim();
  if (!term) return String(query || '');
  const current = String(query || '').trim();
  return current ? `${current} ${term}` : term;
}

export function entityDragPayload(entity: any = {}) {
  return JSON.stringify({
    id: entity.id ?? null,
    docId: entity.docId ?? null,
    literal: entity.literal || ''
  });
}

export function entityFromDragEvent(event) {
  const raw = event?.dataTransfer?.getData('application/x-iftree-entity')
    || event?.dataTransfer?.getData('text/plain')
    || '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.literal ? parsed : null;
  } catch {
    return { literal: raw };
  }
}

function scopedEntityPayload({ docId, docIds, allDocs }: any = {}) {
  if (allDocs) return { allDocs: true };
  const ids = Array.isArray(docIds) ? docIds.filter(Boolean) : [];
  if (ids.length > 1) return { docIds: ids };
  if (ids.length === 1) return { docId: ids[0] };
  return docId ? { docId } : {};
}

/** @param {{ readDatabase: any, docId?: any, docIds?: any[], allDocs?: boolean, query?: string, limit?: number }} options */
export async function fetchEntityList({ readDatabase, docId, docIds, allDocs = false, query, limit = 100 }: any) {
  const scope = scopedEntityPayload({ docId, docIds, allDocs });
  if (!scope.docId && !scope.docIds && !scope.allDocs) return { rows: [] };
  return readDatabase({
    action: 'entity.list',
    ...scope,
    query,
    limit
  });
}

export async function fetchEntityDetail({ readDatabase, docId, entityId }) {
  if (!docId || !entityId) return { entity: null, synonyms: [], related: [] };
  return readDatabase({
    action: 'entity.get',
    docId,
    entityId
  });
}

export async function fetchEntityBindings({
  readDatabase,
  docId,
  entityId,
  query,
  sortBy = 'node',
  sortDirection = 'asc',
  includeIgnored = true
}) {
  if (!docId || !entityId) return { entity: null, rows: [] };
  return readDatabase({
    action: 'entity.listBindings',
    docId,
    entityId,
    query,
    sortBy,
    sortDirection,
    includeIgnored
  });
}

export function writeEntityAction({ writeDatabase, action, payload }) {
  if (typeof writeDatabase !== 'function') throw new Error('IFTree database write is unavailable');
  return writeDatabase({ action, ...(payload || {}) });
}

export function createEntity({ writeDatabase, docId, literal }) {
  return writeEntityAction({ writeDatabase, action: 'entity.create', payload: { docId, literal } });
}

export function deleteEntity({ writeDatabase, docId, entityId }) {
  return writeEntityAction({ writeDatabase, action: 'entity.delete', payload: { docId, entityId } });
}

export function linkEntities({ writeDatabase, docId, sourceEntityId, targetEntityId, kind }) {
  return writeEntityAction({
    writeDatabase,
    action: 'entity.link',
    payload: { docId, sourceEntityId, targetEntityId, kind }
  });
}

export function unlinkEntities({ writeDatabase, docId, sourceEntityId, targetEntityId, kind }) {
  return writeEntityAction({
    writeDatabase,
    action: 'entity.unlink',
    payload: { docId, sourceEntityId, targetEntityId, kind }
  });
}

export function bindEntityNode({ writeDatabase, docId, entityId, nodeId }) {
  return writeEntityAction({ writeDatabase, action: 'entity.bindNode', payload: { docId, entityId, nodeId } });
}

export function ignoreEntityNode({ writeDatabase, docId, entityId, nodeId }) {
  return writeEntityAction({ writeDatabase, action: 'entity.ignoreNode', payload: { docId, entityId, nodeId } });
}

export function clearEntityNodeBinding({ writeDatabase, docId, entityId, nodeId }) {
  return writeEntityAction({ writeDatabase, action: 'entity.clearNodeBinding', payload: { docId, entityId, nodeId } });
}

export function removeEntityNodeBinding({ writeDatabase, docId, entityId, row }) {
  const nodeId = row?.node?.id ?? row?.nodeId;
  return ignoreEntityNode({ writeDatabase, docId, entityId, nodeId });
}

export async function fetchEntityNodeSearch({
  readDatabase,
  docId,
  query,
  matchMode = 'and',
  limit = 100,
  offset = 0,
  mapRow
}) {
  const terms = normalizedTerms(query);
  if (!docId || terms.length === 0) return { rows: [], groups: [], total: 0, offset: 0, limit };
  const result = await readDatabase({
    action: 'content.searchKeyword',
    docId,
    terms,
    matchMode,
    limit,
    offset
  });
  const toRow = typeof mapRow === 'function' ? mapRow : (row) => row;
  return {
    rows: (result?.rows || []).map(toRow).filter((row) => row?.node_id),
    groups: matchMode === 'or'
      ? (result?.groups || []).map((group) => ({
          term: String(group?.term || '').trim(),
          total: Number(group?.total) || 0,
          returned: Number(group?.returned) || 0,
          offset: Number(group?.offset) || 0,
          limit: Number(group?.limit) || limit,
          hasMore: Boolean(group?.hasMore),
          rows: (group?.rows || []).map(toRow).filter((row) => row?.node_id)
        })).filter((group) => group.term)
      : [],
    total: Number(result?.total) || 0,
    returned: Number(result?.returned) || 0,
    offset: Number(result?.offset) || 0,
    limit: Number(result?.limit) || limit,
    hasMore: Boolean(result?.hasMore),
    truncated: Boolean(result?.truncated)
  };
}

export async function openEntityMaintenanceAction({ docId, openWindow, setNotice }: any = {}) {
  if (typeof openWindow !== 'function') {
    setNotice?.('实体库维护窗口入口不可用。');
    return { ok: false, kind: 'entity.maintenance.open.unavailable' };
  }
  return openWindow({ docId });
}
