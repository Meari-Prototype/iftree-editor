// useC2DDrag.ts
// C2D 节点长按拖拽状态机：500ms 长按启动、6px 抖动取消、window 级捕获监听、
// 拖拽幽灵状态、落点选单与三种挂载命令。从 MindMapView 组件体原样外提。
// 监听器经双层 ref 桥（listeners 身份恒定、handlers 每渲染刷新）挂在 window 捕获阶段。

import { useEffect, useRef, useState } from 'react';
import { isRootNode, isValidDragTarget, lookupBlock } from './c2d-blocks.js';
import type { DragChoiceState, DragState, DragAttachMode } from './C2DOverlays';
import type { C2DBlock, C2DTreeIndex } from './c2d-types';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';

const C2D_DRAG_HOLD_MS = 500;
const C2D_DRAG_CANCEL_DISTANCE = 6;

interface DragSession {
  nodeId: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  active: boolean;
}

export interface C2DDragOptions {
  index: C2DTreeIndex;
  canEdit: boolean;
  setSelectedNodeId?: ((id: string) => void) | undefined;
  runNodeCommand(command: Record<string, unknown>): unknown;
  /** 拖拽真正启动时关闭其它浮层（右键菜单、行内编辑）。 */
  onDragBegin(): void;
}

export interface C2DDragApi {
  dragState: DragState | null;
  dragChoice: DragChoiceState | null;
  closeDragChoice(): void;
  startDragHold(event: ReactPointerEvent<HTMLElement>, block: C2DBlock): void;
  applyDragChoice(mode: DragAttachMode): Promise<void>;
  /** 拖拽落下后的一拍内抑制卡片 click（选中/关菜单）误触发。 */
  suppressClickRef: RefObject<boolean>;
}

