import {
  Check,
  Database,
  HelpCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Unlink2
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { WindowTitlebar } from './common.jsx';
import { rawIftreeApi } from '../data/iftree-api.js';
import { readDatabase, writeDatabase } from '../data/database-client.js';
import { documentRepository } from '../data/document-repository.js';
import {
  bindEntityNode,
  createEntity,
  deleteEntity,
  entityDragPayload,
  entityFromDragEvent,
  fetchEntityBindings,
  fetchEntityDetail,
  fetchEntityList,
  linkEntities,
  removeEntityNodeBinding,
  unlinkEntities
} from '../features/entity/entity-actions.js';

function initialDocIdFromLocation() {
  if (typeof window === 'undefined') return null;
  const docId = String(new URLSearchParams(window.location.search).get('docId') || '').trim();
  return docId || null;
}

function docDisplayTitle(doc: any = {}) {
  return String(doc?.title || '').trim() || '未命名文档';
}

function entityDocTitle(entity: any = {}) {
  return String(entity.docTitle || '').trim();
}

function entityLabel(entity: any = {}, options: any = {}) {
  const literal = entity.literal || '未命名实体';
  const docTitle = options.showDocTitle ? entityDocTitle(entity) : '';
  return docTitle ? `${literal} · ${docTitle}` : literal;
}

function hitText(value) {
  return `x${Number(value) || 0}`;
}

const BINDING_SORT_OPTIONS = Object.freeze([
  { value: 'node:asc', label: '正文顺序↑', sortBy: 'node', sortDirection: 'asc' },
  { value: 'node:desc', label: '正文顺序↓', sortBy: 'node', sortDirection: 'desc' },
  { value: 'bm25:desc', label: 'BM25相关↓', sortBy: 'bm25', sortDirection: 'desc' },
  { value: 'bm25:asc', label: 'BM25相关↑', sortBy: 'bm25', sortDirection: 'asc' }
]);

function bindingSortPayload(value = 'node:asc') {
  return BINDING_SORT_OPTIONS.find((item) => item.value === value) || BINDING_SORT_OPTIONS[0];
}

function nodeStatusIcon(status) {
  if (status === 'bound') return <Check size={15} />;
  return <HelpCircle size={15} />;
}

function nodeStatusText(status) {
  if (status === 'bound') return '已绑';
  return '待绑';
}

function EntityLibraryRow({ entity, active, showDocTitle, onSelect, onDragStart }) {
  const docTitle = showDocTitle ? entityDocTitle(entity) : '';
  return (
    <button
      type="button"
      className={`maintenance-entity-row${active ? ' active' : ''}${docTitle ? ' with-doc-label' : ''}`}
      draggable
      onClick={() => onSelect(entity)}
      onDragStart={(event) => onDragStart(event, entity)}
    >
      <span className="maintenance-entity-caret">{active ? '▶' : ''}</span>
      <strong>{entity.literal || '未命名实体'}</strong>
      {docTitle ? <small title={docTitle}>{docTitle}</small> : null}
      <span>{hitText(entity.hitCount ?? entity.mergedHitCount)}</span>
    </button>
  );
}

function RelationRow({ entity, kind, showDocTitle, onUnlink }) {
  return (
    <div className="maintenance-relation-row">
      <span>{entityLabel(entity, { showDocTitle })}</span>
      <strong>{hitText(entity.hitCount ?? entity.mergedHitCount)}</strong>
      <button type="button" title="解除关系" aria-label="解除关系" onClick={() => onUnlink(entity, kind)}>
        <Unlink2 size={14} />
        解
      </button>
    </div>
  );
}

function BindingRow({ row, onBind, onClear }) {
  const node = row?.node || {};
  const status = row?.status === 'ignored' ? 'ignored' : 'bound';
  return (
    <div className={`maintenance-binding-row ${status}`}>
      <span className="maintenance-binding-status">
        {nodeStatusIcon(status)}
        {nodeStatusText(status)}
      </span>
      <code>{node.address || node.id || '未定位'}</code>
      <span>{node.textPreview || node.title || '无正文片段'}</span>
      <strong>{hitText(row?.hitCount)}</strong>
      {status === 'ignored' ? (
        <button type="button" onClick={() => onBind(row)}>
          <Plus size={14} />
          绑
        </button>
      ) : (
        <button type="button" onClick={() => onClear(row)}>
          <Unlink2 size={14} />
          解
        </button>
      )}
    </div>
  );
}

export function EntityMaintenanceWindow() {
  const initialDocId = initialDocIdFromLocation();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [docs, setDocs] = useState([]);
  const [docFilter, setDocFilter] = useState('');
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeAllDocs, setScopeAllDocs] = useState(false);
  const [selectedDocIds, setSelectedDocIds] = useState(() => (initialDocId ? [initialDocId] : []));
  const [entityQuery, setEntityQuery] = useState('');
  const [entities, setEntities] = useState([]);
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [entityDetail, setEntityDetail] = useState(null);
  const [bindingQuery, setBindingQuery] = useState('');
  const [bindingSort, setBindingSort] = useState('node:asc');
  const [bindingRows, setBindingRows] = useState([]);
  const [manualNodeId, setManualNodeId] = useState('');

  const selectedDocKey = selectedDocIds.join(',');
  const showEntityDocTitle = scopeAllDocs || selectedDocIds.length !== 1;

  const filteredDocs = useMemo(() => {
    const q = docFilter.trim().toLocaleLowerCase();
    if (!q) return docs;
    return docs.filter((doc) => docDisplayTitle(doc).toLocaleLowerCase().includes(q));
  }, [docs, docFilter]);

  const scopeLabel = useMemo(() => {
    if (scopeAllDocs) return '全部文档';
    if (selectedDocIds.length === 0) return '未选文档';
    if (selectedDocIds.length > 1) return `${selectedDocIds.length} 个文档`;
    const doc = docs.find((item) => String(item.id) === String(selectedDocIds[0]));
    return doc ? `当前文档: ${docDisplayTitle(doc)}` : '当前文档';
  }, [docs, scopeAllDocs, selectedDocIds]);

  function scopePayload() {
    return {
      allDocs: scopeAllDocs,
      docIds: scopeAllDocs ? [] : selectedDocIds
    };
  }

  async function runBusy(task) {
    setBusy(true);
    try {
      return await task();
    } catch (error) {
      setNotice(error.message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function refreshEntities(options: any = {}) {
    const result = await fetchEntityList({
      readDatabase,
      ...scopePayload(),
      query: entityQuery
    });
    const rows = result?.rows || [];
    setEntities(rows);
    if (!options.keepSelection) return rows;
    if (!selectedEntity) return rows;
    const nextSelected = rows.find((row) => String(row.id) === String(selectedEntity.id)) || null;
    setSelectedEntity(nextSelected);
    return rows;
  }

  async function refreshSelectedEntity(entity = selectedEntity) {
    if (!entity?.id || !entity?.docId) {
      setEntityDetail(null);
      setBindingRows([]);
      return null;
    }
    const detail = await fetchEntityDetail({
      readDatabase,
      docId: entity.docId,
      entityId: entity.id
    });
    setEntityDetail(detail || null);
    return detail;
  }

  async function refreshBindings(entity = selectedEntity, sortValue = bindingSort, queryValue = bindingQuery) {
    if (!entity?.id || !entity?.docId) {
      setBindingRows([]);
      return null;
    }
    const sort = bindingSortPayload(sortValue);
    const result = await fetchEntityBindings({
      readDatabase,
      docId: entity.docId,
      entityId: entity.id,
      query: queryValue || entity.literal,
      sortBy: sort.sortBy,
      sortDirection: sort.sortDirection
    });
    setBindingRows(result?.rows || []);
    return result;
  }

  async function selectEntity(entity) {
    setSelectedEntity(entity);
    const query = entity?.literal || '';
    setBindingQuery(query);
    await runBusy(async () => {
      await refreshSelectedEntity(entity);
      await refreshBindings(entity, bindingSort, query);
    });
  }

  async function changeBindingSort(value) {
    setBindingSort(value);
    await runBusy(() => refreshBindings(selectedEntity, value));
  }

  function dragEntity(event, entity) {
    event.dataTransfer.setData('application/x-iftree-entity', entityDragPayload(entity));
    event.dataTransfer.setData('text/plain', entity.literal || '');
    event.dataTransfer.effectAllowed = 'copy';
  }

  async function dropRelation(event, kind) {
    event.preventDefault();
    const source = entityFromDragEvent(event);
    if (!selectedEntity?.id || !source?.id) return;
    if (String(source.id) === String(selectedEntity.id)) {
      setNotice('不能把实体连接到自身。');
      return;
    }
    await runBusy(async () => {
      await linkEntities({
        writeDatabase,
        docId: selectedEntity.docId,
        sourceEntityId: selectedEntity.id,
        targetEntityId: source.id,
        kind
      });
      await refreshEntities({ keepSelection: true });
      await refreshSelectedEntity(selectedEntity);
    });
  }

  async function unlinkRelation(entity, kind) {
    if (!selectedEntity?.id || !entity?.id) return;
    await runBusy(async () => {
      await unlinkEntities({
        writeDatabase,
        docId: selectedEntity.docId,
        sourceEntityId: selectedEntity.id,
        targetEntityId: entity.id,
        kind
      });
      await refreshEntities({ keepSelection: true });
      await refreshSelectedEntity(selectedEntity);
    });
  }

  async function createFromQuery() {
    const literal = entityQuery.trim();
    if (!literal) {
      setNotice('请先在搜索框输入实体。');
      return;
    }
    if (scopeAllDocs || selectedDocIds.length !== 1) {
      setNotice('新建实体前请只选择一个文档。');
      return;
    }
    await runBusy(async () => {
      const result = await createEntity({
        writeDatabase,
        docId: selectedDocIds[0],
        literal
      });
      await refreshEntities();
      if (result?.entity) await selectEntity(result.entity);
    });
  }

  async function deleteSelectedEntity() {
    if (!selectedEntity?.id) return;
    const ok = window.confirm(`删除实体「${entityLabel(selectedEntity, { showDocTitle: showEntityDocTitle })}」？`);
    if (!ok) return;
    await runBusy(async () => {
      await deleteEntity({
        writeDatabase,
        docId: selectedEntity.docId,
        entityId: selectedEntity.id
      });
      setSelectedEntity(null);
      setEntityDetail(null);
      setBindingRows([]);
      await refreshEntities();
    });
  }

  async function clearRow(row) {
    if (!selectedEntity?.id || !row?.node?.id) return;
    await runBusy(async () => {
      await removeEntityNodeBinding({
        writeDatabase,
        docId: selectedEntity.docId,
        entityId: selectedEntity.id,
        row
      });
      await refreshBindings(selectedEntity);
    });
  }

  async function bindRow(row) {
    if (!selectedEntity?.id || !row?.node?.id) return;
    await runBusy(async () => {
      await bindEntityNode({
        writeDatabase,
        docId: selectedEntity.docId,
        entityId: selectedEntity.id,
        nodeId: row.node.id
      });
      await refreshBindings(selectedEntity);
    });
  }

  async function bindManualNode() {
    const nodeId = String(manualNodeId || '').trim();
    if (!selectedEntity?.id || !nodeId) {
      setNotice('请粘贴节点 UUID。');
      return;
    }
    await runBusy(async () => {
      await bindEntityNode({
        writeDatabase,
        docId: selectedEntity.docId,
        entityId: selectedEntity.id,
        nodeId
      });
      setManualNodeId('');
      await refreshBindings(selectedEntity);
    });
  }

  function toggleDoc(docId) {
    const id = String(docId || '').trim();
    if (!id) return;
    setScopeAllDocs(false);
    setSelectedDocIds((current) => (
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    ));
  }

  function toggleAllDocs(checked) {
    setScopeAllDocs(checked);
    setSelectedDocIds(checked ? docs.map((doc) => doc.id) : []);
    if (!checked) {
      setEntities([]);
      setSelectedEntity(null);
      setEntityDetail(null);
      setBindingRows([]);
    }
  }

  useEffect(() => {
    let alive = true;
    runBusy(async () => {
      const rows = await documentRepository.listDocs();
      if (!alive) return;
      setDocs(rows || []);
      if (!initialDocId && rows?.[0]?.id) setSelectedDocIds([rows[0].id]);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (selectedDocIds.length === 0 && !scopeAllDocs) {
      setEntities([]);
      setSelectedEntity(null);
      setEntityDetail(null);
      setBindingRows([]);
      return;
    }
    runBusy(() => refreshEntities());
  }, [scopeAllDocs, selectedDocKey]);

  useEffect(() => {
    const api = rawIftreeApi();
    if (typeof api.setMenuHandler !== 'function') return undefined;
    api.setMenuHandler((action) => {
      if (action?.type !== 'entity-maintenance:focus') return;
      const docId = String(action.docId || '').trim();
      if (docId) {
        setScopeAllDocs(false);
        setSelectedDocIds([docId]);
      }
    });
    return () => api.setMenuHandler(null);
  }, []);

  const detailEntity = entityDetail?.entity || selectedEntity;
  const synonyms = Array.isArray(entityDetail?.synonyms) ? entityDetail.synonyms : [];
  const related = Array.isArray(entityDetail?.related) ? entityDetail.related : [];

  return (
    <div className="entity-maintenance-app" aria-busy={busy}>
      <WindowTitlebar title="实体库维护" />
      <main className="entity-maintenance-shell">
        <header className="entity-maintenance-title">
          <div>
            <Database size={18} />
            <h1>实体库维护</h1>
          </div>
          <span>{scopeLabel}</span>
        </header>

        {notice && <button type="button" className="entity-maintenance-notice" onClick={() => setNotice('')}>{notice}</button>}

        <section className="entity-maintenance-grid">
          <aside className="maintenance-column maintenance-library">
            <header className="maintenance-column-header">
              <strong>实体库</strong>
              <span>BM25 搜索</span>
            </header>
            <div className="maintenance-search-row">
              <input
                value={entityQuery}
                onChange={(event) => setEntityQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runBusy(() => refreshEntities());
                }}
                placeholder="搜索或输入新实体"
              />
              <button type="button" onClick={() => runBusy(() => refreshEntities())}>
                <Search size={14} />
              </button>
              <button type="button" onClick={createFromQuery}>
                <Plus size={14} />
                新建
              </button>
            </div>
            <div className="maintenance-entity-list">
              {entities.length > 0 ? entities.map((entity) => (
                <EntityLibraryRow
                  key={entity.id}
                  entity={entity}
                  active={String(selectedEntity?.id || '') === String(entity.id)}
                  showDocTitle={showEntityDocTitle}
                  onSelect={selectEntity}
                  onDragStart={dragEntity}
                />
              )) : <div className="maintenance-empty">没有实体。</div>}
            </div>
            <div className={`entity-scope-picker${scopeOpen ? ' open' : ''}`}>
              <button
                type="button"
                className="entity-scope-toggle"
                aria-expanded={scopeOpen}
                onClick={() => setScopeOpen((current) => !current)}
              >
                <span>{scopeOpen ? '▾' : '▸'}</span>
                {scopeLabel}
              </button>
              {scopeOpen && (
                <>
                  <div className="entity-scope-controls">
                    <input
                      value={docFilter}
                      onChange={(event) => setDocFilter(event.target.value)}
                      placeholder="按文档名搜索"
                    />
                    <label>
                      <input
                        type="checkbox"
                        checked={scopeAllDocs}
                        onChange={(event) => toggleAllDocs(event.target.checked)}
                      />
                      全部文档
                    </label>
                  </div>
                  <div className="entity-scope-docs">
                    {filteredDocs.map((doc) => (
                      <label key={doc.id}>
                        <input
                          type="checkbox"
                          checked={scopeAllDocs || selectedDocIds.includes(doc.id)}
                          onChange={() => toggleDoc(doc.id)}
                        />
                        <span title={docDisplayTitle(doc)}>{docDisplayTitle(doc)}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          </aside>

          <section className="maintenance-column maintenance-relations">
            <header className="maintenance-selected-header">
              <div>
                <span>已选中</span>
                <strong>{detailEntity ? entityLabel(detailEntity, { showDocTitle: showEntityDocTitle }) : '未选择实体'}</strong>
                {detailEntity && <small>{hitText(detailEntity.mergedHitCount ?? detailEntity.hitCount)}</small>}
              </div>
              <button type="button" disabled={!selectedEntity} onClick={deleteSelectedEntity}>
                <Trash2 size={14} />
                删
              </button>
            </header>

            <div
              className="maintenance-relation-section"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropRelation(event, 'synonym')}
            >
              <div className="maintenance-section-title">
                <span>同义</span>
                <small>命中合并 · 从左栏拖入</small>
              </div>
              {synonyms.length > 0 ? synonyms.map((entity) => (
                <RelationRow key={`synonym-${entity.id}`} entity={entity} kind="synonym" showDocTitle={showEntityDocTitle} onUnlink={unlinkRelation} />
              )) : <div className="maintenance-drop-empty">拖入实体建立同义关系。</div>}
            </div>

            <div
              className="maintenance-relation-section"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => dropRelation(event, 'related')}
            >
              <div className="maintenance-section-title">
                <span>相关</span>
                <small>无向不合并 · 从左栏拖入</small>
              </div>
              {related.length > 0 ? related.map((entity) => (
                <RelationRow key={`related-${entity.id}`} entity={entity} kind="related" showDocTitle={showEntityDocTitle} onUnlink={unlinkRelation} />
              )) : <div className="maintenance-drop-empty">拖入实体建立相关关系。</div>}
            </div>
          </section>

          <section className="maintenance-column maintenance-bindings">
            <header className="maintenance-column-header">
              <strong>节点关键词</strong>
              <span>绑定状态</span>
            </header>
            <div className="maintenance-binding-search">
              <input
                value={bindingQuery}
                onChange={(event) => setBindingQuery(event.target.value)}
                placeholder="当前实体"
                disabled={!selectedEntity}
              />
              <select
                value={bindingSort}
                disabled={!selectedEntity}
                aria-label="节点绑定排序"
                onChange={(event) => changeBindingSort(event.target.value)}
              >
                {BINDING_SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <button type="button" disabled={!selectedEntity} onClick={() => runBusy(() => refreshBindings())}>
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="maintenance-binding-list">
              {bindingRows.length > 0 ? bindingRows.map((row) => (
                <BindingRow
                  key={`${row.status}-${row.node?.id}`}
                  row={row}
                  onBind={bindRow}
                  onClear={clearRow}
                />
              )) : <div className="maintenance-empty">选择实体后显示绑定节点。</div>}
            </div>
            <div className="maintenance-manual-bind">
              <span>补绑节点</span>
              <input
                value={manualNodeId}
                onChange={(event) => setManualNodeId(event.target.value)}
                placeholder="粘贴节点 UUID"
                disabled={!selectedEntity}
              />
              <button type="button" disabled={!selectedEntity} onClick={bindManualNode}>
                <Plus size={14} />
                加
              </button>
            </div>
          </section>
        </section>
      </main>
    </div>
  );
}
