import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSession,
  ingestRoot,
  ingestChildren,
  setFocus,
  makeChildCountOf,
  planHotFetches,
  nextBackgroundFetch,
  isFullyLoaded,
  projectToLegacyDoc,
  reconcileNode,
  reconcileChildren,
  selectNode,
  setDepthLimit,
  maxDepthOf,
  applyViewState,
  viewStatePayload,
  toggleCollapsed,
  snapshotView,
  applyViewSnapshot
} from '../dist/src/frontend/session/document-session.js';
// 注：activeTab 已归 useAppUI（全局 UI），不再是 session 视图态。
import { buildTree, flattenTree } from '../dist/src/core/tree.js';
import { nextInDfs } from '../dist/src/core/tree-cursor.js';

// 复用 tree-cursor.test 的造树法：嵌套 shape 生成 rows，buildTree 算 address，flattenTree 当 oracle。
const SHAPE = [
  [[], [], []],
  [[[[[], []]]]],
  [],
  [[], [[], [], [[], []]], [[[[[]]]]]],
  [[], []]
];

function genRows(shape, parentId = null, sortOrder = 1, counter = { n: 0 }, rows = []) {
  const id = `n${counter.n++}`;
  rows.push({ id, parent_id: parentId, sort_order: sortOrder, node_type: 'TEXT', text: id });
  shape.forEach((childShape, index) => genRows(childShape, id, index + 1, counter, rows));
  return rows;
}

const fullTree = buildTree(genRows(SHAPE));
const allNodes = flattenTree(fullTree);
const nodeById = new Map(allNodes.map((node) => [String(node.id), node]));

// 模拟后端：每个节点行带 address + child_count（孙子数），listChildren 按 parent 供整窗子节点。
function rowOf(node) {
  return {
    id: node.id,
    parent_id: node.parentId ?? null,
    address: node.address,
    sort_order: node.sortOrder,
    node_type: 'TEXT',
    child_count: (node.children || []).length
  };
}
function serveRoot() {
  return rowOf(fullTree);
}
function serveChildren(parentId, { offset = 0, limit = 1000 } = {}) {
  const parent = nodeById.get(String(parentId));
  const children = parent?.children || [];
  const slice = children.slice(offset, offset + limit);
  return {
    parentId,
    rows: slice.map(rowOf),
    total: children.length,
    offset,
    hasMore: offset + slice.length < children.length
  };
}

test('后台预取至全量：nextBackgroundFetch 驱动迭代 reconcile，拉全整棵树且 DFS 序对齐 oracle', () => {
  let state = createSession('doc1');
  state = ingestRoot(state, serveRoot());

  let guard = 0;
  for (let fetch = nextBackgroundFetch(state); fetch; fetch = nextBackgroundFetch(state)) {
    assert.ok(++guard <= allNodes.length + 5, '预取应在 O(节点数) 步内收敛');
    state = ingestChildren(state, serveChildren(fetch.parentId, fetch));
  }

  assert.equal(state.index.size, allNodes.length, '全量节点都已并入');
  assert.ok(isFullyLoaded(state), '再无取数边界');

  const childCountOf = makeChildCountOf(state);
  const order = [];
  for (let address = fullTree.address; address; address = nextInDfs(address, childCountOf)) {
    order.push(address);
  }
  assert.deepEqual(order, allNodes.map((node) => node.address), 'L3 镜像的 DFS 全序 === oracle');
});

test('planHotFetches：打开第一步以根为焦点，请求根的子列表', () => {
  let state = createSession('doc1');
  state = ingestRoot(state, serveRoot());
  const fetches = planHotFetches(state, { radius: 8 });
  assert.deepEqual(fetches, [{ parentId: fullTree.id, offset: 0, limit: 300 }]);
});

test('planHotFetches：radius 约束前台热区——DFS 序远端的边界留给后台，不在首屏请求', () => {
  // 宽树：根 12 个子，每子各 2 个叶孙 → 根的 12 个子全是「有子未加载」的边界。
  const wideTree = buildTree(genRows(Array.from({ length: 12 }, () => [[], []])));
  const wideById = new Map(flattenTree(wideTree).map((node) => [String(node.id), node]));
  const serveWide = (parentId) => {
    const children = wideById.get(String(parentId))?.children || [];
    return { parentId, rows: children.map(rowOf), total: children.length, offset: 0, hasMore: false };
  };

  let state = createSession('wide');
  state = ingestRoot(state, rowOf(wideTree));
  state = ingestChildren(state, serveWide(wideTree.id)); // 12 个根子进来，都还没拉各自的孙
  const firstChild = wideById.get(String(wideTree.children[0].id));
  state = setFocus(state, firstChild.id);

  const fetches = planHotFetches(state, { radius: 3 });
  const addrs = fetches.map((fetch) => state.index.byId.get(fetch.parentId)?.address);
  assert.ok(fetches.every((fetch) => fetch.offset === 0), '都是首页请求');
  assert.ok(addrs.includes('1-1'), '焦点自身要取');
  assert.ok(addrs.includes('1-2'), '焦点近邻要取');
  assert.ok(!addrs.includes('1-12'), 'DFS 序远端的边界不进前台热区，留给后台预取');
});

