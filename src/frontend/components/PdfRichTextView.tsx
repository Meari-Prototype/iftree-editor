import { PanelLeftClose, PanelRightOpen
} from 'lucide-react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { useEffect, useMemo, useRef, useState } from 'react';
import { canvas2dContextOptions } from '../../core/hardware-strategy.mjs';
import { plainNodeNote } from '../../core/node-notes.mjs';




import { collectNodeAndDescendantIds } from './RichTextView.jsx';
import { base64ToUint8Array, formatSourceSentenceLabel, sourceRangeForSpans, sourceRangesForSpans, sourceSpanAbsoluteStart, sourceSpanKey } from './SourceBlocks.jsx';
import { readSourcePdfData, readSourcePdfHighlights, readSourcePdfSpanRects } from '../data/source-repository.js';
import { depthOf, hasKnownChildren } from '../lib/doc-utils.mjs';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PDF_SCROLL_TOP_PADDING = 72;
const PDF_PAGE_EDGE_PADDING = 22;

function nodeIdSetHas(set, id) {
  if (!set || id === null || id === undefined) return false;
  if (set.has(id)) return true;
  const text = String(id);
  if (set.has(text)) return true;
  const number = Number(text);
  return Number.isInteger(number) && number > 0 && set.has(number);
}

function buildPdfGutterRows(nodes, { baseDepth, collapsed, expanded, depthLimit, sourceSpans, showTitles, showNotes }) {
  const rows = [];
  const cappedDepth = Math.max(1, Number(depthLimit) || 1);
  const orderedSpans = [...(sourceSpans || [])].sort((a, b) => sourceSpanAbsoluteStart(a) - sourceSpanAbsoluteStart(b));

  const visit = (node) => {
    const hasChildren = hasKnownChildren(node);
    const nodeDepth = depthOf(node.address || '1');
    const rowExpanded = hasChildren
      && !nodeIdSetHas(collapsed, node.id)
      && (nodeDepth < cappedDepth || nodeIdSetHas(expanded, node.id));
    const ids = new Set();
    collectNodeAndDescendantIds(node, ids);
    const spans = orderedSpans.filter((span) => ids.has(String(span.node_id)));
    if (spans.length > 0) {
      rows.push({
        node,
        spans,
        sentenceLabel: formatSourceSentenceLabel(spans),
        range: sourceRangeForSpans(spans),
        ranges: sourceRangesForSpans(spans),
        hasChildren,
        expanded: rowExpanded,
        localDepth: Math.max(0, nodeDepth - baseDepth),
        title: showTitles ? String(node.title || '').trim() : '',
        note: showNotes ? plainNodeNote(node.note || '').trim() : ''
      });
    }
    if (rowExpanded) (node.children || []).forEach(visit);
  };

  nodes.forEach(visit);
  return rows;
}

function rangeForSpan(span) {
  return sourceRangeForSpans(span ? [span] : []);
}

function rangeKey(range) {
  return range ? `${range.start}:${range.end}` : '';
}

function rangesKey(ranges) {
  return (ranges || []).map(rangeKey).join(',');
}

function rectSortKey(left, right) {
  return Number(left.page_number) - Number(right.page_number) ||
    Number(left.y0) - Number(right.y0) ||
    Number(left.x0) - Number(right.x0);
}

function pdfRectStyle(rect, scale) {
  return {
    left: `${Number(rect.x0) * scale}px`,
    top: `${Number(rect.y0) * scale}px`,
    width: `${Math.max(1, Number(rect.x1) - Number(rect.x0)) * scale}px`,
    height: `${Math.max(1, Number(rect.y1) - Number(rect.y0)) * scale}px`
  };
}

function groupRectsByPage(rects) {
  const map = new Map();
  for (const rect of rects || []) {
    const page = Number(rect.page_number);
    if (!map.has(page)) map.set(page, []);
    map.get(page).push(rect);
  }
  return map;
}

function rectOverlapsRange(rect, range) {
  if (!range) return false;
  const start = Number(rect.start_offset);
  const end = Number(rect.end_offset);
  return Number.isFinite(start) && Number.isFinite(end) && start < range.end && end > range.start;
}

function firstRectForRanges(rects, ranges) {
  if (!ranges?.length) return null;
  return (rects || [])
    .filter((rect) => ranges.some((range) => rectOverlapsRange(rect, range)))
    .sort(rectSortKey)[0] || null;
}

