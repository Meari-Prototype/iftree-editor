// useC2DInlineEdit.ts
// C2D 卡片行内编辑状态机：标题/正文/摘要备注三字段草稿 + 聚焦管理 + 保存回写。
// 从 MindMapView 组件体原样外提；关菜单动作经 closeContextMenu 回调注入（保持原时序）。

import { useLayoutEffect, useRef, useState } from 'react';
import type { EditField, InlineEditState } from './C2DNodeCard';
import type { C2DBlock } from './c2d-types';

export interface C2DInlineEditOptions {
  canEdit: boolean;
  blockById(blockId: string | null | undefined): C2DBlock | null;
  updateNode(block: C2DBlock, patch: Record<string, unknown>): Promise<unknown>;
  onNotice?: ((message: string) => void) | null;
  closeContextMenu(): void;
}

export function useC2DInlineEdit({
  canEdit, blockById, updateNode, onNotice = null, closeContextMenu
}: C2DInlineEditOptions) {
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const inlineInputRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    if (!inlineEdit) return;
    const input = inlineInputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, [inlineEdit?.nodeId, inlineEdit?.field]);

  function startInlineEdit(block: C2DBlock, field: EditField, options: { subtreePreviewVisible?: boolean } = {}) {
    if (!canEdit) return;
    if (field === 'text' && options.subtreePreviewVisible) {
      onNotice?.('请先展开子树再编辑节点文本');
      closeContextMenu();
      return;
    }
    const draft = field === 'title'
      ? block.title || ''
      : field === 'note'
        ? block.note || ''
        : block.text || '';
    setInlineEdit({ nodeId: block.id, field, draft });
    closeContextMenu();
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

  function setInlineDraft(draft: string) {
    setInlineEdit((current) => current ? { ...current, draft } : current);
  }

  return {
    inlineEdit,
    inlineInputRef,
    startInlineEdit,
    cancelInlineEdit,
    saveInlineEdit,
    setInlineDraft
  };
}
