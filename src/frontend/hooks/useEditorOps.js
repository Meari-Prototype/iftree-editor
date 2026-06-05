import { useMemo, useState } from 'react';

// 撤销/重做栈的纯状态容器。
// 入栈/出栈/历史 token 语义由 App.jsx 的 updateUndoStack/updateRedoStack
// （基于 ref，避免连续操作读到陈旧栈）统一管理，这里只持有 state 本身。
// 「是否处于编辑模式」不在这里：它派生自当前文档是否持有编辑分支标识（见 App.jsx），
// 不再作为独立开关，避免与 editBranch 不一致。
export function useEditorOps() {
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);

  return useMemo(() => ({
    undoStack,
    redoStack,
    setUndoStack,
    setRedoStack
  }), [redoStack, undoStack]);
}
