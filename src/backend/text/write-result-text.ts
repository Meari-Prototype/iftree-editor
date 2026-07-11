// MCP 写动词/状态返回的紧凑文本渲染（projectneed 15-5-1-3：ASCII 非裸 JSON，--json 才裸传）。
// 纯渲染、不改逻辑：吃后端原始返回，挑结果要点成几行人类可读文本，省 token。
// 形态按数据走——状态摘要用键值行、节点树用缩进地址、列表用每项一行，不强求 ASCII tree。
// diff/merge 预览另有 diff-text.mjs / merge-text.mjs；此处管「写动作落库结果」与少数列表/行返回。

import { parseBranchEntryCounts } from './branch-status.js';
import { clip, cell, clipRows, clipConflictPair } from './text-budget.js';
import type { WriteResult, PushNode } from './write-result.js';

// 通用写返回：commit/edit/draft·new/undo/redo/discard/rebase/cherry-pick/merge·yes/
// vectors/certify/memory_distill/set_mode/bulk/revert/switch。挑结果要点，丢快照大字符串。
/**
 * @param {unknown} res
 * @param {{ label?: string }} [opts]
 */
export function formatWriteResult(res: WriteResult | null | undefined, { label }: { label?: string } = {}) {
  if (res == null) return '(空)';
  if (typeof res !== 'object') return String(res);
  if (res.ok === false || res.error) {
    const msg = res.error || res.message || '';
    return `${label || res.action || '失败'}  失败${msg ? '：' + clip(msg, 200) : ''}`;
  }
  const lines: string[] = [];
  const head: string[] = [label || res.action || 'result'];
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
    const tags: string[] = [];
    if (n.address) tags.push(n.address);
    if (n.node_type) tags.push(n.node_type);
    if (n.trust_level) tags.push(`trust:${n.trust_level}`);
    if (n.pending_insert) tags.push('pending');
    let line = `  node ${tags.join(' ')}`.replace(/\s+$/, '');
    if (n.text) line += `  「${clip(n.text)}」`;
    lines.push(line);
    const meta: string[] = [];
    if (n.node_title) meta.push(`title:「${clip(n.node_title, 40)}」`);
    if (n.node_note) meta.push(`note:「${clip(n.node_note, 40)}」`);
    if (meta.length) lines.push(`       ${meta.join('  ')}`);
  }
  if (res.insertedNodeId != null) lines.push(`  inserted:${res.insertedNodeId}`);

  const actionFacts: string[] = [];
  if (res.nodeId != null) actionFacts.push(`nodeId=${res.nodeId}`);
  if (res.sourceNodeId != null) actionFacts.push(`sourceNodeId=${res.sourceNodeId}`);
  if (res.targetNodeId != null) actionFacts.push(`targetNodeId=${res.targetNodeId}`);
  if (res.newParentId != null) actionFacts.push(`newParentId=${res.newParentId}`);
  if (res.axiomId != null) actionFacts.push(`axiomId=${res.axiomId}`);
  if (res.refId != null) actionFacts.push(`refId=${res.refId}`);
  if (res.entityId != null) actionFacts.push(`entityId=${res.entityId}`);
  if (Array.isArray(res.entityIds) && res.entityIds.length) actionFacts.push(`entityIds=${res.entityIds.join(',')}`);
  if (res.kind) actionFacts.push(`kind=${res.kind}`);
  if (res.status) actionFacts.push(`status=${res.status}`);
  if (res.direction) actionFacts.push(`direction=${res.direction}`);
  if (actionFacts.length) lines.push(`  ${actionFacts.join('  ')}`);

  // node.split：交代拆分规模——分支行的逐动作计数对 split 恒 +1，不反映实际拆出的节点数。
  if (res.splitNewNodeCount != null) {
    lines.push(res.splitParagraphCount != null
      ? `  按原文段落拆分：${res.splitParagraphCount} 段、共 ${res.splitNewNodeCount} 句下沉为子节点`
      : `  切成 ${res.splitSentenceCount ?? '?'} 句：首句留守原节点，${res.splitNewNodeCount} 句下沉为子节点`);
  }

  // rebase：交代 base 从哪刷到哪——rebase 后原字段冲突会变成纯草稿侧修改（等效整批取草稿侧），
  // 跨越的历史对调用方必须可见，不能只回分支状态行。
  if (res.previousBaseCommitId !== undefined && res.baseCommitId) {
    const prev = res.previousBaseCommitId;
    lines.push(prev && prev !== res.baseCommitId
      ? `  base:${prev} → ${res.baseCommitId}（base 已前移：原与正文的字段冲突将按草稿侧覆盖，落库前先 diff 复核）`
      : `  base:${res.baseCommitId}（未变，已在主干 HEAD）`);
  }

  // cherry-pick：列出摘入的 entry（kind + 目标 + 文本预览），否则只有计数、还得再 diff 才知道摘了什么。
  // entry 是 op-log 形态（edit-branch-projection）：node.update 带 node_id/address/patch{text}/fields[]（delta 数组），
  // insert 带 tmp_id、ref 系带 *_ref——目标取 address 优先（人可读），文本从 patch.text / text / fields[] 依次找。
  if (res.pickedCount != null) {
    const picked = Array.isArray(res.picked) ? res.picked : [];
    lines.push(`  picked:${res.pickedCount} 条`);
    for (const p of picked.slice(0, 5)) {
      const kind = String(p.kind ?? '?');
      const target = p.address || p.node_id || p.tmp_id || p.node_ref || p.source_ref || p.axiom_ref || p.ref_ref || '';
      let previewText: unknown;
      if (p.patch && typeof p.patch === 'object') previewText = (p.patch as Record<string, unknown>).text;
      if (previewText === undefined && typeof p.text === 'string') previewText = p.text;
      if (previewText === undefined && Array.isArray(p.fields)) {
        const fd = (p.fields as Array<Record<string, unknown>>).find((f) => f && f.field === 'text');
        if (fd) previewText = fd.new ?? fd.value;
      }
      const preview = typeof previewText === 'string' && previewText ? `「${clip(previewText, 40)}」` : '';
      lines.push(`    ${kind}${target ? ` ${target}` : ''}${preview ? `  ${preview}` : ''}`);
    }
    if (picked.length > 5) lines.push(`    … 余 ${picked.length - 5} 条`);
  }

  // 新增 axiom/ref/entity 回执带 tmp 句柄（草稿内 tmp-axiom-/tmp-ref-/tmp-entity-N），是同草稿内
  // 续操作要传的 id：entity.create→entityId、axiom.add→axiomId、ref.add*→refId（commit 时解析成真 id）。
  const ent = res.entity;
  if (ent && typeof ent === 'object' && ent.id != null) {
    lines.push(`  entity:${ent.id}${ent.literal ? `  「${clip(ent.literal, 40)}」` : ''}（bindNode 传 entityId=${ent.id}）`);
  }
  const ax = res.axiom;
  if (ax && typeof ax === 'object' && ax.id != null) {
    lines.push(`  axiom:${ax.id}${ax.content ? `  「${clip(String(ax.content), 40)}」` : ''}`);
  }
  const lk = res.link;
  if (lk && typeof lk === 'object') {
    const ids = [lk.entity_a_id, lk.entity_b_id].filter((value) => value != null).join('↔');
    lines.push(`  link:${ids}${lk.kind ? `  [${lk.kind}]` : ''}`);
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
  if (res.restoredPragmas && typeof res.restoredPragmas === 'object') {
    lines.push(`  restored ${Object.entries(res.restoredPragmas).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  if (res.checkpoint) lines.push(`  checkpoint:${res.checkpoint}`);
  // relink：只显示重绑后的新路径，绝不把后端附带的全库 docs 刷新列表 dump 出来（曾撑爆 token）。
  if (res.source && typeof res.source === 'object' && res.source.original_path) {
    lines.push(`  source:${res.source.original_path}`);
  }
  // relink 的目标自检（handler 附带的 relink.targetCheck sideEffect）：只提示、不阻断——
  // relink 本就不替外部程序管文件状态，但绑到不存在的路径必须让调用方看见。
  const targetCheck = Array.isArray(res.sideEffects)
    ? res.sideEffects.find((fx) => fx && typeof fx === 'object' && fx.effect === 'relink.targetCheck')
    : null;
  if (targetCheck) {
    const exists = targetCheck.targetExists === true;
    lines.push(`  targetExists:${exists}${exists ? '' : '（目标文件当前不存在——relink 只改登记不校验，请确认路径无误）'}`);
  }
  if (Array.isArray(res.touchedNodeIds) && res.touchedNodeIds.length) {
    const ids = res.touchedNodeIds.slice(0, 5).join(' ');
    lines.push(`  touched:${res.touchedNodeIds.length}节点 ${ids}${res.touchedNodeIds.length > 5 ? ' …' : ''}`);
  }
  if (Array.isArray(res.touchedDocIds) && res.touchedDocIds.length) {
    const ids = res.touchedDocIds.slice(0, 5).join(' ');
    lines.push(`  touched:${res.touchedDocIds.length}文档 ${ids}${res.touchedDocIds.length > 5 ? ' …' : ''}`);
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
        // 差异感知截断（clipConflictPair）：从头狠截会把「差异在尾部」的两侧截成一模一样，没法凭回执裁决。
        const pair = clipConflictPair(cf.ours, cf.theirs);
        lines.push(`    ${cf.id || cf.address || ''} [${cf.field || ''}] ours=「${pair.ours}」 theirs=「${pair.theirs}」`);
      }
    }
  }
  return lines.join('\n');
}

// push：新建/追加的节点子树，按缩进地址 + 稳定 id 列出。
export function formatPushResult(res: WriteResult | null | undefined) {
  if (!res || res.ok === false || res.error) return formatWriteResult(res, { label: 'push' });
  const lines: string[] = [];
  const head: string[] = ['push'];
  if (res.docId) head.push(`doc:${res.docId}`);
  if (res.createdCount != null) head.push(`+${res.createdCount}节点`);
  if (res.createdRootId) head.push(`root:${res.createdRootId}`);
  lines.push(head.join('  '));
  if (res.parentId) lines.push(`  parent:${res.parentId}`);
  const walk = (nodes: PushNode[] | null | undefined, depth: number) => {
    for (const nd of nodes || []) {
      lines.push(`  ${'  '.repeat(depth)}${nd.address || ''}  ${nd.id || ''}`);
      if (Array.isArray(nd.children) && nd.children.length) walk(nd.children, depth + 1);
    }
  };
  walk(res.created, 0);
  return lines.join('\n');
}

// memory_deliver：卷标识 + 节点计数 + 卷元信息。
export function formatDeliverResult(res: WriteResult | null | undefined) {
  if (!res || res.ok === false || res.error) return formatWriteResult(res, { label: 'memory_deliver' });
  const lines: string[] = [];
  const head: string[] = ['memory_deliver'];
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
export function formatVolumeList(res: WriteResult | null | undefined) {
  const result = res as WriteResult;
  const vols = res && Array.isArray(res.volumes) ? res.volumes : [];
  if (!vols.length) return '(无记忆卷)';
  const total = typeof result.total === 'number' ? result.total : vols.length;
  const head = total > vols.length
    ? `已列出最新 ${vols.length} 卷，共 ${total} 卷，统计库内总量请显式调大 limit 或用 sql COUNT`
    : `共 ${total} 卷`;
  const lines = [`${head}${result.now ? '（now ' + result.now + '）' : ''}：`];
  for (const v of vols) {
    const last = v.lastActivityAt ? `  末活:${v.lastActivityAt}` : '';
    lines.push(`  ${v.docId}  ${v.state || ''}  ${v.agent || ''}/${v.sessionId || ''}  「${clip(v.title, 40)}」  nodes:${v.nodeCount ?? '?'}${last}`);
  }
  return lines.join('\n');
}

// import：导入路径 + 文档标识 + 节点数 + 向量提示（embed 与否两种口径）。
export function formatImportResult(res: WriteResult | null | undefined, { relativePath, embed }: { relativePath?: string; embed?: boolean } = {}) {
  if (!res || res.ok !== true) return `导入失败：${JSON.stringify(res)}`;
  const lines = [
    `已导入 ${res.relativePath || relativePath || ''}`,
    `#${res.docId} ${res.title || ''}`,
    `节点数：${res.nodeCount || 0}`
  ];
  if (embed === true) lines.push(res.vectorWarning ? `向量：同步建立失败（${res.vectorWarning}）` : '向量：已同步建立');
  else lines.push('向量：未建（默认后补；需即时可检索传 embed:true，或用 vectors 动词）');
  return lines.join('\n');
}

// vectors：覆盖率 + 增量账目（新增/重嵌/清孤儿/保留）。
export function formatVectorsResult(res: WriteResult | null | undefined, { docId }: { docId?: string | number } = {}) {
  if (!res || res.ok === false) return formatWriteResult(res, { label: 'vectors' });
  if (res.skipped) return `vectors  doc:${res.docId || docId}  跳过（${res.reason || '向量未启用'}）`;
  const after = Number(res.vectorCountAfter) || 0;
  const before = Number(res.vectorCountBefore) || 0;
  const nodeCount = res.nodeCount ?? null;
  const coverage = nodeCount ? `${after}/${nodeCount}（覆盖 ${Math.round((after / nodeCount) * 100)}%）` : `${after}`;
  return [
    `vectors  doc:${res.docId || docId}  向量 ${coverage}`,
    `  新增 ${res.missingInserted ?? 0} · 重嵌 ${res.changedDeleted ?? 0} · 清理孤儿 ${res.staleDeleted ?? 0} · 既有保留 ${res.existingCurrent ?? 0}（before ${before}→after ${after}）`
  ].join('\n');
}

// delete：删除结果一行（未找到与已删除区分）。
export function formatDeleteResult(res: WriteResult | null | undefined, { docId }: { docId?: string | number } = {}) {
  if (!res || res.ok !== true) return `删除失败：${JSON.stringify(res)}`;
  return `${res.changed ? '已删除' : '未找到'} doc ${res.docId || docId}${res.title ? `「${res.title}」` : ''}`;
}

// gc：对象库 mark-sweep 账目一行。
export function formatGcResult(res: WriteResult | null | undefined) {
  if (!res || res.ok !== true) return `gc 失败：${JSON.stringify(res)}`;
  return `对象库 GC 完成：扫描 ${res.scanned} · 可达 ${res.reachable} · 回收 ${res.deleted}`;
}

// MCP/CLI 写动词 --json 收口：store 的写返回是给 IPC/前端的——node 双挂 snake+camel、editBranch 带
// base_snapshot/diff 全文转义串，对 LLM 是纯噪声且每次重复。这里只留结果要点：动作状态、节点
// 关键字段、分支的改增删移计数（由 branch.diff 现算），丢掉重复键与快照大字符串。
export function slimWriteResult(res: unknown): unknown {
  if (!res || typeof res !== 'object') return res;
  const src = res as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of [
    'ok', 'action', 'changed', 'applied', 'fastForward',
    'docId', 'baseDocId', 'shadowDocId', 'branchId', 'undoDepth', 'redoDepth',
    'insertedNodeId', 'insertedAxiomId', 'insertedRefId',
    'nodeId', 'sourceNodeId', 'targetNodeId', 'newParentId',
    'axiomId', 'refId', 'entityId', 'entityIds', 'kind', 'status', 'direction',
    'restoredPragmas', 'checkpoint', 'touchedDocIds'
  ]) {
    if (k in src) out[k] = src[k];
  }
  // 写动作被拒/受阻时透传诊断：commit/merge 非快进会返回 blocked/message（结构性受阻）或 conflicts（字段冲突），
  // agent 要靠它判因、靠 conflicts 清单生成 resolutions 折叠冲突——slim 只收口成功路径的重复噪声，
  // 失败账目本身就是结果要点，不能丢（nodes 全量快照体积大且 conflicts 已够裁决，仍不带）。
  if (src.applied === false) {
    for (const k of ['blocked', 'message', 'conflicts', 'blockedConflicts', 'resolutionErrors']) {
      if (k in src) out[k] = src[k];
    }
  }
  if (src.node && typeof src.node === 'object') {
    const n = src.node as Record<string, unknown>;
    const node: Record<string, unknown> = { id: n.id, address: n.address, node_type: n.node_type, text: n.text, node_title: n.node_title, node_note: n.node_note, trust_level: n.trust_level };
    if (n.pending_insert) node.pending_insert = true;
    out.node = node;
  }
  for (const k of ['entity', 'axiom', 'ref', 'link']) {
    if (src[k] && typeof src[k] === 'object') out[k] = src[k];
  }
  const branch = (src.editBranch || src.branch) as Record<string, unknown> | undefined;
  if (branch && typeof branch === 'object' && branch.id != null) {
    const c = parseBranchEntryCounts(branch);
    out.branch = { id: branch.id, owner: branch.owner, status: branch.status, counts: { 改: c.update, 增: c.insert, 删: c.delete, 移: c.move, 其他: c.other, 撤销: c.undone } };
  }
  if (src.history && typeof src.history === 'object') {
    const h = src.history as Record<string, unknown>;
    out.history = { commit_id: h.commit_id || h.id, doc_id: h.doc_id, summary: h.summary, saved_at: h.saved_at };
  }
  return out;
}

// sql：行数 + 每行 key=val（列不固定，按行渲染；长单元格截断）。
export function formatSqlResult(res: WriteResult) {
  const result = res as WriteResult;
  const allRows = res && Array.isArray(res.rows) ? res.rows : [];
  const { rows, total, truncated } = clipRows(allRows);
  const head = `${result.rowCount ?? total} 行${result.truncated ? '（后端已截）' : ''}${truncated ? `（仅渲染前 ${rows.length}，要全部传 json=true）` : ''}`;
  if (!rows.length) return head;
  const lines = [`${head}：`];
  for (const row of rows) {
    lines.push('  ' + Object.entries(row as Record<string, unknown>).map(([k, v]) => `${k}=${cell(v)}`).join('  '));
  }
  return lines.join('\n');
}
