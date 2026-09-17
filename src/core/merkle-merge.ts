import type { MerkleNode } from './merkle.js';

// 三方合并分类（projectneed A5-10）。按稳定节点 id 配对，逐字段三方调和（merge-base / ours=主干 / theirs=本分支）。
// 规则：
//   - 只一侧改某字段 → 自动取该侧；异侧改不同字段（如一侧移动 parent + 另一侧改 text）→ 自动合。
//   - 冲突仅当：同一节点同一字段两侧改成不同值；或一侧删除而另一侧修改；
//     或 theirs 把节点挂在 ours 已删除的父节点下（__parent__ 结构冲突，delete-modify 的结构变体）。
//   - 移动/重挂因 id 不变不算冲突——除非两侧把同一节点移到不同 parent（parent_id 字段冲突）。
// 纯函数，不碰 DB、不依赖地址。subtree_hash 剪枝（只下钻两侧都偏离 base 的子树）是后续优化，
// 当前按 id 全量逐字段比，结论与剪枝版一致。

const MERGE_FIELDS = ['text', 'node_title', 'node_note', 'node_type', 'trust_level', 'parent_id'];
const CAMEL: Record<string, string> = {
  node_title: 'nodeTitle',
  node_note: 'nodeNote',
  node_type: 'nodeType',
  trust_level: 'trustLevel',
  parent_id: 'parentId'
};
const fieldVal = (node: MerkleNode, field: string): string | null => {
  const value = node[field] ?? node[CAMEL[field]];
  return value === null || value === undefined ? null : String(value);
};
const changedVsBase = (node: MerkleNode, base: MerkleNode): boolean =>
  MERGE_FIELDS.some((field) => fieldVal(node, field) !== fieldVal(base, field));

type FieldValue = string | null;

interface FieldConflict {
  field: string;
  base: FieldValue | 'present';
  ours: FieldValue | 'modified' | 'deleted';
  theirs: FieldValue | 'modified' | 'deleted';
}

interface MergeConflict extends FieldConflict {
  id: string;
}

interface MergeNode {
  id: string;
  resolution: string;
  merged?: Record<string, FieldValue>;
  conflicts?: FieldConflict[];
  kind?: string;
  survivorSide?: 'ours' | 'theirs';
}

type FieldMergeResult =
  | { conflict: false; value: FieldValue }
  | { conflict: true; base: FieldValue; ours: FieldValue; theirs: FieldValue };

// 经典三方字段调和：返回取定值或标冲突。
function threeWayField(base: FieldValue, ours: FieldValue, theirs: FieldValue): FieldMergeResult {
  if (ours === theirs) return { value: ours, conflict: false }; // 都没动 / 两侧改成同值（收敛）
  if (ours === base) return { value: theirs, conflict: false }; // ours 未动该字段 → 取 theirs
  if (theirs === base) return { value: ours, conflict: false }; // theirs 未动 → 取 ours
  return { conflict: true, base, ours, theirs }; // 两侧改成不同值 → 冲突
}

