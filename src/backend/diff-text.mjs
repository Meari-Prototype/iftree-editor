// diff 结果的人读文本化。被 MCP shell（scripts/mcp-server.mjs）用于把
// history.diff / editBranch.diffView 的结构化结果转成提交/分支头 + 每条改动一段。
// 抽成独立纯函数模块的原因：渲染逻辑此前内嵌在 server 脚本里无法单测，
// 跨 commit 的 field-diff 形态曾整组渲染成「? ?」而长期无测试覆盖。
//
// 兼容两种 entry 形态：
//   op-log 形态（含 kind/address/fields）——单 commit diff 与编辑分支视图；
//   snapshot field-diff 形态（含 node_id/field/old/new，无 kind）——跨 commit
//   实时由 computeSnapshotDiff 算出（src/backend/db/snapshot-history.mjs）。

/** 取 id 前 8 位作短引用；空值给 ?。 */
export function diffShortRef(id) {
  const value = String(id || '');
  return value ? value.slice(0, 8) : '?';
}

/** 把多行/超长文本压成单行预览（折叠空白、超 max 截断加省略号）。 */
export function diffOneLine(value, max = 200) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// field-diff entry 的展示主语：节点优先地址（后端从快照补入），公理/引用用各自标签，
// 都缺时退回短 id。computeSnapshotDiff 现在比 nodes/axioms/refs 三类，主语据此区分。
function fieldDiffSubject(entry) {
  if (entry.address) return entry.address;
  if (entry.node_id != null) return diffShortRef(entry.node_id);
  if (entry.axiom_id != null) return `公理:${entry.label || diffShortRef(entry.axiom_id)}`;
  if (entry.ref_id != null) return `引用:${entry.ref_label || diffShortRef(entry.ref_id)}`;
  return diffShortRef(entry.node_id ?? entry.axiom_id ?? entry.ref_id);
}

// diff 文本化：提交/分支头 + 每条改动一段（~ 改 / + 增 / - 删 / → 移）。
// entries 为空时明说「无节点级改动」，避免「实体/引用变更」的提交看起来像空提交。
// 非 entries 形态（分支视图的其它变体/未知结构）兜底给原始 JSON，不强行套格式。
/** @param {Record<string, any>} [res] 运行时形状的 diff 结果（来自查询，非静态类型） */
export function formatDiffText(res = {}) {
  if (!res || typeof res !== 'object' || !Array.isArray(res.entries)) {
    return JSON.stringify(res ?? null, null, 2);
  }
  const lines = [];
  const { from, to } = res;
  if (from || to) {
    const fromDesc = from ? `${diffShortRef(from.id)} ${from.summary || ''}`.trim() : '(父提交)';
    const toDesc = to ? `${diffShortRef(to.id)} ${to.summary || ''}`.trim() : '(当前)';
    lines.push(`[diff ${fromDesc} → ${toDesc}]`);
  }
  if (res.entries.length === 0) {
    lines.push('— 无节点级改动（实体/引用/公理等非节点变更不在此 diff 视图）');
    return lines.join('\n');
  }
  for (const entry of res.entries) {
    // snapshot field-diff 形态（跨 commit 实时算）：无 kind，靠 node_id/field/old/new。
    // address 由后端从快照补入；缺失时退回短 node_id，绝不渲染成「?」。
    if (!entry.kind && typeof entry.field === 'string') {
      const fdAddr = fieldDiffSubject(entry);
      const undoneFd = entry.status === 'undone' ? ' (已撤销)' : '';
      if (entry.field === '*' && entry.old == null) {
        lines.push(`+ ${fdAddr} 增${undoneFd} ${diffOneLine(entry.new)}`.trimEnd());
      } else if (entry.field === '*' && entry.new == null) {
        lines.push(`- ${fdAddr} 删${undoneFd}`);
      } else {
        lines.push(`~ ${fdAddr} 改${undoneFd}`);
        lines.push(`    [${entry.field}]`);
        lines.push(`    - ${diffOneLine(entry.old)}`);
        lines.push(`    + ${diffOneLine(entry.new)}`);
      }
      continue;
    }
    const addr = entry.address || entry.target_ref || entry.parent_ref || entry.tmp_id || '?';
    const undone = entry.status === 'undone' ? ' (已撤销)' : '';
    if (entry.kind === 'node.update') {
      lines.push(`~ ${addr} 改${undone}`);
      for (const field of Array.isArray(entry.fields) ? entry.fields : []) {
        lines.push(`    [${field.field}]`);
        lines.push(`    - ${diffOneLine(field.old)}`);
        lines.push(`    + ${diffOneLine(field.new)}`);
      }
    } else if (entry.kind === 'node.delete') {
      lines.push(`- ${addr} 删${undone}`);
    } else if (entry.kind === 'node.insert') {
      lines.push(`+ ${addr === '?' ? '(新节点)' : addr} 增${undone} ${diffOneLine(entry.fields?.text)}`.trimEnd());
    } else if (entry.kind === 'node.move' || entry.kind === 'node.moveAfter' || entry.kind === 'node.reparent') {
      lines.push(`→ ${addr} ${entry.kind}${undone}`);
    } else {
      lines.push(`· ${addr} ${entry.kind || '?'}${undone}`);
    }
  }
  if (res.snapshotAvailable === false) {
    lines.push('', '（无快照基线，diff 可能不完整）');
  }
  return lines.join('\n');
}
