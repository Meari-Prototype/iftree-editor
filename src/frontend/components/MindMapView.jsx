import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { buildTreeIndex, getChildren, getDescendants, getNodeByAddress, getSiblings } from '../../core/node-model.mjs';
import { NODE_TYPES } from '../../core/tree.mjs';
import { plainNodeNote } from '../../core/node-notes.mjs';
import { nodeTypeLabel } from '../lib/doc-utils.mjs';

import {
  clampCenterScrollTop, deriveColumns, subtreePreviewText,
  measureConnectorLines, measureButtonTops,
  COLUMN_GAP, EXPAND_BTN, EXPAND_ICON, TEXT_CHAR_LIMIT
} from './c2d-measure.mjs';

import {
  handleColumnWheel, startColumnResize, syncParentColumn
} from './c2d-events.mjs';

const NODE_TYPE_COLORS = {
  TEXT: 'transparent',
  IF: '#3b73a8',
  THEN: '#5f8f55',
  ELSE: '#b46f3c',
  LOOP: '#7b62a3',
  FOREACH: '#8c7a32',
  BREAK: '#b8525f',
  CONTINUE: '#3f8f88',
  ERROR: '#c2410c',
  HUMAN_BLOCK: '#8b5cf6',
  HUMAN_SUMMARY: '#2563eb'
};
const C2D_DRAG_HOLD_MS = 500;
const C2D_DRAG_CANCEL_DISTANCE = 6;
const C2D_DRAG_GHOST_TEXT_LIMIT = 160;

function axiomBlock(axiom, index) {
  // axiom.id can be a numeric base id or a `tmp-axiom-…` string in lazy edit
  // branches; keep the raw value so updateAxiom/deleteAxiom payloads stay
  // resolvable on the backend.
  const rawAxiomId = axiom?.id ?? null;
  const label = String(axiom?.label || `A${index + 1}`);
  return {
    id: `axiom:${rawAxiomId ?? label}`,
    axiomId: rawAxiomId,
    address: label,
    depth: 0,
    sortOrder: index + 1,
    parentId: null,
    childCount: 0,
    nodeType: 'AXIOMS',
    kind: 'axiom',
    title: String(axiom?.node_title || '').trim(),
    text: String(axiom?.content || '').trim(),
    note: String(axiom?.node_note || '').trim(),
    status: axiom?.status || 'pending'
  };
}

function nodeContentText(node) {
  return [node?.title, node?.text, node?.note]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
}

function contentStats(text) {
  const value = String(text || '');
  const wordMatches = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu) || [];
  const noSpace = value.replace(/\s+/g, '');
  return {
    words: wordMatches.length,
    charsNoSpace: Array.from(noSpace).length,
    charsWithSpace: Array.from(value).length
  };
}

function nodeStats(index, node) {
  const descendants = node ? getDescendants(index, node.id) : [];
  const subtreeNodes = node ? [node, ...descendants] : [];
  const own = contentStats(nodeContentText(node));
  const subtree = contentStats(subtreeNodes.map(nodeContentText).filter(Boolean).join('\n'));
  const nodeDepth = Number(node?.depth) || String(node?.address || '1').split('-').filter(Boolean).length || 1;
  const maxDepth = subtreeNodes.reduce((max, item) => Math.max(max, Number(item?.depth) || nodeDepth), nodeDepth);
  return {
    own,
    subtree,
    subtreeNodeCount: subtreeNodes.length,
    remainingDepth: Math.max(0, maxDepth - nodeDepth),
    nextDepthWidth: node ? getChildren(index, node.id).length : 0
  };
}

function isRootNode(node) {
  return !node?.parentId || String(node?.address || '') === '1';
}

function isAxiomNode(node) {
  return String(node?.nodeType || '').toUpperCase() === 'AXIOMS' || String(node?.address || '').startsWith('A');
}

// In lazy edit-branch mode some nodes have tmp ids like `tmp-node-…`, so
// id comparisons and Map lookups must use string keys rather than Number().
function sameNodeId(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false;
  return String(left) === String(right);
}

// Look up a block in `index.byId` tolerating legacy numeric ids and stable text ids.
function lookupBlock(index, id) {
  if (id === null || id === undefined) return null;
  const direct = index.byId.get(id);
  if (direct) return direct;
  if (typeof id === 'string' && id.startsWith('tmp-')) return null;
  const numeric = Number(id);
  if (Number.isInteger(numeric)) {
    const byNumber = index.byId.get(numeric);
    if (byNumber) return byNumber;
  }
  return index.byId.get(String(id)) || null;
}

function isValidDragTarget(source, target) {
  if (!source || !target) return false;
  if (isAxiomNode(source) || isAxiomNode(target)) return false;
  if (sameNodeId(source.id, target.id)) return false;
  const sourceAddress = String(source.address || '');
  const targetAddress = String(target.address || '');
  if (sourceAddress && targetAddress.startsWith(`${sourceAddress}-`)) return false;
  return true;
}

function ancestorAddresses(address) {
  const parts = String(address || '').split('-').filter(Boolean);
  const result = [];
  for (let i = 1; i < parts.length; i++) {
    result.push(parts.slice(0, i).join('-'));
  }
  return result;
}

function focusAddressForExpandedNode(index, node) {
  if (!node) return null;
  const firstChild = getChildren(index, node.id)[0];
  return firstChild?.address || node.address || null;
}

function addressDepth(address) {
  return String(address || '').split('-').filter(Boolean).length || 1;
}

function addressAtDepth(address, depth) {
  const parts = String(address || '').split('-').filter(Boolean);
  const targetDepth = Math.max(1, Math.floor(Number(depth) || 1));
  return parts.slice(0, Math.min(parts.length, targetDepth)).join('-') || null;
}

