// @ts-nocheck
import { ChevronLeft, ChevronRight, Link2, LocateFixed, Search, Tags } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const ENTITY_TRACE_LEFT_MIN = 260;
const ENTITY_TRACE_RIGHT_MIN = 360;
const ENTITY_TRACE_RESIZER_WIDTH = 1;

function clampEntityTraceWidth(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function countText(value) {
  return `x${Number(value) || 0}`;
}

function rangeText({ total = 0, offset = 0, limit = 100, returned = 0 } = {}) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Number(limit) || 100);
  const safeReturned = Math.max(0, Number(returned) || 0);
  if (safeTotal <= 0) return `0 / 0 · 每页 ${safeLimit}`;
  const start = Math.min(safeOffset + 1, safeTotal);
  const end = Math.min(safeTotal, safeOffset + safeReturned);
  return `${start}-${end} / ${safeTotal} · 每页 ${safeLimit}`;
}

function docText(entity: any = {}) {
  return entity.docTitle ? `doc ${entity.docId} · ${entity.docTitle}` : `doc ${entity.docId ?? '-'}`;
}

function EntityRow({ entity, active = false, relation = '', onSelect, onDragStart }) {
  if (!entity) return null;
  return (
    <button
      type="button"
      className={`entity-row${active ? ' active' : ''}`}
      draggable
      onClick={() => onSelect?.(entity)}
      onDragStart={(event) => onDragStart?.(event, entity)}
    >
      <span className="entity-row-main">
        <strong>{entity.literal || '未命名实体'}</strong>
        <small>{docText(entity)}</small>
      </span>
      {relation && <span className="entity-relation-tag">{relation}</span>}
      <span className="entity-hit-count">{countText(entity.mergedHitCount ?? entity.hitCount)}</span>
    </button>
  );
}

function EntityDetail({ detail, selectedEntity, onUseEntityKeyword, onDragStart }) {
  const entity = detail?.entity || selectedEntity || null;
  const synonyms = Array.isArray(detail?.synonyms) ? detail.synonyms : [];
  const related = Array.isArray(detail?.related) ? detail.related : [];
  if (!entity) {
    return (
      <div className="entity-detail-empty">
        <Tags size={18} />
        <span>从实体列表选择一个实体。</span>
      </div>
    );
  }
  return (
    <div className="entity-detail">
      <div className="entity-section-title">
        <Tags size={15} />
        <span>当前实体</span>
      </div>
      <EntityRow
        entity={entity}
        active
        relation="当前"
        onSelect={onUseEntityKeyword}
        onDragStart={onDragStart}
      />
      <div className="entity-section-title compact">
        <span>同义</span>
        <strong>{synonyms.length}</strong>
      </div>
      {synonyms.length > 0 ? synonyms.map((item) => (
        <EntityRow
          key={`synonym-${item.id}`}
          entity={item}
          relation="同义"
          onSelect={onUseEntityKeyword}
          onDragStart={onDragStart}
        />
      )) : <div className="entity-inline-empty">无同义实体</div>}
      <div className="entity-section-title compact">
        <Link2 size={14} />
        <span>相关</span>
        <strong>{related.length}</strong>
      </div>
      {related.length > 0 ? related.map((item) => (
        <EntityRow
          key={`related-${item.id}`}
          entity={item}
          relation="相关"
          onSelect={onUseEntityKeyword}
          onDragStart={onDragStart}
        />
      )) : <div className="entity-inline-empty">无相关实体</div>}
    </div>
  );
}

function NodeResultRow({ result, onSelectNode }) {
  return (
    <button
      type="button"
      className="entity-node-row"
      onClick={() => onSelectNode?.(result.node_id, result)}
    >
      <code>{result.address || '未定位'}</code>
      <span>{result.text || '无正文片段'}</span>
      <strong>{countText(result.score)}</strong>
      <LocateFixed size={14} />
    </button>
  );
}

function NodeResults({ rows, groups, onSelectNode }) {
  const grouped = Array.isArray(groups) ? groups : [];
  const flatRows = Array.isArray(rows) ? rows : [];
  if (grouped.length > 0) {
    return grouped.map((group) => (
      <section className="entity-node-group" key={group.term}>
        <div className="entity-node-group-title">
          <span>{group.term}</span>
          <strong>{rangeText({
            total: group.total,
            offset: group.offset,
            limit: group.limit,
            returned: group.rows?.length || 0
          })}</strong>
        </div>
        {(group.rows || []).map((row) => (
          <NodeResultRow key={`${group.term}-${row.node_id}`} result={row} onSelectNode={onSelectNode} />
        ))}
      </section>
    ));
  }
  return flatRows.map((row) => (
    <NodeResultRow key={row.node_id} result={row} onSelectNode={onSelectNode} />
  ));
}

