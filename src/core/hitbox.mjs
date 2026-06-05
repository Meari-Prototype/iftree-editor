export const NODE_HITBOX_VERTICAL_PADDING = 32;

export function measuredNodeHeightFromElement(element, padding = NODE_HITBOX_VERTICAL_PADDING) {
  const contentHeight = Math.ceil(Number(element?.scrollHeight) || 0);
  const pad = Math.max(0, Math.ceil(Number(padding) || 0));
  return contentHeight > 0 ? contentHeight + pad : 0;
}
