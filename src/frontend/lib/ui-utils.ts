// @ts-nocheck
export const DEFAULT_IDE_COLUMN_WIDTHS = { node: 150, sentence: 82 };

export const IDE_COLUMN_LIMITS = {
  node: { min: 72, max: 760 },
  sentence: { min: 40, max: 360 }
};
export const IDE_HEADER_HEIGHT = 22;
export const IDE_ROW_MIN_HEIGHT = 24;
export const IDE_CODE_LINE_HEIGHT = 20;
export const IDE_VIRTUAL_OVERSCAN = 700;
export const SOURCE_VIRTUAL_OVERSCAN = 1200;
export const IDE_NODE_INDENT_WIDTH = 24;
export const IDE_NODE_BASE_WIDTH = 52;

export function formatDate(value) {
  if (!value) return '';
  return String(value).replace('T', ' ').slice(0, 19);
}

export function formatProgressNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

export function progressCountText(progress) {
  if (progress?.countLabel) return progress.countLabel;
  return `${formatProgressNumber(progress?.step)} / ${formatProgressNumber(progress?.total)}`;
}

export function readIdeColumnWidths() {
  if (typeof window === 'undefined') return DEFAULT_IDE_COLUMN_WIDTHS;
  try {
    const saved = JSON.parse(window.localStorage.getItem('iftree.ideColumnWidths') || '{}');
    return {
      node: clampIdeColumnWidth(saved.node, IDE_COLUMN_LIMITS.node.min, IDE_COLUMN_LIMITS.node.max, DEFAULT_IDE_COLUMN_WIDTHS.node),
      sentence: clampIdeColumnWidth(saved.sentence, IDE_COLUMN_LIMITS.sentence.min, IDE_COLUMN_LIMITS.sentence.max, DEFAULT_IDE_COLUMN_WIDTHS.sentence)
    };
  } catch {
    return DEFAULT_IDE_COLUMN_WIDTHS;
  }
}

export function clampIdeColumnWidth(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function readIdeColumnWidthFromDom(element, property, fallback) {
  if (!element || typeof window === 'undefined') return fallback;
  const raw = element.style.getPropertyValue(property) || window.getComputedStyle(element).getPropertyValue(property);
  const number = Number.parseFloat(raw);
  return Number.isFinite(number) ? number : fallback;
}

export function buildVirtualRange(heights, scrollTop, viewportHeight, overscan) {
  const offsets = [0];
  let totalHeight = 0;
  for (const height of heights) {
    totalHeight += Math.max(0, Number(height) || 0);
    offsets.push(totalHeight);
  }

  const from = Math.max(0, scrollTop - overscan);
  const to = Math.min(totalHeight, scrollTop + viewportHeight + overscan);
  const start = Math.max(0, lowerBound(offsets, from) - 1);
  const end = Math.min(heights.length, lowerBound(offsets, to) + 1);
  return {
    start,
    end,
    top: offsets[start] || 0,
    bottom: Math.max(0, totalHeight - (offsets[end] || totalHeight)),
    totalHeight
  };
}

export function buildFixedVirtualRange(count, rowHeight, scrollTop, viewportHeight, overscan) {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  const safeRowHeight = Math.max(1, Number(rowHeight) || 1);
  const safeScrollTop = Math.max(0, Number(scrollTop) || 0);
  const safeViewportHeight = Math.max(1, Number(viewportHeight) || 1);
  const safeOverscan = Math.max(0, Number(overscan) || 0);
  const totalHeight = safeCount * safeRowHeight;
  const from = Math.max(0, safeScrollTop - safeOverscan);
  const to = Math.min(totalHeight, safeScrollTop + safeViewportHeight + safeOverscan);
  const start = Math.max(0, Math.floor(from / safeRowHeight));
  const end = Math.min(safeCount, Math.ceil(to / safeRowHeight) + 1);
  return {
    start,
    end,
    top: start * safeRowHeight,
    bottom: Math.max(0, totalHeight - end * safeRowHeight),
    totalHeight
  };
}

export function lowerBound(values, target) {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (values[middle] < target) left = middle + 1;
    else right = middle;
  }
  return left;
}
