import './_assert-electron.mjs';

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTree } from '../dist/src/core/tree.js';
import { buildTreeIndex } from '../dist/src/core/node-model.js';
import {
  addressAtDepth,
  addressDepth,
  ancestorAddresses,
  clampVisibleDepth,
  expandedAddressesForVisibleDepth,
  focusAddressForExpandedNode,
  isVisibleDepthFullyExpanded,
  resolveDepthControl,
  resolveDepthShrinkLocate,
  resolveToggleExpand,
  visibleDepthForExpandedAddresses
} from '../dist/src/frontend/components/c2d/c2d-depth-logic.js';

// 行为锁定测试：C2D 重构（补丁塔规整化）刀 1/2——这些断言对着 C2DMapView
// （原 MindMapView.tsx）外提前的组件内实现拍摄，锁定 8-7 深度控制、9-2-x 展开/热点决策的现行为。
// 重构各刀不得让本文件变红；断言与需求条文冲突时先归因（见 CLAUDE.md 测试纪律）。

// root(1) ─ a(1-1) ─ a1(1-1-1) ─ ax(1-1-1-1)
//         ─ b(1-2) ─ b1(1-2-1)
//         ─ c(1-3)（叶子）
// depth 显式给出：buildTree 只透传不按层计算（缺省 1），真实投影数据自后端带真 depth。
function sampleIndex() {
  return buildTreeIndex(buildTree([
    { id: 'root', docId: 'd', parentId: null, depth: 1, sortOrder: 1, childCount: 3, nodeType: 'TEXT', text: 'root' },
    { id: 'a', docId: 'd', parentId: 'root', depth: 2, sortOrder: 1, childCount: 1, nodeType: 'TEXT', text: 'a' },
    { id: 'b', docId: 'd', parentId: 'root', depth: 2, sortOrder: 2, childCount: 1, nodeType: 'TEXT', text: 'b' },
    { id: 'c', docId: 'd', parentId: 'root', depth: 2, sortOrder: 3, childCount: 0, nodeType: 'TEXT', text: 'c' },
    { id: 'a1', docId: 'd', parentId: 'a', depth: 3, sortOrder: 1, childCount: 1, nodeType: 'TEXT', text: 'a1' },
    { id: 'ax', docId: 'd', parentId: 'a1', depth: 4, sortOrder: 1, childCount: 0, nodeType: 'TEXT', text: 'ax' },
    { id: 'b1', docId: 'd', parentId: 'b', depth: 3, sortOrder: 1, childCount: 0, nodeType: 'TEXT', text: 'b1' }
  ]));
}

const MAX_DEPTH = 4;

test('地址工具：depth / atDepth / ancestors / clamp', () => {
  assert.equal(addressDepth('1-2-3'), 3);
  assert.equal(addressDepth(''), 1);
  assert.equal(addressDepth(null), 1);
  assert.equal(addressAtDepth('1-2-3', 2), '1-2');
  assert.equal(addressAtDepth('1-2-3', 9), '1-2-3');
  assert.equal(addressAtDepth('', 2), null);
  assert.deepEqual(ancestorAddresses('1-2-3'), ['1', '1-2']);
  assert.deepEqual(ancestorAddresses('1'), []);
  assert.equal(clampVisibleDepth(0, 5), 1);
  assert.equal(clampVisibleDepth(7, 5), 5);
  assert.equal(clampVisibleDepth(3, 0), 1);
});

test('visibleDepthForExpandedAddresses 取最深展开地址深度 + 1 并 clamp', () => {
  assert.equal(visibleDepthForExpandedAddresses([], MAX_DEPTH), 1);
  assert.equal(visibleDepthForExpandedAddresses(['1'], MAX_DEPTH), 2);
  assert.equal(visibleDepthForExpandedAddresses(['1', '1-1', '1-1-1'], MAX_DEPTH), 4);
  assert.equal(visibleDepthForExpandedAddresses(['1-1-1'], 3), 3);
});

