import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSession,
  ingestRoot,
  ingestChildren,
  ingestPath,
  setFocus,
  selectNode,
  applyViewState,
  planHotFetches,
  planEvictions,
  evictChildren,
  loadedNodeCount,
  projectToLegacyDoc
} from '../dist/src/frontend/session/document-session.js';

// ingestPath（定位到未加载 / 已驱逐节点时把「根 → 目标」整条链拉回镜像）的行为锁定。
// 树形状：root(1) 下 3 个分支 b1/b2/b3；b2 有 10 个子（宽节点，用来验分页前缀），
// b1/b3 各声称 4 个子。初始只加载根的直接子——b2 的子一个都没到，正是定位落空的现场。

function row(id, parentId, address, childCount = 0) {
  return {
    id,
    parent_id: parentId,
    address,
    sort_order: Number(address.split('-').pop()),
    child_count: childCount,
    node_title: id,
    text: id
  };
}

// 后端 node.ancestors 的一行：listChildren 行格式 + child_offset（在父的子列表里的 0 基序号）。
function pathRow(id, parentId, address, childCount = 0) {
  const base = row(id, parentId, address, childCount);
  return { ...base, child_offset: Math.max(0, base.sort_order - 1) };
}

function shallowSession({ depthLimit = 2 } = {}) {
  let s = ingestRoot(createSession('doc-1'), row('root', null, '1', 3));
  s = ingestChildren(s, {
    parentId: 'root',
    rows: [row('b1', 'root', '1-1', 4), row('b2', 'root', '1-2', 10), row('b3', 'root', '1-3', 4)],
    total: 3
  });
  return applyViewState(s, { depthLimit });
}

test('ingestPath: 链并入镜像并接上父子，投影自根可达目标；链上的父仍是取数边界', () => {
  let s = shallowSession();
  assert.equal(s.index.byId.has('b2-c6'), false, '前置：目标还没加载');

  const before = s;
  s = ingestPath(s, {
    rows: [pathRow('root', null, '1', 3), pathRow('b2', 'root', '1-2', 10), pathRow('b2-c6', 'b2', '1-2-6', 0)]
  });
  assert.notEqual(s, before, '有新行并入应换引用（bump）');

  // 索引三处齐：byId / byAddress / 父的 childrenOf。
  assert.ok(s.index.byId.has('b2-c6'));
  assert.equal(s.index.byAddress.get('1-2-6')?.id, 'b2-c6');
  assert.deepEqual(s.index.childrenOf.get('b2').map((n) => n.id), ['b2-c6']);

  // 投影自根可达 → findNode(tree, id) 成立，selectedNode 不再落空（F3 的前提）。
  const { tree, idByAddress } = projectToLegacyDoc(s);
  const b2 = tree.children.find((n) => n.id === 'b2');
  assert.deepEqual(b2.children.map((n) => n.id), ['b2-c6']);
  assert.equal(idByAddress['1-2-6'], 'b2-c6');
  assert.equal(b2.childCount, 10, '父的「声称子数」不因只来了一条链而缩水');

  // 关键不变量：链上的父不得进 loadedParents——否则剩下 9 个兄弟永远取不回来。
  assert.equal(s.loadedParents.has('b2'), false);
  assert.equal(s.childPages.has('b2'), false);
  s = setFocus(s, 'b2-c6');
  const plan = planHotFetches(s, { radius: 8 });
  assert.ok(
    plan.some((fetch) => fetch.parentId === 'b2' && fetch.offset === 0),
    '链上的父仍被排进分页请求（从第 0 页补齐兄弟）'
  );
});

test('ingestPath: 链上的子不污染分页前缀——下一页 offset 不跳过真兄弟', () => {
  let s = shallowSession();
  // 目标是 b2 的第 6 个子（child_offset=5，落在第 2 页），先被单独塞进 childrenOf。
  s = ingestPath(s, {
    rows: [pathRow('root', null, '1', 3), pathRow('b2', 'root', '1-2', 10), pathRow('b2-c6', 'b2', '1-2-6', 0)]
  });
  // 随后照常从第 0 页按页取子（每页 3 条）。
  s = ingestChildren(s, {
    parentId: 'b2',
    rows: [1, 2, 3].map((i) => row(`b2-c${i}`, 'b2', `1-2-${i}`)),
    total: 10,
    offset: 0
  });

  const page = s.childPages.get('b2');
  assert.equal(s.index.childrenOf.get('b2').length, 4, 'childrenOf = 已取的 3 条 + 链上先到的那条');
  assert.equal(page.loaded, 3, 'loaded 是「连续前缀」= 3，不是 childrenOf 的 4');
  assert.equal(page.hasMore, true);

  s = setFocus(s, 'b2');
  const plan = planHotFetches(s, { radius: 8 });
  const next = plan.find((fetch) => fetch.parentId === 'b2');
  assert.equal(next?.offset, 3, '下一页从 3 续，不是 4——否则第 4 个子成为补不回的空洞');
});