export function useC2DDrag({
  index, canEdit, setSelectedNodeId, runNodeCommand, onDragBegin
}: C2DDragOptions): C2DDragApi {
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [dragChoice, setDragChoice] = useState<DragChoiceState | null>(null);

  const dragHoldTimer = useRef<number | null>(null);
  const dragSession = useRef<DragSession | null>(null);
  const dragHandlers = useRef<{
    move: ((event: PointerEvent) => void) | null;
    up: ((event: PointerEvent) => void) | null;
    cancel: ((event: PointerEvent) => void) | null;
  }>({ move: null, up: null, cancel: null });
  const dragListeners = useRef<{
    move: (event: PointerEvent) => void;
    up: (event: PointerEvent) => void;
    cancel: (event: PointerEvent) => void;
  } | null>(null);
  const suppressClickRef = useRef(false);
  if (!dragListeners.current) {
    dragListeners.current = {
      move: (event) => dragHandlers.current.move?.(event),
      up: (event) => dragHandlers.current.up?.(event),
      cancel: (event) => dragHandlers.current.cancel?.(event)
    };
  }

  function clearDragHoldTimer() {
    if (dragHoldTimer.current) {
      window.clearTimeout(dragHoldTimer.current);
      dragHoldTimer.current = null;
    }
  }

  function endDragSession() {
    clearDragHoldTimer();
    const listeners = dragListeners.current!;
    window.removeEventListener('pointermove', listeners.move, true);
    window.removeEventListener('pointerup', listeners.up, true);
    window.removeEventListener('pointercancel', listeners.cancel, true);
    document.body.classList.remove('is-dragging-c2d-node');
    dragSession.current = null;
    setDragState(null);
  }

  function validDragTargetAt(clientX: number, clientY: number) {
    const element = document.elementFromPoint(clientX, clientY);
    const card = (element?.closest?.('.c2d-node-card') || null) as HTMLElement | null;
    const targetId = card?.dataset?.nodeId || null;
    const session = dragSession.current;
    const source = session ? lookupBlock(index, session.nodeId) : null;
    const target = targetId ? lookupBlock(index, targetId) : null;
    return isValidDragTarget(source, target) ? target : null;
  }

  function beginDragSession() {
    const session = dragSession.current;
    if (!session) return;
    const node = lookupBlock(index, session.nodeId);
    if (!node || isRootNode(node)) {
      endDragSession();
      return;
    }
    session.active = true;
    document.body.classList.add('is-dragging-c2d-node');
    onDragBegin();
    setDragChoice(null);
    setSelectedNodeId?.(node.id);
    setDragState({
      nodeId: node.id,
      address: node.address,
      title: node.title || '',
      text: node.text || '',
      x: session.x,
      y: session.y,
      offsetX: session.offsetX,
      offsetY: session.offsetY,
      targetNodeId: null
    });
  }

  function startDragHold(event: ReactPointerEvent<HTMLElement>, block: C2DBlock) {
    if (!canEdit || !block || isRootNode(block)) return;
    if (event.button !== undefined && event.button !== 0) return;
    if ((event.target as HTMLElement)?.closest?.('button, input, textarea, select, .c2d-inline-editor')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragSession.current = {
      nodeId: block.id,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      active: false
    };
    clearDragHoldTimer();
    dragHoldTimer.current = window.setTimeout(beginDragSession, C2D_DRAG_HOLD_MS);
    const listeners = dragListeners.current!;
    window.addEventListener('pointermove', listeners.move, true);
    window.addEventListener('pointerup', listeners.up, true);
    window.addEventListener('pointercancel', listeners.cancel, true);
  }

  function handleDragPointerMove(event: PointerEvent) {
    const session = dragSession.current;
    if (!session) return;
    session.x = event.clientX;
    session.y = event.clientY;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.active && Math.hypot(dx, dy) > C2D_DRAG_CANCEL_DISTANCE) {
      endDragSession();
      return;
    }
    if (!session.active) return;
    event.preventDefault();
    const target = validDragTargetAt(event.clientX, event.clientY);
    setDragState((current) => current ? {
      ...current,
      x: event.clientX,
      y: event.clientY,
      targetNodeId: target?.id || null
    } : current);
  }

  function handleDragPointerUp(event: PointerEvent) {
    const session = dragSession.current;
    if (!session) return;
    const wasActive = Boolean(session.active);
    const target = wasActive ? validDragTargetAt(event.clientX, event.clientY) : null;
    const sourceNodeId = session.nodeId;
    const x = event.clientX;
    const y = event.clientY;
    endDragSession();
    if (wasActive) {
      event.preventDefault();
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      if (target) {
        setDragChoice({
          sourceNodeId,
          targetNodeId: target.id,
          x,
          y
        });
      }
    }
  }

  function handleDragPointerCancel() {
    endDragSession();
  }

  dragHandlers.current.move = handleDragPointerMove;
  dragHandlers.current.up = handleDragPointerUp;
  dragHandlers.current.cancel = handleDragPointerCancel;

  useEffect(() => () => endDragSession(), []);

  useEffect(() => {
    if (!canEdit) endDragSession();
  }, [canEdit]);

  async function applyDragChoice(mode: DragAttachMode) {
    if (!dragChoice) return;
    const source = lookupBlock(index, dragChoice.sourceNodeId);
    const target = lookupBlock(index, dragChoice.targetNodeId);
    if (!isValidDragTarget(source, target)) {
      setDragChoice(null);
      return;
    }
    setDragChoice(null);
    if (mode === 'merge') {
      await runNodeCommand({ type: 'mergeIntoTarget', nodeId: source!.id, targetNodeId: target.id });
    } else if (mode === 'sibling') {
      await runNodeCommand({ type: 'moveAfterSibling', nodeId: source!.id, targetNodeId: target.id });
    } else {
      await runNodeCommand({ type: 'moveToParent', nodeId: source!.id, newParentId: target.id });
    }
  }

  return {
    dragState,
    dragChoice,
    closeDragChoice: () => setDragChoice(null),
    startDragHold,
    applyDragChoice,
    suppressClickRef
  };
}
