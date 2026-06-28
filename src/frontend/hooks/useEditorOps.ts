import { useMemo, useState } from 'react';

// undo/redo 栈元素 = 编辑分支 diff entry 或 editor snapshot token（id 形如 'editor-N'）；
// 真类型在 history-stack / document-session 里，AppBody 经 normalizeHistoryToken 自行 narrow。
// 这里只把 useState 显式标 unknown[] —— 默认 [] 会推断 never[]，让窄 setter 在 AppBody 调用处变体不兼容。
export type EditorHistoryStack = unknown[];

// 撤销/重做栈的纯状态容器。
// 入栈/出栈/历史 token 语义由 App.jsx 的 updateUndoStack/updateRedoStack
// （基于 ref，避免连续操作读到陈旧栈）统一管理，这里只持有 state 本身。
// 「是否处于编辑模式」不在这里：它派生自当前文档是否持有编辑分支标识（见 App.jsx），
// 不再作为独立开关，避免与 editBranch 不一致。
export function useEditorOps() {
  const [undoStack, setUndoStack] = useState<EditorHistoryStack>([]);
  const [redoStack, setRedoStack] = useState<EditorHistoryStack>([]);

  return useMemo(() => ({
    undoStack,
    redoStack,
    setUndoStack,
    setRedoStack
  }), [redoStack, undoStack]);
}
