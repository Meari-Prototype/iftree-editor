// c2d-depth-logic.ts
// C2D 列视图的地址/深度/展开集派生与深度控制决策纯逻辑（需求 8-7 / 9-2-2 / 9-2-3 / 9-2-8 / 2-1）。
// 无 React、无 DOM、无副作用——从 MindMapView 组件体外提，行为由 tests/c2d-depth-logic.test.mjs 锁定。

import type { C2DBlock, C2DTreeIndex } from './c2d-types.js';

export function addressDepth(address: string | null | undefined) {
  return String(address || '').split('-').filter(Boolean).length || 1;
}

export function addressAtDepth(address: string | null | undefined, depth: number) {
  const parts = String(address || '').split('-').filter(Boolean);
  const targetDepth = Math.max(1, Math.floor(Number(depth) || 1));
  return parts.slice(0, Math.min(parts.length, targetDepth)).join('-') || null;
}

export function ancestorAddresses(address: string) {
  const parts = String(address || '').split('-').filter(Boolean);
  const result: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    result.push(parts.slice(0, i).join('-'));
  }
  return result;
}

export function focusAddressForExpandedNode(index: C2DTreeIndex, node: C2DBlock | null) {
  if (!node) return null;
  // c2d 视角下直接走 Map 访问；不绕 node-model 的 getChildren（视角差 + normalizeNodeId 兜底）。
  const firstChild = index.childrenOf.get(node.id)?.[0];
  return firstChild?.address || node.address || null;
}

