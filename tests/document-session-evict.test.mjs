import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSession,
  ingestRoot,
  ingestChildren,
  setFocus,
  selectNode,
  setMultiSelected,
  setClaimedMaxDepth,
  toggleCollapsed,
  applyViewState,
  applyViewSnapshot,
  snapshotView,
  maxDepthOf,
  nextBackgroundFetch,
  projectToLegacyDoc,
  loadedNodeCount,
  evictChildren,
  planEvictions,
  evictToWindow,
  DEFAULT_EVICT_WINDOW
} from '../dist/src/frontend/session/document-session.js';

// 投影窗口 W 与驱逐（frontend-refactor.md §5 方案 II）行为锁定。
// 树形状：root(1) 下 3 个分支 b1/b2/b3，各带 4 个子节点（共 1+3+12=16 节点）。

function row(id, parentId, address, childCount = 0) {
  return { id, parent_id: parentId, address, sort_order: Number(address.split('-').pop()), child_count: childCount, node_title: id, text: id };
}

function buildSession({ depthLimit = 3 } = {}) {
  let s = ingestRoot(createSession('doc-1'), row('root', null, '1', 3));
  s = ingestChildren(s, {
    parentId: 'root',
    rows: [row('b1', 'root', '1-1', 4), row('b2', 'root', '1-2', 4), row('b3', 'root', '1-3', 4)],
    total: 3
  });
  for (const [branch, index] of [['b1', 1], ['b2', 2], ['b3', 3]]) {
    s = ingestChildren(s, {
      parentId: branch,
      rows: [1, 2, 3, 4].map((i) => row(`${branch}-c${i}`, branch, `1-${index}-${i}`)),
      total: 4
    });
  }
  s = applyViewState(s, { depthLimit });
  return s;
}

test('evictChildren: 卸载后回取数边界态，重载后投影恢复，视图态透明', () => {
  let s = buildSession();
  assert.equal(loadedNodeCount(s), 16);

  // 折叠 b2 并记录视图态（含指向待驱逐节点的展开记录）。
  s = toggleCollapsed(s, 'b2', { promoteDepth: false });
  s = selectNode(s, 'b1-c1');
  const collapsedBefore = new Set(s.view.collapsed);

  // 全量已加载：无取数边界。
  assert.equal(nextBackgroundFetch(s), null);

  const evicted = evictChildren(s, 'b2');
  assert.notEqual(evicted, s, '有已加载子的 parent 驱逐应产生新引用');
  assert.equal(loadedNodeCount(evicted), 12, 'b2 的 4 个子被卸载');
  // 投影不再含被驱逐节点，b2 自身保留且 childCount「声称」不动。
  const projected = projectToLegacyDoc(evicted);
  const b2 = projected.tree.children.find((n) => n.id === 'b2');
  assert.equal(b2.children.length, 0);
  assert.equal(b2.childCount, 4);
  assert.equal(projected.idByAddress['1-2-1'], undefined);
  // 回边界态：后台预取重新给出 b2 的取数请求（重载走现有扩散加载，零新机制）。
  const refetch = nextBackgroundFetch(evicted);
  assert.equal(refetch?.parentId, 'b2');
  // 视图态不因驱逐改变（node id 稳定，折叠/选中记录对驱逐透明）。
  assert.deepEqual(new Set(evicted.view.collapsed), collapsedBefore);
  assert.equal(evicted.view.selectedId, 'b1-c1');

  // 重载：ingestChildren 同一批行 → 投影恢复原状。
  const reloaded = ingestChildren(evicted, {
    parentId: 'b2',
    rows: [1, 2, 3, 4].map((i) => row(`b2-c${i}`, 'b2', `1-2-${i}`)),
    total: 4
  });
  assert.equal(loadedNodeCount(reloaded), 16);
  const restored = projectToLegacyDoc(reloaded);
  assert.equal(restored.tree.children.find((n) => n.id === 'b2').children.length, 4);
  assert.equal(restored.idByAddress['1-2-1'], 'b2-c1');
  assert.equal(nextBackgroundFetch(reloaded), null);

  // 无已加载子 / 未加载 parent：原引用（不 bump）。
  assert.equal(evictChildren(reloaded, 'b1-c1'), reloaded);
  assert.equal(evictChildren(reloaded, 'ghost'), reloaded);
});

