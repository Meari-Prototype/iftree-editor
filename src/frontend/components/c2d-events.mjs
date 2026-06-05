// c2d-events.mjs
// Event handling logic for C2DMapView.
// Each function takes explicit context — no closures over React state.

import { clamp, clampCenterScrollTop } from './c2d-measure.mjs';
import { parentAddress } from '../../core/node-model.mjs';

// ── Scroll sync ──────────────────────────────────────────

function groupForBlock(column, block) {
  return (column?.groups || []).find(group =>
    (group.blocks || []).some(item => item.address === block.address)
  ) || null;
}

function syncLeftChildColumn(parentIdx, parentAddr, targetY, colElsMap, cardsMap, columns) {
  const childIdx = parentIdx - 1;
  const childEl = colElsMap.get(childIdx);
  if (!childEl) return;
  const group = (columns[childIdx]?.groups || []).find(item =>
    item.direction === 'left' && item.parent?.address === parentAddr && item.blocks?.length
  );
  if (!group) return;
  const first = cardsMap.get(group.blocks[0].address);
  const last = cardsMap.get(group.blocks[group.blocks.length - 1].address);
  if (!first || !last) return;
  const childR = childEl.getBoundingClientRect();
  const groupCenter = (first.offsetTop + last.offsetTop + last.offsetHeight) / 2;
  const target = groupCenter - (targetY - childR.top);
  const max = Math.max(0, childEl.scrollHeight - childEl.clientHeight);
  const clamped = clampCenterScrollTop(target, first.offsetTop, max);
  if (Math.abs(childEl.scrollTop - clamped) > 2) {
    childEl.scrollTo({ top: clamped, behavior: 'smooth' });
  }
}

export function syncParentColumn(childIdx, colElsMap, cardsMap, columns) {
  const childEl = colElsMap.get(childIdx);
  if (!childEl) return;
  const childR = childEl.getBoundingClientRect();
  const targetY = childR.top + childR.height / 2;
  const blocks = columns[childIdx]?.groups.flatMap(g => g.blocks) || [];
  let center = null;
  let bestD = Infinity;
  for (const b of blocks) {
    const el = cardsMap.get(b.address);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - targetY);
    if (d < bestD) { bestD = d; center = b; }
  }
  if (!center) return;
  const group = groupForBlock(columns[childIdx], center);
  if (!group?.parent) {
    syncLeftChildColumn(childIdx, center.address, targetY, colElsMap, cardsMap, columns);
    return;
  }
  const parentIdx = group?.direction === 'left' ? childIdx + 1 : childIdx - 1;
  const parentEl = colElsMap.get(parentIdx);
  if (!parentEl) return;
  const pAddr = group.parent.address || parentAddress(center.address);
  if (!pAddr) return;
  const pEl = cardsMap.get(pAddr);
  if (!pEl) return;
  const parentR = parentEl.getBoundingClientRect();
  const target = pEl.offsetTop + pEl.offsetHeight / 2 - (targetY - parentR.top);
  const max = Math.max(0, parentEl.scrollHeight - parentEl.clientHeight);
  const clamped = clampCenterScrollTop(target, pEl.offsetTop, max);
  if (Math.abs(parentEl.scrollTop - clamped) > 2) {
    parentEl.scrollTo({ top: clamped, behavior: 'smooth' });
  }
  if (group.direction !== 'left') {
    syncLeftChildColumn(parentIdx, pAddr, targetY, colElsMap, cardsMap, columns);
  }
}

// ── Scroll boundary clamping ─────────────────────────────

function columnScrollItems(blocks, cardsMap) {
  return blocks.map(b => {
    const el = cardsMap.get(b.address);
    if (!el) return null;
    return { block: b, top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight };
  }).filter(Boolean).sort((a, b) => a.top - b.top);
}

function activeScrollItem(items, scrollTop, viewH) {
  const center = scrollTop + viewH / 2;
  let best = null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const d = Math.abs((it.top + it.bottom) / 2 - center);
    if (!best || d < best.distance) best = { item: it, index: i, distance: d };
  }
  return best;
}

function activeExpandedScrollItem(items, expandedSet, scrollTop, viewH) {
  return activeScrollItem(
    items.filter(it => expandedSet.has(it.block.address)),
    scrollTop, viewH
  );
}

function clampExpandedNodeScroll({ item, direction, viewH, scrollMax, nextScrollTop }) {
  // 展开节点统一规则：scrollTop 卡在 [顶部对齐, 底部对齐] 区间内——上下卡住、
  // 中间可滚。节点能放进视野时该区间很窄（顶/底两个贴边位几乎重合），超长节点
  // 时该区间很宽（中间能滚很多，才看得到底部的备注）。向下滚钳到底边界，
  // 向上滚钳到顶边界。
  const minScroll = clamp(Math.min(item.top, item.bottom - viewH), 0, scrollMax);
  const maxScroll = clamp(Math.max(item.top, item.bottom - viewH), 0, scrollMax);
  return {
    scrollTop: direction === 'down'
      ? Math.min(nextScrollTop, maxScroll)
      : Math.max(nextScrollTop, minScroll),
    boundary: direction === 'down' ? maxScroll : minScroll,
    anchor: item
  };
}