test('expandedAddressesForVisibleDepth 收集目标深度之上所有有子节点的地址', () => {
  const index = sampleIndex();
  assert.deepEqual([...expandedAddressesForVisibleDepth(index.root, 1, index)], []);
  assert.deepEqual([...expandedAddressesForVisibleDepth(index.root, 2, index)].sort(), ['1']);
  assert.deepEqual([...expandedAddressesForVisibleDepth(index.root, 3, index)].sort(), ['1', '1-1', '1-2']);
  // 深度 4：1-3 是叶子不入集，1-2-1 是叶子不入集
  assert.deepEqual([...expandedAddressesForVisibleDepth(index.root, 4, index)].sort(), ['1', '1-1', '1-1-1', '1-2']);
});

test('isVisibleDepthFullyExpanded 判定当前层是否完全展开', () => {
  const index = sampleIndex();
  assert.equal(isVisibleDepthFullyExpanded(index.root, 3, new Set(['1', '1-1', '1-2']), index), true);
  assert.equal(isVisibleDepthFullyExpanded(index.root, 3, new Set(['1', '1-1']), index), false);
  assert.equal(isVisibleDepthFullyExpanded(index.root, 1, new Set(), index), true);
});

test('focusAddressForExpandedNode 取首子地址，无子取自身', () => {
  const index = sampleIndex();
  assert.equal(focusAddressForExpandedNode(index, index.byAddress.get('1')), '1-1');
  assert.equal(focusAddressForExpandedNode(index, index.byAddress.get('1-3')), '1-3');
  assert.equal(focusAddressForExpandedNode(index, null), null);
});

function depthContext(index, currentExpanded, currentVisibleDepth, visibleDepthLimit) {
  return {
    root: index.root,
    index,
    currentExpanded,
    currentVisibleDepth,
    visibleDepthLimit,
    maxVisibleDepth: MAX_DEPTH
  };
}

test('resolveDepthControl collapseAll：仅删根、保留其它展开（8-7-1）', () => {
  const index = sampleIndex();
  const resolved = resolveDepthControl('collapseAll', depthContext(index, new Set(['1', '1-1', '1-1-1']), 4, 4));
  assert.equal(resolved.targetDepth, 1);
  assert.deepEqual([...resolved.nextExpanded].sort(), ['1-1', '1-1-1']);
});

test('resolveDepthControl collapseOne：从当前实际深度收一层重建集合（8-7-2）', () => {
  const index = sampleIndex();
  const resolved = resolveDepthControl('collapseOne', depthContext(index, new Set(['1', '1-1', '1-1-1']), 4, 4));
  assert.equal(resolved.targetDepth, 3);
  assert.deepEqual([...resolved.nextExpanded].sort(), ['1', '1-1', '1-2']);
  // 收到 1 走 collapseToRoot：保留其它展开
  const toRoot = resolveDepthControl('collapseOne', depthContext(index, new Set(['1', '1-1']), 2, 2));
  assert.equal(toRoot.targetDepth, 1);
  assert.deepEqual([...toRoot.nextExpanded].sort(), ['1-1']);
});

test('resolveDepthControl setDepth：按所选深度重置集合，不重用调整前集合（8-7-3 / 9-2-8）', () => {
  const index = sampleIndex();
  // 原集合里有 1-1-1（会产生深度 4 内容），setDepth 3 重建后不保留
  const resolved = resolveDepthControl('setDepth', depthContext(index, new Set(['1', '1-1-1']), 3, 3));
  assert.equal(resolved.targetDepth, 3);
  assert.deepEqual([...resolved.nextExpanded].sort(), ['1', '1-1', '1-2']);
  const toRoot = resolveDepthControl('setDepth', depthContext(index, new Set(['1', '1-1']), 3, 1));
  assert.equal(toRoot.targetDepth, 1);
  assert.deepEqual([...toRoot.nextExpanded].sort(), ['1-1']);
});

test('resolveDepthControl expandOne：未补齐先补齐当前层，已补齐展下一层（8-7-4）', () => {
  const index = sampleIndex();
  // 深度 3 未完全展开（缺 1-2）：先补齐当前层
  const fill = resolveDepthControl('expandOne', depthContext(index, new Set(['1', '1-1']), 3, 3));
  assert.equal(fill.targetDepth, 3);
  assert.deepEqual([...fill.nextExpanded].sort(), ['1', '1-1', '1-2']);
  // 深度 3 已完全展开：展到 4
  const grow = resolveDepthControl('expandOne', depthContext(index, new Set(['1', '1-1', '1-2']), 3, 3));
  assert.equal(grow.targetDepth, 4);
  assert.deepEqual([...grow.nextExpanded].sort(), ['1', '1-1', '1-1-1', '1-2']);
  // 已到 max：clamp 不越界
  const capped = resolveDepthControl('expandOne', depthContext(index, new Set(['1', '1-1', '1-1-1', '1-2']), 4, 4));
  assert.equal(capped.targetDepth, 4);
});

