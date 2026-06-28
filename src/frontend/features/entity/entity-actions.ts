import type { EntityListResult, EntityGetResult, EntityListBindingsResult } from '../../../backend/entities/read.js';

export type { EntityListResult, EntityGetResult, EntityListBindingsResult };
export type { FormattedEntity } from '../../../backend/entities/shared.js';

function normalizedTerms(query: unknown = '') {
  return String(query || '').trim().split(/\s+/).filter(Boolean);
}

type EntityPayload = Record<string, unknown>;
type DatabaseReader = (payload: EntityPayload) => Promise<unknown>;
type DatabaseWriter = (payload: EntityPayload) => Promise<unknown>;

// 前端实体引用（camelCase 视图，对应 EntityRow 的前端投影）。
interface EntityRef {
  id?: string | number | null;
  docId?: string | number | null;
  literal?: string;
}

// 拖拽事件的最小结构（DOM / React DragEvent 都满足）。
interface DragLike {
  dataTransfer?: { getData(format: string): string } | null;
}

// entity.list 的范围 payload（docId / docIds / allDocs 三选一）。
interface EntityScope {
  docId?: unknown;
  docIds?: unknown[];
  allDocs?: boolean;
}

// content.searchKeyword 返回形状（行/分组按渲染所需取，字段宽松）。
export interface SearchGroup {
  term?: unknown;
  total?: unknown;
  returned?: unknown;
  offset?: unknown;
  limit?: unknown;
  hasMore?: unknown;
  rows?: unknown[];
}
interface KeywordSearchResult {
  rows?: unknown[];
  groups?: SearchGroup[];
  total?: unknown;
  returned?: unknown;
  offset?: unknown;
  limit?: unknown;
  hasMore?: unknown;
  truncated?: unknown;
}

export function appendEntityTerm(query = '', literal = '') {
  const term = String(literal || '').trim();
  if (!term) return String(query || '');
  const current = String(query || '').trim();
  return current ? `${current} ${term}` : term;
}

export function entityDragPayload(entity: EntityRef = {}) {
  return JSON.stringify({
    id: entity.id ?? null,
    docId: entity.docId ?? null,
    literal: entity.literal || ''
  });
}