test('永驻缓存：重复 ingest 同一 parent 不丢已有子、不重复', () => {
  let state = createSession('doc1');
  state = ingestRoot(state, serveRoot());
  state = ingestChildren(state, serveChildren(fullTree.id));
  const sizeAfterFirst = state.index.size;
  const childrenAfterFirst = state.index.childrenOf.get(fullTree.id).length;
  state = ingestChildren(state, serveChildren(fullTree.id)); // 再来一次
  assert.equal(state.index.size, sizeAfterFirst, '节点数不变');
  assert.equal(state.index.childrenOf.get(fullTree.id).length, childrenAfterFirst, '子数不翻倍');
});

test('分页 hasMore：宽节点首窗未取完，nextBackgroundFetch 续取下一页', () => {
  let state = createSession('doc1');
  state = ingestRoot(state, serveRoot());
  // 根有 5 个子，故意只取前 2 个、声明 hasMore。
  state = ingestChildren(state, serveChildren(fullTree.id, { offset: 0, limit: 2 }));
  const page = state.childPages.get(fullTree.id);
  assert.equal(page.hasMore, true);
  const fetch = nextBackgroundFetch(state);
  assert.deepEqual(fetch, { parentId: fullTree.id, offset: 2, limit: 300 }, '从 offset=2 续页');
});

test('makeChildCountOf：已加载父返回真实子数，未加载父返回 0（DFS 边界）', () => {
  let state = createSession('doc1');
  state = ingestRoot(state, serveRoot());
  const childCountOf = makeChildCountOf(state);
  assert.equal(childCountOf('1'), 0, '根的子还没拉 → 边界');
  state = ingestChildren(state, serveChildren(fullTree.id));
  const childCountOf2 = makeChildCountOf(state);
  assert.equal(childCountOf2('1'), 5, '根有 5 个直接子');
  assert.equal(childCountOf2('1-2'), 0, '1-2 的子还没拉 → 边界');
});

test('projectToLegacyDoc：全量加载后投影出兼容嵌套 tree，结构 / idByAddress / 深度对齐 oracle', () => {
  let state = createSession('doc1');
  state = ingestRoot(state, serveRoot());
  for (let fetch = nextBackgroundFetch(state); fetch; fetch = nextBackgroundFetch(state)) {
    state = ingestChildren(state, serveChildren(fetch.parentId, fetch));
  }
  const { tree, idByAddress, depthStats } = projectToLegacyDoc(state);
  assert.equal(tree.address, '1');
  assert.deepEqual(flattenTree(tree).map((node) => node.address), allNodes.map((node) => node.address));
  assert.equal(Object.keys(idByAddress).length, allNodes.length, 'idByAddress 覆盖全部节点');
  assert.equal(idByAddress['1'], fullTree.id);
  const oracleMaxDepth = Math.max(...allNodes.map((node) => node.address.split('-').length));
  assert.equal(depthStats.maxDepth, oracleMaxDepth);
});

test('projectToLegacyDoc：部分加载只投影已加载子树，未加载子缺位且不崩', () => {
  let state = createSession('doc1');
  state = ingestRoot(state, serveRoot());
  state = ingestChildren(state, serveChildren(fullTree.id)); // 仅根的 5 个直接子
  const { tree } = projectToLegacyDoc(state);
  assert.equal(tree.children.length, 5, '根的直接子已投影');
  assert.ok(tree.children.every((child) => child.children.length === 0), '孙子还没拉 → 缺位');
});

