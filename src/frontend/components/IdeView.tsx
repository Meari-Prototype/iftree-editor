import { ChevronDown, ChevronRight
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { plainNodeNote } from '../../core/node-notes.mjs';
import {
  depthOf, hasKnownChildren, nodeTypeLabel
} from '../lib/doc-utils.mjs';


import {
  DEFAULT_IDE_COLUMN_WIDTHS, IDE_COLUMN_LIMITS, buildVirtualRange, clampIdeColumnWidth, readIdeColumnWidthFromDom, readIdeColumnWidths
} from '../lib/ui-utils.mjs';
import { useScrollViewport } from '../hooks/useScrollViewport.js';
import { parseSourceNodeText, renderSyntaxLine } from './SourceBlocks.jsx';
export const IDE_HEADER_HEIGHT = 22;

export const IDE_ROW_MIN_HEIGHT = 24;

export const IDE_CODE_LINE_HEIGHT = 20;

export const IDE_VIRTUAL_OVERSCAN = 700;

export const IDE_NODE_INDENT_WIDTH = 24;

export const IDE_NODE_BASE_WIDTH = 52;

function nodeIdSetHas(set, id) {
  if (!set || id === null || id === undefined) return false;
  if (set.has(id)) return true;
  const text = String(id);
  if (set.has(text)) return true;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 && set.has(number);
}

export function ideRowHeight(parsed, extras: any = {}) {
  const codeLines = parsed?.codeLines?.length || 1;
  const titleLines = extras.title ? 1 : 0;
  const noteLines = extras.note ? Math.max(1, String(extras.note).split('\n').length) : 0;
  return Math.max(IDE_ROW_MIN_HEIGHT, (codeLines + titleLines + noteLines) * IDE_CODE_LINE_HEIGHT + 2);
}

export function buildVisibleIdeRows(nodes, { baseDepth, collapsed, expanded = new Set(), depthLimit, sentenceLabelByNodeId, showTitles = true, showNotes = true }) {
  const rows = [];
  const cappedDepth = Math.max(1, Number(depthLimit) || 1);
  const visit = (node) => {
    const parsed = parseSourceNodeText(node.text);
    const title = showTitles ? String(node.title || '').trim() : '';
    const note = showNotes ? plainNodeNote(node.note || '').trim() : '';
    const hasChildren = hasKnownChildren(node);
    const nodeDepth = depthOf(node.address || '1');
    const localDepth = Math.max(0, nodeDepth - baseDepth);
    const userExpanded = nodeIdSetHas(expanded, node.id);
    const rowExpanded = hasChildren
      && !nodeIdSetHas(collapsed, node.id)
      && (nodeDepth < cappedDepth || userExpanded);
    rows.push({
      type: 'node',
      key: `node-${node.id}`,
      node,
      parsed,
      hasChildren,
      expanded: rowExpanded,
      localDepth,
      sentenceLabel: sentenceLabelByNodeId?.get(node.id) || parsed.lineLabel || '',
      title,
      note,
      height: ideRowHeight(parsed, { title, note })
    });
    if (hasChildren && !rowExpanded) {
      rows.push({
        type: 'summary',
        key: `summary-${node.id}`,
        node,
        localDepth,
        summary: `${Math.max((node.children || []).length, Number(node.childCount ?? 0) || 0)} nodes`,
        height: IDE_ROW_MIN_HEIGHT
      });
    }
    if (rowExpanded) node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return rows;
}

export function IdeView({
  tree,
  selectedNodeId,
  setSelectedNodeId,
  collapsed,
  expanded = new Set(),
  toggleCollapsed,
  depthLimit,
  sentenceLabelByNodeId,
  axioms = [],
  showTitles = true,
  showNotes = true,
  showAxioms = true,
  locateRequest = null
}) {
  const editorRef = useRef(null);
  const { scrollRef, viewport, onScroll } = useScrollViewport();
  const roots = tree ? [tree] : [];
  const baseDepth = roots.length > 0
    ? Math.min(...roots.map((node) => depthOf(node.address || '1')))
    : 1;
  const maxLocalDepth = maxVisibleIdeLocalDepth(roots, baseDepth, collapsed, expanded, depthLimit);
  const [columnWidths, setColumnWidths] = useState(readIdeColumnWidths);
  const nodeColumnMinimumWidth = Math.max(
    IDE_COLUMN_LIMITS.node.min,
    maxLocalDepth * IDE_NODE_INDENT_WIDTH + IDE_NODE_BASE_WIDTH
  );
  const nodeColumnWidth = clampIdeColumnWidth(
    columnWidths.node,
    nodeColumnMinimumWidth,
    IDE_COLUMN_LIMITS.node.max,
    nodeColumnMinimumWidth
  );
  const sentenceColumnWidth = clampIdeColumnWidth(
    columnWidths.sentence,
    IDE_COLUMN_LIMITS.sentence.min,
    IDE_COLUMN_LIMITS.sentence.max,
    DEFAULT_IDE_COLUMN_WIDTHS.sentence
  );
  const liveColumnWidthsRef = useRef({ node: nodeColumnWidth, sentence: sentenceColumnWidth });
  const rows = useMemo(() => (
    buildVisibleIdeRows(roots, { baseDepth, collapsed, expanded, depthLimit, sentenceLabelByNodeId, showTitles, showNotes })
  ), [roots, baseDepth, collapsed, expanded, depthLimit, sentenceLabelByNodeId, showTitles, showNotes]);
  const rowHeights = useMemo(() => rows.map((row) => row.height), [rows]);
  const virtual = useMemo(() => (
    buildVirtualRange(
      rowHeights,
      Math.max(0, viewport.scrollTop - IDE_HEADER_HEIGHT),
      viewport.height,
      IDE_VIRTUAL_OVERSCAN
    )
  ), [rowHeights, viewport]);
  const visibleRows = rows.slice(virtual.start, virtual.end);

  // 跳转定位（16-3）：收到统一定位信号时，在可见行里按累加行高算出目标纵向位置并居中滚动。
  // 虚拟列表下目标行可能尚未渲染，所以用行高累加定位，不依赖目标 DOM 已存在。
  const lastLocateSeqRef = useRef(0);
  useEffect(() => {
    const seq = locateRequest?.seq || 0;
    const targetId = locateRequest?.nodeId;
    if (!seq || seq === lastLocateSeqRef.current || targetId == null) return;
    lastLocateSeqRef.current = seq;
    const index = rows.findIndex((row) => String(row.node?.id) === String(targetId));
    const el = scrollRef.current;
    if (index < 0 || !el) return;
    let offset = 0;
    for (let i = 0; i < index; i += 1) offset += rowHeights[i] || 0;
    const rowH = rowHeights[index] || 0;
    const centered = offset - Math.max(0, (el.clientHeight - IDE_HEADER_HEIGHT - rowH) / 2);
    el.scrollTop = Math.max(0, IDE_HEADER_HEIGHT + centered);
  }, [locateRequest?.seq, rows, rowHeights, scrollRef]);

  useEffect(() => {
    window.localStorage.setItem('iftree.ideColumnWidths', JSON.stringify(columnWidths));
  }, [columnWidths]);

  useEffect(() => {
    liveColumnWidthsRef.current = { node: nodeColumnWidth, sentence: sentenceColumnWidth };
  }, [nodeColumnWidth, sentenceColumnWidth]);

  function startColumnResize(column, event) {
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget?.setPointerCapture?.(event.pointerId);
    } catch { /* pointer capture is best effort */ }
    const resizeHandle = event.currentTarget;
    const startX = event.clientX;
    const cssProperty = column === 'node' ? '--node-column-width' : '--sentence-column-width';
    const limits = IDE_COLUMN_LIMITS[column];
    const min = column === 'node' ? nodeColumnMinimumWidth : limits.min;
    const max = Math.max(min, limits.max);
    const fallbackWidth = liveColumnWidthsRef.current[column] || (column === 'node' ? nodeColumnWidth : sentenceColumnWidth);
    const startWidth = clampIdeColumnWidth(
      readIdeColumnWidthFromDom(editorRef.current, cssProperty, fallbackWidth),
      min,
      max,
      fallbackWidth
    );
    let latestWidth = startWidth;
    let frame = 0;
    const apply = () => {
      frame = 0;
      editorRef.current?.style.setProperty(cssProperty, `${latestWidth}px`);
    };
    editorRef.current?.style.setProperty(cssProperty, `${startWidth}px`);
    liveColumnWidthsRef.current = { ...liveColumnWidthsRef.current, [column]: startWidth };
    document.body.classList.add('ide-resizing');
    const move = (moveEvent) => {
      moveEvent.preventDefault();
      latestWidth = clampIdeColumnWidth(startWidth + moveEvent.clientX - startX, min, max, startWidth);
      liveColumnWidthsRef.current = { ...liveColumnWidthsRef.current, [column]: latestWidth };
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
      document.body.classList.remove('ide-resizing');
      const committedWidth = clampIdeColumnWidth(latestWidth, min, max, startWidth);
      editorRef.current?.style.setProperty(cssProperty, `${committedWidth}px`);
      liveColumnWidthsRef.current = { ...liveColumnWidthsRef.current, [column]: committedWidth };
      setColumnWidths((current) => ({ ...current, [column]: committedWidth }));
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  return (
    <div className="ide-surface" ref={scrollRef} onScroll={onScroll}>
      <div
        ref={editorRef}
        className="ide-editor"
        role="tree"
        style={{
          '--node-column-width': `${nodeColumnWidth}px`,
          '--sentence-column-width': `${sentenceColumnWidth}px`
        }}
      >
        <div className="ide-header" role="presentation">
          <span>节点位置</span>
          <button type="button" className="ide-column-resizer" aria-label="调整节点位置列宽" onPointerDown={(event) => startColumnResize('node', event)} />
          <span>句子编号</span>
          <button type="button" className="ide-column-resizer" aria-label="调整句子编号列宽" onPointerDown={(event) => startColumnResize('sentence', event)} />
          <span>正文</span>
          <span />
        </div>
        {showAxioms ? <IdeAxiomFrontMatter axioms={axioms} /> : null}
        <div className="ide-virtual-spacer" style={{ height: virtual.top }} />
        {visibleRows.map((row) => (
          <IdeRow
            key={row.key}
            row={row}
            selectedNodeId={selectedNodeId}
            setSelectedNodeId={setSelectedNodeId}
            toggleCollapsed={toggleCollapsed}
          />
        ))}
        <div className="ide-virtual-spacer" style={{ height: virtual.bottom }} />
      </div>
    </div>
  );
}

export function IdeRow({ row, selectedNodeId, setSelectedNodeId, toggleCollapsed }) {
  if (row.type === 'summary') {
    return (
      <button
        type="button"
        className="ide-fold-summary"
        style={{ '--depth': row.localDepth + 1, minHeight: row.height }}
        onClick={() => {
          setSelectedNodeId(row.node.id);
          toggleCollapsed(row.node.id, { promoteDepth: false });
        }}
      >
        {row.summary}
      </button>
    );
  }

  const selected = selectedNodeId === row.node.id;
  return (
    <div
      className={`ide-node ${selected ? 'selected' : ''}`}
      style={{ '--depth': row.localDepth, minHeight: row.height }}
      onClick={() => setSelectedNodeId(row.node.id)}
    >
      <span className="ide-node-cell">
        <button
          type="button"
          className="ide-fold-button"
          disabled={!row.hasChildren}
          onClick={(event) => {
            event.stopPropagation();
            if (row.hasChildren) toggleCollapsed(row.node.id, { promoteDepth: false });
          }}
          title={row.expanded ? '折叠节点' : '展开节点'}
        >
          {row.hasChildren ? (row.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span />}
        </button>
        <span className="ide-address">{row.node.address}</span>
      </span>
      <span className="ide-column-gap" />
      <span className="ide-line-label">{row.sentenceLabel}</span>
      <span className="ide-column-gap" />
      <code className="ide-code-block">
        {row.title ? (
          <span className="ide-node-title-line">{row.title}</span>
        ) : null}
        {row.parsed.codeLines.map((line, index) => (
          <span key={`${row.key}-${index}`} className="ide-code-line">
            {renderSyntaxLine(line, `${row.key}-${index}`)}
          </span>
        ))}
        {row.note ? (
          <span className="ide-node-note-line">{row.note}</span>
        ) : null}
      </code>
      <span className="ide-node-kind">{nodeTypeLabel(row.node.nodeType)}</span>
    </div>
  );
}

export function IdeAxiomFrontMatter({ axioms = [] }) {
  const rows = Array.isArray(axioms)
    ? axioms
      .map((axiom) => ({
        key: axiom.id || axiom.label,
        label: String(axiom.label || '').trim(),
        content: String(axiom.content || '').trim()
      }))
      .filter((axiom) => axiom.label || axiom.content)
    : [];
  if (rows.length === 0) return null;
  return (
    <section className="ide-axiom-frontmatter" aria-label="事实前提">
      <span>---</span>
      {rows.map((axiom) => (
        <span key={axiom.key || axiom.label} className="ide-axiom-line">
          <span>{axiom.label}</span>
          <span>: </span>
          <span>{axiom.content}</span>
        </span>
      ))}
      <span>---</span>
    </section>
  );
}

export function maxVisibleIdeLocalDepth(nodes, baseDepth, collapsed, expanded = new Set(), depthLimit) {
  let maxDepth = 0;
  const cappedDepth = Math.max(1, Number(depthLimit) || 1);
  const visit = (node) => {
    const nodeDepth = depthOf(node.address || '1');
    maxDepth = Math.max(maxDepth, nodeDepth - baseDepth);
    const hasChildren = hasKnownChildren(node);
    const rowExpanded = hasChildren
      && !nodeIdSetHas(collapsed, node.id)
      && (nodeDepth < cappedDepth || nodeIdSetHas(expanded, node.id));
    if (!rowExpanded) return;
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return Math.max(0, maxDepth);
}
