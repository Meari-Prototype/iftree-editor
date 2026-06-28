// 三方合并预览（editBranch.threeWayMerge）的人读文本化。与 diff-text 同理抽成纯函数便于单测。
// 预览结果含逐节点 resolution（绝大多数是 unchanged）+ 扁平 conflicts；裸 JSON 把全部节点列出来，
// 文档一大就刷屏不可用。这里折叠 unchanged、只列有裁决/冲突的节点，给计数行与冲突清单。
import { diffOneLine } from './diff-text.js';

const RESOLUTION_LABEL: Record<string, string> = {
  theirs: '取草稿', ours: '取正文', added: '增', deleted: '删',
  modified: '改', conflict: '冲突', unchanged: '未改'
};

interface MergePreviewNode {
  id?: unknown;
  address?: unknown;
  title?: unknown;
  resolution?: string;
}

interface MergePreviewConflict {
  id?: unknown;
  address?: unknown;
  field?: unknown;
  ours?: unknown;
  theirs?: unknown;
}

interface MergePreviewResult {
  fastForward?: boolean;
  hasConflicts?: boolean;
  nodes?: MergePreviewNode[];
  conflicts?: MergePreviewConflict[];
  kind?: string;
  branch?: Record<string, unknown>;
  baseCommitId?: unknown;
  headCommitId?: unknown;
  nodeCounts?: Record<string, unknown>;
}

export function summarizeThreeWayMerge(res: MergePreviewResult | null | undefined = {}, { maxNodes = 200 } = {}) {
  if (!res || typeof res !== 'object' || !Array.isArray(res.nodes)) return res ?? null;
  const limit = Math.max(0, Math.floor(Number(maxNodes) || 200));
  const counts: Record<string, number> = {};
  const changed: MergePreviewNode[] = [];
  for (const node of res.nodes) {
    const resolution = node?.resolution || 'unchanged';
    counts[resolution] = (counts[resolution] || 0) + 1;
    if (resolution !== 'unchanged' && changed.length < limit) {
      const out: Record<string, unknown> = {
        id: node.id,
        address: node.address || '',
        title: node.title || '',
        resolution
      };
      if ((node as Record<string, unknown>).kind) out.kind = (node as Record<string, unknown>).kind;
      if (Array.isArray((node as Record<string, unknown>).conflicts)) out.conflicts = (node as Record<string, unknown>).conflicts;
      changed.push(out as MergePreviewNode);
    }
  }
  const changedTotal = res.nodes.length - (counts.unchanged || 0);
  const branch = res.branch && typeof res.branch === 'object'
    ? {
        id: res.branch.id,
        owner: res.branch.owner,
        status: res.branch.status,
        base_doc_id: res.branch.base_doc_id,
        shadow_doc_id: res.branch.shadow_doc_id
      }
    : undefined;
  return {
    kind: res.kind || 'editBranch.threeWayMerge',
    fastForward: res.fastForward === true,
    hasConflicts: res.hasConflicts === true,
    baseCommitId: res.baseCommitId ?? null,
    headCommitId: res.headCommitId ?? null,
    nodeCounts: res.nodeCounts || null,
    resolutionCounts: counts,
    changedNodeCount: changedTotal,
    returnedChangedNodes: changed.length,
    truncatedChangedNodes: Math.max(0, changedTotal - changed.length),
    conflicts: Array.isArray(res.conflicts) ? res.conflicts : [],
    nodes: changed,
    ...(branch ? { branch } : {}),
    summary: 'merge preview summary: unchanged nodes are omitted; request detail=raw for the full internal node list'
  };
}

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
      lines.push(`  ! ${c.address || c.id}${field} ours=${diffOneLine(c.ours, 30)} | theirs=${diffOneLine(c.theirs, 30)}`);
    }
  } else if (!res.hasConflicts) {
    lines.push('（无冲突，yes=true 可直接落库）');
  }
  return lines.join('\n');
}
