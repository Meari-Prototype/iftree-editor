// 三方合并预览（editBranch.threeWayMerge）的人读文本化。与 diff-text 同理抽成纯函数便于单测。
// 只做文本渲染（L5）：结构化折叠 summarizeThreeWayMerge 在 diff-view（L3），此处消费其类型。
import { diffOneLine } from './diff-text.js';
import { clipConflictPair } from './text-budget.js';
import type { MergePreviewNode, MergePreviewResult } from '../diff/diff-view.js';

const RESOLUTION_LABEL: Record<string, string> = {
  theirs: '取草稿', ours: '取正文', added: '增', deleted: '删',
  modified: '改', conflict: '冲突', unchanged: '未改'
};

export function formatThreeWayMergeText(res: MergePreviewResult | null | undefined = {}): string {
  if (!res || typeof res !== 'object' || !Array.isArray(res.nodes)) {
    return JSON.stringify(res ?? null, null, 2);
  }
  const lines: string[] = [];
  const ff = res.fastForward ? '快进' : '三方';
  lines.push(`[merge 预览 ${ff}${res.hasConflicts ? '·有冲突' : ''}]`);

  const counts = new Map<string, number>();
  const changed: MergePreviewNode[] = [];
  for (const node of res.nodes) {
    const r = node.resolution || 'unchanged';
    counts.set(r, (counts.get(r) || 0) + 1);
    if (r !== 'unchanged') changed.push(node);
  }
  const countParts: string[] = [];
  for (const [r, n] of counts) {
    if (r === 'unchanged') continue;
    countParts.push(`${RESOLUTION_LABEL[r] || r}:${n}`);
  }
  const unchanged = counts.get('unchanged') || 0;
  lines.push(`${countParts.join(' ') || '无改动'}（未改 ${unchanged} 折叠）`);

  for (const node of changed) {
    const mark = node.resolution === 'conflict' ? '!' : '·';
    const title = node.title ? ` ${diffOneLine(node.title, 40)}` : '';
    const resolution = node.resolution || 'unchanged';
    lines.push(`${mark} ${node.address || node.id} ${RESOLUTION_LABEL[resolution] || resolution}${title}`);
  }

  const conflicts = Array.isArray(res.conflicts) ? res.conflicts : [];
  if (conflicts.length) {
    lines.push(`冲突待裁 ${conflicts.length} 条（给 strategy 或 resolutions 落库）：`);
    for (const c of conflicts) {
      const field = c.field ? ` [${c.field}]` : '';
      // 差异感知截断（clipConflictPair）：从头狠截会把「差异在尾部」的两侧截成一模一样，没法凭回执裁决。
      const pair = clipConflictPair(c.ours, c.theirs);
      lines.push(`  ! ${c.address || c.id}${field} ours=${pair.ours} | theirs=${pair.theirs}`);
    }
  } else if (!res.hasConflicts) {
    lines.push('（无冲突，yes=true 可直接落库）');
  }
  return lines.join('\n');
}