test('planEvictions: 渲染依赖集（可见子树 + 焦点/选中祖先链）永不进候选', () => {
  // depthLimit=2：三个分支的子都不可见（分支节点在第 2 层、未显式 expanded）→ 都可驱。
  let s = buildSession({ depthLimit: 2 });
  s = setFocus(s, 'b1-c1'); // 焦点在 b1 子树 → b1 是焦点祖先链，受保护
  s = selectNode(s, 'b3-c2'); // 选中在 b3 子树 → b3 受保护

  const plan = planEvictions(s);
  assert.deepEqual(plan, ['b2'], '只有 b2 可驱：b1/b3 在焦点/选中祖先链上，root 的子可见');

  // depthLimit=3 时全部子树可见 → 无候选。
  const allVisible = buildSession({ depthLimit: 3 });
  assert.deepEqual(planEvictions(allVisible), []);

  // protectIds 显式追加保护。
  let s2 = buildSession({ depthLimit: 2 });
  s2 = setFocus(s2, 'b1-c1');
  assert.deepEqual(planEvictions(s2, { protectIds: ['b2'] }), ['b3']);
});

test('planEvictions: 离焦点最远优先（地址公共前缀短在前），同距离深层在前', () => {
  // b1 下再挂孙层，焦点在 b3：b1 深层子树应排在 b1 之前（同距离先卸叶子层）。
  let s = buildSession({ depthLimit: 1 });
  s = ingestChildren(s, {
    parentId: 'b1-c1',
    rows: [row('b1-c1-g1', 'b1-c1', '1-1-1-1')],
    total: 1
  });
  s = setFocus(s, 'b3');
  const plan = planEvictions(s);
  // 候选：b1(前缀1,深2)、b1-c1(前缀1,深3)、b2(前缀1,深2)。
  // b3 不进候选：焦点祖先链保护；root 不进候选：C2D root 列恒显（并集口径）+ 焦点链兜底。
  assert.equal(plan.includes('b3'), false);
  assert.equal(plan.includes('root'), false);
  assert.ok(plan.indexOf('b1-c1') < plan.indexOf('b1'), '深层先于浅层（先卸叶子层）');
});

test('可见性并集：outline 展开 / C2D 展开列 / 多选祖先链都挡驱逐', () => {
  // depthLimit=1：主树三分支子都不可见；outline 默认折叠（ingest 增量维护）→ 三分支均候选。
  let s = buildSession({ depthLimit: 1 });
  s = setFocus(s, 'root');
  assert.deepEqual(new Set(planEvictions(s)), new Set(['b1', 'b2', 'b3']), '基线：三分支均候选');

  // Outline 面板展开 b1（从 outlineCollapsed 移除）→ b1 的子在 outline 里渲染中，不可驱逐。
  const outlineOpen = new Set(s.view.outlineCollapsed);
  outlineOpen.delete('b1');
  let s1 = applyViewSnapshot(s, { outlineCollapsedNodeIds: [...outlineOpen] });
  assert.equal(planEvictions(s1).includes('b1'), false, 'outline 展开的分支受保护');

  // C2D 展开 b2 的列（address 键）→ 导图渲染中，不可驱逐。
  let s2 = applyViewSnapshot(s, { c2dExpandedAddresses: ['1-2'] });
  assert.equal(planEvictions(s2).includes('b2'), false, 'C2D 展开列受保护');

  // 多选 b3 的子 → b3 在多选祖先链上，不可驱逐。
  let s3 = setMultiSelected(s, ['b3-c2']);
  assert.equal(planEvictions(s3).includes('b3'), false, '多选祖先链受保护');

  // snapshotView/applyViewSnapshot 携带 c2dExpandedAddresses 跨 session 往返。
  const snap = snapshotView(s2);
  assert.deepEqual(snap.c2dExpandedAddresses, ['1-2']);
  const other = applyViewSnapshot(buildSession({ depthLimit: 1 }), snap);
  assert.deepEqual([...other.view.c2dExpanded], ['1-2']);
});

test('ingest 增量维护 outline 默认折叠：深度≥2 有子默认折叠，用户展开后 re-ingest 不打回', () => {
  const s = buildSession();
  // 深度 2 且声称有子的分支默认折叠；root（深度 1）与叶子不折叠。
  assert.deepEqual(new Set(s.view.outlineCollapsed), new Set(['b1', 'b2', 'b3']));

  // 用户在 outline 展开 b2 → re-ingest 同批行（已在镜像，非新增）不得重新折叠。
  const open = new Set(s.view.outlineCollapsed);
  open.delete('b2');
  let s2 = applyViewSnapshot(s, { outlineCollapsedNodeIds: [...open] });
  s2 = ingestChildren(s2, {
    parentId: 'root',
    rows: [row('b1', 'root', '1-1', 4), row('b2', 'root', '1-2', 4), row('b3', 'root', '1-3', 4)],
    total: 3
  });
  assert.equal(s2.view.outlineCollapsed.has('b2'), false, '已存在节点 re-ingest 不重新默认折叠');
});

