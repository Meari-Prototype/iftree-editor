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
// 详略轴（15-5-2）：detail='full'（默认，逐行 old→new）/ 'summary'（节点列表 + 改增删移计数、不出正文）。
// 计数两态都算；summary 在表头后加一行计数、略去 [字段]/-old/+new 三行 body。
/**
 * @param {Record<string, any>} [res] 运行时形状的 diff 结果（来自查询，非静态类型）
 * @param {{ detail?: 'full' | 'summary' }} [opts]
 */
export function formatDiffText(res = {}, { detail = 'full' } = {}) {
  if (!res || typeof res !== 'object' || !Array.isArray(res.entries)) {
    return JSON.stringify(res ?? null, null, 2);
  }
  const summary = detail === 'summary';
  const lines = [];
  const counts = { mod: 0, add: 0, del: 0, move: 0, other: 0 };
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
  const body = [];
  for (const entry of res.entries) {
    // snapshot field-diff 形态（跨 commit 实时算）：无 kind，靠 node_id/field/old/new。
    // address 由后端从快照补入；缺失时退回短 node_id，绝不渲染成「?」。
    if (!entry.kind && typeof entry.field === 'string') {
      const fdAddr = fieldDiffSubject(entry);
      const undoneFd = entry.status === 'undone' ? ' (已撤销)' : '';
      if (entry.field === '__moved__') {
        // 位置变化（换父 reparent / 同父调序 move）：快照对比由 computeSnapshotDiff 产出，
        // old/new 带旧址→新址。归「移」而非「改」，否则 sort_order/parent 变化被静默算成改/漏掉。
        counts.move++;
        const moveTrail = entry.old != null && entry.new != null && String(entry.old) !== String(entry.new)
          ? ` ${diffOneLine(entry.old)}→${diffOneLine(entry.new)}` : '';
        body.push(`→ ${fdAddr} 移${undoneFd}${moveTrail}`.trimEnd());
      } else if (entry.field === '*' && entry.old == null) {
        counts.add++;
        body.push(`+ ${fdAddr} 增${undoneFd} ${diffOneLine(entry.new)}`.trimEnd());
      } else if (entry.field === '*' && entry.new == null) {
        counts.del++;
        body.push(`- ${fdAddr} 删${undoneFd}`);
      } else {
        counts.mod++;
        body.push(`~ ${fdAddr} 改${undoneFd}`);
        if (!summary) {
          body.push(`    [${entry.field}]`);
          body.push(`    - ${diffOneLine(entry.old)}`);
          body.push(`    + ${diffOneLine(entry.new)}`);
        }
      }
      continue;
    }
    const addr = entry.address || entry.target_ref || entry.parent_ref || entry.tmp_id || '?';
    const undone = entry.status === 'undone' ? ' (已撤销)' : '';
    if (entry.kind === 'node.update') {
      counts.mod++;
      body.push(`~ ${addr} 改${undone}`);
      if (!summary) {
        for (const field of Array.isArray(entry.fields) ? entry.fields : []) {
          body.push(`    [${field.field}]`);
          body.push(`    - ${diffOneLine(field.old)}`);
          body.push(`    + ${diffOneLine(field.new)}`);
        }
      }
    } else if (entry.kind === 'node.delete') {
      counts.del++;
      body.push(`- ${addr} 删${undone}`);
    } else if (entry.kind === 'node.insert') {
      counts.add++;
      body.push(`+ ${addr === '?' ? '(新节点)' : addr} 增${undone} ${diffOneLine(entry.fields?.text)}`.trimEnd());
    } else if (entry.kind === 'node.move' || entry.kind === 'node.moveAfter' || entry.kind === 'node.reparent') {
      counts.move++;
      body.push(`→ ${addr} ${entry.kind}${undone}`);
    } else {
      // 未知 kind 兜底：仍占一行 body，故必须计数，否则 summary 表头总数 < body 行数。
      counts.other++;
      body.push(`· ${addr} ${entry.kind || '?'}${undone}`);
    }
  }
  if (summary) {
    // 其它(other)仅在出现未知 kind 时附加，常态 diff 不显示，避免给惯常输出加噪声。
    const summaryLine = `改:${counts.mod} 增:${counts.add} 删:${counts.del} 移:${counts.move}`;
    lines.push(counts.other > 0 ? `${summaryLine} 其他:${counts.other}` : summaryLine);
  }
  lines.push(...body);
  if (res.snapshotAvailable === false) {
    lines.push('', '（无快照基线，diff 可能不完整）');
  }
  return lines.join('\n');
}