function expandedAddressesForVisibleDepth(root, visibleDepthLimit, index) {
  const targetDepth = Math.max(1, Math.floor(Number(visibleDepthLimit) || 1));
  const next = new Set();
  if (!root) return next;
  // index.root 经 toTreeNode 重建后没有 children 属性，必须用 index.childrenOf 走树。
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    const nodeDepth = Math.max(1, Number(node.depth) || addressDepth(node.address));
    const children = index ? getChildren(index, node.id) : (Array.isArray(node.children) ? node.children : []);
    if (nodeDepth < targetDepth && (Number(node.childCount) > 0 || children.length > 0)) {
      next.add(node.address);
    }
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return next;
}

function isVisibleDepthFullyExpanded(root, visibleDepthLimit, expanded, index) {
  const required = expandedAddressesForVisibleDepth(root, visibleDepthLimit, index);
  for (const address of required) {
    if (!expanded.has(address)) return false;
  }
  return true;
}

function clampVisibleDepth(value, maxDepth) {
  const max = Math.max(1, Math.floor(Number(maxDepth) || 1));
  const depth = Math.max(1, Math.floor(Number(value) || 1));
  return Math.min(max, depth);
}

function visibleDepthForExpandedAddresses(expanded, maxDepth) {
  let depth = 1;
  for (const address of expanded || []) {
    depth = Math.max(depth, addressDepth(address) + 1);
  }
  return clampVisibleDepth(depth, maxDepth);
}

function sourcePositionText(value) {
  const position = Number(value);
  if (!Number.isFinite(position)) return '';
  return String(position);
}

function emptyNodePlaceholder(block, paragraphLabelByNodeId) {
  const position = sourcePositionText(block?.sourcePosition ?? block?.source_position);
  if (!position) return '空节点';
  const paragraphLabel = paragraphLabelByNodeId?.get?.(String(block?.id));
  return paragraphLabel ? `段落 ${paragraphLabel}，句位 ${position}` : `句位 ${position}`;
}

// ══════════════════════════════════════════════════════════
// C2DMapView — 组件只做三件事：
//   1. 声明状态和 ref
//   2. 用 effect 驱动数据获取 + 测量
//   3. 输出 JSX
//
// 布局计算 → c2d-measure.mjs
// 事件处理 → c2d-events.mjs
// ══════════════════════════════════════════════════════════