test('孤儿闸：parent 已被驱逐级联卸载的迟到 ingest 丢弃，不产生不可达孤儿', () => {
  let s = buildSession({ depthLimit: 1 });
  s = setFocus(s, 'root');
  const evicted = evictChildren(s, 'b1'); // b1 的子（含 b1-c1）级联卸载
  assert.equal(evicted.index.byId.has('b1-c1'), false);

  // 模拟在途 listChildren(b1-c1) 迟到返回：parent 不在镜像 → 原引用返回、不写入任何行。
  const late = ingestChildren(evicted, {
    parentId: 'b1-c1',
    rows: [row('b1-c1-g1', 'b1-c1', '1-1-1-1')],
    total: 1
  });
  assert.equal(late, evicted, '孤儿 ingest 应原引用丢弃');
  assert.equal(late.index.byId.has('b1-c1-g1'), false);
});

test('claimedMaxDepth：权威树深做 clamp 天花板，加载初期与驱逐后都不缩水', () => {
  // 加载初期：只有 root（遍历深度=1），权威深度 5 → 恢复的 depthLimit=4 不被夹到 1。
  let s = ingestRoot(createSession('doc-2'), row('root', null, '1', 3));
  s = setClaimedMaxDepth(s, 5);
  s = applyViewState(s, { depthLimit: 4 });
  assert.equal(s.view.depthLimit, 4);
  assert.equal(maxDepthOf(s), 5);

  // 驱逐后：已加载区变浅，maxDepthOf 仍以权威深度为准（不把持久化 depthLimit 降级写回）。
  let full = buildSession({ depthLimit: 1 });
  full = setClaimedMaxDepth(full, 3);
  full = setFocus(full, 'root');
  const shrunk = evictToWindow(full, { limit: 4 });
  assert.ok(loadedNodeCount(shrunk) <= 4);
  assert.equal(maxDepthOf(shrunk), 3, '驱逐后天花板不缩水');
});

test('evictToWindow 边界：size 恰好等于 limit 走原引用返回', () => {
  let s = buildSession({ depthLimit: 1 });
  s = setFocus(s, 'root');
  assert.equal(loadedNodeCount(s), 16);
  assert.equal(evictToWindow(s, { limit: 16 }), s, '=W 不驱逐、原引用');
  assert.notEqual(evictToWindow(s, { limit: 15 }), s, '>W 才驱逐');
});

test('evictToWindow: 超窗收敛到 limit 以内；小文档（≤W）返回原引用——(II) ⊇ (I) 等价锁定', () => {
  let s = buildSession({ depthLimit: 1 }); // 16 节点，全部分支折叠（depthLimit=1 下子不可见）
  s = setFocus(s, 'root');

  // (II) ⊇ (I)：文档不超窗口时驱逐路径完全不跑——原引用返回，投影与全量物化同一份。
  assert.equal(evictToWindow(s, { limit: 100 }), s);
  assert.equal(evictToWindow(s), s, `默认窗口 ${DEFAULT_EVICT_WINDOW} 远大于小文档`);

  // 超窗：limit=8 → 逐个卸载离焦点最远的折叠子树直到 ≤ 8。
  const shrunk = evictToWindow(s, { limit: 8 });
  assert.notEqual(shrunk, s);
  assert.ok(loadedNodeCount(shrunk) <= 8, `期望 ≤8，实际 ${loadedNodeCount(shrunk)}`);
  // root 与三个分支行自身仍在（只卸子树不卸声称）。
  for (const id of ['root', 'b1', 'b2', 'b3']) assert.ok(shrunk.index.byId.has(id), `${id} 应保留`);

  // maxEvictions 节流：单轮最多卸 1 个 parent。
  // 注意 session 的 index 内部可变（bump 只换外壳引用），旧引用不可复用——重建。
  let fresh = buildSession({ depthLimit: 1 });
  fresh = setFocus(fresh, 'root');
  const throttled = evictToWindow(fresh, { limit: 1, maxEvictions: 1 });
  assert.equal(loadedNodeCount(throttled), 12, '单轮只卸一个分支（4 节点）');
});
