import {
  RESIZE_RAIL_DRAG_THRESHOLD,
  TREE_BUILD_YIELD_EVERY
} from './doc-utils.mjs';
import { toTreeNode } from '../../core/node-model.mjs';

export function nextFrame() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    window.requestAnimationFrame(finish);
    window.setTimeout(finish, 0);
  });
}

export async function buildTreeWithIndex(rows, onProgress = null) {
  if (!Array.isArray(rows) || rows.length === 0) return { tree: null, idByAddress: {} };

  const childrenByParent = new Map();
  const yieldBuildProgress = async (label, step, total) => {
    onProgress?.({ label, step, total });
    await nextFrame();
  };

  for (let index = 0; index < rows.length; index += 1) {
    const base = toTreeNode(rows[index]);
    if (!base) continue;
    const node = { ...base, children: [] };
    const parentKey = node.parentId ?? null;
    if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
    childrenByParent.get(parentKey).push(node);
    if ((index + 1) % TREE_BUILD_YIELD_EVERY === 0 || index + 1 === rows.length) {
      await yieldBuildProgress('正在构建树节点...', index + 1, rows.length);
    }
  }

  const childLists = [...childrenByParent.values()];
  for (let index = 0; index < childLists.length; index += 1) {
    childLists[index].sort((a, b) => a.sortOrder - b.sortOrder || String(a.id).localeCompare(String(b.id)));
    if ((index + 1) % TREE_BUILD_YIELD_EVERY === 0 || index + 1 === childLists.length) {
      await yieldBuildProgress('正在排序子节点...', index + 1, childLists.length);
    }
  }

  const roots = childrenByParent.get(null) || [];
  const root = roots[0] || null;
  if (!root) return { tree: null, idByAddress: {} };

  root.address = '1';
  const idByAddress = {};
  const depths = new Set();
  const stack = [{ node: root, depth: 1 }];
  let maxDepth = 1;
  let visited = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    maxDepth = Math.max(maxDepth, depth);
    depths.add(depth);
    idByAddress[node.address] = node.id;
    const children = childrenByParent.get(node.id) || [];
    node.children = children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      child.address = `${node.address}-${index + 1}`;
      stack.push({ node: child, depth: depth + 1 });
    }
    visited += 1;
    if (visited % TREE_BUILD_YIELD_EVERY === 0 || visited === rows.length) {
      await yieldBuildProgress('正在生成树地址...', visited, rows.length);
    }
  }

  return {
    tree: root,
    idByAddress,
    depthStats: {
      maxDepth,
      depths: [...depths].sort((a, b) => a - b)
    }
  };
}

export function startResizeRailGesture(event, {
  collapsed = false,
  onExpand,
  bodyClasses = [],
  onDrag,
  onClick
}) {
  event.preventDefault();
  if (collapsed) {
    onExpand?.();
    return;
  }

  const startX = event.clientX;
  const startY = event.clientY;
  let dragged = false;
  if (bodyClasses.length) document.body.classList.add(...bodyClasses);

  const move = (moveEvent) => {
    const distance = Math.max(Math.abs(moveEvent.clientX - startX), Math.abs(moveEvent.clientY - startY));
    if (distance > RESIZE_RAIL_DRAG_THRESHOLD) dragged = true;
    if (!dragged) return;
    onDrag?.(moveEvent, { startX, startY });
  };

  const stop = () => {
    if (bodyClasses.length) document.body.classList.remove(...bodyClasses);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
    if (!dragged) onClick?.();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}
