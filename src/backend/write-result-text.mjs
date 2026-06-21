// MCP 写动词/状态返回的紧凑文本渲染（projectneed 15-5-1-3：ASCII 非裸 JSON，--json 才裸传）。
// 纯渲染、不改逻辑：吃后端原始返回，挑结果要点成几行人类可读文本，省 token。
// 形态按数据走——状态摘要用键值行、节点树用缩进地址、列表用每项一行，不强求 ASCII tree。
// diff/merge 预览另有 diff-text.mjs / merge-text.mjs；此处管「写动作落库结果」与少数列表/行返回。

import { parseBranchEntryCounts } from './branch-status.mjs';
import { clip, cell, clipRows } from './text-budget.mjs';

// 通用写返回：commit/edit/draft·new/undo/redo/discard/rebase/cherry-pick/merge·yes/
// vectors/certify/memory_distill/set_mode/bulk/revert/switch。挑结果要点，丢快照大字符串。
/**
 * @param {any} res
 * @param {{ label?: string }} [opts]
 */
export function formatWriteResult(res, { label } = {}) {
  if (res == null) return '(空)';
  if (typeof res !== 'object') return String(res);
  if (res.ok === false || res.error) {
    const msg = res.error || res.message || '';
    return `${label || res.action || '失败'}  失败${msg ? '：' + clip(msg, 200) : ''}`;
  }
  const lines = [];
  const head = [label || res.action || 'result'];
  if (res.changed === false) head.push('未改动');
  if (res.applied === true) head.push('applied');
  if (res.applied === false) head.push('未落库');
  if (res.fastForward === true) head.push('快进');
  if (res.fastForward === false) head.push('非快进');
  if (res.blocked === true) head.push('blocked');
  if (res.editMode) head.push(`mode=${res.editMode}`);
  else if (res.doc && res.doc.edit_mode) head.push(`mode=${res.doc.edit_mode}`);
  if (res.docId) head.push(`doc:${res.docId}`);
  if (res.branchId != null) head.push(`branch:${res.branchId}`);
  if (res.baseDocId && res.baseDocId !== res.docId) head.push(`base:${res.baseDocId}`);
  if (res.owner) head.push(`owner:${res.owner}`);
  if (res.commitId) head.push(`commit:${res.commitId}`);
  if (res.revertCommitId) head.push(`revert→:${res.revertCommitId}`);
  lines.push(head.join('  '));

  const n = res.node;
  if (n && typeof n === 'object') {
    const tags = [];
    if (n.address) tags.push(n.address);
    if (n.node_type) tags.push(n.node_type);
    if (n.trust_level) tags.push(`trust:${n.trust_level}`);
    if (n.pending_insert) tags.push('pending');
    let line = `  node ${tags.join(' ')}`.replace(/\s+$/, '');
    if (n.text) line += `  「${clip(n.text)}」`;
    lines.push(line);
    const meta = [];
    if (n.node_title) meta.push(`title:「${clip(n.node_title, 40)}」`);
    if (n.node_note) meta.push(`note:「${clip(n.node_note, 40)}」`);
    if (meta.length) lines.push(`       ${meta.join('  ')}`);
  }
  if (res.insertedNodeId != null) lines.push(`  inserted:${res.insertedNodeId}`);

  // 新增 axiom/ref/entity 回执带 tmp 句柄（草稿内 tmp-axiom-/tmp-ref-/tmp-entity-N），是同草稿内
  // 续操作要传的 id：entity.create→entityId、axiom.add→axiomId、ref.add*→refId（commit 时解析成真 id）。
  const ent = res.entity;
  if (ent && typeof ent === 'object' && ent.id != null) {
    lines.push(`  entity:${ent.id}${ent.literal ? `  「${clip(ent.literal, 40)}」` : ''}（bindNode 传 entityId=${ent.id}）`);
  }
  const rf = res.ref;
  if (rf && typeof rf === 'object' && rf.id != null) {
    const rk = rf.ref_kind || rf.kind;
    lines.push(`  ref:${rf.id}${rk ? `  [${rk}]` : ''}（ref.delete 传 refId=${rf.id}）`);
  }
  if (res.insertedAxiomId != null) lines.push(`  axiom:${res.insertedAxiomId}（后续 axiom.update/delete/move 传 axiomId=${res.insertedAxiomId}）`);
  if (res.insertedRefId != null) lines.push(`  ref:${res.insertedRefId}（ref.delete 传 refId=${res.insertedRefId}）`);

  const branch = res.editBranch || res.branch;
  if (branch && typeof branch === 'object' && branch.id != null) {
    let counts;
    if (branch.counts && typeof branch.counts === 'object') {
      const c = branch.counts;
      const other = c.其他 ?? c.other ?? 0;
      counts = `改${c.改 ?? c.update ?? 0} 增${c.增 ?? c.insert ?? 0} 删${c.删 ?? c.delete ?? 0} 移${c.移 ?? c.move ?? 0}${other ? ` 其他${other}` : ''} 撤${c.撤销 ?? c.undone ?? 0}`;
    } else {
      const c = parseBranchEntryCounts(branch);
      counts = `改${c.update} 增${c.insert} 删${c.delete} 移${c.move}${c.other ? ` 其他${c.other}` : ''} 撤${c.undone}`;
    }
    lines.push(`  branch:${branch.id} ${branch.owner || ''}/${branch.status || ''}  ${counts}`);
  }
  if (res.undoDepth != null || res.redoDepth != null) {
    lines.push(`  undo:${res.undoDepth ?? 0} redo:${res.redoDepth ?? 0}`);
  }

  const h = res.history;
  if (h && typeof h === 'object' && (h.commit_id || h.id)) {
    lines.push(`  commit:${h.commit_id || h.id}  「${clip(h.summary, 60)}」${h.saved_at ? '  @' + h.saved_at : ''}`);
  }
  if (res.pragmas && typeof res.pragmas === 'object') {
    lines.push(`  ${Object.entries(res.pragmas).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  // relink：只显示重绑后的新路径，绝不把后端附带的全库 docs 刷新列表 dump 出来（曾撑爆 token）。
  if (res.source && typeof res.source === 'object' && res.source.original_path) {
    lines.push(`  source:${res.source.original_path}`);
  }
  if (Array.isArray(res.touchedNodeIds) && res.touchedNodeIds.length) {
    const ids = res.touchedNodeIds.slice(0, 5).join(' ');
    lines.push(`  touched:${res.touchedNodeIds.length}节点 ${ids}${res.touchedNodeIds.length > 5 ? ' …' : ''}`);
  }
  const hist = res.doc && Array.isArray(res.doc.history) ? res.doc.history : null;
  if (hist && hist.length) {
    lines.push(`  历史 ${hist.length} 条：`);
    for (const c of hist.slice(0, 4)) {
      lines.push(`    ${c.commit_id || c.id}  「${clip(c.summary, 40)}」${c.author ? '  @' + c.author : ''}`);
    }
    if (hist.length > 4) lines.push(`    … 余 ${hist.length - 4} 条`);
  }

  if (res.applied === false || res.blocked) {
    if (res.message) lines.push(`  受阻：${clip(res.message, 200)}`);
    const conflicts = Array.isArray(res.conflicts) ? res.conflicts : [];
    if (conflicts.length) {
      lines.push(`  冲突 ${conflicts.length} 条：`);
      for (const cf of conflicts.slice(0, 10)) {
        lines.push(`    ${cf.id || cf.address || ''} [${cf.field || ''}] ours=「${clip(cf.ours, 30)}」 theirs=「${clip(cf.theirs, 30)}」`);
      }
    }
  }
  return lines.join('\n');
}

// push：新建/追加的节点子树，按缩进地址 + 稳定 id 列出。
export function formatPushResult(res) {
  if (!res || res.ok === false || res.error) return formatWriteResult(res, { label: 'push' });
  const lines = [];
  const head = ['push'];
  if (res.docId) head.push(`doc:${res.docId}`);
  if (res.createdCount != null) head.push(`+${res.createdCount}节点`);
  if (res.createdRootId) head.push(`root:${res.createdRootId}`);
  lines.push(head.join('  '));
  if (res.parentId) lines.push(`  parent:${res.parentId}`);
  const walk = (nodes, depth) => {
    for (const nd of nodes || []) {
      lines.push(`  ${'  '.repeat(depth)}${nd.address || ''}  ${nd.id || ''}`);
      if (Array.isArray(nd.children) && nd.children.length) walk(nd.children, depth + 1);
    }
  };
  walk(res.created, 0);
  return lines.join('\n');
}

// memory_deliver：卷标识 + 节点计数 + 卷元信息。
export function formatDeliverResult(res) {
  if (!res || res.ok === false || res.error) return formatWriteResult(res, { label: 'memory_deliver' });
  const lines = [];
  const head = ['memory_deliver'];
  if (res.docId) head.push(`卷:${res.docId}`);
  if (res.createdCount != null) head.push(`+${res.createdCount}节点`);
  lines.push(head.join('  '));
  if (res.title) lines.push(`  「${clip(res.title, 60)}」`);
  const v = res.volume;
  if (v && typeof v === 'object') {
    const span = v.startedAt ? `  ${v.startedAt}→${v.endedAt || ''}` : '';
    lines.push(`  agent=${v.agent || ''} session=${v.sessionId || ''}${span}`);
  }
  return lines.join('\n');
}

// memory_volumes：每卷一行（状态/身份/标题/节点数/末次活动）。
export function formatVolumeList(res) {
  const vols = res && Array.isArray(res.volumes) ? res.volumes : [];
  if (!vols.length) return '(无记忆卷)';
  const total = Number.isFinite(res?.total) ? res.total : vols.length;
  const head = total > vols.length
    ? `已列出最新 ${vols.length} 卷，共 ${total} 卷，统计库内总量请显式调大 limit 或用 sql COUNT`
    : `共 ${total} 卷`;
  const lines = [`${head}${res.now ? '（now ' + res.now + '）' : ''}：`];
  for (const v of vols) {
    const last = v.lastActivityAt ? `  末活:${v.lastActivityAt}` : '';
    lines.push(`  ${v.docId}  ${v.state || ''}  ${v.agent || ''}/${v.sessionId || ''}  「${clip(v.title, 40)}」  nodes:${v.nodeCount ?? '?'}${last}`);
  }
  return lines.join('\n');
}

// sql：行数 + 每行 key=val（列不固定，按行渲染；长单元格截断）。
export function formatSqlResult(res) {
  const allRows = res && Array.isArray(res.rows) ? res.rows : [];
  const { rows, total, truncated } = clipRows(allRows);
  const head = `${res.rowCount ?? total} 行${res.truncated ? '（后端已截）' : ''}${truncated ? `（仅渲染前 ${rows.length}，要全部传 json=true）` : ''}`;
  if (!rows.length) return head;
  const lines = [`${head}：`];
  for (const row of rows) {
    lines.push('  ' + Object.entries(row).map(([k, v]) => `${k}=${cell(v)}`).join('  '));
  }
  return lines.join('\n');
}
