export function clampVerticalSplitSize({
  startSize,
  startY,
  currentY,
  availableSize,
  minTop = 96,
  minBottom = 150
}) {
  const baseSize = Number(startSize);
  const fromY = Number(startY);
  const toY = Number(currentY);
  const size = Number(availableSize);
  const topMin = Number(minTop);
  const bottomMin = Number(minBottom);

  if (![baseSize, fromY, toY, size, topMin, bottomMin].every(Number.isFinite)) {
    return topMin;
  }

  const maxTop = Math.max(topMin, size - bottomMin);
  return Math.min(maxTop, Math.max(topMin, baseSize + toY - fromY));
}
