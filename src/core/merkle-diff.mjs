import { computeSubtreeHashes } from './merkle.mjs';

// 按 UUID + 哈希做条件树对比分类（A5-2）。取代原先按"树地址"配对的做法——
// 地址是位置性的，插入/移动会让后续兄弟地址级联错位、刷出一片假 diff。
// 这里按稳定 id 配对：
//   - 内容变(contentHash 不等) / 跨父移动(parent 变) / 同父重排(共同兄弟间相对次序变) → modified（用户：「改地址=修改」）
//   - 仅因别处插删导致绝对地址顺移、相对次序没变 → 不算改（共同兄弟 rank 不变）
// 输出 { roots, items }：roots 是按 id/parent 建的对比树（投影结构 ∪ 仅 base 的删除节点），
// items 是全部节点项的扁平表。collapse / hasChangedDescendant / 行渲染交给 store 复用既有逻辑。

const norm = (value) => (value === null || value === undefined ? null : String(value));
const sortKey = (node) => Number(node.sort_order ?? node.sortOrder) || 0;
const parentOf = (node) => norm(node.parent_id ?? node.parentId);

const CONTENT_FIELDS = ['text', 'node_title', 'node_note', 'node_type', 'trust_level'];
const CAMEL = { node_title: 'nodeTitle', node_note: 'nodeNote', node_type: 'nodeType', trust_level: 'trustLevel' };
const fieldVal = (node, field) => {
  const value = node[field] ?? node[CAMEL[field]];
  return value === null || value === undefined ? '' : String(value);
};

function groupChildren(nodes) {
  const map = new Map();
  for (const node of nodes) {
    const key = parentOf(node);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(node);
  }
  for (const list of map.values()) list.sort((a, b) => sortKey(a) - sortKey(b));
  return map;
}

// 每个节点在「两边都存在的兄弟」中的次序号；插入/删除一个只在单边的兄弟不影响它，
// 故能把真重排（rank 变）和顺移（rank 不变）区分开。
function commonSiblingRanks(childrenMap, otherById) {
  const ranks = new Map();
  for (const list of childrenMap.values()) {
    let rank = 0;
    for (const node of list) {
      if (otherById.has(String(node.id))) {
        ranks.set(String(node.id), rank);
        rank += 1;
      }
    }
  }
  return ranks;
}

function changedFieldList(base, proj) {
  const fields = CONTENT_FIELDS.filter((field) => fieldVal(base, field) !== fieldVal(proj, field));
  if (parentOf(base) !== parentOf(proj)) fields.push('parent_id');
  return fields;
}

function diffDepth(address) {
  return Math.max(1, String(address || '').split('-').filter(Boolean).length || 1);
}

export function classifyTreeDiff(baseNodes = [], projectedNodes = [], options = {}) {
  // base 哈希优先用调用方传入的持久缓存（ensureNodeHashes 读列），省掉每次 session 重算整个 base；
  // 不传则当场算（纯逻辑/测试路径）。投影是内存 overlay，始终当场算其增量。
  const baseHashes = options.baseHashes || computeSubtreeHashes(baseNodes);
  const projHashes = computeSubtreeHashes(projectedNodes);
  const baseById = new Map(baseNodes.map((node) => [String(node.id), node]));
  const projById = new Map(projectedNodes.map((node) => [String(node.id), node]));
  const baseChildren = groupChildren(baseNodes);
  const projChildren = groupChildren(projectedNodes);
  const baseRank = commonSiblingRanks(baseChildren, projById);
  const projRank = commonSiblingRanks(projChildren, baseById);

  function classify(id) {
    const base = baseById.get(id);
    const proj = projById.get(id);
    if (base && !proj) return { status: 'deleted', changedFields: [] };
    if (!base && proj) return { status: 'added', changedFields: [] };
    const contentChanged = baseHashes.get(id).contentHash !== projHashes.get(id).contentHash;
    const moved = parentOf(base) !== parentOf(proj);
    const reordered = !moved && baseRank.get(id) !== projRank.get(id);
    if (!contentChanged && !moved && !reordered) return { status: 'unchanged', changedFields: [] };
    const changedFields = changedFieldList(base, proj);
    if (reordered && !changedFields.includes('sort_order')) changedFields.push('sort_order');
    return { status: 'modified', changedFields };
  }

  const items = [];
  const built = new Set();

  function build(node, depth) {
    const id = String(node.id);
    if (built.has(id)) return null;
    built.add(id);
    const base = baseById.get(id);
    const proj = projById.get(id);
    const cls = classify(id);
    const address = proj?.address ?? base?.address ?? '';
    const item = {
      id,
      hasChangedDescendant: false,
      row: {
        kind: 'node',
        key: `node:${id}`,
        address,
        depth: Number(proj?.depth ?? base?.depth) || diffDepth(address),
        status: cls.status,
        changedFields: cls.changedFields,
        left: base || null,
        right: proj || null
      },
      children: []
    };
    items.push(item);

    // 子节点 = 投影侧子节点 ∪ 仅 base 侧（被删）子节点，按 id 去重。
    const seen = new Set();
    const childNodes = [];
    for (const child of projChildren.get(id) || []) {
      childNodes.push(child);
      seen.add(String(child.id));
    }
    for (const child of baseChildren.get(id) || []) {
      if (!seen.has(String(child.id))) childNodes.push(child);
    }
    for (const child of childNodes) {
      const childItem = build(child, item.row.depth + 1);
      if (childItem) item.children.push(childItem);
    }
    return item;
  }

  const roots = [];
  const seenRoot = new Set();
  for (const root of projChildren.get(null) || []) {
    const item = build(root, 1);
    if (item) {
      roots.push(item);
      seenRoot.add(item.id);
    }
  }
  for (const root of baseChildren.get(null) || []) {
    if (!seenRoot.has(String(root.id))) {
      const item = build(root, 1);
      if (item) roots.push(item);
    }
  }

  return { roots, items };
}
