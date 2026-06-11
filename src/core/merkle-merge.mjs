// 三方合并分类（projectneed A5-10）。按稳定节点 id 配对，逐字段三方调和（merge-base / ours=主干 / theirs=本分支）。
// 规则：
//   - 只一侧改某字段 → 自动取该侧；异侧改不同字段（如一侧移动 parent + 另一侧改 text）→ 自动合。
//   - 冲突仅当：同一节点同一字段两侧改成不同值；或一侧删除而另一侧修改；
//     或 theirs 把节点挂在 ours 已删除的父节点下（__parent__ 结构冲突，delete-modify 的结构变体）。
//   - 移动/重挂因 id 不变不算冲突——除非两侧把同一节点移到不同 parent（parent_id 字段冲突）。
// 纯函数，不碰 DB、不依赖地址。subtree_hash 剪枝（只下钻两侧都偏离 base 的子树）是后续优化，
// 当前按 id 全量逐字段比，结论与剪枝版一致。

const MERGE_FIELDS = ['text', 'node_title', 'node_note', 'node_type', 'trust_level', 'parent_id'];
const CAMEL = {
  node_title: 'nodeTitle',
  node_note: 'nodeNote',
  node_type: 'nodeType',
  trust_level: 'trustLevel',
  parent_id: 'parentId'
};
const fieldVal = (node, field) => {
  const value = node[field] ?? node[CAMEL[field]];
  return value === null || value === undefined ? null : String(value);
};
const changedVsBase = (node, base) => MERGE_FIELDS.some((field) => fieldVal(node, field) !== fieldVal(base, field));

// 经典三方字段调和：返回取定值或标冲突。
function threeWayField(base, ours, theirs) {
  if (ours === theirs) return { value: ours, conflict: false }; // 都没动 / 两侧改成同值（收敛）
  if (ours === base) return { value: theirs, conflict: false }; // ours 未动该字段 → 取 theirs
  if (theirs === base) return { value: ours, conflict: false }; // theirs 未动 → 取 ours
  return { conflict: true, base, ours, theirs }; // 两侧改成不同值 → 冲突
}

export function classifyThreeWayMerge(baseNodes = [], oursNodes = [], theirsNodes = []) {
  const baseById = new Map(baseNodes.map((node) => [String(node.id), node]));
  const oursById = new Map(oursNodes.map((node) => [String(node.id), node]));
  const theirsById = new Map(theirsNodes.map((node) => [String(node.id), node]));
  const allIds = new Set([...baseById.keys(), ...oursById.keys(), ...theirsById.keys()]);

  const nodes = [];
  const conflicts = [];
  const pushConflict = (id, list) => {
    for (const c of list) conflicts.push({ id, ...c });
  };

  for (const id of allIds) {
    const base = baseById.get(id) || null;
    const ours = oursById.get(id) || null;
    const theirs = theirsById.get(id) || null;

    // base 没有 → 新增侧
    if (!base) {
      if (ours && !theirs) { nodes.push({ id, resolution: 'added-ours' }); continue; }
      if (theirs && !ours) { nodes.push({ id, resolution: 'added-theirs' }); continue; }
      if (ours && theirs) {
        const diff = MERGE_FIELDS
          .map((field) => ({ field, base: null, ours: fieldVal(ours, field), theirs: fieldVal(theirs, field) }))
          .filter((c) => c.ours !== c.theirs);
        if (diff.length === 0) nodes.push({ id, resolution: 'added-converged' });
        else { pushConflict(id, diff); nodes.push({ id, resolution: 'conflict', conflicts: diff }); }
      }
      continue;
    }

    // base 有，一侧删除
    if (!ours || !theirs) {
      if (!ours && !theirs) { nodes.push({ id, resolution: 'deleted' }); continue; }
      const survivor = ours || theirs;
      const survivorSide = ours ? 'ours' : 'theirs';
      if (!changedVsBase(survivor, base)) {
        nodes.push({ id, resolution: 'deleted' }); // 另一侧删、本侧没改 → 接受删除
      } else {
        const c = {
          field: '__node__',
          base: 'present',
          ours: ours ? 'modified' : 'deleted',
          theirs: theirs ? 'modified' : 'deleted'
        };
        conflicts.push({ id, ...c });
        nodes.push({ id, resolution: 'conflict', kind: 'delete-modify', survivorSide, conflicts: [c] });
      }
      continue;
    }

    // 三方都在 → 看各侧是否偏离 base
    const oursChanged = changedVsBase(ours, base);
    const theirsChanged = changedVsBase(theirs, base);
    if (!oursChanged && !theirsChanged) { nodes.push({ id, resolution: 'unchanged' }); continue; }
    if (!oursChanged) { nodes.push({ id, resolution: 'theirs' }); continue; }
    if (!theirsChanged) { nodes.push({ id, resolution: 'ours' }); continue; }

    // 两侧都改 → 逐字段三方
    const merged = {};
    const nodeConflicts = [];
    for (const field of MERGE_FIELDS) {
      const r = threeWayField(fieldVal(base, field), fieldVal(ours, field), fieldVal(theirs, field));
      if (r.conflict) nodeConflicts.push({ field, base: r.base, ours: r.ours, theirs: r.theirs });
      else merged[field] = r.value;
    }
    if (nodeConflicts.length === 0) {
      nodes.push({ id, resolution: 'merged', merged });
    } else {
      pushConflict(id, nodeConflicts);
      nodes.push({ id, resolution: 'conflict', merged, conflicts: nodeConflicts });
    }
  }

  // 结构性删改后置检查：theirs 把节点挂在某父节点下（新增 / 移入），而该父在 ours 已不存在
  // （主干删除被上面按「接受删除」自动取）→ 合并结果里父缺失，写回重放必撞缺父。
  // 这是 delete-modify 的结构变体，按节点报 __parent__ 冲突交人裁（复活父节点 v1 不支持）。
  // 只报孤儿链的顶端：父若是 theirs 自己新建的节点，重放会一并创建，孤儿问题在更上层节点暴露。
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const [id, theirsNode] of theirsById) {
    const parentRef = fieldVal(theirsNode, 'parent_id');
    if (parentRef === null) continue;
    if (oursById.has(parentRef)) continue; // 父在主干存活
    if (!baseById.has(parentRef) && theirsById.has(parentRef)) continue; // 父由本分支新建
    const base = baseById.get(id) || null;
    const ours = oursById.get(id) || null;
    // 只在「合并结果会采用 theirs 的父」时报：theirs 新增的节点，或仅 theirs 移动了该节点。
    // base 有、ours 删 → 主循环已按 delete-modify 处理；两侧都移 → 主循环已报 parent_id 冲突。
    let usesTheirsParent = false;
    if (!base && !ours) usesTheirsParent = true;
    else if (base && ours) {
      const baseParent = fieldVal(base, 'parent_id');
      usesTheirsParent = parentRef !== baseParent && fieldVal(ours, 'parent_id') === baseParent;
    }
    if (!usesTheirsParent) continue;
    const conflict = {
      field: '__parent__',
      base: base ? fieldVal(base, 'parent_id') : null,
      ours: 'deleted',
      theirs: parentRef
    };
    conflicts.push({ id, ...conflict });
    const node = nodeById.get(id);
    if (node) {
      node.resolution = 'conflict';
      if (!node.kind) node.kind = 'parent-deleted';
      node.conflicts = [...(node.conflicts || []), conflict];
    } else {
      nodes.push({ id, resolution: 'conflict', kind: 'parent-deleted', conflicts: [conflict] });
    }
  }

  return { nodes, conflicts, hasConflicts: conflicts.length > 0 };
}
