import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ForwardedRef } from 'react';
import type { LocateRequest } from '../../hooks/useNodeSelection.js';
import { buildTreeIndex } from '../../../core/node-model.js';

import {
  deriveColumns,
  measureConnectorLines, measureButtonTops,
  buildStatsIndex,
  COLUMN_GAP
} from './c2d-measure.js';

import {
  handleColumnWheel, startColumnResize, syncParentColumn
} from './c2d-events';

import {
  clampVisibleDepth,
  resolveDepthControl, resolveDepthShrinkLocate, resolveToggleExpand
} from './c2d-depth-logic.js';
import { axiomBlock, isAxiomNode } from './c2d-blocks.js';
import { syncConnectorLayer } from './c2d-connector.js';
import { C2DNodeCard } from './C2DNodeCard';
import type { CardApi } from './C2DNodeCard';
import { C2DContextMenu } from './C2DContextMenu';
import type { CtxMenuState } from './C2DContextMenu';
import {
  C2DDragGhost, C2DDragChoiceMenu, C2DMoveDialog, C2DStatsDialog
} from './C2DOverlays';
import { useC2DNodeCommands } from './useC2DNodeCommands.js';
import { useC2DInlineEdit } from './useC2DInlineEdit.js';
import { useC2DDrag } from './useC2DDrag.js';
import { useC2DCamera } from './useC2DCamera.js';

import type { C2DBlock, C2DColumn, C2DTreeIndex, ConnectorMeasure, StatsIndex } from './c2d-types';


// ══════════════════════════════════════════════════════════
// C2DMapView — 组件只做三件事：
//   1. 声明状态和 ref
//   2. 用 effect 驱动数据获取 + 测量
//   3. 输出 JSX
//
// 布局计算 → c2d-measure.ts
// 事件处理 → c2d-events.ts
// 卡片渲染 → C2DNodeCard（memo，经稳定 CardApi 回调）
// 连接线 / 展开按钮位置 → applyMeasure 命令式写 DOM，不进 React state
// ══════════════════════════════════════════════════════════

// 深度控件命令接口（需求 8-7）：ref 命令替代旧「seq 计数器 prop 当命令总线」。
// 调用时机在 session depthLimit 写完之后、组件重渲染之前——方法闭包里的 columns
// 恰是「点击前」的列状态，targetDepth 由调用方直接传入，无需再从 prop 倒推。
export interface C2DMapHandle {
  applyDepthControl(action: string, targetDepth: number): void;
}

interface C2DMapViewProps {
  docId?: string | number | null;
  rootNode: unknown;
  // 展开列集（address 键）受控化：真相在 session view（c2dExpanded），驱逐的渲染依赖集才看得见
  // 导图正在显示的列。组件内仍以 address 为键运转（hotspot/深度纯函数都吃 address）。
  expanded: Set<string>;
  onExpandedChange: (next: Set<string>) => void;
  selectedNodeId?: string | null;
  setSelectedNodeId?: (id: string) => void;
  setMultiSelectedIds?: (ids: Set<string>) => void;
  onRenderReady?: ((info: { docId: string | number | null; renderBackend: string; visual: null }) => void) | null;
  onNotice?: ((message: string) => void) | null;
  locateRequest?: LocateRequest | null;
  axioms?: unknown[];
  axiomsCollapsed?: boolean;
  onToggleAxiomsCollapsed?: (() => void) | null;
  showNotes?: boolean;
  paragraphLabelByNodeId?: Map<string, string> | null;
  maxVisibleDepth?: number;
  onVisibleDepthChange?: ((depth: number) => void) | null;
  treeEditMode?: boolean;
  onNodeCommand?: ((command: Record<string, unknown>) => any) | null;
  onAddAxiom?: ((nodeId: string) => void) | null;
  onAddAxiomRef?: ((nodeId: string) => void) | null;
}

