const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;
const NOTE_GAP = 0;

export const MAX_DEPTH_LIMIT = 28;
export const DEFAULT_DEPTH_LIMIT = MAX_DEPTH_LIMIT;
export const DEFAULT_NODE_LAYOUT = Object.freeze({
  mode: 'equalWidth',
  defaultWidth: NODE_WIDTH,
  defaultHeight: NODE_HEIGHT,
  minWidth: 120,
  maxWidth: 100000,
  minHeight: 48,
  maxHeight: 1000000,
  paddingX: 12,
  noteGap: NOTE_GAP
});

export function normalizeNodeLayout(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const minWidth = normalizeNumber(source.minWidth, DEFAULT_NODE_LAYOUT.minWidth, 40, 100000);
  const maxWidth = Math.max(minWidth, normalizeNumber(source.maxWidth, DEFAULT_NODE_LAYOUT.maxWidth, minWidth, 100000));
  const minHeight = normalizeNumber(source.minHeight, DEFAULT_NODE_LAYOUT.minHeight, 24, 1000000);
  const maxHeight = Math.max(minHeight, normalizeNumber(source.maxHeight, DEFAULT_NODE_LAYOUT.maxHeight, minHeight, 1000000));
  return {
    mode: normalizeNodeLayoutMode(source.mode),
    defaultWidth: normalizeNumber(source.defaultWidth, DEFAULT_NODE_LAYOUT.defaultWidth, minWidth, maxWidth),
    defaultHeight: normalizeNumber(source.defaultHeight, DEFAULT_NODE_LAYOUT.defaultHeight, minHeight, maxHeight),
    minWidth,
    maxWidth,
    minHeight,
    maxHeight,
    paddingX: normalizeNumber(source.paddingX, DEFAULT_NODE_LAYOUT.paddingX, 4, 48),
    noteGap: normalizeNumber(source.noteGap, DEFAULT_NODE_LAYOUT.noteGap, 0, 120)
  };
}

function normalizeNodeLayoutMode(value) {
  return ['goldenRatio', 'ratio', 'equalRatio'].includes(value) ? 'goldenRatio' : 'equalWidth';
}

function normalizeNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return clamp(fallback, min, max);
  return clamp(number, min, max);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
