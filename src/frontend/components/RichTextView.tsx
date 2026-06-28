import { useMemo } from 'react';
import { plainNodeNote } from '../../core/node-notes.js';
import { flattenTree } from '../../core/tree.js';
import {
  depthOf
} from '../lib/doc-utils.js';



import { PdfRichTextView } from './PdfRichTextView.jsx';
import { RichNodeView } from './RichNodeView';
import type { LocateRequest } from './RichNodeView';
import { renderInlineMarkdownText, sourceSpanKey } from './SourceBlocks.jsx';
export const SOURCE_VIRTUAL_OVERSCAN = 1200;
export const SOURCE_WINDOW_CHAR_LIMIT = 50000;
export const SOURCE_WINDOW_AUTO_LOAD_GAP = 240;

export type RichTreeNode = Record<string, unknown> & { id?: unknown; address?: unknown; children?: RichTreeNode[] };
type SourceSpan = Record<string, unknown>;
type RichCurrentDoc = Record<string, unknown> & {
  tree?: RichTreeNode | null;
  sourceDocument?: Record<string, unknown> | null;
  sourceWindow?: { raw_markdown?: string; sourceSpans?: SourceSpan[] } | null;
  sourceSpans?: SourceSpan[];
};

// 源文档块的渲染视图（解析输出在前端的最小读取面）。
interface SourceBlockView {
  type?: string;
  start?: number;
  end?: number;
  text?: string;
  rows?: unknown[];
  items?: unknown[];
  lines?: unknown[];
}

// 事实前提条目的渲染视图。
interface AxiomView {
  id?: unknown;
  label?: unknown;
  content?: unknown;
}

export function estimateSourceBlockHeight(block: SourceBlockView, rawMarkdown: unknown) {
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

export function nodeMapFromTree(tree: RichTreeNode | null | undefined) {
  return new Map((flattenTree(tree as unknown) as RichTreeNode[]).map((node) => [String(node.id), node]));
}

export function buildRichDepthModel(tree: RichTreeNode | null | undefined, sourceSpans: SourceSpan[], depthLimit: unknown) {
  if (!tree) return { targetNodes: [], allowedNodeIds: new Set(), allowedSpanIds: null, visibleSpans: [] };
  const targetDepth = Math.max(1, Number(depthLimit) || 1);
  const flat = flattenTree(tree as unknown) as RichTreeNode[];
  const targetNodes = flat.filter((node) => depthOf(String(node.address || '1')) === targetDepth);
  if (targetNodes.length === 0) return { targetNodes: [], allowedNodeIds: new Set(), allowedSpanIds: new Set(), visibleSpans: [] };
  const allowedNodeIds = new Set<string>();
  for (const node of flat) {
    if (depthOf(String(node.address || '1')) <= targetDepth) allowedNodeIds.add(String(node.id));
  }
  for (const node of targetNodes) collectNodeAndDescendantIds(node, allowedNodeIds);
  const visibleSpans = (sourceSpans || []).filter((span) => allowedNodeIds.has(String(span.node_id)));
  const allowedSpanIds = new Set(visibleSpans.map(sourceSpanKey));
  return { targetNodes, allowedNodeIds, allowedSpanIds, visibleSpans };
}

export function collectNodeAndDescendantIds(node: RichTreeNode | null | undefined, output: Set<string>) {
  if (!node) return;
  output.add(String(node.id));
  for (const child of node.children || []) collectNodeAndDescendantIds(child, output);
}

export function isSourceSpanAllowed(allowedSpanIds: Set<string> | null, span: SourceSpan | null | undefined) {
  if (!allowedSpanIds) return true;
  if (!span) return false;
  return allowedSpanIds.has(String(sourceSpanKey(span)));
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
}: {
  currentDoc?: RichCurrentDoc | null;
  docId?: unknown;
  selectedNodeId?: unknown;
  setSelectedNodeId?: (nodeId: unknown) => void;
  depthLimit?: unknown;
  collapsed?: Set<unknown>;
  expanded?: Set<unknown>;
  toggleCollapsed?: (nodeId: unknown) => void;
  showLeftInfo?: boolean;
  showTitles?: boolean;
  showNotes?: boolean;
  showAxioms?: boolean;
  onAddAxiom?: () => void;
  loadSourceWindow?: (...args: unknown[]) => unknown;
  sourceWindowLoading?: boolean;
  locateRequest?: LocateRequest;
}) {
  const tree = currentDoc?.tree;
  const sourceDocument = currentDoc?.sourceDocument;
  const sourceWindow = currentDoc?.sourceWindow;
  const sourceSpans = sourceWindow?.sourceSpans || currentDoc?.sourceSpans || [];
  const usingSourceWindow = Boolean(sourceWindow?.raw_markdown);
  const nodeById = useMemo(() => nodeMapFromTree(tree), [tree]);
  const depthModel = useMemo(() => (
    usingSourceWindow
      ? { targetNodes: tree ? [tree] : [], allowedNodeIds: null, allowedSpanIds: null, visibleSpans: sourceSpans }
      : buildRichDepthModel(tree, sourceSpans, depthLimit)
  ), [tree, sourceSpans, depthLimit, usingSourceWindow]);
  const isPdfSource = sourceDocument?.source_type === 'pdf';

  if (!tree) return <div className="empty-state">未打开文档</div>;

  // 有版面坐标的源（PDF）保留坐标型渲染（span 映射回版面位置）。
  if (isPdfSource) {
    return (
      <PdfRichTextView
        currentDoc={currentDoc as Parameters<typeof PdfRichTextView>[0]['currentDoc']}
        docId={String(docId ?? '')}
        selectedNodeId={selectedNodeId as Parameters<typeof PdfRichTextView>[0]['selectedNodeId']}
        setSelectedNodeId={setSelectedNodeId as Parameters<typeof PdfRichTextView>[0]['setSelectedNodeId']}
        depthModel={depthModel}
        nodeById={nodeById}
        depthLimit={Number(depthLimit) || 1}
        collapsed={collapsed as Parameters<typeof PdfRichTextView>[0]['collapsed']}
        expanded={expanded as Parameters<typeof PdfRichTextView>[0]['expanded']}
        toggleCollapsed={toggleCollapsed as Parameters<typeof PdfRichTextView>[0]['toggleCollapsed']}
        showLeftInfo={showLeftInfo}
        showTitles={Boolean(showTitles)}
        showNotes={Boolean(showNotes)}
      />
    );
  }

  // 无版面格式（md / txt / docx）按节点树渲染统一富文本，不再走原文 + span 坐标层。
  return (
    <RichNodeView
      currentDoc={currentDoc}
      docId={docId}
      selectedNodeId={selectedNodeId}
      setSelectedNodeId={setSelectedNodeId}
      depthLimit={depthLimit}
      showTitles={showTitles}
      showNotes={showNotes}
      showAxioms={showAxioms}
      onAddAxiom={onAddAxiom}
      locateRequest={locateRequest}
    />
  );
}

export function RichAxiomProperties({ axioms = [], onAddAxiom }: { axioms?: AxiomView[]; onAddAxiom?: () => void }) {
  const rows = Array.isArray(axioms)
    ? axioms
      .map((axiom) => ({
        key: String(axiom.id || axiom.label || ''),
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

export function SourceDocumentLead({ node, showNotes }: { node?: { note?: unknown } | null; showNotes?: boolean }) {
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