function sourceSpansForNodeSelection(nodeId, nodeById, sourceSpans) {
  if (nodeId === null || nodeId === undefined) return [];
  const ids = new Set();
  const node = nodeById.get(String(nodeId));
  if (node) collectNodeAndDescendantIds(node, ids);
  ids.add(String(nodeId));
  return (sourceSpans || [])
    .filter((span) => ids.has(String(span.node_id)))
    .sort((left, right) => sourceSpanAbsoluteStart(left) - sourceSpanAbsoluteStart(right));
}

function nodeSelection(nodeId, nodeById, sourceSpans, origin) {
  if (nodeId === null || nodeId === undefined) return null;
  const spans = sourceSpansForNodeSelection(nodeId, nodeById, sourceSpans);
  const range = sourceRangeForSpans(spans);
  const ranges = sourceRangesForSpans(spans);
  if (!range || ranges.length === 0) return null;
  return { key: `node:${nodeId}`, kind: 'node', nodeId, range, ranges, origin };
}

function spanSelection(span, origin) {
  const range = rangeForSpan(span);
  const ranges = sourceRangesForSpans(span ? [span] : []);
  if (!range || ranges.length === 0) return null;
  const key = sourceSpanKey(span) || `${span?.node_id ?? ''}:${span?.sentence_index ?? ''}:${rangeKey(range)}`;
  return { key: `span:${key}`, kind: 'span', nodeId: span?.node_id ?? null, range, ranges, origin };
}

