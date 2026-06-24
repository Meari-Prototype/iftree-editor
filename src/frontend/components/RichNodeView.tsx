// @ts-nocheck
import { useEffect, useMemo, useRef, useState } from 'react';

import { plainNodeNote } from '../../core/node-notes.js';
import { flattenTree } from '../../core/tree.js';
import { depthOf, docDisplayTitle } from '../lib/doc-utils.js';
import { buildVirtualRange } from '../lib/ui-utils.js';
import { useScrollViewport } from '../hooks/useScrollViewport.js';
import { RichMarkdown } from './RichMarkdown';

// 富视图按节点树渲染（无版面格式 md / txt / docx）：每个节点一块,正文走统一富文本渲染,
// 节点 id 挂 DOM、点击选中 / 高亮——句子↔节点联动天然成立,不再靠原文 span 反查。
// 坐标型(rawMarkdown + span)只留给 PDF（PdfRichTextView）。深度过滤与原坐标版同义:
// 显示深度 ≤ depthLimit 的节点,且 depthLimit 处的节点完整展开其子树。
const NODE_OVERSCAN = 1200;

function visibleNodesForDepth(tree, depthLimit) {
  const flat = flattenTree(tree);
  const targetDepth = Math.max(1, Number(depthLimit) || 1);
  const targetNodes = flat.filter((node) => depthOf(node.address || '1') === targetDepth);
  if (targetNodes.length === 0) return flat;
  const allowed = new Set();
  for (const node of flat) {
    if (depthOf(node.address || '1') <= targetDepth) allowed.add(String(node.id));
  }
  for (const node of targetNodes) collectSubtreeIds(node, allowed);
  return flat.filter((node) => allowed.has(String(node.id)));
}

function collectSubtreeIds(node, out) {
  out.add(String(node.id));
  for (const child of node.children || []) collectSubtreeIds(child, out);
}

// 虚拟滚动的高度预估（仅未渲染过的块用;渲染后 ResizeObserver 量回真实高度覆盖）。
function estimateNodeHeight(node) {
  const textLength = String(node.text || '').length;
  const titleHeight = node.node_title ? 30 : 0;
  const noteHeight = node.node_note ? 26 : 0;
  const bodyHeight = Math.max(28, Math.ceil(textLength / 56) * 28);
  return titleHeight + bodyHeight + noteHeight + 18;
}

export function RichNodeView({
  currentDoc,
  docId,
  selectedNodeId,
  setSelectedNodeId,
  depthLimit,
  showTitles = true,
  showNotes = false,
  showAxioms = true,
  onAddAxiom,
  locateRequest = null
}) {
  const tree = currentDoc?.tree;
  const nodes = useMemo(() => (tree ? visibleNodesForDepth(tree, depthLimit) : []), [tree, depthLimit]);
  const { scrollRef, viewport, onScroll } = useScrollViewport();
  const readerRef = useRef(null);
  const measuredHeightsRef = useRef(new Map());
  const [measureVersion, setMeasureVersion] = useState(0);

  useEffect(() => {
    measuredHeightsRef.current = new Map();
    setMeasureVersion((version) => version + 1);
  }, [nodes]);

  const nodeHeights = useMemo(() => {
    const measured = measuredHeightsRef.current;
    return nodes.map((node) => measured.get(String(node.id)) ?? estimateNodeHeight(node));
  }, [nodes, measureVersion]);

  const virtual = useMemo(
    () => buildVirtualRange(nodeHeights, Math.max(0, viewport.scrollTop - 96), viewport.height, NODE_OVERSCAN),
    [nodeHeights, viewport]
  );
  const visibleNodes = nodes.slice(virtual.start, virtual.end);

  useEffect(() => {
    const reader = readerRef.current;
    if (!reader || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const children = reader.children;
      if (children.length !== visibleNodes.length + 2) return;
      let changed = false;
      for (let index = 0; index < visibleNodes.length; index += 1) {
        const height = children[index + 2].offsetTop - children[index + 1].offsetTop;
        if (height <= 0) continue;
        const key = String(visibleNodes[index].id);
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
    for (let index = 1; index < reader.children.length - 1; index += 1) observer.observe(reader.children[index]);
    return () => observer.disconnect();
  }, [nodes, virtual]);

  const lastLocateSeqRef = useRef(0);
  useEffect(() => {
    const seq = locateRequest?.seq || 0;
    const targetId = locateRequest?.nodeId;
    if (!seq || seq === lastLocateSeqRef.current || targetId == null) return;
    lastLocateSeqRef.current = seq;
    const el = scrollRef.current;
    if (!el) return;
    const index = nodes.findIndex((node) => String(node.id) === String(targetId));
    if (index < 0) return;
    let offset = 0;
    for (let i = 0; i < index; i += 1) offset += nodeHeights[i] || 0;
    el.scrollTop = Math.max(0, offset - 96);
  }, [locateRequest?.seq, nodes, nodeHeights, scrollRef]);

  if (!tree) return <div className="empty-state">未打开文档</div>;

  return (
    <div className="rich-surface source-rich-surface" ref={scrollRef} onScroll={onScroll}>
      <article className="source-document rich-node-document">
        <header className="source-title">
          <h1>{docDisplayTitle(currentDoc?.doc) || tree.text}</h1>
          <span>{nodes.length} 个节点</span>
        </header>
        {showAxioms ? <RichNodeAxioms axioms={currentDoc?.axioms} onAddAxiom={onAddAxiom} /> : null}
        <div className="rich-node-reader" ref={readerRef}>
          <div className="source-virtual-spacer" style={{ height: virtual.top }} />
          {visibleNodes.map((node) => (
            <RichNodeBlock
              key={node.id}
              node={node}
              docId={docId}
              selected={String(node.id) === String(selectedNodeId)}
              onSelect={setSelectedNodeId}
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

function RichNodeBlock({ node, docId, selected, onSelect, showTitles, showNotes }) {
  const note = showNotes ? plainNodeNote(node.node_note || '') : '';
  return (
    <section
      data-node-id={node.id}
      className={`rich-node ${selected ? 'selected' : ''}`}
      onClick={() => onSelect?.(node.id)}
    >
      <button type="button" className="rich-node-gutter" title={node.address || ''}>{node.address}</button>
      <div className="rich-node-body">
        {showTitles && node.node_title ? <div className="rich-node-title">{node.node_title}</div> : null}
        {node.text ? <RichMarkdown markdown={node.text} docId={docId} /> : null}
        {note ? (
          <div className="rich-node-note">
            <span className="rich-node-note-label">摘要备注</span>
            {note}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// 事实前提:与 RichTextView 的 RichAxiomProperties 同形,内联一份避免两个富文本视图互相 import 成环。
function RichNodeAxioms({ axioms = [], onAddAxiom }) {
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