export function C2DMapView({
  docId = null,
  rootNode,
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
  visibleDepthLimit = 1,
  depthControlSeq = 0,
  depthControlAction = 'setDepth',
  maxVisibleDepth = 1,
  onVisibleDepthChange = null,
  treeEditMode = false,
  runWrite = null,
  nodeActions = {},
  onAddAxiom = null,
  onAddAxiomRef = null,
}) {
  // ── 状态 ────────────────────────────────────
  const [expanded, setExpanded]       = useState(() => new Set());
  const [colWidths, setColWidths]     = useState([]);
  const [hovered, setHovered]         = useState(null);
  const [ctxMenu, setCtxMenu]         = useState(null);
  const [inlineEdit, setInlineEdit]   = useState(null);
  const [moveDialog, setMoveDialog]   = useState(null);
  const [statsNodeId, setStatsNodeId] = useState(null);
  const [dragState, setDragState]     = useState(null);
  const [dragChoice, setDragChoice]   = useState(null);
  const [selectedBlockId, setSelectedBlockId] = useState(null);
  const [conn, setConn]               = useState({ lines: [], w: 1, h: 1 });
  const [btnTops, setBtnTops]         = useState(() => new Map());

  // ── Ref ─────────────────────────────────────
  const surfaceRef     = useRef(null);
  const stripRef       = useRef(null);
  const spacerRef      = useRef(null);
  const cards          = useRef(new Map());
  const colEls         = useRef(new Map());
  const readyFired     = useRef(false);
  const savedScrollX   = useRef(0);
  const prevColCount   = useRef(0);
  const scrollTargets  = useRef(new Map());
  const surfaceWidth   = useRef(0);
  const pendingLocate  = useRef(null);
  const lastHotspot    = useRef(null);
  const expandedRef    = useRef(expanded);
  const handledDepthControlSeq = useRef(0);
  const skipNextColumnAutoCenter = useRef(false);
  const previousShowAxiomColumn = useRef(null);
  const dragHoldTimer  = useRef(null);
  const dragSession    = useRef(null);
  const dragHandlers   = useRef({ move: null, up: null, cancel: null });
  const dragListeners  = useRef(null);
  const suppressClick  = useRef(false);
  const inlineInputRef = useRef(null);
  if (!dragListeners.current) {
    dragListeners.current = {
      move: (event) => dragHandlers.current.move?.(event),
      up: (event) => dragHandlers.current.up?.(event),
      cancel: (event) => dragHandlers.current.cancel?.(event)
    };
  }

  // ── 推导数据 ─────────────────────────────────
  const index = useMemo(() => buildTreeIndex(rootNode), [rootNode]);
  const root = index.root;
  const columns = useMemo(() => deriveColumns(root, expanded, index), [root, expanded, index]);
  const axiomBlocks = useMemo(() => (Array.isArray(axioms) ? axioms : []).map(axiomBlock), [axioms]);
  const hasAxioms = axiomBlocks.length > 0;
  const showAxiomColumn = hasAxioms && !axiomsCollapsed;
  const displayColumns = useMemo(() => {
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

  useLayoutEffect(() => {
    if (!inlineEdit) return;
    const input = inlineInputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [inlineEdit?.nodeId, inlineEdit?.field]);

  const runNodeAction = useCallback((action, payload) => {
    if (!canEdit) return null;
    const handler = nodeActions?.[action];
    if (typeof handler !== 'function') {
      onNotice?.('当前动作尚未接入。');
      return null;
    }
    const task = () => handler(payload);
    return runWrite ? runWrite(task) : task();
  }, [canEdit, nodeActions, onNotice, runWrite]);

  function blockById(blockId) {
    const axiom = axiomBlocks.find((item) => String(item.id) === String(blockId));
    if (axiom) return axiom;
    return lookupBlock(index, blockId);
  }

  function resultNodeId(result) {
    return result?.insertedNodeId || result?.node?.id || result?.nodeId || null;
  }

  async function addChild(block) {
    if (isAxiomNode(block)) return;
    const result = await runNodeAction('insertNode', {
      docId,
      parentId: block.id,
      text: '',
      nodeType: 'TEXT'
    });
    const nextNodeId = resultNodeId(result);
    if (nextNodeId) setSelectedNodeId?.(nextNodeId);
  }

  async function addSibling(block) {
    if (!block?.parentId || isAxiomNode(block)) return;
    const result = await runNodeAction('insertNode', {
      docId,
      parentId: block.parentId,
      afterNodeId: block.id,
      text: '',
      nodeType: 'TEXT'
    });
    const nextNodeId = resultNodeId(result);
    if (nextNodeId) setSelectedNodeId?.(nextNodeId);
  }

  async function updateNode(block, patch) {
    if (isAxiomNode(block)) {
      const nextPatch = {};
      if (Object.prototype.hasOwnProperty.call(patch, 'text')) nextPatch.content = patch.text;
      if (Object.prototype.hasOwnProperty.call(patch, 'node_title')) nextPatch.node_title = patch.node_title;
      if (Object.prototype.hasOwnProperty.call(patch, 'node_note')) nextPatch.node_note = patch.node_note;
      if (Object.prototype.hasOwnProperty.call(patch, 'status')) nextPatch.status = patch.status;
      return runNodeAction('updateAxiom', {
        docId,
        axiomId: block.axiomId,
        patch: nextPatch
      });
    }
    return runNodeAction('updateNode', {
      docId,
      nodeId: block.id,
      patch
    });
  }

  async function moveNode(block, direction) {
    if (isAxiomNode(block)) return;
    await runNodeAction('moveNode', { docId, nodeId: block.id, direction });
  }

  async function promoteNode(block) {
    const parent = block?.parentId ? lookupBlock(index, block.parentId) : null;
    if (!block?.parentId || !parent?.parentId) return;
    await runNodeAction('promoteNode', { docId, nodeId: block.id });
  }

  async function splitNode(block) {
    if (isAxiomNode(block)) return;
    const result = await runNodeAction('splitNode', { docId, nodeId: block.id });
    if (result?.changed === false) onNotice?.('当前节点无法自动拆分。');
  }

  async function deleteNode(block) {
    if (isAxiomNode(block)) {
      if (!block?.axiomId) return;
      const ok = window.confirm(`删除事实前提 ${block.address} 及其引用？`);
      if (!ok) return;
      await runNodeAction('deleteAxiom', { docId, axiomId: block.axiomId });
      return;
    }
    if (!block?.parentId) return;
    const ok = window.confirm(`删除节点 ${block.address} 及其子树？`);
    if (!ok) return;
    await runNodeAction('deleteNode', { docId, nodeId: block.id });
  }

  function startInlineEdit(block, field, options = {}) {
    if (!canEdit) return;
    if (field === 'text' && options.subtreePreviewVisible) {
      onNotice?.('请先展开子树再编辑节点文本');
      setCtxMenu(null);
      return;
    }
    const draft = field === 'title'
      ? block.title || ''
      : field === 'note'
        ? block.note || ''
        : block.text || '';
    setInlineEdit({ nodeId: block.id, field, draft });
    setCtxMenu(null);
  }

  function cancelInlineEdit() {
    setInlineEdit(null);
  }

  async function saveInlineEdit(exit = true) {
    if (!inlineEdit) return;
    const block = blockById(inlineEdit.nodeId);
    if (!block) {
      setInlineEdit(null);
      return;
    }
    const fieldName = inlineEdit.field === 'title'
      ? 'node_title'
      : inlineEdit.field === 'note'
        ? 'node_note'
        : 'text';
    await updateNode(block, { [fieldName]: inlineEdit.draft });
    if (exit) setInlineEdit(null);
  }

  function openMoveDialog(block) {
    setMoveDialog({ nodeId: block.id, address: '', error: '' });
    setCtxMenu(null);
  }

  function closeMoveDialog() {
    setMoveDialog(null);
  }

  function clearDragHoldTimer() {
    if (dragHoldTimer.current) {
      window.clearTimeout(dragHoldTimer.current);
      dragHoldTimer.current = null;
    }
  }

  function endDragSession() {
    clearDragHoldTimer();
    const listeners = dragListeners.current;
    window.removeEventListener('pointermove', listeners.move, true);
    window.removeEventListener('pointerup', listeners.up, true);
    window.removeEventListener('pointercancel', listeners.cancel, true);
    document.body.classList.remove('is-dragging-c2d-node');
    dragSession.current = null;
    setDragState(null);
  }

  function validDragTargetAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    const card = element?.closest?.('.c2d-node-card');
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
    setCtxMenu(null);
    setInlineEdit(null);
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

  function startDragHold(event, block) {
    if (!canEdit || !block || isRootNode(block)) return;
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target?.closest?.('button, input, textarea, select, .c2d-inline-editor')) return;
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
    const listeners = dragListeners.current;
    window.addEventListener('pointermove', listeners.move, true);
    window.addEventListener('pointerup', listeners.up, true);
    window.addEventListener('pointercancel', listeners.cancel, true);
  }

  function handleDragPointerMove(event) {
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

  function handleDragPointerUp(event) {
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
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
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

  async function applyDragChoice(mode) {
    if (!dragChoice) return;
    const source = lookupBlock(index, dragChoice.sourceNodeId);
    const target = lookupBlock(index, dragChoice.targetNodeId);
    if (!isValidDragTarget(source, target)) {
      setDragChoice(null);
      return;
    }
    setDragChoice(null);
    if (mode === 'merge') {
      await runNodeAction('mergeNodeIntoTarget', { docId, nodeId: source.id, targetNodeId: target.id });
    } else if (mode === 'sibling') {
      await runNodeAction('moveNodeAfterSibling', { docId, nodeId: source.id, targetNodeId: target.id });
    } else {
      await runNodeAction('moveNodeToParent', { docId, nodeId: source.id, newParentId: target.id });
    }
  }

  async function applyMoveDialog(mode) {
    if (!moveDialog) return;
    const node = lookupBlock(index, moveDialog.nodeId);
    const target = getNodeByAddress(index, String(moveDialog.address || '').trim());
    if (!node || !target) {
      setMoveDialog((current) => current ? { ...current, error: '目标节点地址不存在。' } : current);
      return;
    }
    if (mode === 'merge') {
      await runNodeAction('mergeNodeIntoTarget', { docId, nodeId: node.id, targetNodeId: target.id });
    } else if (mode === 'sibling') {
      await runNodeAction('moveNodeAfterSibling', { docId, nodeId: node.id, targetNodeId: target.id });
    } else {
      await runNodeAction('moveNodeToParent', { docId, nodeId: node.id, newParentId: target.id });
    }
    setMoveDialog(null);
  }

  // ── 统一测量入口（effect 和事件都调这一个）──
  const runMeasure = useCallback(() => {
    setConn(measureConnectorLines(
      stripRef.current, surfaceRef.current,
      colEls.current, cards.current, displayColumns
    ));
    const next = measureButtonTops(displayColumns, expanded, colEls.current, cards.current);
    setBtnTops(prev => {
      if (prev.size !== next.size) return next;
      for (const [k, v] of prev) if (Math.abs((next.get(k) ?? -1) - v) > 0.5) return next;
      return prev;
    });
  }, [displayColumns, expanded]);

  // ── 展开 / 收起 ────────────────────────────
  const toggleExpand = useCallback((block) => {
    const addr = block?.address;
    if (!addr) return;
    const wasExpanded = expanded.has(addr);
    const next = new Set(expanded);
    // 9-2-7：单节点收起只删自身，不级联清掉子孙；子孙留在集合里只是因父级收起而不可见，
    // 父级再展开时所有内部展开/折叠状态自动还原。
    if (wasExpanded) {
      next.delete(addr);
    } else {
      next.add(addr);
    }
    // 还原场景：再次展开根节点 1 时，镜头回到原热点祖先而非默认首子
    const isRootRestore = !wasExpanded && addr === '1' && expanded.size > 0;
    if (isRootRestore && lastHotspot.current) {
      const restoreDepth = visibleDepthForExpandedAddresses(next, maxVisibleDepth);
      pendingLocate.current = addressAtDepth(lastHotspot.current, restoreDepth) || addr;
    } else {
      const hotspot = wasExpanded ? addr : focusAddressForExpandedNode(index, block);
      pendingLocate.current = hotspot || addr;
      lastHotspot.current = hotspot || addr;
      if (docId) {
        try { localStorage.setItem(`c2d:last:${docId}`, hotspot || addr); } catch {}
      }
    }
    setExpanded(next);
  }, [docId, expanded, index, maxVisibleDepth]);

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

  useEffect(() => () => endDragSession(), []);

  useEffect(() => {
    if (!canEdit) endDragSession();
  }, [canEdit]);

  useLayoutEffect(() => {
    let restored = new Set();
    let hotspot = null;
    lastHotspot.current = null;
    if (docId) {
      try {
        const last = localStorage.getItem(`c2d:last:${docId}`);
        if (last) {
          hotspot = last;
          lastHotspot.current = last;
          for (const ancestor of ancestorAddresses(last)) restored.add(ancestor);
        }
      } catch {}
    }
    pendingLocate.current = hotspot;
    setExpanded(restored);
    expandedRef.current = restored;
    setColWidths([]);
    readyFired.current = false;
    prevColCount.current = 0;
    previousShowAxiomColumn.current = null;
  }, [docId]);

  useEffect(() => {
    if (!depthControlSeq) return;
    if (handledDepthControlSeq.current === depthControlSeq) return;
    const action = depthControlAction || 'setDepth';
    const currentExpanded = expandedRef.current;
    // 当前实际最大可见深度直接从 columns 派生（依赖当前 expanded 状态）；
    // visibleDepthLimit 此刻已是按钮提交的新值，不能用来表示"点击前的深度"。
    const currentVisibleDepth = clampVisibleDepth(columns.length || 1, maxVisibleDepth);

    // 8-7-1：仅删除根，保留其它 expanded。下拉/收一层降到 1 也走此路径。
    const collapseToRoot = () => {
      const next = new Set(currentExpanded);
      next.delete('1');
      return { nextExpanded: next, targetDepth: 1 };
    };

    let resolved = null;
    if (action === 'collapseAll') {
      resolved = collapseToRoot();
    } else if (action === 'collapseOne') {
      // 8-7-2：从当前实际最大可见深度收回一层
      const next = Math.max(1, currentVisibleDepth - 1);
      if (next <= 1) {
        resolved = collapseToRoot();
      } else {
        resolved = { nextExpanded: expandedAddressesForVisibleDepth(root, next, index), targetDepth: next };
      }
    } else if (action === 'setDepth') {
      // 8-7-3：清空 expanded 按所选深度重置；选到 1 走 8-7-1
      const next = clampVisibleDepth(visibleDepthLimit, maxVisibleDepth);
      if (next <= 1) {
        resolved = collapseToRoot();
      } else {
        resolved = { nextExpanded: expandedAddressesForVisibleDepth(root, next, index), targetDepth: next };
      }
    } else if (action === 'expandOne') {
      // 8-7-4：当前层未完全展开先补齐，已完全展开再展下一层
      const fully = isVisibleDepthFullyExpanded(root, currentVisibleDepth, currentExpanded, index);
      const next = fully
        ? clampVisibleDepth(currentVisibleDepth + 1, maxVisibleDepth)
        : currentVisibleDepth;
      resolved = { nextExpanded: expandedAddressesForVisibleDepth(root, next, index), targetDepth: next };
    } else if (action === 'expandAll') {
      // 8-7-5：展开到全部深度
      const next = clampVisibleDepth(maxVisibleDepth, maxVisibleDepth);
      resolved = { nextExpanded: expandedAddressesForVisibleDepth(root, next, index), targetDepth: next };
    }

    if (!resolved) return;
    handledDepthControlSeq.current = depthControlSeq;
    // 2-1：仅在调低显示深度且新深度低于热点深度时居中热点祖先。
    // 调高显示深度（expandOne / expandAll / setDepth 增大）时不主动移动镜头，
    // 让列自动居中/保留滚动位置接管，避免横向乱跳。
    const hotspot = lastHotspot.current;
    const hotspotDepth = hotspot ? addressDepth(hotspot) : 0;
    const shrinking = resolved.targetDepth < currentVisibleDepth;
    if (hotspot && shrinking && resolved.targetDepth < hotspotDepth) {
      pendingLocate.current = addressAtDepth(hotspot, resolved.targetDepth);
    } else {
      pendingLocate.current = null;
    }
    expandedRef.current = resolved.nextExpanded;
    setExpanded(resolved.nextExpanded);
  }, [depthControlSeq, depthControlAction, root, visibleDepthLimit, maxVisibleDepth, columns.length]);

  useEffect(() => {
    const defaultW = Math.max(180, Math.floor((surfaceWidth.current || 800) * 0.3));
    setColWidths(prev => displayColumns.map((_, i) => {
      if (i < prev.length) return prev[i];
      return defaultW;
    }));
  }, [displayColumns]);

  useLayoutEffect(() => {
    const prev = previousShowAxiomColumn.current;
    if (prev === null) {
      previousShowAxiomColumn.current = showAxiomColumn;
      return;
    }
    if (prev !== showAxiomColumn) {
      if (showAxiomColumn) {
        const axiomCol = colEls.current.get(0);
        const blocks = displayColumns[0]?.groups.flatMap(g => g.blocks) || [];
        const first = blocks.length ? cards.current.get(blocks[0].address) : null;
        const last = blocks.length ? cards.current.get(blocks[blocks.length - 1].address) : null;
        if (axiomCol && first && last) {
          const center = (first.offsetTop + last.offsetTop + last.offsetHeight) / 2;
          const max = Math.max(0, axiomCol.scrollHeight - axiomCol.clientHeight);
          axiomCol.scrollTop = clampCenterScrollTop(center - axiomCol.clientHeight / 2, first.offsetTop, max);
        }
      }
      previousShowAxiomColumn.current = showAxiomColumn;
      requestAnimationFrame(runMeasure);
    }
  }, [showAxiomColumn, displayColumns, runMeasure]);

  useEffect(() => {
    if (!locateRequest?.address || !locateRequest?.seq) return;
    const addr = locateRequest.address;
    const parts = addr.split('-');
    const ancestors = [];
    for (let i = 1; i < parts.length; i++) {
      ancestors.push(parts.slice(0, i).join('-'));
    }
    if (ancestors.length) {
      setExpanded(prev => {
        const next = new Set(prev);
        for (const a of ancestors) next.add(a);
        return next;
      });
    }
    pendingLocate.current = addr;
  }, [locateRequest?.seq]);

  useLayoutEffect(() => {
    const addr = pendingLocate.current;
    if (!addr) return;
    const el = cards.current.get(addr);
    if (!el) return;
    pendingLocate.current = null;
    skipNextColumnAutoCenter.current = true;
    for (let i = 0; i < displayColumns.length; i++) {
      const blocks = displayColumns[i].groups.flatMap(g => g.blocks);
      if (!blocks.find(b => b.address === addr)) continue;
      const colEl = colEls.current.get(i);
      if (!colEl) break;
      const target = el.offsetTop + el.offsetHeight / 2 - colEl.clientHeight / 2;
      const max = Math.max(0, colEl.scrollHeight - colEl.clientHeight);
      colEl.scrollTo({ top: clampCenterScrollTop(target, el.offsetTop, max), behavior: 'smooth' });
      const surface = surfaceRef.current;
      if (surface) {
        const colRect = colEl.getBoundingClientRect();
        const surfaceRect = surface.getBoundingClientRect();
        if (colRect.right > surfaceRect.right || colRect.left < surfaceRect.left) {
          surface.scrollTo({
            left: Math.max(0, colEl.offsetLeft - surfaceRect.width / 2 + colRect.width / 2),
            behavior: 'smooth'
          });
        }
      }
      break;
    }
    requestAnimationFrame(runMeasure);
  }, [displayColumns, runMeasure]);

  // ── 事件绑定：wheel ───────────────────────
  useEffect(() => {
    const ctx = {
      colElsMap: colEls.current,
      cardsMap: cards.current,
      columns: displayColumns,
      expandedSet: expanded,
      scrollTargets: scrollTargets.current,
      onMeasure: runMeasure
    };
    function onWheel(event) { handleColumnWheel(event, ctx); }
    const els = [...colEls.current.values()];
    for (const el of els) el.addEventListener('wheel', onWheel, { passive: false });
    return () => { for (const el of els) el.removeEventListener('wheel', onWheel); };
  }, [displayColumns, expanded, runMeasure]);

  // ── 列变化后：居中新列、横向滚动 ──────────
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!displayColumns.length) {
      prevColCount.current = 0;
      skipNextColumnAutoCenter.current = false;
      return;
    }
    if (skipNextColumnAutoCenter.current) {
      skipNextColumnAutoCenter.current = false;
      prevColCount.current = displayColumns.length;
      return;
    }
    const prev = prevColCount.current;
    prevColCount.current = displayColumns.length;

    const startFrom = prev === 0 ? 0 : prev;
    for (let i = startFrom; i < displayColumns.length; i++) {
      const el = colEls.current.get(i);
      if (!el) continue;
      const blocks = displayColumns[i].groups.flatMap(g => g.blocks);
      if (!blocks.length) continue;
      const first = cards.current.get(blocks[0].address);
      const last = cards.current.get(blocks[blocks.length - 1].address);
      if (!first || !last) continue;
      const c = (first.offsetTop + last.offsetTop + last.offsetHeight) / 2;
      const max = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = clampCenterScrollTop(c - el.clientHeight / 2, first.offsetTop, max);
    }

    if (surface) {
      if (displayColumns.length > prev && prev > 0) {
        const lastEl = colEls.current.get(displayColumns.length - 1);
        if (lastEl) {
          const r = lastEl.getBoundingClientRect();
          const sr = surface.getBoundingClientRect();
          if (r.right > sr.right) {
            surface.scrollBy({ left: r.right - sr.right + 20, behavior: 'smooth' });
          }
        }
      } else if (savedScrollX.current > 0) {
        surface.scrollLeft = savedScrollX.current;
      }
    }
  }, [displayColumns]);

  // ── 测量 + ResizeObserver ─────────────────
  useLayoutEffect(() => {
    runMeasure();
    const surface = surfaceRef.current;
    if (!surface) return;
    function syncSpacer() {
      if (spacerRef.current && surface) {
        spacerRef.current.style.width = `${Math.floor(surface.clientWidth / 2)}px`;
      }
    }
    syncSpacer();
    const onResize = () => { runMeasure(); syncSpacer(); };
    const ro = new ResizeObserver(onResize);
    ro.observe(surface);
    return () => ro.disconnect();
  }, [displayColumns, runMeasure, showNotes]);

  // ── 渲染就绪回调 ──────────────────────────
  useLayoutEffect(() => {
    if (readyFired.current || !displayColumns.length || !docId) return;
    readyFired.current = true;
    requestAnimationFrame(() => {
      onRenderReady?.({
        docId,
        renderBackend: 'dom',
        requiresGpu: false,
        forceGpuBackend: false,
        hasGpuScene: false,
        visual: null
      });
    });
  }, [displayColumns.length, docId]);

  // ══════════════════════════════════════════════
  // 渲染区
  // ══════════════════════════════════════════════

  function renderInlineEditor(block, field) {
    if (!inlineEdit || inlineEdit.nodeId !== block.id || inlineEdit.field !== field) return null;
    const label = field === 'title' ? '编辑标题' : field === 'note' ? '编辑摘要备注' : '编辑正文';
    return (
      <form
        className={`c2d-inline-editor c2d-inline-editor-${field}`}
        onSubmit={(event) => {
          event.preventDefault();
          saveInlineEdit(true);
        }}
      >
        <span className="c2d-inline-label">{label}</span>
        <textarea
          ref={inlineInputRef}
          className="c2d-inline-input"
          value={inlineEdit.draft}
          rows={field === 'text' ? 4 : 2}
          onChange={(event) => setInlineEdit((current) => current ? { ...current, draft: event.target.value } : current)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelInlineEdit();
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              saveInlineEdit(true);
            }
          }}
          autoFocus
        />
        <div className="c2d-inline-actions">
          <button type="button" onClick={() => saveInlineEdit(false)}>保存</button>
          <button type="submit">保存并退出</button>
          <button type="button" onClick={cancelInlineEdit}>取消</button>
        </div>
      </form>
    );
  }

  function renderTypeBar(block) {
    const type = String(block?.nodeType || 'TEXT').toUpperCase();
    if (type === 'TEXT') return null;
    const color = NODE_TYPE_COLORS[type];
    if (!color || color === 'transparent') return null;
    return (
      <div
        className="c2d-node-type-bar"
        style={{ '--c2d-node-type-color': color }}
        title={nodeTypeLabel(type)}
        aria-label={nodeTypeLabel(type)}
      />
    );
  }

  function renderBlock(block) {
    const addr = block.address;
    const selected = String(selectedBlockId ?? '') === String(block.id);
    const isExpanded = expanded.has(addr);
    const isHovered = hovered === addr;
    const hasChildren = block.childCount > 0;
    const Icon = isExpanded ? ChevronLeft : ChevronRight;
    const AxiomIcon = showAxiomColumn ? ChevronRight : ChevronLeft;
    const btnTop = btnTops.get(addr);
    const isAxiom = isAxiomNode(block);
    const hasAxiomToggle = !isAxiom && isRootNode(block) && hasAxioms;
    const isDragSource = sameNodeId(dragState?.nodeId, block.id);
    const isDragTarget = sameNodeId(dragState?.targetNodeId, block.id);

    const title = block.title || '';
    const noteText = plainNodeNote(block.note || '');
    let ownText = block.text;
    let subtreePreview = '';
    // 节点 text 字段里通常已经包含子节点 text（PDF 解析就这么存的）。无论展开还是收起，
    // ownText 都要先剥掉直接子节点的 text 再渲染；否则收起态下 ownText + subtreePreview
    // 会重复显示同一段内容。
    if (hasChildren) {
      const children = getChildren(index, block.id);
      if (children.length > 0) {
        let stripped = ownText;
        for (const child of children) {
          if (child.text) stripped = stripped.replace(child.text, '');
        }
        ownText = stripped.trim();
      }
      if (!isExpanded) {
        subtreePreview = subtreePreviewText(index, block.id, TEXT_CHAR_LIMIT);
      }
    }
    const textLoading = false;
    const stats = nodeStats(index, block);
    const subtreePreviewVisible = Boolean(subtreePreview);
    const emptyPlaceholder = emptyNodePlaceholder(block, paragraphLabelByNodeId);
    const editTextFromBody = (event) => {
      event.preventDefault();
      event.stopPropagation();
      startInlineEdit(block, 'text', { subtreePreviewVisible });
    };

    return (
      <article
        key={block.id}
        data-node-id={block.id}
        data-node-address={addr}
        ref={el => { if (el) cards.current.set(addr, el); else cards.current.delete(addr); }}
        className={`c2d-node-card${selected ? ' selected' : ''}${isExpanded ? ' expanded' : ''}${hasAxiomToggle ? ' has-axiom-toggle' : ''}${isAxiom ? ' axiom-node' : ''}${isDragSource ? ' drag-source' : ''}${isDragTarget ? ' drag-target' : ''}`}
        onPointerEnter={() => setHovered(addr)}
        onPointerLeave={() => setHovered(p => p === addr ? null : p)}
        onPointerDown={(event) => startDragHold(event, block)}
        onClick={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          setCtxMenu(null);
          setSelectedBlockId(block.id);
          if (!isAxiom) setSelectedNodeId?.(block.id);
          setMultiSelectedIds(new Set());
        }}
        onContextMenu={e => {
          e.preventDefault();
          e.stopPropagation();
          setSelectedBlockId(block.id);
          setCtxMenu({ x: e.clientX, y: e.clientY, block, subtreePreviewVisible });
          if (!isAxiom) setSelectedNodeId?.(block.id);
        }}
      >
        {renderTypeBar(block)}
        <button
          type="button"
          className="c2d-node-stats-button"
          title="节点统计"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setStatsNodeId(block.id);
            setSelectedBlockId(block.id);
            if (!isAxiom) setSelectedNodeId?.(block.id);
          }}
        >
          {stats.subtree.words}
        </button>
        <div className="c2d-node-meta">{addr}</div>
        {renderInlineEditor(block, 'title') || (title ? <div className="c2d-node-title">{title}</div> : null)}
        {renderInlineEditor(block, 'text') || (ownText
          ? <div className="c2d-node-body" onDoubleClick={editTextFromBody}>{ownText}</div>
          : !subtreePreview && <div className="c2d-node-body muted" onDoubleClick={editTextFromBody}>{textLoading ? '正在读取子树正文。' : emptyPlaceholder}</div>)}
        {subtreePreview ? <div className="c2d-node-body c2d-subtree-preview" onDoubleClick={editTextFromBody}>{subtreePreview}</div> : null}
        {renderInlineEditor(block, 'note') || (showNotes && noteText ? <div className="c2d-node-note">{noteText}</div> : null)}
        {hasAxiomToggle && isHovered ? (
          <button
            type="button"
            className="c2d-expand-button c2d-axiom-expand-button"
            aria-label={showAxiomColumn ? '收起事实前提' : '展开事实前提'}
            title={showAxiomColumn ? '收起事实前提' : '展开事实前提'}
            onClick={e => { e.stopPropagation(); e.preventDefault(); onToggleAxiomsCollapsed?.(); }}
          >
            <AxiomIcon aria-hidden="true" size={EXPAND_ICON} strokeWidth={2.2} />
          </button>
        ) : null}
        {hasChildren && isHovered ? (
          <button
            type="button"
            className="c2d-expand-button"
            aria-label={isExpanded ? '收起' : '展开'}
            title={isExpanded ? '收起' : '展开'}
            style={{
              '--c2d-expand-button-size': `${EXPAND_BTN}px`,
              top: Number.isFinite(btnTop) ? `${btnTop}px` : undefined
            }}
            onClick={e => { e.stopPropagation(); e.preventDefault(); toggleExpand(block); }}
          >
            <Icon aria-hidden="true" size={EXPAND_ICON} strokeWidth={2.2} />
          </button>
        ) : null}
      </article>
    );
  }

  return (
    <div
      ref={surfaceRef}
      className="c2d-map-surface"
      onScroll={() => { if (surfaceRef.current) savedScrollX.current = surfaceRef.current.scrollLeft; }}
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
          <svg
            className="c2d-connector-layer"
            width={conn.w}
            height={conn.h}
            viewBox={`0 0 ${conn.w} ${conn.h}`}
            aria-hidden="true"
          >
            {conn.lines.map(l => (
              <path
                key={l.key}
                d={l.d}
                className="c2d-connector-line"
                data-edge-left={l.bounds?.left ?? 0}
                data-edge-top={l.bounds?.top ?? 0}
                data-edge-width={l.bounds?.width ?? 0}
                data-edge-height={l.bounds?.height ?? 0}
              />
            ))}
          </svg>
          {displayColumns.map((col, i) => {
            const blocks = col.groups.flatMap(g => g.blocks);
            return (
              <div key={`col-wrap-${col.kind || 'tree'}-${i}`} className={`c2d-column-wrapper${col.kind === 'axioms' ? ' axiom-column-wrapper' : ''}`} style={{ position: 'relative' }}>
                <section
                  ref={el => { if (el) colEls.current.set(i, el); else colEls.current.delete(i); }}
                  className={`c2d-column${col.kind === 'axioms' ? ' c2d-axiom-column' : ''}`}
                  style={{ width: `${colWidths[i] || 240}px` }}
                  onScroll={() => {
                    requestAnimationFrame(runMeasure);
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
                    onEnd: () => requestAnimationFrame(runMeasure)
                  })}
                />
              </div>
            );
          })}
          <div ref={spacerRef} className="c2d-column-spacer" aria-hidden="true" />
        </div>
      )}

      {ctxMenu && (() => {
        const block = ctxMenu.block;
        const isAxiom = isAxiomNode(block);
        const isRoot = !isAxiom && !block?.parentId;
        const parentBlock = block?.parentId ? lookupBlock(index, block.parentId) : null;
        const canPromoteToParentSibling = !isAxiom && Boolean(block?.parentId && parentBlock?.parentId);
        const siblings = block && !isAxiom ? getSiblings(index, block.id) : [];
        const siblingIndex = siblings.findIndex((item) => sameNodeId(item.id, block?.id));
        const canMoveUp = siblingIndex > 0;
        const canMoveDown = siblingIndex >= 0 && siblingIndex < siblings.length - 1;
        const menuAction = (handler) => (event) => {
          event.preventDefault();
          event.stopPropagation();
          setCtxMenu(null);
          handler();
        };
        const editModePromptAction = (event) => {
          event.preventDefault();
          event.stopPropagation();
          onNotice?.('请先进入编辑模式');
          setCtxMenu(null);
        };
        const editButtonProps = (disabled, handler) => (
          canEdit
            ? { disabled, onClick: disabled ? undefined : menuAction(handler) }
            : { 'aria-disabled': 'true', onClick: editModePromptAction }
        );
        const clampMenu = el => {
          if (!el) return;
          const margin = 8;
          const r = el.getBoundingClientRect();
          const x = Math.max(margin, Math.min(ctxMenu.x, window.innerWidth - r.width - margin));
          const y = Math.max(margin, Math.min(ctxMenu.y, window.innerHeight - r.height - margin));
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        };
        return createPortal(
          <div ref={clampMenu} className="context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={e => e.stopPropagation()}>
            <button {...editButtonProps(isAxiom, () => addChild(block))}>新增空白子节点</button>
            <button {...editButtonProps(isRoot || isAxiom, () => addSibling(block))}>新增空白兄弟节点</button>
            <div className="context-sep" />
            <div className="context-submenu">
              <div className={`context-sub-trigger${canEdit ? '' : ' disabled'}`} onClick={canEdit ? undefined : editModePromptAction}>编辑内容 ▸</div>
              <div className="context-sub-items">
                <button {...editButtonProps(false, () => startInlineEdit(block, 'text', { subtreePreviewVisible: Boolean(ctxMenu.subtreePreviewVisible) }))}>编辑正文</button>
                <button {...editButtonProps(false, () => startInlineEdit(block, 'title'))}>编辑标题</button>
                <button {...editButtonProps(false, () => startInlineEdit(block, 'note'))}>编辑摘要备注</button>
              </div>
            </div>
            <div className="context-sep" />
            <div className="context-submenu">
              <div className={`context-sub-trigger${canEdit && !isAxiom ? '' : ' disabled'}`} onClick={!canEdit ? editModePromptAction : undefined}>编辑关系 ▸</div>
              <div className="context-sub-items">
                <button {...editButtonProps(!canMoveUp, () => moveNode(block, 'up'))}>上移</button>
                <button {...editButtonProps(!canMoveDown, () => moveNode(block, 'down'))}>下移</button>
                <button {...editButtonProps(!canPromoteToParentSibling, () => promoteNode(block))}>升为父级兄弟</button>
                <button {...editButtonProps(isRoot || isAxiom, () => openMoveDialog(block))}>移动到…</button>
              </div>
            </div>
            <div className="context-sep" />
            <button {...editButtonProps(isAxiom, () => splitNode(block))}>自动拆分</button>
            {!isAxiom ? <button {...editButtonProps(!onAddAxiom, () => onAddAxiom?.(block.id))}>新增事实前提</button> : null}
            {!isAxiom ? <button {...editButtonProps(isRoot || !onAddAxiomRef, () => onAddAxiomRef?.(block.id))}>添加事实前提引用</button> : null}
            <div className="context-sep" />
            {!isAxiom ? (
              <div className="context-submenu">
                <div className={`context-sub-trigger${canEdit ? '' : ' disabled'}`} onClick={canEdit ? undefined : editModePromptAction}>修改类型 ▸</div>
                <div className="context-sub-items">
                  {NODE_TYPES.map(t => (
                    <button
                      key={t}
                      {...editButtonProps(block?.nodeType === t, () => updateNode(block, { node_type: t }))}
                    >
                      {nodeTypeLabel(t)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {!isAxiom ? <div className="context-sep" /> : null}
            <button className="context-danger" {...editButtonProps(isRoot, () => deleteNode(block))}>{isAxiom ? '删除事实前提' : '删除节点及子树'}</button>
          </div>,
          document.body
        );
      })()}
      {dragState && createPortal(
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
      )}
      {dragChoice && (() => {
        const source = lookupBlock(index, dragChoice.sourceNodeId);
        const target = lookupBlock(index, dragChoice.targetNodeId);
        if (!source || !target) return null;
        const canAttachSibling = Boolean(target.parentId);
        const close = () => setDragChoice(null);
        const run = (mode) => (event) => {
          event.preventDefault();
          event.stopPropagation();
          applyDragChoice(mode);
        };
        const clampDragChoice = el => {
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
            <button onClick={close}>取消</button>
          </div>,
          document.body
        );
      })()}
      {statsNodeId && (() => {
        const node = blockById(statsNodeId);
        if (!node) return null;
        const stats = nodeStats(index, node);
        const statRow = (label, ownValue, subtreeValue) => (
          <>
            <div className="c2d-stat-label">{label}</div>
            <div className="c2d-stat-value">{ownValue}</div>
            <div className="c2d-stat-value">{subtreeValue}</div>
          </>
        );
        return createPortal(
          <div className="dialog-overlay" onClick={() => setStatsNodeId(null)}>
            <div className="dialog-box node-dialog c2d-stats-dialog" onClick={(event) => event.stopPropagation()}>
              <header className="dialog-header with-close">
                <span>节点统计</span>
                <button type="button" onClick={() => setStatsNodeId(null)} aria-label="关闭">x</button>
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
      })()}
      {moveDialog && createPortal(
        <div className="dialog-overlay" onClick={closeMoveDialog}>
          <div className="dialog-box node-dialog" onClick={(event) => event.stopPropagation()}>
            <header className="dialog-header">移动到…</header>
            <label className="dialog-field">
              <span>目标节点地址</span>
              <input
                className="dialog-input"
                value={moveDialog.address}
                placeholder="例如 1-5-6"
                onChange={(event) => setMoveDialog((current) => current ? { ...current, address: event.target.value, error: '' } : current)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') closeMoveDialog();
                  event.stopPropagation();
                }}
                autoFocus
              />
            </label>
            {moveDialog.error ? <div className="dialog-error">{moveDialog.error}</div> : null}
            <div className="dialog-actions">
              <button type="button" onClick={() => applyMoveDialog('merge')}>合并节点</button>
              <button type="button" onClick={() => applyMoveDialog('sibling')}>挂载为兄弟节点</button>
              <button type="button" onClick={() => applyMoveDialog('child')}>挂载子节点</button>
              <button type="button" onClick={closeMoveDialog}>取消</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
