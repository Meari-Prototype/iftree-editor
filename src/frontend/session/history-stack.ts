// @ts-nocheck
// 撤销/重做栈纯逻辑（前后端无关，可 node --test）。token 不透明（后端 capture 给），本模块只管三件：
// 栈封顶、editBranch 双轨过滤（diff entry 的 undo/redo 分组）、快照 token id 提取。
// React 适配（ref/setState）+ 后端 IO（capture/restore/discard）留 AppBody，不在这里。

export const HISTORY_STACK_CAP = 80;

// 封顶 push：返回 { stack, evicted }——evicted 是被挤出的最旧 token，调用方负责通知后端释放快照。
export function pushCapped(stack, token, cap = HISTORY_STACK_CAP) {
  const list = Array.isArray(stack) ? stack : [];
  const keep = Math.max(0, cap - 1);
  const evicted = list.slice(0, Math.max(0, list.length - keep));
  return { stack: [...list.slice(-keep), token], evicted };
}

// editBranch diff entry 是否已撤销（status==='undone'；undoneAt 只用于 redo 排序）。
export function isUndoneEditBranchEntry(entry) {
  return String(entry?.status || 'active') === 'undone';
}

// 编辑分支双轨：undo = 未撤销 entries（正序）；redo = 已撤销 entries（按 undoneAt/createdAt 升序）。
export function editBranchUndoEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => !isUndoneEditBranchEntry(entry));
}

export function editBranchRedoEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter(isUndoneEditBranchEntry)
    .sort((left, right) => String(left.undoneAt || left.createdAt || '')
      .localeCompare(String(right.undoneAt || right.createdAt || '')));
}

// 快照 token id（editor- 前缀）提取——栈里混着 editBranch diff entry 时靠前缀挡掉，
// 只有 editorSnapshotTokens 需要后端释放。idOf 注入（AppBody 用 normalizeHistoryToken）。
export function snapshotTokenIds(tokens, idOf) {
  return (Array.isArray(tokens) ? tokens : [])
    .map((token) => idOf(token))
    .filter((id) => id && String(id).startsWith('editor-'));
}
