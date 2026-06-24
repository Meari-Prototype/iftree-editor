// @ts-nocheck
// 三方合并预览（editBranch.threeWayMerge）的人读文本化。与 diff-text 同理抽成纯函数便于单测。
// 预览结果含逐节点 resolution（绝大多数是 unchanged）+ 扁平 conflicts；裸 JSON 把全部节点列出来，
// 文档一大就刷屏不可用。这里折叠 unchanged、只列有裁决/冲突的节点，给计数行与冲突清单。
import { diffOneLine } from './diff-text.js';

const RESOLUTION_LABEL = {
  theirs: '取草稿', ours: '取正文', added: '增', deleted: '删',
  modified: '改', conflict: '冲突', unchanged: '未改'
};

/**
 * @param {Record<string, any>} [res] threeWayMerge 预览结果（运行时形状）
 */
export function formatThreeWayMergeText(res = {}) {
  if (!res || typeof res !== 'object' || !Array.isArray(res.nodes)) {
    return JSON.stringify(res ?? null, null, 2);
  }
  const lines = [];
  const ff = res.fastForward ? '快进' : '三方';
  lines.push(`[merge 预览 ${ff}${res.hasConflicts ? '·有冲突' : ''}]`);

  const counts = new Map();
  const changed = [];
  for (const node of res.nodes) {
    const r = node.resolution || 'unchanged';
    counts.set(r, (counts.get(r) || 0) + 1);
    if (r !== 'unchanged') changed.push(node);
  }
  const countParts = [];
  for (const [r, n] of counts) {
    if (r === 'unchanged') continue;
    countParts.push(`${RESOLUTION_LABEL[r] || r}:${n}`);
  }
  const unchanged = counts.get('unchanged') || 0;
  lines.push(`${countParts.join(' ') || '无改动'}（未改 ${unchanged} 折叠）`);

  for (const node of changed) {
    const mark = node.resolution === 'conflict' ? '!' : '·';
    const title = node.title ? ` ${diffOneLine(node.title, 40)}` : '';
    lines.push(`${mark} ${node.address || node.id} ${RESOLUTION_LABEL[node.resolution] || node.resolution}${title}`);
  }

  const conflicts = Array.isArray(res.conflicts) ? res.conflicts : [];
  if (conflicts.length) {
    lines.push(`冲突待裁 ${conflicts.length} 条（给 strategy 或 resolutions 落库）：`);
    for (const c of conflicts) {
      const field = c.field ? ` [${c.field}]` : '';
      lines.push(`  ! ${c.address || c.id}${field} ours=${diffOneLine(c.ours, 30)} | theirs=${diffOneLine(c.theirs, 30)}`);
    }
  } else if (!res.hasConflicts) {
    lines.push('（无冲突，yes=true 可直接落库）');
  }
  return lines.join('\n');
}