test('reconcileNode：内容写单行 patch——更新正文、不增减节点、投影见新内容、结构不变', () => {
  let state = createSession('doc1');
  state = ingestRoot(state, serveRoot());
  state = ingestChildren(state, serveChildren(fullTree.id)); // 根的 5 个直接子
  const sizeBefore = state.index.size;
  const seqBefore = state.loadSeq;
  const target = fullTree.children[1]; // 地址 1-2，已加载

  state = reconcileNode(state, {
    id: target.id,
    parent_id: target.parentId,
    address: target.address,
    sort_order: target.sortOrder,
    node_type: 'TEXT',
    text: 'PATCHED'
  });

  assert.equal(state.index.size, sizeBefore, '内容写不增减节点');
  assert.ok(state.loadSeq > seqBefore, 'bump 触发变化信号');
  assert.equal(state.index.byId.get(target.id).text, 'PATCHED', 'byId 见新内容');

  const { tree } = projectToLegacyDoc(state);
  const projected = tree.children.find((child) => child.id === target.id);
  assert.equal(projected.text, 'PATCHED', '投影树见新内容引用');
  assert.equal(projected.address, target.address, 'address 不变');
  assert.equal(tree.children.length, 5, '根的子数不变');
});

test('reconcileNode：根节点内容写更新 index.root，投影根见新内容', () => {
  let state = createSession('doc1');
  state = ingestRoot(state, serveRoot());
  state = reconcileNode(state, {
    id: fullTree.id, parent_id: null, address: '1', sort_order: 1, node_type: 'TEXT', text: 'NEW_ROOT'
  });
  assert.equal(state.index.root.text, 'NEW_ROOT', 'index.root 更新');
  assert.equal(projectToLegacyDoc(state).tree.text, 'NEW_ROOT', '投影根见新内容');
});

test('reconcileNode：空 / 未加载 id 安全无操作、不 bump、不新增孤儿', () => {
  let state = createSession('doc1');
  state = ingestRoot(state, serveRoot());
  const seqBefore = state.loadSeq;
  assert.equal(reconcileNode(state, { id: null }).loadSeq, seqBefore, '空 id 不 bump');
  assert.equal(reconcileNode(state, { id: 'ghost', text: 'x' }).loadSeq, seqBefore, '未加载 id 不 bump');
  assert.equal(state.index.size, 1, 'index 仍只有根，无孤儿');
});

function fullyLoaded(docId = 'doc1') {
  let state = createSession(docId);
  state = ingestRoot(state, serveRoot());
  for (let fetch = nextBackgroundFetch(state); fetch; fetch = nextBackgroundFetch(state)) {
    state = ingestChildren(state, serveChildren(fetch.parentId, fetch));
  }
  return state;
}

test('视图·toggleCollapsed：depthLimit=1 下展开深层节点进 expanded，再点折叠回 collapsed', () => {
  let state = fullyLoaded();
  const branch = fullTree.children[0]; // 1-1，有子
  assert.ok(branch.children.length > 0, 'fixture: 1-1 有子');

  state = toggleCollapsed(state, branch.id); // depth2 >= limit1，首次 → 展开
  assert.ok(state.view.expanded.has(branch.id), '展开后进 expanded');
  assert.ok(!state.view.collapsed.has(branch.id), '不在 collapsed');

  state = toggleCollapsed(state, branch.id); // 再点 → 折叠
  assert.ok(state.view.collapsed.has(branch.id), '折叠后进 collapsed');
  assert.ok(!state.view.expanded.has(branch.id), '自身移出 expanded');
});

test('视图·toggleCollapsed：折叠父清掉后代的 expanded', () => {
  let state = fullyLoaded();
  const branch = fullTree.children[3];  // 1-4，有子
  const sub = branch.children[1];       // 1-4-2，有子
  assert.ok(branch.children.length > 0 && sub.children.length > 0, 'fixture 有深子树');

  state = toggleCollapsed(state, branch.id); // 展开 1-4
  state = toggleCollapsed(state, sub.id);    // 展开 1-4-2 → 进 expanded
  assert.ok(state.view.expanded.has(sub.id), '1-4-2 已 expanded');

  state = toggleCollapsed(state, branch.id); // 折叠 1-4
  assert.ok(!state.view.expanded.has(sub.id), '折叠父清掉后代 1-4-2 的 expanded');
});

test('视图·toggleCollapsed promote：当前层有子节点全展开则 depthLimit 自动 +1', () => {
  let state = fullyLoaded();
  // depthLimit=1，深度1层只有根；展开根 → 整层展开 → promote 到 2，根的冗余 expanded 清掉。
  state = toggleCollapsed(state, fullTree.id);
  assert.equal(state.view.depthLimit, 2, '整层展开自动提深度');
  assert.ok(!state.view.expanded.has(fullTree.id), 'promote 后根的冗余 expanded 被清');
});