export const C2DMapView = forwardRef(function C2DMapView({
  docId = null,
  rootNode,
  expanded,
  onExpandedChange,
  selectedNodeId,
  setSelectedNodeId,
  setMultiSelectedIds = () => {},
  onRenderReady = null,
  onNotice = null,
  locateRequest = null,
  axioms = [],
  axiomsCollapsed = true,
  onToggleAxiomsCollapsed = null,
  showNotes = true,
  paragraphLabelByNodeId = null,
  maxVisibleDepth = 1,
  onVisibleDepthChange = null,
  treeEditMode = false,
  onNodeCommand = null,
  onAddAxiom = null,
  onAddAxiomRef = null,
}: C2DMapViewProps, ref: ForwardedRef<C2DMapHandle>) {
  // ── 状态 ────────────────────────────────────
  const [colWidths, setColWidths]     = useState<number[]>([]);
  const [ctxMenu, setCtxMenu]         = useState<CtxMenuState | null>(null);
  const [statsNodeId, setStatsNodeId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

  // ── Ref ─────────────────────────────────────
  const surfaceRef     = useRef<HTMLDivElement | null>(null);
  const stripRef       = useRef<HTMLDivElement | null>(null);
  const spacerRef      = useRef<HTMLDivElement | null>(null);
  const svgRef         = useRef<SVGSVGElement | null>(null);
  const cards          = useRef(new Map<string, HTMLElement>());
  const colEls         = useRef(new Map<number, HTMLElement>());
  const expandBtnEls   = useRef(new Map<string, HTMLButtonElement>());
  const readyFired     = useRef(false);
  const scrollTargets  = useRef(new Map<number | string, number | ReturnType<typeof setTimeout>>());
  const surfaceWidth   = useRef(0);
  const expandedRef    = useRef(expanded);
  const measureRaf     = useRef(0);
  const applyMeasureRef = useRef<() => void>(() => {});

  // ── 推导数据 ─────────────────────────────────
  // buildTreeIndex 固定产 TreeIndex<TreeNode>；C2DBlock 是 TreeNode 的字段宽松投影（id/address/parentId/childCount/nodeType 同名同型，其余 optional 或 unknown），边界 cast 当 C2DTreeIndex 用、丢失 axiomId 字段（axiom 节点不入 buildTreeIndex，独立维护）。
  const index = useMemo<C2DTreeIndex>(() => buildTreeIndex(rootNode as Parameters<typeof buildTreeIndex>[0]) as unknown as C2DTreeIndex, [rootNode]);
  const root = index.root;
  const columns = useMemo<C2DColumn[]>(() => deriveColumns(root, expanded, index), [root, expanded, index]);
  // 字数/字符统计整树一次预计算，渲染路径 O(1) 取数。
  const statsIndex = useMemo<StatsIndex>(() => buildStatsIndex(index), [index]);
  const axiomBlocks = useMemo(() => (Array.isArray(axioms) ? axioms : []).map(axiomBlock), [axioms]);
  const hasAxioms = axiomBlocks.length > 0;
  const showAxiomColumn = hasAxioms && !axiomsCollapsed;
  const displayColumns = useMemo<C2DColumn[]>(() => {
    if (!showAxiomColumn || !root) return columns;
    return [
      { kind: 'axioms', groups: [{ parent: root, blocks: axiomBlocks, direction: 'left' }] },
      ...columns
    ];
  }, [axiomBlocks, columns, root, showAxiomColumn]);
  const canEdit = Boolean(treeEditMode);

  useEffect(() => {
    setSelectedBlockId(selectedNodeId ?? null);
  }, [selectedNodeId]);

  useEffect(() => {
    expandedRef.current = expanded;
  }, [expanded]);

  useEffect(() => {
    if (!columns.length) return;
    onVisibleDepthChange?.(clampVisibleDepth(columns.length, maxVisibleDepth));
  }, [columns.length, maxVisibleDepth, onVisibleDepthChange]);

  // ── 命令 / 行内编辑 / 拖拽三个交互 hook ──────
  const {
    runNodeCommand, blockById,
    addChild, addSibling, updateNode, moveNode, promoteNode, splitNode, deleteNode,
    moveDialog, openMoveDialog, closeMoveDialog, setMoveDialogAddress, applyMoveDialog
  } = useC2DNodeCommands({ index, axiomBlocks, canEdit, onNodeCommand, onNotice, setSelectedNodeId });

  const {
    inlineEdit, inlineInputRef, startInlineEdit, cancelInlineEdit, saveInlineEdit, setInlineDraft
  } = useC2DInlineEdit({
    canEdit, blockById, updateNode, onNotice,
    closeContextMenu: () => setCtxMenu(null)
  });

  const {
    dragState, dragChoice, closeDragChoice, startDragHold, applyDragChoice, suppressClickRef
  } = useC2DDrag({
    index, canEdit, setSelectedNodeId, runNodeCommand,
    onDragBegin: () => { setCtxMenu(null); cancelInlineEdit(); }
  });

  // ── 统一测量入口 ─────────────────────────────
  // 测量结果不进 React state：连接线写进 svg path 池，按钮位置直接写
  // style.top。滚动期间不触发任何 React 渲染。
  const applyMeasure = useCallback(() => {
    const conn = measureConnectorLines(
      stripRef.current, surfaceRef.current,
      colEls.current, cards.current, displayColumns
    ) as ConnectorMeasure;
    syncConnectorLayer(svgRef.current, conn);
    const tops = measureButtonTops(displayColumns, colEls.current, cards.current) as Map<string, number>;
    for (const [addr, btn] of expandBtnEls.current) {
      const top = tops.get(addr);
      if (Number.isFinite(top)) btn.style.top = `${top}px`;
    }
  }, [displayColumns]);
  applyMeasureRef.current = applyMeasure;

  // rAF 合并：同一帧内的多次调度只测一次。
  const scheduleMeasure = useCallback(() => {
    if (measureRaf.current) return;
    measureRaf.current = requestAnimationFrame(() => {
      measureRaf.current = 0;
      applyMeasureRef.current();
    });
  }, []);

  useEffect(() => () => {
    if (measureRaf.current) cancelAnimationFrame(measureRaf.current);
  }, []);

  // ── 镜头状态机：定位/热点/列居中/横向滚动记忆 ──
  // 调用点须先于组件其余 layoutEffect（测量、渲染就绪）——声明顺序即执行顺序。
  const camera = useC2DCamera({
    docId, expanded, displayColumns, showAxiomColumn,
    surfaceRef, colEls, cards,
    scheduleMeasure,
    onSeedExpanded: (restored) => {
      expandedRef.current = restored;
      onExpandedChange(restored);
    },
    onDocumentReset: () => {
      setColWidths([]);
      readyFired.current = false;
    }
  });

  // ── 展开 / 收起 ────────────────────────────
  const toggleExpand = useCallback((block: C2DBlock) => {
    if (!block?.address) return;
    const resolved = resolveToggleExpand({
      block,
      expanded,
      index,
      lastHotspot: camera.getHotspot(),
      maxVisibleDepth
    });
    camera.requestLocate(resolved.pendingLocate);
    if (resolved.nextHotspot) camera.setHotspot(resolved.nextHotspot);
    expandedRef.current = resolved.nextExpanded;
    onExpandedChange(resolved.nextExpanded);
  }, [camera, expanded, index, maxVisibleDepth, onExpandedChange]);

  // ── 卡片回调 api：对象身份稳定，实现每次渲染刷新 ──
  const cardApiImpl = useRef<Omit<CardApi, 'inlineInputRef' | 'registerCard' | 'registerExpandBtn'> | null>(null);
  cardApiImpl.current = {
    clickBlock(event, block) {
      if (suppressClickRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      setCtxMenu(null);
      setSelectedBlockId(block.id);
      if (!isAxiomNode(block)) setSelectedNodeId?.(block.id);
      setMultiSelectedIds(new Set());
    },
    openContextMenu(event, block, subtreePreviewVisible) {
      event.preventDefault();
      event.stopPropagation();
      setSelectedBlockId(block.id);
      setCtxMenu({ x: event.clientX, y: event.clientY, block, subtreePreviewVisible });
      if (!isAxiomNode(block)) setSelectedNodeId?.(block.id);
    },
    pointerDownBlock(event, block) {
      startDragHold(event, block);
    },
    toggleExpand(block) {
      toggleExpand(block);
    },
    toggleAxioms() {
      onToggleAxiomsCollapsed?.();
    },
    openStats(block) {
      setStatsNodeId(block.id);
      setSelectedBlockId(block.id);
      if (!isAxiomNode(block)) setSelectedNodeId?.(block.id);
    },
    startTextEdit(block, subtreePreviewVisible) {
      startInlineEdit(block, 'text', { subtreePreviewVisible });
    },
    setInlineDraft,
    saveInline(exit) {
      saveInlineEdit(exit);
    },
    cancelInline() {
      cancelInlineEdit();
    }
  };
  const cardApi = useMemo<CardApi>(() => ({
    clickBlock: (event, block) => cardApiImpl.current!.clickBlock(event, block),
    openContextMenu: (event, block, visible) => cardApiImpl.current!.openContextMenu(event, block, visible),
    pointerDownBlock: (event, block) => cardApiImpl.current!.pointerDownBlock(event, block),
    toggleExpand: (block) => cardApiImpl.current!.toggleExpand(block),
    toggleAxioms: () => cardApiImpl.current!.toggleAxioms(),
    openStats: (block) => cardApiImpl.current!.openStats(block),
    startTextEdit: (block, visible) => cardApiImpl.current!.startTextEdit(block, visible),
    setInlineDraft: (draft) => cardApiImpl.current!.setInlineDraft(draft),
    saveInline: (exit) => cardApiImpl.current!.saveInline(exit),
    cancelInline: () => cardApiImpl.current!.cancelInline(),
    registerCard: (addr, el) => {
      if (el) cards.current.set(addr, el);
      else cards.current.delete(addr);
    },
    registerExpandBtn: (addr, el) => {
      if (el) expandBtnEls.current.set(addr, el);
      else expandBtnEls.current.delete(addr);
    },
    inlineInputRef
  }), []);

  // ══════════════════════════════════════════════
  // Effect 区：数据获取 + 视图同步
  // ══════════════════════════════════════════════

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const update = () => { surfaceWidth.current = el.clientWidth; };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── 深度控件命令（8-7）：ref 命令接口 ──────
  // 每渲染刷新 handle，方法闭包里的 columns 即「点击前」的列状态；
  // currentExpanded 经 expandedRef 取实时值。
  useImperativeHandle(ref, () => ({
    applyDepthControl(action: string, targetDepth: number) {
      const currentVisibleDepth = clampVisibleDepth(columns.length || 1, maxVisibleDepth);
      const resolved = resolveDepthControl(action || 'setDepth', {
        root,
        index,
        currentExpanded: expandedRef.current,
        currentVisibleDepth,
        visibleDepthLimit: targetDepth,
        maxVisibleDepth
      });
      if (!resolved) return;
      camera.requestLocate(resolveDepthShrinkLocate({
        hotspot: camera.getHotspot(),
        targetDepth: resolved.targetDepth,
        currentVisibleDepth
      }));
      expandedRef.current = resolved.nextExpanded;
      onExpandedChange(resolved.nextExpanded);
    }
  }));

  useEffect(() => {
    const defaultW = Math.max(180, Math.floor((surfaceWidth.current || 800) * 0.3));
    setColWidths(prev => displayColumns.map((_, i) => {
      if (i < prev.length) return prev[i];
      return defaultW;
    }));
  }, [displayColumns]);

  useEffect(() => {
    if (!locateRequest?.address || !locateRequest?.seq) return;
    const addr = locateRequest.address;
    const parts = addr.split('-');
    const ancestors: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      ancestors.push(parts.slice(0, i).join('-'));
    }
    if (ancestors.length) {
      // 原函数式 setExpanded(prev=>…) 为的是拿最新值（本 effect deps 刻意不含 expanded）；
      // 受控后经 expandedRef 取最新，乐观写回再上抛。
      const next = new Set(expandedRef.current);
      for (const a of ancestors) next.add(a);
      expandedRef.current = next;
      onExpandedChange(next);
    }
    camera.requestLocate(addr);
  }, [locateRequest?.seq]);

  // ── 事件绑定：wheel ───────────────────────
  useEffect(() => {
    const ctx = {
      colElsMap: colEls.current,
      cardsMap: cards.current,
      columns: displayColumns,
      expandedSet: expanded,
      scrollTargets: scrollTargets.current,
      onMeasure: scheduleMeasure
    };
    function onWheel(event: WheelEvent) { handleColumnWheel(event, ctx); }
    const els = [...colEls.current.values()];
    for (const el of els) el.addEventListener('wheel', onWheel, { passive: false });
    return () => { for (const el of els) el.removeEventListener('wheel', onWheel); };
  }, [displayColumns, expanded, scheduleMeasure]);

  // ── 测量 + ResizeObserver ─────────────────
  useLayoutEffect(() => {
    applyMeasure();
    const surface = surfaceRef.current;
    if (!surface) return;
    function syncSpacer() {
      if (spacerRef.current && surface) {
        spacerRef.current.style.width = `${Math.floor(surface.clientWidth / 2)}px`;
      }
    }
    syncSpacer();
    const onResize = () => { scheduleMeasure(); syncSpacer(); };
    const ro = new ResizeObserver(onResize);
    ro.observe(surface);
    return () => ro.disconnect();
  }, [applyMeasure, scheduleMeasure, showNotes]);

  // ── 渲染就绪回调 ──────────────────────────
  useLayoutEffect(() => {
    if (readyFired.current || !displayColumns.length || !docId) return;
    readyFired.current = true;
    requestAnimationFrame(() => {
      onRenderReady?.({
        docId,
        renderBackend: 'dom',
        visual: null
      });
    });
  }, [displayColumns.length, docId]);

  // ══════════════════════════════════════════════
  // 渲染区
  // ══════════════════════════════════════════════

  const renderBlock = (block: C2DBlock) => (
    <C2DNodeCard
      key={block.id}
      block={block}
      index={index}
      statsIndex={statsIndex}
      api={cardApi}
      selected={selectedBlockId === block.id}
      isExpanded={expanded.has(block.address)}
      hasAxioms={hasAxioms}
      showAxiomColumn={showAxiomColumn}
      showNotes={showNotes}
      isDragSource={dragState?.nodeId === block.id}
      isDragTarget={dragState?.targetNodeId === block.id}
      inlineEdit={inlineEdit && inlineEdit.nodeId === block.id ? inlineEdit : null}
      paragraphLabelByNodeId={paragraphLabelByNodeId}
      docId={docId}
    />
  );

  return (
    <div
      ref={surfaceRef}
      className="c2d-map-surface"
      onScroll={camera.noteSurfaceScroll}
      onClick={() => setCtxMenu(null)}
    >
      {!displayColumns.length ? (
        <div className="view-empty-canvas">
          <div className="view-prompt-card">正在读取节点列。</div>
        </div>
      ) : (
        <div
          ref={stripRef}
          className="c2d-column-strip"
          style={{ '--c2d-column-gap': `${COLUMN_GAP}px`, '--c2d-column-gutter': '0px' }}
        >
          <svg ref={svgRef} className="c2d-connector-layer" aria-hidden="true" />
          {displayColumns.map((col, i) => {
            const blocks = col.groups.flatMap(g => g.blocks);
            return (
              <div key={`col-wrap-${col.kind || 'tree'}-${i}`} className={`c2d-column-wrapper${col.kind === 'axioms' ? ' axiom-column-wrapper' : ''}`} style={{ position: 'relative' }}>
                <section
                  ref={el => { if (el) colEls.current.set(i, el); else colEls.current.delete(i); }}
                  className={`c2d-column${col.kind === 'axioms' ? ' c2d-axiom-column' : ''}`}
                  style={{ width: `${colWidths[i] || 240}px` }}
                  onScroll={() => {
                    scheduleMeasure();
                    syncParentColumn(i, colEls.current, cards.current, displayColumns);
                  }}
                >
                  <div className="c2d-column-inner">
                    {blocks.map(renderBlock)}
                  </div>
                </section>
                <div
                  className="c2d-column-resize-handle"
                  onPointerDown={e => startColumnResize(i, e, {
                    currentWidths: colWidths,
                    onWidthChange: (ci, w) => setColWidths(prev => {
                      const next = [...prev]; next[ci] = w; return next;
                    }),
                    onEnd: () => scheduleMeasure()
                  })}
                />
              </div>
            );
          })}
          <div ref={spacerRef} className="c2d-column-spacer" aria-hidden="true" />
        </div>
      )}

      {ctxMenu && (
        <C2DContextMenu
          ctxMenu={ctxMenu}
          index={index}
          canEdit={canEdit}
          actions={{
            addChild, addSibling, startInlineEdit, moveNode, promoteNode,
            openMoveDialog, splitNode, updateNode, deleteNode
          }}
          onAddAxiom={onAddAxiom}
          onAddAxiomRef={onAddAxiomRef}
          onNotice={onNotice}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {dragState && <C2DDragGhost dragState={dragState} />}
      {dragChoice && (
        <C2DDragChoiceMenu
          dragChoice={dragChoice}
          index={index}
          onApply={applyDragChoice}
          onClose={closeDragChoice}
        />
      )}
      {statsNodeId && (() => {
        const node = blockById(statsNodeId);
        if (!node) return null;
        return <C2DStatsDialog node={node} index={index} statsIndex={statsIndex} onClose={() => setStatsNodeId(null)} />;
      })()}
      {moveDialog && (
        <C2DMoveDialog
          moveDialog={moveDialog}
          onAddressChange={setMoveDialogAddress}
          onApply={applyMoveDialog}
          onClose={closeMoveDialog}
        />
      )}
    </div>
  );
});
