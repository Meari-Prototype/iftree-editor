import { useEffect, useState } from 'react';

import {
  appendEntityTerm,
  entityDragPayload,
  entityFromDragEvent,
  fetchEntityList,
  fetchEntityDetail,
  fetchEntityNodeSearch,
  openEntityMaintenanceAction,
  type EntityGetResult,
  type SearchGroup
} from '../features/entity/entity-actions.js';
import { readDatabase } from '../data/database-client.js';
import { openEntityMaintenanceWindow } from '../data/window-service.js';
import { useAppUIContext } from './useAppUI.js';

const ENTITY_NODE_SEARCH_PAGE_LIMIT = 100;

export interface EntityNodePage {
  total: number;
  returned: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  truncated: boolean;
}

const EMPTY_ENTITY_NODE_PAGE: Readonly<EntityNodePage> = Object.freeze({
  total: 0,
  returned: 0,
  offset: 0,
  limit: ENTITY_NODE_SEARCH_PAGE_LIMIT,
  hasMore: false,
  truncated: false
});

export interface EntityTraceRow {
  id?: unknown;
  literal?: string;
  docId?: unknown;
  docTitle?: string;
  hitCount?: unknown;
  mergedHitCount?: unknown;
  [extra: string]: unknown;
}

export type EntityTraceDetail = EntityGetResult;

export interface EntityNodeSearchRow {
  node_id: unknown;
  doc_id: unknown;
  address: string | null;
  text: string;
  score: number;
  [extra: string]: unknown;
}

interface KeywordSearchRow {
  node?: { id?: unknown; docId?: unknown; address?: string; text?: string; title?: string; textPreview?: string; score?: unknown };
  doc?: { docId?: unknown };
  [extra: string]: unknown;
}

interface EntitySearchOptions {
  manageBusy?: boolean;
  offset?: number;
}

interface UseEntityTraceOptions {
  docId?: unknown;
}

function keywordRowToSearchResult(row: KeywordSearchRow): EntityNodeSearchRow {
  const node = row?.node || (row as KeywordSearchRow['node']) || {};
  return {
    node_id: node?.id,
    doc_id: node?.docId ?? row?.doc?.docId ?? null,
    address: node?.address || null,
    text: node?.textPreview || node?.text || node?.title || '',
    score: Number(node?.score) || 0
  };
}