export function PdfRichTextView({
  currentDoc,
  docId,
  selectedNodeId,
  setSelectedNodeId,
  depthModel,
  nodeById,
  depthLimit,
  collapsed = new Set(),
  expanded = new Set(),
  toggleCollapsed,
  showLeftInfo = true,
  showTitles,
  showNotes
}) {
  const sourceSpans = currentDoc?.sourceWindow?.sourceSpans || currentDoc?.sourceSpans || [];
  const sourcePdfPages = currentDoc?.sourcePdfPages || [];
  const [pdfDoc, setPdfDoc] = useState(null);
  const [pdfError, setPdfError] = useState('');
  const [selectionRects, setSelectionRects] = useState([]);
  const [hoverRects, setHoverRects] = useState([]);
  const [spanHitRects, setSpanHitRects] = useState([]);
  const [hoverRanges, setHoverRanges] = useState(null);
  const [hoverNodeId, setHoverNodeId] = useState(null);
  const [selection, setSelection] = useState(null);
  const [gutterCollapsed, setGutterCollapsed] = useState(false);
  const pageStackRef = useRef(null);
  const gutterRef = useRef(null);
  const gutterRowRefs = useRef(new Map());
  const pdfScrollKeyRef = useRef('');
  const gutterScrollKeyRef = useRef('');
  const scale = 1.25;

  const roots = useMemo(() => (
    currentDoc?.tree ? [currentDoc.tree] : (depthModel.targetNodes || [])
  ), [currentDoc?.tree, depthModel.targetNodes]);
  const baseDepth = roots.length > 0
    ? Math.min(...roots.map((node) => depthOf(node.address || '1')))
    : 1;
  const rows = useMemo(() => (
    buildPdfGutterRows(roots, {
      baseDepth,
      collapsed,
      expanded,
      depthLimit,
      sourceSpans,
      showTitles,
      showNotes
    })
  ), [roots, baseDepth, collapsed, expanded, depthLimit, sourceSpans, showTitles, showNotes]);
  const spanByKey = useMemo(() => {
    const map = new Map();
    for (const span of sourceSpans || []) {
      const key = sourceSpanKey(span);
      if (key) map.set(key, span);
      if (span?.id) map.set(String(span.id), span);
    }
    return map;
  }, [sourceSpans]);
  const hitRectsByPage = useMemo(() => {
    const map = new Map();
    for (const rect of spanHitRects || []) {
      const page = Number(rect.page_number);
      if (!map.has(page)) map.set(page, []);
      map.get(page).push(rect);
    }
    const rectDepth = (rect) => depthOf(nodeById.get(String(rect.node_id))?.address || '1');
    for (const rects of map.values()) rects.sort((left, right) => rectDepth(left) - rectDepth(right));
    return map;
  }, [nodeById, spanHitRects]);

  useEffect(() => {
    let alive = true;
    setPdfDoc(null);
    setPdfError('');
    setSpanHitRects([]);
    setSelectionRects([]);
    setHoverRects([]);
    setHoverRanges(null);
    setHoverNodeId(null);
    setSelection(null);
    pdfScrollKeyRef.current = '';
    gutterScrollKeyRef.current = '';
    readSourcePdfData(docId)
      .then(async (payload) => {
        if (!alive) return;
        if (!payload?.base64) {
          setPdfError('PDF 源文件不可用');
          return;
        }
        const pdf = await getDocument({
          data: base64ToUint8Array(payload.base64)
        }).promise;
        if (alive) setPdfDoc(pdf);
      })
      .catch((error) => {
        if (alive) setPdfError(String(error?.message || error));
      });
    return () => { alive = false; };
  }, [docId]);

  useEffect(() => {
    let alive = true;
    readSourcePdfSpanRects(docId)
      .then((rects) => {
        if (alive) setSpanHitRects(rects || []);
      })
      .catch(() => {
        if (alive) setSpanHitRects([]);
      });
    return () => { alive = false; };
  }, [docId]);

  const externalSelection = useMemo(() => (
    nodeSelection(selectedNodeId, nodeById, sourceSpans, 'external')
  ), [selectedNodeId, nodeById, sourceSpans]);
  const activeSelection = useMemo(() => {
    if (!selectedNodeId) return null;
    if (selection?.nodeId !== null && selection?.nodeId !== undefined && String(selection.nodeId) === String(selectedNodeId)) {
      return selection;
    }
    return externalSelection;
  }, [selection, selectedNodeId, externalSelection]);
  // 选区与悬停分两层互不替换：选区是常驻淡色底（父节点选中会覆盖全部
  // 后代正文，染太亮等于"全选"），悬停是亮色跟手层（指哪亮哪）。
  // 合并成一个 ranges 会让悬停反复抹掉/恢复选区底色，大面积闪烁。
  const selectionRanges = activeSelection?.ranges || null;
  const selectionRangesKey = rangesKey(selectionRanges);
  const hoverRangesKey = rangesKey(hoverRanges);

  useEffect(() => {
    let alive = true;
    if (!selectionRanges?.length) {
      setSelectionRects([]);
      return () => { alive = false; };
    }
    readSourcePdfHighlights({
      docId,
      ranges: selectionRanges.map((range) => ({ start: range.start, end: range.end }))
    }).then((rects) => {
      if (alive) setSelectionRects(rects || []);
    }).catch(() => {
      if (alive) setSelectionRects([]);
    });
    return () => { alive = false; };
  }, [docId, selectionRangesKey]);

  useEffect(() => {
    let alive = true;
    if (!hoverRanges?.length) {
      setHoverRects([]);
      return () => { alive = false; };
    }
    readSourcePdfHighlights({
      docId,
      ranges: hoverRanges.map((range) => ({ start: range.start, end: range.end }))
    }).then((rects) => {
      if (alive) setHoverRects(rects || []);
    }).catch(() => {
      if (alive) setHoverRects([]);
    });
    return () => { alive = false; };
  }, [docId, hoverRangesKey]);

  const selectionRectsByPage = useMemo(() => groupRectsByPage(selectionRects), [selectionRects]);
  const hoverRectsByPage = useMemo(() => groupRectsByPage(hoverRects), [hoverRects]);

  const pages = sourcePdfPages.length > 0
    ? sourcePdfPages
    : Array.from({ length: pdfDoc?.numPages || 0 }, (_, index) => ({
      page_number: index + 1,
      width: 595,
      height: 842
    }));

  // 取消选中必须连 hover 一起清：再次单击取消时鼠标还停在原句/原行上，
  // hover 高亮不清的话取消前后画面一个像素都不变，看起来就是"取消没生效"。
  function clearSelection() {
    setSelection(null);
    setHoverNodeId(null);
    setHoverRanges(null);
    pdfScrollKeyRef.current = '';
    gutterScrollKeyRef.current = '';
    setSelectedNodeId(null);
  }

  function scrollPdfToRect(rect) {
    const container = pageStackRef.current;
    const page = container?.querySelector?.(`[data-page-number="${Number(rect?.page_number)}"]`);
    if (!container || !page) return false;
    const targetTop = page.offsetTop + Number(rect.y0 || 0) * scale;
    const pageTop = page.offsetTop;
    container.scrollTo({
      left: container.scrollLeft,
      top: Math.max(0, Math.max(pageTop - PDF_PAGE_EDGE_PADDING, targetTop - PDF_SCROLL_TOP_PADDING)),
      behavior: 'auto'
    });
    return true;
  }

  function scrollGutterToRow(row) {
    const gutter = gutterRef.current;
    if (!gutter || !row) return false;
    const stickyHead = gutter.querySelector('.pdf-gutter-sticky-head');
    const stickyHeight = Number(stickyHead?.offsetHeight || 0);
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    const visibleTop = gutter.scrollTop + stickyHeight;
    const visibleBottom = gutter.scrollTop + gutter.clientHeight;
    if (rowTop < visibleTop) {
      gutter.scrollTo({ top: Math.max(0, rowTop - stickyHeight - 6), behavior: 'auto' });
      return true;
    }
    if (rowBottom > visibleBottom) {
      gutter.scrollTo({ top: Math.max(0, rowBottom - gutter.clientHeight + 6), behavior: 'auto' });
      return true;
    }
    return true;
  }

  function selectGutterRow(row) {
    const next = { key: `node:${row.node.id}`, kind: 'node', nodeId: row.node.id, range: row.range, ranges: row.ranges, origin: 'gutter' };
    if (activeSelection?.key === next.key) {
      clearSelection();
      return;
    }
    setSelection(next);
    setSelectedNodeId(row.node.id);
  }

  function spanFromHitRect(rect) {
    const fallback = {
      id: rect.span_id,
      node_id: rect.node_id,
      sentence_index: rect.sentence_index,
      start_offset: rect.start_offset,
      end_offset: rect.end_offset
    };
    return spanByKey.get(String(rect.span_id || '')) || spanByKey.get(sourceSpanKey(fallback)) || fallback;
  }

  function selectPdfSpan(rect) {
    const span = spanFromHitRect(rect);
    const next = spanSelection(span, 'pdf');
    if (!next) return;
    if (activeSelection?.key === next.key) {
      clearSelection();
      return;
    }
    setSelection(next);
    setSelectedNodeId(span.node_id || null);
  }

  function hoverPdfSpan(rect) {
    const span = spanFromHitRect(rect);
    setHoverNodeId(span.node_id || null);
    setHoverRanges(sourceRangesForSpans(span ? [span] : []));
  }

  useEffect(() => {
    if (!activeSelection || activeSelection.origin === 'pdf') return;
    const scrollKey = `${activeSelection.origin}:${activeSelection.key}`;
    if (pdfScrollKeyRef.current === scrollKey) return;
    const firstRect = firstRectForRanges(spanHitRects, activeSelection.ranges);
    if (firstRect && scrollPdfToRect(firstRect)) pdfScrollKeyRef.current = scrollKey;
  }, [activeSelection, spanHitRects, pdfDoc, pages.length, scale]);

  useEffect(() => {
    if (!activeSelection || gutterCollapsed) return;
    const row = gutterRowRefs.current.get(String(activeSelection.nodeId));
    if (!row) return;
    const scrollKey = `${activeSelection.key}:${rows.length}`;
    if (gutterScrollKeyRef.current === scrollKey) return;
    if (scrollGutterToRow(row)) gutterScrollKeyRef.current = scrollKey;
  }, [activeSelection, rows, gutterCollapsed]);

  return (
    <div className={`rich-surface pdf-rich-surface ${gutterCollapsed || !showLeftInfo ? 'gutter-collapsed' : ''} ${showLeftInfo ? '' : 'hide-left-info'}`}>
      {showLeftInfo ? (
        <aside ref={gutterRef} className="pdf-source-gutter">
          <div className="pdf-gutter-sticky-head">
            <button
              type="button"
              className="pdf-gutter-toggle"
              onClick={() => setGutterCollapsed((value) => !value)}
              title={gutterCollapsed ? '展开源位置栏' : '折叠源位置栏'}
            >
              {gutterCollapsed ? <PanelRightOpen size={14} /> : <PanelLeftClose size={14} />}
            </button>
            {!gutterCollapsed && (
              <div className="pdf-gutter-head">
                <span>节点位置</span>
                <span>句子位置</span>
              </div>
            )}
          </div>
          {!gutterCollapsed && (
            <div className="pdf-gutter-rows">
              {rows.map((row) => {
                const selected = row.node.id === selectedNodeId;
                return (
                  <div
                    key={row.node.id}
                    ref={(element) => {
                      const key = String(row.node.id);
                      if (element) gutterRowRefs.current.set(key, element);
                      else gutterRowRefs.current.delete(key);
                    }}
                    role="button"
                    tabIndex={0}
                    className={`pdf-gutter-row ${selected ? 'selected' : ''} ${String(hoverNodeId || '') === String(row.node.id) ? 'hovered' : ''}`}
                    style={{ '--depth': row.localDepth }}
                    onMouseEnter={() => {
                      setHoverNodeId(row.node.id);
                      setHoverRanges(row.ranges);
                    }}
                    onMouseLeave={() => {
                      setHoverNodeId(null);
                      setHoverRanges(null);
                    }}
                    onClick={() => selectGutterRow(row)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      selectGutterRow(row);
                    }}
                  >
                    <span className="pdf-gutter-node">
                      <button
                        type="button"
                        className="pdf-gutter-fold-button"
                        disabled={!row.hasChildren}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (row.hasChildren) toggleCollapsed?.(row.node.id, { promoteDepth: false });
                        }}
                        title={row.expanded ? '折叠节点' : '展开节点'}
                      >
                        {row.hasChildren ? (row.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span />}
                      </button>
                      <span className="pdf-gutter-address">{row.node.address}</span>
                    </span>
                    <span>{row.sentenceLabel}</span>
                    {row.title ? <strong>{row.title}</strong> : null}
                    {row.note ? <em>{row.note}</em> : null}
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      ) : null}
      <section className="pdf-page-stack" ref={pageStackRef} onClick={clearSelection}>
        {!pdfDoc && !pdfError ? <div className="empty-state">PDF 载入中...</div> : null}
        {pdfError ? <div className="empty-state">{pdfError}</div> : null}
        {pdfDoc ? pages.map((page) => (
          <PdfPageView
            key={page.page_number}
            pdfDoc={pdfDoc}
            pageInfo={page}
            scale={scale}
            selectionHighlights={selectionRectsByPage.get(Number(page.page_number)) || []}
            hoverHighlights={hoverRectsByPage.get(Number(page.page_number)) || []}
            hitRects={hitRectsByPage.get(Number(page.page_number)) || []}
            onHitHover={hoverPdfSpan}
            onHitLeave={() => {
              setHoverNodeId(null);
              setHoverRanges(null);
            }}
            onHitClick={selectPdfSpan}
          />
        )) : null}
      </section>
    </div>
  );
}

export function PdfPageView({ pdfDoc, pageInfo, scale, selectionHighlights = [], hoverHighlights = [], hitRects = [], onHitHover, onHitLeave, onHitClick }) {
  const canvasRef = useRef(null);
  const pageNumber = Number(pageInfo.page_number);

  useEffect(() => {
    let renderTask = null;
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas || !pdfDoc || !pageNumber) return () => {};
    pdfDoc.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const context = canvas.getContext('2d', canvas2dContextOptions());
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      renderTask = page.render({ canvasContext: context, viewport });
      return renderTask.promise;
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (renderTask) renderTask.cancel();
    };
  }, [pdfDoc, pageNumber, scale]);

  const width = Number(pageInfo.width || 595) * scale;
  const height = Number(pageInfo.height || 842) * scale;

  return (
    <div className="pdf-page-shell" data-page-number={pageNumber} style={{ width, minHeight: height }}>
      <canvas ref={canvasRef} className="pdf-page-canvas" />
      <div className="pdf-highlight-layer">
        {(selectionHighlights || []).map((rect, index) => (
          <span
            key={`sel-${pageNumber}-${index}`}
            className="pdf-highlight-rect is-selection"
            style={pdfRectStyle(rect, scale)}
          />
        ))}
        {(hoverHighlights || []).map((rect, index) => (
          <span
            key={`hover-${pageNumber}-${index}`}
            className="pdf-highlight-rect"
            style={pdfRectStyle(rect, scale)}
          />
        ))}
      </div>
      <div className="pdf-hit-layer">
        {(hitRects || []).map((rect, index) => (
          <span
            key={`${pageNumber}-${rect.span_id || rect.sentence_index}-${index}`}
            role="button"
            tabIndex={-1}
            className="pdf-hit-rect"
            style={pdfRectStyle(rect, scale)}
            onMouseEnter={() => onHitHover?.(rect)}
            onMouseLeave={() => onHitLeave?.()}
            onClick={(event) => {
              event.stopPropagation();
              onHitClick?.(rect);
            }}
          />
        ))}
      </div>
    </div>
  );
}
