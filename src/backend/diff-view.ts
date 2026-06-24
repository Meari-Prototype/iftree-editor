// @ts-nocheck
// 对比弹窗（编辑分支 diff / 公理 diff）的视图渲染层——从主库存储类（store.mjs）剥离（后端解耦第 1 步）。
// 职责：把基线/投影节点树分类成差异行、折叠未改动子树成占位行、统计各状态计数、把节点行转成
// 客户端 camelCase 别名、把公理（事实前提）伪装成对比视图的节点卡片。纯函数、零状态、不碰 db。
import { classifyTreeDiff } from '../core/merkle-diff.js';

// 节点行 → 客户端 camelCase 别名（doc_id→docId 等）。编辑分支暂存方法（store 内）与下面的 diff
// 渲染共用：两者返回的都是「编辑分支节点的客户端形态」，故落在本模块单点维护。
export function nodeRowWithClientAliases(row) {
  if (!row) return row;
  return {
    ...row,
    docId: row.doc_id,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    nodeType: row.node_type,
    title: row.node_title || '',
    nodeTitle: row.node_title || '',
    note: row.node_note || '',
    nodeNote: row.node_note || '',
    trustLevel: row.trust_level ?? null,
    sourcePosition: row.source_position ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null
  };
}

function editBranchDiffNode(row) {
  if (!row) return null;
  const node = nodeRowWithClientAliases(row);
  return {
    ...node,
    childCount: Math.max(0, Number(row.child_count) || 0)
  };
}

function flattenDiffTreeItem(item) {
  const rows = [{ ...item.row }];
  for (const child of item.children) rows.push(...flattenDiffTreeItem(child));
  return rows;
}

function diffHiddenNodeCount(items) {
  return items.reduce((sum, item) => sum + flattenDiffTreeItem(item).length, 0);
}

export function buildEditBranchDiffRows(baseNodes = [], projectedNodes = [], baseHashes = null) {
  const { roots, items } = classifyTreeDiff(baseNodes, projectedNodes, baseHashes ? { baseHashes } : {});
  const stats = {
    added: 0,
    deleted: 0,
    modified: 0,
    moved: 0,
    unchanged: 0,
    collapsed: 0,
    visibleRows: 0,
    totalRows: 0
  };
  // 仅位置/父级变更（sort_order/parent_id）从 modified 拆出单列 moved，与 diff summary 的「移」口径对齐
  // （否则 move/reparent 挤动的邻居 sort_order 变化全算 modified，summary 报 2、stats 报 11 对不上）。
  const POSITION_ONLY_FIELDS = new Set(['sort_order', 'parent_id', 'address']);
  for (const item of items) {
    item.row.left = editBranchDiffNode(item.row.left);
    item.row.right = editBranchDiffNode(item.row.right);
    const fields = Array.isArray(item.row.changedFields) ? item.row.changedFields : [];
    if (item.row.status === 'modified' && fields.length > 0 && fields.every((f) => POSITION_ONLY_FIELDS.has(f))) {
      stats.moved += 1;
    } else {
      stats[item.row.status] += 1;
    }
    stats.totalRows += 1;
  }

  function markChangedDescendants(item) {
    let hasChangedDescendant = false;
    for (const child of item.children) {
      const childChanged = markChangedDescendants(child);
      hasChangedDescendant = hasChangedDescendant || childChanged;
    }
    item.hasChangedDescendant = hasChangedDescendant;
    return item.row.status !== 'unchanged' || hasChangedDescendant;
  }

  for (const root of roots) markChangedDescendants(root);

  function collapsedRowFor(items) {
    const hiddenRows = items.flatMap(flattenDiffTreeItem);
    const first = hiddenRows[0];
    const last = hiddenRows[hiddenRows.length - 1];
    return {
      kind: 'collapsed',
      key: `collapsed:${first?.address || ''}:${last?.address || ''}`,
      address: first?.address || '',
      depth: first?.depth || 1,
      status: 'collapsed',
      hiddenCount: hiddenRows.length,
      hiddenRows
    };
  }

  function renderItems(items) {
    const rows = [];
    let pending = [];
    const flushPending = () => {
      if (pending.length === 0) return;
      const row = collapsedRowFor(pending);
      stats.collapsed += row.hiddenCount;
      rows.push(row);
      pending = [];
    };

    for (const item of items) {
      const canCollapse = item.row.depth > 1
        && item.row.status === 'unchanged'
        && !item.hasChangedDescendant;
      if (canCollapse) {
        pending.push(item);
        continue;
      }
      flushPending();
      rows.push({ ...item.row });
      rows.push(...renderItems(item.children));
    }
    flushPending();
    return rows;
  }

  const rows = renderItems(roots);
  stats.visibleRows = rows.length;
  stats.unchangedCollapsed = stats.collapsed;
  stats.hiddenRows = Math.max(0, diffHiddenNodeCount(roots) - rows.filter((row) => row.kind === 'node').length);
  return { rows, stats };
}

// 公理（事实前提）卡片行：伪装成对比视图节点卡片的形状，address 用 A 标号。
function axiomDiffCard(axiom) {
  if (!axiom) return null;
  return {
    id: axiom.id,
    address: axiom.label || '',
    node_type: 'AXIOM',
    nodeType: 'AXIOM',
    text: axiom.content ?? '',
    node_title: axiom.node_title || '',
    nodeTitle: axiom.node_title || '',
    node_note: axiom.node_note || '',
    nodeNote: axiom.node_note || '',
    status: axiom.status || 'pending',
    childCount: 0
  };
}

// 公理（事实前提）对比：对比视图此前只对比 nodes，公理变更完全不可见
// （active diff 有数、统计全 0，实际翻过车）。by id 配对；content/status/标题/备注
// 任一变即 modified；label 是地址不是内容（删除引发的重排不算修改）；
// node_width/height/size_mode 是视图偏好，不进 diff（8-3-2-1）。
// 未修改公理不显示也不进折叠计数（折叠条语义是"未修改节点"）。
export function buildAxiomDiffRows(baseAxioms = [], projectedAxioms = []) {
  const AXIOM_DIFF_FIELDS = ['content', 'status', 'node_title', 'node_note'];
  const rows = [];
  const stats = { added: 0, deleted: 0, modified: 0 };
  const baseById = new Map(baseAxioms.map((axiom) => [String(axiom.id), axiom]));
  const seen = new Set();
  for (const proj of projectedAxioms) {
    const id = String(proj.id);
    seen.add(id);
    const base = baseById.get(id) || null;
    let status = 'added';
    let changedFields = [];
    if (base) {
      changedFields = AXIOM_DIFF_FIELDS.filter((field) => String(base[field] ?? '') !== String(proj[field] ?? ''));
      status = changedFields.length ? 'modified' : 'unchanged';
    }
    if (status === 'unchanged') continue;
    stats[status] += 1;
    rows.push({
      kind: 'axiom',
      key: `axiom:${id}`,
      address: proj.label || base?.label || '',
      depth: 1,
      status,
      changedFields,
      left: axiomDiffCard(base),
      right: axiomDiffCard(proj)
    });
  }
  for (const base of baseAxioms) {
    const id = String(base.id);
    if (seen.has(id)) continue;
    stats.deleted += 1;
    rows.push({
      kind: 'axiom',
      key: `axiom:${id}`,
      address: base.label || '',
      depth: 1,
      status: 'deleted',
      changedFields: [],
      left: axiomDiffCard(base),
      right: null
    });
  }
  return { rows, stats };
}
