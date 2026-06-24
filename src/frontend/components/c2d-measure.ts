// @ts-nocheck
// c2d-measure.mjs
// Pure layout computation and DOM measurement for C2DMapView.
// No React, no side effects — takes inputs, returns data.

import { getChildren } from '../../core/node-model.js';

export const COLUMN_GAP = 40;
// 按钮尺寸有两处来源：这里（测量用）和 styles.css 的 var(--c2d-expand-button-size, 32px) 兜底值，改动须同步。
export const EXPAND_BTN = 32;
export const EXPAND_ICON = 30;
export const TEXT_CHAR_LIMIT = 3000;

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 自动居中（卡位）：节点能放进视野时正常居中；放不下（超长节点）时不再
// 居中，而是让顶部贴住视野上沿——否则节点头顶的字数统计、地址会被裁掉。
// rawTop 是纯居中算出的 scrollTop，topOffset 是节点（或首卡）的 offsetTop。
// 不超过视野高度时 rawTop 本就 <= topOffset，取 min 不影响居中；
// 超长节点 rawTop > topOffset，取 min 退化为顶部贴边。
export function clampCenterScrollTop(rawTop, topOffset, scrollMax) {
  return clamp(Math.min(rawTop, topOffset), 0, scrollMax);
}

function connectorCurve(x1, y1, x2, y2) {
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`;
}

function connectorBounds(x1, y1, x2, y2) {
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  };
}

export function deriveColumns(root, expanded, index) {
  if (!root) return [];
  const columns = [{ groups: [{ parent: null, blocks: [root] }] }];
  let parents = expanded.has(root.address) ? [root] : [];
  while (parents.length > 0) {
    const groups = [];
    const next = [];
    for (const p of parents) {
      const children = getChildren(index, p.id);
      if (!children?.length) continue;
      groups.push({ parent: p, blocks: children });
      for (const c of children) {
        if (expanded.has(c.address) && c.childCount > 0) next.push(c);
      }
    }
    if (!groups.length) break;
    columns.push({ groups });
    parents = next;
  }
  return columns;
}

function clippedBand(top, bottom, stripRect, viewportRect) {
  const clippedTop = clamp(top, viewportRect.top, viewportRect.bottom);
  const clippedBottom = clamp(bottom, viewportRect.top, viewportRect.bottom);
  if (clippedBottom <= clippedTop) return null;
  return {
    top: clippedTop - stripRect.top,
    bottom: clippedBottom - stripRect.top
  };
}

function pushConnector(lines, key, parentEl, firstChildEl, lastChildEl, x1, x2, stripRect, viewportRect) {
  if (!parentEl || !firstChildEl || !lastChildEl) return;
  const pr = parentEl.getBoundingClientRect();
  const fr = firstChildEl.getBoundingClientRect();
  const lr = lastChildEl.getBoundingClientRect();
  const parentBand = clippedBand(pr.top, pr.bottom, stripRect, viewportRect);
  const childBand = clippedBand(fr.top, lr.bottom, stripRect, viewportRect);
  if (!parentBand || !childBand) return;
  const topBounds = connectorBounds(x1, parentBand.top, x2, childBand.top);
  const bottomBounds = connectorBounds(x1, parentBand.bottom, x2, childBand.bottom);
  lines.push(
    {
      key: `${key}-t`,
      d: connectorCurve(x1, parentBand.top, x2, childBand.top),
      bounds: topBounds
    },
    {
      key: `${key}-b`,
      d: connectorCurve(x1, parentBand.bottom, x2, childBand.bottom),
      bounds: bottomBounds
    }
  );
}

// 子树正文预览：从内存索引遍历子孙，累积到上限即停（不含节点自身）。
export function subtreePreviewText(index, nodeId, limit = TEXT_CHAR_LIMIT) {
  const parts = [];
  let total = 0;
  const stack = getChildren(index, nodeId).slice().reverse();
  while (stack.length > 0 && total < limit) {
    const n = stack.pop();
    const chunk = n.text || '';
    if (chunk) { parts.push(chunk); total += chunk.length + 1; }
    const children = getChildren(index, n.id);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return parts.join('\n').slice(0, limit);
}

// ── 节点内容统计 ─────────────────────────────────────────
// 一次自底向上遍历把整棵树的字数/字符数/子树规模算完（buildStatsIndex），
// 渲染路径上按节点 id O(1) 取数（statsForNode）。输出与逐节点全子树遍历
// 完全同值：subtree 各项等价于「子树内非空 nodeContentText 以 \n join 后
// 再统计」——words / charsNoSpace 可直接逐节点求和；charsWithSpace 需补回
// join 分隔符数（非空片段数 - 1）。

export function nodeContentText(node) {
  return [node?.title, node?.text, node?.note]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
}

/** @returns {import('./c2d-types').ContentStats} */
export function contentStats(text) {
  const value = String(text || '');
  const wordMatches = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}]+/gu) || [];
  const noSpace = value.replace(/\s+/g, '');
  return {
    words: wordMatches.length,
    charsNoSpace: Array.from(noSpace).length,
    charsWithSpace: Array.from(value).length
  };
}

// toTreeNode 保证树内节点 depth ≥ 1，|| 1 只兜缺字段的非常规输入。
function nodeDepthOf(node) {
  return Math.max(1, Number(node?.depth) || 1);
}

/** @returns {import('./c2d-types').StatsIndex} */
export function buildStatsIndex(index) {
  /** @type {import('./c2d-types').StatsIndex} */
  const result = new Map();
  const root = index?.root;
  if (!root) return result;
  // 前序入栈展平后逆序聚合：子节点必然先于父节点被处理。
  const order = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    order.push(node);
    const children = getChildren(index, node.id);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    const own = contentStats(nodeContentText(node));
    const entry = {
      own,
      words: own.words,
      charsNoSpace: own.charsNoSpace,
      charsSum: own.charsWithSpace,
      nonEmptyCount: own.charsWithSpace > 0 ? 1 : 0,
      nodeCount: 1,
      maxDepth: nodeDepthOf(node)
    };
    for (const child of getChildren(index, node.id)) {
      const c = result.get(child.id);
      if (!c) continue;
      entry.words += c.words;
      entry.charsNoSpace += c.charsNoSpace;
      entry.charsSum += c.charsSum;
      entry.nonEmptyCount += c.nonEmptyCount;
      entry.nodeCount += c.nodeCount;
      entry.maxDepth = Math.max(entry.maxDepth, c.maxDepth);
    }
    result.set(node.id, entry);
  }
  return result;
}

// 不在树索引里的块（事实前提）走单节点兜底：subtree 即自身。
/**
 * @param {import('./c2d-types').StatsIndex | null | undefined} statsIndex
 * @returns {import('./c2d-types').NodeStats}
 */
export function statsForNode(statsIndex, index, node) {
  const entry = node ? statsIndex?.get(node.id) : null;
  const own = entry ? entry.own : contentStats(nodeContentText(node));
  if (!entry) {
    return {
      own,
      subtree: own,
      subtreeNodeCount: 1,
      remainingDepth: 0,
      nextDepthWidth: node ? getChildren(index, node.id).length : 0
    };
  }
  return {
    own,
    subtree: {
      words: entry.words,
      charsNoSpace: entry.charsNoSpace,
      charsWithSpace: entry.charsSum + Math.max(0, entry.nonEmptyCount - 1)
    },
    subtreeNodeCount: entry.nodeCount,
    remainingDepth: Math.max(0, entry.maxDepth - nodeDepthOf(node)),
    nextDepthWidth: getChildren(index, node.id).length
  };
}

export function measureConnectorLines(stripEl, surfaceEl, colElsMap, cardsMap, columns) {
  if (!stripEl || !surfaceEl || columns.length < 2) {
    return { lines: [], w: 1, h: 1 };
  }
  const w = Math.max(1, stripEl.scrollWidth);
  const h = Math.max(1, surfaceEl.clientHeight);
  const sr = stripEl.getBoundingClientRect();
  const vr = surfaceEl.getBoundingClientRect();
  const lines = [];
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const curEl = colElsMap.get(i);
    const parentEl = colElsMap.get(i + 1);
    if (!curEl || !parentEl) continue;
    for (const g of col.groups || []) {
      if (g.direction !== 'left' || !g.parent || !g.blocks?.length) continue;
      const pEl = cardsMap.get(g.parent.address);
      const fEl = cardsMap.get(g.blocks[0].address);
      const lEl = cardsMap.get(g.blocks[g.blocks.length - 1].address);
      const parentX = parentEl.getBoundingClientRect().left - sr.left;
      const childX = curEl.getBoundingClientRect().right - sr.left;
      pushConnector(lines, `${g.parent.address}-left`, pEl, fEl, lEl, parentX, childX, sr, vr);
    }
  }
  for (let i = 1; i < columns.length; i++) {
    const prevEl = colElsMap.get(i - 1);
    const curEl = colElsMap.get(i);
    if (!prevEl || !curEl) continue;
    const laneL = prevEl.getBoundingClientRect().right - sr.left;
    const laneR = curEl.getBoundingClientRect().left - sr.left;
    for (const g of columns[i].groups) {
      if (!g.parent) continue;
      const pEl = cardsMap.get(g.parent.address);
      if (!pEl || !g.blocks.length) continue;
      const fEl = cardsMap.get(g.blocks[0].address);
      const lEl = cardsMap.get(g.blocks[g.blocks.length - 1].address);
      if (!fEl || !lEl) continue;
      pushConnector(lines, g.parent.address, pEl, fEl, lEl, laneL, laneR, sr, vr);
    }
  }
  return { lines, w, h };
}

export function measureButtonTops(columns, colElsMap, cardsMap) {
  const result = new Map();
  columns.forEach((col, ci) => {
    const colEl = colElsMap.get(ci);
    if (!colEl) return;
    for (const b of col.groups.flatMap(g => g.blocks)) {
      if (b.childCount <= 0) continue;
      const el = cardsMap.get(b.address);
      if (!el) continue;
      const cardR = el.getBoundingClientRect();
      const colR = colEl.getBoundingClientRect();
      const maxT = Math.max(0, el.offsetHeight - EXPAND_BTN);
      if (cardR.bottom <= colR.top) { result.set(b.address, maxT); continue; }
      if (cardR.top >= colR.bottom) { result.set(b.address, 0); continue; }
      const visCenter = (Math.max(cardR.top, colR.top) + Math.min(cardR.bottom, colR.bottom)) / 2;
      result.set(b.address, clamp(visCenter - cardR.top - EXPAND_BTN / 2, 0, maxT));
    }
  });
  return result;
}
