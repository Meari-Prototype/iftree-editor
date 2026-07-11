// C2DContextMenu.tsx
// C2D 节点右键菜单（需求 9-5 只读交互：非编辑模式下动作降级为「请先进入编辑模式」提示）。
// 从 MindMapView 内联 IIFE 原样组件化：动作经 actions 对象注入，菜单自身无业务逻辑。

import { createPortal } from 'react-dom';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { NODE_TYPES } from '../../../core/tree.js';
import { nodeTypeLabel } from '../../lib/doc-utils.js';
import { isAxiomNode, lookupBlock } from './c2d-blocks.js';
import type { EditField } from './C2DNodeCard';
import type { C2DBlock, C2DTreeIndex } from './c2d-types';

export interface CtxMenuState {
  x: number;
  y: number;
  block: C2DBlock;
  subtreePreviewVisible: boolean;
}

export interface C2DContextMenuActions {
  addChild(block: C2DBlock): void;
  addSibling(block: C2DBlock): void;
  startInlineEdit(block: C2DBlock, field: EditField, options?: { subtreePreviewVisible?: boolean }): void;
  moveNode(block: C2DBlock, direction: 'up' | 'down'): void;
  promoteNode(block: C2DBlock): void;
  openMoveDialog(block: C2DBlock): void;
  splitNode(block: C2DBlock): void;
  updateNode(block: C2DBlock, patch: Record<string, unknown>): void;
  deleteNode(block: C2DBlock): void;
}

export interface C2DContextMenuProps {
  ctxMenu: CtxMenuState;
  index: C2DTreeIndex;
  canEdit: boolean;
  actions: C2DContextMenuActions;
  onAddAxiom?: ((nodeId: string) => void) | null;
  onAddAxiomRef?: ((nodeId: string) => void) | null;
  onNotice?: ((message: string) => void) | null;
  onClose(): void;
}

export function C2DContextMenu({
  ctxMenu, index, canEdit, actions, onAddAxiom = null, onAddAxiomRef = null, onNotice = null, onClose
}: C2DContextMenuProps) {
  const block = ctxMenu.block;
  const isAxiom = isAxiomNode(block);
  const isRoot = !isAxiom && !block?.parentId;
  const parentBlock = block?.parentId ? lookupBlock(index, block.parentId) : null;
  const canPromoteToParentSibling = !isAxiom && Boolean(block?.parentId && parentBlock?.parentId);
  const siblings = block && !isAxiom ? (index.childrenOf.get(block.parentId) || []) : [];
  const siblingIndex = siblings.findIndex((item: C2DBlock) => item.id === block.id);
  const canMoveUp = siblingIndex > 0;
  const canMoveDown = siblingIndex >= 0 && siblingIndex < siblings.length - 1;
  const menuAction = (handler: () => void) => (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    handler();
  };
  const editModePromptAction = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onNotice?.('请先进入编辑模式');
    onClose();
  };
  const editButtonProps = (disabled: boolean, handler: () => void) => (
    canEdit
      ? { disabled, onClick: disabled ? undefined : menuAction(handler) }
      : { 'aria-disabled': 'true' as const, onClick: editModePromptAction }
  );
  const clampMenu = (el: HTMLDivElement | null) => {
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
      <button {...editButtonProps(isAxiom, () => actions.addChild(block))}>新增空白子节点</button>
      <button {...editButtonProps(isRoot || isAxiom, () => actions.addSibling(block))}>新增空白兄弟节点</button>
      <div className="context-sep" />
      <div className="context-submenu">
        <div className={`context-sub-trigger${canEdit ? '' : ' disabled'}`} onClick={canEdit ? undefined : editModePromptAction}>编辑内容 ▸</div>
        <div className="context-sub-items">
          <button {...editButtonProps(false, () => actions.startInlineEdit(block, 'text', { subtreePreviewVisible: Boolean(ctxMenu.subtreePreviewVisible) }))}>编辑正文</button>
          <button {...editButtonProps(false, () => actions.startInlineEdit(block, 'title'))}>编辑标题</button>
          <button {...editButtonProps(false, () => actions.startInlineEdit(block, 'note'))}>编辑摘要备注</button>
        </div>
      </div>
      <div className="context-sep" />
      <div className="context-submenu">
        <div className={`context-sub-trigger${canEdit && !isAxiom ? '' : ' disabled'}`} onClick={!canEdit ? editModePromptAction : undefined}>编辑关系 ▸</div>
        <div className="context-sub-items">
          <button {...editButtonProps(!canMoveUp, () => actions.moveNode(block, 'up'))}>上移</button>
          <button {...editButtonProps(!canMoveDown, () => actions.moveNode(block, 'down'))}>下移</button>
          <button {...editButtonProps(!canPromoteToParentSibling, () => actions.promoteNode(block))}>升为父级兄弟</button>
          <button {...editButtonProps(isRoot || isAxiom, () => actions.openMoveDialog(block))}>移动到…</button>
        </div>
      </div>
      <div className="context-sep" />
      <button {...editButtonProps(isAxiom, () => actions.splitNode(block))}>自动拆分</button>
      {!isAxiom ? <button {...editButtonProps(!onAddAxiom, () => onAddAxiom?.(block.id))}>新增事实前提</button> : null}
      {!isAxiom ? <button {...editButtonProps(isRoot || !onAddAxiomRef, () => onAddAxiomRef?.(block.id))}>添加事实前提引用</button> : null}
      <div className="context-sep" />
      {!isAxiom ? (
        <div className="context-submenu">
          <div className={`context-sub-trigger${canEdit ? '' : ' disabled'}`} onClick={canEdit ? undefined : editModePromptAction}>修改类型 ▸</div>
          <div className="context-sub-items">
            {NODE_TYPES.map((t: string) => (
              <button
                key={t}
                {...editButtonProps(block?.nodeType === t, () => actions.updateNode(block, { node_type: t }))}
              >
                {nodeTypeLabel(t)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {!isAxiom ? <div className="context-sep" /> : null}
      <button className="context-danger" {...editButtonProps(isRoot, () => actions.deleteNode(block))}>{isAxiom ? '删除事实前提' : '删除节点及子树'}</button>
    </div>,
    document.body
  );
}