export function entityFromDragEvent(event: DragLike | null | undefined) {
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

function scopedEntityPayload({ docId, docIds, allDocs }: EntityScope = {}): EntityScope {
  if (allDocs) return { allDocs: true };
  const ids = Array.isArray(docIds) ? docIds.filter(Boolean) : [];
  if (ids.length > 1) return { docIds: ids };
  if (ids.length === 1) return { docId: ids[0] };
  return docId ? { docId } : {};
}

export async function fetchEntityList({ readDatabase, docId, docIds, allDocs = false, query, limit = 100 }: {
  readDatabase: DatabaseReader;
  docId?: unknown;
  docIds?: unknown[];
  allDocs?: boolean;
  query?: unknown;
  limit?: number;
}): Promise<EntityListResult> {
  const scope = scopedEntityPayload({ docId, docIds, allDocs });
  if (!scope.docId && !scope.docIds && !scope.allDocs) return { kind: 'entity.list', returned: 0, rows: [] };
  // IPC 返回 unknown，read.ts 端的实际类型是 EntityListResult；这里单点收口。
  return readDatabase({
    action: 'entity.list',
    ...scope,
    query,
    limit
  }) as Promise<EntityListResult>;
}

export async function fetchEntityDetail({ readDatabase, docId, entityId }: {
  readDatabase: DatabaseReader;
  docId?: unknown;
  entityId?: unknown;
}): Promise<EntityGetResult> {
  if (!docId || !entityId) return { kind: 'entity.get', entity: null, synonyms: [], related: [] };
  return readDatabase({
    action: 'entity.get',
    docId,
    entityId
  }) as Promise<EntityGetResult>;
}

export async function fetchEntityBindings({
  readDatabase,
  docId,
  entityId,
  query,
  sortBy = 'node',
  sortDirection = 'asc',
  includeIgnored = true
}: {
  readDatabase: DatabaseReader;
  docId?: unknown;
  entityId?: unknown;
  query?: unknown;
  sortBy?: string;
  sortDirection?: string;
  includeIgnored?: boolean;
}): Promise<EntityListBindingsResult> {
  if (!docId || !entityId) return { kind: 'entity.listBindings', entity: null, rows: [] };
  return readDatabase({
    action: 'entity.listBindings',
    docId,
    entityId,
    query,
    sortBy,
    sortDirection,
    includeIgnored
  }) as Promise<EntityListBindingsResult>;
}

export function writeEntityAction({ writeDatabase, action, payload }: { writeDatabase: DatabaseWriter; action: string; payload?: EntityPayload }) {
  if (typeof writeDatabase !== 'function') throw new Error('IFTree database write is unavailable');
  return writeDatabase({ action, ...(payload || {}) });
}

export function createEntity({ writeDatabase, docId, literal }: {
  writeDatabase: DatabaseWriter;
  docId?: unknown;
  literal?: unknown;
}) {
  return writeEntityAction({ writeDatabase, action: 'entity.create', payload: { docId, literal } });
}

export function deleteEntity({ writeDatabase, docId, entityId }: {
  writeDatabase: DatabaseWriter;
  docId?: unknown;
  entityId?: unknown;
}) {
  return writeEntityAction({ writeDatabase, action: 'entity.delete', payload: { docId, entityId } });
}

export function linkEntities({ writeDatabase, docId, sourceEntityId, targetEntityId, kind }: {
  writeDatabase: DatabaseWriter;
  docId?: unknown;
  sourceEntityId?: unknown;
  targetEntityId?: unknown;
  kind?: unknown;
}) {
  return writeEntityAction({
    writeDatabase,
    action: 'entity.link',
    payload: { docId, sourceEntityId, targetEntityId, kind }
  });
}

export function unlinkEntities({ writeDatabase, docId, sourceEntityId, targetEntityId, kind }: {
  writeDatabase: DatabaseWriter;
  docId?: unknown;
  sourceEntityId?: unknown;
  targetEntityId?: unknown;
  kind?: unknown;
}) {
  return writeEntityAction({
    writeDatabase,
    action: 'entity.unlink',
    payload: { docId, sourceEntityId, targetEntityId, kind }
  });
}

export function bindEntityNode({ writeDatabase, docId, entityId, nodeId }: {
  writeDatabase: DatabaseWriter;
  docId?: unknown;
  entityId?: unknown;
  nodeId?: unknown;
}) {
  return writeEntityAction({ writeDatabase, action: 'entity.bindNode', payload: { docId, entityId, nodeId } });
}

export function ignoreEntityNode({ writeDatabase, docId, entityId, nodeId }: {
  writeDatabase: DatabaseWriter;
  docId?: unknown;
  entityId?: unknown;
  nodeId?: unknown;
}) {
  return writeEntityAction({ writeDatabase, action: 'entity.ignoreNode', payload: { docId, entityId, nodeId } });
}

export function clearEntityNodeBinding({ writeDatabase, docId, entityId, nodeId }: {
  writeDatabase: DatabaseWriter;
  docId?: unknown;
  entityId?: unknown;
  nodeId?: unknown;
}) {
  return writeEntityAction({ writeDatabase, action: 'entity.clearNodeBinding', payload: { docId, entityId, nodeId } });
}

export function removeEntityNodeBinding({ writeDatabase, docId, entityId, row }: {
  writeDatabase: DatabaseWriter;
  docId?: unknown;
  entityId?: unknown;
  row?: { node?: { id?: unknown }; nodeId?: unknown } | null;
}) {
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
}: {
  readDatabase: DatabaseReader;
  docId?: unknown;
  query?: unknown;
  matchMode?: string;
  limit?: number;
  offset?: number;
  mapRow?: (row: unknown) => any;
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
  }) as KeywordSearchResult;
  const toRow: (row: unknown) => any = typeof mapRow === 'function' ? mapRow : (row) => row;
  return {
    rows: (result?.rows || []).map(toRow).filter((row) => row?.node_id),
    groups: matchMode === 'or'
      ? (result?.groups || []).map((group: SearchGroup) => ({
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

export async function openEntityMaintenanceAction({ docId, openWindow, setNotice }: {
  docId?: unknown;
  openWindow?: (arg: { docId?: unknown }) => unknown;
  setNotice?: (msg: string) => void;
} = {}) {
  if (typeof openWindow !== 'function') {
    setNotice?.('实体库维护窗口入口不可用。');
    return { ok: false, kind: 'entity.maintenance.open.unavailable' };
  }
  return openWindow({ docId });
}