function clampCollapsedRunScroll({ items, activeIndex, direction, viewH, scrollMax, nextScrollTop, expandedSet }) {
  let start = activeIndex;
  let end = activeIndex;
  while (start > 0 && !expandedSet.has(items[start - 1].block.address)) start--;
  while (end + 1 < items.length && !expandedSet.has(items[end + 1].block.address)) end++;
  const first = items[start];
  const last = items[end];
  if (!first || !last) return null;
  const anchor = direction === 'down' ? last : first;
  const anchorH = Math.max(0, anchor.bottom - anchor.top);
  const isOversized = anchorH > viewH;
  const boundary = direction === 'down'
    ? clamp(isOversized ? last.bottom - viewH : last.top, 0, scrollMax)
    : clamp(isOversized ? first.top : first.bottom - viewH, 0, scrollMax);
  return {
    scrollTop: direction === 'down'
      ? Math.min(nextScrollTop, boundary)
      : Math.max(nextScrollTop, boundary),
    boundary,
    anchor
  };
}

export function clampColumnScrollBoundary(colEl, blocks, nextScrollTop, delta, expandedSet, cardsMap) {
  if (!colEl) return null;
  const viewH = colEl.clientHeight;
  const scrollMax = Math.max(0, colEl.scrollHeight - viewH);
  if (scrollMax < 1) return null;
  const items = columnScrollItems(blocks, cardsMap);
  if (!items.length) return null;

  const direction = delta > 0 ? 'down' : 'up';
  const ae = activeExpandedScrollItem(items, expandedSet, nextScrollTop, viewH);
  if (ae) {
    const c = clampExpandedNodeScroll({ item: ae.item, direction, viewH, scrollMax, nextScrollTop });
    return { scrollTop: c.scrollTop, direction, boundary: c.boundary,
      anchorAddr: c.anchor.block.address, boundaryMode: 'expanded', scrollMax };
  }
  const a = activeScrollItem(items, nextScrollTop, viewH);
  if (!a) return null;
  const c = clampCollapsedRunScroll({ items, activeIndex: a.index, direction, viewH, scrollMax, nextScrollTop, expandedSet });
  if (!c) return null;
  return { scrollTop: c.scrollTop, direction, boundary: c.boundary,
    anchorAddr: c.anchor.block.address, boundaryMode: 'collapsed', scrollMax };
}

// ── Wheel event ──────────────────────────────────────────

export function handleColumnWheel(event, { colElsMap, cardsMap, columns, expandedSet, scrollTargets, onMeasure }) {
  const el = event.currentTarget;
  const delta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
  if (!delta) return;
  let colIndex = -1;
  let blocks = [];
  for (const [i, colEl] of colElsMap.entries()) {
    if (colEl === el) {
      colIndex = i;
      blocks = columns[i]?.groups.flatMap(g => g.blocks) || [];
      break;
    }
  }
  const scrollMax = Math.max(0, el.scrollHeight - el.clientHeight);
  const tKey = colIndex;
  const base = scrollTargets.has(tKey) ? scrollTargets.get(tKey) : el.scrollTop;
  const next = clamp(base + delta, 0, scrollMax);
  const clamped = clampColumnScrollBoundary(el, blocks, next, delta, expandedSet, cardsMap);
  if (!clamped) {
    syncParentColumn(colIndex, colElsMap, cardsMap, columns);
    return;
  }
  if (delta > 0 && clamped.scrollTop < base) { syncParentColumn(colIndex, colElsMap, cardsMap, columns); return; }
  if (delta < 0 && clamped.scrollTop > base) { syncParentColumn(colIndex, colElsMap, cardsMap, columns); return; }
  event.preventDefault();
  event.stopPropagation();
  scrollTargets.set(tKey, clamped.scrollTop);
  clearTimeout(scrollTargets.get(`t${tKey}`));
  scrollTargets.set(`t${tKey}`, setTimeout(() => {
    scrollTargets.delete(tKey);
    scrollTargets.delete(`t${tKey}`);
  }, 150));
  el.scrollTo({ top: clamped.scrollTop, behavior: 'smooth' });
  requestAnimationFrame(onMeasure);
  syncParentColumn(colIndex, colElsMap, cardsMap, columns);
}

// ── Column resize gesture ────────────────────────────────

export function startColumnResize(colIndex, event, { currentWidths, onWidthChange, onEnd }) {
  event.preventDefault();
  const startX = event.clientX;
  const startW = currentWidths[colIndex] || 240;
  function onMove(ev) {
    const w = Math.max(120, startW + ev.clientX - startX);
    onWidthChange(colIndex, w);
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    onEnd?.();
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}
