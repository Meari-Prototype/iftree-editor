// useC2DNodeCommands.ts
// C2D 节点命令包装层：把卡片/菜单/拖拽的结构编辑动作统一打到 onNodeCommand 上抛口，
// 附带「移动到…」对话框状态（其应用路径也是命令）。从 MindMapView 组件体原样外提。

import { useCallback, useState } from 'react';
import { isAxiomNode, lookupBlock } from './c2d-blocks.js';
import type { MoveDialogState, DragAttachMode } from './C2DOverlays';
import type { C2DBlock, C2DTreeIndex } from './c2d-types';

export interface C2DNodeCommandsOptions {
  index: C2DTreeIndex;
  axiomBlocks: C2DBlock[];
  canEdit: boolean;
  onNodeCommand?: ((command: Record<string, unknown>) => unknown) | null;
  onNotice?: ((message: string) => void) | null;
  setSelectedNodeId?: ((id: string) => void) | undefined;
}

function resultNodeId(rawResult: unknown): string | null {
  const result = (rawResult || {}) as { insertedNodeId?: unknown; node?: { id?: unknown }; nodeId?: unknown };
  return (result.insertedNodeId || result.node?.id || result.nodeId || null) as string | null;
}

export function useC2DNodeCommands({
  index, axiomBlocks, canEdit, onNodeCommand = null, onNotice = null, setSelectedNodeId
}: C2DNodeCommandsOptions) {
  const [moveDialog, setMoveDialog] = useState<MoveDialogState | null>(null);

  const runNodeCommand = useCallback((command: Record<string, unknown>) => {
    if (!canEdit) return null;
    if (typeof onNodeCommand !== 'function') {
      onNotice?.('当前动作尚未接入。');
      return null;
    }
    return onNodeCommand(command);
  }, [canEdit, onNodeCommand, onNotice]);

  const blockById = useCallback((blockId: string | null | undefined): C2DBlock | null => {
    const axiom = axiomBlocks.find((item) => item.id === blockId);
    if (axiom) return axiom;
    return lookupBlock(index, blockId);
  }, [axiomBlocks, index]);

  async function addChild(block: C2DBlock) {
    if (isAxiomNode(block)) return;
    const result = await runNodeCommand({
      type: 'addChild',
      parentNodeId: block.id
    });
    const nextNodeId = resultNodeId(result);
    if (nextNodeId) setSelectedNodeId?.(nextNodeId);
  }

  async function addSibling(block: C2DBlock) {
    if (!block?.parentId || isAxiomNode(block)) return;
    const result = await runNodeCommand({
      type: 'addSibling',
      parentNodeId: block.parentId,
      afterNodeId: block.id
    });
    const nextNodeId = resultNodeId(result);
    if (nextNodeId) setSelectedNodeId?.(nextNodeId);
  }

  async function updateNode(block: C2DBlock, patch: Record<string, unknown>) {
    return runNodeCommand({
      type: 'updateBlock',
      target: isAxiomNode(block)
        ? { kind: 'axiom', axiomId: block.axiomId }
        : { kind: 'node', nodeId: block.id },
      patch
    });
  }

  async function moveNode(block: C2DBlock, direction: 'up' | 'down') {
    if (isAxiomNode(block)) return;
    await runNodeCommand({ type: 'reorderNode', nodeId: block.id, direction });
  }

  async function promoteNode(block: C2DBlock) {
    const parent = block?.parentId ? lookupBlock(index, block.parentId) : null;
    if (!block?.parentId || !parent?.parentId) return;
    await runNodeCommand({ type: 'promoteToParentSibling', nodeId: block.id });
  }

  async function splitNode(block: C2DBlock) {
    if (isAxiomNode(block)) return;
    const result = await runNodeCommand({ type: 'splitNode', nodeId: block.id }) as { changed?: boolean } | null;
    if (result?.changed === false) onNotice?.('当前节点无法自动拆分。');
  }

  async function deleteNode(block: C2DBlock) {
    if (isAxiomNode(block)) {
      if (!block?.axiomId) return;
      const ok = window.confirm(`删除事实前提 ${block.address} 及其引用？`);
      if (!ok) return;
      await runNodeCommand({
        type: 'deleteBlock',
        target: { kind: 'axiom', axiomId: block.axiomId }
      });
      return;
    }
    if (!block?.parentId) return;
    const ok = window.confirm(`删除节点 ${block.address} 及其子树？`);
    if (!ok) return;
    await runNodeCommand({
      type: 'deleteBlock',
      target: { kind: 'node', nodeId: block.id }
    });
  }

  // 唯一入口是右键菜单，menuAction 已先关菜单，这里只管自身状态。
  function openMoveDialog(block: C2DBlock) {
    setMoveDialog({ nodeId: block.id, address: '', error: '' });
  }

  function closeMoveDialog() {
    setMoveDialog(null);
  }

  function setMoveDialogAddress(address: string) {
    setMoveDialog((current) => current ? { ...current, address, error: '' } : current);
  }

  async function applyMoveDialog(mode: DragAttachMode) {
    if (!moveDialog) return;
    const node = lookupBlock(index, moveDialog.nodeId);
    const target = index.byAddress.get(String(moveDialog.address || '').trim()) ?? null;
    if (!node || !target) {
      setMoveDialog((current) => current ? { ...current, error: '目标节点地址不存在。' } : current);
      return;
    }
    if (mode === 'merge') {
      await runNodeCommand({ type: 'mergeIntoTarget', nodeId: node.id, targetNodeId: target.id });
    } else if (mode === 'sibling') {
      await runNodeCommand({ type: 'moveAfterSibling', nodeId: node.id, targetNodeId: target.id });
    } else {
      await runNodeCommand({ type: 'moveToParent', nodeId: node.id, newParentId: target.id });
    }
    setMoveDialog(null);
  }

  return {
    runNodeCommand,
    blockById,
    addChild,
    addSibling,
    updateNode,
    moveNode,
    promoteNode,
    splitNode,
    deleteNode,
    moveDialog,
    openMoveDialog,
    closeMoveDialog,
    setMoveDialogAddress,
    applyMoveDialog
  };
}
