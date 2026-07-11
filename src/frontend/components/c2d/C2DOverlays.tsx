// C2DOverlays.tsx
// C2D 浮层集合：拖拽幽灵、拖拽落点选单、节点统计弹窗（需求 9-1-6）、移动到…对话框。
// 从 MindMapView 内联 IIFE/JSX 原样组件化，全部经 portal 挂 document.body。

import { createPortal } from 'react-dom';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { statsForNode } from './c2d-measure.js';
import { lookupBlock } from './c2d-blocks.js';
import type { C2DBlock, C2DTreeIndex, StatsIndex } from './c2d-types';

const C2D_DRAG_GHOST_TEXT_LIMIT = 160;

export interface DragState {
  nodeId: string;
  address: string;
  title: string;
  text: string;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  targetNodeId: string | null;
}

export interface DragChoiceState {
  sourceNodeId: string;
  targetNodeId: string;
  x: number;
  y: number;
}

export interface MoveDialogState {
  nodeId: string;
  address: string;
  error: string;
}

export type DragAttachMode = 'merge' | 'sibling' | 'child';

export function C2DDragGhost({ dragState }: { dragState: DragState }) {
  return createPortal(
    <div
      className="c2d-drag-ghost"
      style={{
        left: `${dragState.x - dragState.offsetX}px`,
        top: `${dragState.y - dragState.offsetY}px`
      }}
    >
      <div className="c2d-drag-ghost-address">{dragState.address}</div>
      {dragState.title ? <div className="c2d-drag-ghost-title">{dragState.title}</div> : null}
      <div className="c2d-drag-ghost-text">
        {String(dragState.text || dragState.title || '空节点').slice(0, C2D_DRAG_GHOST_TEXT_LIMIT)}
      </div>
    </div>,
    document.body
  );
}

export function C2DDragChoiceMenu({ dragChoice, index, onApply, onClose }: {
  dragChoice: DragChoiceState;
  index: C2DTreeIndex;
  onApply(mode: DragAttachMode): void;
  onClose(): void;
}) {
  const source = lookupBlock(index, dragChoice.sourceNodeId);
  const target = lookupBlock(index, dragChoice.targetNodeId);
  if (!source || !target) return null;
  const canAttachSibling = Boolean(target.parentId);
  const run = (mode: DragAttachMode) => (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onApply(mode);
  };
  const clampDragChoice = (el: HTMLDivElement | null) => {
    if (!el) return;
    const margin = 8;
    const r = el.getBoundingClientRect();
    const x = Math.max(margin, Math.min(dragChoice.x, window.innerWidth - r.width - margin));
    const y = Math.max(margin, Math.min(dragChoice.y, window.innerHeight - r.height - margin));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };
  return createPortal(
    <div
      ref={clampDragChoice}
      className="context-menu c2d-drag-choice-menu"
      style={{ left: dragChoice.x, top: dragChoice.y }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="c2d-drag-choice-title">{source.address} {'->'} {target.address}</div>
      <button onClick={run('merge')}>合并节点</button>
      <button disabled={!canAttachSibling} onClick={run('sibling')}>挂载为兄弟节点</button>
      <button onClick={run('child')}>挂载子节点</button>
      <div className="context-sep" />
      <button onClick={onClose}>取消</button>
    </div>,
    document.body
  );
}

export function C2DStatsDialog({ node, index, statsIndex, onClose }: {
  node: C2DBlock;
  index: C2DTreeIndex;
  statsIndex: StatsIndex;
  onClose(): void;
}) {
  const stats = statsForNode(statsIndex, index, node);
  const statRow = (label: string, ownValue: number, subtreeValue: number) => (
    <>
      <div className="c2d-stat-label">{label}</div>
      <div className="c2d-stat-value">{ownValue}</div>
      <div className="c2d-stat-value">{subtreeValue}</div>
    </>
  );
  return createPortal(
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-box node-dialog c2d-stats-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-header with-close">
          <span>节点统计</span>
          <button type="button" onClick={onClose} aria-label="关闭">x</button>
        </header>
        <div className="dialog-meta">{node.address}</div>
        <section className="c2d-stats-grid">
          <div />
          <strong>当前节点</strong>
          <strong>节点及子树</strong>
          {statRow('字数', stats.own.words, stats.subtree.words)}
          {statRow('字符数(不计空格)', stats.own.charsNoSpace, stats.subtree.charsNoSpace)}
          {statRow('字符数(计空格)', stats.own.charsWithSpace, stats.subtree.charsWithSpace)}
        </section>
        <section className="c2d-stats-meta">
          <div><span>当前子树节点数</span><strong>{stats.subtreeNodeCount}</strong></div>
          <div><span>剩余最大深度</span><strong>{stats.remainingDepth}</strong></div>
          <div><span>下一深度宽度</span><strong>{stats.nextDepthWidth}</strong></div>
        </section>
      </div>
    </div>,
    document.body
  );
}

export function C2DMoveDialog({ moveDialog, onAddressChange, onApply, onClose }: {
  moveDialog: MoveDialogState;
  onAddressChange(address: string): void;
  onApply(mode: DragAttachMode): void;
  onClose(): void;
}) {
  return createPortal(
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-box node-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="dialog-header">移动到…</header>
        <label className="dialog-field">
          <span>目标节点地址</span>
          <input
            className="dialog-input"
            value={moveDialog.address}
            placeholder="例如 1-5-6"
            onChange={(event) => onAddressChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose();
              event.stopPropagation();
            }}
            autoFocus
          />
        </label>
        {moveDialog.error ? <div className="dialog-error">{moveDialog.error}</div> : null}
        <div className="dialog-actions">
          <button type="button" onClick={() => onApply('merge')}>合并节点</button>
          <button type="button" onClick={() => onApply('sibling')}>挂载为兄弟节点</button>
          <button type="button" onClick={() => onApply('child')}>挂载子节点</button>
          <button type="button" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
