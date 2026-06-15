import { useEffect, useState } from 'react';

import {
  appendEntityTerm,
  entityDragPayload,
  entityFromDragEvent,
  fetchEntityDetail,
  fetchEntityList,
  fetchEntityNodeSearch,
  openEntityMaintenanceAction
} from '../features/entity/entity-actions.js';
import { readDatabase } from '../data/database-client.js';
import { openEntityMaintenanceWindow } from '../data/window-service.js';

const ENTITY_NODE_SEARCH_PAGE_LIMIT = 100;
const EMPTY_ENTITY_NODE_PAGE = Object.freeze(/** @type {{ total: number, returned: number, offset: number, limit: number, hasMore: boolean, truncated: boolean }} */ ({
  total: 0,
  returned: 0,
  offset: 0,
  limit: ENTITY_NODE_SEARCH_PAGE_LIMIT,
  hasMore: false,
  truncated: false
}));

function keywordRowToSearchResult(row) {
  const node = row?.node || row || {};
  return {
    node_id: node.id,
    doc_id: node.docId ?? row?.doc?.docId ?? null,
    address: node.address || null,
    text: node.textPreview || node.text || node.title || '',
    score: Number(node.score) || 0
  };
}

// 实体检索/追踪面板（EntityTraceView）的全部状态与动作。
// 对 App 的依赖收口为 docId/activeTab 两个输入 + busy/notice 两个回写。
/** @param {{ docId?: any, activeTab?: string, setBusy?: any, setNotice?: any }} [options] */
export function useEntityTrace({ docId = null, activeTab = '', setBusy, setNotice } = {}) {
  const [entityQuery, setEntityQuery] = useState('');
  const [entityRows, setEntityRows] = useState([]);
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [entityDetail, setEntityDetail] = useState(null);
  const [entityNodeQuery, setEntityNodeQuery] = useState('');
  const [entityNodeMatchMode, setEntityNodeMatchMode] = useState('and');
  const [entityNodeResults, setEntityNodeResults] = useState([]);
  const [entityNodeGroups, setEntityNodeGroups] = useState([]);
  const [entityNodePage, setEntityNodePage] = useState(EMPTY_ENTITY_NODE_PAGE);

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
        if (alive) setEntityRows(result?.rows || []);
      })
      .catch((error) => {
        if (alive) setNotice(error.message);
      });
    return () => {
      alive = false;
    };
  }, [activeTab, docId, setNotice]);

  function changeEntityNodeMatchMode(mode) {
    const nextMode = mode === 'or' ? 'or' : 'and';
    setEntityNodeMatchMode(nextMode);
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }

  function changeEntityNodeQuery(value) {
    setEntityNodeQuery(value);
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }

  async function runEntitySearch() {
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
      });
      setEntityRows(result?.rows || []);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function runEntityNodeSearch(queryOverride = entityNodeQuery, modeOverride = entityNodeMatchMode, options = {}) {
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
        mapRow: keywordRowToSearchResult
      });
      setEntityNodeResults(result.rows);
      setEntityNodeGroups(result.groups);
      setEntityNodePage({
        total: Number(result.total) || 0,
        returned: Number(result.returned) || 0,
        offset: Number(result.offset) || 0,
        limit: Number(result.limit) || ENTITY_NODE_SEARCH_PAGE_LIMIT,
        hasMore: Boolean(result.hasMore),
        truncated: Boolean(result.truncated)
      });
    } catch (error) {
      setNotice(error.message);
    } finally {
      if (manageBusy) setBusy(false);
    }
  }

  async function selectEntityTraceEntity(entity) {
    if (!docId || !entity?.id) return;
    setSelectedEntity(entity);
    setBusy(true);
    try {
      const detail = await fetchEntityDetail({
        readDatabase,
        docId,
        entityId: entity.id
      });
      setEntityDetail(detail || null);
      const literal = String(detail?.entity?.literal || entity.literal || '').trim();
      if (literal) {
        setEntityNodeQuery(literal);
        await runEntityNodeSearch(literal, entityNodeMatchMode, { manageBusy: false, offset: 0 });
      }
    } catch (error) {
      setNotice(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function useEntityTraceKeyword(entity) {
    const literal = String(entity?.literal || '').trim();
    if (!literal) return;
    setEntityNodeQuery(literal);
    await runEntityNodeSearch(literal, entityNodeMatchMode, { offset: 0 });
  }

  function pageEntityNodeSearch(direction) {
    const limit = Number(entityNodePage.limit) || ENTITY_NODE_SEARCH_PAGE_LIMIT;
    const currentOffset = Number(entityNodePage.offset) || 0;
    const nextOffset = direction === 'prev'
      ? Math.max(0, currentOffset - limit)
      : currentOffset + limit;
    runEntityNodeSearch(entityNodeQuery, entityNodeMatchMode, { offset: nextOffset }).catch((error) => setNotice(error.message));
  }

  function dragEntityTraceEntity(event, entity) {
    if (!entity?.literal) return;
    event.dataTransfer.setData('application/x-iftree-entity', entityDragPayload(entity));
    event.dataTransfer.setData('text/plain', entity.literal);
    event.dataTransfer.effectAllowed = 'copy';
  }

  function dropEntityIntoNodeSearch(event) {
    event.preventDefault();
    const entity = entityFromDragEvent(event);
    if (!entity?.literal) return;
    setEntityNodeQuery((current) => appendEntityTerm(current, entity.literal));
    setEntityNodeResults([]);
    setEntityNodeGroups([]);
    setEntityNodePage(EMPTY_ENTITY_NODE_PAGE);
  }

  async function openEntityMaintenance() {
    try {
      await openEntityMaintenanceAction({
        docId: docId || null,
        openWindow: openEntityMaintenanceWindow,
        setNotice
      });
    } catch (error) {
      setNotice(error.message);
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
