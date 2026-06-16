// edit branch 暂存变更的紧凑状态行（git status 语义）。MCP（draft list / diff）与
// CLI（db-shell）共用——此前两处逐字重复、只数笼统的 active/undone，不分改/增/删。
// diff.entries 是 op-log 形态（kind: node.insert/delete/update/move...），按 kind 归类计数。

const KIND_BUCKET = {
  'node.insert': 'insert',
  'node.delete': 'delete',
  'node.update': 'update',
  'node.move': 'move',
  'node.moveAfter': 'move',
  'node.reparent': 'move'
};

export function parseBranchEntryCounts(branch = {}) {
  const counts = { active: 0, undone: 0, update: 0, insert: 0, delete: 0, move: 0, other: 0 };
  let entries = [];
  try {
    const diff = JSON.parse(branch.diff || '{}');
    entries = Array.isArray(diff.entries) ? diff.entries : [];
  } catch {
    return counts;
  }
  for (const entry of entries) {
    if (entry?.status === 'undone') { counts.undone += 1; continue; }
    counts.active += 1;
    counts[KIND_BUCKET[entry?.kind] || 'other'] += 1;
  }
  return counts;
}

// 一行 git status：`[*] branch:X doc:Y owner:Z 改:U 增:I 删:D [移:M] [其他:O] [撤销:K] 时间`。
// opts.current 传当前 switch 选中的 branchId 时，该行以 * 标出。改/增/删常驻（哪怕 0），
// 移/其他/撤销有才显示，避免噪声。
export function formatBranchLine(branch = {}, opts = {}) {
  const counts = parseBranchEntryCounts(branch);
  const isCurrent = opts.current != null && String(opts.current) === String(branch.id);
  const parts = [
    `${isCurrent ? '* ' : ''}branch:${branch.id}`,
    `doc:${branch.base_doc_id}`,
    `owner:${branch.owner || ''}`,
    `改:${counts.update}`,
    `增:${counts.insert}`,
    `删:${counts.delete}`
  ];
  if (counts.move) parts.push(`移:${counts.move}`);
  if (counts.other) parts.push(`其他:${counts.other}`);
  if (counts.undone) parts.push(`撤销:${counts.undone}`);
  if (branch.updated_at) parts.push(branch.updated_at);
  return parts.filter(Boolean).join('\t');
}