export function EntityTraceView({
  entityQuery,
  setEntityQuery,
  entityRows,
  entityDetail,
  selectedEntity,
  onSearchEntities,
  onSelectEntity,
  onUseEntityKeyword,
  onEntityDragStart,
  nodeQuery,
  setNodeQuery,
  nodeMatchMode,
  setNodeMatchMode,
  nodeRows,
  nodeGroups,
  nodePage,
  onSearchNodes,
  onPageNodes,
  onDropEntityTerm,
  onSelectNode,
  disabled = false
}) {
  const surfaceRef = useRef(null);
  const leftPanelRef = useRef(null);
  const [leftWidth, setLeftWidth] = useState(null);
  const hasEntityRows = Array.isArray(entityRows) && entityRows.length > 0;
  const hasNodeRows = (Array.isArray(nodeRows) && nodeRows.length > 0)
    || (Array.isArray(nodeGroups) && nodeGroups.length > 0);
  const nodePageReturned = Array.isArray(nodeRows) ? nodeRows.length : 0;
  const canPagePrev = (Number(nodePage?.offset) || 0) > 0;
  const canPageNext = Boolean(nodePage?.hasMore);

  useEffect(() => () => {
    document.body.classList.remove('entity-trace-resizing');
  }, []);

  function startTraceResize(event) {
    event.preventDefault();
    event.stopPropagation();
    const surface = surfaceRef.current;
    const leftPanel = leftPanelRef.current;
    if (!surface || !leftPanel) return;
    try {
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    } catch { /* pointer capture is best effort */ }

    const resizeHandle = event.currentTarget;
    const surfaceRect = surface.getBoundingClientRect();
    const startWidth = leftPanel.getBoundingClientRect().width;
    const maxWidth = Math.max(
      ENTITY_TRACE_LEFT_MIN,
      surfaceRect.width - ENTITY_TRACE_RIGHT_MIN - ENTITY_TRACE_RESIZER_WIDTH
    );
    const minWidth = Math.min(ENTITY_TRACE_LEFT_MIN, maxWidth);
    const startX = event.clientX;
    let latestWidth = clampEntityTraceWidth(startWidth, minWidth, maxWidth, startWidth);
    let frame = 0;
    const apply = () => {
      frame = 0;
      surface.style.setProperty('--entity-trace-left-width', `${latestWidth}px`);
    };

    document.body.classList.add('entity-trace-resizing');
    apply();

    const move = (moveEvent) => {
      moveEvent.preventDefault();
      latestWidth = clampEntityTraceWidth(
        startWidth + moveEvent.clientX - startX,
        minWidth,
        maxWidth,
        startWidth
      );
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      try {
        resizeHandle?.releasePointerCapture?.(event.pointerId);
      } catch { /* pointer may already be released */ }
      if (frame) {
        cancelAnimationFrame(frame);
        apply();
      }
      document.body.classList.remove('entity-trace-resizing');
      setLeftWidth(clampEntityTraceWidth(latestWidth, minWidth, maxWidth, startWidth));
    };

    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  return (
    <div
      className="entity-trace-surface"
      ref={surfaceRef}
      style={leftWidth ? { '--entity-trace-left-width': `${leftWidth}px` } : undefined}
    >
      <section className="entity-trace-panel entity-trace-left" ref={leftPanelRef}>
        <header className="entity-panel-header">
          <div>
            <strong>实体</strong>
            <span>同义与相关</span>
          </div>
          <div className="entity-searchbar">
            <input
              value={entityQuery}
              onChange={(event) => setEntityQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !disabled) onSearchEntities?.();
              }}
              placeholder="输入实体"
              disabled={disabled}
            />
            <button type="button" title="查找实体" aria-label="查找实体" disabled={disabled} onClick={onSearchEntities}>
              <Search size={15} />
            </button>
          </div>
        </header>
        <div className="entity-panel-body">
          <EntityDetail
            detail={entityDetail}
            selectedEntity={selectedEntity}
            onUseEntityKeyword={onUseEntityKeyword}
            onDragStart={onEntityDragStart}
          />
          <div className="entity-section-title">
            <span>实体列表</span>
            <strong>{entityRows?.length || 0}</strong>
          </div>
          <div className="entity-list">
            {hasEntityRows ? entityRows.map((entity) => (
              <EntityRow
                key={entity.id}
                entity={entity}
                active={String(selectedEntity?.id || '') === String(entity.id)}
                onSelect={onSelectEntity}
                onDragStart={onEntityDragStart}
              />
            )) : <div className="entity-inline-empty">输入实体后查找。</div>}
          </div>
        </div>
      </section>

      <button
        type="button"
        className="entity-trace-resizer"
        aria-label="调整实体追踪左右栏宽度"
        title="拖动调整左右栏宽度"
        onPointerDown={startTraceResize}
      />

      <section className="entity-trace-panel entity-trace-right">
        <header className="entity-panel-header">
          <div>
            <strong>节点关键词</strong>
            <span>正文证据</span>
          </div>
          <div
            className="entity-node-searchbar"
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDropEntityTerm}
          >
            <input
              value={nodeQuery}
              onChange={(event) => setNodeQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !disabled) onSearchNodes?.();
              }}
              placeholder="输入节点关键词"
              disabled={disabled}
            />
            <div className="entity-mode-toggle" role="group" aria-label="节点关键词匹配模式">
              <button
                type="button"
                className={nodeMatchMode === 'and' ? 'active' : ''}
                disabled={disabled}
                onClick={() => setNodeMatchMode('and')}
              >
                AND
              </button>
              <button
                type="button"
                className={nodeMatchMode === 'or' ? 'active' : ''}
                disabled={disabled}
                onClick={() => setNodeMatchMode('or')}
              >
                OR
              </button>
            </div>
            <button type="button" title="搜索节点" aria-label="搜索节点" disabled={disabled} onClick={onSearchNodes}>
              <Search size={15} />
            </button>
          </div>
        </header>
        <div className="entity-panel-body entity-node-results">
          {hasNodeRows ? (
            <>
              <div className="entity-node-pagebar">
                <span>{rangeText({ ...nodePage, returned: nodePageReturned })}</span>
                <div>
                  <button
                    type="button"
                    title="上一页"
                    aria-label="上一页"
                    disabled={disabled || !canPagePrev}
                    onClick={() => onPageNodes?.('prev')}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    type="button"
                    title="下一页"
                    aria-label="下一页"
                    disabled={disabled || !canPageNext}
                    onClick={() => onPageNodes?.('next')}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
              <NodeResults rows={nodeRows} groups={nodeGroups} onSelectNode={onSelectNode} />
            </>
          ) : (
            <div className="entity-detail-empty">
              <Search size={18} />
              <span>输入内容后执行搜索。</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