export function classifyThreeWayMerge(baseNodes: MerkleNode[] = [], oursNodes: MerkleNode[] = [], theirsNodes: MerkleNode[] = []) {
  const baseById = new Map(baseNodes.map((node) => [String(node.id), node]));
  const oursById = new Map(oursNodes.map((node) => [String(node.id), node]));
  const theirsById = new Map(theirsNodes.map((node) => [String(node.id), node]));
  const allIds = new Set<string>([...baseById.keys(), ...oursById.keys(), ...theirsById.keys()]);

  const nodes: MergeNode[] = [];
  const conflicts: MergeConflict[] = [];
  const pushConflict = (id: string, list: FieldConflict[]) => {
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
        const diff: FieldConflict[] = MERGE_FIELDS
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
      const survivor = ours || theirs!;
      const survivorSide: 'ours' | 'theirs' = ours ? 'ours' : 'theirs';
      if (!changedVsBase(survivor, base)) {
        nodes.push({ id, resolution: 'deleted' }); // 另一侧删、本侧没改 → 接受删除
      } else {
        const c: FieldConflict = {
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
    const merged: Record<string, FieldValue> = {};
    const nodeConflicts: FieldConflict[] = [];
    for (const field of MERGE_FIELDS) {
      const r = threeWayField(fieldVal(base, field), fieldVal(ours, field), fieldVal(theirs, field));
      if ('value' in r) merged[field] = r.value;
      else nodeConflicts.push({ field, base: r.base, ours: r.ours, theirs: r.theirs });
    }
    if (nodeConflicts.length === 0) {
      nodes.push({ id, resolution: 'merged', merged });
    } else {
      pushConflict(id, nodeConflicts);
      nodes.push({ id, resolution: 'conflict', merged, conflicts: nodeConflicts });
    }
  }

  // 结构性删改后置检查：一侧把节点挂在某父节点下（新增 / 移入），而该父在另一侧已不存在
  // （那侧的删除被上面按「接受删除」自动取）→ 合并结果里父缺失，写回重放必撞缺父。
  // 这是 delete-modify 的结构变体，按节点报 __parent__ 冲突交人裁（复活父节点 v1 不支持）。
  // 只报孤儿链的顶端：父若是本侧自己新建的节点，重放会一并创建，孤儿问题在更上层节点暴露。
  // 两个方向都查，因为 ours/theirs 谁是「删父的那侧」取决于调用场景：常规 merge 是主干删父、
  // 分支在其下新增；revertCommit 反过来（base=被撤 commit C、theirs=C 的父版本），C 新建的父在
  // theirs 侧根本不存在，ours 之后挂在它下面的节点就是孤儿——单查 theirs 时这一支会漏到写回才炸。
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const checkOrphanParents = (side: 'ours' | 'theirs') => {
    const sideById = side === 'theirs' ? theirsById : oursById;
    const otherById = side === 'theirs' ? oursById : theirsById;
    for (const [id, sideNode] of sideById) {
      const parentRef = fieldVal(sideNode, 'parent_id');
      if (parentRef === null) continue;
      if (otherById.has(parentRef)) continue; // 父在另一侧存活
      if (!baseById.has(parentRef) && sideById.has(parentRef)) continue; // 父由本侧新建
      const base = baseById.get(id) || null;
      const other = otherById.get(id) || null;
      // 只在「合并结果会采用本侧的父」时报：本侧新增的节点，或仅本侧移动了该节点。
      // base 有、另一侧删 → 主循环已按 delete-modify 处理；两侧都移 → 主循环已报 parent_id 冲突。
      let usesSideParent = false;
      if (!base && !other) usesSideParent = true;
      else if (base && other) {
        const baseParent = fieldVal(base, 'parent_id');
        usesSideParent = parentRef !== baseParent && fieldVal(other, 'parent_id') === baseParent;
      }
      if (!usesSideParent) continue;
      const baseParentRef = base ? fieldVal(base, 'parent_id') : null;
      const conflict: FieldConflict = side === 'theirs'
        ? { field: '__parent__', base: baseParentRef, ours: 'deleted', theirs: parentRef }
        : { field: '__parent__', base: baseParentRef, ours: parentRef, theirs: 'deleted' };
      conflicts.push({ id, ...conflict });
      const node = nodeById.get(id);
      if (node) {
        node.resolution = 'conflict';
        if (!node.kind) node.kind = 'parent-deleted';
        node.conflicts = [...(node.conflicts || []), conflict];
      } else {
        const created: MergeNode = { id, resolution: 'conflict', kind: 'parent-deleted', conflicts: [conflict] };
        nodes.push(created);
        nodeById.set(id, created);
      }
    }
  };
  checkOrphanParents('theirs');
  checkOrphanParents('ours');

  return { nodes, conflicts, hasConflicts: conflicts.length > 0 };
}