test('resolveDepthControl expandAll 展到全部深度；未知 action 返回 null（8-7-5）', () => {
  const index = sampleIndex();
  const resolved = resolveDepthControl('expandAll', depthContext(index, new Set(), 1, 1));
  assert.equal(resolved.targetDepth, 4);
  assert.deepEqual([...resolved.nextExpanded].sort(), ['1', '1-1', '1-1-1', '1-2']);
  assert.equal(resolveDepthControl('bogus', depthContext(index, new Set(), 1, 1)), null);
});

test('resolveDepthShrinkLocate：仅缩深且热点更深时给出热点祖先（2-1）', () => {
  assert.equal(resolveDepthShrinkLocate({ hotspot: '1-1-1-1', targetDepth: 2, currentVisibleDepth: 4 }), '1-1');
  // 调高深度不移镜头
  assert.equal(resolveDepthShrinkLocate({ hotspot: '1-1-1-1', targetDepth: 4, currentVisibleDepth: 2 }), null);
  // 缩深但热点不深于目标深度：不移
  assert.equal(resolveDepthShrinkLocate({ hotspot: '1-1', targetDepth: 3, currentVisibleDepth: 4 }), null);
  assert.equal(resolveDepthShrinkLocate({ hotspot: null, targetDepth: 1, currentVisibleDepth: 4 }), null);
});

test('resolveToggleExpand 展开：热点与镜头落在首子，写热点记录（9-2-2 / 9-2-9）', () => {
  const index = sampleIndex();
  const block = index.byAddress.get('1-1');
  const resolved = resolveToggleExpand({
    block, expanded: new Set(['1']), index, lastHotspot: null, maxVisibleDepth: MAX_DEPTH
  });
  assert.deepEqual([...resolved.nextExpanded].sort(), ['1', '1-1']);
  assert.equal(resolved.pendingLocate, '1-1-1');
  assert.equal(resolved.nextHotspot, '1-1-1');
});

test('resolveToggleExpand 收起：只删自身、子孙展开保留，热点为自身（9-2-3 / 9-2-7）', () => {
  const index = sampleIndex();
  const block = index.byAddress.get('1-1');
  const resolved = resolveToggleExpand({
    block, expanded: new Set(['1', '1-1', '1-1-1']), index, lastHotspot: '1-1-1', maxVisibleDepth: MAX_DEPTH
  });
  assert.deepEqual([...resolved.nextExpanded].sort(), ['1', '1-1-1']);
  assert.equal(resolved.pendingLocate, '1-1');
  assert.equal(resolved.nextHotspot, '1-1');
});

test('resolveToggleExpand 根还原：镜头回热点在还原深度的祖先，不刷新热点记录', () => {
  const index = sampleIndex();
  const root = index.byAddress.get('1');
  // 根被收起（不在集合），其它展开保留 → 再展根：还原深度 = 最深展开地址深度 + 1 = 4，
  // 热点 1-1-1-1 取深度 4 祖先即自身；不刷新热点记录。
  const resolved = resolveToggleExpand({
    block: root, expanded: new Set(['1-1', '1-1-1']), index, lastHotspot: '1-1-1-1', maxVisibleDepth: MAX_DEPTH
  });
  assert.deepEqual([...resolved.nextExpanded].sort(), ['1', '1-1', '1-1-1']);
  assert.equal(resolved.pendingLocate, '1-1-1-1');
  assert.equal(resolved.nextHotspot, null);
});

test('resolveToggleExpand 根展开但无热点记录：走普通展开分支', () => {
  const index = sampleIndex();
  const root = index.byAddress.get('1');
  const resolved = resolveToggleExpand({
    block: root, expanded: new Set(['1-1']), index, lastHotspot: null, maxVisibleDepth: MAX_DEPTH
  });
  assert.equal(resolved.pendingLocate, '1-1');
  assert.equal(resolved.nextHotspot, '1-1');
});
