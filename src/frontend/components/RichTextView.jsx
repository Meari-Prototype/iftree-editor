import { ArrowDown, ArrowUp
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { plainNodeNote } from '../../core/node-notes.mjs';
import { parseSourceMarkdownBlocks } from '../../core/source-markdown.mjs';
import { flattenTree } from '../../core/tree.mjs';
import { debugPerfBegin, debugPerfEnd } from '../lib/debug-log.mjs';
import {
  depthOf, docDisplayTitle
} from '../lib/doc-utils.mjs';


import { buildVirtualRange
} from '../lib/ui-utils.mjs';
import { IconButton } from './common.jsx';
import { PdfRichTextView } from './PdfRichTextView.jsx';
import { useScrollViewport } from '../hooks/useScrollViewport.js';
import { useResolvedImageSources } from '../hooks/useResolvedImages.js';
import { SourceMarkdownBlock, renderInlineMarkdownText, sourceSpanKey, sourceSpansForRange } from './SourceBlocks.jsx';
export const SOURCE_VIRTUAL_OVERSCAN = 1200;
export const SOURCE_WINDOW_CHAR_LIMIT = 50000;
export const SOURCE_WINDOW_AUTO_LOAD_GAP = 240;

export function estimateSourceBlockHeight(block, rawMarkdown) {
  const textLength = Math.max(1, Number(block?.end || 0) - Number(block?.start || 0));
  if (block?.type === 'heading') return 56;
  if (block?.type === 'code') {
    const lines = String(block.text || '').split('\n').length;
    return Math.max(52, lines * 20 + 34);
  }
  if (block?.type === 'table') {
    const rows = Array.isArray(block.rows) ? block.rows.length : 1;
    return Math.max(72, rows * 38 + 22);
  }
  if (block?.type === 'image') return 280;
  if (block?.type === 'list') {
    const items = Array.isArray(block.items) ? block.items.length : 1;
    return Math.max(44, items * 30 + Math.ceil(textLength / 90) * 10);
  }
  if (block?.type === 'blockquote') {
    const lines = Array.isArray(block.lines) ? block.lines.length : 1;
    return Math.max(52, lines * 32 + Math.ceil(textLength / 95) * 18);
  }
  const raw = rawMarkdown ? String(rawMarkdown).slice(block?.start || 0, block?.end || 0) : '';
  const lineCount = Math.max(1, raw.split('\n').length);
  return Math.max(38, lineCount * 28 + Math.ceil(textLength / 90) * 22);
}

export function nodeMapFromTree(tree) {
  return new Map(flattenTree(tree).map((node) => [String(node.id), node]));
}

export function buildRichDepthModel(tree, sourceSpans, depthLimit) {
  if (!tree) return { targetNodes: [], allowedNodeIds: new Set(), allowedSpanIds: null, visibleSpans: [] };
  const targetDepth = Math.max(1, Number(depthLimit) || 1);
  const flat = flattenTree(tree);
  const targetNodes = flat.filter((node) => depthOf(node.address || '1') === targetDepth);
  if (targetNodes.length === 0) return { targetNodes: [], allowedNodeIds: new Set(), allowedSpanIds: new Set(), visibleSpans: [] };
  const allowedNodeIds = new Set();
  for (const node of flat) {
    if (depthOf(node.address || '1') <= targetDepth) allowedNodeIds.add(String(node.id));
  }
  for (const node of targetNodes) collectNodeAndDescendantIds(node, allowedNodeIds);
  const visibleSpans = (sourceSpans || []).filter((span) => allowedNodeIds.has(String(span.node_id)));
  const allowedSpanIds = new Set(visibleSpans.map(sourceSpanKey));
  return { targetNodes, allowedNodeIds, allowedSpanIds, visibleSpans };
}

export function collectNodeAndDescendantIds(node, output) {
  if (!node) return;
  output.add(String(node.id));
  for (const child of node.children || []) collectNodeAndDescendantIds(child, output);
}

export function isSourceSpanAllowed(allowedSpanIds, span) {
  if (!allowedSpanIds) return true;
  if (!span) return false;
  return allowedSpanIds.has(sourceSpanKey(span));
}

export function RichTextView({
  currentDoc,
  docId,
  selectedNodeId,
  setSelectedNodeId,
  depthLimit,
  collapsed = new Set(),
  expanded = new Set(),
  toggleCollapsed,
  showLeftInfo = true,
  showTitles,
  showNotes,
  showAxioms = true,
  onAddAxiom,
  loadSourceWindow,
  sourceWindowLoading = false,
  locateRequest = null
}) {
  const tree = currentDoc?.tree;
  const sourceDocument = currentDoc?.sourceDocument;
  const sourceWindow = currentDoc?.sourceWindow;
  const rawMarkdown = sourceWindow?.raw_markdown || sourceDocument?.raw_markdown || '';
  const sourceSpans = sourceWindow?.sourceSpans || currentDoc?.sourceSpans || [];
  const usingSourceWindow = Boolean(sourceWindow?.raw_markdown);
  const nodeById = useMemo(() => nodeMapFromTree(tree), [tree]);
  const depthModel = useMemo(() => (
    usingSourceWindow
      ? { targetNodes: tree ? [tree] : [], allowedNodeIds: null, allowedSpanIds: null, visibleSpans: sourceSpans }
      : buildRichDepthModel(tree, sourceSpans, depthLimit)
  ), [tree, sourceSpans, depthLimit, usingSourceWindow]);
  const blocks = useMemo(() => {
    // debug 模式下测 markdown parse 耗时
    if (!rawMarkdown) return [];
    const perfToken = debugPerfBegin('parseSourceMarkdownBlocks');
    const result = parseSourceMarkdownBlocks(rawMarkdown);
    debugPerfEnd('parseSourceMarkdownBlocks', perfToken, { chars: rawMarkdown.length, blocks: result.length });
    return result;
  }, [rawMarkdown]);
  const filteredBlocks = useMemo(() => {
    // debug 模式下测过滤耗时 + 触发频率：滚动期间不该被反复触发
    const perfToken = debugPerfBegin('filteredBlocks');
    const result = depthModel.allowedSpanIds
      ? blocks.filter((block) => sourceSpansForRange(sourceSpans, block.start, block.end)
        .some((span) => isSourceSpanAllowed(depthModel.allowedSpanIds, span)))
      : blocks;
    debugPerfEnd('filteredBlocks', perfToken, {
      blocks: blocks.length,
      spans: sourceSpans.length,
      kept: result.length,
      hasAllowedSpanIds: depthModel.allowedSpanIds ? depthModel.allowedSpanIds.size : null
    });
    return result;
  }, [blocks, depthModel.allowedSpanIds, sourceSpans]);
  const resolvedImages = useResolvedImageSources(blocks, docId);
  // hover 高亮通过往一个 <style> 节点写一行 CSS 规则实现，
  // onMouseEnter/Leave 完全绕开 React state，不再让父组件 re-render。
  // 同 sentence_index 的所有 spans 通过 [data-sentence-index="N"] 同时命中。
  const hoverStyleRef = useRef(null);
  const handleSentenceHover = useCallback((sentenceIndex) => {
    const node = hoverStyleRef.current;
    if (!node) return;
    if (sentenceIndex === null || sentenceIndex === undefined) {
      node.textContent = '';
    } else {
      node.textContent = `.source-sentence[data-sentence-index="${sentenceIndex}"]{background:rgba(255,225,0,0.3);}`;
    }
  }, []);
  const selectSpan = useCallback((span) => {
    if (span?.node_id) setSelectedNodeId(span.node_id);
  }, [setSelectedNodeId]);
  const { scrollRef, viewport, onScroll } = useScrollViewport();
  const autoWindowRef = useRef({ lastScrollTop: 0, requestKey: '', suppress: false });
  // 抖动修复：estimateSourceBlockHeight 只是估算，估算误差会在块进出虚拟窗口时
  // 表现为内容跳动（spacer 高度 ≠ 真实 DOM 高度）。这里把渲染后的真实高度量回来缓存，
  // 已测量的块用实测值，未渲染过的块才用估算兜底。换正文窗口时缓存整体作废。
  const readerRef = useRef(null);
  const measuredHeightsRef = useRef(new Map());
  const [measureVersion, setMeasureVersion] = useState(0);
  useEffect(() => {
    measuredHeightsRef.current = new Map();
    setMeasureVersion((version) => version + 1);
  }, [rawMarkdown]);
  const blockHeights = useMemo(() => {
    const measured = measuredHeightsRef.current;
    return filteredBlocks.map((block) => (
      measured.get(`${block.type}:${block.start}:${block.end}`)
        ?? estimateSourceBlockHeight(block, rawMarkdown)
    ));
  }, [filteredBlocks, rawMarkdown, measureVersion]);
  // virtual 引用稳定化：滚动一格通常 start/end/top/bottom/totalHeight 都没变，
  // 浅比较命中时复用旧对象，让 visibleBlocks.slice 之后 .map 出的 children
  // 在 React.memo 浅比较中保持 prop 引用稳定。
  const virtualRef = useRef(null);
  const virtual = useMemo(() => {
    const next = buildVirtualRange(blockHeights, Math.max(0, viewport.scrollTop - 96), viewport.height, SOURCE_VIRTUAL_OVERSCAN);
    const prev = virtualRef.current;
    if (prev
      && prev.start === next.start
      && prev.end === next.end
      && prev.top === next.top
      && prev.bottom === next.bottom
      && prev.totalHeight === next.totalHeight) {
      return prev;
    }
    virtualRef.current = next;
    return next;
  }, [blockHeights, viewport]);
  const visibleBlocks = filteredBlocks.slice(virtual.start, virtual.end);

  // 量回真实块高：用相邻子元素 offsetTop 差值（含 margin），头尾两个子元素是 spacer。
  // ResizeObserver 盯住每个渲染块，图片异步加载撑开后也会触发回写。
  useEffect(() => {
    const reader = readerRef.current;
    if (!reader || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const children = reader.children;
      if (children.length !== visibleBlocks.length + 2) return;
      let changed = false;
      for (let index = 0; index < visibleBlocks.length; index += 1) {
        const block = visibleBlocks[index];
        const height = children[index + 2].offsetTop - children[index + 1].offsetTop;
        if (height <= 0) continue;
        const key = `${block.type}:${block.start}:${block.end}`;
        const previous = measuredHeightsRef.current.get(key);
        if (previous === undefined || Math.abs(previous - height) > 0.5) {
          measuredHeightsRef.current.set(key, height);
          changed = true;
        }
      }
      if (changed) setMeasureVersion((version) => version + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (let index = 1; index < reader.children.length - 1; index += 1) {
      observer.observe(reader.children[index]);
    }
    return () => observer.disconnect();
  }, [filteredBlocks, virtual]);

  // 跳转定位（16-3）：用现成的 span↔块映射找到目标节点所在的源文本块，按累加块高居中滚动。
  // 96 与 virtual 的头部偏移一致；定位滚动前置 suppress，避免被自动翻窗逻辑误判为用户滚动。
  // 基础版只定位当前已加载源窗口内的目标；跨窗口（超大文档翻窗）与 PDF 源暂不在此覆盖。
  const lastLocateSeqRef = useRef(0);
  useEffect(() => {
    const seq = locateRequest?.seq || 0;
    const targetId = locateRequest?.nodeId;
    if (!seq || seq === lastLocateSeqRef.current || targetId == null) return;
    lastLocateSeqRef.current = seq;
    const el = scrollRef.current;
    if (!el) return;
    const index = filteredBlocks.findIndex((block) => (
      sourceSpansForRange(sourceSpans, block.start, block.end)
        .some((span) => String(span.node_id) === String(targetId))
    ));
    if (index < 0) return;
    let offset = 0;
    for (let i = 0; i < index; i += 1) offset += blockHeights[i] || 0;
    const blockH = blockHeights[index] || 0;
    const centered = offset - Math.max(0, (el.clientHeight - 96 - blockH) / 2);
    autoWindowRef.current.suppress = true;
    el.scrollTop = Math.max(0, 96 + centered);
  }, [locateRequest?.seq, filteredBlocks, blockHeights, sourceSpans, scrollRef]);
  const isPdfSource = sourceDocument?.source_type === 'pdf';
  const sourceWindowStart = Number(sourceWindow?.startOffset) || 0;
  const sourceWindowEnd = Number(sourceWindow?.endOffset) || 0;
  const sourceWindowTotal = Number(sourceWindow?.totalLength) || 0;
  const canLoadPreviousWindow = Boolean(sourceWindow?.hasBefore) && !sourceWindowLoading;
  const canLoadNextWindow = Boolean(sourceWindow?.hasAfter) && !sourceWindowLoading;
  const loadWindowAt = useCallback(async (startOffset) => {
    const loaded = await loadSourceWindow?.({
      docId,
      nodeId: selectedNodeId,
      startOffset,
      before: 0
    });
    if (loaded && scrollRef.current) {
      autoWindowRef.current.suppress = true;
      scrollRef.current.scrollTop = 0;
    }
  }, [docId, loadSourceWindow, selectedNodeId]);
  const loadPreviousWindow = () => loadWindowAt(Math.max(0, sourceWindowStart - SOURCE_WINDOW_CHAR_LIMIT));
  const loadNextWindow = () => loadWindowAt(Math.min(sourceWindowTotal, sourceWindowEnd));

  useEffect(() => {
    const previousScrollTop = autoWindowRef.current.lastScrollTop;
    const direction = viewport.scrollTop > previousScrollTop ? 1 : (viewport.scrollTop < previousScrollTop ? -1 : 0);
    autoWindowRef.current.lastScrollTop = viewport.scrollTop;

    if (autoWindowRef.current.suppress) {
      autoWindowRef.current.suppress = false;
      return;
    }
    if (!sourceWindow || sourceWindowLoading || !loadSourceWindow || virtual.totalHeight <= 0) return;

    const threshold = Math.max(SOURCE_WINDOW_AUTO_LOAD_GAP, viewport.height * 0.35);
    const bottomGap = virtual.totalHeight - (viewport.scrollTop + viewport.height);
    let targetOffset = null;
    if (direction > 0 && sourceWindow.hasAfter && bottomGap <= threshold) {
      targetOffset = sourceWindowEnd;
    } else if (direction < 0 && sourceWindow.hasBefore && viewport.scrollTop <= threshold) {
      targetOffset = Math.max(0, sourceWindowStart - SOURCE_WINDOW_CHAR_LIMIT);
    }
    if (targetOffset === null) return;

    const requestKey = `${docId}:${targetOffset}`;
    if (autoWindowRef.current.requestKey === requestKey) return;
    autoWindowRef.current.requestKey = requestKey;
    loadWindowAt(targetOffset);
  }, [
    docId,
    loadSourceWindow,
    loadWindowAt,
    sourceWindow,
    sourceWindowEnd,
    sourceWindowLoading,
    sourceWindowStart,
    viewport.height,
    viewport.scrollTop,
    virtual.totalHeight
  ]);

  if (!tree) return <div className="empty-state">未打开文档</div>;
  if (isPdfSource) {
    return (
      <PdfRichTextView
        currentDoc={currentDoc}
        docId={docId}
        selectedNodeId={selectedNodeId}
        setSelectedNodeId={setSelectedNodeId}
        depthModel={depthModel}
        nodeById={nodeById}
        depthLimit={depthLimit}
        collapsed={collapsed}
        expanded={expanded}
        toggleCollapsed={toggleCollapsed}
        showLeftInfo={showLeftInfo}
        showTitles={showTitles}
        showNotes={showNotes}
      />
    );
  }
  if (!rawMarkdown) {
    return (
      <div className="rich-surface source-rich-surface">
        <article className={`source-document missing-source ${showLeftInfo ? '' : 'hide-left-info'}`}>
          <header className="source-title">
            <h1>{docDisplayTitle(currentDoc?.doc) || tree.text}</h1>
            <span>{flattenTree(tree).length} 个节点</span>
          </header>
          {showAxioms ? (
            <RichAxiomProperties axioms={currentDoc?.axioms} onAddAxiom={onAddAxiom} />
          ) : null}
          <div className="source-reader">
            <div className="source-block source-missing-block">
              <span className="source-gutter-cell" aria-hidden="true" />
              <span className="source-gutter-cell source-gutter-sentence" aria-hidden="true" />
              <div className="source-block-body">
                <p>{sourceDocument ? '正在加载当前正文窗口。' : '未绑定原始正文。请重新导入当前文件。'}</p>
              </div>
            </div>
          </div>
        </article>
      </div>
    );
  }

  return (
    <div className="rich-surface source-rich-surface" ref={scrollRef} onScroll={onScroll}>
      <style ref={hoverStyleRef} />
      <article className={`source-document ${showLeftInfo ? '' : 'hide-left-info'}`}>
        <header className="source-title">
          <h1>{docDisplayTitle(currentDoc?.doc) || tree.text}</h1>
          <div className="source-title-meta">
            <span>
              {sourceSpans.length} 个句子映射
              {sourceWindow ? ` · ${sourceWindowStart + 1}-${sourceWindowEnd}/${sourceWindowTotal}` : ''}
            </span>
            {sourceWindow ? (
              <div className="source-window-controls">
                <IconButton title="上一正文窗口" disabled={!canLoadPreviousWindow} onClick={loadPreviousWindow}><ArrowUp size={14} /></IconButton>
                <IconButton title="下一正文窗口" disabled={!canLoadNextWindow} onClick={loadNextWindow}><ArrowDown size={14} /></IconButton>
              </div>
            ) : null}
          </div>
        </header>
        {showAxioms ? (
          <RichAxiomProperties axioms={currentDoc?.axioms} onAddAxiom={onAddAxiom} />
        ) : null}
        <SourceDocumentLead node={tree} showNotes={showNotes} />
        <div className="source-reader" ref={readerRef}>
          <div className="source-virtual-spacer" style={{ height: virtual.top }} />
          {visibleBlocks.map((block, index) => (
            <SourceMarkdownBlock
              key={`${block.type}-${block.start}-${virtual.start + index}`}
              block={block}
              rawMarkdown={rawMarkdown}
              sourceSpans={sourceSpans}
              selectedNodeId={selectedNodeId}
              onSentenceHover={handleSentenceHover}
              selectSpan={selectSpan}
              resolvedImages={resolvedImages}
              allowedSpanIds={depthModel.allowedSpanIds}
              nodeById={nodeById}
              showTitles={showTitles}
              showNotes={showNotes}
            />
          ))}
          <div className="source-virtual-spacer" style={{ height: virtual.bottom }} />
        </div>
      </article>
    </div>
  );
}

export function RichAxiomProperties({ axioms = [], onAddAxiom }) {
  const rows = Array.isArray(axioms)
    ? axioms
      .map((axiom) => ({
        key: axiom.id || axiom.label,
        label: String(axiom.label || '').trim(),
        content: String(axiom.content || '').trim()
      }))
      .filter((axiom) => axiom.label || axiom.content)
    : [];
  return (
    <section className="rich-axiom-properties" aria-label="事实前提">
      <h2>事实前提</h2>
      <div className="rich-axiom-property-list">
        {rows.map((axiom) => (
          <div key={axiom.key || axiom.label} className="rich-axiom-property-row">
            <span className="rich-axiom-drag" aria-hidden="true">☰</span>
            <span className="rich-axiom-label">{axiom.label}</span>
            <span className="rich-axiom-value">{axiom.content}</span>
          </div>
        ))}
      </div>
      <button type="button" className="rich-axiom-add" onClick={() => onAddAxiom?.()}>
        + 添加事实前提
      </button>
    </section>
  );
}

export function SourceDocumentLead({ node, showNotes }) {
  const note = plainNodeNote(node?.note || '');
  if (!showNotes || !note) return null;
  return (
    <section className="source-block source-document-lead">
      <span className="source-gutter-cell" aria-hidden="true" />
      <span className="source-gutter-cell source-gutter-sentence" aria-hidden="true" />
      <div className="source-block-body">
        <span className="source-node-extra-note">
          <span className="source-node-extra-label">全文摘要备注</span>
          {renderInlineMarkdownText(note, 'source-root-note')}
        </span>
      </div>
    </section>
  );
}