test('视图·setDepthLimit clamp 到 [1, maxDepthOf]', () => {
  let state = fullyLoaded();
  const cap = maxDepthOf(state);
  assert.ok(cap > 1, 'fixture 多层');
  state = setDepthLimit(state, 999);
  assert.equal(state.view.depthLimit, cap, '超界 clamp 到 maxDepth');
  state = setDepthLimit(state, 0);
  assert.equal(state.view.depthLimit, 1, '下界 clamp 到 1');
});

test('视图·applyViewState / viewStatePayload 往返', () => {
  let state = fullyLoaded();
  const someId = fullTree.children[0].id;
  state = applyViewState(state, { depthLimit: 2, collapsedNodeIds: [someId], expandedNodeIds: [] });
  assert.equal(state.view.depthLimit, 2);
  assert.ok(state.view.collapsed.has(someId));
  const payload = viewStatePayload(state);
  assert.equal(payload.depthLimit, 2);
  assert.deepEqual(payload.collapsedNodeIds, [someId]);
  assert.deepEqual(payload.expandedNodeIds, []);
});

test('视图·selectNode：变更换引用、同值不变', () => {
  let state = fullyLoaded();
  const before = state;
  state = selectNode(state, fullTree.children[1].id);
  assert.equal(state.view.selectedId, fullTree.children[1].id);
  assert.notEqual(state, before, '变更换 state 引用');
  assert.equal(selectNode(state, fullTree.children[1].id), state, '同值不换引用');
});

test('视图·snapshotView / applyViewSnapshot 往返：折叠/选中/深度整套复原到另一个 session', () => {
  let state = fullyLoaded();
  const a = fullTree.children[0].id;
  const b = fullTree.children[1].id;
  state = applyViewState(state, { depthLimit: 2, collapsedNodeIds: [a], expandedNodeIds: [b] });
  state = selectNode(state, b);
  const snap = snapshotView(state);

  let other = fullyLoaded();
  other = applyViewSnapshot(other, snap);
  assert.equal(other.view.depthLimit, 2);
  assert.ok(other.view.collapsed.has(a));
  assert.ok(other.view.expanded.has(b));
  assert.equal(other.view.selectedId, b);
});

test('视图·applyViewSnapshot 缺省字段保留现状', () => {
  let state = fullyLoaded();
  state = selectNode(state, fullTree.children[0].id);
  state = applyViewSnapshot(state, { depthLimit: 3 });
  assert.equal(state.view.depthLimit, 3);
  assert.equal(state.view.selectedId, fullTree.children[0].id, '没给 selectedNodeId → 保留');
});

test('reconcileChildren replace：移走有子的节点 → 级联删其整棵子树，留下的不动', () => {
  let state = fullyLoaded();
  const parent = fullTree.children[3];   // 1-4，有子
  const kept = parent.children[0];       // 1-4-1
  const removed = parent.children[1];    // 1-4-2（有子）
  assert.ok(removed.children.length > 0, 'fixture: 1-4-2 有子');
  const removedGrandchild = removed.children[0].id;
  assert.ok(state.index.byId.has(removedGrandchild), '前置：1-4-2 的子已加载');

  // 结构写后 1-4 只剩 1-4-1（1-4-2 整棵移走/删）
  state = reconcileChildren(state, { parentId: parent.id, rows: [rowOf(kept)], total: 1, hasMore: false });

  assert.ok(state.index.byId.has(kept.id), '保留的子还在');
  assert.ok(!state.index.byId.has(removed.id), '移走的子被删');
  assert.ok(!state.index.byId.has(removedGrandchild), '移走子的后代被级联删');
  assert.equal(state.index.childrenOf.get(parent.id).length, 1, 'replace 后子数 = 1');
});

test('reconcileChildren replace：留下的子更新新 address（byId / byAddress 同步迁移）', () => {
  let state = fullyLoaded();
  const parent = fullTree.children[3];   // 1-4
  const kept = parent.children[1];       // 1-4-2
  // 结构写：1-4-2 升到第 1 位（新 address 1-4-1），原 1-4-1 移走
  state = reconcileChildren(state, {
    parentId: parent.id,
    rows: [{ id: kept.id, parent_id: parent.id, address: '1-4-1', sort_order: 1, node_type: 'TEXT' }],
    total: 1,
    hasMore: false
  });
  assert.equal(state.index.byId.get(kept.id).address, '1-4-1', 'address 更新到新位置');
  assert.equal(state.index.byAddress.get('1-4-1')?.id, kept.id, 'byAddress 迁移到新地址');
});
