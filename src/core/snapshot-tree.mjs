// 快照节点树的纯构建逻辑（从 db-shell 提取，解耦第 5 步走法 b）：history `--at` 读的是 commit 对象库
// materializeTree 出来的原始节点行（数组、没有算好的预算值），这里把「按 parent 分组排序 → 现算
// child_count / 字数 → 拼成带 meta 的树 → 按深度剪枝」做成吃节点行数组的纯函数。它与在线读（query-api
// 走 SQL 把 child_count/字数算好放进返回的 nodes）数据源不同、各喂各的；两条路的渲染（db-shell 的
// formatIndexNode）本就共用。放 core 让这套快照遍历不再是 db-shell 私有、可被任何吃节点行数组的地方复用。

export function snapshotNodeId(row = {}) {
  return String(row.id ?? row.nodeId ?? row.node_id ?? '');
}

export function snapshotParentId(row = {}) {
  const parent = row.parent_id ?? row.parentId ?? null;
  return parent === null || parent === undefined ? '' : String(parent);
}

// 按 parent 分组并按 sort_order（次按地址）排序——快照行没有现成的树形，先建邻接表。
export function snapshotChildrenByParent(rows = []) {
  const byParent = new Map();
  for (const row of rows) {
    const key = snapshotParentId(row);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(row);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((left, right) => {
      const order = Number(left.sort_order ?? left.sortOrder ?? 0) - Number(right.sort_order ?? right.sortOrder ?? 0);
      return order || String(left.address || '').localeCompare(String(right.address || ''));
    });
  }
  return byParent;
}

export function snapshotTextChars(row = {}) {
  return String(row.text || '').length;
}

export function snapshotSubtreeTextChars(row, byParent) {
  return snapshotTextChars(row) + (byParent.get(snapshotNodeId(row)) || [])
    .reduce((sum, child) => sum + snapshotSubtreeTextChars(child, byParent), 0);
}

// 从快照原始行 + 邻接表建一个节点视图（含现算的 childCount / textChars / subtreeTextChars），
// 形态与在线读返回的 node 同构，好喂给共用的 formatIndexNode 渲染。
export function snapshotReadNode(row, byParent) {
  const children = byParent.get(snapshotNodeId(row)) || [];
  return {
    id: row.id,
    docId: row.doc_id ?? row.docId,
    parentId: row.parent_id ?? row.parentId ?? null,
    address: row.address || '',
    depth: row.depth ?? null,
    sortOrder: row.sort_order ?? row.sortOrder ?? null,
    type: row.node_type ?? row.nodeType ?? 'TEXT',
    title: row.node_title ?? row.nodeTitle ?? '',
    text: row.text || '',
    note: row.node_note ?? row.nodeNote ?? '',
    childCount: children.length,
    tags: {
      trustLevel: row.trust_level ?? row.trustLevel ?? null
    },
    meta: {
      textChars: snapshotTextChars(row),
      subtreeTextChars: snapshotSubtreeTextChars(row, byParent)
    },
    children: children.map((child) => snapshotReadNode(child, byParent))
  };
}

// 收集某根的整棵子树原始行（前序），供正文拼接 / 字数统计用。
export function snapshotSubtreeRows(root, byParent) {
  const rows = [root];
  for (const child of byParent.get(snapshotNodeId(root)) || []) rows.push(...snapshotSubtreeRows(child, byParent));
  return rows;
}

export function snapshotAddressDepth(address = '') {
  const value = String(address || '').trim();
  return value ? value.split('-').length : 0;
}

// 把快照树剪到 maxLevels 层（level 1 = 当前节点）；tree --at 默认只展 2 层，与在线 tree 一致。
export function pruneTreeDepth(node, maxLevels, level = 1) {
  if (level >= maxLevels) return { ...node, children: [] };
  return { ...node, children: (node.children || []).map((child) => pruneTreeDepth(child, maxLevels, level + 1)) };
}