test('ingestPath: 焦点/选中祖先链挡驱逐；祖先真被驱逐时链随级联消失，不留孤儿', () => {
  let s = shallowSession({ depthLimit: 1 });
  s = ingestPath(s, {
    rows: [pathRow('root', null, '1', 3), pathRow('b2', 'root', '1-2', 10), pathRow('b2-c6', 'b2', '1-2-6', 0)]
  });
  s = ingestChildren(s, {
    parentId: 'b2',
    rows: [1, 2, 3].map((i) => row(`b2-c${i}`, 'b2', `1-2-${i}`)),
    total: 10,
    offset: 0
  });

  // 定位后焦点/选中落在目标上 → 整条链进 planEvictions 的保护集。
  s = setFocus(s, 'b2-c6');
  s = selectNode(s, 'b2-c6');
  assert.equal(planEvictions(s).includes('b2'), false, '焦点/选中祖先链上的 b2 不进候选');

  // 焦点移开后 b2 恢复可驱（depthLimit=1 下它的子不可见、outline 默认折叠）。
  s = setFocus(s, 'root');
  s = selectNode(s, 'root');
  assert.ok(planEvictions(s).includes('b2'), '焦点移开后 b2 可驱');

  // 祖先被驱逐：级联删掉整棵子树，链上先到的 b2-c6 一并消失（不留从根不可达的孤儿行）。
  const evicted = evictChildren(s, 'root');
  assert.equal(evicted.index.byId.has('b2'), false);
  assert.equal(evicted.index.byId.has('b2-c6'), false, '链随祖先级联卸载');
  assert.equal(loadedNodeCount(evicted), 1, '只剩根');
  assert.equal(evicted.loadedParents.has('b2'), false, '级联删掉的 parent 记录一并清理');
});

test('ingestPath: 链给的父与镜像不符时，从旧父摘掉再挂新父（不留重影）', () => {
  let s = shallowSession();
  s = ingestChildren(s, {
    parentId: 'b1',
    rows: [row('m1', 'b1', '1-1-1')],
    total: 1
  });
  assert.deepEqual(s.index.childrenOf.get('b1').map((n) => n.id), ['m1']);

  // 权威链说 m1 现在挂在 b3 下（分支里被 reparent / 主干结构写后镜像还没对账）。
  s = ingestPath(s, {
    rows: [pathRow('root', null, '1', 3), pathRow('b3', 'root', '1-3', 5), pathRow('m1', 'b3', '1-3-5', 0)]
  });
  assert.deepEqual(s.index.childrenOf.get('b1').map((n) => n.id), [], '旧父不再挂着它');
  assert.deepEqual(s.index.childrenOf.get('b3').map((n) => n.id), ['m1'], '挂到了新父下');
  assert.equal(s.index.byId.get('m1').parentId, 'b3');

  const { tree } = projectToLegacyDoc(s);
  const ids = tree.children.flatMap((branch) => branch.children.map((n) => n.id));
  assert.deepEqual(ids, ['m1'], '整棵投影里 m1 只出现一次');
});

test('ingestPath 孤儿闸：断链 / 跨文档的批次整批丢弃', () => {
  const s = shallowSession();
  const sizeBefore = s.index.size;

  // 父既不在本批、也不在镜像。
  const broken = ingestPath(s, { rows: [pathRow('x1', 'ghost', '1-9-1', 0)] });
  assert.equal(broken, s, '断链应原引用丢弃');
  assert.equal(s.index.byId.has('x1'), false);

  // 链首是另一棵树的根（跨文档迟到结果）。
  const foreign = ingestPath(s, { rows: [pathRow('other-root', null, '1', 1)] });
  assert.equal(foreign, s, '跨文档链应原引用丢弃');
  assert.equal(s.index.size, sizeBefore);

  // 空批次同样是无操作。
  assert.equal(ingestPath(s, { rows: [] }), s);
  assert.equal(ingestPath(s), s);
});

test('ingestPath: 结构共享——只有链上的子树重建，链外子树复用旧投影引用', () => {
  let s = shallowSession();
  const prev = projectToLegacyDoc(s);
  const b1Before = prev.tree.children.find((n) => n.id === 'b1');
  const b2Before = prev.tree.children.find((n) => n.id === 'b2');

  s = ingestPath(s, {
    rows: [pathRow('root', null, '1', 3), pathRow('b2', 'root', '1-2', 10), pathRow('b2-c6', 'b2', '1-2-6', 0)]
  });
  const next = projectToLegacyDoc(s, prev);
  assert.equal(next.tree.children.find((n) => n.id === 'b1'), b1Before, '链外子树 O(1) 复用');
  assert.notEqual(next.tree.children.find((n) => n.id === 'b2'), b2Before, '链上子树重建（版本已 bump）');
  assert.equal(next.idByAddress['1-2-6'], 'b2-c6');
});
