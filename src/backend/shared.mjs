export function parseJsonObject(value, fallback = {}) {
  try {
    const parsed = value ? JSON.parse(value) : fallback;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function compareNodeAddress(a, b) {
  const aParts = String(a?.address || '').split('-').filter(Boolean).map(Number);
  const bParts = String(b?.address || '').split('-').filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

// 文档编辑模式三态标签（projectneed 4-16-8）：只读 / 增量编辑（流式写入）/ 完整编辑（2way/3way）。
export const EDIT_MODE_LABELS = Object.freeze({
  readonly: '只读',
  incremental: '增量编辑（流式写入）',
  full: '完整编辑'
});

// 编辑模式不符时的统一报错（projectneed 4-16-8 / NOW 1-2）：写入动词自报当前模式、所需模式与切换办法，
// 调用方据此一步切模式即可，不必预先建模"现在处于什么模式"的状态机。
// 后端为 GUI / db 外壳 / MCP 共用，故同时给出两条文字通道的切模式动词。
export function editModeMismatchMessage({ docId, current, required, intent }) {
  const cur = EDIT_MODE_LABELS[current] || current || '未知';
  const req = EDIT_MODE_LABELS[required] || required;
  return `${intent}要求文档 ${docId} 处于${req}模式，当前为${cur}；请先 set_mode 切到 ${required}（db 外壳：db set-mode ${docId} ${required}）`;
}

// 节点补丁字段校验：底座 updateNode 与编辑分支 stage/nodePatchForEditBranch 共用，故下沉到这里。
// human_tag 已退场（改 node_type）、trust_level 只走 human certify（18-3），补丁里夹这些字段一律报错。
export function hasOwnValue(source, ...keys) {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(source || {}, key));
}

export function assertNoHumanTagField(source, context = 'node patch') {
  if (hasOwnValue(source, 'human_tag', 'humanTag')) {
    throw new Error(`${context} no longer supports human_tag; set node_type instead`);
  }
}

export function assertNoEditTrustField(source, context = 'node patch') {
  if (hasOwnValue(source, 'trust_level', 'trustLevel', 'trust')) {
    throw new Error(`${context} no longer supports trust_level; use human certify to set trust_level`);
  }
}