// 实体检索/追踪面板（EntityTraceView）的全部状态与动作。
// 输入仅 docId；busy/notice/activeTab 从 useAppUIContext 读。
export function useEntityTrace({ docId = null }: UseEntityTraceOptions = {}) {
  const { setBusy, setNotice, activeTab } = useAppUIContext();
  const [entityQuery, setEntityQuery] = useState<string>('');
  const [entityRows, setEntityRows] = useState<EntityTraceRow[]>([]);
  const [selectedEntity, setSelectedEntity] = useState<EntityTraceRow | null>(null);
  const [entityDetail, setEntityDetail] = useState<EntityTraceDetail | null>(null);
  const [entityNodeQuery, setEntityNodeQuery] = useState<string>('');
  const [entityNodeMatchMode, setEntityNodeMatchMode] = useState<'and' | 'or'>('and');
  const [entityNodeResults, setEntityNodeResults] = useState<EntityNodeSearchRow[]>([]);
  const [entityNodeGroups, setEntityNodeGroups] = useState<SearchGroup[]>([]);
  const [entityNodePage, setEntityNodePage] = useState<EntityNodePage>(EMPTY_ENTITY_NODE_PAGE);

  useEffect(() => {
    setEntityQuery('');
    setEntityRows([]);
    setSelectedEntity(null);
    setEntityDetail(null);
    setEntityNodeQuery('');
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }, [docId]);

  useEffect(() => {
    if (activeTab !== 'entity' || !docId) return undefined;
    let alive = true;
    fetchEntityList({ readDatabase, docId, query: '', limit: 100 })
      .then((result) => {
        if (alive) setEntityRows(((result as { rows?: EntityTraceRow[] } | null | undefined)?.rows) || []);
      })
      .catch((error) => {
        if (alive) setNotice((error as { message?: string }).message || '');
      });
    return () => {
      alive = false;
    };
  }, [activeTab, docId, setNotice]);

  function changeEntityNodeMatchMode(mode: unknown): void {
    const nextMode: 'and' | 'or' = mode === 'or' ? 'or' : 'and';
    setEntityNodeMatchMode(nextMode);
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }

  function changeEntityNodeQuery(value: string): void {
    setEntityNodeQuery(value);
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }

  async function runEntitySearch(): Promise<void> {
    if (!docId) {
      setEntityRows([]);
      setSelectedEntity(null);
      setEntityDetail(null);
      return;
    }
    setBusy(true);
    try {
      const result = await fetchEntityList({
        readDatabase,
        docId,
        query: entityQuery,
        limit: 100
      }) as { rows?: EntityTraceRow[] } | null | undefined;
      setEntityRows(result?.rows || []);
    } catch (error) {
      setNotice((error as { message?: string }).message || '');
    } finally {
      setBusy(false);
    }
  }

  async function runEntityNodeSearch(queryOverride: string = entityNodeQuery, modeOverride: 'and' | 'or' = entityNodeMatchMode, options: EntitySearchOptions = {}): Promise<void> {
    const manageBusy = options.manageBusy !== false;
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    if (!docId || !String(queryOverride || '').trim()) {
      setEntityNodeResults([]);
      setEntityNodeGroups([]);
      setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
      return;
    }
    if (manageBusy) setBusy(true);
    try {
      const result = await fetchEntityNodeSearch({
        readDatabase,
        docId,
        query: queryOverride,
        matchMode: modeOverride,
        limit: ENTITY_NODE_SEARCH_PAGE_LIMIT,
        offset,
        mapRow: keywordRowToSearchResult as never
      }) as { rows?: EntityNodeSearchRow[]; groups?: SearchGroup[]; total?: unknown; returned?: unknown; offset?: unknown; limit?: unknown; hasMore?: unknown; truncated?: unknown };
      setEntityNodeResults(result.rows || []);
      setEntityNodeGroups(result.groups || []);
      setEntityNodePage({
        total: Number(result.total) || 0,
        returned: Number(result.returned) || 0,
        offset: Number(result.offset) || 0,
        limit: Number(result.limit) || ENTITY_NODE_SEARCH_PAGE_LIMIT,
        hasMore: Boolean(result.hasMore),
        truncated: Boolean(result.truncated)
      });
    } catch (error) {
      setNotice((error as { message?: string }).message || '');
    } finally {
      if (manageBusy) setBusy(false);
    }
  }

  async function selectEntityTraceEntity(entity: EntityTraceRow | null | undefined): Promise<void> {
    if (!docId || !entity?.id) return;
    setSelectedEntity(entity);
    setBusy(true);
    try {
      const detail = await fetchEntityDetail({
        readDatabase,
        docId,
        entityId: entity.id
      }) as EntityGetResult | null | undefined;
      setEntityDetail(detail || null);
      const literal = String(detail?.entity?.literal || entity.literal || '').trim();
      if (literal) {
        setEntityNodeQuery(literal);
        await runEntityNodeSearch(literal, entityNodeMatchMode, { manageBusy: false, offset: 0 });
      }
    } catch (error) {
      setNotice((error as { message?: string }).message || '');
    } finally {
      setBusy(false);
    }
  }

  async function useEntityTraceKeyword(entity: EntityTraceRow | null | undefined): Promise<void> {
    const literal = String(entity?.literal || '').trim();
    if (!literal) return;
    setEntityNodeQuery(literal);
    await runEntityNodeSearch(literal, entityNodeMatchMode, { offset: 0 });
  }

  function pageEntityNodeSearch(direction: 'prev' | 'next'): void {
    const limit = Number(entityNodePage.limit) || ENTITY_NODE_SEARCH_PAGE_LIMIT;
    const currentOffset = Number(entityNodePage.offset) || 0;
    const nextOffset = direction === 'prev'
      ? Math.max(0, currentOffset - limit)
      : currentOffset + limit;
    runEntityNodeSearch(entityNodeQuery, entityNodeMatchMode, { offset: nextOffset })
      .catch((error) => setNotice((error as { message?: string }).message || ''));
  }

  function dragEntityTraceEntity(event: React.DragEvent, entity: EntityTraceRow | null | undefined): void {
    if (!entity?.literal) return;
    event.dataTransfer.setData('application/x-iftree-entity', entityDragPayload(entity as never));
    event.dataTransfer.setData('text/plain', entity.literal);
    event.dataTransfer.effectAllowed = 'copy';
  }

  function dropEntityIntoNodeSearch(event: React.DragEvent): void {
    event.preventDefault();
    const entity = entityFromDragEvent(event) as EntityTraceRow | null | undefined;
    if (!entity?.literal) return;
    setEntityNodeQuery((current) => appendEntityTerm(current, entity.literal!));
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }

  async function openEntityMaintenance(): Promise<void> {
    try {
      await openEntityMaintenanceAction({
        docId: docId || null,
        openWindow: openEntityMaintenanceWindow,
        setNotice
      });
    } catch (error) {
      setNotice((error as { message?: string }).message || '');
    }
  }

  return {
    entityQuery,
    setEntityQuery,
    entityRows,
    selectedEntity,
    entityDetail,
    entityNodeQuery,
    entityNodeMatchMode,
    entityNodeResults,
    entityNodeGroups,
    entityNodePage,
    changeEntityNodeMatchMode,
    changeEntityNodeQuery,
    runEntitySearch,
    runEntityNodeSearch,
    selectEntityTraceEntity,
    useEntityTraceKeyword,
    pageEntityNodeSearch,
    dragEntityTraceEntity,
    dropEntityIntoNodeSearch,
    openEntityMaintenance
  };
}