export function expandedAddressesForVisibleDepth(root: C2DBlock | null, visibleDepthLimit: number, index: C2DTreeIndex) {
  const targetDepth = Math.max(1, Math.floor(Number(visibleDepthLimit) || 1));
  const next = new Set<string>();
  if (!root) return next;
  // index.root 经 toTreeNode 重建后没有 children 属性，必须用 index.childrenOf 走树。
  const stack: C2DBlock[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeDepth = Math.max(1, Number(node.depth) || addressDepth(node.address));
    const children = index ? (index.childrenOf.get(node.id) || []) : [];
    if (nodeDepth < targetDepth && (Number(node.childCount) > 0 || children.length > 0)) {
      next.add(node.address);
    }
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return next;
}

export function isVisibleDepthFullyExpanded(root: C2DBlock | null, visibleDepthLimit: number, expanded: Set<string>, index: C2DTreeIndex) {
  const required = expandedAddressesForVisibleDepth(root, visibleDepthLimit, index);
  for (const address of required) {
    if (!expanded.has(address)) return false;
  }
  return true;
}

export function clampVisibleDepth(value: number, maxDepth: number) {
  const max = Math.max(1, Math.floor(Number(maxDepth) || 1));
  const depth = Math.max(1, Math.floor(Number(value) || 1));
  return Math.min(max, depth);
}

export function visibleDepthForExpandedAddresses(expanded: Iterable<string>, maxDepth: number) {
  let depth = 1;
  for (const address of expanded || []) {
    depth = Math.max(depth, addressDepth(address) + 1);
  }
  return clampVisibleDepth(depth, maxDepth);
}

export interface DepthControlResolution {
  nextExpanded: Set<string>;
  targetDepth: number;
}

export interface DepthControlContext {
  root: C2DBlock | null;
  index: C2DTreeIndex;
  /** 点击前的实际展开集。 */
  currentExpanded: Set<string>;
  /** 点击前的实际最大可见深度（从 columns 派生，不是按钮提交的新值）。 */
  currentVisibleDepth: number;
  /** setDepth 动作按钮提交的目标深度。 */
  visibleDepthLimit: number;
  maxVisibleDepth: number;
}

// 8-7 深度控件五个动作 → 下一展开集 + 目标深度；未知动作返回 null。
export function resolveDepthControl(action: string, context: DepthControlContext): DepthControlResolution | null {
  const { root, index, currentExpanded, currentVisibleDepth, visibleDepthLimit, maxVisibleDepth } = context;

  // 8-7-1：仅删除根，保留其它 expanded。下拉/收一层降到 1 也走此路径。
  const collapseToRoot = (): DepthControlResolution => {
    const next = new Set(currentExpanded);
    next.delete('1');
    return { nextExpanded: next, targetDepth: 1 };
  };

  if (action === 'collapseAll') {
    return collapseToRoot();
  }
  if (action === 'collapseOne') {
    // 8-7-2：从当前实际最大可见深度收回一层
    const next = Math.max(1, currentVisibleDepth - 1);
    if (next <= 1) return collapseToRoot();
    return { nextExpanded: expandedAddressesForVisibleDepth(root, next, index), targetDepth: next };
  }
  if (action === 'setDepth') {
    // 8-7-3：清空 expanded 按所选深度重置；选到 1 走 8-7-1
    const next = clampVisibleDepth(visibleDepthLimit, maxVisibleDepth);
    if (next <= 1) return collapseToRoot();
    return { nextExpanded: expandedAddressesForVisibleDepth(root, next, index), targetDepth: next };
  }
  if (action === 'expandOne') {
    // 8-7-4：当前层未完全展开先补齐，已完全展开再展下一层
    const fully = isVisibleDepthFullyExpanded(root, currentVisibleDepth, currentExpanded, index);
    const next = fully
      ? clampVisibleDepth(currentVisibleDepth + 1, maxVisibleDepth)
      : currentVisibleDepth;
    return { nextExpanded: expandedAddressesForVisibleDepth(root, next, index), targetDepth: next };
  }
  if (action === 'expandAll') {
    // 8-7-5：展开到全部深度
    const next = clampVisibleDepth(maxVisibleDepth, maxVisibleDepth);
    return { nextExpanded: expandedAddressesForVisibleDepth(root, next, index), targetDepth: next };
  }
  return null;
}

// 2-1：仅在调低显示深度且新深度低于热点深度时居中热点祖先。
// 调高显示深度（expandOne / expandAll / setDepth 增大）时不主动移动镜头，
// 让列自动居中/保留滚动位置接管，避免横向乱跳；此时返回 null。
export function resolveDepthShrinkLocate(options: {
  hotspot: string | null;
  targetDepth: number;
  currentVisibleDepth: number;
}): string | null {
  const { hotspot, targetDepth, currentVisibleDepth } = options;
  if (!hotspot) return null;
  if (targetDepth >= currentVisibleDepth) return null;
  if (targetDepth >= addressDepth(hotspot)) return null;
  return addressAtDepth(hotspot, targetDepth);
}

export interface ToggleExpandResolution {
  nextExpanded: Set<string>;
  /** 本次切换后镜头应定位的地址（进 pendingLocate）。 */
  pendingLocate: string | null;
  /** 非 null 时更新热点记录（内存 + localStorage 持久化都由调用方执行）。 */
  nextHotspot: string | null;
}

// 9-2-2 / 9-2-3 / 9-2-7 / 9-2-9：单节点展开/收起的展开集与热点/镜头决策。
// 单节点收起只删自身，不级联清掉子孙；子孙留在集合里只是因父级收起而不可见，
// 父级再展开时所有内部展开/折叠状态自动还原。
// 还原场景（再次展开根 1 且此前有其它展开）：镜头回到原热点祖先而非默认首子，且不刷新热点记录。
export function resolveToggleExpand(options: {
  block: C2DBlock;
  expanded: Set<string>;
  index: C2DTreeIndex;
  lastHotspot: string | null;
  maxVisibleDepth: number;
}): ToggleExpandResolution {
  const { block, expanded, index, lastHotspot, maxVisibleDepth } = options;
  const addr = block.address;
  const wasExpanded = expanded.has(addr);
  const next = new Set(expanded);
  if (wasExpanded) {
    next.delete(addr);
  } else {
    next.add(addr);
  }
  const isRootRestore = !wasExpanded && addr === '1' && expanded.size > 0;
  if (isRootRestore && lastHotspot) {
    const restoreDepth = visibleDepthForExpandedAddresses(next, maxVisibleDepth);
    return {
      nextExpanded: next,
      pendingLocate: addressAtDepth(lastHotspot, restoreDepth) || addr,
      nextHotspot: null
    };
  }
  const hotspot = wasExpanded ? addr : focusAddressForExpandedNode(index, block);
  return {
    nextExpanded: next,
    pendingLocate: hotspot || addr,
    nextHotspot: hotspot || addr
  };
}
